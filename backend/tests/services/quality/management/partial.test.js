'use strict';

const {
  resolvePartialCompletion,
  resolvePrematureReduction
} = require('../../../../src/services/quality/management/partial');

describe('resolvePartialCompletion', () => {
  const base = {
    originalPositionQty: 200,
    targetPct: 50,
    triggerDueSessionDate: '2026-03-05',
    nextSessionDate: '2026-03-06'
  };

  it('multiple fills can satisfy the 50% target', () => {
    const result = resolvePartialCompletion({
      ...base,
      reductions: [
        { timeEpoch: 100, quantity: 40, sessionDate: '2026-03-05', cumulativeQty: 40 },
        { timeEpoch: 200, quantity: 35, sessionDate: '2026-03-05', cumulativeQty: 75 },
        { timeEpoch: 300, quantity: 25, sessionDate: '2026-03-05', cumulativeQty: 100 }
      ]
    });
    expect(result.completed).toBe(true);
    expect(result.achievedPct).toBeCloseTo(50);
    expect(result.timingOutcome).toBe('same_trigger_session');
  });

  it('computes achieved percentage against the ORIGINAL position', () => {
    const result = resolvePartialCompletion({
      ...base,
      reductions: [
        { timeEpoch: 100, quantity: 100, sessionDate: '2026-03-05', cumulativeQty: 100 }
      ]
    });
    expect(result.achievedPct).toBeCloseTo(50);
  });

  it('classifies completion next session', () => {
    const result = resolvePartialCompletion({
      ...base,
      reductions: [
        { timeEpoch: 100, quantity: 100, sessionDate: '2026-03-06', cumulativeQty: 100 }
      ]
    });
    expect(result.timingOutcome).toBe('next_session');
  });

  it('classifies later completion', () => {
    const result = resolvePartialCompletion({
      ...base,
      reductions: [
        { timeEpoch: 100, quantity: 100, sessionDate: '2026-03-08', cumulativeQty: 100 }
      ]
    });
    expect(result.timingOutcome).toBe('later_or_not_completed');
  });

  it('reports not completed when the target is never reached', () => {
    const result = resolvePartialCompletion({
      ...base,
      reductions: [
        { timeEpoch: 100, quantity: 40, sessionDate: '2026-03-05', cumulativeQty: 40 }
      ]
    });
    expect(result.completed).toBe(false);
    expect(result.timingOutcome).toBe('later_or_not_completed');
  });
});

describe('resolvePrematureReduction', () => {
  it('returns zero premature reduction when nothing reduced before the boundary', () => {
    const result = resolvePrematureReduction({
      reductions: [
        { timeEpoch: 100, quantity: 100, sessionDate: '2026-03-05', cumulativeQty: 100 }
      ],
      originalPositionQty: 200,
      boundarySessionDate: '2026-03-05'
    });
    expect(result.prematureQty).toBe(0);
    expect(result.prematureFraction).toBe(0);
  });

  it('counts reductions before the boundary as premature', () => {
    const result = resolvePrematureReduction({
      reductions: [
        { timeEpoch: 100, quantity: 40, sessionDate: '2026-03-03', cumulativeQty: 40 },
        { timeEpoch: 200, quantity: 100, sessionDate: '2026-03-05', cumulativeQty: 140 }
      ],
      originalPositionQty: 200,
      boundarySessionDate: '2026-03-05'
    });
    expect(result.prematureQty).toBe(40);
    expect(result.prematureFraction).toBeCloseTo(0.2);
  });

  it('excludes trusted protective-stop executions from premature reduction', () => {
    const result = resolvePrematureReduction({
      reductions: [
        { timeEpoch: 100, quantity: 40, sessionDate: '2026-03-03', cumulativeQty: 40 },
        { timeEpoch: 200, quantity: 60, sessionDate: '2026-03-04', cumulativeQty: 100 }
      ],
      originalPositionQty: 200,
      boundarySessionDate: '2026-03-05',
      protectiveStopExecutions: [{ epoch: 100, quantity: 40 }]
    });
    expect(result.prematureQty).toBe(60);
    expect(result.excludedQty).toBe(40);
  });
});
