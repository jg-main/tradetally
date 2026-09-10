'use strict';

// Shared helpers for Entry criterion evaluators
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 22-32, 55-56).
//
// Every evaluator returns a "criterion row fragment":
//   { status, scoring_value, raw_value, evidence, message }
// The Entry orchestrator derives the authoritative numerical `score` from the
// immutable profile-version `scoring` envelope using the Phase 1 scoring
// engine (backend/src/services/quality/scoring.js) — criteria never compute
// their own scoring curves.

const { CRITERION_STATUS } = require('../../constants');

function hasOwn(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

// Requires a numeric profile parameter so trading-policy values are never
// hard-coded inside evaluator code. A misconfigured profile surfaces an
// explicit error instead of silently substituting a canonical value.
function requireNumberParameter(parameters, key, label) {
  if (!hasOwn(parameters, key)) {
    throw new Error(`Entry criterion ${label} is missing required parameter "${key}"`);
  }
  const value = parameters[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Entry criterion ${label} parameter "${key}" must be a finite number`);
  }
  return value;
}

function requireStringParameter(parameters, key, label) {
  if (!hasOwn(parameters, key) || typeof parameters[key] !== 'string') {
    throw new Error(`Entry criterion ${label} parameter "${key}" must be a string`);
  }
  return parameters[key];
}

function requireBooleanParameter(parameters, key, label) {
  if (!hasOwn(parameters, key) || typeof parameters[key] !== 'boolean') {
    throw new Error(`Entry criterion ${label} parameter "${key}" must be a boolean`);
  }
  return parameters[key];
}

function requireArrayParameter(parameters, key, label) {
  if (!hasOwn(parameters, key) || !Array.isArray(parameters[key]) || parameters[key].length === 0) {
    throw new Error(`Entry criterion ${label} parameter "${key}" must be a non-empty array`);
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

module.exports = {
  hasOwn,
  requireNumberParameter,
  requireStringParameter,
  requireBooleanParameter,
  requireArrayParameter,
  unknownResult
};
