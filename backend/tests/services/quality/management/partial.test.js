'use strict';

const {
  resolvePartialCompletion,
  resolvePrematureReduction,
  resolvePartialExitSupersession
} = require('../../../../src/services/quality/management/partial');

const UNIT = { known: true, unit: 1, source: 'instrument_type' };
const sessionIndexForDate = (date) => ({ '2026-03-10': 0, '2026-03-11': 1, '2026-03-12': 2, '2026-03-13': 3 }[date] ?? null);

function completion(reductions, overrides = {}) {
  return resolvePartialCompletion({
    reductions,
    originalPositionQty: 200,
    targetFraction: 0.5,
    targetPct: 50,
    quantityUnit: UNIT,
    triggerDueSessionIndex: 2, // 2026-03-12
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
    expect(result.completed).toBe(true);
  });

  it('direct 100% exit is not a compliant 50% partial', () => {
    const result = completion([
      { timeEpoch: 1, quantity: 200, sessionDate: '2026-03-12', cumulativeQty: 200 }
    ]);
    expect(result.completed).toBe(true);
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

  it('later exits never change the recorded partial sizing', () => {
    const early = completion([
      { timeEpoch: 1, quantity: 100, sessionDate: '2026-03-12', cumulativeQty: 100 },
      { timeEpoch: 2, quantity: 100, sessionDate: '2026-03-20', cumulativeQty: 200 }
    ]);
    const later = completion([
      { timeEpoch: 1, quantity: 100, sessionDate: '2026-03-12', cumulativeQty: 100 },
      { timeEpoch: 2, quantity: 100, sessionDate: '2026-04-01', cumulativeQty: 200 }
    ]);
    expect(early.achievedQty).toBe(later.achievedQty);
    expect(early.achievedPct).toBe(later.achievedPct);
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

  it('classifies next-session and later completions', () => {
    expect(completion([{ timeEpoch: 1, quantity: 100, sessionDate: '2026-03-13', cumulativeQty: 100 }]).timingOutcome).toBe('next_session');
    expect(completion([{ timeEpoch: 1, quantity: 100, sessionDate: '2026-04-01', cumulativeQty: 100 }]).timingOutcome).toBe('later_or_not_completed');
  });

  it('reports not completed when the target is never reached', () => {
    const result = completion([
      { timeEpoch: 1, quantity: 40, sessionDate: '2026-03-12', cumulativeQty: 40 }
    ]);
    expect(result.completed).toBe(false);
    expect(result.achievedPct).toBeCloseTo(20);
  });
});

describe('resolvePartialCompletion — tradable-unit rounding (F8)', () => {
  it('101 whole shares at 50%: 50 or 51 completes without a false failure', () => {
    const base = {
      originalPositionQty: 101,
      targetFraction: 0.5,
      targetPct: 50,
      quantityUnit: UNIT,
      triggerDueSessionIndex: 2,
      sessionIndexForDate
    };
    expect(resolvePartialCompletion({ ...base, reductions: [{ timeEpoch: 1, quantity: 51, sessionDate: '2026-03-12', cumulativeQty: 51 }] }).completed).toBe(true);
    expect(resolvePartialCompletion({ ...base, reductions: [{ timeEpoch: 1, quantity: 50, sessionDate: '2026-03-12', cumulativeQty: 50 }] }).completed).toBe(true);
  });

  it('unknown unit + non-integer target => unresolved (caller returns UNKNOWN)', () => {
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

describe('resolvePrematureReduction — evidence discipline (F4)', () => {
  const reductions = [
    { timeEpoch: 100, quantity: 40, sessionDate: '2026-03-10', cumulativeQty: 40 },
    { timeEpoch: 200, quantity: 100, sessionDate: '2026-03-12', cumulativeQty: 140 }
  ];

  it('no pre-boundary reduction => none (may PASS)', () => {
    const result = resolvePrematureReduction({
      reductions,
      originalPositionQty: 200,
      boundarySessionDate: '2026-03-10'
    });
    expect(result.outcome).toBe('none');
    expect(result.prematureFraction).toBe(0);
  });

  it('unclassified pre-trigger reduction => ambiguous, never a fabricated FAIL', () => {
    const result = resolvePrematureReduction({
      reductions,
      originalPositionQty: 200,
      boundarySessionDate: '2026-03-12'
    });
    expect(result.outcome).toBe('ambiguous');
    expect(result.prematureFraction).toBeNull();
    expect(result.ambiguousQty).toBe(40);
  });

  it('trusted protective classification excludes the reduction', () => {
    const result = resolvePrematureReduction({
      reductions,
      originalPositionQty: 200,
      boundarySessionDate: '2026-03-12',
      stopExecutionClassification: { available: true, complete: true, byEpoch: { 100: 'protective' } }
    });
    expect(result.outcome).toBe('none');
    expect(result.excludedQty).toBe(40);
  });

  it('a complete classification marks unmarked reductions discretionary', () => {
    const result = resolvePrematureReduction({
      reductions,
      originalPositionQty: 200,
      boundarySessionDate: '2026-03-12',
      stopExecutionClassification: { available: true, complete: true, byEpoch: { 100: 'discretionary' } }
    });
    expect(result.outcome).toBe('discretionary');
    expect(result.prematureFraction).toBeCloseTo(0.2);
  });
});

describe('resolvePartialExitSupersession', () => {
  const reductions = [
    { timeEpoch: 100, quantity: 200, sessionDate: '2026-03-10', cumulativeQty: 200 }
  ];

  it('proven protective full close before due => superseded_protective', () => {
    const result = resolvePartialExitSupersession({
      reductions,
      originalPositionQty: 200,
      dueSessionDate: '2026-03-12',
      stopExecutionClassification: { available: true, complete: true, byEpoch: { 100: 'protective' } }
    });
    expect(result.outcome).toBe('superseded_protective');
  });

  it('unclassified full close before due => superseded_ambiguous (not mislabeled protective)', () => {
    const result = resolvePartialExitSupersession({
      reductions,
      originalPositionQty: 200,
      dueSessionDate: '2026-03-12'
    });
    expect(result.outcome).toBe('superseded_ambiguous');
  });

  it('a discretionary full close before due => superseded_discretionary', () => {
    const result = resolvePartialExitSupersession({
      reductions,
      originalPositionQty: 200,
      dueSessionDate: '2026-03-12',
      stopExecutionClassification: { available: true, complete: true, byEpoch: { 100: 'discretionary' } }
    });
    expect(result.outcome).toBe('superseded_discretionary');
  });

  it('no close before due => none', () => {
    const result = resolvePartialExitSupersession({
      reductions,
      originalPositionQty: 200,
      dueSessionDate: '2026-03-10'
    });
    expect(result.outcome).toBe('none');
  });
});
