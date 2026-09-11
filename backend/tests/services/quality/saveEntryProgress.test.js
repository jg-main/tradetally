'use strict';

jest.mock('../../../src/config/database', () => ({ query: jest.fn() }));

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');
const { CRITERION_STATUS } = require('../../../src/services/quality/constants');

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

const SETUP_RESULT = { score: 91, grade: 'A', compliance: 'PASS', coverage: 100, criterionResults: [] };

function lookupRow(overrides = {}) {
  return {
    id: 'eval-1',
    status: 'draft',
    profile_version_id: 'version-1',
    results: { setup: SETUP_RESULT, entry: null, management: null },
    detected_context: { boundary: { pivotPrice: 100 }, setup_dependency_fingerprint: 'F', setup_context_revision: '5' },
    evidence_snapshot: { bars: [{ date: '2026-03-10' }], setupBoundary: { resolutionDate: '2026-03-10' }, entry: { old: true } },
    user_inputs: { leader_confirmed: true, base_start: { date: '2026-02-10' } },
    configuration: CONFIG,
    ...overrides
  };
}

function passingEntryPayload(extra = {}) {
  return {
    entryResults: {
      criterionResults: [
        { key: 'breakout_session', status: CRITERION_STATUS.PASS, score: 100, scoring_value: null, raw_value: 'same_session' }
      ]
    },
    entryEvidence: { new_entry: true },
    entryDetectedContext: { new_entry_ctx: true },
    dependencyFingerprint: 'F',
    ...extra
  };
}

let updateParams;
let updateSql;

function installSuccessfulUpdate({ row } = {}) {
  db.query
    .mockResolvedValueOnce({ rows: [row || lookupRow()] })
    .mockImplementationOnce((sql, params) => {
      updateSql = sql;
      updateParams = params;
      return { rows: [{ id: 'eval-1', status: 'draft', results: null }] };
    });
}

function highestPlaceholder(sql) {
  const matches = sql.match(/\$\d+/g) || [];
  return matches.reduce((max, token) => Math.max(max, Number(token.slice(1))), 0);
}

beforeEach(() => {
  jest.clearAllMocks();
  updateParams = null;
  updateSql = null;
});

describe('evaluationService.saveEntryProgress (Entry-owned state merge)', () => {
  test('merges Entry state into the CURRENT DB Setup state (never the caller copy)', async () => {
    installSuccessfulUpdate();
    const result = await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload());
    expect(result).not.toBeNull();

    const results = JSON.parse(updateParams[2]);
    expect(results.setup).toEqual(SETUP_RESULT);
    expect(results.entry.score).toBe(100);
    expect(results.management).toBeNull();

    // Current top-level Setup snapshot preserved; only `.entry` replaced.
    expect(updateParams[3].bars).toEqual([{ date: '2026-03-10' }]);
    expect(updateParams[3].setupBoundary).toEqual({ resolutionDate: '2026-03-10' });
    expect(updateParams[3].entry).toEqual({ new_entry: true });

    // Current Setup semantic inputs preserved; Entry writes no Setup inputs.
    expect(updateParams[4].leader_confirmed).toBe(true);
    expect(updateParams[4].base_start).toEqual({ date: '2026-02-10' });

    // Current Setup-level detected context preserved; only `.entry` replaced.
    expect(updateParams[5].boundary).toEqual({ pivotPrice: 100 });
    expect(updateParams[5].setup_dependency_fingerprint).toBe('F');
    expect(updateParams[5].setup_context_revision).toBe('5');
    expect(updateParams[5].entry).toEqual(
      expect.objectContaining({ new_entry_ctx: true, entry_dependency_fingerprint: expect.any(String) })
    );

    // entry_* flat columns set.
    expect(updateParams[6]).toBe(100);
    expect(updateParams[8]).toBe('PASS');
    expect(updateParams[9]).toBe(100);
  });

  test('refuses to proceed without an existing Setup result', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow({ results: { setup: null, entry: null, management: null } })] });
    await expect(
      evaluationService.saveEntryProgress('eval-1', 'user-1', { entryResults: { criterionResults: [] } })
    ).rejects.toThrow(/requires an existing Setup result/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('rejects PASS/FAIL scores that contradict the profile scoring configuration', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow()] });
    await expect(
      evaluationService.saveEntryProgress('eval-1', 'user-1', {
        entryResults: { criterionResults: [{ key: 'breakout_session', status: CRITERION_STATUS.PASS, score: 12, scoring_value: null }] }
      })
    ).rejects.toThrow(/contradicts its profile scoring configuration/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('returns null (never updates) for terminal evaluations', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await evaluationService.saveEntryProgress('eval-1', 'user-1', {
      entryResults: { criterionResults: [] }
    });
    expect(result).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});

describe('evaluationService.saveEntryProgress (Setup CAS + intended-trigger CAS)', () => {
  test('rejects a stale fingerprint before any UPDATE', async () => {
    db.query.mockResolvedValueOnce({
      rows: [lookupRow({ detected_context: { setup_dependency_fingerprint: 'B', setup_context_revision: '5' } })]
    });
    await expect(
      evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload())
    ).rejects.toMatchObject({ code: 'STALE_DEPENDENCY' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('a zero-row UPDATE caused by a Setup revision change after lookup is STALE_DEPENDENCY', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [lookupRow()] }) // lookup: revision 5
      .mockResolvedValueOnce({ rows: [] }) // UPDATE lost the CAS
      .mockResolvedValueOnce({
        rows: [lookupRow({ detected_context: { setup_dependency_fingerprint: 'F', setup_context_revision: '6' } })]
      }); // recheck: revision advanced
    await expect(
      evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload())
    ).rejects.toMatchObject({ code: 'STALE_DEPENDENCY' });
  });

  test('the UPDATE predicate carries the fingerprint and revision read by saveEntryProgress', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload());
    const sql = db.query.mock.calls[1][0];
    expect(sql).toContain("detected_context->>'setup_dependency_fingerprint'");
    expect(sql).toContain("detected_context->>'setup_context_revision'");
    expect(updateParams[10]).toBe('F');
    expect(updateParams[11]).toBe('5');
  });

  test('an intended trigger is established once with full immutable provenance', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({
      intendedTrigger: { mode: 'establish', value: 'BO-PIVOT' }
    }));
    const sql = db.query.mock.calls[1][0];
    expect(sql).toContain("user_inputs->>'intended_trigger_type'");
    expect(updateParams[4].intended_trigger_type).toBe('BO-PIVOT');
    expect(updateParams[4].immutable_semantic_context.intended_trigger).toEqual(
      expect.objectContaining({ value: 'BO-PIVOT', source: 'user_asserted', asserted_at: expect.any(String) })
    );
    // The true-establish predicate has NO trigger placeholder: only $1..$12.
    expect(updateParams).toHaveLength(12);
  });

  test('two concurrent first assertions cannot both win (loser is INTENDED_TRIGGER_IMMUTABLE)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [lookupRow()] }) // both saw no trigger
      .mockResolvedValueOnce({ rows: [] }) // this UPDATE lost the trigger CAS
      .mockResolvedValueOnce({
        rows: [lookupRow({ user_inputs: { leader_confirmed: true, intended_trigger_type: 'BO-ORH-5' } })]
      }); // recheck: the other request established BO-ORH-5
    await expect(
      evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({
        intendedTrigger: { mode: 'establish', value: 'BO-PIVOT' }
      }))
    ).rejects.toMatchObject({ code: 'INTENDED_TRIGGER_IMMUTABLE' });
  });

  test('a true establish claimant claims only an EMPTY trigger', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({
      intendedTrigger: { mode: 'establish', value: 'BO-PIVOT' }
    }));
    const sql = db.query.mock.calls[1][0];
    expect(sql).toContain("COALESCE(user_inputs->>'intended_trigger_type', '') = ''");
    expect(sql).not.toContain("user_inputs->>'intended_trigger_type' = $13");
  });

  test('repeating the established value is allowed (normalized to preserve)', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [lookupRow({ user_inputs: { leader_confirmed: true, intended_trigger_type: 'BO-PIVOT' } })]
      })
      .mockImplementationOnce((sql, params) => {
        updateParams = params;
        return { rows: [{ id: 'eval-1', status: 'draft', results: null }] };
      });
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({
      intendedTrigger: { mode: 'establish', value: 'BO-PIVOT' }
    }));
    const sql = db.query.mock.calls[1][0];
    expect(sql).toContain("COALESCE(user_inputs->>'intended_trigger_type', '') = $13");
    expect(updateParams[4].intended_trigger_type).toBe('BO-PIVOT');
  });

  test('a stale same-value second claimant adopts the FIRST asserted_at (never overwrites it)', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [lookupRow({
          user_inputs: {
            leader_confirmed: true,
            intended_trigger_type: 'BO-PIVOT',
            immutable_semantic_context: {
              intended_trigger: { value: 'BO-PIVOT', source: 'user_asserted', asserted_at: 'T1-WINNER' }
            }
          }
        })]
      })
      .mockImplementationOnce((sql, params) => {
        updateParams = params;
        return { rows: [{ id: 'eval-1', status: 'draft', results: null }] };
      });
    // The second claimant proposed the same value but built its own (stale) T2.
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({
      intendedTrigger: { mode: 'establish', value: 'BO-PIVOT', assertedAt: 'T2-STALE' }
    }));
    expect(updateParams[4].immutable_semantic_context.intended_trigger.asserted_at).toBe('T1-WINNER');
  });

  test('concurrent same-value establish claimants: the loser cannot overwrite provenance', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [lookupRow()] }) // both saw empty
      .mockResolvedValueOnce({ rows: [] }) // this claimant lost the empty claim
      .mockResolvedValueOnce({
        rows: [lookupRow({ user_inputs: { leader_confirmed: true, intended_trigger_type: 'BO-PIVOT' } })]
      }); // winner established the SAME value
    await expect(
      evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({
        intendedTrigger: { mode: 'establish', value: 'BO-PIVOT', assertedAt: 'T2-STALE' }
      }))
    ).rejects.toMatchObject({ code: 'STALE_DEPENDENCY' });
  });

  test('the original asserted_at survives an Entry rerun (preserve mode)', async () => {
    db.query
      .mockResolvedValueOnce({
        rows: [lookupRow({
          user_inputs: {
            leader_confirmed: true,
            intended_trigger_type: 'BO-PIVOT',
            immutable_semantic_context: {
              intended_trigger: { value: 'BO-PIVOT', source: 'user_asserted', asserted_at: '2026-03-10T14:00:00.000Z' }
            }
          }
        })]
      })
      .mockImplementationOnce((sql, params) => {
        updateParams = params;
        return { rows: [{ id: 'eval-1', status: 'draft', results: null }] };
      });
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({
      intendedTrigger: { mode: 'preserve', value: 'BO-PIVOT' }
    }));
    expect(updateParams[4].immutable_semantic_context.intended_trigger.asserted_at).toBe('2026-03-10T14:00:00.000Z');
  });
});

describe('evaluationService.saveEntryProgress — SQL construction (PostgreSQL validity)', () => {
  test('progress UPDATE does not reference a non-existent table alias', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload());
    const sql = db.query.mock.calls[1][0];
    expect(sql).toContain("status NOT IN ('completed', 'insufficient_data')");
    expect(sql).not.toMatch(/\be\.status\b/);
  });
});

describe('saveEntryProgress — Entry change invalidates Management', () => {
  const { entryDependencyFingerprint } = require('../../../src/services/quality/dependencyFingerprint');

  const MANAGEMENT_RESULT = { score: 87, grade: 'B', compliance: 'PASS', coverage: 100, criterionResults: [] };

  function installWithManagementEntryState({ entryEvidence, entryDetected, management }) {
    const fp = entryDependencyFingerprint({ profileVersionId: 'version-1', entryEvidence });
    db.query
      .mockResolvedValueOnce({
        rows: [lookupRow({
          results: { setup: SETUP_RESULT, entry: { score: 95 }, management },
          detected_context: {
            boundary: { pivotPrice: 100 },
            setup_dependency_fingerprint: 'F',
            setup_context_revision: '5',
            entry: { entry_dependency_fingerprint: fp }
          },
          evidence_snapshot: { entry: entryEvidence }
        })]
      })
      .mockImplementationOnce((sql, params) => {
        updateSql = sql;
        updateParams = params;
        return { rows: [{ id: 'eval-1', status: 'draft', results: null }] };
      });
  }

  test('preserves Management when the Entry dependency is unchanged', async () => {
    const entryEvidence = { execution: { entry_basis: 100, original_position_qty: 200 } };
    installWithManagementEntryState({ entryEvidence, entryDetected: {}, management: MANAGEMENT_RESULT });
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({ entryEvidence }));
    expect(JSON.parse(updateParams[2]).management).toEqual(MANAGEMENT_RESULT);
  });

  test('invalidates Management when the Entry dependency changes', async () => {
    const oldEntryEvidence = { execution: { entry_basis: 100, original_position_qty: 200 } };
    const newEntryEvidence = { execution: { entry_basis: 101, original_position_qty: 200 } };
    installWithManagementEntryState({ entryEvidence: oldEntryEvidence, entryDetected: {}, management: MANAGEMENT_RESULT });
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({ entryEvidence: newEntryEvidence }));
    expect(JSON.parse(updateParams[2]).management).toBeNull();
    expect(updateParams[3].management).toBeUndefined();
    expect(updateParams[5].management).toBeUndefined();
  });
});

describe('saveEntryProgress — SQL placeholder/parameter parity (BLOCKER regression)', () => {
  test('mode none: highest $N placeholder equals params.length', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({
      intendedTrigger: { mode: 'none' }
    }));
    expect(highestPlaceholder(updateSql)).toBe(updateParams.length);
    expect(updateParams).toHaveLength(12);
  });

  test('mode establish: no unused $13 and highest $N equals params.length', async () => {
    installSuccessfulUpdate({ row: lookupRow() }); // observed an EMPTY trigger
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({
      intendedTrigger: { mode: 'establish', value: 'BO-PIVOT' }
    }));
    // The empty-trigger predicate must not bind a trigger parameter.
    expect(updateSql).not.toContain('$13');
    expect(updateSql).toContain("COALESCE(user_inputs->>'intended_trigger_type', '') = ''");
    expect(updateParams).toHaveLength(12);
    expect(highestPlaceholder(updateSql)).toBe(updateParams.length);
  });

  test('mode preserve: $13 is bound and highest $N equals params.length', async () => {
    installSuccessfulUpdate({
      row: lookupRow({ user_inputs: { leader_confirmed: true, intended_trigger_type: 'BO-PIVOT' } })
    });
    await evaluationService.saveEntryProgress('eval-1', 'user-1', passingEntryPayload({
      intendedTrigger: { mode: 'preserve', value: 'BO-PIVOT' }
    }));
    expect(updateSql).toContain('$13');
    expect(updateParams).toHaveLength(13);
    expect(updateParams[12]).toBe('BO-PIVOT');
    expect(highestPlaceholder(updateSql)).toBe(updateParams.length);
  });
});
