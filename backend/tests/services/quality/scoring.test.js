'use strict';

const { CRITERION_STATUS } = require('../../../src/services/quality/constants');
const {
  deriveScoreForCriterion,
  evaluateStep,
  evaluatePiecewiseLinear,
  evaluateDiscrete,
  evaluateComposite
} = require('../../../src/services/quality/scoring');

describe('deriveScoreForCriterion', () => {
  it('derives binary scores from PASS/FAIL', () => {
    const scoring = { type: 'binary', pass_score: 100, fail_score: 0 };
    expect(deriveScoreForCriterion({ status: CRITERION_STATUS.PASS, scoring }).score).toBe(100);
    expect(deriveScoreForCriterion({ status: CRITERION_STATUS.FAIL, scoring }).score).toBe(0);
  });

  it('returns no numeric score for UNKNOWN / NOT_APPLICABLE', () => {
    const scoring = { type: 'binary', pass_score: 100, fail_score: 0 };
    expect(deriveScoreForCriterion({ status: CRITERION_STATUS.UNKNOWN, scoring }).score).toBeNull();
    expect(deriveScoreForCriterion({ status: CRITERION_STATUS.NOT_APPLICABLE, scoring }).score).toBeNull();
  });

  it('rejects a criterion without scoring configuration', () => {
    const { error } = deriveScoreForCriterion({ status: CRITERION_STATUS.PASS, scoring: null });
    expect(error).toMatch(/no scoring configuration/);
  });

  describe('step', () => {
    const gte = {
      type: 'step',
      mode: 'gte',
      default_score: 0,
      thresholds: [
        { value: 20, score: 40 },
        { value: 30, score: 60 },
        { value: 40, score: 80 },
        { value: 60, score: 90 },
        { value: 100, score: 100 }
      ]
    };
    const lte = {
      type: 'step',
      mode: 'lte',
      default_score: 0,
      thresholds: [
        { value: 0.4, score: 100 },
        { value: 0.55, score: 90 },
        { value: 0.7, score: 75 },
        { value: 0.85, score: 50 },
        { value: 1.0, score: 25 }
      ]
    };

    it('matches gte thresholds from the largest reached threshold (prior_move example)', () => {
      const derive = (scoringValue) =>
        deriveScoreForCriterion({ status: CRITERION_STATUS.PASS, scoring: gte, scoringValue }).score;
      expect(derive(10)).toBe(0); // < 20 -> default 0
      expect(derive(25)).toBe(40); // 20-<30
      expect(derive(35)).toBe(60); // 30-<40 (audit example)
      expect(derive(45)).toBe(80);
      expect(derive(85)).toBe(90);
      expect(derive(120)).toBe(100);
    });

    it('matches lte thresholds from the smallest not-exceeded threshold (contraction example)', () => {
      const derive = (scoringValue) =>
        deriveScoreForCriterion({ status: CRITERION_STATUS.PASS, scoring: lte, scoringValue }).score;
      expect(derive(0.3)).toBe(100);
      expect(derive(0.5)).toBe(90);
      expect(derive(0.8)).toBe(50);
      expect(derive(1.1)).toBe(0); // > 1.0 -> default 0
    });

    it('requires a finite numeric scoring_value', () => {
      const { error } = deriveScoreForCriterion({ status: CRITERION_STATUS.PASS, scoring: gte });
      expect(error).toMatch(/finite numeric scoring_value/);
    });
  });

  describe('piecewise_linear', () => {
    it('interpolates between points and clamps outside the range', () => {
      const scoring = {
        type: 'piecewise_linear',
        points: [
          { value: 0, score: 0 },
          { value: 1, score: 100 }
        ]
      };
      const derive = (v) =>
        deriveScoreForCriterion({ status: CRITERION_STATUS.PASS, scoring, scoringValue: v }).score;
      expect(derive(0)).toBe(0);
      expect(derive(0.5)).toBe(50);
      expect(derive(1)).toBe(100);
      expect(derive(-1)).toBe(0); // clamped below
      expect(derive(2)).toBe(100); // clamped above
    });

    it('supports descending segments (pivot proximity example)', () => {
      const scoring = {
        type: 'piecewise_linear',
        points: [
          { value: 2, score: 100 },
          { value: 5, score: 70 },
          { value: 10, score: 0 }
        ]
      };
      const derive = (v) =>
        deriveScoreForCriterion({ status: CRITERION_STATUS.PASS, scoring, scoringValue: v }).score;
      expect(derive(1)).toBe(100); // <= 2% -> 100
      expect(derive(3.5)).toBe(85); // linear 100 -> 70 over 2-5%
      expect(derive(7.5)).toBe(35); // linear 70 -> 0 over 5-10%
      expect(derive(12)).toBe(0); // > 10% -> 0
    });
  });

  describe('discrete', () => {
    const scoring = {
      type: 'discrete',
      scores: { same_trigger_session: 100, next_session: 50, later_or_not_completed: 0 }
    };

    it('scores from a configured outcome key', () => {
      expect(deriveScoreForCriterion({
        status: CRITERION_STATUS.PASS,
        scoring,
        scoringValue: 'same_trigger_session'
      }).score).toBe(100);
      expect(deriveScoreForCriterion({
        status: CRITERION_STATUS.FAIL,
        scoring,
        scoringValue: 'later_or_not_completed'
      }).score).toBe(0);
    });

    it('rejects an outcome key that is not configured', () => {
      const { error } = deriveScoreForCriterion({
        status: CRITERION_STATUS.PASS,
        scoring,
        scoringValue: 'sometimes'
      });
      expect(error).toMatch(/no configured outcome "sometimes"/);
    });
  });

  describe('composite', () => {
    const scoring = {
      type: 'composite',
      components: [
        { key: 'touches', weight: 30, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } },
        { key: 'proximity', weight: 70, scoring: { type: 'piecewise_linear', points: [{ value: 0, score: 0 }, { value: 1, score: 100 }] } }
      ]
    };

    it('computes the weighted mean from component inputs', () => {
      const result = deriveScoreForCriterion({
        status: CRITERION_STATUS.PASS,
        scoring,
        scoringValue: { touches: true, proximity: 1 }
      });
      expect(result.score).toBe(100);
    });

    it('requires all component inputs', () => {
      const { error } = deriveScoreForCriterion({
        status: CRITERION_STATUS.PASS,
        scoring,
        scoringValue: { touches: true }
      });
      expect(error).toMatch(/missing component input "proximity"/);
    });

    it('rejects component weights with no positive usable total', () => {
      const zeroWeight = {
        type: 'composite',
        components: [{ key: 'a', weight: 0, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } }]
      };
      const { error } = deriveScoreForCriterion({
        status: CRITERION_STATUS.PASS,
        scoring: zeroWeight,
        scoringValue: { a: true }
      });
      expect(error).toMatch(/positive usable total/);
    });
  });
});

describe('evaluation helpers', () => {
  it('evaluateStep honors gte/lte defaults', () => {
    const gte = { mode: 'gte', default_score: 5, thresholds: [{ value: 10, score: 100 }] };
    expect(evaluateStep(gte, 9).score).toBe(5);
    expect(evaluateStep(gte, 10).score).toBe(100);
    const lte = { mode: 'lte', default_score: 5, thresholds: [{ value: 10, score: 100 }] };
    expect(evaluateStep(lte, 10).score).toBe(100);
    expect(evaluateStep(lte, 11).score).toBe(5);
  });

  it('evaluatePiecewiseLinear/evaluateDiscrete/evaluateComposite validate input types', () => {
    expect(evaluatePiecewiseLinear({ points: [{ value: 0, score: 0 }, { value: 1, score: 100 }] }, 'x').error).toMatch(/finite numeric/);
    expect(evaluateDiscrete({ scores: { a: 100 } }, 1).error).toMatch(/requires a string/);
    expect(evaluateComposite({ components: [] }, {}) .error).toMatch(/positive usable total|components/);
  });
});
