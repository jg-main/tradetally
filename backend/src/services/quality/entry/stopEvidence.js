'use strict';

// Actual initial protective-stop evidence resolution for Entry Quality
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 29, 60).
//
// TradeTally capability audit conclusion: there is NO stop-order lifecycle
// table. The only stored protective level is the single trade-level
// `trades.stop_loss` numeric column (migration 092), with no separate
// creation/replacement timestamp and no guarantee that it is a broker-executed
// stop rather than a planned/default level.
//
// Per section 60 this service therefore:
//   - uses the trade-level stop as the best ACTUAL evidence when present,
//     recording provenance and the missing-timestamp limitation;
//   - sets reference_time = initial entry time (no stop-establishment time
//     exists);
//   - returns UNKNOWN (available: false) when no usable stop is stored.
//
// It NEVER infers the user's real stop from a hypothetical/rule-based stop
// (e.g. LOD - buffer), and never uses a later stop update as the initial stop.

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const STOP_SOURCE = 'trade_stop_loss_field';

/**
 * @param {object} params
 * @param {object} params.trade - trades row.
 * @param {object} params.executionEvidence - normalized execution evidence.
 * @returns {object} { available, price, source, referenceEpoch, referenceTime,
 *   referenceTimeSource, stopEstablishmentTime, protective, provenance, reason }
 */
function resolveStopEvidence({ trade, executionEvidence }) {
  const base = {
    available: false,
    price: null,
    source: null,
    referenceEpoch: executionEvidence ? executionEvidence.initialEntryEpoch ?? null : null,
    referenceTime: executionEvidence ? executionEvidence.initialEntryTime ?? null : null,
    referenceTimeSource: 'initial_entry_time',
    stopEstablishmentTime: null,
    protective: null,
    provenance: {
      source: null,
      limitations: []
    },
    reason: null
  };

  const stopLoss = asNumber(trade && trade.stop_loss);
  if (stopLoss === null || stopLoss <= 0) {
    return {
      ...base,
      reason: 'No actual initial protective stop is stored for this trade; Initial Stop is UNKNOWN.'
    };
  }
  if (!executionEvidence || !executionEvidence.available || !Number.isFinite(executionEvidence.initialEntryEpoch)) {
    return {
      ...base,
      price: stopLoss,
      source: STOP_SOURCE,
      reason: 'The initial entry time/basis is unavailable, so the stop reference cannot be anchored; Initial Stop is UNKNOWN.'
    };
  }

  const protective = executionEvidence.direction === 'long'
    ? stopLoss < executionEvidence.entryBasis
    : stopLoss > executionEvidence.entryBasis;

  return {
    available: true,
    price: stopLoss,
    source: STOP_SOURCE,
    referenceEpoch: executionEvidence.initialEntryEpoch,
    referenceTime: executionEvidence.initialEntryTime,
    referenceTimeSource: 'initial_entry_time',
    stopEstablishmentTime: null,
    protective,
    provenance: {
      source: STOP_SOURCE,
      limitations: [
        'TradeTally stores a single trade-level stop with no stop-order lifecycle; there is no separate stop-establishment timestamp, so the initial entry time is used as the reference time.',
        'The stored stop may be a planned/default level rather than a broker-executed protective stop.'
      ]
    },
    reason: null
  };
}

module.exports = {
  STOP_SOURCE,
  resolveStopEvidence
};
