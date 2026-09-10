'use strict';

// Immutable Initial R (docs/QUALITY_PROFILES_REQUIREMENT.md section 30;
// Phase 3 hardening finding 4): once established in an evaluation it is frozen.
// A later stop change, position edit, or conflicting evidence must NOT redefine
// it inside the same evaluation.

const { computeInitialR, resolveInitialR } = require('../../../../src/services/quality/entry/initialR');

const STOP = { available: true, price: 99, source: 'trusted_source' };

function computedFor(stopPrice, entryBasis = 101, originalPositionQty = 250) {
  return computeInitialR({
    direction: 'long',
    entryBasis,
    originalPositionQty,
    stopEvidence: { available: true, price: stopPrice, source: 'trusted_source' }
  });
}

describe('entry Initial R', () => {
  test('R per share and dollar risk derive from entry basis and original position', () => {
    const result = computedFor(99);
    expect(result.available).toBe(true);
    expect(result.r_per_share).toBeCloseTo(2, 12);
    expect(result.initial_risk_dollars).toBeCloseTo(500, 12);
  });

  test('a non-protective stop does not manufacture a positive R', () => {
    const result = computedFor(102);
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

  test('a later stop change (95 -> 97) does NOT redefine an established Initial R', () => {
    const stored = {
      ...computedFor(95),
      established_at: '2026-03-10T15:00:00.000Z',
      immutable: true
    };
    const resolved = resolveInitialR({ computed: computedFor(97), storedInitialR: stored });
    expect(resolved.preserved).toBe(true);
    expect(resolved.frozen).toBe(true);
    expect(resolved.initial_stop).toBe(95);
    expect(resolved.r_per_share).toBeCloseTo(6, 12);
    expect(resolved.established_at).toBe('2026-03-10T15:00:00.000Z');
    expect(resolved.conflict).toBe(true);
    expect(resolved.conflict_fields).toContain('initial_stop');
  });

  test('a later disappearance of current stop evidence keeps the frozen R', () => {
    const stored = {
      ...computedFor(95),
      established_at: '2026-03-10T15:00:00.000Z',
      immutable: true
    };
    const resolved = resolveInitialR({
      computed: { available: false, reason: 'no current stop' },
      storedInitialR: stored
    });
    expect(resolved.frozen).toBe(true);
    expect(resolved.initial_risk_dollars).toBeCloseTo(1500, 12);
    expect(resolved.conflict_fields).toContain('current_evidence_unavailable');
  });

  test('conflicting entry-basis/position evidence cannot silently produce a new R', () => {
    const stored = {
      ...computedFor(99, 101, 250),
      established_at: '2026-03-10T15:00:00.000Z',
      immutable: true
    };
    const resolved = resolveInitialR({
      computed: computedFor(99, 110, 100),
      storedInitialR: stored
    });
    expect(resolved.entry_basis).toBe(101);
    expect(resolved.original_position_qty).toBe(250);
    expect(resolved.conflict_fields).toEqual(
      expect.arrayContaining(['entry_basis', 'original_position_qty'])
    );
  });

  test('an initially-unavailable Initial R may be established once and then frozen', () => {
    const once = resolveInitialR({
      computed: computedFor(99),
      storedInitialR: { available: false, established_at: null }
    });
    expect(once.available).toBe(true);
    expect(once.frozen).toBe(true);
    expect(once.established_at).toBeTruthy();

    const rerun = resolveInitialR({ computed: computedFor(99), storedInitialR: once });
    expect(rerun.preserved).toBe(true);
    expect(rerun.established_at).toBe(once.established_at);
  });
});
