'use strict';

// Point-in-time intraday metrics (docs/QUALITY_PROFILES_REQUIREMENT.md
// sections 26, 27, 29): same-time reference, no same-minute look-ahead, and
// observable-LOD cutoffs.

const {
  cumulativeVolumeThrough,
  rangeThrough,
  computePaceMetric,
  observableLod
} = require('../../../../src/services/quality/intradayEvidenceService');
const { regularSessionBounds } = require('../../../../src/services/quality/entry/sessionTime');

const SESSION = '2026-03-10';
const SESSION_BOUNDS = regularSessionBounds(SESSION);
const O = SESSION_BOUNDS.openEpoch;

function barsAt(base, startMinute, count, { high, low, close, volume }) {
  const output = [];
  for (let i = 0; i < count; i += 1) {
    output.push({
      time: base + (startMinute + i) * 60,
      open: close,
      high,
      low,
      close,
      volume
    });
  }
  return output;
}

function bars(startMinute, count, options) {
  return barsAt(O, startMinute, count, options);
}

describe('intraday point-in-time metrics', () => {
  test('cumulative volume excludes the same-minute future bar and after-cutoff bars', () => {
    const sessionBars = [
      ...bars(0, 5, { high: 11, low: 10, close: 10.5, volume: 100 }), // 09:30-09:34
      { time: O + 5 * 60, open: 10.5, high: 50, low: 1, close: 50, volume: 999999 }, // 09:35 future
      { time: O + 6 * 60, open: 50, high: 60, low: 1, close: 55, volume: 999999 } // 09:36 future
    ];
    const cutoff = O + 5 * 60 + 24; // 09:35:24
    expect(cumulativeVolumeThrough(sessionBars, cutoff, 60)).toBe(500);
  });

  test('missing volume in an observable bar makes the cumulative sum unavailable', () => {
    const sessionBars = [
      { time: O, open: 10, high: 11, low: 9, close: 10, volume: 100 },
      { time: O + 60, open: 10, high: 11, low: 9, close: 10, volume: null }
    ];
    expect(cumulativeVolumeThrough(sessionBars, O + 5 * 60, 60)).toBeNull();
  });

  test('rangeThrough only sees observable bars plus observed execution prints', () => {
    const sessionBars = [
      { time: O, open: 10, high: 12, low: 9, close: 11, volume: 1 },
      { time: O + 5 * 60, open: 11, high: 99, low: 1, close: 50, volume: 1 } // future
    ];
    const cutoff = O + 5 * 60 + 30;
    const result = rangeThrough(sessionBars, cutoff, { resolutionSeconds: 60, extraPrices: [8.5] });
    expect(result.high).toBe(12);
    expect(result.low).toBe(8.5);
    expect(result.range).toBeCloseTo(3.5, 12);
  });

  test('pace uses the identical elapsed cutoff for every reference session', () => {
    const cutoff = O + 5 * 60; // 09:35 -> five completed bars
    const today = [
      ...bars(0, 5, { high: 12, low: 10, close: 11, volume: 30 }), // 150
      { time: O + 5 * 60, open: 11, high: 99, low: 1, close: 99, volume: 100000 }
    ];
    const refOpenA = O - 86400;
    const refOpenB = O - 2 * 86400;
    const referenceA = { date: '2026-03-09', openEpoch: refOpenA, bars: barsAt(refOpenA, 0, 8, { high: 11, low: 10, close: 10.5, volume: 10 }) };
    const referenceB = { date: '2026-03-06', openEpoch: refOpenB, bars: barsAt(refOpenB, 0, 8, { high: 11, low: 10, close: 10.5, volume: 20 }) };

    const metric = computePaceMetric({
      entrySession: SESSION_BOUNDS,
      entrySessionBars: today,
      entryCutoffEpoch: cutoff,
      referenceSessions: [referenceA, referenceB],
      requiredSessions: 2,
      kind: 'volume'
    });
    expect(metric.available).toBe(true);
    expect(metric.today).toBe(150);
    expect(metric.expected).toBe(75); // (50 + 100) / 2, five bars each
    expect(metric.pace).toBeCloseTo(2, 12);
    expect(metric.usableSessions).toBe(2);
    expect(metric.referenceCutoffs.every((ref) => ref.usable)).toBe(true);
  });

  test('pace is unavailable when fewer reference sessions than required are usable', () => {
    const cutoff = O + 5 * 60;
    const today = bars(0, 5, { high: 12, low: 10, close: 11, volume: 30 });
    const metric = computePaceMetric({
      entrySession: SESSION_BOUNDS,
      entrySessionBars: today,
      entryCutoffEpoch: cutoff,
      referenceSessions: [
        { date: '2026-03-09', openEpoch: O - 86400, bars: barsAt(O - 86400, 0, 5, { high: 11, low: 10, close: 10.5, volume: 10 }) }
      ],
      requiredSessions: 2,
      kind: 'volume'
    });
    expect(metric.available).toBe(false);
    expect(metric.reason).toMatch(/usable reference/);
  });

  test('observable LOD is limited to the reference-time cutoff', () => {
    const sessionBars = [
      { time: O, open: 10, high: 12, low: 9, close: 11 },
      { time: O + 5 * 60, open: 11, high: 12, low: 3, close: 4 } // 09:35 future, final low of day
    ];
    const early = observableLod({
      bars: sessionBars,
      openEpoch: O,
      referenceEpoch: O + 5 * 60 + 30, // 09:35:30
      resolutionSeconds: 60
    });
    expect(early.low).toBe(9);

    // A stop established at 09:34 can only see the 09:30-09:33 bars; the later
    // 09:35 final low has zero effect on compliance.
    const earlier = observableLod({
      bars: sessionBars,
      openEpoch: O,
      referenceEpoch: O + 4 * 60 + 30,
      resolutionSeconds: 60
    });
    expect(earlier.low).toBe(9);
  });

  test('observable LOD includes observed execution prints at the cutoff', () => {
    const sessionBars = [{ time: O, open: 10, high: 12, low: 9, close: 11 }];
    const result = observableLod({
      bars: sessionBars,
      openEpoch: O,
      referenceEpoch: O + 60,
      resolutionSeconds: 60,
      extraPrices: [8.25]
    });
    expect(result.low).toBe(8.25);
  });
});
