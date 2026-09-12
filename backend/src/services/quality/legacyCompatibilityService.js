'use strict';

// Phase 6 (Legacy Integration) quality compatibility resolver, per
// docs/QUALITY_PROFILES_REQUIREMENT.md sections 47, 53, 54 and 66.
//
// This module owns ONE precedence contract used by every compatibility
// surface (trade list, trade detail, quality-grade filter, count, analytics,
// export):
//
//   1. an explicit Phase-5 PRIMARY profile evaluation exists
//        -> source = 'profile_primary' (it wins, even when its Setup
//           dimension is ungraded / null; it NEVER falls back to legacy)
//   2. otherwise legacy quality data exists
//        -> source = 'legacy'
//   3. otherwise
//        -> source = 'none'
//
// Only the explicitly selected primary supersedes legacy. Latest/newest/
// draft/non-primary evaluations are never considered here. This layer is a
// presentation/query bridge: it never writes profile results into the legacy
// trade columns and never builds a profile evaluation from legacy data.
//
// Raw legacy API fields (quality_grade / quality_score / quality_metrics) are
// left untouched; the resolved object is additive (`qualitySummary`).

const db = require('../../config/database');

const SOURCE = Object.freeze({
  PROFILE_PRIMARY: 'profile_primary',
  LEGACY: 'legacy',
  NONE: 'none'
});

// Legacy Setup Quality is historically displayed on a 0-5 scale; Quality
// Profiles use 0-100. The two are never translated into one another.
const LEGACY_SCORE_SCALE = 5;
const PROFILE_SCORE_SCALE = 100;

// Columns projected from the primary-evaluation join. The flat summary
// columns on trade_quality_evaluations are the persisted, CHECK-constrained
// mirror of `results.<dimension>` (written by evaluationService's
// summariesFromResults); reading them keeps display and filtering on the exact
// same persisted value and avoids JSONB parsing differences.
const PRIMARY_PROJECTION_COLUMNS = Object.freeze([
  'evaluation_id',
  'evaluation_status',
  'profile_version_id',
  'version_number',
  'profile_id',
  'profile_name',
  'selected_at',
  'setup_score',
  'setup_grade',
  'setup_compliance',
  'setup_coverage',
  'entry_score',
  'entry_grade',
  'entry_compliance',
  'entry_coverage',
  'management_score',
  'management_grade',
  'management_compliance',
  'management_coverage'
]);

function coerceNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function coerceGrade(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

// Inner SELECT list for the primary evaluation joined to its immutable
// profile/version metadata. Used both by the list LATERAL join and the
// single-trade detail lookup so both expose identical fields.
function primaryProjectionSql() {
  return `
    ppe.evaluation_id AS evaluation_id,
    pe.status AS evaluation_status,
    pe.profile_version_id AS profile_version_id,
    pv.version_number AS version_number,
    p.id AS profile_id,
    p.name AS profile_name,
    ppe.selected_at AS selected_at,
    pe.setup_score::float8 AS setup_score,
    pe.setup_grade AS setup_grade,
    pe.setup_compliance AS setup_compliance,
    pe.setup_coverage::float8 AS setup_coverage,
    pe.entry_score::float8 AS entry_score,
    pe.entry_grade AS entry_grade,
    pe.entry_compliance AS entry_compliance,
    pe.entry_coverage::float8 AS entry_coverage,
    pe.management_score::float8 AS management_score,
    pe.management_grade AS management_grade,
    pe.management_compliance AS management_compliance,
    pe.management_coverage::float8 AS management_coverage
  `;
}

// One-row LATERAL join fragment. `trade_quality_primary_evaluations.trade_id`
// is the primary key, so this yields at most one row per trade — the trade
// list stays a single set query with no per-trade follow-up query (no N+1).
// Correlated on both trade_id AND user_id so a user can never observe another
// user's primary evaluation/profile metadata.
function primaryCompatibilityLateralSql(tradeAlias = 't', lateralAlias = 'qp') {
  return `
    LEFT JOIN LATERAL (
      SELECT
        ${primaryProjectionSql()}
      FROM trade_quality_primary_evaluations ppe
      JOIN trade_quality_evaluations pe ON pe.id = ppe.evaluation_id
      JOIN quality_profile_versions pv ON pv.id = pe.profile_version_id
      JOIN quality_profiles p ON p.id = pv.profile_id
      WHERE ppe.trade_id = ${tradeAlias}.id
        AND ppe.user_id = ${tradeAlias}.user_id
      LIMIT 1
    ) ${lateralAlias} ON true
  `;
}

// Outer SELECT list for findByUser. The LATERAL contributes at most one row
// per trade, so its columns are safe to reference directly. They are also
// added to GROUP BY (primaryListGroupBySql) rather than wrapped in MAX(),
// because PostgreSQL has no MAX(uuid) aggregate.
function primaryListSelectSql(lateralAlias = 'qp', prefix = 'primary_') {
  return PRIMARY_PROJECTION_COLUMNS
    .map((column) => `${lateralAlias}.${column} AS ${prefix}${column}`)
    .join(',\n        ');
}

// GROUP BY fragment required because the lateral columns are not functionally
// dependent on t.id from PostgreSQL's perspective.
function primaryListGroupBySql(lateralAlias = 'qp') {
  return PRIMARY_PROJECTION_COLUMNS
    .map((column) => `${lateralAlias}.${column}`)
    .join(', ');
}

function prefixPrimaryColumns(row) {
  const prefixed = {};
  for (const column of PRIMARY_PROJECTION_COLUMNS) {
    const value = row ? row[column] : null;
    prefixed[`primary_${column}`] = value === undefined ? null : value;
  }
  return prefixed;
}

// Self-contained effective Setup grade expression usable in ANY query that
// has `trades t` in scope (list, count, analytics, export), independent of
// whether that query joins the primary relation.
//
// Semantics (spec 54 / prompt Phase 6 s.10):
//   CASE WHEN a primary evaluation exists THEN primary results.setup.grade
//        ELSE t.quality_grade END
//
// It is deliberately NOT a COALESCE(primary_grade, legacy_grade): a selected
// primary whose Setup grade is NULL must resolve to NULL (N/A), never fall
// back to the legacy grade. The primary predicate is scoped by trade_id AND
// user_id, and only the Phase-5 primary pointer is read — never a latest or
// newest evaluation.
//
// The primary grade is read from the persisted `setup_grade` summary column,
// which evaluationService writes as the exact mirror of
// `results.setup.grade`; display and filtering therefore agree by
// construction.
//
// This predicate is intentionally SELF-CONTAINED rather than referencing the
// trade-list LATERAL alias: `_buildWhereClause` is the single shared seam for
// trade list, count, analytics, CSV/analytics export, partial exits and Trade
// Management, and most of those statements do not join the primary relation.
// A single predicate that is structurally identical everywhere is what keeps
// those endpoints' filtered trade sets from drifting. Both lookups are
// primary-key bounded (`trade_quality_primary_evaluations.trade_id` PK, then
// `trade_quality_evaluations.id` PK), and the EXISTS short-circuits so the
// second probe only runs for trades that actually have a primary. Within one
// SQL statement PostgreSQL uses a single snapshot, so this predicate cannot
// observe a different primary row than the list's LATERAL display.
function effectiveSetupGradeSql(tradeAlias = 't') {
  return `(
    CASE
      WHEN EXISTS (
        SELECT 1
        FROM trade_quality_primary_evaluations qpp_exists
        WHERE qpp_exists.trade_id = ${tradeAlias}.id
          AND qpp_exists.user_id = ${tradeAlias}.user_id
      )
      THEN (
        SELECT qpe.setup_grade
        FROM trade_quality_primary_evaluations qpp_grade
        JOIN trade_quality_evaluations qpe ON qpe.id = qpp_grade.evaluation_id
        WHERE qpp_grade.trade_id = ${tradeAlias}.id
          AND qpp_grade.user_id = ${tradeAlias}.user_id
        LIMIT 1
      )
      ELSE ${tradeAlias}.quality_grade
    END
  )`;
}

// Effective Setup grade filter, preserving the exact `qualityGrades`
// parameter/keys. Values are bound by the caller as SQL parameters.
function effectiveSetupGradeFilterSql(tradeAlias, placeholders) {
  return `${effectiveSetupGradeSql(tradeAlias)} IN (${placeholders})`;
}

// The `quality_profiles.name` of a trade's primary evaluation, or null.
// Used to label compatibility display. Owner scoped.
async function findPrimaryEvaluation(userId, tradeId) {
  if (!userId || !tradeId) return null;
  const result = await db.query(
    `
      SELECT ${primaryProjectionSql()}
      FROM trade_quality_primary_evaluations ppe
      JOIN trade_quality_evaluations pe ON pe.id = ppe.evaluation_id
      JOIN quality_profile_versions pv ON pv.id = pe.profile_version_id
      JOIN quality_profiles p ON p.id = pv.profile_id
      WHERE ppe.trade_id = $1 AND ppe.user_id = $2
      LIMIT 1
    `,
    [tradeId, userId]
  );
  return result.rows[0] || null;
}

function parseLegacyMetrics(metrics) {
  if (!metrics) return null;
  if (typeof metrics === 'object') return metrics;
  if (typeof metrics === 'string') {
    try {
      const parsed = JSON.parse(metrics);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_error) {
      return null;
    }
  }
  return null;
}

// Legacy coverage is only surfaced when the stored legacy metrics genuinely
// contain it. The legacy calculator stores coverage as a 0-1 decimal; it is
// normalized to the 0-100 percent scale used by profile coverage so the two
// share one field contract. No compliance is ever fabricated for legacy data.
function legacyCoveragePercent(metrics) {
  const parsed = parseLegacyMetrics(metrics);
  if (!parsed) return null;
  const raw = parsed.coverage;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const percent = raw >= 0 && raw <= 1 ? raw * 100 : raw;
  if (!Number.isFinite(percent)) return null;
  return Math.round(percent * 100) / 100;
}

function hasLegacyQuality(row) {
  if (!row) return false;
  return (
    (row.quality_grade !== null && row.quality_grade !== undefined) ||
    (row.quality_score !== null && row.quality_score !== undefined) ||
    (row.quality_metrics !== null && row.quality_metrics !== undefined)
  );
}

function buildProfileDimension(row, prefix, includeScoreScale) {
  const score = coerceNumber(row[`${prefix}_score`]);
  const grade = coerceGrade(row[`${prefix}_grade`]);
  const compliance = coerceGrade(row[`${prefix}_compliance`]);
  const coverage = coerceNumber(row[`${prefix}_coverage`]);
  const dimension = { score, grade, compliance, coverage };
  if (includeScoreScale) dimension.scoreScale = PROFILE_SCORE_SCALE;
  return dimension;
}

function dimensionHasData(dimension) {
  return (
    dimension.score !== null ||
    dimension.grade !== null ||
    dimension.compliance !== null ||
    dimension.coverage !== null
  );
}

function emptySetup(scoreScale) {
  return {
    score: null,
    grade: null,
    compliance: null,
    coverage: null,
    scoreScale: scoreScale ?? null
  };
}

// Pure resolver. `row` may be:
//   - a trade list/detail row that carries the `primary_*` join columns;
//   - a plain legacy trade row with no primary columns (source resolves
//     to 'legacy' or 'none').
function resolveQualitySummary(row) {
  if (!row) {
    return {
      source: SOURCE.NONE,
      setup: emptySetup(null),
      entry: null,
      management: null,
      profile: null
    };
  }

  const hasPrimary = row.primary_evaluation_id !== null && row.primary_evaluation_id !== undefined;

  if (hasPrimary) {
    const setup = buildProfileDimension(row, 'primary_setup', true);
    const entry = buildProfileDimension(row, 'primary_entry', false);
    const management = buildProfileDimension(row, 'primary_management', false);
    return {
      source: SOURCE.PROFILE_PRIMARY,
      setup,
      entry: dimensionHasData(entry) ? entry : null,
      management: dimensionHasData(management) ? management : null,
      profile: {
        profileId: row.primary_profile_id ?? null,
        profileName: row.primary_profile_name ?? null,
        profileVersionId: row.primary_profile_version_id ?? null,
        versionNumber: coerceNumber(row.primary_version_number),
        evaluationId: row.primary_evaluation_id,
        evaluationStatus: row.primary_evaluation_status ?? null,
        selectedAt: row.primary_selected_at ?? null
      }
    };
  }

  if (hasLegacyQuality(row)) {
    return {
      source: SOURCE.LEGACY,
      setup: {
        score: coerceNumber(row.quality_score),
        grade: coerceGrade(row.quality_grade),
        compliance: null,
        coverage: legacyCoveragePercent(row.quality_metrics),
        scoreScale: LEGACY_SCORE_SCALE
      },
      entry: null,
      management: null,
      profile: null
    };
  }

  return {
    source: SOURCE.NONE,
    setup: emptySetup(null),
    entry: null,
    management: null,
    profile: null
  };
}

// Resolves the compatibility summary for one owned trade by combining the
// trade's raw legacy fields with (at most) one primary-evaluation lookup.
// This is a single-trade detail path, not a list path; list rows resolve from
// the already-joined columns via resolveQualitySummary().
async function resolveForOwnedTrade(userId, trade) {
  if (!trade) return resolveQualitySummary(null);
  const primary = await findPrimaryEvaluation(userId, trade.id);
  return resolveQualitySummary({ ...trade, ...prefixPrimaryColumns(primary) });
}

// Resolves the compatibility summary for one owned trade id. Used by the
// Phase-5 primary mutation endpoints so a client can patch its in-memory trade
// with the backend-authoritative result immediately after select/clearPrimary
// without a second round trip or re-deriving precedence in the UI. When a
// primary exists, the legacy trade row is not even needed; when it does not,
// the legacy fields are loaded and resolution falls back to legacy/none.
async function resolveForTradeId(userId, tradeId) {
  if (!userId || !tradeId) return resolveQualitySummary(null);

  const primary = await findPrimaryEvaluation(userId, tradeId);
  if (primary) {
    return resolveQualitySummary(prefixPrimaryColumns(primary));
  }

  const result = await db.query(
    `SELECT id, quality_grade, quality_score, quality_metrics
     FROM trades
     WHERE id = $1 AND user_id = $2`,
    [tradeId, userId]
  );
  return resolveQualitySummary(result.rows[0] || null);
}

module.exports = {
  SOURCE,
  LEGACY_SCORE_SCALE,
  PROFILE_SCORE_SCALE,
  PRIMARY_PROJECTION_COLUMNS,
  primaryProjectionSql,
  primaryCompatibilityLateralSql,
  primaryListSelectSql,
  primaryListGroupBySql,
  prefixPrimaryColumns,
  effectiveSetupGradeSql,
  effectiveSetupGradeFilterSql,
  findPrimaryEvaluation,
  hasLegacyQuality,
  resolveQualitySummary,
  resolveForOwnedTrade,
  resolveForTradeId
};
