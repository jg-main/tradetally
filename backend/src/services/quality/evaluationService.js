'use strict';

// Trade Quality Evaluation persistence service (spec section 5.3).
//
// An evaluation links a trade to the exact immutable profile version that
// produced it and stores the evidence snapshot, detected context, semantic
// user inputs, and per-dimension results used at evaluation time.
//
// Lifecycle invariants (Phase 1 hardening):
//   - Evaluations are created as `draft` only. Terminal statuses
//     (`completed` / `insufficient_data`) are produced exclusively through
//     saveResult(), which validates the terminal payload against the
//     evaluation's immutable profile-version configuration before persisting.
//   - createEvaluation() atomically enforces ownership: the trade must belong
//     to the user and the profile version must belong to a Quality Profile
//     owned by the same user.
//   - Completed evaluations are immutable (DB trigger + service guard); a new
//     calculation always creates a new evaluation row (spec section 6).
//   - Terminal flat summary columns are derived from validated aggregate
//     results, never trusted from the caller directly.

const db = require('../../config/database');
const { EVALUATION_STATUS } = require('./constants');
const { aggregateDimension } = require('./aggregation');

const EVALUATION_COLUMNS = `
  id, user_id, trade_id, profile_version_id, status,
  setup_score, setup_grade, setup_compliance, setup_coverage,
  entry_score, entry_grade, entry_compliance, entry_coverage,
  management_score, management_grade, management_compliance, management_coverage,
  user_inputs, detected_context, evidence_snapshot, results,
  evaluated_at, created_at
`;

const DIMENSION_SUMMARY_KEYS = ['setup', 'entry', 'management'];

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

// Recomputes a dimension aggregate from the supplied result's per-criterion
// states using the evaluation's immutable profile-version configuration, then
// requires the supplied aggregate summary to match. The caller may not assert
// a score/grade/compliance/coverage combination that the aggregation engine
// would not derive for that profile version.
function assertConsistentDimensionResult(dimension, dimensionConfig, dimResult) {
  if (dimResult === null || typeof dimResult !== 'object' || Array.isArray(dimResult)) {
    throw new Error(`completed results for dimension "${dimension}" must be an object`);
  }
  if (!Array.isArray(dimResult.criterionResults)) {
    throw new Error(`completed results for dimension "${dimension}" require criterionResults`);
  }

  const criterionResults = dimResult.criterionResults.map((entry) => ({
    key: entry.key,
    status: entry.status,
    score: entry.score ?? null,
    raw_value: entry.rawValue ?? entry.raw_value ?? null,
    evidence: entry.evidence ?? null,
    message: entry.message ?? null
  }));

  const recomputed = aggregateDimension(dimensionConfig, criterionResults);

  if (!sameNullableNumber(recomputed.score, dimResult.score) ||
      recomputed.grade !== dimResult.grade ||
      recomputed.compliance !== dimResult.compliance ||
      !sameNullableNumber(recomputed.coverage, dimResult.coverage)) {
    throw new Error(
      `invalid completed results for dimension "${dimension}": score/grade/compliance/coverage ` +
      'contradict the profile version configuration'
    );
  }
  return recomputed;
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

// Persists a terminal result for an evaluation. For `completed`, the supplied
// per-dimension results must cover every dimension configured in the
// evaluation's immutable profile version and every dimension summary must
// match a fresh aggregation over that version's configuration. Flat summary
// columns are derived from the recomputed aggregates. For `insufficient_data`,
// no completed dimension results may be attached. Completed rows are
// immutable: this refuses to overwrite one, and the DB trigger rejects the
// UPDATE regardless.
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
        AND e.status <> 'completed'
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

    const recomputedByDimension = {};
    for (const dimension of configuredDimensions) {
      recomputedByDimension[dimension] = assertConsistentDimensionResult(
        dimension,
        configuration.dimensions[dimension],
        results[dimension]
      );
    }
    // Flat summary columns derive from the validated aggregates. The results
    // JSONB keeps the supplied evidence/enriched rows, which are guaranteed
    // to agree with the recomputed summaries.
    summaries = summariesFromResults(recomputedByDimension);
    persistedResults = results;
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
        AND status <> 'completed'
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
  createEvaluation,
  saveResult,
  getEvaluation,
  listEvaluationsForTrade
};
