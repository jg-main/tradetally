'use strict';

// Trade Quality Evaluation persistence service (spec section 5.3).
//
// An evaluation links a trade to the exact immutable profile version that
// produced it and stores the evidence snapshot, detected context, semantic
// user inputs, and per-dimension results used at evaluation time. Completed
// evaluations are immutable (DB trigger + service guard); a new calculation
// always creates a new evaluation row (section 6).
//
// Phase 1 scope: row creation, terminal result persistence with summary
// mirror columns, and reads. No evaluation workflow, detectors, or criteria
// evaluators yet.

const db = require('../../config/database');
const { EVALUATION_STATUS_VALUES, GRADE_VALUES, COMPLIANCE_VALUES } = require('./constants');

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

function assertSummaryEnums(summaries) {
  for (const dimension of DIMENSION_SUMMARY_KEYS) {
    const grade = summaries[`${dimension}_grade`];
    if (grade !== null && !GRADE_VALUES.includes(grade)) {
      throw new Error(`Invalid ${dimension} grade "${grade}"`);
    }
    const compliance = summaries[`${dimension}_compliance`];
    if (compliance !== null && !COMPLIANCE_VALUES.includes(compliance)) {
      throw new Error(`Invalid ${dimension} compliance "${compliance}"`);
    }
  }
}

function assertEvaluationStatus(status) {
  if (!EVALUATION_STATUS_VALUES.includes(status)) {
    throw new Error(`Invalid evaluation status "${status}"`);
  }
}

// Creates a new evaluation row. Defaults to `draft`; later phases transition
// the row to `needs_input` / `completed` / `insufficient_data` as the
// evaluation workflow runs.
async function createEvaluation(userId, tradeId, profileVersionId, data = {}) {
  const status = data.status || 'draft';
  assertEvaluationStatus(status);

  const result = await db.query(
    `
      INSERT INTO trade_quality_evaluations (
        user_id, trade_id, profile_version_id, status,
        user_inputs, detected_context, evidence_snapshot, results
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING ${EVALUATION_COLUMNS}
    `,
    [
      userId,
      tradeId,
      profileVersionId,
      status,
      data.userInputs ?? null,
      data.detectedContext ?? null,
      data.evidenceSnapshot ?? null,
      data.results ?? null
    ]
  );
  return result.rows[0];
}

// Persists a terminal result for an evaluation (status `completed` or
// `insufficient_data`) together with the evidence used at evaluation time.
// Completed rows are immutable: this refuses to overwrite one, and the DB
// trigger rejects the UPDATE regardless.
async function saveResult(evaluationId, userId, data) {
  const status = data.status || 'completed';
  assertEvaluationStatus(status);
  if (!['completed', 'insufficient_data'].includes(status)) {
    throw new Error(`saveResult only accepts terminal statuses completed or insufficient_data`);
  }

  const results = data.results ?? null;
  const summaries = summariesFromResults(results);
  assertSummaryEnums(summaries);

  const result = await db.query(
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
      status,
      results,
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
  return result.rows[0] || null;
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
