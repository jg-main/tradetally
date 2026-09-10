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
  // Negative volume is invalid evidence, not a finite usable value.
  const usableVolume = Number.isFinite(volume) && volume >= 0 ? volume : null;
  return {
    time,
    open,
    high,
    low,
    close,
    volume: usableVolume
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
  // Coverage metadata must reflect the ACTUAL span of bars returned; it must
  // never claim full-session coverage for a partial/sparse result.
  const firstTs = Math.min(...bars.map((bar) => bar.time));
  const lastTs = Math.max(...bars.map((bar) => bar.time));
  await db.query(
    `INSERT INTO intraday_candle_coverage (symbol, interval, session_date, from_ts, to_ts, source, candle_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (symbol, interval, session_date) DO UPDATE
       SET from_ts = LEAST(intraday_candle_coverage.from_ts, EXCLUDED.from_ts),
           to_ts = GREATEST(intraday_candle_coverage.to_ts, EXCLUDED.to_ts),
           source = EXCLUDED.source,
           candle_count = EXCLUDED.candle_count,
           fetched_at = NOW()`,
    [symbol, INTERVAL, session.date, firstTs, lastTs, source, bars.length]
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
    cached = await getCachedBars(symbolUpper, session.openEpoch, session.closeEpoch);
  } catch (cacheError) {
    cached = [];
  }
  const regularCached = filterRegularSession(cached, session);
  const expectedCount = expectedSessionIntervalCount(session, RESOLUTION_SECONDS);
  const coverageOf = (bars) => ({
    count: bars.length,
    expectedCount,
    firstEpoch: bars.length > 0 ? bars[0].time : null,
    lastEpoch: bars.length > 0 ? bars[bars.length - 1].time : null
  });

  // `available` means bars are PRESENT, not that they are metric-sufficient.
  // Metric-level sufficiency is decided by the pure functions below.
  if (regularCached.length >= expectedCount && expectedCount > 0) {
    return {
      available: true, bars: regularCached, source: 'intraday_cache', resolution: INTERVAL,
      resolutionSeconds: RESOLUTION_SECONDS, session, cacheHit: true, reason: null,
      coverage: coverageOf(regularCached)
    };
  }

  const fetched = await fetchProviderBars(symbolUpper, session, userId);
  if (fetched.bars.length > regularCached.length) {
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
      resolutionSeconds: RESOLUTION_SECONDS, session, cacheHit: false, reason: null,
      coverage: coverageOf(fetched.bars)
    };
  }
  if (regularCached.length > 0) {
    return {
      available: true, bars: regularCached, source: 'intraday_cache', resolution: INTERVAL,
      resolutionSeconds: RESOLUTION_SECONDS, session, cacheHit: true,
      reason: 'Provider returned no additional bars; cached evidence may be partial.',
      coverage: coverageOf(regularCached)
    };
  }

  return {
    available: false, bars: [], source: null, resolution: INTERVAL,
    resolutionSeconds: RESOLUTION_SECONDS, session, cacheHit: false,
    reason: fetched.error || `No regular-session intraday data available for ${symbolUpper} on ${sessionDate}.`,
    coverage: coverageOf([])
  };
}

// ---------------------------------------------------------------------------
// Evidence sufficiency (finding 5)
// ---------------------------------------------------------------------------
//
// A metric is knowable from 1-minute evidence ONLY when:
//   - the cutoff is exactly on a 1-minute interval boundary (no partially
//     observed interval can contain an unobserved extreme or extra volume);
//   - every expected interval from the session open through the cutoff is
//     present (no gaps).
// Otherwise the metric is UNKNOWN. Merely excluding the bar that CONTAINS the
// cutoff does not make the measurement exact.

function intervalAlignment(cutoffEpoch, openEpoch, resolutionSeconds = RESOLUTION_SECONDS) {
  if (!isFiniteNumber(cutoffEpoch) || !isFiniteNumber(openEpoch)) {
    return { aligned: false, completedIntervals: null, partialSeconds: null };
  }
  const offset = cutoffEpoch - openEpoch;
  if (offset < 0) return { aligned: false, completedIntervals: null, partialSeconds: null };
  return {
    aligned: offset % resolutionSeconds === 0,
    completedIntervals: Math.floor(offset / resolutionSeconds),
    partialSeconds: offset % resolutionSeconds
  };
}

// Expected interval OPEN times fully contained in [fromEpoch, toEpoch).
function expectedIntervalStarts(fromEpoch, toEpoch, resolutionSeconds = RESOLUTION_SECONDS) {
  const starts = [];
  if (!isFiniteNumber(fromEpoch) || !isFiniteNumber(toEpoch)) return starts;
  for (let start = fromEpoch; start + resolutionSeconds <= toEpoch; start += resolutionSeconds) {
    starts.push(start);
  }
  return starts;
}

function missingIntervalStarts(bars, fromEpoch, toEpoch, resolutionSeconds = RESOLUTION_SECONDS) {
  const present = new Set((bars || []).map((bar) => bar.time));
  return expectedIntervalStarts(fromEpoch, toEpoch, resolutionSeconds).filter(
    (start) => !present.has(start)
  );
}

function expectedSessionIntervalCount(session, resolutionSeconds = RESOLUTION_SECONDS) {
  if (!session || !isFiniteNumber(session.openEpoch) || !isFiniteNumber(session.closeEpoch)) return 0;
  return Math.max(0, Math.floor((session.closeEpoch - session.openEpoch) / resolutionSeconds));
}

// ---------------------------------------------------------------------------
// Pure point-in-time metric functions
// ---------------------------------------------------------------------------

// Cumulative regular-session volume of bars fully observable at the cutoff.
// Returns null when any observable bar has unknown/negative volume.
function cumulativeVolumeThrough(bars, cutoffEpoch, resolutionSeconds = RESOLUTION_SECONDS) {
  const observable = observableBars(bars, cutoffEpoch, resolutionSeconds);
  let total = 0;
  for (const bar of observable) {
    if (!isFiniteNumber(bar.volume) || bar.volume < 0) return null;
    total += bar.volume;
  }
  return total;
}

function observationsThrough(observations, cutoffEpoch) {
  return (observations || []).filter(
    (observation) => isFiniteNumber(observation.epoch) && observation.epoch <= cutoffEpoch
  );
}

// High/low/range over bars fully observable at the cutoff, plus observed
// execution observations whose timestamp is <= the cutoff.
function rangeThrough(
  bars,
  cutoffEpoch,
  { resolutionSeconds = RESOLUTION_SECONDS, extraObservations = [] } = {}
) {
  const observable = observableBars(bars, cutoffEpoch, resolutionSeconds);
  let high = -Infinity;
  let low = Infinity;
  let lastObservableEpoch = null;
  for (const bar of observable) {
    high = Math.max(high, bar.high);
    low = Math.min(low, bar.low);
    lastObservableEpoch = lastObservableEpoch === null ? bar.time : Math.max(lastObservableEpoch, bar.time);
  }
  for (const observation of observationsThrough(extraObservations, cutoffEpoch)) {
    if (!isFiniteNumber(observation.price) || observation.price <= 0) continue;
    high = Math.max(high, observation.price);
    low = Math.min(low, observation.price);
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
 * @param {Array} [params.extraObservations] - timestamped execution prints.
 * @returns {object}
 */
function computePaceMetric({
  entrySession,
  entrySessionBars,
  entryCutoffEpoch,
  referenceSessions,
  requiredSessions,
  kind,
  extraObservations = []
}) {
  const resolutionSeconds = RESOLUTION_SECONDS;
  const openEpoch = entrySession.openEpoch;
  const elapsed = entryCutoffEpoch - openEpoch;
  const entryAlignment = intervalAlignment(entryCutoffEpoch, openEpoch, resolutionSeconds);

  const failure = (reason, extra = {}) => ({
    available: false,
    kind,
    today: null,
    expected: null,
    pace: null,
    usableSessions: 0,
    requiredSessions: requiredSessions || null,
    elapsedSeconds: elapsed,
    cutoffEpoch: entryCutoffEpoch,
    referenceCutoffs: [],
    resolution: INTERVAL,
    resolutionSeconds,
    reason,
    ...extra
  });

  if (!entryAlignment.aligned) {
    return failure(
      'The entry cutoff is not exactly on a 1-minute interval boundary; a partially observed interval could contain unobserved activity, so this metric is UNKNOWN.',
      { precision: 'partial_interval', partialSeconds: entryAlignment.partialSeconds }
    );
  }

  const entryMissing = missingIntervalStarts(
    entrySessionBars, openEpoch, entryCutoffEpoch, resolutionSeconds
  );
  if (entryMissing.length > 0) {
    return failure(
      `The entry-session evidence has ${entryMissing.length} missing 1-minute interval(s) through the entry cutoff; the metric is UNKNOWN.`,
      { precision: 'gap', missingIntervals: entryMissing.length }
    );
  }

  const valueFor = (bars, cutoffEpoch) =>
    kind === 'volume'
      ? cumulativeVolumeThrough(bars, cutoffEpoch, resolutionSeconds)
      : rangeThrough(bars, cutoffEpoch, { resolutionSeconds }).range;

  const today = kind === 'volume'
    ? cumulativeVolumeThrough(entrySessionBars, entryCutoffEpoch, resolutionSeconds)
    : rangeThrough(entrySessionBars, entryCutoffEpoch, {
        resolutionSeconds,
        extraObservations
      }).range;

  if (!isFiniteNumber(today)) {
    return failure(
      kind === 'volume'
        ? 'Entry-session cumulative volume through the cutoff is unavailable (missing or invalid volume).'
        : 'Entry-session range through the cutoff is unavailable.'
    );
  }

  const references = [];
  const usableValues = [];
  for (const reference of referenceSessions || []) {
    const cutoff = reference.openEpoch + elapsed;
    const referenceMissing = missingIntervalStarts(
      reference.bars, reference.openEpoch, cutoff, resolutionSeconds
    );
    const value = referenceMissing.length === 0 ? valueFor(reference.bars, cutoff) : null;
    const usable = isFiniteNumber(value);
    if (usable) usableValues.push(value);
    references.push({
      date: reference.date,
      value: usable ? value : null,
      cutoffEpoch: cutoff,
      usable,
      missingIntervals: referenceMissing.length
    });
  }

  const expected = usableValues.length > 0
    ? usableValues.reduce((sum, value) => sum + value, 0) / usableValues.length
    : null;

  const available =
    isFiniteNumber(expected) &&
    expected > 0 &&
    usableValues.length >= (Number.isInteger(requiredSessions) ? requiredSessions : 0);

  let pace = null;
  if (isFiniteNumber(expected) && expected > 0) {
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
    precision: 'exact_1min',
    reason: available
      ? null
      : !isFiniteNumber(expected) || expected <= 0
        ? 'Same-time historical reference evidence is unavailable.'
        : `Only ${usableValues.length} usable reference session(s); ${requiredSessions} required.`
  };
}

/**
 * Observable LOD from the session open through the reference time. Only fully
 * observable bars plus timestamped execution observations <= the reference time
 * contribute. The metric is exact ONLY when the reference time is interval
 * aligned and there are no gaps; otherwise `low` is null with a reason and the
 * caller must treat Initial Stop as UNKNOWN.
 */
function observableLod({
  bars,
  openEpoch,
  referenceEpoch,
  resolutionSeconds = RESOLUTION_SECONDS,
  extraObservations = []
}) {
  const alignment = intervalAlignment(referenceEpoch, openEpoch, resolutionSeconds);
  if (!alignment.aligned) {
    return {
      low: null,
      high: null,
      lastObservableEpoch: null,
      observableBars: 0,
      precision: 'partial_interval',
      reason:
        'The stop-establishment reference time is not exactly on a 1-minute interval boundary; the observable LOD is UNKNOWN.'
    };
  }
  const scoped = (bars || []).filter((bar) => !isFiniteNumber(openEpoch) || bar.time >= openEpoch);
  const missing = missingIntervalStarts(scoped, openEpoch, referenceEpoch, resolutionSeconds);
  if (missing.length > 0) {
    return {
      low: null,
      high: null,
      lastObservableEpoch: null,
      observableBars: 0,
      precision: 'gap',
      missingIntervals: missing.length,
      reason: `The entry-session evidence has ${missing.length} missing 1-minute interval(s) through the reference time; the observable LOD is UNKNOWN.`
    };
  }
  const range = rangeThrough(scoped, referenceEpoch, { resolutionSeconds, extraObservations });
  return {
    low: range.low,
    high: range.high,
    lastObservableEpoch: range.lastObservableEpoch,
    observableBars: range.observableBars,
    precision: 'exact_1min',
    reason: null
  };
}

module.exports = {
  INTERVAL,
  RESOLUTION_SECONDS,
  normalizeIntradayBars,
  filterRegularSession,
  loadSessionIntradayBars,
  intervalAlignment,
  expectedIntervalStarts,
  missingIntervalStarts,
  expectedSessionIntervalCount,
  cumulativeVolumeThrough,
  rangeThrough,
  computePaceMetric,
  observableLod
};
