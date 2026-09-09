'use strict';

// Base Duration criterion (docs/QUALITY_PROFILES_REQUIREMENT.md sections 15.3
// and 15.5).
//
// Base Duration = trading sessions from the confirmed Base Start through D-1
// inclusive, where D is the breakout-resolution session and D-1 is Base End.
//
// Canonical 10-40 sessions PASS, outside the configured range FAIL. Scoring is
// the profile's binary scoring envelope. The Base Start is NEVER altered to
// force a pass (a 47-session base stays 47 sessions and fails).

const { CRITERION_STATUS } = require('../../constants');
const { requireNumberParameter, unknownResult } = require('./common');

function evaluate({ key = 'base_duration', criterion = {}, setup = {} }) {
  const parameters = criterion.parameters || {};
  const minimumSessions = requireNumberParameter(parameters, 'minimum_sessions', key);
  const maximumSessions = requireNumberParameter(parameters, 'maximum_sessions', key);

  const baseStart = setup.baseStart;
  const baseEnd = setup.baseEnd;

  if (!baseStart || !baseEnd) {
    return unknownResult(
      'Base Duration requires an established setup boundary (confirmed Base Start and a resolution session).'
    );
  }

  const durationSessions = baseEnd.index - baseStart.index + 1;
  const inRange = durationSessions >= minimumSessions && durationSessions <= maximumSessions;

  const evidence = {
    base_start_date: baseStart.date,
    base_start_source: baseStart.source || null,
    base_end_date: baseEnd.date,
    resolution_date: setup.resolution ? setup.resolution.date : null,
    base_duration_sessions: durationSessions,
    minimum_sessions: minimumSessions,
    maximum_sessions: maximumSessions
  };

  return {
    status: inRange ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: null,
    raw_value: durationSessions,
    evidence,
    message: inRange
      ? `Base duration of ${durationSessions} sessions is within ${minimumSessions}-${maximumSessions}.`
      : `Base duration of ${durationSessions} sessions is outside the configured ${minimumSessions}-${maximumSessions} range.`
  };
}

module.exports = { evaluate };
