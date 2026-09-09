'use strict';

// SMA Trend Structure criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 19).
//
// Evaluated at D-1. Canonical defaults (profile parameters): SMA fast=10,
// slow=20, slope_lookback=5, support MA=SMA20, max close below support=2%,
// require_fast_above_slow=false.
//
// MA history MAY use pre-base bars (indicator history), unlike the
// range/volume contraction windows which must stay inside the base.
//
// Configured components (evaluated at D-1 against the comparison date
// D-1 - slope_lookback):
//   SMA_fast(D-1) > SMA_fast(comparison)
//   SMA_slow(D-1) > SMA_slow(comparison)
//   Close(D-1) >= SMA_slow(D-1) * (1 - max_close_below_support_pct / 100)
// plus, when the profile enables require_fast_above_slow,
//   SMA_fast(D-1) > SMA_slow(D-1)
//
// scoring_value = number of passing configured components; the profile step
// curve derives the numerical score. Compliance uses ALL enabled component
// requirements. Insufficient MA history -> UNKNOWN.

const { CRITERION_STATUS } = require('../../constants');
const { requireNumberParameter, optionalBooleanParameter, unknownResult } = require('./common');

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function smaAt(bars, index, period) {
  if (index < period - 1) return null;
  let sum = 0;
  for (let i = index - period + 1; i <= index; i += 1) {
    sum += bars[i].close;
  }
  return sum / period;
}

function evaluate({ key = 'ma_trend', criterion = {}, setup = {}, bars = [] }) {
  const parameters = criterion.parameters || {};
  const type = parameters.type || 'SMA';
  const fastPeriod = requireNumberParameter(parameters, 'fast_period', key);
  const slowPeriod = requireNumberParameter(parameters, 'slow_period', key);
  const slopeLookback = requireNumberParameter(parameters, 'slope_lookback', key);
  const maxCloseBelowSupportPct = requireNumberParameter(
    parameters,
    'max_close_below_support_pct',
    key
  );
  const requireFastAboveSlow = optionalBooleanParameter(
    parameters,
    'require_fast_above_slow',
    false
  );
  const supportPeriod =
    parameters.support_period !== undefined
      ? requireNumberParameter(parameters, 'support_period', key)
      : slowPeriod;

  if (String(type).toUpperCase() !== 'SMA') {
    return unknownResult(
      `MA type "${type}" is not supported by the Setup Quality SMA Trend evaluator.`
    );
  }

  const baseEnd = setup.baseEnd;
  if (!baseEnd) {
    return unknownResult(
      'SMA Trend Structure requires an established setup boundary (resolution session).'
    );
  }
  const d1 = baseEnd.index;
  const comparison = d1 - slopeLookback;

  // Earliest close used: SMA_slow at the comparison date needs
  // comparison - slowPeriod + 1 >= 0; the support MA at D-1 needs
  // d1 - supportPeriod + 1 >= 0.
  if (d1 < slopeLookback + slowPeriod - 1 || d1 < supportPeriod - 1) {
    return {
      status: CRITERION_STATUS.UNKNOWN,
      scoring_value: null,
      raw_value: null,
      evidence: {
        evaluation_date: baseEnd.date,
        required_history_sessions: Math.max(slopeLookback + slowPeriod - 1, supportPeriod - 1),
        available_history_sessions: d1,
        fast_period: fastPeriod,
        slow_period: slowPeriod,
        support_period: supportPeriod,
        slope_lookback: slopeLookback
      },
      message: 'Insufficient MA history to evaluate SMA Trend Structure at D-1.'
    };
  }

  const fastNow = smaAt(bars, d1, fastPeriod);
  const fastThen = smaAt(bars, comparison, fastPeriod);
  const slowNow = smaAt(bars, d1, slowPeriod);
  const slowThen = smaAt(bars, comparison, slowPeriod);
  const supportNow = smaAt(bars, d1, supportPeriod);
  const closeNow = bars[d1].close;

  if (
    fastNow === null ||
    fastThen === null ||
    slowNow === null ||
    slowThen === null ||
    supportNow === null ||
    closeNow === null
  ) {
    return unknownResult('SMA Trend Structure could not compute its indicators at D-1.');
  }

  const supportThreshold = supportNow * (1 - maxCloseBelowSupportPct / 100);

  const components = [
    {
      key: 'fast_rising',
      label: `SMA${fastPeriod}(${bars[d1].date}) > SMA${fastPeriod}(${bars[comparison].date})`,
      pass: fastNow > fastThen
    },
    {
      key: 'slow_rising',
      label: `SMA${slowPeriod}(${bars[d1].date}) > SMA${slowPeriod}(${bars[comparison].date})`,
      pass: slowNow > slowThen
    },
    {
      key: 'close_supported',
      label: `Close(${bars[d1].date}) >= SMA${supportPeriod}(${bars[d1].date}) * ${1 - maxCloseBelowSupportPct / 100}`,
      pass: closeNow >= supportThreshold
    }
  ];
  if (requireFastAboveSlow) {
    components.push({
      key: 'fast_above_slow',
      label: `SMA${fastPeriod}(${bars[d1].date}) > SMA${slowPeriod}(${bars[d1].date})`,
      pass: fastNow > slowNow
    });
  }

  const passing = components.filter((component) => component.pass).length;
  const allPass = passing === components.length;
  const supportDistancePct = round2(((closeNow - supportNow) / supportNow) * 100);

  const evidence = {
    evaluation_date: bars[d1].date,
    comparison_date: bars[comparison].date,
    close_d1: closeNow,
    fast_ma: {
      period: fastPeriod,
      current: fastNow,
      comparison: fastThen
    },
    slow_ma: {
      period: slowPeriod,
      current: slowNow,
      comparison: slowThen
    },
    support_ma: {
      period: supportPeriod,
      current: supportNow
    },
    support_distance_pct: supportDistancePct,
    max_close_below_support_pct: maxCloseBelowSupportPct,
    require_fast_above_slow: requireFastAboveSlow,
    components: components.map((component) => ({
      key: component.key,
      label: component.label,
      pass: component.pass
    })),
    component_counts: { passing, total: components.length }
  };

  return {
    status: allPass ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: passing,
    raw_value: passing,
    evidence,
    message: allPass
      ? `All ${components.length} configured SMA trend components pass at D-1.`
      : `${passing}/${components.length} configured SMA trend components pass at D-1.`
  };
}

module.exports = { evaluate };
