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
      if (overrides.failAtomicUpdate) {
        throw new Error('simulated db failure');
      }
      if (overrides.updateReturnsEmpty) {
        // Simulates a lost compare-and-swap: the row changed (or reached a
        // terminal state) between the read and the UPDATE.
        return { rows: [] };
      }
      // Both Setup write paths (persistPrepareContext and saveSetupProgress)
      // now persist the full coherent state: results, evidence snapshot,
      // user inputs, detected context, and every flat summary column.
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
        setup_coverage: params[9],
        entry_score: params[10],
        entry_grade: params[11],
        entry_compliance: params[12],
        entry_coverage: params[13],
        management_score: params[14],
        management_grade: params[15],
        management_compliance: params[16],
        management_coverage: params[17]
      });
      if (overrides.trackEvalRow) existingDraft = row;
      return { rows: [row] };
    }
    if (sql.includes('v.configuration') && sql.includes('e.profile_version_id')) {
      return {
        rows: [{
          id: EVAL_ID,
          status: overrides.evalStatus || 'draft',
          profile_version_id: VERSION_ID,
          results: (existingDraft && existingDraft.results) || null,
          detected_context: (existingDraft && existingDraft.detected_context) || null,
          evidence_snapshot: (existingDraft && existingDraft.evidence_snapshot) || null,
          user_inputs: (existingDraft && existingDraft.user_inputs) || null,
          configuration: overrides.versionConfiguration || CANONICAL_CONFIG
        }]
      };
    }
    if (sql.includes('FROM quality_profile_versions v') && sql.includes('p.name AS profile_name')) {
      return {
        rows: [
          {
            id: VERSION_ID,
            version_number: 1,
            schema_version: 1,
            configuration: overrides.versionConfiguration || CANONICAL_CONFIG,
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
    expect(reprepared.evaluation.results.setup).toBeNull();
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
    expect(list[0].results.setup).toBeNull();
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

describe('integrity closure (Phase 2 final)', () => {
  function withConfig(configuration) {
    profileService.getCurrentVersion.mockReset().mockResolvedValue({
      id: VERSION_ID,
      version_number: 1,
      schema_version: 1,
      configuration
    });
  }

  test('context change + Setup-result invalidation is a single atomic UPDATE', async () => {
    const preparedA = await prepareDraft();
    await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: preparedA.evaluation.id,
      userInputs: confirmedFromPrepared(preparedA)
    });
    db.query.mockClear();

    await prepareDraft({
      confirmedBaseStart: { date: scenario.dateAt(71), source: 'user_adjusted' }
    });

    const updateCalls = db.query.mock.calls.filter(([sql]) =>
      sql.includes('UPDATE trade_quality_evaluations')
    );
    // Exactly ONE UPDATE: it carries the new context AND the invalidation in the
    // same statement (no separate clear-setup UPDATE can interleave).
    expect(updateCalls).toHaveLength(1);
    const [updateSql, updateParams] = updateCalls[0];
    expect(updateSql).toContain('results = $3');
    expect(updateSql).toContain('evidence_snapshot = $4');
    expect(updateSql).toContain('user_inputs = $5');
    expect(updateSql).toContain('detected_context = $6');
    expect(updateSql).toContain('setup_score = $7');
    expect(updateSql).toContain('entry_score = $11');
    // The single statement writes the invalidated envelope and NULL summaries.
    expect(JSON.parse(updateParams[2])).toEqual({ setup: null, entry: null, management: null });
    expect(updateParams[6]).toBeNull();
    expect(updateParams[10]).toBeNull();
  });

  test('a simulated failure mid-persist cannot leave new context paired with stale Setup results', async () => {
    const preparedA = await prepareDraft();
    await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: preparedA.evaluation.id,
      userInputs: confirmedFromPrepared(preparedA)
    });
    db.query.mockClear();

    // Force the single atomic UPDATE to fail (router override).
    installDbRouter({ trackEvalRow: true, failAtomicUpdate: true });
    db.query.mockClear();

    await expect(
      prepareDraft({ confirmedBaseStart: { date: scenario.dateAt(71), source: 'user_adjusted' } })
    ).rejects.toThrow('simulated db failure');

    // Only the single atomic UPDATE was attempted (no partial second write).
    const updateAttempts = db.query.mock.calls.filter(([sql]) =>
      sql.includes('UPDATE trade_quality_evaluations')
    );
    expect(updateAttempts).toHaveLength(1);
  });

  test('an unchanged context does not clear an existing Setup result', async () => {
    const preparedA = await prepareDraft();
    await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: preparedA.evaluation.id,
      userInputs: confirmedFromPrepared(preparedA)
    });
    db.query.mockClear();

    // Plain re-prepare with no changes (same evidence, same base, same pivot).
    const again = await prepareDraft();
    expect(again.evaluation.results.setup).toBeDefined();
    expect(again.evaluation.setup_grade).toBe('A');
    const updates = db.query.mock.calls
      .map(([sql]) => sql)
      .filter((sql) => sql.includes('UPDATE trade_quality_evaluations'));
    // The context UPDATE runs, but it does NOT clear the Setup result.
    expect(updates).toHaveLength(1);
    expect(updates[0]).not.toContain('setup_score = NULL');
  });

  test('Leader disabled removes leader_confirmed from required inputs and evaluation', async () => {
    const config = JSON.parse(JSON.stringify(CANONICAL_CONFIG));
    config.dimensions.setup.criteria.find((c) => c.key === 'leader').enabled = false;
    withConfig(config);

    const prepared = await prepareDraft();
    expect(prepared.requiredUserInputs).toEqual(['base_start', 'pivot']);

    // Evaluation succeeds WITHOUT leader_confirmed.
    const inputs = confirmedFromPrepared(prepared);
    expect(inputs.leader_confirmed).toBeDefined();
    delete inputs.leader_confirmed;

    installDbRouter({ trackEvalRow: true, versionConfiguration: config });
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: prepared.evaluation.id,
      userInputs: inputs
    });
    const rows = resultByKey(result.evaluation);
    expect(rows.has('leader')).toBe(false);
    expect(rows.size).toBe(7);
    // No leader contribution: enabled weights sum to 80 and all pass.
    expect(result.evaluation.setup_coverage).toBe(100);
    expect(result.evaluation.setup_compliance).toBe('PASS');
    expect(result.evaluation.results.setup.knownWeight).toBe(80);
    expect(result.evaluation.user_inputs.leader_confirmed).toBeUndefined();
  });

  test('Canonical profile still requires Leader/Base Start/Pivot', async () => {
    const prepared = await prepareDraft();
    expect(prepared.requiredUserInputs).toEqual(['leader_confirmed', 'base_start', 'pivot']);
  });

  test('larger MA periods / support period / swing windows enlarge the fetched history', () => {
    const clone = () => JSON.parse(JSON.stringify(CANONICAL_CONFIG));
    const setupDim = (cfg) => cfg.dimensions.setup;
    const later = (config) => SetupQualityService.evidenceWindowDates(scenario.dateAt(RESOLUTION_INDEX), setupDim(config)).fromDate;
    const canonicalDate = later(clone());

    // Keep the structural term small so the MA requirement is the dominant one.
    const baseSmall = () => {
      const cfg = clone();
      cfg.dimensions.setup.criteria.find((c) => c.key === 'base_duration').parameters.detection_lookback = 20;
      cfg.dimensions.setup.criteria.find((c) => c.key === 'prior_move').parameters.search_lookback = 20;
      return cfg;
    };

    // canonical MA (fast 10/slow 20/support 20) vs fast_period > slow_period.
    const maCanon = baseSmall();
    const maFast = baseSmall();
    const fastParams = maFast.dimensions.setup.criteria.find((c) => c.key === 'ma_trend').parameters;
    fastParams.fast_period = 60;
    fastParams.slow_period = 40;
    fastParams.support_period = 20;
    fastParams.slope_lookback = 5;

    // support_period > slow_period drives the requirement instead.
    const supportDominant = baseSmall();
    const supportParams = supportDominant.dimensions.setup.criteria.find((c) => c.key === 'ma_trend').parameters;
    supportParams.slow_period = 20;
    supportParams.support_period = 90;
    supportParams.slope_lookback = 5;

    // Unusually large structural swing windows also expand the request.
    const bigSwings = clone();
    bigSwings.dimensions.setup.criteria.find((c) => c.key === 'base_duration').parameters.detection_lookback = 200;
    bigSwings.dimensions.setup.criteria.find((c) => c.key === 'prior_move').parameters.search_lookback = 200;
    bigSwings.dimensions.setup.criteria.find((c) => c.key === 'prior_move').parameters.swing_left = 20;
    bigSwings.dimensions.setup.criteria.find((c) => c.key === 'prior_move').parameters.swing_right = 20;

    expect(later(maFast) < later(maCanon)).toBe(true);
    expect(later(supportDominant) < later(maFast)).toBe(true);
    expect(later(bigSwings) < canonicalDate).toBe(true);

    // Canonical request remains sufficient for the canonical regression scenario.
    const canonicalSessions = SetupQualityService.requiredHistorySessions(setupDim(clone()));
    expect(canonicalSessions).toBeGreaterThan(130);
  });

  test('provenance-only Base Start change invalidates stale Setup results but keeps the identical machine Pivot', async () => {
    const preparedA = await prepareDraft();
    await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: preparedA.evaluation.id,
      userInputs: confirmedFromPrepared(preparedA)
    });
    const machineBaseDate = preparedA.detectedBaseStart.date;

    // Same date, source changes detected_confirmed -> user_adjusted.
    const reprepared = await prepareDraft({
      confirmedBaseStart: { date: machineBaseDate, source: 'user_adjusted' }
    });
    // Stale Setup invalidated (atomic UPDATE carried the clear).
    expect(reprepared.evaluation.results.setup).toBeNull();
    expect(reprepared.evaluation.setup_grade).toBeNull();
    // Structural date is identical, so the machine Pivot is NOT needlessly
    // invalidated: it remains derived from the same date and still confirms.
    expect(reprepared.evaluation.user_inputs.base_start).toEqual({
      date: machineBaseDate,
      source: 'user_adjusted'
    });
    expect(reprepared.evaluation.user_inputs.pivot).toBeDefined();
    expect(reprepared.detectedPivot.derivedFromBaseStart).toBe(machineBaseDate);

    // Re-evaluate under the user_adjusted provenance: persisted evidence must
    // reflect user_adjusted.
    const inputs = confirmedFromPrepared(reprepared); // pivot detected_confirmed
    inputs.base_start = { date: machineBaseDate, source: 'user_adjusted' };
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: reprepared.evaluation.id,
      userInputs: inputs
    });
    expect(result.evaluation.results.setup).toBeDefined();
    expect(result.evaluation.user_inputs.base_start.source).toBe('user_adjusted');
    const duration = resultByKey(result.evaluation).get('base_duration');
    expect(duration.evidence.base_start_source).toBe('user_adjusted');
  });

  test('an arbitrary detected_confirmed Base Start submitted through Prepare is rejected', async () => {
    const preparedA = await prepareDraft(); // stored machine Base Start at session 70
    expect(preparedA.detectedBaseStart.date).toBe(scenario.dateAt(70));
    await expect(
      prepareDraft({
        confirmedBaseStart: { date: scenario.dateAt(80), source: 'detected_confirmed' }
      })
    ).rejects.toMatchObject({ code: 'BASE_START_DETECTION_MISMATCH' });
  });

  test('user_adjusted Prepare input remains accepted with exact provenance', async () => {
    const result = await prepareDraft({
      confirmedBaseStart: { date: scenario.dateAt(71), source: 'user_adjusted' }
    });
    expect(result.evaluation.user_inputs.base_start).toEqual({
      date: scenario.dateAt(71),
      source: 'user_adjusted'
    });
    expect(result.detectedPivot.derivedFromBaseStart).toBe(scenario.dateAt(71));
  });

  test('invalidateResultDimensions preserves unrelated dimensions (Phase 3 seam)', () => {
    const results = { setup: { score: 90 }, entry: { score: 80 }, management: { score: 70 } };
    expect(SetupQualityService.invalidateResultDimensions(results, ['setup'])).toEqual({
      entry: { score: 80 },
      management: { score: 70 }
    });
    // Phase 3 dependency expectation: a Setup/Pivot semantic change cascades to
    // Entry (depends on the confirmed Pivot / breakout boundary) and then to
    // Management (Initial R / Entry dependencies). The seam supports clearing
    // all three without erasing unrelated state.
    expect(SetupQualityService.invalidateResultDimensions(results, ['setup', 'entry', 'management'])).toBeNull();
  });

  test('a Setup/Pivot context change atomically invalidates Setup, Entry and Management', async () => {
    const first = await prepareDraft();
    // Persist Setup + Entry results on that draft, as a completed Phase 3
    // evaluation would have.
    existingDraft = makeEvaluationRow({
      id: first.evaluation.id,
      results: { setup: { score: 96 }, entry: { score: 80 }, management: null },
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
    db.query.mockClear();

    // A structural Base Start change invalidates the old Entry grade (it was
    // derived from the old Pivot/breakout boundary).
    const reprepared = await prepareDraft({
      confirmedBaseStart: { date: scenario.dateAt(71), source: 'user_adjusted' }
    });
    expect(reprepared.evaluation.results.setup).toBeNull();
    expect(reprepared.evaluation.results.entry).toBeNull();

    // The atomic UPDATE must clear Entry AND Management flat summaries too, and
    // drop their evidence/context blocks in the same statement.
    const invalidationCall = db.query.mock.calls.find(([sql]) =>
      sql.includes('UPDATE trade_quality_evaluations')
    );
    expect(invalidationCall).toBeDefined();
    const [invalidationSql, invalidationParams] = invalidationCall;
    expect(invalidationSql).toContain('entry_score = $11');
    expect(invalidationSql).toContain('entry_compliance = $13');
    expect(invalidationSql).toContain('management_score = $15');
    expect(JSON.parse(invalidationParams[2])).toEqual({
      setup: null,
      entry: null,
      management: null
    });
    expect(invalidationParams[10]).toBeNull(); // entry_score
    expect(invalidationParams[12]).toBeNull(); // entry_compliance
    expect(invalidationParams[14]).toBeNull(); // management_score
    // Derived Entry evidence/context must not survive an invalidation.
    expect(invalidationParams[3].entry).toBeUndefined();
    expect(invalidationParams[5].entry).toBeUndefined();
  });
});

describe('executable-contract closure (Phase 2 final)', () => {
  function withConfig(configuration) {
    profileService.getCurrentVersion.mockReset().mockResolvedValue({
      id: VERSION_ID,
      version_number: 1,
      schema_version: 1,
      configuration
    });
  }


  function leaderOnlyConfig() {
    const config = JSON.parse(JSON.stringify(CANONICAL_CONFIG));
    for (const criterion of config.dimensions.setup.criteria) {
      if (criterion.key !== 'leader') criterion.enabled = false;
    }
    return config;
  }

  function structuralConfig() {
    const config = JSON.parse(JSON.stringify(CANONICAL_CONFIG));
    config.dimensions.setup.criteria.find((c) => c.key === 'leader').enabled = false;
    return config;
  }

  test('Leader-only prepare succeeds without market data or detection', async () => {
    const config = leaderOnlyConfig();
    withConfig(config);
    loadDailyEvidence.mockClear();

    const prepared = await prepareDraft();
    expect(loadDailyEvidence).not.toHaveBeenCalled();
    expect(prepared.requiredUserInputs).toEqual(['leader_confirmed']);
    expect(prepared.detectedBaseStart).toBeNull();
    expect(prepared.detectedPivot).toBeNull();
    expect(prepared.evaluation.evidence_snapshot.completeness).toBe('not_required');
    expect(prepared.unavailableEvidence).toEqual([]);
  });

  test('Leader-only evaluate succeeds and contains exactly the Leader criterion', async () => {
    const config = leaderOnlyConfig();
    withConfig(config);
    const prepared = await prepareDraft();

    installDbRouter({ trackEvalRow: true, versionConfiguration: config });
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: prepared.evaluation.id,
      userInputs: { leader_confirmed: true }
    });

    expect(result.evaluation.results.setup).toBeDefined();
    const rows = resultByKey(result.evaluation);
    expect(rows.size).toBe(1);
    expect(rows.has('leader')).toBe(true);
    expect(rows.get('leader').status).toBe('PASS');
    expect(result.evaluation.setup_compliance).toBe('PASS');
    expect(result.evaluation.evidence_snapshot.completeness).toBe('not_required');
  });

  test('Leader disabled + structural criteria unchanged (no leader_confirmed required, no Leader result)', async () => {
    const config = structuralConfig();
    withConfig(config);
    const prepared = await prepareDraft();
    expect(prepared.requiredUserInputs).toEqual(['base_start', 'pivot']);
    installDbRouter({ trackEvalRow: true, versionConfiguration: config });
    const inputs = confirmedFromPrepared(prepared);
    delete inputs.leader_confirmed;
    const result = await SetupQualityService.evaluate(USER_ID, TRADE_ID, {
      evaluationId: prepared.evaluation.id,
      userInputs: inputs
    });
    const rows = resultByKey(result.evaluation);
    expect(rows.has('leader')).toBe(false);
    expect(rows.size).toBe(7);
    expect(result.evaluation.setup_compliance).toBe('PASS');
  });

  test('fresh-evidence detected_confirmed must match the machine Base Start detected from THAT evidence', async () => {
    const addDays = (base, n) => {
      const d = new Date(`${base}T00:00:00.000Z`);
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().split('T')[0];
    };
    // Evidence B: an alternative verified series whose machine Base Start
    // (2026-03-20) differs from evidence A's (2026-03-12) while 2026-03-12 is
    // still a valid session inside B. Entry session = 2026-04-06.
    const altBars = () => {
      const rows = [];
      for (let i = 0; i < 20; i += 1) {
        const close = 10 + (i * 40) / 19; // climb to ~50 at index 19
        rows.push([close - 0.1, close + 0.4, close - 0.6, close, 1_000_000]);
      }
      for (let i = 20; i <= 35; i += 1) {
        const close = 46.5 + (i % 3);
        rows.push([close - 0.1, close + 0.5, close - 0.5, close, 1_000_000]);
      }
      rows.push([59, 62, 58, 60, 1_000_000]); // breakout day 2026-04-06
      for (let i = 0; i < 4; i += 1) {
        rows.push([61 + i, 63 + i, 60 + i, 62 + i, 1_000_000]);
      }
      const { buildBars } = require('./barFactory');
      return buildBars('2026-03-01', rows);
    };

    // Evidence A: cache-only/unverified with machine Base Start at scenario 70.
    loadDailyEvidence
      .mockResolvedValueOnce({ bars: scenario.bars, source: 'historical_cache', completeness: 'unverified', error: 'x' });
    const first = await prepareDraft();
    const oldBaseA = scenario.dateAt(70);
    expect(first.detectedBaseStart.date).toBe(oldBaseA);

    // Provider recovers with evidence B (fresh). Submitting OLD Base A as
    // detected_confirmed must be rejected: B's machine detection differs.
    loadDailyEvidence.mockResolvedValueOnce({ bars: altBars(), source: 'finnhub', completeness: 'verified', error: null });
    await expect(
      prepareDraft({ confirmedBaseStart: { date: oldBaseA, source: 'detected_confirmed' } })
    ).rejects.toMatchObject({ code: 'BASE_START_DETECTION_MISMATCH' });

    // Fresh machine detection (B) is stored and then accepted as
    // detected_confirmed.
    loadDailyEvidence.mockResolvedValueOnce({ bars: altBars(), source: 'finnhub', completeness: 'verified', error: null });
    const second = await prepareDraft();
    const baseB = second.detectedBaseStart.date;
    expect(baseB).not.toBe(oldBaseA);
    expect(second.evaluation.evidence_snapshot.completeness).toBe('verified');

    const bConfirmed = await prepareDraft({
      confirmedBaseStart: { date: baseB, source: 'detected_confirmed' }
    });
    expect(bConfirmed.pivotBaseStartDate).toBe(baseB);

    // OLD Base A remains acceptable as user_adjusted because it is a valid
    // session inside evidence B.
    const adjusted = await prepareDraft({
      confirmedBaseStart: { date: oldBaseA, source: 'user_adjusted' }
    });
    expect(adjusted.evaluation.user_inputs.base_start).toEqual({
      date: oldBaseA,
      source: 'user_adjusted'
    });
  });

  test('reused verified evidence continues to validate detected_confirmed against its stored detection', async () => {
    const prepared = await prepareDraft();
    expect(prepared.evaluation.evidence_snapshot.completeness).toBe('verified');
    const confirmed = await prepareDraft({
      confirmedBaseStart: {
        date: prepared.detectedBaseStart.date,
        source: 'detected_confirmed'
      }
    });
    expect(confirmed.evaluation.user_inputs.base_start.source).toBe('detected_confirmed');
    expect(loadDailyEvidence).toHaveBeenCalledTimes(1); // reuse; no fresh fetch
  });
});

describe('Setup downstream-state coherence + CAS (Phase 3 follow-up)', () => {
  function augmentEntryState() {
    existingDraft = {
      ...existingDraft,
      results: { setup: { score: 96 }, entry: { score: 80 }, management: null },
      evidence_snapshot: { ...(existingDraft.evidence_snapshot || {}), entry: { probe: 'entry-evidence' } },
      detected_context: {
        ...(existingDraft.detected_context || {}),
        setup_dependency_fingerprint: 'FP',
        setup_context_revision: '5',
        entry: { probe: 'entry-context' }
      },
      user_inputs: { ...(existingDraft.user_inputs || {}), intended_trigger_type: 'BO-PIVOT' }
    };
  }

  test('an unchanged Setup Prepare preserves Entry result, evidence, context and immutable trigger', async () => {
    await prepareDraft();
    augmentEntryState();

    const reprepared = await prepareDraft();
    expect(reprepared.evaluation.results.entry).toEqual({ score: 80 });
    expect(reprepared.evaluation.evidence_snapshot.entry).toEqual({ probe: 'entry-evidence' });
    expect(reprepared.evaluation.detected_context.entry).toEqual({ probe: 'entry-context' });
    expect(reprepared.evaluation.user_inputs.intended_trigger_type).toBe('BO-PIVOT');
    // The Setup dependency fingerprint (the token that gates downstream
    // preservation) is NOT dropped by an unchanged Prepare write.
    expect(reprepared.evaluation.detected_context.setup_dependency_fingerprint).toBe('FP');
    // Successful write advances the CAS token.
    expect(reprepared.evaluation.detected_context.setup_context_revision).toBe('6');
  });

  test('a changed Setup Prepare clears derived Entry evidence/context but keeps the immutable trigger', async () => {
    await prepareDraft();
    augmentEntryState();

    const reprepared = await prepareDraft({
      confirmedBaseStart: { date: scenario.dateAt(71), source: 'user_adjusted' }
    });
    expect(reprepared.evaluation.results.entry).toBeNull();
    expect(reprepared.evaluation.evidence_snapshot.entry).toBeUndefined();
    expect(reprepared.evaluation.detected_context.entry).toBeUndefined();
    // The historical semantic assertion is NOT derived downstream state.
    expect(reprepared.evaluation.user_inputs.intended_trigger_type).toBe('BO-PIVOT');
  });

  test('a stale Setup Prepare write is rejected with STALE_SETUP_CONTEXT', async () => {
    installDbRouter({ trackEvalRow: true, updateReturnsEmpty: true });
    await expect(prepareDraft()).rejects.toMatchObject({ code: 'STALE_SETUP_CONTEXT' });
  });

  test('a stale Setup Evaluate write is rejected with STALE_SETUP_CONTEXT', async () => {
    const prepared = await prepareDraft();
    installDbRouter({ trackEvalRow: true, updateReturnsEmpty: true });
    await expect(
      SetupQualityService.evaluate(USER_ID, TRADE_ID, {
        evaluationId: prepared.evaluation.id,
        userInputs: confirmedFromPrepared(prepared)
      })
    ).rejects.toMatchObject({ code: 'STALE_SETUP_CONTEXT' });
  });
});
