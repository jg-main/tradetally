'use strict';

jest.mock('../../../src/config/database', () => ({
  query: jest.fn()
}));

const db = require('../../../src/config/database');
const evaluationService = require('../../../src/services/quality/evaluationService');
const { CRITERION_STATUS } = require('../../../src/services/quality/constants');

const CONFIG = {
  dimensions: {
    setup: {
      minimum_coverage: 70,
      grade_thresholds: { A: 90, B: 80, C: 70, D: 60 },
      criteria: [
        {
          key: 'leader',
          enabled: true,
          required: true,
          weight: 20,
          parameters: { source: 'user_asserted' },
          scoring: { type: 'binary', pass_score: 100, fail_score: 0 }
        }
      ]
    }
  }
};

function lookupRow(overrides = {}) {
  return { id: 'eval-1', status: 'draft', configuration: CONFIG, ...overrides };
}

function updatedRow(overrides = {}) {
  return { id: 'eval-1', status: 'draft', results: null, setup_score: null, ...overrides };
}

let updateParams;

beforeEach(() => {
  jest.clearAllMocks();
  updateParams = null;
});

describe('evaluationService.saveSetupProgress', () => {
  test('normalizes setup rows, recomputes the aggregate and persists a NON-TERMINAL { setup } result', async () => {
    db.query
      .mockResolvedValueOnce({ rows: [lookupRow()] })
      .mockImplementationOnce((sql, params) => {
        updateParams = params;
        return { rows: [updatedRow()] };
      });

    const result = await evaluationService.saveSetupProgress('eval-1', 'user-1', {
      setupResults: {
        criterionResults: [
          {
            key: 'leader',
            status: CRITERION_STATUS.PASS,
            score: 100,
            scoring_value: null,
            raw_value: 'yes',
            evidence: { source: 'user_asserted' },
            message: 'Leader'
          }
        ]
      },
      evidenceSnapshot: { bars: [] },
      userInputs: { leader_confirmed: true },
      detectedContext: {}
    });

    expect(result).not.toBeNull();
    const results = JSON.parse(updateParams[2]);
    // One key per configured dimension; Entry/Management are explicit null
    // because Phase 2 never evaluates them (nothing is fabricated).
    expect(results.setup).toBeDefined();
    expect(results.entry).toBeNull();
    expect(results.management).toBeNull();
    expect(results.setup.score).toBe(100);
    expect(results.setup.compliance).toBe('PASS');
    expect(results.setup.coverage).toBe(100);
    expect(updateParams[6]).toBe(100); // setup_score column
    expect(updateParams[8]).toBe('PASS'); // setup_compliance column
    // The row must remain a mutable draft (SQL guard, not a terminal status).
    expect(updateParams[0]).toBe('eval-1');
  });

  test('rejects PASS/FAIL scores that contradict the profile scoring configuration', async () => {
    db.query.mockResolvedValueOnce({ rows: [lookupRow()] });

    await expect(
      evaluationService.saveSetupProgress('eval-1', 'user-1', {
        setupResults: {
          criterionResults: [
            {
              key: 'leader',
              status: CRITERION_STATUS.PASS,
              score: 55, // binary envelope says 100
              scoring_value: null
            }
          ]
        }
      })
    ).rejects.toThrow(/contradicts its profile scoring configuration/);
    expect(db.query).toHaveBeenCalledTimes(1); // the UPDATE must never run
  });

  test('returns null (never updates) for terminal evaluations', async () => {
    db.query.mockResolvedValueOnce({ rows: [] });
    const result = await evaluationService.saveSetupProgress('eval-1', 'user-1', {
      setupResults: { criterionResults: [] }
    });
    expect(result).toBeNull();
    expect(db.query).toHaveBeenCalledTimes(1);
  });

  test('rejects a profile version without a setup dimension', async () => {
    db.query.mockResolvedValueOnce({
      rows: [{ id: 'eval-1', status: 'draft', configuration: { dimensions: {} } }]
    });
    await expect(
      evaluationService.saveSetupProgress('eval-1', 'user-1', {
        setupResults: { criterionResults: [] }
      })
    ).rejects.toThrow(/no setup dimension/);
  });
});
