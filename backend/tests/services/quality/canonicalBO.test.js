'use strict';

const { DIMENSIONS, DEFAULT_MINIMUM_COVERAGE } = require('../../../src/services/quality/constants');
const {
  CANONICAL_BO_NAME,
  CANONICAL_BO_DESCRIPTION,
  CANONICAL_BO_CONFIG,
  getCanonicalBOConfig
} = require('../../../src/services/quality/canonicalBO');
const { assertProfileVersionConfiguration } = require('../../../src/services/quality/aggregation');

const EXPECTED_DIMENSIONS = {
  [DIMENSIONS.SETUP]: {
    criteria: [
      'leader', 'prior_move', 'base_duration', 'higher_lows',
      'range_contraction', 'volume_contraction', 'ma_trend', 'pivot_quality'
    ],
    requiredAll: true,
    weights: 100
  },
  [DIMENSIONS.ENTRY]: {
    criteria: [
      'breakout_session', 'trigger_compliance', 'volume_pace', 'range_pace',
      'entry_extension', 'initial_stop', 'stop_width'
    ],
    required: ['breakout_session', 'trigger_compliance', 'initial_stop', 'stop_width'],
    weights: 100
  },
  [DIMENSIONS.MANAGEMENT]: {
    criteria: [
      'partial_timing', 'partial_sizing', 'no_premature_reduction', 'stop_ratchet',
      'post_partial_breakeven', 'trailing_ma'
    ],
    requiredAll: true,
    weights: 100
  }
};

function totalWeight(dimensionConfig) {
  return dimensionConfig.criteria.reduce((sum, c) => sum + c.weight, 0);
}

describe('Canonical BO seed configuration', () => {
  it('passes structural profile-version validation', () => {
    expect(() => assertProfileVersionConfiguration(CANONICAL_BO_CONFIG)).not.toThrow();
  });

  it('declares the canonical profile metadata', () => {
    expect(CANONICAL_BO_NAME).toBe('Canonical BO');
    expect(CANONICAL_BO_DESCRIPTION.length).toBeGreaterThan(0);
  });

  it('defines setup/entry/management with canonical weights summing to 100', () => {
    const dimensions = CANONICAL_BO_CONFIG.dimensions;
    expect(Object.keys(dimensions).sort()).toEqual(
      [DIMENSIONS.SETUP, DIMENSIONS.ENTRY, DIMENSIONS.MANAGEMENT].sort()
    );

    for (const [dimension, expected] of Object.entries(EXPECTED_DIMENSIONS)) {
      const dimConfig = dimensions[dimension];
      expect(dimConfig.criteria.map((c) => c.key)).toEqual(expected.criteria);
      expect(totalWeight(dimConfig)).toBe(expected.weights);
      expect(dimConfig.minimum_coverage).toBe(DEFAULT_MINIMUM_COVERAGE);
    }
  });

  it('sets canonical default grade thresholds on every dimension', () => {
    for (const dimension of Object.values(DIMENSIONS)) {
      const dimConfig = CANONICAL_BO_CONFIG.dimensions[dimension];
      expect(dimConfig.grade_thresholds).toEqual({ A: 90, B: 80, C: 70, D: 60 });
    }
  });

  it('flags every criterion enabled with a non-negative weight and unique keys per dimension', () => {
    for (const dimension of Object.values(DIMENSIONS)) {
      const criteria = CANONICAL_BO_CONFIG.dimensions[dimension].criteria;
      const keys = criteria.map((c) => c.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const criterion of criteria) {
        expect(criterion.enabled).toBe(true);
        expect(criterion.weight).toBeGreaterThanOrEqual(0);
        expect(typeof criterion.parameters).toBe('object');
      }
    }
  });

  it('sets required flags per the Canonical BO default summaries', () => {
    const setup = CANONICAL_BO_CONFIG.dimensions[DIMENSIONS.SETUP];
    for (const criterion of setup.criteria) {
      expect(criterion.required).toBe(true);
    }

    const entry = CANONICAL_BO_CONFIG.dimensions[DIMENSIONS.ENTRY];
    for (const criterion of entry.criteria) {
      expect(criterion.required).toBe(EXPECTED_DIMENSIONS[DIMENSIONS.ENTRY].required.includes(criterion.key));
    }

    const management = CANONICAL_BO_CONFIG.dimensions[DIMENSIONS.MANAGEMENT];
    for (const criterion of management.criteria) {
      expect(criterion.required).toBe(true);
    }
  });

  it('captures canonical Setup defaults (spec section 61)', () => {
    const setup = CANONICAL_BO_CONFIG.dimensions[DIMENSIONS.SETUP];
    const byKey = Object.fromEntries(setup.criteria.map((c) => [c.key, c]));

    expect(byKey.leader.parameters.source).toBe('user_asserted');

    expect(byKey.prior_move.parameters.minimum_pct).toBe(30);
    expect(byKey.prior_move.parameters.search_lookback).toBe(60);
    expect(byKey.prior_move.parameters.swing_left).toBe(3);
    expect(byKey.prior_move.parameters.swing_right).toBe(3);

    expect(byKey.base_duration.parameters.minimum_sessions).toBe(10);
    expect(byKey.base_duration.parameters.maximum_sessions).toBe(40);
    expect(byKey.base_duration.parameters.candidate_selection).toBe('earliest_qualifying');

    expect(byKey.higher_lows.parameters.swing_left).toBe(2);
    expect(byKey.higher_lows.parameters.minimum_lows).toBe(2);
    expect(byKey.higher_lows.parameters.tolerance_pct).toBe(0.5);

    expect(byKey.range_contraction.parameters.recent_window).toBe(5);
    expect(byKey.range_contraction.parameters.prior_window).toBe(10);
    expect(byKey.range_contraction.parameters.maximum_ratio).toBe(0.7);
    expect(byKey.range_contraction.parameters.require_full_windows).toBe(true);

    expect(byKey.volume_contraction.parameters).toEqual(byKey.range_contraction.parameters);

    expect(byKey.ma_trend.parameters.type).toBe('SMA');
    expect(byKey.ma_trend.parameters.fast_period).toBe(10);
    expect(byKey.ma_trend.parameters.slow_period).toBe(20);
    expect(byKey.ma_trend.parameters.require_fast_above_slow).toBe(false);

    expect(byKey.pivot_quality.parameters.cluster_tolerance_pct).toBe(2);
    expect(byKey.pivot_quality.parameters.minimum_touches).toBe(2);
    expect(byKey.pivot_quality.parameters.recent_touch_window).toBe(10);
  });

  it('captures canonical Entry defaults (spec section 62)', () => {
    const entry = CANONICAL_BO_CONFIG.dimensions[DIMENSIONS.ENTRY];
    const byKey = Object.fromEntries(entry.criteria.map((c) => [c.key, c]));

    expect(byKey.trigger_compliance.parameters.allowed_types).toEqual(
      ['BO-PIVOT', 'BO-ORH-1', 'BO-ORH-5', 'BO-ORH-60']
    );
    expect(byKey.volume_pace.parameters.reference_sessions).toBe(20);
    expect(byKey.volume_pace.parameters.target_multiple).toBe(1.4);
    expect(byKey.range_pace.parameters.reference_sessions).toBe(20);
    expect(byKey.entry_extension.parameters.primary_normalization).toBe('ADR');
    expect(byKey.entry_extension.parameters.hard_maximum).toBe('disabled');
    expect(byKey.initial_stop.parameters.minimum_buffer_method).toBe('minimum_tick');
    expect(byKey.initial_stop.parameters.minimum_buffer_value).toBe(1);
    expect(byKey.stop_width.parameters.volatility_method).toBe('ADR');
    expect(byKey.stop_width.parameters.period).toBe(20);
    expect(byKey.stop_width.parameters.maximum_multiple).toBe(1.0);
  });

  it('captures canonical Management defaults (spec section 63)', () => {
    const management = CANONICAL_BO_CONFIG.dimensions[DIMENSIONS.MANAGEMENT];
    const byKey = Object.fromEntries(management.criteria.map((c) => [c.key, c]));

    expect(byKey.partial_timing.parameters.earliest_day).toBe(3);
    expect(byKey.partial_timing.parameters.latest_day).toBe(5);
    expect(byKey.partial_timing.parameters.minimum_mfe_r).toBe(1.0);
    expect(byKey.partial_timing.parameters.completion_window).toBe('same_session');
    expect(byKey.partial_sizing.parameters.target_pct).toBe(50);
    expect(byKey.partial_sizing.parameters.target_tolerance_pct).toBe(2);
    expect(byKey.stop_ratchet.parameters.downward_tolerance_ticks).toBe(0);
    expect(byKey.post_partial_breakeven.parameters.minimum_stop).toBe('original_entry_basis');
    expect(byKey.post_partial_breakeven.parameters.deadline).toBe('same_session');
    expect(byKey.trailing_ma.parameters.allowed_periods).toEqual([10, 20]);
    expect(byKey.trailing_ma.parameters.exit_signal).toBe('first_daily_close_below_selected_ma');
    expect(byKey.trailing_ma.parameters.execution_window_minutes).toBe(30);
  });

  it('returns an editable deep copy that never mutates the frozen canonical default', () => {
    const copy = getCanonicalBOConfig();
    copy.dimensions.setup.criteria[0].weight = 999;
    copy.dimensions.setup.criteria[0].parameters.source = 'changed';

    expect(CANONICAL_BO_CONFIG.dimensions.setup.criteria[0].weight).toBe(20);
    expect(CANONICAL_BO_CONFIG.dimensions.setup.criteria[0].parameters.source).toBe('user_asserted');
    expect(Object.isFrozen(CANONICAL_BO_CONFIG.dimensions.setup.criteria[0])).toBe(true);
  });
});

describe('Canonical BO scoring configuration', () => {
  function byKey(dimension) {
    return Object.fromEntries(
      CANONICAL_BO_CONFIG.dimensions[dimension].criteria.map((criterion) => [criterion.key, criterion])
    );
  }

  it('attaches typed scoring to every criterion with a spec-defined curve', () => {
    const setup = byKey(DIMENSIONS.SETUP);
    for (const key of Object.keys(setup)) {
      expect(setup[key].scoring).toBeDefined();
    }

    const entry = byKey(DIMENSIONS.ENTRY);
    for (const key of Object.keys(entry)) {
      expect(entry[key].scoring).toBeDefined();
    }

    const management = byKey(DIMENSIONS.MANAGEMENT);
    for (const key of Object.keys(management)) {
      expect(management[key].scoring).toBeDefined();
    }
  });

  it('gives every compliance-only criterion canonical binary scoring (PASS 100 / FAIL 0)', () => {
    const entry = byKey(DIMENSIONS.ENTRY);
    expect(entry.trigger_compliance.scoring).toEqual({ type: 'binary', pass_score: 100, fail_score: 0 });
    expect(entry.initial_stop.scoring).toEqual({ type: 'binary', pass_score: 100, fail_score: 0 });

    const management = byKey(DIMENSIONS.MANAGEMENT);
    expect(management.stop_ratchet.scoring).toEqual({ type: 'binary', pass_score: 100, fail_score: 0 });
  });

  it('encodes the Setup scoring curves exactly', () => {
    const setup = byKey(DIMENSIONS.SETUP);

    expect(setup.leader.scoring).toEqual({ type: 'binary', pass_score: 100, fail_score: 0 });
    expect(setup.base_duration.scoring).toEqual({ type: 'binary', pass_score: 100, fail_score: 0 });

    // Section 14.5.
    expect(setup.prior_move.scoring).toEqual({
      type: 'step',
      mode: 'gte',
      default_score: 0,
      thresholds: [
        { value: 20, score: 40 },
        { value: 30, score: 60 },
        { value: 40, score: 80 },
        { value: 60, score: 90 },
        { value: 100, score: 100 }
      ]
    });

    // Section 16.5: score = 100 * non_lower_transitions / total_transitions.
    expect(setup.higher_lows.scoring).toEqual({
      type: 'piecewise_linear',
      points: [
        { value: 0, score: 0 },
        { value: 1, score: 100 }
      ]
    });

    // Sections 17.4 / 18.3.
    const contractionBands = {
      type: 'step',
      mode: 'lte',
      default_score: 0,
      thresholds: [
        { value: 0.4, score: 100 },
        { value: 0.55, score: 90 },
        { value: 0.7, score: 75 },
        { value: 0.85, score: 50 },
        { value: 1.0, score: 25 }
      ]
    };
    expect(setup.range_contraction.scoring).toEqual(contractionBands);
    expect(setup.volume_contraction.scoring).toEqual(contractionBands);

    // Section 19.3 (passing subcomponents count).
    expect(setup.ma_trend.scoring).toEqual({
      type: 'step',
      mode: 'gte',
      default_score: 0,
      thresholds: [
        { value: 1, score: 33 },
        { value: 2, score: 67 },
        { value: 3, score: 100 }
      ]
    });
  });

  it('encodes the Pivot Quality composite with canonical subweights (section 21.4)', () => {
    const pivot = byKey(DIMENSIONS.SETUP).pivot_quality.scoring;
    expect(pivot.type).toBe('composite');
    expect(pivot.components.map((c) => c.weight)).toEqual([30, 20, 30, 20]);
    expect(pivot.components.map((c) => c.key)).toEqual([
      'resistance_touches', 'recent_touch', 'd1_proximity', 'no_prior_resolution'
    ]);

    const touches = pivot.components[0].scoring;
    expect(touches).toEqual({
      type: 'step',
      mode: 'gte',
      default_score: 0,
      thresholds: [
        { value: 1, score: 40 },
        { value: 2, score: 80 },
        { value: 3, score: 100 }
      ]
    });
    expect(pivot.components[1].scoring).toEqual({ type: 'binary', pass_score: 100, fail_score: 0 });
    expect(pivot.components[2].scoring).toEqual({
      type: 'piecewise_linear',
      points: [
        { value: 2, score: 100 },
        { value: 5, score: 70 },
        { value: 10, score: 0 }
      ]
    });
    expect(pivot.components[3].scoring).toEqual({ type: 'binary', pass_score: 100, fail_score: 0 });
  });

  it('encodes the Entry scoring curves exactly', () => {
    const entry = byKey(DIMENSIONS.ENTRY);

    expect(entry.breakout_session.scoring).toEqual({ type: 'binary', pass_score: 100, fail_score: 0 });

    // Section 26.
    expect(entry.volume_pace.scoring).toEqual({
      type: 'step',
      mode: 'gte',
      default_score: 0,
      thresholds: [
        { value: 0.8, score: 25 },
        { value: 1.0, score: 60 },
        { value: 1.4, score: 85 },
        { value: 2.0, score: 100 }
      ]
    });

    // Section 27.
    expect(entry.range_pace.scoring).toEqual({
      type: 'step',
      mode: 'gte',
      default_score: 0,
      thresholds: [
        { value: 0.75, score: 40 },
        { value: 1.0, score: 70 },
        { value: 1.25, score: 90 },
        { value: 1.5, score: 100 }
      ]
    });

    // Section 25 (ADR units).
    expect(entry.entry_extension.scoring).toEqual({
      type: 'step',
      mode: 'lte',
      default_score: 0,
      thresholds: [
        { value: 0.05, score: 100 },
        { value: 0.1, score: 90 },
        { value: 0.2, score: 75 },
        { value: 0.3, score: 50 },
        { value: 0.5, score: 25 }
      ]
    });

    // Section 31 (stop width / ADR$).
    expect(entry.stop_width.scoring).toEqual({
      type: 'step',
      mode: 'lte',
      default_score: 0,
      thresholds: [
        { value: 0.5, score: 100 },
        { value: 0.75, score: 90 },
        { value: 1.0, score: 75 },
        { value: 1.25, score: 40 }
      ]
    });
  });

  it('encodes the Management scoring curves and missing-data behavior exactly', () => {
    const management = byKey(DIMENSIONS.MANAGEMENT);

    // Sections 36.3/38/42/45: these conditional rules may legitimately be
    // NOT_APPLICABLE, so they declare not_applicable missing-data behavior.
    for (const key of ['partial_timing', 'partial_sizing', 'post_partial_breakeven', 'trailing_ma']) {
      expect(management[key].missing_data_behavior).toBe('not_applicable');
    }

    expect(management.partial_timing.scoring).toEqual({
      type: 'discrete',
      scores: { same_trigger_session: 100, next_session: 50, later_or_not_completed: 0 }
    });

    // Section 39 (deviation from the 50% target, in percentage points/100).
    expect(management.partial_sizing.scoring).toEqual({
      type: 'step',
      mode: 'lte',
      default_score: 0,
      thresholds: [
        { value: 0.02, score: 100 },
        { value: 0.05, score: 90 },
        { value: 0.1, score: 70 },
        { value: 0.2, score: 40 }
      ]
    });

    // Section 40 (fraction reduced before trigger).
    expect(management.no_premature_reduction.scoring).toEqual({
      type: 'step',
      mode: 'lte',
      default_score: 0,
      thresholds: [
        { value: 0, score: 100 },
        { value: 0.1, score: 75 },
        { value: 0.25, score: 50 }
      ]
    });

    expect(management.post_partial_breakeven.scoring).toEqual({
      type: 'discrete',
      scores: {
        same_session_at_or_above_be: 100,
        before_next_session: 70,
        raised_below_be: 40,
        no_meaningful_reduction: 0
      }
    });

    // Section 44.
    expect(management.trailing_ma.scoring).toEqual({
      type: 'discrete',
      scores: {
        within_window: 100,
        later_same_next_session: 70,
        one_session_late: 40,
        later_or_ignored: 0
      }
    });
  });

  it('returns editable copies whose scoring objects are independent per criterion', () => {
    const copy = getCanonicalBOConfig();

    // Editing the leader's binary scoring must not change any other binary
    // criterion's scoring in the same copy.
    const leader = copy.dimensions.setup.criteria.find((c) => c.key === 'leader');
    leader.scoring.pass_score = 90;
    leader.scoring.fail_score = 10;

    const setup = Object.fromEntries(copy.dimensions.setup.criteria.map((c) => [c.key, c]));
    const entry = Object.fromEntries(copy.dimensions.entry.criteria.map((c) => [c.key, c]));
    const management = Object.fromEntries(copy.dimensions.management.criteria.map((c) => [c.key, c]));

    for (const criterion of [setup.base_duration, entry.breakout_session,
      entry.trigger_compliance, entry.initial_stop, management.stop_ratchet]) {
      expect(criterion.scoring.pass_score).toBe(100);
      expect(criterion.scoring.fail_score).toBe(0);
    }

    // Pivot Quality binary components are also independent.
    const pivot = setup.pivot_quality.scoring;
    expect(pivot.components.find((c) => c.key === 'recent_touch').scoring.pass_score).toBe(100);
    expect(pivot.components.find((c) => c.key === 'no_prior_resolution').scoring.pass_score).toBe(100);
  });

  it('keeps range_contraction and volume_contraction scoring independent in copies', () => {
    const copy = getCanonicalBOConfig();
    const range = copy.dimensions.setup.criteria.find((c) => c.key === 'range_contraction');
    const volume = copy.dimensions.setup.criteria.find((c) => c.key === 'volume_contraction');

    range.scoring.default_score = 42;
    range.scoring.thresholds[0].score = 1;

    expect(volume.scoring.default_score).toBe(0);
    expect(volume.scoring.thresholds[0].score).toBe(100);
    expect(range.scoring).not.toBe(volume.scoring);
  });

  it('still cannot mutate the frozen canonical config through a returned copy', () => {
    const copy = getCanonicalBOConfig();
    copy.dimensions.setup.criteria.find((c) => c.key === 'leader').scoring.pass_score = 90;
    copy.dimensions.setup.criteria.find((c) => c.key === 'range_contraction').scoring.default_score = 99;

    expect(CANONICAL_BO_CONFIG.dimensions.setup.criteria[0].scoring.pass_score).toBe(100);
    expect(
      CANONICAL_BO_CONFIG.dimensions.setup.criteria.find((c) => c.key === 'range_contraction').scoring.default_score
    ).toBe(0);
    expect(Object.isFrozen(CANONICAL_BO_CONFIG.dimensions.setup.criteria[0].scoring)).toBe(true);
  });
});
