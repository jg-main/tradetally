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
// Evidence completeness rules:
//   - The generic historicalPriceCache.hasRange() coverage check (~50% of
//     expected sessions) is NOT sufficient for Setup Quality, where missing
//     sessions would otherwise be treated as adjacent trading sessions and
//     corrupt detector horizons, Base Duration, Prior Move searches,
//     contraction windows, and SMA history. The Quality path therefore never
//     uses hasRange().
//   - When a configured provider/fallback can supply the window, its session
//     set is authoritative and cache rows only fill dates the provider did not
//     return (deterministic merge by session date; provider wins conflicts).
//     The result is marked `completeness: 'verified'`.
//   - A partial cache can never prevent fetching a missing entry/base/history
//     session when an existing provider can supply it.
//   - When no provider is available, cache rows are returned only as
//     `completeness: 'unverified'` evidence. Setup evaluation refuses to treat
//     unverified sessions as consecutive trading sessions: the orchestrator
//     surfaces UNKNOWN instead of fabricating a score.
//   - Missing volume stays missing: the cache is read with
//     preserveNullVolume and cached zero volumes (which the shared cache uses
//     to represent missing volume) are treated as missing on the Quality path.
//     Bars with unknown volume are never written back into the shared cache as
//     zero-volume observations. Volume Contraction therefore yields UNKNOWN
//     rather than a fabricated zero-volume PASS.
//   - Mathematically invalid OHLCV bars are rejected by normalization.

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

// Cache rows may hold a coerced 0 where volume was originally missing (the
// shared insertCandles path and legacy consumers treat missing volume as 0).
// For Setup Quality a cached 0 is never a trustworthy zero-volume observation,
// so it is surfaced as missing volume. Real non-zero volumes pass through.
function volumeFromCacheRow(volume, preserveNullVolume) {
  if (volume === null || volume === undefined) {
    return preserveNullVolume ? null : 0;
  }
  const value = parseFloat(volume);
  if (!Number.isFinite(value) || value <= 0) return null;
  return value;
}

async function readCachedBars(symbolUpper, fromDate, toDate) {
  try {
    const rows = await historicalPriceCache.getRange(symbolUpper, fromDate, toDate, {
      preserveNullVolume: true
    });
    return rows.map((row) => ({
      time: row.time,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: volumeFromCacheRow(row.volume, true)
    }));
  } catch (cacheError) {
    return [];
  }
}

// Deterministic merge: `primary` (provider) wins per session date; `secondary`
// (cache) only fills session dates the primary did not return. Output is sorted
// chronologically by session date.
function mergeDailyBars(primary, secondary) {
  const byDate = new Map();
  for (const bar of secondary || []) {
    byDate.set(bar.date, bar);
  }
  for (const bar of primary || []) {
    byDate.set(bar.date, bar);
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function persistProviderBars(symbolUpper, bars, source) {
  // Only sessions with a known volume are cached. Unknown-volume sessions are
  // intentionally NOT written through insertCandles (which would coerce them
  // to zero), so the cache never fabricates zero-volume observations.
  const cacheable = bars.filter((bar) => typeof bar.volume === 'number' && Number.isFinite(bar.volume));
  if (cacheable.length === 0) return;
  try {
    await historicalPriceCache.insertCandles(symbolUpper, cacheable, source);
  } catch (insertError) {
    // Cache persistence is best-effort; the provider response is usable.
  }
}

/**
 * Loads normalized daily bars for a calendar window.
 *
 * @param {object} params
 * @param {string} params.symbol - equity symbol (upper-cased for lookups).
 * @param {string} params.userId - owning user (provider usage metering).
 * @param {string} params.fromDate - YYYY-MM-DD inclusive.
 * @param {string} params.toDate - YYYY-MM-DD inclusive.
 * @returns {Promise<{bars:Array, source:string|null, completeness:string|null,
 *   error:string|null}>}
 *   `bars` are normalized daily bars sorted chronologically.
 *   `completeness` is 'verified' when a provider session set backs the bars and
 *   'unverified' when only cache rows are available. `error` describes why
 *   evidence is missing/unverified when relevant.
 */
async function loadDailyEvidence({ symbol, userId, fromDate, toDate }) {
  const symbolUpper = String(symbol || '').trim().toUpperCase();
  if (!symbolUpper) {
    return { bars: [], source: null, completeness: 'unverified', error: 'trade has no symbol' };
  }

  const cached = await readCachedBars(symbolUpper, fromDate, toDate);
  const cachedBars = normalizeDailyBars(cached);

  const fromEpoch = dateStringToEpochSeconds(fromDate);
  const toEpoch = dateStringToEpochSeconds(toDate) + DAY_SECONDS - 1;

  // Provider completion chain: configured provider, then Yahoo Finance, then
  // Alpha Vantage (the same fallback ordering replayDataService uses).
  let providerBars = null;
  let providerSource = null;

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
      providerBars = normalizeDailyBars(raw);
      providerSource = marketData.providerName || 'finnhub';
    } catch (providerError) {
      providerBars = null;
    }
  }

  if ((!providerBars || providerBars.length === 0) && typeof yahooFinance.isEnabled === 'function' && yahooFinance.isEnabled()) {
    try {
      const raw = await yahooFinance.getCandlesInWindow(symbolUpper, fromEpoch, toEpoch, 'D');
      providerBars = normalizeDailyBars(raw);
      providerSource = 'yahoo';
    } catch (yahooError) {
      providerBars = null;
    }
  }

  if ((!providerBars || providerBars.length === 0) && typeof alphaVantage.isConfigured === 'function' && alphaVantage.isConfigured()) {
    try {
      const candles = await alphaVantage.getDailyData(symbolUpper, 'full');
      providerBars = normalizeDailyBars(candles).filter(
        (bar) => bar.date >= fromDate && bar.date <= toDate
      );
      providerSource = 'alphavantage';
    } catch (alphaError) {
      providerBars = null;
    }
  }

  if (providerBars && providerBars.length > 0) {
    // Provider session set is authoritative; the cache only fills dates the
    // provider omitted. Cached volumes are already surfaced as missing when
    // the shared cache stored 0 for an unknown volume.
    const merged = mergeDailyBars(providerBars, cachedBars);
    await persistProviderBars(symbolUpper, providerBars, providerSource);
    return {
      bars: merged,
      source: providerSource,
      completeness: 'verified',
      error: null
    };
  }

  if (cachedBars.length > 0) {
    return {
      bars: cachedBars,
      source: 'historical_cache',
      completeness: 'unverified',
      error:
        `Daily market data for ${symbolUpper} could not be verified against a provider; ` +
        'cache coverage is not authoritative for Setup Quality session counting.'
    };
  }

  return {
    bars: [],
    source: null,
    completeness: 'unverified',
    error: `No daily market data available for ${symbolUpper} between ${fromDate} and ${toDate}`
  };
}

module.exports = { loadDailyEvidence, mergeDailyBars };
