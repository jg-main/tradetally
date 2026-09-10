'use strict';

// Entry trigger resolution (docs/QUALITY_PROFILES_REQUIREMENT.md section 24).
//
// Supported canonical trigger types:
//   BO-PIVOT    TriggerPrice = ConfirmedPivot
//   BO-ORH-1    regular-session opening range 09:30-09:31 ET
//   BO-ORH-5    regular-session opening range 09:30-09:35 ET
//   BO-ORH-60   regular-session opening range 09:30-10:30 ET
//
//   EffectiveTrigger = max(ConfirmedPivot, OpeningRangeHigh)  (ORH only)
//   crossThreshold   = EffectiveTrigger * (1 + minimum_penetration_pct / 100)
//
// Canonical requires the first market trade PRICE strictly above the effective
// threshold; the user's actual opening fill is an observed execution print and
// may itself establish that the trade price was above the trigger.
//
// An ORH trigger does not exist until the opening range is fully complete: an
// entry before the configured completion time is a known FAIL (never a
// retrospective valid ORH entry). When ORH intraday evidence is genuinely
// unavailable the result is UNKNOWN, never fabricated from later bars.
//
// Point-in-time invariant: only bars fully observable before the entry cutoff
// may contribute. Bars are bar-OPEN intervals (see entry/sessionTime.js).

const { CRITERION_STATUS } = require('../constants');
const {
  openingRangeBounds,
  regularSessionBounds,
  observableBars,
  barFullyObservable
} = require('./sessionTime');

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isoOrNull(epochSeconds) {
  return Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : null;
}

// Best-effort crossing evidence from fully-observable 1-minute bars. OHLC bars
// cannot reproduce tick-level cross counts; this is retained as evidence only
// and never determines compliance.
function crossingEvidence(bars, threshold) {
  let barsAbove = 0;
  let firstCrossEpoch = null;
  for (const bar of bars) {
    if (isFiniteNumber(bar.high) && bar.high > threshold) {
      barsAbove += 1;
      if (firstCrossEpoch === null) firstCrossEpoch = bar.time;
    }
  }
  return { barsAbove, firstCrossEpoch };
}

/**
 * @param {object} params
 * @param {string} params.triggerType
 * @param {object} params.parameters - trigger_compliance criterion parameters.
 * @param {object} params.setupContext - { confirmedPivot, breakoutSession, resolutionDate }.
 * @param {object} params.executionEvidence - normalized execution evidence.
 * @param {object|null} params.intraday - entry-session intraday evidence or null.
 * @returns {object} resolved trigger with status/reason/evidence.
 */
function resolveTrigger({ triggerType, parameters = {}, setupContext = {}, executionEvidence = {}, intraday = null }) {
  const confirmedPivot = setupContext.confirmedPivot;
  const breakoutSession = setupContext.breakoutSession;
  const allowedTypes = Array.isArray(parameters.allowed_types) ? parameters.allowed_types : [];
  const minPenPct = isFiniteNumber(parameters.minimum_penetration_pct) ? parameters.minimum_penetration_pct : 0;
  const requirePivotResolution = parameters.require_pivot_resolution === true;

  const base = {
    triggerType,
    confirmedPivot: confirmedPivot ?? null,
    openingRangeHigh: null,
    effectiveTrigger: null,
    triggerValidFrom: null,
    triggerTime: null,
    entryPrintPrice: executionEvidence.entryBasis ?? null,
    entryPrintTime: executionEvidence.initialEntryTime ?? null,
    triggerCrossNumber: null,
    minutesAfterFirstTrigger: null,
    marketEvidenceResolution: intraday ? intraday.resolution || '1min' : null
  };

  if (!allowedTypes.includes(triggerType)) {
    return {
      ...base,
      status: CRITERION_STATUS.UNKNOWN,
      reason: `Intended trigger type "${triggerType}" is not permitted by the profile.`,
      evidence: { allowed_types: allowedTypes }
    };
  }
  if (!isFiniteNumber(confirmedPivot) || confirmedPivot <= 0) {
    return {
      ...base,
      status: CRITERION_STATUS.UNKNOWN,
      reason: 'The confirmed Pivot is unavailable; trigger compliance cannot be evaluated.'
    };
  }
  const entryPrintPrice = executionEvidence.entryBasis;
  const entryPrintEpoch = executionEvidence.initialEntryEpoch;
  if (!isFiniteNumber(entryPrintPrice) || entryPrintPrice <= 0 || !Number.isFinite(entryPrintEpoch)) {
    return {
      ...base,
      status: CRITERION_STATUS.UNKNOWN,
      reason: 'Actual opening execution evidence is unavailable; trigger compliance cannot be established.'
    };
  }

  const penetration = minPenPct / 100;
  const session = breakoutSession ? regularSessionBounds(breakoutSession) : null;

  if (triggerType === 'BO-PIVOT') {
    const effectiveTrigger = confirmedPivot;
    const threshold = effectiveTrigger * (1 + penetration);
    // A direct-Pivot trigger is only valid once the Pivot is resolved: when the
    // profile requires pivot resolution, an entry before the breakout/resolution
    // session open cannot be a valid BO-PIVOT entry.
    if (requirePivotResolution && session && entryPrintEpoch < session.openEpoch) {
      return {
        ...base,
        effectiveTrigger,
        triggerValidFrom: session.openEpoch,
        status: CRITERION_STATUS.FAIL,
        reason: `Entry occurred before the Pivot was resolved (breakout session ${breakoutSession} opens at ${isoOrNull(session.openEpoch)}); a direct-Pivot trigger requires pivot resolution.`,
        evidence: {
          trigger_type: 'BO-PIVOT',
          confirmed_pivot: confirmedPivot,
          effective_trigger: effectiveTrigger,
          cross_threshold: threshold,
          entry_print_price: entryPrintPrice,
          entry_print_time: isoOrNull(entryPrintEpoch),
          trigger_valid_from: isoOrNull(session.openEpoch),
          require_pivot_resolution: true,
          entry_before_pivot_resolution: true
        }
      };
    }
    const passed = entryPrintPrice > threshold;
    let triggerTime = null;
    let crossNumber = null;
    let minutesAfter = null;

    const bars = intraday && Array.isArray(intraday.entrySessionBars)
      ? regularBarsFor(intraday, session)
      : [];
    const observable = observableBars(bars, entryPrintEpoch, intraday ? intraday.resolutionSeconds || 60 : 60);
    const crossings = crossingEvidence(observable, threshold);
    if (crossings.firstCrossEpoch !== null) {
      triggerTime = crossings.firstCrossEpoch;
      crossNumber = Math.max(1, crossings.barsAbove);
      minutesAfter = Math.round((entryPrintEpoch - crossings.firstCrossEpoch) / 60);
    } else if (passed) {
      triggerTime = entryPrintEpoch;
      crossNumber = 1;
      minutesAfter = 0;
    }

    return {
      ...base,
      openingRangeHigh: null,
      effectiveTrigger,
      triggerValidFrom: session ? session.openEpoch : null,
      triggerTime,
      triggerCrossNumber: crossNumber,
      minutesAfterFirstTrigger: minutesAfter,
      status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
      reason: passed
        ? `Opening execution ${entryPrintPrice} is above the confirmed Pivot threshold ${threshold}.`
        : `Opening execution ${entryPrintPrice} is not above the confirmed Pivot threshold ${threshold}.`,
      evidence: {
        trigger_type: 'BO-PIVOT',
        confirmed_pivot: confirmedPivot,
        effective_trigger: effectiveTrigger,
        cross_threshold: threshold,
        minimum_penetration_pct: minPenPct,
        require_pivot_resolution: requirePivotResolution,
        entry_print_price: entryPrintPrice,
        entry_print_time: isoOrNull(entryPrintEpoch),
        trigger_valid_from: isoOrNull(session ? session.openEpoch : null),
        trigger_time: isoOrNull(triggerTime),
        trigger_cross_number: crossNumber,
        trigger_cross_number_method: 'completed_1min_bars_above_threshold',
        minutes_after_first_trigger: minutesAfter,
        market_evidence_resolution: intraday ? intraday.resolution || '1min' : null
      }
    };
  }

  const range = breakoutSession ? openingRangeBounds(breakoutSession, triggerType) : null;
  if (!range) {
    return {
      ...base,
      status: CRITERION_STATUS.UNKNOWN,
      reason: `Unsupported or unresolvable opening-range trigger type "${triggerType}".`
    };
  }

  // An entry before the opening range completes can never be a valid ORH entry.
  if (entryPrintEpoch < range.completionEpoch) {
    return {
      ...base,
      triggerValidFrom: range.completionEpoch,
      status: CRITERION_STATUS.FAIL,
      reason: `Entry occurred before the ${range.minutes}-minute opening range completed at ${isoOrNull(range.completionEpoch)}; an ORH trigger is not valid before completion.`,
      evidence: {
        trigger_type: triggerType,
        confirmed_pivot: confirmedPivot,
        opening_range_minutes: range.minutes,
        opening_range_start: isoOrNull(range.startEpoch),
        opening_range_complete: isoOrNull(range.completionEpoch),
        entry_print_time: isoOrNull(entryPrintEpoch),
        entry_before_opening_range_complete: true
      }
    };
  }

  if (!intraday || !Array.isArray(intraday.entrySessionBars) || intraday.entrySessionBars.length === 0) {
    return {
      ...base,
      triggerValidFrom: range.completionEpoch,
      status: CRITERION_STATUS.UNKNOWN,
      reason: 'Opening-range intraday evidence is unavailable; the ORH effective trigger cannot be established.'
    };
  }

  const resolutionSeconds = intraday.resolutionSeconds || 60;
  const rangeBars = (intraday.entrySessionBars || []).filter(
    (bar) =>
      isFiniteNumber(bar.time) &&
      bar.time >= range.startEpoch &&
      barFullyObservable(bar.time, range.completionEpoch, resolutionSeconds)
  );
  if (rangeBars.length === 0) {
    return {
      ...base,
      triggerValidFrom: range.completionEpoch,
      status: CRITERION_STATUS.UNKNOWN,
      reason: 'No fully-completed opening-range bars are observable; the ORH effective trigger cannot be established.'
    };
  }
  const openingRangeHigh = rangeBars.reduce((max, bar) => Math.max(max, bar.high), -Infinity);
  if (!isFiniteNumber(openingRangeHigh)) {
    return {
      ...base,
      triggerValidFrom: range.completionEpoch,
      status: CRITERION_STATUS.UNKNOWN,
      reason: 'Opening-range bars contain unusable high prices.'
    };
  }
  const effectiveTrigger = Math.max(confirmedPivot, openingRangeHigh);
  const threshold = effectiveTrigger * (1 + penetration);
  const passed = entryPrintPrice > threshold;

  const observable = observableBars(
    intraday.entrySessionBars,
    entryPrintEpoch,
    resolutionSeconds
  ).filter((bar) => !session || (bar.time >= session.openEpoch));
  const crossings = crossingEvidence(observable, threshold);
  let triggerTime = null;
  let crossNumber = null;
  let minutesAfter = null;
  if (crossings.firstCrossEpoch !== null) {
    triggerTime = crossings.firstCrossEpoch;
    crossNumber = Math.max(1, crossings.barsAbove);
    minutesAfter = Math.round((entryPrintEpoch - crossings.firstCrossEpoch) / 60);
  } else if (passed) {
    triggerTime = entryPrintEpoch;
    crossNumber = 1;
    minutesAfter = 0;
  }

  return {
    ...base,
    openingRangeHigh,
    effectiveTrigger,
    triggerValidFrom: range.completionEpoch,
    triggerTime,
    triggerCrossNumber: crossNumber,
    minutesAfterFirstTrigger: minutesAfter,
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    reason: passed
      ? `Opening execution ${entryPrintPrice} is above the effective trigger ${threshold} (max of confirmed Pivot ${confirmedPivot} and opening-range high ${openingRangeHigh}).`
      : `Opening execution ${entryPrintPrice} is not above the effective trigger ${threshold} (max of confirmed Pivot ${confirmedPivot} and opening-range high ${openingRangeHigh}).`,
    evidence: {
      trigger_type: triggerType,
      confirmed_pivot: confirmedPivot,
      opening_range_high: openingRangeHigh,
      opening_range_minutes: range.minutes,
      opening_range_start: isoOrNull(range.startEpoch),
      opening_range_complete: isoOrNull(range.completionEpoch),
      effective_trigger: effectiveTrigger,
      cross_threshold: threshold,
      minimum_penetration_pct: minPenPct,
      entry_print_price: entryPrintPrice,
      entry_print_time: isoOrNull(entryPrintEpoch),
      trigger_valid_from: isoOrNull(range.completionEpoch),
      trigger_time: isoOrNull(triggerTime),
      trigger_cross_number: crossNumber,
      trigger_cross_number_method: 'completed_1min_bars_above_threshold',
      minutes_after_first_trigger: minutesAfter,
      market_evidence_resolution: intraday.resolution || '1min'
    }
  };
}

// Regular-session filter for the entry session's bars. Bars outside 09:30-16:00
// ET never contaminate canonical Entry metrics.
function regularBarsFor(intraday, session) {
  const bars = intraday && Array.isArray(intraday.entrySessionBars) ? intraday.entrySessionBars : [];
  if (!session) return bars;
  return bars.filter((bar) => isFiniteNumber(bar.time) && bar.time >= session.openEpoch && bar.time < session.closeEpoch);
}

module.exports = {
  resolveTrigger,
  regularBarsFor
};
