'use strict';

const { evaluate } = require('../../../../src/services/quality/criteria/setup/priorMove');
const { buildBars } = require('../barFactory');

const CONFIG = {
  parameters: {
    minimum_pct: 30,
    search_lookback: 60,
    swing_left: 3,
    swing_right: 3,
    selection: 'most_recent_qualifying'
  }
};

function rowFor(low) {
  return [low + 2, low + 6, low, low + 4, 1_000_000];
}

// Bars 0..64 with a monotone decline into a swing low at index 49 (low 60)
// followed by a monotone rise; base start at index 65.
function declineRiseBars() {
  const rows = [];
  for (let i = 0; i < 50; i += 1) {
    const low = 100 - (40 * i) / 49;
    rows.push(rowFor(low));
  }
  for (let i = 50; i <= 75; i += 1) {
    const low = 60 + (i - 49) * 2;
    rows.push(rowFor(low));
  }
  return buildBars('2026-01-01', rows);
}

function setupFor(baseStartIndex) {
  return {
    baseStart: { index: baseStartIndex, date: '2026-01-01' },
    pivot: { price: 100, source: 'user_confirmed' }
  };
}

describe('Setup criterion: prior_move', () => {
  test('PASS using the most recent qualifying structural swing low', () => {
    const bars = declineRiseBars();
    const result = evaluate({ criterion: CONFIG, setup: setupFor(65), bars });
    expect(result.status).toBe('PASS');
    expect(result.evidence.impulse_low_date).toBe(bars[49].date);
    expect(result.evidence.prior_move_pct).toBeCloseTo((100 / 60 - 1) * 100, 2);
    expect(result.scoring_value).toBeCloseTo((100 / 60 - 1) * 100, 2);
    expect(result.evidence.prior_move_duration_sessions).toBe(65 - 49);
  });

  test('FAIL when no structural low reaches the minimum prior move', () => {
    const bars = declineRiseBars();
    const result = evaluate({
      criterion: CONFIG,
      setup: { baseStart: { index: 65, date: '2026-01-01' }, pivot: { price: 75 } },
      bars
    });
    expect(result.status).toBe('FAIL');
    // Evidence never claims a qualifying impulse existed.
    expect(result.evidence.prior_move_pct).toBeNull();
    expect(result.evidence.impulse_low_date).toBeNull();
    // Numeric scoring input derives from the most recent structural low found.
    expect(result.scoring_value).toBeCloseTo((75 / 60 - 1) * 100, 2);
  });

  test('selects the most recent qualifying low, not the older larger move', () => {
    const rows = [];
    // Descent to swing low at index 20 (low 55).
    for (let i = 0; i <= 20; i += 1) {
      rows.push(rowFor(100 - (45 * i) / 20));
    }
    // Rise to ~84 then descend to a second swing low at index 55 (low 68).
    for (let i = 21; i <= 40; i += 1) {
      rows.push(rowFor(58 + ((84 - 58) * (i - 21)) / 19));
    }
    for (let i = 41; i <= 55; i += 1) {
      rows.push(rowFor(84 - ((84 - 68) * (i - 41)) / 14));
    }
    for (let i = 56; i <= 75; i += 1) {
      rows.push(rowFor(70 + (i - 55) * 1.5));
    }
    const bars = buildBars('2026-01-01', rows);
    const result = evaluate({ criterion: CONFIG, setup: setupFor(70), bars });
    expect(result.status).toBe('PASS');
    // Older low (55) gives ~81.8%; the recent qualifying low (68) is chosen.
    expect(result.evidence.impulse_low_date).toBe(bars[55].date);
    expect(result.evidence.impulse_low_price).toBe(68);
    expect(result.scoring_value).toBeCloseTo((100 / 68 - 1) * 100, 2);
  });

  test('UNKNOWN when pre-base history cannot form a structural low', () => {
    const bars = buildBars('2026-01-01', Array(6).fill(rowFor(90)));
    const result = evaluate({ criterion: CONFIG, setup: setupFor(3), bars });
    expect(result.status).toBe('UNKNOWN');
    expect(result.scoring_value).toBeNull();
  });

  test('UNKNOWN when Base Start or Pivot is not confirmed', () => {
    const bars = declineRiseBars();
    const result = evaluate({ criterion: CONFIG, setup: {}, bars });
    expect(result.status).toBe('UNKNOWN');
  });
});
