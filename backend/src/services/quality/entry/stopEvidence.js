'use strict';

// Actual initial protective-stop evidence resolution for Entry Quality
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 29, 60; Phase 3 hardening).
//
// TradeTally capability audit conclusion:
//   - there is NO stop-order lifecycle table;
//   - `trades.stop_loss` is a single MUTABLE trade-level column;
//   - `Trade.create` auto-populates it from the user's configured default stop
//     (percent / LOD / dollar) when a trade is created without one;
//   - `risk_level_history` records only CHANGES (old -> new), never the
//     establishment of the first stop.
//
// A planned/default/current stop is therefore NOT historical evidence of the
// FIRST ACTUAL protective stop associated with the opening position. Per
// section 29, when the actual initial stop cannot be established, Initial Stop
// is UNKNOWN, Stop Width is UNKNOWN, and Initial R remains unavailable.
//
// The stored trade-level stop is still returned as a `referenceStop` with
// explicit provenance so the UI can show a planned/current/reference level —
// but it is NEVER labelled `actual_initial_stop` and never drives a grade.
//
// A genuinely trustworthy imported stop-order source could be supplied via the
// optional `trustedInitialStop` argument (with its own provenance establishing
// why it is the first actual stop); no such TradeTally field exists today, so
// in production this always resolves to UNKNOWN. The hook exists so the
// evaluator contract is honest and testable, not to enable fabrication.

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const REFERENCE_SOURCE = 'trade_stop_loss_field';

function buildReferenceStop(trade) {
  const stopLoss = asNumber(trade && trade.stop_loss);
  if (stopLoss === null || stopLoss <= 0) return null;
  return {
    price: stopLoss,
    source: REFERENCE_SOURCE,
    // Documented semantics: a planned/default/current level, not the actual
    // first executed protective stop.
    semantics: 'planned_or_current_trade_stop'
  };
}

/**
 * @param {object} params
 * @param {object} params.trade - trades row.
 * @param {object} params.executionEvidence - normalized execution evidence.
 * @param {object|null} [params.trustedInitialStop] - optional authoritative
 *   source: { price, source, establishmentEpoch?, establishmentTime?, provenance }.
 * @returns {object} { available, price, source, referenceEpoch, referenceTime,
 *   referenceTimeSource, stopEstablishmentTime, protective, provenance,
 *   referenceStop, reason }
 */
function resolveStopEvidence({ trade, executionEvidence, trustedInitialStop = null }) {
  const referenceStop = buildReferenceStop(trade);
  const base = {
    available: false,
    price: null,
    source: null,
    referenceEpoch: executionEvidence ? executionEvidence.initialEntryEpoch ?? null : null,
    referenceTime: executionEvidence ? executionEvidence.initialEntryTime ?? null : null,
    referenceTimeSource: 'initial_entry_time',
    stopEstablishmentTime: null,
    protective: null,
    referenceStop,
    provenance: {
      source: referenceStop ? REFERENCE_SOURCE : null,
      limitations: referenceStop
        ? [
            'TradeTally stores a single mutable trade-level stop that may be a planned/default/current value; it has no stop-order lifecycle or establishment timestamp and is NOT proof of the first actual protective stop.',
            'The stored stop is reported as a reference level only.'
          ]
        : []
    },
    reason: null
  };

  const trustedPrice = trustedInitialStop ? asNumber(trustedInitialStop.price) : null;
  if (trustedInitialStop && trustedPrice !== null && trustedPrice > 0) {
    const establishmentEpoch =
      Number.isFinite(trustedInitialStop.establishmentEpoch)
        ? trustedInitialStop.establishmentEpoch
        : (executionEvidence ? executionEvidence.initialEntryEpoch ?? null : null);
    const protective = executionEvidence && executionEvidence.available
      ? (executionEvidence.direction === 'long'
          ? trustedPrice < executionEvidence.entryBasis
          : trustedPrice > executionEvidence.entryBasis)
      : null;
    return {
      available: true,
      price: trustedPrice,
      source: trustedInitialStop.source || 'trusted_initial_stop_source',
      referenceEpoch: establishmentEpoch,
      referenceTime: establishmentEpoch ? new Date(establishmentEpoch * 1000).toISOString() : null,
      referenceTimeSource: trustedInitialStop.establishmentEpoch
        ? 'stop_establishment_time'
        : 'initial_entry_time',
      stopEstablishmentTime: trustedInitialStop.establishmentTime ||
        (trustedInitialStop.establishmentEpoch
          ? new Date(trustedInitialStop.establishmentEpoch * 1000).toISOString()
          : null),
      protective,
      referenceStop,
      provenance: {
        source: trustedInitialStop.source || 'trusted_initial_stop_source',
        limitations: trustedInitialStop.provenance ? [trustedInitialStop.provenance] : []
      },
      reason: null
    };
  }

  return {
    ...base,
    reason: referenceStop
      ? 'No actual initial protective stop can be established from TradeTally evidence (only a planned/default/current reference stop is stored); Initial Stop is UNKNOWN.'
      : 'No actual initial protective stop is stored for this trade; Initial Stop is UNKNOWN.'
  };
}

module.exports = {
  REFERENCE_SOURCE,
  resolveStopEvidence
};
