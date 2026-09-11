'use strict';

// Pairwise historical evaluation comparison (Phase 5 of
// docs/QUALITY_PROFILES_REQUIREMENT.md, sections 53 and 66).
//
// Comparison is READ-ONLY and uses ONLY the persisted snapshot of each
// evaluation (results / flattened summaries). It never re-runs a criterion,
// never re-derives a score from the current profile configuration, and never
// computes a combined Setup+Entry+Management overall quality score.
//
// Immutable profile-version configurations are read only to report WHY two
// versions differ (enabled / required / weight / parameters / scoring per
// criterion). Historical criterion absence (the criterion did not exist in one
// immutable version) is represented as an absent side, never as UNKNOWN.

const db = require('../../config/database');
const { DIMENSION_KEYS, round2 } = require('./constants');

// Reuse the history service's typed error so controllers map failures
// consistently (same 400/404 semantics).
const { QualityHistoryInputError } = require('./historyService');

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

function isNumeric(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function numericOrNull(value) {
  return isNumeric(value) ? value : null;
}

// Stable (key-sorted) JSON so two JSONB objects are compared by VALUE, not by
// the driver's key ordering.
function stableStringify(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function sameCriterionConfig(a, b) {
  const policy = (config) => ({
    enabled: config.enabled === undefined ? true : config.enabled,
    required: config.required === true,
    weight: config.weight,
    parameters: config.parameters === undefined ? null : config.parameters,
    scoring: config.scoring === undefined ? null : config.scoring
  });
  return stableStringify(policy(a)) === stableStringify(policy(b));
}

function criterionConfigurationView(config) {
  if (!config) return null;
  return {
    enabled: config.enabled === undefined ? true : config.enabled,
    required: config.required === true,
    weight: config.weight ?? null,
    parameters: config.parameters ?? null,
    scoring: config.scoring ?? null
  };
}

function enabledCriteriaByKey(version) {
  const configuration = parseJsonField(version && version.configuration);
  const byDimension = {};
  for (const dimension of DIMENSION_KEYS) {
    const dimConfig =
      configuration && configuration.dimensions ? configuration.dimensions[dimension] : null;
    const map = new Map();
    if (dimConfig && Array.isArray(dimConfig.criteria)) {
      for (const criterion of dimConfig.criteria) {
        if (!criterion || typeof criterion.key !== 'string') continue;
        map.set(criterion.key, criterion);
      }
    }
    byDimension[dimension] = map;
  }
  return byDimension;
}

function dimensionSummary(row, dimension) {
  const results = parseJsonField(row && row.results);
  const dim = results && results[dimension];
  return {
    score: dim && isNumeric(dim.score) ? dim.score : null,
    grade: dim && typeof dim.grade === 'string' ? dim.grade : null,
    compliance: dim && typeof dim.compliance === 'string' ? dim.compliance : null,
    coverage: dim && isNumeric(dim.coverage) ? dim.coverage : null
  };
}

function criterionRowsByKey(row, dimension) {
  const results = parseJsonField(row && row.results);
  const dim = results && results[dimension];
  const map = new Map();
  if (dim && Array.isArray(dim.criterionResults)) {
    for (const criterionRow of dim.criterionResults) {
      if (criterionRow && typeof criterionRow.key === 'string') {
        map.set(criterionRow.key, criterionRow);
      }
    }
  }
  return map;
}

function isEnabled(config) {
  return !!config && (config.enabled === undefined || config.enabled === true);
}

function presenceFor(leftExists, rightExists) {
  if (leftExists && rightExists) return 'both';
  if (leftExists) return 'only_left';
  if (rightExists) return 'only_right';
  return 'none';
}

// Align the criterion rows of one dimension by key. Keys are ordered by the
// left version's configured order, then any right-only keys, then any
// persisted-only keys, so removed criteria stay in place and added criteria
// append (deterministic, no alphabetical reordering of the profile's intent).
function alignCriterionKeys(leftConfigMap, rightConfigMap, leftRows, rightRows) {
  const keys = [];
  const seen = new Set();
  const push = (key) => {
    if (typeof key === 'string' && !seen.has(key)) {
      seen.add(key);
      keys.push(key);
    }
  };
  for (const key of leftConfigMap.keys()) push(key);
  for (const key of rightConfigMap.keys()) push(key);
  for (const key of leftRows.keys()) push(key);
  for (const key of rightRows.keys()) push(key);
  return keys;
}

function buildCriterionComparison(key, leftRow, rightRow, leftConfig, rightConfig) {
  const leftConfigured = isEnabled(leftConfig);
  const rightConfigured = isEnabled(rightConfig);
  const leftExists = leftConfigured || !!leftRow;
  const rightExists = rightConfigured || !!rightRow;

  let configurationChanged = null;
  if (leftConfig && rightConfig) {
    configurationChanged = !sameCriterionConfig(leftConfig, rightConfig);
  }

  const leftScore = numericOrNull(leftRow && leftRow.score);
  const rightScore = numericOrNull(rightRow && rightRow.score);
  const scoreDelta = leftScore !== null && rightScore !== null ? round2(rightScore - leftScore) : null;

  return {
    key,
    presence: presenceFor(leftExists, rightExists),
    status: {
      left: leftRow ? leftRow.status ?? null : null,
      right: rightRow ? rightRow.status ?? null : null
    },
    score: {
      left: leftScore,
      right: rightScore,
      delta: scoreDelta
    },
    scoring_value: {
      left: leftRow ? leftRow.scoringValue ?? null : null,
      right: rightRow ? rightRow.scoringValue ?? null : null
    },
    raw_value: {
      left: leftRow ? leftRow.rawValue ?? null : null,
      right: rightRow ? rightRow.rawValue ?? null : null
    },
    weight: {
      left: leftRow && leftRow.weight !== undefined ? leftRow.weight : leftConfig ? leftConfig.weight ?? null : null,
      right: rightRow && rightRow.weight !== undefined ? rightRow.weight : rightConfig ? rightConfig.weight ?? null : null
    },
    required: {
      left: leftRow && leftRow.required !== undefined
        ? leftRow.required
        : leftConfig
          ? leftConfig.required === true
          : null,
      right: rightRow && rightRow.required !== undefined
        ? rightRow.required
        : rightConfig
          ? rightConfig.required === true
          : null
    },
    enabled: { left: leftConfigured, right: rightConfigured },
    configuration_changed: configurationChanged,
    configuration: configurationChanged
      ? {
          left: criterionConfigurationView(leftConfig),
          right: criterionConfigurationView(rightConfig)
        }
      : null
  };
}

function buildDimensionComparison(dimension, leftRow, rightRow, leftMaps, rightMaps) {
  const leftSummary = dimensionSummary(leftRow, dimension);
  const rightSummary = dimensionSummary(rightRow, dimension);
  const leftRows = criterionRowsByKey(leftRow, dimension);
  const rightRows = criterionRowsByKey(rightRow, dimension);

  const keys = alignCriterionKeys(leftMaps[dimension], rightMaps[dimension], leftRows, rightRows);
  const criteria = keys.map((key) =>
    buildCriterionComparison(
      key,
      leftRows.get(key) || null,
      rightRows.get(key) || null,
      leftMaps[dimension].get(key) || null,
      rightMaps[dimension].get(key) || null
    )
  );

  return {
    dimension,
    left: leftSummary,
    right: rightSummary,
    score_delta:
      isNumeric(leftSummary.score) && isNumeric(rightSummary.score)
        ? round2(rightSummary.score - leftSummary.score)
        : null,
    coverage_delta:
      isNumeric(leftSummary.coverage) && isNumeric(rightSummary.coverage)
        ? round2(rightSummary.coverage - leftSummary.coverage)
        : null,
    criteria
  };
}

function evaluationMetadata(row) {
  return {
    evaluation_id: row.id,
    status: row.status,
    is_primary: row.is_primary === true,
    is_current_version: row.is_current_version === true,
    profile_id: row.profile_id,
    profile_name: row.profile_name,
    profile_version_id: row.profile_version_id,
    version_number: row.version_number,
    schema_version: row.schema_version,
    evaluated_at: row.evaluated_at,
    created_at: row.created_at
  };
}

const COMPARISON_EVALUATION_SELECT = `
  e.id,
  e.status,
  e.trade_id,
  e.profile_version_id,
  e.results,
  e.evaluated_at,
  e.created_at,
  v.version_number,
  v.schema_version,
  v.configuration,
  p.id AS profile_id,
  p.name AS profile_name,
  p.current_version_id,
  (e.profile_version_id = p.current_version_id) AS is_current_version,
  (pe.evaluation_id IS NOT NULL) AS is_primary
`;

async function loadComparisonEvaluation(userId, tradeId, evaluationId) {
  const result = await db.query(
    `
      SELECT ${COMPARISON_EVALUATION_SELECT}
      FROM trade_quality_evaluations e
      JOIN quality_profile_versions v ON v.id = e.profile_version_id
      JOIN quality_profiles p ON p.id = v.profile_id
      LEFT JOIN trade_quality_primary_evaluations pe ON pe.evaluation_id = e.id
      WHERE e.id = $1 AND e.user_id = $2 AND e.trade_id = $3
    `,
    [evaluationId, userId, tradeId]
  );
  return result.rows[0] || null;
}

/**
 * Builds a pairwise comparison of two evaluations of the SAME trade.
 *
 * Both evaluations must belong to `userId` and to `tradeId`; a missing or
 * foreign evaluation yields the same EVALUATION_NOT_FOUND error so existence is
 * not leaked. Reads persisted snapshots and immutable version configurations
 * only.
 */
async function compareEvaluations(userId, tradeId, leftId, rightId) {
  if (!leftId || !rightId) {
    throw new QualityHistoryInputError(
      'Both left and right evaluation ids are required for comparison.',
      'COMPARISON_IDS_REQUIRED'
    );
  }

  const [leftRow, rightRow] = await Promise.all([
    loadComparisonEvaluation(userId, tradeId, leftId),
    loadComparisonEvaluation(userId, tradeId, rightId)
  ]);

  if (!leftRow || !rightRow) {
    throw new QualityHistoryInputError(
      'One or both evaluations were not found for this trade.',
      'EVALUATION_NOT_FOUND'
    );
  }

  const leftMaps = enabledCriteriaByKey(leftRow);
  const rightMaps = enabledCriteriaByKey(rightRow);

  const dimensions = {};
  for (const dimension of DIMENSION_KEYS) {
    dimensions[dimension] = buildDimensionComparison(dimension, leftRow, rightRow, leftMaps, rightMaps);
  }

  return {
    trade_id: tradeId,
    left: evaluationMetadata(leftRow),
    right: evaluationMetadata(rightRow),
    dimensions
  };
}

module.exports = {
  compareEvaluations,
  // exposed for focused unit tests
  stableStringify,
  sameCriterionConfig,
  alignCriterionKeys,
  buildCriterionComparison,
  buildDimensionComparison,
  dimensionSummary
};
