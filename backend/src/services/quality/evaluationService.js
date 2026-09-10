'use strict';

// Trade Quality Evaluation persistence service (spec section 5.3).
//
// An evaluation links a trade to the exact immutable profile version that
// produced it and stores the evidence snapshot, detected context, semantic
// user inputs, and per-dimension results used at evaluation time.
//
// Lifecycle invariants (Phase 1 final hardening):
//   - Evaluations are created as `draft` only. Terminal statuses
//     (`completed` / `insufficient_data`) are produced exclusively through
//     saveResult(), which validates the terminal payload against the
//     evaluation's immutable profile-version configuration before persisting.
//   - Both terminal statuses are immutable: once an evaluation is `completed`
//     or `insufficient_data`, saveResult() cannot rewrite, upgrade, or replace
//     it; a later attempt must create a NEW trade_quality_evaluations row.
//     Draft and future `needs_input` rows remain mutable pre-terminal states.
//   - createEvaluation() atomically enforces ownership: the trade must belong
//     to the user and the profile version must belong to a Quality Profile
//     owned by the same user.
//   - The persisted completed snapshot is NORMALIZED from the immutable
//     profile-version configuration: every PASS/FAIL criterion score is
//     derived from (or validated against) the criterion's `scoring` envelope
//     plus its normalized `scoring_value`, and per-dimension summaries are
//     recomputed by the aggregation engine. Caller-supplied aggregates are
//     not trusted.

const db = require('../../config/database');
const { CRITERION_STATUS, EVALUATION_STATUS } = require('./constants');
const { aggregateDimension } = require('./aggregation');
const { deriveScoreForCriterion } = require('./scoring');
const { setupDependencyFingerprint } = require('./dependencyFingerprint');
const {
  applyDownstreamState,
  nextContextRevision,
  SETUP_CONTEXT_REVISION_KEY,
  SETUP_DEPENDENCY_FINGERPRINT_KEY
} = require('./downstreamState');

const EVALUATION_COLUMNS = `
  id, user_id, trade_id, profile_version_id, status,
  setup_score, setup_grade, setup_compliance, setup_coverage,
  entry_score, entry_grade, entry_compliance, entry_coverage,
  management_score, management_grade, management_compliance, management_coverage,
  user_inputs, detected_context, evidence_snapshot, results,
  evaluated_at, created_at
`;

const DIMENSION_SUMMARY_KEYS = ['setup', 'entry', 'management'];

const TERMINAL_STATUS_SQL = "e.status NOT IN ('completed', 'insufficient_data')";

// Mirrors the dimension result summaries returned by the aggregation engine
// into the flat queryable columns on trade_quality_evaluations.
function summariesFromResults(results) {
  const summaries = {};
  for (const dimension of DIMENSION_SUMMARY_KEYS) {
    const dim = results && results[dimension] ? results[dimension] : null;
    summaries[`${dimension}_score`] = dim && typeof dim.score === 'number' ? dim.score : null;
    summaries[`${dimension}_grade`] = dim && typeof dim.grade === 'string' ? dim.grade : null;
    summaries[`${dimension}_compliance`] =
      dim && typeof dim.compliance === 'string' ? dim.compliance : null;
    summaries[`${dimension}_coverage`] =
      dim && typeof dim.coverage === 'number' ? dim.coverage : null;
  }
  return summaries;
}

function sameNullableNumber(a, b) {
  if (a === null || a === undefined) {
    return b === null || b === undefined;
  }
  return typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 1e-9;
}

// Normalizes the caller-supplied criterion rows for one dimension against the
// immutable dimension configuration:
//   - rejects rows whose key is not an enabled configured criterion;
//   - rejects duplicate keys;
//   - derives PASS/FAIL scores from the criterion `scoring` envelope and the
//     row `scoring_value`, rejecting scores that contradict the profile
//     scoring configuration;
//   - requires UNKNOWN/NOT_APPLICABLE rows to carry no numeric score;
//   - preserves raw_value / scoring_value / evidence / message.
// Omitted enabled criteria are left for the aggregation engine to normalize
// to UNKNOWN.
function normalizeCriterionRows(dimension, dimensionConfig, dimResult) {
  if (dimResult === null || typeof dimResult !== 'object' || Array.isArray(dimResult)) {
    throw new Error(`completed results for dimension "${dimension}" must be an object`);
  }
  if (!Array.isArray(dimResult.criterionResults)) {
    throw new Error(`completed results for dimension "${dimension}" require criterionResults`);
  }

  const enabledCriteria = dimensionConfig.criteria.filter(
    (criterion) => criterion.enabled === undefined || criterion.enabled === true
  );
  const enabledByKey = new Map(enabledCriteria.map((criterion) => [criterion.key, criterion]));
  const seen = new Set();
  const rows = [];

  for (const entry of dimResult.criterionResults) {
    if (entry === null || typeof entry !== 'object') {
      throw new Error(`criterion results for dimension "${dimension}" must be objects`);
    }
    const configured = enabledByKey.get(entry.key);
    if (!configured) {
      throw new Error(
        `criterion result key "${entry.key}" is not an enabled criterion of dimension "${dimension}"`
      );
    }
    if (seen.has(entry.key)) {
      throw new Error(`duplicate criterion result for "${entry.key}" in dimension "${dimension}"`);
    }
    seen.add(entry.key);

    let normalizedScore;
    let scoringValue;
    if (Object.prototype.hasOwnProperty.call(entry, 'scoring_value')) {
      scoringValue = entry.scoring_value ?? null;
    } else if (Object.prototype.hasOwnProperty.call(entry, 'scoringValue')) {
      scoringValue = entry.scoringValue ?? null;
    } else {
      scoringValue = null;
    }

    if (entry.status === CRITERION_STATUS.PASS || entry.status === CRITERION_STATUS.FAIL) {
      if (configured.weight > 0) {
        // Positive-weight criteria always carry a profile-derived score. The
        // score must be present and equal to what the immutable scoring
        // envelope derives from scoring_value.
        if (entry.score === null || entry.score === undefined) {
          throw new Error(
            `criterion "${entry.key}" has positive weight and requires a numeric score derived from its profile scoring configuration`
          );
        }
        if (!configured.scoring) {
          throw new Error(`criterion "${entry.key}" has positive weight but no scoring configuration`);
        }
        const derived = deriveScoreForCriterion({
          status: entry.status,
          scoring: configured.scoring,
          scoringValue
        });
        if (derived.error) {
          throw new Error(`criterion "${entry.key}" in dimension "${dimension}": ${derived.error}`);
        }
        if (!sameNullableNumber(derived.score, entry.score)) {
          throw new Error(
            `criterion "${entry.key}" in dimension "${dimension}": score contradicts its profile scoring configuration`
          );
        }
        normalizedScore = derived.score;
      } else {
        // Zero-weight enabled criteria are compliance/evidence-only: the
        // score is optional (null allowed) and, when present, must be a
        // finite number in 0..100.
        if (
          entry.score !== null &&
          entry.score !== undefined &&
          !(typeof entry.score === 'number' && Number.isFinite(entry.score) && entry.score >= 0 && entry.score <= 100)
        ) {
          throw new Error(`criterion "${entry.key}" score must be a number between 0 and 100 or null`);
        }
        normalizedScore = entry.score ?? null;
      }
    } else {
      if (entry.score !== null && entry.score !== undefined) {
        throw new Error(`criterion "${entry.key}" with status ${entry.status} must not carry a quality score`);
      }
      normalizedScore = null;
    }

    rows.push({
      key: entry.key,
      status: entry.status,
      score: normalizedScore,
      scoring_value: scoringValue,
      raw_value: entry.raw_value ?? entry.rawValue ?? null,
      evidence: entry.evidence ?? null,
      message: entry.message ?? null
    });
  }
  return rows;
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

function assertTerminalStatus(status) {
  if (status !== EVALUATION_STATUS.COMPLETED && status !== EVALUATION_STATUS.INSUFFICIENT_DATA) {
    throw new Error('saveResult only accepts terminal statuses completed or insufficient_data');
  }
}

// Creates a new evaluation row in `draft` state only. The INSERT atomically
// enforces that the trade belongs to `userId` and that the profile version
// belongs to a Quality Profile owned by the same user, so a user can never
// link an evaluation to another user's trade or profile version.
async function createEvaluation(userId, tradeId, profileVersionId, data = {}) {
  if (data.status !== undefined && data.status !== null && data.status !== EVALUATION_STATUS.DRAFT) {
    throw new Error(
      `evaluations must be created as draft; status "${data.status}" can only be produced by saveResult`
    );
  }

  const result = await db.query(
    `
      INSERT INTO trade_quality_evaluations (
        user_id, trade_id, profile_version_id, status,
        user_inputs, detected_context, evidence_snapshot, results
      )
      SELECT $1, t.id, v.id, 'draft', $4, $5, $6, NULL::jsonb
      FROM trades t
      JOIN quality_profile_versions v ON v.id = $3
      JOIN quality_profiles p ON p.id = v.profile_id
      WHERE t.id = $2
        AND t.user_id = $1
        AND p.user_id = $1
      RETURNING ${EVALUATION_COLUMNS}
    `,
    [
      userId,
      tradeId,
      profileVersionId,
      data.userInputs ?? null,
      data.detectedContext ?? null,
      data.evidenceSnapshot ?? null
    ]
  );

  if (result.rows.length === 0) {
    throw new Error('trade or profile version not found for this user');
  }
  return result.rows[0];
}

// Persists a terminal result for an evaluation. Once the evaluation reaches a
// terminal status (`completed` or `insufficient_data`) it is immutable: a
// later attempt must create a new evaluation row.
//
// `completed`: every dimension supplied must cover exactly the configured
// dimensions; per-criterion PASS/FAIL scores are derived from/validated
// against the immutable profile-version scoring configuration and the
// normalized aggregate is recomputed by the aggregation engine; flat summary
// columns derive from the recomputed aggregate; the persisted results JSONB
// is the normalized aggregate (raw evidence/scoring values preserved).
//
// `insufficient_data`: no completed dimension results may be attached.
async function saveResult(evaluationId, userId, data) {
  assertTerminalStatus(data.status);

  const lookup = await db.query(
    `
      SELECT e.id, e.status, v.configuration
      FROM trade_quality_evaluations e
      JOIN quality_profile_versions v ON v.id = e.profile_version_id
      JOIN quality_profiles p ON p.id = v.profile_id
      WHERE e.id = $1
        AND e.user_id = $2
        AND p.user_id = $2
        AND ${TERMINAL_STATUS_SQL}
    `,
    [evaluationId, userId]
  );

  if (lookup.rows.length === 0) {
    return null;
  }
  const configuration = lookup.rows[0].configuration;

  let persistedResults = null;
  let summaries = summariesFromResults(null);

  if (data.status === EVALUATION_STATUS.INSUFFICIENT_DATA) {
    if (data.results !== undefined && data.results !== null) {
      throw new Error('insufficient_data evaluations cannot carry completed dimension results');
    }
  } else if (data.status === EVALUATION_STATUS.COMPLETED) {
    const results = data.results;
    if (results === null || typeof results !== 'object' || Array.isArray(results)) {
      throw new Error('completed evaluations require a per-dimension results object');
    }

    const configuredDimensions = Object.keys(configuration.dimensions).sort();
    const suppliedDimensions = Object.keys(results).sort();
    if (configuredDimensions.length !== suppliedDimensions.length ||
        configuredDimensions.some((dimension, index) => dimension !== suppliedDimensions[index])) {
      throw new Error(
        `completed results must cover exactly the configured dimensions (${configuredDimensions.join(', ')})`
      );
    }

    // Normalize + validate each dimension from the immutable configuration,
    // then recompute the authoritative aggregate.
    const normalizedResults = {};
    for (const dimension of configuredDimensions) {
      const rows = normalizeCriterionRows(dimension, configuration.dimensions[dimension], results[dimension]);
      const recomputed = aggregateDimension(configuration.dimensions[dimension], rows);

      const supplied = results[dimension];
      if (supplied.score !== undefined && !sameNullableNumber(supplied.score, recomputed.score)) {
        throw new Error(
          `invalid completed results for dimension "${dimension}": score contradicts the profile version configuration`
        );
      }
      if (supplied.grade !== undefined && supplied.grade !== recomputed.grade) {
        throw new Error(
          `invalid completed results for dimension "${dimension}": grade contradicts the profile version configuration`
        );
      }
      if (supplied.compliance !== undefined && supplied.compliance !== recomputed.compliance) {
        throw new Error(
          `invalid completed results for dimension "${dimension}": compliance contradicts the profile version configuration`
        );
      }
      if (supplied.coverage !== undefined && !sameNullableNumber(supplied.coverage, recomputed.coverage)) {
        throw new Error(
          `invalid completed results for dimension "${dimension}": coverage contradicts the profile version configuration`
        );
      }

      normalizedResults[dimension] = recomputed;
    }

    summaries = summariesFromResults(normalizedResults);
    persistedResults = normalizedResults;
  }

  const updated = await db.query(
    `
      UPDATE trade_quality_evaluations
      SET
        status = $3,
        results = $4,
        evidence_snapshot = COALESCE($5, evidence_snapshot),
        user_inputs = COALESCE($6, user_inputs),
        detected_context = COALESCE($7, detected_context),
        setup_score = $8,
        setup_grade = $9,
        setup_compliance = $10,
        setup_coverage = $11,
        entry_score = $12,
        entry_grade = $13,
        entry_compliance = $14,
        entry_coverage = $15,
        management_score = $16,
        management_grade = $17,
        management_compliance = $18,
        management_coverage = $19,
        evaluated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND user_id = $2
        AND status NOT IN ('completed', 'insufficient_data')
      RETURNING ${EVALUATION_COLUMNS}
    `,
    [
      evaluationId,
      userId,
      data.status,
      persistedResults,
      data.evidenceSnapshot ?? null,
      data.userInputs ?? null,
      data.detectedContext ?? null,
      summaries.setup_score,
      summaries.setup_grade,
      summaries.setup_compliance,
      summaries.setup_coverage,
      summaries.entry_score,
      summaries.entry_grade,
      summaries.entry_compliance,
      summaries.entry_coverage,
      summaries.management_score,
      summaries.management_grade,
      summaries.management_compliance,
      summaries.management_coverage
    ]
  );
  return updated.rows[0] || null;
}

async function getEvaluation(evaluationId, userId) {
  const result = await db.query(
    `
      SELECT ${EVALUATION_COLUMNS}
      FROM trade_quality_evaluations
      WHERE id = $1 AND user_id = $2
    `,
    [evaluationId, userId]
  );
  return result.rows[0] || null;
}

// Persists NON-TERMINAL Setup evaluation progress for a draft evaluation
// (Phase 2 Setup Quality workflow).
//
// Phase 2 evaluates and persists the Setup dimension only. Canonical BO also
// contains Entry and Management dimensions that are not implemented yet, so an
// evaluation must NOT be marked `completed` in Phase 2: no Entry/Management
// results are fabricated and terminal saveResult() is never called with dummy
// dimensions. This method stores the Setup dimension aggregate plus the exact
// evidence/user-input snapshot on a still-mutable draft row.
//
// Contract:
//   - the evaluation must exist, belong to `userId`, link to a profile version
//     owned by the same user, and be NON-TERMINAL (draft/needs_input). Terminal
//     (`completed` / `insufficient_data`) immutability from Phase 1 is never
//     weakened: a terminal row returns null and the caller must create a new
//     evaluation.
//   - setupResults.criterionResults are normalized against the immutable
//     profile-version setup configuration: PASS/FAIL scores are derived from
//     (or validated against) the configured `scoring` envelopes, and the
//     authoritative Setup aggregate is recomputed by the aggregation engine.
//   - results JSONB is stored as { setup: <recomputed aggregate>, entry: null,
//     management: null } — Entry/Management are explicit null because they are
//     not evaluated in Phase 2; nothing is fabricated to satisfy a
//     completed-dimension contract.
//   - the row stays mutable so later Base/Pivot confirmation adjustments can
//     re-run evaluate() and update the same draft.
async function saveSetupProgress(evaluationId, userId, data = {}) {
  const lookup = await db.query(
    `
      SELECT e.id, e.status, e.profile_version_id, e.results, e.detected_context,
             e.evidence_snapshot, e.user_inputs, v.configuration
      FROM trade_quality_evaluations e
      JOIN quality_profile_versions v ON v.id = e.profile_version_id
      JOIN quality_profiles p ON p.id = v.profile_id
      WHERE e.id = $1
        AND e.user_id = $2
        AND p.user_id = $2
        AND ${TERMINAL_STATUS_SQL}
    `,
    [evaluationId, userId]
  );

  if (lookup.rows.length === 0) {
    return null;
  }
  const configuration = lookup.rows[0].configuration;
  if (
    configuration === null ||
    typeof configuration !== 'object' ||
    !configuration.dimensions ||
    !configuration.dimensions.setup
  ) {
    throw new Error('profile version configuration has no setup dimension');
  }
  const setupConfig = configuration.dimensions.setup;

  const setupResults = data.setupResults;
  if (setupResults === null || typeof setupResults !== 'object' || Array.isArray(setupResults)) {
    throw new Error('setup progress requires a setupResults object with criterionResults');
  }
  const dimResult = { criterionResults: setupResults.criterionResults || [] };
  const rows = normalizeCriterionRows('setup', setupConfig, dimResult);
  const recomputed = aggregateDimension(setupConfig, rows);

  const detectedContextInput =
    data.detectedContext && typeof data.detectedContext === 'object'
      ? data.detectedContext
      : {};
  const existingDetected = parseJsonField(lookup.rows[0].detected_context) || {};
  const existingResults = parseJsonField(lookup.rows[0].results) || {};
  const existingEvidenceSnapshot = parseJsonField(lookup.rows[0].evidence_snapshot) || {};
  const existingUserInputs = parseJsonField(lookup.rows[0].user_inputs) || {};

  // Setup compare-and-swap (finding 3). `expectedSetupRevision` is the
  // revision the caller read before doing provider/aggregation work; the
  // predicate makes a stale write fail instead of overwriting a newer Setup
  // context and resurrecting invalidated downstream state. When the caller
  // does not supply one, the lookup's own revision is used (still race-safe).
  const existingRevision = existingDetected[SETUP_CONTEXT_REVISION_KEY] ?? null;
  const expectedRevision =
    data.expectedSetupRevision !== undefined ? data.expectedSetupRevision : existingRevision;
  if (String(expectedRevision ?? '') !== String(existingRevision ?? '')) {
    const staleError = new Error(
      'Setup context is stale: it changed after this request read it. Re-run Setup prepare/evaluate.'
    );
    staleError.code = 'STALE_SETUP_CONTEXT';
    throw staleError;
  }
  const nextRevision = nextContextRevision(expectedRevision);

  // Setup -> downstream dependency fingerprint (server-computed, never client
  // trusted). Unchanged -> preserve every downstream dimension; changed ->
  // invalidate results AND evidence/context AND flat summaries atomically.
  const newFingerprint = setupDependencyFingerprint({
    profileVersionId: lookup.rows[0].profile_version_id,
    boundary: detectedContextInput.boundary,
    evidenceSnapshot: data.evidenceSnapshot
  });
  const existingFingerprint = existingDetected[SETUP_DEPENDENCY_FINGERPRINT_KEY] ?? null;
  const dependenciesUnchanged =
    existingFingerprint !== null &&
    existingFingerprint === newFingerprint &&
    existingResults.setup !== null &&
    existingResults.setup !== undefined;

  const nextDetectedContext = {
    ...detectedContextInput,
    [SETUP_DEPENDENCY_FINGERPRINT_KEY]: newFingerprint,
    [SETUP_CONTEXT_REVISION_KEY]: nextRevision
  };

  const merged = applyDownstreamState({
    mode: dependenciesUnchanged ? 'preserve' : 'invalidate',
    existing: {
      results: existingResults,
      evidenceSnapshot: existingEvidenceSnapshot,
      detectedContext: existingDetected,
      userInputs: existingUserInputs
    },
    next: {
      results: { setup: recomputed },
      evidenceSnapshot: data.evidenceSnapshot,
      detectedContext: nextDetectedContext,
      userInputs: data.userInputs
    }
  });
  const summaries = summariesFromResults(merged.results || {});

  const updated = await db.query(
    `
      UPDATE trade_quality_evaluations
      SET
        results = $3,
        evidence_snapshot = $4,
        user_inputs = $5,
        detected_context = $6,
        setup_score = $7,
        setup_grade = $8,
        setup_compliance = $9,
        setup_coverage = $10,
        entry_score = $11,
        entry_grade = $12,
        entry_compliance = $13,
        entry_coverage = $14,
        management_score = $15,
        management_grade = $16,
        management_compliance = $17,
        management_coverage = $18,
        evaluated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND user_id = $2
        AND ${TERMINAL_STATUS_SQL}
        AND COALESCE(detected_context->>'${SETUP_CONTEXT_REVISION_KEY}', '') = $19
      RETURNING ${EVALUATION_COLUMNS}
    `,
    [
      evaluationId,
      userId,
      merged.results === null ? null : JSON.stringify(merged.results),
      merged.evidenceSnapshot,
      merged.userInputs,
      merged.detectedContext,
      summaries.setup_score,
      summaries.setup_grade,
      summaries.setup_compliance,
      summaries.setup_coverage,
      summaries.entry_score,
      summaries.entry_grade,
      summaries.entry_compliance,
      summaries.entry_coverage,
      summaries.management_score,
      summaries.management_grade,
      summaries.management_compliance,
      summaries.management_coverage,
      expectedRevision ?? ''
    ]
  );
  if (updated.rows.length === 0) {
    const staleError = new Error(
      'Setup results were not saved because the Setup context changed during evaluation. Re-run Setup prepare/evaluate.'
    );
    staleError.code = 'STALE_SETUP_CONTEXT';
    throw staleError;
  }
  return updated.rows[0] || null;
}

// Persists NON-TERMINAL Entry evaluation progress on a still-mutable draft
// (Phase 3 Entry Quality workflow).
//
// Contract (parallel to saveSetupProgress):
//   - the evaluation must exist, belong to `userId`, link to a profile version
//     owned by the same user, and be NON-TERMINAL. Terminal immutability is
//     never weakened.
//   - an EXISTING Setup result is REQUIRED: Entry Quality depends on the
//     confirmed Pivot / breakout boundary, so Entry progress must never be able
//     to silently erase Setup. It preserves results.setup untouched and
//     replaces only results.entry (management stays null in Phase 3).
//   - entryResults.criterionResults are normalized against the immutable
//     entry configuration: PASS/FAIL scores are derived from/validated against
//     the configured `scoring` envelopes and the authoritative Entry aggregate
//     is recomputed. Caller-supplied scores/summaries are never trusted.
//   - flat entry_* summary columns derive from the recomputed aggregate; the
//     setup_* columns are untouched. The row stays non-terminal because
//     Management is not implemented yet.
async function saveEntryProgress(evaluationId, userId, data = {}) {
  const lookup = await db.query(
    `
      SELECT e.id, e.status, e.results, e.detected_context, v.configuration
      FROM trade_quality_evaluations e
      JOIN quality_profile_versions v ON v.id = e.profile_version_id
      JOIN quality_profiles p ON p.id = v.profile_id
      WHERE e.id = $1
        AND e.user_id = $2
        AND p.user_id = $2
        AND ${TERMINAL_STATUS_SQL}
    `,
    [evaluationId, userId]
  );

  if (lookup.rows.length === 0) {
    return null;
  }
  // Optimistic Setup-dependency guard: Entry computed against a server-derived
  // fingerprint from the Setup context it loaded. If the persisted Setup
  // dependency changed while Entry evidence work was in flight, stale Entry
  // results must never attach to the newer Setup. The value is server-derived
  // (never client-trusted) and is re-checked in the UPDATE predicate to close
  // the read/write race.
  const currentDetected = parseJsonField(lookup.rows[0].detected_context) || {};
  const currentFingerprint = currentDetected.setup_dependency_fingerprint ?? null;
  const expectedFingerprint =
    data.dependencyFingerprint === undefined || data.dependencyFingerprint === null
      ? null
      : String(data.dependencyFingerprint);
  if (expectedFingerprint !== null && currentFingerprint !== expectedFingerprint) {
    const staleError = new Error(
      'Entry evidence is stale: the Setup dependency changed while Entry was being evaluated. Re-run Entry prepare/evaluate against the current Setup.'
    );
    staleError.code = 'STALE_DEPENDENCY';
    throw staleError;
  }

  const configuration = lookup.rows[0].configuration;
  if (
    configuration === null ||
    typeof configuration !== 'object' ||
    !configuration.dimensions ||
    !configuration.dimensions.entry
  ) {
    throw new Error('profile version configuration has no entry dimension');
  }
  const entryConfig = configuration.dimensions.entry;

  const existingResults = parseJsonField(lookup.rows[0].results);
  if (
    !existingResults ||
    typeof existingResults !== 'object' ||
    !Object.prototype.hasOwnProperty.call(existingResults, 'setup') ||
    existingResults.setup === null
  ) {
    throw new Error(
      'Entry progress requires an existing Setup result; run Setup Quality before Entry Quality.'
    );
  }

  const entryResults = data.entryResults;
  if (entryResults === null || typeof entryResults !== 'object' || Array.isArray(entryResults)) {
    throw new Error('entry progress requires an entryResults object with criterionResults');
  }
  const rows = normalizeCriterionRows('entry', entryConfig, {
    criterionResults: entryResults.criterionResults || []
  });
  const recomputed = aggregateDimension(entryConfig, rows);

  // Preserve Setup byte-for-byte; replace Entry; keep Management null/progress.
  const persistedResults = {
    ...existingResults,
    setup: existingResults.setup,
    entry: recomputed,
    management: Object.prototype.hasOwnProperty.call(existingResults, 'management')
      ? existingResults.management
      : null
  };

  // Entry only writes Entry state: it must carry forward the CURRENT Setup
  // concurrency token and fingerprint it was guarded against, never a stale
  // revision it read before some other concurrent Setup write.
  const detectedContextInput =
    data.detectedContext && typeof data.detectedContext === 'object' ? data.detectedContext : {};
  const persistedDetectedContext = {
    ...detectedContextInput,
    [SETUP_DEPENDENCY_FINGERPRINT_KEY]: currentDetected[SETUP_DEPENDENCY_FINGERPRINT_KEY] ?? null,
    [SETUP_CONTEXT_REVISION_KEY]: currentDetected[SETUP_CONTEXT_REVISION_KEY] ?? null
  };

  const updated = await db.query(
    `
      UPDATE trade_quality_evaluations
      SET
        results = $3,
        evidence_snapshot = $4,
        user_inputs = $5,
        detected_context = $6,
        entry_score = $7,
        entry_grade = $8,
        entry_compliance = $9,
        entry_coverage = $10,
        evaluated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND user_id = $2
        AND ${TERMINAL_STATUS_SQL}
        AND COALESCE(detected_context->>'setup_dependency_fingerprint', '') = $11
      RETURNING ${EVALUATION_COLUMNS}
    `,
    [
      evaluationId,
      userId,
      JSON.stringify(persistedResults),
      data.evidenceSnapshot ?? null,
      data.userInputs ?? null,
      persistedDetectedContext,
      recomputed.score,
      recomputed.grade,
      recomputed.compliance,
      recomputed.coverage,
      expectedFingerprint ?? ''
    ]
  );
  if (updated.rows.length === 0) {
    // The lookup confirmed a non-terminal row, so a zero-row UPDATE means the
    // Setup-dependency predicate no longer holds: reject the stale write.
    const staleError = new Error(
      'Entry results were not saved because the Setup dependency changed during evaluation. Re-run Entry prepare/evaluate.'
    );
    staleError.code = 'STALE_DEPENDENCY';
    throw staleError;
  }
  return updated.rows[0] || null;
}

// Evaluation history for a trade, newest first. Keeps every version's result
// so the UI can show "evaluated with v1 / re-evaluate with v3".
async function listEvaluationsForTrade(userId, tradeId) {
  const result = await db.query(
    `
      SELECT ${EVALUATION_COLUMNS}
      FROM trade_quality_evaluations
      WHERE user_id = $1 AND trade_id = $2
      ORDER BY created_at DESC, id DESC
    `,
    [userId, tradeId]
  );
  return result.rows;
}

module.exports = {
  EVALUATION_COLUMNS,
  DIMENSION_SUMMARY_KEYS,
  summariesFromResults,
  normalizeCriterionRows,
  createEvaluation,
  saveResult,
  saveSetupProgress,
  saveEntryProgress,
  getEvaluation,
  listEvaluationsForTrade
};
