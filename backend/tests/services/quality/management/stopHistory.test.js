'use strict';

const {
  resolveStopHistory,
  resolveStopExecutionClassification,
  evaluateStopRatchet,
  AUDIT_REASON,
  CLASSIFICATION_REASON
} = require('../../../../src/services/quality/management/stopHistory');

describe('resolveStopHistory (capability audit)', () => {
  it('returns UNKNOWN (available: false) without a trustworthy source', () => {
    const result = resolveStopHistory({});
    expect(result.available).toBe(false);
    expect(result.reason).toBe(AUDIT_REASON);
    expect(result.provenance.limitations).toEqual([AUDIT_REASON]);
  });

  it('accepts a trustworthy hook with chronological modifications', () => {
    const result = resolveStopHistory({
      trustedStopHistory: {
        source: 'broker_stop_orders',
        modifications: [
          { epoch: 100, price: 69.3 },
          { epoch: 200, price: 71.0 }
        ]
      }
    });
    expect(result.available).toBe(true);
    expect(result.modifications.map((m) => m.price)).toEqual([69.3, 71.0]);
  });
});

describe('resolveStopExecutionClassification (F4)', () => {
  it('is unavailable in production (no order-type evidence)', () => {
    const result = resolveStopExecutionClassification({});
    expect(result.available).toBe(false);
    expect(result.reason).toBe(CLASSIFICATION_REASON);
  });

  it('accepts a complete trusted classification hook', () => {
    const result = resolveStopExecutionClassification({
      trustedStopExecutionClassification: {
        available: true,
        complete: true,
        byEpoch: { 100: 'protective' },
        source: 'broker_orders'
      }
    });
    expect(result.available).toBe(true);
    expect(result.complete).toBe(true);
    expect(result.byEpoch[100]).toBe('protective');
  });
});

describe('evaluateStopRatchet', () => {
  it('passes a non-decreasing sequence with zero tolerance (tick not required)', () => {
    const result = evaluateStopRatchet({
      modifications: [
        { epoch: 100, price: 69.3 },
        { epoch: 200, price: 71.0 },
        { epoch: 300, price: 71.0 }
      ],
      tickKnown: false,
      downwardToleranceTicks: 0
    });
    expect(result.resolved).toBe(true);
    expect(result.valid).toBe(true);
  });

  it('fails a downward move with zero tolerance without needing a tick', () => {
    const result = evaluateStopRatchet({
      modifications: [
        { epoch: 100, price: 69.3 },
        { epoch: 200, price: 71.0 },
        { epoch: 300, price: 70.5 }
      ],
      tickKnown: false,
      downwardToleranceTicks: 0
    });
    expect(result.resolved).toBe(true);
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
  });

  it('is unresolved when a positive tolerance needs a tick that is not stored', () => {
    const result = evaluateStopRatchet({
      modifications: [
        { epoch: 100, price: 71.0 },
        { epoch: 200, price: 70.99 }
      ],
      tickKnown: false,
      downwardToleranceTicks: 1
    });
    expect(result.resolved).toBe(false);
    expect(result.valid).toBeNull();
  });

  it('uses the tick when it is known for a positive tolerance', () => {
    const result = evaluateStopRatchet({
      modifications: [
        { epoch: 100, price: 71.0 },
        { epoch: 200, price: 70.99 }
      ],
      tickSize: 0.1,
      tickKnown: true,
      downwardToleranceTicks: 0
    });
    // 71.0 -> 70.99 is below one 0.1 tick down, so no full-tick violation.
    expect(result.resolved).toBe(true);
    expect(result.valid).toBe(true);
  });
});
