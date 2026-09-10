'use strict';

// Entry trigger resolution (docs/QUALITY_PROFILES_REQUIREMENT.md section 24):
// direct Pivot, ORH completion validity, effective trigger floor, penetration,
// and the point-in-time bar cutoff.

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

function baseExecution(minute, price) {
  const epoch = OPEN + minute * 60 + 30;
  return {
    available: true,
    direction: 'long',
    entryBasis: price,
    initialEntryEpoch: epoch,
    initialEntryTime: new Date(epoch * 1000).toISOString()
  };
}

const SETUP = { confirmedPivot: 100, breakoutSession: SESSION };

describe('triggerResolver', () => {
  test('BO-PIVOT passes strictly above the confirmed Pivot, fails otherwise', () => {
    const pass = resolveTrigger({
      triggerType: 'BO-PIVOT',
      parameters: { allowed_types: ['BO-PIVOT'], minimum_penetration_pct: 0 },
      setupContext: SETUP,
      executionEvidence: baseExecution(65, 101),
      intraday: null
    });
    expect(pass.status).toBe('PASS');
    expect(pass.effectiveTrigger).toBe(100);

    const fail = resolveTrigger({
      triggerType: 'BO-PIVOT',
      parameters: { allowed_types: ['BO-PIVOT'], minimum_penetration_pct: 0 },
      setupContext: SETUP,
      executionEvidence: baseExecution(65, 99.99),
      intraday: null
    });
    expect(fail.status).toBe('FAIL');
  });

  test('minimum penetration is applied from the profile parameters', () => {
    const result = resolveTrigger({
      triggerType: 'BO-PIVOT',
      parameters: { allowed_types: ['BO-PIVOT'], minimum_penetration_pct: 1 },
      setupContext: SETUP,
      executionEvidence: baseExecution(65, 100.5),
      intraday: null
    });
    expect(result.status).toBe('FAIL');
    expect(result.evidence.cross_threshold).toBeCloseTo(101, 12);
  });

  test('BO-ORH-60 cannot be valid before the opening range completes', () => {
    const result = resolveTrigger({
      triggerType: 'BO-ORH-60',
      parameters: { allowed_types: ['BO-ORH-60'], minimum_penetration_pct: 0 },
      setupContext: SETUP,
      executionEvidence: baseExecution(20, 110), // 09:50 ET < 10:30
      intraday: { entrySessionBars: minuteBars(0, 30, 111), resolution: '1min', resolutionSeconds: 60 }
    });
    expect(result.status).toBe('FAIL');
    expect(result.evidence.entry_before_opening_range_complete).toBe(true);
  });

  test('ORH effective trigger is max(pivot, opening-range high) and never below the pivot', () => {
    const bars = minuteBars(0, 60, 105); // opening range high 105
    const pass = resolveTrigger({
      triggerType: 'BO-ORH-60',
      parameters: { allowed_types: ['BO-ORH-60'], minimum_penetration_pct: 0 },
      setupContext: SETUP,
      executionEvidence: baseExecution(61, 106),
      intraday: { entrySessionBars: bars, resolution: '1min', resolutionSeconds: 60 }
    });
    expect(pass.status).toBe('PASS');
    expect(pass.openingRangeHigh).toBe(105);
    expect(pass.effectiveTrigger).toBe(105);

    const lowRange = minuteBars(0, 60, 98); // opening range below pivot
    const floored = resolveTrigger({
      triggerType: 'BO-ORH-60',
      parameters: { allowed_types: ['BO-ORH-60'], minimum_penetration_pct: 0 },
      setupContext: SETUP,
      executionEvidence: baseExecution(61, 101),
      intraday: { entrySessionBars: lowRange, resolution: '1min', resolutionSeconds: 60 }
    });
    expect(floored.effectiveTrigger).toBe(100);
    expect(floored.status).toBe('PASS');
  });

  test('ORH without intraday evidence after completion is UNKNOWN, never fabricated', () => {
    const result = resolveTrigger({
      triggerType: 'BO-ORH-60',
      parameters: { allowed_types: ['BO-ORH-60'], minimum_penetration_pct: 0 },
      setupContext: SETUP,
      executionEvidence: baseExecution(61, 106),
      intraday: null
    });
    expect(result.status).toBe('UNKNOWN');
  });

  test('bars AFTER the entry cutoff never change the resolved trigger', () => {
    const before = minuteBars(0, 60, 105);
    const withFuture = [...before, ...minuteBars(90, 200, 9999)];
    const first = resolveTrigger({
      triggerType: 'BO-ORH-60',
      parameters: { allowed_types: ['BO-ORH-60'], minimum_penetration_pct: 0 },
      setupContext: SETUP,
      executionEvidence: baseExecution(61, 106),
      intraday: { entrySessionBars: before, resolution: '1min', resolutionSeconds: 60 }
    });
    const second = resolveTrigger({
      triggerType: 'BO-ORH-60',
      parameters: { allowed_types: ['BO-ORH-60'], minimum_penetration_pct: 0 },
      setupContext: SETUP,
      executionEvidence: baseExecution(61, 106),
      intraday: { entrySessionBars: withFuture, resolution: '1min', resolutionSeconds: 60 }
    });
    expect(second.status).toBe(first.status);
    expect(second.openingRangeHigh).toBe(first.openingRangeHigh);
    expect(second.effectiveTrigger).toBe(first.effectiveTrigger);
  });

  test('a second-break entry is not automatically failed', () => {
    const bars = [
      ...minuteBars(0, 5, 105),
      ...minuteBars(5, 10, 100, 99), // price dips back below the trigger
      ...minuteBars(10, 60, 105)
    ];
    const result = resolveTrigger({
      triggerType: 'BO-ORH-60',
      parameters: { allowed_types: ['BO-ORH-60'], minimum_penetration_pct: 0 },
      setupContext: SETUP,
      executionEvidence: baseExecution(61, 106),
      intraday: { entrySessionBars: bars, resolution: '1min', resolutionSeconds: 60 }
    });
    expect(result.status).toBe('PASS');
    expect(result.evidence.trigger_cross_number).toBeGreaterThanOrEqual(1);
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
        initialEntryEpoch: beforeOpen,
        initialEntryTime: new Date(beforeOpen * 1000).toISOString()
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
      executionEvidence: baseExecution(61, 106),
      intraday: null
    });
    expect(result.status).toBe('UNKNOWN');
  });
});
