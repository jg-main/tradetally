'use strict';

// Management Quality orchestration service (Phase 4 of
// docs/QUALITY_PROFILES_REQUIREMENT.md, sections 33-46, 49, 57, 63).
//
// Prepare -> Select trailing MA -> Evaluate -> Finalize workflow:
//   - prepare(): operates on an EXISTING non-terminal evaluation created by
//     Setup + Entry. It reports the semantic Management input still required
//     (the trailing MA period) plus evidence availability, WITHOUT mutating the
//     evaluation beyond confirming upstream state.
//   - evaluate(): runs exactly the enabled Management criteria of the immutable
//     profile version against point-in-time evidence and persists NON-TERMINAL
//     Management progress while preserving the valid Setup and Entry results.
//   - finalize(): marks an evaluation with complete Setup + Entry + Management
//     results `completed` (terminal, immutable), via the Phase 1 saveResult
//     contract.
//
// Management dependencies:
//   - immutable Initial R and Entry Basis from Entry Quality;
//   - the actual entry session (Day 1) and subsequent regular sessions from
//     VERIFIED daily bars (never calendar arithmetic);
//   - the full execution fill list (for reductions/partials/premature);
//   - a user-asserted trailing MA selection (SMA10/SMA20) with honest
//     post-trade provenance.
//
// Stop-history capability: TradeTally has no trustworthy complete stop-order
// lifecycle (see management/stopHistory.js), so Stop Ratchet and Post-Partial
// Breakeven resolve to UNKNOWN in production — never fabricated from the
// current/final trade.stop_loss.

const { CRITERION_STATUS, EVALUATION_STATUS } = require('./constants');
const { deriveScoreForCriterion } = require('./scoring');
const {
  saveManagementProgress,
  saveResult,
  getEvaluation,
  EVALUATION_COLUMNS
} = require('./evaluationService');
const { normalizeDailyBars, indexByDate, addCalendarDays } = require('./dailyEvidence');
const { loadDailyEvidence } = require('./marketEvidenceService');
const { setupDependencyFingerprint, entryDependencyFingerprint } = require('./dependencyFingerprint');
const {
  reconstructManagementFills,
  reconstructReductions
} = require('./management/executionFills');
const { resolveStopHistory } = require('./management/stopHistory');
const { resolvePartialTrigger } = require('./management/managementDays');
const { resolvePartialCompletion, resolvePrematureReduction } = require('./management/partial');
const {
  findTrailingSignal,
  classifyTrailingExecution
} = require('./management/trailingMa');
const { regularSessionBounds, sessionDateInZone } = require('./entry/sessionTime');
const { validateManagementCriteria, SUPPORTED_TRAILING_PERIODS } = require('./criteria/management/parameterSchemas');
const { MANAGEMENT_CRITERION_KEYS, evaluateManagementCriterion } = require('./managementCriterionRegistry');
const { getDateInTimezone } = require('../../utils/timezone');

const MARKET_TZ = 'America/New_York';
const TERMINAL_STATUSES = Object.freeze(['completed', 'insufficient_data']);
const PRIOR_CALENDAR_DAYS = 45;
const FORWARD_CALENDAR_DAYS = 120;

class ManagementQualityInputError extends Error {
  constructor(message, code = 'INVALID_INPUT', details = null) {
    super(message);
    this.name = 'ManagementQualityInputError';
    this.code = code;
    this.details = details;
  }
}

function hasOwn(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

function parseJsonField(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }
  return null;
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toFrontendEvaluation(row) {
  const parsed = { ...row };
  for (const field of ['user_inputs', 'detected_context', 'evidence_snapshot', 'results']) {
    if (typeof parsed[field] === 'string') {
      try {
        parsed[field] = JSON.parse(parsed[field]);
      } catch (error) {
        parsed[field] = null;
      }
    }
  }
  return parsed;
}

async function getTradeForUser(userId, tradeId) {
  const result = await require('../../config/database').query(
    `
      SELECT id, user_id, symbol, side, instrument_type, tick_size,
             entry_time, exit_time, trade_date, entry_price, quantity, executions, stop_loss
      FROM trades
      WHERE id = $1 AND user_id = $2
    `,
    [tradeId, userId]
  );
  return result.rows[0] || null;
}

function getManagementDimensionConfig(configuration) {
  if (
    configuration === null ||
    typeof configuration !== 'object' ||
    !configuration.dimensions ||
    !configuration.dimensions.management
  ) {
    throw new ManagementQualityInputError(
      'Profile version has no management dimension configuration.',
      'PROFILE_CONFIG_INVALID'
    );
  }
  const managementConfig = configuration.dimensions.management;
  if (!Array.isArray(managementConfig.criteria)) {
    throw new ManagementQualityInputError(
      'Profile version management dimension has no criteria.',
      'PROFILE_CONFIG_INVALID'
    );
  }
  return managementConfig;
}

function enabledManagementCriteria(managementConfig) {
  return managementConfig.criteria.filter(
    (criterion) => criterion.enabled === undefined || criterion.enabled === true
  );
}

function enabledCriterion(managementConfig, key) {
  return enabledManagementCriteria(managementConfig).find((criterion) => criterion.key === key) || null;
}

function assertValidManagementConfiguration(managementConfig) {
  const violations = validateManagementCriteria(managementConfig);
  if (violations.length > 0) {
    throw new ManagementQualityInputError(
      `Profile version management configuration is invalid: ${violations.join('; ')}`,
      'PROFILE_CONFIG_INVALID'
    );
  }
  const unsupportedEnabled = enabledManagementCriteria(managementConfig)
    .filter((criterion) => !MANAGEMENT_CRITERION_KEYS.includes(criterion.key))
    .map((criterion) => criterion.key);
  if (unsupportedEnabled.length > 0) {
    throw new ManagementQualityInputError(
      `Unsupported enabled Management criterion key(s): ${unsupportedEnabled.join(', ')}. ` +
        'No evaluator is implemented for them in Phase 4.',
      'PROFILE_CONFIG_INVALID'
    );
  }
}

function requiredManagementUserInputsFromConfig(managementConfig) {
  const enabledKeys = enabledManagementCriteria(managementConfig).map((criterion) => criterion.key);
  return enabledKeys.includes('trailing_ma') ? ['trailing_ma_period'] : [];
}

function allowedTrailingPeriodsFromConfig(managementConfig) {
  const trailing = enabledCriterion(managementConfig, 'trailing_ma');
  const allowed = trailing && trailing.parameters && Array.isArray(trailing.parameters.allowed_periods)
    ? trailing.parameters.allowed_periods
    : SUPPORTED_TRAILING_PERIODS;
  return [...allowed];
}

async function loadVersionForEvaluation(evaluation, userId) {
  const db = require('../../config/database');
  const versionResult = await db.query(
    `
      SELECT v.id, v.version_number, v.schema_version, v.configuration,
             p.name AS profile_name, p.id AS profile_id
      FROM quality_profile_versions v
      JOIN quality_profiles p ON p.id = v.profile_id
      WHERE v.id = $1 AND p.user_id = $2
    `,
    [evaluation.profile_version_id, userId]
  );
  if (versionResult.rows.length === 0) {
    throw new ManagementQualityInputError('Profile version not found or not owned by this user.', 'VERSION_NOT_FOUND');
  }
  return versionResult.rows[0];
}

async function resolveEvaluationForManagement(userId, tradeId, evaluationId) {
  if (evaluationId) {
    const evaluation = await getEvaluation(evaluationId, userId);
    if (!evaluation || String(evaluation.trade_id) !== String(tradeId)) {
      throw new ManagementQualityInputError(
        'Evaluation not found or not owned by this user/trade.',
        'EVALUATION_NOT_FOUND'
      );
    }
    if (TERMINAL_STATUSES.includes(evaluation.status)) {
      throw new ManagementQualityInputError(
        'This evaluation is terminal and immutable. Create a new evaluation to run Management Quality.',
        'EVALUATION_TERMINAL'
      );
    }
    return evaluation;
  }

  const db = require('../../config/database');
  const result = await db.query(
    `
      SELECT ${EVALUATION_COLUMNS}
      FROM trade_quality_evaluations
      WHERE user_id = $1
        AND trade_id = $2
        AND status NOT IN ('completed', 'insufficient_data')
        AND results->'setup' IS NOT NULL
        AND results->'entry' IS NOT NULL
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [userId, tradeId]
  );
  if (result.rows.length === 0) {
    throw new ManagementQualityInputError(
      'No draft evaluation with valid Setup and Entry results exists for this trade. Run Setup and Entry Quality first.',
      'MANAGEMENT_ENTRY_REQUIRED'
    );
  }
  return result.rows[0];
}

// Extracts the immutable Entry-owned state Management depends on.
function getEntryContext(evaluation) {
  const results = parseJsonField(evaluation.results);
  const evidence = parseJsonField(evaluation.evidence_snapshot) || {};
  if (!results || !results.setup || !results.entry) {
    throw new ManagementQualityInputError(
      'Management Quality requires evaluated Setup and Entry results. Run Setup and Entry Quality first.',
      'MANAGEMENT_ENTRY_REQUIRED'
    );
  }
  const entryEvidence = evidence.entry || {};
  const execution = entryEvidence.execution || {};
  const initialR = entryEvidence.initial_r || null;

  const entryBasis = isFiniteNumber(execution.entry_basis) ? execution.entry_basis : null;
  const originalPositionQty = isFiniteNumber(execution.original_position_qty)
    ? execution.original_position_qty
    : null;
  const actualEntrySession = execution.actual_entry_session || null;

  if (!entryBasis || !originalPositionQty || !actualEntrySession) {
    throw new ManagementQualityInputError(
      'The persisted Entry result is missing entry basis, original position, or actual entry session; re-run Entry Quality first.',
      'MANAGEMENT_ENTRY_INCOMPLETE'
    );
  }

  return {
    entryBasis,
    originalPositionQty,
    actualEntrySession,
    initialR: initialR && typeof initialR === 'object' ? initialR : null
  };
}

function fallbackEntrySession(trade) {
  if (!trade || !trade.entry_time) return null;
  return getDateInTimezone(trade.entry_time, MARKET_TZ, false);
}

async function resolveManagementDailyEvidence({ symbol, userId, entrySession }) {
  const fromDate = addCalendarDays(entrySession, -PRIOR_CALENDAR_DAYS);
  const toDate = addCalendarDays(entrySession, FORWARD_CALENDAR_DAYS);
  const loaded = await loadDailyEvidence({ symbol, userId, fromDate, toDate });
  const bars = normalizeDailyBars(loaded.bars);
  const indexMap = indexByDate(bars);
  const entryIndex = indexMap.has(entrySession) ? indexMap.get(entrySession) : -1;
  const authoritative = loaded.completeness === 'verified' && entryIndex >= 0;
  return {
    bars,
    entryIndex,
    authoritative,
    source: loaded.source,
    completeness: loaded.completeness || 'unverified',
    window: { fromDate, toDate },
    reason: loaded.error || null
  };
}

function parseTrailingPeriod(rawValue, { required, allowedPeriods }) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    if (required) {
      throw new ManagementQualityInputError(
        'trailing_ma_period is required by the active Trailing MA criterion.',
        'INPUT_REQUIRED'
      );
    }
    return null;
  }
  const period = Number(rawValue);
  if (!allowedPeriods.includes(period)) {
    throw new ManagementQualityInputError(
      `trailing_ma_period must be one of ${allowedPeriods.join(', ')}.`,
      'INVALID_TRAILING_PERIOD',
      { allowedPeriods, value: rawValue }
    );
  }
  return period;
}

function tickSizeFor(trade) {
  const stored = Number(trade && trade.tick_size);
  if (Number.isFinite(stored) && stored > 0) return stored;
  return 0.01;
}

// Builds the shared, deterministic Management state consumed by every
// Management criterion evaluator. All point-in-time decisions use only
// evidence observable at the relevant historical time.
function buildManagementState({
  trade,
  entryContext,
  daily,
  fills,
  stopHistory,
  trailingPeriod,
  partialTriggerParameters,
  targetPct,
  executionWindowMinutes,
  protectiveStopExecutions = []
}) {
  const initialR = entryContext.initialR && entryContext.initialR.available
    ? entryContext.initialR
    : { available: false, r_per_share: null, reason: entryContext.initialR ? entryContext.initialR.reason : 'Initial R unavailable.' };

  const rPerShare = initialR.available ? initialR.r_per_share : null;
  const entryBasis = entryContext.entryBasis;
  const entryIndex = daily.entryIndex;

  // Partial trigger (requires Initial R + verified daily sessions).
  let partialTrigger = null;
  if (initialR.available && daily.authoritative && rPerShare > 0) {
    partialTrigger = resolvePartialTrigger({
      bars: daily.bars,
      entryIndex,
      entryBasis,
      rPerShare,
      parameters: partialTriggerParameters
    });
  } else if (initialR.available && daily.authoritative) {
    partialTrigger = { triggered: false, reason: 'invalid_r', mfeByDay: [] };
  }

  // If the position was fully closed before the partial became due, the partial
  // rule is superseded (there is no position to take a partial of).
  if (
    partialTrigger &&
    partialTrigger.triggered &&
    fills.available &&
    fills.positionClosed &&
    fills.lastClosingSessionDate &&
    partialTrigger.dueSessionDate &&
    fills.lastClosingSessionDate < partialTrigger.dueSessionDate
  ) {
    partialTrigger = { ...partialTrigger, supersededByExit: true };
  }

  // Reductions and partial/premature resolution.
  const reductions = fills && fills.available ? fills.reductions : [];
  const partialCompletion = partialTrigger && partialTrigger.triggered
    ? resolvePartialCompletion({
        reductions,
        originalPositionQty: entryContext.originalPositionQty,
        targetPct: targetPct || 50,
        triggerDueSessionDate: partialTrigger.dueSessionDate || null,
        nextSessionDate: partialTrigger.dueSessionIndex !== null && partialTrigger.dueSessionIndex + 1 < daily.bars.length
          ? daily.bars[partialTrigger.dueSessionIndex + 1].date
          : null
      })
    : { completed: false, achievedFraction: null, achievedPct: null, timingOutcome: 'later_or_not_completed' };

  const boundarySessionDate = partialTrigger && partialTrigger.triggered
    ? partialTrigger.dueSessionDate
    : (fills.available && fills.positionClosed ? fills.lastClosingSessionDate : null);
  const prematureReduction = resolvePrematureReduction({
    reductions,
    originalPositionQty: entryContext.originalPositionQty,
    boundarySessionDate,
    protectiveStopExecutions
  });
  prematureReduction.boundarySessionDate = boundarySessionDate;
  prematureReduction.protectiveStopEvidenceAvailable = protectiveStopExecutions.length > 0;

  // Trailing MA resolution.
  const trailing = { selectedPeriod: trailingPeriod, signal: null, signalReason: null, superseded: false, supersededReason: null, execution: null };
  if (trailingPeriod && daily.authoritative) {
    const signal = findTrailingSignal(daily.bars, trailingPeriod, entryIndex);
    if (!signal) {
      if (fills.available && fills.positionClosed) {
        trailing.superseded = true;
        trailing.supersededReason = 'position closed before any selected-MA close signal';
      } else {
        trailing.signalReason = 'no selected-MA close signal within the available daily evidence';
      }
    } else if (fills.available && fills.positionClosed && fills.lastClosingSessionDate && fills.lastClosingSessionDate < signal.date) {
      trailing.superseded = true;
      trailing.supersededReason = 'position closed before the selected-MA close signal';
    } else if (fills.available && fills.positionClosed) {
      trailing.execution = classifyTrailingExecution({
        signal,
        bars: daily.bars,
        actualExitEpoch: fills.lastClosingTimeEpoch,
        regularSessionBounds,
        executionWindowMinutes: Number.isInteger(executionWindowMinutes) && executionWindowMinutes > 0
          ? executionWindowMinutes
          : 30
      });
    } else {
      trailing.signalReason = 'position not fully closed; trailing exit cannot be determined';
    }
  }

  // Breakeven deadline context (only meaningful with trustworthy stop history).
  const be = { deadlineEpoch: null, nextSessionCloseEpoch: null };
  if (partialCompletion.completionSessionDate) {
    const completionIndex = daily.bars.findIndex((bar) => bar.date === partialCompletion.completionSessionDate);
    if (completionIndex !== -1) {
      const completionBounds = regularSessionBounds(partialCompletion.completionSessionDate);
      be.deadlineEpoch = completionBounds ? completionBounds.closeEpoch : null;
      if (completionIndex + 1 < daily.bars.length) {
        const nextBounds = regularSessionBounds(daily.bars[completionIndex + 1].date);
        be.nextSessionCloseEpoch = nextBounds ? nextBounds.closeEpoch : null;
      }
    }
  }

  return {
    direction: 'long',
    entryBasis,
    originalPositionQty: entryContext.originalPositionQty,
    initialR,
    daily,
    fills,
    partialTrigger,
    partialCompletion,
    prematureReduction,
    stopHistory,
    trailing,
    be,
    tickSize: tickSizeFor(trade)
  };
}

function buildManagementCriterionRows(managementConfig, managementState, userInputs) {
  const rows = [];
  for (const criterionConfig of enabledManagementCriteria(managementConfig)) {
    const fragment = evaluateManagementCriterion(criterionConfig, {
      managementState,
      userInputs
    });
    const row = {
      key: criterionConfig.key,
      status: fragment.status,
      scoring_value: fragment.scoring_value,
      raw_value: fragment.raw_value,
      evidence: fragment.evidence,
      message: fragment.message
    };
    if (fragment.status === CRITERION_STATUS.PASS || fragment.status === CRITERION_STATUS.FAIL) {
      if (criterionConfig.weight > 0) {
        const derived = deriveScoreForCriterion({
          status: fragment.status,
          scoring: criterionConfig.scoring,
          scoringValue: fragment.scoring_value
        });
        if (derived.error) {
          throw new ManagementQualityInputError(
            `Criterion "${criterionConfig.key}" could not be scored: ${derived.error}`,
            'SCORING_INVALID'
          );
        }
        row.score = derived.score;
      } else {
        row.score = null;
      }
    }
    rows.push(row);
  }
  return rows;
}

function buildManagementEvidenceBlock({ daily, fills, stopHistory, partialTrigger, partialCompletion, prematureReduction, trailing, entryContext }) {
  return {
    preparedAt: new Date().toISOString(),
    entry_dependency: {
      entry_basis: entryContext.entryBasis,
      original_position_qty: entryContext.originalPositionQty,
      actual_entry_session: entryContext.actualEntrySession,
      initial_r: entryContext.initialR || null
    },
    daily: daily
      ? {
          source: daily.source,
          completeness: daily.completeness,
          authoritative: daily.authoritative === true,
          requested_window: daily.window || null,
          entry_session: entryContext.actualEntrySession,
          entry_index: daily.entryIndex,
          bars: daily.bars ? daily.bars.length : 0,
          error: daily.reason || null
        }
      : null,
    fills: fills
      ? {
          available: fills.available,
          reductions: fills.reductions || [],
          total_reduction_qty: fills.totalReductionQty,
          position_closed: fills.positionClosed,
          last_closing_time: fills.lastClosingTimeEpoch
            ? new Date(fills.lastClosingTimeEpoch * 1000).toISOString()
            : null,
          last_closing_session: fills.lastClosingSessionDate
        }
      : null,
    stop_history: stopHistory
      ? {
          available: stopHistory.available,
          source: stopHistory.source,
          provenance: stopHistory.provenance || null,
          reason: stopHistory.reason || null
        }
      : null,
    partial_trigger: partialTrigger
      ? {
          triggered: partialTrigger.triggered,
          due_day: partialTrigger.dueDay || null,
          due_session: partialTrigger.dueSessionDate || null,
          first_reach_day: partialTrigger.firstReachDay || null,
          reached_early: partialTrigger.reachedEarly || false,
          superseded_by_exit: partialTrigger.supersededByExit || false,
          reason: partialTrigger.reason || null,
          mfe_by_day: partialTrigger.mfeByDay || []
        }
      : null,
    partial_completion: partialCompletion
      ? {
          completed: partialCompletion.completed,
          achieved_pct: partialCompletion.achievedPct,
          completion_session: partialCompletion.completionSessionDate || null,
          timing_outcome: partialCompletion.timingOutcome || null
        }
      : null,
    premature_reduction: prematureReduction
      ? {
          premature_qty: prematureReduction.prematureQty,
          premature_fraction: prematureReduction.prematureFraction,
          excluded_qty: prematureReduction.excludedQty || 0,
          boundary_session_date: prematureReduction.boundarySessionDate || null
        }
      : null,
    trailing: trailing
      ? {
          selected_period: trailing.selectedPeriod || null,
          signal_date: trailing.signal ? trailing.signal.date : null,
          signal_close: trailing.signal ? trailing.signal.close : null,
          signal_ma_value: trailing.signal ? trailing.signal.sma : null,
          superseded: trailing.superseded,
          superseded_reason: trailing.supersededReason || null,
          signal_reason: trailing.signalReason || null,
          execution: trailing.execution
            ? {
                outcome: trailing.execution.outcome,
                next_session_date: trailing.execution.nextSessionDate || null,
                actual_exit_epoch: trailing.execution.actualExitEpoch ?? null
              }
            : null
        }
      : null
  };
}

function computeManagementDependencyFingerprint(evaluation) {
  const detected = parseJsonField(evaluation.detected_context) || {};
  return setupDependencyFingerprint({
    profileVersionId: evaluation.profile_version_id,
    boundary: detected.boundary || null,
    evidenceSnapshot: parseJsonField(evaluation.evidence_snapshot) || null
  });
}

function computeManagementEntryDependencyFingerprint(evaluation) {
  const evidence = parseJsonField(evaluation.evidence_snapshot) || {};
  return entryDependencyFingerprint({
    profileVersionId: evaluation.profile_version_id,
    entryEvidence: evidence.entry || null
  });
}

/**
 * Prepares Management Quality for an existing draft evaluation (read-only).
 */
async function prepare(userId, tradeId, { evaluationId } = {}) {
  const trade = await getTradeForUser(userId, tradeId);
  if (!trade) {
    throw new ManagementQualityInputError('Trade not found or not owned by this user.', 'TRADE_NOT_FOUND');
  }
  const evaluation = await resolveEvaluationForManagement(userId, tradeId, evaluationId);
  const version = await loadVersionForEvaluation(evaluation, userId);
  const managementConfig = getManagementDimensionConfig(version.configuration);
  assertValidManagementConfiguration(managementConfig);

  const entryContext = getEntryContext(evaluation);
  const prepareInputs = parseJsonField(evaluation.user_inputs) || {};
  const prepareDetected = parseJsonField(evaluation.detected_context) || {};
  const requiredInputs = requiredManagementUserInputsFromConfig(managementConfig);

  const immutableTrailing =
    prepareInputs.immutable_semantic_context &&
    prepareInputs.immutable_semantic_context.trailing_ma &&
    typeof prepareInputs.immutable_semantic_context.trailing_ma.value === 'number'
      ? prepareInputs.immutable_semantic_context.trailing_ma
      : null;
  const establishedTrailing =
    (immutableTrailing && immutableTrailing.value) ||
    (Number.isFinite(Number(prepareInputs.trailing_ma_period)) ? Number(prepareInputs.trailing_ma_period) : null) ||
    null;

  return {
    evaluation: toFrontendEvaluation(evaluation),
    profileVersion: {
      id: version.id,
      profileId: version.profile_id,
      profileName: version.profile_name,
      versionNumber: version.version_number,
      schemaVersion: version.schema_version
    },
    entryDependency: {
      ready: true,
      entryBasis: entryContext.entryBasis,
      originalPositionQty: entryContext.originalPositionQty,
      actualEntrySession: entryContext.actualEntrySession,
      initialR: entryContext.initialR
    },
    trailingMa: {
      value: establishedTrailing,
      established: !!establishedTrailing,
      selectedAt:
        (immutableTrailing && immutableTrailing.selected_at) ||
        (prepareDetected.management &&
          prepareDetected.management.trailing_ma &&
          prepareDetected.management.trailing_ma.selectedAt) ||
        null,
      timing:
        (immutableTrailing && immutableTrailing.timing) || null
    },
    allowedTrailingPeriods: requiredInputs.includes('trailing_ma_period')
      ? allowedTrailingPeriodsFromConfig(managementConfig)
      : [],
    requiredManagementUserInputs: requiredInputs,
    managementCriterionKeys: enabledManagementCriteria(managementConfig).map((criterion) => criterion.key)
  };
}

/**
 * Evaluates and persists NON-TERMINAL Management progress, preserving the valid
 * Setup and Entry results.
 */
async function evaluate(userId, tradeId, { evaluationId, userInputs: rawUserInputs } = {}) {
  if (!evaluationId) {
    throw new ManagementQualityInputError('Run management prepare() first; evaluationId is required.', 'EVALUATION_REQUIRED');
  }
  const trade = await getTradeForUser(userId, tradeId);
  if (!trade) {
    throw new ManagementQualityInputError('Trade not found or not owned by this user.', 'TRADE_NOT_FOUND');
  }
  const evaluation = await resolveEvaluationForManagement(userId, tradeId, evaluationId);
  const version = await loadVersionForEvaluation(evaluation, userId);
  const managementConfig = getManagementDimensionConfig(version.configuration);
  assertValidManagementConfiguration(managementConfig);

  const entryContext = getEntryContext(evaluation);
  const requiredInputs = requiredManagementUserInputsFromConfig(managementConfig);
  const allowedPeriods = requiredInputs.includes('trailing_ma_period')
    ? allowedTrailingPeriodsFromConfig(managementConfig)
    : [];
  const raw = rawUserInputs && typeof rawUserInputs === 'object' ? rawUserInputs : {};

  // Trailing MA selection is a frozen semantic assertion for this evaluation:
  // the first assertion wins (provenance user_asserted, post-trade timing).
  const storedInputs = parseJsonField(evaluation.user_inputs) || {};
  const storedDetected = parseJsonField(evaluation.detected_context) || {};
  const storedImmutableTrailing =
    storedInputs.immutable_semantic_context &&
    storedInputs.immutable_semantic_context.trailing_ma &&
    typeof storedInputs.immutable_semantic_context.trailing_ma.value === 'number'
      ? storedInputs.immutable_semantic_context.trailing_ma
      : null;
  const persistedTrailing =
    storedImmutableTrailing && storedImmutableTrailing.value
      ? storedImmutableTrailing.value
      : (Number.isFinite(Number(storedInputs.trailing_ma_period)) ? Number(storedInputs.trailing_ma_period) : null);
  const requestedTrailing = raw.trailing_ma_period;
  let trailingPeriod = null;
  let trailingMode = 'none';
  let trailingSelectedAt = null;
  if (persistedTrailing) {
    if (
      requestedTrailing === undefined ||
      requestedTrailing === null ||
      requestedTrailing === '' ||
      Number(requestedTrailing) === persistedTrailing
    ) {
      trailingPeriod = persistedTrailing;
    } else {
      throw new ManagementQualityInputError(
        `trailing_ma_period is immutable for this evaluation (already asserted as ${persistedTrailing}). Create a new evaluation to use a different trailing MA.`,
        'TRAILING_MA_IMMUTABLE',
        { persisted: persistedTrailing, requested: requestedTrailing, allowedPeriods }
      );
    }
    trailingMode = 'preserve';
    trailingSelectedAt =
      (storedImmutableTrailing && storedImmutableTrailing.selected_at) ||
      (storedDetected.management && storedDetected.management.trailing_ma && storedDetected.management.trailing_ma.selectedAt) ||
      null;
  } else if (requiredInputs.includes('trailing_ma_period')) {
    trailingPeriod = parseTrailingPeriod(requestedTrailing, { required: true, allowedPeriods });
    trailingMode = trailingPeriod !== null ? 'establish' : 'none';
  }

  const symbol = String(trade.symbol || '').trim().toUpperCase();
  const entrySession = entryContext.actualEntrySession || fallbackEntrySession(trade);
  const daily = entrySession && symbol
    ? await resolveManagementDailyEvidence({ symbol, userId, entrySession })
    : { bars: [], entryIndex: -1, authoritative: false, source: null, completeness: 'unverified', window: null, reason: 'no entry session/symbol' };

  const fillsResult = reconstructManagementFills(trade);
  const fills = fillsResult
    ? reconstructReductions({
        fills: fillsResult.fills,
        direction: fillsResult.direction,
        originalPositionQty: entryContext.originalPositionQty,
        sessionDateInZone
      })
    : null;
  const fillsState = fills
    ? { available: true, ...fills }
    : { available: false, reductions: [], totalReductionQty: null, positionClosed: false, lastClosingTimeEpoch: null, lastClosingSessionDate: null, remainingQty: null };

  // Production: no trustworthy stop-history source exists -> UNKNOWN.
  const stopHistory = resolveStopHistory({});

  // Profile-owned partial trigger / sizing parameters.
  const partialTimingCriterion = enabledCriterion(managementConfig, 'partial_timing');
  const partialSizingCriterion = enabledCriterion(managementConfig, 'partial_sizing');
  const trailingMaCriterion = enabledCriterion(managementConfig, 'trailing_ma');
  const partialTriggerParameters = partialTimingCriterion
    ? {
        earliest_day: partialTimingCriterion.parameters.earliest_day,
        latest_day: partialTimingCriterion.parameters.latest_day,
        minimum_mfe_r: partialTimingCriterion.parameters.minimum_mfe_r
      }
    : { earliest_day: 3, latest_day: 5, minimum_mfe_r: 1.0 };
  const targetPct = partialSizingCriterion
    ? partialSizingCriterion.parameters.target_pct
    : 50;
  const executionWindowMinutes = trailingMaCriterion
    ? trailingMaCriterion.parameters.execution_window_minutes
    : 30;

  const managementState = buildManagementState({
    trade,
    entryContext,
    daily,
    fills: fillsState,
    stopHistory,
    trailingPeriod,
    partialTriggerParameters,
    targetPct,
    executionWindowMinutes,
    protectiveStopExecutions: []
  });

  const criterionRows = buildManagementCriterionRows(managementConfig, managementState, {
    trailing_ma_period: trailingPeriod
  });

  const managementEvidenceBlock = buildManagementEvidenceBlock({
    daily,
    fills: fillsState,
    stopHistory,
    partialTrigger: managementState.partialTrigger,
    partialCompletion: managementState.partialCompletion,
    prematureReduction: managementState.prematureReduction,
    trailing: managementState.trailing,
    entryContext
  });

  const managementDetectedContext = {
    evaluatedAt: new Date().toISOString(),
    trailing_ma: trailingPeriod
      ? { value: trailingPeriod, source: 'user_asserted', selectedAt: trailingSelectedAt || new Date().toISOString(), timing: 'post_trade' }
      : null
  };

  const dependencyFingerprint = computeManagementDependencyFingerprint(evaluation);
  const entryDependency = computeManagementEntryDependencyFingerprint(evaluation);

  let updated;
  try {
    updated = await saveManagementProgress(evaluationId, userId, {
      managementResults: { criterionResults: criterionRows },
      managementEvidence: managementEvidenceBlock,
      managementDetectedContext,
      dependencyFingerprint,
      entryDependencyFingerprint: entryDependency,
      trailingMa: {
        mode: trailingMode,
        value: trailingPeriod,
        selectedAt: trailingSelectedAt
      }
    });
  } catch (error) {
    if (
      error &&
      (error.code === 'STALE_DEPENDENCY' ||
        error.code === 'STALE_ENTRY_DEPENDENCY' ||
        error.code === 'TRAILING_MA_IMMUTABLE')
    ) {
      throw new ManagementQualityInputError(error.message, error.code);
    }
    throw error;
  }
  if (!updated) {
    throw new ManagementQualityInputError(
      'Evaluation could not be updated (it may have reached a terminal state).',
      'EVALUATION_TERMINAL'
    );
  }

  return {
    evaluation: toFrontendEvaluation(updated),
    profileVersion: {
      id: version.id,
      profileId: version.profile_id,
      profileName: version.profile_name,
      versionNumber: version.version_number,
      schemaVersion: version.schema_version
    },
    management: {
      entryBasis: entryContext.entryBasis,
      originalPositionQty: entryContext.originalPositionQty,
      initialR: managementState.initialR,
      trailingMaPeriod: trailingPeriod,
      partialTrigger: managementState.partialTrigger,
      stopHistoryAvailable: stopHistory.available
    }
  };
}

/**
 * Finalizes an evaluation with complete Setup + Entry + Management results to
 * a terminal `completed` state (immutable). Uses the Phase 1 saveResult
 * contract, which re-validates all dimensions against the immutable profile
 * version and recomputes the authoritative aggregate.
 */
async function finalize(userId, tradeId, { evaluationId } = {}) {
  if (!evaluationId) {
    throw new ManagementQualityInputError('evaluationId is required to finalize.', 'EVALUATION_REQUIRED');
  }
  const evaluation = await resolveEvaluationForManagement(userId, tradeId, evaluationId);
  const results = parseJsonField(evaluation.results);
  if (!results || !results.setup || !results.entry || !results.management) {
    throw new ManagementQualityInputError(
      'Setup, Entry, and Management results are all required before an evaluation can be completed.',
      'MANAGEMENT_INCOMPLETE'
    );
  }

  const completed = await saveResult(evaluationId, userId, {
    status: EVALUATION_STATUS.COMPLETED,
    results: { setup: results.setup, entry: results.entry, management: results.management }
  });
  if (!completed) {
    throw new ManagementQualityInputError(
      'Evaluation could not be completed (it may already be terminal).',
      'EVALUATION_TERMINAL'
    );
  }
  return { evaluation: toFrontendEvaluation(completed) };
}

async function listEvaluations(userId, tradeId) {
  const setupQualityService = require('./setupQualityService');
  return setupQualityService.listEvaluations(userId, tradeId);
}

module.exports = {
  ManagementQualityInputError,
  prepare,
  evaluate,
  finalize,
  listEvaluations,
  // exposed for tests
  getTradeForUser,
  getManagementDimensionConfig,
  enabledManagementCriteria,
  assertValidManagementConfiguration,
  requiredManagementUserInputsFromConfig,
  allowedTrailingPeriodsFromConfig,
  getEntryContext,
  buildManagementState,
  buildManagementCriterionRows,
  buildManagementEvidenceBlock,
  parseTrailingPeriod,
  resolveManagementDailyEvidence,
  computeManagementDependencyFingerprint,
  computeManagementEntryDependencyFingerprint,
  toFrontendEvaluation
};
