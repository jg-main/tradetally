'use strict';

const {
  resolveManagementPolicy,
  resolvePartialTriggerPolicy,
  resolvePartialTargetPolicy,
  resolveTrailingPolicy,
  deriveToleranceFromScoring
} = require('../../../../src/services/quality/management/policy');

const { getCanonicalBOConfig } = require('../../../../src/services/quality/canonicalBO');

function managementConfig(overrides = {}) {
  const base = getCanonicalBOConfig().dimensions.management;
  return {
    ...base,
    ...overrides,
    criteria: overrides.criteria || base.criteria
  };
}

function withoutCriterion(config, key) {
  return { ...config, criteria: config.criteria.filter((c) => c.key !== key) };
}

function enableOnly(config, keys) {
  return { ...config, criteria: config.criteria.filter((c) => keys.includes(c.key)) };
}

describe('resolveManagementPolicy (F7: no hidden canonical fallback)', () => {
  it('resolves the canonical policy entirely from the profile version', () => {
    const policy = resolveManagementPolicy(managementConfig());
    expect(policy.partialTrigger).toEqual({ earliest_day: 3, latest_day: 5, minimum_mfe_r: 1 });
    expect(policy.partialTriggerSource).toBe('partial_timing');
    expect(policy.partialTarget).toEqual({ target_pct: 50, target_tolerance_pct: 2 });
    expect(policy.completionWindow).toEqual({ sessions: 0, normalized: 'same_session' });
    expect(policy.executionWindowMinutes).toBe(30);
    expect(policy.trailingActivation).toBe('after_partial');
    expect(policy.available.partialTrigger).toBe(true);
  });

  it('does NOT inject the canonical trigger when partial_timing is disabled', () => {
    const config = withoutCriterion(managementConfig(), 'partial_timing');
    const policy = resolveManagementPolicy(config);
    expect(policy.partialTrigger).toBeNull();
    expect(policy.partialTriggerSource).toBeNull();
  });

  it('uses an explicit management.policy block when the owning criterion is disabled', () => {
    const config = withoutCriterion(managementConfig(), 'partial_timing');
    config.policy = { partial_trigger: { earliest_day: 2, latest_day: 4, minimum_mfe_r: 1.5, completion_window: 1 } };
    const policy = resolveManagementPolicy(config);
    expect(policy.partialTrigger).toEqual({ earliest_day: 2, latest_day: 4, minimum_mfe_r: 1.5 });
    expect(policy.partialTriggerSource).toBe('management_policy');
    expect(policy.completionWindow).toEqual({ sessions: 1, normalized: '1' });
  });

  it('derives the tolerance from the immutable scoring envelope when absent (F9)', () => {
    const config = managementConfig();
    const sizing = config.criteria.find((c) => c.key === 'partial_sizing');
    sizing.parameters = { target_pct: 50 }; // pre-Phase-4 shape
    const policy = resolveManagementPolicy(config);
    expect(policy.partialTarget).toEqual({ target_pct: 50, target_tolerance_pct: 2 });
    expect(policy.partialToleranceSource).toBe('scoring_envelope');
  });

  it('returns no partial target when partial_sizing is disabled and no policy exists', () => {
    const config = withoutCriterion(managementConfig(), 'partial_sizing');
    const policy = resolveManagementPolicy(config);
    expect(policy.partialTarget).toBeNull();
  });

  it('treats an activation parameter absent on older versions as immediate (version-compatible)', () => {
    const config = managementConfig();
    const trailing = config.criteria.find((c) => c.key === 'trailing_ma');
    delete trailing.parameters.activation;
    expect(resolveTrailingPolicy(config).activation).toBe('immediate');
    expect(resolveTrailingPolicy(config).activationSource).toBe('version_legacy_default');
  });

  it('a genuinely trigger-free configuration acquires no trigger dependency', () => {
    const config = enableOnly(withoutCriterion(managementConfig(), 'partial_timing'), ['stop_ratchet']);
    const policy = resolveManagementPolicy(config);
    expect(policy.partialTrigger).toBeNull();
    expect(policy.available.partialTrigger).toBe(false);
  });
});

describe('resolvePartialTargetPolicy / deriveToleranceFromScoring', () => {
  it('derives the tightest lte step band', () => {
    expect(deriveToleranceFromScoring({ type: 'step', mode: 'lte', thresholds: [{ value: 0.05, score: 90 }, { value: 0.02, score: 100 }] })).toBeCloseTo(2);
  });
  it('does not derive a tolerance from a gte step or non-step envelope', () => {
    expect(deriveToleranceFromScoring({ type: 'step', mode: 'gte', thresholds: [{ value: 0.02, score: 100 }] })).toBeNull();
    expect(deriveToleranceFromScoring({ type: 'binary' })).toBeNull();
  });
  it('resolves an explicit tolerance first', () => {
    const config = managementConfig();
    expect(resolvePartialTargetPolicy(config).toleranceSource).toBe('explicit');
  });
});
