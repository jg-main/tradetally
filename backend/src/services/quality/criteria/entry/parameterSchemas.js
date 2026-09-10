'use strict';

// Typed Entry criterion parameter validation
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 22-32, 55-56, 62).
//
// Every implemented Entry evaluator/helper is declared here with the exact
// type it interprets:
//   positiveInteger   - whole numbers >= 1 (reference sessions, periods)
//   nonNegativeNumber - finite >= 0 (percentages, multiples, tolerances)
//   positiveNumber    - finite > 0 (buffer values, target multiples)
//   boolean           - strict boolean
//   enum              - exactly one of the listed policy strings
//   stringArray       - non-empty array of supported policy strings
//
// Trading-policy limits themselves remain profile configuration; this module
// never invents limits. Cross-field invariants are enforced here because they
// are structural. Any configured enum option that is not implemented is a
// PROFILE_CONFIG_INVALID error, never silently executed as canonical behavior.

const SUPPORTED_TRIGGER_TYPES = Object.freeze([
  'BO-PIVOT',
  'BO-ORH-1',
  'BO-ORH-5',
  'BO-ORH-60'
]);

const SUPPORTED_VOLATILITY_METHODS = Object.freeze(['ADR', 'ATR']);

const SUPPORTED_EXTENSION_NORMALIZATIONS = Object.freeze(['ADR', 'ATR']);

const SUPPORTED_BUFFER_METHODS = Object.freeze([
  'minimum_tick',
  'fixed_dollars',
  'percentage',
  'ATR_fraction',
  'ADR_fraction'
]);

// Explicit technical supported maximum for same-time historical reference
// sessions. The configured count is honored exactly; a configured value above
// this is REJECTED before any evidence loading rather than silently capped.
const MAX_REFERENCE_SESSIONS = 250;

// Shared-policy ownership. Some criterion parameter blocks are read by more
// than one enabled criterion; when any consumer is enabled the owner's block
// must be explicitly validated even if the owner itself is disabled, so runtime
// can never fall back to invented trading policy.
const TRIGGER_POLICY_OWNER = 'trigger_compliance';
const TRIGGER_POLICY_CONSUMERS = Object.freeze(['trigger_compliance', 'entry_extension']);
const VOLATILITY_POLICY_OWNER = 'stop_width';
const VOLATILITY_POLICY_CONSUMERS = Object.freeze(['stop_width', 'entry_extension']);

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

function checkStringArray(value, allowed, label) {
  if (!Array.isArray(value) || value.length === 0) {
    return `${label} must be a non-empty array of supported values`;
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || !allowed.includes(entry)) {
      return `${label} contains unsupported value ${JSON.stringify(entry)}; supported: ${allowed.join(', ')}`;
    }
  }
  return null;
}

const PARAMETER_SCHEMAS = {
  breakout_session: {},
  trigger_compliance: {
    allowed_types: { kind: 'stringArray', allowed: SUPPORTED_TRIGGER_TYPES },
    require_pivot_resolution: { kind: 'boolean' },
    minimum_penetration_pct: { kind: 'nonNegativeNumber' }
  },
  volume_pace: {
    reference_sessions: { kind: 'positiveInteger' },
    target_multiple: { kind: 'positiveNumber' }
  },
  range_pace: {
    reference_sessions: { kind: 'positiveInteger' }
  },
  entry_extension: {
    primary_normalization: { kind: 'enum', allowed: SUPPORTED_EXTENSION_NORMALIZATIONS },
    // Canonical v1 has no hard limit ('disabled'). A positive finite number
    // enables a hard compliance maximum on the primary normalized extension.
    hard_maximum: { kind: 'disabledOrPositiveNumber' }
  },
  initial_stop: {
    reference: { kind: 'enum', allowed: ['observable_lod_at_stop_establishment'] },
    session: { kind: 'enum', allowed: ['regular'] },
    // minimum_tick requires a resolvable price increment: the trade's stored
    // tick_size, a known futures contract tick, or the US-equity minimum
    // increment for stocks. For other instrument types without a stored
    // tick_size the buffer (and Initial Stop) becomes UNKNOWN; use
    // fixed_dollars, percentage, ATR_fraction or ADR_fraction there.
    minimum_buffer_method: { kind: 'enum', allowed: SUPPORTED_BUFFER_METHODS },
    minimum_buffer_value: { kind: 'positiveNumber' }
  },
  stop_width: {
    volatility_method: { kind: 'enum', allowed: SUPPORTED_VOLATILITY_METHODS },
    period: { kind: 'positiveInteger' },
    maximum_multiple: { kind: 'positiveNumber' }
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
    const label = `criterion "${key}" parameter "${paramName}"`;
    if (!Object.prototype.hasOwnProperty.call(parameters, paramName)) {
      // Entry is the execution layer for its parameters: every parameter an
      // evaluator/helper interprets is REQUIRED in profile configuration.
      // Trading-policy fields are never silently defaulted in code.
      errors.push(`${label} is required`);
      continue;
    }
    const value = parameters[paramName];
    let error = null;
    switch (spec.kind) {
      case 'positiveInteger':
        error = checkPositiveInteger(value, label);
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
      case 'stringArray':
        error = checkStringArray(value, spec.allowed, label);
        break;
      case 'disabledOrPositiveNumber':
        if (value !== 'disabled' && (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)) {
          error = `${label} must be "disabled" or a finite positive number; got ${JSON.stringify(value)}`;
        }
        break;
      default:
        break;
    }
    if (error) errors.push(error);
  }

  // Explicit technical bound: a configured reference-session count is honored,
  // never silently truncated. Values above the documented supported maximum are
  // rejected before execution.
  if ((key === 'volume_pace' || key === 'range_pace') &&
      Number.isInteger(parameters.reference_sessions) &&
      parameters.reference_sessions > MAX_REFERENCE_SESSIONS) {
    errors.push(
      `criterion "${key}" parameter "reference_sessions" must be <= ${MAX_REFERENCE_SESSIONS} (documented supported maximum); got ${parameters.reference_sessions}`
    );
  }
  return errors;
}

// Validates a shared policy owner's block when a consumer depends on it, even
// if the owner criterion is disabled. Prevents runtime fallbacks to invented
// trigger policy / volatility period.
function validateSharedPolicyOwners(entryConfig, enabledKeys) {
  const errors = [];

  const triggerConsumerEnabled = enabledKeys.some((key) => TRIGGER_POLICY_CONSUMERS.includes(key));
  if (triggerConsumerEnabled && !enabledKeys.includes(TRIGGER_POLICY_OWNER)) {
    const owner = entryConfig.criteria.find((criterion) => criterion.key === TRIGGER_POLICY_OWNER);
    if (!owner || !owner.parameters || typeof owner.parameters !== 'object') {
      errors.push(
        `criterion "${TRIGGER_POLICY_OWNER}" parameters are required because an enabled criterion consumes trigger policy`
      );
    } else {
      errors.push(
        ...validateParameters(TRIGGER_POLICY_OWNER, owner.parameters).map(
          (error) => `[shared policy owner] ${error}`
        )
      );
    }
  }

  const volatilityConsumerEnabled =
    enabledKeys.some((key) => VOLATILITY_POLICY_CONSUMERS.includes(key)) ||
    (enabledKeys.includes('initial_stop') && stopBufferUsesVolatilityFraction(entryConfig));
  if (volatilityConsumerEnabled && !enabledKeys.includes(VOLATILITY_POLICY_OWNER)) {
    const owner = entryConfig.criteria.find((criterion) => criterion.key === VOLATILITY_POLICY_OWNER);
    const period = owner && owner.parameters ? owner.parameters.period : undefined;
    const periodError = checkPositiveInteger(period, `criterion "${VOLATILITY_POLICY_OWNER}" parameter "period"`);
    if (periodError) {
      errors.push(
        `[shared policy owner] ${periodError} is required because an enabled criterion consumes the volatility reference`
      );
    }
  }

  return errors;
}

function stopBufferUsesVolatilityFraction(entryConfig) {
  const initialStop = entryConfig.criteria.find((criterion) => criterion.key === 'initial_stop');
  const method = initialStop && initialStop.parameters ? initialStop.parameters.minimum_buffer_method : null;
  return method === 'ATR_fraction' || method === 'ADR_fraction';
}

/**
 * Validates the Entry dimension criteria of a profile version. Only ENABLED
 * criteria are enforced: a disabled criterion (even a malformed one) never
 * blocks execution, and its parameters are not read by any evaluator.
 * Returns an array of violation strings (empty when valid).
 */
function validateEntryCriteria(entryConfig) {
  const errors = [];
  if (!entryConfig || !Array.isArray(entryConfig.criteria)) {
    return errors;
  }
  const enabledKeys = [];
  for (const criterion of entryConfig.criteria) {
    const enabled = criterion.enabled === undefined ? true : criterion.enabled;
    if (!enabled) continue;
    enabledKeys.push(criterion.key);
    errors.push(...validateParameters(criterion.key, criterion.parameters));
  }
  // Validate shared policy owners that enabled criteria depend on, even when
  // the owner criterion itself is disabled.
  errors.push(...validateSharedPolicyOwners(entryConfig, enabledKeys));
  return errors;
}

module.exports = {
  PARAMETER_SCHEMAS,
  MAX_REFERENCE_SESSIONS,
  TRIGGER_POLICY_OWNER,
  TRIGGER_POLICY_CONSUMERS,
  VOLATILITY_POLICY_OWNER,
  VOLATILITY_POLICY_CONSUMERS,
  SUPPORTED_TRIGGER_TYPES,
  SUPPORTED_VOLATILITY_METHODS,
  SUPPORTED_EXTENSION_NORMALIZATIONS,
  SUPPORTED_BUFFER_METHODS,
  validateParameters,
  validateEntryCriteria,
  validateSharedPolicyOwners,
  checkPositiveInteger,
  checkNonNegativeNumber,
  checkPositiveNumber
};
