'use strict';

// Immutable Initial R normalization for Entry Quality
// (docs/QUALITY_PROFILES_REQUIREMENT.md section 30).
//
//   R_per_share        = EntryBasis - InitialStop          (long)
//   InitialRiskDollars = R_per_share * OriginalPositionQty
//
// Once established for an evaluation, Initial R is IMMUTABLE: later stop
// modifications must never redefine it. This module only reads the actual
// initial protective stop evidence (never a later stop update), and
// resolveInitialR() preserves an already-established value when the frozen
// entry basis / initial stop / original position are unchanged, so a later
// "stop modification" cannot silently move R.
//
// A non-protective stop (RperShare <= 0) yields an explicit unavailable result
// with the evidence problem recorded instead of a manufactured positive R.

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function computeInitialR({ direction, entryBasis, originalPositionQty, stopEvidence }) {
  if (direction && direction !== 'long') {
    return {
      available: false,
      reason: 'Initial R is defined for long breakouts; a short entry cannot be normalized by this profile.',
      r_per_share: null,
      initial_risk_dollars: null
    };
  }
  if (!stopEvidence || !stopEvidence.available) {
    return {
      available: false,
      reason: 'The actual initial protective stop is unavailable; Initial R cannot be established.',
      r_per_share: null,
      initial_risk_dollars: null
    };
  }
  if (!isFiniteNumber(entryBasis) || entryBasis <= 0) {
    return {
      available: false,
      reason: 'Entry basis is unavailable; Initial R cannot be established.',
      r_per_share: null,
      initial_risk_dollars: null
    };
  }
  if (!isFiniteNumber(originalPositionQty) || originalPositionQty <= 0) {
    return {
      available: false,
      reason: 'Original position quantity is unavailable; Initial R cannot be established.',
      r_per_share: null,
      initial_risk_dollars: null
    };
  }

  const rPerShare = entryBasis - stopEvidence.price;
  if (!(rPerShare > 0)) {
    return {
      available: false,
      reason: 'The recorded stop is not a valid protective stop below the entry basis; Initial R is unavailable rather than manufactured.',
      r_per_share: null,
      initial_risk_dollars: null,
      evidence_problem: 'non_protective_stop'
    };
  }

  return {
    available: true,
    r_per_share: rPerShare,
    initial_risk_dollars: rPerShare * originalPositionQty,
    entry_basis: entryBasis,
    initial_stop: stopEvidence.price,
    original_position_qty: originalPositionQty,
    stop_evidence_source: stopEvidence.source,
    reason: null
  };
}

/**
 * Preserves an already-established Initial R for this evaluation when the
 * frozen inputs are unchanged; otherwise establishes it now.
 */
function resolveInitialR({ computed, storedInitialR, now = new Date() }) {
  if (!computed.available) {
    return { ...computed, immutable: false, established_at: null, preserved: false };
  }
  const stored = storedInitialR && typeof storedInitialR === 'object' ? storedInitialR : null;
  if (
    stored &&
    stored.available === true &&
    stored.entry_basis === computed.entry_basis &&
    stored.initial_stop === computed.initial_stop &&
    stored.original_position_qty === computed.original_position_qty &&
    stored.established_at
  ) {
    return {
      ...computed,
      established_at: stored.established_at,
      immutable: stored.immutable !== false,
      preserved: true
    };
  }
  return {
    ...computed,
    established_at: now.toISOString(),
    immutable: true,
    preserved: false
  };
}

module.exports = {
  computeInitialR,
  resolveInitialR
};
