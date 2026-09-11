'use strict';

// No Premature Reduction criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 40).
//
// Before the canonical partial trigger occurs, the position should remain at
// original size unless reduced by a legitimate protective stop. Any
// discretionary reduction before the trigger is a failure.
//
// Premature reduction is evaluated independently of eventual partial
// compliance. Without trustworthy stop-execution evidence, a pre-trigger
// reduction cannot be proven protective, so it is counted as premature (the
// evaluator documents this limitation; a protective-stop execution hook exists
// upstream so tests can prove legitimate protective reductions are excluded).

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult } = require('./common');

function evaluate({ criterion = {}, managementState = {} }) {
  const initialR = managementState.initialR || {};
  const daily = managementState.daily || {};
  const premature = managementState.prematureReduction || {};

  if (!initialR.available) {
    return unknownResult(
      'Initial R is unavailable, so the canonical partial trigger cannot be established; premature reduction cannot be evaluated.',
      { initial_r_available: false }
    );
  }
  if (!daily.authoritative) {
    return unknownResult(
      'Verified daily session evidence is unavailable, so the partial trigger boundary cannot be established; premature reduction is UNKNOWN.',
      { daily_authoritative: false }
    );
  }
  if (!managementState.fills || !managementState.fills.available) {
    return unknownResult(
      'Execution fill evidence is unavailable, so reductions cannot be reconstructed; premature reduction is UNKNOWN.',
      {}
    );
  }

  const fraction = premature.prematureFraction ?? null;
  if (fraction === null) {
    return unknownResult('The premature-reduction fraction could not be established.', {});
  }

  const passed = fraction <= 1e-9;

  return {
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: fraction,
    raw_value: fraction,
    evidence: {
      premature_reduction_qty: premature.prematureQty,
      premature_reduction_fraction: fraction,
      excluded_protective_qty: premature.excludedQty || 0,
      boundary_session_date: premature.boundarySessionDate || null,
      original_position_qty: managementState.originalPositionQty ?? null,
      stop_execution_evidence_available: !!premature.protectiveStopEvidenceAvailable
    },
    message: passed
      ? 'No discretionary reduction occurred before the canonical partial trigger.'
      : `${(fraction * 100).toFixed(1)}% of the original position was reduced before the canonical partial trigger.`
  };
}

module.exports = { evaluate };
