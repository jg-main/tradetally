'use strict';

// Point-in-time intraday market evidence for Entry Quality
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 2.3, 24-27, 29).
//
// TradeTally's existing market-data abstraction supplies 1-minute OHLCV bars
// (Finnhub/FMP through utils/finnhub, Yahoo fallback) and the replay feature
// already caches closed-session bars globally in `intraday_candles`. This
// service reuses that exact infrastructure:
//
//   - regular-session only (09:30-16:00 ET): premarket/after-hours prints never
//     contaminate canonical Entry metrics;
//   - bar `time` is the interval OPEN (epoch seconds UTC), so a bar is only
//     fully observable at `time + resolution`;
//   - a bar spanning the cutoff is NEVER consumed (no look-ahead);
//   - the actual opening execution prints are themselves observed prices and
//     may contribute to the range/low seen through the cutoff;
//   - historical reference sessions use the identical elapsed-time cutoff;
//   - genuinely unavailable evidence is surfaced as unavailable, and criteria
//     become UNKNOWN rather than fabricated.
//
// The loading function is cache-first; fetches go through the existing
// provider fallback chain. All the metric functions are pure and unit-tested.

const db = require('../../config/database');
const marketData = require('../../utils/finnhub');
const yahooFinance = require('../../utils/yahooFinance');
const {
  regularSessionBounds,
  observableBars
} = require('./entry/sessionTime');

const INTERVAL = '1min';
const RESOLUTION_SECONDS = 60;
// Don't persist bars for a session until it is safely closed, so a partial day
// is never recorded as covered.
const SESSION_CLOSE_BUFFER_SECONDS = 30 * 60;

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function normalizeBar(raw) {
  if (!raw || !isFiniteNumber(Number(raw.time))) return null;
  const time = Number(raw.time);
  const open = Number(raw.open);
  const high = Number(raw.high);
  const low = Number(raw.low);
  const close = Number(raw.close);
  if (![open, high, low, close].every((v) => Number.isFinite(v) && v > 0)) return null;
  if (high < open || high < close || high < low) return null;
  if (low > open || low > close) return null;
  const volume = raw.volume === null || raw.volume === undefined ? null : Number(raw.volume);
  return {
    time,
    open,
    high,
    low,
    close,
    volume: Number.isFinite(volume) ? volume : null
  };
}

function normalizeIntradayBars(rawBars) {
  if (!Array.isArray(rawBars)) return [];
  const byTime = new Map();
  for (const raw of rawBars) {
    const bar = normalizeBar(raw);
    if (bar) byTime.set(bar.time, bar);
  }
  return Array.from(byTime.values()).sort((a, b) => a.time - b.time);
}

function filterRegularSession(bars, session) {
  if (!session) return bars;
  return bars.filter((bar) => bar.time >= session.openEpoch && bar.time < session.closeEpoch);
}

async function getCoverage(symbol, sessionDate) {
  const result = await db.query(
    `SELECT from_ts, to_ts, source, candle_count
     FROM intraday_candle_coverage
     WHERE symbol = $1 AND interval = $2 AND session_date = $3`,
    [symbol, INTERVAL, sessionDate]
  );
  return result.rows[0] || null;
}

async function getCachedBars(symbol, fromTs, toTs) {
  const result = await db.query(
    `SELECT ts, open, high, low, close, volume
     FROM intraday_candles
     WHERE symbol = $1 AND interval = $2 AND ts >= $3 AND ts < $4
     ORDER BY ts ASC`,
    [symbol, INTERVAL, fromTs, toTs]
  );
  return result.rows.map((row) => ({
    time: Number(row.ts),
    open: Number(row.open),
    high: Number(row.high),
    low: Number(row.low),
    close: Number(row.close),
    volume: row.volume === null ? null : Number(row.volume)
  }));
}

async function storeBars(symbol, session, bars, source) {
  if (bars.length === 0) return;
  const values = [];
  const params = [];
  let i = 1;
  for (const bar of bars) {
    const volume = bar.volume === null || bar.volume === undefined ? null : Math.round(Number(bar.volume));
    values.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
    params.push(symbol, INTERVAL, bar.time, bar.open, bar.high, bar.low, bar.close, volume, source);
  }
  await db.query(
    `INSERT INTO intraday_candles (symbol, interval, ts, open, high, low, close, volume, source)
     VALUES ${values.join(', ')}
     ON CONFLICT (symbol, interval, ts) DO NOTHING`,
    params
  );
  await db.query(
    `INSERT INTO intraday_candle_coverage (symbol, interval, session_date, from_ts, to_ts, source, candle_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (symbol, interval, session_date) DO UPDATE
       SET from_ts = EXCLUDED.from_ts,
           to_ts = EXCLUDED.to_ts,
           source = EXCLUDED.source,
           candle_count = EXCLUDED.candle_count,
           fetched_at = NOW()`,
    [symbol, INTERVAL, session.date, session.openEpoch, session.closeEpoch, source, bars.length]
  );
}

async function fetchProviderBars(symbol, session, userId) {
  let rawBars;
  let source = marketData.providerName || 'provider';
  try {
    rawBars = await marketData.getStockCandles(
      symbol, '1', session.openEpoch, session.closeEpoch, userId, { source: 'quality_entry' }
    );
  } catch (providerError) {
    if (!(typeof yahooFinance.isEnabled === 'function' && yahooFinance.isEnabled())) {
      return { bars: [], source: null, error: providerError.message };
    }
    try {
      rawBars = await yahooFinance.getCandlesInWindow(symbol, session.openEpoch, session.closeEpoch, '1');
      source = 'yahoo';
    } catch (yahooError) {
      return { bars: [], source: null, error: yahooError.message };
    }
  }
  const bars = filterRegularSession(normalizeIntradayBars(rawBars), session);
  return { bars, source, error: null };
}

/**
 * Cache-first load of regular-session 1-minute bars for a session date.
 *
 * @returns {Promise<{available:boolean, bars:Array, source:string|null,
 *   resolution:string, resolutionSeconds:number, session:object|null,
 *   cacheHit:boolean, reason:string|null}>}
 */
async function loadSessionIntradayBars(symbol, sessionDate, userId) {
  const symbolUpper = String(symbol || '').trim().toUpperCase();
  const session = regularSessionBounds(sessionDate);
  if (!session) {
    return {
      available: false, bars: [], source: null, resolution: INTERVAL,
      resolutionSeconds: RESOLUTION_SECONDS, session: null, cacheHit: false,
      reason: `Invalid session date "${sessionDate}".`
    };
  }

  let cached = [];
  try {
    const coverage = await getCoverage(symbolUpper, sessionDate);
    if (coverage && Number(coverage.from_ts) <= session.openEpoch && Number(coverage.to_ts) >= session.closeEpoch) {
      cached = await getCachedBars(symbolUpper, session.openEpoch, session.closeEpoch);
    } else if (coverage) {
      cached = await getCachedBars(symbolUpper, session.openEpoch, session.closeEpoch);
    }
  } catch (cacheError) {
    cached = [];
  }
  const regularCached = filterRegularSession(cached, session);
  if (regularCached.length > 0) {
    return {
      available: true, bars: regularCached, source: 'intraday_cache', resolution: INTERVAL,
      resolutionSeconds: RESOLUTION_SECONDS, session, cacheHit: true, reason: null
    };
  }

  const fetched = await fetchProviderBars(symbolUpper, session, userId);
  if (fetched.bars.length > 0) {
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (session.closeEpoch + SESSION_CLOSE_BUFFER_SECONDS < nowSeconds) {
      try {
        await storeBars(symbolUpper, session, fetched.bars, fetched.source);
      } catch (cacheWriteError) {
        // Best-effort caching; the fetched bars are still usable.
      }
    }
    return {
      available: true, bars: fetched.bars, source: fetched.source, resolution: INTERVAL,
      resolutionSeconds: RESOLUTION_SECONDS, session, cacheHit: false, reason: null
    };
  }

  return {
    available: false, bars: [], source: null, resolution: INTERVAL,
    resolutionSeconds: RESOLUTION_SECONDS, session, cacheHit: false,
    reason: fetched.error || `No regular-session intraday data available for ${symbolUpper} on ${sessionDate}.`
  };
}

// ---------------------------------------------------------------------------
// Pure point-in-time metric functions
// ---------------------------------------------------------------------------

// Cumulative regular-session volume of bars fully observable at the cutoff.
// Returns null when any observable bar has unknown volume (incomplete sum).
function cumulativeVolumeThrough(bars, cutoffEpoch, resolutionSeconds = RESOLUTION_SECONDS) {
  const observable = observableBars(bars, cutoffEpoch, resolutionSeconds);
  let total = 0;
  for (const bar of observable) {
    if (!isFiniteNumber(bar.volume)) return null;
    total += bar.volume;
  }
  return total;
}

// High/low/range over bars fully observable at the cutoff, optionally including
// observed execution print prices (e.g. actual opening fills).
function rangeThrough(bars, cutoffEpoch, { resolutionSeconds = RESOLUTION_SECONDS, extraPrices = [] } = {}) {
  const observable = observableBars(bars, cutoffEpoch, resolutionSeconds);
  let high = -Infinity;
  let low = Infinity;
  let lastObservableEpoch = null;
  for (const bar of observable) {
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
    lastObservableEpoch = lastObservableEpoch === null ? bar.time : Math.max(lastObservableEpoch, bar.time);
  }
  for (const price of extraPrices) {
    if (!isFiniteNumber(price) || price <= 0) continue;
    high = Math.max(high, price);
    low = Math.min(low, price);
  }
  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return { high: null, low: null, range: null, observableBars: observable.length, lastObservableEpoch };
  }
  return {
    high,
    low,
    range: high - low,
    observableBars: observable.length,
    lastObservableEpoch
  };
}

/**
 * Same-time-of-day pace metric for volume or range.
 *
 * @param {object} params
 * @param {object} params.entrySession - { date, openEpoch, closeEpoch }.
 * @param {Array} params.entrySessionBars - regular-session 1-min bars.
 * @param {number} params.entryCutoffEpoch - actual initial entry time.
 * @param {Array} params.referenceSessions - [{ date, openEpoch, bars }].
 * @param {number} params.requiredSessions
 * @param {'volume'|'range'} params.kind
 * @param {Array} [params.extraPrices] - observed entry prints (today only).
 * @returns {object}
 */
function computePaceMetric({
  entrySession,
  entrySessionBars,
  entryCutoffEpoch,
  referenceSessions,
  requiredSessions,
  kind,
  extraPrices = []
}) {
  const resolutionSeconds = RESOLUTION_SECONDS;
  const elapsed = entryCutoffEpoch - entrySession.openEpoch;
  const valueFor = (bars, cutoffEpoch, prices) =>
    kind === 'volume'
      ? cumulativeVolumeThrough(bars, cutoffEpoch, resolutionSeconds)
      : (() => {
          const r = rangeThrough(bars, cutoffEpoch, { resolutionSeconds, extraPrices: prices });
          return r.range;
        })();

  const today = kind === 'volume'
    ? cumulativeVolumeThrough(entrySessionBars, entryCutoffEpoch, resolutionSeconds)
    : (() => {
        const r = rangeThrough(entrySessionBars, entryCutoffEpoch, { resolutionSeconds, extraPrices });
        return r.range;
      })();

  const references = [];
  const usableValues = [];
  for (const reference of referenceSessions || []) {
    const cutoff = reference.openEpoch + elapsed;
    const value = valueFor(reference.bars, cutoff, []);
    const usable = isFiniteNumber(value);
    if (usable) usableValues.push(value);
    references.push({ date: reference.date, value: usable ? value : null, cutoffEpoch: cutoff, usable });
  }

  const expected = usableValues.length > 0
    ? usableValues.reduce((sum, value) => sum + value, 0) / usableValues.length
    : null;

  const todayUsable = isFiniteNumber(today);
  const available =
    todayUsable &&
    isFiniteNumber(expected) &&
    expected > 0 &&
    usableValues.length >= (Number.isInteger(requiredSessions) ? requiredSessions : 0);

  let pace = null;
  if (todayUsable && isFiniteNumber(expected) && expected > 0) {
    pace = today / expected;
  }

  return {
    available,
    kind,
    today,
    expected,
    pace,
    usableSessions: usableValues.length,
    requiredSessions: requiredSessions || null,
    elapsedSeconds: elapsed,
    cutoffEpoch: entryCutoffEpoch,
    referenceCutoffs: references,
    resolution: INTERVAL,
    resolutionSeconds,
    reason: available
      ? null
      : !todayUsable
        ? 'Entry-session evidence through the entry cutoff is unavailable.'
        : !isFiniteNumber(expected) || expected <= 0
          ? 'Same-time historical reference evidence is unavailable.'
          : `Only ${usableValues.length} usable reference session(s); ${requiredSessions} required.`
  };
}

/**
 * Observable LOD from the session open through the reference time, using only
 * fully-observable bars plus observed execution prints. Later lows are never
 * included. Returns null when no price observation exists.
 */
function observableLod({ bars, openEpoch, referenceEpoch, resolutionSeconds = RESOLUTION_SECONDS, extraPrices = [] }) {
  const scoped = (bars || []).filter((bar) => !isFiniteNumber(openEpoch) || bar.time >= openEpoch);
  const range = rangeThrough(scoped, referenceEpoch, { resolutionSeconds, extraPrices });
  return {
    low: range.low,
    high: range.high,
    lastObservableEpoch: range.lastObservableEpoch,
    observableBars: range.observableBars
  };
}

module.exports = {
  INTERVAL,
  RESOLUTION_SECONDS,
  normalizeIntradayBars,
  filterRegularSession,
  loadSessionIntradayBars,
  cumulativeVolumeThrough,
  rangeThrough,
  computePaceMetric,
  observableLod
};
