'use strict';

jest.mock('../../../src/config/database', () => ({ query: jest.fn() }));

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');
const { CRITERION_STATUS } = require('../../../src/services/quality/constants');
const { setupDependencyFingerprint } = require('../../../src/services/quality/dependencyFingerprint');

const CONFIG = {
  dimensions: {
    setup: {
      minimum_coverage: 70,
      grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
      criteria: [
        { key: 'leader', enabled: true, required: true, weight: 20, parameters: { source: 'user_asserted' }, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } }
      ]
    },
    entry: {
      minimum_coverage: 70,
      grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
      criteria: [
        { key: 'breakout_session', enabled: true, required: true, weight: 10, parameters: {}, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } }
      ]
    }
  }
};

const SNAPSHOT = {
  symbol: 'TEST',
  entrySessionDate: '2026-03-10',
  source: 'finnhub',
  completeness: 'verified',
  bars: [{ date: '2026-03-10', open: 1, high: 2, low: 1, close: 2, volume: 1 }]
};
const BOUNDARY = { pivotPrice: 100, resolutionDate: '2026-03-10', baseStartDate: '2026-02-10', baseEndDate: '2026-03-09' };

const ENTRY_RESULT = { score: 88, grade: 'B', compliance: 'PASS', coverage: 100, criterionResults: [] };

function fingerprint(boundary = BOUNDARY, snapshot = SNAPSHOT) {
  return setupDependencyFingerprint({ profileVersionId: 'version-1', boundary, evidenceSnapshot: snapshot });
}

function lookupRow(overrides = {}) {
  return {
    id: 'eval-1',
    status: 'draft',
    profile_version_id: 'version-1',
    results: { setup: { score: 90 }, entry: ENTRY_RESULT, management: null },
    detected_context: { boundary: BOUNDARY, setup_dependency_fingerprint: fingerprint() },
    configuration: CONFIG,
    ...overrides
  };
}

let updateParams;
let updateSql;

function installUpdate() {
  db.query.mockImplementationOnce((sql, params) => {
    updateParams = params;
    updateSql = sql;
    return { rows: [{ id: 'eval-1', status: 'draft', results: null }] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  updateParams = null;
  updateSql = null;
});

function setupInput() {
  return {
    setupResults: {
      criterionResults: [{ key: 'leader', status: CRITERION_STATUS.PASS, score: 100, scoring_value: null, raw_value: 'yes' }]
    },
    evidenceSnapshot: SNAPSHOT,
    userInputs: { leader_confirmed: true },
    detectedContext: { boundary: BOUNDARY }
  };
}

describe('evaluationService.saveSetupProgress (Phase 3 hardening)', () => {
  test('unchanged dependencies preserve a valid Entry result and entry_* summaries', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow()] });
    installUpdate();

    await evaluationService.saveSetupProgress('eval-1', 'user-1', setupInput());
    const results = JSON.parse(updateParams[2]);
    expect(results.setup.score).toBe(100);
    expect(results.entry).toEqual(ENTRY_RESULT);
    expect(updateParams[6]).toBe(100); // setup_score
    expect(updateParams[10]).toBe(88); // entry_score
    expect(updateParams[12]).toBe('PASS'); // entry_compliance
    expect(updateParams[13]).toBe(100); // entry_coverage
  });

  test('a changed Pivot/breakout dependency atomically clears Entry JSON and entry_* summaries', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow()] });
    installUpdate();

    const changedBoundary = { ...BOUNDARY, pivotPrice: 123 };
    await evaluationService.saveSetupProgress('eval-1', 'user-1', {
      ...setupInput(),
      detectedContext: { boundary: changedBoundary }
    });
    const results = JSON.parse(updateParams[2]);
    expect(results.entry).toBeNull();
    expect(results.management).toBeNull();
    expect(updateParams[10]).toBeNull(); // entry_score
    expect(updateParams[11]).toBeNull();
    expect(updateParams[12]).toBeNull();
    expect(updateParams[13]).toBeNull();
    // The persisted fingerprint reflects the new boundary.
    expect(updateParams[5].setup_dependency_fingerprint).toBe(
      setupDependencyFingerprint({ profileVersionId: 'version-1', boundary: changedBoundary, evidenceSnapshot: SNAPSHOT })
    );
  });

  test('a legacy row without a stored fingerprint does not preserve an Entry result it cannot prove coherent', async () => {
    db.query.mockResolvedValueOnce({
      rows: [lookupRow({ detected_context: { boundary: BOUNDARY } })]
    });
    installUpdate();

    await evaluationService.saveSetupProgress('eval-1', 'user-1', setupInput());
    const results = JSON.parse(updateParams[2]);
    expect(results.entry).toBeNull();
    expect(updateParams[10]).toBeNull();
  });

  test('rejects PASS/FAIL scores that contradict the profile scoring configuration', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow()] });
    await expect(
      evaluationService.saveSetupProgress('eval-1', 'user-1', {
        setupResults: { criterionResults: [{ key: 'leader', status: CRITERION_STATUS.PASS, score: 55, scoring_value: null }] }
      })
    ).rejects.toThrow(/contradicts its profile scoring configuration/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('returns null (never updates) for terminal evaluations', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await evaluationService.saveSetupProgress('eval-1', 'user-1', {
      setupResults: { criterionResults: [] }
    });
    expect(result).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('Setup downstream-state coherence + compare-and-swap (Phase 3 follow-up)', () => {
  const existingWithDownstream = () => ({
    evidence_snapshot: { ...SNAPSHOT, entry: { probe: 'entry-evidence' } },
    detected_context: {
      boundary: BOUNDARY,
      setup_dependency_fingerprint: fingerprint(),
      entry: { probe: 'entry-context' }
    },
    user_inputs: { leader_confirmed: true, intended_trigger_type: 'BO-PIVOT' }
  });

  test('unchanged Setup evaluate preserves entry result, evidence block and context block', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow(existingWithDownstream())] });
    installUpdate();

    await evaluationService.saveSetupProgress('eval-1', 'user-1', setupInput());
    const results = JSON.parse(updateParams[2]);
    expect(results.entry).toEqual(ENTRY_RESULT);
    expect(updateParams[3].entry).toEqual({ probe: 'entry-evidence' });
    expect(updateParams[5].entry).toEqual({ probe: 'entry-context' });
    // Immutable semantic assertion survives.
    expect(updateParams[4].intended_trigger_type).toBe('BO-PIVOT');
  });

  test('changed Setup dependency atomically clears entry result, evidence, context and summaries', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow(existingWithDownstream())] });
    installUpdate();

    const changedBoundary = { ...BOUNDARY, pivotPrice: 130 };
    await evaluationService.saveSetupProgress('eval-1', 'user-1', {
      ...setupInput(),
      detectedContext: { boundary: changedBoundary }
    });
    const results = JSON.parse(updateParams[2]);
    expect(results.entry).toBeNull();
    expect(updateParams[3].entry).toBeUndefined();
    expect(updateParams[5].entry).toBeUndefined();
    expect(updateParams[10]).toBeNull(); // entry_score
    // The immutable intended trigger is NOT downstream state: it survives.
    expect(updateParams[4].intended_trigger_type).toBe('BO-PIVOT');
  });

  test('a stale Setup revision is rejected before any UPDATE', async () => {
    db.query.mockResolvedValueOnce({
      rows: [lookupRow({
        detected_context: {
          boundary: BOUNDARY,
          setup_dependency_fingerprint: fingerprint(),
          setup_context_revision: '2'
        }
      })]
    });
    await expect(
      evaluationService.saveSetupProgress('eval-1', 'user-1', {
        ...setupInput(),
        expectedSetupRevision: '1'
      })
    ).rejects.toMatchObject({ code: 'STALE_SETUP_CONTEXT' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('a matching Setup revision advances the compare-and-swap token', async () => {
    db.query.mockResolvedValueOnce({
      rows: [lookupRow({
        detected_context: {
          boundary: BOUNDARY,
          setup_dependency_fingerprint: fingerprint(),
          setup_context_revision: '2'
        }
      })]
    });
    installUpdate();

    await evaluationService.saveSetupProgress('eval-1', 'user-1', {
      ...setupInput(),
      expectedSetupRevision: '2'
    });
    expect(updateParams[5].setup_context_revision).toBe('3');
    expect(updateParams[18]).toBe('2');
  });
});

describe('evaluationService.saveSetupProgress — SQL construction (PostgreSQL validity)', () => {
  test('progress UPDATE does not reference a non-existent table alias', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow()] });
    installUpdate();
    await evaluationService.saveSetupProgress('eval-1', 'user-1', setupInput());
    expect(updateSql).toContain("status NOT IN ('completed', 'insufficient_data')");
    // The UPDATE target is not aliased, so `e.status` would be invalid SQL.
    expect(updateSql).not.toMatch(/\be\.status\b/);
  });
});
