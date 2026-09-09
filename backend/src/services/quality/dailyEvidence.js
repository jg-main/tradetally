'use strict';

// Pure daily-bar evidence helpers for Setup Quality evaluation
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 2.3, 2.5 and the Phase 2
// market-evidence requirements).
//
// A "session" is one normalized daily bar. Session counts and durations are
// ALWAYS derived from the actual bars (trading sessions represented by
// candles); calendar-day arithmetic is never used to count sessions. The only
// calendar math in Phase 2 is choosing how wide a window to REQUEST from the
// provider/cache, which is a fetch concern (see marketEvidenceService.js).
//
// Bar identity: a daily bar's session date is the UTC date of its epoch
// second (`new Date(time * 1000).toISOString().split('T')[0]`), the same
// convention historicalPriceCache and the FMP/Finnhub candle paths already
// use, so provider bars and the persistent cache agree on session dates.

const DAY_SECONDS = 24 * 60 * 60;

function dateFromEpochSeconds(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString().split('T')[0];
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function toFinite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// True when a raw bar is usable as a daily trading session. `time` and
// `close` are required (a session without a close cannot participate in any
// price rule); open/high/low are required because OHLC rules read them;
// volume is optional at this level (volume-contraction criteria treat missing
// volume as insufficient evidence).
function isValidRawBar(bar) {
  if (bar === null || typeof bar !== 'object') return false;
  if (!isFiniteNumber(bar.time)) return false;
  if (!isFiniteNumber(toFinite(bar.open))) return false;
  if (!isFiniteNumber(toFinite(bar.high))) return false;
  if (!isFiniteNumber(toFinite(bar.low))) return false;
  if (!isFiniteNumber(toFinite(bar.close))) return false;
  return true;
}

/**
 * Normalizes raw provider/cache bars into the internal daily-bar
 * representation, ordered chronologically with duplicate sessions removed:
 *
 *   [{ date, time, open, high, low, close, volume }]
 *
 * - sorts ascending by time;
 * - deduplicates by session date keeping the first bar seen for a date
 *   (providers are queried chronologically; later duplicates of the same
 *   session add no information);
 * - drops bars with unusable OHLC/time values;
 * - preserves the raw `volume` value (may be null when a provider does not
 *   report it).
 */
function normalizeDailyBars(rawBars) {
  if (!Array.isArray(rawBars)) return [];

  const valid = rawBars.filter(isValidRawBar).sort((a, b) => a.time - b.time);
  const byDate = new Map();
  const output = [];
  for (const bar of valid) {
    const date = dateFromEpochSeconds(bar.time);
    if (byDate.has(date)) continue;
    byDate.set(date, true);
    output.push({
      date,
      time: bar.time,
      open: toFinite(bar.open),
      high: toFinite(bar.high),
      low: toFinite(bar.low),
      close: toFinite(bar.close),
      volume: bar.volume === null || bar.volume === undefined ? null : toFinite(bar.volume)
    });
  }
  return output;
}

/**
 * Builds a Map of session date -> index over normalized bars.
 */
function indexByDate(bars) {
  const map = new Map();
  for (let i = 0; i < bars.length; i += 1) {
    map.set(bars[i].date, i);
  }
  return map;
}

/**
 * Adds signed calendar days to a YYYY-MM-DD date string.
 * Calendar arithmetic is only used to compute provider/cache REQUEST windows,
 * never to measure trading-session durations.
 */
function addCalendarDays(dateString, deltaDays) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);
  return date.toISOString().split('T')[0];
}

/**
 * Converts a YYYY-MM-DD date string into the UTC epoch used by providers.
 */
function dateStringToEpochSeconds(dateString) {
  return Math.floor(new Date(`${dateString}T00:00:00.000Z`).getTime() / 1000);
}

// Trading days are roughly 5/7 of calendar days. Used only to size the fetch
// window (request enough calendar span to guarantee `requiredSessions` bars).
function calendarDaysForSessions(sessionCount) {
  return Math.ceil((sessionCount * 7) / 5) + 7;
}

/**
 * Returns bars[startIndex..endIndex] inclusive. Clamps to the array bounds
 * and returns [] when the range is empty/invalid.
 */
function sliceBars(bars, startIndex, endIndex) {
  if (!Array.isArray(bars) || bars.length === 0) return [];
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return [];
  if (startIndex < 0 || endIndex < startIndex) return [];
  const from = Math.max(0, startIndex);
  const to = Math.min(bars.length - 1, endIndex);
  if (from > to) return [];
  return bars.slice(from, to + 1);
}

// True when the sub-array has at least `length` bars (i.e. a window starting
// at startIndex and ending at endIndex is "complete").
function windowIsComplete(bars, startIndex, endIndex, length) {
  if (!Number.isInteger(startIndex) || !Number.isInteger(endIndex)) return false;
  const from = Math.max(0, startIndex);
  const to = Math.min(bars.length - 1, endIndex);
  if (from > to) return false;
  return to - from + 1 >= length && endIndex - startIndex + 1 >= length;
}

module.exports = {
  DAY_SECONDS,
  dateFromEpochSeconds,
  normalizeDailyBars,
  indexByDate,
  addCalendarDays,
  dateStringToEpochSeconds,
  calendarDaysForSessions,
  sliceBars,
  windowIsComplete,
  isFiniteNumber
};
