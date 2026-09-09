'use strict';

const { evaluate } = require('../../../../src/services/quality/criteria/setup/rangeContraction');
const { buildBars, candle } = require('../barFactory');

const CONFIG = {
  parameters: { recent_window: 5, prior_window: 10, maximum_ratio: 0.7, require_full_windows: true }
};

function setup(baseStartIndex, baseEndIndex) {
  return {
    baseStart: { index: baseStartIndex, date: '2026-01-05' },
    baseEnd: { index: baseEndIndex, date: '2026-01-30' }
  };
}

// 30-session base [0..29]; prior window [15..24], recent window [25..29].
function baseBars(priorStyle, recentStyle) {
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    if (i >= 25) {
      rows.push(recentStyle(i));
    } else if (i >= 15) {
      rows.push(priorStyle(i));
    } else {
      rows.push(candle(95, 100, 90));
    }
  }
  return buildBars('2026-01-01', rows);
}

describe('Setup criterion: range_contraction', () => {
  test('PASS when the recent 5-session range contracts against the prior 10', () => {
    const bars = baseBars(
      () => candle(95, 110, 90), // wide prior window (range 20)
      () => candle(94.5, 96, 93) // tight recent window (range 3)
    );
    const result = evaluate({ criterion: CONFIG, setup: setup(0, 29), bars });
    expect(result.status).toBe('PASS');
    expect(result.scoring_value).toBeLessThanOrEqual(0.7);
    expect(result.evidence.recent_window.endDate).toBe(bars[29].date); // ends at D-1
  });

  test('FAIL when the recent range is not contracted enough', () => {
    const bars = baseBars(
      () => candle(94, 95, 93), // small prior range (2)
      () => candle(95, 110, 85) // wide recent range (25)
    );
    const result = evaluate({ criterion: CONFIG, setup: setup(0, 29), bars });
    expect(result.status).toBe('FAIL');
    expect(result.scoring_value).toBeGreaterThan(0.7);
  });

  test('UNKNOWN when full windows cannot fit inside the base', () => {
    const bars = buildBars('2026-01-01', Array(12).fill(candle(95, 100, 90)));
    const result = evaluate({ criterion: CONFIG, setup: setup(0, 11), bars });
    expect(result.status).toBe('UNKNOWN');
    expect(result.evidence.reason).toContain('never reach before Base Start');
  });

  test('windows never reach before the confirmed Base Start', () => {
    const bars = baseBars(
      () => candle(95, 110, 90),
      () => candle(94.5, 96, 93)
    );
    const result = evaluate({ criterion: CONFIG, setup: setup(5, 29), bars });
    // Base [5..29] has 25 sessions; windows [15..24] and [25..29] are inside.
    expect(result.status).toBe('PASS');
    expect(result.evidence.prior_window.startDate).toBe(bars[15].date);
  });

  test('UNKNOWN when prior window range is zero (undefined denominator)', () => {
    const rows = [];
    for (let i = 0; i < 30; i += 1) {
      // Flat bars: every range is zero.
      rows.push([100, 100, 100, 100, 1_000_000]);
    }
    const bars = buildBars('2026-01-01', rows);
    const result = evaluate({ criterion: CONFIG, setup: setup(0, 29), bars });
    expect(result.status).toBe('UNKNOWN');
    expect(result.message).toContain('undefined');
  });

  test('UNKNOWN when no setup boundary is established', () => {
    const bars = buildBars('2026-01-01', Array(20).fill(candle(95, 100, 90)));
    const result = evaluate({ criterion: CONFIG, setup: {}, bars });
    expect(result.status).toBe('UNKNOWN');
  });
});
