'use strict';

// Swing-point detection helpers shared by the Base Start detector, the Pivot
// detector, Prior Move and Higher Lows criteria.
//
// Structural definitions come from docs/QUALITY_PROFILES_REQUIREMENT.md:
//   - swing high at i: high[i] strictly greater than the highs of the
//     previous `left` sessions AND greater than or equal to the highs of the
//     following `right` sessions;
//   - swing low at i:  low[i] strictly lower than the lows of the previous
//     `left` sessions AND lower than or equal to the lows of the following
//     `right` sessions.
//
// The left/right window sizes are always read from the caller's profile
// criterion parameters (canonical BO: 3/3 for Base Start and Prior Move,
// 2/2 for Pivot and Higher Lows). Window sizes are never hard-coded here.

function isSwingHighAtIndex(bars, index, left, right) {
  if (index < left || index > bars.length - right - 1) return false;
  const high = bars[index].high;
  for (let j = index - left; j < index; j += 1) {
    if (!(high > bars[j].high)) return false;
  }
  for (let j = index + 1; j <= index + right; j += 1) {
    if (!(high >= bars[j].high)) return false;
  }
  return true;
}

function isSwingLowAtIndex(bars, index, left, right) {
  if (index < left || index > bars.length - right - 1) return false;
  const low = bars[index].low;
  for (let j = index - left; j < index; j += 1) {
    if (!(low < bars[j].low)) return false;
  }
  for (let j = index + 1; j <= index + right; j += 1) {
    if (!(low <= bars[j].low)) return false;
  }
  return true;
}

/**
 * Structural swing highs over the full normalized bar array. Confirmation is
 * strictly local to the bars themselves; callers that need point-in-time
 * guarantees must additionally restrict the returned indices to the range
 * observable at evaluation time.
 *
 * @param {Array} bars - normalized daily bars [{date, high, ...}]
 * @param {object} windows - { left, right }
 * @returns {Array<{index:number,date:string,price:number}>}
 */
function findSwingHighs(bars, { left = 2, right = 2 } = {}) {
  const results = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (isSwingHighAtIndex(bars, i, left, right)) {
      results.push({ index: i, date: bars[i].date, price: bars[i].high });
    }
  }
  return results;
}

/**
 * Structural swing lows over the full normalized bar array.
 */
function findSwingLows(bars, { left = 2, right = 2 } = {}) {
  const results = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (isSwingLowAtIndex(bars, i, left, right)) {
      results.push({ index: i, date: bars[i].date, price: bars[i].low });
    }
  }
  return results;
}

module.exports = {
  isSwingHighAtIndex,
  isSwingLowAtIndex,
  findSwingHighs,
  findSwingLows
};
