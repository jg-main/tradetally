'use strict';

// Builds a synthetic daily-bar series representing a clean Canonical BO setup:
// a strong prior impulse, an orderly base (higher lows, contracting range and
// volume, rising SMAs, a two-touch pivot with a recent touch), then a breakout
// session. Indexes below are stable because generation is fully deterministic.
//
// Layout (global bar indexes):
//   0..69  prior impulse (swing low at index 19, low = 50)
//   70     Base Start session (swing high, high = 102, close 99)
//   71..94 base (24 more sessions => 25-session base through D-1 at index 94)
//   95     breakout/setup-resolution session D (high 106 > confirmed pivot 101)
//   96..105 post-breakout sessions (used by late-entry regression variants)
//
// Confirmed semantic inputs for this scenario:
//   leader_confirmed = true
//   base_start       = { date: bar(70).date, source: 'detected_confirmed' }
//   pivot            = { price: 101, date: bar(89).date, source: 'detected_confirmed' }
const { buildBars } = require('./barFactory');

const BASE_START_INDEX = 70;
const BASE_END_INDEX = 94;
const RESOLUTION_INDEX = 95;
const ENTRY_INDEX = 95;
const IMPULSE_LOW_INDEX = 19;
const PIVOT_PRICE = 102; // base-start/pivot top of the base; touches print ~101
const PIVOT_TOUCH_INDEX = 89;

function row(high, low, close, volume) {
  // Guarantee a mathematically coherent daily bar (open == close; close clamped
  // inside [low, high]) so scenario candles satisfy the strict OHLC validity
  // rules of the Quality evidence layer.
  const c = Math.min(high, Math.max(low, close));
  const open = c;
  return [open, high, low, c, volume];
}

function buildCanonicalBOSeries({ extraPostBreakout = 10 } = {}) {
  const rows = [];

  // ---- Impulse: descend to 50 at index 19, then climb ----
  for (let i = 0; i <= 69; i += 1) {
    let low;
    if (i <= 19) {
      low = 100 - (50 * i) / 19;
    } else {
      low = 50 + ((86 - 50) * (i - 19)) / 50;
    }
    // Ends just below the base start top at index 70 (high 102) so the top of
    // the impulse IS the Base Start.
    const high = low + 12 + i * 0.03;
    const close = high - 2.2;
    rows.push(row(high, low, close, i <= 19 ? 900_000 : 1_400_000));
  }

  // ---- Base Start session (index 70) ----
  rows.push(row(102, 90, 99, 800_000));

  // ---- Base sessions (indices 71..94) ----
  const base = [];
  // Low path through alternating descents/ascents so the anchor points are true
  // structural swing-low bottoms: (6, 92), (14, 94.5), (21, 96.5) rising.
  const lowAnchors = [
    [0, 90],
    [2, 95],
    [6, 92],
    [9, 98],
    [14, 94.5],
    [17, 98],
    [21, 96.5],
    [24, 97.5]
  ];
  const lowAt = (p) => {
    let segment = lowAnchors[0];
    for (let a = 0; a < lowAnchors.length - 1; a += 1) {
      const [p0, l0] = lowAnchors[a];
      const [p1, l1] = lowAnchors[a + 1];
      if (p >= p0 && p <= p1) {
        segment = l0 + ((l1 - l0) * (p - p0)) / (p1 - p0);
        break;
      }
    }
    return segment;
  };
  for (let p = 1; p <= 24; p += 1) {
    const index = 70 + p;
    const low = lowAt(p);
    // Highs stay below the pivot except the two resistance touches (80, 89).
    const isTouch = index === 80 || index === 89;
    const high = isTouch ? 101 : 99.2 + (p % 4) * 0.35;
    // Gently rising closes so SMA10/SMA20 rise over the comparison window.
    const close = 94.5 + (p - 1) * 0.18 + (p % 3) * 0.1;
    // Volume: prior 10-session window (80..89) elevated, recent 5 (90..94) dry.
    let volume = 1_000_000;
    if (index >= 90) volume = 250_000;
    else if (index >= 80) volume = 1_200_000;
    else volume = 700_000;
    base.push({ low, high, close, volume, isTouch });
    rows.push(row(high, Math.min(high, low), close, volume));
  }

  // ---- Breakout session (index 95) and post-breakout padding ----
  rows.push(row(106, 97, 104, 3_000_000));
  for (let i = 0; i < extraPostBreakout; i += 1) {
    rows.push(row(110 + i, 102 + i, 108 + i, 2_000_000));
  }

  const bars = buildBars('2026-01-01', rows);
  return {
    bars,
    baseStartIndex: BASE_START_INDEX,
    baseEndIndex: BASE_END_INDEX,
    resolutionIndex: RESOLUTION_INDEX,
    entryIndex: ENTRY_INDEX,
    impulseLowIndex: IMPULSE_LOW_INDEX,
    pivotPrice: PIVOT_PRICE,
    pivotTouchIndex: PIVOT_TOUCH_INDEX,
    dateAt: (index) => bars[index].date
  };
}

module.exports = {
  buildCanonicalBOSeries,
  BASE_START_INDEX,
  BASE_END_INDEX,
  RESOLUTION_INDEX,
  ENTRY_INDEX,
  IMPULSE_LOW_INDEX,
  PIVOT_PRICE,
  PIVOT_TOUCH_INDEX
};
