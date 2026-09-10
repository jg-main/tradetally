'use strict';

// Original Position / Entry Basis normalization
// (docs/QUALITY_PROFILES_REQUIREMENT.md section 28).

const { normalizeExecutionEvidence } = require('../../../../src/services/quality/executionEvidenceService');

function longTrade(executions, overrides = {}) {
  return {
    side: 'long',
    executions,
    entry_time: null,
    entry_price: null,
    quantity: null,
    ...overrides
  };
}

describe('executionEvidenceService', () => {
  test('multiple opening fills before the first reduction are weighted correctly', () => {
    const trade = longTrade([
      { action: 'buy', quantity: 100, price: 10, datetime: '2026-03-10T13:31:00Z' },
      { action: 'buy', quantity: 100, price: 11, datetime: '2026-03-10T13:32:00Z' },
      { action: 'buy', quantity: 50, price: 12, datetime: '2026-03-10T13:33:00Z' },
      { action: 'sell', quantity: 125, price: 13, datetime: '2026-03-10T14:00:00Z' }
    ]);
    const evidence = normalizeExecutionEvidence(trade);
    expect(evidence.available).toBe(true);
    expect(evidence.originalPositionQty).toBe(250);
    expect(evidence.entryBasis).toBeCloseTo((1000 + 1100 + 600) / 250, 12);
    expect(evidence.initialEntryTime).toBe('2026-03-10T13:31:00.000Z');
    expect(evidence.actualEntrySession).toBe('2026-03-10');
    expect(evidence.firstReductionTime).toBe('2026-03-10T14:00:00.000Z');
    expect(evidence.fills).toHaveLength(3);
    expect(evidence.fills.every((fill) => fill.source === 'executions_jsonb')).toBe(true);
  });

  test('a later opening fill AFTER the first reduction never changes original position or basis', () => {
    const trade = longTrade([
      { action: 'buy', quantity: 100, price: 10, datetime: '2026-03-10T13:31:00Z' },
      { action: 'buy', quantity: 100, price: 11, datetime: '2026-03-10T13:32:00Z' },
      { action: 'sell', quantity: 50, price: 13, datetime: '2026-03-10T14:00:00Z' },
      { action: 'buy', quantity: 999, price: 1, datetime: '2026-03-10T15:00:00Z' }
    ]);
    const evidence = normalizeExecutionEvidence(trade);
    expect(evidence.originalPositionQty).toBe(200);
    expect(evidence.entryBasis).toBeCloseTo(10.5, 12);
    expect(evidence.firstReductionTime).toBe('2026-03-10T14:00:00.000Z');
  });

  test('grouped round-trip execution shape is supported', () => {
    const trade = longTrade([
      { entry_price: 20, entry_time: '2026-03-10T13:31:00Z', exit_price: 25, exit_time: '2026-03-12T14:00:00Z', quantity: 100 }
    ]);
    const evidence = normalizeExecutionEvidence(trade);
    expect(evidence.originalPositionQty).toBe(100);
    expect(evidence.entryBasis).toBe(20);
    expect(evidence.firstReductionTime).toBe('2026-03-12T14:00:00.000Z');
  });

  test('trade-level fallback is used with explicit provenance when fills are absent', () => {
    const trade = longTrade([], {
      entry_time: '2026-03-10T13:31:00Z',
      entry_price: 25,
      quantity: 100
    });
    const evidence = normalizeExecutionEvidence(trade);
    expect(evidence.available).toBe(true);
    expect(evidence.originalPositionQty).toBe(100);
    expect(evidence.entryBasis).toBe(25);
    expect(evidence.provenance.source).toBe('trade_level_fields');
    expect(evidence.provenance.limitations.length).toBeGreaterThan(0);
  });

  test('missing execution evidence is reported as unavailable', () => {
    const evidence = normalizeExecutionEvidence(longTrade([]));
    expect(evidence.available).toBe(false);
    expect(evidence.unavailableReason).toMatch(/could not be established/);
  });
});
