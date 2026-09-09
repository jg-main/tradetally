'use strict';

const { normalizeDailyBars } = require('../../../src/services/quality/dailyEvidence');
const { evaluate } = require('../../../src/services/quality/criteria/setup/volumeContraction');
const { buildBars, candle } = require('./barFactory');

function raw(date, { open, high, low, close, volume }) {
  return { time: Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000), open, high, low, close, volume };
}

describe('normalizeDailyBars mathematical validity', () => {
  test('drops inverted OHLC bars (high < low, high < close, low > open)', () => {
    const bars = normalizeDailyBars([
      raw('2026-01-05', { open: 10, high: 8, low: 7, close: 9, volume: 100 }), // high < low
      raw('2026-01-06', { open: 10, high: 12, low: 9, close: 13, volume: 100 }), // close > high
      raw('2026-01-07', { open: 11, high: 12, low: 10, close: 10.5, volume: 100 }), // valid
      raw('2026-01-08', { open: 11, high: 13, low: 10.5, close: 12, volume: 100 }), // valid
      raw('2026-01-09', { open: 10, high: 12, low: 9, close: 9.5, volume: 100 }) // valid
    ]);
    expect(bars.map((bar) => bar.date)).toEqual(['2026-01-07', '2026-01-08', '2026-01-09']);
  });

  test('drops non-positive price bars', () => {
    const bars = normalizeDailyBars([
      raw('2026-01-05', { open: 0, high: 10, low: 0, close: 5, volume: 100 }),
      raw('2026-01-06', { open: 10, high: 10, low: -1, close: 5, volume: 100 }),
      raw('2026-01-07', { open: 5, high: 6, low: 4, close: 5, volume: 100 })
    ]);
    expect(bars.map((bar) => bar.date)).toEqual(['2026-01-07']);
  });

  test('negative/non-finite volume becomes null and never invalidates the price bar', () => {
    const bars = normalizeDailyBars([
      raw('2026-01-05', { open: 10, high: 12, low: 9, close: 11, volume: -500 }),
      raw('2026-01-06', { open: 10, high: 12, low: 9, close: 11, volume: NaN }),
      raw('2026-01-07', { open: 10, high: 12, low: 9, close: 11, volume: 300 })
    ]);
    expect(bars).toHaveLength(3);
    expect(bars[0].volume).toBeNull();
    expect(bars[1].volume).toBeNull();
    expect(bars[2].volume).toBe(300);
  });

  test('valid null-volume bar still supports price criteria (volume stays null)', () => {
    const bars = normalizeDailyBars([
      raw('2026-01-05', { open: 10, high: 12, low: 9, close: 11, volume: null })
    ]);
    expect(bars).toHaveLength(1);
    expect(bars[0].close).toBe(11);
    expect(bars[0].volume).toBeNull();
  });
});

describe('volumeContraction rejects unusable volume (defense in depth)', () => {
  const CONFIG = {
    parameters: { recent_window: 2, prior_window: 2, maximum_ratio: 0.7, require_full_windows: true }
  };

  test('a negative recent volume yields UNKNOWN, never a negative-ratio PASS', () => {
    const rows = [];
    for (let i = 0; i < 4; i += 1) {
      rows.push(candle(95, 97, 93, i === 3 ? -100 : 5000));
    }
    const bars = buildBars('2026-01-01', rows);
    const result = evaluate({
      criterion: CONFIG,
      setup: { baseStart: { index: 0 }, baseEnd: { index: 3 } },
      bars
    });
    expect(result.status).toBe('UNKNOWN');
    expect(result.scoring_value).toBeNull();
  });
});
