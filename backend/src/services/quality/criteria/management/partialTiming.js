'use strict';

// Partial Timing criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 38).
//
// Timing is evaluated against the canonical partial trigger (section 36):
//   completed during trigger session        -> same_trigger_session (100)
//   completed next regular session          -> next_session (50)
//   later / not completed                   -> later_or_not_completed (0)
//
// Compliance requires completion within the configured completion window.
// NOT_APPLICABLE only when the configured partial window has actually elapsed
// without a trigger (or a PROVEN protective-stop exit superseded the partial);
// a pending/insufficient horizon is UNKNOWN, never NOT_APPLICABLE.

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult, notApplicableResult } = require('./common');

function evaluate({ managementState = {} }) {
  const initialR = managementState.initialR || {};
  const daily = managementState.daily || {};
  const policy = managementState.policy || {};
  const partialTrigger = managementState.partialTrigger || {};
  const partialCompletion = managementState.partialCompletion || {};
  const partialExit = managementState.partialExit || {};

  if (!initialR.available) {
    return unknownResult(
      'Initial R is unavailable, so the canonical partial trigger (+1R) cannot be established; Partial Timing is UNKNOWN.',
      { initial_r_available: false }
    );
  }
  if (!daily.authoritative) {
    return unknownResult(
      'Verified daily session evidence is unavailable, so management days cannot be counted; Partial Timing is UNKNOWN.',
      { daily_authoritative: false, daily_reason: daily.reason || null }
    );
  }
  if (!policy.partialTrigger || !policy.completionWindow) {
    return unknownResult(
      'No explicit partial-trigger/completion-window policy is configured for this profile version; Partial Timing is UNKNOWN.',
      { policy_available: policy.available || null }
    );
  }

  if (partialExit.outcome === 'superseded_protective') {
    return notApplicableResult(
      'A proven protective-stop exit closed the position before the partial became due; Partial Timing is NOT_APPLICABLE.',
      { reason: 'superseded_protective', close_session: partialExit.closeSessionDate || null }
    );
  }
  if (partialExit.outcome === 'superseded_discretionary') {
    return {
      status: CRITERION_STATUS.FAIL,
      scoring_value: 'later_or_not_completed',
      raw_value: 'superseded_discretionary',
      evidence: { reason: 'superseded_discretionary', close_session: partialExit.closeSessionDate || null },
      message: 'The position was fully closed before the partial became due without evidence of a protective stop.'
    };
  }
  if (partialExit.outcome === 'superseded_ambiguous') {
    return unknownResult(
      'The position was fully closed before the partial became due and TradeTally cannot classify the exit as protective; Partial Timing is UNKNOWN.',
      { reason: 'superseded_ambiguous', close_session: partialExit.closeSessionDate || null }
    );
  }

  if (partialTrigger.status === 'never_reached') {
    return notApplicableResult(
      'Cumulative MFE never reached the configured minimum through the partial window; the partial rule is NOT_APPLICABLE.',
      { reason: partialTrigger.reason || 'never_reached_minimum_mfe', mfe_by_day: partialTrigger.mfeByDay || [] }
    );
  }
  if (partialTrigger.status !== 'triggered') {
    return unknownResult(
      partialTrigger.status === 'pending'
        ? 'The partial window has not yet fully elapsed (the trigger is pending); Partial Timing is UNKNOWN.'
        : 'The point-in-time +1R trigger could not be established from trustworthy evidence; Partial Timing is UNKNOWN.',
      { trigger_status: partialTrigger.status, reason: partialTrigger.reason || null }
    );
  }
  if (!managementState.fills || !managementState.fills.available) {
    return unknownResult(
      'Execution fill evidence is unavailable, so partial completion cannot be established; Partial Timing is UNKNOWN.',
      { partial_trigger_due_session: partialTrigger.dueSessionDate || null }
    );
  }
  if (partialCompletion.rounding && partialCompletion.rounding.resolved === false) {
    return unknownResult(
      'The required partial quantity could not be resolved without fabricating a tradable unit; Partial Timing is UNKNOWN.',
      { rounding_reason: partialCompletion.rounding.reason || null }
    );
  }

  const windowSessions = policy.completionWindow.sessions;
  const completed = partialCompletion.completed === true;
  const sessionsLate = partialCompletion.sessionsAfterTrigger;
  const withinWindow = completed && Number.isInteger(sessionsLate) && sessionsLate <= windowSessions;
  const outcome = partialCompletion.timingOutcome || 'later_or_not_completed';

  return {
    status: withinWindow ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: outcome,
    raw_value: outcome,
    evidence: {
      partial_trigger_due_session: partialTrigger.dueSessionDate || null,
      partial_trigger_due_day: partialTrigger.dueDay || null,
      first_reach_day: partialTrigger.firstReachDay || null,
      trigger_crossing_time: partialTrigger.crossing && partialTrigger.crossing.epoch
        ? new Date(partialTrigger.crossing.epoch * 1000).toISOString()
        : null,
      trigger_crossing_precision: partialTrigger.crossing ? partialTrigger.crossing.precision : null,
      completion_session: partialCompletion.completionSessionDate || null,
      sessions_after_trigger: sessionsLate,
      completion_window_sessions: windowSessions,
      timing_outcome: outcome
    },
    message: withinWindow
      ? `The partial was completed within the configured completion window (${sessionsLate} session(s) after the trigger).`
      : `The partial was not completed within the configured completion window (outcome: ${outcome}).`
  };
}

module.exports = { evaluate };
