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

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');
const { loadSessionIntradayBars } = require('../../../src/services/quality/intradayEvidenceService');
const EntryQualityService = require('../../../src/services/quality/entryQualityService');
const { getCanonicalBOConfig } = require('../../../src/services/quality/canonicalBO');
const { regularSessionBounds } = require('../../../src/services/quality/entry/sessionTime');

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

// 25 completed daily sessions ending on the entry session (index 24).
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
const ENTRY_FILL_ISO = '2026-03-10T14:31:30.000Z';
const ENTRY_EPOCH = Math.floor(Date.parse(ENTRY_FILL_ISO) / 1000);

function tradeRow(overrides = {}) {
  return {
    id: TRADE_ID,
    user_id: USER_ID,
    symbol: 'TEST',
    side: 'long',
    instrument_type: 'stock',
    tick_size: null,
    underlying_asset: null,
    entry_time: ENTRY_FILL_ISO,
    exit_time: null,
    trade_date: ENTRY_SESSION,
    entry_price: 101,
    quantity: 100,
    executions: [
      { action: 'buy', quantity: 100, price: 101, datetime: ENTRY_FILL_ISO }
    ],
    stop_loss: 99,
    ...overrides
  };
}

function evaluationRow(overrides = {}) {
  return {
    id: EVAL_ID,
    user_id: USER_ID,
    trade_id: TRADE_ID,
    profile_version_id: VERSION_ID,
    status: 'draft',
    results: { setup: { score: 91, grade: 'A', compliance: 'PASS', coverage: 100 }, entry: null, management: null },
    detected_context: {
      boundary: {
        method: 'first_daily_high_above_confirmed_pivot',
        pivotPrice: 100,
        baseStartDate: '2026-02-10',
        baseEndDate: '2026-03-09',
        resolutionDate: ENTRY_SESSION,
        pivotSource: 'detected_confirmed'
      }
    },
    user_inputs: {
      leader_confirmed: true,
      base_start: { date: '2026-02-10', source: 'detected_confirmed' },
      pivot: { price: 100, date: '2026-03-09', source: 'detected_confirmed' }
    },
    evidence_snapshot: { symbol: 'TEST', resolution: 'daily', entrySessionDate: ENTRY_SESSION, bars: DAILY_BARS },
    ...overrides
  };
}

function installDbRouter() {
  db.query.mockReset();
  db.query.mockImplementation((sql) => {
    if (sql.includes('FROM trades')) {
      return Promise.resolve({ rows: [tradeRow()] });
    }
    if (sql.includes('FROM quality_profile_versions v') && sql.includes('p.name AS profile_name')) {
      return Promise.resolve({
        rows: [{
          id: VERSION_ID,
          version_number: 1,
          schema_version: 1,
          configuration: CONFIG,
          profile_id: 'profile-1',
          profile_name: 'Canonical BO'
        }]
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
    evidence_snapshot: data.evidenceSnapshot,
    user_inputs: data.userInputs,
    detected_context: data.detectedContext
  }));
  loadSessionIntradayBars.mockImplementation(async (symbol, sessionDate) => {
    const bounds = regularSessionBounds(sessionDate);
    const bars = [];
    for (let minute = 0; minute < 300; minute += 1) {
      bars.push({
        time: bounds.openEpoch + minute * 60,
        open: 101,
        high: 102,
        low: 100.5,
        close: 101,
        volume: 1000
      });
    }
    return {
      available: true,
      bars,
      source: 'test',
      resolution: '1min',
      resolutionSeconds: 60,
      session: bounds,
      cacheHit: false,
      reason: null
    };
  });
});

describe('EntryQualityService', () => {
  test('prepare returns the Setup dependency, execution evidence, allowed triggers and required inputs', async () => {
    const payload = await EntryQualityService.prepare(USER_ID, TRADE_ID, { evaluationId: EVAL_ID });
    expect(payload.setupDependency.ready).toBe(true);
    expect(payload.setupDependency.confirmedPivot).toBe(100);
    expect(payload.setupDependency.breakoutSession).toBe(ENTRY_SESSION);
    expect(payload.executionEvidence.entryBasis).toBe(101);
    expect(payload.executionEvidence.originalPositionQty).toBe(100);
    expect(payload.executionEvidence.actualEntrySession).toBe(ENTRY_SESSION);
    expect(payload.allowedTriggerTypes).toEqual(['BO-PIVOT', 'BO-ORH-1', 'BO-ORH-5', 'BO-ORH-60']);
    expect(payload.requiredEntryUserInputs).toEqual(['intended_trigger_type']);
  });

  test('prepare refuses to fabricate Setup context when no Setup result exists', async () => {
    evaluationService.getEvaluation.mockResolvedValue(
      evaluationRow({ results: { setup: null, entry: null, management: null } })
    );
    await expect(
      EntryQualityService.prepare(USER_ID, TRADE_ID, { evaluationId: EVAL_ID })
    ).rejects.toMatchObject({ code: 'ENTRY_SETUP_REQUIRED' });
  });

  test('evaluate runs every enabled Entry criterion and preserves the Setup result', async () => {
    const payload = await EntryQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { intended_trigger_type: 'BO-PIVOT' }
    });

    expect(evaluationService.saveEntryProgress).toHaveBeenCalledTimes(1);
    const [evalId, userId, data] = evaluationService.saveEntryProgress.mock.calls[0];
    expect(evalId).toBe(EVAL_ID);
    expect(userId).toBe(USER_ID);

    const rows = data.entryResults.criterionResults;
    const keys = rows.map((row) => row.key).sort();
    expect(keys).toEqual([
      'breakout_session',
      'entry_extension',
      'initial_stop',
      'range_pace',
      'stop_width',
      'trigger_compliance',
      'volume_pace'
    ]);
    const byKey = new Map(rows.map((row) => [row.key, row]));
    expect(byKey.get('breakout_session').status).toBe('PASS');
    expect(byKey.get('trigger_compliance').status).toBe('PASS');
    expect(byKey.get('initial_stop').status).toBe('PASS');
    expect(byKey.get('stop_width').status).toBe('PASS');

    // Setup snapshot bars preserved; only an entry block is appended.
    expect(data.evidenceSnapshot.bars).toEqual(DAILY_BARS);
    expect(data.evidenceSnapshot.entry).toBeDefined();
    expect(data.evidenceSnapshot.entry.initial_r.available).toBe(true);
    expect(data.evidenceSnapshot.entry.initial_r.r_per_share).toBeCloseTo(2, 12);

    // Semantic inputs merged without erasing Setup inputs.
    expect(data.userInputs.leader_confirmed).toBe(true);
    expect(data.userInputs.base_start).toEqual({ date: '2026-02-10', source: 'detected_confirmed' });
    expect(data.userInputs.intended_trigger_type).toBe('BO-PIVOT');
    expect(data.detectedContext.entry.intended_trigger).toEqual({ value: 'BO-PIVOT', source: 'user_asserted' });

    expect(payload.entry.intendedTriggerType).toBe('BO-PIVOT');
    expect(payload.entry.initialR.available).toBe(true);
  });

  test('evaluate requires the intended trigger when trigger-dependent criteria are enabled', async () => {
    await expect(
      EntryQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: {} })
    ).rejects.toMatchObject({ code: 'INPUT_REQUIRED' });
  });

  test('evaluate rejects an intended trigger not permitted by the profile', async () => {
    await expect(
      EntryQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: EVAL_ID,
        userInputs: { intended_trigger_type: 'BO-ORH-99' }
      })
    ).rejects.toMatchObject({ code: 'INVALID_TRIGGER_TYPE' });
  });

  test('evaluate does NOT require an intended trigger when no enabled criterion depends on it', async () => {
    const config = JSON.parse(JSON.stringify(CONFIG));
    config.dimensions.entry.criteria = config.dimensions.entry.criteria.map((criterion) => {
      if (criterion.key === 'trigger_compliance' || criterion.key === 'entry_extension') {
        return { ...criterion, enabled: false };
      }
      return criterion;
    });
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM trades')) return Promise.resolve({ rows: [tradeRow()] });
      if (sql.includes('FROM quality_profile_versions v') && sql.includes('p.name AS profile_name')) {
        return Promise.resolve({ rows: [{ id: VERSION_ID, version_number: 1, schema_version: 1, configuration: config, profile_id: 'p', profile_name: 'Canonical BO' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await EntryQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: {}
    });
    expect(evaluationService.saveEntryProgress).toHaveBeenCalledTimes(1);
    const rows = evaluationService.saveEntryProgress.mock.calls[0][2].entryResults.criterionResults;
    expect(rows.some((row) => row.key === 'trigger_compliance')).toBe(false);
    expect(rows.some((row) => row.key === 'entry_extension')).toBe(false);
  });
});
