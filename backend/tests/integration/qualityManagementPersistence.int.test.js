'use strict';

// Real-PostgreSQL acceptance gate for the Phase-4 Management persistence path.
//
// This suite runs only via `pnpm --dir backend test:integration`. It exercises
// the ACTUAL SQL of saveManagementProgress / saveEntryProgress / saveResult and
// the Management orchestrator persistence path against the isolated scratch
// database; only the market-data providers are stubbed (no external calls).

jest.mock('../../src/services/quality/marketEvidenceService', () => {
  const actual = jest.requireActual('../../src/services/quality/marketEvidenceService');
  return { ...actual, loadDailyEvidence: jest.fn() };
});

jest.mock('../../src/services/quality/intradayEvidenceService', () => {
  const actual = jest.requireActual('../../src/services/quality/intradayEvidenceService');
  return { ...actual, loadSessionIntradayBars: jest.fn() };
});

const { randomUUID } = require('crypto');
const db = require('../../src/config/database');
const evaluationService = require('../../src/services/quality/evaluationService');
const ManagementQualityService = require('../../src/services/quality/managementQualityService');
const { loadDailyEvidence } = require('../../src/services/quality/marketEvidenceService');
const { loadSessionIntradayBars } = require('../../src/services/quality/intradayEvidenceService');
const { entryDependencyFingerprint, setupDependencyFingerprint } = require('../../src/services/quality/dependencyFingerprint');
const { aggregateDimension } = require('../../src/services/quality/aggregation');

const ENTRY_SESSION = '2026-03-10';

function binaryScoring(pass, fail) {
  return { type: 'binary', pass_score: pass, fail_score: fail };
}

// Minimal three-dimension configuration so finalize() can re-validate all
// dimensions. Management uses a registered evaluator key.
const CONFIG = {
  dimensions: {
    setup: {
      minimum_coverage: 70,
      grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
      criteria: [{ key: 'leader', enabled: true, required: true, weight: 100, parameters: {}, scoring: binaryScoring(100, 0) }]
    },
    entry: {
      minimum_coverage: 70,
      grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
      criteria: [{ key: 'breakout_session', enabled: true, required: true, weight: 100, parameters: {}, scoring: binaryScoring(100, 0) }]
    },
    management: {
      minimum_coverage: 70,
      grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
      criteria: [{ key: 'stop_ratchet', enabled: true, required: true, weight: 100, parameters: { downward_tolerance_ticks: 0 }, scoring: binaryScoring(100, 0) }]
    }
  }
};

function addDays(dateString, days) {
  const date = new Date(`${dateString}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().split('T')[0];
}

function dailyBars() {
  const bars = [];
  for (let i = 10; i >= -3; i -= 1) {
    const date = addDays(ENTRY_SESSION, -i);
    bars.push({ date, time: Math.floor(new Date(`${date}T00:00:00.000Z`).getTime() / 1000), open: 100, high: 101, low: 99, close: 100, volume: 1000 });
  }
  return bars;
}

function entryEvidence(overrides = {}) {
  return {
    execution: {
      entry_basis: 100,
      original_position_qty: 200,
      actual_entry_session: ENTRY_SESSION,
      initial_entry_time: '2026-03-10T14:30:00.000Z',
      initial_entry_fill_epoch: 1773153000,
      first_reduction_time: null,
      fills: []
    },
    initial_r: { available: true, r_per_share: 5, entry_basis: 100, initial_stop: 95, original_position_qty: 200 },
    ...overrides
  };
}

function aggregateResult(config, key, status, score) {
  const scoringValue = null;
  return aggregateDimension(config, [{ key, status, score, scoring_value: scoringValue }]);
}

async function createFixture() {
  const suffix = randomUUID().slice(0, 8);
  const profileId = randomUUID();
  const versionId = randomUUID();
  const user = await db.query(
    `INSERT INTO users (email, username, password_hash, is_verified, is_active, admin_approved, role)
     VALUES ($1, $2, 'integration-test-hash', true, true, true, 'user') RETURNING id`,
    [`mgmt-${suffix}@example.com`, `mgmt_${suffix}`]
  );
  const userId = user.rows[0].id;

  await db.query(
    `INSERT INTO quality_profiles (id, user_id, name) VALUES ($1, $2, $3)`,
    [profileId, userId, `Mgmt Integration ${suffix}`]
  );
  await db.query(
    `INSERT INTO quality_profile_versions (id, profile_id, version_number, schema_version, configuration)
     VALUES ($1, $2, 1, 1, $3)`,
    [versionId, profileId, CONFIG]
  );

  const trade = await db.query(
    `INSERT INTO trades (user_id, symbol, side, quantity, entry_price, trade_date, instrument_type, tick_size, executions)
     VALUES ($1, 'TEST', 'long', 200, 100, $2, 'stock', 0.01, $3) RETURNING id`,
    [userId, ENTRY_SESSION, JSON.stringify([
      { action: 'buy', quantity: 200, price: 100, datetime: '2026-03-10T14:30:00.000Z' }
    ])]
  );
  const tradeId = trade.rows[0].id;

  const snapshot = { symbol: 'TEST', resolution: 'daily', entrySessionDate: ENTRY_SESSION, completeness: 'verified', source: 'stub', bars: dailyBars() };
  const setupResult = aggregateResult(CONFIG.dimensions.setup, 'leader', 'PASS', 100);
  const entryResult = aggregateResult(CONFIG.dimensions.entry, 'breakout_session', 'PASS', 100);
  const setupFingerprint = setupDependencyFingerprint({
    profileVersionId: versionId,
    boundary: { pivotPrice: 100, resolutionDate: ENTRY_SESSION, baseStartDate: '2026-02-10' },
    evidenceSnapshot: snapshot
  });
  const entryFingerprint = entryDependencyFingerprint({ profileVersionId: versionId, entryEvidence: entryEvidence() });

  const evaluation = await db.query(
    `INSERT INTO trade_quality_evaluations
       (user_id, trade_id, profile_version_id, status, results, detected_context, evidence_snapshot, user_inputs)
     VALUES ($1, $2, $3, 'draft', $4, $5, $6, $7) RETURNING id`,
    [
      userId,
      tradeId,
      versionId,
      JSON.stringify({ setup: setupResult, entry: entryResult, management: null }),
      JSON.stringify({
        boundary: { pivotPrice: 100, resolutionDate: ENTRY_SESSION, baseStartDate: '2026-02-10' },
        setup_dependency_fingerprint: setupFingerprint,
        setup_context_revision: '1',
        entry: { entry_dependency_fingerprint: entryFingerprint }
      }),
      JSON.stringify({ ...snapshot, entry: entryEvidence() }),
      JSON.stringify({})
    ]
  );

  return { userId, tradeId, profileId, versionId, evaluationId: evaluation.rows[0].id, setupFingerprint, entryFingerprint, setupResult, entryResult };
}

async function destroyFixture(target) {
  if (!target) return;
  await db.query('DELETE FROM trade_quality_evaluations WHERE user_id = $1', [target.userId]);
  await db.query('DELETE FROM quality_profile_versions WHERE profile_id = $1', [target.profileId]);
  await db.query('DELETE FROM quality_profiles WHERE id = $1', [target.profileId]);
  await db.query('DELETE FROM trades WHERE user_id = $1', [target.userId]);
  await db.query('DELETE FROM users WHERE id = $1', [target.userId]);
}

async function readEvaluation(evaluationId) {
  const result = await db.query(
    `SELECT status, results, detected_context, evidence_snapshot, user_inputs, management_score, management_compliance
     FROM trade_quality_evaluations WHERE id = $1`,
    [evaluationId]
  );
  return result.rows[0];
}

let fixture;

beforeAll(async () => {
  fixture = await createFixture();
  loadDailyEvidence.mockResolvedValue({ bars: dailyBars(), source: 'stub', completeness: 'verified', error: null });
  loadSessionIntradayBars.mockResolvedValue({ available: false, bars: [], source: null, reason: 'stub' });
});

afterAll(async () => {
  await destroyFixture(fixture);
  await db.pool.end();
});

describe('Management persistence — real PostgreSQL', () => {
  test('Setup + Entry state is already persisted and Management evaluate succeeds', async () => {
    const payload = await ManagementQualityService.evaluate(fixture.userId, fixture.tradeId, {
      evaluationId: fixture.evaluationId
    });
    expect(payload.evaluation).toBeTruthy();
    expect(payload.evaluation.results.management).toBeTruthy();
    // Management write must not disturb the unrelated Setup/Entry state.
    const row = await readEvaluation(fixture.evaluationId);
    expect(row.results.setup).toEqual(fixture.setupResult);
    expect(row.results.entry).toEqual(fixture.entryResult);
    expect(row.evidence_snapshot.entry.execution.entry_basis).toBe(100);
    // Production has no stop history: stop_ratchet UNKNOWN, management INCOMPLETE.
    expect(row.management_compliance).toBe('INCOMPLETE');
  });

  test('trailing-MA first establishment executes the real establish bind path', async () => {
    const managementCriteria = [{ key: 'stop_ratchet', status: 'UNKNOWN', score: null, scoring_value: null }];
    const updated = await evaluationService.saveManagementProgress(fixture.evaluationId, fixture.userId, {
      managementResults: { criterionResults: managementCriteria },
      managementEvidence: { marker: 'establish' },
      managementDetectedContext: { marker: 'establish' },
      dependencyFingerprint: fixture.setupFingerprint,
      entryDependencyFingerprint: fixture.entryFingerprint,
      trailingMa: { mode: 'establish', value: 10 }
    });
    expect(updated).not.toBeNull();
    const row = await readEvaluation(fixture.evaluationId);
    expect(row.user_inputs.trailing_ma_period).toBe(10);
    expect(row.user_inputs.immutable_semantic_context.trailing_ma.value).toBe(10);
    const firstSelectedAt = row.user_inputs.immutable_semantic_context.trailing_ma.selected_at;
    expect(typeof firstSelectedAt).toBe('string');

    // Same-value rerun normalizes to preserve and keeps the first authority.
    const rerun = await evaluationService.saveManagementProgress(fixture.evaluationId, fixture.userId, {
      managementResults: { criterionResults: managementCriteria },
      managementEvidence: { marker: 'preserve' },
      managementDetectedContext: { marker: 'preserve' },
      dependencyFingerprint: fixture.setupFingerprint,
      entryDependencyFingerprint: fixture.entryFingerprint,
      trailingMa: { mode: 'establish', value: 10 }
    });
    expect(rerun).not.toBeNull();
    const row2 = await readEvaluation(fixture.evaluationId);
    expect(row2.user_inputs.immutable_semantic_context.trailing_ma.selected_at).toBe(firstSelectedAt);
  });

  test('a different trailing-MA claim cannot win (TRAILING_MA_IMMUTABLE)', async () => {
    await expect(
      evaluationService.saveManagementProgress(fixture.evaluationId, fixture.userId, {
        managementResults: { criterionResults: [{ key: 'stop_ratchet', status: 'UNKNOWN', score: null, scoring_value: null }] },
        dependencyFingerprint: fixture.setupFingerprint,
        entryDependencyFingerprint: fixture.entryFingerprint,
        trailingMa: { mode: 'establish', value: 20 }
      })
    ).rejects.toMatchObject({ code: 'TRAILING_MA_IMMUTABLE' });
  });

  test('trailing activation boundary first assertion executes the establish bind path', async () => {
    const managementCriteria = [{ key: 'stop_ratchet', status: 'UNKNOWN', score: null, scoring_value: null }];
    const updated = await evaluationService.saveManagementProgress(fixture.evaluationId, fixture.userId, {
      managementResults: { criterionResults: managementCriteria },
      dependencyFingerprint: fixture.setupFingerprint,
      entryDependencyFingerprint: fixture.entryFingerprint,
      trailingActivation: { mode: 'establish', session: '2026-03-12' }
    });
    expect(updated).not.toBeNull();
    const row = await readEvaluation(fixture.evaluationId);
    expect(row.user_inputs.trailing_activation_session).toBe('2026-03-12');
    expect(row.user_inputs.immutable_semantic_context.trailing_activation.session).toBe('2026-03-12');
    const assertedAt = row.user_inputs.immutable_semantic_context.trailing_activation.asserted_at;
    expect(typeof assertedAt).toBe('string');

    // Same-value rerun preserves the first asserted_at (immutable authority).
    await evaluationService.saveManagementProgress(fixture.evaluationId, fixture.userId, {
      managementResults: { criterionResults: managementCriteria },
      dependencyFingerprint: fixture.setupFingerprint,
      entryDependencyFingerprint: fixture.entryFingerprint,
      trailingActivation: { mode: 'establish', session: '2026-03-12' }
    });
    const row2 = await readEvaluation(fixture.evaluationId);
    expect(row2.user_inputs.immutable_semantic_context.trailing_activation.asserted_at).toBe(assertedAt);
  });

  test('a competing activation boundary cannot win (TRAILING_ACTIVATION_IMMUTABLE)', async () => {
    await expect(
      evaluationService.saveManagementProgress(fixture.evaluationId, fixture.userId, {
        managementResults: { criterionResults: [{ key: 'stop_ratchet', status: 'UNKNOWN', score: null, scoring_value: null }] },
        dependencyFingerprint: fixture.setupFingerprint,
        entryDependencyFingerprint: fixture.entryFingerprint,
        trailingActivation: { mode: 'establish', session: '2026-03-13' }
      })
    ).rejects.toMatchObject({ code: 'TRAILING_ACTIVATION_IMMUTABLE' });
  });

  test('Setup fingerprint / revision CAS rejects a stale Management write', async () => {
    await expect(
      evaluationService.saveManagementProgress(fixture.evaluationId, fixture.userId, {
        managementResults: { criterionResults: [{ key: 'stop_ratchet', status: 'UNKNOWN', score: null, scoring_value: null }] },
        dependencyFingerprint: 'stale-setup-fingerprint',
        entryDependencyFingerprint: fixture.entryFingerprint
      })
    ).rejects.toMatchObject({ code: 'STALE_DEPENDENCY' });
  });

  test('Entry dependency fingerprint CAS rejects a stale Management write', async () => {
    await expect(
      evaluationService.saveManagementProgress(fixture.evaluationId, fixture.userId, {
        managementResults: { criterionResults: [{ key: 'stop_ratchet', status: 'UNKNOWN', score: null, scoring_value: null }] },
        dependencyFingerprint: fixture.setupFingerprint,
        entryDependencyFingerprint: 'stale-entry-fingerprint'
      })
    ).rejects.toMatchObject({ code: 'STALE_ENTRY_DEPENDENCY' });
  });

  test('an Entry dependency change invalidates existing Management atomically', async () => {
    const changedEvidence = entryEvidence({ execution: { entry_basis: 101, original_position_qty: 200, actual_entry_session: ENTRY_SESSION } });
    const entryResults = { criterionResults: [{ key: 'breakout_session', status: 'PASS', score: 100, scoring_value: null }] };
    const updated = await evaluationService.saveEntryProgress(fixture.evaluationId, fixture.userId, {
      entryResults,
      entryEvidence: changedEvidence,
      entryDetectedContext: { reEvaluated: true },
      dependencyFingerprint: fixture.setupFingerprint
    });
    expect(updated).not.toBeNull();
    const row = await readEvaluation(fixture.evaluationId);
    expect(row.results.management).toBeNull();
    expect(row.detected_context.management).toBeUndefined();
    expect(row.evidence_snapshot.management).toBeUndefined();
    // The changed Entry fingerprint is persisted for future Management CAS.
    expect(typeof row.detected_context.entry.entry_dependency_fingerprint).toBe('string');
  });

  test('finalize works against real PostgreSQL and completed is immutable', async () => {
    const row = await readEvaluation(fixture.evaluationId);
    // Build a valid Management result for the minimal config.
    const managementResult = aggregateResult(CONFIG.dimensions.management, 'stop_ratchet', 'PASS', 100);
    await db.query('UPDATE trade_quality_evaluations SET results = $2 WHERE id = $1', [
      fixture.evaluationId,
      JSON.stringify({ ...row.results, management: managementResult })
    ]);

    const payload = await ManagementQualityService.finalize(fixture.userId, fixture.tradeId, { evaluationId: fixture.evaluationId });
    expect(payload.evaluation.status).toBe('completed');

    // Terminal rows reject further management writes.
    const rejected = await evaluationService.saveManagementProgress(fixture.evaluationId, fixture.userId, {
      managementResults: { criterionResults: [{ key: 'stop_ratchet', status: 'UNKNOWN', score: null, scoring_value: null }] },
      dependencyFingerprint: fixture.setupFingerprint,
      entryDependencyFingerprint: fixture.entryFingerprint
    });
    expect(rejected).toBeNull();
  });

  test('insufficient_data is terminal and immutable', async () => {
    const second = await createFixture();
    try {
      const terminal = await evaluationService.saveResult(second.evaluationId, second.userId, {
        status: 'insufficient_data',
        results: null
      });
      expect(terminal.status).toBe('insufficient_data');
      const rejected = await evaluationService.saveManagementProgress(second.evaluationId, second.userId, {
        managementResults: { criterionResults: [{ key: 'stop_ratchet', status: 'UNKNOWN', score: null, scoring_value: null }] },
        dependencyFingerprint: second.setupFingerprint,
        entryDependencyFingerprint: second.entryFingerprint
      });
      expect(rejected).toBeNull();
    } finally {
      await destroyFixture(second);
    }
  });
});
