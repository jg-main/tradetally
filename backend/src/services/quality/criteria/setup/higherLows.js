'use strict';

// Higher Lows criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 16).
//
// Evaluated only inside Confirmed Base Start -> D-1. Structural swing lows use
// the configured left/right windows, fully contained inside the base (no
// look-ahead past D-1, no reach before Base Start).
//
// Canonical defaults (profile parameters): swing_left=2, swing_right=2,
// minimum_lows=2, tolerance_pct=0.5, sequence rule no_material_lower_low.
//
// A later low passes the transition when:
//
//   L[n] >= L[n-1] * (1 - tolerance_pct / 100)
//
//   all transitions non-materially-lower            -> PASS
//   any material lower transition                   -> FAIL
//   fewer than the configured minimum structural lows -> UNKNOWN
//
// scoring_value = non_lower_transitions / total_transitions (the profile
// envelope derives the numerical score).

const { CRITERION_STATUS } = require('../../constants');
const { requireNumberParameter, unknownResult } = require('./common');

/**
 * Structural swing lows whose confirmation windows are fully inside
 * [rangeStart, rangeEnd] (point-in-time: nothing after D-1 is observed).
 */
function swingLowsInRange(bars, rangeStart, rangeEnd, left, right) {
  const lows = [];
  for (let i = rangeStart + left; i <= rangeEnd - right; i += 1) {
    let ok = true;
    for (let j = i - left; j < i; j += 1) {
      if (!(bars[i].low < bars[j].low)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (let j = i + 1; j <= i + right; j += 1) {
      if (!(bars[i].low <= bars[j].low)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      lows.push({ index: i, date: bars[i].date, price: bars[i].low });
    }
  }
  return lows;
}

function evaluate({ key = 'higher_lows', criterion = {}, setup = {}, bars = [] }) {
  const parameters = criterion.parameters || {};
  const swingLeft = requireNumberParameter(parameters, 'swing_left', key);
  const swingRight = requireNumberParameter(parameters, 'swing_right', key);
  const minimumLows = requireNumberParameter(parameters, 'minimum_lows', key);
  const tolerancePct = requireNumberParameter(parameters, 'tolerance_pct', key);

  const baseStart = setup.baseStart;
  const baseEnd = setup.baseEnd;
  if (!baseStart || !baseEnd) {
    return unknownResult(
      'Higher Lows requires an established setup boundary (confirmed Base Start and a resolution session).'
    );
  }

  const rangeStart = baseStart.index;
  const rangeEnd = baseEnd.index;
  const lows = swingLowsInRange(bars, rangeStart, rangeEnd, swingLeft, swingRight);

  const evidenceBase = {
    base_range: {
      startDate: bars[rangeStart].date,
      endDate: bars[rangeEnd].date
    },
    swing_left: swingLeft,
    swing_right: swingRight,
    minimum_lows: minimumLows,
    tolerance_pct: tolerancePct,
    structural_lows: lows.map((low) => ({ index: low.index, date: low.date, price: low.price }))
  };

  if (lows.length < minimumLows) {
    return {
      status: CRITERION_STATUS.UNKNOWN,
      scoring_value: null,
      raw_value: null,
      evidence: {
        ...evidenceBase,
        structural_lows_count: lows.length,
        reason: `Only ${lows.length} structural swing low(s) detected inside the base; the configured minimum is ${minimumLows}.`
      },
      message: `Fewer than ${minimumLows} structural swing lows were detected inside the base; Higher Lows is UNKNOWN.`
    };
  }

  const transitions = [];
  for (let n = 1; n < lows.length; n += 1) {
    const prior = lows[n - 1];
    const current = lows[n];
    const thresholdPrice = prior.price * (1 - tolerancePct / 100);
    const materialLower = current.price < thresholdPrice;
    transitions.push({
      from_date: prior.date,
      from_price: prior.price,
      to_date: current.date,
      to_price: current.price,
      threshold_price: thresholdPrice,
      material_lower: materialLower,
      pass: !materialLower
    });
  }

  const nonLowerTransitions = transitions.filter((transition) => transition.pass).length;
  const totalTransitions = transitions.length;
  const anyMaterialLower = transitions.some((transition) => transition.material_lower);
  const ratio = totalTransitions > 0 ? round2(nonLowerTransitions / totalTransitions) : null;

  const evidence = {
    ...evidenceBase,
    structural_lows_count: lows.length,
    transitions,
    transition_counts: {
      total: totalTransitions,
      non_lower: nonLowerTransitions,
      material_lower: totalTransitions - nonLowerTransitions
    }
  };

  if (anyMaterialLower) {
    return {
      status: CRITERION_STATUS.FAIL,
      scoring_value: ratio,
      raw_value: ratio,
      evidence,
      message: 'At least one structural swing low inside the base was materially lower than the prior low.'
    };
  }
  return {
    status: CRITERION_STATUS.PASS,
    scoring_value: ratio,
    raw_value: ratio,
    evidence,
    message: `All ${totalTransitions} structural-low transition(s) inside the base held above the ${tolerancePct}% tolerance.`
  };
}

function round2(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

module.exports = { evaluate, swingLowsInRange };
