'use strict';

// Exchange-session time helpers for Entry Quality
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 23-27, 29).
//
// Canonical U.S. equity regular session clock is America/New_York (09:30-16:00
// ET). Market-data bar timestamps from TradeTally's providers are TRUE UTC
// epoch seconds of the bar's OPEN time (Finnhub `t`; FMP Eastern wall-clock
// converted to UTC). A bar of resolution R that opens at time T is only fully
// observable at T + R, so point-in-time rules must treat `time` as the bar OPEN,
// never as its close.
//
// This module is pure (no database access) and shares the same single-pass
// timezone-offset technique the replay service uses; US DST transitions happen
// at 2am Sunday when the equity market is closed, so a session window never
// straddles one.

const MARKET_TZ = 'America/New_York';
const REGULAR_OPEN_HOUR = 9;
const REGULAR_OPEN_MINUTE = 30;
const REGULAR_CLOSE_HOUR = 16;
const REGULAR_CLOSE_MINUTE = 0;

// Opening-range length in minutes per canonical trigger type.
const OPENING_RANGE_MINUTES = Object.freeze({
  'BO-ORH-1': 1,
  'BO-ORH-5': 5,
  'BO-ORH-60': 60
});

function wallClockPartsInZone(epochMs, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(new Date(epochMs));
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    // Intl formats midnight as hour 24 in some environments.
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second')
  };
}

function tzOffsetMs(epochMs, timeZone) {
  const p = wallClockPartsInZone(epochMs, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - epochMs;
}

// Epoch seconds for a wall-clock time in a timezone.
function zonedEpochSeconds(year, month, day, hour, minute, second, timeZone = MARKET_TZ) {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  return Math.floor((guess - tzOffsetMs(guess, timeZone)) / 1000);
}

function parseDateParts(dateString) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
  if (!match) return null;
  return { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
}

// Regular-session (09:30-16:00 ET) bounds for a YYYY-MM-DD session date.
function regularSessionBounds(dateString) {
  const parts = parseDateParts(dateString);
  if (!parts) return null;
  const openEpoch = zonedEpochSeconds(
    parts.year, parts.month, parts.day, REGULAR_OPEN_HOUR, REGULAR_OPEN_MINUTE, 0
  );
  const closeEpoch = zonedEpochSeconds(
    parts.year, parts.month, parts.day, REGULAR_CLOSE_HOUR, REGULAR_CLOSE_MINUTE, 0
  );
  return { date: dateString, openEpoch, closeEpoch };
}

// Opening-range window for an ORH trigger type. Returns null for BO-PIVOT or an
// unknown type. `completionEpoch` is when the range is fully complete and the
// ORH trigger first becomes valid.
function openingRangeBounds(dateString, triggerType) {
  const minutes = OPENING_RANGE_MINUTES[triggerType];
  if (!minutes) return null;
  const session = regularSessionBounds(dateString);
  if (!session) return null;
  return {
    minutes,
    startEpoch: session.openEpoch,
    completionEpoch: session.openEpoch + minutes * 60
  };
}

// Session date (YYYY-MM-DD) in exchange time for a UTC epoch second.
function sessionDateInZone(epochSeconds, timeZone = MARKET_TZ) {
  const p = wallClockPartsInZone(epochSeconds * 1000, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

// True when a bar of `resolutionSeconds` opening at `barTime` is fully
// observable at `cutoffEpoch` (i.e. its interval has completed). The bar that
// CONTAINS the cutoff is never fully observable and is excluded.
function barFullyObservable(barTime, cutoffEpoch, resolutionSeconds = 60) {
  return Number.isFinite(barTime) && barTime + resolutionSeconds <= cutoffEpoch;
}

// Filters bars to those fully observable at the cutoff, sorted ascending.
function observableBars(bars, cutoffEpoch, resolutionSeconds = 60) {
  return (bars || [])
    .filter((bar) => barFullyObservable(bar.time, cutoffEpoch, resolutionSeconds))
    .sort((a, b) => a.time - b.time);
}

module.exports = {
  MARKET_TZ,
  OPENING_RANGE_MINUTES,
  wallClockPartsInZone,
  zonedEpochSeconds,
  regularSessionBounds,
  openingRangeBounds,
  sessionDateInZone,
  barFullyObservable,
  observableBars
};
