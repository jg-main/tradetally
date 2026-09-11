'use strict';

// Trailing MA criterion (docs/QUALITY_PROFILES_REQUIREMENT.md sections 43, 44, 45).
//
// The selected trailing MA (SMA10 or SMA20) defines the exit signal: the first
// COMPLETED daily close strictly below the selected MA (equality is HOLD). The
// non-selected MA is irrelevant.
//
// Hardening:
//   - the criterion is applicable only when the trailing phase is actually
//     active (section 46); the signal search begins at activation, never at
//     entry by default;
//   - a protective-stop exit before the signal supersedes the criterion ONLY
//     when it is proven protective; an unclassified exit is UNKNOWN;
//   - an exit before the next session open never scores 100;
//   - if evidence ends before the conclusion can be established, UNKNOWN.

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult, notApplicableResult } = require('./common');

function evaluate({ managementState = {}, userInputs = {} }) {
  const selectedPeriod = userInputs.trailing_ma_period;
  const daily = managementState.daily || {};
  const policy = managementState.policy || {};
  const trailing = managementState.trailing || {};

  if (!policy.trailingActivation) {
    return unknownResult(
      'No trailing activation policy is configured for this profile version; Trailing MA is UNKNOWN.',
      { policy_available: policy.available || null }
    );
  }
  if (trailing.activationResolved === false) {
    return unknownResult(
      trailing.inactiveReason || 'Whether the trailing phase activated could not be established; Trailing MA is UNKNOWN.',
      { activation: trailing.activation || null, reason: trailing.inactiveReason || null }
    );
  }
  if (!trailing.active) {
    return notApplicableResult(
      trailing.inactiveReason || 'The trailing phase never activated, so the trailing MA exit is NOT_APPLICABLE.',
      { activation: trailing.activation || null, reason: trailing.inactiveReason || null }
    );
  }
  if (!selectedPeriod) {
    return unknownResult('No trailing MA period has been selected; Trailing MA is UNKNOWN.', { trailing_ma_period: null });
  }
  if (!daily.authoritative) {
    return unknownResult(
      'Verified daily session evidence is unavailable, so the trailing MA cannot be computed; Trailing MA is UNKNOWN.',
      { daily_authoritative: false, daily_reason: daily.reason || null }
    );
  }

  const supersession = trailing.supersession || {};
  if (supersession.outcome === 'superseded_protective') {
    return notApplicableResult(
      'A proven protective-stop exit closed the remaining position before any selected-MA signal; Trailing MA is superseded and NOT_APPLICABLE.',
      { superseded_reason: supersession.reason || 'protective_stop_exit_before_signal', close_session: supersession.closeSessionDate || null }
    );
  }
  if (supersession.outcome === 'superseded_discretionary') {
    return {
      status: CRITERION_STATUS.FAIL,
      scoring_value: 'later_or_ignored',
      raw_value: 'superseded_discretionary',
      evidence: { reason: 'superseded_discretionary', close_session: supersession.closeSessionDate || null },
      message: 'The remaining position was closed before the selected-MA signal without evidence of a protective stop.'
    };
  }
  if (supersession.outcome === 'superseded_ambiguous') {
    return unknownResult(
      'The remaining position was closed before the selected-MA signal and TradeTally cannot classify the exit as protective; Trailing MA is UNKNOWN.',
      { reason: 'superseded_ambiguous', close_session: supersession.closeSessionDate || null }
    );
  }

  if (!trailing.signal) {
    return unknownResult(
      trailing.signalReason || 'No trailing MA close signal could be established; Trailing MA is UNKNOWN.',
      { selected_period: selectedPeriod, activation_session_index: trailing.activationSessionIndex ?? null }
    );
  }
  if (!managementState.fills || !managementState.fills.available) {
    return unknownResult('Execution fill evidence is unavailable, so the actual exit cannot be established; Trailing MA is UNKNOWN.', {
      signal_date: trailing.signal.date || null
    });
  }
  if (!trailing.execution) {
    return unknownResult(
      trailing.executionReason || 'The exit timing relative to the signal could not be established; Trailing MA is UNKNOWN.',
      { signal_date: trailing.signal.date || null }
    );
  }

  const execution = trailing.execution;
  const outcome = execution.outcome || 'later_or_ignored';
  const passed = outcome === 'within_window';

  return {
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: outcome,
    raw_value: outcome,
    evidence: {
      trailing_ma_period: selectedPeriod,
      activation: trailing.activation || null,
      activation_source: trailing.activationSource || null,
      activation_session_index: trailing.activationSessionIndex ?? null,
      signal_date: trailing.signal.date || null,
      signal_close: trailing.signal.close ?? null,
      signal_ma_value: trailing.signal.sma ?? null,
      signal_bar_completed: trailing.signal.completed === true,
      signal_bar_source: daily.signalSource || daily.source || null,
      actual_exit_time: execution.actualExitEpoch
        ? new Date(execution.actualExitEpoch * 1000).toISOString()
        : null,
      actual_exit_price: trailing.exitPrice ?? null,
      next_session_date: execution.nextSessionDate || null,
      execution_window_open: execution.windowOpenEpoch
        ? new Date(execution.windowOpenEpoch * 1000).toISOString()
        : null,
      execution_window_close: execution.windowCloseEpoch
        ? new Date(execution.windowCloseEpoch * 1000).toISOString()
        : null,
      execution_window_minutes: policy.executionWindowMinutes ?? null,
      exit_before_next_open: execution.beforeNextOpen === true,
      execution_outcome: outcome
    },
    message: passed
      ? `The remaining position was exited within the configured execution window after the SMA${selectedPeriod} close signal.`
      : `The remaining position was not exited within the configured execution window (outcome: ${outcome}).`
  };
}

module.exports = { evaluate };
