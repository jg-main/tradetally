'use strict';

const {
  smaAt,
  smaSeries,
  findTrailingSignal,
  classifyTrailingExecution
} = require('../../../../src/services/quality/management/trailingMa');

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
    expect(smaAt(bars, 4, 3)).toBeCloseTo(40);
    expect(smaAt(bars, 2, 2)).toBeCloseTo(25);
  });
  it('returns null when the window is incomplete', () => {
    const bars = barsWithCloses([10, 20]);
    expect(smaAt(bars, 1, 3)).toBeNull();
  });
  it('skips indices where the SMA is not yet computable', () => {
    const bars = barsWithCloses([10, 20, 30, 40]);
    expect(smaSeries(bars, 3, 0)[0].sessionIndex).toBe(2);
  });
});

describe('findTrailingSignal', () => {
  it('signals the first completed close strictly below the selected MA', () => {
    const bars = barsWithCloses([10, 11, 12, 13, 14, 9]);
    const signal = findTrailingSignal({ bars, period: 5, fromIndex: 0, completedThroughIndex: 5 });
    expect(signal).not.toBeNull();
    expect(signal.sessionIndex).toBe(5);
  });

  it('treats equality as HOLD (not exit)', () => {
    const bars = barsWithCloses([10, 10, 10, 10, 10]);
    expect(findTrailingSignal({ bars, period: 5, fromIndex: 0, completedThroughIndex: 4 })).toBeNull();
  });

  it('never signals from an in-progress (not yet completed) daily bar', () => {
    const bars = barsWithCloses([10, 11, 12, 13, 14, 9]);
    // The 6th bar (index 5) is below the MA but not completed yet.
    expect(findTrailingSignal({ bars, period: 5, fromIndex: 0, completedThroughIndex: 4 })).toBeNull();
    expect(findTrailingSignal({ bars, period: 5, fromIndex: 0, completedThroughIndex: 5 })).not.toBeNull();
  });

  it('ignores the non-selected MA (SMA10 crosses before SMA20)', () => {
    const closes = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
      19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const bars = barsWithCloses(closes);
    const through = bars.length - 1;
    const signal10 = findTrailingSignal({ bars, period: 10, fromIndex: 0, completedThroughIndex: through });
    const signal20 = findTrailingSignal({ bars, period: 20, fromIndex: 0, completedThroughIndex: through });
    expect(signal10).not.toBeNull();
    expect(signal20).not.toBeNull();
    expect(signal10.sessionIndex).toBeLessThan(signal20.sessionIndex);
  });

  it('does not evaluate a close below the MA before the activation index', () => {
    // A close below the MA exists at index 5; after activation (index 6) the
    // closes are above the MA, so no signal is produced for activation >= 6.
    const bars = barsWithCloses([10, 11, 12, 13, 14, 9, 30]);
    expect(findTrailingSignal({ bars, period: 5, fromIndex: 5, completedThroughIndex: 6 })).not.toBeNull();
    expect(findTrailingSignal({ bars, period: 5, fromIndex: 6, completedThroughIndex: 6 })).toBeNull();
  });
});

describe('classifyTrailingExecution', () => {
  const nextSession = { date: '2026-03-07', openEpoch: 1000000, closeEpoch: 1000000 + 6.5 * 3600 };
  const secondNextSession = { date: '2026-03-08', openEpoch: 1000000 + 86400, closeEpoch: 1000000 + 86400 + 6.5 * 3600 };

  it('never scores an exit before the next session open as within_window', () => {
    const result = classifyTrailingExecution({
      nextSession, secondNextSession, actualExitEpoch: 999000, executionWindowMinutes: 30
    });
    expect(result.outcome).toBe('later_or_ignored');
    expect(result.beforeNextOpen).toBe(true);
  });

  it('scores exactly at the next session open as within_window', () => {
    const result = classifyTrailingExecution({
      nextSession, secondNextSession, actualExitEpoch: 1000000, executionWindowMinutes: 30
    });
    expect(result.outcome).toBe('within_window');
  });

  it('scores exactly at the configured window boundary as within_window', () => {
    const result = classifyTrailingExecution({
      nextSession, secondNextSession, actualExitEpoch: 1000000 + 30 * 60, executionWindowMinutes: 30
    });
    expect(result.outcome).toBe('within_window');
  });

  it('scores later in the same next session', () => {
    const result = classifyTrailingExecution({
      nextSession, secondNextSession, actualExitEpoch: 1000000 + 2 * 3600, executionWindowMinutes: 30
    });
    expect(result.outcome).toBe('later_same_next_session');
  });

  it('scores one additional session late', () => {
    const result = classifyTrailingExecution({
      nextSession, secondNextSession, actualExitEpoch: 1000000 + 86400 + 3600, executionWindowMinutes: 30
    });
    expect(result.outcome).toBe('one_session_late');
  });

  it('scores much later as later_or_ignored', () => {
    const result = classifyTrailingExecution({
      nextSession, secondNextSession, actualExitEpoch: 1000000 + 5 * 86400, executionWindowMinutes: 30
    });
    expect(result.outcome).toBe('later_or_ignored');
  });

  it('is unresolved without a configured execution window', () => {
    const result = classifyTrailingExecution({
      nextSession, secondNextSession, actualExitEpoch: 1000000, executionWindowMinutes: null
    });
    expect(result.outcome).toBe('later_or_ignored');
    expect(result.reason).toBe('execution_window_unconfigured');
  });
});
