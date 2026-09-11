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
// NOT trustworthy complete stop-order lifecycle evidence. Per sections 41.4 and
// 42, Stop Ratchet and Post-Partial Breakeven are UNKNOWN when complete history
// is unavailable; they must NEVER be inferred from the current/final stop_loss
// or from a reasonable final exit.
//
// A genuinely trustworthy stop-history source may be supplied via the optional
// `trustedStopHistory` hook (with its own provenance establishing why it is a
// complete logical stop-modification sequence). No such TradeTally source
// exists today, so production always resolves to UNKNOWN. The hook exists so
// the evaluator contract is honest and testable, not to enable fabrication.

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

/**
 * Resolves the logical stop-modification sequence (chronological, per-price
 * change) for the protective stop covering a long position.
 *
 * @param {object} params
 * @param {object} [params.trustedStopHistory] - optional authoritative source:
 *   {
 *     modifications: [{ epoch, price }],  // chronological, non-decreasing-by-rule
 *     source: string,
 *     provenance: string
 *   }
 * @returns {object}
 *   { available, modifications: [{epoch, price}], source, provenance, reason }
 */
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
 * Determines whether a logical stop-modification sequence is non-decreasing
 * (Stop Ratchet / Never Lower, section 41). Normalizes prices to the configured
 * valid tick before comparison; a downward move of more than
 * `downwardToleranceTicks` ticks fails. For a long position any net decrease is
 * a failure with canonical tolerance 0 ticks.
 *
 * @param {object} params
 * @param {Array} params.modifications - [{ epoch, price }] chronological.
 * @param {number} [params.tickSize] - valid price increment (default 0.01).
 * @param {number} [params.downwardToleranceTicks=0]
 * @returns {object} { valid, violations: [{index, fromPrice, toPrice, ticksDown}] }
 */
function evaluateStopRatchet({ modifications, tickSize = 0.01, downwardToleranceTicks = 0 }) {
  const mods = modifications || [];
  const tick = Number.isFinite(tickSize) && tickSize > 0 ? tickSize : 0.01;
  const tolerance = Number.isFinite(downwardToleranceTicks) && downwardToleranceTicks >= 0
    ? downwardToleranceTicks
    : 0;
  const violations = [];
  for (let i = 1; i < mods.length; i += 1) {
    const from = mods[i - 1];
    const to = mods[i];
    if (from.price === null || to.price === null) continue;
    const ticksDown = Math.round((from.price - to.price) / tick);
    if (ticksDown > tolerance) {
      violations.push({
        index: i,
        fromPrice: from.price,
        toPrice: to.price,
        ticksDown
      });
    }
  }
  return { valid: violations.length === 0, violations };
}

module.exports = {
  AUDIT_REASON,
  resolveStopHistory,
  evaluateStopRatchet
};
