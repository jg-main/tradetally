'use strict';

// Phase 6 — the legacy "Calculate Setup Quality" path must keep writing ONLY
// the legacy trade columns. It must never create/update a Quality Profile
// evaluation, and must never change the Phase-5 primary pointer.
//
// It must ALSO invalidate the canonical analytics cache after persisted legacy
// writes, because a legacy grade change alters the effective qualityGrades
// filter population for trades without a profile primary.

jest.mock('../../src/models/Trade', () => ({
  findById: jest.fn()
}));
jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/imageProcessor', () => ({}));
jest.mock('../../src/services/tierService', () => ({}));
jest.mock('../../src/services/tradeQuality.service', () => ({
  calculateQuality: jest.fn(),
  calculateBatchQuality: jest.fn()
}));
jest.mock('../../src/services/analyticsCache', () => ({
  invalidate: jest.fn()
}));

const db = require('../../src/config/database');
const Trade = require('../../src/models/Trade');
const tradeQualityService = require('../../src/services/tradeQuality.service');
const AnalyticsCache = require('../../src/services/analyticsCache');
const tradeController = require('../../src/controllers/trade.controller');

function createRes() {
  return {
    statusCode: 200,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.payload = body; return this; }
  };
}

function profileWriteAttempted(sql) {
  return /trade_quality_evaluations|trade_quality_primary_evaluations|quality_profile_versions|quality_profiles/i.test(sql);
}

function ownedTrade() {
  return {
    id: 'trade-1',
    user_id: 'user-1',
    symbol: 'AAPL',
    entry_time: '2026-03-10T14:30:00Z',
    entry_price: 100,
    side: 'long',
    instrument_type: 'stock'
  };
}

describe('legacy Calculate Setup Quality compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('graded calculation updates only legacy columns and never profile tables', async () => {
    Trade.findById.mockResolvedValue(ownedTrade());
    tradeQualityService.calculateQuality.mockResolvedValue({
      grade: 'A',
      score: 4.5,
      metrics: { float: 1, coverage: 0.95 }
    });
    db.query.mockResolvedValue({ rows: [{ id: 'trade-1', quality_grade: 'A', quality_score: '4.5' }] });

    const next = jest.fn();
    const res = createRes();
    await tradeController.calculateTradeQuality(
      { params: { id: 'trade-1' }, user: { id: 'user-1' } },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.payload.success).toBe(true);

    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql, params] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE trades/);
    expect(sql).toMatch(/quality_grade = \$1/);
    expect(sql).toMatch(/quality_score = \$2/);
    expect(sql).toMatch(/quality_metrics = \$3/);
    expect(profileWriteAttempted(sql)).toBe(false);
    expect(params[0]).toBe('A');
    expect(params[1]).toBe(4.5);
    // A. graded persisted write invalidates exactly once.
    expect(AnalyticsCache.invalidate).toHaveBeenCalledTimes(1);
    expect(AnalyticsCache.invalidate).toHaveBeenCalledWith('user-1');
  });

  test('ungraded (metrics-only) calculation still writes only legacy columns', async () => {
    Trade.findById.mockResolvedValue(ownedTrade());
    tradeQualityService.calculateQuality.mockResolvedValue({
      grade: null,
      score: null,
      metrics: { coverage: 0.2 },
      reason: 'insufficient_coverage',
      message: 'Not enough data'
    });
    db.query.mockResolvedValue({ rows: [] });

    const next = jest.fn();
    const res = createRes();
    await tradeController.calculateTradeQuality(
      { params: { id: 'trade-1' }, user: { id: 'user-1' } },
      res,
      next
    );

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE trades/);
    expect(sql).toMatch(/quality_grade = NULL/);
    expect(profileWriteAttempted(sql)).toBe(false);
    // B. metrics-only NULL-grade persisted write invalidates exactly once.
    expect(AnalyticsCache.invalidate).toHaveBeenCalledTimes(1);
    expect(AnalyticsCache.invalidate).toHaveBeenCalledWith('user-1');
  });

  test('calculation with no usable result performs no write and no invalidation', async () => {
    Trade.findById.mockResolvedValue(ownedTrade());
    tradeQualityService.calculateQuality.mockResolvedValue({
      grade: null,
      score: null,
      metrics: null,
      message: 'No market data'
    });

    const next = jest.fn();
    const res = createRes();
    await tradeController.calculateTradeQuality(
      { params: { id: 'trade-1' }, user: { id: 'user-1' } },
      res,
      next
    );

    expect(res.statusCode).toBe(400);
    expect(db.query).not.toHaveBeenCalled();
    // C. no persisted write -> no invalidation.
    expect(AnalyticsCache.invalidate).not.toHaveBeenCalled();
  });

  test('calculation that throws before persistence performs no write and no invalidation', async () => {
    Trade.findById.mockResolvedValue(ownedTrade());
    tradeQualityService.calculateQuality.mockRejectedValue(new Error('provider down'));

    const next = jest.fn();
    const res = createRes();
    await tradeController.calculateTradeQuality(
      { params: { id: 'trade-1' }, user: { id: 'user-1' } },
      res,
      next
    );

    expect(next).toHaveBeenCalledTimes(1);
    expect(db.query).not.toHaveBeenCalled();
    expect(AnalyticsCache.invalidate).not.toHaveBeenCalled();
  });
});

describe('legacy batch Calculate Setup Quality compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  function batchResult(tradeId, overrides = {}) {
    return {
      tradeId,
      quality: { grade: 'A', score: 4.5, metrics: { float: 1 }, ...overrides }
    };
  }

  test('N persisted batch updates invalidate the cache exactly once', async () => {
    const trades = [
      { id: 't1' }, { id: 't2' }, { id: 't3' }
    ];
    db.query
      .mockResolvedValueOnce({ rows: trades }) // trades SELECT
      .mockResolvedValue({ rows: [] }); // UPDATEs
    tradeQualityService.calculateBatchQuality.mockResolvedValue([
      batchResult('t1'), batchResult('t2'), batchResult('t3')
    ]);

    const res = createRes();
    await tradeController.calculateBatchQuality(
      { body: { tradeIds: ['t1', 't2', 't3'] }, user: { id: 'user-1' } },
      res,
      jest.fn()
    );

    expect(res.payload.success).toBe(true);
    // 1 SELECT + 3 UPDATEs.
    expect(db.query).toHaveBeenCalledTimes(4);
    // D. exactly once for the whole batch.
    expect(AnalyticsCache.invalidate).toHaveBeenCalledTimes(1);
    expect(AnalyticsCache.invalidate).toHaveBeenCalledWith('user-1');
  });

  test('zero persisted batch updates do not invalidate', async () => {
    db.query.mockResolvedValueOnce({ rows: [{ id: 't1' }] });
    tradeQualityService.calculateBatchQuality.mockResolvedValue([
      { tradeId: 't1', quality: { grade: null, score: null, metrics: null } }
    ]);

    const res = createRes();
    await tradeController.calculateBatchQuality(
      { body: { tradeIds: ['t1'] }, user: { id: 'user-1' } },
      res,
      jest.fn()
    );

    expect(db.query).toHaveBeenCalledTimes(1);
    // E. no writes -> no invalidation.
    expect(AnalyticsCache.invalidate).not.toHaveBeenCalled();
  });
});

describe('legacy all-trades async quality calculation compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('background worker invalidates once AFTER persisted writes, not when queued', async () => {
    let worker;
    const setImmediateSpy = jest
      .spyOn(global, 'setImmediate')
      .mockImplementation((fn) => { worker = fn; return 1; });

    try {
      db.query
        .mockResolvedValueOnce({ rows: [{ id: 't1' }, { id: 't2' }] }) // trades SELECT
        .mockResolvedValue({ rows: [] }); // UPDATEs
      tradeQualityService.calculateBatchQuality.mockResolvedValue([
        { tradeId: 't1', quality: { grade: 'B', score: 3.5, metrics: { float: 1 } } },
        { tradeId: 't2', quality: { grade: null, score: null, metrics: { coverage: 0.2 } } }
      ]);

      const res = createRes();
      await tradeController.calculateAllTradesQuality(
        { user: { id: 'user-1' } },
        res,
        jest.fn()
      );

      expect(res.payload.success).toBe(true);
      // F. not invalidated merely because the job was queued.
      expect(AnalyticsCache.invalidate).not.toHaveBeenCalled();

      expect(typeof worker).toBe('function');
      await worker();

      expect(db.query).toHaveBeenCalledTimes(3); // 1 SELECT + 2 UPDATEs
      expect(AnalyticsCache.invalidate).toHaveBeenCalledTimes(1);
      expect(AnalyticsCache.invalidate).toHaveBeenCalledWith('user-1');
    } finally {
      setImmediateSpy.mockRestore();
    }
  });

  test('background worker with no persisted writes does not invalidate', async () => {
    let worker;
    const setImmediateSpy = jest
      .spyOn(global, 'setImmediate')
      .mockImplementation((fn) => { worker = fn; return 1; });

    try {
      db.query.mockResolvedValueOnce({ rows: [{ id: 't1' }] });
      tradeQualityService.calculateBatchQuality.mockResolvedValue([
        { tradeId: 't1', quality: { grade: null, score: null, metrics: null } }
      ]);

      const res = createRes();
      await tradeController.calculateAllTradesQuality(
        { user: { id: 'user-1' } },
        res,
        jest.fn()
      );

      await worker();

      // G. no writes -> no invalidation.
      expect(AnalyticsCache.invalidate).not.toHaveBeenCalled();
    } finally {
      setImmediateSpy.mockRestore();
    }
  });
});

