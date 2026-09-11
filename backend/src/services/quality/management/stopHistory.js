'use strict';

// Stop-history capability audit and evidence resolution for Management Quality
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 41, 42, 60).
//
// TradeTally capability audit conclusion:
//   - there is NO stop-order lifecycle table;
//   - `trades.stop_loss` is a single MUTABLE trade-level column (a
//     planned/default/current value, never the first actual protective stop);
//   - `trades.risk_level_history` is a JSONB array of CHANGE entries written
//     ONLY by the trade-management UI update path when the user edits stop_loss
//     (`{ timestamp, type, old_value, new_value, ... }`). It is NOT written by
//     CSV imports or broker sync, has no stop-creation/cancellation/replacement
//     events, and cannot establish a first stop or the effective protective
//     floor across concurrent orders.
//
// A planned/default/current stop plus a partial UI-only change log is therefore
// NOT trustworthy complete stop-order lifecycle evidence. Per sections 41.4,
// 42 and 60, Stop Ratchet and Post-Partial Breakeven are UNKNOWN when complete
// history is unavailable; they must NEVER be inferred from the current/final
// stop_loss or from a reasonable final exit.
//
// The same evidence discipline is applied to protective-stop CLASSIFICATION:
// a reduction is only treated as a protective-stop execution when trustworthy
// evidence explicitly classifies it. No TradeTally source does, so production
// classification is unavailable and the affected criteria return UNKNOWN rather
// than a fabricated PASS/FAIL.
//
// Optional hooks (`trustedStopHistory`, `trustedStopExecutionClassification`)
// exist so the evaluator contract is honest and testable, not to enable
// fabrication.

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

const AUDIT_REASON =
  'TradeTally has no stop-order lifecycle. trades.stop_loss is a single mutable ' +
  'planned/default/current value and risk_level_history records only UI-initiated ' +
  'changes (no establishment, cancellation, replacement, or effective-quantity ' +
  'per stop); a trustworthy complete stop-modification sequence cannot be established.';

const CLASSIFICATION_REASON =
  'TradeTally does not persist an order type per fill, so it cannot distinguish a ' +
  'discretionary reduction from a protective-stop execution. Reductions are neither ' +
  'confirmed protective nor confirmed discretionary.';

function resolveStopHistory({ trustedStopHistory = null } = {}) {
  if (trustedStopHistory && Array.isArray(trustedStopHistory.modifications)) {
    const modifications = trustedStopHistory.modifications
      .map((entry) => ({
        epoch: Number.isFinite(entry.epoch) ? entry.epoch : null,
        price: asNumber(entry.price)
      }))
      .filter((entry) => entry.price !== null && entry.price > 0)
      .sort((a, b) => (a.epoch ?? 0) - (b.epoch ?? 0));
    return {
      available: true,
      modifications,
      source: trustedStopHistory.source || 'trusted_stop_history',
      provenance: trustedStopHistory.provenance || null,
      reason: null
    };
  }

  return {
    available: false,
    modifications: [],
    source: null,
    provenance: { source: null, limitations: [AUDIT_REASON] },
    reason: AUDIT_REASON
  };
}

/**
 * Resolves a trustworthy protective-stop classification for closing fills.
 * Production has no such source, so this returns `available:false` unless a
 * hook is supplied.
 *
 * @returns {{available:boolean, complete:boolean, byEpoch:object, source:(string|null), reason:(string|null)}}
 */
function resolveStopExecutionClassification({ trustedStopExecutionClassification = null } = {}) {
  if (
    trustedStopExecutionClassification &&
    trustedStopExecutionClassification.available === true &&
    trustedStopExecutionClassification.byEpoch &&
    typeof trustedStopExecutionClassification.byEpoch === 'object'
  ) {
    return {
      available: true,
      complete: trustedStopExecutionClassification.complete === true,
      byEpoch: trustedStopExecutionClassification.byEpoch,
      source: trustedStopExecutionClassification.source || 'trusted_stop_classification',
      reason: null
    };
  }
  return {
    available: false,
    complete: false,
    byEpoch: {},
    source: null,
    reason: CLASSIFICATION_REASON
  };
}

/**
 * Determines whether a logical stop-modification sequence is non-decreasing
 * (Stop Ratchet / Never Lower, section 41). Execution slippage is not a stop
 * modification. When the configured tolerance requires a tick and no
 * trustworthy tick is available, the result is unresolved (UNKNOWN) rather
 * than fabricated.
 *
 * @returns {{resolved:boolean, valid:(boolean|null), violations:Array, reason:(string|null)}}
 */
function evaluateStopRatchet({ modifications, tickSize = null, tickKnown = false, downwardToleranceTicks = 0 }) {
  const mods = modifications || [];
  const tolerance = Number.isFinite(downwardToleranceTicks) && downwardToleranceTicks >= 0
    ? downwardToleranceTicks
    : 0;
  const needsTick = tolerance > 0;

  if (needsTick && !tickKnown) {
    return {
      resolved: false,
      valid: null,
      violations: [],
      reason:
        'A positive downward-tolerance requires a trustworthy instrument tick size, which is not stored; Stop Ratchet cannot be resolved.'
    };
  }
  const tick = tickKnown && Number.isFinite(tickSize) && tickSize > 0 ? tickSize : null;
  const epsilon = 1e-6;

  const violations = [];
  for (let i = 1; i < mods.length; i += 1) {
    const from = mods[i - 1];
    const to = mods[i];
    if (from.price === null || to.price === null) continue;
    if (tick) {
      const ticksDown = Math.round((from.price - to.price) / tick);
      if (ticksDown > tolerance) {
        violations.push({ index: i, fromPrice: from.price, toPrice: to.price, ticksDown });
      }
    } else if (from.price - to.price > epsilon) {
      // Tolerance is zero: any genuine decrease violates the no-lowering rule.
      violations.push({ index: i, fromPrice: from.price, toPrice: to.price, ticksDown: null });
    }
  }
  return { resolved: true, valid: violations.length === 0, violations, reason: null };
}

module.exports = {
  AUDIT_REASON,
  CLASSIFICATION_REASON,
  resolveStopHistory,
  resolveStopExecutionClassification,
  evaluateStopRatchet
};
