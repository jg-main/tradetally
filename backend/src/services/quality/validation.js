'use strict';

// Structural validation for Quality Profile configuration (spec sections 2,
// 5.2, 56). Pure functions; no database access.
//
// Validation covers the generic profile/version envelope and the common
// typed scoring envelope. Criterion-specific parameter semantics belong to
// Phase 2+ evaluators and are intentionally not validated here. This module
// does not implement any evaluator, detector, or rule DSL.

const {
  DIMENSION_KEYS,
  MAX_SCORE,
  MISSING_DATA_BEHAVIOR_VALUES,
  SCORING_TYPES
} = require('./constants');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteScore(value) {
  return isFiniteNumber(value) && value >= 0 && value <= MAX_SCORE;
}

function assertFiniteScore(value, label) {
  if (!isFiniteScore(value)) {
    throw new Error(`${label} must be a finite number between 0 and ${MAX_SCORE}`);
  }
}

function assertStrictlyAscending(values, label) {
  for (let i = 1; i < values.length; i += 1) {
    if (!(values[i] > values[i - 1])) {
      throw new Error(`${label} values must be strictly ascending`);
    }
  }
}

function assertScoringConfig(scoring, label, depth = 0) {
  if (!isObject(scoring)) {
    throw new Error(`${label} scoring must be an object`);
  }
  if (typeof scoring.type !== 'string' || !SCORING_TYPES.includes(scoring.type)) {
    throw new Error(
      `${label} scoring.type must be one of ${SCORING_TYPES.join(', ')}; got ${JSON.stringify(scoring.type)}`
    );
  }
  if (depth > 4) {
    throw new Error(`${label} scoring composite nesting is too deep`);
  }

  switch (scoring.type) {
    case 'binary':
      assertFiniteScore(scoring.pass_score, `${label} scoring.pass_score`);
      assertFiniteScore(scoring.fail_score, `${label} scoring.fail_score`);
      return;
    case 'step': {
      if (scoring.mode !== 'gte' && scoring.mode !== 'lte') {
        throw new Error(`${label} scoring.mode must be 'gte' or 'lte'`);
      }
      assertFiniteScore(scoring.default_score, `${label} scoring.default_score`);
      if (!Array.isArray(scoring.thresholds) || scoring.thresholds.length === 0) {
        throw new Error(`${label} scoring.thresholds must be a non-empty array`);
      }
      const values = scoring.thresholds.map((threshold, index) => {
        if (!isObject(threshold)) {
          throw new Error(`${label} scoring.thresholds[${index}] must be an object`);
        }
        if (!isFiniteNumber(threshold.value)) {
          throw new Error(`${label} scoring.thresholds[${index}].value must be a finite number`);
        }
        assertFiniteScore(threshold.score, `${label} scoring.thresholds[${index}].score`);
        return threshold.value;
      });
      assertStrictlyAscending(values, `${label} scoring.thresholds`);
      return;
    }
    case 'piecewise_linear': {
      if (!Array.isArray(scoring.points) || scoring.points.length === 0) {
        throw new Error(`${label} scoring.points must be a non-empty array`);
      }
      const values = scoring.points.map((point, index) => {
        if (!isObject(point)) {
          throw new Error(`${label} scoring.points[${index}] must be an object`);
        }
        if (!isFiniteNumber(point.value)) {
          throw new Error(`${label} scoring.points[${index}].value must be a finite number`);
        }
        assertFiniteScore(point.score, `${label} scoring.points[${index}].score`);
        return point.value;
      });
      assertStrictlyAscending(values, `${label} scoring.points`);
      return;
    }
    case 'discrete': {
      if (!isObject(scoring.scores) || Object.keys(scoring.scores).length === 0) {
        throw new Error(`${label} scoring.scores must be a non-empty object`);
      }
      for (const [outcome, score] of Object.entries(scoring.scores)) {
        if (typeof outcome !== 'string' || outcome.trim() === '') {
          throw new Error(`${label} scoring.scores keys must be non-empty strings`);
        }
        assertFiniteScore(score, `${label} scoring.scores.${outcome}`);
      }
      return;
    }
    case 'composite': {
      if (!Array.isArray(scoring.components) || scoring.components.length === 0) {
        throw new Error(`${label} scoring.components must be a non-empty array`);
      }
      const seenKeys = new Set();
      scoring.components.forEach((component, index) => {
        if (!isObject(component)) {
          throw new Error(`${label} scoring.components[${index}] must be an object`);
        }
        if (typeof component.key !== 'string' || component.key.trim() === '') {
          throw new Error(`${label} scoring.components[${index}] requires a non-empty key`);
        }
        if (seenKeys.has(component.key)) {
          throw new Error(`${label} scoring.components contains duplicate key "${component.key}"`);
        }
        seenKeys.add(component.key);
        if (!isFiniteNumber(component.weight) || component.weight < 0) {
          throw new Error(
            `${label} scoring.components.${component.key}.weight must be a non-negative finite number`
          );
        }
        assertScoringConfig(component.scoring, `${label} scoring.components.${component.key}`, depth + 1);
      });
      return;
    }
    default:
      throw new Error(`${label} scoring.type is not supported`);
  }
}

// Common per-criterion envelope: key, enabled, required, weight, parameters,
// scoring, and missing_data_behavior. Trading-policy thresholds live in this
// configuration; evaluator types interpret them.
function assertCriterionCommonConfig(criterion, index) {
  if (!isObject(criterion)) {
    throw new Error(`criteria[${index}] must be an object`);
  }
  const label = criterion && typeof criterion.key === 'string' ? `criterion "${criterion.key}"` : `criteria[${index}]`;

  if (typeof criterion.key !== 'string' || criterion.key.trim() === '') {
    throw new Error(`${label} requires a non-empty key`);
  }
  if (criterion.enabled !== undefined && typeof criterion.enabled !== 'boolean') {
    throw new Error(`${label} enabled must be a boolean`);
  }
  if (criterion.required !== undefined && typeof criterion.required !== 'boolean') {
    throw new Error(`${label} required must be a boolean`);
  }
  if (criterion.enabled === undefined || criterion.enabled === true) {
    const weight = criterion.weight;
    if (!isFiniteNumber(weight) || weight < 0) {
      throw new Error(`${label} weight must be a non-negative finite number`);
    }
  }
  if (criterion.parameters !== undefined && !isObject(criterion.parameters)) {
    throw new Error(`${label} parameters must be an object`);
  }
  if (criterion.scoring !== undefined && criterion.scoring !== null) {
    assertScoringConfig(criterion.scoring, label);
  }
  if (
    criterion.missing_data_behavior !== undefined &&
    criterion.missing_data_behavior !== null &&
    !MISSING_DATA_BEHAVIOR_VALUES.includes(criterion.missing_data_behavior)
  ) {
    throw new Error(
      `${label} missing_data_behavior must be one of ${MISSING_DATA_BEHAVIOR_VALUES.join(', ')}`
    );
  }
}

function assertDimensionConfig(dimensionConfig) {
  if (!isObject(dimensionConfig)) {
    throw new Error('dimension configuration must be an object');
  }
  if (!Array.isArray(dimensionConfig.criteria)) {
    throw new Error('dimension configuration requires a criteria array');
  }
  const seenKeys = new Set();
  dimensionConfig.criteria.forEach((criterion, index) => {
    assertCriterionCommonConfig(criterion, index);
    if (seenKeys.has(criterion.key)) {
      throw new Error(`dimension configuration contains duplicate criterion key "${criterion.key}"`);
    }
    seenKeys.add(criterion.key);
  });
}

function assertGradeThresholds(thresholds, label) {
  if (!isObject(thresholds)) {
    throw new Error(`${label} grade_thresholds must be an object`);
  }
  for (const grade of ['A', 'B', 'C', 'D']) {
    if (typeof thresholds[grade] !== 'number' || !Number.isFinite(thresholds[grade])) {
      throw new Error(`${label} grade_thresholds.${grade} must be a finite number`);
    }
    if (thresholds[grade] < 0 || thresholds[grade] > MAX_SCORE) {
      throw new Error(`${label} grade_thresholds.${grade} must be between 0 and ${MAX_SCORE}`);
    }
  }
  if (!(thresholds.A > thresholds.B && thresholds.B > thresholds.C && thresholds.C > thresholds.D)) {
    throw new Error(`${label} grade_thresholds must satisfy A > B > C > D`);
  }
}

// Validates a complete profile version configuration (spec section 5.2):
// dimensions are restricted to setup/entry/management with at least one
// present; minimum_coverage is a finite percentage in 0..100 when supplied;
// grade_thresholds, when supplied, are complete, finite, in 0..100, and
// strictly ordered A > B > C > D; every configured dimension holds a valid
// criteria array (unique keys, typed envelope, valid scoring when present).
function assertProfileVersionConfiguration(configuration) {
  if (!isObject(configuration)) {
    throw new Error('profile version configuration must be an object');
  }
  const dimensions = configuration.dimensions;
  if (!isObject(dimensions)) {
    throw new Error('profile version configuration requires a dimensions object');
  }
  const configuredKeys = Object.keys(dimensions);
  if (configuredKeys.length === 0) {
    throw new Error('profile version configuration must define at least one dimension');
  }
  for (const dimension of configuredKeys) {
    if (!DIMENSION_KEYS.includes(dimension)) {
      throw new Error(
        `unknown dimension "${dimension}"; allowed dimensions are ${DIMENSION_KEYS.join(', ')}`
      );
    }
    const dimConfig = dimensions[dimension];
    if (!isObject(dimConfig)) {
      throw new Error(`dimension "${dimension}" must be an object`);
    }
    if (dimConfig.minimum_coverage !== undefined) {
      if (!isFiniteNumber(dimConfig.minimum_coverage)) {
        throw new Error(`dimension "${dimension}" minimum_coverage must be a finite number`);
      }
      if (dimConfig.minimum_coverage < 0 || dimConfig.minimum_coverage > MAX_SCORE) {
        throw new Error(`dimension "${dimension}" minimum_coverage must be between 0 and ${MAX_SCORE}`);
      }
    }
    if (dimConfig.grade_thresholds !== undefined) {
      assertGradeThresholds(dimConfig.grade_thresholds, `dimension "${dimension}"`);
    }
    assertDimensionConfig(dimConfig);

    // The profile scoring configuration is the authoritative source of
    // numerical criterion scores. Every enabled criterion that carries
    // positive quality weight must declare an explicit scoring envelope;
    // zero-weight criteria may be scoreless (non-scoring evidence).
    for (const criterion of dimConfig.criteria) {
      const enabled = criterion.enabled !== undefined ? criterion.enabled : true;
      if (
        enabled &&
        typeof criterion.weight === 'number' &&
        criterion.weight > 0 &&
        (criterion.scoring === undefined || criterion.scoring === null)
      ) {
        throw new Error(
          `dimension "${dimension}" criterion "${criterion.key}" has positive weight but no scoring configuration`
        );
      }
    }
  }
}

module.exports = {
  assertScoringConfig,
  assertCriterionCommonConfig,
  assertDimensionConfig,
  assertGradeThresholds,
  assertProfileVersionConfiguration
};
