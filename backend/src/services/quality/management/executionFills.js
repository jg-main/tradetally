'use strict';

// Management execution-fill reconstruction
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 28, 36-40).
//
// Pure helpers over the FULL chronological fill list (opening AND closing
// fills). The Entry dimension already freezes the ORIGINAL POSITION and ENTRY
// BASIS; Management consumes those immutable values but must additionally
// reconstruct reductions (closing fills) to detect premature reductions and
// partial completion. This module shares the exact normalization contract of
// executionEvidenceService so opening/closing classification is consistent.

const {
  parseExecutions,
  toEpochSeconds,
  directionFromSide,
  normalizeFills
} = require('../executionEvidenceService');

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reconstructs the full chronological fill list for a trade.
 *
 * @param {object} trade - trades row with side/executions.
 * @returns {object|null}
 *   { direction, fills: [{ timeEpoch, action, quantity, price }], available }
 */
function reconstructManagementFills(trade) {
  const direction = directionFromSide(trade && trade.side);
  const executions = parseExecutions(trade && trade.executions);
  const fills = normalizeFills(executions, direction);
  if (!fills || fills.length === 0) return null;
  return { direction, fills, available: true };
}

function isClosingAction(action, direction) {
  return direction === 'long' ? action === 'sell' : action === 'buy';
}

/**
 * Reductions (closing fills) in chronological order.
 */
function closingFills(fills, direction) {
  return (fills || []).filter((fill) => isClosingAction(fill.action, direction));
}

/**
 * Total closing quantity across the given fills.
 */
function totalQuantity(fills) {
  return (fills || []).reduce((sum, fill) => sum + (asNumber(fill.quantity) || 0), 0);
}

/**
 * Session date (YYYY-MM-DD) for a fill timestamp using the ET session clock.
 */
function fillSessionDate(fill, sessionDateInZone) {
  if (!fill || !Number.isFinite(fill.timeEpoch)) return null;
  return sessionDateInZone(fill.timeEpoch);
}

/**
 * Reconstructs reductions and the partial/premature picture from the full fill
 * list, using the IMMUTABLE original position quantity from Entry.
 *
 * @param {object} params
 * @param {Array} params.fills - full chronological fills.
 * @param {string} params.direction - 'long' | 'short'.
 * @param {number} params.originalPositionQty - immutable Entry original position.
 * @param {Function} params.sessionDateInZone - epoch -> YYYY-MM-DD.
 * @returns {object}
 *   { reductions: [{timeEpoch, quantity, sessionDate, cumulativeQty}],
 *     totalReductionQty, positionClosed (boolean), lastClosingTimeEpoch,
 *     lastClosingSessionDate, remainingQty }
 */
function reconstructReductions({ fills, direction, originalPositionQty, sessionDateInZone }) {
  const closes = closingFills(fills, direction);
  const reductions = [];
  let cumulative = 0;
  let lastClosingTimeEpoch = null;
  let lastClosingSessionDate = null;
  for (const fill of closes) {
    cumulative += asNumber(fill.quantity) || 0;
    const sessionDate = fillSessionDate(fill, sessionDateInZone);
    if (fill.timeEpoch !== null && fill.timeEpoch !== undefined) {
      lastClosingTimeEpoch = fill.timeEpoch;
      lastClosingSessionDate = sessionDate;
    }
    reductions.push({
      timeEpoch: fill.timeEpoch,
      quantity: asNumber(fill.quantity) || 0,
      sessionDate,
      cumulativeQty: cumulative
    });
  }
  const totalReductionQty = cumulative;
  const positionQty = asNumber(originalPositionQty);
  const positionClosed =
    positionQty !== null && positionQty > 0 && totalReductionQty >= positionQty - 1e-9;
  return {
    reductions,
    totalReductionQty,
    positionClosed,
    lastClosingTimeEpoch,
    lastClosingSessionDate,
    remainingQty: positionQty !== null ? Math.max(0, positionQty - totalReductionQty) : null
  };
}

module.exports = {
  reconstructManagementFills,
  reconstructReductions,
  closingFills,
  totalQuantity,
  isClosingAction,
  fillSessionDate
};
