'use strict';

// Actual initial protective-stop evidence (docs/QUALITY_PROFILES_REQUIREMENT.md
// sections 29, 60). TradeTally has one trade-level stop and no stop lifecycle.

const { resolveStopEvidence } = require('../../../../src/services/quality/entry/stopEvidence');

const EXECUTION = {
  available: true,
  direction: 'long',
  entryBasis: 101,
  initialEntryEpoch: 1741613430,
  initialEntryTime: '2026-03-10T13:30:30.000Z'
};

describe('resolveStopEvidence', () => {
  test('uses the stored trade-level stop with explicit provenance and limitations', () => {
    const result = resolveStopEvidence({ trade: { stop_loss: 98.5 }, executionEvidence: EXECUTION });
    expect(result.available).toBe(true);
    expect(result.price).toBe(98.5);
    expect(result.source).toBe('trade_stop_loss_field');
    expect(result.referenceTimeSource).toBe('initial_entry_time');
    expect(result.referenceTime).toBe(EXECUTION.initialEntryTime);
    expect(result.stopEstablishmentTime).toBeNull();
    expect(result.provenance.limitations.length).toBeGreaterThan(0);
  });

  test('a missing stop is UNKNOWN', () => {
    const result = resolveStopEvidence({ trade: { stop_loss: null }, executionEvidence: EXECUTION });
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/UNKNOWN/);
  });

  test('a later risk_level_history stop modification is never used as the initial stop', () => {
    const trade = {
      stop_loss: 98.5,
      // A later stop update stored elsewhere must not redefine the initial stop.
      risk_level_history: [{ timestamp: '2026-03-12T14:00:00Z', old_value: 98.5, new_value: 105 }]
    };
    const result = resolveStopEvidence({ trade, executionEvidence: EXECUTION });
    expect(result.price).toBe(98.5);
    expect(result.referenceTimeSource).toBe('initial_entry_time');
  });
});
