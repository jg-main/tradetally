'use strict';

// Management execution-fill reconstruction
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 28, 36-40, 44).
//
// Pure helpers over the FULL chronological fill list (opening AND closing
// fills). The Entry dimension already freezes the ORIGINAL POSITION and ENTRY
// BASIS; Management consumes those immutable values but must additionally
// reconstruct reductions (closing fills) to detect premature reductions,
// partial completion, and the actual exit price/time. This module shares the
// exact normalization contract of executionEvidenceService.

const {
  parseExecutions,
  directionFromSide,
  normalizeFills
} = require('../executionEvidenceService');

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

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

function closingFills(fills, direction) {
  return (fills || []).filter((fill) => isClosingAction(fill.action, direction));
}

function totalQuantity(fills) {
  return (fills || []).reduce((sum, fill) => sum + (asNumber(fill.quantity) || 0), 0);
}

function fillSessionDate(fill, sessionDateInZone) {
  if (!fill || !Number.isFinite(fill.timeEpoch)) return null;
  return sessionDateInZone(fill.timeEpoch);
}

/**
 * Reconstructs reductions (closing fills in chronological order) with price,
 * the final closing fill, and the first full-close event.
 *
 * @returns {object}
 *   { reductions: [{timeEpoch, quantity, price, sessionDate, cumulativeQty}],
 *     totalReductionQty, positionClosed, lastClosingTimeEpoch,
 *     lastClosingPrice, lastClosingSessionDate, firstFullClose, remainingQty }
 */
function reconstructReductions({ fills, direction, originalPositionQty, sessionDateInZone }) {
  const closes = closingFills(fills, direction);
  const reductions = [];
  let cumulative = 0;
  let lastClosingTimeEpoch = null;
  let lastClosingPrice = null;
  let lastClosingSessionDate = null;
  let firstFullClose = null;
  const positionQty = asNumber(originalPositionQty);

  for (const fill of closes) {
    const quantity = asNumber(fill.quantity) || 0;
    cumulative += quantity;
    const sessionDate = fillSessionDate(fill, sessionDateInZone);
    if (fill.timeEpoch !== null && fill.timeEpoch !== undefined) {
      lastClosingTimeEpoch = fill.timeEpoch;
      lastClosingPrice = asNumber(fill.price);
      lastClosingSessionDate = sessionDate;
    }
    const reduction = {
      timeEpoch: fill.timeEpoch,
      quantity,
      price: asNumber(fill.price),
      sessionDate,
      cumulativeQty: cumulative
    };
    reductions.push(reduction);
    if (
      !firstFullClose &&
      positionQty !== null &&
      positionQty > 0 &&
      cumulative >= positionQty - 1e-9
    ) {
      firstFullClose = reduction;
    }
  }

  const positionClosed = positionQty !== null && positionQty > 0 && cumulative >= positionQty - 1e-9;
  return {
    reductions,
    totalReductionQty: cumulative,
    positionClosed,
    lastClosingTimeEpoch,
    lastClosingPrice,
    lastClosingSessionDate,
    firstFullClose,
    remainingQty: positionQty !== null ? Math.max(0, positionQty - cumulative) : null
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
