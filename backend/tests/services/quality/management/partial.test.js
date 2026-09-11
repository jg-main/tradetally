'use strict';

const {
  resolvePartialCompletion,
  resolvePrematureReduction,
  resolvePartialExitSupersession,
  relationToBoundary
} = require('../../../../src/services/quality/management/partial');

const UNIT = { known: true, unit: 1, source: 'instrument_type' };
const sessionIndexForDate = (date) => ({ '2026-03-10': 0, '2026-03-11': 1, '2026-03-12': 2, '2026-03-13': 3, '2026-03-20': 10 }[date] ?? null);

// A boundary on 2026-03-12 whose regular session is [1_000_000, 1_023_400).
function boundaryAt(epoch, overrides = {}) {
  return {
    mode: 'instant',
    kind: 'crossing',
    sessionDate: '2026-03-12',
    epoch,
    orderingKnown: true,
    precision: '1min_bar',
    source: 'intraday_cache',
    sessionOpenEpoch: 1_000_000,
    sessionCloseEpoch: 1_023_400,
    ...overrides
  };
}

function completion(reductions, overrides = {}) {
  return resolvePartialCompletion({
    reductions,
    originalPositionQty: 200,
    targetFraction: 0.5,
    targetPct: 50,
    quantityUnit: UNIT,
    triggerDueSessionIndex: 2,
    sessionIndexForDate,
    ...overrides
  });
}

describe('resolvePartialCompletion — sizing at the partial event (F1)', () => {
  it('50% canonical partial + later final exit => 50% sizing', () => {
    const result = completion([
      { timeEpoch: 1, quantity: 100, sessionDate: '2026-03-12', cumulativeQty: 100 },
      { timeEpoch: 2, quantity: 100, sessionDate: '2026-03-20', cumulativeQty: 200 }
    ]);
    expect(result.completed).toBe(true);
    expect(result.achievedQty).toBe(100);
    expect(result.achievedPct).toBeCloseTo(50);
    expect(result.timingOutcome).toBe('same_trigger_session');
  });

  it('40% early + 10% later qualifying + final exit => partial event is 50%', () => {
    const result = completion([
      { timeEpoch: 1, quantity: 80, sessionDate: '2026-03-09', cumulativeQty: 80 },
      { timeEpoch: 2, quantity: 20, sessionDate: '2026-03-12', cumulativeQty: 100 },
      { timeEpoch: 3, quantity: 100, sessionDate: '2026-03-20', cumulativeQty: 200 }
    ]);
    expect(result.achievedQty).toBe(100);
    expect(result.achievedPct).toBeCloseTo(50);
  });

  it('direct 100% exit is not a compliant 50% partial', () => {
    const result = completion([
      { timeEpoch: 1, quantity: 200, sessionDate: '2026-03-12', cumulativeQty: 200 }
    ]);
    expect(result.achievedQty).toBe(200);
    expect(result.achievedPct).toBeCloseTo(100);
  });

  it('oversize partial is graded from the quantity at the partial event', () => {
    const result = completion([
      { timeEpoch: 1, quantity: 130, sessionDate: '2026-03-12', cumulativeQty: 130 },
      { timeEpoch: 2, quantity: 70, sessionDate: '2026-03-20', cumulativeQty: 200 }
    ]);
    expect(result.achievedQty).toBe(130);
    expect(result.achievedPct).toBeCloseTo(65);
  });

  it('multiple fills can satisfy the target', () => {
    const result = completion([
      { timeEpoch: 1, quantity: 40, sessionDate: '2026-03-12', cumulativeQty: 40 },
      { timeEpoch: 2, quantity: 35, sessionDate: '2026-03-12', cumulativeQty: 75 },
      { timeEpoch: 3, quantity: 25, sessionDate: '2026-03-12', cumulativeQty: 100 }
    ]);
    expect(result.completed).toBe(true);
    expect(result.achievedQty).toBe(100);
  });

  it('101 whole shares at 50%: 50 or 51 completes without a false failure', () => {
    const base = { originalPositionQty: 101, quantityUnit: UNIT, triggerDueSessionIndex: 2, sessionIndexForDate };
    expect(resolvePartialCompletion({ ...base, targetFraction: 0.5, targetPct: 50, reductions: [{ timeEpoch: 1, quantity: 51, sessionDate: '2026-03-12', cumulativeQty: 51 }] }).completed).toBe(true);
    expect(resolvePartialCompletion({ ...base, targetFraction: 0.5, targetPct: 50, reductions: [{ timeEpoch: 1, quantity: 50, sessionDate: '2026-03-12', cumulativeQty: 50 }] }).completed).toBe(true);
  });

  it('unknown unit + non-integer target => unresolved', () => {
    const result = resolvePartialCompletion({
      reductions: [{ timeEpoch: 1, quantity: 50, sessionDate: '2026-03-12', cumulativeQty: 50 }],
      originalPositionQty: 101,
      targetFraction: 0.5,
      targetPct: 50,
      quantityUnit: { known: false, unit: null },
      triggerDueSessionIndex: 2,
      sessionIndexForDate
    });
    expect(result.rounding.resolved).toBe(false);
    expect(result.rounding.reason).toBe('quantity_unit_unknown');
  });
});

describe('resolvePartialCompletion — boundary-verified same-session timing (F1)', () => {
  it('a same-session fill after the crossing is an on-time same-session completion', () => {
    const result = completion(
      [{ timeEpoch: 1_010_000, quantity: 100, sessionDate: '2026-03-12', cumulativeQty: 100 }],
      { boundary: boundaryAt(1_005_000) }
    );
    expect(result.timingOutcome).toBe('same_trigger_session');
    expect(result.completionRelation).toBe('same_after');
  });

  it('a same-session fill BEFORE the crossing is pre-trigger, never on-time', () => {
    const result = completion(
      [{ timeEpoch: 1_002_000, quantity: 100, sessionDate: '2026-03-12', cumulativeQty: 100 }],
      { boundary: boundaryAt(1_005_000) }
    );
    expect(result.completed).toBe(true);
    expect(result.timingOutcome).toBe('pre_trigger');
    expect(result.completionRelation).toBe('same_before');
  });

  it('a target reached completely before the trigger is pre-trigger', () => {
    const result = completion(
      [{ timeEpoch: 1, quantity: 200, sessionDate: '2026-03-09', cumulativeQty: 200 }],
      { boundary: boundaryAt(1_005_000) }
    );
    expect(result.timingOutcome).toBe('pre_trigger');
  });

  it('missing crossing instant + same-session reduction => unknown ordering', () => {
    const result = completion(
      [{ timeEpoch: 1_010_000, quantity: 100, sessionDate: '2026-03-12', cumulativeQty: 100 }],
      { boundary: boundaryAt(null, { orderingKnown: false }) }
    );
    expect(result.timingOutcome).toBe('unknown_ordering');
    expect(result.completionRelation).toBe('same_unknown');
  });

  it('an after-hours same-date completion is not a same-regular-session completion', () => {
    const result = completion(
      [{ timeEpoch: 1_030_000, quantity: 100, sessionDate: '2026-03-12', cumulativeQty: 100 }],
      { boundary: boundaryAt(1_005_000) }
    );
    expect(result.completionRelation).toBe('after_hours');
    expect(result.timingOutcome).toBe('later_or_not_completed');
  });
});

describe('resolvePrematureReduction — point-in-time boundary (F1/F4)', () => {
  const reductions = [
    { timeEpoch: 100, quantity: 40, sessionDate: '2026-03-12', cumulativeQty: 40 },
    { timeEpoch: 200, quantity: 100, sessionDate: '2026-03-12', cumulativeQty: 140 }
  ];

  it('a same-day reduction after the crossing is not premature', () => {
    const result = resolvePrematureReduction({
      reductions,
      originalPositionQty: 200,
      boundary: boundaryAt(50)
    });
    expect(result.outcome).toBe('none');
  });

  it('a same-day reduction before the crossing is premature (Day 4 10:00 vs 11:17)', () => {
    const result = resolvePrematureReduction({
      reductions: [{ timeEpoch: 1_003_600, quantity: 40, sessionDate: '2026-03-12', cumulativeQty: 40 }],
      originalPositionQty: 200,
      boundary: boundaryAt(1_007_820) // 11:17 ET in this synthetic scale
    });
    expect(result.outcome).toBe('ambiguous');
    expect(result.ambiguousQty).toBe(40);
  });

  it('a same-day reduction after the crossing is not premature (Day 4 11:30 vs 11:17)', () => {
    const result = resolvePrematureReduction({
      reductions: [{ timeEpoch: 1_008_600, quantity: 40, sessionDate: '2026-03-12', cumulativeQty: 40 }],
      originalPositionQty: 200,
      boundary: boundaryAt(1_007_820)
    });
    expect(result.outcome).toBe('none');
  });

  it('unknown crossing time + same-day reduction => ambiguous, never a fabricated PASS/FAIL', () => {
    const result = resolvePrematureReduction({
      reductions: [{ timeEpoch: 1_003_600, quantity: 40, sessionDate: '2026-03-12', cumulativeQty: 40 }],
      originalPositionQty: 200,
      boundary: boundaryAt(null, { orderingKnown: false })
    });
    expect(result.outcome).toBe('ambiguous');
    expect(result.prematureFraction).toBeNull();
  });

  it('a premarket reduction on the due session is before the boundary', () => {
    const result = resolvePrematureReduction({
      reductions: [{ timeEpoch: 990_000, quantity: 40, sessionDate: '2026-03-12', cumulativeQty: 40 }],
      originalPositionQty: 200,
      boundary: boundaryAt(1_007_820)
    });
    expect(result.outcome).toBe('ambiguous');
    expect(result.ambiguousQty).toBe(40);
  });

  it('a reduction before the due session is premature', () => {
    const result = resolvePrematureReduction({
      reductions: [{ timeEpoch: 100, quantity: 40, sessionDate: '2026-03-10', cumulativeQty: 40 }],
      originalPositionQty: 200,
      boundary: boundaryAt(1_007_820)
    });
    expect(result.outcome).toBe('ambiguous');
    expect(result.ambiguousQty).toBe(40);
  });

  it('trusted protective classification excludes the reduction', () => {
    const result = resolvePrematureReduction({
      reductions: [{ timeEpoch: 100, quantity: 40, sessionDate: '2026-03-10', cumulativeQty: 40 }],
      originalPositionQty: 200,
      boundary: boundaryAt(1_007_820),
      stopExecutionClassification: { available: true, complete: true, byEpoch: { 100: 'protective' } }
    });
    expect(result.outcome).toBe('none');
    expect(result.excludedQty).toBe(40);
  });

  it('a complete classification marks unmarked reductions discretionary', () => {
    const result = resolvePrematureReduction({
      reductions: [{ timeEpoch: 100, quantity: 40, sessionDate: '2026-03-10', cumulativeQty: 40 }],
      originalPositionQty: 200,
      boundary: boundaryAt(1_007_820),
      stopExecutionClassification: { available: true, complete: true, byEpoch: { 100: 'discretionary' } }
    });
    expect(result.outcome).toBe('discretionary');
    expect(result.prematureFraction).toBeCloseTo(0.2);
  });

  it('no reductions => none', () => {
    const result = resolvePrematureReduction({ reductions: [], originalPositionQty: 200, boundary: boundaryAt(50) });
    expect(result.outcome).toBe('none');
  });

  it('a session-granularity (window-end) boundary treats a same-session reduction as ambiguous', () => {
    const sessionBoundary = { mode: 'session', kind: 'window_end', sessionDate: '2026-03-12', epoch: null, orderingKnown: false };
    const result = resolvePrematureReduction({
      reductions: [{ timeEpoch: 1_003_600, quantity: 40, sessionDate: '2026-03-12', cumulativeQty: 40 }],
      originalPositionQty: 200,
      boundary: sessionBoundary
    });
    expect(result.outcome).toBe('ambiguous');
    expect(result.ambiguousQty).toBe(40);
  });
});

describe('resolvePartialExitSupersession — boundary (F1/F4)', () => {
  const reductions = [{ timeEpoch: 100, quantity: 200, sessionDate: '2026-03-10', cumulativeQty: 200 }];

  it('proven protective full close before the boundary => superseded_protective', () => {
    const result = resolvePartialExitSupersession({
      reductions,
      originalPositionQty: 200,
      boundary: boundaryAt(1_007_820),
      stopExecutionClassification: { available: true, complete: true, byEpoch: { 100: 'protective' } }
    });
    expect(result.outcome).toBe('superseded_protective');
  });

  it('unclassified full close before the boundary => superseded_ambiguous', () => {
    const result = resolvePartialExitSupersession({ reductions, originalPositionQty: 200, boundary: boundaryAt(1_007_820) });
    expect(result.outcome).toBe('superseded_ambiguous');
  });

  it('a close after the boundary => none', () => {
    const after = [{ timeEpoch: 1_010_000, quantity: 200, sessionDate: '2026-03-12', cumulativeQty: 200 }];
    const result = resolvePartialExitSupersession({ reductions: after, originalPositionQty: 200, boundary: boundaryAt(1_005_000) });
    expect(result.outcome).toBe('none');
  });
});

describe('relationToBoundary', () => {
  const b = boundaryAt(1_005_000);
  it('classifies reductions around the boundary instant and session', () => {
    expect(relationToBoundary({ sessionDate: '2026-03-11', timeEpoch: 1 }, b)).toBe('before_session');
    expect(relationToBoundary({ sessionDate: '2026-03-12', timeEpoch: 1 }, b)).toBe('same_before');
    expect(relationToBoundary({ sessionDate: '2026-03-12', timeEpoch: 1_005_000 }, b)).toBe('same_after');
    expect(relationToBoundary({ sessionDate: '2026-03-12', timeEpoch: 1_030_000 }, b)).toBe('after_hours');
    expect(relationToBoundary({ sessionDate: '2026-03-13', timeEpoch: 1_050_000 }, b)).toBe('after');
  });

  it('treats a same-session reduction against a session-granularity boundary as unknown ordering', () => {
    const sessionBoundary = { mode: 'session', kind: 'window_end', sessionDate: '2026-03-12', epoch: null, orderingKnown: false, sessionCloseEpoch: 1_023_400 };
    expect(relationToBoundary({ sessionDate: '2026-03-12', timeEpoch: 1_003_600 }, sessionBoundary)).toBe('same_unknown');
    expect(relationToBoundary({ sessionDate: '2026-03-11', timeEpoch: 1 }, sessionBoundary)).toBe('before_session');
    expect(relationToBoundary({ sessionDate: '2026-03-13', timeEpoch: 1 }, sessionBoundary)).toBe('after');
  });

  it('treats an after-hours reduction on a session-granularity boundary session as after_hours', () => {
    const sessionBoundary = { mode: 'session', kind: 'window_end', sessionDate: '2026-03-12', epoch: null, orderingKnown: false, sessionCloseEpoch: 1_023_400 };
    expect(relationToBoundary({ sessionDate: '2026-03-12', timeEpoch: 1_030_000 }, sessionBoundary)).toBe('after_hours');
  });
});
