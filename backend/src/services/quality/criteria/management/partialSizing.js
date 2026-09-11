'use strict';

// Partial Sizing criterion (docs/QUALITY_PROFILES_REQUIREMENT.md sections 37, 39).
//
// The target is 50% of the ORIGINAL position; multiple fills may satisfy it.
// The scoring value is the absolute deviation between the achieved partial
// percentage and the target percentage (as a fraction, e.g. 0.02 = 2 pp).
// Compliance uses the configured target/tolerance policy.

const { CRITERION_STATUS } = require('../../constants');
const { requireNumberParameter, unknownResult, notApplicableResult } = require('./common');

function evaluate({ criterion = {}, managementState = {} }) {
  const initialR = managementState.initialR || {};
  const daily = managementState.daily || {};
  const partialTrigger = managementState.partialTrigger || {};
  const partialCompletion = managementState.partialCompletion || {};

  if (!initialR.available) {
    return unknownResult(
      'Initial R is unavailable, so the canonical partial trigger cannot be established; Partial Sizing is UNKNOWN.',
      { initial_r_available: false }
    );
  }
  if (!daily.authoritative) {
    return unknownResult(
      'Verified daily session evidence is unavailable; Partial Sizing is UNKNOWN.',
      { daily_authoritative: false }
    );
  }
  if (!partialTrigger.triggered || partialTrigger.supersededByExit) {
    return notApplicableResult(
      partialTrigger.supersededByExit
        ? 'The position was fully closed before the partial became due; the partial rule is NOT_APPLICABLE.'
        : 'Cumulative MFE never reached the configured minimum through the partial window; the partial rule is NOT_APPLICABLE.',
      { reason: partialTrigger.supersededByExit ? 'superseded_by_exit' : partialTrigger.reason || 'never_reached_minimum_mfe' }
    );
  }
  if (!managementState.fills || !managementState.fills.available) {
    return unknownResult(
      'Execution fill evidence is unavailable, so the achieved partial cannot be established; Partial Sizing is UNKNOWN.',
      { partial_trigger_due_session: partialTrigger.dueSessionDate || null }
    );
  }

  const targetPct = requireNumberParameter(criterion.parameters, 'target_pct', 'partial_sizing');
  const tolerancePct = requireNumberParameter(
    criterion.parameters,
    'target_tolerance_pct',
    'partial_sizing'
  );
  const achievedPct = partialCompletion.achievedPct ?? null;
  if (achievedPct === null) {
    return unknownResult(
      'The achieved partial percentage could not be established; Partial Sizing is UNKNOWN.',
      { achieved_fraction: partialCompletion.achievedFraction ?? null }
    );
  }

  const deviation = Math.abs(achievedPct - targetPct);
  const passed = deviation <= tolerancePct + 1e-9;

  return {
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: deviation / 100,
    raw_value: achievedPct,
    evidence: {
      target_pct: targetPct,
      target_tolerance_pct: tolerancePct,
      achieved_pct: achievedPct,
      achieved_fraction: partialCompletion.achievedFraction,
      deviation_pct: deviation,
      original_position_qty: managementState.originalPositionQty ?? null,
      total_reduction_qty: managementState.fills.totalReductionQty ?? null
    },
    message: passed
      ? `The partial reduced ${achievedPct}% of the original position (within +/-${tolerancePct}pp of the ${targetPct}% target).`
      : `The partial reduced ${achievedPct}% of the original position, outside the ${targetPct}% +/-${tolerancePct}pp target.`
  };
}

module.exports = { evaluate };
