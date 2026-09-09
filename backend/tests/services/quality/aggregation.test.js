'use strict';

const {
  CRITERION_STATUS,
  COMPLIANCE,
  DEFAULT_MINIMUM_COVERAGE
} = require('../../../src/services/quality/constants');
const {
  aggregateDimension,
  aggregateAllDimensions,
  assertDimensionConfig,
  assertProfileVersionConfiguration,
  gradeForScore
} = require('../../../src/services/quality/aggregation');

function result(key, status, score = null) {
  return { key, status, score };
}

function configWith(criteria, overrides = {}) {
  return {
    minimum_coverage: overrides.minimum_coverage ?? DEFAULT_MINIMUM_COVERAGE,
    grade_thresholds: overrides.grade_thresholds,
    criteria
  };
}

function criterion(key, weight, { required = false, enabled = true } = {}) {
  return { key, enabled, required, weight, parameters: {} };
}

describe('aggregateDimension', () => {
  it('computes a weighted score, full coverage, and PASS compliance when every criterion passes', () => {
    const config = configWith([
      criterion('a', 70, { required: true }),
      criterion('b', 30)
    ]);
    const out = aggregateDimension(config, [
      result('a', CRITERION_STATUS.PASS, 100),
      result('b', CRITERION_STATUS.PASS, 50)
    ]);

    expect(out.score).toBe(85);
    expect(out.grade).toBe('B');
    expect(out.compliance).toBe(COMPLIANCE.PASS);
    expect(out.coverage).toBe(100);
    expect(out.coverageMet).toBe(true);
  });

  it('keeps a required FAIL independent from a high score (A grade with Compliance FAIL)', () => {
    const config = configWith([
      criterion('a', 70, { required: true }),
      criterion('b', 30)
    ]);
    const out = aggregateDimension(config, [
      result('a', CRITERION_STATUS.FAIL, 90),
      result('b', CRITERION_STATUS.PASS, 100)
    ]);

    expect(out.score).toBe(93);
    expect(out.grade).toBe('A');
    expect(out.compliance).toBe(COMPLIANCE.FAIL);
    expect(out.coverage).toBe(100);
  });

  it('renormalizes score over known criteria and reduces coverage for UNKNOWN', () => {
    const config = configWith([
      criterion('a', 70, { required: true }),
      criterion('b', 30)
    ]);
    const out = aggregateDimension(config, [
      result('a', CRITERION_STATUS.PASS, 100),
      result('b', CRITERION_STATUS.UNKNOWN)
    ]);

    // b is removed from the score denominator but still counts as applicable.
    expect(out.score).toBe(100);
    expect(out.coverage).toBe(70);
    expect(out.knownWeight).toBe(70);
    expect(out.unknownWeight).toBe(30);
    expect(out.compliance).toBe(COMPLIANCE.PASS);
  });

  it('treats an enabled criterion without a supplied result as UNKNOWN', () => {
    const config = configWith([
      criterion('a', 70, { required: true }),
      criterion('b', 30)
    ]);
    const out = aggregateDimension(config, [result('a', CRITERION_STATUS.PASS, 100)]);

    expect(out.coverage).toBe(70);
    const missing = out.criterionResults.find((entry) => entry.key === 'b');
    expect(missing.status).toBe(CRITERION_STATUS.UNKNOWN);
    expect(missing.evidenceMissing).toBe(true);
  });

  it('leaves NOT_APPLICABLE out of both score and coverage denominators', () => {
    const config = configWith([
      criterion('a', 40, { required: true }),
      criterion('b', 30, { required: true }),
      criterion('c', 30)
    ]);
    const out = aggregateDimension(config, [
      result('a', CRITERION_STATUS.PASS, 100),
      result('b', CRITERION_STATUS.NOT_APPLICABLE),
      result('c', CRITERION_STATUS.PASS, 100)
    ]);

    // Applicable criteria are only a (40) + c (30); all are known.
    expect(out.coverage).toBe(100);
    expect(out.score).toBe(100);
    expect(out.notApplicableWeight).toBe(30);
    // NOT_APPLICABLE required criterion is excluded from compliance.
    expect(out.compliance).toBe(COMPLIANCE.PASS);
  });

  it('returns INCOMPLETE for a required UNKNOWN while still scoring', () => {
    const config = configWith([
      criterion('a', 50, { required: true }),
      criterion('b', 50)
    ], { minimum_coverage: 50 });
    const out = aggregateDimension(config, [
      result('a', CRITERION_STATUS.UNKNOWN),
      result('b', CRITERION_STATUS.PASS, 100)
    ]);

    expect(out.coverage).toBe(50);
    expect(out.coverageMet).toBe(true);
    expect(out.score).toBe(100);
    expect(out.grade).toBe('A');
    expect(out.compliance).toBe(COMPLIANCE.INCOMPLETE);
  });

  it('suppresses score and grade below minimum coverage but still reports a known required FAIL', () => {
    const config = configWith([
      criterion('a', 30, { required: true }),
      criterion('b', 70)
    ]);
    const out = aggregateDimension(config, [
      result('a', CRITERION_STATUS.FAIL, 0),
      result('b', CRITERION_STATUS.UNKNOWN)
    ]);

    expect(out.coverage).toBe(30);
    expect(out.coverageMet).toBe(false);
    expect(out.score).toBeNull();
    expect(out.grade).toBeNull();
    expect(out.compliance).toBe(COMPLIANCE.FAIL);
  });

  it('suppresses score/grade below minimum coverage while compliance is PASS when required criteria are known', () => {
    const config = configWith([
      criterion('a', 60, { required: true }),
      criterion('b', 40)
    ]);
    const out = aggregateDimension(config, [
      result('a', CRITERION_STATUS.PASS, 80),
      result('b', CRITERION_STATUS.UNKNOWN)
    ]);

    expect(out.coverage).toBe(60);
    expect(out.score).toBeNull();
    expect(out.grade).toBeNull();
    expect(out.compliance).toBe(COMPLIANCE.PASS);
  });

  it('excludes disabled criteria from scoring, coverage, and compliance', () => {
    const config = configWith([
      criterion('a', 100, { required: true }),
      criterion('disabled', 0, { required: true, enabled: false })
    ]);
    const out = aggregateDimension(config, [result('a', CRITERION_STATUS.PASS, 75)]);

    expect(out.score).toBe(75);
    expect(out.coverage).toBe(100);
    expect(out.compliance).toBe(COMPLIANCE.PASS);
    expect(out.criterionResults).toHaveLength(1);
  });

  it('reports full coverage and no score when every enabled criterion is NOT_APPLICABLE', () => {
    const config = configWith([
      criterion('conditional', 100, { required: true })
    ]);
    const out = aggregateDimension(config, [result('conditional', CRITERION_STATUS.NOT_APPLICABLE)]);

    expect(out.coverage).toBe(100);
    expect(out.score).toBeNull();
    expect(out.grade).toBeNull();
    expect(out.compliance).toBe(COMPLIANCE.PASS);
  });

  it('rounds weighted scores to two decimals', () => {
    const config = configWith([
      criterion('a', 60, { required: true }),
      criterion('b', 40)
    ]);
    const out = aggregateDimension(config, [
      result('a', CRITERION_STATUS.PASS, 66.6667),
      result('b', CRITERION_STATUS.PASS, 100)
    ]);

    expect(out.score).toBeCloseTo(80, 5);
  });

  it('passes scoring_value through to enriched criterion rows', () => {
    const config = configWith([criterion('a', 100, { required: true })]);
    const out = aggregateDimension(config, [{
      key: 'a',
      status: CRITERION_STATUS.PASS,
      score: 90,
      scoring_value: 0.542,
      raw_value: 0.542,
      message: 'ratio 0.542'
    }]);

    expect(out.criterionResults[0].scoringValue).toBe(0.542);
    expect(out.criterionResults[0].rawValue).toBe(0.542);
    expect(out.criterionResults[0].message).toBe('ratio 0.542');
  });

  it('throws on invalid dimension config', () => {
    expect(() => aggregateDimension({ criteria: [{ key: 'a', weight: -1 }] }, [])).toThrow(/weight/);
    expect(() => aggregateDimension({ criteria: [{ key: 'a', weight: 10, enabled: 'yes' }] }, []))
      .toThrow(/enabled/);
    expect(() => aggregateDimension({}, [])).toThrow(/criteria array/);
  });

  it('rejects dimension configs with duplicate criterion keys', () => {
    const config = configWith([
      criterion('a', 60, { required: true }),
      criterion('a', 40)
    ]);
    expect(() => aggregateDimension(config, [])).toThrow(/duplicate criterion key "a"/);
    expect(() => assertDimensionConfig({ criteria: [{ key: 'a', weight: 1 }, { key: 'a', weight: 1 }] }))
      .toThrow(/duplicate criterion key "a"/);
  });

  it('throws on an invalid or duplicate criterion result', () => {
    const config = configWith([criterion('a', 100, { required: true })]);
    expect(() => aggregateDimension(config, [result('a', CRITERION_STATUS.UNKNOWN, 50)]))
      .toThrow(/must not carry a quality score/);
    expect(() => aggregateDimension(config, [
      result('a', CRITERION_STATUS.PASS, 100),
      result('a', CRITERION_STATUS.PASS, 100)
    ])).toThrow(/Duplicate criterion result/);
  });

  it('throws when treatMissingAsUnknown is false and a result is missing', () => {
    const config = configWith([criterion('a', 100, { required: true })]);
    expect(() => aggregateDimension(config, [], { treatMissingAsUnknown: false }))
      .toThrow(/No criterion result supplied/);
  });
});

describe('gradeForScore', () => {
  it('maps canonical grade boundaries', () => {
    expect(gradeForScore(100)).toBe('A');
    expect(gradeForScore(90)).toBe('A');
    expect(gradeForScore(89.99)).toBe('B');
    expect(gradeForScore(80)).toBe('B');
    expect(gradeForScore(70)).toBe('C');
    expect(gradeForScore(60)).toBe('D');
    expect(gradeForScore(59.99)).toBe('F');
    expect(gradeForScore(0)).toBe('F');
    expect(gradeForScore(null)).toBeNull();
  });

  it('respects custom thresholds', () => {
    const custom = { A: 95, B: 85, C: 75, D: 65 };
    expect(gradeForScore(94, custom)).toBe('B');
    expect(gradeForScore(95, custom)).toBe('A');
    expect(gradeForScore(64, custom)).toBe('F');
  });
});

describe('assertProfileVersionConfiguration', () => {
  function scored(key, weight, overrides = {}) {
    return { ...criterion(key, weight, overrides), scoring: { type: 'binary', pass_score: 100, fail_score: 0 } };
  }

  it('accepts a configuration with all three dimensions', () => {
    const config = {
      dimensions: {
        setup: configWith([scored('a', 100)]),
        entry: configWith([scored('b', 100)]),
        management: configWith([scored('c', 100)])
      }
    };
    expect(() => assertProfileVersionConfiguration(config)).not.toThrow();
  });

  it('rejects configurations without dimensions', () => {
    expect(() => assertProfileVersionConfiguration({})).toThrow(/dimensions/);
    expect(() => assertProfileVersionConfiguration(null)).toThrow(/configuration/);
  });
});

describe('aggregateAllDimensions', () => {
  it('aggregates each dimension independently and never creates a combined overall result', () => {
    const versionConfig = {
      dimensions: {
        setup: configWith([criterion('s1', 100, { required: true })]),
        entry: configWith([criterion('e1', 100, { required: true })])
      }
    };
    const out = aggregateAllDimensions(versionConfig, {
      setup: [result('s1', CRITERION_STATUS.FAIL, 90)],
      entry: [result('e1', CRITERION_STATUS.PASS, 95)]
    });

    expect(out.setup.score).toBe(90);
    expect(out.setup.compliance).toBe(COMPLIANCE.FAIL);
    expect(out.entry.score).toBe(95);
    expect(out.entry.compliance).toBe(COMPLIANCE.PASS);
    expect(Object.keys(out).sort()).toEqual(['entry', 'setup']);
    expect(out.overall).toBeUndefined();
    expect(out.combined).toBeUndefined();
  });
});

describe('assertDimensionConfig', () => {
  it('rejects invalid criteria entries', () => {
    expect(() => assertDimensionConfig({ criteria: [null] })).toThrow(/must be an object/);
    expect(() => assertDimensionConfig({ criteria: [{ weight: 10 }] })).toThrow(/non-empty key/);
  });
});

describe('zero-weight scoreless criteria', () => {
  it('keeps a required zero-weight FAIL as Compliance FAIL without NaN arithmetic', () => {
    const config = configWith([
      criterion('scored', 100, { required: true }),
      criterion('evidence', 0, { required: true })
    ]);
    const out = aggregateDimension(config, [
      result('scored', CRITERION_STATUS.PASS, 80),
      result('evidence', CRITERION_STATUS.FAIL, null)
    ]);

    expect(out.score).toBe(80);
    expect(out.coverage).toBe(100);
    expect(out.compliance).toBe(COMPLIANCE.FAIL);
    expect(Number.isNaN(out.score)).toBe(false);
  });

  it('keeps a required zero-weight UNKNOWN as Compliance INCOMPLETE without reducing coverage', () => {
    const config = configWith([
      criterion('scored', 100, { required: true }),
      criterion('evidence', 0, { required: true })
    ]);
    const out = aggregateDimension(config, [
      result('scored', CRITERION_STATUS.PASS, 100),
      result('evidence', CRITERION_STATUS.UNKNOWN, null)
    ]);

    expect(out.score).toBe(100);
    expect(out.coverage).toBe(100);
    expect(out.compliance).toBe(COMPLIANCE.INCOMPLETE);
  });

  it('lets zero-weight criteria contribute nothing to score or coverage', () => {
    const without = aggregateDimension(
      configWith([criterion('a', 100, { required: true })]),
      [result('a', CRITERION_STATUS.PASS, 80)]
    );
    const withEvidence = aggregateDimension(
      configWith([
        criterion('a', 100, { required: true }),
        criterion('evidence', 0, { required: true })
      ]),
      [
        result('a', CRITERION_STATUS.PASS, 80),
        result('evidence', CRITERION_STATUS.PASS, null)
      ]
    );

    expect(withEvidence.score).toBe(without.score);
    expect(withEvidence.coverage).toBe(without.coverage);
    expect(withEvidence.compliance).toBe(COMPLIANCE.PASS);
  });

  it('reports full coverage and no score when only zero-weight scoreless criteria exist', () => {
    const config = configWith([criterion('evidence', 0, { required: true })]);
    const out = aggregateDimension(config, [result('evidence', CRITERION_STATUS.PASS, null)]);

    expect(out.score).toBeNull();
    expect(out.coverage).toBe(100);
    expect(out.compliance).toBe(COMPLIANCE.PASS);
  });

  it('rejects a positive-weight known-status result without a numeric score', () => {
    const config = configWith([criterion('a', 100, { required: true })]);
    expect(() => aggregateDimension(config, [result('a', CRITERION_STATUS.PASS, null)]))
      .toThrow(/positive weight but no numeric score/);
  });
});
