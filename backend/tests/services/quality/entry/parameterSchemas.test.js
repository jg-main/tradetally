'use strict';

// Entry criterion parameter validation + explicit shared-policy ownership
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 55-56; Phase 3 hardening
// finding 7).

const {
  validateEntryCriteria,
  validateParameters,
  MAX_REFERENCE_SESSIONS
} = require('../../../../src/services/quality/criteria/entry/parameterSchemas');
const { getCanonicalBOConfig } = require('../../../../src/services/quality/canonicalBO');

function canonicalEntryConfig() {
  return JSON.parse(JSON.stringify(getCanonicalBOConfig().dimensions.entry));
}

function criterion(config, key) {
  return config.criteria.find((entry) => entry.key === key);
}

describe('Entry parameter schemas', () => {
  test('the canonical entry configuration is valid', () => {
    expect(validateEntryCriteria(canonicalEntryConfig())).toEqual([]);
  });

  test('reference_sessions above the documented supported maximum is rejected', () => {
    const config = canonicalEntryConfig();
    criterion(config, 'volume_pace').parameters.reference_sessions = MAX_REFERENCE_SESSIONS + 1;
    const errors = validateEntryCriteria(config);
    expect(errors.some((error) => /reference_sessions/.test(error))).toBe(true);
  });

  test('reference_sessions at the supported maximum is accepted', () => {
    const config = canonicalEntryConfig();
    criterion(config, 'volume_pace').parameters.reference_sessions = MAX_REFERENCE_SESSIONS;
    criterion(config, 'range_pace').parameters.reference_sessions = MAX_REFERENCE_SESSIONS;
    expect(validateEntryCriteria(config)).toEqual([]);
  });

  test('entry_extension enabled with a disabled trigger_compliance still requires valid trigger policy', () => {
    const config = canonicalEntryConfig();
    criterion(config, 'trigger_compliance').enabled = false;
    // Remove the policy owner block entirely: runtime must not fall back.
    delete criterion(config, 'trigger_compliance').parameters;
    const errors = validateEntryCriteria(config);
    expect(errors.some((error) => /trigger_compliance/.test(error))).toBe(true);
  });

  test('a disabled trigger_compliance with valid policy satisfies an enabled extension', () => {
    const config = canonicalEntryConfig();
    criterion(config, 'trigger_compliance').enabled = false;
    expect(validateEntryCriteria(config)).toEqual([]);
  });

  test('a volatility consumer requires an explicit stop_width period', () => {
    const config = canonicalEntryConfig();
    criterion(config, 'stop_width').enabled = false;
    delete criterion(config, 'stop_width').parameters.period;
    const errors = validateEntryCriteria(config);
    expect(errors.some((error) => /stop_width.*period/.test(error))).toBe(true);
  });

  test('an unsupported buffer method enum is rejected', () => {
    const errors = validateParameters('initial_stop', {
      reference: 'observable_lod_at_stop_establishment',
      session: 'regular',
      minimum_buffer_method: 'magic',
      minimum_buffer_value: 1
    });
    expect(errors.length).toBeGreaterThan(0);
  });

  test('an unsupported extension normalization is rejected', () => {
    const errors = validateParameters('entry_extension', {
      primary_normalization: 'MAGIC',
      hard_maximum: 'disabled'
    });
    expect(errors.length).toBeGreaterThan(0);
  });
});
