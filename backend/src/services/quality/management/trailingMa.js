'use strict';

// Trailing MA helpers (docs/QUALITY_PROFILES_REQUIREMENT.md sections 43, 44, 45).
//
// Pure functions. The selected trailing MA (SMA10 or SMA20) is computed from
// completed daily closes; the exit signal is the FIRST completed daily close
// STRICTLY below the selected MA (equality is HOLD). The signal search begins
// only once the trailing phase is active. Execution timing is evaluated against
// regular-session boundaries (the next session after the signal), never
// calendar arithmetic.
//
// Point-in-time discipline:
//   - only COMPLETED daily bars may create a close-below-MA signal;
//   - an exit before the next session's open (signal-day close, after-hours,
//     overnight, premarket) is never "within window";
//   - no future-data leakage.

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Simple moving average of `period` closes ending at `endIndex` (inclusive).
function smaAt(bars, endIndex, period) {
  if (!Array.isArray(bars) || !Number.isInteger(period) || period < 1) return null;
  if (!Number.isInteger(endIndex) || endIndex < 0 || endIndex >= bars.length) return null;
  const startIndex = endIndex - period + 1;
  if (startIndex < 0) return null;
  let sum = 0;
  for (let i = startIndex; i <= endIndex; i += 1) {
    const close = bars[i] && bars[i].close;
    if (!isFiniteNumber(close) || close <= 0) return null;
    sum += close;
  }
  return sum / period;
}

function smaSeries(bars, period, fromIndex = 0) {
  if (!Array.isArray(bars) || !Number.isInteger(period) || period < 1) return [];
  const series = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (i < fromIndex) continue;
    const sma = smaAt(bars, i, period);
    if (sma === null) continue;
    series.push({ sessionIndex: i, date: bars[i].date, close: bars[i].close, sma });
  }
  return series;
}

/**
 * Finds the first COMPLETED daily close strictly below the selected SMA,
 * searching from `fromIndex` (trailing activation) through
 * `completedThroughIndex` (the last completed session).
 *
 * @returns {object|null} { sessionIndex, date, close, sma } or null.
 */
function findTrailingSignal({ bars, period, fromIndex, completedThroughIndex }) {
  if (!Array.isArray(bars)) return null;
  const upper = Number.isInteger(completedThroughIndex) ? completedThroughIndex : bars.length - 1;
  for (let i = fromIndex; i <= upper; i += 1) {
    if (i < 0 || i >= bars.length) continue;
    const sma = smaAt(bars, i, period);
    if (sma === null) continue;
    const close = bars[i].close;
    if (isFiniteNumber(close) && close < sma) {
      return { sessionIndex: i, date: bars[i].date, close, sma, completed: true };
    }
  }
  return null;
}

/**
 * Classifies actual-exit execution timing relative to a trailing signal.
 *
 * Boundary convention: regular-session windows are half-open `[open, close)`.
 *   - exit before the next session open           -> later_or_ignored (0)
 *   - open <= exit <= open + windowMinutes         -> within_window (100)
 *   - windowClose < exit < next session close      -> later_same_next_session (70)
 *   - second open <= exit < second session close   -> one_session_late (40)
 *   - otherwise (overnight, premarket, after close) -> later_or_ignored (0)
 *
 * @returns {object}
 */
function classifyTrailingExecution({
  nextSession,
  secondNextSession,
  actualExitEpoch,
  executionWindowMinutes
}) {
  const base = {
    outcome: 'later_or_ignored',
    reason: null,
    beforeNextOpen: false,
    nextSessionDate: nextSession ? nextSession.date : null,
    windowOpenEpoch: nextSession ? nextSession.openEpoch : null,
    windowCloseEpoch: null,
    actualExitEpoch: isFiniteNumber(actualExitEpoch) ? actualExitEpoch : null
  };
  if (!nextSession || !isFiniteNumber(nextSession.openEpoch) || !isFiniteNumber(nextSession.closeEpoch)) {
    return { ...base, reason: 'no_next_session' };
  }
  const minutes = Number.isInteger(executionWindowMinutes) && executionWindowMinutes > 0
    ? executionWindowMinutes
    : null;
  if (minutes === null) {
    return { ...base, reason: 'execution_window_unconfigured' };
  }
  const windowCloseEpoch = nextSession.openEpoch + minutes * 60;
  base.windowCloseEpoch = windowCloseEpoch;

  if (!isFiniteNumber(actualExitEpoch)) {
    return { ...base, reason: 'no_exit_evidence' };
  }
  if (actualExitEpoch < nextSession.openEpoch) {
    return { ...base, reason: 'exit_before_next_session_open', beforeNextOpen: true };
  }
  if (actualExitEpoch <= windowCloseEpoch) {
    return { ...base, outcome: 'within_window', reason: null };
  }
  if (actualExitEpoch < nextSession.closeEpoch) {
    return { ...base, outcome: 'later_same_next_session', reason: null };
  }
  // One session late ONLY when the exit is within the following regular
  // session. Overnight (after the next close, before the second open) and
  // second-day premarket are not the late regular session.
  if (
    secondNextSession &&
    isFiniteNumber(secondNextSession.openEpoch) &&
    isFiniteNumber(secondNextSession.closeEpoch) &&
    actualExitEpoch >= secondNextSession.openEpoch &&
    actualExitEpoch < secondNextSession.closeEpoch
  ) {
    return { ...base, outcome: 'one_session_late', reason: null };
  }
  return { ...base, outcome: 'later_or_ignored', reason: 'exit_outside_second_regular_session' };
}

module.exports = {
  smaAt,
  smaSeries,
  findTrailingSignal,
  classifyTrailingExecution
};
