'use strict';

// Partial Sizing criterion (docs/QUALITY_PROFILES_REQUIREMENT.md sections 37, 39).
//
// The target is a percentage of the ORIGINAL position; multiple fills may
// satisfy it. Sizing is measured from the quantity reduced AT THE PARTIAL EVENT
// (the first fill whose cumulative reduction crosses the target), never from
// later liquidation, so a later final exit cannot inflate or deflate it.
//
// The scoring value is the absolute deviation between the achieved partial
// percentage and the target percentage (as a fraction, e.g. 0.02 = 2 pp).
// Compliance uses the configured target/tolerance policy.

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult, notApplicableResult } = require('./common');

function evaluate({ managementState = {} }) {
  const initialR = managementState.initialR || {};
  const daily = managementState.daily || {};
  const policy = managementState.policy || {};
  const partialTrigger = managementState.partialTrigger || {};
  const partialCompletion = managementState.partialCompletion || {};
  const partialExit = managementState.partialExit || {};

  if (!initialR.available) {
    return unknownResult(
      'Initial R is unavailable, so the canonical partial trigger cannot be established; Partial Sizing is UNKNOWN.',
      { initial_r_available: false }
    );
  }
  if (!daily.authoritative) {
    return unknownResult('Verified daily session evidence is unavailable; Partial Sizing is UNKNOWN.', { daily_authoritative: false });
  }
  if (!policy.partialTarget) {
    return unknownResult(
      'No explicit partial target policy is configured for this profile version; Partial Sizing is UNKNOWN.',
      { policy_available: policy.available || null }
    );
  }

  if (partialExit.outcome === 'superseded_protective') {
    return notApplicableResult(
      'A proven protective-stop exit closed the position before the partial became due; Partial Sizing is NOT_APPLICABLE.',
      { reason: 'superseded_protective' }
    );
  }
  if (partialExit.outcome === 'superseded_discretionary') {
    return {
      status: CRITERION_STATUS.FAIL,
      scoring_value: 1,
      raw_value: 0,
      evidence: { reason: 'superseded_discretionary' },
      message: 'The position was fully closed before the partial became due without evidence of a protective stop.'
    };
  }
  if (partialExit.outcome === 'superseded_ambiguous') {
    return unknownResult(
      'The position was fully closed before the partial became due and TradeTally cannot classify the exit as protective; Partial Sizing is UNKNOWN.',
      { reason: 'superseded_ambiguous' }
    );
  }

  if (partialTrigger.status === 'never_reached') {
    return notApplicableResult(
      'Cumulative MFE never reached the configured minimum through the partial window; the partial rule is NOT_APPLICABLE.',
      { reason: partialTrigger.reason || 'never_reached_minimum_mfe' }
    );
  }
  if (partialTrigger.status !== 'triggered') {
    return unknownResult(
      partialTrigger.status === 'pending'
        ? 'The partial window has not yet fully elapsed (the trigger is pending); Partial Sizing is UNKNOWN.'
        : 'The point-in-time +1R trigger could not be established from trustworthy evidence; Partial Sizing is UNKNOWN.',
      { trigger_status: partialTrigger.status, reason: partialTrigger.reason || null }
    );
  }
  if (!managementState.fills || !managementState.fills.available) {
    return unknownResult('Execution fill evidence is unavailable, so the achieved partial cannot be established; Partial Sizing is UNKNOWN.', {});
  }
  if (partialCompletion.rounding && partialCompletion.rounding.resolved === false) {
    return unknownResult(
      'The required partial quantity could not be resolved without fabricating a tradable unit; Partial Sizing is UNKNOWN.',
      { rounding_reason: partialCompletion.rounding.reason || null }
    );
  }

  const targetPct = policy.partialTarget.target_pct;
  const tolerancePct = policy.partialTarget.target_tolerance_pct;
  if (typeof tolerancePct !== 'number' || !Number.isFinite(tolerancePct)) {
    return unknownResult(
      'The partial target tolerance cannot be established from the immutable profile version; Partial Sizing compliance is UNKNOWN.',
      { tolerance_source: policy.partialToleranceSource || null }
    );
  }

  const achievedPct = partialCompletion.achievedPct;
  if (typeof achievedPct !== 'number' || !Number.isFinite(achievedPct)) {
    return unknownResult('The achieved partial percentage could not be established; Partial Sizing is UNKNOWN.', {
      observed_fraction: partialCompletion.observedFraction ?? null
    });
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
      tolerance_source: policy.partialToleranceSource || null,
      achieved_pct: achievedPct,
      achieved_fraction: partialCompletion.achievedFraction,
      achieved_qty: partialCompletion.achievedQty,
      required_qty: partialCompletion.rounding ? partialCompletion.rounding.requiredQty : null,
      quantity_unit: partialCompletion.rounding ? partialCompletion.rounding.unit : null,
      deviation_pct: deviation,
      original_position_qty: managementState.originalPositionQty ?? null,
      observed_total_reduction_qty: partialCompletion.observedQty ?? null
    },
    message: passed
      ? `The partial reduced ${achievedPct}% of the original position at the partial event (within +/-${tolerancePct}pp of the ${targetPct}% target).`
      : `The partial reduced ${achievedPct}% of the original position at the partial event, outside the ${targetPct}% +/-${tolerancePct}pp target.`
  };
}

module.exports = { evaluate };
