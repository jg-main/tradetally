'use strict';

// Management criterion evaluator registry
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 33, 55-56).
//
// Maps profile-configuration criterion keys to modular evaluators so the
// Management orchestrator never switches on criterion keys itself.

const partialTiming = require('./criteria/management/partialTiming');
const partialSizing = require('./criteria/management/partialSizing');
const prematureReduction = require('./criteria/management/prematureReduction');
const stopRatchet = require('./criteria/management/stopRatchet');
const breakevenProtection = require('./criteria/management/breakevenProtection');
const trailingMA = require('./criteria/management/trailingMA');

const MANAGEMENT_EVALUATORS = Object.freeze({
  partial_timing: partialTiming,
  partial_sizing: partialSizing,
  no_premature_reduction: prematureReduction,
  stop_ratchet: stopRatchet,
  post_partial_breakeven: breakevenProtection,
  trailing_ma: trailingMA
});

const MANAGEMENT_CRITERION_KEYS = Object.freeze(Object.keys(MANAGEMENT_EVALUATORS));

function hasManagementEvaluator(key) {
  return Object.prototype.hasOwnProperty.call(MANAGEMENT_EVALUATORS, key);
}

function getManagementEvaluator(key) {
  return MANAGEMENT_EVALUATORS[key] || null;
}

/**
 * Evaluates one Management criterion using its registered modular evaluator.
 *
 * @param {object} criterionConfig - criterion block from the immutable profile version.
 * @param {object} context - normalized Management context (managementState + userInputs).
 * @returns {object} criterion row fragment { status, scoring_value, raw_value, evidence, message }.
 */
function evaluateManagementCriterion(criterionConfig, context) {
  const key = criterionConfig.key;
  const evaluator = getManagementEvaluator(key);
  if (!evaluator) {
    throw new Error(`No Management criterion evaluator registered for key "${key}"`);
  }
  return evaluator.evaluate({
    key,
    criterion: criterionConfig,
    ...context
  });
}

module.exports = {
  MANAGEMENT_CRITERION_KEYS,
  hasManagementEvaluator,
  getManagementEvaluator,
  evaluateManagementCriterion
};
