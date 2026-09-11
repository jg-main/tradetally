'use strict';

// Partial completion, sizing-at-event, premature-reduction classification, and
// partial supersession (docs/QUALITY_PROFILES_REQUIREMENT.md sections 36-40).
//
// Pure functions. Key hardening rules:
//   - Partial Sizing is measured from the quantity at the PARTIAL EVENT (the
//     first fill whose cumulative reduction crosses the required quantity),
//     never from lifetime liquidation. Later exits cannot change it.
//   - Premature reduction and same-session timing are evaluated against the
//     authoritative trigger BOUNDARY (session + instant when knowable), not
//     merely the session date.
//   - A pre-trigger reduction is only excluded as protective when trustworthy
//     evidence classifies it; otherwise the criterion is UNKNOWN.
//   - Required quantity uses valid tradable-unit rounding.
//   - A pre-trigger completion never counts as an on-time post-trigger
//     completion, but its quantity may still count toward Partial Sizing.

const { resolveRequiredQuantity } = require('./quantityUnit');

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

const EPSILON = 1e-9;

function boundaryMode(boundary) {
  if (!boundary) return null;
  if (boundary.mode) return boundary.mode;
  return (boundary.kind === 'session_open' || boundary.kind === 'crossing') ? 'instant' : 'session';
}

/**
 * Classifies a reduction relative to the trigger boundary.
 *
 * The boundary may be:
 *   - an exact instant (session_open or an execution_print crossing) -> precise
 *     before/after ordering;
 *   - a 1-minute bar INTERVAL (1min_bar crossing) -> before the bar is before,
 *     after the bar is after, inside the bar is UNKNOWN;
 *   - session granularity -> intra-session ordering is UNKNOWN.
 *
 * @returns {'before_session'|'same_before'|'same_after'|'same_unknown'|'after_hours'|'after'|'unknown'}
 */
function relationToBoundary(reduction, boundary) {
  if (!boundary || !boundary.sessionDate || !reduction || !reduction.sessionDate) return 'unknown';
  const session = reduction.sessionDate;
  if (session < boundary.sessionDate) return 'before_session';
  if (session > boundary.sessionDate) return 'after';
  const epoch = reduction.timeEpoch;
  const mode = boundaryMode(boundary);
  const afterHours = isFiniteNumber(boundary.sessionCloseEpoch) && isFiniteNumber(epoch) && epoch >= boundary.sessionCloseEpoch;

  if (mode !== 'instant') {
    // Session-granularity boundary: an after-hours reduction is after the
    // regular session; otherwise intra-session ordering is unknown.
    return afterHours ? 'after_hours' : 'same_unknown';
  }
  if (afterHours) return 'after_hours';

  // Exact-instant boundary (session open or execution print).
  if (boundary.orderingKnown && isFiniteNumber(boundary.epoch) && isFiniteNumber(epoch)) {
    return epoch < boundary.epoch ? 'same_before' : 'same_after';
  }
  // 1-minute bar interval OR conservative first-crossing uncertainty interval.
  // Interval bounds are treated INDEPENDENTLY: a known start already proves a
  // reduction before it is pre-trigger even when the end is unknown, and a
  // known end proves a reduction at/after it is post-trigger even when the
  // start is unknown. Never fabricate the missing bound.
  const windowStart = isFiniteNumber(boundary.uncertaintyStartEpoch)
    ? boundary.uncertaintyStartEpoch
    : boundary.intervalStartEpoch;
  const windowEnd = isFiniteNumber(boundary.uncertaintyEndEpoch)
    ? boundary.uncertaintyEndEpoch
    : boundary.intervalEndEpoch;
  if (isFiniteNumber(epoch)) {
    const startKnown = isFiniteNumber(windowStart);
    const endKnown = isFiniteNumber(windowEnd);
    if (startKnown && epoch < windowStart) return 'same_before';
    if (endKnown && epoch >= windowEnd) return 'same_after';
    if (startKnown || endKnown) return 'same_unknown';
  }
  // Session-level crossing with no intraday evidence: unknown ordering.
  return 'same_unknown';
}

function resolvePartialCompletion({
  reductions,
  originalPositionQty,
  targetFraction,
  targetPct,
  quantityUnit,
  triggerDueSessionIndex,
  boundary = null,
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
      completionRelation: null,
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

  const completionRelation = boundary ? relationToBoundary(crossing, boundary) : null;

  let timingOutcome;
  if (
    completionRelation === 'before_session' ||
    completionRelation === 'same_before' ||
    (sessionsAfterTrigger !== null && sessionsAfterTrigger < 0)
  ) {
    // Target attained entirely before the trigger: it counts for Sizing but is
    // never an on-time post-trigger completion.
    timingOutcome = 'pre_trigger';
  } else if (completionRelation === 'same_unknown') {
    timingOutcome = 'unknown_ordering';
  } else if (completionRelation === 'after_hours') {
    timingOutcome = 'later_or_not_completed';
  } else if (sessionsAfterTrigger === 0) {
    timingOutcome = 'same_trigger_session';
  } else if (sessionsAfterTrigger === 1) {
    timingOutcome = 'next_session';
  } else {
    timingOutcome = 'later_or_not_completed';
  }

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
    completionRelation,
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
  return classification.complete === true ? 'discretionary' : 'ambiguous';
}

/**
 * Resolves the premature-reduction outcome against the trigger boundary.
 *
 * Reductions strictly before the boundary session, or on the boundary session
 * before the boundary instant, are candidates. A same-session reduction whose
 * intra-session ordering cannot be proven is ambiguous.
 */
function resolvePrematureReduction({
  reductions,
  originalPositionQty,
  boundary = null,
  stopExecutionClassification = null
}) {
  const boundarySessionDate = boundary ? boundary.sessionDate || null : null;
  const empty = {
    outcome: 'not_evaluated',
    prematureQty: null,
    prematureFraction: null,
    excludedQty: 0,
    ambiguousQty: 0,
    beforeBoundaryQty: 0,
    unknownOrderingQty: 0,
    boundarySessionDate
  };
  if (!isFiniteNumber(originalPositionQty) || originalPositionQty <= 0) {
    return empty;
  }
  if (!boundary || !boundary.sessionDate) {
    // No observed temporal boundary: never fabricate PASS/FAIL.
    return empty;
  }

  let prematureQty = 0;
  let excludedQty = 0;
  let ambiguousQty = 0;
  let beforeBoundaryQty = 0;
  let unknownOrderingQty = 0;
  let candidateCount = 0;

  for (const reduction of reductions || []) {
    const relation = relationToBoundary(reduction, boundary);
    const quantity = isFiniteNumber(reduction.quantity) ? reduction.quantity : 0;
    if (relation === 'before_session' || relation === 'same_before') {
      candidateCount += 1;
      beforeBoundaryQty += quantity;
      const verdict = classifyReduction(reduction, stopExecutionClassification);
      if (verdict === 'protective') excludedQty += quantity;
      else if (verdict === 'discretionary') prematureQty += quantity;
      else ambiguousQty += quantity;
    } else if (relation === 'same_unknown') {
      candidateCount += 1;
      unknownOrderingQty += quantity;
      ambiguousQty += quantity;
    }
  }

  if (candidateCount === 0) {
    return {
      outcome: 'none',
      prematureQty: 0,
      prematureFraction: 0,
      excludedQty: 0,
      ambiguousQty: 0,
      beforeBoundaryQty: 0,
      unknownOrderingQty: 0,
      boundarySessionDate
    };
  }
  if (prematureQty === 0 && ambiguousQty > 0) {
    return {
      outcome: 'ambiguous',
      prematureQty: null,
      prematureFraction: null,
      excludedQty,
      ambiguousQty,
      beforeBoundaryQty,
      unknownOrderingQty,
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
    beforeBoundaryQty,
    unknownOrderingQty,
    boundarySessionDate
  };
}

/**
 * Classifies whether the position was fully closed BEFORE the trigger boundary.
 */
function resolvePartialExitSupersession({
  reductions,
  originalPositionQty,
  boundary = null,
  stopExecutionClassification = null
}) {
  const none = { closedBeforeDue: false, outcome: 'none', closeSessionDate: null, closeTimeEpoch: null };
  if (!isFiniteNumber(originalPositionQty) || originalPositionQty <= 0 || !boundary || !boundary.sessionDate) {
    return none;
  }
  let close = null;
  for (const reduction of reductions || []) {
    if (isFiniteNumber(reduction.cumulativeQty) && reduction.cumulativeQty >= originalPositionQty - EPSILON) {
      close = reduction;
      break;
    }
  }
  if (!close) return none;

  const relation = relationToBoundary(close, boundary);
  if (relation !== 'before_session' && relation !== 'same_before' && relation !== 'same_unknown') {
    return none;
  }
  const verdict = classifyReduction(close, stopExecutionClassification);
  const outcome =
    relation === 'same_unknown' || verdict === 'ambiguous'
      ? 'superseded_ambiguous'
      : verdict === 'protective' ? 'superseded_protective'
        : 'superseded_discretionary';
  return {
    closedBeforeDue: true,
    outcome,
    closeSessionDate: close.sessionDate || null,
    closeTimeEpoch: close.timeEpoch ?? null
  };
}

module.exports = {
  resolvePartialCompletion,
  resolvePrematureReduction,
  resolvePartialExitSupersession,
  relationToBoundary,
  classifyReduction
};
