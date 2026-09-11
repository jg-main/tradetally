'use strict';

// Generic trade quality evaluation history + primary-selection service
// (Phase 5 of docs/QUALITY_PROFILES_REQUIREMENT.md, sections 4, 6, 49, 53, 57,
// 66).
//
// This service owns the generic Phase-5 persistence around the existing
// evaluators:
//   - the immutable per-trade evaluation history (read-only, persisted values
//     only — it never recalculates a historical result);
//   - starting a NEW evaluation pinned to an explicitly selected immutable
//     profile version (historical re-evaluation);
//   - selecting at most ONE primary evaluation per trade, stored in a separate
//     relation so terminal evaluation snapshots are never mutated.
//
// Setup / Entry / Management workflow services delegate here instead of
// duplicating history logic.

const db = require('../../config/database');
const evaluationService = require('./evaluationService');
const profileService = require('./profileService');
const { EVALUATION_STATUS } = require('./constants');

const TERMINAL_STATUSES = Object.freeze([
  EVALUATION_STATUS.COMPLETED,
  EVALUATION_STATUS.INSUFFICIENT_DATA
]);

class QualityHistoryInputError extends Error {
  constructor(message, code = 'INVALID_INPUT', details = null) {
    super(message);
    this.name = 'QualityHistoryInputError';
    this.code = code;
    this.details = details;
  }
}

function isTerminalStatus(status) {
  return TERMINAL_STATUSES.includes(status);
}

// Flat queryable summary columns are NUMERIC in PostgreSQL and returned as
// strings by the driver; cast them so the JSON history payload carries numbers
// and the UI can compare them without client-side parsing.
const ENRICHED_EVALUATION_SELECT = `
  e.id,
  e.user_id,
  e.trade_id,
  e.profile_version_id,
  e.status,
  e.setup_score::float8 AS setup_score,
  e.setup_grade,
  e.setup_compliance,
  e.setup_coverage::float8 AS setup_coverage,
  e.entry_score::float8 AS entry_score,
  e.entry_grade,
  e.entry_compliance,
  e.entry_coverage::float8 AS entry_coverage,
  e.management_score::float8 AS management_score,
  e.management_grade,
  e.management_compliance,
  e.management_coverage::float8 AS management_coverage,
  e.user_inputs,
  e.detected_context,
  e.evidence_snapshot,
  e.results,
  e.evaluated_at,
  e.created_at,
  v.profile_id,
  v.version_number,
  v.schema_version,
  p.name AS profile_name,
  p.current_version_id,
  cv.version_number AS current_version_number,
  (e.profile_version_id = p.current_version_id) AS is_current_version,
  (pe.evaluation_id IS NOT NULL) AS is_primary
`;

const ENRICHED_EVALUATION_FROM = `
  FROM trade_quality_evaluations e
  JOIN quality_profile_versions v ON v.id = e.profile_version_id
  JOIN quality_profiles p ON p.id = v.profile_id
  LEFT JOIN quality_profile_versions cv ON cv.id = p.current_version_id
  LEFT JOIN trade_quality_primary_evaluations pe ON pe.evaluation_id = e.id
`;

// Deterministic history order (spec section 1 / Phase-5 scope):
//   evaluated_at DESC NULLS LAST, created_at DESC, id DESC
const HISTORY_ORDER = 'e.evaluated_at DESC NULLS LAST, e.created_at DESC, e.id DESC';

/**
 * Immutable evaluation history for one owned trade. Every row displays the
 * values persisted on that exact evaluation plus its immutable profile/version
 * metadata, current-version marker, and primary marker. No result is
 * recalculated or inferred from current profile configuration.
 */
async function listEvaluationsForTrade(userId, tradeId) {
  const result = await db.query(
    `
      SELECT ${ENRICHED_EVALUATION_SELECT}
      ${ENRICHED_EVALUATION_FROM}
      WHERE e.user_id = $1 AND e.trade_id = $2
      ORDER BY ${HISTORY_ORDER}
    `,
    [userId, tradeId]
  );
  return result.rows;
}

// Loads one enriched evaluation row, scoped to the user AND the trade so a
// caller can never observe another user's/trade's evaluation through this
// path.
async function findEnrichedEvaluation(userId, tradeId, evaluationId) {
  const result = await db.query(
    `
      SELECT ${ENRICHED_EVALUATION_SELECT}
      ${ENRICHED_EVALUATION_FROM}
      WHERE e.user_id = $1 AND e.trade_id = $2 AND e.id = $3
    `,
    [userId, tradeId, evaluationId]
  );
  return result.rows[0] || null;
}

async function assertTradeOwned(userId, tradeId) {
  const result = await db.query(
    'SELECT 1 AS found FROM trades WHERE id = $1 AND user_id = $2',
    [tradeId, userId]
  );
  if (result.rows.length === 0) {
    throw new QualityHistoryInputError(
      'Trade not found or not owned by this user.',
      'TRADE_NOT_FOUND'
    );
  }
}

/**
 * Starts a FRESH evaluation pinned to the explicitly selected immutable
 * profile version.
 *
 * This is the Phase-5 historical re-evaluation contract: an explicit
 * "Evaluate with vN" ALWAYS creates a NEW trade_quality_evaluations row, even
 * when another still-open draft for the same trade+version already exists. An
 * abandoned draft is a legitimate historical record (possibly stale evidence
 * or assertions from another attempt) and is never resumed, mutated, or
 * deleted here. A future "Resume draft" action is a distinct explicit
 * operation and is out of scope.
 *
 * The version is frozen at creation because the caller selects an exact
 * profile_version_id — the workflow never resolves "current version" again, so
 * a profile that advances while the draft is in progress does not move the
 * evaluation.
 */
async function startEvaluation(userId, tradeId, profileVersionId) {
  if (!profileVersionId || typeof profileVersionId !== 'string') {
    throw new QualityHistoryInputError(
      'profileVersionId is required to start an evaluation.',
      'PROFILE_VERSION_REQUIRED'
    );
  }

  await assertTradeOwned(userId, tradeId);

  const version = await profileService.findVersionById(profileVersionId, userId);
  if (!version) {
    throw new QualityHistoryInputError(
      'Quality Profile version not found or not owned by this user.',
      'VERSION_NOT_FOUND'
    );
  }

  // Always a NEW row. Reuse the generic evaluation persistence (single INSERT
  // that enforces trade + version ownership); never a second grading path and
  // never a lookup for an existing draft.
  const created = await evaluationService.createEvaluation(userId, tradeId, profileVersionId);

  return findEnrichedEvaluation(userId, tradeId, created.id);
}

/**
 * Sets the primary evaluation for a trade. At most one primary exists per
 * trade, enforced by the trade_id primary key on
 * trade_quality_primary_evaluations together with this upsert.
 *
 * Eligibility (all enforced before the write; same-trade/user is additionally
 * guaranteed by the composite FK and terminal-only by a DB trigger):
 *   - the trade and evaluation must belong to the authenticated user;
 *   - the evaluation must belong to this exact trade;
 *   - the evaluation must be terminal (completed / insufficient_data).
 *
 * Re-selecting the current primary is idempotent. Completing a newer
 * evaluation never changes the primary automatically; only this explicit call
 * does.
 */
async function selectPrimary(userId, tradeId, evaluationId) {
  if (!evaluationId || typeof evaluationId !== 'string') {
    throw new QualityHistoryInputError(
      'evaluationId is required to select a primary evaluation.',
      'EVALUATION_ID_REQUIRED'
    );
  }

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    const tradeResult = await client.query(
      'SELECT 1 AS found FROM trades WHERE id = $1 AND user_id = $2',
      [tradeId, userId]
    );
    if (tradeResult.rows.length === 0) {
      throw new QualityHistoryInputError(
        'Trade not found or not owned by this user.',
        'TRADE_NOT_FOUND'
      );
    }

    const evaluationResult = await client.query(
      `
        SELECT id, status
        FROM trade_quality_evaluations
        WHERE id = $1 AND user_id = $2 AND trade_id = $3
        FOR UPDATE
      `,
      [evaluationId, userId, tradeId]
    );
    if (evaluationResult.rows.length === 0) {
      throw new QualityHistoryInputError(
        'Evaluation not found for this trade or not owned by this user.',
        'EVALUATION_NOT_FOUND'
      );
    }
    const status = evaluationResult.rows[0].status;
    if (!isTerminalStatus(status)) {
      throw new QualityHistoryInputError(
        'Only terminal evaluations (completed or insufficient_data) can be primary.',
        'EVALUATION_NOT_TERMINAL',
        { status }
      );
    }

    // trade_id is the PRIMARY KEY, so this single statement can never leave
    // two primaries for a trade, even under concurrent selections.
    //
    // Re-selecting the evaluation that is ALREADY primary must be state
    // idempotent: selected_at is preserved (unchanged) instead of being
    // rewritten to CURRENT_TIMESTAMP. Switching to a different evaluation does
    // advance selected_at.
    const upsert = await client.query(
      `
        INSERT INTO trade_quality_primary_evaluations (trade_id, user_id, evaluation_id)
        VALUES ($1, $2, $3)
        ON CONFLICT (trade_id) DO UPDATE
          SET evaluation_id = EXCLUDED.evaluation_id,
              user_id = EXCLUDED.user_id,
              selected_at = CASE
                WHEN trade_quality_primary_evaluations.evaluation_id IS DISTINCT FROM EXCLUDED.evaluation_id
                THEN CURRENT_TIMESTAMP
                ELSE trade_quality_primary_evaluations.selected_at
              END
        RETURNING trade_id, user_id, evaluation_id, selected_at
      `,
      [tradeId, userId, evaluationId]
    );

    await client.query('COMMIT');
    return upsert.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

// Removes the trade's primary pointer, if any. Idempotent.
async function clearPrimary(userId, tradeId) {
  await assertTradeOwned(userId, tradeId);
  const result = await db.query(
    `
      DELETE FROM trade_quality_primary_evaluations
      WHERE trade_id = $1 AND user_id = $2
      RETURNING trade_id, evaluation_id
    `,
    [tradeId, userId]
  );
  return result.rows[0] || null;
}

module.exports = {
  QualityHistoryInputError,
  TERMINAL_STATUSES,
  isTerminalStatus,
  listEvaluationsForTrade,
  findEnrichedEvaluation,
  startEvaluation,
  selectPrimary,
  clearPrimary
};
