'use strict';

// Entry Quality orchestration service (Phase 3 of
// docs/QUALITY_PROFILES_REQUIREMENT.md, sections 22-32, 47-49, 55-58).
//
// Prepare -> Assert intended trigger -> Evaluate workflow:
//   - prepare(): operates on an EXISTING non-terminal evaluation created by
//     Setup Quality. It requires the persisted Setup dependency context
//     (confirmed Pivot, breakout/resolution session, exact daily evidence
//     snapshot), normalizes the trade's actual opening execution evidence, and
//     reports the semantic Entry inputs still required (the intended trigger
//     type) plus intraday-evidence availability.
//   - evaluate(): runs exactly the enabled Entry criteria of the immutable
//     profile version against point-in-time evidence and persists non-terminal
//     Entry progress while preserving the valid Setup result.
//
// Dependencies:
//   - The breakout session is the Phase 2 authoritative resolution session; it
//     is never redefined from the actual entry date.
//   - Entry never re-detects a Pivot and never fabricates Setup context.
//   - Machine-observable metrics (volume/range pace, ADR/ATR, LOD, extension,
//     Initial R) are computed from evidence and are never requested from the
//     user. The only semantic Entry assertion is the intended trigger type.
//
// Phase 3 does NOT evaluate Management and never marks the evaluation terminal.

const { CRITERION_STATUS } = require('./constants');
const { deriveScoreForCriterion } = require('./scoring');
const {
  saveEntryProgress,
  getEvaluation,
  EVALUATION_COLUMNS
} = require('./evaluationService');
const { normalizeDailyBars, indexByDate } = require('./dailyEvidence');
const { normalizeExecutionEvidence } = require('./executionEvidenceService');
const { resolveTrigger } = require('./entry/triggerResolver');
const { computeVolatility, CANONICAL_ADR_PERIOD } = require('./entry/volatility');
const { resolveStopEvidence } = require('./entry/stopEvidence');
const { resolveBuffer } = require('./entry/buffer');
const { computeInitialR, resolveInitialR } = require('./entry/initialR');
const {
  loadSessionIntradayBars,
  computePaceMetric,
  observableLod
} = require('./intradayEvidenceService');
const { regularSessionBounds } = require('./entry/sessionTime');
const {
  validateEntryCriteria,
  SUPPORTED_TRIGGER_TYPES
} = require('./criteria/entry/parameterSchemas');
const { ENTRY_CRITERION_KEYS, evaluateEntryCriterion } = require('./entryCriterionRegistry');
const { getDateInTimezone } = require('../../utils/timezone');

const MARKET_TZ = 'America/New_York';
const TERMINAL_STATUSES = Object.freeze(['completed', 'insufficient_data']);
// Hard cap on historical same-time reference sessions a profile can require,
// used only to bound provider requests; it never changes a configured value.
const MAX_REFERENCE_SESSIONS = 60;

class EntryQualityInputError extends Error {
  constructor(message, code = 'INVALID_INPUT', details = null) {
    super(message);
    this.name = 'EntryQualityInputError';
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
      SELECT
        id, user_id, symbol, side, instrument_type, tick_size, underlying_asset,
        entry_time, exit_time, trade_date, entry_price, quantity, executions, stop_loss
      FROM trades
      WHERE id = $1 AND user_id = $2
    `,
    [tradeId, userId]
  );
  return result.rows[0] || null;
}

function getEntryDimensionConfig(configuration) {
  if (
    configuration === null ||
    typeof configuration !== 'object' ||
    !configuration.dimensions ||
    !configuration.dimensions.entry
  ) {
    throw new EntryQualityInputError(
      'Profile version has no entry dimension configuration.',
      'PROFILE_CONFIG_INVALID'
    );
  }
  const entryConfig = configuration.dimensions.entry;
  if (!Array.isArray(entryConfig.criteria)) {
    throw new EntryQualityInputError(
      'Profile version entry dimension has no criteria.',
      'PROFILE_CONFIG_INVALID'
    );
  }
  return entryConfig;
}

function enabledEntryCriteria(entryConfig) {
  return entryConfig.criteria.filter(
    (criterion) => criterion.enabled === undefined || criterion.enabled === true
  );
}

function enabledCriterion(entryConfig, key) {
  return enabledEntryCriteria(entryConfig).find((criterion) => criterion.key === key) || null;
}

// Enforces the Entry execution contract before any evidence work:
//   - typed Entry criterion parameters;
//   - every parameter an evaluator/helper interprets is present and typed;
//   - an ENABLED Entry criterion with no registered evaluator is a clear
//     PROFILE_CONFIG_INVALID, never a runtime 500.
function assertValidEntryConfiguration(entryConfig) {
  const violations = validateEntryCriteria(entryConfig);
  if (violations.length > 0) {
    throw new EntryQualityInputError(
      `Profile version entry configuration is invalid: ${violations.join('; ')}`,
      'PROFILE_CONFIG_INVALID'
    );
  }
  const unsupportedEnabled = enabledEntryCriteria(entryConfig)
    .filter((criterion) => !ENTRY_CRITERION_KEYS.includes(criterion.key))
    .map((criterion) => criterion.key);
  if (unsupportedEnabled.length > 0) {
    throw new EntryQualityInputError(
      `Unsupported enabled Entry criterion key(s): ${unsupportedEnabled.join(', ')}. ` +
        'No evaluator is implemented for them in Phase 3.',
      'PROFILE_CONFIG_INVALID'
    );
  }
}

// The intended trigger is required only when an enabled criterion actually
// depends on the resolved trigger (Trigger Compliance or Entry Extension).
function requiredEntryUserInputsFromConfig(entryConfig) {
  const enabledKeys = enabledEntryCriteria(entryConfig).map((criterion) => criterion.key);
  const triggerDependent = enabledKeys.some(
    (key) => key === 'trigger_compliance' || key === 'entry_extension'
  );
  return triggerDependent ? ['intended_trigger_type'] : [];
}

function allowedTriggerTypesFromConfig(entryConfig) {
  const criterion = entryConfig.criteria.find((entry) => entry.key === 'trigger_compliance');
  const allowed =
    criterion && criterion.parameters && Array.isArray(criterion.parameters.allowed_types)
      ? criterion.parameters.allowed_types
      : null;
  return allowed && allowed.length > 0 ? [...allowed] : [...SUPPORTED_TRIGGER_TYPES];
}

// Reads and verifies the persisted Setup dependency context Entry relies on:
// confirmed Pivot, breakout/resolution session, base boundary, and the exact
// daily evidence snapshot. Missing/stale Setup context is a hard error: Entry
// never fabricates Setup context.
function getSetupContext(evaluation) {
  const results = parseJsonField(evaluation.results);
  if (!results || !hasOwn(results, 'setup') || results.setup === null) {
    throw new EntryQualityInputError(
      'Entry Quality requires an evaluated Setup result for this draft. Run Setup Quality first.',
      'ENTRY_SETUP_REQUIRED'
    );
  }
  const detected = parseJsonField(evaluation.detected_context) || {};
  const inputs = parseJsonField(evaluation.user_inputs) || {};
  const boundary = detected.boundary || null;
  const confirmedPivot = boundary && isFiniteNumber(Number(boundary.pivotPrice))
    ? Number(boundary.pivotPrice)
    : (inputs.pivot && isFiniteNumber(Number(inputs.pivot.price)) ? Number(inputs.pivot.price) : null);
  const breakoutSession = boundary && boundary.resolutionDate
    ? boundary.resolutionDate
    : (detected.setupBoundary && detected.setupBoundary.resolutionDate
      ? detected.setupBoundary.resolutionDate
      : null);

  if (!isFiniteNumber(confirmedPivot) || confirmedPivot <= 0 || !breakoutSession) {
    throw new EntryQualityInputError(
      'The confirmed Pivot and breakout/resolution session are unavailable on this draft. Re-run Setup Quality before Entry Quality.',
      'ENTRY_SETUP_REQUIRED',
      { confirmedPivot, breakoutSession }
    );
  }

  return {
    confirmedPivot,
    breakoutSession,
    baseStartDate: boundary ? boundary.baseStartDate : (inputs.base_start ? inputs.base_start.date : null),
    resolutionDate: breakoutSession,
    baseEndDate: boundary ? boundary.baseEndDate : null,
    pivotSource: boundary ? boundary.pivotSource : (inputs.pivot ? inputs.pivot.source : null),
    boundarySource: boundary ? boundary.method : null
  };
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
    throw new EntryQualityInputError('Profile version not found or not owned by this user.', 'VERSION_NOT_FOUND');
  }
  return versionResult.rows[0];
}

// Resolves the evaluation Entry operates on: an explicit evaluationId, or the
// most recent non-terminal draft for the trade that already holds Setup
// results. Ownership is always enforced server-side.
async function resolveEvaluationForEntry(userId, tradeId, evaluationId) {
  if (evaluationId) {
    const evaluation = await getEvaluation(evaluationId, userId);
    if (!evaluation || String(evaluation.trade_id) !== String(tradeId)) {
      throw new EntryQualityInputError(
        'Evaluation not found or not owned by this user/trade.',
        'EVALUATION_NOT_FOUND'
      );
    }
    if (TERMINAL_STATUSES.includes(evaluation.status)) {
      throw new EntryQualityInputError(
        'This evaluation is terminal and immutable. Create a new evaluation to run Entry Quality.',
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
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [userId, tradeId]
  );
  if (result.rows.length === 0) {
    throw new EntryQualityInputError(
      'No draft evaluation with a valid Setup result exists for this trade. Run Setup Quality first.',
      'ENTRY_SETUP_REQUIRED'
    );
  }
  return result.rows[0];
}

function fallbackEntrySession(trade) {
  if (!trade || !trade.entry_time) return null;
  return getDateInTimezone(trade.entry_time, MARKET_TZ, false);
}

function dailyContext(evaluation) {
  const snapshot = parseJsonField(evaluation.evidence_snapshot) || {};
  const bars = normalizeDailyBars(Array.isArray(snapshot.bars) ? snapshot.bars : []);
  return { snapshot, bars, dateIndex: indexByDate(bars) };
}

function entrySessionIndex(bars, dateIndex, entryEvidence, trade) {
  const actualSession = (entryEvidence && entryEvidence.actualEntrySession) || fallbackEntrySession(trade);
  return {
    actualSession,
    index: actualSession && dateIndex.has(actualSession) ? dateIndex.get(actualSession) : -1
  };
}

// Historical same-time reference sessions: the configured number of completed
// sessions immediately preceding the actual entry session, drawn from the same
// frozen daily snapshot.
function referenceSessionDates(dailyBars, entryIndex, count) {
  const dates = [];
  for (let i = entryIndex - 1; i >= 0 && dates.length < count; i -= 1) {
    dates.push(dailyBars[i].date);
  }
  return dates.reverse();
}

function volatilityPeriod(entryConfig) {
  const stopWidth = entryConfig.criteria.find((criterion) => criterion.key === 'stop_width');
  if (stopWidth && stopWidth.parameters && Number.isInteger(stopWidth.parameters.period)) {
    return stopWidth.parameters.period;
  }
  return CANONICAL_ADR_PERIOD;
}

function neededVolatilityMethods(entryConfig) {
  const methods = new Set();
  const stopWidth = enabledCriterion(entryConfig, 'stop_width');
  if (stopWidth) methods.add(stopWidth.parameters.volatility_method);
  const extension = enabledCriterion(entryConfig, 'entry_extension');
  if (extension) methods.add(extension.parameters.primary_normalization);
  const initialStop = enabledCriterion(entryConfig, 'initial_stop');
  if (initialStop) {
    if (initialStop.parameters.minimum_buffer_method === 'ATR_fraction') methods.add('ATR');
    if (initialStop.parameters.minimum_buffer_method === 'ADR_fraction') methods.add('ADR');
  }
  return methods;
}

function buildVolatilityByMethod({ methods, dailyBars, entryIndex, entryBasis, period }) {
  const output = {};
  for (const method of methods) {
    output[method] = computeVolatility({
      dailyBars,
      entryIndex,
      method,
      period,
      entryBasis
    });
  }
  return output;
}

async function loadReferenceSessions({ symbol, userId, dailyBars, entryIndex, count }) {
  if (!(count > 0) || entryIndex < 0) return [];
  const dates = referenceSessionDates(dailyBars, entryIndex, Math.min(count, MAX_REFERENCE_SESSIONS));
  const references = [];
  for (const date of dates) {
    const sessionBounds = regularSessionBounds(date);
    const loaded = await loadSessionIntradayBars(symbol, date, userId);
    references.push({
      date,
      openEpoch: sessionBounds ? sessionBounds.openEpoch : null,
      bars: loaded.available ? loaded.bars : [],
      available: loaded.available,
      source: loaded.source || null
    });
  }
  return references;
}

function parseIntendedTriggerType(rawValue, { required, allowedTypes }) {
  if (rawValue === undefined || rawValue === null || rawValue === '') {
    if (required) {
      throw new EntryQualityInputError(
        'intended_trigger_type is required by the active Entry criteria.',
        'INPUT_REQUIRED'
      );
    }
    return null;
  }
  if (typeof rawValue !== 'string' || !allowedTypes.includes(rawValue)) {
    throw new EntryQualityInputError(
      `intended_trigger_type must be one of ${allowedTypes.join(', ')}.`,
      'INVALID_TRIGGER_TYPE',
      { allowedTypes, value: rawValue }
    );
  }
  return rawValue;
}

function buildEntryCriterionRows(entryConfig, context) {
  const rows = [];
  for (const criterionConfig of enabledEntryCriteria(entryConfig)) {
    const fragment = evaluateEntryCriterion(criterionConfig, context);
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
          throw new EntryQualityInputError(
            `Criterion "${criterionConfig.key}" could not be scored: ${derived.error}`,
            'SCORING_INVALID'
          );
        }
        row.score = derived.score;
      } else {
        row.score = fragment.score !== undefined ? fragment.score : null;
      }
    }
    rows.push(row);
  }
  return rows;
}

// Builds the compact Entry evidence snapshot block appended under
// evidence_snapshot.entry. Raw intraday bars are NOT duplicated here (criterion
// evidence already carries the measured values and provenance); only the
// deterministic provenance/cutoff summary is persisted so already-evaluated
// results cannot be silently changed by later provider revisions.
function buildEntryEvidenceBlock({ executionEvidence, setupContext, intraday, stopEvidence, buffer, initialR, volatilityByMethod, metrics, triggerResolution, referenceSessions }) {
  return {
    preparedAt: new Date().toISOString(),
    execution: {
      available: executionEvidence.available,
      direction: executionEvidence.direction,
      provenance: executionEvidence.provenance,
      original_position_qty: executionEvidence.originalPositionQty,
      entry_basis: executionEvidence.entryBasis,
      initial_entry_time: executionEvidence.initialEntryTime,
      actual_entry_session: executionEvidence.actualEntrySession,
      first_reduction_time: executionEvidence.firstReductionTime,
      fills: executionEvidence.fills
    },
    setup_dependency: {
      confirmed_pivot: setupContext.confirmedPivot,
      breakout_session: setupContext.breakoutSession,
      base_start_date: setupContext.baseStartDate,
      base_end_date: setupContext.baseEndDate,
      boundary_source: setupContext.boundarySource
    },
    intraday: intraday
      ? {
          available: intraday.available,
          source: intraday.source,
          resolution: intraday.resolution,
          session: intraday.session
            ? { date: intraday.session.date, openEpoch: intraday.session.openEpoch, closeEpoch: intraday.session.closeEpoch }
            : null,
          bars: intraday.bars ? intraday.bars.length : 0,
          reason: intraday.reason || null
        }
      : null,
    reference_sessions: (referenceSessions || []).map((reference) => ({
      date: reference.date,
      available: reference.available,
      source: reference.source,
      bars: reference.bars ? reference.bars.length : 0
    })),
    stop: stopEvidence
      ? {
          available: stopEvidence.available,
          price: stopEvidence.price,
          source: stopEvidence.source,
          reference_time: stopEvidence.referenceTime,
          reference_time_source: stopEvidence.referenceTimeSource,
          provenance: stopEvidence.provenance
        }
      : null,
    buffer: buffer || null,
    initial_r: initialR || null,
    volatility: Object.fromEntries(
      Object.entries(volatilityByMethod || {}).map(([method, value]) => [
        method,
        value
          ? {
              available: value.available,
              method: value.method,
              period: value.period,
              dollars: value.dollars ?? null,
              pct: value.pct ?? null,
              reason: value.reason || null
            }
          : null
      ])
    ),
    metrics: metrics
      ? {
          lod_observable: metrics.lod ? metrics.lod.low : null,
          lod_last_observable_epoch: metrics.lod ? metrics.lod.lastObservableEpoch : null,
          volume_pace: metrics.volumePace
            ? { available: metrics.volumePace.available, pace: metrics.volumePace.pace }
            : null,
          range_pace: metrics.rangePace
            ? { available: metrics.rangePace.available, pace: metrics.rangePace.pace }
            : null,
          range_at_entry_over_adr: metrics.rangeAtEntryOverAdr ?? null
        }
      : null,
    trigger: triggerResolution
      ? {
          status: triggerResolution.status,
          trigger_type: triggerResolution.triggerType,
          effective_trigger: triggerResolution.effectiveTrigger,
          opening_range_high: triggerResolution.openingRangeHigh,
          evidence: triggerResolution.evidence
        }
      : null
  };
}

/**
 * Prepares Entry Quality for an existing draft evaluation. Returns the persisted
 * Setup dependency context, normalized execution evidence, intraday-evidence
 * availability, the allowed intended-trigger values, and the required semantic
 * Entry user inputs. It does NOT require the user to enter machine-observable
 * metrics.
 */
async function prepare(userId, tradeId, { evaluationId } = {}) {
  const trade = await getTradeForUser(userId, tradeId);
  if (!trade) {
    throw new EntryQualityInputError('Trade not found or not owned by this user.', 'TRADE_NOT_FOUND');
  }
  const evaluation = await resolveEvaluationForEntry(userId, tradeId, evaluationId);
  const version = await loadVersionForEvaluation(evaluation, userId);
  const entryConfig = getEntryDimensionConfig(version.configuration);
  assertValidEntryConfiguration(entryConfig);

  const setupContext = getSetupContext(evaluation);
  const { bars, dateIndex } = dailyContext(evaluation);
  const executionEvidence = normalizeExecutionEvidence(trade);
  const { actualSession, index: entryIndex } = entrySessionIndex(bars, dateIndex, executionEvidence, trade);

  const unavailableEvidence = [];
  if (bars.length === 0) unavailableEvidence.push('daily_setup_snapshot');
  if (entryIndex === -1) unavailableEvidence.push('entry_session_daily_bar');
  if (!executionEvidence.available) unavailableEvidence.push('execution_evidence');
  if (!trade.stop_loss) unavailableEvidence.push('actual_initial_stop');

  const symbol = String(trade.symbol || '').trim().toUpperCase();
  const entrySessionDate = actualSession || fallbackEntrySession(trade);
  const entryIntraday = entrySessionDate
    ? await loadSessionIntradayBars(symbol, entrySessionDate, userId)
    : { available: false, bars: [], source: null, resolution: '1min', session: null, reason: 'No actual entry session is available.' };
  if (!entryIntraday.available) unavailableEvidence.push('entry_session_intraday');

  return {
    evaluation: toFrontendEvaluation(evaluation),
    profileVersion: {
      id: version.id,
      profileId: version.profile_id,
      profileName: version.profile_name,
      versionNumber: version.version_number,
      schemaVersion: version.schema_version
    },
    setupDependency: {
      ready: true,
      confirmedPivot: setupContext.confirmedPivot,
      breakoutSession: setupContext.breakoutSession,
      baseStartDate: setupContext.baseStartDate,
      baseEndDate: setupContext.baseEndDate,
      boundarySource: setupContext.boundarySource
    },
    executionEvidence: {
      available: executionEvidence.available,
      direction: executionEvidence.direction,
      originalPositionQty: executionEvidence.originalPositionQty,
      entryBasis: executionEvidence.entryBasis,
      initialEntryTime: executionEvidence.initialEntryTime,
      actualEntrySession: executionEvidence.actualEntrySession,
      firstReductionTime: executionEvidence.firstReductionTime,
      provenance: executionEvidence.provenance,
      fills: executionEvidence.fills,
      unavailableReason: executionEvidence.unavailableReason
    },
    intradayEvidence: {
      entrySession: {
        available: entryIntraday.available,
        date: entrySessionDate,
        source: entryIntraday.source,
        resolution: entryIntraday.resolution,
        bars: entryIntraday.bars ? entryIntraday.bars.length : 0,
        reason: entryIntraday.reason || null
      }
    },
    allowedTriggerTypes: allowedTriggerTypesFromConfig(entryConfig),
    requiredEntryUserInputs: requiredEntryUserInputsFromConfig(entryConfig),
    entryCriterionKeys: enabledEntryCriteria(entryConfig).map((criterion) => criterion.key),
    unavailableEvidence
  };
}

/**
 * Evaluates and persists NON-TERMINAL Entry progress, preserving the valid
 * Setup result. Input carries only semantic assertions (intended_trigger_type).
 */
async function evaluate(userId, tradeId, { evaluationId, userInputs: rawUserInputs } = {}) {
  if (!evaluationId) {
    throw new EntryQualityInputError('Run entry prepare() first; evaluationId is required.', 'EVALUATION_REQUIRED');
  }
  const trade = await getTradeForUser(userId, tradeId);
  if (!trade) {
    throw new EntryQualityInputError('Trade not found or not owned by this user.', 'TRADE_NOT_FOUND');
  }
  const evaluation = await resolveEvaluationForEntry(userId, tradeId, evaluationId);
  const version = await loadVersionForEvaluation(evaluation, userId);
  const entryConfig = getEntryDimensionConfig(version.configuration);
  assertValidEntryConfiguration(entryConfig);

  const setupContext = getSetupContext(evaluation);
  const { snapshot, bars, dateIndex } = dailyContext(evaluation);
  const executionEvidence = normalizeExecutionEvidence(trade);
  const { actualSession, index: entryIndex } = entrySessionIndex(bars, dateIndex, executionEvidence, trade);

  const requiredInputs = requiredEntryUserInputsFromConfig(entryConfig);
  const allowedTypes = allowedTriggerTypesFromConfig(entryConfig);
  const raw = rawUserInputs && typeof rawUserInputs === 'object' ? rawUserInputs : {};
  const intendedTriggerType = parseIntendedTriggerType(raw.intended_trigger_type, {
    required: requiredInputs.includes('intended_trigger_type'),
    allowedTypes
  });

  const symbol = String(trade.symbol || '').trim().toUpperCase();
  const entrySessionDate = actualSession || null;

  // Entry-session intraday evidence (cache-first).
  const entryIntraday = entrySessionDate
    ? await loadSessionIntradayBars(symbol, entrySessionDate, userId)
    : {
        available: false, bars: [], source: null, resolution: '1min',
        resolutionSeconds: 60, session: null,
        reason: 'No actual initial-entry session is available.'
      };

  const session = entryIntraday.session || (entrySessionDate ? regularSessionBounds(entrySessionDate) : null);
  const extraPrices = executionEvidence.available
    ? executionEvidence.fills.map((fill) => fill.price)
    : [];

  // Stop evidence and buffer.
  const stopEvidence = resolveStopEvidence({ trade, executionEvidence });

  // Volatility references needed by enabled criteria.
  const methods = neededVolatilityMethods(entryConfig);
  const period = volatilityPeriod(entryConfig);
  const volatilityByMethod = buildVolatilityByMethod({
    methods,
    dailyBars: bars,
    entryIndex,
    entryBasis: executionEvidence.entryBasis,
    period
  });

  const initialStopCriterion = enabledCriterion(entryConfig, 'initial_stop');
  const buffer = initialStopCriterion
    ? resolveBuffer({
        criterionParameters: initialStopCriterion.parameters,
        entryBasis: executionEvidence.entryBasis,
        volatilityByMethod,
        trade
      })
    : { available: false, buffer: null, method: null, value: null, source: null, reason: 'Initial Stop is not enabled.' };

  // Immutable Initial R: established once from the actual initial protective
  // stop, then preserved across re-evaluations while the frozen inputs match.
  const storedInitialR = snapshot && snapshot.entry ? snapshot.entry.initial_r || null : null;
  const initialR = resolveInitialR({
    computed: computeInitialR({
      direction: executionEvidence.direction,
      entryBasis: executionEvidence.entryBasis,
      originalPositionQty: executionEvidence.originalPositionQty,
      stopEvidence
    }),
    storedInitialR
  });

  // Point-in-time LOD through the stop-establishment reference time.
  const referenceEpoch = stopEvidence.referenceEpoch || executionEvidence.initialEntryEpoch || null;
  let lod = { low: null, high: null, lastObservableEpoch: null, observableBars: 0 };
  if (entryIntraday.available && session && isFiniteNumber(referenceEpoch)) {
    lod = observableLod({
      bars: entryIntraday.bars,
      openEpoch: session.openEpoch,
      referenceEpoch,
      resolutionSeconds: entryIntraday.resolutionSeconds,
      extraPrices
    });
  }

  // Historical same-time reference sessions for pace criteria.
  const volumeCriterion = enabledCriterion(entryConfig, 'volume_pace');
  const rangeCriterion = enabledCriterion(entryConfig, 'range_pace');
  const referenceCount = Math.max(
    volumeCriterion ? volumeCriterion.parameters.reference_sessions : 0,
    rangeCriterion ? rangeCriterion.parameters.reference_sessions : 0
  );
  const referenceSessions = entryIntraday.available
    ? await loadReferenceSessions({ symbol, userId, dailyBars: bars, entryIndex, count: referenceCount })
    : [];

  let volumePace = null;
  let rangePace = null;
  let rangeAtEntryOverAdr = null;
  if (entryIntraday.available && session && isFiniteNumber(executionEvidence.initialEntryEpoch)) {
    const entryCutoffEpoch = executionEvidence.initialEntryEpoch;
    if (volumeCriterion) {
      volumePace = computePaceMetric({
        entrySession: session,
        entrySessionBars: entryIntraday.bars,
        entryCutoffEpoch,
        referenceSessions,
        requiredSessions: volumeCriterion.parameters.reference_sessions,
        kind: 'volume'
      });
    }
    if (rangeCriterion) {
      rangePace = computePaceMetric({
        entrySession: session,
        entrySessionBars: entryIntraday.bars,
        entryCutoffEpoch,
        referenceSessions,
        requiredSessions: rangeCriterion.parameters.reference_sessions,
        kind: 'range',
        extraPrices
      });
      const adr = volatilityByMethod.ADR;
      if (rangePace && rangePace.available && adr && adr.available && adr.dollars > 0) {
        rangeAtEntryOverAdr = rangePace.today / adr.dollars;
      }
    }
  }

  // Trigger resolution (long-only canonical semantics).
  const triggerCriterion = entryConfig.criteria.find((criterion) => criterion.key === 'trigger_compliance');
  const triggerParameters = triggerCriterion && triggerCriterion.parameters ? triggerCriterion.parameters : {};
  let triggerResolution = null;
  if (intendedTriggerType && executionEvidence.available && executionEvidence.direction === 'long') {
    triggerResolution = resolveTrigger({
      triggerType: intendedTriggerType,
      parameters: {
        allowed_types: triggerParameters.allowed_types || allowedTypes,
        minimum_penetration_pct: isFiniteNumber(triggerParameters.minimum_penetration_pct)
          ? triggerParameters.minimum_penetration_pct
          : 0,
        require_pivot_resolution: triggerParameters.require_pivot_resolution === true
      },
      setupContext,
      executionEvidence,
      intraday: entryIntraday.available
        ? {
            entrySessionBars: entryIntraday.bars,
            resolution: entryIntraday.resolution,
            resolutionSeconds: entryIntraday.resolutionSeconds
          }
        : null
    });
  }

  const intradayMetrics = {
    entryIntraday,
    session,
    resolution: entryIntraday.resolution,
    resolutionSeconds: entryIntraday.resolutionSeconds,
    regularSessionOpenEpoch: session ? session.openEpoch : null,
    lod,
    volumePace,
    rangePace,
    rangeAtEntryOverAdr
  };

  const context = {
    setupContext,
    entryEvidence: executionEvidence,
    triggerResolution,
    volatilityByMethod,
    intradayMetrics,
    stopEvidence,
    buffer,
    userInputs: {
      intended_trigger_type: intendedTriggerType
    }
  };

  const criterionRows = buildEntryCriterionRows(entryConfig, context);

  // Merge Entry evidence and semantic inputs into the existing evaluation
  // context WITHOUT replacing the frozen Phase 2 Setup snapshot or its inputs.
  const storedSnapshot = parseJsonField(evaluation.evidence_snapshot) || {};
  const storedInputs = parseJsonField(evaluation.user_inputs) || {};
  const storedDetected = parseJsonField(evaluation.detected_context) || {};

  const entryEvidenceBlock = buildEntryEvidenceBlock({
    executionEvidence,
    setupContext,
    intraday: entryIntraday,
    stopEvidence,
    buffer,
    initialR,
    volatilityByMethod,
    metrics: intradayMetrics,
    triggerResolution,
    referenceSessions
  });

  const evidenceSnapshot = {
    ...storedSnapshot,
    entry: entryEvidenceBlock
  };

  const storedUserInputs = { ...storedInputs };
  if (intendedTriggerType) {
    storedUserInputs.intended_trigger_type = intendedTriggerType;
  }

  const detectedContext = {
    ...storedDetected,
    version: 2,
    entry: {
      evaluatedAt: new Date().toISOString(),
      allowed_trigger_types: allowedTypes,
      intended_trigger: intendedTriggerType
        ? { value: intendedTriggerType, source: 'user_asserted' }
        : null,
      breakout_session: setupContext.breakoutSession,
      actual_entry_session: executionEvidence.actualEntrySession,
      setup_boundary_source: setupContext.boundarySource,
      initial_r: initialR
    }
  };

  const updated = await saveEntryProgress(evaluationId, userId, {
    entryResults: { criterionResults: criterionRows },
    evidenceSnapshot,
    userInputs: storedUserInputs,
    detectedContext
  });
  if (!updated) {
    throw new EntryQualityInputError(
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
    setupDependency: setupContext,
    entry: {
      breakoutSession: setupContext.breakoutSession,
      actualEntrySession: executionEvidence.actualEntrySession,
      initialEntryTime: executionEvidence.initialEntryTime,
      entryBasis: executionEvidence.entryBasis,
      originalPositionQty: executionEvidence.originalPositionQty,
      intendedTriggerType,
      effectiveTrigger: triggerResolution ? triggerResolution.effectiveTrigger : null,
      initialR
    }
  };
}

// Reuses the Setup evaluation history endpoint: one evaluation carries both
// dimensions, so Entry does not need a separate history listing.
async function listEvaluations(userId, tradeId) {
  const setupQualityService = require('./setupQualityService');
  return setupQualityService.listEvaluations(userId, tradeId);
}

module.exports = {
  EntryQualityInputError,
  prepare,
  evaluate,
  listEvaluations,
  // exposed for tests
  getTradeForUser,
  getEntryDimensionConfig,
  enabledEntryCriteria,
  assertValidEntryConfiguration,
  requiredEntryUserInputsFromConfig,
  allowedTriggerTypesFromConfig,
  getSetupContext,
  parseIntendedTriggerType,
  buildEntryCriterionRows,
  buildEntryEvidenceBlock,
  referenceSessionDates,
  neededVolatilityMethods,
  volatilityPeriod,
  toFrontendEvaluation
};
