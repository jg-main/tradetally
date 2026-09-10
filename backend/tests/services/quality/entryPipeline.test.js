'use strict';

// End-to-end Entry Quality pipeline tests over a synthetic Canonical BO
// scenario. These exercise the modular Entry evaluators against the real
// immutable Canonical BO v1 configuration plus the Phase 1 aggregation engine,
// and lock the point-in-time / no-lookahead guarantees required by the
// Phase 3 milestone.

const { getCanonicalBOConfig } = require('../../../src/services/quality/canonicalBO');
const { aggregateDimension } = require('../../../src/services/quality/aggregation');
const { buildEntryCriterionRows } = require('../../../src/services/quality/entryQualityService');
const { normalizeCriterionRows } = require('../../../src/services/quality/evaluationService');
const { regularSessionBounds } = require('../../../src/services/quality/entry/sessionTime');

const SESSION = '2026-03-10';
const SESSION_BOUNDS = regularSessionBounds(SESSION);
const OPEN = SESSION_BOUNDS.openEpoch;

function intradayBars({ startMinute, count, high, low, volume = 1000 }) {
  const bars = [];
  for (let i = 0; i < count; i += 1) {
    bars.push({
      time: OPEN + (startMinute + i) * 60,
      open: high - 0.2,
      high,
      low,
      close: high - 0.1,
      volume
    });
  }
  return bars;
}

function executionEvidence({ price = 101, minute = 61, session = SESSION, sessionOpen = OPEN } = {}) {
  const epoch = sessionOpen + minute * 60 + 30;
  return {
    available: true,
    direction: 'long',
    provenance: { source: 'executions_jsonb', limitations: [] },
    originalPositionQty: 100,
    entryBasis: price,
    initialEntryEpoch: epoch,
    initialEntryTime: new Date(epoch * 1000).toISOString(),
    actualEntrySession: session,
    firstReductionTime: null,
    fills: [{ timestamp: new Date(epoch * 1000).toISOString(), timestampEpoch: epoch, action: 'buy', quantity: 100, price, source: 'executions_jsonb' }]
  };
}

function resolvedTrigger({ type = 'BO-PIVOT', effectiveTrigger = 100, status = 'PASS' } = {}) {
  return {
    triggerType: type,
    status,
    effectiveTrigger,
    openingRangeHigh: type === 'BO-ORH-60' ? 99 : null,
    triggerValidFrom: OPEN,
    triggerTime: OPEN + 61 * 60,
    triggerCrossNumber: 1,
    minutesAfterFirstTrigger: 0,
    reason: 'test',
    evidence: {
      trigger_type: type,
      confirmed_pivot: 100,
      effective_trigger: effectiveTrigger,
      entry_print_price: 101,
      trigger_cross_number: 1,
      market_evidence_resolution: '1min'
    }
  };
}

function baseContext(overrides = {}) {
  const entryEvidence = overrides.entryEvidence || executionEvidence();
  const volatility = {
    available: true,
    method: 'ADR',
    period: 20,
    dollars: 4,
    pct: 4 / 101,
    atr: null,
    adrPct: 4 / 101,
    sessions: new Array(20).fill({})
  };
  const stopEvidence = overrides.stopEvidence || {
    available: true,
    price: 99,
    source: 'trade_stop_loss_field',
    referenceEpoch: entryEvidence.initialEntryEpoch,
    referenceTime: entryEvidence.initialEntryTime,
    referenceTimeSource: 'initial_entry_time',
    stopEstablishmentTime: null,
    protective: true,
    provenance: { source: 'trade_stop_loss_field', limitations: [] },
    reason: null
  };
  const buffer = overrides.buffer || {
    available: true,
    buffer: 0.01,
    method: 'minimum_tick',
    value: 1,
    source: 'us_equity_minimum_increment',
    reason: null
  };
  const intradayMetrics = overrides.intradayMetrics || {
    entryIntraday: { available: true, resolution: '1min', resolutionSeconds: 60, session: SESSION_BOUNDS },
    session: SESSION_BOUNDS,
    resolution: '1min',
    resolutionSeconds: 60,
    regularSessionOpenEpoch: OPEN,
    lod: { low: 100.5, high: 103, lastObservableEpoch: OPEN + 60 * 60, observableBars: 60 },
    volumePace: { available: true, pace: 1.6, today: 1600, expected: 1000, usableSessions: 20, requiredSessions: 20, referenceCutoffs: [], elapsedSeconds: 3660, cutoffEpoch: entryEvidence.initialEntryEpoch, resolution: '1min' },
    rangePace: { available: true, pace: 1.1, today: 2.5, expected: 2.27, usableSessions: 20, requiredSessions: 20, referenceCutoffs: [], elapsedSeconds: 3660, cutoffEpoch: entryEvidence.initialEntryEpoch, resolution: '1min' },
    rangeAtEntryOverAdr: 0.625
  };

  return {
    setupContext: {
      confirmedPivot: 100,
      breakoutSession: SESSION,
      baseStartDate: '2026-02-10',
      baseEndDate: '2026-03-09',
      resolutionDate: SESSION,
      boundarySource: 'first_daily_high_above_confirmed_pivot'
    },
    entryEvidence,
    triggerResolution: 'triggerResolution' in overrides ? overrides.triggerResolution : resolvedTrigger(),
    volatilityByMethod: {
      ADR: volatility,
      ATR: { ...volatility, method: 'ATR', pct: null, atr: 4 }
    },
    intradayMetrics,
    stopEvidence,
    buffer,
    userInputs: { intended_trigger_type: overrides.intendedTriggerType || 'BO-PIVOT' }
  };
}

function runEntry(config, context) {
  const rows = buildEntryCriterionRows(config.dimensions.entry, context);
  const summary = aggregateDimension(config.dimensions.entry, rows);
  const normalized = normalizeCriterionRows('entry', config.dimensions.entry, { criterionResults: rows });
  const normalizedSummary = aggregateDimension(config.dimensions.entry, normalized);
  return { rows, summary, normalized, normalizedSummary };
}

function rowMap(rows) {
  return new Map(rows.map((row) => [row.key, row]));
}

describe('Entry Quality pipeline (Canonical BO v1)', () => {
  const config = getCanonicalBOConfig();

  test('the healthy synthetic scenario passes every Entry criterion', () => {
    const { rows, summary } = runEntry(config, baseContext());
    for (const row of rows) {
      expect(row.status).toBe('PASS');
    }
    expect(summary.compliance).toBe('PASS');
    expect(summary.coverage).toBe(100);
    expect(summary.score).not.toBeNull();
  });

  test('normalized persistence view matches the authoritative aggregate', () => {
    const { summary, normalizedSummary } = runEntry(config, baseContext());
    expect(normalizedSummary).toEqual(summary);
  });

  test('a late actual entry fails breakout session and does not redefine it', () => {
    const late = baseContext({
      entryEvidence: executionEvidence({ minute: 61, session: '2026-03-11' })
    });
    // executionEvidence helper anchors the session date as given.
    late.entryEvidence.actualEntrySession = '2026-03-11';
    const { rows } = runEntry(config, late);
    const breakout = rowMap(rows).get('breakout_session');
    expect(breakout.status).toBe('FAIL');
    expect(breakout.evidence.breakout_session).toBe(SESSION);
    expect(breakout.evidence.actual_entry_session).toBe('2026-03-11');
  });

  test('the intended trigger cannot be relabelled to improve the grade', () => {
    // Entry at 09:50 ET (before the ORH-60 completion at 10:30) at a price
    // above the pivot: BO-PIVOT passes but BO-ORH-60 is a known FAIL.
    const early = baseContext({
      entryEvidence: executionEvidence({ minute: 20, price: 106 }),
      triggerResolution: resolvedTrigger({ type: 'BO-PIVOT', effectiveTrigger: 100, status: 'PASS' })
    });
    const pivot = rowMap(runEntry(config, early).rows).get('trigger_compliance');
    expect(pivot.status).toBe('PASS');

    const orhContext = baseContext({
      entryEvidence: executionEvidence({ minute: 20, price: 106 }),
      triggerResolution: resolvedTrigger({ type: 'BO-ORH-60', effectiveTrigger: 100, status: 'FAIL' }),
      intendedTriggerType: 'BO-ORH-60'
    });
    const orh = rowMap(runEntry(config, orhContext).rows).get('trigger_compliance');
    expect(orh.status).toBe('FAIL');
  });

  test('missing intraday evidence produces UNKNOWN, never fabricated PASS/FAIL', () => {
    const unavailable = {
      entryIntraday: { available: false, resolution: '1min', resolutionSeconds: 60, session: null, reason: 'no intraday' },
      session: null,
      resolution: '1min',
      resolutionSeconds: 60,
      regularSessionOpenEpoch: null,
      lod: { low: null, high: null, lastObservableEpoch: null, observableBars: 0 },
      volumePace: { available: false, reason: 'no intraday' },
      rangePace: { available: false, reason: 'no intraday' },
      rangeAtEntryOverAdr: null
    };
    const { rows, summary } = runEntry(config, baseContext({ intradayMetrics: unavailable }));
    const byKey = rowMap(rows);
    expect(byKey.get('volume_pace').status).toBe('UNKNOWN');
    expect(byKey.get('range_pace').status).toBe('UNKNOWN');
    // Initial Stop needs the observable LOD, so missing intraday evidence makes
    // it UNKNOWN. Stop Width does not need intraday evidence (only the actual
    // stop and the volatility reference), so it still evaluates.
    expect(byKey.get('initial_stop').status).toBe('UNKNOWN');
    expect(byKey.get('stop_width').status).toBe('PASS');
    // Required Initial Stop UNKNOWN -> Compliance INCOMPLETE.
    expect(summary.compliance).toBe('INCOMPLETE');
  });

  test('missing actual initial-stop evidence produces UNKNOWN Initial Stop and Stop Width', () => {
    const noStop = {
      available: false,
      price: null,
      source: null,
      referenceEpoch: null,
      referenceTime: null,
      referenceTimeSource: 'initial_entry_time',
      stopEstablishmentTime: null,
      protective: null,
      provenance: { source: null, limitations: [] },
      reason: 'No actual initial protective stop is stored for this trade.'
    };
    const { rows } = runEntry(config, baseContext({ stopEvidence: noStop }));
    const byKey = rowMap(rows);
    expect(byKey.get('initial_stop').status).toBe('UNKNOWN');
    expect(byKey.get('stop_width').status).toBe('UNKNOWN');
  });

  test('a non-protective stop never yields a misleading passing Stop Width', () => {
    const nonProtective = {
      available: true,
      price: 101,
      source: 'trade_stop_loss_field',
      referenceEpoch: OPEN,
      referenceTime: new Date(OPEN * 1000).toISOString(),
      referenceTimeSource: 'initial_entry_time',
      stopEstablishmentTime: null,
      protective: false,
      provenance: { source: 'trade_stop_loss_field', limitations: [] },
      reason: null
    };
    const { rows } = runEntry(config, baseContext({ stopEvidence: nonProtective }));
    const stopWidth = rowMap(rows).get('stop_width');
    expect(stopWidth.status).toBe('UNKNOWN');
  });

  test('the profile scoring envelope remains authoritative', () => {
    const { rows } = runEntry(config, baseContext());
    const stopWidth = rowMap(rows).get('stop_width');
    // stop width = 101 - 99 = 2; ADR$ = 4 -> 0.5 ADR -> profile score 100.
    expect(stopWidth.scoring_value).toBeCloseTo(0.5, 12);
    expect(stopWidth.score).toBe(100);

    const extension = rowMap(rows).get('entry_extension');
    // extension = (101 - 100) / 4 = 0.25 ADR -> profile band 50.
    expect(extension.scoring_value).toBeCloseTo(0.25, 12);
    expect(extension.score).toBe(50);
  });
});
