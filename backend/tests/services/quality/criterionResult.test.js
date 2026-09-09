'use strict';

const {
  CRITERION_STATUS
} = require('../../../src/services/quality/constants');
const {
  validateCriterionResult,
  assertValidCriterionResult,
  criterionCompliance
} = require('../../../src/services/quality/criterionResult');

function base(overrides = {}) {
  return {
    key: 'range_contraction',
    status: CRITERION_STATUS.PASS,
    score: 90,
    raw_value: 0.542,
    evidence: { ratio: 0.542 },
    message: 'Recent 5-session range is 54.2% of the prior 10-session range.',
    ...overrides
  };
}

describe('validateCriterionResult', () => {
  it('accepts a well-formed PASS result', () => {
    const { valid, errors } = validateCriterionResult(base());
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  it('accepts FAIL with a numerical score (score is independent from compliance)', () => {
    const { valid } = validateCriterionResult(base({
      status: CRITERION_STATUS.FAIL,
      score: 90,
      compliance: false
    }));
    expect(valid).toBe(true);
  });

  it('accepts PASS/FAIL with a zero score', () => {
    for (const status of [CRITERION_STATUS.PASS, CRITERION_STATUS.FAIL]) {
      const { valid, errors } = validateCriterionResult(base({ status, score: 0 }));
      expect(valid).toBe(true);
      expect(errors).toEqual([]);
    }
  });

  it('rejects NOT_APPLICABLE/UNKNOWN carrying a quality score', () => {
    for (const status of [CRITERION_STATUS.NOT_APPLICABLE, CRITERION_STATUS.UNKNOWN]) {
      const { valid, errors } = validateCriterionResult(base({ status, score: 80 }));
      expect(valid).toBe(false);
      expect(errors.join(' ')).toMatch(/must not carry a quality score/);
    }
  });

  it('rejects unknown statuses', () => {
    const { valid } = validateCriterionResult(base({ status: 'MAYBE' }));
    expect(valid).toBe(false);
  });

  it('requires a non-empty key', () => {
    expect(validateCriterionResult(base({ key: '' })).valid).toBe(false);
    expect(validateCriterionResult(base({ key: undefined })).valid).toBe(false);
  });

  it('accepts PASS/FAIL with a null score (scoreless zero-weight results)', () => {
    for (const status of [CRITERION_STATUS.PASS, CRITERION_STATUS.FAIL]) {
      const { valid, errors } = validateCriterionResult(base({ status, score: null }));
      expect(valid).toBe(true);
      expect(errors).toEqual([]);
    }
  });

  it('rejects out-of-range or non-numeric scores', () => {
    for (const score of [-1, 101, '90', Number.NaN]) {
      const { valid } = validateCriterionResult(base({ score }));
      expect(valid).toBe(false);
    }
  });

  it('validates an optional compliance field against status', () => {
    expect(validateCriterionResult(base({ compliance: true })).valid).toBe(true);
    expect(validateCriterionResult(base({ compliance: false })).valid).toBe(false);
    expect(validateCriterionResult(base({
      status: CRITERION_STATUS.FAIL,
      compliance: true
    })).valid).toBe(false);
    expect(validateCriterionResult(base({
      status: CRITERION_STATUS.NOT_APPLICABLE,
      compliance: true
    })).valid).toBe(false);
  });

  it('rejects non-object evidence and non-string messages', () => {
    expect(validateCriterionResult(base({ evidence: [] })).valid).toBe(false);
    expect(validateCriterionResult(base({ message: 42 })).valid).toBe(false);
  });

  it('accepts an optional scoring_value as number, string, or object', () => {
    expect(validateCriterionResult(base({ scoring_value: 0.542 })).valid).toBe(true);
    expect(validateCriterionResult(base({ scoring_value: 'same_trigger_session' })).valid).toBe(true);
    expect(validateCriterionResult(base({ scoring_value: { touches: 3, recent: true } })).valid).toBe(true);
    expect(validateCriterionResult(base({ scoring_value: null })).valid).toBe(true);
  });

  it('rejects malformed scoring_value values', () => {
    expect(validateCriterionResult(base({ scoring_value: [0.542] })).valid).toBe(false);
    expect(validateCriterionResult(base({ scoring_value: Number.NaN })).valid).toBe(false);
    expect(validateCriterionResult(base({ scoring_value: () => 100 })).valid).toBe(false);
    expect(validateCriterionResult(base({ scoring_value: '' })).valid).toBe(false);
    expect(validateCriterionResult(base({ scoring_value: new Date() })).valid).toBe(false);
  });

  it('rejects non-object results', () => {
    expect(validateCriterionResult(null).valid).toBe(false);
    expect(validateCriterionResult('pass').valid).toBe(false);
    expect(validateCriterionResult([]).valid).toBe(false);
  });
});

describe('assertValidCriterionResult', () => {
  it('throws with the criterion key on failure', () => {
    expect(() => assertValidCriterionResult(base({ status: 'nope' })))
      .toThrow(/range_contraction/);
    expect(() => assertValidCriterionResult(base())).not.toThrow();
  });
});

describe('criterionCompliance', () => {
  it('derives the authoritative compliance meaning from status', () => {
    expect(criterionCompliance(base({ status: CRITERION_STATUS.PASS }))).toBe(true);
    expect(criterionCompliance(base({ status: CRITERION_STATUS.FAIL }))).toBe(false);
    expect(criterionCompliance(base({ status: CRITERION_STATUS.NOT_APPLICABLE }))).toBeNull();
    expect(criterionCompliance(base({ status: CRITERION_STATUS.UNKNOWN }))).toBeNull();
    expect(criterionCompliance(null)).toBeNull();
  });
});
