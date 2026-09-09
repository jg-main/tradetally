'use strict';

// Range Contraction criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 17).
//
// Compare the total high-to-low span of the final recent base window with the
// immediately preceding comparison window, both fully inside the confirmed
// base (Confirmed Base Start -> D-1). Canonical defaults: recent_window=5,
// prior_window=10, maximum_ratio=0.70, require_full_windows=true.
//
//   Range(W) = max(High_W) - min(Low_W)
//   ContractionRatio = RecentRange / PriorRange
//
// Windows NEVER reach backward into the impulse to fill an incomplete window.
// Insufficient base sessions or an unusable denominator -> UNKNOWN.

const { CRITERION_STATUS } = require('../../constants');
const { requireNumberParameter, optionalBooleanParameter, unknownResult } = require('./common');
const { sliceBars } = require('../../dailyEvidence');

function rangeOf(bars) {
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (const bar of bars) {
    maxHigh = Math.max(maxHigh, bar.high);
    minLow = Math.min(minLow, bar.low);
  }
  return { high: maxHigh, low: minLow, range: maxHigh - minLow };
}

function evaluate({ key = 'range_contraction', criterion = {}, setup = {}, bars = [] }) {
  const parameters = criterion.parameters || {};
  const recentWindow = requireNumberParameter(parameters, 'recent_window', key);
  const priorWindow = requireNumberParameter(parameters, 'prior_window', key);
  const maximumRatio = requireNumberParameter(parameters, 'maximum_ratio', key);
  const requireFullWindows = optionalBooleanParameter(parameters, 'require_full_windows', true);

  const baseStart = setup.baseStart;
  const baseEnd = setup.baseEnd;
  if (!baseStart || !baseEnd) {
    return unknownResult(
      'Range Contraction requires an established setup boundary (confirmed Base Start and a resolution session).'
    );
  }

  const rangeStart = baseStart.index;
  const rangeEnd = baseEnd.index;
  const baseSessions = rangeEnd - rangeStart + 1;

  // Final recent window anchored at D-1, immediately preceded by the prior
  // window. The prior window must end before the recent window starts and both
  // must lie inside the base.
  const recentStart = rangeEnd - recentWindow + 1;
  const priorEnd = recentStart - 1;
  const priorStart = priorEnd - priorWindow + 1;

  const windowsFullyInside =
    rangeStart <= priorStart && priorEnd < recentStart && recentStart <= rangeEnd;

  const recentComplete =
    recentStart >= rangeStart && baseSessions >= recentWindow;
  const priorComplete = priorStart >= rangeStart && baseSessions >= priorWindow + recentWindow;

  if (requireFullWindows) {
    if (!recentComplete || !priorComplete || !windowsFullyInside) {
      return {
        status: CRITERION_STATUS.UNKNOWN,
        scoring_value: null,
        raw_value: null,
        evidence: {
          base_range: {
            startDate: bars[rangeStart].date,
            endDate: bars[rangeEnd].date,
            sessions: baseSessions
          },
          recent_window: { sessions: recentWindow },
          prior_window: { sessions: priorWindow },
          reason: `Base has ${baseSessions} session(s); full windows need ${recentWindow + priorWindow} sessions entirely inside the base. Windows never reach before Base Start.`
        },
        message: 'Insufficient base sessions for the configured full contraction windows.'
      };
    }
  } else if (recentStart < rangeStart || priorEnd < rangeStart) {
    return unknownResult(
      'Range Contraction windows would reach before the confirmed Base Start; evidence is insufficient.'
    );
  }

  const recentBars = sliceBars(bars, recentStart, rangeEnd);
  const priorBars = sliceBars(bars, priorStart, priorEnd);
  if (recentBars.length === 0 || priorBars.length === 0) {
    return unknownResult('Range Contraction windows are empty.');
  }

  const recentRange = rangeOf(recentBars);
  const priorRange = rangeOf(priorBars);
  if (!Number.isFinite(recentRange.range) || !Number.isFinite(priorRange.range)) {
    return unknownResult('Range Contraction encountered unusable high/low data.');
  }
  if (priorRange.range <= 0) {
    return unknownResult('Range Contraction prior window range is zero; the contraction ratio is undefined.');
  }

  const ratio = Math.round((recentRange.range / priorRange.range) * 10000) / 10000;
  const compliant = ratio <= maximumRatio;

  const evidence = {
    base_range: {
      startDate: bars[rangeStart].date,
      endDate: bars[rangeEnd].date,
      sessions: baseSessions
    },
    prior_window: {
      startDate: priorBars[0].date,
      endDate: priorBars[priorBars.length - 1].date,
      sessions: priorBars.length,
      high: priorRange.high,
      low: priorRange.low,
      range: priorRange.range
    },
    recent_window: {
      startDate: recentBars[0].date,
      endDate: recentBars[recentBars.length - 1].date,
      sessions: recentBars.length,
      high: recentRange.high,
      low: recentRange.low,
      range: recentRange.range
    },
    contraction_ratio: ratio,
    maximum_ratio: maximumRatio
  };

  return {
    status: compliant ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: ratio,
    raw_value: ratio,
    evidence,
    message: compliant
      ? `Recent ${recentWindow}-session range is ${ratio} of the prior ${priorWindow}-session range (<= ${maximumRatio}).`
      : `Recent ${recentWindow}-session range is ${ratio} of the prior ${priorWindow}-session range (> ${maximumRatio}).`
  };
}

module.exports = { evaluate };
