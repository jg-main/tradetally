'use strict';

const { DEFAULT_MINIMUM_COVERAGE } = require('../../../src/services/quality/constants');
const {
  assertScoringConfig,
  assertCriterionCommonConfig,
  assertDimensionConfig,
  assertProfileVersionConfiguration
} = require('../../../src/services/quality/validation');

function dim(overrides = {}) {
  return {
    minimum_coverage: DEFAULT_MINIMUM_COVERAGE,
    criteria: overrides.criteria || [{
      key: 'a',
      enabled: true,
      required: true,
      weight: 100,
      parameters: {},
      scoring: { type: 'binary', pass_score: 100, fail_score: 0 }
    }]
  };
}

function versionConfig(dimensions) {
  return { dimensions };
}

describe('assertScoringConfig', () => {
  it('accepts a well-formed binary envelope', () => {
    expect(() => assertScoringConfig({ type: 'binary', pass_score: 100, fail_score: 0 }, 'c')).not.toThrow();
  });

  it('rejects binary envelopes with out-of-range or missing scores', () => {
    expect(() => assertScoringConfig({ type: 'binary', pass_score: 101, fail_score: 0 }, 'c')).toThrow(/between 0 and 100/);
    expect(() => assertScoringConfig({ type: 'binary', fail_score: 0 }, 'c')).toThrow(/pass_score/);
  });

  it('accepts step envelopes and rejects invalid modes or unsorted thresholds', () => {
    const valid = { type: 'step', mode: 'lte', default_score: 0, thresholds: [{ value: 0.5, score: 100 }, { value: 1, score: 50 }] };
    expect(() => assertScoringConfig(valid, 'c')).not.toThrow();

    expect(() => assertScoringConfig({ ...valid, mode: 'above' }, 'c')).toThrow(/mode/);
    expect(() => assertScoringConfig({ ...valid, thresholds: [{ value: 1, score: 50 }, { value: 0.5, score: 100 }] }, 'c')).toThrow(/strictly ascending/);
    expect(() => assertScoringConfig({ ...valid, thresholds: [] }, 'c')).toThrow(/non-empty/);
  });

  it('rejects piecewise_linear points that are not strictly ascending', () => {
    const valid = { type: 'piecewise_linear', points: [{ value: 0, score: 0 }, { value: 1, score: 100 }] };
    expect(() => assertScoringConfig(valid, 'c')).not.toThrow();
    expect(() => assertScoringConfig({ type: 'piecewise_linear', points: [{ value: 1, score: 100 }, { value: 0, score: 0 }] }, 'c')).toThrow(/strictly ascending/);
    expect(() => assertScoringConfig({ type: 'piecewise_linear', points: [] }, 'c')).toThrow(/non-empty/);
  });

  it('validates discrete outcome maps', () => {
    const valid = { type: 'discrete', scores: { same_session: 100, next_session: 50 } };
    expect(() => assertScoringConfig(valid, 'c')).not.toThrow();
    expect(() => assertScoringConfig({ type: 'discrete', scores: {} }, 'c')).toThrow(/non-empty/);
    expect(() => assertScoringConfig({ type: 'discrete', scores: { same_session: 150 } }, 'c')).toThrow(/between 0 and 100/);
  });

  it('validates composite envelopes recursively and rejects duplicate component keys', () => {
    const valid = {
      type: 'composite',
      components: [
        { key: 'touches', weight: 30, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } },
        { key: 'proximity', weight: 70, scoring: { type: 'piecewise_linear', points: [{ value: 0, score: 100 }, { value: 1, score: 0 }] } }
      ]
    };
    expect(() => assertScoringConfig(valid, 'c')).not.toThrow();
    expect(() => assertScoringConfig({
      ...valid,
      components: [valid.components[0], valid.components[0]]
    }, 'c')).toThrow(/duplicate key/);
  });

  it('rejects unknown scoring types and non-object scoring', () => {
    expect(() => assertScoringConfig({ type: 'magic', pass_score: 100, fail_score: 0 }, 'c')).toThrow(/one of/);
    expect(() => assertScoringConfig(null, 'c')).toThrow(/must be an object/);
  });
});

describe('assertCriterionCommonConfig', () => {
  it('rejects criteria missing a key or weight when enabled', () => {
    expect(() => assertCriterionCommonConfig({ weight: 10 }, 0)).toThrow(/requires a non-empty key/);
    expect(() => assertCriterionCommonConfig({ key: 'a', weight: undefined }, 0)).toThrow(/weight must be a non-negative finite number/);
    expect(() => assertCriterionCommonConfig({ key: 'a', weight: -5 }, 0)).toThrow(/weight/);
  });

  it('rejects non-boolean enabled/required and non-object parameters', () => {
    expect(() => assertCriterionCommonConfig({ key: 'a', weight: 10, enabled: 'yes' }, 0)).toThrow(/enabled/);
    expect(() => assertCriterionCommonConfig({ key: 'a', weight: 10, required: 1 }, 0)).toThrow(/required/);
    expect(() => assertCriterionCommonConfig({ key: 'a', weight: 10, parameters: [] }, 0)).toThrow(/parameters/);
  });

  it('rejects an invalid missing_data_behavior value', () => {
    expect(() => assertCriterionCommonConfig({
      key: 'a',
      weight: 10,
      missing_data_behavior: 'sometimes'
    }, 0)).toThrow(/missing_data_behavior/);
  });
});

describe('assertProfileVersionConfiguration', () => {
  it('accepts a configuration with one or more valid dimensions', () => {
    expect(() => assertProfileVersionConfiguration(versionConfig({ setup: dim() }))).not.toThrow();
    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: dim(),
      entry: dim({ criteria: [{
        key: 'e1', weight: 100, parameters: {},
        scoring: { type: 'binary', pass_score: 100, fail_score: 0 }
      }] }),
      management: dim({ criteria: [{
        key: 'm1', weight: 100,
        scoring: { type: 'binary', pass_score: 100, fail_score: 0 }
      }] })
    }))).not.toThrow();
  });

  it('rejects unknown or typo dimension keys instead of ignoring them', () => {
    expect(() => assertProfileVersionConfiguration(versionConfig({ setup_quality: dim() })))
      .toThrow(/unknown dimension "setup_quality"/);
  });

  it('requires at least one dimension', () => {
    expect(() => assertProfileVersionConfiguration(versionConfig({}))).toThrow(/at least one dimension/);
  });

  it('rejects duplicate criterion keys', () => {
    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: dim({ criteria: [
        { key: 'a', weight: 50 },
        { key: 'a', weight: 50 }
      ] })
    }))).toThrow(/duplicate criterion key "a"/);
  });

  it('validates minimum_coverage range (0..100, finite)', () => {
    for (const bad of [-1, 101, NaN, Infinity, '70']) {
      expect(() => assertProfileVersionConfiguration(versionConfig({
        setup: { minimum_coverage: bad, criteria: [{ key: 'a', weight: 100 }] }
      }))).toThrow(/minimum_coverage/);
    }
  });

  it('validates grade_thresholds completeness, range, and strict order', () => {
    const baseCriteria = [{
      key: 'a', weight: 100,
      scoring: { type: 'binary', pass_score: 100, fail_score: 0 }
    }];
    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: { criteria: baseCriteria, grade_thresholds: { A: 90, B: 80, C: 70, D: 60 } }
    }))).not.toThrow();

    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: { criteria: baseCriteria, grade_thresholds: { A: 90, B: 80, C: 70 } }
    }))).toThrow(/grade_thresholds\.D/);

    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: { criteria: baseCriteria, grade_thresholds: { A: 90, B: 80, C: 70, D: 75 } }
    }))).toThrow(/A > B > C > D/);

    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: { criteria: baseCriteria, grade_thresholds: { A: 90, B: 95, C: 70, D: 60 } }
    }))).toThrow(/A > B > C > D/);

    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: { criteria: baseCriteria, grade_thresholds: { A: 90, B: 80, C: 70, D: 101 } }
    }))).toThrow(/between 0 and 100/);
  });

  it('validates the scoring envelope when present on a criterion', () => {
    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: dim({ criteria: [
        { key: 'a', weight: 100, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } }
      ] })
    }))).not.toThrow();

    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: dim({ criteria: [
        { key: 'a', weight: 100, scoring: { type: 'binary', pass_score: 100 } }
      ] })
    }))).toThrow(/fail_score/);
  });

  it('requires scoring configuration on enabled positive-weight criteria', () => {
    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: { criteria: [{ key: 'a', weight: 100 }] }
    }))).toThrow(/positive weight but no scoring configuration/);
  });

  it('accepts enabled zero-weight criteria without scoring (non-scoring evidence)', () => {
    expect(() => assertProfileVersionConfiguration(versionConfig({
      setup: { criteria: [
        { key: 'scored', weight: 100, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } },
        { key: 'evidence_only', weight: 0 }
      ] }
    }))).not.toThrow();
  });
});
