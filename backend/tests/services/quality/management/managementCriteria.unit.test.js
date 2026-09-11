'use strict';

const partialTiming = require('../../../../src/services/quality/criteria/management/partialTiming');
const partialSizing = require('../../../../src/services/quality/criteria/management/partialSizing');
const prematureReduction = require('../../../../src/services/quality/criteria/management/prematureReduction');
const stopRatchet = require('../../../../src/services/quality/criteria/management/stopRatchet');
const breakevenProtection = require('../../../../src/services/quality/criteria/management/breakevenProtection');
const trailingMA = require('../../../../src/services/quality/criteria/management/trailingMA');

const { CRITERION_STATUS } = require('../../../../src/services/quality/constants');

function state(overrides = {}) {
  return {
    direction: 'long',
    entryBasis: 100,
    originalPositionQty: 200,
    initialR: { available: true, r_per_share: 5 },
    daily: { authoritative: true, bars: [], entryIndex: 2, source: 'test', completeness: 'verified', reason: null },
    fills: { available: true, reductions: [], totalReductionQty: 0, positionClosed: false, lastClosingTimeEpoch: null, lastClosingSessionDate: null, remainingQty: 200 },
    partialTrigger: { triggered: false, reason: 'never_reached_minimum_mfe' },
    partialCompletion: { completed: false, achievedFraction: null, achievedPct: null, timingOutcome: 'later_or_not_completed' },
    prematureReduction: { prematureQty: 0, prematureFraction: 0, excludedQty: 0 },
    stopHistory: { available: false, reason: 'no stop-order lifecycle' },
    trailing: { selectedPeriod: null, signal: null, superseded: false, execution: null },
    be: { deadlineEpoch: null, nextSessionCloseEpoch: null },
    tickSize: 0.01,
    ...overrides
  };
}

const timingCriterion = { key: 'partial_timing', parameters: { earliest_day: 3, latest_day: 5, minimum_mfe_r: 1.0, completion_window: 'same_session' } };
const sizingCriterion = { key: 'partial_sizing', parameters: { target_pct: 50, target_tolerance_pct: 2 } };
const ratchetCriterion = { key: 'stop_ratchet', parameters: { downward_tolerance_ticks: 0 } };
const beCriterion = { key: 'post_partial_breakeven', parameters: { minimum_stop: 'original_entry_basis', deadline: 'same_session' } };
const trailingCriterion = { key: 'trailing_ma', parameters: { allowed_periods: [10, 20], execution_window_minutes: 30 } };

describe('partial timing / sizing — Initial R unavailable', () => {
  it('both become UNKNOWN when Initial R is unavailable', () => {
    const s = state({ initialR: { available: false, r_per_share: null } });
    expect(partialTiming.evaluate({ criterion: timingCriterion, managementState: s }).status).toBe(CRITERION_STATUS.UNKNOWN);
    expect(partialSizing.evaluate({ criterion: sizingCriterion, managementState: s }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });
});

describe('partial timing / sizing / post-BE — NOT_APPLICABLE', () => {
  it('all three are NOT_APPLICABLE when +1R never reached', () => {
    const s = state();
    expect(partialTiming.evaluate({ criterion: timingCriterion, managementState: s }).status).toBe(CRITERION_STATUS.NOT_APPLICABLE);
    expect(partialSizing.evaluate({ criterion: sizingCriterion, managementState: s }).status).toBe(CRITERION_STATUS.NOT_APPLICABLE);
    expect(breakevenProtection.evaluate({ criterion: beCriterion, managementState: s }).status).toBe(CRITERION_STATUS.NOT_APPLICABLE);
  });
});

describe('partial timing', () => {
  it('PASS when completed during the trigger session', () => {
    const s = state({
      partialTrigger: { triggered: true, dueDay: 3, dueSessionDate: '2026-03-05' },
      partialCompletion: { completed: true, achievedPct: 50, timingOutcome: 'same_trigger_session', completionSessionDate: '2026-03-05' }
    });
    const r = partialTiming.evaluate({ criterion: timingCriterion, managementState: s });
    expect(r.status).toBe(CRITERION_STATUS.PASS);
    expect(r.scoring_value).toBe('same_trigger_session');
  });

  it('FAIL when completed later', () => {
    const s = state({
      partialTrigger: { triggered: true, dueDay: 3, dueSessionDate: '2026-03-05' },
      partialCompletion: { completed: true, achievedPct: 50, timingOutcome: 'later_or_not_completed', completionSessionDate: '2026-03-08' }
    });
    expect(partialTiming.evaluate({ criterion: timingCriterion, managementState: s }).status).toBe(CRITERION_STATUS.FAIL);
  });
});

describe('partial sizing', () => {
  it('PASS within tolerance and FAIL outside it', () => {
    const s = state({
      partialTrigger: { triggered: true, dueDay: 3, dueSessionDate: '2026-03-05' },
      partialCompletion: { completed: true, achievedPct: 48, timingOutcome: 'same_trigger_session' }
    });
    expect(partialSizing.evaluate({ criterion: sizingCriterion, managementState: s }).status).toBe(CRITERION_STATUS.PASS);

    const far = state({
      partialTrigger: { triggered: true, dueDay: 3, dueSessionDate: '2026-03-05' },
      partialCompletion: { completed: true, achievedPct: 20, timingOutcome: 'same_trigger_session' }
    });
    expect(partialSizing.evaluate({ criterion: sizingCriterion, managementState: far }).status).toBe(CRITERION_STATUS.FAIL);
  });
});

describe('no premature reduction', () => {
  it('PASS with 0% premature and FAIL with >0%', () => {
    const s = state({ prematureReduction: { prematureQty: 0, prematureFraction: 0, excludedQty: 0 } });
    expect(prematureReduction.evaluate({ criterion: { key: 'no_premature_reduction', parameters: {} }, managementState: s }).status).toBe(CRITERION_STATUS.PASS);

    const p = state({ prematureReduction: { prematureQty: 20, prematureFraction: 0.1, excludedQty: 0 } });
    const r = prematureReduction.evaluate({ criterion: { key: 'no_premature_reduction', parameters: {} }, managementState: p });
    expect(r.status).toBe(CRITERION_STATUS.FAIL);
    expect(r.scoring_value).toBeCloseTo(0.1);
  });

  it('is UNKNOWN when Initial R is unavailable', () => {
    const s = state({ initialR: { available: false } });
    expect(prematureReduction.evaluate({ criterion: { key: 'no_premature_reduction', parameters: {} }, managementState: s }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });
});

describe('stop ratchet', () => {
  it('UNKNOWN when no trustworthy stop history', () => {
    const r = stopRatchet.evaluate({ criterion: ratchetCriterion, managementState: state() });
    expect(r.status).toBe(CRITERION_STATUS.UNKNOWN);
  });

  it('FAIL when a real downward move exists in trustworthy history', () => {
    const s = state({
      stopHistory: {
        available: true,
        source: 'broker',
        modifications: [
          { epoch: 100, price: 69.3 },
          { epoch: 200, price: 71.0 },
          { epoch: 300, price: 70.5 }
        ]
      }
    });
    expect(stopRatchet.evaluate({ criterion: ratchetCriterion, managementState: s }).status).toBe(CRITERION_STATUS.FAIL);
  });

  it('PASS when the history is non-decreasing', () => {
    const s = state({
      stopHistory: {
        available: true,
        source: 'broker',
        modifications: [
          { epoch: 100, price: 69.3 },
          { epoch: 200, price: 71.0 }
        ]
      }
    });
    expect(stopRatchet.evaluate({ criterion: ratchetCriterion, managementState: s }).status).toBe(CRITERION_STATUS.PASS);
  });
});

describe('post-partial breakeven', () => {
  it('UNKNOWN without stop history', () => {
    const s = state({
      partialTrigger: { triggered: true, dueDay: 3, dueSessionDate: '2026-03-05' },
      partialCompletion: { completed: true, completionTimeEpoch: 100 }
    });
    expect(breakevenProtection.evaluate({ criterion: beCriterion, managementState: s }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });

  it('PASS when the stop reaches the entry basis during the same session', () => {
    const s = state({
      partialTrigger: { triggered: true, dueDay: 3, dueSessionDate: '2026-03-05' },
      partialCompletion: { completed: true, completionTimeEpoch: 100 },
      stopHistory: {
        available: true,
        source: 'broker',
        modifications: [
          { epoch: 50, price: 90 },
          { epoch: 150, price: 100 }
        ]
      },
      be: { deadlineEpoch: 200, nextSessionCloseEpoch: 300 }
    });
    const r = breakevenProtection.evaluate({ criterion: beCriterion, managementState: s });
    expect(r.status).toBe(CRITERION_STATUS.PASS);
    expect(r.scoring_value).toBe('same_session_at_or_above_be');
  });
});

describe('trailing MA', () => {
  it('UNKNOWN without a selected period', () => {
    const r = trailingMA.evaluate({ criterion: trailingCriterion, managementState: state(), userInputs: {} });
    expect(r.status).toBe(CRITERION_STATUS.UNKNOWN);
  });

  it('NOT_APPLICABLE when superseded by a protective-stop exit before the signal', () => {
    const s = state({
      daily: { authoritative: true, bars: [], entryIndex: 2 },
      trailing: { selectedPeriod: 20, signal: null, superseded: true, supersededReason: 'position closed before signal', execution: null }
    });
    const r = trailingMA.evaluate({ criterion: trailingCriterion, managementState: s, userInputs: { trailing_ma_period: 20 } });
    expect(r.status).toBe(CRITERION_STATUS.NOT_APPLICABLE);
  });

  it('PASS when exited within the window and FAIL otherwise', () => {
    const signal = { sessionIndex: 4, date: '2026-03-06', close: 99, sma: 100 };
    const pass = state({
      daily: { authoritative: true, bars: [], entryIndex: 2 },
      trailing: { selectedPeriod: 20, signal, superseded: false, execution: { outcome: 'within_window' } }
    });
    expect(trailingMA.evaluate({ criterion: trailingCriterion, managementState: pass, userInputs: { trailing_ma_period: 20 } }).status).toBe(CRITERION_STATUS.PASS);

    const fail = state({
      daily: { authoritative: true, bars: [], entryIndex: 2 },
      trailing: { selectedPeriod: 20, signal, superseded: false, execution: { outcome: 'later_or_ignored' } }
    });
    const r = trailingMA.evaluate({ criterion: trailingCriterion, managementState: fail, userInputs: { trailing_ma_period: 20 } });
    expect(r.status).toBe(CRITERION_STATUS.FAIL);
    expect(r.scoring_value).toBe('later_or_ignored');
  });
});
