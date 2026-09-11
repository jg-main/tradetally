'use strict';

// Shared helpers for Management criterion evaluators
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 33-46, 56).
//
// Every evaluator returns a "criterion row fragment":
//   { status, scoring_value, raw_value, evidence, message }
// The Management orchestrator derives the authoritative numerical `score` from
// the immutable profile-version `scoring` envelope using the Phase 1 scoring
// engine — criteria never compute their own scoring curves.

const { CRITERION_STATUS } = require('../../constants');

function hasOwn(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

function requireNumberParameter(parameters, key, label) {
  if (!hasOwn(parameters, key) || typeof parameters[key] !== 'number' || !Number.isFinite(parameters[key])) {
    throw new Error(`Management criterion ${label} parameter "${key}" must be a finite number`);
  }
  return parameters[key];
}

function requireIntegerParameter(parameters, key, label) {
  if (!hasOwn(parameters, key) || !Number.isInteger(parameters[key])) {
    throw new Error(`Management criterion ${label} parameter "${key}" must be an integer`);
  }
  return parameters[key];
}

function unknownResult(message, evidence = null) {
  return {
    status: CRITERION_STATUS.UNKNOWN,
    scoring_value: null,
    raw_value: null,
    evidence,
    message
  };
}

function notApplicableResult(message, evidence = null) {
  return {
    status: CRITERION_STATUS.NOT_APPLICABLE,
    scoring_value: null,
    raw_value: null,
    evidence,
    message
  };
}

module.exports = {
  hasOwn,
  requireNumberParameter,
  requireIntegerParameter,
  unknownResult,
  notApplicableResult
};
