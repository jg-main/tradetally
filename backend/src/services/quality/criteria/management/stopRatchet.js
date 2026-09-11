'use strict';

// Stop Ratchet / Never Lower criterion
// (docs/QUALITY_PROFILES_REQUIREMENT.md section 41).
//
// For a long trade the protective stop must never be lowered. When trustworthy
// complete stop-order history is unavailable the result is UNKNOWN (never
// fabricated PASS/FAIL); it must never be inferred from the current/final
// trade.stop_loss. A positive downward tolerance requires a trustworthy
// instrument tick size; without one the criterion is UNKNOWN rather than using
// a fabricated default tick.

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult } = require('./common');
const { evaluateStopRatchet } = require('../../management/stopHistory');

function evaluate({ criterion = {}, managementState = {} }) {
  const stopHistory = managementState.stopHistory || {};
  if (!stopHistory.available) {
    return unknownResult(
      stopHistory.reason || 'Trustworthy complete stop-order history is unavailable; Stop Ratchet is UNKNOWN.',
      { stop_history_available: false, provenance: stopHistory.provenance || null }
    );
  }

  const tick = managementState.tickSize || { known: false, tickSize: null };
  const toleranceTicks = criterion.parameters && Number.isInteger(criterion.parameters.downward_tolerance_ticks)
    ? criterion.parameters.downward_tolerance_ticks
    : 0;

  const result = evaluateStopRatchet({
    modifications: stopHistory.modifications || [],
    tickSize: tick.tickSize,
    tickKnown: tick.known === true,
    downwardToleranceTicks: toleranceTicks
  });

  if (!result.resolved) {
    return unknownResult(result.reason || 'Stop Ratchet could not be resolved.', {
      tick_known: false,
      downward_tolerance_ticks: toleranceTicks
    });
  }

  return {
    status: result.valid ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: null,
    raw_value: result.violations.length,
    evidence: {
      modifications: (stopHistory.modifications || []).map((m) => ({ epoch: m.epoch, price: m.price })),
      source: stopHistory.source,
      provenance: stopHistory.provenance || null,
      tick_size: tick.known ? tick.tickSize : null,
      tick_source: tick.source || null,
      downward_tolerance_ticks: toleranceTicks,
      violations: result.violations
    },
    message: result.valid
      ? 'The protective stop was never lowered (each logical modification was non-decreasing).'
      : `The protective stop was lowered ${result.violations.length} time(s), violating the no-lowering rule.`
  };
}

module.exports = { evaluate };
