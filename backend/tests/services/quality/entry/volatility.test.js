'use strict';

// Point-in-time ADR/ATR reference (docs/QUALITY_PROFILES_REQUIREMENT.md
// sections 25, 31): only completed sessions strictly before the entry session.

const { computeVolatility, CANONICAL_ADR_PERIOD } = require('../../../../src/services/quality/entry/volatility');

function bar(date, high, low, close) {
  return { date, high, low, close };
}

// 6 completed sessions (index 0..5) then an entry session at index 6.
const BARS = [
  bar('2026-01-02', 11, 9, 10),
  bar('2026-01-05', 12, 10, 11),
  bar('2026-01-06', 13, 11, 12),
  bar('2026-01-07', 14, 12, 13),
  bar('2026-01-08', 15, 13, 14),
  bar('2026-01-09', 16, 14, 15),
  bar('2026-01-12', 100, 1, 50) // entry session: must never be used
];

describe('entry volatility', () => {
  test('ADR20-style percentage uses completed sessions before entry', () => {
    const result = computeVolatility({
      dailyBars: BARS,
      entryIndex: 6,
      method: 'ADR',
      period: 3,
      entryBasis: 20
    });
    expect(result.available).toBe(true);
    // Sessions 3,4,5 with previous closes 12,13,14:
    // (14-12)/12, (15-13)/13, (16-14)/14
    const expectedPct = ((2 / 12) + (2 / 13) + (2 / 14)) / 3;
    expect(result.pct).toBeCloseTo(expectedPct, 12);
    expect(result.dollars).toBeCloseTo(20 * expectedPct, 12);
    expect(result.sessions.map((s) => s.date)).toEqual(['2026-01-07', '2026-01-08', '2026-01-09']);
  });

  test('ATR uses true range including previous close', () => {
    const result = computeVolatility({
      dailyBars: BARS,
      entryIndex: 6,
      method: 'ATR',
      period: 3,
      entryBasis: 20
    });
    expect(result.available).toBe(true);
    // TR = max(H-L, |H-prevClose|, |L-prevClose|)
    // session 3: max(2, |14-12|=2, |12-12|=0) = 2
    // session 4: max(2, |15-13|=2, |13-13|=0) = 2
    // session 5: max(2, |16-14|=2, |14-14|=0) = 2
    expect(result.dollars).toBeCloseTo(2, 12);
    expect(result.pct).toBeNull();
  });

  test('the entry session high/low is never used', () => {
    const withWildEntry = BARS.map((entry, index) => (index === 6 ? bar(entry.date, 9999, 0.01, 50) : entry));
    const result = computeVolatility({ dailyBars: withWildEntry, entryIndex: 6, method: 'ADR', period: 3, entryBasis: 20 });
    const original = computeVolatility({ dailyBars: BARS, entryIndex: 6, method: 'ADR', period: 3, entryBasis: 20 });
    expect(result.pct).toBeCloseTo(original.pct, 12);
  });

  test('insufficient history is unavailable', () => {
    const result = computeVolatility({ dailyBars: BARS, entryIndex: 3, method: 'ADR', period: 3, entryBasis: 20 });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/needs/);
  });

  test('the documented canonical fallback period is ADR20', () => {
    expect(CANONICAL_ADR_PERIOD).toBe(20);
  });
});
