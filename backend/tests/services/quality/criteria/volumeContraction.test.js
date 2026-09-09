'use strict';

const { evaluate } = require('../../../../src/services/quality/criteria/setup/volumeContraction');
const { buildBars, candle } = require('../barFactory');

const CONFIG = {
  parameters: { recent_window: 5, prior_window: 10, maximum_ratio: 0.7, require_full_windows: true }
};

function setup(baseStartIndex, baseEndIndex) {
  return {
    baseStart: { index: baseStartIndex, date: '2026-01-05' },
    baseEnd: { index: baseEndIndex, date: '2026-01-30' }
  };
}

function baseBars(priorVolume, recentVolume) {
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    const volume = i >= 25 ? recentVolume : i >= 15 ? priorVolume : 1_000_000;
    rows.push(candle(95, 97, 93, volume));
  }
  return buildBars('2026-01-01', rows);
}

describe('Setup criterion: volume_contraction', () => {
  test('PASS when recent mean share volume contracts against the prior mean', () => {
    const bars = baseBars(2_000_000, 500_000);
    const result = evaluate({ criterion: CONFIG, setup: setup(0, 29), bars });
    expect(result.status).toBe('PASS');
    expect(result.scoring_value).toBeCloseTo(0.25, 4);
    expect(result.evidence.recent_window.endDate).toBe(bars[29].date); // ends at D-1
    expect(result.evidence.volume_basis).toContain('share volume');
  });

  test('FAIL when volume expands instead of contracting', () => {
    const bars = baseBars(500_000, 2_000_000);
    const result = evaluate({ criterion: CONFIG, setup: setup(0, 29), bars });
    expect(result.status).toBe('FAIL');
    expect(result.scoring_value).toBe(4);
  });

  test('arithmetic mean is used (no winsorizing or spike removal)', () => {
    // Prior window contains a spike; mean must include it: (10+10+10+10+10+10+10+10+10+100)/10 = 19.
    const rows = [];
    for (let i = 0; i < 30; i += 1) {
      let volume = 1_000_000;
      if (i >= 25) volume = 500_000;
      else if (i >= 15) volume = i === 20 ? 100_000_000 : 10_000_000;
      rows.push(candle(95, 97, 93, volume));
    }
    const bars = buildBars('2026-01-01', rows);
    const result = evaluate({ criterion: CONFIG, setup: setup(0, 29), bars });
    const priorMean = 19_000_000;
    const recentMean = 500_000;
    expect(result.scoring_value).toBeCloseTo(recentMean / priorMean, 4);
  });

  test('UNKNOWN when full windows cannot fit inside the base', () => {
    const bars = buildBars('2026-01-01', Array(12).fill(candle(95, 100, 90, 1_000_000)));
    const result = evaluate({ criterion: CONFIG, setup: setup(0, 11), bars });
    expect(result.status).toBe('UNKNOWN');
    expect(result.evidence.reason).toContain('never reach before Base Start');
  });

  test('UNKNOWN when volume is missing/unusable in a window', () => {
    const rows = [];
    for (let i = 0; i < 30; i += 1) {
      if (i === 27) {
        rows.push(candle(95, 97, 93, null));
      } else {
        rows.push(candle(95, 97, 93, 1_000_000));
      }
    }
    const bars = buildBars('2026-01-01', rows);
    const result = evaluate({ criterion: CONFIG, setup: setup(0, 29), bars });
    expect(result.status).toBe('UNKNOWN');
    expect(result.message).toContain('share volume');
  });
});
