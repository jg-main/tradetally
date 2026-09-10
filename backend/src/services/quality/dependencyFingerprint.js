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

module.exports = {
  setupDependencyFingerprint,
  evidenceSnapshotIdentity,
  boundaryIdentity
};
