'use strict';

// Management shared-policy resolution
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 33-45, 63).
//
// Policy that multiple Management criteria depend on (the +1R partial trigger,
// the partial target/tolerance, the partial completion window, and the trailing
// execution window) is resolved ONLY from the immutable profile version:
//
//   1. an enabled policy-owning criterion's own parameters, or
//   2. an explicit `dimensions.management.policy` block.
//
// If neither is configured, a dependent criterion receives `null` policy and
// must return UNKNOWN (policy_unconfigured). This module never injects a
// hidden Canonical BO default: disabling `partial_timing` cannot silently give
// another criterion the canonical 3/5/1R policy. The canonical preset exists
// only in the Canonical BO seed.

const { resolveSessionWindow } = require('./sessionWindow');

function hasOwn(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value >= 1;
}

function isPositiveNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

function getCriterion(managementConfig, key) {
  const criteria = (managementConfig && Array.isArray(managementConfig.criteria))
    ? managementConfig.criteria
    : [];
  const criterion = criteria.find((entry) => entry && entry.key === key) || null;
  if (!criterion) return null;
  const enabled = criterion.enabled === undefined ? true : criterion.enabled;
  return enabled ? criterion : null;
}

function policyBlock(managementConfig) {
  return managementConfig && managementConfig.policy && typeof managementConfig.policy === 'object'
    ? managementConfig.policy
    : {};
}

function resolvePartialTriggerPolicy(managementConfig) {
  const partialTiming = getCriterion(managementConfig, 'partial_timing');
  if (partialTiming && partialTiming.parameters) {
    const { earliest_day, latest_day, minimum_mfe_r } = partialTiming.parameters;
    if (isPositiveInteger(earliest_day) && isPositiveInteger(latest_day) && isPositiveNumber(minimum_mfe_r)) {
      return {
        value: { earliest_day, latest_day, minimum_mfe_r },
        source: 'partial_timing',
        completion_window: partialTiming.parameters.completion_window
      };
    }
  }
  const block = policyBlock(managementConfig);
  const trigger = block.partial_trigger;
  if (trigger && isPositiveInteger(trigger.earliest_day) && isPositiveInteger(trigger.latest_day) && isPositiveNumber(trigger.minimum_mfe_r)) {
    return {
      value: { earliest_day: trigger.earliest_day, latest_day: trigger.latest_day, minimum_mfe_r: trigger.minimum_mfe_r },
      source: 'management_policy',
      completion_window: trigger.completion_window
    };
  }
  return { value: null, source: null, completion_window: null };
}

// When a profile predates the explicit target_tolerance_pct parameter, derive
// the compliance tolerance from the immutable version's own scoring envelope
// (the tightest lte step band). This is version-derived, never a global
// canonical constant; if it cannot be derived the tolerance is unresolved and
// Partial Sizing compliance is UNKNOWN.
function deriveToleranceFromScoring(scoring) {
  if (!scoring || scoring.type !== 'step' || !Array.isArray(scoring.thresholds)) return null;
  if (scoring.mode !== 'lte') return null;
  const values = scoring.thresholds
    .map((threshold) => threshold && threshold.value)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
  if (values.length === 0) return null;
  return Math.min(...values) * 100;
}

function resolvePartialTargetPolicy(managementConfig) {
  const partialSizing = getCriterion(managementConfig, 'partial_sizing');
  if (partialSizing && partialSizing.parameters && isPositiveNumber(partialSizing.parameters.target_pct)) {
    const explicitTolerance = partialSizing.parameters.target_tolerance_pct;
    if (typeof explicitTolerance === 'number' && Number.isFinite(explicitTolerance) && explicitTolerance >= 0) {
      return {
        value: { target_pct: partialSizing.parameters.target_pct, target_tolerance_pct: explicitTolerance },
        toleranceSource: 'explicit',
        source: 'partial_sizing'
      };
    }
    const derived = deriveToleranceFromScoring(partialSizing.scoring);
    return {
      value: {
        target_pct: partialSizing.parameters.target_pct,
        target_tolerance_pct: derived
      },
      toleranceSource: derived === null ? null : 'scoring_envelope',
      source: 'partial_sizing'
    };
  }
  const block = policyBlock(managementConfig);
  const target = block.partial_target;
  if (target && isPositiveNumber(target.target_pct)) {
    const explicitTolerance = target.target_tolerance_pct;
    const tolerance = typeof explicitTolerance === 'number' && Number.isFinite(explicitTolerance) && explicitTolerance >= 0
      ? explicitTolerance
      : null;
    return {
      value: { target_pct: target.target_pct, target_tolerance_pct: tolerance },
      toleranceSource: tolerance === null ? null : 'explicit',
      source: 'management_policy'
    };
  }
  return { value: null, toleranceSource: null, source: null };
}

function resolveCompletionWindowPolicy(managementConfig, triggerPolicy) {
  const explicit = triggerPolicy && triggerPolicy.completion_window !== undefined
    ? triggerPolicy.completion_window
    : (policyBlock(managementConfig).completion_window);
  if (explicit === undefined || explicit === null) {
    return { value: null, source: null };
  }
  const resolved = resolveSessionWindow(explicit);
  if (!resolved.valid) return { value: null, source: null, error: resolved.error };
  return { value: { sessions: resolved.sessions, normalized: resolved.normalized }, source: triggerPolicy.source || 'management_policy' };
}

function resolveTrailingPolicy(managementConfig) {
  const trailing = getCriterion(managementConfig, 'trailing_ma');
  if (!trailing) {
    return { executionWindowMinutes: null, activation: null, activationSource: null };
  }
  const params = trailing.parameters || {};
  const executionWindowMinutes = Number.isInteger(params.execution_window_minutes) && params.execution_window_minutes > 0
    ? params.execution_window_minutes
    : null;
  let activation = null;
  let activationSource = null;
  if (params.activation === 'after_partial' || params.activation === 'immediate' || params.activation === 'explicit') {
    activation = params.activation;
    activationSource = 'trailing_ma';
  } else {
    // Versions predating the activation parameter used an immediate signal
    // scan; preserve that version's historical semantics.
    activation = 'immediate';
    activationSource = 'version_legacy_default';
  }
  return { executionWindowMinutes, activation, activationSource };
}

/**
 * Resolves all shared Management policy from the immutable management config.
 */
function resolveManagementPolicy(managementConfig) {
  const triggerPolicy = resolvePartialTriggerPolicy(managementConfig);
  const targetPolicy = resolvePartialTargetPolicy(managementConfig);
  const completionWindow = resolveCompletionWindowPolicy(managementConfig, triggerPolicy);
  const trailing = resolveTrailingPolicy(managementConfig);

  const postPartial = getCriterion(managementConfig, 'post_partial_breakeven');
  const postDeadline = postPartial && postPartial.parameters
    ? resolveSessionWindow(postPartial.parameters.deadline)
    : { valid: false, sessions: null, error: 'post_partial_breakeven not enabled' };

  return {
    partialTrigger: triggerPolicy.value,
    partialTriggerSource: triggerPolicy.source,
    partialTarget: targetPolicy.value,
    partialTargetSource: targetPolicy.source,
    partialToleranceSource: targetPolicy.toleranceSource,
    completionWindow: completionWindow.value,
    completionWindowSource: completionWindow.source,
    completionWindowError: completionWindow.error || null,
    postPartialDeadlineSessions: postDeadline.valid ? postDeadline.sessions : null,
    executionWindowMinutes: trailing.executionWindowMinutes,
    trailingActivation: trailing.activation,
    trailingActivationSource: trailing.activationSource,
    available: {
      partialTrigger: triggerPolicy.value !== null,
      partialTarget: targetPolicy.value !== null && targetPolicy.value.target_tolerance_pct !== null,
      completionWindow: completionWindow.value !== null,
      postPartialDeadline: postDeadline.valid,
      executionWindow: trailing.executionWindowMinutes !== null,
      trailing: !!trailing.activation
    }
  };
}

module.exports = {
  resolveManagementPolicy,
  resolvePartialTriggerPolicy,
  resolvePartialTargetPolicy,
  resolveTrailingPolicy,
  deriveToleranceFromScoring,
  hasOwn
};
