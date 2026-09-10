'use strict';

// Entry criterion evaluator registry
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 22, 55-56).
//
// Criterion keys are defined by the profile configuration (canonical keys:
// breakout_session, trigger_compliance, volume_pace, range_pace,
// entry_extension, initial_stop, stop_width). The registry maps a key to a
// modular evaluator so the Entry orchestrator never switches on criterion keys
// itself.

const breakoutSession = require('./criteria/entry/breakoutSession');
const triggerCompliance = require('./criteria/entry/triggerCompliance');
const volumePace = require('./criteria/entry/volumePace');
const rangePace = require('./criteria/entry/rangePace');
const entryExtension = require('./criteria/entry/extension');
const initialStop = require('./criteria/entry/initialStop');
const stopWidth = require('./criteria/entry/stopWidth');

const ENTRY_EVALUATORS = Object.freeze({
  breakout_session: breakoutSession,
  trigger_compliance: triggerCompliance,
  volume_pace: volumePace,
  range_pace: rangePace,
  entry_extension: entryExtension,
  initial_stop: initialStop,
  stop_width: stopWidth
});

const ENTRY_CRITERION_KEYS = Object.freeze(Object.keys(ENTRY_EVALUATORS));

function hasEntryEvaluator(key) {
  return Object.prototype.hasOwnProperty.call(ENTRY_EVALUATORS, key);
}

function getEntryEvaluator(key) {
  return ENTRY_EVALUATORS[key] || null;
}

/**
 * Evaluates one Entry criterion using its registered modular evaluator.
 *
 * @param {object} criterionConfig - criterion block from the immutable profile
 *   version (key, enabled, required, weight, parameters, scoring).
 * @param {object} context - normalized Entry context (setup boundary, resolved
 *   trigger, execution evidence, volatility, intraday metrics, stop/buffer).
 * @returns {object} criterion row fragment { status, scoring_value, raw_value,
 *   evidence, message }.
 */
function evaluateEntryCriterion(criterionConfig, context) {
  const key = criterionConfig.key;
  const evaluator = getEntryEvaluator(key);
  if (!evaluator) {
    throw new Error(`No Entry criterion evaluator registered for key "${key}"`);
  }
  return evaluator.evaluate({
    key,
    criterion: criterionConfig,
    ...context
  });
}

module.exports = {
  ENTRY_CRITERION_KEYS,
  hasEntryEvaluator,
  getEntryEvaluator,
  evaluateEntryCriterion
};
