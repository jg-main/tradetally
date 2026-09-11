'use strict';

// Management day count and cumulative MFE-in-R helpers
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 34, 35, 36).
//
// Pure functions; no database access. Session sequencing is EXACT: management
// days are derived from adjacent daily bars, never calendar arithmetic.
//
//   Day 1 = the session containing the initial entry (entryIndex).
//   Day N = bars[entryIndex + (N - 1)].
//
// A "session" is one normalized daily bar. Weekends and exchange holidays never
// appear as bars, so they can never increment the management day count.

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// One-based management day for a session index relative to the entry index.
// Returns null when the session is before the entry session.
function managementDayForSession(entryIndex, sessionIndex) {
  if (!Number.isInteger(entryIndex) || !Number.isInteger(sessionIndex) || sessionIndex < entryIndex) {
    return null;
  }
  return sessionIndex - entryIndex + 1;
}

/**
 * Cumulative MFE (highest price since entry) in R for each management day up to
 * `maxDay`. MFE is cumulative and never resets by session.
 *
 * @param {object} params
 * @param {Array} params.bars - normalized daily bars (ascending by date).
 * @param {number} params.entryIndex - index of the entry session bar.
 * @param {number} params.entryBasis - immutable entry basis.
 * @param {number} params.rPerShare - immutable R per share (> 0).
 * @param {number} [params.maxDay=5] - inclusive upper management day.
 * @returns {Array<{day, sessionDate, sessionIndex, high, mfeR}>} one entry per
 *   management day present in the bars, cumulatively increasing mfeR.
 */
function cumulativeMfeInR({ bars, entryIndex, entryBasis, rPerShare, maxDay = 5 }) {
  if (!Array.isArray(bars) || !Number.isInteger(entryIndex) || entryIndex < 0) return [];
  if (!isFiniteNumber(entryBasis) || !isFiniteNumber(rPerShare) || rPerShare <= 0) return [];
  if (!Number.isInteger(maxDay) || maxDay < 1) return [];

  const rows = [];
  let highest = -Infinity;
  for (let day = 1; day <= maxDay; day += 1) {
    const sessionIndex = entryIndex + (day - 1);
    if (sessionIndex >= bars.length) break;
    const bar = bars[sessionIndex];
    highest = highest === -Infinity ? bar.high : Math.max(highest, bar.high);
    rows.push({
      day,
      sessionDate: bar.date,
      sessionIndex,
      high: bar.high,
      highestSinceEntry: highest,
      mfeR: (highest - entryBasis) / rPerShare
    });
  }
  return rows;
}

/**
 * Resolves the canonical partial trigger (section 36).
 *
 *   - cumulative MFE reaches >= minimum_mfe_r before earliest_day -> partial
 *     becomes due on earliest_day (no second touch required);
 *   - first reaches >= minimum_mfe_r on earliest_day..latest_day -> due that
 *     same session;
 *   - first reaches on latest_day+1 or later -> no canonical partial trigger;
 *   - never reaches through latest_day -> no trigger.
 *
 * @param {object} params
 * @param {Array} params.bars - normalized daily bars.
 * @param {number} params.entryIndex
 * @param {number} params.entryBasis
 * @param {number} params.rPerShare
 * @param {object} params.parameters - { earliest_day, latest_day, minimum_mfe_r }.
 * @returns {object|null} trigger info or null when unavailable/no-trigger:
 *   { triggered, dueDay, dueSessionDate, dueSessionIndex, firstReachDay,
 *     firstReachSessionDate, reachedEarly, mfeByDay }
 */
function resolvePartialTrigger({ bars, entryIndex, entryBasis, rPerShare, parameters }) {
  const earliestDay = parameters ? parameters.earliest_day : null;
  const latestDay = parameters ? parameters.latest_day : null;
  const minimumMfeR = parameters ? parameters.minimum_mfe_r : null;

  if (!Number.isInteger(earliestDay) || !Number.isInteger(latestDay) || earliestDay < 1 || latestDay < earliestDay) {
    return { triggered: false, dueDay: null, reason: 'partial_trigger_parameters_invalid', mfeByDay: [] };
  }
  if (!isFiniteNumber(minimumMfeR) || minimumMfeR <= 0) {
    return { triggered: false, dueDay: null, reason: 'partial_trigger_parameters_invalid', mfeByDay: [] };
  }

  const mfeByDay = cumulativeMfeInR({ bars, entryIndex, entryBasis, rPerShare, maxDay: latestDay });

  let firstReachDay = null;
  let firstReachSessionDate = null;
  for (const row of mfeByDay) {
    if (row.mfeR >= minimumMfeR) {
      firstReachDay = row.day;
      firstReachSessionDate = row.sessionDate;
      break;
    }
  }

  if (firstReachDay === null) {
    return {
      triggered: false,
      dueDay: null,
      dueSessionDate: null,
      dueSessionIndex: null,
      firstReachDay: null,
      firstReachSessionDate: null,
      reachedEarly: false,
      reason: 'never_reached_minimum_mfe',
      mfeByDay
    };
  }

  const reachedEarly = firstReachDay < earliestDay;
  const dueDay = reachedEarly ? earliestDay : firstReachDay;

  return {
    triggered: true,
    dueDay,
    dueSessionIndex: entryIndex + (dueDay - 1),
    dueSessionDate: mfeByDay[dueDay - 1] ? mfeByDay[dueDay - 1].sessionDate : null,
    firstReachDay,
    firstReachSessionDate,
    reachedEarly,
    reason: null,
    mfeByDay
  };
}

module.exports = {
  managementDayForSession,
  cumulativeMfeInR,
  resolvePartialTrigger
};
