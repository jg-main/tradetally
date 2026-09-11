'use strict';

const partialTiming = require('../../../../src/services/quality/criteria/management/partialTiming');
const partialSizing = require('../../../../src/services/quality/criteria/management/partialSizing');
const prematureReduction = require('../../../../src/services/quality/criteria/management/prematureReduction');
const stopRatchet = require('../../../../src/services/quality/criteria/management/stopRatchet');
const breakevenProtection = require('../../../../src/services/quality/criteria/management/breakevenProtection');
const trailingMA = require('../../../../src/services/quality/criteria/management/trailingMA');
const { CRITERION_STATUS } = require('../../../../src/services/quality/constants');

function baseState(overrides = {}) {
  return {
    direction: 'long',
    entryBasis: 100,
    originalPositionQty: 200,
    initialR: { available: true, r_per_share: 5 },
    daily: { authoritative: true, bars: [], entryIndex: 2, completedThroughIndex: 10, source: 'test', completeness: 'verified', reason: null },
    fills: { available: true, reductions: [], totalReductionQty: 0, positionClosed: false, lastClosingTimeEpoch: null, lastClosingPrice: null, lastClosingSessionDate: null, remainingQty: 200 },
    policy: {
      partialTrigger: { earliest_day: 3, latest_day: 5, minimum_mfe_r: 1 },
      partialTriggerSource: 'partial_timing',
      partialTarget: { target_pct: 50, target_tolerance_pct: 2 },
      partialToleranceSource: 'explicit',
      completionWindow: { sessions: 0, normalized: 'same_session' },
      postPartialDeadlineSessions: 0,
      executionWindowMinutes: 30,
      trailingActivation: 'after_partial',
      trailingActivationSource: 'trailing_ma',
      available: { partialTrigger: true, partialTarget: true, completionWindow: true, postPartialDeadline: true, executionWindow: true, trailing: true }
    },
    quantityUnit: { known: true, unit: 1 },
    tickSize: { known: false, tickSize: null },
    stopHistory: { available: false, reason: 'no stop-order lifecycle' },
    stopExecutionClassification: { available: false },
    partialTrigger: {
      status: 'triggered',
      triggered: true,
      dueDay: 3,
      dueSessionDate: '2026-03-12',
      dueSessionIndex: 2,
      dueSessionCompleted: true,
      firstReachDay: 1,
      boundary: { kind: 'session_open', sessionDate: '2026-03-12', epoch: 100, precision: 'session_open', source: 'session_calendar', orderingKnown: true }
    },
    partialCompletion: {
      completed: true,
      achievedQty: 100,
      achievedFraction: 0.5,
      achievedPct: 50,
      observedQty: 100,
      observedFraction: 0.5,
      sessionsAfterTrigger: 0,
      completionRelation: 'same_after',
      timingOutcome: 'same_trigger_session',
      rounding: { resolved: true, requiredQty: 100, unit: 1, rounded: false }
    },
    partialExit: { closedBeforeDue: false, outcome: 'none', closeSessionDate: null, closeTimeEpoch: null },
    prematureReduction: { outcome: 'none', prematureQty: 0, prematureFraction: 0, excludedQty: 0, ambiguousQty: 0, boundarySessionDate: '2026-03-12', classificationAvailable: false, classificationComplete: false },
    trailing: { activation: 'after_partial', active: true, activationResolved: true, activationSessionIndex: 2, signal: null, signalReason: null, supersession: { outcome: 'none' }, execution: null, executionReason: null },
    be: { deadlineEpoch: 200, nextSessionCloseEpoch: 300 },
    ...overrides
  };
}

describe('partial timing (F3/F7/F9)', () => {
  it('UNKNOWN when Initial R is unavailable', () => {
    expect(partialTiming.evaluate({ managementState: baseState({ initialR: { available: false } }) }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });
  it('UNKNOWN when no partial-trigger policy is configured', () => {
    const s = baseState({ policy: { ...baseState().policy, partialTrigger: null } });
    expect(partialTiming.evaluate({ managementState: s }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });
  it('NOT_APPLICABLE on never_reached, UNKNOWN on pending', () => {
    expect(partialTiming.evaluate({ managementState: baseState({ partialTrigger: { status: 'never_reached' } }) }).status).toBe(CRITERION_STATUS.NOT_APPLICABLE);
    expect(partialTiming.evaluate({ managementState: baseState({ partialTrigger: { status: 'pending' } }) }).status).toBe(CRITERION_STATUS.UNKNOWN);
    expect(partialTiming.evaluate({ managementState: baseState({ partialTrigger: { status: 'insufficient_evidence' } }) }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });
  it('PASS same trigger session and FAIL later', () => {
    expect(partialTiming.evaluate({ managementState: baseState() }).status).toBe(CRITERION_STATUS.PASS);
    const later = baseState({ partialCompletion: { ...baseState().partialCompletion, completed: false, sessionsAfterTrigger: 5, timingOutcome: 'later_or_not_completed' } });
    expect(partialTiming.evaluate({ managementState: later }).status).toBe(CRITERION_STATUS.FAIL);
  });
  it('never PASSes when the target was reached completely before the trigger (F1)', () => {
    const pre = baseState({
      partialCompletion: {
        ...baseState().partialCompletion,
        achievedQty: 200,
        achievedPct: 100,
        sessionsAfterTrigger: 0,
        completionRelation: 'same_before',
        timingOutcome: 'pre_trigger'
      }
    });
    const result = partialTiming.evaluate({ managementState: pre });
    expect(result.status).toBe(CRITERION_STATUS.FAIL);
    expect(result.scoring_value).toBe('later_or_not_completed');
  });
  it('never PASSes on a negative sessionsAfterTrigger', () => {
    const negative = baseState({
      partialCompletion: { ...baseState().partialCompletion, sessionsAfterTrigger: -1, completionRelation: 'before_session', timingOutcome: 'pre_trigger' }
    });
    expect(partialTiming.evaluate({ managementState: negative }).status).toBe(CRITERION_STATUS.FAIL);
  });
  it('is UNKNOWN when same-session ordering relative to the crossing cannot be established', () => {
    const unknown = baseState({
      partialCompletion: { ...baseState().partialCompletion, sessionsAfterTrigger: 0, completionRelation: 'same_unknown', timingOutcome: 'unknown_ordering' }
    });
    expect(partialTiming.evaluate({ managementState: unknown }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });
  it('honours a next-session completion window', () => {
    const s = baseState({
      policy: { ...baseState().policy, completionWindow: { sessions: 1, normalized: 'next_session' } },
      partialCompletion: { ...baseState().partialCompletion, sessionsAfterTrigger: 1, timingOutcome: 'next_session' }
    });
    expect(partialTiming.evaluate({ managementState: s }).status).toBe(CRITERION_STATUS.PASS);
  });
  it('superseded: protective => N/A, ambiguous => UNKNOWN, discretionary => FAIL', () => {
    expect(partialTiming.evaluate({ managementState: baseState({ partialExit: { outcome: 'superseded_protective' } }) }).status).toBe(CRITERION_STATUS.NOT_APPLICABLE);
    expect(partialTiming.evaluate({ managementState: baseState({ partialExit: { outcome: 'superseded_ambiguous' } }) }).status).toBe(CRITERION_STATUS.UNKNOWN);
    expect(partialTiming.evaluate({ managementState: baseState({ partialExit: { outcome: 'superseded_discretionary' } }) }).status).toBe(CRITERION_STATUS.FAIL);
  });
});

describe('partial sizing (F1/F8/F9)', () => {
  it('PASS within tolerance and FAIL outside', () => {
    expect(partialSizing.evaluate({ managementState: baseState() }).status).toBe(CRITERION_STATUS.PASS);
    const far = baseState({ partialCompletion: { ...baseState().partialCompletion, achievedPct: 20 } });
    expect(partialSizing.evaluate({ managementState: far }).status).toBe(CRITERION_STATUS.FAIL);
  });
  it('UNKNOWN when the tolerance cannot be resolved', () => {
    const s = baseState({ policy: { ...baseState().policy, partialTarget: { target_pct: 50, target_tolerance_pct: null } } });
    expect(partialSizing.evaluate({ managementState: s }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });
  it('UNKNOWN when quantity rounding is unresolved', () => {
    const s = baseState({ partialCompletion: { ...baseState().partialCompletion, rounding: { resolved: false, reason: 'quantity_unit_unknown' } } });
    expect(partialSizing.evaluate({ managementState: s }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });
});

describe('no premature reduction (F4)', () => {
  it('PASS with none, UNKNOWN with ambiguous, FAIL with discretionary', () => {
    expect(prematureReduction.evaluate({ managementState: baseState() }).status).toBe(CRITERION_STATUS.PASS);
    const ambiguous = baseState({ prematureReduction: { outcome: 'ambiguous', ambiguousQty: 40, boundarySessionDate: '2026-03-12' } });
    expect(prematureReduction.evaluate({ managementState: ambiguous }).status).toBe(CRITERION_STATUS.UNKNOWN);
    const discretionary = baseState({ prematureReduction: { outcome: 'discretionary', prematureQty: 40, prematureFraction: 0.2, boundarySessionDate: '2026-03-12' } });
    const result = prematureReduction.evaluate({ managementState: discretionary });
    expect(result.status).toBe(CRITERION_STATUS.FAIL);
    expect(result.scoring_value).toBeCloseTo(0.2);
  });
});

describe('stop ratchet (F8)', () => {
  it('UNKNOWN without stop history', () => {
    expect(stopRatchet.evaluate({ criterion: { parameters: { downward_tolerance_ticks: 0 } }, managementState: baseState() }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });
  it('UNKNOWN when a positive tolerance needs a missing tick', () => {
    const s = baseState({
      stopHistory: { available: true, modifications: [{ epoch: 1, price: 69 }, { epoch: 2, price: 68 }] },
      tickSize: { known: false, tickSize: null }
    });
    expect(stopRatchet.evaluate({ criterion: { parameters: { downward_tolerance_ticks: 1 } }, managementState: s }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });
  it('FAIL on a downward move and PASS when non-decreasing (zero tolerance, no tick needed)', () => {
    const down = baseState({ stopHistory: { available: true, modifications: [{ epoch: 1, price: 71 }, { epoch: 2, price: 70.5 }] } });
    expect(stopRatchet.evaluate({ criterion: { parameters: { downward_tolerance_ticks: 0 } }, managementState: down }).status).toBe(CRITERION_STATUS.FAIL);
    const up = baseState({ stopHistory: { available: true, modifications: [{ epoch: 1, price: 69 }, { epoch: 2, price: 71 }] } });
    expect(stopRatchet.evaluate({ criterion: { parameters: { downward_tolerance_ticks: 0 } }, managementState: up }).status).toBe(CRITERION_STATUS.PASS);
  });
});

describe('post-partial breakeven', () => {
  it('N/A on never_reached, UNKNOWN without stop history, PASS when reached', () => {
    expect(breakevenProtection.evaluate({ managementState: baseState({ partialTrigger: { status: 'never_reached' } }) }).status).toBe(CRITERION_STATUS.NOT_APPLICABLE);
    expect(breakevenProtection.evaluate({ managementState: baseState() }).status).toBe(CRITERION_STATUS.UNKNOWN);
    const s = baseState({
      partialCompletion: { ...baseState().partialCompletion, completionTimeEpoch: 100 },
      stopHistory: { available: true, modifications: [{ epoch: 50, price: 90 }, { epoch: 150, price: 100 }] }
    });
    expect(breakevenProtection.evaluate({ managementState: s }).status).toBe(CRITERION_STATUS.PASS);
  });
});

describe('trailing MA (F5/F6)', () => {
  const criterion = { parameters: { allowed_periods: [10, 20], execution_window_minutes: 30 } };

  it('UNKNOWN when activation is unresolved, N/A when inactive, UNKNOWN when no period', () => {
    expect(trailingMA.evaluate({ criterion, managementState: baseState({ trailing: { activation: 'explicit', active: false, activationResolved: false } }), userInputs: { trailing_ma_period: 20 } }).status).toBe(CRITERION_STATUS.UNKNOWN);
    expect(trailingMA.evaluate({ criterion, managementState: baseState({ trailing: { activation: 'after_partial', active: false, activationResolved: true, inactiveReason: 'partial_never_triggered' } }), userInputs: { trailing_ma_period: 20 } }).status).toBe(CRITERION_STATUS.NOT_APPLICABLE);
    expect(trailingMA.evaluate({ criterion, managementState: baseState(), userInputs: {} }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });

  it('N/A for a proven protective supersession, UNKNOWN for an ambiguous one', () => {
    const protective = baseState({ trailing: { ...baseState().trailing, signal: null, supersession: { outcome: 'superseded_protective' } } });
    expect(trailingMA.evaluate({ criterion, managementState: protective, userInputs: { trailing_ma_period: 20 } }).status).toBe(CRITERION_STATUS.NOT_APPLICABLE);
    const ambiguous = baseState({ trailing: { ...baseState().trailing, signal: null, supersession: { outcome: 'superseded_ambiguous' } } });
    expect(trailingMA.evaluate({ criterion, managementState: ambiguous, userInputs: { trailing_ma_period: 20 } }).status).toBe(CRITERION_STATUS.UNKNOWN);
  });

  it('PASS within window and FAIL otherwise', () => {
    const signal = { sessionIndex: 4, date: '2026-03-13', close: 99, sma: 100 };
    const pass = baseState({ trailing: { ...baseState().trailing, signal, execution: { outcome: 'within_window' } } });
    expect(trailingMA.evaluate({ criterion, managementState: pass, userInputs: { trailing_ma_period: 20 } }).status).toBe(CRITERION_STATUS.PASS);
    const fail = baseState({ trailing: { ...baseState().trailing, signal, execution: { outcome: 'later_or_ignored' } } });
    const result = trailingMA.evaluate({ criterion, managementState: fail, userInputs: { trailing_ma_period: 20 } });
    expect(result.status).toBe(CRITERION_STATUS.FAIL);
    expect(result.scoring_value).toBe('later_or_ignored');
  });
});

describe('independent corridor bounds — criterion outcome (F1)', () => {
  it('premarket completion with a known corridor start => Partial Timing FAIL (pre_trigger)', () => {
    const s = baseState({
      partialCompletion: {
        ...baseState().partialCompletion,
        sessionsAfterTrigger: 0,
        completionRelation: 'same_before',
        timingOutcome: 'pre_trigger'
      }
    });
    const r = partialTiming.evaluate({ managementState: s });
    expect(r.status).toBe(CRITERION_STATUS.FAIL);
    expect(r.scoring_value).toBe('later_or_not_completed');
  });

  it('trusted discretionary premarket reduction => No Premature Reduction FAIL with before-boundary evidence', () => {
    const s = baseState({
      prematureReduction: {
        outcome: 'discretionary',
        prematureQty: 40,
        prematureFraction: 0.2,
        beforeBoundaryQty: 40,
        unknownOrderingQty: 0,
        boundarySessionDate: '2026-03-12'
      }
    });
    const r = prematureReduction.evaluate({ managementState: s });
    expect(r.status).toBe(CRITERION_STATUS.FAIL);
    expect(r.evidence.before_boundary_qty).toBe(40);
  });

  it('unclassified premarket reduction => UNKNOWN but the pre-trigger relation is recorded', () => {
    const s = baseState({
      prematureReduction: {
        outcome: 'ambiguous',
        ambiguousQty: 40,
        beforeBoundaryQty: 40,
        unknownOrderingQty: 0,
        boundarySessionDate: '2026-03-12'
      }
    });
    const r = prematureReduction.evaluate({ managementState: s });
    expect(r.status).toBe(CRITERION_STATUS.UNKNOWN);
    expect(r.evidence.before_boundary_qty).toBe(40);
    expect(r.evidence.unknown_ordering_qty).toBe(0);
  });
});
