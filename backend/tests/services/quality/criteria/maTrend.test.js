'use strict';

const { evaluate } = require('../../../../src/services/quality/criteria/setup/maTrend');
const { buildBars } = require('../barFactory');

const CONFIG = {
  parameters: {
    type: 'SMA',
    fast_period: 10,
    slow_period: 20,
    slope_lookback: 5,
    support_period: 20,
    max_close_below_support_pct: 2,
    require_fast_above_slow: false
  }
};

function setup(baseEndIndex) {
  return {
    baseEnd: { index: baseEndIndex, date: '2026-02-20' },
    resolution: { index: baseEndIndex + 1, date: '2026-02-23' }
  };
}

function closesToBars(closes) {
  const rows = closes.map((close) => [close - 0.2, close + 0.4, close - 0.6, close, 1_000_000]);
  return buildBars('2025-12-01', rows);
}

describe('Setup criterion: ma_trend', () => {
  test('PASS when fast/slow SMAs rise and D-1 close holds the support MA', () => {
    const closes = [];
    for (let i = 0; i < 40; i += 1) closes.push(90 + i * 0.5);
    const bars = closesToBars(closes);
    const result = evaluate({ criterion: CONFIG, setup: setup(39), bars });
    expect(result.status).toBe('PASS');
    expect(result.scoring_value).toBe(3);
  });

  test('FAIL with partial credit when only fast/slow rising pass and support fails', () => {
    const closes = [];
    for (let i = 0; i < 39; i += 1) closes.push(90 + i * 0.6); // steady climb
    closes.push(100); // D-1 close far below SMA20 (~100.8)
    const bars = closesToBars(closes);
    const result = evaluate({ criterion: CONFIG, setup: setup(39), bars });
    expect(result.status).toBe('FAIL');
    expect(result.scoring_value).toBe(2);
    expect(result.evidence.components.find((component) => component.key === 'close_supported').pass).toBe(false);
  });

  test('FAIL 0/3 for a downtrend', () => {
    const closes = [];
    for (let i = 0; i < 40; i += 1) closes.push(130 - i * 0.6);
    const bars = closesToBars(closes);
    const result = evaluate({ criterion: CONFIG, setup: setup(39), bars });
    expect(result.status).toBe('FAIL');
    expect(result.scoring_value).toBe(0);
  });

  test('UNKNOWN when MA history is insufficient at D-1', () => {
    const closes = [];
    for (let i = 0; i < 12; i += 1) closes.push(100 + i);
    const bars = closesToBars(closes);
    const result = evaluate({ criterion: CONFIG, setup: setup(11), bars });
    expect(result.status).toBe('UNKNOWN');
    expect(result.scoring_value).toBeNull();
  });

  test('UNKNOWN when the setup boundary is missing', () => {
    const closes = [];
    for (let i = 0; i < 40; i += 1) closes.push(100 + i);
    const bars = closesToBars(closes);
    const result = evaluate({ criterion: CONFIG, setup: {}, bars });
    expect(result.status).toBe('UNKNOWN');
  });
});
