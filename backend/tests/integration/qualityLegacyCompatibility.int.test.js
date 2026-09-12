'use strict';

// Real-PostgreSQL acceptance gate for Phase 6 (Legacy Integration), per
// docs/QUALITY_PROFILES_REQUIREMENT.md sections 54 and 66.
//
// Runs only via `pnpm --dir backend test:integration`. Exercises the ACTUAL
// SQL of the Phase-6 compatibility layer: the trade-list LATERAL join, the
// effective Setup-grade filter used by list/count/analytics, and the additive
// qualitySummary resolution. No market-data providers are involved.
//
// Fixture matrix (prompt Phase-6 s.25):
//   T1 legacy A, no primary                       -> legacy
//   T2 legacy A, primary C                         -> profile_primary C
//   T3 legacy B, primary A                         -> profile_primary A
//   T4 no legacy, primary A                        -> profile_primary A
//   T5 legacy A, primary insufficient_data (null)  -> profile_primary N/A
//   T6 legacy C, completed profile A but NO primary-> legacy C
//   T7 no legacy, no primary                       -> none

const { randomUUID } = require('crypto');
const db = require('../../src/config/database');
const profileService = require('../../src/services/quality/profileService');
const historyService = require('../../src/services/quality/historyService');
const legacyCompatibilityService = require('../../src/services/quality/legacyCompatibilityService');
const AnalyticsCache = require('../../src/services/analyticsCache');
const TradeQueries = require('../../src/services/tradeQueries');
const Trade = require('../../src/models/Trade');

function binary(pass, fail) {
  return { type: 'binary', pass_score: pass, fail_score: fail };
}

function makeConfig() {
  return {
    dimensions: {
      setup: {
        minimum_coverage: 70,
        grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
        criteria: [
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

async function insertTrade(userId, symbol, { entryDate = '2026-03-10' } = {}) {
  const row = await db.query(
    `INSERT INTO trades (
       user_id, symbol, side, quantity, entry_price, exit_price, pnl,
       entry_time, exit_time, trade_date, instrument_type
     ) VALUES ($1, $2, 'long', 1, 100, 110, 10,
       $3, $4, $5, 'stock')
     RETURNING id`,
    [userId, symbol, `${entryDate}T14:30:00Z`, `${entryDate}T20:00:00Z`, entryDate]
  );
  return row.rows[0].id;
}

async function setLegacyQuality(tradeId, { grade, score, metrics }) {
  await db.query(
    `UPDATE trades SET quality_grade = $2, quality_score = $3, quality_metrics = $4 WHERE id = $1`,
    [tradeId, grade ?? null, score ?? null, metrics ? JSON.stringify(metrics) : null]
  );
}

async function insertCompletedEvaluation({ userId, tradeId, versionId, setup }) {
  const results = {
    setup: {
      score: setup.score,
      grade: setup.grade,
      compliance: setup.compliance,
      coverage: setup.coverage,
      criterionResults: []
    },
    entry: null,
    management: null
  };
  const row = await db.query(
    `INSERT INTO trade_quality_evaluations (
       user_id, trade_id, profile_version_id, status, results,
       setup_score, setup_grade, setup_compliance, setup_coverage,
       evaluated_at
     ) VALUES ($1, $2, $3, 'completed', $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      userId, tradeId, versionId, JSON.stringify(results),
      setup.score, setup.grade, setup.compliance, setup.coverage,
      '2026-03-11T10:00:00Z'
    ]
  );
  return row.rows[0].id;
}

async function insertInsufficientEvaluation({ userId, tradeId, versionId }) {
  const row = await db.query(
    `INSERT INTO trade_quality_evaluations (
       user_id, trade_id, profile_version_id, status, results,
       setup_score, setup_grade, setup_compliance, setup_coverage,
       evaluated_at
     ) VALUES ($1, $2, $3, 'insufficient_data', NULL, NULL, NULL, NULL, NULL, $4)
     RETURNING id`,
    [userId, tradeId, versionId, '2026-03-11T10:00:00Z']
  );
  return row.rows[0].id;
}

async function setPrimary(tradeId, userId, evaluationId) {
  await db.query(
    `INSERT INTO trade_quality_primary_evaluations (trade_id, user_id, evaluation_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (trade_id) DO UPDATE SET evaluation_id = EXCLUDED.evaluation_id`,
    [tradeId, userId, evaluationId]
  );
}

async function createFixture() {
  const suffix = randomUUID().slice(0, 8);
  const user = await db.query(
    `INSERT INTO users (email, username, password_hash, is_verified, is_active, admin_approved, role)
     VALUES ($1, $2, 'integration-test-hash', true, true, true, 'user') RETURNING id`,
    [`phase6-${suffix}@example.com`, `phase6_${suffix}`]
  );
  const userId = user.rows[0].id;

  const profile = await profileService.createProfile(userId, {
    name: `Phase6 ${suffix}`,
    configuration: makeConfig()
  });
  const version = await profileService.getCurrentVersion(profile.id, userId);

  const legacyMetrics = { float: 1, relativeVolume: 1.2, priceRange: 0.8, gap: 0.1, coverage: 0.95 };
  const trades = {
    t1: await insertTrade(userId, `P6T1_${suffix}`),
    t2: await insertTrade(userId, `P6T2_${suffix}`),
    t3: await insertTrade(userId, `P6T3_${suffix}`),
    t4: await insertTrade(userId, `P6T4_${suffix}`),
    t5: await insertTrade(userId, `P6T5_${suffix}`),
    t6: await insertTrade(userId, `P6T6_${suffix}`),
    t7: await insertTrade(userId, `P6T7_${suffix}`)
  };

  // T1 legacy A only
  await setLegacyQuality(trades.t1, { grade: 'A', score: 4.5, metrics: legacyMetrics });
  // T2 legacy A + primary C
  await setLegacyQuality(trades.t2, { grade: 'A', score: 4.6, metrics: legacyMetrics });
  await setPrimary(trades.t2, userId, await insertCompletedEvaluation({
    userId, tradeId: trades.t2, versionId: version.id,
    setup: { score: 72, grade: 'C', compliance: 'FAIL', coverage: 95 }
  }));
  // T3 legacy B + primary A
  await setLegacyQuality(trades.t3, { grade: 'B', score: 3.5, metrics: legacyMetrics });
  await setPrimary(trades.t3, userId, await insertCompletedEvaluation({
    userId, tradeId: trades.t3, versionId: version.id,
    setup: { score: 92, grade: 'A', compliance: 'PASS', coverage: 100 }
  }));
  // T4 no legacy + primary A
  await setPrimary(trades.t4, userId, await insertCompletedEvaluation({
    userId, tradeId: trades.t4, versionId: version.id,
    setup: { score: 91, grade: 'A', compliance: 'PASS', coverage: 100 }
  }));
  // T5 legacy A + primary insufficient_data/null
  await setLegacyQuality(trades.t5, { grade: 'A', score: 4.8, metrics: legacyMetrics });
  await setPrimary(trades.t5, userId, await insertInsufficientEvaluation({
    userId, tradeId: trades.t5, versionId: version.id
  }));
  // T6 legacy C + completed profile A but NO primary
  await setLegacyQuality(trades.t6, { grade: 'C', score: 2.5, metrics: legacyMetrics });
  await insertCompletedEvaluation({
    userId, tradeId: trades.t6, versionId: version.id,
    setup: { score: 92, grade: 'A', compliance: 'PASS', coverage: 100 }
  });
  // T7 no legacy, no primary: nothing to set.

  return { userId, profileId: profile.id, versionId: version.id, trades };
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

async function snapshotLegacy(userId) {
  const result = await db.query(
    `SELECT id, quality_grade, quality_score, quality_metrics FROM trades WHERE user_id = $1 ORDER BY id`,
    [userId]
  );
  return result.rows;
}

async function snapshotProfileState(fixture) {
  const [evaluations, primaries, versions] = await Promise.all([
    db.query('SELECT id FROM trade_quality_evaluations WHERE user_id = $1 ORDER BY id', [fixture.userId]),
    db.query('SELECT trade_id, evaluation_id FROM trade_quality_primary_evaluations WHERE user_id = $1 ORDER BY trade_id', [fixture.userId]),
    db.query('SELECT id FROM quality_profile_versions WHERE profile_id = $1 ORDER BY id', [fixture.profileId])
  ]);
  return {
    evaluationIds: evaluations.rows.map((r) => r.id),
    primaries: primaries.rows,
    versionIds: versions.rows.map((r) => r.id)
  };
}

async function listTrades(fixture, filters = {}) {
  return TradeQueries.findByUser(fixture.userId, filters);
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

describe('Phase 6 — compatibility source resolution (real PostgreSQL)', () => {
  test('list payload exposes resolved sources and preserves raw legacy fields', async () => {
    const rows = await listTrades(fixture);
    const byId = new Map(rows.map((r) => [r.id, r]));

    const expectedSource = {
      t1: 'legacy',
      t2: 'profile_primary',
      t3: 'profile_primary',
      t4: 'profile_primary',
      t5: 'profile_primary',
      t6: 'legacy',
      t7: 'none'
    };

    for (const [key, tradeId] of Object.entries(fixture.trades)) {
      const row = byId.get(tradeId);
      expect(row).toBeTruthy();
      const summary = legacyCompatibilityService.resolveQualitySummary(row);
      expect(summary.source).toBe(expectedSource[key]);
      // Raw legacy columns stay on the payload unchanged.
      expect(Object.prototype.hasOwnProperty.call(row, 'quality_grade')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(row, 'quality_score')).toBe(true);
    }

    // Both T2: legacy grade stays A while compatibility Setup is primary C.
    const t2 = legacyCompatibilityService.resolveQualitySummary(byId.get(fixture.trades.t2));
    expect(t2.setup.grade).toBe('C');
    expect(t2.setup.scoreScale).toBe(100);
    expect(t2.profile.profileName).toBe(byId.get(fixture.trades.t2).primary_profile_name);
    expect(byId.get(fixture.trades.t2).quality_grade).toBe('A');

    // T5: primary exists but is ungraded -> N/A, NOT legacy A.
    const t5 = legacyCompatibilityService.resolveQualitySummary(byId.get(fixture.trades.t5));
    expect(t5.source).toBe('profile_primary');
    expect(t5.setup.grade).toBeNull();
    expect(byId.get(fixture.trades.t5).quality_grade).toBe('A');

    // T1 legacy summary: scoreScale 5, no fabricated compliance, coverage from metrics.
    const t1 = legacyCompatibilityService.resolveQualitySummary(byId.get(fixture.trades.t1));
    expect(t1.setup.scoreScale).toBe(5);
    expect(t1.setup.compliance).toBeNull();
    expect(t1.setup.coverage).toBeCloseTo(95, 5);

    // T7: nothing at all.
    const t7 = legacyCompatibilityService.resolveQualitySummary(byId.get(fixture.trades.t7));
    expect(t7.source).toBe('none');
    expect(t7.setup.grade).toBeNull();
  });

  test('non-primary historical evaluations never affect resolution or filtering', async () => {
    // T6 has a completed evaluation but no primary -> legacy wins.
    const rows = await listTrades(fixture);
    const t6 = legacyCompatibilityService.resolveQualitySummary(rows.find((r) => r.id === fixture.trades.t6));
    expect(t6.source).toBe('legacy');
    expect(t6.setup.grade).toBe('C');
  });
});

describe('Phase 6 — effective Setup grade filter consistency (real PostgreSQL)', () => {
  test('qualityGrades=A matches exactly T1, T3, T4 (never a null primary falling back)', async () => {
    const rows = await listTrades(fixture, { qualityGrades: ['A'] });
    const ids = rows.map((r) => r.id).sort();
    const expected = [fixture.trades.t1, fixture.trades.t3, fixture.trades.t4].sort();
    expect(ids).toEqual(expected);

    // T5 (primary NULL) must NOT appear through its legacy A.
    expect(ids).not.toContain(fixture.trades.t5);
    // T2 (primary C) must NOT appear.
    expect(ids).not.toContain(fixture.trades.t2);
    // T6 (legacy C, no primary) must NOT appear.
    expect(ids).not.toContain(fixture.trades.t6);
  });

  test('qualityGrades=C matches T2 (primary C) and T6 (legacy C, no primary)', async () => {
    const rows = await listTrades(fixture, { qualityGrades: ['C'] });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual([fixture.trades.t2, fixture.trades.t6].sort());
  });

  test('multiple requested grades continue to work', async () => {
    const rows = await listTrades(fixture, { qualityGrades: ['A', 'C'] });
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(
      [fixture.trades.t1, fixture.trades.t2, fixture.trades.t3, fixture.trades.t4, fixture.trades.t6].sort()
    );
  });

  test('count agrees with the list set for the same filter', async () => {
    const rows = await listTrades(fixture, { qualityGrades: ['A'] });
    const total = await Trade.getCountWithFilters(fixture.userId, { qualityGrades: ['A'] });
    expect(total).toBe(rows.length);
    expect(total).toBe(3);
  });

  test('analytics summary is computed from the same filtered population', async () => {
    const analytics = await TradeQueries.getAnalytics(fixture.userId, { qualityGrades: ['A'] });
    expect(analytics.summary.totalTrades).toBe(3);
  });
});

describe('Phase 6 — no mutation and raw preservation (real PostgreSQL)', () => {
  test('display/filter/analytics queries mutate neither legacy data nor profile history', async () => {
    const legacyBefore = await snapshotLegacy(fixture.userId);
    const profileBefore = await snapshotProfileState(fixture);

    await listTrades(fixture);
    await listTrades(fixture, { qualityGrades: ['A'] });
    await Trade.getCountWithFilters(fixture.userId, { qualityGrades: ['A'] });
    await TradeQueries.getAnalytics(fixture.userId, { qualityGrades: ['A'] });
    await legacyCompatibilityService.resolveForOwnedTrade(fixture.userId, {
      id: fixture.trades.t2,
      quality_grade: 'A',
      quality_score: 4.6,
      quality_metrics: null
    });

    const legacyAfter = await snapshotLegacy(fixture.userId);
    const profileAfter = await snapshotProfileState(fixture);

    expect(legacyAfter).toEqual(legacyBefore);
    expect(profileAfter.evaluationIds).toEqual(profileBefore.evaluationIds);
    expect(profileAfter.primaries).toEqual(profileBefore.primaries);
    expect(profileAfter.versionIds).toEqual(profileBefore.versionIds);
  });

  test('simulated legacy recalculation writes only legacy columns', async () => {
    const profileBefore = await snapshotProfileState(fixture);
    // The legacy calculator's persistence is a plain UPDATE of the legacy
    // columns; profile history and the primary pointer must stay untouched.
    await db.query(
      `UPDATE trades SET quality_grade = $2, quality_score = $3, quality_metrics = $4 WHERE id = $1 AND user_id = $5`,
      [fixture.trades.t1, 'B', 3.9, JSON.stringify({ coverage: 0.9 }), fixture.userId]
    );
    const profileAfter = await snapshotProfileState(fixture);
    expect(profileAfter).toEqual(profileBefore);

    const t1 = await db.query('SELECT quality_grade, quality_score FROM trades WHERE id = $1', [fixture.trades.t1]);
    expect(t1.rows[0].quality_grade).toBe('B');
    expect(Number(t1.rows[0].quality_score)).toBeCloseTo(3.9, 5);

    // The primary pointer for T5 is unaffected by an unrelated legacy update.
    const primaryT5 = await db.query(
      'SELECT evaluation_id FROM trade_quality_primary_evaluations WHERE trade_id = $1',
      [fixture.trades.t5]
    );
    expect(primaryT5.rows).toHaveLength(1);
  });
});

describe('Phase 6 — primary mutation invalidates stale analytics cache (real PostgreSQL)', () => {
  test('selectPrimary clears the cached qualityGrades population and recomputes it', async () => {
    // T3 currently resolves to primary A (effective A). Cache an A-filtered
    // population, then switch T3 to primary C and prove the stale cache is gone
    // and the recomputed population no longer contains T3.
    const filters = { qualityGrades: ['A'] };
    const cacheKey = TradeQueries.cacheKey(fixture.userId, filters);

    const before = await TradeQueries.getAnalytics(fixture.userId, filters);
    expect(before.summary.totalTrades).toBe(3); // T1 legacy A, T3 primary A, T4 primary A

    await AnalyticsCache.set(fixture.userId, cacheKey, { stale: true }, 60);
    expect(await AnalyticsCache.get(fixture.userId, cacheKey)).not.toBeNull();

    const evalC = await insertCompletedEvaluation({
      userId: fixture.userId,
      tradeId: fixture.trades.t3,
      versionId: fixture.versionId,
      setup: { score: 72, grade: 'C', compliance: 'FAIL', coverage: 95 }
    });

    await historyService.selectPrimary(fixture.userId, fixture.trades.t3, evalC);

    // The effective primary change invalidated the user's analytics cache.
    expect(await AnalyticsCache.get(fixture.userId, cacheKey)).toBeNull();

    const after = await TradeQueries.getAnalytics(fixture.userId, filters);
    expect(after.summary.totalTrades).toBe(2); // T1 + T4; T3 is now effective C
    const rows = await TradeQueries.findByUser(fixture.userId, filters);
    expect(rows.map((r) => r.id).sort()).toEqual([fixture.trades.t1, fixture.trades.t4].sort());
  });

  test('clearPrimary clears the cached population and restores legacy semantics', async () => {
    const filters = { qualityGrades: ['A'] };
    const cacheKey = TradeQueries.cacheKey(fixture.userId, filters);
    await AnalyticsCache.set(fixture.userId, cacheKey, { stale: true }, 60);
    expect(await AnalyticsCache.get(fixture.userId, cacheKey)).not.toBeNull();

    // T2 has legacy A + primary C; clearing the primary restores legacy A.
    await historyService.clearPrimary(fixture.userId, fixture.trades.t2);

    expect(await AnalyticsCache.get(fixture.userId, cacheKey)).toBeNull();
    const rows = await TradeQueries.findByUser(fixture.userId, filters);
    expect(rows.map((r) => r.id)).toContain(fixture.trades.t2);
  });
});
