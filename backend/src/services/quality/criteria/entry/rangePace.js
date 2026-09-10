'use strict';

// Range Pace at Entry criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 27).
//
//   TodayRangeAtEntry = highest observable regular-session price from open
//                       through the entry cutoff minus the lowest, using only
//                       completed bars plus observed opening execution prints.
//   RangePace = TodayRangeAtEntry / expected historical range at the SAME
//               elapsed time (arithmetic mean over the configured reference
//               sessions).
//
// Completed breakout-day high/low and any after-cutoff movement are never used.
// Missing/insufficient intraday evidence -> UNKNOWN.
//
// This criterion is not required for canonical Entry compliance and defines no
// canonical compliance threshold; when the evidence is available it is PASS
// (evaluated, no violation) and carries its profile-derived quality score.

const { CRITERION_STATUS } = require('../../constants');
const { requireNumberParameter } = require('./common');

function evaluate({ key = 'range_pace', criterion = {}, intradayMetrics = {} }) {
  const parameters = criterion.parameters || {};
  const referenceSessions = requireNumberParameter(parameters, 'reference_sessions', key);
  const metric = intradayMetrics.rangePace;

  if (!metric || !metric.available) {
    return {
      status: CRITERION_STATUS.UNKNOWN,
      scoring_value: null,
      raw_value: null,
      evidence: {
        reference_sessions: referenceSessions,
        reason: metric ? metric.reason : 'Range-pace evidence was not prepared.',
        usable_sessions: metric ? metric.usableSessions : 0
      },
      message: metric && metric.reason
        ? metric.reason
        : 'Range pace at entry could not be established from available intraday evidence.'
    };
  }

  const pace = metric.pace;
  return {
    status: CRITERION_STATUS.PASS,
    scoring_value: pace,
    raw_value: pace,
    evidence: {
      range_at_entry: metric.today,
      expected_historical_range: metric.expected,
      range_pace: pace,
      reference_sessions: referenceSessions,
      usable_sessions: metric.usableSessions,
      reference_values: metric.referenceCutoffs,
      entry_elapsed_seconds: metric.elapsedSeconds,
      cutoff_epoch: metric.cutoffEpoch,
      resolution: metric.resolution,
      range_at_entry_over_adr: intradayMetrics.rangeAtEntryOverAdr ?? null
    },
    message: `Range pace at entry is ${pace.toFixed(2)}x the same-time historical reference.`
  };
}

module.exports = { evaluate };
