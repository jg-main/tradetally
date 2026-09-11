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

jest.mock('../../../src/services/quality/intradayEvidenceService', () => {
  const actual = jest.requireActual('../../../src/services/quality/intradayEvidenceService');
  return {
    ...actual,
    loadSessionIntradayBars: jest.fn()
  };
});

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');
const { loadDailyEvidence } = require('../../../src/services/quality/marketEvidenceService');
const { loadSessionIntradayBars } = require('../../../src/services/quality/intradayEvidenceService');
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
    user_inputs: {
      trailing_ma_period: data.trailingMa ? data.trailingMa.value : null,
      trailing_phase: data.trailingPhase ? data.trailingPhase.value : null
    },
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
  // Provide intraday crossing evidence for the Day-3 crossing session so
  // same-session ordering can be confirmed; other sessions have no intraday.
  loadSessionIntradayBars.mockImplementation(async (symbol, date) => {
    if (date === addDays(ENTRY_SESSION, 2)) {
      const open = Math.floor(Date.parse(`${date}T13:30:00.000Z`) / 1000);
      return { available: true, bars: [{ time: open, high: 106, low: 100, close: 105 }], source: 'test_intraday' };
    }
    return { available: false, bars: [], source: null, reason: 'no intraday in tests' };
  });
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

  test('an ongoing trade with an incomplete horizon keeps partial criteria UNKNOWN (F3)', async () => {
    // Only Day 1 and Day 2 have completed; the partial window has not elapsed.
    const partialBars = DAILY_BARS.filter((bar) => bar.date <= addDays(ENTRY_SESSION, 1));
    loadDailyEvidence.mockResolvedValue({ bars: partialBars, source: 'finnhub', completeness: 'verified', error: null });

    await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_ma_period: 20 }
    });

    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    const byKey = new Map(data.managementResults.criterionResults.map((r) => [r.key, r]));
    expect(byKey.get('partial_timing').status).toBe('UNKNOWN');
    expect(byKey.get('partial_sizing').status).toBe('UNKNOWN');
    expect(byKey.get('post_partial_breakeven').status).toBe('UNKNOWN');
    expect(data.managementEvidence.partial_trigger.status).toBe('pending');
  });

  test('a pre-trigger reduction with no classification is UNKNOWN, not FAIL (F4)', async () => {
    const trade = tradeRow({
      executions: [
        { action: 'buy', quantity: 200, price: 100, datetime: '2026-03-10T14:30:00.000Z' },
        { action: 'sell', quantity: 40, price: 102, datetime: '2026-03-11T15:00:00.000Z' }, // Day 2, before due Day 3
        { action: 'sell', quantity: 100, price: 106, datetime: '2026-03-12T15:00:00.000Z' }
      ]
    });
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM trades')) return Promise.resolve({ rows: [trade] });
      if (sql.includes('FROM quality_profile_versions v') && sql.includes('p.name AS profile_name')) {
        return Promise.resolve({ rows: [{ id: VERSION_ID, version_number: 1, schema_version: 1, configuration: CONFIG, profile_id: 'profile-1', profile_name: 'Canonical BO' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_ma_period: 20 }
    });

    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    const byKey = new Map(data.managementResults.criterionResults.map((r) => [r.key, r]));
    expect(byKey.get('no_premature_reduction').status).toBe('UNKNOWN');
    expect(data.managementEvidence.premature_reduction.outcome).toBe('ambiguous');
  });

  test('sizing is measured at the partial event even with a later final exit (F1)', async () => {
    const trade = tradeRow({
      executions: [
        { action: 'buy', quantity: 200, price: 100, datetime: '2026-03-10T14:30:00.000Z' },
        { action: 'sell', quantity: 100, price: 105, datetime: '2026-03-12T15:00:00.000Z' }, // the partial
        { action: 'sell', quantity: 100, price: 108, datetime: '2026-03-16T15:00:00.000Z' } // later final exit
      ]
    });
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM trades')) return Promise.resolve({ rows: [trade] });
      if (sql.includes('FROM quality_profile_versions v') && sql.includes('p.name AS profile_name')) {
        return Promise.resolve({ rows: [{ id: VERSION_ID, version_number: 1, schema_version: 1, configuration: CONFIG, profile_id: 'profile-1', profile_name: 'Canonical BO' }] });
      }
      return Promise.resolve({ rows: [] });
    });

    await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_ma_period: 20 }
    });

    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    const byKey = new Map(data.managementResults.criterionResults.map((r) => [r.key, r]));
    expect(byKey.get('partial_sizing').status).toBe('PASS');
    expect(byKey.get('partial_sizing').raw_value).toBeCloseTo(50);
  });

  test('a pre-Phase-4 immutable version (no target_tolerance_pct / activation) remains readable (F9)', async () => {
    const legacy = JSON.parse(JSON.stringify(CONFIG));
    const management = legacy.dimensions.management;
    const sizing = management.criteria.find((c) => c.key === 'partial_sizing');
    delete sizing.parameters.target_tolerance_pct;
    const trailing = management.criteria.find((c) => c.key === 'trailing_ma');
    delete trailing.parameters.activation;
    installDbRouter(legacy);

    await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_ma_period: 20 }
    });

    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    const byKey = new Map(data.managementResults.criterionResults.map((r) => [r.key, r]));
    // Tolerance derived from the version's own scoring envelope (2pp) => PASS.
    expect(byKey.get('partial_sizing').status).toBe('PASS');
    expect(data.managementEvidence.policy.partial_tolerance_source).toBe('scoring_envelope');
    expect(data.managementEvidence.policy.trailing_activation).toBe('immediate');
  });
});

describe('resolveTrailingState — activation gating (F6)', () => {
  const daily = {
    authoritative: true,
    entryIndex: 0,
    completedThroughIndex: 3,
    indexMap: new Map([['2026-03-10', 0], ['2026-03-11', 1], ['2026-03-12', 2], ['2026-03-13', 3]]),
    bars: [
      { date: '2026-03-10', close: 100 },
      { date: '2026-03-11', close: 100 },
      { date: '2026-03-12', close: 100 },
      { date: '2026-03-13', close: 100 }
    ]
  };
  const policy = {
    trailingActivation: 'after_partial',
    trailingActivationSource: 'trailing_ma',
    executionWindowMinutes: 30
  };

  test('never-activated when the partial never triggered => inactive', () => {
    const state = ManagementQualityService.resolveTrailingState({
      policy,
      partialTrigger: { status: 'never_reached' },
      partialCompletion: { completed: false },
      partialExit: { outcome: 'none' },
      fillsState: { available: true, positionClosed: false },
      daily,
      nowEpoch: 0,
      trailingPhase: null,
      sessionIndexForDate: () => null,
      executionWindowMinutes: 30,
      stopExecutionClassification: { available: false },
      userInputs: {}
    });
    expect(state.active).toBe(false);
    expect(state.activationResolved).toBe(true);
    expect(state.inactiveReason).toBe('partial_never_triggered');
  });

  test('activation is unresolved while the trigger is pending => UNKNOWN semantics', () => {
    const state = ManagementQualityService.resolveTrailingState({
      policy,
      partialTrigger: { status: 'pending' },
      partialCompletion: { completed: false },
      partialExit: { outcome: 'none' },
      fillsState: { available: true, positionClosed: false },
      daily,
      nowEpoch: 0,
      trailingPhase: null,
      sessionIndexForDate: () => null,
      executionWindowMinutes: 30,
      stopExecutionClassification: { available: false },
      userInputs: {}
    });
    expect(state.active).toBe(false);
    expect(state.activationResolved).toBe(false);
  });

  test('explicit activation requires an assertion', () => {
    const explicitPolicy = { ...policy, trailingActivation: 'explicit' };
    const noAssertion = ManagementQualityService.resolveTrailingState({
      policy: explicitPolicy,
      partialTrigger: { status: 'never_reached' },
      partialCompletion: { completed: false },
      partialExit: { outcome: 'none' },
      fillsState: { available: true, positionClosed: false },
      daily,
      nowEpoch: 0,
      trailingPhase: null,
      sessionIndexForDate: () => null,
      executionWindowMinutes: 30,
      stopExecutionClassification: { available: false },
      userInputs: {}
    });
    expect(noAssertion.activationResolved).toBe(false);

    const notActivated = ManagementQualityService.resolveTrailingState({
      policy: explicitPolicy,
      partialTrigger: { status: 'never_reached' },
      partialCompletion: { completed: false },
      partialExit: { outcome: 'none' },
      fillsState: { available: true, positionClosed: false },
      daily,
      nowEpoch: 0,
      trailingPhase: 'not_activated',
      sessionIndexForDate: () => null,
      executionWindowMinutes: 30,
      stopExecutionClassification: { available: false },
      userInputs: { trailing_phase: 'not_activated' }
    });
    expect(notActivated.activationResolved).toBe(true);
    expect(notActivated.active).toBe(false);
  });

  test('explicit activated without an activation boundary does NOT scan from entry', () => {
    const explicitPolicy = { ...policy, trailingActivation: 'explicit' };
    const state = ManagementQualityService.resolveTrailingState({
      policy: explicitPolicy,
      partialTrigger: { status: 'never_reached' },
      partialCompletion: { completed: false },
      partialExit: { outcome: 'none' },
      fillsState: { available: true, positionClosed: false },
      daily,
      nowEpoch: 0,
      trailingPhase: 'activated',
      sessionIndexForDate: () => null,
      executionWindowMinutes: 30,
      stopExecutionClassification: { available: false },
      userInputs: { trailing_phase: 'activated' }
    });
    expect(state.active).toBe(false);
    expect(state.activationResolved).toBe(false);
    expect(state.inactiveReason).toBe('activation_boundary_missing');
    expect(state.activationSessionIndex).toBeNull();
  });

  test('explicit activated with an authoritative session scans from that session', () => {
    const explicitPolicy = { ...policy, trailingActivation: 'explicit' };
    const state = ManagementQualityService.resolveTrailingState({
      policy: explicitPolicy,
      partialTrigger: { status: 'never_reached' },
      partialCompletion: { completed: false },
      partialExit: { outcome: 'none' },
      fillsState: { available: true, positionClosed: false },
      daily,
      nowEpoch: 0,
      trailingPhase: 'activated',
      sessionIndexForDate: () => null,
      executionWindowMinutes: 30,
      stopExecutionClassification: { available: false },
      userInputs: { trailing_phase: 'activated', trailing_activation_session: '2026-03-12', trailing_ma_period: 20 }
    });
    expect(state.active).toBe(true);
    expect(state.activationResolved).toBe(true);
    expect(state.activationSessionIndex).toBe(2);
    expect(state.activationSession).toBe('2026-03-12');
  });
});

describe('resolveTrailingApplicability (F4b)', () => {
  const afterPartial = { trailingActivation: 'after_partial' };
  const explicit = { trailingActivation: 'explicit' };

  test('after_partial + never-triggered partial => no SMA required', () => {
    const r = ManagementQualityService.resolveTrailingApplicability({
      policy: afterPartial, partialTrigger: { status: 'never_reached' }, partialCompletion: { completed: false },
      partialExit: { outcome: 'none' }, trailingPhase: null, activationSessionEstablished: false
    });
    expect(r.smaRequired).toBe(false);
  });

  test('after_partial + completed partial => SMA required', () => {
    const r = ManagementQualityService.resolveTrailingApplicability({
      policy: afterPartial, partialTrigger: { status: 'triggered' }, partialCompletion: { completed: true },
      partialExit: { outcome: 'none' }, trailingPhase: null, activationSessionEstablished: false
    });
    expect(r.smaRequired).toBe(true);
  });

  test('after_partial + proven protective supersession => no SMA required', () => {
    const r = ManagementQualityService.resolveTrailingApplicability({
      policy: afterPartial, partialTrigger: { status: 'triggered' }, partialCompletion: { completed: false },
      partialExit: { outcome: 'superseded_protective' }, trailingPhase: null, activationSessionEstablished: false
    });
    expect(r.smaRequired).toBe(false);
  });

  test('explicit not_activated => no SMA required', () => {
    const r = ManagementQualityService.resolveTrailingApplicability({
      policy: explicit, partialTrigger: { status: 'never_reached' }, partialCompletion: { completed: false },
      partialExit: { outcome: 'none' }, trailingPhase: 'not_activated', activationSessionEstablished: false
    });
    expect(r.smaRequired).toBe(false);
  });

  test('explicit activated without boundary => SMA + activation boundary required', () => {
    const r = ManagementQualityService.resolveTrailingApplicability({
      policy: explicit, partialTrigger: { status: 'never_reached' }, partialCompletion: { completed: false },
      partialExit: { outcome: 'none' }, trailingPhase: 'activated', activationSessionEstablished: false
    });
    expect(r.smaRequired).toBe(true);
    expect(r.activationSessionRequired).toBe(true);
  });
});

describe('Trailing applicability workflow (F4b)', () => {
  function neverReachedBars() {
    return DAILY_BARS.map((bar) => ({ ...bar, high: 101, close: 101 }));
  }

  test('prepare reports no SMA required for a never-triggered canonical after_partial phase', async () => {
    loadDailyEvidence.mockResolvedValue({ bars: neverReachedBars(), source: 'finnhub', completeness: 'verified', error: null });
    const payload = await ManagementQualityService.prepare(USER_ID, TRADE_ID, { evaluationId: EVAL_ID });
    expect(payload.trailingMa.smaRequired).toBe(false);
    expect(payload.requiredManagementUserInputs).not.toContain('trailing_ma_period');
  });

  test('canonical after_partial with a never-triggered partial evaluates without an SMA (trailing N/A)', async () => {
    loadDailyEvidence.mockResolvedValue({ bars: neverReachedBars(), source: 'finnhub', completeness: 'verified', error: null });
    await ManagementQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID });
    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    const byKey = new Map(data.managementResults.criterionResults.map((r) => [r.key, r]));
    expect(byKey.get('trailing_ma').status).toBe('NOT_APPLICABLE');
    expect(data.managementEvidence.partial_trigger.status).toBe('never_reached');
  });

  test('a completed partial makes the SMA required (evaluate throws INPUT_REQUIRED without it)', async () => {
    await expect(
      ManagementQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID })
    ).rejects.toMatchObject({ code: 'INPUT_REQUIRED' });
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

describe('resolveDayOnePostEntryHigh — containing-bar + sparse-path discipline (F1)', () => {
  const { regularSessionBounds } = require('../../../src/services/quality/entry/sessionTime');
  const DATE = '2026-03-12';
  const bounds = regularSessionBounds(DATE);
  const entryEpoch = bounds.openEpoch + 30; // entry 09:30:30

  function sessionBars({ high = 101, omit = [] } = {}) {
    const bars = [];
    for (let t = bounds.openEpoch; t < bounds.closeEpoch; t += 60) {
      if (omit.includes(t)) continue;
      bars.push({ time: t, open: high, high, low: high, close: high });
    }
    return bars;
  }

  beforeEach(() => {
    loadSessionIntradayBars.mockReset();
  });

  test('entry inside a containing bar that could cross +1R leaves Day-1 first reach UNCERTAIN', async () => {
    loadSessionIntradayBars.mockResolvedValue({
      available: true,
      source: 'test_intraday',
      bars: [{ time: bounds.openEpoch, high: 106 }, ...sessionBars({ omit: [bounds.openEpoch] })]
    });
    const result = await ManagementQualityService.resolveDayOnePostEntryHigh({
      day1Bar: { date: DATE, high: 106 },
      entryEpoch, entryBasis: 100, rPerShare: 5, minimumMfeR: 1.0, symbol: 'TEST', userId: USER_ID, observations: []
    });
    expect(result.highKnown).toBe(false);
    expect(result.possibleX).toBe(true);
    expect(result.reason).toBe('day1_containing_bar_could_cross');
  });

  test('E: containing bar below +1R with a missing post-entry interval keeps Day 1 uncertain', async () => {
    loadSessionIntradayBars.mockResolvedValue({
      available: true,
      source: 'test_intraday',
      // 09:31 missing; every observed regular-session bar is below +1R.
      bars: sessionBars({ high: 101, omit: [bounds.openEpoch + 60] })
    });
    const result = await ManagementQualityService.resolveDayOnePostEntryHigh({
      day1Bar: { date: DATE, high: 106 }, // daily high >= threshold (could be in the gap)
      entryEpoch, entryBasis: 100, rPerShare: 5, minimumMfeR: 1.0, symbol: 'TEST', userId: USER_ID, observations: []
    });
    expect(result.highKnown).toBe(false);
    expect(result.possibleX).toBe(true);
    expect(result.reason).toBe('day1_post_entry_intervals_missing');
    expect(result.missingIntervals).toBeGreaterThan(0);
  });

  test('F: a complete post-entry path below +1R is a definitive no-cross', async () => {
    loadSessionIntradayBars.mockResolvedValue({
      available: true,
      source: 'test_intraday',
      bars: sessionBars({ high: 101 }) // complete regular session, all below +1R
    });
    const result = await ManagementQualityService.resolveDayOnePostEntryHigh({
      // daily high >= threshold from outside the regular session (e.g. premarket)
      day1Bar: { date: DATE, high: 106 },
      entryEpoch, entryBasis: 100, rPerShare: 5, minimumMfeR: 1.0, symbol: 'TEST', userId: USER_ID, observations: []
    });
    expect(result.highKnown).toBe(true);
    expect(result.possibleX).toBe(false);
    expect(result.definitivelyBelowThreshold).toBe(true);
    expect(result.high).toBe(101);
  });

  test('G: a daily high below +1R is a definitive no-cross even with missing intraday bars', async () => {
    loadSessionIntradayBars.mockResolvedValue({
      available: true,
      source: 'test_intraday',
      bars: sessionBars({ high: 101, omit: [bounds.openEpoch + 60, bounds.openEpoch + 120] })
    });
    const result = await ManagementQualityService.resolveDayOnePostEntryHigh({
      day1Bar: { date: DATE, high: 102 },
      entryEpoch, entryBasis: 100, rPerShare: 5, minimumMfeR: 1.0, symbol: 'TEST', userId: USER_ID, observations: []
    });
    expect(result.highKnown).toBe(true);
    expect(result.possibleX).toBe(false);
    expect(result.definitivelyBelowThreshold).toBe(true);
    expect(result.highValueKnown).toBe(false);
    expect(result.reason).toBe('day1_daily_high_below_threshold');
  });

  test('a fully post-entry observed bar that crosses establishes the Day-1 crossing', async () => {
    loadSessionIntradayBars.mockResolvedValue({
      available: true,
      source: 'test_intraday',
      bars: [
        { time: bounds.openEpoch, high: 101 },
        { time: bounds.openEpoch + 60, high: 106 }, // fully post-entry crossing
        ...sessionBars({ omit: [bounds.openEpoch, bounds.openEpoch + 60] })
      ]
    });
    const result = await ManagementQualityService.resolveDayOnePostEntryHigh({
      day1Bar: { date: DATE, high: 106 },
      entryEpoch, entryBasis: 100, rPerShare: 5, minimumMfeR: 1.0, symbol: 'TEST', userId: USER_ID, observations: []
    });
    expect(result.highKnown).toBe(true);
    expect(result.possibleX).toBe(false);
    expect(result.high).toBe(106);
    expect(result.precision).toBe('1min_bar');
  });

  test('a containing bar below +1R with no fully post-entry evidence is uncertain (sparse path)', async () => {
    loadSessionIntradayBars.mockResolvedValue({
      available: true,
      source: 'test_intraday',
      bars: [{ time: bounds.openEpoch, high: 101 }] // only the containing bar
    });
    const result = await ManagementQualityService.resolveDayOnePostEntryHigh({
      day1Bar: { date: DATE, high: 106 },
      entryEpoch, entryBasis: 100, rPerShare: 5, minimumMfeR: 1.0, symbol: 'TEST', userId: USER_ID, observations: []
    });
    expect(result.highKnown).toBe(false);
    expect(result.possibleX).toBe(true);
    expect(result.reason).toBe('day1_post_entry_intervals_missing');
  });

  test('no intraday evidence at all with daily high >= +1R keeps Day 1 uncertain', async () => {
    loadSessionIntradayBars.mockResolvedValue({ available: false, bars: [], source: null });
    const result = await ManagementQualityService.resolveDayOnePostEntryHigh({
      day1Bar: { date: DATE, high: 106 },
      entryEpoch, entryBasis: 100, rPerShare: 5, minimumMfeR: 1.0, symbol: 'TEST', userId: USER_ID, observations: []
    });
    expect(result.highKnown).toBe(false);
    expect(result.possibleX).toBe(true);
    expect(result.reason).toBe('day1_post_entry_evidence_unavailable');
  });
});

describe('resolveTrailingState — same-date signal/exit ordering (F3)', () => {
  const { regularSessionBounds } = require('../../../src/services/quality/entry/sessionTime');
  const dates = [];
  for (let i = 0; i < 25; i += 1) {
    dates.push(`2026-04-${String(i + 1).padStart(2, '0')}`);
  }
  const bars = dates.map((date, i) => ({ date, close: i === 20 ? 90 : 100 }));
  const daily = {
    authoritative: true,
    entryIndex: 0,
    completedThroughIndex: 24,
    indexMap: new Map(dates.map((date, i) => [date, i])),
    bars
  };
  const signalDate = dates[20];
  const signalCloseEpoch = regularSessionBounds(signalDate).closeEpoch;
  const policy = { trailingActivation: 'after_partial', trailingActivationSource: 'trailing_ma', executionWindowMinutes: 30 };

  function stateWithExit(sessionDate, timeEpoch, classification) {
    return ManagementQualityService.resolveTrailingState({
      policy,
      partialTrigger: { status: 'triggered' },
      partialCompletion: {
        completed: true,
        completionSessionIndex: 0,
        completionSessionDate: dates[0],
        // intraday completion well before the entry-session close
        completionTimeEpoch: regularSessionBounds(dates[0]).openEpoch + 3600
      },
      partialExit: { outcome: 'none' },
      fillsState: {
        available: true,
        positionClosed: true,
        lastClosingTimeEpoch: timeEpoch,
        lastClosingPrice: 100,
        lastClosingSessionDate: sessionDate,
        firstFullClose: { sessionDate, timeEpoch, quantity: 200, cumulativeQty: 200, price: 100 }
      },
      daily,
      nowEpoch: 0,
      trailingPhase: null,
      sessionIndexForDate: (d) => daily.indexMap.get(d) ?? null,
      executionWindowMinutes: 30,
      stopExecutionClassification: classification,
      userInputs: { trailing_ma_period: 20 }
    });
  }

  test('protective stop 11:00 on the signal date => superseded NOT_APPLICABLE', () => {
    const state = stateWithExit(signalDate, signalCloseEpoch - 3600, { available: true, complete: true, byEpoch: { [signalCloseEpoch - 3600]: 'protective' } });
    expect(state.signal).toBeTruthy();
    expect(state.supersession.outcome).toBe('superseded_protective');
  });

  test('ambiguous 11:00 same-day exit => superseded UNKNOWN', () => {
    const state = stateWithExit(signalDate, signalCloseEpoch - 3600, { available: false });
    expect(state.supersession.outcome).toBe('superseded_ambiguous');
  });

  test('discretionary 11:00 same-day exit => superseded_discretionary', () => {
    const state = stateWithExit(signalDate, signalCloseEpoch - 3600, { available: true, complete: true, byEpoch: { [signalCloseEpoch - 3600]: 'discretionary' } });
    expect(state.supersession.outcome).toBe('superseded_discretionary');
  });

  test('an after-close exit on the signal date is NOT a pre-signal supersession', () => {
    const state = stateWithExit(signalDate, signalCloseEpoch + 600, { available: true, complete: true, byEpoch: { [signalCloseEpoch + 600]: 'protective' } });
    expect(state.supersession.outcome).toBe('none');
    expect(state.execution).toBeTruthy();
  });

  test('a protective exit on a prior session remains superseded', () => {
    const prior = dates[18];
    const priorClose = regularSessionBounds(prior).closeEpoch;
    const state = stateWithExit(prior, priorClose - 3600, { available: true, complete: true, byEpoch: { [priorClose - 3600]: 'protective' } });
    expect(state.signal).toBeTruthy();
    expect(state.supersession.outcome).toBe('superseded_protective');
  });
});

describe('resolveTrailingState — explicit activation validation (F4)', () => {
  const daily = {
    authoritative: true,
    entryIndex: 2,
    completedThroughIndex: 5,
    indexMap: new Map([['2026-03-10', 0], ['2026-03-11', 1], ['2026-03-12', 2], ['2026-03-13', 3], ['2026-03-16', 4], ['2026-03-17', 5]]),
    bars: [
      { date: '2026-03-10', close: 100 },
      { date: '2026-03-11', close: 100 },
      { date: '2026-03-12', close: 100 },
      { date: '2026-03-13', close: 100 },
      { date: '2026-03-16', close: 100 },
      { date: '2026-03-17', close: 100 }
    ]
  };
  const policy = { trailingActivation: 'explicit', trailingActivationSource: 'trailing_ma', executionWindowMinutes: 30 };

  function state({ session, fillsState = { available: true, positionClosed: false }, phase = 'activated' }) {
    return ManagementQualityService.resolveTrailingState({
      policy,
      partialTrigger: { status: 'never_reached' },
      partialCompletion: { completed: false },
      partialExit: { outcome: 'none' },
      fillsState,
      daily,
      nowEpoch: 0,
      trailingPhase: phase,
      sessionIndexForDate: (d) => daily.indexMap.get(d) ?? null,
      executionWindowMinutes: 30,
      stopExecutionClassification: { available: false },
      userInputs: { trailing_phase: phase, trailing_activation_session: session, trailing_ma_period: 20 }
    });
  }

  test('a valid activation session on a real trading session at/after entry is accepted', () => {
    const result = state({ session: '2026-03-12' });
    expect(result.active).toBe(true);
    expect(result.activationResolved).toBe(true);
    expect(result.activationSessionIndex).toBe(2);
  });

  test('an activation session before the entry is rejected', () => {
    const result = state({ session: '2026-03-10' });
    expect(result.active).toBe(false);
    expect(result.inactiveReason).toBe('activation_session_before_entry');
  });

  test('a weekend/non-session activation date is rejected rather than shifted', () => {
    const result = state({ session: '2026-03-14' }); // Saturday, not in the daily evidence
    expect(result.active).toBe(false);
    expect(result.inactiveReason).toBe('activation_session_not_a_trading_session');
  });

  test('an activation after the position was fully closed is rejected', () => {
    const result = state({
      session: '2026-03-16',
      fillsState: { available: true, positionClosed: true, lastClosingSessionDate: '2026-03-12' }
    });
    expect(result.active).toBe(false);
    expect(result.inactiveReason).toBe('activation_session_after_position_closed');
  });
});

describe('resolveTrailingApplicability — required-input transitions (F4)', () => {
  const explicit = { trailingActivation: 'explicit' };

  test('explicit with no phase assertion requires trailing_phase only', () => {
    const r = ManagementQualityService.resolveTrailingApplicability({
      policy: explicit, partialTrigger: { status: 'never_reached' }, partialCompletion: { completed: false },
      partialExit: { outcome: 'none' }, trailingPhase: null, activationSessionEstablished: false
    });
    expect(r.phaseRequired).toBe(true);
    expect(r.smaRequired).toBe(false);
    expect(r.activationSessionRequired).toBe(false);
  });

  test('explicit activated with no session requires the activation boundary and an SMA', () => {
    const r = ManagementQualityService.resolveTrailingApplicability({
      policy: explicit, partialTrigger: { status: 'never_reached' }, partialCompletion: { completed: false },
      partialExit: { outcome: 'none' }, trailingPhase: 'activated', activationSessionEstablished: false
    });
    expect(r.activationSessionRequired).toBe(true);
    expect(r.smaRequired).toBe(true);
  });

  test('explicit activated with a session but no SMA requires trailing_ma_period', () => {
    const r = ManagementQualityService.resolveTrailingApplicability({
      policy: explicit, partialTrigger: { status: 'never_reached' }, partialCompletion: { completed: false },
      partialExit: { outcome: 'none' }, trailingPhase: 'activated', activationSessionEstablished: true
    });
    expect(r.activationSessionRequired).toBe(false);
    expect(r.smaRequired).toBe(true);
  });

  test('explicit not_activated requires nothing', () => {
    const r = ManagementQualityService.resolveTrailingApplicability({
      policy: explicit, partialTrigger: { status: 'never_reached' }, partialCompletion: { completed: false },
      partialExit: { outcome: 'none' }, trailingPhase: 'not_activated', activationSessionEstablished: false
    });
    expect(r.phaseRequired).toBe(false);
    expect(r.smaRequired).toBe(false);
    expect(r.activationSessionRequired).toBe(false);
  });
});

describe('explicit activation end-to-end (F4)', () => {
  function explicitConfig() {
    const config = JSON.parse(JSON.stringify(CONFIG));
    const trailing = config.dimensions.management.criteria.find((c) => c.key === 'trailing_ma');
    trailing.parameters.activation = 'explicit';
    return config;
  }

  test('prepare requires trailing_phase first and not the SMA/session', async () => {
    installDbRouter(explicitConfig());
    const payload = await ManagementQualityService.prepare(USER_ID, TRADE_ID, { evaluationId: EVAL_ID });
    expect(payload.requiredManagementUserInputs).toContain('trailing_phase');
    expect(payload.requiredManagementUserInputs).not.toContain('trailing_ma_period');
    expect(payload.requiredManagementUserInputs).not.toContain('trailing_activation_session');
    expect(payload.trailingMa.phaseRequired).toBe(true);
  });

  test('prepare requires the activation session and the SMA once the phase is activated', async () => {
    const evaluation = evaluationRow();
    evaluation.user_inputs = { trailing_phase: 'activated' };
    evaluationService.getEvaluation.mockResolvedValue(evaluation);
    installDbRouter(explicitConfig());
    const payload = await ManagementQualityService.prepare(USER_ID, TRADE_ID, { evaluationId: EVAL_ID });
    expect(payload.requiredManagementUserInputs).toContain('trailing_activation_session');
    expect(payload.requiredManagementUserInputs).toContain('trailing_ma_period');
    expect(payload.requiredManagementUserInputs).not.toContain('trailing_phase');
  });

  test('evaluate rejects an activation session that is not a trading session', async () => {
    installDbRouter(explicitConfig());
    await expect(
      ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: EVAL_ID,
        userInputs: { trailing_phase: 'activated', trailing_activation_session: '2026-04-01', trailing_ma_period: 20 }
      })
    ).rejects.toMatchObject({ code: 'INVALID_ACTIVATION_SESSION' });
  });

  test('evaluate rejects an activation session before the entry', async () => {
    installDbRouter(explicitConfig());
    await expect(
      ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: EVAL_ID,
        userInputs: { trailing_phase: 'activated', trailing_activation_session: '2026-03-05', trailing_ma_period: 20 }
      })
    ).rejects.toMatchObject({ code: 'INVALID_ACTIVATION_SESSION' });
  });

  test('evaluate accepts an exact valid activation session', async () => {
    installDbRouter(explicitConfig());
    const payload = await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_phase: 'activated', trailing_activation_session: '2026-03-12', trailing_ma_period: 20 }
    });
    expect(payload.evaluation).toBeTruthy();
    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    expect(data.trailingActivation).toMatchObject({ mode: 'establish', session: '2026-03-12' });
  });
});

describe('crossing provenance (F3)', () => {
  test('a candle interval keeps the actual provider/cache source', async () => {
    await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_ma_period: 20 }
    });
    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    expect(data.managementEvidence.partial_trigger.crossing_precision).toBe('1min_bar');
    expect(data.managementEvidence.partial_trigger.crossing_source).toBe('test_intraday');
  });

  test('an exact execution_print crossing keeps source executions_jsonb (not the intraday provider)', async () => {
    const printTrade = tradeRow({
      executions: [
        { action: 'buy', quantity: 200, price: 106, datetime: '2026-03-10T14:30:00.000Z' },
        { action: 'sell', quantity: 100, price: 110, datetime: '2026-03-12T15:00:00.000Z' }
      ]
    });
    db.query.mockImplementation((sql) => {
      if (sql.includes('FROM trades')) return Promise.resolve({ rows: [printTrade] });
      if (sql.includes('FROM quality_profile_versions v') && sql.includes('p.name AS profile_name')) {
        return Promise.resolve({ rows: [{ id: VERSION_ID, version_number: 1, schema_version: 1, configuration: CONFIG, profile_id: 'profile-1', profile_name: 'Canonical BO' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const entryOpen = Math.floor(Date.parse('2026-03-10T13:30:00.000Z') / 1000);
    // The entry-session daily high must reflect the print, otherwise the daily
    // high short-circuits to a definitive no-cross.
    const barsWithPrint = DAILY_BARS.map((bar) =>
      bar.date === ENTRY_SESSION ? { ...bar, high: 106 } : bar
    );
    loadDailyEvidence.mockResolvedValue({ bars: barsWithPrint, source: 'finnhub', completeness: 'verified', error: null });
    loadSessionIntradayBars.mockImplementation(async (symbol, date) => {
      if (date === '2026-03-10') {
        return { available: true, source: 'test_provider', bars: [{ time: entryOpen, high: 101, low: 100, close: 101 }] };
      }
      return { available: false, bars: [], source: null, reason: 'no intraday' };
    });

    await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_ma_period: 20 }
    });
    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    expect(data.managementEvidence.partial_trigger.crossing_precision).toBe('execution_print');
    expect(data.managementEvidence.partial_trigger.crossing_source).toBe('executions_jsonb');
  });
});

describe('evaluate explicit required-input order (F2)', () => {
  function explicitConfig() {
    const config = JSON.parse(JSON.stringify(CONFIG));
    config.dimensions.management.criteria.find((c) => c.key === 'trailing_ma').parameters.activation = 'explicit';
    return config;
  }

  test('no phase assertion => INPUT_REQUIRED field trailing_phase first (not trailing_ma_period)', async () => {
    installDbRouter(explicitConfig());
    await expect(
      ManagementQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID })
    ).rejects.toMatchObject({ code: 'INPUT_REQUIRED', details: { field: 'trailing_phase' } });
  });

  test('phase=not_activated => no SMA/session required', async () => {
    installDbRouter(explicitConfig());
    const payload = await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_phase: 'not_activated' }
    });
    expect(payload.evaluation).toBeTruthy();
    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    const trailing = data.managementResults.criterionResults.find((r) => r.key === 'trailing_ma');
    expect(trailing.status).toBe('NOT_APPLICABLE');
  });

  test('phase=activated with no session => INPUT_REQUIRED field trailing_activation_session (before the SMA)', async () => {
    installDbRouter(explicitConfig());
    await expect(
      ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: EVAL_ID,
        userInputs: { trailing_phase: 'activated' }
      })
    ).rejects.toMatchObject({ code: 'INPUT_REQUIRED', details: { field: 'trailing_activation_session' } });
  });

  test('phase=activated with a valid session but no SMA => INPUT_REQUIRED field trailing_ma_period', async () => {
    installDbRouter(explicitConfig());
    await expect(
      ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: EVAL_ID,
        userInputs: { trailing_phase: 'activated', trailing_activation_session: '2026-03-12' }
      })
    ).rejects.toMatchObject({ code: 'INPUT_REQUIRED', details: { field: 'trailing_ma_period' } });
  });
});

describe('resolveTrailingState — after_partial activation follows the completion instant (F2)', () => {
  const { regularSessionBounds } = require('../../../src/services/quality/entry/sessionTime');
  const dates = ['2026-04-01', '2026-04-02', '2026-04-03', '2026-04-06', '2026-04-07', '2026-04-08',
    '2026-04-09', '2026-04-10', '2026-04-13', '2026-04-14', '2026-04-15', '2026-04-16'];
  const closes = dates.map(() => 100);
  closes[10] = 90; // below-MA close on the partial-completion session
  const bars = dates.map((date, i) => ({ date, close: closes[i] }));
  const daily = {
    authoritative: true,
    entryIndex: 0,
    completedThroughIndex: 11,
    indexMap: new Map(dates.map((date, i) => [date, i])),
    bars
  };
  const bounds10 = regularSessionBounds(dates[10]);

  function state(partialCompletion) {
    return ManagementQualityService.resolveTrailingState({
      policy: { trailingActivation: 'after_partial', trailingActivationSource: 'trailing_ma', executionWindowMinutes: 30 },
      partialTrigger: { status: 'triggered' },
      partialCompletion,
      partialExit: { outcome: 'none' },
      fillsState: { available: true, positionClosed: false },
      daily,
      nowEpoch: 0,
      trailingPhase: null,
      sessionIndexForDate: (d) => daily.indexMap.get(d) ?? null,
      executionWindowMinutes: 30,
      stopExecutionClassification: { available: false },
      userInputs: { trailing_ma_period: 10 }
    });
  }

  test('intraday 15:00 completion => that session close may be the first MA signal', () => {
    const result = state({
      completed: true,
      completionSessionIndex: 10,
      completionSessionDate: dates[10],
      completionTimeEpoch: bounds10.openEpoch + 5 * 3600 // 15:00
    });
    expect(result.active).toBe(true);
    expect(result.activationSessionIndex).toBe(10);
    expect(result.partialCompletionBeforeClose).toBe(true);
    expect(result.signal).toBeTruthy();
    expect(result.signal.sessionIndex).toBe(10);
  });

  test('after-hours 17:00 completion => that day close MUST NOT signal; next session starts the search', () => {
    const result = state({
      completed: true,
      completionSessionIndex: 10,
      completionSessionDate: dates[10],
      completionTimeEpoch: bounds10.closeEpoch + 3600 // 17:00
    });
    expect(result.active).toBe(true);
    expect(result.activationSessionIndex).toBe(11);
    expect(result.partialCompletionBeforeClose).toBe(false);
    expect(result.signal).toBeNull();
  });

  test('completion exactly at the regular-session close => that close is not a post-activation signal', () => {
    const result = state({
      completed: true,
      completionSessionIndex: 10,
      completionSessionDate: dates[10],
      completionTimeEpoch: bounds10.closeEpoch
    });
    expect(result.activationSessionIndex).toBe(11);
    expect(result.signal).toBeNull();
  });

  test('after-hours Friday completion => activation starts the next actual session (Monday), not Saturday', () => {
    const bounds7 = regularSessionBounds(dates[7]); // 2026-04-10 (Fri)
    const result = state({
      completed: true,
      completionSessionIndex: 7,
      completionSessionDate: dates[7],
      completionTimeEpoch: bounds7.closeEpoch + 3600
    });
    expect(result.activationSessionIndex).toBe(8);
    expect(result.activationSessionDate).toBe('2026-04-13'); // Monday
  });

  test('missing completion timestamp => UNKNOWN activation, not scan-from-session-start', () => {
    const result = state({
      completed: true,
      completionSessionIndex: 10,
      completionSessionDate: dates[10],
      completionTimeEpoch: null
    });
    expect(result.active).toBe(false);
    expect(result.activationResolved).toBe(false);
    expect(result.inactiveReason).toBe('partial_completion_time_unknown');
  });
});

describe('Day1 uncertainty corridor — orchestrator wiring (F1)', () => {
  test('fills the corridor end from the confirmed earliest_day crossing evidence', async () => {
    const day3 = addDays(ENTRY_SESSION, 2);
    const day1Open = Math.floor(Date.parse(`${ENTRY_SESSION}T13:30:00.000Z`) / 1000);
    const day3Open = Math.floor(Date.parse(`${day3}T13:30:00.000Z`) / 1000);
    // Entry-session daily high >= +1R so the Day-1 path is evaluated; Day 2 remains below.
    const bars = DAILY_BARS.map((bar) => (bar.date === ENTRY_SESSION ? { ...bar, high: 106 } : bar));
    loadDailyEvidence.mockResolvedValue({ bars, source: 'finnhub', completeness: 'verified', error: null });
    loadSessionIntradayBars.mockImplementation(async (symbol, date) => {
      if (date === ENTRY_SESSION) {
        // Day 1: containing-only evidence; the post-entry path is incomplete.
        return { available: true, source: 'test_intraday', bars: [{ time: day1Open, high: 101, low: 100, close: 101 }] };
      }
      if (date === day3) {
        return { available: true, source: 'test_intraday', bars: [{ time: day3Open, high: 106, low: 100, close: 105 }] };
      }
      return { available: false, bars: [], source: null, reason: 'no intraday' };
    });

    await ManagementQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: { trailing_ma_period: 20 }
    });
    const data = evaluationService.saveManagementProgress.mock.calls[0][2];
    const boundary = data.managementEvidence.partial_trigger.boundary;
    expect(data.managementEvidence.partial_trigger.status).toBe('triggered');
    expect(boundary.uncertain).toBe(true);
    expect(boundary.uncertainty_basis).toBe('day1_vs_earliest_day');
    expect(boundary.uncertainty_start).toBe(day3Open);
    expect(boundary.uncertainty_end).toBe(day3Open + 60);
    expect(boundary.epoch).toBeNull();
    expect(boundary.ordering_known).toBe(false);
  });
});
