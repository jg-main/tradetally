'use strict';

jest.mock('../../../src/config/database', () => ({ query: jest.fn() }));

jest.mock('../../../src/services/quality/evaluationService', () => {
  const actual = jest.requireActual('../../../src/services/quality/evaluationService');
  return {
    ...actual,
    getEvaluation: jest.fn(),
    saveEntryProgress: jest.fn()
  };
});

jest.mock('../../../src/services/quality/intradayEvidenceService', () => {
  const actual = jest.requireActual('../../../src/services/quality/intradayEvidenceService');
  return {
    ...actual,
    loadSessionIntradayBars: jest.fn()
  };
});

jest.mock('../../../src/services/quality/marketEvidenceService', () => {
  const actual = jest.requireActual('../../../src/services/quality/marketEvidenceService');
  return {
    ...actual,
    loadDailyEvidence: jest.fn()
  };
});

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');
const { loadSessionIntradayBars } = require('../../../src/services/quality/intradayEvidenceService');
const { loadDailyEvidence } = require('../../../src/services/quality/marketEvidenceService');
const EntryQualityService = require('../../../src/services/quality/entryQualityService');
const { getCanonicalBOConfig } = require('../../../src/services/quality/canonicalBO');
const { regularSessionBounds } = require('../../../src/services/quality/entry/sessionTime');
const { setupDependencyFingerprint } = require('../../../src/services/quality/dependencyFingerprint');

const USER_ID = 'user-1';
const TRADE_ID = 'trade-1';
const EVAL_ID = 'eval-1';
const VERSION_ID = 'version-1';
const ENTRY_SESSION = '2026-03-10';
const CONFIG = getCanonicalBOConfig();

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
}

function buildDailyBars() {
  const bars = [];
  for (let i = 24; i >= 0; i -= 1) {
    const date = addDays(ENTRY_SESSION, -i);
    bars.push({
      date,
      time: Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000),
      open: 100,
      high: 104,
      low: 100,
      close: 100,
      volume: 1_000_000
    });
  }
  return bars;
}

const DAILY_BARS = buildDailyBars();
const OPEN = regularSessionBounds(ENTRY_SESSION).openEpoch;
const FILL1_ISO = '2026-03-10T14:31:00.000Z'; // exactly 61 minutes after the open
const FILL2_ISO = '2026-03-10T14:41:00.000Z';
const FILL1_EPOCH = Math.floor(Date.parse(FILL1_ISO) / 1000);
const BOUNDARY = {
  method: 'first_daily_high_above_confirmed_pivot',
  pivotPrice: 100,
  baseStartDate: '2026-02-10',
  baseEndDate: '2026-03-09',
  resolutionDate: ENTRY_SESSION,
  pivotSource: 'detected_confirmed'
};

function tradeRow(overrides = {}) {
  return {
    id: TRADE_ID,
    user_id: USER_ID,
    symbol: 'TEST',
    side: 'long',
    instrument_type: 'stock',
    tick_size: null,
    underlying_asset: null,
    entry_time: FILL1_ISO,
    exit_time: null,
    trade_date: ENTRY_SESSION,
    entry_price: 101,
    quantity: 200,
    executions: [
      { action: 'buy', quantity: 100, price: 101, datetime: FILL1_ISO },
      { action: 'buy', quantity: 100, price: 110, datetime: FILL2_ISO },
      { action: 'sell', quantity: 50, price: 130, datetime: '2026-03-10T15:30:00.000Z' }
    ],
    stop_loss: 99,
    ...overrides
  };
}

function snapshotFor(bars = DAILY_BARS) {
  return { symbol: 'TEST', resolution: 'daily', entrySessionDate: ENTRY_SESSION, completeness: 'verified', source: 'finnhub', bars };
}

function evaluationRow(overrides = {}) {
  const snapshot = snapshotFor();
  return {
    id: EVAL_ID,
    user_id: USER_ID,
    trade_id: TRADE_ID,
    profile_version_id: VERSION_ID,
    status: 'draft',
    results: { setup: { score: 91, grade: 'A', compliance: 'PASS', coverage: 100 }, entry: null, management: null },
    detected_context: {
      boundary: BOUNDARY,
      setup_dependency_fingerprint: setupDependencyFingerprint({ profileVersionId: VERSION_ID, boundary: BOUNDARY, evidenceSnapshot: snapshot })
    },
    user_inputs: {
      leader_confirmed: true,
      base_start: { date: '2026-02-10', source: 'detected_confirmed' },
      pivot: { price: 100, date: '2026-03-09', source: 'detected_confirmed' }
    },
    evidence_snapshot: snapshot,
    ...overrides
  };
}

function installDbRouter(configOverride = CONFIG) {
  db.query.mockReset();
  db.query.mockImplementation((sql) => {
    if (sql.includes('FROM trades')) return Promise.resolve({ rows: [tradeRow()] });
    if (sql.includes('FROM quality_profile_versions v') && sql.includes('p.name AS profile_name')) {
      return Promise.resolve({
        rows: [{ id: VERSION_ID, version_number: 1, schema_version: 1, configuration: configOverride, profile_id: 'profile-1', profile_name: 'Canonical BO' }]
      });
    }
    return Promise.resolve({ rows: [] });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  installDbRouter();
  evaluationService.getEvaluation.mockResolvedValue(evaluationRow());
  evaluationService.saveEntryProgress.mockImplementation(async (id, userId, data) => ({
    id,
    user_id: userId,
    trade_id: TRADE_ID,
    profile_version_id: VERSION_ID,
    status: 'draft',
    results: { setup: evaluationRow().results.setup, entry: { score: 95 }, management: null },
    evidence_snapshot: { entry: data.entryEvidence },
    user_inputs: { intended_trigger_type: data.intendedTrigger ? data.intendedTrigger.value : null },
    detected_context: { entry: data.entryDetectedContext }
  }));
  loadDailyEvidence.mockResolvedValue({ bars: DAILY_BARS, source: 'finnhub', completeness: 'verified', error: null });
  loadSessionIntradayBars.mockImplementation(async (symbol, sessionDate) => {
    const bounds = regularSessionBounds(sessionDate);
    const isEntry = sessionDate === ENTRY_SESSION;
    const bars = [];
    for (let minute = 0; minute < 390; minute += 1) {
      bars.push({
        time: bounds.openEpoch + minute * 60,
        open: 101,
        high: isEntry ? 102 : 101.5,
        low: isEntry ? 100.5 : 100.75,
        close: 101,
        volume: isEntry ? 2000 : 1000
      });
    }
    return {
      available: true, bars, source: 'test', resolution: '1min', resolutionSeconds: 60,
      session: bounds, cacheHit: false, reason: null,
      coverage: { count: bars.length, expectedCount: 390, firstEpoch: bars[0].time, lastEpoch: bars[bars.length - 1].time }
    };
  });
});

describe('EntryQualityService (hardened)', () => {
  test('prepare reports first-fill vs Entry Basis and criterion-driven dependencies', async () => {
    const payload = await EntryQualityService.prepare(USER_ID, TRADE_ID, { evaluationId: EVAL_ID });
    expect(payload.executionEvidence.entryBasis).toBeCloseTo(105.5, 12);
    expect(payload.executionEvidence.initialEntryFillPrice).toBe(101);
    expect(payload.executionEvidence.initialEntryFillTime).toBe(FILL1_ISO);
    expect(payload.executionEvidence.originalPositionQty).toBe(200);
    expect(payload.requiredEntryUserInputs).toEqual(['intended_trigger_type']);
    expect(payload.unavailableEvidence).toContain('actual_initial_stop');
  });

  test('evaluate runs enabled criteria with first-print trigger and UNKNOWN actual stop', async () => {
    const payload = await EntryQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { intended_trigger_type: 'BO-PIVOT' }
    });

    const data = evaluationService.saveEntryProgress.mock.calls[0][2];
    const rows = data.entryResults.criterionResults;
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get('breakout_session').status).toBe('PASS');
    expect(byKey.get('trigger_compliance').status).toBe('PASS');
    // trade.stop_loss is only a reference level: no actual first stop exists.
    expect(byKey.get('initial_stop').status).toBe('UNKNOWN');
    expect(byKey.get('stop_width').status).toBe('UNKNOWN');
    expect(byKey.get('volume_pace').status).toBe('PASS');
    expect(byKey.get('range_pace').status).toBe('PASS');
    expect(byKey.get('entry_extension').status).toBe('PASS');

    // First print vs Entry Basis remain distinct in the persisted snapshot.
    expect(data.entryEvidence.execution.entry_basis).toBeCloseTo(105.5, 12);
    expect(data.entryEvidence.execution.initial_entry_fill_price).toBe(101);
    expect(data.entryEvidence.stop.reference_stop.price).toBe(99);
    expect(data.entryEvidence.initial_r.available).toBe(false);
    // F9: breakout-session evidence is recorded separately from the entry session.
    expect(data.entryEvidence.intraday.breakout_session.session).toBe(ENTRY_SESSION);

    expect(payload.entry.initialEntryFillPrice).toBe(101);
    expect(payload.entry.entryBasis).toBeCloseTo(105.5, 12);
  });

  test('a stale Setup dependency is rejected, never attached to a newer Setup', async () => {
    evaluationService.saveEntryProgress.mockRejectedValueOnce(
      Object.assign(new Error('stale'), { code: 'STALE_DEPENDENCY' })
    );
    await expect(
      EntryQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: EVAL_ID,
        userInputs: { intended_trigger_type: 'BO-PIVOT' }
      })
    ).rejects.toMatchObject({ code: 'STALE_DEPENDENCY' });
  });

  test('a Leader-only Setup with Entry criteria that do not need Pivot does not fail', async () => {
    const config = JSON.parse(JSON.stringify(CONFIG));
    for (const criterion of config.dimensions.entry.criteria) {
      // Keep only stop_width (needs volatility, not Pivot/breakout).
      criterion.enabled = criterion.key === 'stop_width';
    }
    installDbRouter(config);
    evaluationService.getEvaluation.mockResolvedValue(
      evaluationRow({
        results: { setup: { score: 50, grade: 'F', compliance: 'FAIL', coverage: 100 }, entry: null, management: null },
        detected_context: {},
        evidence_snapshot: { symbol: 'TEST', resolution: 'daily', entrySessionDate: ENTRY_SESSION, completeness: 'not_required', bars: [] }
      })
    );

    await EntryQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: {}
    });
    // Entry-specific daily evidence was fetched separately (Setup snapshot empty).
    expect(loadDailyEvidence).toHaveBeenCalled();
    const data = evaluationService.saveEntryProgress.mock.calls[0][2];
    expect(data.entryEvidence.entry_daily.appended).toBe(true);
    expect(data.entryResults.criterionResults.map((row) => row.key)).toEqual(['stop_width']);
  });

  test('a criterion that needs Pivot rejects a missing Pivot cleanly', async () => {
    evaluationService.getEvaluation.mockResolvedValue(
      evaluationRow({ detected_context: {}, user_inputs: {} })
    );
    await expect(
      EntryQualityService.prepare(USER_ID, TRADE_ID, { evaluationId: EVAL_ID })
    ).rejects.toMatchObject({ code: 'ENTRY_SETUP_REQUIRED' });
  });
});

describe('EntryQualityService — intended trigger immutability (finding 1)', () => {
  test('the first assertion is persisted with user_asserted provenance', async () => {
    await EntryQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { intended_trigger_type: 'BO-PIVOT' }
    });
    const data = evaluationService.saveEntryProgress.mock.calls[0][2];
    expect(data.intendedTrigger.value).toBe('BO-PIVOT');
    expect(data.entryDetectedContext.intended_trigger.value).toBe('BO-PIVOT');
    expect(data.entryDetectedContext.intended_trigger.source).toBe('user_asserted');
    expect(data.entryDetectedContext.intended_trigger.assertedAt).toBeTruthy();
  });

  test('repeating the same assertion is allowed', async () => {
    evaluationService.getEvaluation.mockResolvedValue(
      evaluationRow({
        user_inputs: {
          ...evaluationRow().user_inputs,
          intended_trigger_type: 'BO-PIVOT'
        }
      })
    );
    await EntryQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { intended_trigger_type: 'BO-PIVOT' }
    });
    expect(evaluationService.saveEntryProgress).toHaveBeenCalledTimes(1);
  });

  test('omitting the assertion reuses the persisted value', async () => {
    evaluationService.getEvaluation.mockResolvedValue(
      evaluationRow({
        user_inputs: {
          ...evaluationRow().user_inputs,
          intended_trigger_type: 'BO-ORH-5'
        }
      })
    );
    await EntryQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: {}
    });
    const data = evaluationService.saveEntryProgress.mock.calls[0][2];
    expect(data.intendedTrigger.value).toBe('BO-ORH-5');
    expect(data.entryDetectedContext.intended_trigger.value).toBe('BO-ORH-5');
  });

  test('a different assertion is rejected and no Entry write occurs', async () => {
    evaluationService.getEvaluation.mockResolvedValue(
      evaluationRow({
        user_inputs: {
          ...evaluationRow().user_inputs,
          intended_trigger_type: 'BO-PIVOT'
        }
      })
    );
    await expect(
      EntryQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: EVAL_ID,
        userInputs: { intended_trigger_type: 'BO-ORH-5' }
      })
    ).rejects.toMatchObject({ code: 'INTENDED_TRIGGER_IMMUTABLE' });
    expect(evaluationService.saveEntryProgress).not.toHaveBeenCalled();
  });

  test('a new evaluation may assert a different trigger', async () => {
    evaluationService.getEvaluation.mockResolvedValue(evaluationRow());
    await EntryQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { intended_trigger_type: 'BO-ORH-60' }
    });
    const data = evaluationService.saveEntryProgress.mock.calls[0][2];
    expect(data.intendedTrigger.value).toBe('BO-ORH-60');
  });
});

describe('EntryQualityService — Entry-specific daily evidence authority (finding 4)', () => {
  test('verified Entry-specific daily evidence records the exact volatility sessions', async () => {
    const config = JSON.parse(JSON.stringify(CONFIG));
    for (const criterion of config.dimensions.entry.criteria) {
      criterion.enabled = criterion.key === 'stop_width';
    }
    installDbRouter(config);
    evaluationService.getEvaluation.mockResolvedValue(
      evaluationRow({
        detected_context: {},
        evidence_snapshot: { symbol: 'TEST', resolution: 'daily', entrySessionDate: ENTRY_SESSION, completeness: 'not_required', bars: [] }
      })
    );
    loadDailyEvidence.mockResolvedValue({
      bars: DAILY_BARS,
      source: 'finnhub',
      completeness: 'verified',
      error: null
    });

    await EntryQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: {} });
    const data = evaluationService.saveEntryProgress.mock.calls[0][2];
    expect(data.entryEvidence.entry_daily.appended).toBe(true);
    expect(data.entryEvidence.entry_daily.authoritative).toBe(true);
    expect(data.entryEvidence.entry_daily.requested_window).toBeTruthy();
    // Exact per-session inputs required to reproduce ADR are persisted.
    expect(data.entryEvidence.volatility.ADR.sessions.length).toBe(20);
    expect(data.entryEvidence.volatility.ADR.sessions[0]).toEqual(
      expect.objectContaining({ date: expect.any(String), high: expect.any(Number), previousClose: expect.any(Number) })
    );
  });

  test('cache-only/unverified Entry daily evidence yields UNKNOWN volatility-derived criteria', async () => {
    evaluationService.getEvaluation.mockResolvedValue(
      evaluationRow({
        evidence_snapshot: {
          symbol: 'TEST', resolution: 'daily', entrySessionDate: ENTRY_SESSION,
          completeness: 'unverified', source: 'historical_cache', bars: []
        }
      })
    );
    loadDailyEvidence.mockResolvedValue({
      bars: DAILY_BARS,
      source: 'historical_cache',
      completeness: 'unverified',
      error: 'cache only'
    });

    await EntryQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { intended_trigger_type: 'BO-PIVOT' }
    });
    const data = evaluationService.saveEntryProgress.mock.calls[0][2];
    expect(data.entryEvidence.entry_daily.authoritative).toBe(false);
    expect(data.entryEvidence.volatility).toEqual({});
    const byKey = new Map(data.entryResults.criterionResults.map((row) => [row.key, row]));
    expect(byKey.get('entry_extension').status).toBe('UNKNOWN');
    expect(byKey.get('stop_width').status).toBe('UNKNOWN');
  });
});

describe('EntryQualityService — pace reference-session identity authority (finding 3)', () => {
  test('unverified daily identity makes Volume Pace and Range Pace UNKNOWN with an explicit reason', async () => {
    evaluationService.getEvaluation.mockResolvedValue(
      evaluationRow({
        evidence_snapshot: {
          symbol: 'TEST', resolution: 'daily', entrySessionDate: ENTRY_SESSION,
          completeness: 'unverified', source: 'historical_cache', bars: []
        }
      })
    );
    loadDailyEvidence.mockResolvedValue({
      bars: DAILY_BARS, source: 'historical_cache', completeness: 'unverified', error: 'cache only'
    });

    await EntryQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { intended_trigger_type: 'BO-PIVOT' }
    });
    const data = evaluationService.saveEntryProgress.mock.calls[0][2];
    const byKey = new Map(data.entryResults.criterionResults.map((row) => [row.key, row]));
    expect(byKey.get('volume_pace').status).toBe('UNKNOWN');
    expect(byKey.get('range_pace').status).toBe('UNKNOWN');
    expect(byKey.get('volume_pace').evidence.reason).toMatch(/reference-session identity/);
    expect(byKey.get('range_pace').evidence.reason).toMatch(/reference-session identity/);
    // No pace value is fabricated even though the intraday bars are "complete".
    expect(data.entryEvidence.metrics.volume_pace.available).toBe(false);
    expect(data.entryEvidence.metrics.range_pace.available).toBe(false);
  });
});

describe('EntryQualityService — criterion-driven trigger policy (finding 4)', () => {
  function configWithCriteria(criteria) {
    const config = JSON.parse(JSON.stringify(CONFIG));
    config.dimensions.entry.criteria = criteria;
    return config;
  }

  test('a stop_width-only profile with NO trigger policy block runs normally', async () => {
    const config = configWithCriteria([
      {
        key: 'stop_width',
        enabled: true,
        required: true,
        weight: 50,
        parameters: { volatility_method: 'ADR', period: 20, maximum_multiple: 1.0 },
        scoring: { type: 'step', mode: 'lte', default_score: 0, thresholds: [{ value: 0.5, score: 100 }, { value: 1.0, score: 75 }] }
      }
    ]);
    installDbRouter(config);
    evaluationService.getEvaluation.mockResolvedValue(
      evaluationRow({ detected_context: {}, user_inputs: {} })
    );

    const prepared = await EntryQualityService.prepare(USER_ID, TRADE_ID, { evaluationId: EVAL_ID });
    expect(prepared.allowedTriggerTypes).toEqual([]);
    expect(prepared.requiredEntryUserInputs).toEqual([]);

    await EntryQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: {} });
    const data = evaluationService.saveEntryProgress.mock.calls[0][2];
    expect(data.intendedTrigger.mode).toBe('none');
    // stop_width evaluated (UNKNOWN: no trustworthy actual stop), no trigger required.
    expect(data.entryResults.criterionResults.map((row) => row.key)).toEqual(['stop_width']);
  });

  test('a volume/range-only profile with NO trigger criterion runs normally', async () => {
    const config = configWithCriteria([
      { key: 'volume_pace', enabled: true, required: false, weight: 50, parameters: { reference_sessions: 2, target_multiple: 1.4 }, scoring: { type: 'step', mode: 'gte', default_score: 0, thresholds: [{ value: 1.4, score: 85 }] } },
      { key: 'range_pace', enabled: true, required: false, weight: 50, parameters: { reference_sessions: 2 }, scoring: { type: 'step', mode: 'gte', default_score: 0, thresholds: [{ value: 1.0, score: 70 }] } }
    ]);
    installDbRouter(config);
    evaluationService.getEvaluation.mockResolvedValue(evaluationRow({ detected_context: {}, user_inputs: {} }));

    await EntryQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: {} });
    const data = evaluationService.saveEntryProgress.mock.calls[0][2];
    expect(data.intendedTrigger.mode).toBe('none');
    expect(data.entryResults.criterionResults.map((row) => row.key).sort()).toEqual(['range_pace', 'volume_pace']);
  });

  test('entry_extension with a missing trigger policy is still rejected', () => {
    const config = configWithCriteria([
      { key: 'entry_extension', enabled: true, required: false, weight: 50, parameters: { primary_normalization: 'ADR', hard_maximum: 'disabled' }, scoring: { type: 'step', mode: 'lte', default_score: 0, thresholds: [{ value: 0.1, score: 90 }] } }
    ]);
    expect(() => EntryQualityService.assertValidEntryConfiguration(config.dimensions.entry)).toThrow(
      /trigger_compliance|trigger policy/i
    );
  });
});

describe('resolveEntryDailyEvidence — exact prior-session requirement (finding 3)', () => {
  function dailyBarsWithPrior(priorCount) {
    const bars = [];
    for (let i = priorCount; i >= 1; i -= 1) {
      const date = new Date(`${ENTRY_SESSION}T00:00:00.000Z`);
      date.setUTCDate(date.getUTCDate() - i);
      const iso = date.toISOString().split('T')[0];
      bars.push({ date: iso, time: Math.floor(date.getTime() / 1000), open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 });
    }
    bars.push({
      date: ENTRY_SESSION,
      time: Math.floor(new Date(`${ENTRY_SESSION}T00:00:00.000Z`).getTime() / 1000),
      open: 1, high: 2, low: 0.5, close: 1.5, volume: 100
    });
    return bars;
  }
  function evaluationWithSnapshot(priorCount, completeness = 'verified') {
    return { evidence_snapshot: { entrySessionDate: ENTRY_SESSION, completeness, source: 'finnhub', bars: dailyBarsWithPrior(priorCount) } };
  }

  test('pace reference_sessions=20: exactly 20 prior verified sessions is sufficient', async () => {
    const result = await EntryQualityService.resolveEntryDailyEvidence({
      evaluation: evaluationWithSnapshot(20), trade: { symbol: 'TEST' }, userId: 'u',
      entrySession: ENTRY_SESSION, requiredPriorSessions: 20
    });
    expect(result.index).toBe(20);
    expect(result.authoritative).toBe(true);
  });

  test('pace reference_sessions=20: 19 prior sessions is insufficient', async () => {
    loadDailyEvidence.mockResolvedValue({ bars: dailyBarsWithPrior(19), completeness: 'verified', source: 'finnhub', error: null });
    const result = await EntryQualityService.resolveEntryDailyEvidence({
      evaluation: evaluationWithSnapshot(19), trade: { symbol: 'TEST' }, userId: 'u',
      entrySession: ENTRY_SESSION, requiredPriorSessions: 20
    });
    expect(result.authoritative).toBe(false);
  });

  test('ADR20/ATR20: exactly 21 prior bars is sufficient, 20 is not', async () => {
    const sufficient = await EntryQualityService.resolveEntryDailyEvidence({
      evaluation: evaluationWithSnapshot(21), trade: { symbol: 'TEST' }, userId: 'u',
      entrySession: ENTRY_SESSION, requiredPriorSessions: 21
    });
    expect(sufficient.authoritative).toBe(true);

    loadDailyEvidence.mockResolvedValue({ bars: dailyBarsWithPrior(20), completeness: 'verified', source: 'finnhub', error: null });
    const insufficient = await EntryQualityService.resolveEntryDailyEvidence({
      evaluation: evaluationWithSnapshot(20), trade: { symbol: 'TEST' }, userId: 'u',
      entrySession: ENTRY_SESSION, requiredPriorSessions: 21
    });
    expect(insufficient.authoritative).toBe(false);
  });

  test('combined ADR20 + pace20: 21 prior bars is sufficient (exact max)', async () => {
    const result = await EntryQualityService.resolveEntryDailyEvidence({
      evaluation: evaluationWithSnapshot(21), trade: { symbol: 'TEST' }, userId: 'u',
      entrySession: ENTRY_SESSION, requiredPriorSessions: 21
    });
    expect(result.authoritative).toBe(true);
  });

  test('larger configured counts retain exact semantics', async () => {
    const sufficient = await EntryQualityService.resolveEntryDailyEvidence({
      evaluation: evaluationWithSnapshot(31), trade: { symbol: 'TEST' }, userId: 'u',
      entrySession: ENTRY_SESSION, requiredPriorSessions: 31
    });
    expect(sufficient.authoritative).toBe(true);

    loadDailyEvidence.mockResolvedValue({ bars: dailyBarsWithPrior(30), completeness: 'verified', source: 'finnhub', error: null });
    const insufficient = await EntryQualityService.resolveEntryDailyEvidence({
      evaluation: evaluationWithSnapshot(30), trade: { symbol: 'TEST' }, userId: 'u',
      entrySession: ENTRY_SESSION, requiredPriorSessions: 31
    });
    expect(insufficient.authoritative).toBe(false);
  });
});
