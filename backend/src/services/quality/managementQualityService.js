'use strict';

// Management Quality orchestration service (Phase 4 of
// docs/QUALITY_PROFILES_REQUIREMENT.md, sections 33-46, 49, 57, 63; hardened).
//
// Prepare -> Select trailing MA/activation -> Evaluate -> Finalize workflow.
//
// Point-in-time and evidence discipline:
//   - Day 1's MFE uses only post-entry evidence (intraday where the entry is
//     not at the open); Days 2+ daily highs are fully post-entry.
//   - The +1R crossing session/timestamp is resolved from trustworthy intraday
//     evidence where available, with explicit precision and provenance.
//   - Observation maturity is explicit: never_reached only after the partial
//     window has completed; otherwise the trigger is pending/insufficient.
//   - Protective-stop classification is never fabricated: when TradeTally
//     cannot distinguish a discretionary reduction from a protective-stop
//     execution, the affected criteria are UNKNOWN.
//   - No hidden canonical policy: every shared policy value is resolved from
//     the immutable profile version.

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
const { loadSessionIntradayBars, missingIntervalStarts } = require('./intradayEvidenceService');
const { setupDependencyFingerprint, entryDependencyFingerprint } = require('./dependencyFingerprint');
const {
  reconstructManagementFills,
  reconstructReductions
} = require('./management/executionFills');
const { resolveStopHistory, resolveStopExecutionClassification } = require('./management/stopHistory');
const {
  buildDayEvidence,
  resolvePartialTrigger,
  findCrossingInSession
} = require('./management/managementDays');
const {
  resolvePartialCompletion,
  resolvePrematureReduction,
  resolvePartialExitSupersession
} = require('./management/partial');
const { findTrailingSignal, classifyTrailingExecution } = require('./management/trailingMa');
const { resolveManagementPolicy } = require('./management/policy');
const { resolveQuantityUnit, resolveTickSize } = require('./management/quantityUnit');
const { regularSessionBounds, sessionDateInZone } = require('./entry/sessionTime');
const { validateManagementCriteria, SUPPORTED_TRAILING_PERIODS } = require('./criteria/management/parameterSchemas');
const { MANAGEMENT_CRITERION_KEYS, evaluateManagementCriterion } = require('./managementCriterionRegistry');
const { getDateInTimezone } = require('../../utils/timezone');

const MARKET_TZ = 'America/New_York';
const TERMINAL_STATUSES = Object.freeze(['completed', 'insufficient_data']);
const PRIOR_CALENDAR_DAYS = 45;
const FORWARD_CALENDAR_DAYS = 10;

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

function nowEpochSeconds() {
  return Math.floor(Date.now() / 1000);
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
    throw new ManagementQualityInputError('Profile version has no management dimension configuration.', 'PROFILE_CONFIG_INVALID');
  }
  const managementConfig = configuration.dimensions.management;
  if (!Array.isArray(managementConfig.criteria)) {
    throw new ManagementQualityInputError('Profile version management dimension has no criteria.', 'PROFILE_CONFIG_INVALID');
  }
  return managementConfig;
}

function enabledManagementCriteria(managementConfig) {
  return managementConfig.criteria.filter((criterion) => criterion.enabled === undefined || criterion.enabled === true);
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
      `Unsupported enabled Management criterion key(s): ${unsupportedEnabled.join(', ')}.`,
      'PROFILE_CONFIG_INVALID'
    );
  }
}

function requiredManagementUserInputsFromConfig(managementConfig) {
  const trailing = enabledCriterion(managementConfig, 'trailing_ma');
  if (!trailing) return [];
  const policy = resolveManagementPolicy(managementConfig);
  if (policy.trailingActivation === 'explicit') {
    return ['trailing_ma_period', 'trailing_phase'];
  }
  return ['trailing_ma_period'];
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
      throw new ManagementQualityInputError('Evaluation not found or not owned by this user/trade.', 'EVALUATION_NOT_FOUND');
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
  const originalPositionQty = isFiniteNumber(execution.original_position_qty) ? execution.original_position_qty : null;
  const actualEntrySession = execution.actual_entry_session || null;
  const entryEpoch = isFiniteNumber(execution.initial_entry_fill_epoch)
    ? execution.initial_entry_fill_epoch
    : (execution.initial_entry_time ? Math.floor(Date.parse(execution.initial_entry_time) / 1000) : null);

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
    entryEpoch,
    initialR: initialR && typeof initialR === 'object' ? initialR : null
  };
}

function isSessionCompleted(sessionDate, nowEpoch) {
  const bounds = regularSessionBounds(sessionDate);
  if (!bounds || !isFiniteNumber(bounds.closeEpoch)) return false;
  return bounds.closeEpoch <= nowEpoch;
}

function lastCompletedIndex(bars, nowEpoch) {
  let index = -1;
  for (let i = 0; i < bars.length; i += 1) {
    if (isSessionCompleted(bars[i].date, nowEpoch)) index = i;
  }
  return index;
}

function todayInMarket() {
  return getDateInTimezone(new Date(), MARKET_TZ, false);
}

async function resolveManagementDailyEvidence({ symbol, userId, entrySession, anchorSession, nowEpoch }) {
  const fromDate = addCalendarDays(entrySession, -PRIOR_CALENDAR_DAYS);
  const anchor = anchorSession || todayInMarket();
  let toDate = addCalendarDays(anchor, FORWARD_CALENDAR_DAYS);
  // Always cover the partial window with margin even for a very young trade.
  const partialWindowEnd = addCalendarDays(entrySession, 14);
  if (toDate < partialWindowEnd) toDate = partialWindowEnd;

  const loaded = await loadDailyEvidence({ symbol, userId, fromDate, toDate });
  const bars = normalizeDailyBars(loaded.bars);
  const indexMap = indexByDate(bars);
  const entryIndex = indexMap.has(entrySession) ? indexMap.get(entrySession) : -1;
  const completedThroughIndex = lastCompletedIndex(bars, nowEpoch);
  const authoritative = loaded.completeness === 'verified' && entryIndex >= 0;
  return {
    bars,
    entryIndex,
    completedThroughIndex,
    indexMap,
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
      throw new ManagementQualityInputError('trailing_ma_period is required by the active Trailing MA criterion.', 'INPUT_REQUIRED');
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

function parseTrailingPhase(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  if (rawValue === 'activated' || rawValue === 'not_activated') return rawValue;
  throw new ManagementQualityInputError(
    `trailing_phase must be one of activated, not_activated; got ${JSON.stringify(rawValue)}.`,
    'INVALID_TRAILING_PHASE'
  );
}

// Validates an asserted activation session date (YYYY-MM-DD). Malformed values
// are rejected rather than silently ignored.
function parseActivationSession(rawValue) {
  if (rawValue === undefined || rawValue === null || rawValue === '') return null;
  const value = String(rawValue);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ManagementQualityInputError(
      `trailing_activation_session must be a YYYY-MM-DD session date; got ${JSON.stringify(rawValue)}.`,
      'INVALID_ACTIVATION_SESSION'
    );
  }
  return value;
}

// Day 1 post-entry high. The whole daily bar is valid only when the actual
// entry is at/before the regular-session open; otherwise only evidence
// genuinely observable at/after the entry and within the Day-1 regular session
// is used. The 1-minute bar CONTAINING the entry mixes pre- and post-entry
// action: its whole high is never treated as post-entry evidence, but if it
// could have crossed +1R the Day-1 first reach is marked UNCERTAIN (never
// silently ruled out by later complete bars).
async function resolveDayOnePostEntryHigh({
  day1Bar,
  entryEpoch,
  entryBasis,
  rPerShare,
  minimumMfeR,
  symbol,
  userId,
  observations
}) {
  const bounds = day1Bar ? regularSessionBounds(day1Bar.date) : null;
  const thresholdPrice = isFiniteNumber(entryBasis) && isFiniteNumber(rPerShare)
    ? entryBasis + minimumMfeR * rPerShare
    : null;
  if (!day1Bar || !bounds) {
    return { highKnown: false, high: null, highValueKnown: false, possibleX: false, precision: null, source: null, reason: 'day1_session_unknown' };
  }
  if (isFiniteNumber(entryEpoch) && entryEpoch <= bounds.openEpoch) {
    // The actual entry is at/before the open, so the entire regular session is
    // post-entry and the completed daily high is exact.
    return { highKnown: true, high: day1Bar.high, highValueKnown: true, possibleX: false, precision: 'daily_bar', source: 'daily_bar', reason: null };
  }
  const dailyAtOrAboveThreshold = thresholdPrice !== null
    && isFiniteNumber(day1Bar.high)
    && day1Bar.high >= thresholdPrice;

  const resolutionSeconds = 60;
  const firstPostEntryInterval = isFiniteNumber(entryEpoch)
    ? bounds.openEpoch + Math.ceil((entryEpoch - bounds.openEpoch) / resolutionSeconds) * resolutionSeconds
    : bounds.openEpoch;

  // The completed daily high itself is below the threshold: a definitive
  // no-cross even when intraday evidence is sparse or absent.
  if (!dailyAtOrAboveThreshold) {
    return {
      highKnown: true, high: null, highValueKnown: false,
      definitivelyBelowThreshold: true, possibleX: false,
      precision: null, source: null, reason: 'day1_daily_high_below_threshold'
    };
  }

  const boundedObservations = (observations || []).filter((obs) =>
    isFiniteNumber(obs.price) && obs.price > 0 &&
    isFiniteNumber(obs.epoch) &&
    obs.epoch >= bounds.openEpoch &&
    obs.epoch < bounds.closeEpoch &&
    (!isFiniteNumber(entryEpoch) || obs.epoch >= entryEpoch)
  );

  let postEntryHigh = -Infinity;
  let precision = null;
  let source = null;
  let containingPossibleX = false;
  let intradayAvailable = false;
  let intradayBars = [];
  try {
    const intraday = await loadSessionIntradayBars(symbol, day1Bar.date, userId);
    if (intraday && intraday.available && intraday.bars.length > 0) {
      intradayAvailable = true;
      intradayBars = intraday.bars;
      for (const bar of intraday.bars) {
        if (!isFiniteNumber(bar.time) || !isFiniteNumber(bar.high)) continue;
        if (bar.time < bounds.openEpoch || bar.time >= bounds.closeEpoch) continue;
        const containsEntry = isFiniteNumber(entryEpoch)
          && entryEpoch > bar.time
          && entryEpoch < bar.time + resolutionSeconds;
        if (containsEntry) {
          if (thresholdPrice !== null && bar.high >= thresholdPrice) containingPossibleX = true;
          continue; // never use the containing bar's whole high as post-entry
        }
        if (isFiniteNumber(entryEpoch) && bar.time < entryEpoch) continue;
        postEntryHigh = Math.max(postEntryHigh, bar.high);
        precision = '1min_bar';
        source = intraday.source || 'intraday_cache';
      }
    }
  } catch (error) {
    // Fall through; bounded observations may still establish the high.
  }
  for (const obs of boundedObservations) {
    if (obs.price > postEntryHigh) {
      postEntryHigh = obs.price;
      if (precision !== '1min_bar') {
        precision = 'execution_print';
        source = 'executions_jsonb';
      }
    }
  }

  if (thresholdPrice !== null && postEntryHigh >= thresholdPrice) {
    // An observed fully post-entry bar or execution print establishes the
    // crossing (no need for a gap-free full session), but the exact maximum may
    // be understated by gaps, so the exact value is not claimed.
    return { highKnown: true, high: postEntryHigh, highValueKnown: false, possibleX: false, precision: precision || 'execution_print', source: source || 'executions_jsonb', reason: null };
  }
  if (containingPossibleX) {
    return { highKnown: false, high: null, highValueKnown: false, possibleX: true, precision: null, source: null, reason: 'day1_containing_bar_could_cross' };
  }
  if (intradayAvailable) {
    // Sparse post-entry evidence cannot prove a no-cross: the daily high is
    // at/above the threshold and one or more required post-entry intervals are
    // missing, so Day 1 remains potentially a crossing day.
    const missing = missingIntervalStarts(intradayBars, firstPostEntryInterval, bounds.closeEpoch, resolutionSeconds);
    if (missing.length > 0) {
      return {
        highKnown: false, high: null, highValueKnown: false, possibleX: true,
        precision: null, source: null, reason: 'day1_post_entry_intervals_missing',
        missingIntervals: missing.length
      };
    }
    return {
      highKnown: true,
      high: postEntryHigh === -Infinity ? null : postEntryHigh,
      highValueKnown: postEntryHigh !== -Infinity,
      definitivelyBelowThreshold: true,
      possibleX: false,
      precision,
      source,
      reason: null
    };
  }
  // No intraday evidence at all and the daily high is at/above the threshold:
  // the crossing could have happened post-entry, so Day 1 is uncertain.
  return { highKnown: false, high: null, highValueKnown: false, possibleX: true, precision: null, source: null, reason: 'day1_post_entry_evidence_unavailable' };
}

function buildManagementState({
  trade,
  entryContext,
  daily,
  fills,
  policy,
  quantityUnit,
  tickSize,
  stopHistory,
  stopExecutionClassification,
  partialTrigger,
  partialCompletion,
  partialExit,
  prematureReduction,
  trailing,
  be,
  nowEpoch
}) {
  const initialR = entryContext.initialR && entryContext.initialR.available
    ? entryContext.initialR
    : { available: false, r_per_share: null, reason: entryContext.initialR ? entryContext.initialR.reason : 'Initial R unavailable.' };

  const horizon = {
    observedDays: partialTrigger ? partialTrigger.observedDays : 0,
    horizonComplete: partialTrigger ? partialTrigger.horizonComplete : false,
    latestDay: policy.partialTrigger ? policy.partialTrigger.latest_day : null,
    completedThroughIndex: daily.completedThroughIndex,
    nowEpoch
  };

  return {
    direction: 'long',
    entryBasis: entryContext.entryBasis,
    originalPositionQty: entryContext.originalPositionQty,
    initialR,
    daily,
    fills,
    policy,
    quantityUnit,
    tickSize: tickSize || { known: false, tickSize: null },
    stopHistory,
    stopExecutionClassification,
    partialTrigger,
    partialCompletion,
    partialExit,
    prematureReduction,
    trailing,
    be,
    horizon
  };
}

function buildManagementCriterionRows(managementConfig, managementState, userInputs) {
  const rows = [];
  for (const criterionConfig of enabledManagementCriteria(managementConfig)) {
    const fragment = evaluateManagementCriterion(criterionConfig, { managementState, userInputs });
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

function buildManagementEvidenceBlock({
  daily, fills, stopHistory, stopExecutionClassification, policy, quantityUnit, tickSize,
  partialTrigger, partialCompletion, partialExit, prematureReduction, trailing, entryContext, nowEpoch
}) {
  return {
    preparedAt: new Date().toISOString(),
    policy: {
      partial_trigger: policy.partialTrigger,
      partial_trigger_source: policy.partialTriggerSource,
      partial_target: policy.partialTarget,
      partial_target_source: policy.partialTargetSource,
      partial_tolerance_source: policy.partialToleranceSource,
      completion_window: policy.completionWindow,
      post_partial_deadline_sessions: policy.postPartialDeadlineSessions,
      execution_window_minutes: policy.executionWindowMinutes,
      trailing_activation: policy.trailingActivation,
      trailing_activation_source: policy.trailingActivationSource,
      available: policy.available
    },
    entry_dependency: {
      entry_basis: entryContext.entryBasis,
      original_position_qty: entryContext.originalPositionQty,
      actual_entry_session: entryContext.actualEntrySession,
      initial_r: entryContext.initialR || null
    },
    quantity_unit: quantityUnit,
    tick_size: tickSize,
    daily: daily
      ? {
          source: daily.source,
          completeness: daily.completeness,
          authoritative: daily.authoritative === true,
          requested_window: daily.window || null,
          entry_session: entryContext.actualEntrySession,
          entry_index: daily.entryIndex,
          completed_through_index: daily.completedThroughIndex,
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
          last_closing_time: fills.lastClosingTimeEpoch ? new Date(fills.lastClosingTimeEpoch * 1000).toISOString() : null,
          last_closing_price: fills.lastClosingPrice ?? null,
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
    stop_execution_classification: {
      available: !!(stopExecutionClassification && stopExecutionClassification.available),
      complete: !!(stopExecutionClassification && stopExecutionClassification.complete),
      reason: stopExecutionClassification ? stopExecutionClassification.reason || null : null
    },
    partial_trigger: partialTrigger
      ? {
          status: partialTrigger.status,
          triggered: partialTrigger.triggered === true,
          due_day: partialTrigger.dueDay || null,
          due_session: partialTrigger.dueSessionDate || null,
          due_session_completed: partialTrigger.dueSessionCompleted === true,
          first_reach_day: partialTrigger.firstReachDay || null,
          first_reach_session: partialTrigger.firstReachSessionDate || null,
          reached_early: partialTrigger.reachedEarly === true,
          horizon_complete: partialTrigger.horizonComplete === true,
          observed_days: partialTrigger.observedDays,
          crossing_time: partialTrigger.crossing && partialTrigger.crossing.epoch
            ? new Date(partialTrigger.crossing.epoch * 1000).toISOString()
            : null,
          crossing_precision: partialTrigger.crossing ? partialTrigger.crossing.precision : null,
          crossing_source: partialTrigger.crossing ? partialTrigger.crossing.source : null,
          crossing_interval_start: partialTrigger.crossing ? partialTrigger.crossing.intervalStartEpoch ?? null : null,
          crossing_interval_end: partialTrigger.crossing ? partialTrigger.crossing.intervalEndEpoch ?? null : null,
          crossing_uncertain: partialTrigger.crossing ? partialTrigger.crossing.uncertain === true : false,
          crossing_uncertainty_start: partialTrigger.crossing ? partialTrigger.crossing.uncertaintyStartEpoch ?? null : null,
          crossing_uncertainty_end: partialTrigger.crossing ? partialTrigger.crossing.uncertaintyEndEpoch ?? null : null,
          crossing_authoritative: partialTrigger.crossing ? partialTrigger.crossing.authoritative === true : false,
          boundary: partialTrigger.boundary
            ? {
                kind: partialTrigger.boundary.kind,
                session: partialTrigger.boundary.sessionDate || null,
                epoch: partialTrigger.boundary.epoch,
                interval_start: partialTrigger.boundary.intervalStartEpoch ?? null,
                interval_end: partialTrigger.boundary.intervalEndEpoch ?? null,
                uncertainty_start: partialTrigger.boundary.uncertaintyStartEpoch ?? null,
                uncertainty_end: partialTrigger.boundary.uncertaintyEndEpoch ?? null,
                uncertainty_basis: partialTrigger.boundary.uncertaintyBasis ?? null,
                uncertain: partialTrigger.boundary.uncertain === true,
                precision: partialTrigger.boundary.precision || null,
                source: partialTrigger.boundary.source || null,
                ordering_known: partialTrigger.boundary.orderingKnown === true
              }
            : null,
          reason: partialTrigger.reason || null,
          mfe_by_day: partialTrigger.mfeByDay || []
        }
      : null,
    partial_completion: partialCompletion
      ? {
          completed: partialCompletion.completed,
          achieved_pct: partialCompletion.achievedPct,
          achieved_qty: partialCompletion.achievedQty,
          required_qty: partialCompletion.rounding ? partialCompletion.rounding.requiredQty : null,
          quantity_unit: partialCompletion.rounding ? partialCompletion.rounding.unit : null,
          rounding_resolved: partialCompletion.rounding ? partialCompletion.rounding.resolved : null,
          completion_session: partialCompletion.completionSessionDate || null,
          completion_relation: partialCompletion.completionRelation || null,
          sessions_after_trigger: partialCompletion.sessionsAfterTrigger,
          timing_outcome: partialCompletion.timingOutcome || null
        }
      : null,
    partial_exit: partialExit,
    premature_reduction: prematureReduction
      ? {
          outcome: prematureReduction.outcome,
          premature_qty: prematureReduction.prematureQty,
          premature_fraction: prematureReduction.prematureFraction,
          excluded_qty: prematureReduction.excludedQty || 0,
          ambiguous_qty: prematureReduction.ambiguousQty || 0,
          before_boundary_qty: prematureReduction.beforeBoundaryQty || 0,
          unknown_ordering_qty: prematureReduction.unknownOrderingQty || 0,
          boundary_session_date: prematureReduction.boundarySessionDate || null
        }
      : null,
    trailing: trailing
      ? {
          activation: trailing.activation,
          activation_source: trailing.activationSource,
          activation_resolved: trailing.activationResolved,
          active: trailing.active,
          activation_session: trailing.activationSessionDate || null,
          activation_session_index: trailing.activationSessionIndex ?? null,
          activation_basis: trailing.activationBasis || null,
          partial_completion_before_close: trailing.partialCompletionBeforeClose === true,
          inactive_reason: trailing.inactiveReason || null,
          signal_date: trailing.signal ? trailing.signal.date : null,
          signal_close: trailing.signal ? trailing.signal.close : null,
          signal_ma_value: trailing.signal ? trailing.signal.sma : null,
          signal_reason: trailing.signalReason || null,
          supersession: trailing.supersession || null,
          execution: trailing.execution || null,
          reason: trailing.executionReason || null
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

async function prepare(userId, tradeId, { evaluationId } = {}) {
  const trade = await getTradeForUser(userId, tradeId);
  if (!trade) throw new ManagementQualityInputError('Trade not found or not owned by this user.', 'TRADE_NOT_FOUND');
  const evaluation = await resolveEvaluationForManagement(userId, tradeId, evaluationId);
  const version = await loadVersionForEvaluation(evaluation, userId);
  const managementConfig = getManagementDimensionConfig(version.configuration);
  assertValidManagementConfiguration(managementConfig);

  const entryContext = getEntryContext(evaluation);
  const prepareInputs = parseJsonField(evaluation.user_inputs) || {};
  const prepareDetected = parseJsonField(evaluation.detected_context) || {};
  const policy = resolveManagementPolicy(managementConfig);
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
  const immutablePhase =
    prepareInputs.immutable_semantic_context &&
    prepareInputs.immutable_semantic_context.trailing_phase &&
    typeof prepareInputs.immutable_semantic_context.trailing_phase.value === 'string'
      ? prepareInputs.immutable_semantic_context.trailing_phase
      : null;
  const establishedPhase =
    (immutablePhase && immutablePhase.value) ||
    (prepareInputs.trailing_phase === 'activated' || prepareInputs.trailing_phase === 'not_activated'
      ? prepareInputs.trailing_phase
      : null);

  // Resolve deterministic Management applicability so the workflow never asks
  // for a trailing MA that is ultimately irrelevant (e.g. canonical
  // after_partial with a never-triggered partial).
  const nowEpoch = nowEpochSeconds();
  const core = await resolveManagementCore({ trade, userId, entryContext, policy, nowEpoch });
  const { partialTrigger, partialBoundary, fillsState, quantityUnit, sessionIndexForDate } = core;
  const previewTargetPct = policy.partialTarget ? policy.partialTarget.target_pct : null;
  let previewCompletion = { completed: false };
  if (policy.partialTrigger && policy.partialTarget && partialTrigger && partialTrigger.status === 'triggered' && fillsState.available) {
    previewCompletion = resolvePartialCompletion({
      reductions: fillsState.reductions,
      originalPositionQty: entryContext.originalPositionQty,
      targetFraction: previewTargetPct !== null ? previewTargetPct / 100 : null,
      targetPct: previewTargetPct,
      quantityUnit,
      triggerDueSessionIndex: partialTrigger.dueSessionIndex,
      boundary: partialBoundary,
      sessionIndexForDate
    });
  }
  const previewExit = fillsState.available && partialTrigger && partialTrigger.status === 'triggered'
    ? resolvePartialExitSupersession({
        reductions: fillsState.reductions,
        originalPositionQty: entryContext.originalPositionQty,
        boundary: partialBoundary,
        stopExecutionClassification: null
      })
    : { outcome: 'none' };
  const establishedActivationSession =
    (typeof prepareInputs.trailing_activation_session === 'string' && prepareInputs.trailing_activation_session) ||
    (prepareInputs.immutable_semantic_context &&
      prepareInputs.immutable_semantic_context.trailing_activation &&
      prepareInputs.immutable_semantic_context.trailing_activation.session) ||
    null;
  // An activation boundary is only "established" when it is an actual trading
  // session at/after the entry and not after the position was fully closed.
  const activationResolution = establishedActivationSession
    ? resolveActivationSessionIndex(core.daily, establishedActivationSession)
    : { valid: false };
  const closeIndex = core.fillsState && core.fillsState.positionClosed && core.fillsState.lastClosingSessionDate
    ? (core.daily.indexMap ? core.daily.indexMap.get(core.fillsState.lastClosingSessionDate) : null)
    : null;
  const activationSessionValid = activationResolution.valid === true
    && Number.isInteger(core.daily.entryIndex)
    && activationResolution.index >= core.daily.entryIndex
    && !(Number.isInteger(closeIndex) && activationResolution.index > closeIndex);
  const applicability = resolveTrailingApplicability({
    policy,
    partialTrigger,
    partialCompletion: previewCompletion,
    partialExit: previewExit,
    trailingPhase: establishedPhase,
    activationSessionEstablished: activationSessionValid
  });
  const effectiveRequiredInputs = [];
  if (applicability.phaseRequired) effectiveRequiredInputs.push('trailing_phase');
  if (applicability.activationSessionRequired) effectiveRequiredInputs.push('trailing_activation_session');
  if (applicability.smaRequired) effectiveRequiredInputs.push('trailing_ma_period');

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
    policy: {
      partialTrigger: policy.partialTrigger,
      partialTriggerSource: policy.partialTriggerSource,
      partialTarget: policy.partialTarget,
      executionWindowMinutes: policy.executionWindowMinutes,
      trailingActivation: policy.trailingActivation,
      available: policy.available
    },
    trailingMa: {
      value: establishedTrailing,
      established: !!establishedTrailing,
      selectedAt: (immutableTrailing && immutableTrailing.selected_at) || null,
      timing: (immutableTrailing && immutableTrailing.timing) || null,
      phase: establishedPhase,
      phaseEstablished: !!establishedPhase,
      phaseAssertedAt:
        (immutablePhase && immutablePhase.asserted_at) ||
        (prepareDetected.management &&
          prepareDetected.management.trailing_phase &&
          prepareDetected.management.trailing_phase.assertedAt) ||
        null,
      activationSession: establishedActivationSession,
      activationSessionEstablished: activationSessionValid,
      smaRequired: applicability.smaRequired,
      phaseRequired: applicability.phaseRequired,
      applicabilityReason: applicability.reason
    },
    trailingApplicability: applicability,
    allowedTrailingPeriods: requiredInputs.includes('trailing_ma_period') ? allowedTrailingPeriodsFromConfig(managementConfig) : [],
    requiredManagementUserInputs: effectiveRequiredInputs,
    managementCriterionKeys: enabledManagementCriteria(managementConfig).map((criterion) => criterion.key)
  };
}

// Resolves an asserted activation session date to a daily-bar index. The date
// MUST be an actual trading session represented by authoritative daily
// evidence; a weekend/holiday/absent date is rejected rather than silently
// shifted to the next session.
function resolveActivationSessionIndex(daily, date) {
  if (!date || !daily || !Array.isArray(daily.bars)) {
    return { valid: false, index: null, reason: 'activation_session_missing' };
  }
  const exact = daily.indexMap ? daily.indexMap.get(date) : undefined;
  if (!Number.isInteger(exact)) {
    return { valid: false, index: null, reason: 'activation_session_not_a_trading_session' };
  }
  return { valid: true, index: exact, reason: null };
}

// Deterministic trailing-phase applicability used by prepare() (and mirrored by
// evaluate()). Returns whether an SMA selection is actually required and
// whether an explicit activation boundary is still needed.
function resolveTrailingApplicability({ policy, partialTrigger, partialCompletion, partialExit, trailingPhase, activationSessionEstablished }) {
  const activation = policy.trailingActivation || null;
  const result = { activation, phaseRequired: false, smaRequired: false, activationSessionRequired: false, reason: null };
  if (!activation) return { ...result, reason: 'trailing_not_configured' };

  if (activation === 'immediate') {
    return { ...result, smaRequired: true, reason: 'immediate_activation' };
  }
  if (activation === 'explicit') {
    if (trailingPhase !== 'activated' && trailingPhase !== 'not_activated') {
      // Explicit activation needs the phase assertion first.
      return { ...result, phaseRequired: true, reason: 'activation_not_asserted' };
    }
    if (trailingPhase === 'not_activated') {
      return { ...result, smaRequired: false, reason: 'explicit_not_activated' };
    }
    return {
      ...result,
      smaRequired: true,
      activationSessionRequired: !activationSessionEstablished,
      reason: activationSessionEstablished ? 'explicit_activated' : 'explicit_activation_boundary_required'
    };
  }
  // after_partial (canonical): trailing only activates after a completed partial.
  if (partialExit && partialExit.outcome === 'superseded_protective') {
    return { ...result, smaRequired: false, reason: 'protected_exit_before_partial' };
  }
  if (!partialTrigger || partialTrigger.status === 'pending' || partialTrigger.status === 'insufficient_evidence') {
    return { ...result, smaRequired: true, reason: 'partial_trigger_pending' };
  }
  if (partialTrigger.status === 'never_reached') {
    return { ...result, smaRequired: false, reason: 'partial_never_triggered' };
  }
  if (!partialCompletion || completedFalse(partialCompletion)) {
    return { ...result, smaRequired: false, reason: 'partial_not_completed' };
  }
  return { ...result, smaRequired: true, reason: 'partial_completed' };
}

function completedFalse(partialCompletion) {
  return partialCompletion.completed !== true;
}

async function resolveManagementCore({
  trade, userId, entryContext, policy, nowEpoch,
  trustedStopHistory = null, trustedStopExecutionClassification = null
}) {
  const symbol = String(trade.symbol || '').trim().toUpperCase();
  const entrySession = entryContext.actualEntrySession || null;
  const fillsResult = reconstructManagementFills(trade);
  const reductions = fillsResult
    ? reconstructReductions({
        fills: fillsResult.fills,
        direction: fillsResult.direction,
        originalPositionQty: entryContext.originalPositionQty,
        sessionDateInZone
      })
    : null;
  const fillsState = reductions
    ? { available: true, ...reductions }
    : { available: false, reductions: [], totalReductionQty: null, positionClosed: false, lastClosingTimeEpoch: null, lastClosingPrice: null, lastClosingSessionDate: null, firstFullClose: null, remainingQty: null };

  const anchorSession = fillsState.positionClosed ? fillsState.lastClosingSessionDate : null;
  const daily = entrySession && symbol
    ? await resolveManagementDailyEvidence({ symbol, userId, entrySession, anchorSession, nowEpoch })
    : { bars: [], entryIndex: -1, completedThroughIndex: -1, indexMap: new Map(), authoritative: false, source: null, completeness: 'unverified', window: null, reason: 'no entry session/symbol' };
  const sessionIndexForDate = (date) => (daily.indexMap && daily.indexMap.has(date) ? daily.indexMap.get(date) : null);

  const quantityUnit = resolveQuantityUnit(trade.instrument_type);
  const tickSize = resolveTickSize({ storedTickSize: trade.tick_size });
  const stopHistory = resolveStopHistory({ trustedStopHistory: trustedStopHistory || null });
  const stopExecutionClassification = resolveStopExecutionClassification({
    trustedStopExecutionClassification: trustedStopExecutionClassification || null
  });

  const initialR = entryContext.initialR && entryContext.initialR.available
    ? entryContext.initialR
    : { available: false, r_per_share: null };

  // ---- Partial trigger (point-in-time) ------------------------------------
  let partialTrigger = null;
  let dayEvidence = [];
  if (
    policy.partialTrigger &&
    initialR.available &&
    daily.authoritative
  ) {
    dayEvidence = buildDayEvidence({
      bars: daily.bars,
      entryIndex: daily.entryIndex,
      latestDay: policy.partialTrigger.latest_day,
      isSessionCompleted: (date) => isSessionCompleted(date, nowEpoch),
      sessionBoundsForDate: regularSessionBounds
    });
    const day1 = dayEvidence.find((day) => day.day === 1);
    if (day1) {
      const observations = (fillsResult ? fillsResult.fills : [])
        .filter((fill) => fill.action === (fillsResult && fillsResult.direction === 'short' ? 'sell' : 'buy'))
        .map((fill) => ({ epoch: fill.timeEpoch, price: fill.price }));
      const day1PostEntry = await resolveDayOnePostEntryHigh({
        day1Bar: { date: day1.sessionDate, high: daily.bars[day1.sessionIndex] ? daily.bars[day1.sessionIndex].high : null },
        entryEpoch: entryContext.entryEpoch,
        entryBasis: entryContext.entryBasis,
        rPerShare: initialR.r_per_share,
        minimumMfeR: policy.partialTrigger.minimum_mfe_r,
        symbol,
        userId,
        observations
      });
      day1.high = day1PostEntry.high;
      day1.highKnown = day1PostEntry.highKnown === true;
      day1.highValueKnown = day1PostEntry.highValueKnown === true;
      day1.definitivelyBelowThreshold = day1PostEntry.definitivelyBelowThreshold === true;
      day1.precision = day1PostEntry.precision;
      day1.source = day1PostEntry.source;
      day1.possibleX = day1PostEntry.possibleX === true;
    }
    partialTrigger = resolvePartialTrigger({
      dayEvidence,
      entryBasis: entryContext.entryBasis,
      rPerShare: initialR.r_per_share,
      parameters: policy.partialTrigger
    });

    // Crossing timestamp from trustworthy intraday evidence where available.
    if (partialTrigger.status === 'triggered' && Number.isInteger(partialTrigger.firstReachSessionIndex)) {
      const reachDay = partialTrigger.firstReachDay;
      const reachBar = daily.bars[partialTrigger.firstReachSessionIndex];
      const priorHighest = dayEvidence
        .filter((day) => day.day < reachDay && day.highKnown && isFiniteNumber(day.high))
        .reduce((max, day) => (max === null ? day.high : Math.max(max, day.high)), null);
      const thresholdPrice = entryContext.entryBasis + policy.partialTrigger.minimum_mfe_r * initialR.r_per_share;
      const bounds = reachBar ? regularSessionBounds(reachBar.date) : null;
      // Validate only the path required for the crossing: from the session open
      // (or the first fully post-entry interval on Day 1) to the candidate.
      const pathStartEpoch = bounds
        ? (reachDay === 1 && isFiniteNumber(entryContext.entryEpoch)
            ? bounds.openEpoch + Math.ceil((entryContext.entryEpoch - bounds.openEpoch) / 60) * 60
            : bounds.openEpoch)
        : null;
      let crossing = null;
      if (reachBar) {
        try {
          const intraday = await loadSessionIntradayBars(symbol, reachBar.date, userId);
          if (intraday && intraday.available && intraday.bars.length > 0) {
            // Entry-print observations are only relevant to the Day-1 crossing;
            // Days 2+ have their own session evidence.
            const observations = reachDay === 1
              ? (fillsResult ? fillsResult.fills : [])
                  .filter((fill) => fill.action === (fillsResult && fillsResult.direction === 'short' ? 'sell' : 'buy'))
                  .map((fill) => ({ epoch: fill.timeEpoch, price: fill.price }))
              : [];
            const found = findCrossingInSession({
              bars: intraday.bars,
              priorHighest,
              thresholdPrice,
              entryEpoch: reachDay === 1 ? entryContext.entryEpoch : null,
              sessionOpenEpoch: bounds ? bounds.openEpoch : null,
              sessionCloseEpoch: bounds ? bounds.closeEpoch : null,
              pathStartEpoch,
              observations
            });
            if (found.crossed) {
              const uncertain = isFiniteNumber(found.uncertaintyStartEpoch) && isFiniteNumber(found.uncertaintyEndEpoch);
              const isExecutionPrint = found.precision === 'execution_print';
              crossing = {
                epoch: uncertain ? null : (isFiniteNumber(found.crossingEpoch) ? found.crossingEpoch : null),
                intervalStartEpoch: uncertain
                  ? found.uncertaintyStartEpoch
                  : (isFiniteNumber(found.crossingStartEpoch) ? found.crossingStartEpoch : null),
                intervalEndEpoch: uncertain
                  ? found.uncertaintyEndEpoch
                  : (isFiniteNumber(found.crossingEndEpoch) ? found.crossingEndEpoch : null),
                uncertaintyStartEpoch: uncertain ? found.uncertaintyStartEpoch : null,
                uncertaintyEndEpoch: uncertain ? found.uncertaintyEndEpoch : null,
                uncertain,
                authoritative: found.authoritative === true,
                precision: found.precision,
                // An exact execution print keeps its executions_jsonb provenance;
                // a candle interval keeps the provider/cache source.
                source: isExecutionPrint ? 'executions_jsonb' : (intraday.source || found.source)
              };
            }
          }
        } catch (error) {
          crossing = null;
        }
      }
      if (!crossing) {
        crossing = {
          epoch: null,
          intervalStartEpoch: null,
          intervalEndEpoch: null,
          uncertaintyStartEpoch: null,
          uncertaintyEndEpoch: null,
          uncertain: false,
          authoritative: false,
          precision: reachDay === 1 ? 'daily_bar' : 'session',
          source: daily.source || 'daily_bar'
        };
      }
      // The crossing evidence also establishes the authoritative boundary when
      // the first reach is on/after earliest_day. A 1-minute bar establishes an
      // interval (or a conservative uncertainty interval), never a fabricated
      // exact instant.
      let boundary = partialTrigger.boundary;
      if (boundary && boundary.kind === 'crossing') {
        if (boundary.day1EarliestDayUncertainty === true) {
          // Day 1 was point-in-time uncertain and the first CONFIRMED crossing
          // is on earliest_day: the due instant lies in
          // [earliest_day open, confirmed crossing upper bound].
          const corridorStart = isFiniteNumber(boundary.uncertaintyStartEpoch)
            ? boundary.uncertaintyStartEpoch
            : null;
          const crossingUpperBound = isFiniteNumber(crossing.epoch)
            ? crossing.epoch
            : isFiniteNumber(crossing.intervalEndEpoch)
              ? crossing.intervalEndEpoch
              : isFiniteNumber(crossing.uncertaintyEndEpoch)
                ? crossing.uncertaintyEndEpoch
                : null;
          boundary = {
            ...boundary,
            epoch: null,
            intervalStartEpoch: corridorStart,
            intervalEndEpoch: crossingUpperBound,
            uncertaintyStartEpoch: corridorStart,
            uncertaintyEndEpoch: crossingUpperBound,
            uncertain: true,
            uncertaintyBasis: 'day1_vs_earliest_day',
            precision: crossing.precision || 'session',
            source: crossing.source || null,
            orderingKnown: false
          };
        } else {
          boundary = {
            ...boundary,
            epoch: isFiniteNumber(crossing.epoch) ? crossing.epoch : null,
            intervalStartEpoch: isFiniteNumber(crossing.intervalStartEpoch) ? crossing.intervalStartEpoch : null,
            intervalEndEpoch: isFiniteNumber(crossing.intervalEndEpoch) ? crossing.intervalEndEpoch : null,
            uncertaintyStartEpoch: isFiniteNumber(crossing.uncertaintyStartEpoch) ? crossing.uncertaintyStartEpoch : null,
            uncertaintyEndEpoch: isFiniteNumber(crossing.uncertaintyEndEpoch) ? crossing.uncertaintyEndEpoch : null,
            uncertain: crossing.uncertain === true,
            precision: crossing.precision || 'session',
            source: crossing.source || null,
            orderingKnown: isFiniteNumber(crossing.epoch)
          };
        }
      }
      partialTrigger = { ...partialTrigger, crossing, boundary };
    }
  } else if (policy.partialTrigger) {
    partialTrigger = {
      status: daily.authoritative ? 'insufficient_evidence' : 'insufficient_evidence',
      triggered: false,
      crossed: false,
      reason: 'partial_trigger_unavailable',
      mfeByDay: [],
      observedDays: 0,
      horizonComplete: false,
      day1Uncertain: false
    };
  }

  // ---- Authoritative partial trigger boundary -----------------------------
  // A triggered evaluation uses an instant-level boundary (earliest_day open,
  // or the first crossing instant). Non-trigger evaluation uses a
  // session-granularity window-end boundary so only reductions strictly before
  // the window are candidates.
  const partialBoundary = (() => {
    if (partialTrigger && partialTrigger.status === 'triggered' && partialTrigger.boundary) {
      return { ...partialTrigger.boundary, mode: 'instant' };
    }
    let day = null;
    if (partialTrigger && partialTrigger.status === 'never_reached') {
      day = dayEvidence.length > 0 ? dayEvidence[dayEvidence.length - 1] : null;
    } else if (daily.authoritative) {
      day = [...dayEvidence].reverse().find((entry) => entry.sessionCompleted) || null;
    }
    if (!day) return null;
    if (isFiniteNumber(day.sessionCloseEpoch)) {
      // A completed session in which no trigger occurred has a KNOWN close: the
      // premature-reduction observation boundary, so reductions during that
      // session are before the boundary rather than merely "same date unknown".
      return {
        mode: 'instant',
        kind: 'window_end',
        day: day.day,
        sessionIndex: day.sessionIndex,
        sessionDate: day.sessionDate,
        sessionOpenEpoch: day.sessionOpenEpoch,
        sessionCloseEpoch: day.sessionCloseEpoch,
        epoch: day.sessionCloseEpoch,
        intervalStartEpoch: null,
        intervalEndEpoch: null,
        precision: 'session_close',
        source: 'session_calendar',
        orderingKnown: true
      };
    }
    return {
      mode: 'session',
      kind: 'window_end',
      day: day.day,
      sessionIndex: day.sessionIndex,
      sessionDate: day.sessionDate,
      sessionOpenEpoch: day.sessionOpenEpoch,
      sessionCloseEpoch: day.sessionCloseEpoch,
      epoch: null,
      intervalStartEpoch: null,
      intervalEndEpoch: null,
      precision: null,
      source: null,
      orderingKnown: false
    };
  })();
  return {
    symbol, entrySession, fillsResult, fillsState, daily, sessionIndexForDate,
    quantityUnit, tickSize, stopHistory, stopExecutionClassification, initialR,
    partialTrigger, dayEvidence, partialBoundary
  };
}

async function evaluate(userId, tradeId, { evaluationId, userInputs: rawUserInputs, trustedStopHistory, trustedStopExecutionClassification } = {}) {
  if (!evaluationId) throw new ManagementQualityInputError('Run management prepare() first; evaluationId is required.', 'EVALUATION_REQUIRED');
  const trade = await getTradeForUser(userId, tradeId);
  if (!trade) throw new ManagementQualityInputError('Trade not found or not owned by this user.', 'TRADE_NOT_FOUND');
  const evaluation = await resolveEvaluationForManagement(userId, tradeId, evaluationId);
  const version = await loadVersionForEvaluation(evaluation, userId);
  const managementConfig = getManagementDimensionConfig(version.configuration);
  assertValidManagementConfiguration(managementConfig);

  const entryContext = getEntryContext(evaluation);
  const policy = resolveManagementPolicy(managementConfig);
  const requiredInputs = requiredManagementUserInputsFromConfig(managementConfig);
  const allowedPeriods = requiredInputs.includes('trailing_ma_period') ? allowedTrailingPeriodsFromConfig(managementConfig) : [];
  const raw = rawUserInputs && typeof rawUserInputs === 'object' ? rawUserInputs : {};

  // ---- Immutable semantic assertions (first assertion wins) ----------------
  const storedInputs = parseJsonField(evaluation.user_inputs) || {};
  const storedDetected = parseJsonField(evaluation.detected_context) || {};
  const storedImmutableTrailing =
    storedInputs.immutable_semantic_context &&
    storedInputs.immutable_semantic_context.trailing_ma &&
    typeof storedInputs.immutable_semantic_context.trailing_ma.value === 'number'
      ? storedInputs.immutable_semantic_context.trailing_ma
      : null;
  const persistedTrailing =
    (storedImmutableTrailing && storedImmutableTrailing.value) ||
    (Number.isFinite(Number(storedInputs.trailing_ma_period)) ? Number(storedInputs.trailing_ma_period) : null);
  const storedImmutablePhase =
    storedInputs.immutable_semantic_context &&
    storedInputs.immutable_semantic_context.trailing_phase &&
    typeof storedInputs.immutable_semantic_context.trailing_phase.value === 'string'
      ? storedInputs.immutable_semantic_context.trailing_phase
      : null;
  const persistedPhase =
    (storedImmutablePhase && storedImmutablePhase.value) ||
    (storedInputs.trailing_phase === 'activated' || storedInputs.trailing_phase === 'not_activated'
      ? storedInputs.trailing_phase
      : null);
  const requestedPhase = parseTrailingPhase(raw.trailing_phase);
  let trailingPhase = persistedPhase || null;
  let phaseMode = 'none';
  let phaseAssertedAt = null;
  if (persistedPhase) {
    if (requestedPhase !== null && requestedPhase !== persistedPhase) {
      throw new ManagementQualityInputError(
        `trailing_phase is immutable for this evaluation (already asserted as ${persistedPhase}).`,
        'TRAILING_PHASE_IMMUTABLE'
      );
    }
    phaseMode = 'preserve';
    phaseAssertedAt = (storedImmutablePhase && storedImmutablePhase.asserted_at) || null;
  } else if (policy.trailingActivation === 'explicit' && requestedPhase !== null) {
    trailingPhase = requestedPhase;
    phaseMode = 'establish';
  }

  // ---- Explicit activation boundary (first assertion wins) ----------------
  const storedImmutableActivation =
    storedInputs.immutable_semantic_context &&
    storedInputs.immutable_semantic_context.trailing_activation &&
    typeof storedInputs.immutable_semantic_context.trailing_activation.session === 'string'
      ? storedInputs.immutable_semantic_context.trailing_activation
      : null;
  const persistedActivationSession =
    (typeof storedInputs.trailing_activation_session === 'string' && storedInputs.trailing_activation_session) ||
    (storedImmutableActivation && storedImmutableActivation.session) ||
    null;
  const requestedActivationSession = parseActivationSession(raw.trailing_activation_session);
  let trailingActivationSession = persistedActivationSession || null;
  let activationMode = 'none';
  let activationAssertedAt = null;
  if (persistedActivationSession) {
    if (requestedActivationSession !== null && requestedActivationSession !== persistedActivationSession) {
      throw new ManagementQualityInputError(
        `trailing_activation_session is immutable for this evaluation (already asserted as ${persistedActivationSession}).`,
        'TRAILING_ACTIVATION_IMMUTABLE'
      );
    }
    activationMode = 'preserve';
    activationAssertedAt = (storedImmutableActivation && storedImmutableActivation.asserted_at) || null;
  } else if (requestedActivationSession !== null) {
    trailingActivationSession = requestedActivationSession;
    activationMode = 'establish';
  }

  const requestedTrailing = raw.trailing_ma_period;
  let trailingPeriod = null;
  let trailingMode = 'none';
  let trailingSelectedAt = null;
  // Canonical after_partial resolves activation deterministically after the
  // partial; the SMA is parsed if supplied but only *required* once the
  // trailing phase is proven active. explicit/immediate require it up front.
  const maInputEnabled = requiredInputs.includes('trailing_ma_period') && trailingPhase !== 'not_activated';
  // Dependency order: for explicit activation the phase and activation session
  // are validated first, so the SMA is only required up front for `immediate`
  // (and post-resolution when an `after_partial`/`explicit` phase is active).
  const maRequiredUpFront = maInputEnabled && policy.trailingActivation === 'immediate';
  if (persistedTrailing) {
    if (requestedTrailing === undefined || requestedTrailing === null || requestedTrailing === '' || Number(requestedTrailing) === persistedTrailing) {
      trailingPeriod = persistedTrailing;
    } else {
      throw new ManagementQualityInputError(
        `trailing_ma_period is immutable for this evaluation (already asserted as ${persistedTrailing}). Create a new evaluation to use a different trailing MA.`,
        'TRAILING_MA_IMMUTABLE',
        { persisted: persistedTrailing, requested: requestedTrailing, allowedPeriods }
      );
    }
    trailingMode = 'preserve';
    trailingSelectedAt = (storedImmutableTrailing && storedImmutableTrailing.selected_at) || null;
  } else if (maInputEnabled) {
    trailingPeriod = parseTrailingPeriod(requestedTrailing, { required: maRequiredUpFront, allowedPeriods });
    trailingMode = trailingPeriod !== null ? 'establish' : 'none';
  }

  const nowEpoch = nowEpochSeconds();
  const core = await resolveManagementCore({
    trade, userId, entryContext, policy, nowEpoch,
    trustedStopHistory, trustedStopExecutionClassification
  });
  const {
    symbol, entrySession, fillsResult, fillsState, daily, sessionIndexForDate,
    quantityUnit, tickSize, stopHistory, stopExecutionClassification, initialR,
    partialTrigger, dayEvidence, partialBoundary
  } = core;

  // ---- Partial completion / sizing-at-event -------------------------------
  const targetPct = policy.partialTarget ? policy.partialTarget.target_pct : null;
  const targetFraction = targetPct !== null ? targetPct / 100 : null;
  let partialCompletion = {
    completed: false,
    achievedQty: null,
    achievedFraction: null,
    achievedPct: null,
    observedQty: null,
    observedFraction: null,
    completionTimeEpoch: null,
    completionSessionDate: null,
    completionSessionIndex: null,
    sessionsAfterTrigger: null,
    completionRelation: null,
    timingOutcome: 'later_or_not_completed',
    rounding: { resolved: false, requiredQty: null, unit: null, reason: 'policy_unavailable' }
  };
  if (
    policy.partialTrigger &&
    policy.partialTarget &&
    partialTrigger &&
    partialTrigger.status === 'triggered' &&
    fillsState.available
  ) {
    partialCompletion = resolvePartialCompletion({
      reductions: fillsState.reductions,
      originalPositionQty: entryContext.originalPositionQty,
      targetFraction,
      targetPct,
      quantityUnit,
      triggerDueSessionIndex: partialTrigger.dueSessionIndex,
      boundary: partialBoundary,
      sessionIndexForDate
    });
  } else if (policy.partialTrigger && policy.partialTarget && partialTrigger && partialTrigger.status === 'triggered' && !fillsState.available) {
    partialCompletion = {
      ...partialCompletion,
      rounding: { resolved: false, requiredQty: null, unit: null, reason: 'fills_unavailable' }
    };
  }

  // ---- Partial exit supersession / premature reduction --------------------
  // Supersession only applies when a trigger actually became due; a
  // never_reached/pending partial has no due boundary to be superseded.
  const partialExit = fillsState.available && partialTrigger && partialTrigger.status === 'triggered'
    ? resolvePartialExitSupersession({
        reductions: fillsState.reductions,
        originalPositionQty: entryContext.originalPositionQty,
        boundary: partialBoundary,
        stopExecutionClassification
      })
    : { closedBeforeDue: false, outcome: 'none', closeSessionDate: null, closeTimeEpoch: null };

  const prematureBase = fillsState.available
    ? resolvePrematureReduction({
        reductions: fillsState.reductions,
        originalPositionQty: entryContext.originalPositionQty,
        boundary: partialBoundary,
        stopExecutionClassification
      })
    : {
        outcome: 'not_evaluated',
        prematureQty: null,
        prematureFraction: null,
        excludedQty: 0,
        ambiguousQty: 0,
        boundarySessionDate: partialBoundary ? partialBoundary.sessionDate : null
      };
  const prematureReduction = {
    ...prematureBase,
    boundary: partialBoundary,
    classificationAvailable: !!(stopExecutionClassification && stopExecutionClassification.available),
    classificationComplete: !!(stopExecutionClassification && stopExecutionClassification.complete)
  };

  // ---- Trailing -----------------------------------------------------------
  const trailing = resolveTrailingState({
    policy,
    partialTrigger,
    partialCompletion,
    partialExit,
    fillsState,
    daily,
    nowEpoch,
    trailingPhase,
    sessionIndexForDate,
    executionWindowMinutes: policy.executionWindowMinutes,
    stopExecutionClassification,
    userInputs: {
      ...storedInputs,
      ...raw,
      trailing_activation_session: trailingActivationSession
    }
  });

  // Explicit activation without an authoritative boundary needs semantic input;
  // never scan from entry. The dependency order is phase -> activation session
  // -> SMA. An invalid asserted boundary is rejected clearly rather than
  // silently shifted.
  if (policy.trailingActivation === 'explicit') {
    if (trailingPhase !== 'activated' && trailingPhase !== 'not_activated') {
      throw new ManagementQualityInputError(
        'trailing_phase is required when explicit trailing activation is configured.',
        'INPUT_REQUIRED',
        { field: 'trailing_phase' }
      );
    }
    if (trailingPhase === 'activated') {
      if (!trailingActivationSession) {
        throw new ManagementQualityInputError(
          'trailing_activation_session is required when the trailing phase is asserted activated.',
          'INPUT_REQUIRED',
          { field: 'trailing_activation_session' }
        );
      }
      if (trailing.active !== true) {
        throw new ManagementQualityInputError(
          `trailing_activation_session ${trailingActivationSession} is not a valid authoritative activation boundary (${trailing.inactiveReason || 'unresolved'}).`,
          'INVALID_ACTIVATION_SESSION',
          { reason: trailing.inactiveReason || null }
        );
      }
    }
  }
  if (trailing.active === true && !trailingPeriod) {
    throw new ManagementQualityInputError(
      'trailing_ma_period is required because the trailing phase is active.',
      'INPUT_REQUIRED',
      { field: 'trailing_ma_period' }
    );
  }

  // ---- BE deadline context ------------------------------------------------
  const be = { deadlineEpoch: null, nextSessionCloseEpoch: null };
  if (partialCompletion.completionSessionDate && Number.isInteger(policy.postPartialDeadlineSessions)) {
    const completionIndex = sessionIndexForDate(partialCompletion.completionSessionDate);
    if (Number.isInteger(completionIndex)) {
      const deadlineIndex = completionIndex + policy.postPartialDeadlineSessions;
      const deadlineBar = daily.bars[deadlineIndex];
      if (deadlineBar) {
        const deadlineBounds = regularSessionBounds(deadlineBar.date);
        be.deadlineEpoch = deadlineBounds ? deadlineBounds.closeEpoch : null;
        const nextBar = daily.bars[deadlineIndex + 1];
        if (nextBar) {
          const nextBounds = regularSessionBounds(nextBar.date);
          be.nextSessionCloseEpoch = nextBounds ? nextBounds.closeEpoch : null;
        }
      }
    }
  }

  const managementState = buildManagementState({
    trade,
    entryContext,
    daily,
    fills: fillsState,
    policy,
    quantityUnit,
    tickSize,
    stopHistory,
    stopExecutionClassification,
    partialTrigger,
    partialCompletion,
    partialExit,
    prematureReduction,
    trailing,
    be,
    nowEpoch
  });

  const criterionRows = buildManagementCriterionRows(managementConfig, managementState, {
    trailing_ma_period: trailingPeriod
  });

  const managementEvidenceBlock = buildManagementEvidenceBlock({
    daily, fills: fillsState, stopHistory, stopExecutionClassification, policy, quantityUnit, tickSize,
    partialTrigger, partialCompletion, partialExit, prematureReduction, trailing, entryContext, nowEpoch
  });

  const managementDetectedContext = {
    evaluatedAt: new Date().toISOString(),
    trailing_ma: trailingPeriod
      ? { value: trailingPeriod, source: 'user_asserted', selectedAt: trailingSelectedAt || new Date().toISOString(), timing: 'post_trade' }
      : null,
    trailing_phase: trailingPhase
      ? { value: trailingPhase, source: 'user_asserted', assertedAt: phaseAssertedAt || new Date().toISOString(), timing: 'post_trade' }
      : null,
    trailing_activation: trailingActivationSession
      ? { session: trailingActivationSession, source: 'user_asserted', assertedAt: activationAssertedAt || new Date().toISOString(), timing: 'post_trade' }
      : null
  };

  const dependencyFingerprint = computeManagementDependencyFingerprint(evaluation);
  const entryDependencyFingerprintValue = computeManagementEntryDependencyFingerprint(evaluation);

  let updated;
  try {
    updated = await saveManagementProgress(evaluationId, userId, {
      managementResults: { criterionResults: criterionRows },
      managementEvidence: managementEvidenceBlock,
      managementDetectedContext,
      dependencyFingerprint,
      entryDependencyFingerprint: entryDependencyFingerprintValue,
      trailingMa: { mode: trailingMode, value: trailingPeriod, selectedAt: trailingSelectedAt },
      trailingPhase: { mode: phaseMode, value: trailingPhase, assertedAt: phaseAssertedAt },
      trailingActivation: { mode: activationMode, session: trailingActivationSession, assertedAt: activationAssertedAt }
    });
  } catch (error) {
    if (
      error &&
      (error.code === 'STALE_DEPENDENCY' ||
        error.code === 'STALE_ENTRY_DEPENDENCY' ||
        error.code === 'TRAILING_MA_IMMUTABLE' ||
        error.code === 'TRAILING_PHASE_IMMUTABLE' ||
        error.code === 'TRAILING_ACTIVATION_IMMUTABLE')
    ) {
      throw new ManagementQualityInputError(error.message, error.code);
    }
    throw error;
  }
  if (!updated) {
    throw new ManagementQualityInputError('Evaluation could not be updated (it may have reached a terminal state).', 'EVALUATION_TERMINAL');
  }

  return {
    evaluation: toFrontendEvaluation(updated),
    profileVersion: {
      id: version.id, profileId: version.profile_id, profileName: version.profile_name,
      versionNumber: version.version_number, schemaVersion: version.schema_version
    },
    management: {
      entryBasis: entryContext.entryBasis,
      originalPositionQty: entryContext.originalPositionQty,
      initialR: managementState.initialR,
      trailingMaPeriod: trailingPeriod,
      trailingPhase,
      policy: policy,
      partialTrigger
    }
  };
}

function resolveTrailingState({
  policy, partialTrigger, partialCompletion, partialExit, fillsState, daily, nowEpoch,
  trailingPhase, sessionIndexForDate, executionWindowMinutes, stopExecutionClassification, userInputs
}) {
  const activation = policy.trailingActivation || null;
  const activationSource = policy.trailingActivationSource || null;
  const base = {
    activation,
    activationSource,
    active: false,
    activationResolved: false,
    activationSession: null,
    activationSessionDate: null,
    activationSessionIndex: null,
    inactiveReason: null,
    signal: null,
    signalReason: null,
    supersession: { outcome: 'none', reason: null, closeSessionDate: null, closeTimeEpoch: null },
    execution: null,
    executionReason: null,
    exitPrice: fillsState && isFiniteNumber(fillsState.lastClosingPrice) ? fillsState.lastClosingPrice : null
  };

  if (!activation) return { ...base, inactiveReason: 'trailing_not_configured' };

  if (activation === 'after_partial') {
    if (partialExit && partialExit.outcome === 'superseded_protective') {
      return { ...base, activationResolved: true, inactiveReason: 'protected_exit_before_partial' };
    }
    if (partialExit && (partialExit.outcome === 'superseded_discretionary' || partialExit.outcome === 'superseded_ambiguous')) {
      return { ...base, activationResolved: false, inactiveReason: 'partial_exit_unclassified' };
    }
    if (!partialTrigger || partialTrigger.status === 'pending' || partialTrigger.status === 'insufficient_evidence') {
      return { ...base, activationResolved: false, inactiveReason: 'partial_trigger_pending' };
    }
    if (partialTrigger.status === 'never_reached') {
      return { ...base, activationResolved: true, inactiveReason: 'partial_never_triggered' };
    }
    if (!partialCompletion || !partialCompletion.completed) {
      return { ...base, activationResolved: true, inactiveReason: 'partial_not_completed' };
    }
    // Activation begins at the partial-completion INSTANT. A daily close is only
    // eligible as an MA signal when it occurs AFTER activation, so a completion
    // at/after the regular-session close (half-open [open, close)) pushes
    // activation to the NEXT regular session; that day's already-completed close
    // must not become a retrospective signal.
    const completionSessionIndex = partialCompletion.completionSessionIndex;
    const completionSessionDate = partialCompletion.completionSessionDate;
    const completionTimeEpoch = partialCompletion.completionTimeEpoch;
    const completionCloseEpoch = completionSessionDate
      ? (regularSessionBounds(completionSessionDate) || {}).closeEpoch
      : null;
    if (
      !isFiniteNumber(completionTimeEpoch) ||
      !isFiniteNumber(completionCloseEpoch) ||
      !Number.isInteger(completionSessionIndex)
    ) {
      // The completion's same-session ordering cannot be established: do not
      // scan an earlier close.
      return { ...base, activationResolved: false, inactiveReason: 'partial_completion_time_unknown' };
    }
    const activationIndex = completionTimeEpoch >= completionCloseEpoch
      ? completionSessionIndex + 1
      : completionSessionIndex;
    base.active = true;
    base.activationResolved = true;
    base.activationSessionIndex = activationIndex;
    base.activationSession = daily.bars[activationIndex] ? daily.bars[activationIndex].date : null;
    base.activationSessionDate = base.activationSession;
    base.activationBasis = 'partial_completion';
    base.partialCompletionBeforeClose = completionTimeEpoch < completionCloseEpoch;
  } else if (activation === 'immediate') {
    base.active = true;
    base.activationResolved = true;
    base.activationSessionIndex = daily.entryIndex;
  } else if (activation === 'explicit') {
    if (trailingPhase !== 'activated' && trailingPhase !== 'not_activated') {
      return { ...base, activationResolved: false, inactiveReason: 'activation_not_asserted' };
    }
    if (trailingPhase === 'not_activated') {
      return { ...base, activationResolved: true, inactiveReason: 'user_asserted_not_activated' };
    }
    // An activated explicit phase MUST have an authoritative activation
    // boundary; never fall back to the partial completion or entry.
    const assertedSession = userInputs && userInputs.trailing_activation_session;
    if (!assertedSession) {
      return { ...base, activationResolved: false, inactiveReason: 'activation_boundary_missing' };
    }
    const resolved = resolveActivationSessionIndex(daily, assertedSession);
    if (!resolved.valid) {
      return { ...base, activationResolved: false, inactiveReason: resolved.reason };
    }
    if (!Number.isInteger(daily.entryIndex) || resolved.index < daily.entryIndex) {
      return { ...base, activationResolved: false, inactiveReason: 'activation_session_before_entry' };
    }
    const closeIndex = fillsState && fillsState.positionClosed && fillsState.lastClosingSessionDate && daily.indexMap
      ? daily.indexMap.get(fillsState.lastClosingSessionDate)
      : null;
    if (Number.isInteger(closeIndex) && resolved.index > closeIndex) {
      return { ...base, activationResolved: false, inactiveReason: 'activation_session_after_position_closed' };
    }
    base.active = true;
    base.activationResolved = true;
    base.activationSession = assertedSession;
    base.activationSessionDate = daily.bars[resolved.index] ? daily.bars[resolved.index].date : assertedSession;
    base.activationSessionIndex = resolved.index;
  }

  if (!base.active) return base;
  if (!daily.authoritative) {
    return { ...base, signalReason: 'daily_evidence_unavailable' };
  }

  const selectedPeriod = userInputs ? Number(userInputs.trailing_ma_period) : null;
  if (!Number.isInteger(selectedPeriod)) {
    return { ...base, signalReason: 'trailing_ma_period_not_selected' };
  }

  const fromIndex = Number.isInteger(base.activationSessionIndex) ? base.activationSessionIndex : daily.entryIndex;
  const completedThroughIndex = daily.completedThroughIndex;
  const signal = findTrailingSignal({ bars: daily.bars, period: selectedPeriod, fromIndex, completedThroughIndex });

  const positionClosed = !!(fillsState && fillsState.positionClosed);
  const exit = fillsState && fillsState.firstFullClose ? fillsState.firstFullClose : null;
  // The MA signal exists only at the COMPLETED daily close, so its effective
  // instant is the regular-session close of the signal session.
  const signalCloseEpoch = signal ? (regularSessionBounds(signal.date) || {}).closeEpoch : null;

  if (positionClosed && exit) {
    const exitEpoch = isFiniteNumber(exit.timeEpoch) ? exit.timeEpoch : null;
    let ordering = 'after';
    if (!signal) {
      ordering = 'before';
    } else if (exit.sessionDate && exit.sessionDate < signal.date) {
      ordering = 'before';
    } else if (exit.sessionDate && exit.sessionDate === signal.date) {
      // Same date: an exit before the close is pre-signal; an after-close exit
      // is not a pre-signal supersession.
      if (exitEpoch !== null && isFiniteNumber(signalCloseEpoch)) {
        ordering = exitEpoch < signalCloseEpoch ? 'before' : 'after';
      } else {
        ordering = 'unknown';
      }
    }

    if (ordering === 'before' || ordering === 'unknown') {
      const verdict = ordering === 'unknown' ? 'ambiguous' : classifyExit(fillsState.firstFullClose, stopExecutionClassification);
      const outcome =
        verdict === 'protective' ? 'superseded_protective'
          : verdict === 'discretionary' ? 'superseded_discretionary'
            : 'superseded_ambiguous';
      return {
        ...base,
        signal,
        signalReason: signal ? null : 'no_signal_before_exit',
        supersession: {
          outcome,
          reason: ordering === 'unknown' ? 'exit_signal_same_session_ordering_unknown' : 'exit_before_signal',
          closeSessionDate: exit.sessionDate || null,
          closeTimeEpoch: exit.timeEpoch ?? null,
          signalCloseEpoch: isFiniteNumber(signalCloseEpoch) ? signalCloseEpoch : null
        }
      };
    }
  }

  if (!signal) {
    return { ...base, signalReason: 'no_signal_within_available_evidence' };
  }

  const nextBar = daily.bars[signal.sessionIndex + 1];
  const secondBar = daily.bars[signal.sessionIndex + 2];
  const nextSession = nextBar
    ? { date: nextBar.date, ...(regularSessionBounds(nextBar.date) || {}) }
    : null;
  const secondNextSession = secondBar
    ? { date: secondBar.date, ...(regularSessionBounds(secondBar.date) || {}) }
    : null;

  if (positionClosed && exit && exit.sessionDate && signal.date && exit.sessionDate >= signal.date) {
    const execution = classifyTrailingExecution({
      nextSession,
      secondNextSession,
      actualExitEpoch: fillsState.lastClosingTimeEpoch,
      executionWindowMinutes
    });
    return { ...base, signal, execution };
  }

  // Position still open after the signal.
  const horizonCompleteForExit =
    Number.isInteger(daily.completedThroughIndex) &&
    daily.completedThroughIndex >= signal.sessionIndex + 2;
  if (horizonCompleteForExit) {
    return {
      ...base,
      signal,
      execution: { outcome: 'later_or_ignored', reason: 'signal_ignored_position_still_open', nextSessionDate: nextSession ? nextSession.date : null, actualExitEpoch: null, beforeNextOpen: false }
    };
  }
  return { ...base, signal, executionReason: 'insufficient_horizon_after_signal' };
}

function classifyExit(exitReduction, classification) {
  // Production cannot classify fills (no order type). A trusted classification
  // hook may supply per-fill verdicts; otherwise the exit is ambiguous.
  if (!exitReduction) return 'ambiguous';
  if (classification && classification.available === true) {
    const verdict = (classification.byEpoch || {})[exitReduction.timeEpoch];
    if (verdict === 'protective') return 'protective';
    if (verdict === 'discretionary') return 'discretionary';
    return classification.complete === true ? 'discretionary' : 'ambiguous';
  }
  return 'ambiguous';
}

async function finalize(userId, tradeId, { evaluationId } = {}) {
  if (!evaluationId) throw new ManagementQualityInputError('evaluationId is required to finalize.', 'EVALUATION_REQUIRED');
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
    throw new ManagementQualityInputError('Evaluation could not be completed (it may already be terminal).', 'EVALUATION_TERMINAL');
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
  parseTrailingPhase,
  resolveManagementDailyEvidence,
  resolveDayOnePostEntryHigh,
  resolveTrailingState,
  resolveTrailingApplicability,
  computeManagementDependencyFingerprint,
  computeManagementEntryDependencyFingerprint,
  toFrontendEvaluation
};
