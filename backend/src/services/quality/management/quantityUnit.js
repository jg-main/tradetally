'use strict';

// Instrument quantity-unit and tick metadata resolution
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 37, 39, 41, 63).
//
// TradeTally stores whole-share / whole-contract quantities: the minimum
// tradable quantity increment for a known instrument is one unit (1 share for
// stock, 1 contract for option/future). This module never GUESSES a unit or a
// tick when the instrument is unknown: callers receive `known:false` and must
// return UNKNOWN rather than fabricate compliance.

const KNOWN_INSTRUMENT_TYPES = Object.freeze(['stock', 'option', 'future']);

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Floating-safe rounding to avoid binary noise in quantity comparisons.
function roundQuantity(value, decimals = 6) {
  if (!isFiniteNumber(value)) return value;
  const factor = 10 ** decimals;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Resolves the tradable quantity unit for an instrument.
 * Whole shares/contracts -> unit 1. Unknown instrument -> unknown (never 1).
 *
 * @returns {{known:boolean, unit:(number|null), source:(string|null), reason:(string|null)}}
 */
function resolveQuantityUnit(instrumentType) {
  const normalized = typeof instrumentType === 'string' ? instrumentType.trim().toLowerCase() : '';
  if (KNOWN_INSTRUMENT_TYPES.includes(normalized)) {
    return {
      known: true,
      unit: 1,
      source: 'instrument_type',
      reason: null
    };
  }
  return {
    known: false,
    unit: null,
    source: null,
    reason:
      'The instrument type is unknown, so the valid tradable quantity unit cannot be established; rounded quantities must not be fabricated.'
  };
}

function roundToUnit(value, unit) {
  if (!isFiniteNumber(value) || !isFiniteNumber(unit) || unit <= 0) return null;
  return roundQuantity(Math.round(value / unit) * unit);
}

/**
 * Resolves the required partial quantity with valid tradable-unit rounding.
 *
 * @param {object} params
 * @param {number} params.originalPositionQty
 * @param {number} params.targetFraction - e.g. 0.5
 * @param {object} params.quantityUnit - result of resolveQuantityUnit
 * @returns {{resolved:boolean, requiredQty:(number|null), toleranceQty:number,
 *   unit:(number|null), rawQty:(number|null), rounded:boolean, reason:(string|null)}}
 */
function resolveRequiredQuantity({ originalPositionQty, targetFraction, quantityUnit }) {
  if (!isFiniteNumber(originalPositionQty) || originalPositionQty <= 0) {
    return {
      resolved: false, requiredQty: null, toleranceQty: 0, unit: null, rawQty: null,
      rounded: false, reason: 'original_position_qty_unavailable'
    };
  }
  if (!isFiniteNumber(targetFraction) || targetFraction <= 0) {
    return {
      resolved: false, requiredQty: null, toleranceQty: 0, unit: null, rawQty: null,
      rounded: false, reason: 'target_fraction_unavailable'
    };
  }
  const rawQty = roundQuantity(originalPositionQty * targetFraction);
  const unitKnown = quantityUnit && quantityUnit.known === true && isFiniteNumber(quantityUnit.unit);

  if (!unitKnown) {
    // Without a proven unit, only an already-exact whole target is unambiguous.
    if (Number.isInteger(rawQty)) {
      return {
        resolved: true, requiredQty: rawQty, toleranceQty: 0, unit: null, rawQty,
        rounded: false, reason: null
      };
    }
    return {
      resolved: false, requiredQty: null, toleranceQty: 0, unit: null, rawQty,
      rounded: false, reason: 'quantity_unit_unknown'
    };
  }

  const requiredQty = roundToUnit(rawQty, quantityUnit.unit);
  return {
    resolved: true,
    requiredQty,
    // One tradable unit of tolerance so rounding can never create a false
    // Timing/Sizing failure (e.g. 101 shares at 50% -> 50.5 -> 50 or 51).
    toleranceQty: quantityUnit.unit,
    unit: quantityUnit.unit,
    rawQty,
    rounded: requiredQty !== rawQty,
    reason: null
  };
}

/**
 * Resolves the instrument tick size from stored per-trade metadata. Never
 * defaults an unknown tick (a future trusted Stop-Ratchet source must not use a
 * fabricated 0.01).
 */
function resolveTickSize({ storedTickSize } = {}) {
  const tickSize = Number(storedTickSize);
  if (Number.isFinite(tickSize) && tickSize > 0) {
    return { known: true, tickSize, source: 'trade_tick_size', reason: null };
  }
  return {
    known: false,
    tickSize: null,
    source: null,
    reason:
      'The instrument tick size is not stored; tick-sensitive stop-history rules cannot be evaluated without fabricating a tick.'
  };
}

module.exports = {
  KNOWN_INSTRUMENT_TYPES,
  resolveQuantityUnit,
  roundToUnit,
  resolveRequiredQuantity,
  resolveTickSize,
  roundQuantity
};
