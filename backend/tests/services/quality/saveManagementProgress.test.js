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
        { key: 'leader', enabled: true, required: true, weight: 100, parameters: { source: 'user_asserted' }, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } }
      ]
    },
    entry: {
      minimum_coverage: 70,
      grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
      criteria: [
        { key: 'breakout_session', enabled: true, required: true, weight: 100, parameters: {}, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } }
      ]
    },
    management: {
      minimum_coverage: 70,
      grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
      criteria: [
        { key: 'stop_ratchet', enabled: true, required: true, weight: 100, parameters: { downward_tolerance_ticks: 0 }, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } }
      ]
    }
  }
};

const SETUP_RESULT = { score: 91, grade: 'A', compliance: 'PASS', coverage: 100, criterionResults: [] };
const ENTRY_RESULT = { score: 95, grade: 'A', compliance: 'PASS', coverage: 100, criterionResults: [] };

function lookupRow(overrides = {}) {
  return {
    id: 'eval-1',
    status: 'draft',
    profile_version_id: 'version-1',
    results: { setup: SETUP_RESULT, entry: ENTRY_RESULT, management: null },
    detected_context: {
      boundary: { pivotPrice: 100 },
      setup_dependency_fingerprint: 'F',
      setup_context_revision: '5',
      entry: { entry_dependency_fingerprint: 'EF' }
    },
    evidence_snapshot: { bars: [{ date: '2026-03-10' }], entry: { entry_basis: 100 } },
    user_inputs: { leader_confirmed: true },
    configuration: CONFIG,
    ...overrides
  };
}

function passingManagementPayload(extra = {}) {
  return {
    managementResults: {
      criterionResults: [
        { key: 'stop_ratchet', status: CRITERION_STATUS.PASS, score: 100, scoring_value: null, raw_value: 0 }
      ]
    },
    managementEvidence: { mgmt: true },
    managementDetectedContext: { mgmt_ctx: true },
    dependencyFingerprint: 'F',
    entryDependencyFingerprint: 'EF',
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

describe('evaluationService.saveManagementProgress', () => {
  test('merges Management into current DB Setup+Entry state', async () => {
    installSuccessfulUpdate();
    const result = await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload());
    expect(result).not.toBeNull();

    const results = JSON.parse(updateParams[2]);
    expect(results.setup).toEqual(SETUP_RESULT);
    expect(results.entry).toEqual(ENTRY_RESULT);
    expect(results.management.score).toBe(100);

    // Current Setup/Entry snapshot preserved; only `.management` added.
    expect(updateParams[3].bars).toEqual([{ date: '2026-03-10' }]);
    expect(updateParams[3].entry).toEqual({ entry_basis: 100 });
    expect(updateParams[3].management).toEqual({ mgmt: true });

    expect(updateParams[5].boundary).toEqual({ pivotPrice: 100 });
    expect(updateParams[5].management).toEqual({ mgmt_ctx: true });

    // management_* flat columns set.
    expect(updateParams[6]).toBe(100);
    expect(updateParams[8]).toBe('PASS');
    expect(updateParams[9]).toBe(100);
  });

  test('refuses to proceed without existing Setup AND Entry results', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow({ results: { setup: SETUP_RESULT, entry: null, management: null } })] });
    await expect(
      evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload())
    ).rejects.toThrow(/requires existing Setup and Entry results/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('rejects PASS/FAIL scores that contradict the profile scoring configuration', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow()] });
    await expect(
      evaluationService.saveManagementProgress('eval-1', 'user-1', {
        managementResults: { criterionResults: [{ key: 'stop_ratchet', status: CRITERION_STATUS.PASS, score: 12, scoring_value: null }] }
      })
    ).rejects.toThrow(/contradicts its profile scoring configuration/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('returns null (never updates) for terminal evaluations', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload());
    expect(result).toBeNull();
  });
});

describe('saveManagementProgress — CAS (Setup + Entry + trailing MA)', () => {
  test('rejects a stale Setup fingerprint before any UPDATE', async () => {
    db.query.mockResolvedValueOnce({
      rows: [lookupRow({ detected_context: { setup_dependency_fingerprint: 'B', setup_context_revision: '5', entry: { entry_dependency_fingerprint: 'EF' } } })]
    });
    await expect(
      evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload())
    ).rejects.toMatchObject({ code: 'STALE_DEPENDENCY' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('rejects a stale Entry dependency fingerprint before any UPDATE', async () => {
    db.query.mockResolvedValueOnce({
      rows: [lookupRow({ detected_context: { setup_dependency_fingerprint: 'F', setup_context_revision: '5', entry: { entry_dependency_fingerprint: 'OTHER' } } })]
    });
    await expect(
      evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload())
    ).rejects.toMatchObject({ code: 'STALE_ENTRY_DEPENDENCY' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('the UPDATE predicate carries setup fingerprint, revision, and entry fingerprint', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload());
    const sql = db.query.mock.calls[1][0];
    expect(sql).toContain("detected_context->>'setup_dependency_fingerprint'");
    expect(sql).toContain("detected_context->>'setup_context_revision'");
    expect(sql).toContain("detected_context->'entry'->>'entry_dependency_fingerprint'");
    expect(updateParams[10]).toBe('F');
    expect(updateParams[11]).toBe('5');
    expect(updateParams[12]).toBe('EF');
  });

  test('establishes the trailing MA selection once with honest post-trade provenance', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
      trailingMa: { mode: 'establish', value: 20 }
    }));
    expect(updateParams[4].trailing_ma_period).toBe(20);
    expect(updateParams[4].immutable_semantic_context.trailing_ma).toEqual(
      expect.objectContaining({ value: 20, source: 'user_asserted', timing: 'post_trade', selected_at: expect.any(String) })
    );
    // The true-establish predicate has NO trailing placeholder: only $1..$13.
    expect(updateParams).toHaveLength(13);
    expect(updateSql).toContain("COALESCE(user_inputs->>'trailing_ma_period', '') = ''");
  });

  test('two concurrent first assertions cannot both win (TRAILING_MA_IMMUTABLE)', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [lookupRow()] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [lookupRow({ user_inputs: { leader_confirmed: true, trailing_ma_period: 10 } })]
      });
    await expect(
      evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
        trailingMa: { mode: 'establish', value: 20 }
      }))
    ).rejects.toMatchObject({ code: 'TRAILING_MA_IMMUTABLE' });
  });
});

describe('saveManagementProgress — trailing phase immutability (F6)', () => {
  test('establishes the trailing phase once with honest post-trade provenance', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
      trailingPhase: { mode: 'establish', value: 'activated' }
    }));
    expect(updateParams[4].trailing_phase).toBe('activated');
    expect(updateParams[4].immutable_semantic_context.trailing_phase).toEqual(
      expect.objectContaining({ value: 'activated', source: 'user_asserted', timing: 'post_trade', asserted_at: expect.any(String) })
    );
    expect(updateParams).toHaveLength(13);
    expect(updateSql).toContain("COALESCE(user_inputs->>'trailing_phase', '') = ''");
  });

  test('rejects a conflicting phase assertion (TRAILING_PHASE_IMMUTABLE)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [lookupRow({ user_inputs: { leader_confirmed: true, trailing_phase: 'not_activated' } })]
    });
    await expect(
      evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
        trailingPhase: { mode: 'establish', value: 'activated' }
      }))
    ).rejects.toMatchObject({ code: 'TRAILING_PHASE_IMMUTABLE' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('preserve binds $14 for the phase when no trailing MA is preserved', async () => {
    installSuccessfulUpdate({
      row: lookupRow({ user_inputs: { leader_confirmed: true, trailing_phase: 'activated' } })
    });
    await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
      trailingPhase: { mode: 'preserve', value: 'activated' }
    }));
    expect(updateSql).toContain("user_inputs->>'trailing_phase', '') = $14");
    expect(updateParams).toHaveLength(14);
    expect(updateParams[13]).toBe('activated');
  });
});

describe('saveManagementProgress — trailing activation boundary immutability (F4a)', () => {
  test('establishes the activation session once with post-trade provenance', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
      trailingActivation: { mode: 'establish', session: '2026-03-12' }
    }));
    expect(updateParams[4].trailing_activation_session).toBe('2026-03-12');
    expect(updateParams[4].immutable_semantic_context.trailing_activation).toEqual(
      expect.objectContaining({ session: '2026-03-12', source: 'user_asserted', timing: 'post_trade', asserted_at: expect.any(String) })
    );
    expect(updateSql).toContain("COALESCE(user_inputs->>'trailing_activation_session', '') = ''");
  });

  test('rejects a conflicting activation boundary (TRAILING_ACTIVATION_IMMUTABLE)', async () => {
    db.query.mockResolvedValueOnce({
      rows: [lookupRow({ user_inputs: { leader_confirmed: true, trailing_activation_session: '2026-03-12' } })]
    });
    await expect(
      evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
        trailingActivation: { mode: 'establish', session: '2026-03-13' }
      }))
    ).rejects.toMatchObject({ code: 'TRAILING_ACTIVATION_IMMUTABLE' });
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('preserve binds the activation session and keeps the first asserted_at', async () => {
    installSuccessfulUpdate({
      row: lookupRow({
        user_inputs: {
          leader_confirmed: true,
          trailing_activation_session: '2026-03-12',
          immutable_semantic_context: { trailing_activation: { session: '2026-03-12', asserted_at: '2026-03-12T10:00:00.000Z' } }
        }
      })
    });
    await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
      trailingActivation: { mode: 'preserve', session: '2026-03-12' }
    }));
    const persisted = updateParams[4];
    expect(persisted.trailing_activation_session).toBe('2026-03-12');
    expect(persisted.immutable_semantic_context.trailing_activation.asserted_at).toBe('2026-03-12T10:00:00.000Z');
    expect(updateSql).toContain("user_inputs->>'trailing_activation_session', '') = $14");
    expect(updateParams).toHaveLength(14);
  });
});

describe('saveManagementProgress — SQL placeholder/parameter parity', () => {
  test('mode none: highest $N equals params.length', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
      trailingMa: { mode: 'none' }
    }));
    expect(highestPlaceholder(updateSql)).toBe(updateParams.length);
    expect(updateParams).toHaveLength(13);
  });

  test('mode establish: no unused $14', async () => {
    installSuccessfulUpdate();
    await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
      trailingMa: { mode: 'establish', value: 20 }
    }));
    expect(updateSql).not.toContain('$14');
    expect(updateParams).toHaveLength(13);
  });

  test('mode preserve: $14 is bound', async () => {
    installSuccessfulUpdate({
      row: lookupRow({ user_inputs: { leader_confirmed: true, trailing_ma_period: 20 } })
    });
    await evaluationService.saveManagementProgress('eval-1', 'user-1', passingManagementPayload({
      trailingMa: { mode: 'preserve', value: 20 }
    }));
    expect(updateSql).toContain('$14');
    expect(updateParams).toHaveLength(14);
    expect(updateParams[13]).toBe('20');
    expect(highestPlaceholder(updateSql)).toBe(updateParams.length);
  });
});
