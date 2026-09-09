'use strict';

// Generic typed scoring engine for Quality Profile criterion `scoring`
// configuration (docs/QUALITY_PROFILES_REQUIREMENT.md sections 56, and the
// Canonical BO scoring sections). Pure functions; no database access.
//
// This is generic profile-scoring infrastructure, NOT a BO criterion
// evaluator. Given a criterion result's status and normalized `scoring_value`,
// it derives the numerical quality score from the immutable criterion
// `scoring` envelope so that caller-supplied scores can be validated (and
// normalized) instead of trusted.
//
// Envelope semantics (see backend/src/services/quality/validation.js):
//   binary          - PASS -> pass_score, FAIL -> fail_score (no scoring_value).
//   step            - mode 'gte': largest reached threshold; mode 'lte':
//                     smallest threshold not exceeded; else default_score.
//   piecewise_linear- linear interpolation between ascending points, clamped
//                     to endpoint scores outside the point range.
//   discrete        - score from a configured outcome key (string).
//   composite       - weighted mean of component scoring configs; component
//                     inputs are keyed by component.key. Component binary
//                     scoring takes a boolean, step/piecewise take a finite
//                     number, discrete takes an outcome-key string.
//
// UNKNOWN / NOT_APPLICABLE results never carry a numeric score. Compliance is
// independent from the numerical quality score.

const { CRITERION_STATUS } = require('./constants');

const isKnownStatus = (status) => status === CRITERION_STATUS.PASS || status === CRITERION_STATUS.FAIL;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function scoreFromBinary(scoring, pass) {
  return pass ? scoring.pass_score : scoring.fail_score;
}

function evaluateStep(scoring, value) {
  if (!isFiniteNumber(value)) {
    return { error: 'step scoring requires a finite numeric scoring_value' };
  }
  const { mode, thresholds, default_score: defaultScore } = scoring;
  if (mode === 'gte') {
    for (let index = thresholds.length - 1; index >= 0; index -= 1) {
      if (value >= thresholds[index].value) {
        return { score: thresholds[index].score };
      }
    }
  } else {
    for (let index = 0; index < thresholds.length; index += 1) {
      if (value <= thresholds[index].value) {
        return { score: thresholds[index].score };
      }
    }
  }
  return { score: defaultScore };
}

function evaluatePiecewiseLinear(scoring, value) {
  if (!isFiniteNumber(value)) {
    return { error: 'piecewise_linear scoring requires a finite numeric scoring_value' };
  }
  const points = scoring.points;
  if (value <= points[0].value) {
    return { score: points[0].score };
  }
  const last = points[points.length - 1];
  if (value >= last.value) {
    return { score: last.score };
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const lower = points[index];
    const upper = points[index + 1];
    if (value >= lower.value && value <= upper.value) {
      const span = upper.value - lower.value;
      const ratio = span === 0 ? 0 : (value - lower.value) / span;
      return { score: lower.score + ratio * (upper.score - lower.score) };
    }
  }
  return { error: 'piecewise_linear value fell outside all segments' };
}

function evaluateDiscrete(scoring, outcomeKey) {
  if (typeof outcomeKey !== 'string') {
    return { error: 'discrete scoring requires a string scoring_value (configured outcome key)' };
  }
  if (!Object.prototype.hasOwnProperty.call(scoring.scores, outcomeKey)) {
    return {
      error: `discrete scoring has no configured outcome "${outcomeKey}"`
    };
  }
  return { score: scoring.scores[outcomeKey] };
}

function evaluateComposite(scoring, componentInputs) {
  if (componentInputs === null || typeof componentInputs !== 'object' || Array.isArray(componentInputs)) {
    return { error: 'composite scoring requires a scoring_value object keyed by component' };
  }
  let totalWeight = 0;
  let weightedSum = 0;
  for (const component of scoring.components) {
    if (!Object.prototype.hasOwnProperty.call(componentInputs, component.key)) {
      return { error: `composite scoring is missing component input "${component.key}"` };
    }
    const derived = deriveComponentScore(
      component.scoring,
      componentInputs[component.key]
    );
    if (derived.error) {
      return { error: `composite component "${component.key}": ${derived.error}` };
    }
    totalWeight += component.weight;
    weightedSum += derived.score * component.weight;
  }
  if (!(totalWeight > 0)) {
    return { error: 'composite scoring component weights must have a positive usable total' };
  }
  return { score: weightedSum / totalWeight };
}

// Scores a single scoring envelope from a raw component input:
// binary -> boolean, step/piecewise_linear -> number, discrete -> string,
// composite -> nested object keyed by component.
function deriveComponentScore(scoring, input) {
  if (scoring === null || typeof scoring !== 'object') {
    return { error: 'component has no scoring configuration' };
  }
  switch (scoring.type) {
    case 'binary':
      if (typeof input !== 'boolean') {
        return { error: 'binary component scoring requires a boolean scoring_value' };
      }
      return { score: scoreFromBinary(scoring, input) };
    case 'step':
      return evaluateStep(scoring, input);
    case 'piecewise_linear':
      return evaluatePiecewiseLinear(scoring, input);
    case 'discrete':
      return evaluateDiscrete(scoring, input);
    case 'composite':
      return evaluateComposite(scoring, input);
    default:
      return { error: `unsupported scoring type "${scoring && scoring.type}"` };
  }
}

/**
 * Derives the numerical quality score for a criterion result from its
 * immutable profile `scoring` configuration.
 *
 * @param {object} params
 * @param {string} params.status - PASS/FAIL/UNKNOWN/NOT_APPLICABLE.
 * @param {object} params.scoring - criterion scoring envelope from the profile version.
 * @param {*} [params.scoringValue] - normalized scoring input: a finite number
 *   for step/piecewise_linear, an outcome-key string for discrete, an object
 *   keyed by component for composite; unused for binary.
 * @returns {{score: (number|null), error?: string}} score is null for
 *   UNKNOWN/NOT_APPLICABLE.
 */
function deriveScoreForCriterion({ status, scoring, scoringValue }) {
  if (!isKnownStatus(status)) {
    // UNKNOWN / NOT_APPLICABLE never carry a numeric score.
    return { score: null };
  }
  if (scoring === null || typeof scoring !== 'object') {
    return { error: 'criterion has no scoring configuration' };
  }
  switch (scoring.type) {
    case 'binary':
      // PASS -> pass_score, FAIL -> fail_score.
      return { score: scoreFromBinary(scoring, status === CRITERION_STATUS.PASS) };
    case 'step':
      return evaluateStep(scoring, scoringValue);
    case 'piecewise_linear':
      return evaluatePiecewiseLinear(scoring, scoringValue);
    case 'discrete':
      return evaluateDiscrete(scoring, scoringValue);
    case 'composite':
      return evaluateComposite(scoring, scoringValue);
    default:
      return { error: `unsupported scoring type "${scoring.type}"` };
  }
}

module.exports = {
  deriveScoreForCriterion,
  evaluateStep,
  evaluatePiecewiseLinear,
  evaluateDiscrete,
  evaluateComposite,
  deriveComponentScore
};
