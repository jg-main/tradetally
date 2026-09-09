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
const { normalizeDailyBars, indexByDate, addCalendarDays } = require('./dailyEvidence');
const { detectBaseStart } = require('./detectors/baseStart');
const { detectPivot } = require('./detectors/pivot');
const { resolveSetupBoundary } = require('./detectors/setupBoundary');
const { evaluateCriterion } = require('./criterionRegistry');
const { getDateInTimezone } = require('../../utils/timezone');

// Calendar days of daily history requested before the trade's initial entry
// session. Trading-session durations are always counted from actual bars; this
// constant only sizes the fetch window (roughly 280 trading sessions), enough
// for a 60-session Base Start search, a 60-session Prior Move lookback before
// the Base Start, SMA history, and detector left/right windows with margin.
const HISTORY_CALENDAR_DAYS = 400;
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

function evidenceWindowDates(entryDate) {
  const fromDate = addCalendarDays(entryDate, -HISTORY_CALENDAR_DAYS);
  const toDate = addCalendarDays(entryDate, POST_ENTRY_CALENDAR_DAYS);
  return { fromDate, toDate };
}

// ---------------------------------------------------------------------------
// Detection proposals (prepare)
// ---------------------------------------------------------------------------

// Estimates the session BEFORE the final sustained upward run ending near the
// entry. A Canonical BO base ends quietly (D-1); the breakout starts the final
// run, whose session highs keep printing near their trailing highs. Walking
// backward from the session before the entry, run sessions stay within a small
// tolerance of the immediately following high; the session before that run is
// the provisional base end (D-1 proxy). This is a PROPOSAL-only heuristic: it
// keeps post-breakout bars from contaminating the proposed Base Start/Pivot of
// a late entry. It returns the provisional base end index or null when no
// meaningful run boundary is found (the search stays bounded by the entry).
function estimateProvisionalBaseEnd(bars, entryIndex, provisionalEndIndex) {
  if (provisionalEndIndex < 2) return null;
  const end = provisionalEndIndex;
  if (!(bars[end].high > 0)) return null;
  let runStart = end;
  for (let i = end - 1; i >= 0; i -= 1) {
    const nextHigh = bars[i + 1].high;
    if (!(nextHigh > 0) || !(bars[i].high > 0)) break;
    if (bars[i].high >= nextHigh * 0.97) {
      runStart = i;
    } else {
      break;
    }
  }
  // A run must be at least a few sessions to be meaningful, and the base-end
  // proxy must be strictly inside the search horizon to matter.
  if (runStart >= end || runStart < 2) return null;
  const proxy = runStart - 1;
  if (proxy < 0 || proxy >= provisionalEndIndex) return null;
  return proxy;
}

function proposeDetections(bars, dateIndexByDate, entryIndex, setupConfig) {
  const provisionalBaseEndIndex = entryIndex - 1;
  const baseParams = baseStartParameters(setupConfig);
  const pivotParams = pivotParameters(setupConfig);

  if (provisionalBaseEndIndex < 0) {
    return {
      provisionalBaseEndIndex,
      baseStart: null,
      pivot: null,
      detectionEvidence: { baseStart: null, pivot: null }
    };
  }

  // Proposal search bound. For a late entry the session before the final run
  // is a much better D-1 proxy than the session before the entry itself: the
  // recent-touch window of the pivot cluster and the Base Start qualification
  // window then never see post-breakout bars.
  const runBaseEnd = estimateProvisionalBaseEnd(bars, entryIndex, provisionalBaseEndIndex);
  let detectionEndIndex = runBaseEnd === null ? provisionalBaseEndIndex : runBaseEnd;

  // Stage 1 — propose a pivot over the (post-breakout-free) proposal bound.
  const firstPassBaseStart = detectBaseStart({
    bars,
    endIndex: detectionEndIndex,
    parameters: baseParams
  });
  const stage1LowerBound = firstPassBaseStart
    ? firstPassBaseStart.index
    : Math.max(0, detectionEndIndex - (baseParams.detection_lookback || 60));
  const stage1Pivot = detectPivot({
    bars,
    rangeStartIndex: stage1LowerBound,
    rangeEndIndex: detectionEndIndex,
    parameters: pivotParams
  });

  // Stage 2 — when a pivot proposal exists, resolve the breakout session D
  // exactly. If price resolved above the pivot before the current bound, the
  // base truly ended at D-1; re-run both detections bounded by that real D-1.
  if (stage1Pivot) {
    const boundaryLowerBound = firstPassBaseStart ? firstPassBaseStart.index : stage1LowerBound;
    const boundary = resolveSetupBoundary({
      bars,
      baseStartIndex: boundaryLowerBound,
      pivotPrice: stage1Pivot.pivot.price,
      upperBoundIndex: entryIndex
    });
    if (
      boundary &&
      boundary.resolutionIndex > boundaryLowerBound &&
      boundary.baseEndIndex >= boundaryLowerBound &&
      boundary.baseEndIndex < detectionEndIndex
    ) {
      detectionEndIndex = boundary.baseEndIndex;
    }
  }

  const baseStartResult = detectBaseStart({
    bars,
    endIndex: detectionEndIndex,
    parameters: baseParams
  });

  let pivotResult = null;
  if (baseStartResult) {
    pivotResult = detectPivot({
      bars,
      rangeStartIndex: baseStartResult.index,
      rangeEndIndex: detectionEndIndex,
      parameters: pivotParams
    });
  }
  // Only fall back to the stage-1 pivot when the base search stayed on the
  // same proposal bound (no earlier boundary refinement happened).
  if (!pivotResult && detectionEndIndex === (runBaseEnd === null ? provisionalBaseEndIndex : runBaseEnd)) {
    pivotResult = stage1Pivot;
  }

  return {
    provisionalBaseEndIndex: detectionEndIndex,
    baseStart: baseStartResult
      ? {
          index: baseStartResult.index,
          date: baseStartResult.date,
          price: baseStartResult.price,
          source: 'detected'
        }
      : null,
    pivot: pivotResult
      ? {
          index: pivotResult.pivot.index,
          date: pivotResult.pivot.date,
          price: pivotResult.pivot.price,
          confidence: pivotResult.confidence,
          method: pivotResult.method,
          source: 'detected'
        }
      : null,
    detectionEvidence: {
      baseStart: baseStartResult
        ? {
            candidateCount: baseStartResult.candidateCount,
            allowancePct: baseStartResult.allowancePct,
            lookbackStartDate: bars[baseStartResult.lookbackStartIndex].date,
            searchEndDate: bars[detectionEndIndex].date
          }
        : null,
      pivot: pivotResult ? pivotResult.evidence : null
    }
  };
}

// Finds an existing non-terminal draft evaluation for a trade + profile
// version, preferring one that still has no persisted results (so re-running
// prepare refreshes its detection context without clobbering a completed
// Setup run's evidence snapshot).
async function findOrCreateDraftEvaluation(userId, tradeId, profileVersionId) {
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
  if (existing.rows.length > 0) {
    return existing.rows[0];
  }
  return createEvaluation(userId, tradeId, profileVersionId);
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

async function persistDraftDetectionContext(evaluation, userId, payload) {
  const db = require('../../config/database');
  // Only refresh a draft that has not yet persisted Setup results, so the
  // evidence snapshot that backs existing results is never clobbered by a
  // later prepare rerun.
  if (evaluation.results && typeof evaluation.results === 'string' && evaluation.results !== 'null') {
    return evaluation;
  }
  if (evaluation.results && typeof evaluation.results === 'object') {
    return evaluation;
  }
  const updated = await db.query(
    `
      UPDATE trade_quality_evaluations
      SET evidence_snapshot = $3, detected_context = $4
      WHERE id = $1 AND user_id = $2
        AND status NOT IN ('completed', 'insufficient_data')
      RETURNING ${EVALUATION_COLUMNS}
    `,
    [evaluation.id, userId, payload.evidenceSnapshot, payload.detectedContext]
  );
  return updated.rows[0] || evaluation;
}

/**
 * Prepares a Setup Quality evaluation for a trade: resolves the profile
 * version, loads daily evidence, proposes Base Start/Pivot detections, and
 * returns the draft evaluation id plus required semantic inputs.
 */
async function prepare(userId, tradeId, { profileId } = {}) {
  const trade = await getTradeForUser(userId, tradeId);
  if (!trade) {
    throw new SetupQualityInputError('Trade not found or not owned by this user.', 'TRADE_NOT_FOUND');
  }
  const entryDate = entrySessionDate(trade);
  if (!entryDate) {
    throw new SetupQualityInputError('Trade has no entry time; Setup Quality cannot be prepared.', 'TRADE_NO_ENTRY_TIME');
  }

  const { profile, version } = await resolveProfileAndVersion(userId, { profileId });
  const setupConfig = getSetupDimensionConfig(version.configuration);

  const { fromDate, toDate } = evidenceWindowDates(entryDate);
  const evidence = await loadDailyEvidence({
    symbol: trade.symbol,
    userId,
    fromDate,
    toDate
  });

  const bars = normalizeDailyBars(evidence.bars);
  const dateIndexByDate = indexByDate(bars);
  const entryIndex = findEntrySessionIndex(bars, dateIndexByDate, entryDate);

  const unavailableEvidence = [];
  if (!evidence.bars || evidence.bars.length === 0) {
    unavailableEvidence.push('daily_ohlcv');
  }
  if (entryIndex === -1) {
    unavailableEvidence.push('entry_session_bar');
  }

  let detections = null;
  if (bars.length > 0 && entryIndex > 0) {
    detections = proposeDetections(bars, dateIndexByDate, entryIndex, setupConfig);
  }

  const detectedContext = {
    version: 1,
    preparedAt: new Date().toISOString(),
    entrySessionDate: entryDate,
    provisionalBaseEndDate:
      detections && detections.provisionalBaseEndIndex >= 0
        ? bars[detections.provisionalBaseEndIndex].date
        : null,
    baseStart: detections ? detections.baseStart : null,
    pivot: detections ? detections.pivot : null,
    detectionEvidence: detections ? detections.detectionEvidence : null
  };

  const evidenceSnapshot = {
    symbol: String(trade.symbol || '').toUpperCase(),
    resolution: 'daily',
    requestedWindow: { fromDate, toDate },
    source: evidence.source,
    sessionCount: bars.length,
    firstDate: bars.length > 0 ? bars[0].date : null,
    lastDate: bars.length > 0 ? bars[bars.length - 1].date : null,
    entrySessionDate: entryDate,
    bars
  };

  const evaluation = await findOrCreateDraftEvaluation(userId, tradeId, version.id);
  const refreshed = await persistDraftDetectionContext(evaluation, userId, {
    evidenceSnapshot,
    detectedContext
  });

  return {
    evaluation: toFrontendEvaluation(refreshed),
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
          method: detections.pivot.method
        }
      : null,
    evidence: {
      symbol: String(trade.symbol || '').toUpperCase(),
      source: evidence.source,
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

function parseBaseStartInput(input, { bars, dateIndexByDate, entryIndex }) {
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
  return {
    date,
    index,
    price: bars[index].high,
    source
  };
}

function parsePivotInput(input, { bars, dateIndexByDate, entryIndex }) {
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
    if (entryIndex !== -1 && index > entryIndex) {
      throw new SetupQualityInputError(
        'pivot.date cannot be after the trade\'s initial entry session.',
        'PIVOT_AFTER_ENTRY',
        { date }
      );
    }
  } else if (source === 'detected_confirmed') {
    // Confirming a machine-detected pivot implies anchoring it to the detected
    // session; a date-less pivot can only arrive through an explicit user
    // adjustment (source = user_adjusted).
    throw new SetupQualityInputError(
      'A confirmed pivot requires the detected session date.',
      'PIVOT_DATE_REQUIRED'
    );
  }
  const detectionConfidence =
    typeof input.detectionConfidence === 'string' ? input.detectionConfidence : null;
  return { price, date, index, source, detectionConfidence };
}

function parseLeaderInput(input) {
  if (typeof input !== 'boolean') {
    throw new SetupQualityInputError('leader_confirmed must be a boolean (true = Yes, false = No).');
  }
  return input;
}

function normalizeUserInputs(raw, context) {
  return {
    leader_confirmed: parseLeaderInput(raw.leader_confirmed),
    base_start: parseBaseStartInput(raw.base_start, context),
    pivot: parsePivotInput(raw.pivot, context)
  };
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

  if (!rawUserInputs || typeof rawUserInputs !== 'object') {
    throw new SetupQualityInputError('Semantic user inputs are required.', 'INPUT_REQUIRED');
  }

  // Fetch and snapshot the daily evidence actually used. The evaluation
  // reuses the evidence snapshot captured at prepare() when one exists (a
  // draft evaluation is reproducible from the exact evidence its detections
  // were based on; provider history cannot silently change between prepare and
  // evaluate). Only when no stored snapshot exists (e.g. an evaluate called
  // without a prior prepare) is fresh evidence fetched.
  const { fromDate, toDate } = evidenceWindowDates(entryDate);
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
  if (snapshotBars && storedSnapshot.entrySessionDate === entryDate) {
    evidence = {
      bars: snapshotBars,
      source: storedSnapshot.source || 'stored_snapshot',
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
  const dateIndexByDate = indexByDate(bars);
  const entryIndex = findEntrySessionIndex(bars, dateIndexByDate, entryDate);
  if (entryIndex === -1) {
    throw new SetupQualityInputError(
      `No daily bar is available for the trade entry session ${entryDate}; Setup Quality cannot be evaluated.`,
      'ENTRY_SESSION_UNAVAILABLE'
    );
  }

  // Parse/validate semantic inputs against the available evidence.
  const userInputs = normalizeUserInputs(rawUserInputs, {
    bars,
    dateIndexByDate,
    entryIndex
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

  const detectedContext = {
    version: 1,
    evaluatedAt: new Date().toISOString(),
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
    },
    priorDetection: evaluation.detected_context || null
  };

  const evidenceSnapshot = {
    symbol: String(trade.symbol || '').toUpperCase(),
    resolution: 'daily',
    requestedWindow: { fromDate, toDate },
    source: evidence.source,
    sessionCount: bars.length,
    firstDate: bars[0].date,
    lastDate: bars[bars.length - 1].date,
    entrySessionDate: entryDate,
    setupBoundary: {
      baseStartDate: setup.baseStart.date,
      resolutionDate: setup.resolution.date,
      baseEndDate: setup.baseEnd.date
    },
    bars
  };

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
  parseBaseStartInput,
  parsePivotInput,
  normalizeUserInputs,
  buildCriterionRows,
  resolveProfileAndVersion,
  evidenceWindowDates,
  toFrontendEvaluation,
  findOrCreateDraftEvaluation,
  getTradeForUser
};
