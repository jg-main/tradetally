'use strict';

jest.mock('../../../src/config/database', () => ({ query: jest.fn() }));

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');
const { CRITERION_STATUS } = require('../../../src/services/quality/constants');

const CONFIG = {
  dimensions: {
    setup: {
      minimum_coverage: 70,
      grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
      criteria: [
        { key: 'leader', enabled: true, required: true, weight: 20, parameters: { source: 'user_asserted' }, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } }
      ]
    },
    entry: {
      minimum_coverage: 70,
      grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
      criteria: [
        { key: 'breakout_session', enabled: true, required: true, weight: 10, parameters: {}, scoring: { type: 'binary', pass_score: 100, fail_score: 0 } }
      ]
    }
  }
};

const SETUP_RESULT = { score: 91, grade: 'A', compliance: 'PASS', coverage: 100, criterionResults: [] };

function lookupRow(overrides = {}) {
  return {
    id: 'eval-1',
    status: 'draft',
    results: { setup: SETUP_RESULT, entry: null, management: null },
    configuration: CONFIG,
    ...overrides
  };
}

let updateParams;

beforeEach(() => {
  jest.clearAllMocks();
  updateParams = null;
});

describe('evaluationService.saveEntryProgress', () => {
  test('preserves Setup byte-for-byte, replaces Entry and derives entry summaries', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [lookupRow()] })
      .mockImplementationOnce((sql, params) => {
        updateParams = params;
        return { rows: [{ id: 'eval-1', status: 'draft', results: null }] };
      });

    const result = await evaluationService.saveEntryProgress('eval-1', 'user-1', {
      entryResults: {
        criterionResults: [
          { key: 'breakout_session', status: CRITERION_STATUS.PASS, score: 100, scoring_value: null, raw_value: 'same_session' }
        ]
      },
      evidenceSnapshot: { bars: [], entry: { ok: true } },
      userInputs: { base_start: { date: '2026-02-10' }, intended_trigger_type: 'BO-PIVOT' },
      detectedContext: { entry: {} }
    });

    expect(result).not.toBeNull();
    const results = JSON.parse(updateParams[2]);
    expect(results.setup).toEqual(SETUP_RESULT);
    expect(results.entry.score).toBe(100);
    expect(results.entry.compliance).toBe('PASS');
    expect(results.entry.coverage).toBe(100);
    expect(results.management).toBeNull();
    // entry_* columns only; setup_* untouched by this UPDATE.
    expect(updateParams[6]).toBe(100); // entry_score
    expect(updateParams[8]).toBe('PASS'); // entry_compliance
    expect(updateParams[9]).toBe(100); // entry_coverage
  });

  test('refuses to proceed without an existing Setup result (never silently erases Setup)', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow({ results: { setup: null, entry: null, management: null } })] });

    await expect(
      evaluationService.saveEntryProgress('eval-1', 'user-1', {
        entryResults: { criterionResults: [] }
      })
    ).rejects.toThrow(/requires an existing Setup result/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('rejects PASS/FAIL scores that contradict the profile scoring configuration', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow()] });
    await expect(
      evaluationService.saveEntryProgress('eval-1', 'user-1', {
        entryResults: {
          criterionResults: [{ key: 'breakout_session', status: CRITERION_STATUS.PASS, score: 12, scoring_value: null }]
        }
      })
    ).rejects.toThrow(/contradicts its profile scoring configuration/);
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('returns null (never updates) for terminal evaluations', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await evaluationService.saveEntryProgress('eval-1', 'user-1', {
      entryResults: { criterionResults: [] }
    });
    expect(result).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
  });
});
