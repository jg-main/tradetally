'use strict';

// Point-in-time intraday metrics (docs/QUALITY_PROFILES_REQUIREMENT.md
// sections 26, 27, 29; Phase 3 hardening finding 5): metric-level sufficiency,
// same-minute honesty, timestamped execution observations, negative volume.

const {
  cumulativeVolumeThrough,
  rangeThrough,
  computePaceMetric,
  observableLod,
  missingIntervalStarts
} = require('../../../../src/services/quality/intradayEvidenceService');
const { regularSessionBounds } = require('../../../../src/services/quality/entry/sessionTime');

const SESSION = '2026-03-10';
const SESSION_BOUNDS = regularSessionBounds(SESSION);
const O = SESSION_BOUNDS.openEpoch;

function barsAt(base, startMinute, count, { high, low, close, volume }) {
  const output = [];
  for (let i = 0; i < count; i += 1) {
    output.push({ time: base + (startMinute + i) * 60, open: close, high, low, close, volume });
  }
  return output;
}

function bars(startMinute, count, options) {
  return barsAt(O, startMinute, count, options);
}

describe('intraday sufficiency + point-in-time metrics', () => {
  test('cumulative volume excludes the same-minute future bar and after-cutoff bars', () => {
    const sessionBars = [
      ...bars(0, 5, { high: 11, low: 10, close: 10.5, volume: 100 }),
      { time: O + 5 * 60, open: 10.5, high: 50, low: 1, close: 50, volume: 999999 },
      { time: O + 6 * 60, open: 50, high: 60, low: 1, close: 55, volume: 999999 }
    ];
    const cutoff = O + 5 * 60; // aligned at 09:35
    expect(cumulativeVolumeThrough(sessionBars, cutoff, 60)).toBe(500);
  });

  test('negative or missing volume makes the cumulative sum unavailable', () => {
    expect(cumulativeVolumeThrough([
      { time: O, open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { time: O + 60, open: 10, high: 11, low: 9, close: 10, volume: -5 }
    ], O + 2 * 60, 60)).toBeNull();
    expect(cumulativeVolumeThrough([
      { time: O, open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { time: O + 60, open: 10, high: 11, low: 9, close: 10, volume: null }
    ], O + 2 * 60, 60)).toBeNull();
  });

  test('missingIntervalStarts detects a sparse gap', () => {
    const barsWithGap = [O, O + 60, O + 3 * 60].map((time) => ({ time }));
    expect(missingIntervalStarts(barsWithGap, O, O + 4 * 60, 60)).toEqual([O + 2 * 60]);
  });

  test('rangeThrough only includes timestamped execution observations <= the cutoff', () => {
    const sessionBars = [
      { time: O, open: 10, high: 12, low: 9, close: 11, volume: 1 },
      { time: O + 5 * 60, open: 11, high: 99, low: 1, close: 50, volume: 1 }
    ];
    const cutoff = O + 5 * 60;
    const result = rangeThrough(sessionBars, cutoff, {
      resolutionSeconds: 60,
      extraObservations: [
        { epoch: O + 30, price: 8.5 }, // before cutoff: included
        { epoch: O + 5 * 60 + 30, price: 1 } // after cutoff: MUST be excluded
      ]
    });
    expect(result.high).toBe(12);
    expect(result.low).toBe(8.5);
    expect(result.range).toBeCloseTo(3.5, 12);
  });

  test('pace at a mid-minute cutoff is UNKNOWN (no fabricated precision)', () => {
    const today = bars(0, 8, { high: 12, low: 10, close: 11, volume: 30 });
    const metric = computePaceMetric({
      entrySession: SESSION_BOUNDS,
      entrySessionBars: today,
      entryCutoffEpoch: O + 5 * 60 + 24, // 09:35:24
      referenceSessions: [],
      requiredSessions: 0,
      kind: 'volume'
    });
    expect(metric.available).toBe(false);
    expect(metric.precision).toBe('partial_interval');
    expect(metric.reason).toMatch(/interval boundary/);
  });

  test('pace at an aligned cutoff with complete evidence is exact', () => {
    const cutoff = O + 5 * 60;
    const today = bars(0, 8, { high: 12, low: 10, close: 11, volume: 30 });
    const refOpenA = O - 86400;
    const refOpenB = O - 2 * 86400;
    const metric = computePaceMetric({
      entrySession: SESSION_BOUNDS,
      entrySessionBars: today,
      entryCutoffEpoch: cutoff,
      referenceSessions: [
        { date: '2026-03-09', openEpoch: refOpenA, bars: barsAt(refOpenA, 0, 8, { high: 11, low: 10, close: 10.5, volume: 10 }) },
        { date: '2026-03-06', openEpoch: refOpenB, bars: barsAt(refOpenB, 0, 8, { high: 11, low: 10, close: 10.5, volume: 20 }) }
      ],
      requiredSessions: 2,
      kind: 'volume'
    });
    expect(metric.available).toBe(true);
    expect(metric.precision).toBe('exact_1min');
    expect(metric.today).toBe(150);
    expect(metric.expected).toBe(75);
    expect(metric.pace).toBeCloseTo(2, 12);
  });

  test('a reference session missing its same-time interval is unusable', () => {
    const cutoff = O + 5 * 60;
    const today = bars(0, 8, { high: 12, low: 10, close: 11, volume: 30 });
    const refOpen = O - 86400;
    const sparseRef = barsAt(refOpen, 0, 5, { high: 11, low: 10, close: 10.5, volume: 10 });
    sparseRef.splice(2, 1); // remove the 09:32 interval
    const metric = computePaceMetric({
      entrySession: SESSION_BOUNDS,
      entrySessionBars: today,
      entryCutoffEpoch: cutoff,
      referenceSessions: [{ date: '2026-03-09', openEpoch: refOpen, bars: sparseRef }],
      requiredSessions: 1,
      kind: 'volume'
    });
    expect(metric.available).toBe(false);
    expect(metric.referenceCutoffs[0].usable).toBe(false);
    expect(metric.referenceCutoffs[0].missingIntervals).toBe(1);
  });

  test('observable LOD requires an aligned, gap-free path', () => {
    const exact = [
      { time: O, open: 10, high: 12, low: 9, close: 11 },
      { time: O + 60, open: 11, high: 12, low: 9.5, close: 11 }
    ];
    const aligned = observableLod({
      bars: exact,
      openEpoch: O,
      referenceEpoch: O + 2 * 60,
      resolutionSeconds: 60
    });
    expect(aligned.low).toBe(9);
    expect(aligned.precision).toBe('exact_1min');

    const midMinute = observableLod({
      bars: exact,
      openEpoch: O,
      referenceEpoch: O + 2 * 60 + 30,
      resolutionSeconds: 60
    });
    expect(midMinute.low).toBeNull();
    expect(midMinute.precision).toBe('partial_interval');

    const gapped = observableLod({
      bars: [exact[0], exact[1]].filter((bar) => bar.time !== O + 60),
      openEpoch: O,
      referenceEpoch: O + 2 * 60,
      resolutionSeconds: 60
    });
    expect(gapped.low).toBeNull();
    expect(gapped.precision).toBe('gap');
  });

  test('the final daily low after stop establishment has zero effect', () => {
    const sessionBars = [
      ...bars(0, 4, { high: 12, low: 9, close: 11, volume: 1 }), // 09:30-09:33
      { time: O + 5 * 60, open: 11, high: 12, low: 3, close: 4, volume: 1 } // 09:35, after the 09:34 reference
    ];
    const early = observableLod({
      bars: sessionBars,
      openEpoch: O,
      referenceEpoch: O + 4 * 60,
      resolutionSeconds: 60
    });
    expect(early.low).toBe(9);
    expect(early.precision).toBe('exact_1min');
  });

  test('a timestamped execution observation at the cutoff is included', () => {
    const sessionBars = [{ time: O, open: 10, high: 12, low: 9, close: 11 }];
    const result = observableLod({
      bars: sessionBars,
      openEpoch: O,
      referenceEpoch: O + 60,
      resolutionSeconds: 60,
      extraObservations: [{ epoch: O + 60, price: 8.25 }]
    });
    expect(result.low).toBe(8.25);
  });
});
