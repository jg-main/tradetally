'use strict';

jest.mock('../../../src/config/database', () => ({ query: jest.fn() }));

jest.mock('../../../src/services/quality/evaluationService', () => {
  const actual = jest.requireActual('../../../src/services/quality/evaluationService');
  return {
    ...actual,
    getEvaluation: jest.fn(),
    saveManagementProgress: jest.fn(),
    saveResult: jest.fn()
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
const { loadDailyEvidence } = require('../../../src/services/quality/marketEvidenceService');
const ManagementQualityService = require('../../../src/services/quality/managementQualityService');
const { getCanonicalBOConfig } = require('../../../src/services/quality/canonicalBO');
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
  for (let i = 10; i >= -6; i -= 1) {
    const date = addDays(ENTRY_SESSION, -i);
    const isDay3OrLater = i <= -2; // entry - (-2) = entry+2 => Day 3
    bars.push({
      date,
      time: Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000),
      open: 100,
      high: isDay3OrLater ? 106 : 101,
      low: 99,
      close: isDay3OrLater ? 105 : 101,
      volume: 1_000_000
    });
  }
  return bars;
}

const DAILY_BARS = buildDailyBars();

function entryEvidence(overrides = {}) {
  return {
    execution: {
      entry_basis: 100,
      original_position_qty: 200,
      actual_entry_session: ENTRY_SESSION,
      initial_entry_time: '2026-03-10T14:30:00.000Z',
      first_reduction_time: '2026-03-12T15:00:00.000Z',
      fills: [
        { timestamp: '2026-03-10T14:30:00.000Z', timestampEpoch: 1000, action: 'buy', quantity: 200, price: 100, source: 'executions_jsonb' }
      ]
    },
    initial_r: { available: true, r_per_share: 5, entry_basis: 100, initial_stop: 95, original_position_qty: 200, established_at: '2026-03-10T15:00:00.000Z' },
    ...overrides
  };
}

function tradeRow(overrides = {}) {
  return {
    id: TRADE_ID,
    user_id: USER_ID,
    symbol: 'TEST',
    side: 'long',
    instrument_type: 'stock',
    tick_size: 0.01,
    entry_time: '2026-03-10T14:30:00.000Z',
    exit_time: null,
    trade_date: ENTRY_SESSION,
    entry_price: 100,
    quantity: 200,
    executions: [
      { action: 'buy', quantity: 200, price: 100, datetime: '2026-03-10T14:30:00.000Z' },
      { action: 'sell', quantity: 100, price: 105, datetime: '2026-03-12T15:00:00.000Z' }
    ],
    stop_loss: 95,
    ...overrides
  };
}

function evaluationRow(overrides = {}) {
  const snapshot = { symbol: 'TEST', resolution: 'daily', entrySessionDate: ENTRY_SESSION, completeness: 'verified', source: 'finnhub', bars: DAILY_BARS };
  const entry = entryEvidence();
  return {
    id: EVAL_ID,
    user_id: USER_ID,
    trade_id: TRADE_ID,
    profile_version_id: VERSION_ID,
    status: 'draft',
    results: { setup: { score: 91 }, entry: { score: 95 }, management: null },
    detected_context: {
      boundary: { pivotPrice: 100, resolutionDate: ENTRY_SESSION, baseStartDate: '2026-02-10' },
      setup_dependency_fingerprint: setupDependencyFingerprint({ profileVersionId: VERSION_ID, boundary: { pivotPrice: 100, resolutionDate: ENTRY_SESSION }, evidenceSnapshot: snapshot })
    },
    user_inputs: { leader_confirmed: true },
    evidence_snapshot: { ...snapshot, entry },
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
  evaluationService.saveManagementProgress.mockImplementation(async (id, userId, data) => ({
    id,
    user_id: userId,
    trade_id: TRADE_ID,
    profile_version_id: VERSION_ID,
    status: 'draft',
    results: { setup: evaluationRow().results.setup, entry: evaluationRow().results.entry, management: { score: 87 } },
    evidence_snapshot: { entry: evaluationRow().evidence_snapshot.entry, management: data.managementEvidence },
    user_inputs: { trailing_ma_period: data.trailingMa ? data.trailingMa.value : null },
    detected_context: { management: data.managementDetectedContext }
  }));
  evaluationService.saveResult.mockImplementation(async (id, userId, data) => ({
    id,
    user_id: userId,
    trade_id: TRADE_ID,
    profile_version_id: VERSION_ID,
    status: data.status,
    results: data.results
  }));
  loadDailyEvidence.mockResolvedValue({ bars: DAILY_BARS, source: 'finnhub', completeness: 'verified', error: null });
});

describe('ManagementQualityService.evaluate', () => {
  test('runs enabled criteria and persists non-terminal Management progress', async () => {
    await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_ma_period: 20 }
    });

    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    const rows = data.managementResults.criterionResults;
    const byKey = new Map(rows.map((row) => [row.key, row]));

    expect(byKey.size).toBe(6);
    // Production has no trustworthy stop-history: both stop-history criteria are UNKNOWN.
    expect(byKey.get('stop_ratchet').status).toBe('UNKNOWN');
    expect(byKey.get('post_partial_breakeven').status).toBe('UNKNOWN');
    // Initial R is available and +1R reached on Day 3 -> partial is applicable.
    expect(byKey.get('partial_timing').status).toBe('PASS');
    expect(byKey.get('partial_sizing').status).toBe('PASS');
    expect(byKey.get('no_premature_reduction').status).toBe('PASS');

    expect(data.trailingMa.value).toBe(20);
  });

  test('Initial R unavailable makes R-dependent Management criteria UNKNOWN', async () => {
    const row = evaluationRow();
    row.evidence_snapshot.entry.initial_r = { available: false, r_per_share: null, reason: 'Initial R unavailable.' };
    evaluationService.getEvaluation.mockResolvedValue(row);

    await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_ma_period: 20 }
    });

    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    const byKey = new Map(data.managementResults.criterionResults.map((r) => [r.key, r]));
    expect(byKey.get('partial_timing').status).toBe('UNKNOWN');
    expect(byKey.get('partial_sizing').status).toBe('UNKNOWN');
    expect(byKey.get('no_premature_reduction').status).toBe('UNKNOWN');
  });

  test('trailing MA selection is immutable across reruns', async () => {
    const row = evaluationRow();
    row.user_inputs = { trailing_ma_period: 20 };
    evaluationService.getEvaluation.mockResolvedValue(row);

    await expect(
      ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: EVAL_ID,
        userInputs: { trailing_ma_period: 10 }
      })
    ).rejects.toMatchObject({ code: 'TRAILING_MA_IMMUTABLE' });
  });

  test('a stale Entry dependency is rejected', async () => {
    evaluationService.saveManagementProgress.mockRejectedValueOnce(
      Object.assign(new Error('stale entry'), { code: 'STALE_ENTRY_DEPENDENCY' })
    );
    await expect(
      ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: EVAL_ID,
        userInputs: { trailing_ma_period: 20 }
      })
    ).rejects.toMatchObject({ code: 'STALE_ENTRY_DEPENDENCY' });
  });
});

describe('ManagementQualityService.finalize', () => {
  test('marks a complete Setup+Entry+Management evaluation completed', async () => {
    const row = evaluationRow({
      results: { setup: { score: 91, criterionResults: [] }, entry: { score: 95, criterionResults: [] }, management: { score: 87, criterionResults: [] } }
    });
    evaluationService.getEvaluation.mockResolvedValue(row);

    const payload = await ManagementQualityService.finalize(USER_ID, TRADE_ID, { evaluationId: EVAL_ID });
    expect(payload.evaluation.status).toBe('completed');
    expect(evaluationService.saveResult).toHaveBeenCalledWith(
      EVAL_ID,
      USER_ID,
      expect.objectContaining({ status: 'completed', results: expect.objectContaining({ setup: expect.anything(), entry: expect.anything(), management: expect.anything() }) })
    );
  });

  test('rejects finalize when any dimension result is missing', async () => {
    const row = evaluationRow({ results: { setup: { score: 91 }, entry: { score: 95 }, management: null } });
    evaluationService.getEvaluation.mockResolvedValue(row);
    await expect(
      ManagementQualityService.finalize(USER_ID, TRADE_ID, { evaluationId: EVAL_ID })
    ).rejects.toMatchObject({ code: 'MANAGEMENT_INCOMPLETE' });
  });
});
