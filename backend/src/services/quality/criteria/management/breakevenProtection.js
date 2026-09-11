'use strict';

// Post-Partial Breakeven Protection criterion
// (docs/QUALITY_PROFILES_REQUIREMENT.md section 42).
//
// After the required partial is completed, the remaining position must have a
// protective stop >= the original entry basis by the configured deadline
// (canonical: end of the same trigger/partial session).
//
// NOT_APPLICABLE when the partial rule never triggered or a proven protective
// exit superseded it; UNKNOWN when the trigger is pending, the exit is
// unclassifiable, or stop history is unavailable. The comparison always uses
// the immutable original entry basis, never the current/final trade.stop_loss.

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult, notApplicableResult } = require('./common');

function stopAtOrBefore(modifications, epoch) {
  let last = null;
  for (const modification of modifications || []) {
    if (modification.epoch !== null && modification.epoch > epoch) break;
    last = modification;
  }
  return last ? last.price : null;
}

function resolveOutcome({ modifications, entryBasis, completionTimeEpoch, deadlineEpoch, nextSessionCloseEpoch }) {
  const baseline = stopAtOrBefore(modifications, completionTimeEpoch);
  const stopAtDeadline = stopAtOrBefore(modifications, deadlineEpoch);
  const stopAtNextSession = stopAtOrBefore(modifications, nextSessionCloseEpoch);

  if (stopAtDeadline !== null && stopAtDeadline >= entryBasis) {
    return { outcome: 'same_session_at_or_above_be', stopAtDeadline, baseline };
  }
  if (stopAtNextSession !== null && stopAtNextSession >= entryBasis) {
    return { outcome: 'before_next_session', stopAtNextSession, baseline };
  }
  if (baseline !== null && stopAtNextSession !== null && stopAtNextSession > baseline) {
    return { outcome: 'raised_below_be', stopAtNextSession, baseline };
  }
  return { outcome: 'no_meaningful_reduction', stopAtNextSession, baseline };
}

function evaluate({ managementState = {} }) {
  const policy = managementState.policy || {};
  const partialTrigger = managementState.partialTrigger || {};
  const partialCompletion = managementState.partialCompletion || {};
  const partialExit = managementState.partialExit || {};
  const stopHistory = managementState.stopHistory || {};
  const entryBasis = managementState.entryBasis;
  const beContext = managementState.be || {};

  if (!policy.partialTrigger) {
    return unknownResult(
      'No explicit partial-trigger policy is configured for this profile version; Post-Partial Breakeven is UNKNOWN.',
      { policy_available: policy.available || null }
    );
  }

  if (partialExit.outcome === 'superseded_protective') {
    return notApplicableResult(
      'A proven protective-stop exit closed the position before the partial became due; Post-Partial Breakeven is NOT_APPLICABLE.',
      { reason: 'superseded_protective' }
    );
  }
  if (partialExit.outcome === 'superseded_discretionary') {
    return {
      status: CRITERION_STATUS.FAIL,
      scoring_value: 'no_meaningful_reduction',
      raw_value: 'superseded_discretionary',
      evidence: { reason: 'superseded_discretionary' },
      message: 'The position was fully closed before the partial became due without evidence of a protective stop.'
    };
  }
  if (partialExit.outcome === 'superseded_ambiguous') {
    return unknownResult(
      'The position was fully closed before the partial became due and TradeTally cannot classify the exit as protective; Post-Partial Breakeven is UNKNOWN.',
      { reason: 'superseded_ambiguous' }
    );
  }

  if (partialTrigger.status === 'never_reached') {
    return notApplicableResult(
      'Cumulative MFE never reached the configured minimum through the partial window; Post-Partial Breakeven is NOT_APPLICABLE.',
      { reason: partialTrigger.reason || 'never_reached_minimum_mfe' }
    );
  }
  if (partialTrigger.status !== 'triggered') {
    return unknownResult(
      partialTrigger.status === 'pending'
        ? 'The partial window has not yet fully elapsed (the trigger is pending); Post-Partial Breakeven is UNKNOWN.'
        : 'The point-in-time +1R trigger could not be established from trustworthy evidence; Post-Partial Breakeven is UNKNOWN.',
      { trigger_status: partialTrigger.status, reason: partialTrigger.reason || null }
    );
  }
  if (!stopHistory.available) {
    return unknownResult(
      stopHistory.reason || 'Trustworthy stop-history evidence is unavailable, so post-partial breakeven protection cannot be established; it is UNKNOWN.',
      { stop_history_available: false, provenance: stopHistory.provenance || null }
    );
  }
  if (partialCompletion.completionTimeEpoch === null || partialCompletion.completionTimeEpoch === undefined) {
    return unknownResult('The partial completion time could not be established; Post-Partial Breakeven is UNKNOWN.', {});
  }
  if (!Number.isFinite(entryBasis) || entryBasis <= 0) {
    return unknownResult('The immutable original entry basis is unavailable; Post-Partial Breakeven is UNKNOWN.', {});
  }

  const { outcome, stopAtDeadline, stopAtNextSession, baseline } = resolveOutcome({
    modifications: stopHistory.modifications || [],
    entryBasis,
    completionTimeEpoch: partialCompletion.completionTimeEpoch,
    deadlineEpoch: beContext.deadlineEpoch ?? partialCompletion.completionTimeEpoch,
    nextSessionCloseEpoch: beContext.nextSessionCloseEpoch ?? (beContext.deadlineEpoch ?? partialCompletion.completionTimeEpoch)
  });

  const passed = outcome === 'same_session_at_or_above_be';

  return {
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: outcome,
    raw_value: outcome,
    evidence: {
      entry_basis: entryBasis,
      partial_completion_time: partialCompletion.completionTimeEpoch
        ? new Date(partialCompletion.completionTimeEpoch * 1000).toISOString()
        : null,
      deadline_epoch: beContext.deadlineEpoch ?? null,
      deadline_sessions: policy.postPartialDeadlineSessions ?? null,
      next_session_close_epoch: beContext.nextSessionCloseEpoch ?? null,
      stop_at_deadline: stopAtDeadline,
      stop_at_next_session: stopAtNextSession,
      baseline_stop: baseline,
      source: stopHistory.source,
      provenance: stopHistory.provenance || null
    },
    message: passed
      ? `The protective stop reached or exceeded the original entry basis (${entryBasis}) by the configured deadline.`
      : `The protective stop did not reach the original entry basis by the deadline (outcome: ${outcome}).`
  };
}

module.exports = { evaluate, resolveOutcome };
