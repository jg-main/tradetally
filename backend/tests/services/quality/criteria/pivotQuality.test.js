'use strict';

const { evaluate } = require('../../../../src/services/quality/criteria/setup/pivotQuality');
const { buildBars } = require('../barFactory');

const CONFIG = {
  parameters: {
    swing_left: 2,
    swing_right: 2,
    cluster_tolerance_pct: 2,
    minimum_touches: 2,
    recent_touch_window: 10,
    max_d1_distance_pct: 5,
    prior_close_tolerance_pct: 1,
    require_confirmation: true
  }
};

const BASE_START_INDEX = 2;
const BASE_END_INDEX = 32;

// Base bars: default high 96.5 / low 92 / close 95; "touch" sessions print a
// structural high of 100 (pivot level) and close 99. Options let a test force
// a prior-resolution close and/or the D-1 close.
function baseBars({ touches = [], priorResolutionCloseAt = null, d1Close = 97 } = {}) {
  const rows = [];
  for (let i = 0; i <= BASE_END_INDEX; i += 1) {
    if (touches.includes(i)) {
      rows.push([98, 100, 92, 99, 1_000_000]);
    } else if (i === priorResolutionCloseAt) {
      rows.push([100, 103, 95, 102, 1_000_000]); // close 102 > pivot * 1.01
    } else if (i === BASE_END_INDEX) {
      rows.push([d1Close - 1, d1Close + 1, d1Close - 2, d1Close, 1_000_000]);
    } else {
      rows.push([94.5, 96.5, 92, 95, 1_000_000]);
    }
  }
  return buildBars('2026-01-01', rows);
}

function setup(pivotPrice, { confidence = null, source = 'user_confirmed' } = {}) {
  return {
    baseStart: { index: BASE_START_INDEX, date: '2026-01-01' },
    baseEnd: { index: BASE_END_INDEX, date: '2026-02-01' },
    pivot: { price: pivotPrice, source, detectionConfidence: confidence }
  };
}

describe('Setup criterion: pivot_quality', () => {
  test('PASS when the confirmed pivot has enough touches, a recent touch, D-1 proximity and no prior resolution', () => {
    const bars = baseBars({ touches: [8, 18, 28] });
    const result = evaluate({ criterion: CONFIG, setup: setup(100), bars });
    expect(result.status).toBe('PASS');
    expect(result.scoring_value.resistance_touches).toBe(3);
    expect(result.scoring_value.recent_touch).toBe(true);
    expect(result.scoring_value.d1_proximity).toBe(3);
    expect(result.scoring_value.no_prior_resolution).toBe(true);
    expect(result.evidence.touch_count).toBe(3);
  });

  test('a one-touch confirmed pivot FAILs instead of becoming UNKNOWN', () => {
    const bars = baseBars({ touches: [8] });
    const result = evaluate({ criterion: CONFIG, setup: setup(100), bars });
    expect(result.status).toBe('FAIL');
    expect(result.scoring_value.resistance_touches).toBe(1);
    expect(result.scoring_value.recent_touch).toBe(false);
  });

  test('FAIL when no touch falls in the recent window', () => {
    const bars = baseBars({ touches: [8, 18] }); // recent window starts at index 23
    const result = evaluate({ criterion: CONFIG, setup: setup(100), bars });
    expect(result.status).toBe('FAIL');
    expect(result.scoring_value.recent_touch).toBe(false);
    expect(result.evidence.recent_touch_count).toBe(0);
  });

  test('FAIL when a pre-breakout close resolved above the pivot', () => {
    const bars = baseBars({ touches: [8, 18, 28], priorResolutionCloseAt: 12 });
    const result = evaluate({ criterion: CONFIG, setup: setup(100), bars });
    expect(result.status).toBe('FAIL');
    expect(result.scoring_value.no_prior_resolution).toBe(false);
    expect(result.evidence.prior_resolution).toBe(true);
  });

  test('FAIL when D-1 closes too far below the pivot', () => {
    const bars = baseBars({ touches: [8, 18, 28], d1Close: 90 });
    const result = evaluate({ criterion: CONFIG, setup: setup(100), bars });
    expect(result.status).toBe('FAIL');
    expect(result.scoring_value.d1_proximity).toBe(10); // > max 5
  });

  test('detection confidence is evidence only and never changes the grade inputs', () => {
    const barsHigh = baseBars({ touches: [8, 18, 28] });
    const barsLow = baseBars({ touches: [8, 18, 28] });
    const high = evaluate({ criterion: CONFIG, setup: setup(100, { confidence: 'high' }), bars: barsHigh });
    const low = evaluate({ criterion: CONFIG, setup: setup(100, { confidence: 'low' }), bars: barsLow });
    expect(low.status).toBe(high.status);
    expect(low.scoring_value).toEqual(high.scoring_value);
    expect(low.evidence.detection_confidence).toBe('low');
    expect(high.evidence.detection_confidence).toBe('high');
  });

  test('UNKNOWN only when the confirmed pivot or boundary is missing', () => {
    const bars = baseBars({ touches: [8, 18, 28] });
    const missingPivot = evaluate({ criterion: CONFIG, setup: { ...setup(100), pivot: null }, bars });
    expect(missingPivot.status).toBe('UNKNOWN');
    const noBoundary = evaluate({ criterion: CONFIG, setup: { pivot: { price: 100 } }, bars });
    expect(noBoundary.status).toBe('UNKNOWN');
  });

  // Custom bars for the spec 21.1 tolerance semantics: structural highs at
  // chosen prices relative to the confirmed pivot. The two touch highs sit in
  // the recent window (indices 24 and 29 of the 2..32 base).
  function customTouchBars({ belowPrice, abovePrice, priorResolutionCloseAt = null }) {
    const rows = [];
    for (let i = 0; i <= BASE_END_INDEX; i += 1) {
      if (i === 24) {
        rows.push([belowPrice - 0.5, belowPrice, belowPrice - 2, belowPrice - 0.6, 1_000_000]);
      } else if (i === 29) {
        rows.push([abovePrice - 0.5, abovePrice, abovePrice - 2, abovePrice - 0.6, 1_000_000]);
      } else if (i === priorResolutionCloseAt) {
        rows.push([100.4, 102.6, 99, 101.6, 1_000_000]); // close > pivot * 1.01, high outside band
      } else if (i === BASE_END_INDEX) {
        rows.push([96, 99, 95, 98, 1_000_000]);
      } else if (i >= 22 && i <= 31) {
        rows.push([94, 96, 93, 95, 1_000_000]);
      } else {
        rows.push([93, 95, 91, 94, 1_000_000]);
      }
    }
    return buildBars('2026-01-01', rows);
  }

  test('a high 1% BELOW and a high 1% ABOVE the pivot both count as touches (spec 21.1)', () => {
    const bars = customTouchBars({ belowPrice: 99, abovePrice: 101 }); // pivot 100, tolerance 2%
    const result = evaluate({ criterion: CONFIG, setup: setup(100), bars });
    expect(result.status).toBe('PASS');
    expect(result.scoring_value.resistance_touches).toBe(2);
    expect(result.evidence.touch_count).toBe(2);
  });

  test('highs outside the configured tolerance do not count as touches', () => {
    // 2.5% below/above the pivot are outside the 2% tolerance band.
    const bars = customTouchBars({ belowPrice: 97.5, abovePrice: 102.5 });
    const result = evaluate({ criterion: CONFIG, setup: setup(100), bars });
    expect(result.status).toBe('FAIL'); // not UNKNOWN: the pivot itself is valid
    expect(result.scoring_value.resistance_touches).toBe(0);
  });

  test('the prior-resolution close rule stays independent of touch tolerance', () => {
    const bars = customTouchBars({
      belowPrice: 99,
      abovePrice: 101,
      priorResolutionCloseAt: 12
    });
    const result = evaluate({ criterion: CONFIG, setup: setup(100), bars });
    expect(result.status).toBe('FAIL');
    // Touches are unaffected by the prior-resolution close.
    expect(result.scoring_value.resistance_touches).toBe(2);
    expect(result.scoring_value.no_prior_resolution).toBe(false);
    expect(result.evidence.prior_resolution).toBe(true);
  });
});
