'use strict';

// Phase 6 — the legacy "Calculate Setup Quality" path must keep writing ONLY
// the legacy trade columns. It must never create/update a Quality Profile
// evaluation, and must never change the Phase-5 primary pointer.

jest.mock('../../src/models/Trade', () => ({
  findById: jest.fn()
}));
jest.mock('../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../src/utils/imageProcessor', () => ({}));
jest.mock('../../src/services/tierService', () => ({}));
jest.mock('../../src/services/tradeQuality.service', () => ({
  calculateQuality: jest.fn()
}));

const db = require('../../src/config/database');
const Trade = require('../../src/models/Trade');
const tradeQualityService = require('../../src/services/tradeQuality.service');
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

describe('legacy Calculate Setup Quality compatibility', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('graded calculation updates only legacy columns and never profile tables', async () => {
    Trade.findById.mockResolvedValue({
      id: 'trade-1',
      user_id: 'user-1',
      symbol: 'AAPL',
      entry_time: '2026-03-10T14:30:00Z',
      entry_price: 100,
      side: 'long',
      instrument_type: 'stock'
    });
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
  });

  test('ungraded (metrics-only) calculation still writes only legacy columns', async () => {
    Trade.findById.mockResolvedValue({
      id: 'trade-1',
      user_id: 'user-1',
      symbol: 'AAPL',
      entry_time: '2026-03-10T14:30:00Z',
      entry_price: 100,
      side: 'long',
      instrument_type: 'stock'
    });
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
  });
});
