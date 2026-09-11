'use strict';

// Deterministic Setup -> Entry dependency fingerprint
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 22, 28, 60; Phase 3 hardening).
//
// Entry Quality depends on immutable Setup state: the profile version, the
// confirmed Pivot, the breakout/resolution session and base boundary, and the
// exact frozen daily evidence snapshot Setup was computed against. This module
// derives a server-computed fingerprint over ONLY those inputs so that:
//
//   - a Setup re-evaluation with identical dependencies preserves a still-valid
//     Entry result (same fingerprint);
//   - a Setup/Pivot/breakout/evidence change invalidates Entry atomically
//     (different fingerprint);
//   - a stale Entry task that computed against Setup A cannot attach results to
//     a newer Setup B (optimistic guard in evaluationService.saveEntryProgress).
//
// The fingerprint is ALWAYS derived server-side from persisted state; it is
// never accepted from or trusted from the client.

const crypto = require('crypto');

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Identity of the frozen daily evidence Setup used. Bars are hashed so a
// provider revision that changes OHLCV (but not counts/dates) still changes the
// fingerprint.
function evidenceSnapshotIdentity(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { bars: 0, hash: null, entrySessionDate: null, source: null };
  }
  const bars = Array.isArray(snapshot.bars) ? snapshot.bars : [];
  const hash = crypto.createHash('sha256');
  for (const bar of bars) {
    hash.update(
      `${bar.date}|${bar.open}|${bar.high}|${bar.low}|${bar.close}|${bar.volume ?? ''}\n`
    );
  }
  return {
    bars: bars.length,
    hash: bars.length > 0 ? hash.digest('hex') : null,
    entrySessionDate: snapshot.entrySessionDate ?? null,
    source: snapshot.source ?? null
  };
}

function boundaryIdentity(boundary) {
  if (!boundary || typeof boundary !== 'object') return null;
  return {
    pivot: boundary.pivotPrice ?? boundary.pivot ?? null,
    resolutionDate: boundary.resolutionDate ?? null,
    baseStartDate: boundary.baseStartDate ?? null,
    baseEndDate: boundary.baseEndDate ?? null
  };
}

/**
 * @param {object} params
 * @param {string|number} params.profileVersionId
 * @param {object|null} params.boundary - persisted Setup boundary.
 * @param {object|null} params.evidenceSnapshot - frozen daily snapshot.
 * @returns {string} stable hex fingerprint.
 */
function setupDependencyFingerprint({ profileVersionId, boundary, evidenceSnapshot }) {
  const payload = {
    profile_version_id: String(profileVersionId ?? ''),
    boundary: boundaryIdentity(boundary),
    snapshot: evidenceSnapshotIdentity(evidenceSnapshot)
  };
  return sha256Hex(JSON.stringify(payload));
}

// Management depends on immutable Entry-owned state: the original position /
// entry basis, the actual entry session, the first reduction boundary, and the
// frozen Initial R. These are all persisted in the Entry evidence block; this
// fingerprint lets a Management write CAS-guard against a newer Entry result
// (re-run Entry with a different trigger, a position edit, or an Initial R
// establishment change) without trusting client input.
function entryDependencyIdentity(entryEvidence) {
  if (!entryEvidence || typeof entryEvidence !== 'object') {
    return null;
  }
  const execution = entryEvidence.execution || {};
  const initialR = entryEvidence.initial_r || {};
  return {
    entry_basis: execution.entry_basis ?? null,
    original_position_qty: execution.original_position_qty ?? null,
    actual_entry_session: execution.actual_entry_session ?? null,
    first_reduction_time: execution.first_reduction_time ?? null,
    initial_r: initialR && typeof initialR === 'object'
      ? {
          available: initialR.available ?? null,
          r_per_share: initialR.r_per_share ?? null,
          initial_stop: initialR.initial_stop ?? null,
          entry_basis: initialR.entry_basis ?? null,
          original_position_qty: initialR.original_position_qty ?? null
        }
      : null
  };
}

function entryDependencyFingerprint({ profileVersionId, entryEvidence }) {
  const payload = {
    profile_version_id: String(profileVersionId ?? ''),
    entry: entryDependencyIdentity(entryEvidence)
  };
  return sha256Hex(JSON.stringify(payload));
}

module.exports = {
  setupDependencyFingerprint,
  entryDependencyFingerprint,
  entryDependencyIdentity,
  evidenceSnapshotIdentity,
  boundaryIdentity
};
