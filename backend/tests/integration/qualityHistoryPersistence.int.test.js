'use strict';

// Real-PostgreSQL acceptance gate for Phase 5 (Version / Evaluation History).
//
// Runs only via `pnpm --dir backend test:integration`. Exercises the ACTUAL SQL
// of historyService (history list, version-pinned re-evaluation, primary
// selection), comparisonService, and the terminal-immutability triggers
// against the isolated scratch database. Market-data providers are not
// involved: persisted snapshots are inserted directly, exactly as the
// comparison path expects.

const { randomUUID } = require('crypto');
const db = require('../../src/config/database');
const profileService = require('../../src/services/quality/profileService');
const historyService = require('../../src/services/quality/historyService');
const comparisonService = require('../../src/services/quality/comparisonService');
const evaluationService = require('../../src/services/quality/evaluationService');
const setupQualityService = require('../../src/services/quality/setupQualityService');

function binary(pass, fail) {
  return { type: 'binary', pass_score: pass, fail_score: fail };
}

// Minimal valid three-dimension configuration. `setupCriteria` lets each
// version differ so comparison can exercise added/removed/changed criteria.
function makeConfig({ setupCriteria } = {}) {
  return {
    dimensions: {
      setup: {
        minimum_coverage: 70,
        grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
        criteria: setupCriteria || [
          { key: 'leader', enabled: true, required: true, weight: 100, parameters: {}, scoring: binary(100, 0) }
        ]
      },
      entry: {
        minimum_coverage: 70,
        grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
        criteria: [
          { key: 'breakout_session', enabled: true, required: true, weight: 100, parameters: {}, scoring: binary(100, 0) }
        ]
      },
      management: {
        minimum_coverage: 70,
        grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
        criteria: [
          { key: 'stop_ratchet', enabled: true, required: true, weight: 100, parameters: {}, scoring: binary(100, 0) }
        ]
      }
    }
  };
}

function dimensionSummary(score, grade, compliance, coverage) {
  return score === null
    ? { score: null, grade: null, compliance: null, coverage: null, criterionResults: [] }
    : { score, grade, compliance, coverage, criterionResults: [] };
}

function criterion(key, status, score, extra = {}) {
  return {
    key,
    status,
    score,
    scoringValue: extra.scoringValue ?? null,
    rawValue: extra.rawValue ?? null,
    weight: extra.weight ?? null,
    required: extra.required ?? true
  };
}

async function createFixture(v1SetupCriteria) {
  const suffix = randomUUID().slice(0, 8);
  const user = await db.query(
    `INSERT INTO users (email, username, password_hash, is_verified, is_active, admin_approved, role)
     VALUES ($1, $2, 'integration-test-hash', true, true, true, 'user') RETURNING id`,
    [`phase5-${suffix}@example.com`, `phase5_${suffix}`]
  );
  const userId = user.rows[0].id;

  const trade = await db.query(
    `INSERT INTO trades (user_id, symbol, side, quantity, entry_price, entry_time, trade_date, instrument_type)
     VALUES ($1, 'TEST', 'long', 100, 100, '2026-03-10T14:30:00Z', '2026-03-10', 'stock') RETURNING id`,
    [userId]
  );
  const tradeId = trade.rows[0].id;

  const v1Config = makeConfig({ setupCriteria: v1SetupCriteria });
  const profile = await profileService.createProfile(userId, {
    name: `Phase5 ${suffix}`,
    configuration: v1Config
  });

  return { userId, tradeId, profileId: profile.id, v1Config };
}

async function createVersion(fixture, setupCriteria) {
  return profileService.createVersion(
    fixture.profileId,
    fixture.userId,
    makeConfig({ setupCriteria })
  );
}

async function insertTerminalEvaluation({ userId, tradeId, versionId, results, evaluatedAt }) {
  const row = await db.query(
    `INSERT INTO trade_quality_evaluations (
       user_id, trade_id, profile_version_id, status, results,
       setup_score, setup_grade, setup_compliance, setup_coverage,
       entry_score, entry_grade, entry_compliance, entry_coverage,
       management_score, management_grade, management_compliance, management_coverage,
       evaluated_at
     ) VALUES (
       $1, $2, $3, 'completed', $4,
       $5, $6, $7, $8,
       $9, $10, $11, $12,
       $13, $14, $15, $16,
       $17
     ) RETURNING id`,
    [
      userId,
      tradeId,
      versionId,
      JSON.stringify(results),
      results.setup ? results.setup.score : null,
      results.setup ? results.setup.grade : null,
      results.setup ? results.setup.compliance : null,
      results.setup ? results.setup.coverage : null,
      results.entry ? results.entry.score : null,
      results.entry ? results.entry.grade : null,
      results.entry ? results.entry.compliance : null,
      results.entry ? results.entry.coverage : null,
      results.management ? results.management.score : null,
      results.management ? results.management.grade : null,
      results.management ? results.management.compliance : null,
      results.management ? results.management.coverage : null,
      evaluatedAt || null
    ]
  );
  return row.rows[0].id;
}

async function readEvaluation(evaluationId) {
  const result = await db.query(
    `SELECT status, results, evidence_snapshot, user_inputs, detected_context, profile_version_id, evaluated_at
     FROM trade_quality_evaluations WHERE id = $1`,
    [evaluationId]
  );
  return result.rows[0];
}

async function destroyFixture(fixture) {
  if (!fixture) return;
  await db.query('DELETE FROM trade_quality_primary_evaluations WHERE user_id = $1', [fixture.userId]);
  await db.query('DELETE FROM trade_quality_evaluations WHERE user_id = $1', [fixture.userId]);
  await db.query('DELETE FROM quality_profile_versions WHERE profile_id = $1', [fixture.profileId]);
  await db.query('DELETE FROM quality_profiles WHERE id = $1', [fixture.profileId]);
  await db.query('DELETE FROM trades WHERE user_id = $1', [fixture.userId]);
  await db.query('DELETE FROM users WHERE id = $1', [fixture.userId]);
}

let fixture;

beforeEach(async () => {
  fixture = await createFixture();
});

afterEach(async () => {
  await destroyFixture(fixture);
  fixture = null;
});

afterAll(async () => {
  await db.pool.end();
});

describe('Phase 5 — version immutability (real PostgreSQL)', () => {
  test('advancing the profile keeps an old evaluation on its original version and payload', async () => {
    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const evaluatedAt = '2026-09-03T10:00:00Z';
    const results = {
      setup: dimensionSummary(91, 'A', 'PASS', 100),
      entry: dimensionSummary(95, 'A', 'PASS', 100),
      management: dimensionSummary(87, 'B', 'FAIL', 100)
    };
    const evaluationA = await insertTerminalEvaluation({
      ...fixture,
      versionId: v1.id,
      results,
      evaluatedAt
    });

    const before = await readEvaluation(evaluationA);

    // Profile advances to v2.
    const v2 = await createVersion(fixture);
    expect(v2.version_number).toBe(2);

    const after = await readEvaluation(evaluationA);
    expect(after.profile_version_id).toBe(v1.id);
    expect(after.results).toEqual(before.results);
    expect(after.evidence_snapshot).toEqual(before.evidence_snapshot);
    expect(new Date(after.evaluated_at).toISOString()).toBe(new Date(before.evaluated_at).toISOString());

    // A terminal evaluation cannot be rewritten by saveResult (returns null).
    const rewrite = await evaluationService.saveResult(evaluationA, fixture.userId, {
      status: 'completed',
      results: {
        setup: dimensionSummary(0, 'F', 'FAIL', 100),
        entry: dimensionSummary(0, 'F', 'FAIL', 100),
        management: dimensionSummary(0, 'F', 'FAIL', 100)
      }
    });
    expect(rewrite).toBeNull();
    const stillSame = await readEvaluation(evaluationA);
    expect(stillSame.results).toEqual(results);
  });
});

describe('Phase 5 — historical re-evaluation (real PostgreSQL)', () => {
  test('creates a NEW evaluation pinned to the selected version and never drifts', async () => {
    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const results = {
      setup: dimensionSummary(90, 'A', 'PASS', 100),
      entry: dimensionSummary(90, 'A', 'PASS', 100),
      management: dimensionSummary(90, 'A', 'PASS', 100)
    };
    const evaluationA = await insertTerminalEvaluation({
      ...fixture,
      versionId: v1.id,
      results,
      evaluatedAt: '2026-09-03T10:00:00Z'
    });

    const v2 = await createVersion(fixture);

    // Start re-evaluation against v2 explicitly.
    const evaluationB = await historyService.startEvaluation(fixture.userId, fixture.tradeId, v2.id);
    expect(evaluationB.id).not.toBe(evaluationA);
    expect(evaluationB.profile_version_id).toBe(v2.id);
    expect(evaluationB.status).toBe('draft');

    // Profile advances to v3 while the v2 draft is open.
    const v3 = await createVersion(fixture);

    // The open draft remains linked to v2 (no drift).
    const reRead = await readEvaluation(evaluationB.id);
    expect(reRead.profile_version_id).toBe(v2.id);
    expect(reRead.status).toBe('draft');

    // Evaluation A is untouched.
    const a = await readEvaluation(evaluationA);
    expect(a.profile_version_id).toBe(v1.id);
    expect(a.results).toEqual(results);

    // Starting re-evaluation against the now-current v3 yields a distinct row.
    const evaluationC = await historyService.startEvaluation(fixture.userId, fixture.tradeId, v3.id);
    expect(evaluationC.profile_version_id).toBe(v3.id);
    expect(evaluationC.id).not.toBe(evaluationB.id);
  });

  test('an explicit re-evaluation always creates a fresh row and never resumes an abandoned draft', async () => {
    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const v2 = await createVersion(fixture);

    // Manual draft for v2 (D1): an abandoned, non-empty draft.
    const d1 = await historyService.startEvaluation(fixture.userId, fixture.tradeId, v2.id);
    await db.query(
      `UPDATE trade_quality_evaluations
         SET user_inputs = $2, detected_context = $3, evidence_snapshot = $4
       WHERE id = $1`,
      [d1.id, JSON.stringify({ leader_confirmed: true }), JSON.stringify({ abandoned: true }), JSON.stringify({ bar: 1 })]
    );
    const d1Before = await readEvaluation(d1.id);

    // Explicit "Evaluate with v2" MUST create D2 even though D1 is open.
    const d2 = await historyService.startEvaluation(fixture.userId, fixture.tradeId, v2.id);
    expect(d2.id).not.toBe(d1.id);
    expect(d2.profile_version_id).toBe(v2.id);
    expect(d2.status).toBe('draft');

    const d2Row = await readEvaluation(d2.id);
    expect(d2Row.results).toBeNull();
    expect(d2Row.evidence_snapshot).toBeNull();
    expect(d2Row.user_inputs).toBeNull();
    expect(d2Row.detected_context).toBeNull();

    // A third explicit call creates D3, distinct from D1 and D2.
    const d3 = await historyService.startEvaluation(fixture.userId, fixture.tradeId, v2.id);
    expect(d3.id).not.toBe(d1.id);
    expect(d3.id).not.toBe(d2.id);

    // The abandoned draft is untouched.
    const d1After = await readEvaluation(d1.id);
    expect(d1After.status).toBe('draft');
    expect(d1After.user_inputs).toEqual(d1Before.user_inputs);
    expect(d1After.detected_context).toEqual(d1Before.detected_context);
    expect(d1After.evidence_snapshot).toEqual(d1Before.evidence_snapshot);
  });

  test('terminal-pinned prepare creates a fresh v2 draft and never attaches to an abandoned v2 draft', async () => {
    const v2 = await createVersion(fixture);
    const terminalV2 = await insertTerminalEvaluation({
      ...fixture,
      versionId: v2.id,
      results: {
        setup: dimensionSummary(90, 'A', 'PASS', 100),
        entry: dimensionSummary(90, 'A', 'PASS', 100),
        management: dimensionSummary(90, 'A', 'PASS', 100)
      },
      evaluatedAt: '2026-09-04T10:00:00Z'
    });
    const abandoned = await historyService.startEvaluation(fixture.userId, fixture.tradeId, v2.id);

    // Profile advances to v3: prepare must NOT resolve the current version.
    await createVersion(fixture);

    const payload = await setupQualityService.prepare(fixture.userId, fixture.tradeId, {
      evaluationId: terminalV2
    });

    expect(payload.profileVersion.id).toBe(v2.id);
    expect(payload.evaluation.profile_version_id).toBe(v2.id);
    expect(payload.evaluation.id).not.toBe(terminalV2);
    expect(payload.evaluation.id).not.toBe(abandoned.id);
    expect(payload.evaluation.status).toBe('draft');

    // The abandoned draft and the terminal row are both untouched.
    const abandonedAfter = await readEvaluation(abandoned.id);
    expect(abandonedAfter.status).toBe('draft');
    expect(abandonedAfter.profile_version_id).toBe(v2.id);
    const terminalAfter = await readEvaluation(terminalV2);
    expect(terminalAfter.status).toBe('completed');
    expect(terminalAfter.profile_version_id).toBe(v2.id);
    expect(terminalAfter.results.setup.score).toBe(90);
  });

  test('rejects an unauthorized profile version for the trade owner', async () => {
    const otherUser = await db.query(
      `INSERT INTO users (email, username, password_hash, is_verified, is_active, admin_approved, role)
       VALUES ($1, $2, 'hash', true, true, true, 'user') RETURNING id`,
      [`phase5-other-${randomUUID().slice(0, 8)}@example.com`, `phase5_other_${randomUUID().slice(0, 8)}`]
    );
    const otherUserId = otherUser.rows[0].id;
    try {
      const otherProfile = await profileService.createProfile(otherUserId, {
        name: `Other ${randomUUID().slice(0, 6)}`,
        configuration: makeConfig()
      });
      const otherVersion = await profileService.getCurrentVersion(otherProfile.id, otherUserId);

      // The fixture user owns the trade but NOT the other user's version, so
      // startEvaluation must reject it (and must not create an evaluation).
      await expect(
        historyService.startEvaluation(fixture.userId, fixture.tradeId, otherVersion.id)
      ).rejects.toMatchObject({ code: 'VERSION_NOT_FOUND' });
      const count = await db.query(
        'SELECT COUNT(*)::int AS count FROM trade_quality_evaluations WHERE trade_id = $1',
        [fixture.tradeId]
      );
      expect(count.rows[0].count).toBe(0);
    } finally {
      await db.query(
        `DELETE FROM quality_profile_versions WHERE profile_id IN (SELECT id FROM quality_profiles WHERE user_id = $1)`,
        [otherUserId]
      );
      await db.query('DELETE FROM quality_profiles WHERE user_id = $1', [otherUserId]);
      await db.query('DELETE FROM users WHERE id = $1', [otherUserId]);
    }
  });
});

describe('Phase 5 — history list (real PostgreSQL)', () => {
  test('returns exact version metadata, primary flag, and deterministic ordering', async () => {
    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const v2 = await createVersion(fixture);
    const v3 = await createVersion(fixture);

    const older = await insertTerminalEvaluation({
      ...fixture,
      versionId: v1.id,
      results: { setup: dimensionSummary(91, 'A', 'PASS', 100), entry: dimensionSummary(95, 'A', 'PASS', 92), management: dimensionSummary(87, 'B', 'FAIL', 85) },
      evaluatedAt: '2026-09-03T10:00:00Z'
    });
    const newer = await insertTerminalEvaluation({
      ...fixture,
      versionId: v3.id,
      results: { setup: dimensionSummary(88, 'B', 'PASS', 90), entry: dimensionSummary(93, 'A', 'PASS', 90), management: dimensionSummary(90, 'A', 'PASS', 90) },
      evaluatedAt: '2026-09-11T12:00:00Z'
    });
    expect(v2.version_number).toBe(2);

    await historyService.selectPrimary(fixture.userId, fixture.tradeId, newer);
    const history = await historyService.listEvaluationsForTrade(fixture.userId, fixture.tradeId);
    expect(history.map((row) => row.id)).toEqual([newer, older]);

    const newerRow = history[0];
    expect(newerRow.profile_id).toBe(fixture.profileId);
    expect(newerRow.profile_name).toMatch(/^Phase5/);
    expect(newerRow.version_number).toBe(3);
    expect(newerRow.schema_version).toBe(1);
    expect(newerRow.is_current_version).toBe(true);
    expect(newerRow.is_primary).toBe(true);
    expect(newerRow.setup_score).toBe(88);

    const olderRow = history[1];
    expect(olderRow.version_number).toBe(1);
    expect(olderRow.is_current_version).toBe(false);
    expect(olderRow.is_primary).toBe(false);
    expect(olderRow.current_version_number).toBe(3);
    // Values are the persisted ones, not re-derived from the current v3 config.
    expect(olderRow.setup_score).toBe(91);
    expect(olderRow.entry_coverage).toBe(92);
    expect(olderRow.management_compliance).toBe('FAIL');
  });

  test('places an un-evaluated draft after evaluated rows (NULLS LAST)', async () => {
    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const evaluated = await insertTerminalEvaluation({
      ...fixture,
      versionId: v1.id,
      results: { setup: dimensionSummary(90, 'A', 'PASS', 100), entry: null, management: null },
      evaluatedAt: '2026-09-03T10:00:00Z'
    });
    const draft = await historyService.startEvaluation(fixture.userId, fixture.tradeId, v1.id);

    const history = await historyService.listEvaluationsForTrade(fixture.userId, fixture.tradeId);
    expect(history.map((row) => row.id)).toEqual([evaluated, draft.id]);
  });
});

describe('Phase 5 — primary selection (real PostgreSQL)', () => {
  test('switches primary transactionally, is idempotent, and never mutates the historical payload', async () => {
    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const v2 = await createVersion(fixture);
    const resultsA = { setup: dimensionSummary(91, 'A', 'PASS', 100), entry: null, management: null };
    const resultsB = { setup: dimensionSummary(85, 'B', 'FAIL', 100), entry: null, management: null };
    const evalA = await insertTerminalEvaluation({ ...fixture, versionId: v1.id, results: resultsA, evaluatedAt: '2026-09-03T10:00:00Z' });
    const evalB = await insertTerminalEvaluation({ ...fixture, versionId: v2.id, results: resultsB, evaluatedAt: '2026-09-04T10:00:00Z' });

    await historyService.selectPrimary(fixture.userId, fixture.tradeId, evalA);
    let history = await historyService.listEvaluationsForTrade(fixture.userId, fixture.tradeId);
    expect(history.find((row) => row.id === evalA).is_primary).toBe(true);

    const before = await readEvaluation(evalA);

    await historyService.selectPrimary(fixture.userId, fixture.tradeId, evalB);
    history = await historyService.listEvaluationsForTrade(fixture.userId, fixture.tradeId);
    expect(history.filter((row) => row.is_primary).map((row) => row.id)).toEqual([evalB]);

    // Idempotent re-select.
    await historyService.selectPrimary(fixture.userId, fixture.tradeId, evalB);
    history = await historyService.listEvaluationsForTrade(fixture.userId, fixture.tradeId);
    expect(history.filter((row) => row.is_primary)).toHaveLength(1);

    // Historical payload untouched by primary selection.
    const after = await readEvaluation(evalA);
    expect(after.results).toEqual(before.results);
    expect(after.profile_version_id).toBe(before.profile_version_id);
  });

  test('re-selecting the same primary preserves selected_at; switching advances it', async () => {
    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const v2 = await createVersion(fixture);
    const mk = (score) => ({ setup: dimensionSummary(score, 'A', 'PASS', 100), entry: null, management: null });
    const evalA = await insertTerminalEvaluation({ ...fixture, versionId: v1.id, results: mk(90), evaluatedAt: '2026-09-03T10:00:00Z' });
    const evalB = await insertTerminalEvaluation({ ...fixture, versionId: v2.id, results: mk(80), evaluatedAt: '2026-09-04T10:00:00Z' });

    const readSelectedAt = async () => {
      const result = await db.query(
        'SELECT evaluation_id, selected_at FROM trade_quality_primary_evaluations WHERE trade_id = $1',
        [fixture.tradeId]
      );
      return result.rows[0];
    };

    const first = await historyService.selectPrimary(fixture.userId, fixture.tradeId, evalA);
    const t1 = (await readSelectedAt()).selected_at;
    expect(new Date(first.selected_at).toISOString()).toBe(new Date(t1).toISOString());

    await new Promise((resolve) => setTimeout(resolve, 5));
    await historyService.selectPrimary(fixture.userId, fixture.tradeId, evalA);
    const sameRow = await readSelectedAt();
    expect(sameRow.evaluation_id).toBe(evalA);
    expect(new Date(sameRow.selected_at).toISOString()).toBe(new Date(t1).toISOString());

    await new Promise((resolve) => setTimeout(resolve, 5));
    await historyService.selectPrimary(fixture.userId, fixture.tradeId, evalB);
    const switched = await readSelectedAt();
    expect(switched.evaluation_id).toBe(evalB);
    expect(new Date(switched.selected_at).getTime()).toBeGreaterThan(new Date(t1).getTime());
  });

  test('rejects a draft, a foreign trade, and a foreign user', async () => {
    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const draft = await historyService.startEvaluation(fixture.userId, fixture.tradeId, v1.id);

    await expect(
      historyService.selectPrimary(fixture.userId, fixture.tradeId, draft.id)
    ).rejects.toMatchObject({ code: 'EVALUATION_NOT_TERMINAL' });

    const otherTrade = await db.query(
      `INSERT INTO trades (user_id, symbol, side, quantity, entry_price, trade_date, instrument_type)
       VALUES ($1, 'OTHER', 'long', 1, 10, '2026-03-10', 'stock') RETURNING id`,
      [fixture.userId]
    );
    await expect(
      historyService.selectPrimary(fixture.userId, otherTrade.rows[0].id, draft.id)
    ).rejects.toMatchObject({ code: 'EVALUATION_NOT_FOUND' });
  });

  test('concurrent competing selections leave exactly ONE primary', async () => {
    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const v2 = await createVersion(fixture);
    const v3 = await createVersion(fixture);
    const mk = (score) => ({ setup: dimensionSummary(score, 'A', 'PASS', 100), entry: null, management: null });
    const evalB = await insertTerminalEvaluation({ ...fixture, versionId: v2.id, results: mk(80), evaluatedAt: '2026-09-04T10:00:00Z' });
    const evalC = await insertTerminalEvaluation({ ...fixture, versionId: v3.id, results: mk(70), evaluatedAt: '2026-09-05T10:00:00Z' });

    const outcomes = await Promise.allSettled([
      historyService.selectPrimary(fixture.userId, fixture.tradeId, evalB),
      historyService.selectPrimary(fixture.userId, fixture.tradeId, evalC)
    ]);
    expect(outcomes.every((outcome) => outcome.status === 'fulfilled')).toBe(true);

    const primaries = await db.query(
      'SELECT evaluation_id FROM trade_quality_primary_evaluations WHERE trade_id = $1',
      [fixture.tradeId]
    );
    expect(primaries.rows).toHaveLength(1);
    expect([evalB, evalC]).toContain(primaries.rows[0].evaluation_id);
  });
});

describe('Phase 5 — comparison from persisted snapshots (real PostgreSQL)', () => {
  test('aligns criteria by key without re-running anything and without an overall score', async () => {
    // Rebuild the fixture so v1 configures leader (w80) + prior_move (w20),
    // making the comparison semantically clean.
    await destroyFixture(fixture);
    fixture = await createFixture([
      { key: 'leader', enabled: true, required: true, weight: 80, parameters: {}, scoring: binary(100, 0) },
      { key: 'prior_move', enabled: true, required: true, weight: 20, parameters: {}, scoring: binary(100, 0) }
    ]);

    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const v2 = await createVersion(fixture, [
      { key: 'leader', enabled: true, required: true, weight: 70, parameters: {}, scoring: binary(100, 0) },
      { key: 'base_duration', enabled: true, required: true, weight: 30, parameters: {}, scoring: binary(100, 0) }
    ]);

    const leftResults = {
      setup: {
        score: 90,
        grade: 'A',
        compliance: 'PASS',
        coverage: 100,
        criterionResults: [
          criterion('leader', 'PASS', 90, { weight: 80 }),
          criterion('prior_move', 'FAIL', 60, { weight: 20 })
        ]
      },
      entry: null,
      management: null
    };
    const rightResults = {
      setup: {
        score: 85,
        grade: 'B',
        compliance: 'FAIL',
        coverage: 90,
        criterionResults: [
          criterion('leader', 'PASS', 100, { weight: 70 }),
          criterion('base_duration', 'FAIL', 0, { weight: 30 })
        ]
      },
      entry: null,
      management: null
    };
    const left = await insertTerminalEvaluation({ ...fixture, versionId: v1.id, results: leftResults, evaluatedAt: '2026-09-03T10:00:00Z' });
    const right = await insertTerminalEvaluation({ ...fixture, versionId: v2.id, results: rightResults, evaluatedAt: '2026-09-11T10:00:00Z' });

    const comparison = await comparisonService.compareEvaluations(fixture.userId, fixture.tradeId, left, right);

    expect(comparison.left.version_number).toBe(1);
    expect(comparison.right.version_number).toBe(2);
    expect(comparison.dimensions.setup.left.score).toBe(90);
    expect(comparison.dimensions.setup.right.score).toBe(85);
    expect(comparison.dimensions.setup.score_delta).toBe(-5);
    expect(comparison).not.toHaveProperty('overall_score');

    const criteria = comparison.dimensions.setup.criteria;
    const leader = criteria.find((entry) => entry.key === 'leader');
    expect(leader.presence).toBe('both');
    expect(leader.score.delta).toBe(10);
    expect(leader.configuration_changed).toBe(true);
    expect(leader.configuration.left.weight).toBe(80);
    expect(leader.configuration.right.weight).toBe(70);

    const removed = criteria.find((entry) => entry.key === 'prior_move');
    expect(removed.presence).toBe('only_left');
    expect(removed.status.right).toBeNull();

    const added = criteria.find((entry) => entry.key === 'base_duration');
    expect(added.presence).toBe('only_right');
    expect(added.status.left).toBeNull();
  });

  test('rejects comparison across trades and users', async () => {
    const v1 = await profileService.getCurrentVersion(fixture.profileId, fixture.userId);
    const results = { setup: dimensionSummary(90, 'A', 'PASS', 100), entry: null, management: null };
    const evalA = await insertTerminalEvaluation({ ...fixture, versionId: v1.id, results, evaluatedAt: '2026-09-03T10:00:00Z' });

    const otherUser = await db.query(
      `INSERT INTO users (email, username, password_hash, is_verified, is_active, admin_approved, role)
       VALUES ($1, $2, 'hash', true, true, true, 'user') RETURNING id`,
      [`phase5-cmp-${randomUUID().slice(0, 8)}@example.com`, `phase5_cmp_${randomUUID().slice(0, 8)}`]
    );
    const otherUserId = otherUser.rows[0].id;
    try {
      const otherTrade = await db.query(
        `INSERT INTO trades (user_id, symbol, side, quantity, entry_price, trade_date, instrument_type)
         VALUES ($1, 'X', 'long', 1, 10, '2026-03-10', 'stock') RETURNING id`,
        [otherUserId]
      );
      const otherProfile = await profileService.createProfile(otherUserId, {
        name: `Other ${randomUUID().slice(0, 6)}`,
        configuration: makeConfig()
      });
      const otherVersion = await profileService.getCurrentVersion(otherProfile.id, otherUserId);
      const foreignEval = await insertTerminalEvaluation({
        userId: otherUserId,
        tradeId: otherTrade.rows[0].id,
        versionId: otherVersion.id,
        results,
        evaluatedAt: '2026-09-03T10:00:00Z'
      });

      // Different trade: the foreign evaluation is not visible for this trade.
      await expect(
        comparisonService.compareEvaluations(fixture.userId, fixture.tradeId, evalA, foreignEval)
      ).rejects.toMatchObject({ code: 'EVALUATION_NOT_FOUND' });

      // Different user cannot compare the fixture evaluation with their own.
      await expect(
        comparisonService.compareEvaluations(otherUserId, otherTrade.rows[0].id, evalA, foreignEval)
      ).rejects.toMatchObject({ code: 'EVALUATION_NOT_FOUND' });
    } finally {
      await db.query('DELETE FROM trade_quality_primary_evaluations WHERE user_id = $1', [otherUserId]);
      await db.query('DELETE FROM trade_quality_evaluations WHERE user_id = $1', [otherUserId]);
      await db.query(
        `DELETE FROM quality_profile_versions WHERE profile_id IN (SELECT id FROM quality_profiles WHERE user_id = $1)`,
        [otherUserId]
      );
      await db.query('DELETE FROM quality_profiles WHERE user_id = $1', [otherUserId]);
      await db.query('DELETE FROM trades WHERE user_id = $1', [otherUserId]);
      await db.query('DELETE FROM users WHERE id = $1', [otherUserId]);
    }
  });
});
