'use strict';

// Daily market-evidence service for Setup Quality
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 2.5 and the Phase 2
// market-evidence requirements).
//
// Phase 2 needs DAILY OHLCV evidence only. This service fetches a normalized,
// chronologically ordered daily-bar series through TradeTally's existing
// market-data abstraction (utils/finnhub routes to the configured Finnhub or
// FMP provider) with the existing persistent historical price cache
// (historical_prices) and the same fallback utilities the replay feature uses
// (Yahoo Finance, then Alpha Vantage when configured).
//
// Responsibilities:
//   - reuse the existing abstraction instead of calling providers directly
//     from individual criteria;
//   - serve repeated lookups for the same evaluation from the persistent
//     cache to avoid repeated provider calls;
//   - normalize provider results into one internal daily-bar representation
//     (see ./dailyEvidence.js) and snapshot the exact evidence used;
//   - provider failure or insufficient evidence becomes an explicit
//     unavailable-evidence state so criteria can return UNKNOWN — evidence is
//     never fabricated.

const marketData = require('../../utils/finnhub');
const historicalPriceCache = require('../../utils/historicalPriceCache');
const yahooFinance = require('../../utils/yahooFinance');
const alphaVantage = require('../../utils/alphaVantage');
const {
  normalizeDailyBars,
  dateStringToEpochSeconds,
  DAY_SECONDS
} = require('./dailyEvidence');

function isConfiguredProviderUsable() {
  return typeof marketData.isConfigured === 'function' && marketData.isConfigured();
}

/**
 * Loads normalized daily bars for a calendar window.
 *
 * @param {object} params
 * @param {string} params.symbol - equity symbol (upper-cased for lookups).
 * @param {string} params.userId - owning user (provider usage metering).
 * @param {string} params.fromDate - YYYY-MM-DD inclusive.
 * @param {string} params.toDate - YYYY-MM-DD inclusive.
 * @returns {Promise<{bars:Array, source:string|null, error:string|null}>}
 *   `bars` are normalized daily bars sorted chronologically. When no evidence
 *   could be obtained `bars` is [] and `error` describes why; criteria must
 *   surface that as UNKNOWN, never fabricate data.
 */
async function loadDailyEvidence({ symbol, userId, fromDate, toDate }) {
  const symbolUpper = String(symbol || '').trim().toUpperCase();
  if (!symbolUpper) {
    return { bars: [], source: null, error: 'trade has no symbol' };
  }

  try {
    const cached = await historicalPriceCache.getRange(symbolUpper, fromDate, toDate);
    const covered = await historicalPriceCache.hasRange(symbolUpper, fromDate, toDate);
    if (cached.length > 0 && covered) {
      return {
        bars: normalizeDailyBars(cached),
        source: 'historical_cache',
        error: null
      };
    }
  } catch (cacheError) {
    // Fall through to the provider rather than failing on a cache error.
  }

  const fromEpoch = dateStringToEpochSeconds(fromDate);
  const toEpoch = dateStringToEpochSeconds(toDate) + DAY_SECONDS - 1;

  if (isConfiguredProviderUsable()) {
    try {
      const raw = await marketData.getStockCandles(
        symbolUpper,
        'D',
        fromEpoch,
        toEpoch,
        userId,
        { source: 'quality_setup' }
      );
      const bars = normalizeDailyBars(raw);
      if (bars.length > 0) {
        try {
          await historicalPriceCache.insertCandles(
            symbolUpper,
            bars,
            marketData.providerName || 'finnhub'
          );
        } catch (insertError) {
          // Cache persistence is best-effort; the provider response is usable.
        }
        return { bars, source: marketData.providerName || 'finnhub', error: null };
      }
    } catch (providerError) {
      // Fall through to fallback providers below.
    }
  }

  // Yahoo Finance daily fallback (same ordering as replayDataService).
  if (typeof yahooFinance.isEnabled === 'function' && yahooFinance.isEnabled()) {
    try {
      const raw = await yahooFinance.getCandlesInWindow(symbolUpper, fromEpoch, toEpoch, 'D');
      const bars = normalizeDailyBars(raw);
      if (bars.length > 0) {
        return { bars, source: 'yahoo', error: null };
      }
    } catch (yahooError) {
      // Fall through to Alpha Vantage below.
    }
  }

  // Alpha Vantage daily fallback (writes its own cache rows).
  if (typeof alphaVantage.isConfigured === 'function' && alphaVantage.isConfigured()) {
    try {
      const candles = await alphaVantage.getDailyData(symbolUpper, 'full');
      const bars = normalizeDailyBars(candles).filter(
        (bar) => bar.date >= fromDate && bar.date <= toDate
      );
      if (bars.length > 0) {
        return { bars, source: 'alphavantage', error: null };
      }
    } catch (alphaError) {
      // Unavailable evidence below.
    }
  }

  return {
    bars: [],
    source: null,
    error: `No daily market data available for ${symbolUpper} between ${fromDate} and ${toDate}`
  };
}

module.exports = { loadDailyEvidence };
