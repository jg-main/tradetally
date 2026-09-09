'use strict';

// Setup criterion evaluator registry
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 55 and 56).
//
// Criterion keys are defined by the profile configuration (canonical keys:
// leader, prior_move, base_duration, higher_lows, range_contraction,
// volume_contraction, ma_trend, pivot_quality). The registry maps a key to a
// modular evaluator so the setup orchestrator never switches on criterion
// keys itself.

const leader = require('./criteria/setup/leader');
const priorMove = require('./criteria/setup/priorMove');
const baseDuration = require('./criteria/setup/baseDuration');
const higherLows = require('./criteria/setup/higherLows');
const rangeContraction = require('./criteria/setup/rangeContraction');
const volumeContraction = require('./criteria/setup/volumeContraction');
const maTrend = require('./criteria/setup/maTrend');
const pivotQuality = require('./criteria/setup/pivotQuality');

const EVALUATORS = Object.freeze({
  leader,
  prior_move: priorMove,
  base_duration: baseDuration,
  higher_lows: higherLows,
  range_contraction: rangeContraction,
  volume_contraction: volumeContraction,
  ma_trend: maTrend,
  pivot_quality: pivotQuality
});

const SETUP_CRITERION_KEYS = Object.freeze(Object.keys(EVALUATORS));

function hasEvaluator(key) {
  return Object.prototype.hasOwnProperty.call(EVALUATORS, key);
}

function getEvaluator(key) {
  return EVALUATORS[key] || null;
}

/**
 * Evaluates one criterion using its registered modular evaluator.
 *
 * @param {object} criterionConfig - the criterion block from the immutable
 *   profile version (key, enabled, required, weight, parameters, scoring).
 * @param {object} context - normalized evaluation context (setup boundary,
 *   confirmed context, bars, userInputs).
 * @returns {object} criterion row fragment { status, scoring_value,
 *   raw_value, evidence, message }.
 */
function evaluateCriterion(criterionConfig, context) {
  const key = criterionConfig.key;
  const evaluator = getEvaluator(key);
  if (!evaluator) {
    throw new Error(`No Setup criterion evaluator registered for key "${key}"`);
  }
  return evaluator.evaluate({
    key,
    criterion: criterionConfig,
    ...context
  });
}

module.exports = {
  SETUP_CRITERION_KEYS,
  hasEvaluator,
  getEvaluator,
  evaluateCriterion
};
