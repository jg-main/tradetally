'use strict';

const {
  resolveStopHistory,
  evaluateStopRatchet,
  AUDIT_REASON
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
    expect(result.source).toBe('broker_stop_orders');
  });
});

describe('evaluateStopRatchet', () => {
  it('passes a non-decreasing sequence', () => {
    const result = evaluateStopRatchet({
      modifications: [
        { epoch: 100, price: 69.3 },
        { epoch: 200, price: 71.0 },
        { epoch: 300, price: 71.0 }
      ],
      tickSize: 0.01,
      downwardToleranceTicks: 0
    });
    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('fails a downward move (even if still above the original stop)', () => {
    const result = evaluateStopRatchet({
      modifications: [
        { epoch: 100, price: 69.3 },
        { epoch: 200, price: 71.0 },
        { epoch: 300, price: 70.5 }
      ],
      tickSize: 0.01,
      downwardToleranceTicks: 0
    });
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].fromPrice).toBe(71.0);
    expect(result.violations[0].toPrice).toBe(70.5);
  });

  it('normalizes prices to the configured tick before comparison', () => {
    const result = evaluateStopRatchet({
      modifications: [
        { epoch: 100, price: 71.0 },
        { epoch: 200, price: 70.99 }
      ],
      tickSize: 0.1,
      downwardToleranceTicks: 0
    });
    // 71.0 -> 70.99 is 0.1 ticks down at tick size 0.1, not a full tick down.
    expect(result.valid).toBe(true);
  });
});
