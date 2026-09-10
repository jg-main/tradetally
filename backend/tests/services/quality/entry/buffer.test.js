'use strict';

// Typed stop-buffer methods (docs/QUALITY_PROFILES_REQUIREMENT.md section 29.3;
// Phase 3 hardening finding 6: no fabricated stock tick size).

const {
  resolveBuffer,
  resolveTickSize
} = require('../../../../src/services/quality/entry/buffer');

const ADR = { available: true, dollars: 4 };
const ATR = { available: true, dollars: 3 };

describe('entry stop buffer', () => {
  test('minimum_tick uses the stored instrument tick size', () => {
    const result = resolveBuffer({
      criterionParameters: { minimum_buffer_method: 'minimum_tick', minimum_buffer_value: 2 },
      entryBasis: 101,
      volatilityByMethod: { ADR, ATR },
      trade: { instrument_type: 'stock', tick_size: 0.05 }
    });
    expect(result.available).toBe(true);
    expect(result.buffer).toBeCloseTo(0.1, 12);
    expect(result.source).toBe('instrument_tick_size');
  });

  test('a known futures contract tick size is used', () => {
    const tick = resolveTickSize({
      trade: { instrument_type: 'future', underlying_asset: 'ES' }
    });
    expect(tick.available).toBe(true);
    expect(tick.source).toBe('futures_contract_tick_size');
  });

  test('a stock with NO stored tick size cannot resolve minimum_tick', () => {
    const tick = resolveTickSize({ trade: { instrument_type: 'stock' } });
    expect(tick.available).toBe(false);
    const result = resolveBuffer({
      criterionParameters: { minimum_buffer_method: 'minimum_tick', minimum_buffer_value: 1 },
      entryBasis: 101,
      volatilityByMethod: { ADR, ATR },
      trade: { instrument_type: 'stock' }
    });
    expect(result.available).toBe(false);
    // No guessed increment may ever produce a buffer (hence no Initial Stop grade).
    expect(result.buffer).toBeNull();
  });

  test('an option without a stored tick size cannot resolve a buffer', () => {
    const result = resolveBuffer({
      criterionParameters: { minimum_buffer_method: 'minimum_tick', minimum_buffer_value: 1 },
      entryBasis: 2,
      volatilityByMethod: { ADR, ATR },
      trade: { instrument_type: 'option' }
    });
    expect(result.available).toBe(false);
  });

  test('fixed_dollars, percentage, ADR_fraction and ATR_fraction are typed', () => {
    expect(resolveBuffer({
      criterionParameters: { minimum_buffer_method: 'fixed_dollars', minimum_buffer_value: 0.25 },
      entryBasis: 101, volatilityByMethod: { ADR, ATR }, trade: {}
    }).buffer).toBeCloseTo(0.25, 12);

    expect(resolveBuffer({
      criterionParameters: { minimum_buffer_method: 'percentage', minimum_buffer_value: 1 },
      entryBasis: 100, volatilityByMethod: { ADR, ATR }, trade: {}
    }).buffer).toBeCloseTo(1, 12);

    expect(resolveBuffer({
      criterionParameters: { minimum_buffer_method: 'ADR_fraction', minimum_buffer_value: 0.5 },
      entryBasis: 100, volatilityByMethod: { ADR, ATR }, trade: {}
    }).buffer).toBeCloseTo(2, 12);

    expect(resolveBuffer({
      criterionParameters: { minimum_buffer_method: 'ATR_fraction', minimum_buffer_value: 0.5 },
      entryBasis: 100, volatilityByMethod: { ADR, ATR }, trade: {}
    }).buffer).toBeCloseTo(1.5, 12);
  });

  test('a fraction buffer cannot be resolved without its volatility reference', () => {
    const result = resolveBuffer({
      criterionParameters: { minimum_buffer_method: 'ATR_fraction', minimum_buffer_value: 0.5 },
      entryBasis: 100, volatilityByMethod: { ADR, ATR: { available: false } }, trade: {}
    });
    expect(result.available).toBe(false);
  });
});
