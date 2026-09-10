'use strict';

// Execution-evidence normalization for Entry Quality
// (docs/QUALITY_PROFILES_REQUIREMENT.md section 28).
//
// Reconstructs the ORIGINAL POSITION and immutable ENTRY BASIS from the
// actual fills TradeTally stores on the trade (`trades.executions` JSONB),
// with a documented trade-level fallback when fill-level evidence is absent.
//
//   Original Position = all opening-side fills before the first position
//                       reduction.
//   Entry Basis       = quantity-weighted average price of those fills.
//   Initial Entry Time= timestamp of the first opening-side fill.
//
// Later scale-ins after the first reduction never enter Original Position or
// Entry Basis. If fill-level evidence is missing but trustworthy trade-level
// fields exist, the best actual evidence is used with explicit provenance and
// limitations — never a fabricated fill schedule.
//
// Pure / stateless: no database access, no I/O.

const { isBuyAction, isSellAction, normalizeAction } = require('../pnlEngine');
const { sessionDateInZone } = require('./entry/sessionTime');

function parseExecutions(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (error) {
      return [];
    }
  }
  return [];
}

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Epoch seconds for a stored execution timestamp. Executions were normalized to
// UTC (migration 134); offsetless strings are pinned to UTC so the server's
// local timezone never shifts a fill.
function toEpochSeconds(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  if (typeof value === 'number') return Math.floor(value > 1e12 ? value / 1000 : value);
  const str = String(value).trim();
  if (!str) return null;
  const hasOffset = /(?:Z|[+-]\d{2}:?\d{2})$/.test(str);
  const isoish = str.replace(' ', 'T');
  const ms = Date.parse(hasOffset ? isoish : `${isoish}Z`);
  return Number.isNaN(ms) ? null : Math.floor(ms / 1000);
}

function directionFromSide(side) {
  return String(side || '').toLowerCase() === 'short' ? 'short' : 'long';
}

// Normalizes the two stored execution shapes to chronological signed fills:
//   { timeEpoch, price, quantity (positive), action: 'buy'|'sell', raw }
// Returns null when no usable fills exist.
function normalizeFills(executions, direction) {
  const openingAction = direction === 'long' ? 'buy' : 'sell';
  const closingAction = direction === 'long' ? 'sell' : 'buy';
  const fills = [];

  const grouped =
    executions.length > 0 &&
    executions.every((e) => e && (e.entry_price !== undefined || e.entryPrice !== undefined));

  if (grouped) {
    for (const exec of executions) {
      const quantity = Math.abs(asNumber(exec.quantity) ?? 0);
      if (!quantity) continue;
      const entryTime = toEpochSeconds(exec.entry_time ?? exec.entryTime);
      const entryPrice = asNumber(exec.entry_price ?? exec.entryPrice);
      if (entryTime && entryPrice !== null) {
        fills.push({ timeEpoch: entryTime, price: entryPrice, quantity, action: openingAction, raw: exec });
      }
      const exitTime = toEpochSeconds(exec.exit_time ?? exec.exitTime);
      const exitPrice = asNumber(exec.exit_price ?? exec.exitPrice);
      if (exitTime && exitPrice !== null) {
        fills.push({ timeEpoch: exitTime, price: exitPrice, quantity, action: closingAction, raw: exec });
      }
    }
  } else {
    for (const exec of executions) {
      const quantity = Math.abs(asNumber(exec.quantity) ?? 0);
      const price = asNumber(exec.price);
      const time = toEpochSeconds(exec.datetime ?? exec.time);
      if (!quantity || price === null || !time) continue;
      const action = normalizeAction(exec.action || exec.side || '');
      if (isBuyAction(action)) {
        fills.push({ timeEpoch: time, price, quantity, action: 'buy', raw: exec });
      } else if (isSellAction(action)) {
        fills.push({ timeEpoch: time, price, quantity, action: 'sell', raw: exec });
      }
    }
  }

  if (fills.length === 0) return null;
  fills.sort((a, b) => a.timeEpoch - b.timeEpoch);
  return fills;
}

function weightedAverage(fills) {
  let quantity = 0;
  let notional = 0;
  for (const fill of fills) {
    quantity += fill.quantity;
    notional += fill.price * fill.quantity;
  }
  if (!(quantity > 0)) return null;
  return notional / quantity;
}

function fillEvidence(fill) {
  return {
    timestamp: new Date(fill.timeEpoch * 1000).toISOString(),
    timestampEpoch: fill.timeEpoch,
    action: fill.action,
    quantity: fill.quantity,
    price: fill.price,
    source: 'executions_jsonb'
  };
}

// Reconstructs original position / entry basis from fill-level evidence.
// Returns null when no opening-side fills can be identified.
function reconstructFromFills(fills, direction) {
  const openingAction = direction === 'long' ? 'buy' : 'sell';
  const closingAction = direction === 'long' ? 'sell' : 'buy';
  const openingFills = [];
  let firstReductionTime = null;
  let sawClosingBeforeOpening = false;

  for (const fill of fills) {
    if (firstReductionTime !== null) {
      // Any later scale-in after the first reduction is excluded by contract.
      break;
    }
    if (fill.action === openingAction) {
      openingFills.push(fill);
    } else if (fill.action === closingAction) {
      if (openingFills.length > 0) {
        firstReductionTime = fill.timeEpoch;
        break;
      }
      sawClosingBeforeOpening = true;
    }
  }

  if (openingFills.length === 0) return null;
  const basis = weightedAverage(openingFills);
  if (basis === null) return null;

  return {
    openingFills,
    originalPositionQty: openingFills.reduce((sum, fill) => sum + fill.quantity, 0),
    entryBasis: basis,
    initialEntryEpoch: openingFills[0].timeEpoch,
    firstReductionEpoch: firstReductionTime,
    sawClosingBeforeOpening
  };
}

/**
 * Normalizes a trade's actual opening-side execution evidence.
 *
 * @param {object} trade - row with side, executions, entry_time/entry_price/quantity.
 * @returns {object} normalized evidence:
 *   {
 *     available: boolean,
 *     direction: 'long'|'short',
 *     provenance: { source, limitations: [] },
 *     originalPositionQty, entryBasis, initialEntryEpoch,
 *     initialEntryTime (ISO), actualEntrySession (YYYY-MM-DD ET),
 *     firstReductionTime (ISO|null),
 *     fills: [ { timestamp, timestampEpoch, action, quantity, price, source } ],
 *     unavailableReason: string|null
 *   }
 */
function normalizeExecutionEvidence(trade) {
  const direction = directionFromSide(trade && trade.side);
  const executions = parseExecutions(trade && trade.executions);
  const fills = normalizeFills(executions, direction);

  if (fills) {
    const reconstructed = reconstructFromFills(fills, direction);
    if (reconstructed) {
      const openingEvidence = reconstructed.openingFills.map(fillEvidence);
      return {
        available: true,
        direction,
        provenance: {
          source: 'executions_jsonb',
          limitations: reconstructed.firstReductionEpoch === null
            ? ['No position reduction is recorded; original position includes every opening-side fill.']
            : []
        },
        originalPositionQty: reconstructed.originalPositionQty,
        entryBasis: reconstructed.entryBasis,
        initialEntryEpoch: reconstructed.initialEntryEpoch,
        initialEntryTime: new Date(reconstructed.initialEntryEpoch * 1000).toISOString(),
        actualEntrySession: sessionDateInZone(reconstructed.initialEntryEpoch),
        firstReductionTime: reconstructed.firstReductionEpoch === null
          ? null
          : new Date(reconstructed.firstReductionEpoch * 1000).toISOString(),
        fills: openingEvidence,
        unavailableReason: null
      };
    }
  }

  // Trade-level fallback: only used when NO usable fill-level opening evidence
  // exists. Provenance and limitations are explicit; entry_price is the trade's
  // stored entry price and may be a blended value for multi-fill trades.
  const quantity = Math.abs(asNumber(trade && trade.quantity) ?? 0);
  const entryPrice = asNumber(trade && trade.entry_price);
  const entryEpoch = toEpochSeconds(trade && trade.entry_time);

  if (quantity > 0 && entryPrice !== null && entryPrice > 0 && entryEpoch) {
    return {
      available: true,
      direction,
      provenance: {
        source: 'trade_level_fields',
        limitations: [
          'Fill-level executions are unavailable; original position and entry basis use the trade-level entry fields.',
          'The trade-level entry price may be a blended/final average rather than the true initial opening basis.'
        ]
      },
      originalPositionQty: quantity,
      entryBasis: entryPrice,
      initialEntryEpoch: entryEpoch,
      initialEntryTime: new Date(entryEpoch * 1000).toISOString(),
      actualEntrySession: sessionDateInZone(entryEpoch),
      firstReductionTime: null,
      fills: [{
        timestamp: new Date(entryEpoch * 1000).toISOString(),
        timestampEpoch: entryEpoch,
        action: direction === 'long' ? 'buy' : 'sell',
        quantity,
        price: entryPrice,
        source: 'trade_level_fields'
      }],
      unavailableReason: null
    };
  }

  return {
    available: false,
    direction,
    provenance: {
      source: null,
      limitations: ['No usable fill-level or trade-level opening evidence is stored for this trade.']
    },
    originalPositionQty: null,
    entryBasis: null,
    initialEntryEpoch: null,
    initialEntryTime: null,
    actualEntrySession: null,
    firstReductionTime: null,
    fills: [],
    unavailableReason: 'Original position and entry basis could not be established from the stored trade/execution evidence.'
  };
}

module.exports = {
  parseExecutions,
  toEpochSeconds,
  directionFromSide,
  normalizeFills,
  normalizeExecutionEvidence
};
