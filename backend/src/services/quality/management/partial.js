'use strict';

// Partial completion and premature-reduction resolution
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 36-40).
//
// Pure functions over the reconstructed reductions plus the resolved partial
// trigger. The 50% target is based on the ORIGINAL position; multiple fills may
// satisfy it. Premature reduction is evaluated independently of eventual
// partial compliance.

const { totalQuantity } = require('./executionFills');

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const EPSILON = 1e-9;

/**
 * Resolves partial completion and timing from chronological reductions.
 *
 * @param {object} params
 * @param {Array} params.reductions - [{ timeEpoch, quantity, sessionDate, cumulativeQty }].
 * @param {number} params.originalPositionQty - immutable original position.
 * @param {number} params.targetPct - configured target percentage (50).
 * @param {string|null} params.triggerDueSessionDate - trigger session date.
 * @param {string|null} params.nextSessionDate - session after the trigger session.
 * @returns {object}
 *   { completed, achievedFraction, achievedPct, completionSessionDate,
 *     completionTimeEpoch, timingOutcome }
 */
function resolvePartialCompletion({
  reductions,
  originalPositionQty,
  targetPct,
  triggerDueSessionDate,
  nextSessionDate
}) {
  if (!isFiniteNumber(originalPositionQty) || originalPositionQty <= 0) {
    return { completed: false, achievedFraction: null, achievedPct: null, timingOutcome: 'unknown' };
  }
  const targetFraction = isFiniteNumber(targetPct) ? targetPct / 100 : 0.5;
  const targetQty = originalPositionQty * targetFraction;

  let completion = null;
  for (const reduction of reductions || []) {
    if (!completion && isFiniteNumber(reduction.cumulativeQty) && reduction.cumulativeQty >= targetQty - EPSILON) {
      completion = reduction;
    }
  }

  const achievedFraction = Math.min(1, totalQuantity(reductions) / originalPositionQty);
  const achievedPct = achievedFraction * 100;

  if (!completion) {
    return {
      completed: false,
      achievedFraction,
      achievedPct,
      completionSessionDate: null,
      completionTimeEpoch: null,
      timingOutcome: 'later_or_not_completed'
    };
  }

  const sessionDate = completion.sessionDate || null;
  let timingOutcome;
  if (triggerDueSessionDate && sessionDate === triggerDueSessionDate) {
    timingOutcome = 'same_trigger_session';
  } else if (nextSessionDate && sessionDate === nextSessionDate) {
    timingOutcome = 'next_session';
  } else {
    timingOutcome = 'later_or_not_completed';
  }

  return {
    completed: true,
    achievedFraction,
    achievedPct,
    completionSessionDate: sessionDate,
    completionTimeEpoch: completion.timeEpoch ?? null,
    timingOutcome
  };
}

/**
 * Resolves the premature-reduction fraction: closing quantity reduced before
 * the boundary session, excluding trusted protective-stop executions.
 *
 * The boundary is the partial trigger session when one exists; otherwise it is
 * the exit session (the final closing fill's session) so the final exit itself
 * is never counted as premature.
 *
 * @param {object} params
 * @param {Array} params.reductions
 * @param {number} params.originalPositionQty
 * @param {string|null} params.boundarySessionDate
 * @param {Array} [params.protectiveStopExecutions] - [{ epoch, quantity }]
 * @returns {object} { prematureQty, prematureFraction, excludedQty }
 */
function resolvePrematureReduction({
  reductions,
  originalPositionQty,
  boundarySessionDate,
  protectiveStopExecutions = []
}) {
  if (!isFiniteNumber(originalPositionQty) || originalPositionQty <= 0) {
    return { prematureQty: null, prematureFraction: null, excludedQty: 0 };
  }

  const protectiveByEpoch = new Map();
  for (const exec of protectiveStopExecutions || []) {
    if (!isFiniteNumber(exec.epoch) || !isFiniteNumber(exec.quantity)) continue;
    protectiveByEpoch.set(exec.epoch, (protectiveByEpoch.get(exec.epoch) || 0) + exec.quantity);
  }

  let prematureQty = 0;
  let excludedQty = 0;
  for (const reduction of reductions || []) {
    const beforeBoundary = boundarySessionDate !== null && reduction.sessionDate !== null
      ? reduction.sessionDate < boundarySessionDate
      : true;
    if (!beforeBoundary) continue;
    const quantity = reduction.quantity || 0;
    const matchedProtective = protectiveByEpoch.has(reduction.timeEpoch);
    if (matchedProtective) {
      excludedQty += quantity;
      continue;
    }
    prematureQty += quantity;
  }

  return {
    prematureQty,
    prematureFraction: Math.min(1, prematureQty / originalPositionQty),
    excludedQty
  };
}

module.exports = {
  resolvePartialCompletion,
  resolvePrematureReduction
};
