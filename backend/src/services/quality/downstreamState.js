'use strict';

// Coherent downstream-dimension state for Setup writes
// (Phase 3 hardening follow-up findings 1 & 2).
//
// Setup Prepare and Setup Evaluate both rewrite `evidence_snapshot` and
// `detected_context`. If they only handled `results`/flat summaries, a
// preserved Entry result could end up without its Entry evidence/context, or a
// stale Entry context could survive after Entry was invalidated. This module is
// the single shared contract so the two write paths cannot diverge again.
//
// Contract:
//   mode 'preserve'   - Setup dependency unchanged. Preserve, byte-for-byte,
//                       every downstream dimension's result, evidence block,
//                       context block, and flat summaries.
//   mode 'invalidate' - Setup dependency changed. Atomically clear every
//                       downstream dimension's result, evidence block, context
//                       block, and flat summaries. Setup itself is handled by
//                       the caller (recomputed for Evaluate, null for Prepare).
//
// Immutable semantic assertions (e.g. the user-asserted intended trigger) are
// NOT downstream dimension state and are always carried forward — Setup must
// never erase them. Derived downstream state (Entry result/evidence/context) is
// what gets preserved or invalidated.

const DOWNSTREAM_DIMENSIONS = Object.freeze(['entry', 'management']);
const SETUP_CONTEXT_REVISION_KEY = 'setup_context_revision';
const SETUP_DEPENDENCY_FINGERPRINT_KEY = 'setup_dependency_fingerprint';

// Historical semantic assertions that stay frozen for the lifetime of an
// evaluation regardless of Setup/Entry recalculation. Kept separate from the
// derived Entry context so Setup invalidation (which clears
// detected_context.entry) cannot erase the original provenance.
const IMMUTABLE_USER_INPUT_KEYS = Object.freeze([
  'intended_trigger_type',
  'immutable_semantic_context'
]);

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasKey(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/**
 * Rebuilds the full persisted evaluation state for a Setup write.
 *
 * @param {object} params
 * @param {'preserve'|'invalidate'} params.mode
 * @param {object} params.existing - { results, evidenceSnapshot, detectedContext, userInputs }
 * @param {object} [params.next] - { results, evidenceSnapshot, detectedContext, userInputs }
 * @returns {{results: object|null, evidenceSnapshot: object, detectedContext: object, userInputs: object}}
 */
function applyDownstreamState({ mode, existing = {}, next = {} }) {
  const existingResults = asObject(existing.results);
  const existingEvidence = asObject(existing.evidenceSnapshot);
  const existingDetected = asObject(existing.detectedContext);
  const existingInputs = asObject(existing.userInputs);

  const nextResults = next.results && typeof next.results === 'object' ? next.results : null;
  const preserve = mode === 'preserve';

  // ----- results envelope -------------------------------------------------
  const hasExistingResults = Object.keys(existingResults).length > 0;
  let results;
  if (nextResults || hasExistingResults || !preserve) {
    results = { ...existingResults, ...(nextResults || {}) };
    if (!hasKey(results, 'setup')) {
      results.setup = preserve ? (existingResults.setup ?? null) : null;
    }
    for (const dimension of DOWNSTREAM_DIMENSIONS) {
      if (preserve && existingResults[dimension] !== undefined) {
        results[dimension] = existingResults[dimension];
      } else {
        results[dimension] = null;
      }
    }
  } else {
    results = null;
  }

  // ----- evidence snapshot ------------------------------------------------
  const evidenceSnapshot = { ...asObject(next.evidenceSnapshot) };
  for (const dimension of DOWNSTREAM_DIMENSIONS) {
    if (preserve && hasKey(existingEvidence, dimension)) {
      evidenceSnapshot[dimension] = existingEvidence[dimension];
    } else {
      delete evidenceSnapshot[dimension];
    }
  }

  // ----- detected context -------------------------------------------------
  const detectedContext = { ...asObject(next.detectedContext) };
  for (const dimension of DOWNSTREAM_DIMENSIONS) {
    if (preserve && hasKey(existingDetected, dimension)) {
      detectedContext[dimension] = existingDetected[dimension];
    } else {
      delete detectedContext[dimension];
    }
  }
  // The Setup dependency fingerprint is Setup-level state, not a downstream
  // dimension: carry it forward in preserve mode so a Prepare/Evaluate write can
  // never silently drop the token that gates Entry/Management preservation.
  // (Callers that supply an explicit fingerprint keep their value; when the
  // dependency is preserved it is equal by definition.)
  if (
    preserve &&
    !hasKey(detectedContext, SETUP_DEPENDENCY_FINGERPRINT_KEY) &&
    hasKey(existingDetected, SETUP_DEPENDENCY_FINGERPRINT_KEY)
  ) {
    detectedContext[SETUP_DEPENDENCY_FINGERPRINT_KEY] =
      existingDetected[SETUP_DEPENDENCY_FINGERPRINT_KEY];
  }

  // ----- semantic user inputs --------------------------------------------
  // Explicit null/undefined in `next` means "remove" (e.g. a structural Base
  // Start change drops the old Pivot confirmation). Immutable assertions are
  // always carried forward and never removed by a caller.
  const userInputs = { ...existingInputs, ...asObject(next.userInputs) };
  for (const key of Object.keys(userInputs)) {
    if ((userInputs[key] === null || userInputs[key] === undefined) && !IMMUTABLE_USER_INPUT_KEYS.includes(key)) {
      delete userInputs[key];
    }
  }
  for (const key of IMMUTABLE_USER_INPUT_KEYS) {
    if (!hasKey(userInputs, key) && hasKey(existingInputs, key)) {
      userInputs[key] = existingInputs[key];
    }
  }

  return { results, evidenceSnapshot, detectedContext, userInputs };
}

// Monotonic, server-derived context revision used as a compare-and-swap token.
function nextContextRevision(previousRevision) {
  const parsed = Number.parseInt(String(previousRevision ?? ''), 10);
  return String(Number.isFinite(parsed) && parsed >= 0 ? parsed + 1 : 1);
}

module.exports = {
  DOWNSTREAM_DIMENSIONS,
  IMMUTABLE_USER_INPUT_KEYS,
  SETUP_CONTEXT_REVISION_KEY,
  SETUP_DEPENDENCY_FINGERPRINT_KEY,
  applyDownstreamState,
  nextContextRevision
};
