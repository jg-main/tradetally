'use strict';

// Actual initial protective-stop evidence (docs/QUALITY_PROFILES_REQUIREMENT.md
// sections 29, 60; Phase 3 hardening finding 3).
//
// TradeTally has no stop-order lifecycle: `trade.stop_loss` may be a
// planned/default/current value, so it is NEVER proof of the first actual
// protective stop.

const { resolveStopEvidence, REFERENCE_SOURCE } = require('../../../../src/services/quality/entry/stopEvidence');

const EXECUTION = {
  available: true,
  direction: 'long',
  entryBasis: 101,
  initialEntryEpoch: 1741613430,
  initialEntryTime: '2026-03-10T13:30:30.000Z'
};

describe('resolveStopEvidence', () => {
  test('a current/planned trade.stop_loss is NOT actual initial-stop evidence', () => {
    const result = resolveStopEvidence({ trade: { stop_loss: 98.5 }, executionEvidence: EXECUTION });
    expect(result.available).toBe(false);
    expect(result.price).toBeNull();
    expect(result.reason).toMatch(/UNKNOWN/);
    // The stored level is still surfaced as a reference stop.
    expect(result.referenceStop).toEqual({
      price: 98.5,
      source: REFERENCE_SOURCE,
      semantics: 'planned_or_current_trade_stop'
    });
    expect(result.provenance.limitations.length).toBeGreaterThan(0);
  });

  test('a missing stop is UNKNOWN', () => {
    const result = resolveStopEvidence({ trade: { stop_loss: null }, executionEvidence: EXECUTION });
    expect(result.available).toBe(false);
    expect(result.referenceStop).toBeNull();
  });

  test('a later risk_level_history stop modification is never used as the initial stop', () => {
    const trade = {
      stop_loss: 98.5,
      risk_level_history: [{ timestamp: '2026-03-12T14:00:00Z', old_value: 98.5, new_value: 105 }]
    };
    const result = resolveStopEvidence({ trade, executionEvidence: EXECUTION });
    expect(result.available).toBe(false);
    expect(result.price).toBeNull();
    expect(result.referenceStop.price).toBe(98.5);
  });

  test('a genuinely trustworthy initial-stop source may produce known results with provenance', () => {
    const result = resolveStopEvidence({
      trade: { stop_loss: 98.5 },
      executionEvidence: EXECUTION,
      trustedInitialStop: {
        price: 99,
        source: 'broker_stop_order',
        establishmentEpoch: EXECUTION.initialEntryEpoch,
        provenance: 'Broker stop order #1 accepted at entry.'
      }
    });
    expect(result.available).toBe(true);
    expect(result.price).toBe(99);
    expect(result.source).toBe('broker_stop_order');
    expect(result.referenceTimeSource).toBe('stop_establishment_time');
  });
});
