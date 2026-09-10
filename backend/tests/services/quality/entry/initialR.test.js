'use strict';

// Immutable Initial R (docs/QUALITY_PROFILES_REQUIREMENT.md section 30):
// established once, never redefined by a later stop modification, and never
// manufactured from a non-protective stop.

const { computeInitialR, resolveInitialR } = require('../../../../src/services/quality/entry/initialR');

const STOP = {
  available: true,
  price: 99,
  source: 'trade_stop_loss_field'
};

describe('entry Initial R', () => {
  test('R per share and dollar risk derive from entry basis and original position', () => {
    const result = computeInitialR({
      direction: 'long',
      entryBasis: 101,
      originalPositionQty: 250,
      stopEvidence: STOP
    });
    expect(result.available).toBe(true);
    expect(result.r_per_share).toBeCloseTo(2, 12);
    expect(result.initial_risk_dollars).toBeCloseTo(500, 12);
  });

  test('a non-protective stop does not manufacture a positive R', () => {
    const result = computeInitialR({
      direction: 'long',
      entryBasis: 101,
      originalPositionQty: 250,
      stopEvidence: { available: true, price: 102, source: 'trade_stop_loss_field' }
    });
    expect(result.available).toBe(false);
    expect(result.evidence_problem).toBe('non_protective_stop');
    expect(result.r_per_share).toBeNull();
  });

  test('missing stop evidence leaves Initial R unavailable', () => {
    const result = computeInitialR({
      direction: 'long',
      entryBasis: 101,
      originalPositionQty: 250,
      stopEvidence: { available: false, price: null }
    });
    expect(result.available).toBe(false);
  });

  test('an established Initial R is preserved when the frozen inputs are unchanged', () => {
    const computed = computeInitialR({
      direction: 'long',
      entryBasis: 101,
      originalPositionQty: 250,
      stopEvidence: STOP
    });
    const stored = {
      ...computed,
      established_at: '2026-03-10T15:00:00.000Z',
      immutable: true
    };
    const resolved = resolveInitialR({ computed, storedInitialR: stored });
    expect(resolved.preserved).toBe(true);
    expect(resolved.established_at).toBe('2026-03-10T15:00:00.000Z');
    expect(resolved.initial_risk_dollars).toBeCloseTo(500, 12);
  });

  test('a changed initial stop legitimately establishes a new Initial R', () => {
    const computed = computeInitialR({
      direction: 'long',
      entryBasis: 101,
      originalPositionQty: 250,
      stopEvidence: { available: true, price: 98, source: 'trade_stop_loss_field' }
    });
    const stored = {
      available: true,
      r_per_share: 2,
      initial_risk_dollars: 500,
      entry_basis: 101,
      initial_stop: 99,
      original_position_qty: 250,
      established_at: '2026-03-10T15:00:00.000Z'
    };
    const resolved = resolveInitialR({ computed, storedInitialR: stored, now: new Date('2026-03-11T00:00:00Z') });
    expect(resolved.preserved).toBe(false);
    expect(resolved.initial_stop).toBe(98);
    expect(resolved.established_at).toBe('2026-03-11T00:00:00.000Z');
  });
});
