'use strict';

// Trailing MA helpers (docs/QUALITY_PROFILES_REQUIREMENT.md sections 43, 44, 45).
//
// Pure functions. The selected trailing MA (SMA10 or SMA20) is computed from
// completed daily closes; the exit signal is the FIRST completed daily close
// STRICTLY below the selected MA (equality is HOLD). Execution timing is
// evaluated against regular-session boundaries (next session after the signal),
// never calendar arithmetic.
//
// No future-data leakage: a session's SMA uses only closes up to and including
// that session; the signal search only uses sessions that have completed.

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// Simple moving average of `period` closes ending at `endIndex` (inclusive).
// Returns null when the window is incomplete.
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

/**
 * Computes the trailing MA series over the given bars for `period`.
 *
 * @param {Array} bars - normalized daily bars.
 * @param {number} period - SMA period (10 or 20).
 * @param {number} fromIndex - first index at which the SMA may be used
 *   (inclusive); SMA values before this are not needed.
 * @returns {Array<{sessionIndex, date, close, sma}>} from the first index where
 *   the SMA is computable.
 */
function smaSeries(bars, period, fromIndex = 0) {
  if (!Array.isArray(bars) || !Number.isInteger(period) || period < 1) return [];
  const series = [];
  for (let i = 0; i < bars.length; i += 1) {
    if (i < fromIndex) continue;
    const sma = smaAt(bars, i, period);
    if (sma === null) continue;
    series.push({
      sessionIndex: i,
      date: bars[i].date,
      close: bars[i].close,
      sma
    });
  }
  return series;
}

/**
 * Finds the first completed daily close strictly below the selected SMA,
 * searching from `fromIndex` (the entry session) onward.
 *
 * @param {Array} bars - normalized daily bars.
 * @param {number} period - selected SMA period.
 * @param {number} fromIndex - entry session index (inclusive).
 * @returns {object|null} { sessionIndex, date, close, sma } or null when no
 *   signal exists within the available bars.
 */
function findTrailingSignal(bars, period, fromIndex) {
  const series = smaSeries(bars, period, fromIndex);
  for (const point of series) {
    // Equality is HOLD, not exit (section 44).
    if (point.close < point.sma) {
      return point;
    }
  }
  return null;
}

/**
 * Classifies actual-exit execution timing relative to a trailing signal.
 *
 * @param {object} params
 * @param {object} params.signal - { sessionIndex, date } from findTrailingSignal.
 * @param {Array} params.bars - normalized daily bars.
 * @param {number} params.actualExitEpoch - epoch seconds of the final closing fill.
 * @param {Function} params.regularSessionBounds - date -> { openEpoch, closeEpoch }.
 * @param {number} [params.executionWindowMinutes=30]
 * @returns {object}
 *   { outcome: 'within_window'|'later_same_next_session'|'one_session_late'|
 *              'later_or_ignored'|'no_next_session',
 *     nextSessionDate, windowOpenEpoch, windowCloseEpoch, actualExitEpoch }
 */
function classifyTrailingExecution({
  signal,
  bars,
  actualExitEpoch,
  regularSessionBounds,
  executionWindowMinutes = 30
}) {
  if (!signal || !Array.isArray(bars)) {
    return { outcome: 'later_or_ignored', reason: 'no_signal' };
  }
  const nextIndex = signal.sessionIndex + 1;
  if (nextIndex >= bars.length) {
    return { outcome: 'later_or_ignored', reason: 'no_next_session' };
  }
  const nextDate = bars[nextIndex].date;
  const nextBounds = regularSessionBounds(nextDate);
  if (!nextBounds) {
    return { outcome: 'later_or_ignored', reason: 'no_next_session_bounds' };
  }
  const windowMinutes = Number.isInteger(executionWindowMinutes) && executionWindowMinutes > 0
    ? executionWindowMinutes
    : 30;
  const windowOpenEpoch = nextBounds.openEpoch;
  const windowCloseEpoch = nextBounds.openEpoch + windowMinutes * 60;

  if (!isFiniteNumber(actualExitEpoch)) {
    return {
      outcome: 'later_or_ignored',
      reason: 'no_exit_evidence',
      nextSessionDate: nextDate,
      windowOpenEpoch,
      windowCloseEpoch,
      actualExitEpoch: null
    };
  }

  if (actualExitEpoch <= windowCloseEpoch) {
    return {
      outcome: 'within_window',
      nextSessionDate: nextDate,
      windowOpenEpoch,
      windowCloseEpoch,
      actualExitEpoch
    };
  }
  if (actualExitEpoch < nextBounds.closeEpoch) {
    return {
      outcome: 'later_same_next_session',
      nextSessionDate: nextDate,
      windowOpenEpoch,
      windowCloseEpoch,
      actualExitEpoch
    };
  }
  // One additional session late: exit during the session after the next.
  const secondNextIndex = nextIndex + 1;
  if (secondNextIndex < bars.length) {
    const secondBounds = regularSessionBounds(bars[secondNextIndex].date);
    if (secondBounds && actualExitEpoch < secondBounds.closeEpoch) {
      return {
        outcome: 'one_session_late',
        nextSessionDate: nextDate,
        windowOpenEpoch,
        windowCloseEpoch,
        actualExitEpoch
      };
    }
  }
  return {
    outcome: 'later_or_ignored',
    nextSessionDate: nextDate,
    windowOpenEpoch,
    windowCloseEpoch,
    actualExitEpoch
  };
}

module.exports = {
  smaAt,
  smaSeries,
  findTrailingSignal,
  classifyTrailingExecution
};
