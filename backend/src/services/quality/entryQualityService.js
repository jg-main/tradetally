'use strict';

// Entry Quality orchestration service (Phase 3 of
// docs/QUALITY_PROFILES_REQUIREMENT.md, sections 22-32, 47-49, 55-58, plus the
// Phase 3 hardening milestone).
//
// Prepare -> Assert intended trigger -> Evaluate workflow:
//   - prepare(): operates on an EXISTING non-terminal evaluation created by
//     Setup Quality. It requires only the Setup fields the ENABLED Entry
//     criteria actually consume, normalizes the trade's actual opening
//     execution evidence, and reports the semantic Entry inputs still required
//     (the intended trigger type) plus evidence availability.
//   - evaluate(): runs exactly the enabled Entry criteria of the immutable
//     profile version against point-in-time evidence and persists non-terminal
//     Entry progress while preserving the valid Setup result.
//
// Hardening invariants:
//   - Entry dependencies are CRITERION-DRIVEN: Pivot/breakout session are only
//     required when an enabled criterion needs them (finding 8).
//   - The FIRST opening execution print is distinct from Entry Basis; Trigger
//     Compliance uses the first print and is UNKNOWN when it cannot be proven
//     (finding 2).
//   - Trigger/ORH evidence uses the persisted breakout session's bars, while
//     entry-time pace/LOD use the actual entry session's bars (finding 9).
//   - Entry-specific daily evidence is fetched/snapshotted separately when the
//     Setup snapshot does not contain enough history; the Setup snapshot is
//     never replaced (finding 8).
//   - Every save is guarded by a server-derived Setup dependency fingerprint so
//     stale Entry work cannot attach to a newer Setup (finding 1).
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
const { loadDailyEvidence } = require('./marketEvidenceService');
const { setupDependencyFingerprint } = require('./dependencyFingerprint');
const { normalizeExecutionEvidence } = require('./executionEvidenceService');
const { resolveTrigger } = require('./entry/triggerResolver');
const { computeVolatility } = require('./entry/volatility');
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
const OPENING_RANGE_TRIGGER_TYPES = Object.freeze(['BO-ORH-1', 'BO-ORH-5', 'BO-ORH-60']);

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

function subtractDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return dateString;
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().split('T')[0];
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

// Derives the Setup/daily/intraday dependencies of the ENABLED Entry criteria.
// Pivot and breakout session are only required when something actually consumes
// them (finding 8).
function entryDependencyNeeds(entryConfig) {
  const enabledKeys = enabledEntryCriteria(entryConfig).map((criterion) => criterion.key);
  const has = (key) => enabledKeys.includes(key);

  const needsPivot = has('trigger_compliance') || has('entry_extension');
  const needsBreakoutSession =
    has('breakout_session') || has('trigger_compliance') || has('entry_extension');
  const needsTriggerIntraday = has('trigger_compliance');
  const needsEntryIntraday = has('volume_pace') || has('range_pace') || has('initial_stop');

  const initialStop = enabledCriterion(entryConfig, 'initial_stop');
  const bufferMethod = initialStop ? initialStop.parameters.minimum_buffer_method : null;
  const needsDailyEvidence =
    has('stop_width') ||
    has('entry_extension') ||
    bufferMethod === 'ATR_fraction' ||
    bufferMethod === 'ADR_fraction';

  return {
    enabledKeys,
    needsPivot,
    needsBreakoutSession,
    needsTriggerIntraday,
    needsEntryIntraday,
    needsDailyEvidence,
    needsReferenceSessions: has('volume_pace') || has('range_pace'),
    has
  };
}

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
  if (!allowed || allowed.length === 0) {
    // The trigger policy owner is validated whenever a consumer is enabled, so
    // reaching here means the profile is malformed.
    throw new EntryQualityInputError(
      'The trigger_compliance policy (allowed_types) is required but missing; profile configuration is invalid.',
      'PROFILE_CONFIG_INVALID'
    );
  }
  return [...allowed];
}

// Criterion-driven Setup dependency context. An existing valid Setup result is
// always required (Entry belongs to that evaluation); individual Setup fields
// are only required when the enabled Entry criteria consume them.
function getSetupContext(evaluation, needs) {
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
  const breakoutSession = boundary && boundary.resolutionDate ? boundary.resolutionDate : null;

  if (needs.needsPivot && (!isFiniteNumber(confirmedPivot) || confirmedPivot <= 0)) {
    throw new EntryQualityInputError(
      'The confirmed Pivot is required by the enabled Entry criteria but is unavailable on this draft. Run Setup Quality first.',
      'ENTRY_SETUP_REQUIRED',
      { confirmedPivot }
    );
  }
  if (needs.needsBreakoutSession && !breakoutSession) {
    throw new EntryQualityInputError(
      'The breakout/resolution session is required by the enabled Entry criteria but is unavailable on this draft. Run Setup Quality first.',
      'ENTRY_SETUP_REQUIRED',
      { breakoutSession }
    );
  }

  return {
    confirmedPivot: isFiniteNumber(confirmedPivot) ? confirmedPivot : null,
    breakoutSession: breakoutSession || null,
    baseStartDate: boundary ? boundary.baseStartDate : null,
    resolutionDate: breakoutSession || null,
    baseEndDate: boundary ? boundary.baseEndDate : null,
    pivotSource: boundary ? boundary.pivotSource : null,
    boundarySource: boundary ? boundary.method : null,
    boundary: boundary || null
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

function setupSnapshot(evaluation) {
  return parseJsonField(evaluation.evidence_snapshot) || {};
}

// Volatility period owner: stop_width. Its period is validated whenever any
// consumer is enabled, so a missing period here is a hard profile error (no
// silent canonical fallback).
function volatilityPeriod(entryConfig) {
  const stopWidth = entryConfig.criteria.find((criterion) => criterion.key === 'stop_width');
  const period = stopWidth && stopWidth.parameters ? stopWidth.parameters.period : undefined;
  if (!Number.isInteger(period) || period < 1) {
    throw new EntryQualityInputError(
      'The stop_width volatility period is required by an enabled Entry criterion but is missing/invalid.',
      'PROFILE_CONFIG_INVALID'
    );
  }
  return period;
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

// Resolves the daily bars Entry uses for volatility. Prefers the frozen Setup
// snapshot when it contains enough completed sessions before the entry session;
// otherwise fetches Entry-specific daily evidence and appends it separately
// (never replacing the Setup snapshot).
async function resolveEntryDailyEvidence({ evaluation, trade, userId, entrySession, period }) {
  const snapshot = setupSnapshot(evaluation);
  const setupBars = normalizeDailyBars(Array.isArray(snapshot.bars) ? snapshot.bars : []);
  const requiredHistory = period + 2;
  const setupIndexMap = indexByDate(setupBars);
  const setupIndex = entrySession && setupIndexMap.has(entrySession) ? setupIndexMap.get(entrySession) : -1;

  if (setupIndex >= requiredHistory) {
    return {
      bars: setupBars,
      index: setupIndex,
      source: snapshot.source || 'setup_snapshot',
      completeness: snapshot.completeness || 'unverified',
      appended: false,
      error: null
    };
  }

  const symbol = String((trade && trade.symbol) || '').trim().toUpperCase();
  const fromDate = entrySession ? subtractDays(entrySession, period * 3 + 14) : null;
  if (!symbol || !fromDate) {
    return { bars: setupBars, index: setupIndex, source: 'setup_snapshot', completeness: 'unverified', appended: false, error: 'no entry daily window' };
  }
  const loaded = await loadDailyEvidence({ symbol, userId, fromDate, toDate: entrySession });
  const bars = normalizeDailyBars(loaded.bars);
  const indexMap = indexByDate(bars);
  const index = entrySession && indexMap.has(entrySession) ? indexMap.get(entrySession) : -1;
  return {
    bars,
    index,
    source: loaded.source,
    completeness: loaded.completeness,
    appended: true,
    error: loaded.error || null
  };
}

function referenceSessionDates(dailyBars, entryIndex, count) {
  const dates = [];
  for (let i = entryIndex - 1; i >= 0 && dates.length < count; i -= 1) {
    dates.push(dailyBars[i].date);
  }
  return dates.reverse();
}

async function loadReferenceSessions({ symbol, userId, dailyBars, entryIndex, count }) {
  if (!(count > 0) || entryIndex < 0) return [];
  const dates = referenceSessionDates(dailyBars, entryIndex, count);
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
        row.score = null;
      }
    }
    rows.push(row);
  }
  return rows;
}

function buildEntryEvidenceBlock({
  executionEvidence,
  setupContext,
  entryDaily,
  entryIntraday,
  breakoutIntraday,
  stopEvidence,
  buffer,
  initialR,
  volatilityByMethod,
  metrics,
  triggerResolution,
  referenceSessions
}) {
  return {
    preparedAt: new Date().toISOString(),
    execution: {
      available: executionEvidence.available,
      direction: executionEvidence.direction,
      provenance: executionEvidence.provenance,
      original_position_qty: executionEvidence.originalPositionQty,
      entry_basis: executionEvidence.entryBasis,
      initial_entry_time: executionEvidence.initialEntryTime,
      initial_entry_fill_price: executionEvidence.initialEntryFillPrice,
      initial_entry_fill_time: executionEvidence.initialEntryFillTime,
      initial_entry_fill_trustworthy: executionEvidence.initialEntryFillTrustworthy,
      ambiguous_first_fill: executionEvidence.ambiguousFirstFill,
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
    entry_daily: entryDaily
      ? {
          source: entryDaily.source,
          completeness: entryDaily.completeness,
          appended: entryDaily.appended,
          bars: entryDaily.bars ? entryDaily.bars.length : 0,
          entry_index: entryDaily.index,
          error: entryDaily.error || null
        }
      : null,
    intraday: {
      entry_session: entryIntraday
        ? {
            available: entryIntraday.available,
            source: entryIntraday.source,
            resolution: entryIntraday.resolution,
            session: entryIntraday.session
              ? { date: entryIntraday.session.date, openEpoch: entryIntraday.session.openEpoch, closeEpoch: entryIntraday.session.closeEpoch }
              : null,
            bars: entryIntraday.bars ? entryIntraday.bars.length : 0,
            coverage: entryIntraday.coverage || null,
            reason: entryIntraday.reason || null
          }
        : null,
      breakout_session: breakoutIntraday
        ? {
            available: breakoutIntraday.available,
            source: breakoutIntraday.source,
            resolution: breakoutIntraday.resolution,
            session: breakoutIntraday.session ? breakoutIntraday.session.date : null,
            bars: breakoutIntraday.bars ? breakoutIntraday.bars.length : 0,
            coverage: breakoutIntraday.coverage || null,
            reason: breakoutIntraday.reason || null
          }
        : null
    },
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
          reference_stop: stopEvidence.referenceStop || null,
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
          lod_precision: metrics.lod ? metrics.lod.precision : null,
          lod_reason: metrics.lod ? metrics.lod.reason : null,
          volume_pace: metrics.volumePace
            ? { available: metrics.volumePace.available, pace: metrics.volumePace.pace, precision: metrics.volumePace.precision || null, reason: metrics.volumePace.reason || null }
            : null,
          range_pace: metrics.rangePace
            ? { available: metrics.rangePace.available, pace: metrics.rangePace.pace, precision: metrics.rangePace.precision || null, reason: metrics.rangePace.reason || null }
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
          trigger_time_precision: triggerResolution.triggerTimePrecision || null,
          evidence: triggerResolution.evidence
        }
      : null
  };
}

function computeEntryDependencyFingerprint(evaluation) {
  const detected = parseJsonField(evaluation.detected_context) || {};
  return setupDependencyFingerprint({
    profileVersionId: evaluation.profile_version_id,
    boundary: detected.boundary || null,
    evidenceSnapshot: parseJsonField(evaluation.evidence_snapshot) || null
  });
}

async function loadBreakoutIntraday({ symbol, userId, setupContext, needs }) {
  if (!needs.needsTriggerIntraday || !symbol || !setupContext.breakoutSession) return null;
  return loadSessionIntradayBars(symbol, setupContext.breakoutSession, userId);
}

async function loadEntryIntraday({ symbol, userId, entrySession, needs }) {
  if (!needs.needsEntryIntraday || !symbol || !entrySession) return null;
  return loadSessionIntradayBars(symbol, entrySession, userId);
}

/**
 * Prepares Entry Quality for an existing draft evaluation.
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
  const needs = entryDependencyNeeds(entryConfig);

  const setupContext = getSetupContext(evaluation, needs);
  const executionEvidence = normalizeExecutionEvidence(trade);

  const unavailableEvidence = [];
  if (!executionEvidence.available) unavailableEvidence.push('execution_evidence');
  if (!executionEvidence.initialEntryFillTrustworthy) unavailableEvidence.push('first_execution_print');
  // TradeTally has no trustworthy actual-initial-stop source: this is a known
  // evidence limitation of the canonical Initial Stop / Stop Width / Initial R.
  if (needs.has('initial_stop') || needs.has('stop_width')) {
    unavailableEvidence.push('actual_initial_stop');
  }
  if (needs.needsDailyEvidence) unavailableEvidence.push('entry_daily_evidence_pending');

  const symbol = String(trade.symbol || '').trim().toUpperCase();
  const entrySessionDate = executionEvidence.actualEntrySession || fallbackEntrySession(trade);
  const entryIntraday = needs.needsEntryIntraday && entrySessionDate
    ? await loadSessionIntradayBars(symbol, entrySessionDate, userId)
    : null;
  if (needs.needsEntryIntraday && (!entryIntraday || !entryIntraday.available)) {
    unavailableEvidence.push('entry_session_intraday');
  }
  const breakoutIntraday = await loadBreakoutIntraday({ symbol, userId, setupContext, needs });

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
      boundarySource: setupContext.boundarySource,
      needsPivot: needs.needsPivot,
      needsBreakoutSession: needs.needsBreakoutSession
    },
    executionEvidence: {
      available: executionEvidence.available,
      direction: executionEvidence.direction,
      originalPositionQty: executionEvidence.originalPositionQty,
      entryBasis: executionEvidence.entryBasis,
      initialEntryTime: executionEvidence.initialEntryTime,
      initialEntryFillPrice: executionEvidence.initialEntryFillPrice,
      initialEntryFillTime: executionEvidence.initialEntryFillTime,
      initialEntryFillTrustworthy: executionEvidence.initialEntryFillTrustworthy,
      ambiguousFirstFill: executionEvidence.ambiguousFirstFill,
      actualEntrySession: executionEvidence.actualEntrySession,
      firstReductionTime: executionEvidence.firstReductionTime,
      provenance: executionEvidence.provenance,
      fills: executionEvidence.fills,
      unavailableReason: executionEvidence.unavailableReason
    },
    intradayEvidence: {
      entrySession: entryIntraday
        ? { available: entryIntraday.available, date: entrySessionDate, source: entryIntraday.source, resolution: entryIntraday.resolution, bars: entryIntraday.bars ? entryIntraday.bars.length : 0, reason: entryIntraday.reason || null }
        : null,
      breakoutSession: breakoutIntraday
        ? { available: breakoutIntraday.available, date: setupContext.breakoutSession, source: breakoutIntraday.source, resolution: breakoutIntraday.resolution, bars: breakoutIntraday.bars ? breakoutIntraday.bars.length : 0, reason: breakoutIntraday.reason || null }
        : null
    },
    entryDependencyNeeds: {
      enabledKeys: needs.enabledKeys,
      needsPivot: needs.needsPivot,
      needsBreakoutSession: needs.needsBreakoutSession,
      needsTriggerIntraday: needs.needsTriggerIntraday,
      needsEntryIntraday: needs.needsEntryIntraday,
      needsDailyEvidence: needs.needsDailyEvidence,
      needsReferenceSessions: needs.needsReferenceSessions
    },
    allowedTriggerTypes: allowedTriggerTypesFromConfig(entryConfig),
    requiredEntryUserInputs: requiredEntryUserInputsFromConfig(entryConfig),
    entryCriterionKeys: enabledEntryCriteria(entryConfig).map((criterion) => criterion.key),
    unavailableEvidence
  };
}

/**
 * Evaluates and persists NON-TERMINAL Entry progress, preserving the valid
 * Setup result.
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
  const needs = entryDependencyNeeds(entryConfig);

  const setupContext = getSetupContext(evaluation, needs);
  const executionEvidence = normalizeExecutionEvidence(trade);
  const symbol = String(trade.symbol || '').trim().toUpperCase();

  const requiredInputs = requiredEntryUserInputsFromConfig(entryConfig);
  const allowedTypes = allowedTriggerTypesFromConfig(entryConfig);
  const raw = rawUserInputs && typeof rawUserInputs === 'object' ? rawUserInputs : {};
  const intendedTriggerType = parseIntendedTriggerType(raw.intended_trigger_type, {
    required: requiredInputs.includes('intended_trigger_type'),
    allowedTypes
  });

  const entrySessionDate = executionEvidence.actualEntrySession || null;

  // Daily evidence (only when a volatility consumer is enabled).
  const period = needs.needsDailyEvidence ? volatilityPeriod(entryConfig) : null;
  const entryDaily = needs.needsDailyEvidence
    ? await resolveEntryDailyEvidence({ evaluation, trade, userId, entrySession: entrySessionDate, period })
    : null;
  const dailyBars = entryDaily ? entryDaily.bars : [];
  const entryIndex = entryDaily ? entryDaily.index : -1;

  // Intraday evidence: breakout session (trigger) and actual entry session
  // (pace/LOD) are loaded SEPARATELY and never mixed (finding 9).
  const breakoutIntraday = await loadBreakoutIntraday({ symbol, userId, setupContext, needs });
  const entryIntraday = await loadEntryIntraday({ symbol, userId, entrySession: entrySessionDate, needs });
  const entrySession = entryIntraday && entryIntraday.session
    ? entryIntraday.session
    : (entrySessionDate ? regularSessionBounds(entrySessionDate) : null);

  const extraObservations = executionEvidence.available
    ? executionEvidence.fills.map((fill) => ({ epoch: fill.timestampEpoch, price: fill.price }))
    : [];

  const stopEvidence = resolveStopEvidence({ trade, executionEvidence });
  const methods = neededVolatilityMethods(entryConfig);
  const volatilityByMethod = buildVolatilityByMethod({
    methods,
    dailyBars,
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

  const storedInitialR =
    (parseJsonField(evaluation.evidence_snapshot) || {}).entry &&
    (parseJsonField(evaluation.evidence_snapshot) || {}).entry.initial_r
      ? (parseJsonField(evaluation.evidence_snapshot) || {}).entry.initial_r
      : null;
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
  let lod = { low: null, high: null, lastObservableEpoch: null, observableBars: 0, precision: null, reason: null };
  if (entryIntraday && entryIntraday.available && entrySession && isFiniteNumber(referenceEpoch)) {
    lod = observableLod({
      bars: entryIntraday.bars,
      openEpoch: entrySession.openEpoch,
      referenceEpoch,
      resolutionSeconds: entryIntraday.resolutionSeconds,
      extraObservations
    });
  } else if (!entryIntraday || !entryIntraday.available) {
    lod.reason = 'Entry-session intraday evidence is unavailable.';
  }

  const volumeCriterion = enabledCriterion(entryConfig, 'volume_pace');
  const rangeCriterion = enabledCriterion(entryConfig, 'range_pace');
  const referenceCount = Math.max(
    volumeCriterion ? volumeCriterion.parameters.reference_sessions : 0,
    rangeCriterion ? rangeCriterion.parameters.reference_sessions : 0
  );
  const referenceSessions = entryIntraday && entryIntraday.available
    ? await loadReferenceSessions({ symbol, userId, dailyBars, entryIndex, count: referenceCount })
    : [];

  let volumePace = null;
  let rangePace = null;
  let rangeAtEntryOverAdr = null;
  if (entryIntraday && entryIntraday.available && entrySession && isFiniteNumber(executionEvidence.initialEntryEpoch)) {
    const entryCutoffEpoch = executionEvidence.initialEntryEpoch;
    if (volumeCriterion) {
      volumePace = computePaceMetric({
        entrySession,
        entrySessionBars: entryIntraday.bars,
        entryCutoffEpoch,
        referenceSessions,
        requiredSessions: volumeCriterion.parameters.reference_sessions,
        kind: 'volume'
      });
    }
    if (rangeCriterion) {
      rangePace = computePaceMetric({
        entrySession,
        entrySessionBars: entryIntraday.bars,
        entryCutoffEpoch,
        referenceSessions,
        requiredSessions: rangeCriterion.parameters.reference_sessions,
        kind: 'range',
        extraObservations
      });
      const adr = volatilityByMethod.ADR;
      if (rangePace && rangePace.available && adr && adr.available && adr.dollars > 0) {
        rangeAtEntryOverAdr = rangePace.today / adr.dollars;
      }
    }
  }

  const triggerCriterion = entryConfig.criteria.find((criterion) => criterion.key === 'trigger_compliance');
  const triggerParameters = triggerCriterion && triggerCriterion.parameters ? triggerCriterion.parameters : {};
  let triggerResolution = null;
  if (intendedTriggerType && executionEvidence.available && executionEvidence.direction === 'long') {
    const wantsBreakoutBars =
      OPENING_RANGE_TRIGGER_TYPES.includes(intendedTriggerType) ||
      triggerCriterion !== undefined;
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
      intraday: wantsBreakoutBars && breakoutIntraday && breakoutIntraday.available
        ? {
            breakoutSession: setupContext.breakoutSession,
            breakoutSessionBars: breakoutIntraday.bars,
            entrySessionBars: entryIntraday ? entryIntraday.bars : [],
            resolution: breakoutIntraday.resolution,
            resolutionSeconds: breakoutIntraday.resolutionSeconds
          }
        : null
    });
  }

  const intradayMetrics = {
    entryIntraday,
    breakoutIntraday,
    session: entrySession,
    resolution: entryIntraday ? entryIntraday.resolution : null,
    resolutionSeconds: entryIntraday ? entryIntraday.resolutionSeconds : null,
    regularSessionOpenEpoch: entrySession ? entrySession.openEpoch : null,
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
    userInputs: { intended_trigger_type: intendedTriggerType }
  };

  const criterionRows = buildEntryCriterionRows(entryConfig, context);

  const storedSnapshot = parseJsonField(evaluation.evidence_snapshot) || {};
  const storedInputs = parseJsonField(evaluation.user_inputs) || {};
  const storedDetected = parseJsonField(evaluation.detected_context) || {};

  const entryEvidenceBlock = buildEntryEvidenceBlock({
    executionEvidence,
    setupContext,
    entryDaily,
    entryIntraday,
    breakoutIntraday,
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

  const dependencyFingerprint = computeEntryDependencyFingerprint(evaluation);

  let updated;
  try {
    updated = await saveEntryProgress(evaluationId, userId, {
      entryResults: { criterionResults: criterionRows },
      evidenceSnapshot,
      userInputs: storedUserInputs,
      detectedContext,
      dependencyFingerprint
    });
  } catch (error) {
    if (error && error.code === 'STALE_DEPENDENCY') {
      throw new EntryQualityInputError(error.message, 'STALE_DEPENDENCY');
    }
    throw error;
  }
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
      initialEntryFillPrice: executionEvidence.initialEntryFillPrice,
      entryBasis: executionEvidence.entryBasis,
      originalPositionQty: executionEvidence.originalPositionQty,
      intendedTriggerType,
      effectiveTrigger: triggerResolution ? triggerResolution.effectiveTrigger : null,
      initialR
    }
  };
}

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
  entryDependencyNeeds,
  requiredEntryUserInputsFromConfig,
  allowedTriggerTypesFromConfig,
  getSetupContext,
  parseIntendedTriggerType,
  buildEntryCriterionRows,
  buildEntryEvidenceBlock,
  referenceSessionDates,
  neededVolatilityMethods,
  volatilityPeriod,
  computeEntryDependencyFingerprint,
  toFrontendEvaluation
};
