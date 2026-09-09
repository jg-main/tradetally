'use strict';

// Authoritative Setup boundary resolution
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 15.3, 23 and the Phase 2
// milestone's Setup date / D-1 / late-entry requirements).
//
// The Setup specification evaluates the base through D-1 where D is the
// breakout-resolution session:
//
//   D = first trading session after the confirmed base in which price trades
//       above the CONFIRMED pivot
//   base_end = D - 1
//
// This is the shared daily-candle boundary used by every Setup criterion.
// Phase 2 does NOT score Entry; it only establishes the correct boundary so a
// late actual entry cannot push post-breakout sessions into Setup Quality.
//
// Phase 2 observes daily candles only, so "price trades above the pivot" is
// resolved as daily high > pivot (intraday trigger/penetration semantics are
// owned by Phase 3 Entry Quality). The search is bounded by the trade's
// initial entry session: a Canonical BO setup must resolve at or before the
// trader entered (a "late entry" happens after the breakout, never before).

/**
 * Resolves the breakout-resolution session index and the base end (D-1).
 *
 * @param {object} params
 * @param {Array} params.bars - normalized daily bars.
 * @param {number} params.baseStartIndex - confirmed Base Start index.
 * @param {number} params.pivotPrice - confirmed Pivot price.
 * @param {number} params.upperBoundIndex - inclusive search bound (the trade's
 *   initial entry session index).
 * @returns {{resolutionIndex:number, baseEndIndex:number}|null} null when no
 *   session in (baseStartIndex, upperBoundIndex] traded above the pivot.
 */
function resolveSetupBoundary({ bars, baseStartIndex, pivotPrice, upperBoundIndex }) {
  if (
    !Array.isArray(bars) ||
    bars.length === 0 ||
    !Number.isInteger(baseStartIndex) ||
    baseStartIndex < 0 ||
    baseStartIndex >= bars.length ||
    !(typeof pivotPrice === 'number' && Number.isFinite(pivotPrice) && pivotPrice > 0) ||
    !Number.isInteger(upperBoundIndex) ||
    upperBoundIndex < 0
  ) {
    return null;
  }
  const end = Math.min(bars.length - 1, upperBoundIndex);
  for (let i = baseStartIndex + 1; i <= end; i += 1) {
    if (bars[i].high > pivotPrice) {
      return { resolutionIndex: i, baseEndIndex: i - 1 };
    }
  }
  return null;
}

module.exports = { resolveSetupBoundary };
