'use strict';

jest.mock('../../../src/config/database', () => ({
  query: jest.fn()
}));

jest.mock('../../../src/services/quality/marketEvidenceService', () => ({
  loadDailyEvidence: jest.fn()
}));

jest.mock('../../../src/services/quality/profileService', () => ({
  findById: jest.fn(),
  findByName: jest.fn(),
  getCurrentVersion: jest.fn(),
  ensureCanonicalBO: jest.fn(),
  createProfile: jest.fn(),
  createVersion: jest.fn()
}));

const db = require('../../../src/config/database');
const profileService = require('../../../src/services/quality/profileService');
const { loadDailyEvidence } = require('../../../src/services/quality/marketEvidenceService');
const SetupQualityService = require('../../../src/services/quality/setupQualityService');
const { getCanonicalBOConfig } = require('../../../src/services/quality/canonicalBO');
const { buildCanonicalBOSeries, RESOLUTION_INDEX, BASE_END_INDEX, PIVOT_PRICE } = require('./canonicalBOScenario');

const USER_ID = 'user-1';
const TRADE_ID = 'trade-1';
const VERSION_ID = 'version-1';
const EVAL_ID = 'eval-1';

const CANONICAL_CONFIG = getCanonicalBOConfig();

function makeEvaluationRow(overrides = {}) {
  return {
    id: EVAL_ID,
    user_id: USER_ID,
    trade_id: TRADE_ID,
    profile_version_id: VERSION_ID,
    status: 'draft',
    setup_score: null,
    setup_grade: null,
    setup_compliance: null,
    setup_coverage: null,
    entry_score: null,
    entry_grade: null,
    entry_compliance: null,
    entry_coverage: null,
    management_score: null,
    management_grade: null,
    management_compliance: null,
    management_coverage: null,
    user_inputs: null,
    detected_context: null,
    evidence_snapshot: null,
    results: null,
    evaluated_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    ...overrides
  };
}

let scenario;
let tradeRow;
let updateCall;

function installDbRouter(overrides = {}) {
  db.query.mockReset();
  db.query.mockImplementation((sql, params = []) => {
    if (sql.includes('UPDATE trade_quality_evaluations')) {
      if (sql.includes('results = $3')) {
        // saveSetupProgress UPDATE (terminal immutability is preserved by the
        // WHERE ... status NOT IN guard inside the SQL).
        updateCall = { sql, params };
        const results = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
        return {
          rows: [
            makeEvaluationRow({
              status: 'draft',
              results,
              evidence_snapshot: params[3],
              user_inputs: params[4],
              detected_context: params[5],
              setup_score: params[6],
              setup_grade: params[7],
              setup_compliance: params[8],
              setup_coverage: params[9]
            })
          ]
        };
      }
      // prepare() detection-context refresh (evidence_snapshot / detected_context).
      return {
        rows: [makeEvaluationRow({ evidence_snapshot: params[2], detected_context: params[3] })]
      };
    }
    if (sql.includes('SELECT e.id, e.status, v.configuration')) {
      // saveSetupProgress lookup against the immutable profile version.
      return {
        rows: [{ id: EVAL_ID, status: overrides.evalStatus || 'draft', configuration: CANONICAL_CONFIG }]
      };
    }
    if (sql.includes('FROM quality_profile_versions v') && sql.includes('p.name AS profile_name')) {
      return {
        rows: [
          {
            id: VERSION_ID,
            version_number: 1,
            schema_version: 1,
            configuration: CANONICAL_CONFIG,
            profile_id: 'profile-1',
            profile_name: 'Canonical BO'
          }
        ]
      };
    }
    if (sql.includes('FROM trades')) {
      return { rows: tradeRow ? [tradeRow] : [] };
    }
    if (sql.includes('INSERT INTO trade_quality_evaluations')) {
      return { rows: [makeEvaluationRow()] };
    }
    if (sql.includes('FROM trade_quality_evaluations') && sql.includes('ORDER BY created_at')) {
      return { rows: [] };
    }
    if (sql.includes('FROM trade_quality_evaluations')) {
      return { rows: overrides.evaluationRows ? overrides.evaluationRows : [makeEvaluationRow()] };
    }
    return { rows: [] };
  });
}

function confirmedInputs({ pivotSource = 'detected_confirmed', baseSource = 'detected_confirmed' } = {}) {
  return {
    leader_confirmed: true,
    base_start: { date: scenario.dateAt(70), source: baseSource },
    pivot: {
      price: PIVOT_PRICE,
      date: scenario.dateAt(70),
      source: pivotSource,
      detectionConfidence: 'high'
    }
  };
}

function resultByKey(evaluation) {
  const rows = evaluation.results.setup.criterionResults;
  return new Map(rows.map((row) => [row.key, row]));
}

beforeEach(() => {
  scenario = buildCanonicalBOSeries();
  tradeRow = {
    id: TRADE_ID,
    user_id: USER_ID,
    symbol: 'TEST',
    side: 'long',
    instrument_type: 'stock',
    entry_time: `${scenario.dateAt(RESOLUTION_INDEX)}T18:00:00.000Z`,
    exit_time: null,
    trade_date: scenario.dateAt(RESOLUTION_INDEX)
  };
  loadDailyEvidence.mockReset();
  loadDailyEvidence.mockResolvedValue({ bars: scenario.bars, source: 'test', error: null });
  installDbRouter();
});

describe('SetupQualityService.evaluate', () => {
  test('persists NON-TERMINAL Setup progress with all 8 criteria and the Setup summary', async () => {
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: confirmedInputs()
    });

    expect(result.evaluation.status).toBe('draft');
    expect(result.evaluation.results.setup).toBeDefined();
    expect(result.evaluation.results.entry).toBeNull();
    expect(result.evaluation.results.management).toBeNull();
    expect(result.evaluation.setup_compliance).toBe('PASS');
    expect(result.evaluation.setup_grade).toBe('A');
    expect(result.evaluation.setup_coverage).toBe(100);

    const results = resultByKey(result.evaluation);
    expect(results.size).toBe(8);
    for (const key of ['leader', 'prior_move', 'base_duration', 'higher_lows', 'range_contraction', 'volume_contraction', 'ma_trend', 'pivot_quality']) {
      expect(results.get(key).status).toBe('PASS');
    }
  });

  test('snapshots the exact evidence, semantic inputs and boundary provenance', async () => {
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: confirmedInputs()
    });
    const evaluation = result.evaluation;

    expect(evaluation.evidence_snapshot.symbol).toBe('TEST');
    expect(evaluation.evidence_snapshot.entrySessionDate).toBe(scenario.dateAt(RESOLUTION_INDEX));
    expect(evaluation.evidence_snapshot.setupBoundary.resolutionDate).toBe(scenario.dateAt(RESOLUTION_INDEX));
    expect(evaluation.evidence_snapshot.setupBoundary.baseEndDate).toBe(scenario.dateAt(BASE_END_INDEX));

    expect(evaluation.user_inputs.leader_confirmed).toBe(true);
    expect(evaluation.user_inputs.base_start.source).toBe('detected_confirmed');
    expect(evaluation.user_inputs.pivot.source).toBe('detected_confirmed');
    expect(evaluation.detected_context.boundary.method).toBe('first_daily_high_above_confirmed_pivot');
    expect(evaluation.detected_context.boundary.pivotPrice).toBe(PIVOT_PRICE);
  });

  test('a late actual entry cannot move the setup boundary or Setup results', async () => {
    // Entry is 8 sessions after the breakout session.
    tradeRow.entry_time = `${scenario.dateAt(RESOLUTION_INDEX + 8)}T18:00:00.000Z`;
    const late = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: confirmedInputs()
    });
    expect(late.evaluation.evidence_snapshot.setupBoundary.resolutionDate).toBe(scenario.dateAt(RESOLUTION_INDEX));
    expect(late.evaluation.evidence_snapshot.setupBoundary.baseEndDate).toBe(scenario.dateAt(BASE_END_INDEX));
    expect(late.evaluation.detected_context.boundary.upperBoundDate).toBe(scenario.dateAt(RESOLUTION_INDEX + 8));
    expect(late.evaluation.evidence_snapshot.entrySessionDate).toBe(scenario.dateAt(RESOLUTION_INDEX + 8));
  });

  test('user-adjusted Base Start/Pivot provenance is retained downstream', async () => {
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: confirmedInputs({ pivotSource: 'user_adjusted', baseSource: 'user_adjusted' })
    });
    const evaluation = result.evaluation;
    expect(evaluation.user_inputs.base_start.source).toBe('user_adjusted');
    expect(evaluation.user_inputs.pivot.source).toBe('user_adjusted');
    expect(evaluation.detected_context.boundary.baseStartSource).toBe('user_adjusted');
    expect(evaluation.detected_context.boundary.pivotSource).toBe('user_adjusted');
  });

  test('rejects a confirmed pivot/base start that never resolved before the entry', async () => {
    const inputs = confirmedInputs();
    inputs.pivot.price = 5000;
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: inputs })
    ).rejects.toMatchObject({ code: 'NO_RESOLUTION_SESSION' });
  });

  test('rejects semantic inputs that are not valid trading sessions or types', async () => {
    const badBase = confirmedInputs();
    badBase.base_start = { date: '1999-01-01', source: 'user_adjusted' };
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: badBase })
    ).rejects.toMatchObject({ code: 'BASE_START_NOT_A_SESSION' });

    const badLeader = confirmedInputs();
    badLeader.leader_confirmed = 'yes';
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: badLeader })
    ).rejects.toThrow(/boolean/);
  });

  test('enforces trade/evaluation ownership', async () => {
    // Evaluation belongs to a different trade.
    installDbRouter({ evaluationRows: [makeEvaluationRow({ trade_id: 'other-trade' })] });
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: confirmedInputs() })
    ).rejects.toMatchObject({ code: 'EVALUATION_NOT_FOUND' });

    // Trade not owned (evaluation exists for this trade, but no trade row).
    installDbRouter();
    tradeRow = null;
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: confirmedInputs() })
    ).rejects.toMatchObject({ code: 'TRADE_NOT_FOUND' });
  });

  test('never rewrites a terminal evaluation', async () => {
    installDbRouter({ evaluationRows: [makeEvaluationRow({ status: 'completed' })] });
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: confirmedInputs() })
    ).rejects.toMatchObject({ code: 'EVALUATION_TERMINAL' });
  });

  test('requires evaluationId (prepare first)', async () => {
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { userInputs: confirmedInputs() })
    ).rejects.toMatchObject({ code: 'EVALUATION_REQUIRED' });
  });

  test('reuses the prepare() evidence snapshot instead of re-fetching market data', async () => {
    // First evaluation carries a stored snapshot (like a real prepare()).
    const snapshot = {
      symbol: 'TEST',
      entrySessionDate: scenario.dateAt(RESOLUTION_INDEX),
      source: 'finnhub',
      bars: scenario.bars
    };
    installDbRouter({
      evaluationRows: [makeEvaluationRow({ evidence_snapshot: snapshot })]
    });
    loadDailyEvidence.mockClear();

    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: EVAL_ID,
      userInputs: confirmedInputs()
    });
    expect(loadDailyEvidence).not.toHaveBeenCalled();
    expect(result.evaluation.evidence_snapshot.bars).toHaveLength(scenario.bars.length);
  });

  test('rejects a detected_confirmed pivot without its detected session date', async () => {
    const inputs = confirmedInputs();
    delete inputs.pivot.date;
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: inputs })
    ).rejects.toMatchObject({ code: 'PIVOT_DATE_REQUIRED' });
  });
});

describe('SetupQualityService.prepare', () => {
  beforeEach(() => {
    profileService.ensureCanonicalBO.mockResolvedValue({ id: 'profile-1', name: 'Canonical BO' });
    profileService.getCurrentVersion.mockResolvedValue({
      id: VERSION_ID,
      version_number: 1,
      schema_version: 1,
      configuration: CANONICAL_CONFIG
    });
  });

  test('returns detections, evidence availability and a draft evaluation id', async () => {
    const result = await SetupQualityService.prepare(USER_ID, TRADE_ID);

    expect(result.evaluation).toBeDefined();
    expect(result.evaluation.status).toBe('draft');
    expect(result.detectedBaseStart.date).toBe(scenario.dateAt(70));
    expect(result.detectedPivot.price).toBe(PIVOT_PRICE);
    expect(result.detectedPivot.detectionConfidence).toBe('high');
    expect(result.profile.name).toBe('Canonical BO');
    expect(result.profileVersion.versionNumber).toBe(1);
    expect(result.requiredUserInputs).toEqual(['leader_confirmed', 'base_start', 'pivot']);
    expect(result.evidence.sessionCount).toBe(scenario.bars.length);
    expect(result.unavailableEvidence).toEqual([]);
  });

  test('a late entry never contaminates proposed detections with post-breakout bars', async () => {
    // The actual entry happens 8 sessions after the breakout; post-breakout
    // bars rise far above the base top, so an unconstrained Base Start search
    // would fail. prepare() must still propose the pre-breakout Base Start
    // (index 70) and Pivot (102) by bounding detection at the resolved D-1.
    tradeRow.entry_time = `${scenario.dateAt(RESOLUTION_INDEX + 8)}T18:00:00.000Z`;
    const result = await SetupQualityService.prepare(USER_ID, TRADE_ID);
    expect(result.detectedBaseStart.date).toBe(scenario.dateAt(70));
    expect(result.detectedPivot.price).toBe(PIVOT_PRICE);
    // Base Start search was bounded by the real pre-breakout D-1 (index 94).
    const detectedContext = result.evaluation.detected_context || {};
    expect(detectedContext.detectionEvidence.baseStart.searchEndDate).toBe(scenario.dateAt(BASE_END_INDEX));
  });
});
