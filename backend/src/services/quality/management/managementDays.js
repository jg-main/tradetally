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
//   - A first crossing may only be claimed at bar precision when the minute
//     path PRECEDING the candidate is complete (reusing the Phase-3 sufficiency
//     helpers). Sparse evidence yields a conservative uncertainty interval
//     rather than a fabricated narrow [barOpen, barClose).

const { missingIntervalStarts } = require('../intradayEvidenceService');

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
      highValueKnown: isFiniteNumber(bar.high),
      definitivelyBelowThreshold: false,
      source: 'daily_bar',
      precision: 'daily_bar',
      sessionCompleted: completed,
      requiresEntryAdjustment: day === 1,
      possibleX: false
    });
  }
  return days;
}

function buildBoundary(day, { kind, epoch, precision, source, orderingKnown, intervalStartEpoch, intervalEndEpoch, uncertaintyStartEpoch, uncertaintyEndEpoch, uncertain }) {
  return {
    kind,
    // Instant boundaries (session open / crossing) order by epoch or interval;
    // window-end boundaries fall back to session granularity.
    mode: kind === 'session_open' || kind === 'crossing' ? 'instant' : 'session',
    day: day ? day.day : null,
    sessionIndex: day ? day.sessionIndex : null,
    sessionDate: day ? day.sessionDate : null,
    sessionOpenEpoch: day ? day.sessionOpenEpoch : null,
    sessionCloseEpoch: day ? day.sessionCloseEpoch : null,
    epoch: isFiniteNumber(epoch) ? epoch : null,
    // A 1-minute crossing is an INTERVAL, never a fabricated exact instant.
    intervalStartEpoch: isFiniteNumber(intervalStartEpoch) ? intervalStartEpoch : null,
    intervalEndEpoch: isFiniteNumber(intervalEndEpoch) ? intervalEndEpoch : null,
    // Conservative first-crossing uncertainty interval when the preceding
    // minute path is sparse.
    uncertaintyStartEpoch: isFiniteNumber(uncertaintyStartEpoch) ? uncertaintyStartEpoch : null,
    uncertaintyEndEpoch: isFiniteNumber(uncertaintyEndEpoch) ? uncertaintyEndEpoch : null,
    uncertain: uncertain === true,
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
      highValueKnown: isFiniteNumber(day.high) || day.highValueKnown === true,
      definitivelyBelowThreshold: day.definitivelyBelowThreshold === true,
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
  const anyUnknownHigh = scoped.some(
    (day) => day.highKnown !== true && day.possibleX !== true && day.definitivelyBelowThreshold !== true
  );

  if (firstReachDay !== null) {
    const firstDay = scoped.find((day) => day.day === firstReachDay);
    const reachedEarly = firstReachDay < earliestDay;
    const dueDay = reachedEarly ? earliestDay : firstReachDay;
    const dueEntry = scoped.find((day) => day.day === dueDay);

    // If Day 1 is point-in-time uncertain and the first CONFIRMED crossing is
    // exactly on earliest_day, the due DATE is known (earliest_day) but the due
    // INSTANT is not: +1R may have occurred on Day 1 (=> due at the
    // earliest_day regular-session OPEN) or first on earliest_day (=> due at
    // that crossing). Represent the boundary as an uncertainty corridor rather
    // than a falsely precise earliest_day crossing boundary.
    const day1EarliestDayUncertainty = day1Uncertain && !reachedEarly && firstReachDay === earliestDay;

    let boundary;
    if (reachedEarly) {
      // Early +1R is due at earliest_day's regular-session OPEN.
      boundary = buildBoundary(dueEntry, {
        kind: 'session_open',
        epoch: dueEntry ? dueEntry.sessionOpenEpoch : null,
        precision: 'session_open',
        source: 'session_calendar',
        orderingKnown: !!(dueEntry && isFiniteNumber(dueEntry.sessionOpenEpoch))
      });
    } else if (day1EarliestDayUncertainty) {
      // Corridor: [earliest_day open, confirmed earliest_day crossing upper
      // bound]. The orchestrator fills the upper bound from the confirmed
      // crossing evidence (exact print, bar-interval end, or sparse uncertainty
      // end).
      boundary = buildBoundary(firstDay, {
        kind: 'crossing',
        epoch: null,
        intervalStartEpoch: null,
        intervalEndEpoch: null,
        uncertaintyStartEpoch: dueEntry ? dueEntry.sessionOpenEpoch : null,
        uncertaintyEndEpoch: null,
        uncertain: true,
        precision: null,
        source: null,
        orderingKnown: false
      });
      boundary.day1EarliestDayUncertainty = true;
    } else {
      // A same-or-later first reach is due at the first crossing instant (the
      // orchestrator fills the epoch when intraday evidence establishes it).
      boundary = buildBoundary(firstDay, {
        kind: 'crossing',
        epoch: null,
        precision: null,
        source: null,
        orderingKnown: false
      });
    }

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
  observations = [],
  barResolutionSeconds = 60,
  pathStartEpoch
}) {
  const resolution = isFiniteNumber(barResolutionSeconds) && barResolutionSeconds > 0 ? barResolutionSeconds : 60;
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

  let pathStart = null;
  if (isFiniteNumber(pathStartEpoch)) {
    pathStart = pathStartEpoch;
  } else if (isFiniteNumber(sessionOpenEpoch)) {
    // Day 1: the path to validate begins at the first fully post-entry interval.
    pathStart = isFiniteNumber(entryEpoch) && entryEpoch > sessionOpenEpoch
      ? sessionOpenEpoch + Math.ceil((entryEpoch - sessionOpenEpoch) / resolution) * resolution
      : sessionOpenEpoch;
  } else if (scoped.length > 0) {
    pathStart = scoped[0].time;
  }
  const regionStart = isFiniteNumber(entryEpoch) && isFiniteNumber(pathStart)
    ? Math.min(entryEpoch, pathStart)
    : pathStart;

  // A candidate crossing is only authoritative when every expected 1-minute
  // interval before it is present. Otherwise the true first crossing may have
  // occurred in an earlier missing interval, so we return a conservative
  // uncertainty interval instead of a fabricated narrow bar interval.
  const resolveCandidate = ({ price, precision, source, candidateStart, candidateEnd }) => {
    const beforePathStart = isFiniteNumber(pathStart) && isFiniteNumber(candidateStart) && candidateStart < pathStart;
    const missing = (!isFiniteNumber(pathStart) || beforePathStart || !isFiniteNumber(candidateStart))
      ? []
      : missingIntervalStarts(scoped, pathStart, candidateStart, resolution);
    if (missing.length === 0 && isFiniteNumber(candidateStart) && !beforePathStart) {
      if (precision === 'execution_print') {
        return {
          crossed: true, crossingEpoch: candidateStart, crossingStartEpoch: null, crossingEndEpoch: null,
          uncertaintyStartEpoch: null, uncertaintyEndEpoch: null, authoritative: true,
          price, precision, source, missingIntervals: 0, reason: null
        };
      }
      return {
        crossed: true, crossingEpoch: null, crossingStartEpoch: candidateStart, crossingEndEpoch: candidateEnd,
        uncertaintyStartEpoch: null, uncertaintyEndEpoch: null, authoritative: true,
        price, precision, source, missingIntervals: 0, reason: null
      };
    }
    const start = missing.length > 0
      ? Math.min(...missing)
      : (isFiniteNumber(regionStart) ? regionStart : candidateStart);
    return {
      crossed: true, crossingEpoch: null, crossingStartEpoch: null, crossingEndEpoch: null,
      uncertaintyStartEpoch: start, uncertaintyEndEpoch: candidateEnd, authoritative: false,
      price, precision, source, missingIntervals: missing.length,
      reason: missing.length > 0 ? 'preceding_intraday_intervals_missing' : 'candidate_precedes_validated_path_start'
    };
  };

  let obsIndex = 0;
  for (const bar of scoped) {
    while (obsIndex < obs.length && obs[obsIndex].epoch <= bar.time) {
      highest = Math.max(highest, obs[obsIndex].price);
      if (highest >= thresholdPrice) {
        return resolveCandidate({
          price: obs[obsIndex].price, precision: 'execution_print', source: 'executions_jsonb',
          candidateStart: obs[obsIndex].epoch, candidateEnd: obs[obsIndex].epoch
        });
      }
      obsIndex += 1;
    }
    if (isFiniteNumber(bar.high)) {
      highest = Math.max(highest, bar.high);
      if (highest >= thresholdPrice) {
        return resolveCandidate({
          price: bar.high, precision: '1min_bar', source: 'intraday_cache',
          candidateStart: bar.time, candidateEnd: bar.time + resolution
        });
      }
    }
  }
  while (obsIndex < obs.length) {
    highest = Math.max(highest, obs[obsIndex].price);
    if (highest >= thresholdPrice) {
      return resolveCandidate({
        price: obs[obsIndex].price, precision: 'execution_print', source: 'executions_jsonb',
        candidateStart: obs[obsIndex].epoch, candidateEnd: obs[obsIndex].epoch
      });
    }
    obsIndex += 1;
  }
  return {
    crossed: false,
    crossingEpoch: null,
    crossingStartEpoch: null,
    crossingEndEpoch: null,
    uncertaintyStartEpoch: null,
    uncertaintyEndEpoch: null,
    authoritative: false,
    price: null,
    precision: null,
    source: null,
    missingIntervals: 0,
    reason: null
  };
}

module.exports = {
  managementDayForSession,
  buildDayEvidence,
  resolvePartialTrigger,
  findCrossingInSession
};
