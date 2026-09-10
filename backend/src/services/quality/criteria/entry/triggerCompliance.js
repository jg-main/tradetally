'use strict';

// Trigger Compliance criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 24).
//
// Binary compliance: the actual opening execution must be strictly above the
// resolved effective trigger threshold for the intended trigger type. The
// trigger resolution (direct Pivot / ORH opening range, penetration, ORH
// completion validity) is performed by entry/triggerResolver.js using this
// criterion's immutable parameters. Missing intraday evidence yields UNKNOWN,
// never FAIL.
//
// Second-break entries are retained as evidence (trigger_cross_number) and are
// not automatically failed.

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult } = require('./common');

function evaluate({ key = 'trigger_compliance', triggerResolution = null, entryEvidence = {} }) {
  if (entryEvidence.direction && entryEvidence.direction !== 'long') {
    return unknownResult(
      'Canonical Entry trigger semantics are defined for long breakouts; a short entry cannot be graded by this profile.'
    );
  }
  if (!triggerResolution) {
    return unknownResult('Trigger compliance could not be resolved for the intended trigger type.');
  }
  const status = triggerResolution.status;
  const evidence = {
    ...(triggerResolution.evidence || {}),
    reason: triggerResolution.reason || null
  };
  return {
    status,
    scoring_value: null,
    raw_value: triggerResolution.effectiveTrigger ?? null,
    evidence,
    message: triggerResolution.reason || `Trigger compliance: ${status}.`
  };
}

module.exports = { evaluate };
