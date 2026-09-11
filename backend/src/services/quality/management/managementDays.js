'use strict';

// Management day count, cumulative MFE-in-R, and partial-trigger maturity
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 34, 35, 36, 40).
//
// Pure functions; no database access. Session sequencing is EXACT: management
// days are derived from adjacent daily bars, never calendar arithmetic.
//
//   Day 1 = the session containing the initial entry (entryIndex).
//   Day N = bars[entryIndex + (N - 1)].
//
// Point-in-time discipline (hardening):
//   - Day 1's high must only include price evidence observable AFTER the actual
//     initial-entry timestamp. The orchestrator supplies the post-entry Day-1
//     high; Day 1 is never assumed to equal the daily high.
//   - Days 2..latest are fully after the entry session, so their daily high is
//     valid for "highest since entry".
//   - Trigger maturity is explicit: `never_reached` is only valid once every
//     required regular session through latest_day has completed.
//   - The trigger exposes an authoritative BOUNDARY (section 36/40):
//       * +1R reached before earliest_day -> due at earliest_day's regular
//         session OPEN (no second touch required);
//       * first reach on earliest_day..latest_day -> due at the first
//         trustworthy crossing instant.

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

// One-based management day for a session index relative to the entry index.
function managementDayForSession(entryIndex, sessionIndex) {
  if (!Number.isInteger(entryIndex) || !Number.isInteger(sessionIndex) || sessionIndex < entryIndex) {
    return null;
  }
  return sessionIndex - entryIndex + 1;
}

/**
 * Builds per-day evidence from normalized daily bars, including the regular
 * session bounds so the trigger can expose an instant-level boundary.
 *
 * @param {object} params
 * @param {Array} params.bars
 * @param {number} params.entryIndex
 * @param {number} params.latestDay
 * @param {Function} params.isSessionCompleted - sessionDate -> boolean.
 * @param {Function} [params.sessionBoundsForDate] - sessionDate -> { openEpoch, closeEpoch }.
 */
function buildDayEvidence({ bars, entryIndex, latestDay, isSessionCompleted, sessionBoundsForDate }) {
  const days = [];
  if (!Array.isArray(bars) || !Number.isInteger(entryIndex) || entryIndex < 0) return days;
  for (let day = 1; day <= latestDay; day += 1) {
    const sessionIndex = entryIndex + (day - 1);
    if (sessionIndex >= bars.length) break;
    const bar = bars[sessionIndex];
    const completed = typeof isSessionCompleted === 'function'
      ? isSessionCompleted(bar.date) === true
      : false;
    const bounds = typeof sessionBoundsForDate === 'function' ? sessionBoundsForDate(bar.date) : null;
    days.push({
      day,
      sessionIndex,
      sessionDate: bar.date,
      sessionOpenEpoch: bounds && isFiniteNumber(bounds.openEpoch) ? bounds.openEpoch : null,
      sessionCloseEpoch: bounds && isFiniteNumber(bounds.closeEpoch) ? bounds.closeEpoch : null,
      high: isFiniteNumber(bar.high) ? bar.high : null,
      highKnown: isFiniteNumber(bar.high),
      source: 'daily_bar',
      precision: 'daily_bar',
      sessionCompleted: completed,
      requiresEntryAdjustment: day === 1,
      possibleX: false
    });
  }
  return days;
}

function buildBoundary(day, { kind, epoch, precision, source, orderingKnown }) {
  return {
    kind,
    day: day ? day.day : null,
    sessionIndex: day ? day.sessionIndex : null,
    sessionDate: day ? day.sessionDate : null,
    sessionOpenEpoch: day ? day.sessionOpenEpoch : null,
    sessionCloseEpoch: day ? day.sessionCloseEpoch : null,
    epoch: isFiniteNumber(epoch) ? epoch : null,
    precision: precision || null,
    source: source || null,
    orderingKnown: orderingKnown === true
  };
}

/**
 * Resolves the canonical partial trigger with point-in-time precision, an
 * authoritative boundary, and explicit observation maturity.
 *
 * @returns {object} trigger state including `boundary`.
 */
function resolvePartialTrigger({ dayEvidence, entryBasis, rPerShare, parameters }) {
  const earliestDay = parameters ? parameters.earliest_day : null;
  const latestDay = parameters ? parameters.latest_day : null;
  const minimumMfeR = parameters ? parameters.minimum_mfe_r : null;

  const base = {
    crossed: false,
    triggered: false,
    dueDay: null,
    dueSessionIndex: null,
    dueSessionDate: null,
    dueSessionCompleted: false,
    firstReachDay: null,
    firstReachSessionIndex: null,
    firstReachSessionDate: null,
    reachedEarly: false,
    horizonComplete: false,
    observedDays: 0,
    day1Uncertain: false,
    boundary: null,
    reason: null,
    mfeByDay: []
  };

  if (!Number.isInteger(earliestDay) || !Number.isInteger(latestDay) || earliestDay < 1 || latestDay < earliestDay) {
    return { ...base, status: 'insufficient_evidence', reason: 'partial_trigger_parameters_invalid' };
  }
  if (!isFiniteNumber(minimumMfeR) || minimumMfeR <= 0 || !isFiniteNumber(entryBasis) || !isFiniteNumber(rPerShare) || rPerShare <= 0) {
    return { ...base, status: 'insufficient_evidence', reason: 'partial_trigger_parameters_invalid' };
  }
  if (!Array.isArray(dayEvidence) || dayEvidence.length === 0) {
    return { ...base, status: 'pending', reason: 'no_observed_sessions' };
  }

  const thresholdPrice = entryBasis + minimumMfeR * rPerShare;
  const scoped = dayEvidence.filter((day) => Number.isInteger(day.day) && day.day <= latestDay);
  const mfeByDay = [];
  let highest = -Infinity;
  let firstReachDay = null;

  for (const day of scoped) {
    if (day.highKnown && isFiniteNumber(day.high)) {
      highest = highest === -Infinity ? day.high : Math.max(highest, day.high);
    }
    const mfeR = highest === -Infinity ? null : (highest - entryBasis) / rPerShare;
    mfeByDay.push({
      day: day.day,
      sessionDate: day.sessionDate,
      high: day.high,
      highKnown: day.highKnown === true,
      source: day.source || null,
      precision: day.precision || null,
      mfeR
    });
    if (firstReachDay === null && day.highKnown && isFiniteNumber(day.high) && highest >= thresholdPrice) {
      firstReachDay = day.day;
    }
  }

  // Leading contiguous completed sessions.
  let observedDays = 0;
  for (const day of scoped) {
    if (day.sessionCompleted) observedDays = day.day;
    else break;
  }
  const horizonComplete = observedDays >= latestDay;

  const day1 = scoped.find((day) => day.day === 1);
  const day1Uncertain = !!day1 && day1.highKnown !== true && day1.possibleX === true;
  const anyUnknownHigh = scoped.some((day) => day.highKnown !== true && day.possibleX !== true);

  if (firstReachDay !== null) {
    const firstDay = scoped.find((day) => day.day === firstReachDay);
    const reachedEarly = firstReachDay < earliestDay;
    const dueDay = reachedEarly ? earliestDay : firstReachDay;
    const dueEntry = scoped.find((day) => day.day === dueDay);

    // Boundary: early +1R is due at earliest_day's regular-session OPEN; a
    // same-or-later first reach is due at the first crossing instant (the
    // orchestrator fills the epoch when intraday evidence establishes it).
    const boundary = reachedEarly
      ? buildBoundary(dueEntry, {
          kind: 'session_open',
          epoch: dueEntry ? dueEntry.sessionOpenEpoch : null,
          precision: 'session_open',
          source: 'session_calendar',
          orderingKnown: !!(dueEntry && isFiniteNumber(dueEntry.sessionOpenEpoch))
        })
      : buildBoundary(firstDay, {
          kind: 'crossing',
          epoch: null,
          precision: null,
          source: null,
          orderingKnown: false
        });

    const result = {
      ...base,
      crossed: true,
      reachedEarly,
      firstReachDay,
      firstReachSessionIndex: firstDay ? firstDay.sessionIndex : null,
      firstReachSessionDate: firstDay ? firstDay.sessionDate : null,
      dueDay,
      dueSessionIndex: dueEntry ? dueEntry.sessionIndex : null,
      dueSessionDate: dueEntry ? dueEntry.sessionDate : null,
      dueSessionCompleted: !!(dueEntry && dueEntry.sessionCompleted),
      horizonComplete,
      observedDays,
      day1Uncertain,
      boundary,
      mfeByDay
    };

    if (day1Uncertain && firstReachDay > earliestDay) {
      return { ...result, status: 'insufficient_evidence', reason: 'day1_post_entry_evidence_unavailable' };
    }
    if (!dueEntry || !dueEntry.sessionCompleted) {
      return { ...result, status: 'pending', reason: 'due_session_not_observed' };
    }
    return { ...result, status: 'triggered', triggered: true, reason: null };
  }

  const common = { ...base, horizonComplete, observedDays, day1Uncertain, mfeByDay };
  if (!horizonComplete) {
    return { ...common, status: 'pending', reason: 'horizon_not_elapsed' };
  }
  if (day1Uncertain || anyUnknownHigh) {
    return { ...common, status: 'insufficient_evidence', reason: 'incomplete_point_in_time_evidence' };
  }
  return { ...common, status: 'never_reached', reason: 'never_reached_minimum_mfe' };
}

function findCrossingInSession({
  bars,
  priorHighest,
  thresholdPrice,
  entryEpoch,
  sessionOpenEpoch,
  sessionCloseEpoch,
  observations = []
}) {
  let highest = isFiniteNumber(priorHighest) ? priorHighest : -Infinity;
  const scoped = (bars || [])
    .filter((bar) => isFiniteNumber(bar.time))
    .filter((bar) => !isFiniteNumber(sessionOpenEpoch) || bar.time >= sessionOpenEpoch)
    .filter((bar) => !isFiniteNumber(sessionCloseEpoch) || bar.time < sessionCloseEpoch)
    .filter((bar) => !isFiniteNumber(entryEpoch) || bar.time >= entryEpoch)
    .sort((a, b) => a.time - b.time);

  const obs = (observations || [])
    .filter((o) => isFiniteNumber(o.epoch) && isFiniteNumber(o.price) && o.price > 0)
    .filter((o) => !isFiniteNumber(sessionOpenEpoch) || o.epoch >= sessionOpenEpoch)
    .filter((o) => !isFiniteNumber(sessionCloseEpoch) || o.epoch < sessionCloseEpoch)
    .filter((o) => !isFiniteNumber(entryEpoch) || o.epoch >= entryEpoch)
    .sort((a, b) => a.epoch - b.epoch);

  let obsIndex = 0;
  for (const bar of scoped) {
    while (obsIndex < obs.length && obs[obsIndex].epoch <= bar.time) {
      highest = Math.max(highest, obs[obsIndex].price);
      if (highest >= thresholdPrice) {
        return { crossed: true, epoch: obs[obsIndex].epoch, price: obs[obsIndex].price, precision: 'execution_print', source: 'executions_jsonb', reason: null };
      }
      obsIndex += 1;
    }
    if (isFiniteNumber(bar.high)) {
      highest = Math.max(highest, bar.high);
      if (highest >= thresholdPrice) {
        return { crossed: true, epoch: bar.time, price: bar.high, precision: '1min_bar', source: 'intraday_cache', reason: null };
      }
    }
  }
  while (obsIndex < obs.length) {
    highest = Math.max(highest, obs[obsIndex].price);
    if (highest >= thresholdPrice) {
      return { crossed: true, epoch: obs[obsIndex].epoch, price: obs[obsIndex].price, precision: 'execution_print', source: 'executions_jsonb', reason: null };
    }
    obsIndex += 1;
  }
  return { crossed: false, epoch: null, price: null, precision: null, source: null, reason: null };
}

module.exports = {
  managementDayForSession,
  buildDayEvidence,
  resolvePartialTrigger,
  findCrossingInSession
};
