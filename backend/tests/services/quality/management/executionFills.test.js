'use strict';

const {
  reconstructManagementFills,
  reconstructReductions,
  closingFills
} = require('../../../../src/services/quality/management/executionFills');

const sessionDateInZone = (epoch) => {
  // Deterministic session dates for test epochs (each +86400 = next day).
  const days = Math.floor(epoch / 86400);
  return `2026-03-${String(2 + (days % 28)).padStart(2, '0')}`;
};

function longTradeExecutions() {
  return [
    { datetime: 1000, action: 'buy', quantity: 100, price: 100 },
    { datetime: 2000, action: 'buy', quantity: 150, price: 100.5 },
    { datetime: 3000, action: 'sell', quantity: 125, price: 106 },
    { datetime: 4000, action: 'sell', quantity: 125, price: 108 }
  ];
}

describe('reconstructManagementFills', () => {
  it('reconstructs full chronological opening + closing fills for a long trade', () => {
    const trade = { side: 'long', executions: longTradeExecutions() };
    const result = reconstructManagementFills(trade);
    expect(result.available).toBe(true);
    expect(result.direction).toBe('long');
    expect(result.fills.map((f) => f.action)).toEqual(['buy', 'buy', 'sell', 'sell']);
    expect(result.fills.map((f) => f.quantity)).toEqual([100, 150, 125, 125]);
  });

  it('returns null when no fills exist', () => {
    expect(reconstructManagementFills({ side: 'long', executions: [] })).toBeNull();
  });

  it('classifies closing fills for the trade direction', () => {
    const result = reconstructManagementFills({ side: 'long', executions: longTradeExecutions() });
    const closes = closingFills(result.fills, 'long');
    expect(closes.map((f) => f.quantity)).toEqual([125, 125]);
  });
});

describe('reconstructReductions', () => {
  it('sums reductions and tracks the final closing fill', () => {
    const result = reconstructManagementFills({ side: 'long', executions: longTradeExecutions() });
    const reductions = reconstructReductions({
      fills: result.fills,
      direction: 'long',
      originalPositionQty: 250,
      sessionDateInZone
    });
    expect(reductions.totalReductionQty).toBe(250);
    expect(reductions.positionClosed).toBe(true);
    expect(reductions.remainingQty).toBe(0);
    expect(reductions.reductions.map((r) => r.cumulativeQty)).toEqual([125, 250]);
  });

  it('marks a position not closed when reductions are below the original quantity', () => {
    const result = reconstructManagementFills({
      side: 'long',
      executions: [
        { datetime: 1000, action: 'buy', quantity: 200, price: 100 },
        { datetime: 2000, action: 'sell', quantity: 100, price: 106 }
      ]
    });
    const reductions = reconstructReductions({
      fills: result.fills,
      direction: 'long',
      originalPositionQty: 200,
      sessionDateInZone
    });
    expect(reductions.positionClosed).toBe(false);
    expect(reductions.remainingQty).toBe(100);
  });
});
