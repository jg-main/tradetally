'use strict';

const { evaluate } = require('../../../../src/services/quality/criteria/setup/leader');

describe('Setup criterion: leader', () => {
  test('Yes (true) is PASS with user_asserted provenance', () => {
    const result = evaluate({ userInputs: { leader_confirmed: true } });
    expect(result.status).toBe('PASS');
    expect(result.raw_value).toBe('yes');
    expect(result.evidence.source).toBe('user_asserted');
  });

  test('No (false) is FAIL with user_asserted provenance', () => {
    const result = evaluate({ userInputs: { leader_confirmed: false } });
    expect(result.status).toBe('FAIL');
    expect(result.raw_value).toBe('no');
    expect(result.evidence.source).toBe('user_asserted');
  });

  test('missing input is UNKNOWN (rule applies but evidence absent)', () => {
    const result = evaluate({ userInputs: {} });
    expect(result.status).toBe('UNKNOWN');
    expect(result.scoring_value).toBeNull();
  });

  test('no RS/leadership metric is ever calculated', () => {
    const result = evaluate({ userInputs: { leader_confirmed: true } });
    expect(result.evidence.rs_percentile).toBeUndefined();
    expect(result.evidence.relative_strength).toBeUndefined();
  });
});
