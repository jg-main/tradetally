'use strict';

jest.mock('../../../src/config/database', () => ({
  query: jest.fn()
}));

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');

const RESULTS = {
  setup: { score: 91, grade: 'A', compliance: 'FAIL', coverage: 100 },
  entry: { score: null, grade: null, compliance: 'INCOMPLETE', coverage: 40 },
  management: { score: 87, grade: 'B', compliance: 'PASS', coverage: 100 }
};

describe('summariesFromResults', () => {
  it('mirrors dimension results into flat summary columns', () => {
    const summaries = evaluationService.summariesFromResults(RESULTS);
    expect(summaries.setup_score).toBe(91);
    expect(summaries.setup_grade).toBe('A');
    expect(summaries.setup_compliance).toBe('FAIL');
    expect(summaries.setup_coverage).toBe(100);
    expect(summaries.entry_score).toBeNull();
    expect(summaries.entry_grade).toBeNull();
    expect(summaries.entry_compliance).toBe('INCOMPLETE');
    expect(summaries.entry_coverage).toBe(40);
    expect(summaries.management_score).toBe(87);
  });

  it('returns null summaries when results are absent', () => {
    const summaries = evaluationService.summariesFromResults(null);
    expect(summaries.setup_score).toBeNull();
    expect(summaries.management_compliance).toBeNull();
  });
});

describe('evaluationService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createEvaluation', () => {
    it('creates a draft evaluation linked to the trade and profile version', async () => {
      db.query.mockResolvedValue({
        rows: [{ id: 'eval-1', user_id: 'user-1', trade_id: 'trade-1', status: 'draft' }]
      });

      const created = await evaluationService.createEvaluation('user-1', 'trade-1', 'version-1', {
        userInputs: { leader: true },
        detectedContext: { pivot: 70.5 }
      });

      expect(created.id).toBe('eval-1');
      const [sql, params] = db.query.mock.calls[0];
      expect(String(sql)).toMatch(/INSERT INTO trade_quality_evaluations/);
      expect(params.slice(0, 4)).toEqual(['user-1', 'trade-1', 'version-1', 'draft']);
      expect(params[4]).toEqual({ leader: true });
      expect(params[5]).toEqual({ pivot: 70.5 });
    });

    it('defaults status to draft and rejects invalid statuses', async () => {
      db.query.mockResolvedValue({ rows: [{ id: 'eval-1', status: 'draft' }] });
      const created = await evaluationService.createEvaluation('user-1', 'trade-1', 'version-1');
      expect(created.status).toBe('draft');
      expect(db.query.mock.calls[0][1][3]).toBe('draft');

      await expect(
        evaluationService.createEvaluation('user-1', 'trade-1', 'version-1', { status: 'nope' })
      ).rejects.toThrow(/Invalid evaluation status/);
    });
  });

  describe('saveResult', () => {
    it('persists a completed result with summary mirror columns and evaluated_at', async () => {
      db.query.mockResolvedValue({
        rows: [{ id: 'eval-1', status: 'completed', setup_score: '91.00' }]
      });

      const saved = await evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results: RESULTS,
        evidenceSnapshot: { candles: [] }
      });

      expect(saved.status).toBe('completed');
      const [sql, params] = db.query.mock.calls[0];
      expect(String(sql)).toMatch(/UPDATE trade_quality_evaluations/);
      expect(String(sql)).toMatch(/status <> 'completed'/);
      expect(params[0]).toBe('eval-1');
      expect(params[1]).toBe('user-1');
      expect(params[2]).toBe('completed');
      expect(params[3]).toBe(RESULTS);
      expect(params[7]).toBe(91); // setup_score
      expect(params[8]).toBe('A'); // setup_grade
      expect(params[9]).toBe('FAIL'); // setup_compliance
      expect(params[10]).toBe(100); // setup_coverage
    });

    it('accepts insufficient_data as a terminal status', async () => {
      db.query.mockResolvedValue({ rows: [{ id: 'eval-1', status: 'insufficient_data' }] });
      const saved = await evaluationService.saveResult('eval-1', 'user-1', {
        status: 'insufficient_data',
        results: null
      });
      expect(saved.status).toBe('insufficient_data');
    });

    it('rejects non-terminal statuses and malformed summary enums', async () => {
      await expect(
        evaluationService.saveResult('eval-1', 'user-1', { status: 'draft', results: RESULTS })
      ).rejects.toThrow(/only accepts terminal statuses/);

      await expect(
        evaluationService.saveResult('eval-1', 'user-1', {
          status: 'completed',
          results: { setup: { grade: 'Z' } }
        })
      ).rejects.toThrow(/Invalid setup grade/);

      await expect(
        evaluationService.saveResult('eval-1', 'user-1', {
          status: 'completed',
          results: { setup: { compliance: 'UNKNOWN' } }
        })
      ).rejects.toThrow(/Invalid setup compliance/);
    });

    it('returns null when no row matches (not found or already completed)', async () => {
      db.query.mockResolvedValue({ rows: [] });
      const saved = await evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results: RESULTS
      });
      expect(saved).toBeNull();
    });
  });

  describe('reads', () => {
    it('fetches a single evaluation scoped to the user', async () => {
      db.query.mockResolvedValue({ rows: [{ id: 'eval-1' }] });
      const evaluation = await evaluationService.getEvaluation('eval-1', 'user-1');
      expect(evaluation).toEqual({ id: 'eval-1' });
      expect(db.query.mock.calls[0][1]).toEqual(['eval-1', 'user-1']);
    });

    it('lists evaluation history for a trade newest first', async () => {
      db.query.mockResolvedValue({ rows: [{ id: 'eval-2' }, { id: 'eval-1' }] });
      const rows = await evaluationService.listEvaluationsForTrade('user-1', 'trade-1');
      expect(rows).toHaveLength(2);
      expect(db.query.mock.calls[0][1]).toEqual(['user-1', 'trade-1']);
    });
  });
});
