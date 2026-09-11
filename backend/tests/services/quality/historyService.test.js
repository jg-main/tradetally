'use strict';

jest.mock('../../../src/config/database', () => ({
  query: jest.fn(),
  connect: jest.fn()
}));

jest.mock('../../../src/services/quality/evaluationService', () => {
  const actual = jest.requireActual('../../../src/services/quality/evaluationService');
  return { ...actual, createEvaluation: jest.fn() };
});

jest.mock('../../../src/services/quality/profileService', () => {
  const actual = jest.requireActual('../../../src/services/quality/profileService');
  return { ...actual, findVersionById: jest.fn() };
});

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');
const profileService = require('../../../src/services/quality/profileService');
const historyService = require('../../../src/services/quality/historyService');

const USER = 'user-1';
const TRADE = 'trade-1';
const VERSION = 'version-3';

function enrichedRow(overrides = {}) {
  return {
    id: 'eval-1',
    user_id: USER,
    trade_id: TRADE,
    profile_version_id: VERSION,
    status: 'draft',
    profile_id: 'profile-1',
    profile_name: 'Canonical BO',
    version_number: 3,
    is_current_version: true,
    is_primary: false,
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('historyService.listEvaluationsForTrade', () => {
  test('scopes by user+trade and uses the deterministic history order', async () => {
    db.query.mockResolvedValue({ rows: [enrichedRow()] });

    const rows = await historyService.listEvaluationsForTrade(USER, TRADE);

    expect(rows).toHaveLength(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/WHERE e\.user_id = \$1 AND e\.trade_id = \$2/);
    expect(sql).toMatch(/e\.evaluated_at DESC NULLS LAST, e\.created_at DESC, e\.id DESC/);
    expect(sql).toMatch(/LEFT JOIN trade_quality_primary_evaluations pe/);
    expect(params).toEqual([USER, TRADE]);
  });
});

describe('historyService.startEvaluation', () => {
  test('requires an explicit profileVersionId', async () => {
    await expect(historyService.startEvaluation(USER, TRADE, null)).rejects.toMatchObject({
      code: 'PROFILE_VERSION_REQUIRED'
    });
  });

  test('rejects a trade that is not owned by the user', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }); // assertTradeOwned

    await expect(historyService.startEvaluation(USER, TRADE, VERSION)).rejects.toMatchObject({
      code: 'TRADE_NOT_FOUND'
    });
    expect(profileService.findVersionById).not.toHaveBeenCalled();
  });

  test('rejects an unauthorized profile version', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ found: 1 }] }); // assertTradeOwned
    profileService.findVersionById.mockResolvedValue(null);

    await expect(historyService.startEvaluation(USER, TRADE, VERSION)).rejects.toMatchObject({
      code: 'VERSION_NOT_FOUND'
    });
    expect(evaluationService.createEvaluation).not.toHaveBeenCalled();
  });

  test('always creates a NEW evaluation and never resumes an existing open draft', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ found: 1 }] }) // assertTradeOwned
      .mockResolvedValueOnce({ rows: [enrichedRow({ id: 'eval-new' })] }); // findEnrichedEvaluation
    profileService.findVersionById.mockResolvedValue({
      id: VERSION,
      profile_id: 'profile-1',
      version_number: 3,
      configuration: { dimensions: {} }
    });
    evaluationService.createEvaluation.mockResolvedValue({ id: 'eval-new' });

    const row = await historyService.startEvaluation(USER, TRADE, VERSION);

    expect(evaluationService.createEvaluation).toHaveBeenCalledWith(USER, TRADE, VERSION);
    // No "find an existing draft" lookup is issued: only the ownership check
    // and the enriched read after creation.
    expect(db.query.mock.calls).toHaveLength(2);
    expect(
      db.query.mock.calls.some(([sql]) => String(sql).includes('status NOT IN'))
    ).toBe(false);
    expect(row.id).toBe('eval-new');
  });

  test('issues a fresh INSERT on every explicit re-evaluation call', async () => {
    db.query.mockResolvedValue({ rows: [enrichedRow()] });
    profileService.findVersionById.mockResolvedValue({
      id: VERSION,
      profile_id: 'profile-1',
      version_number: 3,
      configuration: { dimensions: {} }
    });
    evaluationService.createEvaluation
      .mockResolvedValueOnce({ id: 'eval-d2' })
      .mockResolvedValueOnce({ id: 'eval-d3' });

    await historyService.startEvaluation(USER, TRADE, VERSION);
    await historyService.startEvaluation(USER, TRADE, VERSION);

    expect(evaluationService.createEvaluation).toHaveBeenCalledTimes(2);
    expect(evaluationService.createEvaluation).toHaveBeenNthCalledWith(1, USER, TRADE, VERSION);
    expect(evaluationService.createEvaluation).toHaveBeenNthCalledWith(2, USER, TRADE, VERSION);
  });
});

describe('historyService.selectPrimary', () => {
  function makeClient() {
    return { query: jest.fn(), release: jest.fn() };
  }

  test('rejects a non-terminal evaluation', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ found: 1 }] }) // trade owned
      .mockResolvedValueOnce({ rows: [{ id: 'eval-1', status: 'draft' }] }); // evaluation

    await expect(historyService.selectPrimary(USER, TRADE, 'eval-1')).rejects.toMatchObject({
      code: 'EVALUATION_NOT_TERMINAL'
    });
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('INSERT INTO trade_quality_primary_evaluations'))).toBe(false);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('ROLLBACK'))).toBe(true);
  });

  test('rejects an evaluation from another trade/user (not found for this trade)', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ found: 1 }] }) // trade owned
      .mockResolvedValueOnce({ rows: [] }); // evaluation not found

    await expect(historyService.selectPrimary(USER, TRADE, 'eval-foreign')).rejects.toMatchObject({
      code: 'EVALUATION_NOT_FOUND'
    });
  });

  test('upserts a terminal evaluation with a single-primary invariant and commits', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({ rows: [] }) // BEGIN
      .mockResolvedValueOnce({ rows: [{ found: 1 }] }) // trade owned
      .mockResolvedValueOnce({ rows: [{ id: 'eval-1', status: 'completed' }] }) // evaluation FOR UPDATE
      .mockResolvedValueOnce({
        rows: [{ trade_id: TRADE, user_id: USER, evaluation_id: 'eval-1', selected_at: 'now' }]
      }); // upsert

    const primary = await historyService.selectPrimary(USER, TRADE, 'eval-1');

    expect(primary.evaluation_id).toBe('eval-1');
    const upsert = client.query.mock.calls.find(([sql]) =>
      String(sql).includes('INSERT INTO trade_quality_primary_evaluations')
    );
    expect(upsert[0]).toMatch(/ON CONFLICT \(trade_id\) DO UPDATE/);
    expect(upsert[1]).toEqual([TRADE, USER, 'eval-1']);
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('COMMIT'))).toBe(true);
  });

  test('re-selecting the same primary is an idempotent upsert', async () => {
    const client = makeClient();
    db.connect.mockResolvedValue(client);
    client.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ found: 1 }] })
      .mockResolvedValueOnce({ rows: [{ id: 'eval-1', status: 'insufficient_data' }] })
      .mockResolvedValueOnce({
        rows: [{ trade_id: TRADE, user_id: USER, evaluation_id: 'eval-1', selected_at: 'later' }]
      });

    const primary = await historyService.selectPrimary(USER, TRADE, 'eval-1');
    expect(primary.evaluation_id).toBe('eval-1');
  });
});

describe('historyService.clearPrimary', () => {
  test('deletes the primary only for an owned trade and is idempotent', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [{ found: 1 }] }) // assertTradeOwned
      .mockResolvedValueOnce({ rows: [{ trade_id: TRADE, evaluation_id: 'eval-1' }] });

    const cleared = await historyService.clearPrimary(USER, TRADE);
    expect(cleared.evaluation_id).toBe('eval-1');

    db.query.mockReset();
    db.query
      .mockResolvedValueOnce({ rows: [{ found: 1 }] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(historyService.clearPrimary(USER, TRADE)).resolves.toBeNull();
  });
});
