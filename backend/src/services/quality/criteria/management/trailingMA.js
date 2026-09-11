'use strict';

// Trailing MA criterion (docs/QUALITY_PROFILES_REQUIREMENT.md sections 43, 44, 45).
//
// The selected trailing MA (SMA10 or SMA20) defines the exit signal: the first
// completed daily close strictly below the selected MA (equality is HOLD). The
// non-selected MA is irrelevant. A legitimate protective-stop exit before the
// signal supersedes the MA criterion (NOT_APPLICABLE).
//
// Execution timing is graded against the configured execution window (canonical:
// first 30 minutes of the next regular session).

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult, notApplicableResult } = require('./common');

function evaluate({ criterion = {}, managementState = {}, userInputs = {} }) {
  const selectedPeriod = userInputs.trailing_ma_period;
  const daily = managementState.daily || {};
  const trailing = managementState.trailing || {};

  if (!selectedPeriod) {
    return unknownResult(
      'No trailing MA period has been selected; Trailing MA is UNKNOWN.',
      { trailing_ma_period: null }
    );
  }
  if (!daily.authoritative) {
    return unknownResult(
      'Verified daily session evidence is unavailable, so the trailing MA cannot be computed; Trailing MA is UNKNOWN.',
      { daily_authoritative: false, daily_reason: daily.reason || null }
    );
  }
  if (trailing.superseded) {
    return notApplicableResult(
      'The remaining position was closed before any selected-MA close signal; the trailing MA exit is superseded and NOT_APPLICABLE.',
      { superseded_reason: trailing.supersededReason || 'protective_stop_exit_before_signal' }
    );
  }
  if (!trailing.signal) {
    return unknownResult(
      trailing.signalReason || 'No trailing MA close signal could be established; Trailing MA is UNKNOWN.',
      { selected_period: selectedPeriod }
    );
  }
  if (!managementState.fills || !managementState.fills.available) {
    return unknownResult(
      'Execution fill evidence is unavailable, so the actual exit cannot be established; Trailing MA is UNKNOWN.',
      { signal_date: trailing.signal.date || null }
    );
  }

  const execution = trailing.execution || {};
  const outcome = execution.outcome || 'later_or_ignored';
  const passed = outcome === 'within_window';

  return {
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: outcome,
    raw_value: outcome,
    evidence: {
      trailing_ma_period: selectedPeriod,
      signal_date: trailing.signal.date || null,
      signal_close: trailing.signal.close ?? null,
      signal_ma_value: trailing.signal.sma ?? null,
      actual_exit_time: execution.actualExitEpoch
        ? new Date(execution.actualExitEpoch * 1000).toISOString()
        : null,
      next_session_date: execution.nextSessionDate || null,
      execution_window_open: execution.windowOpenEpoch
        ? new Date(execution.windowOpenEpoch * 1000).toISOString()
        : null,
      execution_window_close: execution.windowCloseEpoch
        ? new Date(execution.windowCloseEpoch * 1000).toISOString()
        : null,
      execution_outcome: outcome
    },
    message: passed
      ? `The remaining position was exited within the configured execution window after the SMA${selectedPeriod} close signal.`
      : `The remaining position was not exited within the configured execution window (outcome: ${outcome}).`
  };
}

module.exports = { evaluate };
