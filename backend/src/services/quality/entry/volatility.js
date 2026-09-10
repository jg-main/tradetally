'use strict';

// Point-in-time ADR/ATR volatility reference for Entry Quality
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 25, 29-31).
//
// All volatility inputs are COMPLETED daily sessions strictly before the
// actual initial-entry session. The entry session's own (possibly partial)
// high/low/low-close is never used: it would be look-ahead relative to the
// intraday entry decision.
//
//   ADR: DailyRangePct_i = (High_i - Low_i) / PreviousClose_i
//        ADRNPct = mean(DailyRangePct over the last N completed sessions)
//        ADR$ = EntryBasis * ADRNPct
//
//   ATR: TR_i = max(High_i - Low_i, |High_i - PrevClose_i|, |Low_i - PrevClose_i|)
//        ATR  = mean(TR over the last N completed sessions)   (price units)
//
// The period is profile configuration (owned by the stop_width criterion).
// CANONICAL_ADR_PERIOD is only a documented mathematical fallback for the
// canonical ADR20 definition when no criterion in the profile configures a
// period; it is not used to override a configured value.

const CANONICAL_ADR_PERIOD = 20;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {object} params
 * @param {Array} params.dailyBars - normalized daily bars, chronological.
 * @param {number} params.entryIndex - index of the actual-ENTRY session bar.
 * @param {string} params.method - 'ADR' | 'ATR'.
 * @param {number} params.period - completed sessions to average.
 * @param {number} params.entryBasis - original entry basis (for ADR$).
 * @returns {{available:boolean, method?:string, period?:number,
 *   dollars?:number, pct?:number|null, atr?:number|null, adrPct?:number|null,
 *   sessions?:Array, reason?:string}}
 */
function computeVolatility({ dailyBars, entryIndex, method, period, entryBasis }) {
  const resolvedPeriod = Number.isInteger(period) && period > 0 ? period : CANONICAL_ADR_PERIOD;
  const resolvedMethod = method === 'ATR' ? 'ATR' : 'ADR';

  if (!Array.isArray(dailyBars) || dailyBars.length === 0) {
    return { available: false, reason: 'No completed daily sessions are available for the volatility reference.' };
  }
  if (!Number.isInteger(entryIndex) || entryIndex < 0) {
    return { available: false, reason: 'The actual entry session is not present in the daily evidence.' };
  }
  // Need `period` completed sessions before the entry session AND a previous
  // close for the earliest one.
  if (entryIndex < resolvedPeriod + 1) {
    return {
      available: false,
      reason: `Only ${entryIndex} completed session(s) precede the entry session; the ${resolvedMethod}${resolvedPeriod} reference needs ${resolvedPeriod + 1}.`
    };
  }
  if (!isFiniteNumber(entryBasis) || entryBasis <= 0) {
    return { available: false, reason: 'Entry basis is unavailable; the volatility reference cannot be expressed in price units.' };
  }

  const startIndex = entryIndex - resolvedPeriod;
  const endIndex = entryIndex - 1;
  const sessions = [];
  for (let i = startIndex; i <= endIndex; i += 1) {
    const bar = dailyBars[i];
    const previous = dailyBars[i - 1];
    if (!bar || !previous || !isFiniteNumber(bar.high) || !isFiniteNumber(bar.low) ||
        !isFiniteNumber(previous.close) || previous.close <= 0) {
      return { available: false, reason: 'A completed daily session in the volatility window has unusable OHLC data.' };
    }
    const highLow = bar.high - bar.low;
    const trueRange = Math.max(
      highLow,
      Math.abs(bar.high - previous.close),
      Math.abs(bar.low - previous.close)
    );
    sessions.push({
      date: bar.date,
      high: bar.high,
      low: bar.low,
      previousClose: previous.close,
      dailyRangePct: highLow / previous.close,
      trueRange
    });
  }

  if (resolvedMethod === 'ATR') {
    const atr = sessions.reduce((sum, session) => sum + session.trueRange, 0) / sessions.length;
    return {
      available: true,
      method: 'ATR',
      period: resolvedPeriod,
      dollars: atr,
      atr,
      pct: null,
      adrPct: null,
      sessions
    };
  }

  const adrPct = sessions.reduce((sum, session) => sum + session.dailyRangePct, 0) / sessions.length;
  return {
    available: true,
    method: 'ADR',
    period: resolvedPeriod,
    dollars: entryBasis * adrPct,
    atr: null,
    pct: adrPct,
    adrPct,
    sessions
  };
}

module.exports = {
  CANONICAL_ADR_PERIOD,
  computeVolatility
};
