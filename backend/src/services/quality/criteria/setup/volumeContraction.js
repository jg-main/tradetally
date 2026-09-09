'use strict';

// Volume Contraction criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 18).
//
// Compare average daily SHARE volume in the final recent base window with the
// immediately preceding comparison window. Both windows lie fully inside the
// confirmed base (Confirmed Base Start -> D-1); breakout-day volume is never
// included because the recent window ends at D-1.
//
// Canonical defaults: recent_window=5, prior_window=10, maximum_ratio=0.70.
//
//   VolumeRatio = mean(recent share volume) / mean(prior share volume)
//
// Arithmetic mean of actual historical share volumes. Volume is never
// winsorized and spikes are never removed. Missing/invalid volume in either
// window, insufficient base history, or a zero prior mean -> UNKNOWN.

const { CRITERION_STATUS } = require('../../constants');
const { requireNumberParameter, optionalBooleanParameter, unknownResult } = require('./common');
const { sliceBars } = require('../../dailyEvidence');

function meanVolume(bars) {
  let sum = 0;
  for (const bar of bars) {
    if (
      bar.volume === null ||
      bar.volume === undefined ||
      !Number.isFinite(bar.volume) ||
      bar.volume < 0
    ) {
      // Missing, non-finite or NEGATIVE volume can never be valid share-volume
      // evidence (a negative value would manufacture a negative ratio and a
      // false PASS).
      return null;
    }
    sum += bar.volume;
  }
  return sum / bars.length;
}

function evaluate({ key = 'volume_contraction', criterion = {}, setup = {}, bars = [] }) {
  const parameters = criterion.parameters || {};
  const recentWindow = requireNumberParameter(parameters, 'recent_window', key);
  const priorWindow = requireNumberParameter(parameters, 'prior_window', key);
  const maximumRatio = requireNumberParameter(parameters, 'maximum_ratio', key);
  const requireFullWindows = optionalBooleanParameter(parameters, 'require_full_windows', true);

  const baseStart = setup.baseStart;
  const baseEnd = setup.baseEnd;
  if (!baseStart || !baseEnd) {
    return unknownResult(
      'Volume Contraction requires an established setup boundary (confirmed Base Start and a resolution session).'
    );
  }

  const rangeStart = baseStart.index;
  const rangeEnd = baseEnd.index;
  const baseSessions = rangeEnd - rangeStart + 1;

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
        message: 'Insufficient base sessions for the configured full volume windows.'
      };
    }
  } else if (recentStart < rangeStart || priorEnd < rangeStart) {
    return unknownResult(
      'Volume Contraction windows would reach before the confirmed Base Start; evidence is insufficient.'
    );
  }

  const recentBars = sliceBars(bars, recentStart, rangeEnd);
  const priorBars = sliceBars(bars, priorStart, priorEnd);
  if (recentBars.length === 0 || priorBars.length === 0) {
    return unknownResult('Volume Contraction windows are empty.');
  }

  const recentMean = meanVolume(recentBars);
  const priorMean = meanVolume(priorBars);
  if (recentMean === null || priorMean === null) {
    return unknownResult('Volume Contraction encountered sessions without usable share volume.');
  }
  if (priorMean <= 0) {
    return unknownResult('Volume Contraction prior window mean volume is zero; the ratio is undefined.');
  }

  const ratio = Math.round((recentMean / priorMean) * 10000) / 10000;
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
      mean_share_volume: priorMean
    },
    recent_window: {
      startDate: recentBars[0].date,
      endDate: recentBars[recentBars.length - 1].date,
      sessions: recentBars.length,
      mean_share_volume: recentMean
    },
    volume_ratio: ratio,
    maximum_ratio: maximumRatio,
    volume_basis: 'share volume arithmetic mean (not winsorized; spikes retained)'
  };

  return {
    status: compliant ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: ratio,
    raw_value: ratio,
    evidence,
    message: compliant
      ? `Recent ${recentWindow}-session mean share volume is ${ratio} of the prior ${priorWindow}-session mean (<= ${maximumRatio}).`
      : `Recent ${recentWindow}-session mean share volume is ${ratio} of the prior ${priorWindow}-session mean (> ${maximumRatio}).`
  };
}

module.exports = { evaluate };
