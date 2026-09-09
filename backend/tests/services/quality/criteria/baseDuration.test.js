'use strict';

const { evaluate } = require('../../../../src/services/quality/criteria/setup/baseDuration');
const { buildBars, candle } = require('../barFactory');

function criterion(parameters) {
  return { parameters };
}

function baseSetup(baseStartIndex, baseEndIndex, resolutionIndex) {
  return {
    baseStart: { index: baseStartIndex, date: `2026-01-${String(baseStartIndex + 1).padStart(2, '0')}`, price: 100, source: 'user_confirmed' },
    baseEnd: { index: baseEndIndex, date: `2026-01-${String(baseEndIndex + 1).padStart(2, '0')}` },
    resolution: { index: resolutionIndex, date: `2026-01-${String(resolutionIndex + 1).padStart(2, '0')}` }
  };
}

describe('Setup criterion: base_duration', () => {
  const config = criterion({ minimum_sessions: 10, maximum_sessions: 40 });

  test('a 22-session base passes', () => {
    const bars = buildBars('2026-01-01', Array(30).fill(candle(100)));
    const setup = baseSetup(3, 24, 25);
    const result = evaluate({ criterion: config, setup, bars });
    expect(result.status).toBe('PASS');
    expect(result.raw_value).toBe(22);
    expect(result.evidence.base_duration_sessions).toBe(22);
  });

  test('a 47-session base stays 47 sessions and FAILs (never truncated)', () => {
    const bars = buildBars('2026-01-01', Array(60).fill(candle(100)));
    const setup = baseSetup(5, 51, 52); // 47 sessions through D-1
    const result = evaluate({ criterion: config, setup, bars });
    expect(result.status).toBe('FAIL');
    expect(result.raw_value).toBe(47);
    expect(result.evidence.base_duration_sessions).toBe(47);
  });

  test('UNKNOWN when the setup boundary is not established', () => {
    const bars = buildBars('2026-01-01', Array(10).fill(candle(100)));
    const result = evaluate({ criterion: config, setup: {}, bars });
    expect(result.status).toBe('UNKNOWN');
  });
});
