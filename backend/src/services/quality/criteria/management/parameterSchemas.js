'use strict';

// Typed Management criterion parameter validation
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 33-45, 63).
//
// Every implemented Management evaluator/helper is declared here with the exact
// type it interprets. Trading-policy limits remain profile configuration; this
// module never invents limits. A required parameter is always present in the
// canonical seed and is never silently defaulted in code.

const SUPPORTED_TRAILING_PERIODS = Object.freeze([10, 20]);
const SUPPORTED_COMPLETION_WINDOWS = Object.freeze(['same_session']);
const SUPPORTED_BE_DEADLINES = Object.freeze(['same_session']);
const SUPPORTED_MINIMUM_STOPS = Object.freeze(['original_entry_basis']);
const SUPPORTED_EXIT_SIGNALS = Object.freeze(['first_daily_close_below_selected_ma']);
const SUPPORTED_TRADE_LEVEL_SELECTIONS = Object.freeze(['required']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    return `${label} must be a positive integer; got ${JSON.stringify(value)}`;
  }
  return null;
}

function checkNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    return `${label} must be a non-negative integer; got ${JSON.stringify(value)}`;
  }
  return null;
}

function checkNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return `${label} must be a finite non-negative number; got ${JSON.stringify(value)}`;
  }
  return null;
}

function checkPositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return `${label} must be a finite positive number; got ${JSON.stringify(value)}`;
  }
  return null;
}

function checkBoolean(value, label) {
  if (typeof value !== 'boolean') {
    return `${label} must be a boolean; got ${JSON.stringify(value)}`;
  }
  return null;
}

function checkEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return `${label} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`;
  }
  return null;
}

function checkPeriodArray(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0) {
    return `${label} must be a non-empty array of supported periods`;
  }
  for (const entry of value) {
    if (!allowed.includes(entry)) {
      return `${label} contains unsupported period ${JSON.stringify(entry)}; supported: ${allowed.join(', ')}`;
    }
  }
  return null;
}

const PARAMETER_SCHEMAS = {
  partial_timing: {
    earliest_day: { kind: 'positiveInteger' },
    latest_day: { kind: 'positiveInteger' },
    minimum_mfe_r: { kind: 'positiveNumber' },
    completion_window: { kind: 'enum', allowed: SUPPORTED_COMPLETION_WINDOWS }
  },
  partial_sizing: {
    target_pct: { kind: 'positiveNumber' },
    target_tolerance_pct: { kind: 'nonNegativeNumber' }
  },
  no_premature_reduction: {},
  stop_ratchet: {
    downward_tolerance_ticks: { kind: 'nonNegativeInteger' }
  },
  post_partial_breakeven: {
    minimum_stop: { kind: 'enum', allowed: SUPPORTED_MINIMUM_STOPS },
    deadline: { kind: 'enum', allowed: SUPPORTED_BE_DEADLINES }
  },
  trailing_ma: {
    allowed_periods: { kind: 'periodArray', allowed: SUPPORTED_TRAILING_PERIODS },
    trade_level_selection: { kind: 'enum', allowed: SUPPORTED_TRADE_LEVEL_SELECTIONS },
    exit_signal: { kind: 'enum', allowed: SUPPORTED_EXIT_SIGNALS },
    equality_triggers: { kind: 'boolean' },
    execution_window_minutes: { kind: 'positiveInteger' }
  }
};

function validateParameters(key, parameters) {
  const errors = [];
  if (!isObject(parameters)) {
    return [`criterion "${key}" parameters must be an object`];
  }
  const schema = PARAMETER_SCHEMAS[key];
  if (!schema) return errors;
  for (const [paramName, spec] of Object.entries(schema)) {
    const label = `criterion "${key}" parameter "${paramName}"`;
    if (!Object.prototype.hasOwnProperty.call(parameters, paramName)) {
      errors.push(`${label} is required`);
      continue;
    }
    const value = parameters[paramName];
    let error = null;
    switch (spec.kind) {
      case 'positiveInteger':
        error = checkPositiveInteger(value, label);
        break;
      case 'nonNegativeInteger':
        error = checkNonNegativeInteger(value, label);
        break;
      case 'nonNegativeNumber':
        error = checkNonNegativeNumber(value, label);
        break;
      case 'positiveNumber':
        error = checkPositiveNumber(value, label);
        break;
      case 'boolean':
        error = checkBoolean(value, label);
        break;
      case 'enum':
        error = checkEnum(value, spec.allowed, label);
        break;
      case 'periodArray':
        error = checkPeriodArray(value, spec.allowed, label);
        break;
      default:
        break;
    }
    if (error) errors.push(error);
  }
  return errors;
}

// Cross-field structural invariant: partial_timing's day window must be
// well-ordered (earliest <= latest). Trading-policy values are still
// configurable; this only rejects an impossible window.
function validateCrossField(managementConfig) {
  const errors = [];
  const partialTiming = managementConfig.criteria.find((c) => c.key === 'partial_timing');
  if (partialTiming && partialTiming.parameters) {
    const { earliest_day, latest_day } = partialTiming.parameters;
    if (Number.isInteger(earliest_day) && Number.isInteger(latest_day) && earliest_day > latest_day) {
      errors.push('criterion "partial_timing" earliest_day must be <= latest_day');
    }
  }
  return errors;
}

/**
 * Validates the Management dimension criteria of a profile version. Only
 * ENABLED criteria are enforced. Returns an array of violation strings.
 */
function validateManagementCriteria(managementConfig) {
  const errors = [];
  if (!managementConfig || !Array.isArray(managementConfig.criteria)) return errors;
  for (const criterion of managementConfig.criteria) {
    const enabled = criterion.enabled === undefined ? true : criterion.enabled;
    if (!enabled) continue;
    errors.push(...validateParameters(criterion.key, criterion.parameters));
  }
  errors.push(...validateCrossField(managementConfig));
  return errors;
}

module.exports = {
  PARAMETER_SCHEMAS,
  SUPPORTED_TRAILING_PERIODS,
  validateParameters,
  validateManagementCriteria
};
