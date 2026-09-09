'use strict';

jest.mock('../../../src/config/database', () => ({
  query: jest.fn()
}));

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');
const { aggregateDimension } = require('../../../src/services/quality/aggregation');
const { getCanonicalBOConfig } = require('../../../src/services/quality/canonicalBO');

function canonicalAllPassFixture() {
  const config = getCanonicalBOConfig();
  const results = {};
  for (const [dimension, dimConfig] of Object.entries(config.dimensions)) {
    const criterionResults = dimConfig.criteria.map((criterion) => ({
      key: criterion.key,
      status: 'PASS',
      score: 100
    }));
    results[dimension] = aggregateDimension(dimConfig, criterionResults);
  }
  return { config, results };
}

describe('summariesFromResults', () => {
  it('mirrors dimension results into flat summary columns', () => {
    const results = {
      setup: { score: 91, grade: 'A', compliance: 'FAIL', coverage: 100 },
      entry: { score: null, grade: null, compliance: 'INCOMPLETE', coverage: 40 },
      management: { score: 87, grade: 'B', compliance: 'PASS', coverage: 100 }
    };
    const summaries = evaluationService.summariesFromResults(results);
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
    const EVAL_ROW = {
      id: 'eval-1',
      user_id: 'user-1',
      trade_id: 'trade-1',
      profile_version_id: 'version-1',
      status: 'draft'
    };

    it('creates a draft evaluation and atomically enforces trade + profile-version ownership', async () => {
      db.query.mockResolvedValue({ rows: [EVAL_ROW] });

      const created = await evaluationService.createEvaluation('user-1', 'trade-1', 'version-1', {
        userInputs: { leader: true },
        detectedContext: { pivot: 70.5 }
      });

      expect(created.status).toBe('draft');
      const [sql, params] = db.query.mock.calls[0];
      expect(String(sql)).toMatch(/INSERT INTO trade_quality_evaluations/);
      expect(String(sql)).toMatch(/SELECT \$1, t\.id, v\.id, 'draft'/);
      expect(String(sql)).toMatch(/t\.user_id = \$1/);
      expect(String(sql)).toMatch(/p\.user_id = \$1/);
      expect(params).toEqual(['user-1', 'trade-1', 'version-1', { leader: true }, { pivot: 70.5 }, null]);
    });

    it('rejects attempts to create a terminal evaluation directly', async () => {
      for (const status of ['completed', 'insufficient_data', 'error', 'needs_input']) {
        await expect(
          evaluationService.createEvaluation('user-1', 'trade-1', 'version-1', { status })
        ).rejects.toThrow(/must be created as draft/);
      }
      expect(db.query).not.toHaveBeenCalled();
    });

    it('rejects when the trade or profile version is not owned by the user', async () => {
      db.query.mockResolvedValue({ rows: [] });
      await expect(
        evaluationService.createEvaluation('user-1', 'trade-other', 'version-1')
      ).rejects.toThrow(/not found for this user/);
    });
  });

  describe('saveResult', () => {
    const { config, results } = canonicalAllPassFixture();

    function mockLookupAndUpdate(updatedRow) {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'eval-1', status: 'draft', configuration: config }]
      });
      db.query.mockResolvedValueOnce({ rows: [updatedRow] });
    }

    it('persists a validated completed result and derives summary columns from the recomputed aggregate', async () => {
      mockLookupAndUpdate({ id: 'eval-1', status: 'completed', setup_score: '100.00', setup_grade: 'A' });

      const saved = await evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results,
        evidenceSnapshot: { candles: [] }
      });

      expect(saved.status).toBe('completed');
      const [sql, params] = db.query.mock.calls[1];
      expect(String(sql)).toMatch(/UPDATE trade_quality_evaluations/);
      expect(String(sql)).toMatch(/status <> 'completed'/);
      expect(params[0]).toBe('eval-1');
      expect(params[1]).toBe('user-1');
      expect(params[2]).toBe('completed');
      expect(params[3]).toBe(results);
      expect(params[7]).toBe(100); // setup_score
      expect(params[8]).toBe('A'); // setup_grade
      expect(params[9]).toBe('PASS'); // setup_compliance
      expect(params[10]).toBe(100); // setup_coverage
    });

    it('rejects contradictory completed results that disagree with the profile version aggregation', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'eval-1', status: 'draft', configuration: config }]
      });

      const contradictory = {
        ...results,
        setup: { ...results.setup, score: 99 }
      };
      await expect(evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results: contradictory
      })).rejects.toThrow(/contradict the profile version configuration/);

      // Only the lookup ran; no UPDATE was attempted.
      expect(db.query.mock.calls).toHaveLength(1);
    });

    it('rejects completed results that do not cover exactly the configured dimensions', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'eval-1', status: 'draft', configuration: config }]
      });

      await expect(evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results: { setup: results.setup }
      })).rejects.toThrow(/exactly the configured dimensions/);
    });

    it('rejects completed results whose criterion states would not reproduce the supplied aggregate', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'eval-1', status: 'draft', configuration: config }]
      });

      const emptyCriterionResults = {
        ...results,
        setup: { ...results.setup, criterionResults: [] }
      };
      await expect(evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results: emptyCriterionResults
      })).rejects.toThrow(/contradict the profile version configuration/);
    });

    it('persists insufficient_data with no completed dimension results', async () => {
      mockLookupAndUpdate({ id: 'eval-1', status: 'insufficient_data' });

      const saved = await evaluationService.saveResult('eval-1', 'user-1', {
        status: 'insufficient_data',
        evidenceSnapshot: { reason: 'no intraday data' }
      });

      expect(saved.status).toBe('insufficient_data');
      const [sql, params] = db.query.mock.calls[1];
      expect(String(sql)).toMatch(/UPDATE trade_quality_evaluations/);
      expect(params[2]).toBe('insufficient_data');
      expect(params[3]).toBeNull(); // results
      expect(params[7]).toBeNull(); // setup_score
    });

    it('rejects insufficient_data carrying completed results', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'eval-1', status: 'draft', configuration: config }]
      });

      await expect(evaluationService.saveResult('eval-1', 'user-1', {
        status: 'insufficient_data',
        results: { setup: results.setup }
      })).rejects.toThrow(/cannot carry completed dimension results/);
    });

    it('rejects non-terminal statuses', async () => {
      await expect(evaluationService.saveResult('eval-1', 'user-1', { status: 'draft' }))
        .rejects.toThrow(/only accepts terminal statuses/);
      await expect(evaluationService.saveResult('eval-1', 'user-1', { status: 'error' }))
        .rejects.toThrow(/only accepts terminal statuses/);
      expect(db.query).not.toHaveBeenCalled();
    });

    it('returns null when the evaluation is missing, owned by another user, or already completed', async () => {
      db.query.mockResolvedValue({ rows: [] });

      const saved = await evaluationService.saveResult('eval-1', 'user-other', {
        status: 'completed',
        results
      });
      expect(saved).toBeNull();
      expect(db.query.mock.calls).toHaveLength(1);
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
