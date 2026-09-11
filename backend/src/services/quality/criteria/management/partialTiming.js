'use strict';

// Partial Timing criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 38).
//
// Timing is evaluated against the canonical partial trigger (sections 36):
//   completed during trigger session        -> same_trigger_session (100)
//   completed next regular session          -> next_session (50)
//   later / not completed                   -> later_or_not_completed (0)
//
// Compliance requires completion during the trigger session. The criterion is
// NOT_APPLICABLE when the partial rule never triggered (+1R never reached by
// latest_day) and UNKNOWN when Initial R / daily evidence / fills are missing.

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult, notApplicableResult } = require('./common');

function evaluate({ criterion = {}, managementState = {} }) {
  const initialR = managementState.initialR || {};
  const daily = managementState.daily || {};
  const partialTrigger = managementState.partialTrigger || {};
  const partialCompletion = managementState.partialCompletion || {};

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
  if (!partialTrigger.triggered || partialTrigger.supersededByExit) {
    return notApplicableResult(
      partialTrigger.supersededByExit
        ? 'The position was fully closed before the partial became due; the partial rule is NOT_APPLICABLE.'
        : 'Cumulative MFE never reached the configured minimum through the partial window; the partial rule is NOT_APPLICABLE.',
      {
        first_reach_day: partialTrigger.firstReachDay || null,
        reason: partialTrigger.supersededByExit ? 'superseded_by_exit' : partialTrigger.reason || 'never_reached_minimum_mfe',
        mfe_by_day: partialTrigger.mfeByDay || []
      }
    );
  }
  if (!managementState.fills || !managementState.fills.available) {
    return unknownResult(
      'Execution fill evidence is unavailable, so partial completion cannot be established; Partial Timing is UNKNOWN.',
      { partial_trigger_due_session: partialTrigger.dueSessionDate || null }
    );
  }

  const outcome = partialCompletion.timingOutcome || 'later_or_not_completed';
  const passed = outcome === 'same_trigger_session';

  return {
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: outcome,
    raw_value: outcome,
    evidence: {
      partial_trigger_due_session: partialTrigger.dueSessionDate || null,
      partial_trigger_due_day: partialTrigger.dueDay || null,
      first_reach_day: partialTrigger.firstReachDay || null,
      completion_session: partialCompletion.completionSessionDate || null,
      completion_time: partialCompletion.completionTimeEpoch
        ? new Date(partialCompletion.completionTimeEpoch * 1000).toISOString()
        : null,
      timing_outcome: outcome
    },
    message: passed
      ? `The 50% partial was completed during the trigger session ${partialTrigger.dueSessionDate}.`
      : `The 50% partial was not completed during the trigger session (outcome: ${outcome}).`
  };
}

module.exports = { evaluate };
