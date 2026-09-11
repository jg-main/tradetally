'use strict';

// Partial completion, sizing-at-event, premature-reduction classification, and
// partial supersession (docs/QUALITY_PROFILES_REQUIREMENT.md sections 36-40).
//
// Pure functions. Key hardening rules:
//   - Partial Sizing is measured from the quantity at the PARTIAL EVENT (the
//     first fill whose cumulative reduction crosses the required quantity),
//     never from lifetime liquidation. Later exits cannot change it.
//   - A direct full liquidation crosses at 100% and is therefore not a
//     compliant 50% partial.
//   - Early reductions count toward the position already reduced (no extra 50%
//     sale is required after an early reduction).
//   - A pre-trigger reduction is only excluded as protective when trustworthy
//     evidence classifies it; otherwise the criterion is UNKNOWN, never a
//     fabricated FAIL.
//   - Required quantity uses valid tradable-unit rounding so rounding can never
//     create a false Timing/Sizing failure.

const { resolveRequiredQuantity } = require('./quantityUnit');

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const EPSILON = 1e-9;

/**
 * Resolves partial completion and sizing-at-event.
 *
 * @param {object} params
 * @param {Array} params.reductions - [{ timeEpoch, quantity, sessionDate, cumulativeQty }].
 * @param {number} params.originalPositionQty
 * @param {number} params.targetFraction - e.g. 0.5
 * @param {number} params.targetPct - configured target percentage.
 * @param {object} params.quantityUnit - result of resolveQuantityUnit.
 * @param {number|null} params.triggerDueSessionIndex - index of the due session.
 * @param {Function} params.sessionIndexForDate - sessionDate -> index|null.
 * @returns {object}
 */
function resolvePartialCompletion({
  reductions,
  originalPositionQty,
  targetFraction,
  targetPct,
  quantityUnit,
  triggerDueSessionIndex,
  sessionIndexForDate
}) {
  const target = resolveRequiredQuantity({ originalPositionQty, targetFraction, quantityUnit });
  const rounding = {
    resolved: target.resolved,
    requiredQty: target.requiredQty,
    rawQty: target.rawQty,
    unit: target.unit,
    rounded: target.rounded,
    reason: target.reason
  };

  if (!isFiniteNumber(originalPositionQty) || originalPositionQty <= 0) {
    return { completed: false, rounding, achievedQty: null, achievedFraction: null, achievedPct: null, timingOutcome: 'later_or_not_completed' };
  }

  const total = (reductions || []).reduce(
    (sum, reduction) => sum + (isFiniteNumber(reduction.quantity) ? reduction.quantity : 0),
    0
  );
  const achievedFractionFromTotal = Math.min(1, total / originalPositionQty);

  if (!target.resolved) {
    // Target cannot be resolved (unknown unit with a non-integer target):
    // completion is UNKNOWN, but the observed cumulative reduction is still
    // reported for evidence.
    return {
      completed: false,
      rounding,
      achievedQty: null,
      achievedFraction: null,
      achievedPct: null,
      observedQty: total,
      observedFraction: achievedFractionFromTotal,
      timedOut: false,
      timingOutcome: 'later_or_not_completed',
      reason: target.reason
    };
  }

  // Half a tradable unit absorbs ROUNDING error only, never a whole shortfall.
  const completionTolerance = target.unit ? target.unit / 2 + EPSILON : EPSILON;
  const completionThreshold = target.rawQty - completionTolerance;

  let crossing = null;
  for (const reduction of reductions || []) {
    if (!isFiniteNumber(reduction.cumulativeQty)) continue;
    if (reduction.cumulativeQty >= completionThreshold - EPSILON) {
      crossing = reduction;
      break;
    }
  }

  if (!crossing) {
    // Never reached the required partial quantity. Sizing reflects the
    // cumulative reduced by the partial deadline (the whole observed total,
    // which is below target, so no later exit beyond target can exist).
    return {
      completed: false,
      rounding,
      achievedQty: total,
      achievedFraction: achievedFractionFromTotal,
      achievedPct: achievedFractionFromTotal * 100,
      observedQty: total,
      observedFraction: achievedFractionFromTotal,
      completionTimeEpoch: null,
      completionSessionDate: null,
      completionSessionIndex: null,
      sessionsAfterTrigger: null,
      timedOut: true,
      timingOutcome: 'later_or_not_completed',
      reason: null
    };
  }

  const achievedQty = isFiniteNumber(crossing.cumulativeQty) ? crossing.cumulativeQty : null;
  const achievedFraction = achievedQty === null ? null : Math.min(1, achievedQty / originalPositionQty);
  const completionSessionDate = crossing.sessionDate || null;
  const completionSessionIndex =
    completionSessionDate !== null && typeof sessionIndexForDate === 'function'
      ? sessionIndexForDate(completionSessionDate)
      : null;
  const sessionsAfterTrigger =
    Number.isInteger(triggerDueSessionIndex) && Number.isInteger(completionSessionIndex)
      ? completionSessionIndex - triggerDueSessionIndex
      : null;

  let timingOutcome;
  if (sessionsAfterTrigger === 0) timingOutcome = 'same_trigger_session';
  else if (sessionsAfterTrigger === 1) timingOutcome = 'next_session';
  else timingOutcome = 'later_or_not_completed';

  return {
    completed: true,
    rounding,
    achievedQty,
    achievedFraction,
    achievedPct: achievedFraction === null ? null : achievedFraction * 100,
    observedQty: total,
    observedFraction: achievedFractionFromTotal,
    completionTimeEpoch: crossing.timeEpoch ?? null,
    completionSessionDate,
    completionSessionIndex,
    sessionsAfterTrigger,
    timedOut: false,
    timingOutcome,
    reason: null
  };
}

function classifyReduction(reduction, classification) {
  if (!classification || classification.available !== true) return 'ambiguous';
  const byEpoch = classification.byEpoch || {};
  const verdict = byEpoch[reduction.timeEpoch];
  if (verdict === 'protective') return 'protective';
  if (verdict === 'discretionary') return 'discretionary';
  // A complete classification that does not mark this reduction protective
  // means it is discretionary; an incomplete one is ambiguous.
  return classification.complete === true ? 'discretionary' : 'ambiguous';
}

/**
 * Resolves the premature-reduction outcome with evidence discipline.
 *
 * @param {object} params
 * @param {Array} params.reductions
 * @param {number} params.originalPositionQty
 * @param {string|null} params.boundarySessionDate - reductions strictly before
 *   this session are candidates for premature reduction.
 * @param {object|null} params.stopExecutionClassification - { available, complete, byEpoch }.
 * @returns {object}
 */
function resolvePrematureReduction({
  reductions,
  originalPositionQty,
  boundarySessionDate,
  stopExecutionClassification = null
}) {
  if (!isFiniteNumber(originalPositionQty) || originalPositionQty <= 0) {
    return { outcome: 'not_evaluated', prematureQty: null, prematureFraction: null, excludedQty: 0, ambiguousQty: 0, boundarySessionDate };
  }

  const candidates = (reductions || []).filter((reduction) =>
    boundarySessionDate !== null && boundarySessionDate !== undefined && reduction.sessionDate !== null
      ? reduction.sessionDate < boundarySessionDate
      : false
  );

  if (candidates.length === 0) {
    return {
      outcome: 'none',
      prematureQty: 0,
      prematureFraction: 0,
      excludedQty: 0,
      ambiguousQty: 0,
      boundarySessionDate
    };
  }

  let prematureQty = 0;
  let excludedQty = 0;
  let ambiguousQty = 0;
  for (const reduction of candidates) {
    const quantity = isFiniteNumber(reduction.quantity) ? reduction.quantity : 0;
    const verdict = classifyReduction(reduction, stopExecutionClassification);
    if (verdict === 'protective') excludedQty += quantity;
    else if (verdict === 'discretionary') prematureQty += quantity;
    else ambiguousQty += quantity;
  }

  if (ambiguousQty > 0 && prematureQty === 0) {
    return {
      outcome: 'ambiguous',
      prematureQty: null,
      prematureFraction: null,
      excludedQty,
      ambiguousQty,
      boundarySessionDate
    };
  }

  const fraction = Math.min(1, prematureQty / originalPositionQty);
  return {
    outcome: prematureQty > 0 ? 'discretionary' : 'none',
    prematureQty,
    prematureFraction: fraction,
    excludedQty,
    ambiguousQty,
    boundarySessionDate
  };
}

/**
 * Classifies whether the position was fully closed BEFORE the partial became
 * due. Only a trustworthy protective classification makes the partial
 * superseded (NOT_APPLICABLE); an unclassified early exit is ambiguous.
 *
 * @returns {{closedBeforeDue:boolean, outcome:'none'|'superseded_protective'|'superseded_discretionary'|'superseded_ambiguous', closeSessionDate:(string|null), closeTimeEpoch:(number|null)}}
 */
function resolvePartialExitSupersession({
  reductions,
  originalPositionQty,
  dueSessionDate,
  stopExecutionClassification = null
}) {
  const none = { closedBeforeDue: false, outcome: 'none', closeSessionDate: null, closeTimeEpoch: null };
  if (!isFiniteNumber(originalPositionQty) || originalPositionQty <= 0 || !dueSessionDate) {
    return none;
  }
  let close = null;
  for (const reduction of reductions || []) {
    if (isFiniteNumber(reduction.cumulativeQty) && reduction.cumulativeQty >= originalPositionQty - EPSILON) {
      close = reduction;
      break;
    }
  }
  if (!close || !close.sessionDate || close.sessionDate >= dueSessionDate) {
    return none;
  }
  const verdict = classifyReduction(close, stopExecutionClassification);
  const outcome =
    verdict === 'protective' ? 'superseded_protective'
      : verdict === 'discretionary' ? 'superseded_discretionary'
        : 'superseded_ambiguous';
  return {
    closedBeforeDue: true,
    outcome,
    closeSessionDate: close.sessionDate,
    closeTimeEpoch: close.timeEpoch ?? null
  };
}

module.exports = {
  resolvePartialCompletion,
  resolvePrematureReduction,
  resolvePartialExitSupersession,
  classifyReduction
};
