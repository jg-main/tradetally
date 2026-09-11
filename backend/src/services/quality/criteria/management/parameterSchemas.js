'use strict';

// Typed Management criterion parameter validation
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 33-45, 63).
//
// Every parameter an evaluator/helper interprets is declared here with the exact
// type it accepts. Trading-policy limits remain profile configuration; this
// module never invents limits. Parameters marked `optional` support immutable
// profile versions created before the Phase-4 hardening (e.g. the
// `target_tolerance_pct` compatibility parameter); their absence is handled
// deterministically by the policy resolver, never by a hidden canonical value.

const { resolveSessionWindow } = require('../../management/sessionWindow');

const SUPPORTED_TRAILING_PERIODS = Object.freeze([10, 20]);
const SUPPORTED_MINIMUM_STOPS = Object.freeze(['original_entry_basis']);
const SUPPORTED_EXIT_SIGNALS = Object.freeze(['first_daily_close_below_selected_ma']);
const SUPPORTED_TRADE_LEVEL_SELECTIONS = Object.freeze(['required']);
const SUPPORTED_ACTIVATIONS = Object.freeze(['after_partial', 'immediate', 'explicit']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) return `${label} must be a positive integer; got ${JSON.stringify(value)}`;
  return null;
}
function checkNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) return `${label} must be a non-negative integer; got ${JSON.stringify(value)}`;
  return null;
}
function checkNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return `${label} must be a finite non-negative number; got ${JSON.stringify(value)}`;
  return null;
}
function checkPositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return `${label} must be a finite positive number; got ${JSON.stringify(value)}`;
  return null;
}
function checkBoolean(value, label) {
  if (typeof value !== 'boolean') return `${label} must be a boolean; got ${JSON.stringify(value)}`;
  return null;
}
function checkEnum(value, allowed, label) {
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return `${label} must be one of ${allowed.join(', ')}; got ${JSON.stringify(value)}`;
  }
  return null;
}
function checkPeriodArray(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0) return `${label} must be a non-empty array of supported periods`;
  for (const entry of value) {
    if (!allowed.includes(entry)) return `${label} contains unsupported period ${JSON.stringify(entry)}; supported: ${allowed.join(', ')}`;
  }
  return null;
}
function checkSessionWindow(value, label) {
  const resolved = resolveSessionWindow(value);
  if (!resolved.valid) return `${label} ${resolved.error}`;
  return null;
}

const PARAMETER_SCHEMAS = {
  partial_timing: {
    earliest_day: { kind: 'positiveInteger' },
    latest_day: { kind: 'positiveInteger' },
    minimum_mfe_r: { kind: 'positiveNumber' },
    completion_window: { kind: 'sessionWindow' }
  },
  partial_sizing: {
    target_pct: { kind: 'positiveNumber' },
    target_tolerance_pct: { kind: 'nonNegativeNumber', optional: true }
  },
  no_premature_reduction: {},
  stop_ratchet: {
    downward_tolerance_ticks: { kind: 'nonNegativeInteger' }
  },
  post_partial_breakeven: {
    minimum_stop: { kind: 'enum', allowed: SUPPORTED_MINIMUM_STOPS },
    deadline: { kind: 'sessionWindow' }
  },
  trailing_ma: {
    allowed_periods: { kind: 'periodArray', allowed: SUPPORTED_TRAILING_PERIODS },
    trade_level_selection: { kind: 'enum', allowed: SUPPORTED_TRADE_LEVEL_SELECTIONS },
    exit_signal: { kind: 'enum', allowed: SUPPORTED_EXIT_SIGNALS },
    equality_triggers: { kind: 'boolean' },
    execution_window_minutes: { kind: 'positiveInteger' },
    activation: { kind: 'enum', allowed: SUPPORTED_ACTIVATIONS, optional: true }
  }
};

function validateParameters(key, parameters) {
  const errors = [];
  if (!isObject(parameters)) return [`criterion "${key}" parameters must be an object`];
  const schema = PARAMETER_SCHEMAS[key];
  if (!schema) return errors;
  for (const [paramName, spec] of Object.entries(schema)) {
    const label = `criterion "${key}" parameter "${paramName}"`;
    if (!Object.prototype.hasOwnProperty.call(parameters, paramName)) {
      if (spec.optional) continue;
      errors.push(`${label} is required`);
      continue;
    }
    const value = parameters[paramName];
    let error = null;
    switch (spec.kind) {
      case 'positiveInteger': error = checkPositiveInteger(value, label); break;
      case 'nonNegativeInteger': error = checkNonNegativeInteger(value, label); break;
      case 'nonNegativeNumber': error = checkNonNegativeNumber(value, label); break;
      case 'positiveNumber': error = checkPositiveNumber(value, label); break;
      case 'boolean': error = checkBoolean(value, label); break;
      case 'enum': error = checkEnum(value, spec.allowed, label); break;
      case 'periodArray': error = checkPeriodArray(value, spec.allowed, label); break;
      case 'sessionWindow': error = checkSessionWindow(value, label); break;
      default: break;
    }
    if (error) errors.push(error);
  }
  return errors;
}

// Validates the optional explicit shared-policy block. The block is what lets a
// profile disable a scored policy-owning criterion while another dependent
// criterion still has an explicit, typed trigger/target/window policy.
function validatePolicyBlock(policy) {
  const errors = [];
  if (policy === undefined || policy === null) return errors;
  if (!isObject(policy)) return ['criterion "management.policy" must be an object'];
  if (policy.partial_trigger !== undefined) {
    const trigger = policy.partial_trigger;
    if (!isObject(trigger)) {
      errors.push('management.policy.partial_trigger must be an object');
    } else {
      const e1 = checkPositiveInteger(trigger.earliest_day, 'management.policy.partial_trigger.earliest_day');
      const e2 = checkPositiveInteger(trigger.latest_day, 'management.policy.partial_trigger.latest_day');
      const e3 = checkPositiveNumber(trigger.minimum_mfe_r, 'management.policy.partial_trigger.minimum_mfe_r');
      if (e1) errors.push(e1);
      if (e2) errors.push(e2);
      if (e3) errors.push(e3);
      if (Number.isInteger(trigger.earliest_day) && Number.isInteger(trigger.latest_day) && trigger.earliest_day > trigger.latest_day) {
        errors.push('management.policy.partial_trigger earliest_day must be <= latest_day');
      }
      if (trigger.completion_window !== undefined) {
        const e4 = checkSessionWindow(trigger.completion_window, 'management.policy.partial_trigger.completion_window');
        if (e4) errors.push(e4);
      }
    }
  }
  if (policy.partial_target !== undefined) {
    const target = policy.partial_target;
    if (!isObject(target)) {
      errors.push('management.policy.partial_target must be an object');
    } else {
      const e1 = checkPositiveNumber(target.target_pct, 'management.policy.partial_target.target_pct');
      if (e1) errors.push(e1);
      if (target.target_tolerance_pct !== undefined) {
        const e2 = checkNonNegativeNumber(target.target_tolerance_pct, 'management.policy.partial_target.target_tolerance_pct');
        if (e2) errors.push(e2);
      }
    }
  }
  if (policy.completion_window !== undefined) {
    const e = checkSessionWindow(policy.completion_window, 'management.policy.completion_window');
    if (e) errors.push(e);
  }
  if (policy.execution_window_minutes !== undefined) {
    const e = checkPositiveInteger(policy.execution_window_minutes, 'management.policy.execution_window_minutes');
    if (e) errors.push(e);
  }
  if (policy.trailing_activation !== undefined) {
    const e = checkEnum(policy.trailing_activation, SUPPORTED_ACTIVATIONS, 'management.policy.trailing_activation');
    if (e) errors.push(e);
  }
  return errors;
}

function validateCrossField(managementConfig) {
  const errors = [];
  const partialTiming = managementConfig.criteria.find((c) => c.key === 'partial_timing');
  if (partialTiming && partialTiming.enabled !== false && partialTiming.parameters) {
    const { earliest_day, latest_day } = partialTiming.parameters;
    if (Number.isInteger(earliest_day) && Number.isInteger(latest_day) && earliest_day > latest_day) {
      errors.push('criterion "partial_timing" earliest_day must be <= latest_day');
    }
  }
  errors.push(...validatePolicyBlock(managementConfig.policy));
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
  SUPPORTED_ACTIVATIONS,
  validateParameters,
  validatePolicyBlock,
  validateManagementCriteria
};
