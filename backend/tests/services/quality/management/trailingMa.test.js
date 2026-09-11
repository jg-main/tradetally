'use strict';

const {
  smaAt,
  smaSeries,
  findTrailingSignal,
  classifyTrailingExecution
} = require('../../../../src/services/quality/management/trailingMa');

// Bars with the given closes (ascending session dates). OHLC prices are
// fabricated valid; only `close` matters for SMA/signal logic.
function barsWithCloses(closes, { startDay = 2 } = {}) {
  return closes.map((close, i) => ({
    date: `2026-03-${String(startDay + i).padStart(2, '0')}`,
    time: 1740000000 + i * 86400,
    open: close,
    high: close,
    low: close,
    close,
    volume: 1000
  }));
}

describe('smaAt / smaSeries', () => {
  it('computes the simple moving average of closes ending at the index', () => {
    const bars = barsWithCloses([10, 20, 30, 40, 50]);
    expect(smaAt(bars, 4, 3)).toBeCloseTo(40); // (30+40+50)/3
    expect(smaAt(bars, 2, 2)).toBeCloseTo(25); // (20+30)/2
  });

  it('returns null when the window is incomplete', () => {
    const bars = barsWithCloses([10, 20]);
    expect(smaAt(bars, 0, 3)).toBeNull();
    expect(smaAt(bars, 1, 3)).toBeNull();
  });

  it('skips indices where the SMA is not yet computable', () => {
    const bars = barsWithCloses([10, 20, 30, 40]);
    const series = smaSeries(bars, 3, 0);
    expect(series[0].sessionIndex).toBe(2);
    expect(series[0].sma).toBeCloseTo(20);
  });
});

describe('findTrailingSignal', () => {
  it('signals the first completed close strictly below the selected MA', () => {
    // closes: 10,11,12,13,14 -> SMA5 rising; make close[5]=9 (below).
    const bars = barsWithCloses([10, 11, 12, 13, 14, 9]);
    const signal = findTrailingSignal(bars, 5, 0);
    expect(signal).not.toBeNull();
    expect(signal.sessionIndex).toBe(5);
    expect(signal.close).toBe(9);
  });

  it('treats equality as HOLD (not exit)', () => {
    // closes exactly equal to SMA at the candidate index does not signal.
    const bars = barsWithCloses([10, 10, 10, 10, 10]);
    // SMA5 = 10 at every index; close == SMA -> HOLD.
    const signal = findTrailingSignal(bars, 5, 0);
    expect(signal).toBeNull();
  });

  it('ignores the non-selected MA (a close below SMA10 but above SMA20 does not signal SMA20)', () => {
    // A peak-and-decline series: the fast MA (10) crosses below the close
    // before the slow MA (20), so SMA10 signals before SMA20. Selecting SMA20
    // means the earlier SMA10 crossing is irrelevant.
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const bars = barsWithCloses(closes);

    const signal10 = findTrailingSignal(bars, 10, 0);
    const signal20 = findTrailingSignal(bars, 20, 0);
    expect(signal10).not.toBeNull();
    expect(signal20).not.toBeNull();
    // SMA10 (non-selected) crosses first; SMA20 (selected) crosses later.
    expect(signal10.sessionIndex).toBeLessThan(signal20.sessionIndex);
  });
});

describe('classifyTrailingExecution', () => {
  const regularSessionBounds = (date) => ({
    date,
    openEpoch: 1740000000,
    closeEpoch: 1740000000 + 6.5 * 3600
  });

  const signal = { sessionIndex: 4, date: '2026-03-06' };
  const bars = barsWithCloses([10, 10, 10, 10, 10, 10, 10, 10, 10, 10]);

  it('scores exit within the first 30 minutes of the next session', () => {
    const result = classifyTrailingExecution({
      signal,
      bars,
      actualExitEpoch: 1740000000 + 10 * 60,
      regularSessionBounds,
      executionWindowMinutes: 30
    });
    expect(result.outcome).toBe('within_window');
  });

  it('scores exit later in the same next session', () => {
    const result = classifyTrailingExecution({
      signal,
      bars,
      actualExitEpoch: 1740000000 + 2 * 3600,
      regularSessionBounds,
      executionWindowMinutes: 30
    });
    expect(result.outcome).toBe('later_same_next_session');
  });

  it('scores exit one additional session late', () => {
    // second-next session close is 6.5h later in our mock only once; use a
    // bounds function that advances the day so "one session late" applies.
    const advancingBounds = (date) => {
      const day = Number(date.slice(-2));
      const base = 1740000000 + (day - 6) * 86400;
      return { date, openEpoch: base, closeEpoch: base + 6.5 * 3600 };
    };
    const result = classifyTrailingExecution({
      signal: { sessionIndex: 4, date: '2026-03-06' },
      bars,
      actualExitEpoch: 1740000000 + 2 * 86400 + 3600, // second-next session morning
      regularSessionBounds: advancingBounds,
      executionWindowMinutes: 30
    });
    expect(result.outcome).toBe('one_session_late');
  });

  it('scores a much later exit as later_or_ignored', () => {
    const advancingBounds = (date) => {
      const day = Number(date.slice(-2));
      const base = 1740000000 + (day - 6) * 86400;
      return { date, openEpoch: base, closeEpoch: base + 6.5 * 3600 };
    };
    const result = classifyTrailingExecution({
      signal: { sessionIndex: 4, date: '2026-03-06' },
      bars,
      actualExitEpoch: 1740000000 + 5 * 86400,
      regularSessionBounds: advancingBounds,
      executionWindowMinutes: 30
    });
    expect(result.outcome).toBe('later_or_ignored');
  });
});
