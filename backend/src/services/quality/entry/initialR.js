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
 * Resolves Initial R for ONE evaluation.
 *
 * Immutability contract: once a stored Initial R is available and has an
 * `established_at`, it is FROZEN. A later current/planned stop value, a later
 * position edit, or any conflicting evidence MUST NOT redefine initial_stop,
 * r_per_share, initial_risk_dollars or established_at inside the same
 * evaluation. Conflicts are reported, never silently applied. A new evaluation
 * is the correct place to establish a different R.
 *
 * An initially-unavailable Initial R may still become established exactly once
 * (before terminalization) when trustworthy evidence first appears; after that
 * it is frozen.
 */
function resolveInitialR({ computed, storedInitialR, now = new Date() }) {
  const stored = storedInitialR && typeof storedInitialR === 'object' ? storedInitialR : null;
  const frozen = stored && stored.available === true && stored.established_at;

  if (frozen) {
    const conflictFields = [];
    if (!computed.available) {
      conflictFields.push('current_evidence_unavailable');
    } else {
      if (stored.entry_basis !== computed.entry_basis) conflictFields.push('entry_basis');
      if (stored.initial_stop !== computed.initial_stop) conflictFields.push('initial_stop');
      if (stored.original_position_qty !== computed.original_position_qty) {
        conflictFields.push('original_position_qty');
      }
    }
    return {
      ...stored,
      immutable: true,
      frozen: true,
      preserved: true,
      conflict: conflictFields.length > 0,
      conflict_fields: conflictFields
    };
  }

  if (!computed.available) {
    return {
      ...computed,
      established_at: null,
      immutable: false,
      frozen: false,
      preserved: false
    };
  }
  return {
    ...computed,
    established_at: now.toISOString(),
    immutable: true,
    frozen: true,
    preserved: false
  };
}

module.exports = {
  computeInitialR,
  resolveInitialR
};
