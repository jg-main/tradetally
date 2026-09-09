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
let existingDraft;
let evaluationSeq;
let updateCall;

function installDbRouter(overrides = {}) {
  db.query.mockReset();
  db.query.mockImplementation((sql, params = []) => {
    if (sql.includes('UPDATE trade_quality_evaluations')) {
      if (sql.includes('setup_score = NULL')) {
        // clearSetupResults invalidation UPDATE: returns the full row with the
        // Setup result cleared but evidence/detections/user_inputs preserved.
        const preserved = params[2];
        const cleared = {
          results: preserved === null ? null : typeof preserved === 'string' ? JSON.parse(preserved) : preserved,
          setup_score: null,
          setup_grade: null,
          setup_compliance: null,
          setup_coverage: null
        };
        const base = existingDraft || makeEvaluationRow();
        const merged = { ...base, ...cleared };
        if (overrides.trackEvalRow) existingDraft = merged;
        return { rows: [merged] };
      }
      if (sql.includes('results = $3')) {
        // saveSetupProgress UPDATE.
        updateCall = { sql, params };
        const results = typeof params[2] === 'string' ? JSON.parse(params[2]) : params[2];
        const row = makeEvaluationRow({
          status: 'draft',
          results,
          evidence_snapshot: params[3],
          user_inputs: params[4],
          detected_context: params[5],
          setup_score: params[6],
          setup_grade: params[7],
          setup_compliance: params[8],
          setup_coverage: params[9]
        });
        if (overrides.trackEvalRow) existingDraft = row;
        return { rows: [row] };
      }
      // prepare() context refresh: evidence_snapshot / detected_context / user_inputs.
      const row = makeEvaluationRow({
        evidence_snapshot: params[2],
        detected_context: params[3],
        user_inputs: params[4]
      });
      if (overrides.trackEvalRow) existingDraft = row;
      return { rows: [row] };
    }
    if (sql.includes('SELECT e.id, e.status, v.configuration')) {
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
      const row = makeEvaluationRow({ id: `eval-${++evaluationSeq}` });
      if (overrides.trackEvalRow) existingDraft = row;
      return { rows: [row] };
    }
    if (sql.includes('FROM trade_quality_evaluations') && sql.includes('ORDER BY created_at')) {
      // findEvaluationForPrepare existing-draft lookup.
      return { rows: existingDraft ? [existingDraft] : [] };
    }
    if (sql.includes('FROM trade_quality_evaluations')) {
      const rows = overrides.evaluationRows
        ? overrides.evaluationRows
        : existingDraft
          ? [existingDraft]
          : [makeEvaluationRow()];
      return { rows };
    }
    return { rows: [] };
  });
}

// Confirms the machine detections returned by prepare (leader true + both
// confirmations), which is the honest path for a fully detected setup. The
// Base Start confirmation mirrors the base start the returned Pivot was
// derived from (detected_confirmed when machine, user_adjusted otherwise).
function confirmedFromPrepared(prepared) {
  const baseSource =
    prepared.pivotBaseStartSource === 'user_adjusted' ? 'user_adjusted' : 'detected_confirmed';
  return {
    leader_confirmed: true,
    base_start: {
      date: prepared.detectedPivot.derivedFromBaseStart,
      source: baseSource
    },
    pivot: {
      price: prepared.detectedPivot.price,
      date: prepared.detectedPivot.date,
      source: 'detected_confirmed'
    }
  };
}

async function prepareDraft(options = {}) {
  return SetupQualityService.prepare(USER_ID, TRADE_ID, options);
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
  existingDraft = null;
  evaluationSeq = 0;
  updateCall = null;
  loadDailyEvidence.mockReset();
  loadDailyEvidence.mockResolvedValue({
    bars: scenario.bars,
    source: 'finnhub',
    completeness: 'verified',
    error: null
  });
  profileService.ensureCanonicalBO.mockReset().mockResolvedValue({ id: 'profile-1', name: 'Canonical BO' });
  profileService.getCurrentVersion.mockReset().mockResolvedValue({
    id: VERSION_ID,
    version_number: 1,
    schema_version: 1,
    configuration: CANONICAL_CONFIG
  });
  installDbRouter({ trackEvalRow: true });
});

describe('SetupQualityService.prepare', () => {
  test('returns detections, verified evidence and a draft evaluation id', async () => {
    const result = await prepareDraft();
    expect(result.evaluation).toBeDefined();
    expect(result.evaluation.status).toBe('draft');
    expect(result.detectedBaseStart.date).toBe(scenario.dateAt(70));
    expect(result.detectedPivot.price).toBe(PIVOT_PRICE);
    expect(result.detectedPivot.derivedFromBaseStart).toBe(scenario.dateAt(70));
    expect(result.detectedPivot.detectionConfidence).toBe('high');
    expect(result.profile.name).toBe('Canonical BO');
    expect(result.profileVersion.versionNumber).toBe(1);
    expect(result.requiredUserInputs).toEqual(['leader_confirmed', 'base_start', 'pivot']);
    expect(result.evidence.sessionCount).toBe(scenario.bars.length);
    expect(result.evidence.completeness).toBe('verified');
    expect(result.unavailableEvidence).toEqual([]);
  });

  test('re-detects the Pivot from a confirmed/adjusted Base Start on the same evidence', async () => {
    // First prepare: machine Base Start (70) and a Pivot derived from it.
    const first = await prepareDraft();
    expect(first.detectedPivot.derivedFromBaseStart).toBe(scenario.dateAt(70));

    // The user adjusts the Base Start to session 71; the Pivot is re-detected
    // from THAT Base Start and labelled as derived from it.
    const second = await prepareDraft({
      confirmedBaseStart: { date: scenario.dateAt(71), source: 'user_adjusted' }
    });
    expect(second.pivotBaseStartDate).toBe(scenario.dateAt(71));
    expect(second.pivotBaseStartSource).toBe('user_adjusted');
    expect(second.detectedPivot).not.toBeNull();
    expect(second.detectedPivot.derivedFromBaseStart).toBe(scenario.dateAt(71));
    expect(second.evaluation.user_inputs.base_start.source).toBe('user_adjusted');
    // Same evidence snapshot: prepare never re-fetches once a usable snapshot
    // exists on the evaluation.
    expect(loadDailyEvidence).toHaveBeenCalledTimes(1);
  });

  test('a late entry cannot contaminate the evidence returned for proposals (coherent snapshot)', async () => {
    tradeRow.entry_time = `${scenario.dateAt(RESOLUTION_INDEX + 8)}T18:00:00.000Z`;
    const result = await prepareDraft();
    expect(result.evaluation.evidence_snapshot.entrySessionDate).toBe(scenario.dateAt(RESOLUTION_INDEX + 8));
    // Proposals are bounded by the entry session (the spec search upper bound);
    // whatever is returned is derived from the snapshot attached to the
    // returned evaluation.
    expect(result.evidence.sessionCount).toBe(scenario.bars.length);
  });

  test('result-bearing drafts reuse their stored snapshot (no fresh evidence mixing)', async () => {
    // Simulate an existing draft that already holds Setup results + snapshot.
    const storedSnapshot = {
      symbol: 'TEST',
      entrySessionDate: scenario.dateAt(RESOLUTION_INDEX),
      source: 'finnhub',
      completeness: 'verified',
      bars: scenario.bars
    };
    existingDraft = makeEvaluationRow({
      id: EVAL_ID,
      results: { setup: { score: 96 }, entry: null, management: null },
      evidence_snapshot: storedSnapshot,
      user_inputs: {
        leader_confirmed: true,
        base_start: { date: scenario.dateAt(70), source: 'detected_confirmed' },
        pivot: { price: PIVOT_PRICE, date: scenario.dateAt(70), source: 'detected_confirmed' }
      }
    });
    // Provider data has changed since the stored snapshot was captured; it must
    // never be consulted for this evaluation.
    loadDailyEvidence.mockImplementation(() => {
      throw new Error('fresh evidence must not be fetched for a result-bearing draft');
    });

    const result = await prepareDraft();
    expect(loadDailyEvidence).not.toHaveBeenCalled();
    expect(result.evaluation.id).toBe(EVAL_ID);
    expect(result.evaluation.evidence_snapshot.bars).toEqual(storedSnapshot.bars);
    expect(result.evaluation.evidence_snapshot.entrySessionDate).toBe(storedSnapshot.entrySessionDate);
    expect(result.evaluation.evidence_snapshot.completeness).toBe('verified');
    // Detections come from the stored snapshot, which matches the persisted
    // Base Start confirmation.
    expect(result.detectedBaseStart.date).toBe(scenario.dateAt(70));
  });

  test('re-running prepare with persisted results cannot silently change the evidence context', async () => {
    const first = await prepareDraft();
    // Persist Setup results on that draft (as evaluate would).
    existingDraft = makeEvaluationRow({
      id: first.evaluation.id,
      results: { setup: { score: 96 }, entry: null, management: null },
      evidence_snapshot: first.evaluation.evidence_snapshot,
      detected_context: first.evaluation.detected_context,
      user_inputs: {
        leader_confirmed: true,
        base_start: { date: first.detectedBaseStart.date, source: 'detected_confirmed' },
        pivot: {
          price: first.detectedPivot.price,
          date: first.detectedPivot.date,
          source: 'detected_confirmed'
        }
      }
    });
    loadDailyEvidence.mockClear();

    const second = await prepareDraft();
    expect(loadDailyEvidence).not.toHaveBeenCalled();
    expect(second.evaluation.evidence_snapshot).toEqual(first.evaluation.evidence_snapshot);
    expect(second.detectedBaseStart.date).toBe(first.detectedBaseStart.date);
  });

  test('a larger configured lookback expands the provider fetch request accordingly', async () => {
    const clone = () => JSON.parse(JSON.stringify(CANONICAL_CONFIG));

    const first = await prepareDraft();
    const firstWindow = loadDailyEvidence.mock.calls[0][0];
    expect(firstWindow.fromDate).toBeDefined();

    // A fresh evaluation with an expanded detection/prior lookback must request
    // a wider history window (no undocumented fixed ceiling).
    const expandedConfig = clone();
    expandedConfig.dimensions.setup.criteria.find((c) => c.key === 'base_duration').parameters.detection_lookback = 200;
    expandedConfig.dimensions.setup.criteria.find((c) => c.key === 'prior_move').parameters.search_lookback = 200;
    profileService.getCurrentVersion.mockResolvedValue({
      id: 'version-2',
      version_number: 1,
      schema_version: 1,
      configuration: expandedConfig
    });
    existingDraft = null;
    installDbRouter({ trackEvalRow: true });
    await prepareDraft();

    const secondWindow = loadDailyEvidence.mock.calls[1][0];
    expect(secondWindow.fromDate < firstWindow.fromDate).toBe(true);
  });

  test('an invalid Setup profile (missing required parameter) is rejected with PROFILE_CONFIG_INVALID', async () => {
    const broken = JSON.parse(JSON.stringify(CANONICAL_CONFIG));
    delete broken.dimensions.setup.criteria.find((c) => c.key === 'prior_move').parameters.selection;
    profileService.getCurrentVersion.mockResolvedValue({
      id: VERSION_ID,
      version_number: 1,
      schema_version: 1,
      configuration: broken
    });
    await expect(prepareDraft()).rejects.toMatchObject({ code: 'PROFILE_CONFIG_INVALID' });
  });

  test('an unsupported ENABLED Setup criterion is rejected before evaluation', async () => {
    const withExtra = JSON.parse(JSON.stringify(CANONICAL_CONFIG));
    withExtra.dimensions.setup.criteria.push({
      key: 'mystery_quality',
      enabled: true,
      required: true,
      weight: 10,
      parameters: {},
      scoring: { type: 'binary', pass_score: 100, fail_score: 0 }
    });
    profileService.getCurrentVersion.mockResolvedValue({
      id: VERSION_ID,
      version_number: 1,
      schema_version: 1,
      configuration: withExtra
    });
    await expect(prepareDraft()).rejects.toMatchObject({ code: 'PROFILE_CONFIG_INVALID' });
  });

  test('a disabled unused unsupported criterion does not block execution', async () => {
    const withDisabled = JSON.parse(JSON.stringify(CANONICAL_CONFIG));
    withDisabled.dimensions.setup.criteria.push({
      key: 'future_criterion',
      enabled: false,
      required: false,
      weight: 0,
      parameters: {}
    });
    profileService.getCurrentVersion.mockResolvedValue({
      id: VERSION_ID,
      version_number: 1,
      schema_version: 1,
      configuration: withDisabled
    });
    const result = await prepareDraft();
    expect(result.detectedBaseStart).not.toBeNull();
  });

  test('unverified cache-only evidence recovers when a provider later becomes available', async () => {
    loadDailyEvidence
      .mockResolvedValueOnce({
        bars: scenario.bars,
        source: 'historical_cache',
        completeness: 'unverified',
        error: 'cannot verify yet'
      })
      .mockResolvedValueOnce({
        bars: scenario.bars,
        source: 'finnhub',
        completeness: 'verified',
        error: null
      });

    const first = await prepareDraft();
    expect(first.evaluation.evidence_snapshot.completeness).toBe('unverified');
    expect(first.unavailableEvidence).toContain('evidence_completeness');

    // Provider recovers: the second prepare MUST retry the provider chain and
    // replace the provisional unverified snapshot on the same unevaluated draft.
    const second = await prepareDraft();
    expect(loadDailyEvidence).toHaveBeenCalledTimes(2);
    expect(second.evaluation.id).toBe(first.evaluation.id);
    expect(second.evaluation.evidence_snapshot.completeness).toBe('verified');
    expect(second.unavailableEvidence).toEqual([]);

    // Setup can now be evaluated.
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: second.evaluation.id,
      userInputs: confirmedFromPrepared(second)
    });
    expect(result.evaluation.results.setup).toBeDefined();
  });
});

describe('SetupQualityService.evaluate', () => {
  test('persists NON-TERMINAL Setup progress with all 8 criteria and the Setup summary', async () => {
    const prepared = await prepareDraft();
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: prepared.evaluation.id,
      userInputs: confirmedFromPrepared(prepared)
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

  test('snapshots the exact evidence, semantic inputs and server-side detection confidence', async () => {
    const prepared = await prepareDraft();
    const inputs = confirmedFromPrepared(prepared);
    inputs.pivot.detectionConfidence = 'fabricated-by-client'; // must be ignored
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: prepared.evaluation.id,
      userInputs: inputs
    });
    const evaluation = result.evaluation;

    expect(evaluation.evidence_snapshot.symbol).toBe('TEST');
    expect(evaluation.evidence_snapshot.entrySessionDate).toBe(scenario.dateAt(RESOLUTION_INDEX));
    expect(evaluation.evidence_snapshot.completeness).toBe('verified');
    expect(evaluation.evidence_snapshot.setupBoundary.resolutionDate).toBe(scenario.dateAt(RESOLUTION_INDEX));
    expect(evaluation.evidence_snapshot.setupBoundary.baseEndDate).toBe(scenario.dateAt(BASE_END_INDEX));

    expect(evaluation.user_inputs.leader_confirmed).toBe(true);
    expect(evaluation.user_inputs.base_start.source).toBe('detected_confirmed');
    expect(evaluation.user_inputs.pivot.source).toBe('detected_confirmed');
    // Confidence always comes from the server-side stored detection.
    expect(evaluation.user_inputs.pivot.detectionConfidence).toBe('high');
    expect(evaluation.user_inputs.pivot.detectionConfidence).not.toBe('fabricated-by-client');
    expect(evaluation.detected_context.boundary.method).toBe('first_daily_high_above_confirmed_pivot');
    expect(evaluation.detected_context.boundary.pivotPrice).toBe(PIVOT_PRICE);
  });

  test('rejects an arbitrary Base Start labeled detected_confirmed', async () => {
    const prepared = await prepareDraft();
    const inputs = confirmedFromPrepared(prepared);
    inputs.base_start = { date: scenario.dateAt(80), source: 'detected_confirmed' };
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: prepared.evaluation.id,
        userInputs: inputs
      })
    ).rejects.toMatchObject({ code: 'BASE_START_DETECTION_MISMATCH' });
  });

  test('rejects an arbitrary Pivot price/date labeled detected_confirmed', async () => {
    const prepared = await prepareDraft();
    const inputs = confirmedFromPrepared(prepared);
    inputs.pivot = { price: PIVOT_PRICE - 1, date: scenario.dateAt(89), source: 'detected_confirmed' };
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: prepared.evaluation.id,
        userInputs: inputs
      })
    ).rejects.toMatchObject({ code: 'PIVOT_DETECTION_MISMATCH' });
  });

  test('an old Pivot proposal cannot be confirmed as machine-detected after its Base Start context changes', async () => {
    const first = await prepareDraft();
    const oldPivot = { price: first.detectedPivot.price, date: first.detectedPivot.date };
    // User adjusts the Base Start; prepare re-detects the Pivot from session 71.
    const second = await prepareDraft({
      confirmedBaseStart: { date: scenario.dateAt(71), source: 'user_adjusted' }
    });
    expect(second.detectedPivot.derivedFromBaseStart).toBe(scenario.dateAt(71));

    // Confirming the OLD pivot (derived under session 70) as machine-detected
    // must be rejected even though it was a genuine detection earlier.
    const inputs = confirmedFromPrepared(second);
    inputs.pivot = { ...oldPivot, source: 'detected_confirmed' };
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: second.evaluation.id,
        userInputs: inputs
      })
    ).rejects.toMatchObject({ code: 'PIVOT_DETECTION_MISMATCH' });

    // The re-detected pivot under the adjusted Base Start confirms cleanly.
    const ok = confirmedFromPrepared(second);
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: second.evaluation.id,
      userInputs: ok
    });
    expect(result.evaluation.results.setup.compliance).toBe('PASS');
  });

  test('user-adjusted provenance survives persistence', async () => {
    const prepared = await prepareDraft();
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: prepared.evaluation.id,
      userInputs: {
        leader_confirmed: true,
        base_start: { date: scenario.dateAt(71), source: 'user_adjusted' },
        pivot: { price: 103, source: 'user_adjusted' }
      }
    });
    expect(result.evaluation.user_inputs.base_start.source).toBe('user_adjusted');
    expect(result.evaluation.user_inputs.pivot.source).toBe('user_adjusted');
    expect(result.evaluation.detected_context.confirmations.base_start.source).toBe('user_adjusted');
    expect(result.evaluation.detected_context.boundary.pivotSource).toBe('user_adjusted');
  });

  test('a late actual entry cannot move the setup boundary or Setup results', async () => {
    // The actual entry is 8 sessions after the breakout; the authoritative
    // Setup boundary stays at the real breakout D-1 regardless.
    tradeRow.entry_time = `${scenario.dateAt(RESOLUTION_INDEX + 8)}T18:00:00.000Z`;
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: 'eval-late',
      userInputs: {
        leader_confirmed: true,
        base_start: { date: scenario.dateAt(70), source: 'user_adjusted' },
        pivot: { price: PIVOT_PRICE, source: 'user_adjusted' }
      }
    });
    expect(result.evaluation.evidence_snapshot.setupBoundary.resolutionDate).toBe(scenario.dateAt(RESOLUTION_INDEX));
    expect(result.evaluation.evidence_snapshot.setupBoundary.baseEndDate).toBe(scenario.dateAt(BASE_END_INDEX));
  });

  test('rejects a confirmed pivot/base start that never resolved before the entry', async () => {
    const prepared = await prepareDraft();
    const inputs = confirmedFromPrepared(prepared);
    inputs.base_start = { date: scenario.dateAt(70), source: 'user_adjusted' };
    inputs.pivot = { price: 5000, source: 'user_adjusted' };
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: prepared.evaluation.id,
        userInputs: inputs
      })
    ).rejects.toMatchObject({ code: 'NO_RESOLUTION_SESSION' });
  });

  test('rejects semantic inputs that are not valid trading sessions or types', async () => {
    const prepared = await prepareDraft();
    const badBase = confirmedFromPrepared(prepared);
    badBase.base_start = { date: '1999-01-01', source: 'user_adjusted' };
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: prepared.evaluation.id,
        userInputs: badBase
      })
    ).rejects.toMatchObject({ code: 'BASE_START_NOT_A_SESSION' });

    const badLeader = confirmedFromPrepared(prepared);
    badLeader.leader_confirmed = 'yes';
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: prepared.evaluation.id,
        userInputs: badLeader
      })
    ).rejects.toThrow(/boolean/);

    // A Pivot anchored at (or after) the entry session is outside the base.
    const pivotAtEntry = confirmedFromPrepared(prepared);
    pivotAtEntry.base_start = { date: scenario.dateAt(70), source: 'user_adjusted' };
    pivotAtEntry.pivot = {
      price: PIVOT_PRICE,
      date: scenario.dateAt(RESOLUTION_INDEX), // entry session
      source: 'user_adjusted'
    };
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: prepared.evaluation.id,
        userInputs: pivotAtEntry
      })
    ).rejects.toMatchObject({ code: 'PIVOT_AFTER_ENTRY' });
  });

  test('enforces trade/evaluation ownership', async () => {
    // Evaluation belongs to a different trade.
    installDbRouter({ evaluationRows: [makeEvaluationRow({ trade_id: 'other-trade' })], trackEvalRow: true });
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: { leader_confirmed: true } })
    ).rejects.toMatchObject({ code: 'EVALUATION_NOT_FOUND' });

    // Trade not owned.
    installDbRouter({ trackEvalRow: true });
    tradeRow = null;
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: { leader_confirmed: true } })
    ).rejects.toMatchObject({ code: 'TRADE_NOT_FOUND' });
  });

  test('never rewrites a terminal evaluation', async () => {
    installDbRouter({ evaluationRows: [makeEvaluationRow({ status: 'completed' })], trackEvalRow: true });
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { evaluationId: EVAL_ID, userInputs: { leader_confirmed: true } })
    ).rejects.toMatchObject({ code: 'EVALUATION_TERMINAL' });
  });

  test('requires evaluationId (prepare first)', async () => {
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, { userInputs: { leader_confirmed: true } })
    ).rejects.toMatchObject({ code: 'EVALUATION_REQUIRED' });
  });

  test('refuses unverified (cache-only) evidence for scoring', async () => {
    loadDailyEvidence.mockResolvedValue({
      bars: scenario.bars,
      source: 'historical_cache',
      completeness: 'unverified',
      error: 'cannot verify'
    });
    // Fresh evaluation without a stored snapshot -> prepare stores unverified
    // evidence; evaluate must refuse to score session-counting criteria.
    const result = await prepareDraft();
    expect(result.unavailableEvidence).toContain('evidence_completeness');
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: result.evaluation.id,
        userInputs: {
          leader_confirmed: true,
          base_start: { date: scenario.dateAt(70), source: 'user_adjusted' },
          pivot: { price: PIVOT_PRICE, source: 'user_adjusted' }
        }
      })
    ).rejects.toMatchObject({ code: 'EVIDENCE_UNAVAILABLE' });
  });

  test('re-prepare with an adjusted Base Start invalidates stale Setup results', async () => {
    // Evaluate Setup under the machine Base Start (session 70) / detected Pivot.
    const preparedA = await prepareDraft();
    const evA = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: preparedA.evaluation.id,
      userInputs: confirmedFromPrepared(preparedA)
    });
    expect(evA.evaluation.results.setup).toBeDefined();
    expect(evA.evaluation.setup_grade).toBe('A');

    // Re-prepare with an adjusted Base Start (session 71): the Pivot is
    // re-detected from B and the OLD Setup result must be invalidated.
    const reprepared = await prepareDraft({
      confirmedBaseStart: { date: scenario.dateAt(71), source: 'user_adjusted' }
    });
    expect(reprepared.evaluation.results.setup).toBeUndefined();
    expect(reprepared.evaluation.results.entry).toBeNull();
    expect(reprepared.evaluation.results.management).toBeNull();
    expect(reprepared.evaluation.setup_score).toBeNull();
    expect(reprepared.evaluation.setup_grade).toBeNull();
    expect(reprepared.evaluation.setup_compliance).toBeNull();
    expect(reprepared.evaluation.setup_coverage).toBeNull();
    // The stale pivot confirmation must not survive in user_inputs.
    expect(reprepared.evaluation.user_inputs.pivot).toBeUndefined();
    expect(reprepared.evaluation.user_inputs.base_start).toEqual({
      date: scenario.dateAt(71),
      source: 'user_adjusted'
    });
    // The new Pivot detection is derived from the adjusted Base Start.
    expect(reprepared.detectedPivot.derivedFromBaseStart).toBe(scenario.dateAt(71));

    // A reload after re-prepare (GET evaluations row) shows Setup as not
    // evaluated: no stale grade.
    const list = await SetupQualityService.listEvaluations(USER_ID, TRADE_ID);
    expect(list[0].results.setup).toBeUndefined();
    expect(list[0].setup_grade).toBeNull();

    // Re-evaluate under B produces fresh Setup results.
    const evB = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: reprepared.evaluation.id,
      userInputs: confirmedFromPrepared(reprepared)
    });
    expect(evB.evaluation.results.setup).toBeDefined();
    expect(evB.evaluation.setup_compliance).toBe('PASS');
  });
});
