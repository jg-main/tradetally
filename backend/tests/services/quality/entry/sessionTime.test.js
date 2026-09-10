'use strict';

// Point-in-time session/bar semantics (docs/QUALITY_PROFILES_REQUIREMENT.md
// sections 24, 26-27, 29): regular-session clock, ORH windows, and the
// "a bar is only observable once its interval completes" rule.

const {
  regularSessionBounds,
  openingRangeBounds,
  sessionDateInZone,
  barFullyObservable,
  observableBars
} = require('../../../../src/services/quality/entry/sessionTime');

const HOUR = 3600;

describe('sessionTime', () => {
  test('regular session bounds use the ET clock across DST', () => {
    const edt = regularSessionBounds('2026-03-10');
    expect(edt.openEpoch).toBe(Date.UTC(2026, 2, 10, 13, 30) / 1000);
    expect(edt.closeEpoch).toBe(Date.UTC(2026, 2, 10, 20, 0) / 1000);

    const est = regularSessionBounds('2026-01-15');
    expect(est.openEpoch).toBe(Date.UTC(2026, 0, 15, 14, 30) / 1000);
    expect(est.closeEpoch).toBe(Date.UTC(2026, 0, 15, 21, 0) / 1000);
  });

  test('opening-range windows complete at 09:31 / 09:35 / 10:30 ET', () => {
    const one = openingRangeBounds('2026-03-10', 'BO-ORH-1');
    const five = openingRangeBounds('2026-03-10', 'BO-ORH-5');
    const sixty = openingRangeBounds('2026-03-10', 'BO-ORH-60');
    const open = regularSessionBounds('2026-03-10').openEpoch;

    expect(one.completionEpoch).toBe(open + 1 * 60);
    expect(five.completionEpoch).toBe(open + 5 * 60);
    expect(sixty.completionEpoch).toBe(open + 60 * 60);
    expect(openingRangeBounds('2026-03-10', 'BO-PIVOT')).toBeNull();
  });

  test('sessionDateInZone maps a UTC epoch to the ET session date', () => {
    const open = regularSessionBounds('2026-03-10').openEpoch;
    expect(sessionDateInZone(open)).toBe('2026-03-10');
    expect(sessionDateInZone(open - 12 * HOUR)).toBe('2026-03-09');
  });

  test('a bar spanning the cutoff is never fully observable', () => {
    // 10:35:24 ET entry; a 10:35:00 bar covers 10:35:00-10:36:00 -> future.
    const open = regularSessionBounds('2026-03-10').openEpoch;
    const bar1034 = open + 64 * 60; // 10:34:00
    const bar1035 = open + 65 * 60; // 10:35:00
    const cutoff = open + 65 * 60 + 24; // 10:35:24

    expect(barFullyObservable(bar1034, cutoff, 60)).toBe(true);
    expect(barFullyObservable(bar1035, cutoff, 60)).toBe(false);

    const bars = [
      { time: bar1035, high: 10, low: 9 },
      { time: bar1034, high: 11, low: 8 }
    ];
    expect(observableBars(bars, cutoff, 60).map((bar) => bar.time)).toEqual([bar1034]);
  });

  test('a bar completes exactly at the cutoff', () => {
    const time = 1000;
    expect(barFullyObservable(time, time + 60, 60)).toBe(true);
    expect(barFullyObservable(time, time + 59, 60)).toBe(false);
  });
});
