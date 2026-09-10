'use strict';

// Configurable initial-stop buffer resolution for Entry Quality
// (docs/QUALITY_PROFILES_REQUIREMENT.md section 29.3).
//
// Supported typed methods:
//   minimum_tick   value * resolved tick size
//   fixed_dollars  value
//   percentage     entryBasis * value / 100
//   ATR_fraction   value * ATR$    (requires the ATR volatility reference)
//   ADR_fraction   value * ADR$    (requires the ADR volatility reference)
//
// Tick size is resolved ONLY from existing authoritative TradeTally
// instrument metadata:
//   - the trade's stored `tick_size` when present (any instrument type);
//   - the futures contract tick size from utils/futuresUtils when known.
//
// There is no authoritative per-instrument stock tick size in TradeTally (the
// SEC Rule 612 minimum increment is a market-wide rule, not stored instrument
// metadata). A stock with no stored tick_size therefore makes `minimum_tick`
// unavailable and Initial Stop UNKNOWN — this milestone MUST NOT substitute a
// guessed heuristic. A profile that intends a fixed $0.01 buffer must configure
// `minimum_buffer_method = fixed_dollars` + `minimum_buffer_value = 0.01`.

const { getFuturesTickSize } = require('../../../utils/futuresUtils');

function asNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function resolveTickSize({ trade }) {
  const stored = asNumber(trade && trade.tick_size);
  if (stored !== null && stored > 0) {
    return { available: true, tickSize: stored, source: 'instrument_tick_size' };
  }

  const instrumentType = String((trade && trade.instrument_type) || 'stock').toLowerCase();
  if (instrumentType === 'future') {
    const underlying = String((trade && trade.underlying_asset) || '').trim().toUpperCase();
    const futuresTick = underlying ? getFuturesTickSize(underlying) : null;
    if (futuresTick !== null && Number.isFinite(futuresTick) && futuresTick > 0) {
      return { available: true, tickSize: futuresTick, source: 'futures_contract_tick_size' };
    }
    return {
      available: false,
      tickSize: null,
      source: null,
      reason: 'No tick size is stored and the futures contract tick size is unknown.'
    };
  }

  return {
    available: false,
    tickSize: null,
    source: null,
    reason: `No authoritative price increment is stored for instrument type "${instrumentType}"; minimum_tick is unavailable (use fixed_dollars/percentage/ATR_fraction/ADR_fraction).`
  };
}

/**
 * @param {object} params
 * @param {object} params.criterionParameters - initial_stop criterion parameters.
 * @param {number} params.entryBasis
 * @param {object} params.volatilityByMethod - { ADR, ATR } volatility results.
 * @param {object} params.trade
 * @returns {object} { available, buffer, method, value, source, reason }
 */
function resolveBuffer({ criterionParameters = {}, entryBasis, volatilityByMethod = {}, trade }) {
  const method = criterionParameters.minimum_buffer_method;
  const value = asNumber(criterionParameters.minimum_buffer_value);
  const base = { available: false, buffer: null, method, value, source: null, reason: null };

  if (value === null || value <= 0) {
    return { ...base, reason: 'The configured buffer value is not a positive number.' };
  }

  switch (method) {
    case 'minimum_tick': {
      const tick = resolveTickSize({ trade });
      if (!tick.available) {
        return { ...base, source: tick.source, reason: tick.reason };
      }
      return {
        available: true,
        buffer: value * tick.tickSize,
        method,
        value,
        source: tick.source,
        reason: null
      };
    }
    case 'fixed_dollars':
      return { available: true, buffer: value, method, value, source: 'fixed_dollars', reason: null };
    case 'percentage': {
      if (!(entryBasis > 0)) {
        return { ...base, source: 'percentage', reason: 'Entry basis is unavailable for a percentage buffer.' };
      }
      return {
        available: true,
        buffer: entryBasis * (value / 100),
        method,
        value,
        source: 'entry_basis_percentage',
        reason: null
      };
    }
    case 'ATR_fraction': {
      const atr = volatilityByMethod.ATR;
      if (!atr || !atr.available || !(atr.dollars > 0)) {
        return { ...base, source: 'ATR', reason: 'The ATR volatility reference is unavailable for an ATR-fraction buffer.' };
      }
      return { available: true, buffer: value * atr.dollars, method, value, source: 'ATR', reason: null };
    }
    case 'ADR_fraction': {
      const adr = volatilityByMethod.ADR;
      if (!adr || !adr.available || !(adr.dollars > 0)) {
        return { ...base, source: 'ADR', reason: 'The ADR volatility reference is unavailable for an ADR-fraction buffer.' };
      }
      return { available: true, buffer: value * adr.dollars, method, value, source: 'ADR', reason: null };
    }
    default:
      return { ...base, reason: `Unsupported buffer method "${method}".` };
  }
}

module.exports = {
  resolveTickSize,
  resolveBuffer
};
