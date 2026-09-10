'use strict';

// Focused unit tests for the Entry criterion evaluators
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 23-31).

const initialStop = require('../../../../src/services/quality/criteria/entry/initialStop');
const stopWidth = require('../../../../src/services/quality/criteria/entry/stopWidth');
const extension = require('../../../../src/services/quality/criteria/entry/extension');
const triggerCompliance = require('../../../../src/services/quality/criteria/entry/triggerCompliance');

const LONG = {
  available: true,
  direction: 'long',
  originalPositionQty: 100,
  entryBasis: 101,
  initialEntryEpoch: 1741600000,
  initialEntryTime: '2026-03-10T13:30:30.000Z'
};

function stop(price) {
  return {
    available: true,
    price,
    source: 'trade_stop_loss_field',
    referenceEpoch: LONG.initialEntryEpoch,
    referenceTime: LONG.initialEntryTime,
    referenceTimeSource: 'initial_entry_time',
    provenance: { source: 'trade_stop_loss_field', limitations: [] }
  };
}

const BUFFER = { available: true, buffer: 0.01, method: 'minimum_tick', value: 1, source: 'us_equity_minimum_increment' };

describe('Initial Stop criterion', () => {
  const base = { criterion: {}, entryEvidence: LONG, stopEvidence: stop(99), buffer: BUFFER };

  test('PASS when the stop is below LOD minus buffer', () => {
    const row = initialStop.evaluate({
      ...base,
      intradayMetrics: { lod: { low: 100.5, lastObservableEpoch: 1, observableBars: 5 }, resolution: '1min' }
    });
    expect(row.status).toBe('PASS');
    expect(row.evidence.required_stop_ceiling).toBeCloseTo(100.49, 12);
  });

  test('FAIL when the stop is above the observable-LOD ceiling', () => {
    const row = initialStop.evaluate({
      ...base,
      intradayMetrics: { lod: { low: 98.0, lastObservableEpoch: 1, observableBars: 5 }, resolution: '1min' }
    });
    expect(row.status).toBe('FAIL');
  });

  test('UNKNOWN when the reference-time LOD cannot be established', () => {
    const row = initialStop.evaluate({
      ...base,
      intradayMetrics: { lod: { low: null, lastObservableEpoch: null, observableBars: 0 }, resolution: '1min' }
    });
    expect(row.status).toBe('UNKNOWN');
  });

  test('UNKNOWN when no actual stop is stored', () => {
    const row = initialStop.evaluate({
      ...base,
      stopEvidence: { available: false, reason: 'none' },
      intradayMetrics: { lod: { low: 100.5 } }
    });
    expect(row.status).toBe('UNKNOWN');
  });
});

describe('Stop Width criterion', () => {
  const criterion = { parameters: { volatility_method: 'ADR', period: 20, maximum_multiple: 1.0 } };
  const volatilityByMethod = { ADR: { available: true, dollars: 4, pct: 0.04, sessions: [] }, ATR: { available: true, dollars: 3 } };

  test('ratio is StopWidth / ADR$ with profile scoring', () => {
    const row = stopWidth.evaluate({
      criterion,
      entryEvidence: LONG,
      stopEvidence: stop(99),
      volatilityByMethod
    });
    expect(row.status).toBe('PASS');
    expect(row.scoring_value).toBeCloseTo(0.5, 12);
    expect(row.score).toBeUndefined(); // score is derived by the orchestrator
  });

  test('FAIL when the ratio exceeds maximum_multiple', () => {
    const row = stopWidth.evaluate({
      criterion,
      entryEvidence: LONG,
      stopEvidence: stop(90),
      volatilityByMethod
    });
    expect(row.status).toBe('FAIL');
    expect(row.scoring_value).toBeCloseTo(11 / 4, 12);
  });

  test('UNKNOWN when the volatility reference is unavailable', () => {
    const row = stopWidth.evaluate({
      criterion,
      entryEvidence: LONG,
      stopEvidence: stop(99),
      volatilityByMethod: { ADR: { available: false, reason: 'no history' } }
    });
    expect(row.status).toBe('UNKNOWN');
  });
});

describe('Entry Extension criterion', () => {
  const criterion = { parameters: { primary_normalization: 'ADR', hard_maximum: 'disabled' } };
  const volatilityByMethod = { ADR: { available: true, dollars: 4, period: 20 }, ATR: { available: true, dollars: 3 } };
  const setupContext = { confirmedPivot: 100 };

  test('(EntryBasis - EffectiveTrigger) / ADR$ is the primary normalization', () => {
    const row = extension.evaluate({
      criterion,
      entryEvidence: LONG,
      setupContext,
      triggerResolution: { effectiveTrigger: 100 },
      volatilityByMethod
    });
    expect(row.status).toBe('PASS');
    expect(row.scoring_value).toBeCloseTo(0.25, 12);
    expect(row.evidence.trigger_extension_pct).toBeCloseTo(1, 12);
    expect(row.evidence.pivot_extension_pct).toBeCloseTo(1, 12);
  });

  test('a configured hard maximum adds a compliance FAIL, disabled does not', () => {
    const violated = extension.evaluate({
      criterion: { parameters: { primary_normalization: 'ADR', hard_maximum: 0.2 } },
      entryEvidence: LONG,
      setupContext,
      triggerResolution: { effectiveTrigger: 100 },
      volatilityByMethod
    });
    expect(violated.status).toBe('FAIL');
  });

  test('later-session range/volume metrics never influence extension', () => {
    const first = extension.evaluate({
      criterion,
      entryEvidence: LONG,
      setupContext,
      triggerResolution: { effectiveTrigger: 100 },
      volatilityByMethod
    });
    const second = extension.evaluate({
      criterion,
      entryEvidence: LONG,
      setupContext,
      triggerResolution: { effectiveTrigger: 100 },
      volatilityByMethod,
      intradayMetrics: { rangePace: { today: 999 }, volumePace: { today: 999 } }
    });
    expect(second.scoring_value).toBe(first.scoring_value);
  });
});

describe('Trigger Compliance criterion', () => {
  test('maps the resolved trigger status and keeps evidence', () => {
    const pass = triggerCompliance.evaluate({
      triggerResolution: { status: 'PASS', effectiveTrigger: 100, evidence: { trigger_type: 'BO-PIVOT' }, reason: 'ok' },
      entryEvidence: LONG
    });
    expect(pass.status).toBe('PASS');
    const unknown = triggerCompliance.evaluate({ triggerResolution: null, entryEvidence: LONG });
    expect(unknown.status).toBe('UNKNOWN');
  });

  test('a short entry is UNKNOWN for canonical long trigger semantics', () => {
    const row = triggerCompliance.evaluate({
      triggerResolution: { status: 'PASS', effectiveTrigger: 100, evidence: {} },
      entryEvidence: { direction: 'short' }
    });
    expect(row.status).toBe('UNKNOWN');
  });
});
