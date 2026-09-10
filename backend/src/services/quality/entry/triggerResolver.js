'use strict';

// Entry trigger resolution (docs/QUALITY_PROFILES_REQUIREMENT.md section 24;
// Phase 3 hardening findings 2 and 9).
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
// SESSION COHERENCE: the trigger forms in the PERSISTED Phase-2 breakout
// session. ORH opening-range evidence and trigger-cross evidence therefore use
// the BREAKOUT-session bars (passed separately), never the actual-entry-session
// bars. The actual entry session is used only for entry-time pace/LOD by the
// orchestrator.
//
// FIRST PRINT: Trigger Compliance is decided by the ACTUAL first opening
// execution print (initialEntryFillPrice at initialEntryFillEpoch), never by
// the blended Entry Basis (which legitimately includes later pre-reduction
// scale-ins). When the first-print semantics cannot be established (no
// fill-level evidence, or an ambiguous tie at the earliest timestamp), the
// result is UNKNOWN — TradeTally does not claim a first print it cannot prove.
//
// PRECISION: 1-minute OHLC bars can prove THAT a crossing occurred inside an
// interval, but not an exact tick timestamp. `trigger_cross_number` is exposed
// only when the evidence can establish it (an execution print); otherwise
// `bars_above_threshold` is retained and trigger_time uses an explicit
// `1min_interval` precision. A sustained run of bars above the threshold is
// never counted as N crossings.

const { CRITERION_STATUS } = require('../constants');
const {
  openingRangeBounds,
  regularSessionBounds,
  observableBars,
  barFullyObservable
} = require('./sessionTime');
const {
  missingIntervalStarts: missingIntervals,
  intervalAlignment
} = require('../intradayEvidenceService');

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isoOrNull(epochSeconds) {
  return Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : null;
}

function crossingEvidence(bars, threshold) {
  let barsAbove = 0;
  let firstCrossBar = null;
  for (const bar of bars) {
    if (isFiniteNumber(bar.high) && bar.high > threshold) {
      barsAbove += 1;
      if (firstCrossBar === null) firstCrossBar = bar;
    }
  }
  return { barsAbove, firstCrossBar };
}

/**
 * @param {object} params
 * @param {string} params.triggerType
 * @param {object} params.parameters - trigger_compliance criterion parameters.
 * @param {object} params.setupContext - { confirmedPivot, breakoutSession }.
 * @param {object} params.executionEvidence - normalized execution evidence.
 * @param {object|null} params.intraday - {
 *   breakoutSessionBars, entrySessionBars, resolution, resolutionSeconds,
 *   breakoutSession, available }.
 */
function resolveTrigger({
  triggerType,
  parameters = {},
  setupContext = {},
  executionEvidence = {},
  intraday = null
}) {
  const confirmedPivot = setupContext.confirmedPivot;
  const breakoutSession = setupContext.breakoutSession;
  const allowedTypes = Array.isArray(parameters.allowed_types) ? parameters.allowed_types : [];
  const minPenPct = isFiniteNumber(parameters.minimum_penetration_pct) ? parameters.minimum_penetration_pct : 0;
  const requirePivotResolution = parameters.require_pivot_resolution === true;

  const firstPrintPrice = executionEvidence.initialEntryFillPrice;
  const firstPrintEpoch = executionEvidence.initialEntryFillEpoch;

  const base = {
    triggerType,
    confirmedPivot: confirmedPivot ?? null,
    openingRangeHigh: null,
    effectiveTrigger: null,
    triggerValidFrom: null,
    triggerTime: null,
    triggerTimePrecision: null,
    entryPrintPrice: firstPrintPrice ?? null,
    entryPrintTime: isoOrNull(firstPrintEpoch),
    triggerCrossNumber: null,
    barsAboveThreshold: null,
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
  if (!isFiniteNumber(firstPrintPrice) || firstPrintPrice <= 0 || !Number.isFinite(firstPrintEpoch)) {
    return {
      ...base,
      status: CRITERION_STATUS.UNKNOWN,
      reason: 'Actual opening execution evidence is unavailable; trigger compliance cannot be established.'
    };
  }
  if (!executionEvidence.initialEntryFillTrustworthy || executionEvidence.ambiguousFirstFill) {
    return {
      ...base,
      status: CRITERION_STATUS.UNKNOWN,
      reason:
        'The FIRST opening execution print cannot be established from the stored evidence (no fill-level data or an ambiguous earliest timestamp); trigger compliance is UNKNOWN rather than using a blended entry price.',
      evidence: {
        trigger_type: triggerType,
        initial_entry_fill_trustworthy: false,
        ambiguous_first_fill: executionEvidence.ambiguousFirstFill === true
      }
    };
  }

  const penetration = minPenPct / 100;
  const session = breakoutSession ? regularSessionBounds(breakoutSession) : null;

  if (triggerType === 'BO-PIVOT') {
    const effectiveTrigger = confirmedPivot;
    const threshold = effectiveTrigger * (1 + penetration);
    if (requirePivotResolution && session && firstPrintEpoch < session.openEpoch) {
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
          entry_print_price: firstPrintPrice,
          entry_print_time: isoOrNull(firstPrintEpoch),
          trigger_valid_from: isoOrNull(session.openEpoch),
          require_pivot_resolution: true,
          entry_before_pivot_resolution: true
        }
      };
    }
    const passed = firstPrintPrice > threshold;
    const crossing = pivotCrossingEvidence(intraday, session, firstPrintEpoch, threshold, firstPrintPrice);
    return {
      ...base,
      effectiveTrigger,
      triggerValidFrom: session ? session.openEpoch : null,
      triggerTime: crossing.triggerTime,
      triggerTimePrecision: crossing.triggerTimePrecision,
      triggerCrossNumber: crossing.triggerCrossNumber,
      barsAboveThreshold: crossing.barsAboveThreshold,
      minutesAfterFirstTrigger: crossing.minutesAfterFirstTrigger,
      status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
      reason: passed
        ? `Opening execution print ${firstPrintPrice} is above the confirmed Pivot threshold ${threshold}.`
        : `Opening execution print ${firstPrintPrice} is not above the confirmed Pivot threshold ${threshold}.`,
      evidence: {
        trigger_type: 'BO-PIVOT',
        confirmed_pivot: confirmedPivot,
        effective_trigger: effectiveTrigger,
        cross_threshold: threshold,
        minimum_penetration_pct: minPenPct,
        require_pivot_resolution: requirePivotResolution,
        entry_print_price: firstPrintPrice,
        entry_print_time: isoOrNull(firstPrintEpoch),
        trigger_valid_from: isoOrNull(session ? session.openEpoch : null),
        trigger_time: crossing.triggerTime,
        trigger_time_precision: crossing.triggerTimePrecision,
        first_cross_bar_open: crossing.firstCrossBarOpen,
        first_cross_bar_close: crossing.firstCrossBarClose,
        trigger_cross_number: crossing.triggerCrossNumber,
        bars_above_threshold: crossing.barsAboveThreshold,
        trigger_cross_number_method: crossing.method,
        minutes_after_first_trigger: crossing.minutesAfterFirstTrigger,
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

  if (firstPrintEpoch < range.completionEpoch) {
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
        entry_print_time: isoOrNull(firstPrintEpoch),
        entry_before_opening_range_complete: true
      }
    };
  }

  const breakoutBars = breakoutIntradayBars(intraday, breakoutSession);
  if (!breakoutBars || breakoutBars.length === 0) {
    return {
      ...base,
      triggerValidFrom: range.completionEpoch,
      status: CRITERION_STATUS.UNKNOWN,
      reason: 'Breakout-session opening-range intraday evidence is unavailable; the ORH effective trigger cannot be established.'
    };
  }

  const resolutionSeconds = intraday.resolutionSeconds || 60;
  // The opening range is only knowable when every expected interval is present.
  const rangeMissing = missingIntervals(breakoutBars, range.startEpoch, range.completionEpoch, resolutionSeconds);
  const rangeAlignment = intervalAlignment(range.completionEpoch, range.startEpoch, resolutionSeconds);
  if (!rangeAlignment.aligned || rangeMissing.length > 0) {
    return {
      ...base,
      triggerValidFrom: range.completionEpoch,
      status: CRITERION_STATUS.UNKNOWN,
      reason: `Breakout-session opening-range evidence is incomplete (${rangeMissing.length} missing interval(s)); the ORH effective trigger is UNKNOWN.`
    };
  }
  const rangeBars = breakoutBars.filter(
    (bar) =>
      isFiniteNumber(bar.time) &&
      bar.time >= range.startEpoch &&
      barFullyObservable(bar.time, range.completionEpoch, resolutionSeconds)
  );
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
  const passed = firstPrintPrice > threshold;
  const crossing = orhCrossingEvidence(breakoutBars, session, firstPrintEpoch, threshold, resolutionSeconds, firstPrintPrice);

  return {
    ...base,
    openingRangeHigh,
    effectiveTrigger,
    triggerValidFrom: range.completionEpoch,
    triggerTime: crossing.triggerTime,
    triggerTimePrecision: crossing.triggerTimePrecision,
    triggerCrossNumber: crossing.triggerCrossNumber,
    barsAboveThreshold: crossing.barsAboveThreshold,
    minutesAfterFirstTrigger: crossing.minutesAfterFirstTrigger,
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    reason: passed
      ? `Opening execution print ${firstPrintPrice} is above the effective trigger ${threshold} (max of confirmed Pivot ${confirmedPivot} and opening-range high ${openingRangeHigh}).`
      : `Opening execution print ${firstPrintPrice} is not above the effective trigger ${threshold} (max of confirmed Pivot ${confirmedPivot} and opening-range high ${openingRangeHigh}).`,
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
      entry_print_price: firstPrintPrice,
      entry_print_time: isoOrNull(firstPrintEpoch),
      trigger_valid_from: isoOrNull(range.completionEpoch),
      trigger_time: crossing.triggerTime,
      trigger_time_precision: crossing.triggerTimePrecision,
      first_cross_bar_open: crossing.firstCrossBarOpen,
      first_cross_bar_close: crossing.firstCrossBarClose,
      trigger_cross_number: crossing.triggerCrossNumber,
      bars_above_threshold: crossing.barsAboveThreshold,
      trigger_cross_number_method: crossing.method,
      minutes_after_first_trigger: crossing.minutesAfterFirstTrigger,
      market_evidence_resolution: intraday.resolution || '1min'
    }
  };
}

function breakoutIntradayBars(intraday, breakoutSession) {
  if (!intraday) return null;
  if (intraday.breakoutSession && breakoutSession && intraday.breakoutSession === breakoutSession) {
    return Array.isArray(intraday.breakoutSessionBars) ? intraday.breakoutSessionBars : null;
  }
  return Array.isArray(intraday.breakoutSessionBars) ? intraday.breakoutSessionBars : null;
}

// Crossing evidence for BO-PIVOT. A crossing is only "established" as a number
// when an actual execution print is the first observed crossing; otherwise the
// bar evidence is retained with 1min precision and no fabricated cross count.
function pivotCrossingEvidence(intraday, session, firstPrintEpoch, threshold, firstPrint) {
  const bars = breakoutIntradayBars(intraday, session ? session.date : null) || [];
  const resolutionSeconds = intraday ? intraday.resolutionSeconds || 60 : 60;
  const observable = observableBars(bars, firstPrintEpoch, resolutionSeconds).filter(
    (bar) => !session || (bar.time >= session.openEpoch && bar.time < session.closeEpoch)
  );
  const crossing = crossingEvidence(observable, threshold);
  return finalizeCrossing(crossing, firstPrintEpoch, firstPrint > threshold);
}

function orhCrossingEvidence(breakoutBars, session, firstPrintEpoch, threshold, resolutionSeconds, firstPrint) {
  const observable = observableBars(breakoutBars, firstPrintEpoch, resolutionSeconds).filter(
    (bar) => !session || (bar.time >= session.openEpoch && bar.time < session.closeEpoch)
  );
  const crossing = crossingEvidence(observable, threshold);
  return finalizeCrossing(crossing, firstPrintEpoch, firstPrint > threshold);
}

function finalizeCrossing(crossing, entryPrintEpoch, passed) {
  const firstCrossBar = crossing.firstCrossBar;
  if (firstCrossBar) {
    return {
      barsAboveThreshold: crossing.barsAbove,
      triggerCrossNumber: null,
      triggerTime: null,
      triggerTimePrecision: '1min_interval',
      firstCrossBarOpen: firstCrossBar.time,
      firstCrossBarClose: firstCrossBar.time + 60,
      minutesAfterFirstTrigger: null,
      method: '1min_ohlc_interval_approximation'
    };
  }
  if (passed) {
    // The execution print itself is the first observed above-threshold trade:
    // this is an exact execution timestamp (not a fabricated market crossing).
    return {
      barsAboveThreshold: 0,
      triggerCrossNumber: 1,
      triggerTime: entryPrintEpoch,
      triggerTimePrecision: 'execution_timestamp',
      firstCrossBarOpen: null,
      firstCrossBarClose: null,
      minutesAfterFirstTrigger: 0,
      method: 'execution_print'
    };
  }
  return {
    barsAboveThreshold: 0,
    triggerCrossNumber: null,
    triggerTime: null,
    triggerTimePrecision: null,
    firstCrossBarOpen: null,
    firstCrossBarClose: null,
    minutesAfterFirstTrigger: null,
    method: null
  };
}

module.exports = {
  resolveTrigger
};
