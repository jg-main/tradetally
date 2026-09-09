'use strict';

// Shared factory helpers for Phase 2 Setup Quality tests. Produces the
// internal normalized daily-bar shape directly ({date, time, open, high, low,
// close, volume}) with deterministic consecutive session dates. Session math
// in the code under test counts bars, so weekend gaps are irrelevant here.

function pad(value) {
  return String(value).padStart(2, '0');
}

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
}

function makeDate(startDate, offset) {
  return addDays(startDate, offset);
}

function epochSecondsFor(date) {
  return Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000);
}

/**
 * Builds normalized daily bars from OHLC rows.
 * @param {string} startDate - first session date YYYY-MM-DD.
 * @param {Array<Array<number>>} rows - [open, high, low, close, volume?]
 *   Volume defaults to 1_000_000.
 */
function buildBars(startDate, rows) {
  return rows.map((row, index) => {
    const [open, high, low, close, volume] = row;
    const date = makeDate(startDate, index);
    return {
      date,
      time: epochSecondsFor(date),
      open,
      high,
      low,
      close,
      volume: row.length < 5 || volume === undefined ? 1_000_000 : volume
    };
  });
}

/**
 * One candle row with a fixed high and low (small range).
 */
function candle(close, high = null, low = null, volume = 1_000_000, open = null) {
  const h = high === null ? close + 0.2 : high;
  const l = low === null ? close - 0.2 : low;
  return [open === null ? close - 0.1 : open, h, l, close, volume];
}

module.exports = { buildBars, candle, makeDate, epochSecondsFor, addDays };
