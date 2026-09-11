'use strict';

const {
  resolveQuantityUnit,
  roundToUnit,
  resolveRequiredQuantity,
  resolveTickSize
} = require('../../../../src/services/quality/management/quantityUnit');

describe('resolveQuantityUnit (F8)', () => {
  it('resolves whole units for known instruments', () => {
    expect(resolveQuantityUnit('stock')).toMatchObject({ known: true, unit: 1, source: 'instrument_type' });
    expect(resolveQuantityUnit('option')).toMatchObject({ known: true, unit: 1 });
    expect(resolveQuantityUnit('future')).toMatchObject({ known: true, unit: 1 });
  });
  it('never guesses a unit for unknown instruments', () => {
    expect(resolveQuantityUnit(null).known).toBe(false);
    expect(resolveQuantityUnit('crypto').known).toBe(false);
    expect(resolveQuantityUnit('weird').unit).toBeNull();
  });
});

describe('resolveRequiredQuantity', () => {
  const unit = { known: true, unit: 1 };

  it('rounds to a valid tradable unit', () => {
    const result = resolveRequiredQuantity({ originalPositionQty: 101, targetFraction: 0.5, quantityUnit: unit });
    expect(result.resolved).toBe(true);
    expect(result.requiredQty).toBe(51);
    expect(result.rounded).toBe(true);
  });

  it('keeps an exact whole target unchanged', () => {
    const result = resolveRequiredQuantity({ originalPositionQty: 200, targetFraction: 0.5, quantityUnit: unit });
    expect(result.requiredQty).toBe(100);
    expect(result.rounded).toBe(false);
  });

  it('is unresolved for an unknown unit with a non-integer target', () => {
    const result = resolveRequiredQuantity({ originalPositionQty: 101, targetFraction: 0.5, quantityUnit: { known: false, unit: null } });
    expect(result.resolved).toBe(false);
    expect(result.reason).toBe('quantity_unit_unknown');
  });

  it('resolves an unknown unit when the target is already a whole number', () => {
    const result = resolveRequiredQuantity({ originalPositionQty: 200, targetFraction: 0.5, quantityUnit: { known: false, unit: null } });
    expect(result.resolved).toBe(true);
    expect(result.requiredQty).toBe(100);
  });

  it('roundToUnit rounds deterministically', () => {
    expect(roundToUnit(50.5, 1)).toBe(51);
    expect(roundToUnit(100, 1)).toBe(100);
  });
});

describe('resolveTickSize (F8)', () => {
  it('uses the stored tick when present', () => {
    expect(resolveTickSize({ storedTickSize: 0.05 })).toMatchObject({ known: true, tickSize: 0.05, source: 'trade_tick_size' });
  });
  it('never defaults an unknown tick', () => {
    const result = resolveTickSize({ storedTickSize: null });
    expect(result.known).toBe(false);
    expect(result.tickSize).toBeNull();
  });
});
