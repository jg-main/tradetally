'use strict';

// No Premature Reduction criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 40).
//
// Before the canonical partial trigger occurs, the position should remain at
// original size unless reduced by a legitimate protective stop. Premature
// reduction is evaluated independently of eventual partial compliance.
//
// Evidence discipline (hardening): a pre-trigger reduction is only excluded as
// protective when trustworthy evidence explicitly classifies it. TradeTally
// cannot distinguish a discretionary reduction from a protective-stop
// execution, so an unclassified pre-trigger reduction is UNKNOWN — never a
// fabricated FAIL. With no pre-trigger reduction the criterion may PASS.

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult } = require('./common');

function evaluate({ managementState = {} }) {
  const initialR = managementState.initialR || {};
  const daily = managementState.daily || {};
  const policy = managementState.policy || {};
  const premature = managementState.prematureReduction || {};

  if (!initialR.available) {
    return unknownResult(
      'Initial R is unavailable, so the partial trigger boundary cannot be established; premature reduction cannot be evaluated.',
      { initial_r_available: false }
    );
  }
  if (!daily.authoritative) {
    return unknownResult(
      'Verified daily session evidence is unavailable, so the partial trigger boundary cannot be established; premature reduction is UNKNOWN.',
      { daily_authoritative: false }
    );
  }
  if (!policy.partialTrigger) {
    return unknownResult(
      'No explicit partial-trigger policy is configured for this profile version; premature reduction is UNKNOWN.',
      { policy_available: policy.available || null }
    );
  }
  if (!managementState.fills || !managementState.fills.available) {
    return unknownResult('Execution fill evidence is unavailable, so reductions cannot be reconstructed; premature reduction is UNKNOWN.', {});
  }

  const evidence = {
    premature_reduction_qty: premature.prematureQty,
    premature_reduction_fraction: premature.prematureFraction,
    excluded_protective_qty: premature.excludedQty || 0,
    ambiguous_qty: premature.ambiguousQty || 0,
    before_boundary_qty: premature.beforeBoundaryQty || 0,
    unknown_ordering_qty: premature.unknownOrderingQty || 0,
    boundary_session_date: premature.boundarySessionDate || null,
    original_position_qty: managementState.originalPositionQty ?? null,
    stop_execution_evidence_available: !!premature.classificationAvailable,
    stop_execution_evidence_complete: !!premature.classificationComplete
  };

  if (premature.outcome === 'none') {
    return {
      status: CRITERION_STATUS.PASS,
      scoring_value: 0,
      raw_value: 0,
      evidence,
      message: 'No reduction occurred before the canonical partial trigger.'
    };
  }
  if (premature.outcome === 'discretionary') {
    return {
      status: CRITERION_STATUS.FAIL,
      scoring_value: premature.prematureFraction,
      raw_value: premature.prematureFraction,
      evidence,
      message: `${(premature.prematureFraction * 100).toFixed(1)}% of the original position was reduced before the canonical partial trigger.`
    };
  }
  return unknownResult(
    'A pre-trigger reduction exists but TradeTally cannot distinguish a discretionary reduction from a protective-stop execution; premature reduction is UNKNOWN.',
    evidence
  );
}

module.exports = { evaluate };
