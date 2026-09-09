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
  const setupSummary = {
    setup_score: recomputed.score,
    setup_grade: recomputed.grade,
    setup_compliance: recomputed.compliance,
    setup_coverage: recomputed.coverage
  };

  // The stored results envelope keeps one key per configured dimension so
  // later phases (and any full-dimension consumer) can rely on a stable shape.
  // Entry/Management are explicitly `null` because Phase 2 never evaluates
  // them — nothing is fabricated to satisfy a completed-dimension contract,
  // and Phase 3/4 replace these nulls with their own recomputed aggregates.
  const persistedResults = { setup: recomputed, entry: null, management: null };

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
        evaluated_at = CURRENT_TIMESTAMP
      WHERE id = $1
        AND user_id = $2
        AND ${TERMINAL_STATUS_SQL}
      RETURNING ${EVALUATION_COLUMNS}
    `,
    [
      evaluationId,
      userId,
      JSON.stringify(persistedResults),
      data.evidenceSnapshot ?? null,
      data.userInputs ?? null,
      data.detectedContext ?? null,
      setupSummary.setup_score,
      setupSummary.setup_grade,
      setupSummary.setup_compliance,
      setupSummary.setup_coverage
    ]
  );
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
  getEvaluation,
  listEvaluationsForTrade
};
