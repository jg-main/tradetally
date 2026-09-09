'use strict';

const { getCanonicalBOConfig } = require('../../../../src/services/quality/canonicalBO');
const {
  validateSetupCriteria,
  validateParameters
} = require('../../../../src/services/quality/criteria/setup/parameterSchemas');
const { detectBaseStart } = require('../../../../src/services/quality/detectors/baseStart');
const { buildBars, candle } = require('../barFactory');

function setupDimensionConfig() {
  // getCanonicalBOConfig() returns a fresh graph on each call, so tests can
  // mutate a criterion without leaking into other tests.
  return getCanonicalBOConfig().dimensions.setup;
}

function criterionByKey(setupConfig, key) {
  return setupConfig.criteria.find((entry) => entry.key === key);
}

describe('parameterSchemas (typed Setup parameter contract)', () => {
  test('the canonical configuration is valid', () => {
    expect(validateSetupCriteria(setupDimensionConfig())).toEqual([]);
  });

  test('rejects non-integer window/lookback/period parameters', () => {
    const setupConfig = setupDimensionConfig();
    criterionByKey(setupConfig, 'base_duration').parameters.detection_lookback = 60.5;
    expect(validateSetupCriteria(setupConfig)).toEqual([
      expect.stringMatching(/detection_lookback.*positive integer/)
    ]);

    const clean = setupDimensionConfig();
    criterionByKey(clean, 'range_contraction').parameters.recent_window = 5;
    criterionByKey(clean, 'range_contraction').parameters.prior_window = 2.5;
    expect(validateSetupCriteria(clean)).toEqual([
      expect.stringMatching(/prior_window.*positive integer/)
    ]);
  });

  test('rejects negative tolerances/percentages', () => {
    const setupConfig = setupDimensionConfig();
    criterionByKey(setupConfig, 'higher_lows').parameters.tolerance_pct = -0.5;
    expect(validateSetupCriteria(setupConfig)).toEqual([
      expect.stringMatching(/tolerance_pct.*finite non-negative number/)
    ]);
  });

  test('rejects unsupported enum policy values instead of silently running canonical behavior', () => {
    let setupConfig = setupDimensionConfig();
    criterionByKey(setupConfig, 'base_duration').parameters.candidate_selection = 'highest_low';
    expect(validateSetupCriteria(setupConfig)).toEqual([
      expect.stringMatching(/candidate_selection" must be one of earliest_qualifying/)
    ]);

    setupConfig = setupDimensionConfig();
    criterionByKey(setupConfig, 'prior_move').parameters.selection = 'oldest_qualifying';
    expect(validateSetupCriteria(setupConfig)).toEqual([
      expect.stringMatching(/selection" must be one of most_recent_qualifying/)
    ]);

    setupConfig = setupDimensionConfig();
    criterionByKey(setupConfig, 'higher_lows').parameters.sequence_rule = 'allow_lower_lows';
    expect(validateSetupCriteria(setupConfig)).toEqual([
      expect.stringMatching(/sequence_rule" must be one of no_material_lower_low/)
    ]);

    setupConfig = setupDimensionConfig();
    criterionByKey(setupConfig, 'ma_trend').parameters.type = 'EMA';
    expect(validateSetupCriteria(setupConfig)).toEqual([
      expect.stringMatching(/type" must be "SMA"/)
    ]);

    setupConfig = setupDimensionConfig();
    criterionByKey(setupConfig, 'ma_trend').parameters.require_fast_above_slow = 'yes';
    expect(validateSetupCriteria(setupConfig)).toEqual([
      expect.stringMatching(/require_fast_above_slow" must be a boolean/)
    ]);
  });

  test('rejects minimum_sessions > maximum_sessions', () => {
    const setupConfig = setupDimensionConfig();
    criterionByKey(setupConfig, 'base_duration').parameters.minimum_sessions = 50;
    expect(validateSetupCriteria(setupConfig)).toEqual([
      expect.stringMatching(/minimum_sessions <= maximum_sessions/)
    ]);
  });

  test('missing required policy fields are rejected (no silent defaults)', () => {
    const setupConfig = setupDimensionConfig();
    delete criterionByKey(setupConfig, 'ma_trend').parameters.support_period;
    expect(validateSetupCriteria(setupConfig)).toEqual([
      expect.stringMatching(/support_period" is required/)
    ]);

    const clean = setupDimensionConfig();
    delete criterionByKey(clean, 'prior_move').parameters.selection;
    expect(validateSetupCriteria(clean)).toEqual([
      expect.stringMatching(/selection" is required/)
    ]);
  });

  test('individual parameter validation requires the full typed contract', () => {
    const pivotParams = criterionByKey(setupDimensionConfig(), 'pivot_quality').parameters;
    expect(validateParameters('pivot_quality', { ...pivotParams, swing_left: 0 })).toEqual([
      expect.stringMatching(/swing_left.*positive integer/)
    ]);
    expect(validateParameters('pivot_quality', { ...pivotParams, max_d1_distance_pct: -1 })).toEqual([
      expect.stringMatching(/max_d1_distance_pct.*finite non-negative number/)
    ]);
    expect(validateParameters('pivot_quality', { ...pivotParams })).toEqual([]);
  });
});

describe('Base Start detection lookback horizon (off-by-one regression)', () => {
  const BASE_PARAMS = {
    detection_lookback: 5,
    swing_high_left: 3,
    swing_high_right: 3,
    max_post_high_advance_pct: 5
  };

  // Swing high at index 5 (high 100) with all later highs <= 100 through
  // index 10 (the D-1 bound). endIndex = 10, lookback = 5 => search window is
  // exactly [6..10]; the candidate at index 5 must be EXCLUDED.
  function candidateJustOutsideLookback() {
    const rows = [];
    for (let i = 0; i < 5; i += 1) rows.push(candle(80 + i * 4)); // climb 0..4
    rows.push(candle(99.5, 100, 97)); // 5 swing high
    for (let i = 6; i <= 10; i += 1) rows.push(candle(94, 96, 92)); // 6..10 D-1
    rows.push(candle(90, 92, 88)); // 11+
    return buildBars('2026-01-01', rows);
  }

  test('a configured 5-session lookback covers exactly 5 sessions, not 6', () => {
    const bars = candidateJustOutsideLookback();
    // The old inclusive-endpoint behavior would have started the search at
    // index 5 and returned that qualifying candidate. The corrected horizon
    // [endIndex - lookback + 1 .. endIndex] excludes it.
    expect(detectBaseStart({ bars, endIndex: 10, parameters: BASE_PARAMS })).toBeNull();
  });

  test('a candidate at the exact start of the horizon is still found', () => {
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push(candle(80 + i * 3)); // climb 0..5
    rows.push(candle(99.5, 100, 97)); // 6 = endIndex - lookback + 1
    for (let i = 7; i <= 10; i += 1) rows.push(candle(94, 96, 92)); // 7..10
    const bars = buildBars('2026-01-01', rows);
    const detected = detectBaseStart({ bars, endIndex: 10, parameters: BASE_PARAMS });
    expect(detected).not.toBeNull();
    expect(detected.index).toBe(6);
  });
});
