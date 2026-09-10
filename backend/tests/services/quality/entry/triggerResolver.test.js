'use strict';

// Entry trigger resolution (docs/QUALITY_PROFILES_REQUIREMENT.md section 24;
// Phase 3 hardening findings 2 and 9): first execution print, breakout-session
// ORH coherence, completion validity, effective-trigger floor, and honest
// crossing precision.

const { resolveTrigger } = require('../../../../src/services/quality/entry/triggerResolver');
const { regularSessionBounds } = require('../../../../src/services/quality/entry/sessionTime');

const SESSION = '2026-03-10';
const OPEN = regularSessionBounds(SESSION).openEpoch;

function minuteBars(fromMinute, toMinute, high, low = high - 1, volume = 100) {
  const bars = [];
  for (let minute = fromMinute; minute < toMinute; minute += 1) {
    bars.push({ time: OPEN + minute * 60, open: high - 0.5, high, low, close: high - 0.1, volume });
  }
  return bars;
}

// First opening execution print (distinct from Entry Basis).
function firstPrint(minute, price) {
  const epoch = OPEN + minute * 60 + 30;
  return {
    available: true,
    direction: 'long',
    entryBasis: price,
    initialEntryEpoch: epoch,
    initialEntryTime: new Date(epoch * 1000).toISOString(),
    initialEntryFillPrice: price,
    initialEntryFillEpoch: epoch,
    initialEntryFillTime: new Date(epoch * 1000).toISOString(),
    initialEntryFillTrustworthy: true,
    ambiguousFirstFill: false
  };
}

const SETUP = { confirmedPivot: 100, breakoutSession: SESSION };

function resolve(overrides) {
  return resolveTrigger({
    parameters: { allowed_types: ['BO-PIVOT', 'BO-ORH-60'], minimum_penetration_pct: 0 },
    setupContext: SETUP,
    ...overrides
  });
}

describe('triggerResolver', () => {
  test('BO-PIVOT uses the first print and passes strictly above the confirmed Pivot', () => {
    const pass = resolve({ triggerType: 'BO-PIVOT', executionEvidence: firstPrint(65, 101), intraday: null });
    expect(pass.status).toBe('PASS');
    expect(pass.effectiveTrigger).toBe(100);

    const fail = resolve({ triggerType: 'BO-PIVOT', executionEvidence: firstPrint(65, 99.99), intraday: null });
    expect(fail.status).toBe('FAIL');
  });

  test('minimum penetration is applied from the profile parameters', () => {
    const result = resolveTrigger({
      triggerType: 'BO-PIVOT',
      parameters: { allowed_types: ['BO-PIVOT'], minimum_penetration_pct: 1 },
      setupContext: SETUP,
      executionEvidence: firstPrint(65, 100.5),
      intraday: null
    });
    expect(result.status).toBe('FAIL');
    expect(result.evidence.cross_threshold).toBeCloseTo(101, 12);
  });

  test('an untrustworthy first print (blended entry price) is UNKNOWN', () => {
    const result = resolve({
      triggerType: 'BO-PIVOT',
      executionEvidence: {
        available: true,
        direction: 'long',
        entryBasis: 101,
        initialEntryEpoch: OPEN + 65 * 60 + 30,
        initialEntryFillPrice: 101,
        initialEntryFillEpoch: OPEN + 65 * 60 + 30,
        initialEntryFillTrustworthy: false,
        ambiguousFirstFill: true
      },
      intraday: null
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toMatch(/FIRST opening execution print/);
  });

  test('BO-ORH-60 cannot be valid before the opening range completes', () => {
    const result = resolve({
      triggerType: 'BO-ORH-60',
      executionEvidence: firstPrint(20, 110),
      intraday: {
        breakoutSession: SESSION,
        breakoutSessionBars: minuteBars(0, 30, 111),
        resolution: '1min',
        resolutionSeconds: 60
      }
    });
    expect(result.status).toBe('FAIL');
    expect(result.evidence.entry_before_opening_range_complete).toBe(true);
  });

  test('ORH effective trigger is max(pivot, opening-range high) and never below the pivot', () => {
    const pass = resolve({
      triggerType: 'BO-ORH-60',
      executionEvidence: firstPrint(61, 106),
      intraday: { breakoutSession: SESSION, breakoutSessionBars: minuteBars(0, 60, 105), resolution: '1min', resolutionSeconds: 60 }
    });
    expect(pass.status).toBe('PASS');
    expect(pass.openingRangeHigh).toBe(105);
    expect(pass.effectiveTrigger).toBe(105);

    const floored = resolve({
      triggerType: 'BO-ORH-60',
      executionEvidence: firstPrint(61, 101),
      intraday: { breakoutSession: SESSION, breakoutSessionBars: minuteBars(0, 60, 98), resolution: '1min', resolutionSeconds: 60 }
    });
    expect(floored.effectiveTrigger).toBe(100);
    expect(floored.status).toBe('PASS');
  });

  test('a missing opening-range interval makes ORH UNKNOWN (sparse evidence)', () => {
    const sparse = minuteBars(0, 60, 105).filter((bar) => bar.time !== OPEN + 10 * 60);
    const result = resolve({
      triggerType: 'BO-ORH-60',
      executionEvidence: firstPrint(61, 106),
      intraday: { breakoutSession: SESSION, breakoutSessionBars: sparse, resolution: '1min', resolutionSeconds: 60 }
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.reason).toMatch(/incomplete/);
  });

  test('no breakout-session bars after completion is UNKNOWN', () => {
    const result = resolve({ triggerType: 'BO-ORH-60', executionEvidence: firstPrint(61, 106), intraday: null });
    expect(result.status).toBe('UNKNOWN');
  });

  test('a sustained run above the threshold is NOT counted as N crossings', () => {
    const openingRange = minuteBars(0, 60, 105); // effective trigger 105
    const sustainedAbove = minuteBars(60, 71, 106); // 11 post-range bars above 105
    const result = resolve({
      triggerType: 'BO-ORH-60',
      executionEvidence: firstPrint(71, 107),
      intraday: { breakoutSession: SESSION, breakoutSessionBars: [...openingRange, ...sustainedAbove], resolution: '1min', resolutionSeconds: 60 }
    });
    expect(result.status).toBe('PASS');
    expect(result.triggerCrossNumber).toBeNull();
    expect(result.barsAboveThreshold).toBe(11);
    expect(result.triggerTimePrecision).toBe('1min_interval');
    expect(result.evidence.first_cross_bar_open).toBe(OPEN + 60 * 60);
    expect(result.evidence.first_cross_bar_close).toBe(OPEN + 61 * 60);
  });

  test('an execution print that is the first crossing has an exact execution timestamp', () => {
    const bars = minuteBars(0, 60, 99); // entire opening range below the pivot threshold
    const result = resolve({
      triggerType: 'BO-ORH-60',
      executionEvidence: firstPrint(61, 106),
      intraday: { breakoutSession: SESSION, breakoutSessionBars: bars, resolution: '1min', resolutionSeconds: 60 }
    });
    expect(result.status).toBe('PASS');
    expect(result.triggerCrossNumber).toBe(1);
    expect(result.triggerTimePrecision).toBe('execution_timestamp');
    expect(result.evidence.minutes_after_first_trigger).toBe(0);
  });

  test('bars after the entry cutoff never change the resolved trigger', () => {
    const before = minuteBars(0, 61, 105);
    const withFuture = [...before, ...minuteBars(90, 200, 9999)];
    const first = resolve({ triggerType: 'BO-ORH-60', executionEvidence: firstPrint(61, 106), intraday: { breakoutSession: SESSION, breakoutSessionBars: before, resolution: '1min', resolutionSeconds: 60 } });
    const second = resolve({ triggerType: 'BO-ORH-60', executionEvidence: firstPrint(61, 106), intraday: { breakoutSession: SESSION, breakoutSessionBars: withFuture, resolution: '1min', resolutionSeconds: 60 } });
    expect(second.status).toBe(first.status);
    expect(second.openingRangeHigh).toBe(first.openingRangeHigh);
    expect(second.effectiveTrigger).toBe(first.effectiveTrigger);
  });

  test('require_pivot_resolution fails a direct-Pivot entry before the breakout session opens', () => {
    const beforeOpen = Math.floor(new Date('2026-03-10T13:00:00.000Z').getTime() / 1000);
    const result = resolveTrigger({
      triggerType: 'BO-PIVOT',
      parameters: { allowed_types: ['BO-PIVOT'], minimum_penetration_pct: 0, require_pivot_resolution: true },
      setupContext: SETUP,
      executionEvidence: {
        available: true,
        direction: 'long',
        entryBasis: 105,
        initialEntryFillPrice: 105,
        initialEntryFillEpoch: beforeOpen,
        initialEntryFillTrustworthy: true,
        ambiguousFirstFill: false
      },
      intraday: null
    });
    expect(result.status).toBe('FAIL');
    expect(result.evidence.entry_before_pivot_resolution).toBe(true);
  });

  test('a disallowed intended trigger type is UNKNOWN', () => {
    const result = resolveTrigger({
      triggerType: 'BO-ORH-60',
      parameters: { allowed_types: ['BO-PIVOT'], minimum_penetration_pct: 0 },
      setupContext: SETUP,
      executionEvidence: firstPrint(61, 106),
      intraday: null
    });
    expect(result.status).toBe('UNKNOWN');
  });
});
