'use strict';

jest.mock('../../../src/config/database', () => ({
  query: jest.fn()
}));

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');
const { aggregateDimension } = require('../../../src/services/quality/aggregation');
const { getCanonicalBOConfig } = require('../../../src/services/quality/canonicalBO');

// Builds a scoring_value input that drives the configured envelope to its
// maximum score (100 for every canonical criterion).
function maxInputForScoring(scoring) {
  if (!scoring) {
    return null;
  }
  switch (scoring.type) {
    case 'binary':
      return undefined;
    case 'step': {
      const index = scoring.mode === 'gte' ? scoring.thresholds.length - 1 : 0;
      return scoring.thresholds[index].value;
    }
    case 'piecewise_linear': {
      let best = scoring.points[0];
      for (const point of scoring.points) {
        if (point.score > best.score) {
          best = point;
        }
      }
      return best.value;
    }
    case 'discrete': {
      let bestKey = Object.keys(scoring.scores)[0];
      for (const [key, score] of Object.entries(scoring.scores)) {
        if (score > scoring.scores[bestKey]) {
          bestKey = key;
        }
      }
      return bestKey;
    }
    case 'composite': {
      const map = {};
      for (const component of scoring.components) {
        map[component.key] = component.scoring.type === 'binary'
          ? true
          : maxInputForScoring(component.scoring);
      }
      return map;
    }
    default:
      return null;
  }
}

function canonicalAllPassFixture() {
  const config = getCanonicalBOConfig();
  const results = {};
  for (const [dimension, dimConfig] of Object.entries(config.dimensions)) {
    const criterionResults = dimConfig.criteria
      .filter((criterion) => criterion.enabled !== false)
      .map((criterion) => ({
        key: criterion.key,
        status: 'PASS',
        score: 100,
        scoring_value: maxInputForScoring(criterion.scoring) ?? null
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
    db.query.mockReset();
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

  describe('saveResult — completed', () => {
    const { config, results } = canonicalAllPassFixture();

    function mockLookupAndUpdate(updatedRow) {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'eval-1', status: 'draft', configuration: config }]
      });
      db.query.mockResolvedValueOnce({ rows: [updatedRow] });
    }

    it('persists a validated completed result normalized from the profile configuration', async () => {
      mockLookupAndUpdate({ id: 'eval-1', status: 'completed', setup_score: '100.00', setup_grade: 'A' });

      const saved = await evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results,
        evidenceSnapshot: { candles: [] }
      });

      expect(saved.status).toBe('completed');
      const [sql, params] = db.query.mock.calls[1];
      expect(String(sql)).toMatch(/UPDATE trade_quality_evaluations/);
      expect(String(sql)).toMatch(/status NOT IN \('completed', 'insufficient_data'\)/);
      expect(params[0]).toBe('eval-1');
      expect(params[1]).toBe('user-1');
      expect(params[2]).toBe('completed');
      expect(params[7]).toBe(100); // setup_score
      expect(params[8]).toBe('A'); // setup_grade
      expect(params[9]).toBe('PASS'); // setup_compliance
      expect(params[10]).toBe(100); // setup_coverage

      // The persisted results JSON is the normalized aggregate.
      const persisted = params[3];
      expect(persisted.setup.criterionResults[0].score).toBe(100);
      expect(persisted.setup.criterionResults[0]).toHaveProperty('scoringValue');
      expect(persisted.setup.criterionResults[0].evidenceMissing).toBe(false);
      expect(persisted.setup.criterionResults[0].rawValue).toBeNull();
    });

    it('rejects a criterion score that contradicts its profile scoring curve', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'eval-1', status: 'draft', configuration: config }]
      });

      const resultsClone = structuredClone(results);
      // Canonical prior_move: scoring_value 35 (%) maps to 60, not 100.
      const row = resultsClone.setup.criterionResults.find((entry) => entry.key === 'prior_move');
      row.scoring_value = 35;
      row.score = 100;

      await expect(evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results: resultsClone
      })).rejects.toThrow(/score contradicts its profile scoring configuration/);
      expect(db.query.mock.calls).toHaveLength(1);
    });

    it('rejects a known-status criterion without the scoring input its envelope requires', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'eval-1', status: 'draft', configuration: config }]
      });

      const resultsClone = structuredClone(results);
      const row = resultsClone.setup.criterionResults.find((entry) => entry.key === 'prior_move');
      row.scoring_value = null; // step scoring requires a finite number

      await expect(evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results: resultsClone
      })).rejects.toThrow(/finite numeric scoring_value/);
    });

    it('rejects an unconfigured/extra criterion result key', async () => {
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'eval-1', status: 'draft', configuration: config }]
      });

      const resultsClone = structuredClone(results);
      resultsClone.setup.criterionResults.push({
        key: 'not_a_criterion', status: 'PASS', score: 100, scoring_value: null
      });

      await expect(evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results: resultsClone
      })).rejects.toThrow(/not an enabled criterion of dimension "setup"/);
      expect(db.query.mock.calls).toHaveLength(1);
    });

    it('normalizes omitted configured criteria to UNKNOWN and persists only configured rows', async () => {
      mockLookupAndUpdate({ id: 'eval-1', status: 'completed' });

      // Keep only criterionResults (no summary fields) and omit ma_trend.
      const rawResults = {};
      for (const [dimension, dimResult] of Object.entries(results)) {
        rawResults[dimension] = {
          criterionResults: dimResult.criterionResults.filter((entry) => entry.key !== 'ma_trend')
        };
      }

      const saved = await evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results: rawResults
      });
      expect(saved.status).toBe('completed');

      const persisted = db.query.mock.calls[1][1][3];
      const setupRows = persisted.setup.criterionResults;
      expect(setupRows.length).toBe(8); // only configured setup criteria
      const maTrend = setupRows.find((entry) => entry.key === 'ma_trend');
      expect(maTrend.status).toBe('UNKNOWN');
      expect(maTrend.evidenceMissing).toBe(true);
      const leader = setupRows.find((entry) => entry.key === 'leader');
      expect(leader.status).toBe('PASS');
      expect(leader.scoringValue).toBeNull(); // binary pass-through
    });

    it('rejects contradictory aggregate summaries', async () => {
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
      })).rejects.toThrow(/score contradicts the profile version configuration/);
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

    it('rejects non-terminal statuses', async () => {
      await expect(evaluationService.saveResult('eval-1', 'user-1', { status: 'draft' }))
        .rejects.toThrow(/only accepts terminal statuses/);
      await expect(evaluationService.saveResult('eval-1', 'user-1', { status: 'error' }))
        .rejects.toThrow(/only accepts terminal statuses/);
      expect(db.query).not.toHaveBeenCalled();
    });

    it('returns null when the evaluation is missing, owned by another user, or already terminal', async () => {
      db.query.mockResolvedValue({ rows: [] });

      const saved = await evaluationService.saveResult('eval-1', 'user-other', {
        status: 'completed',
        results
      });
      expect(saved).toBeNull();
      expect(db.query.mock.calls).toHaveLength(1);
    });
  });

  describe('saveResult — insufficient_data terminal immutability', () => {
    const { config, results } = canonicalAllPassFixture();

    it('allows draft -> insufficient_data, then rejects any rewrite or upgrade on the same evaluation', async () => {
      // First call: draft -> insufficient_data.
      db.query.mockResolvedValueOnce({
        rows: [{ id: 'eval-1', status: 'draft', configuration: config }]
      });
      db.query.mockResolvedValueOnce({ rows: [{ id: 'eval-1', status: 'insufficient_data' }] });

      const insuff = await evaluationService.saveResult('eval-1', 'user-1', {
        status: 'insufficient_data',
        evidenceSnapshot: { reason: 'no intraday data' }
      });
      expect(insuff.status).toBe('insufficient_data');
      expect(db.query.mock.calls[1][1][3]).toBeNull(); // results
      expect(db.query.mock.calls[1][1][7]).toBeNull(); // setup_score

      // Second call: attempt to upgrade insufficient_data -> completed.
      db.query.mockResolvedValueOnce({ rows: [] });
      const upgrade = await evaluationService.saveResult('eval-1', 'user-1', {
        status: 'completed',
        results
      });
      expect(upgrade).toBeNull();

      // Third call: attempt to overwrite insufficient_data with insufficient_data.
      db.query.mockResolvedValueOnce({ rows: [] });
      const overwrite = await evaluationService.saveResult('eval-1', 'user-1', {
        status: 'insufficient_data'
      });
      expect(overwrite).toBeNull();
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

    it('lets a later attempt create a NEW evaluation row after a terminal status', async () => {
      db.query.mockResolvedValueOnce({ rows: [{ id: 'eval-2', status: 'draft' }] });
      const draft = await evaluationService.createEvaluation('user-1', 'trade-1', 'version-1');
      expect(draft.id).toBe('eval-2');
      expect(draft.status).toBe('draft');
      expect(String(db.query.mock.calls[0][0])).toMatch(/INSERT INTO trade_quality_evaluations/);
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
