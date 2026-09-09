'use strict';

const { evaluate } = require('../../../../src/services/quality/criteria/setup/higherLows');
const { buildBars } = require('../barFactory');

const CONFIG = { parameters: { swing_left: 2, swing_right: 2, minimum_lows: 2, tolerance_pct: 0.5 } };

function makeBars(baseStartIndex, baseEndIndex, lowsByIndex) {
  const count = baseEndIndex + 1;
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    const low = lowsByIndex[i] !== undefined ? lowsByIndex[i] : 95;
    const close = low + 4;
    rows.push([close - 2, close + 2, low, close, 1_000_000]);
  }
  return buildBars('2026-01-01', rows);
}

function setup(baseStartIndex, baseEndIndex) {
  return {
    baseStart: { index: baseStartIndex, date: '2026-01-05' },
    baseEnd: { index: baseEndIndex, date: '2026-01-30' }
  };
}

describe('Setup criterion: higher_lows', () => {
  test('PASS when every successive low stays within tolerance', () => {
    // Structural lows at indexes 8 (90), 14 (92), 20 (93): both transitions hold.
    const lows = {
      6: 94, 7: 92.5, 8: 90, 9: 92, 10: 93,
      12: 94.5, 13: 93, 14: 92, 15: 93.5, 16: 94.5,
      18: 96, 19: 94.5, 20: 93, 21: 94, 22: 95
    };
    const bars = makeBars(3, 25, lows);
    const result = evaluate({ criterion: CONFIG, setup: setup(3, 25), bars });
    expect(result.status).toBe('PASS');
    expect(result.evidence.transitions).toHaveLength(2);
    expect(result.scoring_value).toBe(1);
  });

  test('FAIL when a later low is materially lower', () => {
    // Lows at 8 (90), 14 (92), 20 (91.3): 91.3 < 92 * 0.995 => material lower.
    const lows = {
      6: 94, 7: 92.5, 8: 90, 9: 92, 10: 93,
      12: 94.5, 13: 93, 14: 92, 15: 93.5, 16: 94.5,
      18: 94, 19: 92.8, 20: 91.3, 21: 93, 22: 94
    };
    const bars = makeBars(3, 25, lows);
    const result = evaluate({ criterion: CONFIG, setup: setup(3, 25), bars });
    expect(result.status).toBe('FAIL');
    expect(result.evidence.transition_counts.material_lower).toBe(1);
    expect(result.scoring_value).toBe(0.5);
  });

  test('UNKNOWN when fewer than the configured minimum structural lows exist', () => {
    const bars = makeBars(3, 12, { 6: 94, 7: 92.5, 8: 90, 9: 92, 10: 93 });
    const result = evaluate({ criterion: CONFIG, setup: setup(3, 12), bars });
    expect(result.status).toBe('UNKNOWN');
    expect(result.scoring_value).toBeNull();
    expect(result.evidence.structural_lows_count).toBeLessThan(2);
  });

  test('UNKNOWN when no boundary is established', () => {
    const bars = makeBars(3, 25, {});
    const result = evaluate({ criterion: CONFIG, setup: {}, bars });
    expect(result.status).toBe('UNKNOWN');
  });
});
