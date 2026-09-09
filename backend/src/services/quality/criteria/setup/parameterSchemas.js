'use strict';

// Typed Setup criterion parameter validation
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 55-56 and the Phase 2
// hardening requirement that criterion-specific parameter semantics are
// enforced, not just "finite numbers").
//
// Every implemented evaluator/detector is declared here with the exact type it
// interprets:
//   positiveInteger  - whole numbers >= 1 (windows, lookbacks, periods,
//                      minimum session/touch/low counts)
//   nonNegativeNumber - finite >= 0 (tolerances, percentages, maximum ratios)
//   boolean          - strict boolean
//   enum             - exactly one of the listed policy strings; the only
//                      implemented value is accepted and anything else is
//                      rejected rather than silently executing canonical
//                      behavior.
//
// Numeric trading-policy limits themselves remain profile configuration; this
// module never invents limits. Cross-field invariants (minimum_sessions <=
// maximum_sessions) are enforced here because they are structural.

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkPositiveInteger(value, label) {
  if (!Number.isInteger(value) || value < 1) {
    return `${label} must be a positive integer; got ${JSON.stringify(value)}`;
  }
  return null;
}

function checkNonNegativeNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return `${label} must be a finite non-negative number; got ${JSON.stringify(value)}`;
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

function checkString(value, expected, label) {
  if (value !== expected) {
    return `${label} must be ${JSON.stringify(expected)}; got ${JSON.stringify(value)}`;
  }
  return null;
}

function windowParams(label) {
  return {
    swing_left: { kind: 'positiveInteger' },
    swing_right: { kind: 'positiveInteger' }
  };
}

const PARAMETER_SCHEMAS = {
  base_duration: {
    minimum_sessions: { kind: 'positiveInteger' },
    maximum_sessions: { kind: 'positiveInteger' },
    detection_lookback: { kind: 'positiveInteger' },
    swing_high_left: { kind: 'positiveInteger' },
    swing_high_right: { kind: 'positiveInteger' },
    max_post_high_advance_pct: { kind: 'nonNegativeNumber' },
    candidate_selection: { kind: 'enum', allowed: ['earliest_qualifying'] }
  },
  prior_move: {
    minimum_pct: { kind: 'nonNegativeNumber' },
    search_lookback: { kind: 'positiveInteger' },
    ...windowParams('prior_move'),
    selection: { kind: 'enum', allowed: ['most_recent_qualifying'] }
  },
  higher_lows: {
    ...windowParams('higher_lows'),
    minimum_lows: { kind: 'positiveInteger' },
    tolerance_pct: { kind: 'nonNegativeNumber' },
    sequence_rule: { kind: 'enum', allowed: ['no_material_lower_low'] }
  },
  range_contraction: {
    recent_window: { kind: 'positiveInteger' },
    prior_window: { kind: 'positiveInteger' },
    maximum_ratio: { kind: 'nonNegativeNumber' },
    require_full_windows: { kind: 'boolean' }
  },
  volume_contraction: {
    recent_window: { kind: 'positiveInteger' },
    prior_window: { kind: 'positiveInteger' },
    maximum_ratio: { kind: 'nonNegativeNumber' },
    require_full_windows: { kind: 'boolean' }
  },
  ma_trend: {
    type: { kind: 'string', expected: 'SMA' },
    fast_period: { kind: 'positiveInteger' },
    slow_period: { kind: 'positiveInteger' },
    slope_lookback: { kind: 'positiveInteger' },
    support_period: { kind: 'positiveInteger' },
    max_close_below_support_pct: { kind: 'nonNegativeNumber' },
    require_fast_above_slow: { kind: 'boolean' }
  },
  pivot_quality: {
    ...windowParams('pivot_quality'),
    cluster_tolerance_pct: { kind: 'nonNegativeNumber' },
    minimum_touches: { kind: 'positiveInteger' },
    recent_touch_window: { kind: 'positiveInteger' },
    max_d1_distance_pct: { kind: 'nonNegativeNumber' },
    prior_close_tolerance_pct: { kind: 'nonNegativeNumber' },
    require_confirmation: { kind: 'boolean' }
  }
};

function validateParameters(key, parameters) {
  const errors = [];
  if (!isObject(parameters)) {
    return [`criterion "${key}" parameters must be an object`];
  }
  const schema = PARAMETER_SCHEMAS[key];
  if (!schema) {
    return errors;
  }
  for (const [paramName, spec] of Object.entries(schema)) {
    if (!Object.prototype.hasOwnProperty.call(parameters, paramName)) {
      // ma_trend/support_period and boolean toggles may be absent only when a
      // default is defined by the evaluator; required fields are enforced by
      // the evaluators themselves. Presence is still validated when present.
      continue;
    }
    const value = parameters[paramName];
    const label = `criterion "${key}" parameter "${paramName}"`;
    let error = null;
    switch (spec.kind) {
      case 'positiveInteger':
        error = checkPositiveInteger(value, label);
        break;
      case 'nonNegativeNumber':
        error = checkNonNegativeNumber(value, label);
        break;
      case 'boolean':
        error = checkBoolean(value, label);
        break;
      case 'enum':
        error = checkEnum(value, spec.allowed, label);
        break;
      case 'string':
        error = checkString(value, spec.expected, label);
        break;
      default:
        break;
    }
    if (error) errors.push(error);
  }

  if (key === 'base_duration') {
    const minimum = parameters.minimum_sessions;
    const maximum = parameters.maximum_sessions;
    if (
      Number.isInteger(minimum) &&
      Number.isInteger(maximum) &&
      minimum > maximum
    ) {
      errors.push(
        'criterion "base_duration" requires minimum_sessions <= maximum_sessions'
      );
    }
  }
  return errors;
}

/**
 * Validates the Setup dimension criteria of a profile version.
 * Unknown criterion keys / parameters are ignored here (the evaluator registry
 * rejects unknown enabled criteria when they run). Returns an array of
 * violation strings (empty when valid).
 */
function validateSetupCriteria(setupConfig) {
  const errors = [];
  if (!setupConfig || !Array.isArray(setupConfig.criteria)) {
    return errors;
  }
  for (const criterion of setupConfig.criteria) {
    errors.push(...validateParameters(criterion.key, criterion.parameters));
  }
  return errors;
}

module.exports = {
  PARAMETER_SCHEMAS,
  validateParameters,
  validateSetupCriteria,
  checkPositiveInteger,
  checkNonNegativeNumber
};
