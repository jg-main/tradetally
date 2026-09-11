'use strict';

const {
  managementDayForSession,
  cumulativeMfeInR,
  resolvePartialTrigger
} = require('../../../../src/services/quality/management/managementDays');

// Builds normalized daily bars with the given session highs. Day 1 is bars[0]
// (entry index 0 in these tests).
function makeBars(highs) {
  return highs.map((high, i) => ({
    date: `2026-03-${String(2 + i).padStart(2, '0')}`,
    time: 1740000000 + i * 86400,
    open: 100,
    high,
    low: 95,
    close: 100,
    volume: 1000
  }));
}

const ENTRY_INDEX = 0;
const ENTRY_BASIS = 100;
const R_PER_SHARE = 5;

describe('managementDayForSession', () => {
  it('counts Day 1 as the actual entry session', () => {
    expect(managementDayForSession(0, 0)).toBe(1);
  });

  it('counts subsequent sessions as Day 2, Day 3, ...', () => {
    expect(managementDayForSession(0, 1)).toBe(2);
    expect(managementDayForSession(0, 2)).toBe(3);
    expect(managementDayForSession(0, 4)).toBe(5);
  });

  it('returns null for sessions before entry', () => {
    expect(managementDayForSession(2, 1)).toBeNull();
  });
});

describe('cumulativeMfeInR', () => {
  it('never resets: MFE is the cumulative highest price since entry', () => {
    const bars = makeBars([102, 108, 101, 109]);
    const rows = cumulativeMfeInR({ bars, entryIndex: ENTRY_INDEX, entryBasis: ENTRY_BASIS, rPerShare: R_PER_SHARE, maxDay: 4 });
    expect(rows.map((r) => r.day)).toEqual([1, 2, 3, 4]);
    expect(rows.map((r) => r.mfeR)).toEqual([0.4, 1.6, 1.6, 1.8]);
    // Day 3 dips to 101 but cumulative MFE stays 1.6 (never resets).
    expect(rows[2].highestSinceEntry).toBe(108);
  });

  it('computes MFE in R as (highest - entryBasis) / R', () => {
    const bars = makeBars([105]);
    const rows = cumulativeMfeInR({ bars, entryIndex: ENTRY_INDEX, entryBasis: ENTRY_BASIS, rPerShare: R_PER_SHARE, maxDay: 1 });
    expect(rows[0].mfeR).toBeCloseTo(1.0);
  });
});

describe('resolvePartialTrigger', () => {
  const params = { earliest_day: 3, latest_day: 5, minimum_mfe_r: 1.0 };

  it('+1R before Day 3 -> partial due Day 3', () => {
    const bars = makeBars([106, 104, 103, 103, 103]);
    const result = resolvePartialTrigger({ bars, entryIndex: ENTRY_INDEX, entryBasis: ENTRY_BASIS, rPerShare: R_PER_SHARE, parameters: params });
    expect(result.triggered).toBe(true);
    expect(result.firstReachDay).toBe(1);
    expect(result.dueDay).toBe(3);
    expect(result.reachedEarly).toBe(true);
  });

  it('+1R first reached Day 3 -> due Day 3', () => {
    const bars = makeBars([102, 103, 106, 104, 104]);
    const result = resolvePartialTrigger({ bars, entryIndex: ENTRY_INDEX, entryBasis: ENTRY_BASIS, rPerShare: R_PER_SHARE, parameters: params });
    expect(result.triggered).toBe(true);
    expect(result.firstReachDay).toBe(3);
    expect(result.dueDay).toBe(3);
  });

  it('+1R first reached Day 4 -> due Day 4', () => {
    const bars = makeBars([101, 101, 101, 106, 106]);
    const result = resolvePartialTrigger({ bars, entryIndex: ENTRY_INDEX, entryBasis: ENTRY_BASIS, rPerShare: R_PER_SHARE, parameters: params });
    expect(result.triggered).toBe(true);
    expect(result.firstReachDay).toBe(4);
    expect(result.dueDay).toBe(4);
  });

  it('+1R first reached Day 5 -> due Day 5', () => {
    const bars = makeBars([101, 101, 101, 101, 106]);
    const result = resolvePartialTrigger({ bars, entryIndex: ENTRY_INDEX, entryBasis: ENTRY_BASIS, rPerShare: R_PER_SHARE, parameters: params });
    expect(result.triggered).toBe(true);
    expect(result.firstReachDay).toBe(5);
    expect(result.dueDay).toBe(5);
  });

  it('+1R first reached Day 6 -> no canonical partial trigger', () => {
    const bars = makeBars([101, 101, 101, 101, 101, 106]);
    const result = resolvePartialTrigger({ bars, entryIndex: ENTRY_INDEX, entryBasis: ENTRY_BASIS, rPerShare: R_PER_SHARE, parameters: params });
    expect(result.triggered).toBe(false);
  });

  it('never reaches +1R through Day 5 -> no trigger', () => {
    const bars = makeBars([101, 101, 101, 101, 101]);
    const result = resolvePartialTrigger({ bars, entryIndex: ENTRY_INDEX, entryBasis: ENTRY_BASIS, rPerShare: R_PER_SHARE, parameters: params });
    expect(result.triggered).toBe(false);
    expect(result.reason).toBe('never_reached_minimum_mfe');
  });
});
