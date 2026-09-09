'use strict';

// Leader criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 13).
//
// Canonical source is a USER ASSERTION: "Is this stock a leader? Yes/No".
// TradeTally never fabricates a cross-sectional RS percentile, a fake RS
// ranking, or an absolute-return proxy labeled "leadership".
//
//   Yes -> PASS (binary score from the profile = 100)
//   No  -> FAIL (binary score from the profile = 0)
//
// Provenance is `user_asserted`; the actual semantic value arrives through
// userInputs.leader_confirmed (boolean).

const { CRITERION_STATUS } = require('../../constants');

function evaluate({ key = 'leader', userInputs = {} }) {
  const value = userInputs.leader_confirmed;

  if (value === true) {
    return {
      status: CRITERION_STATUS.PASS,
      scoring_value: null,
      raw_value: 'yes',
      evidence: {
        leader_confirmed: true,
        source: 'user_asserted'
      },
      message: 'Stock was confirmed as a leading stock by the user.'
    };
  }
  if (value === false) {
    return {
      status: CRITERION_STATUS.FAIL,
      scoring_value: null,
      raw_value: 'no',
      evidence: {
        leader_confirmed: false,
        source: 'user_asserted'
      },
      message: 'Stock was not confirmed as a leading stock.'
    };
  }

  return {
    status: CRITERION_STATUS.UNKNOWN,
    scoring_value: null,
    raw_value: null,
    evidence: {
      leader_confirmed: null,
      source: 'user_asserted'
    },
    message: 'Leader confirmation is required but was not provided.'
  };
}

module.exports = { evaluate };
