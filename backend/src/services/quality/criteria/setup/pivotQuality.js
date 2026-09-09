'use strict';

// Pivot Quality criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 21).
//
// Pivot detection confidence is NOT Pivot Quality. Pivot Quality grades the
// CONFIRMED pivot and may FAIL even when the detector confidence was low (a
// user-confirmed one-touch pivot still has to satisfy the configured
// requirements). It is never converted to UNKNOWN merely because detection
// confidence was low.
//
// Canonical compliance components (all configurable):
//   touch_count >= minimum_touches
//   at least one recent touch within the final recent_touch_window sessions
//   D-1 close is no more than max_d1_distance_pct below the confirmed pivot
//   no pre-breakout daily close exceeds the pivot by more than
//     prior_close_tolerance_pct
//
// A touch is a structural swing high inside the base whose high approaches the
// confirmed pivot from below within cluster_tolerance_pct (resistance-touch
// semantics; the same tolerance used by the detection cluster). Structural
// highs are detected strictly inside the base range (no look-ahead past D-1).
//
// Scoring uses the profile's composite envelope; scoring_value is the
// component-input object: { resistance_touches, recent_touch, d1_proximity,
// no_prior_resolution }.

const { CRITERION_STATUS } = require('../../constants');
const {
  requireNumberParameter,
  optionalBooleanParameter,
  unknownResult
} = require('./common');

function structuralHighsInRange(bars, rangeStart, rangeEnd, left, right) {
  const highs = [];
  for (let i = rangeStart + left; i <= rangeEnd - right; i += 1) {
    let ok = true;
    for (let j = i - left; j < i; j += 1) {
      if (!(bars[i].high > bars[j].high)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    for (let j = i + 1; j <= i + right; j += 1) {
      if (!(bars[i].high >= bars[j].high)) {
        ok = false;
        break;
      }
    }
    if (ok) {
      highs.push({ index: i, date: bars[i].date, price: bars[i].high });
    }
  }
  return highs;
}

function round4(value) {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}

function evaluate({ key = 'pivot_quality', criterion = {}, setup = {}, bars = [] }) {
  const parameters = criterion.parameters || {};
  const swingLeft = requireNumberParameter(parameters, 'swing_left', key);
  const swingRight = requireNumberParameter(parameters, 'swing_right', key);
  const clusterTolerancePct = requireNumberParameter(parameters, 'cluster_tolerance_pct', key);
  const minimumTouches = requireNumberParameter(parameters, 'minimum_touches', key);
  const recentTouchWindow = requireNumberParameter(parameters, 'recent_touch_window', key);
  const maxD1DistancePct = requireNumberParameter(parameters, 'max_d1_distance_pct', key);
  const priorCloseTolerancePct = requireNumberParameter(
    parameters,
    'prior_close_tolerance_pct',
    key
  );
  optionalBooleanParameter(parameters, 'require_confirmation', true);

  const baseStart = setup.baseStart;
  const baseEnd = setup.baseEnd;
  const pivot = setup.pivot;

  if (!baseStart || !baseEnd || !pivot || typeof pivot.price !== 'number') {
    return unknownResult(
      'Pivot Quality requires a confirmed pivot and an established setup boundary.'
    );
  }

  const rangeStart = baseStart.index;
  const rangeEnd = baseEnd.index;
  const pivotPrice = pivot.price;

  const structuralHighs = structuralHighsInRange(bars, rangeStart, rangeEnd, swingLeft, swingRight);

  // Resistance touches: structural highs that approach the confirmed pivot
  // from below within the configured cluster/touch tolerance.
  const touchFloor = pivotPrice * (1 - clusterTolerancePct / 100);
  const touches = structuralHighs.filter(
    (high) => high.price >= touchFloor && high.price <= pivotPrice
  );

  const recentStartIndex = Math.max(rangeStart, rangeEnd - recentTouchWindow + 1);
  const recentTouches = touches.filter((touch) => touch.index >= recentStartIndex);

  const closeD1 = bars[rangeEnd].close;
  const pivotDistancePct = closeD1 === null || closeD1 === undefined
    ? null
    : round4(((pivotPrice - closeD1) / pivotPrice) * 100);

  let priorResolution = false;
  const priorCloseToleranceLevel = pivotPrice * (1 + priorCloseTolerancePct / 100);
  for (let i = rangeStart; i <= rangeEnd; i += 1) {
    if (bars[i].close !== null && bars[i].close > priorCloseToleranceLevel) {
      priorResolution = true;
      break;
    }
  }

  const touchCount = touches.length;
  const recentTouchCount = recentTouches.length;
  const hasRecentTouch = recentTouchCount >= 1;

  const components = {
    touches_ok: touchCount >= minimumTouches,
    recent_touch_ok: hasRecentTouch,
    d1_proximity_ok: pivotDistancePct !== null && pivotDistancePct <= maxD1DistancePct,
    no_prior_resolution_ok: !priorResolution
  };

  const compliant = Object.values(components).every(Boolean);
  const failures = Object.entries(components)
    .filter(([, ok]) => !ok)
    .map(([component]) => component);

  const evidence = {
    confirmed_pivot: pivotPrice,
    pivot_date: pivot.date || null,
    pivot_source: pivot.source || null,
    detection_confidence: pivot.detectionConfidence ?? pivot.detection_confidence ?? null,
    base_range: {
      startDate: bars[rangeStart].date,
      endDate: bars[rangeEnd].date
    },
    touch_tolerance_pct: clusterTolerancePct,
    minimum_touches: minimumTouches,
    recent_touch_window: recentTouchWindow,
    max_d1_distance_pct: maxD1DistancePct,
    prior_close_tolerance_pct: priorCloseTolerancePct,
    structural_highs_in_base: structuralHighs.map((high) => ({
      date: high.date,
      price: high.price
    })),
    resistance_touches: touches.map((touch) => ({ date: touch.date, price: touch.price })),
    touch_count: touchCount,
    recent_touches: recentTouches.map((touch) => ({ date: touch.date, price: touch.price })),
    recent_touch_count: recentTouchCount,
    close_d1: closeD1,
    pivot_distance_pct: pivotDistancePct,
    prior_resolution: priorResolution,
    components
  };

  if (compliant) {
    return {
      status: CRITERION_STATUS.PASS,
      scoring_value: {
        resistance_touches: touchCount,
        recent_touch: hasRecentTouch,
        d1_proximity: pivotDistancePct,
        no_prior_resolution: !priorResolution
      },
      raw_value: touchCount,
      evidence,
      message: 'Confirmed pivot satisfies all configured Pivot Quality components.'
    };
  }
  return {
    status: CRITERION_STATUS.FAIL,
    scoring_value: {
      resistance_touches: touchCount,
      recent_touch: hasRecentTouch,
      d1_proximity: pivotDistancePct,
      no_prior_resolution: !priorResolution
    },
    raw_value: touchCount,
    evidence,
    message: `Confirmed pivot fails configured Pivot Quality components: ${failures.join(', ')}.`
  };
}

module.exports = { evaluate, structuralHighsInRange };
