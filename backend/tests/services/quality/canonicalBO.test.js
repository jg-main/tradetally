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
