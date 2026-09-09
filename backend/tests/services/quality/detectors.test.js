'use strict';

const { normalizeDailyBars, indexByDate } = require('../../../src/services/quality/dailyEvidence');
const {
  findSwingHighs,
  findSwingLows,
  isSwingHighAtIndex,
  isSwingLowAtIndex
} = require('../../../src/services/quality/detectors/swingPoints');
const { detectBaseStart } = require('../../../src/services/quality/detectors/baseStart');
const { detectPivot, buildClusters } = require('../../../src/services/quality/detectors/pivot');
const { resolveSetupBoundary } = require('../../../src/services/quality/detectors/setupBoundary');
const { buildBars, candle } = require('./barFactory');

const BASE_START_PARAMS = {
  detection_lookback: 60,
  swing_high_left: 3,
  swing_high_right: 3,
  max_post_high_advance_pct: 5
};

const PIVOT_PARAMS = {
  swing_left: 2,
  swing_right: 2,
  cluster_tolerance_pct: 2,
  minimum_touches: 2,
  recent_touch_window: 10
};

describe('dailyEvidence normalizeDailyBars', () => {
  test('sorts chronologically, dedupes by session date, and drops unusable bars', () => {
    const raw = [
      { time: 1700000000, open: 1, high: 2, low: 1, close: 2, volume: 10 },
      { time: 1699990000, open: 1, high: 2, low: 1, close: 1, volume: 9 },
      { time: 1700000000, open: 1, high: 2, low: 1, close: 2, volume: 10 }, // duplicate session
      { time: 1700086400, open: null, high: 2, low: 1, close: 2, volume: 10 }, // non-positive open -> dropped
      { time: 1700172800, open: 1, high: 3, low: 1, close: 3, volume: null }
    ];
    const bars = normalizeDailyBars(raw);
    expect(bars).toHaveLength(2);
    expect(bars[0].date < bars[1].date).toBe(true);
    expect(bars[0].close).toBe(1); // earliest of the duplicated session wins
    expect(bars[0].volume).toBe(9);
    expect(bars[1].volume).toBe(null);
  });

  test('indexByDate returns session indexes', () => {
    const bars = buildBars('2026-01-01', [candle(10), candle(11), candle(12)]);
    const map = indexByDate(bars);
    expect(map.get(bars[1].date)).toBe(1);
    expect(map.has('2020-01-01')).toBe(false);
  });
});

describe('swingPoints', () => {
  test('findSwingHighs honors previous-strict/following-non-strict windows', () => {
    // Session 3 (index 3) is a swing high under left=2/right=2:
    // high[3] > highs[1..2] and high[3] >= highs[4..5].
    const bars = buildBars('2026-01-01', [
      candle(10), // 0
      candle(12), // 1
      candle(11), // 2
      candle(15, 15, 12), // 3 swing high
      candle(14), // 4
      candle(13), // 5
      candle(16, 16, 13), // 6 swing high (higher)
      candle(9) // 7 - breaks the >= following window for 6? right=2 needs 7,8
    ]);
    // bars 6 and 7: index 6 swing-high right window needs indices 7..8, only 7
    // exists so isSwingHighAtIndex requires index <= length - right - 1.
    const highs = findSwingHighs(bars, { left: 2, right: 2 });
    expect(highs.map((point) => point.index)).toEqual([3]);
  });

  test('findSwingLows honors previous-strict/following-non-strict windows', () => {
    const bars = buildBars('2026-01-01', [
      candle(10), // 0
      candle(9), // 1
      candle(10), // 2
      candle(7, 8, 7), // 3 swing low (low[3]=7 < lows 1..2 and <= lows 4..5)
      candle(8), // 4
      candle(9), // 5
      candle(11)
    ]);
    const lows = findSwingLows(bars, { left: 2, right: 2 });
    expect(lows.map((point) => point.index)).toEqual([3]);
    expect(lows[0].price).toBe(7);
    expect(isSwingHighAtIndex(bars, 3, 2, 2)).toBe(false);
    expect(isSwingLowAtIndex(bars, 3, 2, 2)).toBe(true);
  });
});

describe('detectBaseStart', () => {
  // Builds a run-up from 50 to 100 (base start at index 60) followed by a base
  // whose session highs never exceed the base start high by >5%, ending at
  // endIndex = 106 (D-1). Base duration = 107 - 60 = 47 sessions.
  function build47SessionBaseScenario() {
    const rows = [];
    const baseStartIndex = 60;
    const d1Index = 106;
    for (let i = 0; i < baseStartIndex; i += 1) {
      // Monotonic climb ending just below the base start high (top ~98.7 at
      // index 59) so the ONLY pre-base swing high candidate is index 60 with
      // high 100 (no earlier pullbacks => no earlier structural swing highs).
      const close = 50 + (48.5 * i) / (baseStartIndex - 1);
      rows.push(candle(close));
    }
    // Base start session high = 100.
    rows.push(candle(99.5, 100, 97));
    // 46 further base sessions below the base start high (total 47 sessions
    // from base start through D-1).
    for (let i = 0; i < 46; i += 1) {
      const close = 96 + (i % 5) * 0.7;
      rows.push(candle(close, close + 1.5, close - 1));
    }
    return buildBars('2026-01-01', rows);
  }

  test('detects the earliest qualifying candidate without truncating a 47-session base', () => {
    const bars = build47SessionBaseScenario();
    const endIndex = 106;
    const detected = detectBaseStart({ bars, endIndex, parameters: BASE_START_PARAMS });
    expect(detected).not.toBeNull();
    expect(detected.index).toBe(60);
    // A truncated "40 session" candidate would be at 66/67; assert the real
    // 47-session base start is returned and would compute as 47 sessions.
    expect(endIndex - detected.index + 1).toBe(47);
  });

  test('returns null when no candidate qualifies inside the allowance', () => {
    const rows = [
      candle(10), candle(12), candle(11), candle(20, 20, 18),
      candle(24, 24, 22), candle(28, 28, 26)
    ];
    const bars = buildBars('2026-01-01', rows);
    // Index 3 is a swing high but subsequent high (28) > 20 * 1.05.
    const detected = detectBaseStart({ bars, endIndex: 5, parameters: BASE_START_PARAMS });
    expect(detected).toBeNull();
  });

  test('honors the detection lookback horizon', () => {
    const rows = [candle(10), candle(12), candle(11), candle(20, 20, 18), candle(19), candle(18)];
    const bars = buildBars('2026-01-01', rows);
    // Swing high at index 3 is 40 sessions before endIndex? No - only 6 bars;
    // lookback=2 means index 3 is outside [4-2, 4].
    const detected = detectBaseStart({
      bars,
      endIndex: 4,
      parameters: { ...BASE_START_PARAMS, detection_lookback: 2 }
    });
    expect(detected).toBeNull();
  });
});

describe('detectPivot', () => {
  // Base range [baseStart, baseEnd]. Resistance level ~100 is touched by three
  // structural swing highs at indices 6, 16, 26 (26 within the final 10-session
  // recent window when baseEnd = 30). A second lower cluster sits around 96.
  function buildPivotScenario() {
    const rows = [];
    const baseStartIndex = 3;
    const baseEndIndex = 30;
    for (let i = 0; i < baseStartIndex; i += 1) {
      const close = 80 + i * 6;
      rows.push(candle(close));
    }
    for (let i = 0; i <= baseEndIndex - baseStartIndex; i += 1) {
      const touch = [6, 16, 26].includes(i + baseStartIndex);
      const lowTouch = [10, 22].includes(i + baseStartIndex);
      if (touch) {
        rows.push(candle(98.5, 100, 96)); // structural high at 100
      } else if (lowTouch) {
        rows.push(candle(94.5, 96.5, 92)); // structural high at 96.5
      } else {
        rows.push(candle(95 + (i % 3), 97 + (i % 2), 92 + (i % 4)));
      }
    }
    return buildBars('2026-01-01', rows);
  }

  test('selects the highest qualifying resistance cluster and highest high', () => {
    const bars = buildPivotScenario();
    const detection = detectPivot({
      bars,
      rangeStartIndex: 3,
      rangeEndIndex: 30,
      parameters: PIVOT_PARAMS
    });
    expect(detection).not.toBeNull();
    expect(detection.method).toBe('cluster');
    expect(detection.confidence).toBe('high');
    expect(detection.pivot.price).toBe(100);
  });

  test('falls back to the highest recent structural high when no cluster qualifies', () => {
    const bars = buildPivotScenario();
    const detection = detectPivot({
      bars,
      rangeStartIndex: 25,
      rangeEndIndex: 30,
      parameters: { ...PIVOT_PARAMS, minimum_touches: 4 }
    });
    expect(detection).not.toBeNull();
    expect(detection.method).toBe('recent_swing_high');
    expect(detection.confidence).toBe('medium');
  });

  test('falls back to the highest daily high in the final window when no structural high exists', () => {
    const rows = [candle(10), candle(20, 22, 18), candle(21, 23, 20), candle(22, 25, 21)];
    const bars = buildBars('2026-01-01', rows);
    const detection = detectPivot({
      bars,
      rangeStartIndex: 1,
      rangeEndIndex: 3,
      parameters: PIVOT_PARAMS
    });
    expect(detection).not.toBeNull();
    expect(detection.method).toBe('recent_daily_high');
    expect(detection.confidence).toBe('low');
    expect(detection.pivot.price).toBe(25);
  });

  test('returns null for an empty/inverted range', () => {
    const bars = buildBars('2026-01-01', [candle(10), candle(11), candle(12)]);
    expect(detectPivot({ bars, rangeStartIndex: 2, rangeEndIndex: 1, parameters: PIVOT_PARAMS })).toBeNull();
    expect(detectPivot({ bars: [], rangeStartIndex: 0, rangeEndIndex: 2, parameters: PIVOT_PARAMS })).toBeNull();
  });

  test('buildClusters groups highs within tolerance below the anchor', () => {
    const highs = [
      { index: 0, price: 100 },
      { index: 1, price: 99 },
      { index: 2, price: 98.5 },
      { index: 3, price: 96 }
    ];
    const clusters = buildClusters(highs, 1);
    expect(clusters).toHaveLength(3);
    expect(clusters[0].members).toHaveLength(2); // 100 + 99
    expect(new Set(clusters[0].members.map((member) => member.price))).toEqual(new Set([99, 100]));
  });
});

describe('resolveSetupBoundary', () => {
  test('returns the first session after the base start trading above the pivot and its D-1', () => {
    const bars = buildBars('2026-01-01', [
      candle(95, 98, 92), // baseStart (index 0) high 98 <= pivot
      candle(96, 97, 93), // index 1
      candle(97, 99, 94), // index 2 high 99 > 98.5 => resolution
      candle(110, 111, 105), // index 3 (entry day is later - late entry)
      candle(112, 113, 108) // index 4
    ]);
    const boundary = resolveSetupBoundary({
      bars,
      baseStartIndex: 0,
      pivotPrice: 98.5,
      upperBoundIndex: 4
    });
    expect(boundary).toEqual({ resolutionIndex: 2, baseEndIndex: 1 });
  });

  test('a later actual entry does not shift the resolution (late entry regression)', () => {
    const bars = buildBars('2026-01-01', [
      candle(95, 98, 92), // baseStart (index 0)
      candle(96, 97, 93), // index 1 base
      candle(96.5, 97.5, 94), // index 2 base
      candle(103, 105, 101), // index 3 breakout (resolution)
      candle(108, 110, 106), // index 4
      candle(112, 114, 110) // index 5 = actual (late) entry session
    ]);
    const boundary = resolveSetupBoundary({
      bars,
      baseStartIndex: 0,
      pivotPrice: 100,
      upperBoundIndex: 5
    });
    expect(boundary.resolutionIndex).toBe(3);
    expect(boundary.baseEndIndex).toBe(2);
  });

  test('returns null when no session traded above the pivot through the upper bound', () => {
    const bars = buildBars('2026-01-01', [
      candle(95, 98, 92),
      candle(96, 97, 93),
      candle(99, 99.5, 95)
    ]);
    const boundary = resolveSetupBoundary({
      bars,
      baseStartIndex: 0,
      pivotPrice: 120,
      upperBoundIndex: 2
    });
    expect(boundary).toBeNull();
  });
});

// Point-in-time regression coverage: swing-point right-window confirmation
// must be bounded by the detector's observation end (D-1 / range end). Bars
// after that bound can never confirm or disqualify a swing point.
describe('bounded swing detection (no post-D-1 right-window confirmation)', () => {
  const DETECT_PARAMS = {
    detection_lookback: 60,
    swing_high_left: 3,
    swing_high_right: 3,
    max_post_high_advance_pct: 5
  };

  test('the bounded index predicates require every right-window bar to lie at or before maxIndex', () => {
    const bars = buildBars('2026-01-01', [
      candle(10), // 0
      candle(20, 22, 19), // 1 swing high candidate (unbounded)
      candle(19), // 2
      candle(18), // 3
      candle(5), // 4 (would confirm candidate 1 when observed)
      candle(30) // 5 (would deny candidate 1 when observed)
    ]);
    // Unbounded (whole array): index 1's right window is bars [2..4] -> high 22
    // >= bars 2..4, so it is a swing high (bar 5 is outside its window).
    expect(isSwingHighAtIndex(bars, 1, 1, 3)).toBe(true);
    // Bounded at index 3: right window would need bars 4..5 -> beyond bound.
    expect(isSwingHighAtIndex(bars, 1, 1, 3, 3)).toBe(false);
    // Bounded at index 4: right window [2..4] all at or before 4.
    expect(isSwingHighAtIndex(bars, 1, 1, 3, 4)).toBe(true);
  });

  test('a candidate whose right window would need bars after D-1 is never a swing high', () => {
    const rows = [];
    for (let i = 0; i < 6; i += 1) rows.push(candle(80 + i * 3)); // climb 0..5
    rows.push(candle(99.5, 100, 97)); // 6 high would only confirm using 9..11
    rows.push(candle(98, 98, 95)); // 7
    rows.push(candle(97, 97, 94)); // 8 D-1
    rows.push(candle(99, 60, 95)); // 9 quiet post-boundary
    rows.push(candle(98, 55, 94)); // 10
    rows.push(candle(99, 50, 95)); // 11
    const bars = buildBars('2026-01-01', rows);
    // The near-end high (index 6) needs bars 9..11 to confirm; under a D-1
    // bound of 8 it is NOT a swing high, so no Base Start is proposed.
    expect(isSwingHighAtIndex(bars, 6, 3, 3)).toBe(true); // unbounded view
    expect(isSwingHighAtIndex(bars, 6, 3, 3, 8)).toBe(false); // bounded at D-1
    expect(detectBaseStart({ bars, endIndex: 8, parameters: DETECT_PARAMS })).toBeNull();
  });

  test('mutating every bar after the detector endIndex cannot change Base Start detection', () => {
    // Candidate swing high at index 5 whose right window [6..8] lies entirely
    // at or before D-1 (index 8). Bars 9+ must never matter.
    function candidateRows(postHigh) {
      const rows = [];
      for (let i = 0; i < 5; i += 1) rows.push(candle(80 + i * 4)); // climb 0..4
      rows.push(candle(99.5, 100, 97)); // 5 candidate
      rows.push(candle(98, 98, 95)); // 6
      rows.push(candle(97, 97, 94)); // 7
      rows.push(candle(96, 96, 93)); // 8 D-1
      rows.push(candle(98, postHigh, 95)); // 9 post-boundary
      rows.push(candle(97, postHigh + 5, 94)); // 10
      rows.push(candle(99, postHigh + 10, 95)); // 11
      return rows;
    }
    const quiet = buildBars('2026-01-01', candidateRows(60));
    const loud = buildBars('2026-01-01', candidateRows(500));

    const quietDetected = detectBaseStart({ bars: quiet, endIndex: 8, parameters: DETECT_PARAMS });
    const loudDetected = detectBaseStart({ bars: loud, endIndex: 8, parameters: DETECT_PARAMS });
    expect(quietDetected).not.toBeNull();
    expect(quietDetected.index).toBe(5);
    expect(loudDetected).toEqual(quietDetected);
  });

  test('mutating every bar after rangeEndIndex cannot change Pivot detection', () => {
    const baseRows = () => [
      candle(90, 92, 88), // 0
      candle(93, 94, 91), // 1
      candle(99, 100, 97), // 2 structural high (100)
      candle(96, 97, 93), // 3
      candle(95, 96, 92), // 4
      candle(99.5, 100.2, 98), // 5 structural high (100.2)
      candle(96, 97, 93), // 6
      candle(94, 95, 91), // 7 D-1
      candle(98, 101, 95), // 8 post-range
      candle(99, 900, 96) // 9 post-range
    ];
    const params = {
      swing_left: 2,
      swing_right: 2,
      cluster_tolerance_pct: 2,
      minimum_touches: 2,
      recent_touch_window: 10
    };
    const quietBars = buildBars('2026-01-01', baseRows());
    const baseline = detectPivot({ bars: quietBars, rangeStartIndex: 0, rangeEndIndex: 7, parameters: params });
    expect(baseline).not.toBeNull();
    expect(baseline.method).toBe('cluster');

    const mutated = quietBars.map((bar, index) =>
      index > 7 ? { ...bar, open: 1, high: 999, low: 1, close: 990, volume: 9 } : bar
    );
    const after = detectPivot({ bars: mutated, rangeStartIndex: 0, rangeEndIndex: 7, parameters: params });
    expect(after).toEqual(baseline);
  });

  test('pivot fallback stays bounded to the final recent window of the range', () => {
    const bars = buildBars('2026-01-01', [
      candle(10, 20, 9),
      candle(11, 25, 10),
      candle(12, 24, 11),
      candle(13, 23, 12),
      candle(1000, 1001, 999) // post-range high must never become the pivot
    ]);
    const params = {
      swing_left: 2,
      swing_right: 2,
      cluster_tolerance_pct: 2,
      minimum_touches: 2,
      recent_touch_window: 10
    };
    const detection = detectPivot({ bars, rangeStartIndex: 0, rangeEndIndex: 3, parameters: params });
    expect(detection).not.toBeNull();
    expect(detection.method).toBe('recent_daily_high');
    expect(detection.pivot.price).toBe(25); // highest high within the range
  });
});
