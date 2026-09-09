'use strict';

// End-to-end Setup Quality pipeline tests over a synthetic Canonical BO
// scenario (see ./canonicalBOScenario.js). These exercise the modular
// evaluators against the real immutable Canonical BO v1 configuration plus the
// Phase 1 aggregation engine, exactly as the orchestrator persists them, and
// lock the point-in-time / no-lookahead guarantees required by the milestone.

const {
  getCanonicalBOConfig
} = require('../../../src/services/quality/canonicalBO');
const {
  CRITERION_STATUS
} = require('../../../src/services/quality/constants');
const { aggregateDimension, gradeForScore } = require('../../../src/services/quality/aggregation');
const { deriveScoreForCriterion } = require('../../../src/services/quality/scoring');
const { evaluateCriterion } = require('../../../src/services/quality/criterionRegistry');
const {
  normalizeCriterionRows
} = require('../../../src/services/quality/evaluationService');
const {
  buildCanonicalBOSeries,
  BASE_START_INDEX,
  BASE_END_INDEX,
  RESOLUTION_INDEX,
  PIVOT_PRICE
} = require('./canonicalBOScenario');

function buildPipelineRows(setupConfig, setup, bars, userInputs) {
  const rows = [];
  for (const criterionConfig of setupConfig.criteria) {
    if (criterionConfig.enabled === false) continue;
    const fragment = evaluateCriterion(criterionConfig, { setup, bars, userInputs });
    const row = {
      key: criterionConfig.key,
      status: fragment.status,
      scoring_value: fragment.scoring_value,
      raw_value: fragment.raw_value,
      evidence: fragment.evidence,
      message: fragment.message
    };
    if (fragment.status === CRITERION_STATUS.PASS || fragment.status === CRITERION_STATUS.FAIL) {
      const derived = deriveScoreForCriterion({
        status: fragment.status,
        scoring: criterionConfig.scoring,
        scoringValue: fragment.scoring_value
      });
      if (derived.error) throw new Error(`score error for ${criterionConfig.key}: ${derived.error}`);
      row.score = derived.score;
    }
    rows.push(row);
  }
  return rows;
}

function setupContext(bars, { baseStartIndex = BASE_START_INDEX, baseEndIndex = BASE_END_INDEX, resolutionIndex = RESOLUTION_INDEX, pivotIndex = 89, entryIndex = RESOLUTION_INDEX } = {}) {
  return {
    baseStart: {
      index: baseStartIndex,
      date: bars[baseStartIndex].date,
      price: bars[baseStartIndex].high,
      source: 'user_confirmed'
    },
    pivot: {
      index: pivotIndex,
      date: bars[pivotIndex].date,
      price: PIVOT_PRICE,
      source: 'user_confirmed',
      detectionConfidence: 'high'
    },
    resolution: { index: resolutionIndex, date: bars[resolutionIndex].date },
    baseEnd: { index: baseEndIndex, date: bars[baseEndIndex].date },
    entrySession: { index: entryIndex, date: bars[entryIndex].date }
  };
}

function runEvaluation(scenario, options = {}) {
  const { bars } = scenario;
  const setup = setupContext(bars, options);
  const config = getCanonicalBOConfig();
  const setupConfig = config.dimensions.setup;
  const rows = buildPipelineRows(setupConfig, setup, bars, {
    leader_confirmed: options.leader !== undefined ? options.leader : true
  });
  const summary = aggregateDimension(setupConfig, rows);
  // Mirror saveSetupProgress: rows must survive the same normalization the
  // persistence layer applies before aggregation.
  const normalized = normalizeCriterionRows('setup', setupConfig, { criterionResults: rows });
  const normalizedSummary = aggregateDimension(setupConfig, normalized);
  return { rows, summary, normalizedSummary, setup, setupConfig, bars };
}

function resultMap(rows) {
  return new Map(rows.map((row) => [row.key, row]));
}

describe('Setup Quality pipeline (Canonical BO v1)', () => {
  const scenario = buildCanonicalBOSeries();

  test('the synthetic scenario produces all-PASS setup criteria and an A grade', () => {
    const { rows, summary } = runEvaluation(scenario);
    for (const row of rows) {
      expect(row.status).toBe('PASS');
    }
    expect(summary.compliance).toBe('PASS');
    expect(summary.coverage).toBe(100);
    expect(summary.grade).toBe('A');
    expect(summary.score).toBeGreaterThan(90);
  });

  test('normalized persistence view matches the authoritative aggregate', () => {
    const { summary, normalizedSummary } = runEvaluation(scenario);
    expect(normalizedSummary.score).toBe(summary.score);
    expect(normalizedSummary.grade).toBe(summary.grade);
    expect(normalizedSummary.compliance).toBe(summary.compliance);
    expect(normalizedSummary.coverage).toBe(summary.coverage);
  });

  test('breakout-day data is excluded from every Setup criterion', () => {
    const { rows } = runEvaluation(scenario);
    const range = resultMap(rows).get('range_contraction');
    // Recent contraction window ends at D-1, never at the breakout day.
    expect(range.evidence.recent_window.endDate).toBe(scenario.dateAt(BASE_END_INDEX));
    const volume = resultMap(rows).get('volume_contraction');
    expect(volume.evidence.recent_window.endDate).toBe(scenario.dateAt(BASE_END_INDEX));
    // SMA evaluates at D-1.
    const ma = resultMap(rows).get('ma_trend');
    expect(ma.evidence.evaluation_date).toBe(scenario.dateAt(BASE_END_INDEX));
    // Higher Lows only inspects the base range.
    const hl = resultMap(rows).get('higher_lows');
    expect(hl.evidence.base_range.endDate).toBe(scenario.dateAt(BASE_END_INDEX));
  });

  test('changing post-breakout candles cannot alter Setup Quality', () => {
    const original = runEvaluation(scenario);
    // Mutate every bar from the breakout session onward to extreme values.
    const mutatedBars = scenario.bars.map((bar, index) => {
      if (index <= BASE_END_INDEX) return bar;
      return { ...bar, open: 5, high: 500, low: 5, close: 490, volume: 999_999_999 };
    });
    const mutatedScenario = { ...scenario, bars: mutatedBars };
    const changed = runEvaluation(mutatedScenario);
    expect(changed.summary).toEqual(original.summary);
    expect(changed.rows.map((row) => [row.key, row.status, row.scoring_value])).toEqual(
      original.rows.map((row) => [row.key, row.status, row.scoring_value])
    );
  });

  test('a late actual entry does not extend Base End beyond the real breakout D-1', () => {
    // Entry happens 8 sessions after the breakout; the setup boundary stays at
    // the real breakout D-1 (index 94) regardless.
    const entryIndex = RESOLUTION_INDEX + 8;
    const { setup } = runEvaluation(scenario, { entryIndex });
    expect(setup.resolution.index).toBe(RESOLUTION_INDEX);
    expect(setup.baseEnd.index).toBe(BASE_END_INDEX);
    expect(setup.entrySession.index).toBe(entryIndex);

    const sameAsEntryAtBreakout = runEvaluation(scenario, { entryIndex: RESOLUTION_INDEX });
    const late = runEvaluation(scenario, { entryIndex });
    expect(late.summary).toEqual(sameAsEntryAtBreakout.summary);
  });

  test('confirmed Base Start is authoritative and is never silently replaced by a detector', () => {
    // The "detected" Base Start proposal differs from what the user confirmed.
    const confirmedStart = BASE_START_INDEX;
    const { rows, setup } = runEvaluation(scenario, { baseStartIndex: confirmedStart });
    const duration = resultMap(rows).get('base_duration');
    expect(setup.baseStart.index).toBe(confirmedStart);
    expect(duration.evidence.base_duration_sessions).toBe(BASE_END_INDEX - confirmedStart + 1);
    // A different confirmed start produces a different duration (never the
    // detector's value, which is not even consulted on this path).
    const other = runEvaluation(scenario, { baseStartIndex: confirmedStart + 5 });
    const otherDuration = resultMap(other.rows).get('base_duration');
    expect(otherDuration.evidence.base_duration_sessions).not.toBe(
      duration.evidence.base_duration_sessions
    );
  });

  test('confirmed Pivot drives Prior Move, the boundary and Pivot Quality', () => {
    const { rows } = runEvaluation(scenario);
    const priorMove = resultMap(rows).get('prior_move');
    expect(priorMove.evidence.confirmed_pivot).toBe(PIVOT_PRICE);
    const pq = resultMap(rows).get('pivot_quality');
    expect(pq.evidence.confirmed_pivot).toBe(PIVOT_PRICE);
  });

  test('Pivot detection confidence never changes the Pivot Quality score', () => {
    const config = getCanonicalBOConfig();
    const setupConfig = config.dimensions.setup;
    const { bars } = scenario;
    const low = setupContext(bars);
    low.pivot = { ...low.pivot, detectionConfidence: 'low' };
    const high = setupContext(bars);
    high.pivot = { ...high.pivot, detectionConfidence: 'high' };

    const rowsLow = buildPipelineRows(setupConfig, low, bars, { leader_confirmed: true });
    const rowsHigh = buildPipelineRows(setupConfig, high, bars, { leader_confirmed: true });
    const pqLow = resultMap(rowsLow).get('pivot_quality');
    const pqHigh = resultMap(rowsHigh).get('pivot_quality');
    expect(pqLow.score).toBe(pqHigh.score);
    expect(pqLow.scoring_value).toEqual(pqHigh.scoring_value);
    expect(pqHigh.evidence.detection_confidence).toBe('high');
  });

  test('a FAIL (no leader) keeps Quality and Compliance independent', () => {
    const { summary } = runEvaluation(scenario, { leader: false });
    expect(summary.compliance).toBe('FAIL');
    // Score/grade still produced (compliance does not zero the score).
    expect(summary.grade).toBe(gradeForScore(summary.score));
    expect(summary.score).toBeGreaterThanOrEqual(0);
  });
});
