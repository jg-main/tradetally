'use strict';

// Volume Pace at Entry criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 26).
//
//   VolumePace = cumulative regular-session volume observable at the actual
//                entry cutoff / expected historical volume at the same elapsed
//                time (arithmetic mean over the configured reference sessions).
//
// Completed full-day volume is NEVER substituted. Any volume printed after the
// entry cutoff is excluded. Missing/insufficient intraday evidence -> UNKNOWN.
//
// This criterion is not required for canonical Entry compliance; its status
// reflects the configured target multiple when one is provided.

const { CRITERION_STATUS } = require('../../constants');
const { requireNumberParameter, unknownResult } = require('./common');

function evaluate({ key = 'volume_pace', criterion = {}, intradayMetrics = {} }) {
  const parameters = criterion.parameters || {};
  const referenceSessions = requireNumberParameter(parameters, 'reference_sessions', key);
  const targetMultiple = requireNumberParameter(parameters, 'target_multiple', key);
  const metric = intradayMetrics.volumePace;

  if (!metric || !metric.available) {
    return {
      status: CRITERION_STATUS.UNKNOWN,
      scoring_value: null,
      raw_value: null,
      evidence: {
        reference_sessions: referenceSessions,
        target_multiple: targetMultiple,
        reason: metric ? metric.reason : 'Volume-pace evidence was not prepared.',
        usable_sessions: metric ? metric.usableSessions : 0
      },
      message: metric && metric.reason
        ? metric.reason
        : 'Volume pace at entry could not be established from available intraday evidence.'
    };
  }

  const pace = metric.pace;
  const passed = pace >= targetMultiple;
  return {
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: pace,
    raw_value: pace,
    evidence: {
      entry_cumulative_volume: metric.today,
      expected_historical_volume: metric.expected,
      volume_pace: pace,
      target_multiple: targetMultiple,
      reference_sessions: referenceSessions,
      usable_sessions: metric.usableSessions,
      reference_values: metric.referenceCutoffs,
      entry_elapsed_seconds: metric.elapsedSeconds,
      cutoff_epoch: metric.cutoffEpoch,
      resolution: metric.resolution
    },
    message: `Volume pace at entry is ${pace.toFixed(2)}x the same-time historical reference (target >= ${targetMultiple}x).`
  };
}

module.exports = { evaluate };
