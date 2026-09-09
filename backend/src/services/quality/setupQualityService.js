'use strict';

// Setup Quality orchestration service (Phase 2 of
// docs/QUALITY_PROFILES_REQUIREMENT.md, sections 15, 20, 49 and 57).
//
// The Prepare -> Confirm/Adjust -> Evaluate workflow:
//   - prepare(): resolves the Quality Profile/version (default Canonical BO),
//     fetches normalized daily OHLCV evidence, proposes a Base Start and a
//     Pivot (using the trade's initial entry session only as a provisional
//     search upper bound), and creates/reuses a NON-TERMINAL draft
//     trade_quality_evaluations row that carries the detection context.
//   - evaluate(): validates the semantic user inputs (leader assertion,
//     confirmed/adjusted Base Start, confirmed/adjusted Pivot), derives the
//     authoritative Setup boundary (breakout-resolution session D = first
//     session after the confirmed Base Start trading above the confirmed
//     Pivot; Base End = D-1), runs exactly the enabled Setup criteria of the
//     immutable profile version, aggregates the Setup dimension with the
//     Phase 1 engine and persists non-terminal Setup progress.
//
// A late actual entry never shifts Base End: the resolution search is bounded
// by the trade's initial entry session, so post-breakout sessions never
// contaminate Setup Quality. Confirmed Base Start/Pivot values are
// authoritative for every downstream Setup calculation and are never
// overwritten by a detector rerun.
//
// This service never scores Entry or Management and never fabricates results
// for them. It does not mark evaluations `completed` (Phase 3/4 will continue
// from the same draft row/architecture).

const { CRITERION_STATUS } = require('./constants');
const { deriveScoreForCriterion } = require('./scoring');
const {
  createEvaluation,
  saveSetupProgress,
  getEvaluation,
  EVALUATION_COLUMNS
} = require('./evaluationService');
const profileService = require('./profileService');
const { loadDailyEvidence } = require('./marketEvidenceService');
const { normalizeDailyBars, indexByDate, addCalendarDays, calendarDaysForSessions } = require('./dailyEvidence');
const { detectBaseStart } = require('./detectors/baseStart');
const { detectPivot } = require('./detectors/pivot');
const { resolveSetupBoundary } = require('./detectors/setupBoundary');
const { evaluateCriterion, SETUP_CRITERION_KEYS } = require('./criterionRegistry');
const { validateSetupCriteria } = require('./criteria/setup/parameterSchemas');
const { getDateInTimezone } = require('../../utils/timezone');

// Calendar slack: detector right windows, contraction windows and an extra
// buffer beyond the pure session requirement, plus holiday gaps absorbed by
// the session->calendar conversion. Session durations are always counted from
// actual bars; this constant only sizes the fetch request.
const HISTORY_SESSION_SLACK = 40;
const POST_ENTRY_CALENDAR_DAYS = 10;
const MARKET_TZ = 'America/New_York';

const CONFIRM_SOURCES = Object.freeze(['detected_confirmed', 'user_adjusted']);
const TERMINAL_STATUSES = Object.freeze(['completed', 'insufficient_data']);

class SetupQualityInputError extends Error {
  constructor(message, code = 'INVALID_INPUT', details = null) {
    super(message);
    this.name = 'SetupQualityInputError';
    this.code = code;
    this.details = details;
  }
}

function hasOwn(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

async function getTradeForUser(userId, tradeId) {
  const result = await require('../../config/database').query(
    `
      SELECT id, user_id, symbol, side, instrument_type, entry_time, exit_time, trade_date
      FROM trades
      WHERE id = $1 AND user_id = $2
    `,
    [tradeId, userId]
  );
  return result.rows[0] || null;
}

// Resolves the profile + current version used by prepare. Defaults to the
// user's Canonical BO profile (seeding it on first use) when no profileId is
// supplied.
async function resolveProfileAndVersion(userId, { profileId } = {}) {
  let profile;
  if (profileId) {
    profile = await profileService.findById(profileId, userId);
    if (!profile) {
      throw new SetupQualityInputError('Quality Profile not found or not owned by this user.', 'PROFILE_NOT_FOUND');
    }
  } else {
    profile = await profileService.ensureCanonicalBO(userId);
  }
  const version = await profileService.getCurrentVersion(profile.id, userId);
  if (!version) {
    throw new SetupQualityInputError('Quality Profile has no current version.', 'PROFILE_NO_VERSION');
  }
  return { profile, version };
}

function getSetupDimensionConfig(configuration) {
  if (
    configuration === null ||
    typeof configuration !== 'object' ||
    !configuration.dimensions ||
    !configuration.dimensions.setup
  ) {
    throw new SetupQualityInputError(
      'Profile version has no setup dimension configuration.',
      'PROFILE_CONFIG_INVALID'
    );
  }
  const setupConfig = configuration.dimensions.setup;
  if (!Array.isArray(setupConfig.criteria)) {
    throw new SetupQualityInputError(
      'Profile version setup dimension has no criteria.',
      'PROFILE_CONFIG_INVALID'
    );
  }
  return setupConfig;
}

// Enforces the Setup execution contract before any detection or evaluation
// runs:
//   - typed Setup criterion parameters (positive-integer windows/lookbacks/
//     periods/counts, finite non-negative tolerances/ratios, boolean flags,
//     supported enum policy values, minimum_sessions <= maximum_sessions);
//   - every parameter a detector/evaluator interprets must be present
//     (required) — trading-policy fields are never silently defaulted;
//   - an ENABLED Setup criterion that no evaluator supports is a configuration
//     error (a clear PROFILE_CONFIG_INVALID), never a runtime 500 from the
//     criterion registry.
function assertValidSetupConfiguration(setupConfig) {
  const violations = validateSetupCriteria(setupConfig);
  if (violations.length > 0) {
    throw new SetupQualityInputError(
      `Profile version setup configuration is invalid: ${violations.join('; ')}`,
      'PROFILE_CONFIG_INVALID'
    );
  }
  const unsupportedEnabled = enabledSetupCriteria(setupConfig)
    .filter((criterion) => !SETUP_CRITERION_KEYS.includes(criterion.key))
    .map((criterion) => criterion.key);
  if (unsupportedEnabled.length > 0) {
    throw new SetupQualityInputError(
      `Unsupported enabled Setup criterion key(s): ${unsupportedEnabled.join(', ')}. ` +
        'No evaluator is implemented for them in Phase 2.',
      'PROFILE_CONFIG_INVALID'
    );
  }
}

function enabledSetupCriteria(setupConfig) {
  return setupConfig.criteria.filter(
    (criterion) => criterion.enabled === undefined || criterion.enabled === true
  );
}

// Reads detector parameters from the profile setup criteria that own them
// (base_duration owns Base Start detection tuning; pivot_quality owns Pivot
// detection tuning), so every detection window/threshold is profile
// configuration and never hard-coded.
function baseStartParameters(setupConfig) {
  const criterion = setupConfig.criteria.find((entry) => entry.key === 'base_duration');
  if (!criterion || !criterion.parameters) {
    throw new SetupQualityInputError(
      'Profile has no base_duration criterion parameters for Base Start detection.',
      'PROFILE_CONFIG_INVALID'
    );
  }
  return criterion.parameters;
}

function pivotParameters(setupConfig) {
  const criterion = setupConfig.criteria.find((entry) => entry.key === 'pivot_quality');
  if (!criterion || !criterion.parameters) {
    throw new SetupQualityInputError(
      'Profile has no pivot_quality criterion parameters for Pivot detection.',
      'PROFILE_CONFIG_INVALID'
    );
  }
  return criterion.parameters;
}

function entrySessionDate(trade) {
  if (!trade || !trade.entry_time) return null;
  return getDateInTimezone(trade.entry_time, MARKET_TZ, false);
}

function findEntrySessionIndex(bars, dateIndexByDate, entryDate) {
  if (!entryDate || !dateIndexByDate.has(entryDate)) return -1;
  return dateIndexByDate.get(entryDate);
}

function criterionParameters(setupConfig, key) {
  const criterion = setupConfig.criteria.find((entry) => entry.key === key);
  return criterion && criterion.parameters ? criterion.parameters : null;
}

// Derives the required daily-session history from the immutable Setup
// configuration: Base Start detection lookback before the breakout, plus the
// Prior Move search lookback before the Base Start, plus SMA/MA indicator
// history, plus detector window slack. The resulting session count is then
// converted into a conservative calendar-day fetch request so a user who
// enlarges a configured lookback never hits an undocumented fixed 400-day
// implementation ceiling.
function requiredHistorySessions(setupConfig) {
  const baseDuration = criterionParameters(setupConfig, 'base_duration');
  const priorMove = criterionParameters(setupConfig, 'prior_move');
  const maTrend = criterionParameters(setupConfig, 'ma_trend');

  const detectionLookback =
    baseDuration && Number.isInteger(baseDuration.detection_lookback)
      ? baseDuration.detection_lookback
      : 60;
  const priorLookback =
    priorMove && Number.isInteger(priorMove.search_lookback) ? priorMove.search_lookback : 60;
  const slowPeriod =
    maTrend && Number.isInteger(maTrend.slow_period) ? maTrend.slow_period : 20;
  const slopeLookback =
    maTrend && Number.isInteger(maTrend.slope_lookback) ? maTrend.slope_lookback : 5;

  return detectionLookback + priorLookback + slowPeriod + slopeLookback + HISTORY_SESSION_SLACK;
}

function evidenceWindowDates(entryDate, setupConfig) {
  const sessions = setupConfig ? requiredHistorySessions(setupConfig) : 185;
  const fromDate = addCalendarDays(entryDate, -calendarDaysForSessions(sessions));
  const toDate = addCalendarDays(entryDate, POST_ENTRY_CALENDAR_DAYS);
  return { fromDate, toDate };
}

// ---------------------------------------------------------------------------
// Detection proposals (prepare)
// ---------------------------------------------------------------------------

function parseJsonField(value, label) {
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

// Shape check only: bars exist for the same symbol/entry session.
function snapshotHasShape(snapshot, symbolUpper, entryDate) {
  return (
    snapshot !== null &&
    Array.isArray(snapshot.bars) &&
    snapshot.bars.length > 0 &&
    snapshot.entrySessionDate === entryDate &&
    String(snapshot.symbol || '').toUpperCase() === symbolUpper
  );
}

// Determines whether a stored evidence snapshot is a REUSABLE AUTHORITATIVE
// scoring snapshot (same symbol, same entry session, non-empty bars AND
// verified provider completeness). An unverified (cache-only) snapshot is
// provisional: it is NOT reused — prepare() retries the provider chain so
// evidence can recover without manual cleanup.
function snapshotIsUsable(snapshot, symbolUpper, entryDate) {
  return snapshotHasShape(snapshot, symbolUpper, entryDate) &&
    completenessFromSnapshot(snapshot) === 'verified';
}

function evaluationHasResults(evaluation) {
  const results = parseJsonField(evaluation.results, 'results');
  return (
    results !== null &&
    typeof results === 'object' &&
    Object.prototype.hasOwnProperty.call(results, 'setup') &&
    results.setup !== null
  );
}

function sameBars(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return a === b;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i];
    const y = b[i];
    if (
      x.date !== y.date ||
      x.open !== y.open ||
      x.high !== y.high ||
      x.low !== y.low ||
      x.close !== y.close ||
      x.volume !== y.volume
    ) {
      return false;
    }
  }
  return true;
}

// True when the staged pivot detection equals the stored detection context
// (same price/date and the same Base Start it was derived under).
function stagedPivotMatchesStored(detections, storedDetected) {
  const stored = storedDetected && storedDetected.pivotDetection;
  const staged = detections && detections.pivot;
  if (!stored || !staged) return stored === staged;
  return (
    stored.price === staged.price &&
    stored.date === staged.date &&
    stored.baseStartDateUsed === staged.derivedFromBaseStart
  );
}

// True when a prepare operation changes any semantic dependency that can affect
// Setup results: evidence context, the confirmed/adjusted Base Start, or the
// Pivot detection context.
function prepareChangesSetupContext({ storedSnapshot, reuseStored, bars, storedInputs, storedDetected, stagedBaseStart, detections }) {
  const evidenceChanged = reuseStored
    ? !sameBars(bars, storedSnapshot ? storedSnapshot.bars : null)
    : true;
  const storedBase = (storedInputs && storedInputs.base_start) || null;
  const stagedDate = stagedBaseStart ? stagedBaseStart.date : null;
  const storedDate = storedBase ? storedBase.date : null;
  const baseStartChanged = stagedDate !== storedDate;
  const pivotChanged = !stagedPivotMatchesStored(detections, storedDetected);
  return { evidenceChanged, baseStartChanged, pivotChanged, changed: evidenceChanged || baseStartChanged || pivotChanged };
}

function completenessFromSnapshot(snapshot) {
  if (snapshot && typeof snapshot.completeness === 'string') return snapshot.completeness;
  if (snapshot && snapshot.source === 'historical_cache') return 'unverified';
  return 'verified';
}

// Validates a confirmed/adjusted Base Start submitted for pivot re-detection
// or for evaluation. Returns { date, index, price, source }.
function parseConfirmedBaseStartInput(input, { bars, dateIndexByDate, entryIndex }) {
  if (!input || typeof input !== 'object') {
    throw new SetupQualityInputError('confirmedBaseStart requires { date, source }.', 'BASE_START_REQUIRED');
  }
  const date = parseDateOnly(input.date, 'base_start.date');
  if (!dateIndexByDate.has(date)) {
    throw new SetupQualityInputError(
      'Confirmed Base Start must be a trading session present in the available daily evidence.',
      'BASE_START_NOT_A_SESSION',
      { date }
    );
  }
  const index = dateIndexByDate.get(date);
  if (entryIndex === -1 || index >= entryIndex) {
    throw new SetupQualityInputError(
      'Base Start must be a trading session before the trade\'s initial entry session (before or equal to the setup D-1).',
      'BASE_START_AFTER_ENTRY',
      { date, entrySessionDate: null }
    );
  }
  const source = input.source;
  if (!CONFIRM_SOURCES.includes(source)) {
    throw new SetupQualityInputError(
      `base_start.source must be one of ${CONFIRM_SOURCES.join(', ')}.`,
      'INVALID_SOURCE'
    );
  }
  return { date, index, price: bars[index].high, source };
}

// Reuses persisted stage confirmations from a previous prepare (same
// evidence) so the Base Start -> Pivot dependency stays coherent after reload.
function persistedConfirmedBaseStart(evaluation, { bars, dateIndexByDate, entryIndex }) {
  const userInputs = parseJsonField(evaluation.user_inputs, 'user_inputs');
  if (!userInputs || !userInputs.base_start) return null;
  const candidate = userInputs.base_start;
  if (candidate.date && dateIndexByDate.has(candidate.date)) {
    const index = dateIndexByDate.get(candidate.date);
    if (index < entryIndex) {
      return {
        date: candidate.date,
        index,
        price: bars[index].high,
        source: candidate.source === 'user_adjusted' ? 'user_adjusted' : 'detected_confirmed'
      };
    }
  }
  return null;
}

/**
 * Runs the deterministic detection pass over one coherent evidence series.
 *
 * The Base Start search is bounded by the provisional D-1 = session before the
 * trade's initial entry session (the search upper bound the specification
 * allows for proposing detections). Pivot detection is bounded by the SAME
 * provisional D-1 and always starts from the effective Base Start — the
 * confirmed/adjusted Base Start when one exists (the confirmed Base Start is
 * authoritative for downstream structural calculations), otherwise the machine
 * detection. Detections are proposals; the authoritative Setup boundary is
 * re-derived at evaluate() from the confirmed values.
 *
 * @returns {object} { provisionalBaseEndIndex, baseStart, pivot, effectiveBaseStart,
 *   detectionEvidence }
 */
function proposeDetections({ bars, dateIndexByDate, entryIndex, setupConfig, baseStartForPivot }) {
  const provisionalBaseEndIndex = entryIndex - 1;
  const baseParams = baseStartParameters(setupConfig);
  const pivotParams = pivotParameters(setupConfig);

  const baseStartResult =
    provisionalBaseEndIndex >= 0
      ? detectBaseStart({ bars, endIndex: provisionalBaseEndIndex, parameters: baseParams })
      : null;

  const machineBaseStart = baseStartResult
    ? {
        index: baseStartResult.index,
        date: baseStartResult.date,
        price: baseStartResult.price,
        source: 'detected'
      }
    : null;

  let effectiveBaseStart = null;
  if (baseStartForPivot) {
    effectiveBaseStart = {
      index: baseStartForPivot.index,
      date: baseStartForPivot.date,
      price: baseStartForPivot.price,
      source: baseStartForPivot.source
    };
  } else if (machineBaseStart) {
    effectiveBaseStart = machineBaseStart;
  }

  let pivotResult = null;
  if (
    effectiveBaseStart &&
    provisionalBaseEndIndex >= effectiveBaseStart.index &&
    provisionalBaseEndIndex >= 0
  ) {
    pivotResult = detectPivot({
      bars,
      rangeStartIndex: effectiveBaseStart.index,
      rangeEndIndex: provisionalBaseEndIndex,
      parameters: pivotParams
    });
  }

  const pivot = pivotResult
    ? {
        index: pivotResult.pivot.index,
        date: pivotResult.pivot.date,
        price: pivotResult.pivot.price,
        confidence: pivotResult.confidence,
        method: pivotResult.method,
        source: 'detected',
        derivedFromBaseStart: effectiveBaseStart.date
      }
    : null;

  return {
    provisionalBaseEndIndex,
    provisionalBaseEndIndexDate:
      provisionalBaseEndIndex >= 0 ? bars[provisionalBaseEndIndex].date : null,
    baseStart: machineBaseStart,
    pivot,
    effectiveBaseStart,
    detectionEvidence: {
      baseStart: baseStartResult
        ? {
            candidateCount: baseStartResult.candidateCount,
            allowancePct: baseStartResult.allowancePct,
            lookbackStartDate: bars[baseStartResult.lookbackStartIndex].date,
            searchEndDate: bars[provisionalBaseEndIndex].date
          }
        : null,
      pivot: pivotResult ? pivotResult.evidence : null
    }
  };
}

// Builds the v2 detected-context block stored with an evaluation.
function buildDetectedContext({ entryDate, detections }) {
  return {
    version: 2,
    preparedAt: new Date().toISOString(),
    entrySessionDate: entryDate,
    provisionalBaseEndDate:
      detections && detections.provisionalBaseEndIndex >= 0
        ? detections.provisionalBaseEndIndexDate
        : null,
    baseStartDetection: detections && detections.baseStart
      ? {
          index: detections.baseStart.index,
          date: detections.baseStart.date,
          price: detections.baseStart.price,
          source: 'detected'
        }
      : null,
    pivotDetection: detections && detections.pivot
      ? {
          index: detections.pivot.index,
          date: detections.pivot.date,
          price: detections.pivot.price,
          confidence: detections.pivot.confidence,
          method: detections.pivot.method,
          source: 'detected',
          baseStartDateUsed: detections.effectiveBaseStart
            ? detections.effectiveBaseStart.date
            : null,
          baseStartSourceUsed: detections.effectiveBaseStart
            ? detections.effectiveBaseStart.source
            : null
        }
      : null,
    detectionEvidence: detections ? detections.detectionEvidence : null
  };
}

function buildEvidenceSnapshot({ trade, evidence, entryDate, bars, fromDate, toDate, boundary }) {
  return {
    symbol: String(trade.symbol || '').toUpperCase(),
    resolution: 'daily',
    requestedWindow: { fromDate, toDate },
    source: evidence.source,
    completeness: evidence.completeness || 'unverified',
    sessionCount: bars.length,
    firstDate: bars.length > 0 ? bars[0].date : null,
    lastDate: bars.length > 0 ? bars[bars.length - 1].date : null,
    entrySessionDate: entryDate,
    setupBoundary: boundary || null,
    bars
  };
}

// Finds the draft evaluation for a trade + profile version and decides whether
// an existing non-terminal row can be reused.
//
// Invariant: ONE evaluation has ONE coherent evidence/detection context.
//   - A VERIFIED stored snapshot is reused (model A) even when Setup results
//     have been persisted: prepare() recomputes detections ONLY against that
//     stored snapshot and never fetches fresh evidence for it.
//   - An UNVERIFIED (cache-only) snapshot is provisional, never authoritative:
//     prepare() retries the provider chain and, if verified evidence becomes
//     available, replaces it on the same still-unevaluated draft.
//   - When the existing draft has a result-bearing snapshot that is NOT
//     reusable (missing/entry-changed/unverified-with-results), fresh evidence
//     must not be attached to it: a NEW draft is created (model B).
async function findEvaluationForPrepare(userId, tradeId, profileVersionId, symbolUpper, entryDate) {
  const db = require('../../config/database');
  const existing = await db.query(
    `
      SELECT ${EVALUATION_COLUMNS}
      FROM trade_quality_evaluations
      WHERE user_id = $1
        AND trade_id = $2
        AND profile_version_id = $3
        AND status NOT IN ('completed', 'insufficient_data')
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [userId, tradeId, profileVersionId]
  );
  if (existing.rows.length === 0) {
    return createEvaluation(userId, tradeId, profileVersionId);
  }
  const candidate = existing.rows[0];
  const stored = parseJsonField(candidate.evidence_snapshot, 'evidence_snapshot');
  if (snapshotIsUsable(stored, symbolUpper, entryDate)) {
    return candidate;
  }
  if (evaluationHasResults(candidate)) {
    return createEvaluation(userId, tradeId, profileVersionId);
  }
  // Unverified/no snapshot and no persisted results: reuse the draft and retry
  // the provider chain (evidence can recover without manual cleanup).
  return candidate;
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

// Persists one coherent evidence/detection/input context on a non-terminal
// draft evaluation. Terminal rows are never touched (SQL guard + returned row
// check).
async function persistPrepareContext(evaluationId, userId, payload) {
  const db = require('../../config/database');
  const updated = await db.query(
    `
      UPDATE trade_quality_evaluations
      SET evidence_snapshot = $3,
          detected_context = $4,
          user_inputs = $5
      WHERE id = $1 AND user_id = $2
        AND status NOT IN ('completed', 'insufficient_data')
      RETURNING ${EVALUATION_COLUMNS}
    `,
    [evaluationId, userId, payload.evidenceSnapshot, payload.detectedContext, payload.userInputs]
  );
  if (updated.rows.length === 0) {
    throw new SetupQualityInputError(
      'Evaluation could not be updated (it may have reached a terminal state).',
      'EVALUATION_TERMINAL'
    );
  }
  return updated.rows[0];
}

// Invalidates a stale Setup result when a prepare changed the semantic context
// (evidence / confirmed Base Start / Pivot detection). The Setup aggregate and
// flat summary fields are cleared so the old grade is never shown against the
// new confirmations; the draft id is retained and non-setup result keys (e.g.
// a future entry/management) are preserved. Run Setup Quality again is then
// required before Setup is considered evaluated.
async function clearSetupResults(evaluationId, userId, preservedResults) {
  const db = require('../../config/database');
  const updated = await db.query(
    `
      UPDATE trade_quality_evaluations
      SET results = $3,
          setup_score = NULL,
          setup_grade = NULL,
          setup_compliance = NULL,
          setup_coverage = NULL
      WHERE id = $1 AND user_id = $2
        AND status NOT IN ('completed', 'insufficient_data')
      RETURNING ${EVALUATION_COLUMNS}
    `,
    [evaluationId, userId, preservedResults]
  );
  if (updated.rows.length === 0) {
    throw new SetupQualityInputError(
      'Evaluation could not be updated (it may have reached a terminal state).',
      'EVALUATION_TERMINAL'
    );
  }
  return updated.rows[0];
}

function preservedNonSetupResults(results) {
  const parsed = parseJsonField(results, 'results');
  if (!parsed || typeof parsed !== 'object') return null;
  const copy = { ...parsed };
  delete copy.setup;
  return Object.keys(copy).length > 0 ? copy : null;
}

/**
 * Prepares (or re-prepares) the detection context for a Setup Quality
 * evaluation.
 *
 * POST body may carry:
 *   profileId          - optional; defaults to the user's Canonical BO profile
 *   confirmedBaseStart - optional { date, source }; once the user has
 *                        confirmed/adjusted the Base Start, pass it back so
 *                        the Pivot is (re-)detected from THAT Base Start on the
 *                        SAME evidence snapshot. This is the only way a later
 *                        Pivot can be labelled detected_confirmed.
 *
 * One evaluation always has one coherent evidence/detection context (the
 * snapshot on the returned evaluation is exactly the evidence the returned
 * detections were computed from). Evidence is only refreshed when no usable
 * stored snapshot exists, and then only on a NEW evaluation if the existing
 * draft already holds persisted Setup results.
 */
async function prepare(userId, tradeId, { profileId, confirmedBaseStart } = {}) {
  const trade = await getTradeForUser(userId, tradeId);
  if (!trade) {
    throw new SetupQualityInputError('Trade not found or not owned by this user.', 'TRADE_NOT_FOUND');
  }
  const entryDate = entrySessionDate(trade);
  if (!entryDate) {
    throw new SetupQualityInputError('Trade has no entry time; Setup Quality cannot be prepared.', 'TRADE_NO_ENTRY_TIME');
  }
  const symbolUpper = String(trade.symbol || '').trim().toUpperCase();
  if (!symbolUpper) {
    throw new SetupQualityInputError('Trade has no symbol; Setup Quality cannot be prepared.', 'TRADE_NO_SYMBOL');
  }

  const { profile, version } = await resolveProfileAndVersion(userId, { profileId });
  const setupConfig = getSetupDimensionConfig(version.configuration);
  assertValidSetupConfiguration(setupConfig);

  const { fromDate, toDate } = evidenceWindowDates(entryDate, setupConfig);

  // Choose the evaluation + evidence pair (model A reuse vs model B refresh).
  const evaluation = await findEvaluationForPrepare(
    userId,
    tradeId,
    version.id,
    symbolUpper,
    entryDate
  );
  const stored = parseJsonField(evaluation.evidence_snapshot, 'evidence_snapshot');
  const reuseStored = snapshotIsUsable(stored, symbolUpper, entryDate);

  let evidence;
  if (reuseStored) {
    evidence = {
      bars: stored.bars,
      source: stored.source,
      completeness: completenessFromSnapshot(stored),
      error: null
    };
  } else {
    evidence = await loadDailyEvidence({ symbol: symbolUpper, userId, fromDate, toDate });
  }

  const bars = normalizeDailyBars(evidence.bars);
  const dateIndexByDate = indexByDate(bars);
  const entryIndex = findEntrySessionIndex(bars, dateIndexByDate, entryDate);

  const unavailableEvidence = [];
  if (bars.length === 0) {
    unavailableEvidence.push('daily_ohlcv');
  }
  if (entryIndex === -1) {
    unavailableEvidence.push('entry_session_bar');
  }
  if (evidence.completeness !== 'verified') {
    unavailableEvidence.push('evidence_completeness');
  }

  // Effective Base Start: confirmedBaseStart from this request first, then a
  // previously persisted Base Start confirmation (same evidence), then the
  // machine detection.
  let baseStartForPivot = null;
  if (confirmedBaseStart) {
    baseStartForPivot = parseConfirmedBaseStartInput(confirmedBaseStart, {
      bars,
      dateIndexByDate,
      entryIndex
    });
  } else if (entryIndex !== -1) {
    baseStartForPivot = persistedConfirmedBaseStart(evaluation, {
      bars,
      dateIndexByDate,
      entryIndex
    });
  }

  const detections =
    bars.length > 0 && entryIndex > 0
      ? proposeDetections({ bars, dateIndexByDate, entryIndex, setupConfig, baseStartForPivot })
      : {
          provisionalBaseEndIndex: entryIndex - 1,
          provisionalBaseEndIndexDate: entryIndex > 0 ? bars[entryIndex - 1].date : null,
          baseStart: null,
          pivot: null,
          effectiveBaseStart: null,
          detectionEvidence: { baseStart: null, pivot: null }
        };

  const detectedContext = buildDetectedContext({ entryDate, detections });
  const evidenceSnapshot = buildEvidenceSnapshot({
    trade,
    evidence,
    entryDate,
    bars,
    fromDate,
    toDate,
    boundary: null
  });

  const existingUserInputs = parseJsonField(evaluation.user_inputs, 'user_inputs') || {};
  const stagedBaseStart = baseStartForPivot
    ? { date: baseStartForPivot.date, source: baseStartForPivot.source }
    : null;
  const userInputs = {
    ...existingUserInputs,
    ...(stagedBaseStart ? { base_start: stagedBaseStart } : {})
  };

  // Invalidation rule: if a Setup result is already persisted and this prepare
  // changes any semantic dependency that can affect Setup results (evidence,
  // confirmed/adjusted Base Start, or the Pivot detection context), the old
  // Setup result must not stay represented as valid. The result is cleared
  // below; the draft id is retained and Run Setup Quality is required again.
  const storedSnapshot = parseJsonField(evaluation.evidence_snapshot, 'evidence_snapshot');
  const storedDetected = parseJsonField(evaluation.detected_context, 'detected_context');
  const hasSetupResult = evaluationHasResults(evaluation);
  const { baseStartChanged, changed: contextChanged } = prepareChangesSetupContext({
    storedSnapshot,
    reuseStored,
    bars,
    storedInputs: existingUserInputs,
    storedDetected,
    stagedBaseStart,
    detections
  });
  const clearSetup = hasSetupResult && contextChanged;

  // A changed Base Start invalidates any previously confirmed Pivot: never
  // leave an old pivot confirmation in the persisted user_inputs.
  if (baseStartChanged) {
    delete userInputs.pivot;
  }

  const refreshed = await persistPrepareContext(evaluation.id, userId, {
    evidenceSnapshot,
    detectedContext,
    userInputs
  });
  const finalRow = clearSetup
    ? await clearSetupResults(evaluation.id, userId, preservedNonSetupResults(evaluation.results))
    : refreshed;

  return {
    evaluation: toFrontendEvaluation(finalRow),
    profile: {
      id: profile.id,
      name: profile.name
    },
    profileVersion: {
      id: version.id,
      versionNumber: version.version_number,
      schemaVersion: version.schema_version
    },
    setupCriterionKeys: enabledSetupCriteria(setupConfig).map((criterion) => criterion.key),
    detectedBaseStart: detections && detections.baseStart
      ? { date: detections.baseStart.date, price: detections.baseStart.price }
      : null,
    detectedPivot: detections && detections.pivot
      ? {
          date: detections.pivot.date,
          price: detections.pivot.price,
          detectionConfidence: detections.pivot.confidence,
          method: detections.pivot.method,
          derivedFromBaseStart: detections.pivot.derivedFromBaseStart
        }
      : null,
    pivotBaseStartDate: detections && detections.effectiveBaseStart
      ? detections.effectiveBaseStart.date
      : null,
    pivotBaseStartSource: detections && detections.effectiveBaseStart
      ? detections.effectiveBaseStart.source
      : null,
    evidence: {
      symbol: symbolUpper,
      source: evidence.source,
      completeness: evidence.completeness || 'unverified',
      sessionCount: bars.length,
      firstDate: bars.length > 0 ? bars[0].date : null,
      lastDate: bars.length > 0 ? bars[bars.length - 1].date : null,
      entrySessionDate: entryDate
    },
    requiredUserInputs: ['leader_confirmed', 'base_start', 'pivot'],
    unavailableEvidence
  };
}

// ---------------------------------------------------------------------------
// Semantic input parsing/validation (evaluate)
// ---------------------------------------------------------------------------

function parseDateOnly(value, label) {
  if (typeof value !== 'string') {
    throw new SetupQualityInputError(`${label} must be a YYYY-MM-DD date.`);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    // Allow full ISO timestamps by taking their date part.
    const iso = /^(\d{4}-\d{2}-\d{2})T/.exec(value);
    if (iso) return iso[1];
    throw new SetupQualityInputError(`${label} must be a valid date.`);
  }
  return value;
}

function parseBaseStartInput(input, { bars, dateIndexByDate, entryIndex, detections }) {
  if (!input || typeof input !== 'object') {
    throw new SetupQualityInputError('base_start confirmation is required.');
  }
  const date = parseDateOnly(input.date, 'base_start.date');
  if (!dateIndexByDate.has(date)) {
    throw new SetupQualityInputError(
      'Adjusted/confirmed Base Start must be a trading session present in the available daily evidence.',
      'BASE_START_NOT_A_SESSION',
      { date }
    );
  }
  const index = dateIndexByDate.get(date);
  if (entryIndex === -1 || index >= entryIndex) {
    throw new SetupQualityInputError(
      'Base Start must be a trading session before the trade\'s initial entry session (before or equal to the setup D-1).',
      'BASE_START_AFTER_ENTRY',
      { date, entrySessionDate: null }
    );
  }
  const source = input.source;
  if (!CONFIRM_SOURCES.includes(source)) {
    throw new SetupQualityInputError(
      `base_start.source must be one of ${CONFIRM_SOURCES.join(', ')}.`,
      'INVALID_SOURCE'
    );
  }
  if (source === 'detected_confirmed') {
    // A Base Start may only be labelled detected_confirmed when it exactly
    // matches the machine detection stored for this evaluation/evidence.
    const storedBase = detections && detections.baseStartDetection;
    if (!storedBase || storedBase.date !== date) {
      throw new SetupQualityInputError(
        'Confirmed Base Start must match the machine-detected Base Start stored for this evidence snapshot. Re-run Prepare or label it as user_adjusted.',
        'BASE_START_DETECTION_MISMATCH',
        { submittedDate: date, detectedDate: storedBase ? storedBase.date : null }
      );
    }
  }
  return {
    date,
    index,
    price: bars[index].high,
    source
  };
}

function samePrice(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number' || !Number.isFinite(a) || !Number.isFinite(b)) {
    return false;
  }
  const scale = Math.max(1, Math.abs(b));
  return Math.abs(a - b) <= scale * 1e-9;
}

function parsePivotInput(input, { bars, dateIndexByDate, entryIndex, detections, baseStartDate }) {
  if (!input || typeof input !== 'object') {
    throw new SetupQualityInputError('pivot confirmation is required.');
  }
  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new SetupQualityInputError('pivot.price must be a positive finite number.');
  }
  const source = input.source;
  if (!CONFIRM_SOURCES.includes(source)) {
    throw new SetupQualityInputError(
      `pivot.source must be one of ${CONFIRM_SOURCES.join(', ')}.`,
      'INVALID_SOURCE'
    );
  }
  let index = null;
  let date = null;
  let detectionConfidence = null;
  if (source === 'detected_confirmed') {
    // Provenance is SERVER-VERIFIED: a confirmed pivot must match the machine
    // detection stored on this evaluation, derived from the SAME confirmed
    // Base Start. The confidence value always comes from the stored detection,
    // never from client input.
    const storedPivot = detections && detections.pivotDetection;
    if (!storedPivot) {
      throw new SetupQualityInputError(
        'No machine-detected Pivot is stored for this evaluation/evidence snapshot. Re-run Prepare or label the Pivot as user_adjusted.',
        'PIVOT_DETECTION_MISMATCH'
      );
    }
    if (!storedPivot.date) {
      throw new SetupQualityInputError('Stored Pivot detection has no session date.', 'PIVOT_DETECTION_MISMATCH');
    }
    if (input.date === undefined || input.date === null || input.date === '') {
      throw new SetupQualityInputError(
        'A confirmed pivot requires the detected session date.',
        'PIVOT_DATE_REQUIRED'
      );
    }
    date = parseDateOnly(input.date, 'pivot.date');
    if (date !== storedPivot.date) {
      throw new SetupQualityInputError(
        'Confirmed Pivot date must match the machine-detected Pivot session.',
        'PIVOT_DETECTION_MISMATCH',
        { submittedDate: date, detectedDate: storedPivot.date }
      );
    }
    if (storedPivot.baseStartDateUsed !== null && baseStartDate !== null && storedPivot.baseStartDateUsed !== baseStartDate) {
      throw new SetupQualityInputError(
        'The machine-detected Pivot was derived from a different Base Start. Confirm or adjust the Base Start first, re-run Prepare to re-detect the Pivot, or label the Pivot as user_adjusted.',
        'PIVOT_DETECTION_MISMATCH'
      );
    }
    if (!samePrice(price, storedPivot.price)) {
      throw new SetupQualityInputError(
        'Confirmed Pivot price must match the machine-detected Pivot price.',
        'PIVOT_DETECTION_MISMATCH',
        { submittedPrice: price, detectedPrice: storedPivot.price }
      );
    }
    if (!dateIndexByDate.has(date)) {
      throw new SetupQualityInputError(
        'pivot.date must be a trading session present in the available daily evidence.',
        'PIVOT_DATE_NOT_A_SESSION',
        { date }
      );
    }
    index = dateIndexByDate.get(date);
    if (entryIndex !== -1 && index >= entryIndex) {
      throw new SetupQualityInputError(
        'pivot.date must be a session inside the base, before the trade\'s initial entry session.',
        'PIVOT_AFTER_ENTRY',
        { date }
      );
    }
    detectionConfidence = storedPivot.confidence || storedPivot.detectionConfidence || null;
  } else {
    // user_adjusted: explicit user provenance; the session date is optional
    // (price is the adjusted value).
    if (input.date !== undefined && input.date !== null && input.date !== '') {
      date = parseDateOnly(input.date, 'pivot.date');
      if (!dateIndexByDate.has(date)) {
        throw new SetupQualityInputError(
          'pivot.date must be a trading session present in the available daily evidence.',
          'PIVOT_DATE_NOT_A_SESSION',
          { date }
        );
      }
      index = dateIndexByDate.get(date);
      if (entryIndex !== -1 && index >= entryIndex) {
        throw new SetupQualityInputError(
          'pivot.date must be a session inside the base, before the trade\'s initial entry session.',
          'PIVOT_AFTER_ENTRY',
          { date }
        );
      }
    }
    detectionConfidence = null;
  }
  return { price, date, index, source, detectionConfidence };
}

function parseLeaderInput(input) {
  if (typeof input !== 'boolean') {
    throw new SetupQualityInputError('leader_confirmed must be a boolean (true = Yes, false = No).');
  }
  return input;
}

function normalizeUserInputs(raw, context) {
  const leader_confirmed = parseLeaderInput(raw.leader_confirmed);
  const base_start = parseBaseStartInput(raw.base_start, context);
  const pivot = parsePivotInput(raw.pivot, { ...context, baseStartDate: base_start.date });
  return { leader_confirmed, base_start, pivot };
}

// ---------------------------------------------------------------------------
// Evaluate
// ---------------------------------------------------------------------------

function buildCriterionRows(setupConfig, setup, bars, userInputs) {
  const rows = [];
  for (const criterionConfig of enabledSetupCriteria(setupConfig)) {
    const fragment = evaluateCriterion(criterionConfig, {
      setup,
      bars,
      // The full normalized semantic-input object is part of the evaluator
      // context (spec section 56); each criterion reads only what it needs.
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
          throw new SetupQualityInputError(
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

/**
 * Evaluates and persists NON-TERMINAL Setup progress for a draft evaluation.
 */
async function evaluate(userId, tradeId, { evaluationId, userInputs: rawUserInputs }) {
  if (!evaluationId) {
    throw new SetupQualityInputError(
      'Run prepare() first; evaluationId is required.',
      'EVALUATION_REQUIRED'
    );
  }
  const evaluation = await getEvaluation(evaluationId, userId);
  if (!evaluation || String(evaluation.trade_id) !== String(tradeId)) {
    throw new SetupQualityInputError('Evaluation not found or not owned by this user/trade.', 'EVALUATION_NOT_FOUND');
  }
  if (TERMINAL_STATUSES.includes(evaluation.status)) {
    throw new SetupQualityInputError(
      'This evaluation is terminal and immutable. Create a new evaluation to re-run Setup Quality.',
      'EVALUATION_TERMINAL'
    );
  }
  if (!evaluation.profile_version_id) {
    throw new SetupQualityInputError('Evaluation has no profile version.', 'EVALUATION_NO_VERSION');
  }

  const trade = await getTradeForUser(userId, tradeId);
  if (!trade) {
    throw new SetupQualityInputError('Trade not found or not owned by this user.', 'TRADE_NOT_FOUND');
  }
  const entryDate = entrySessionDate(trade);
  if (!entryDate) {
    throw new SetupQualityInputError('Trade has no entry time.', 'TRADE_NO_ENTRY_TIME');
  }

  // Load the immutable profile-version configuration used by this evaluation.
  const db = require('../../config/database');
  const versionResult = await db.query(
    `
      SELECT v.id, v.version_number, v.schema_version, v.configuration, p.name AS profile_name, p.id AS profile_id
      FROM quality_profile_versions v
      JOIN quality_profiles p ON p.id = v.profile_id
      WHERE v.id = $1
        AND p.user_id = $2
    `,
    [evaluation.profile_version_id, userId]
  );
  if (versionResult.rows.length === 0) {
    throw new SetupQualityInputError('Profile version not found or not owned by this user.', 'VERSION_NOT_FOUND');
  }
  const version = versionResult.rows[0];
  const setupConfig = getSetupDimensionConfig(version.configuration);
  assertValidSetupConfiguration(setupConfig);

  if (!rawUserInputs || typeof rawUserInputs !== 'object') {
    throw new SetupQualityInputError('Semantic user inputs are required.', 'INPUT_REQUIRED');
  }

  // Fetch and snapshot the daily evidence actually used. The evaluation
  // reuses the evidence snapshot captured at prepare() when one exists (a
  // draft evaluation is reproducible from the exact evidence its detections
  // were based on; provider history cannot silently change between prepare and
  // evaluate). Only when no stored snapshot exists (e.g. an evaluate called
  // without a prior prepare) is fresh evidence fetched.
  const { fromDate, toDate } = evidenceWindowDates(entryDate, setupConfig);
  const rawStoredSnapshot = evaluation.evidence_snapshot;
  const storedSnapshot =
    typeof rawStoredSnapshot === 'string'
      ? (() => {
          try {
            return JSON.parse(rawStoredSnapshot);
          } catch (error) {
            return null;
          }
        })()
      : rawStoredSnapshot;
  let evidence;
  const snapshotBars =
    storedSnapshot && Array.isArray(storedSnapshot.bars) && storedSnapshot.bars.length > 0
      ? storedSnapshot.bars
      : null;
  // Only a VERIFIED stored snapshot is reused for scoring. An unverified
  // (cache-only) snapshot is provisional: evaluate() retries the provider chain
  // so a later provider recovery makes evaluation possible without cleanup.
  if (
    snapshotBars &&
    storedSnapshot.entrySessionDate === entryDate &&
    completenessFromSnapshot(storedSnapshot) === 'verified'
  ) {
    evidence = {
      bars: snapshotBars,
      source: storedSnapshot.source || 'stored_snapshot',
      completeness: 'verified',
      error: null
    };
  } else {
    evidence = await loadDailyEvidence({
      symbol: trade.symbol,
      userId,
      fromDate,
      toDate
    });
  }
  const bars = normalizeDailyBars(evidence.bars);
  if (bars.length === 0) {
    throw new SetupQualityInputError(
      `Daily market data is unavailable for ${trade.symbol}; Setup Quality cannot be evaluated.`,
      'EVIDENCE_UNAVAILABLE'
    );
  }
  // Evidence completeness must be VERIFIED (a provider session set backs the
  // bars). Unverified cache-only sessions cannot be treated as consecutive
  // trading sessions; Setup Quality must surface UNKNOWN instead of scoring
  // against fabricated adjacency.
  if (evidence.completeness !== 'verified') {
    throw new SetupQualityInputError(
      `Daily market data for ${trade.symbol} could not be verified against a market-data provider; ` +
        'Setup Quality cannot count trading sessions from unverified cache data.',
      'EVIDENCE_UNAVAILABLE'
    );
  }
  const dateIndexByDate = indexByDate(bars);
  const entryIndex = findEntrySessionIndex(bars, dateIndexByDate, entryDate);
  if (entryIndex === -1) {
    throw new SetupQualityInputError(
      `No daily bar is available for the trade entry session ${entryDate}; Setup Quality cannot be evaluated.`,
      'ENTRY_SESSION_UNAVAILABLE'
    );
  }

  // Server-verified detection context: the machine detections stored on this
  // evaluation under its exact evidence snapshot.
  const storedDetections = parseJsonField(evaluation.detected_context, 'detected_context');

  // Parse/validate semantic inputs against the available evidence and the
  // stored detection context (detected_confirmed values are server-verified).
  const userInputs = normalizeUserInputs(rawUserInputs, {
    bars,
    dateIndexByDate,
    entryIndex,
    detections: storedDetections
  });

  // Authoritative Setup boundary: first session after the confirmed Base Start
  // trading above the confirmed Pivot (bounded by the initial entry session).
  const boundary = resolveSetupBoundary({
    bars,
    baseStartIndex: userInputs.base_start.index,
    pivotPrice: userInputs.pivot.price,
    upperBoundIndex: entryIndex
  });
  if (!boundary) {
    throw new SetupQualityInputError(
      'No session traded above the confirmed Pivot between the confirmed Base Start and the trade entry session. Adjust the Base Start and/or Pivot so the setup resolves before the entry.',
      'NO_RESOLUTION_SESSION',
      {
        baseStartDate: userInputs.base_start.date,
        pivotPrice: userInputs.pivot.price,
        entrySessionDate: entryDate
      }
    );
  }

  const baseEndIndex = boundary.baseEndIndex;
  const setup = {
    baseStart: {
      index: userInputs.base_start.index,
      date: userInputs.base_start.date,
      price: userInputs.base_start.price,
      source: userInputs.base_start.source
    },
    pivot: {
      index: userInputs.pivot.index,
      date: userInputs.pivot.date,
      price: userInputs.pivot.price,
      source: userInputs.pivot.source,
      detectionConfidence: userInputs.pivot.detectionConfidence
    },
    resolution: {
      index: boundary.resolutionIndex,
      date: bars[boundary.resolutionIndex].date
    },
    baseEnd: {
      index: baseEndIndex,
      date: bars[baseEndIndex].date
    },
    entrySession: {
      index: entryIndex,
      date: entryDate
    }
  };

  const criterionRows = buildCriterionRows(setupConfig, setup, bars, userInputs);

  const setupBoundary = {
    baseStartDate: setup.baseStart.date,
    resolutionDate: setup.resolution.date,
    baseEndDate: setup.baseEnd.date
  };

  const detectedContext = {
    ...(storedDetections || {}),
    version: 2,
    evaluatedAt: new Date().toISOString(),
    confirmations: {
      base_start: { date: setup.baseStart.date, source: setup.baseStart.source },
      pivot: {
        price: setup.pivot.price,
        date: setup.pivot.date,
        source: setup.pivot.source,
        detectionConfidence: userInputs.pivot.detectionConfidence
      }
    },
    boundary: {
      method: 'first_daily_high_above_confirmed_pivot',
      baseStartDate: setup.baseStart.date,
      baseStartSource: setup.baseStart.source,
      pivotPrice: setup.pivot.price,
      pivotSource: setup.pivot.source,
      detectionConfidence: userInputs.pivot.detectionConfidence,
      resolutionDate: setup.resolution.date,
      baseEndDate: setup.baseEnd.date,
      entrySessionDate: entryDate,
      upperBoundDate: bars[entryIndex].date
    }
  };

  const evidenceSnapshot = buildEvidenceSnapshot({
    trade,
    evidence,
    entryDate,
    bars,
    fromDate,
    toDate,
    boundary: setupBoundary
  });

  const storedUserInputs = {
    leader_confirmed: userInputs.leader_confirmed,
    base_start: { date: userInputs.base_start.date, source: userInputs.base_start.source },
    pivot: {
      price: userInputs.pivot.price,
      date: userInputs.pivot.date,
      source: userInputs.pivot.source,
      detectionConfidence: userInputs.pivot.detectionConfidence
    }
  };

  const updated = await saveSetupProgress(evaluationId, userId, {
    setupResults: { criterionResults: criterionRows },
    evidenceSnapshot,
    userInputs: storedUserInputs,
    detectedContext
  });
  if (!updated) {
    throw new SetupQualityInputError(
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
    setup: {
      baseStart: setup.baseStart,
      pivot: setup.pivot,
      resolution: setup.resolution,
      baseEnd: setup.baseEnd
    }
  };
}

/**
 * Lists evaluations for a trade (newest first), including the profile name and
 * version number for display.
 */
async function listEvaluations(userId, tradeId) {
  const db = require('../../config/database');
  const result = await db.query(
    `
      SELECT ${EVALUATION_COLUMNS
        .split(',')
        .map((column) => `e.${column.trim()}`)
        .join(', ')},
        v.version_number, v.schema_version, p.name AS profile_name
      FROM trade_quality_evaluations e
      JOIN quality_profile_versions v ON v.id = e.profile_version_id
      JOIN quality_profiles p ON p.id = v.profile_id
      WHERE e.user_id = $1 AND e.trade_id = $2
      ORDER BY e.created_at DESC, e.id DESC
    `,
    [userId, tradeId]
  );
  return result.rows.map(toFrontendEvaluation);
}

module.exports = {
  SetupQualityInputError,
  prepare,
  evaluate,
  listEvaluations,
  // exposed for tests
  entrySessionDate,
  findEntrySessionIndex,
  proposeDetections,
  enabledSetupCriteria,
  assertValidSetupConfiguration,
  parseConfirmedBaseStartInput,
  parseBaseStartInput,
  parsePivotInput,
  normalizeUserInputs,
  buildCriterionRows,
  resolveProfileAndVersion,
  evidenceWindowDates,
  toFrontendEvaluation,
  findEvaluationForPrepare,
  parseJsonField,
  snapshotIsUsable,
  completenessFromSnapshot,
  getTradeForUser
};
