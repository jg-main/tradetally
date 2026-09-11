'use strict';

jest.mock('../../../src/config/database', () => ({
  query: jest.fn()
}));

const db = require('../../../src/config/database');
const comparisonService = require('../../../src/services/quality/comparisonService');

function configMap(criteria) {
  return new Map(criteria.map((criterion) => [criterion.key, criterion]));
}

function maps(criteria) {
  return { setup: configMap(criteria), entry: new Map(), management: new Map() };
}

function dimResult(rows, summary = {}) {
  return {
    score: summary.score ?? null,
    grade: summary.grade ?? null,
    compliance: summary.compliance ?? null,
    coverage: summary.coverage ?? null,
    criterionResults: rows
  };
}

function row(key, status, score, extra = {}) {
  return { key, status, score, scoringValue: extra.scoringValue ?? null, rawValue: extra.rawValue ?? null, weight: extra.weight, required: extra.required };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('comparisonService criterion alignment', () => {
  const leftConfig = [
    { key: 'leader', enabled: true, required: true, weight: 20, scoring: { type: 'binary' } },
    { key: 'prior_move', enabled: true, required: true, weight: 20, scoring: { type: 'step' } }
  ];
  const rightConfig = [
    { key: 'leader', enabled: true, required: true, weight: 20, scoring: { type: 'binary' } },
    { key: 'base_duration', enabled: true, required: true, weight: 5, scoring: { type: 'binary' } }
  ];

  test('represents a criterion present in both versions with a numeric delta', () => {
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([row('leader', 'PASS', 90)]) } },
      { results: { setup: dimResult([row('leader', 'PASS', 100)]) } },
      maps(leftConfig),
      maps(rightConfig)
    );

    const leader = comparison.criteria.find((criterion) => criterion.key === 'leader');
    expect(leader.presence).toBe('both');
    expect(leader.score).toEqual({ left: 90, right: 100, delta: 10 });
  });

  test('represents a criterion removed in the right version as only_left (absent, never UNKNOWN)', () => {
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([row('prior_move', 'FAIL', 60)]) } },
      { results: { setup: dimResult([]) } },
      maps(leftConfig),
      maps(rightConfig)
    );

    const priorMove = comparison.criteria.find((criterion) => criterion.key === 'prior_move');
    expect(priorMove.presence).toBe('only_left');
    expect(priorMove.status.right).toBeNull();
    expect(priorMove.score.delta).toBeNull();
    expect(priorMove.status.left).toBe('FAIL');
  });

  test('represents a criterion added in the right version as only_right', () => {
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([]) } },
      { results: { setup: dimResult([row('base_duration', 'PASS', 100)]) } },
      maps(leftConfig),
      maps(rightConfig)
    );

    const added = comparison.criteria.find((criterion) => criterion.key === 'base_duration');
    expect(added.presence).toBe('only_right');
    expect(added.status.left).toBeNull();
  });

  test('does not compute a score delta when one side is UNKNOWN / NOT_APPLICABLE', () => {
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([row('leader', 'UNKNOWN', null)]) } },
      { results: { setup: dimResult([row('leader', 'PASS', 100)]) } },
      maps(leftConfig),
      maps(rightConfig)
    );

    const leader = comparison.criteria.find((criterion) => criterion.key === 'leader');
    expect(leader.score.left).toBeNull();
    expect(leader.score.delta).toBeNull();
    expect(leader.status.left).toBe('UNKNOWN');
  });

  test('keeps UNKNOWN distinct from historical absence', () => {
    // leader exists (evaluated UNKNOWN) on the left, but the right version does
    // not configure it at all: the right side must be absent, never UNKNOWN.
    const rightWithoutLeader = [{ key: 'base_duration', enabled: true, required: true, weight: 5, scoring: { type: 'binary' } }];
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([row('leader', 'UNKNOWN', null)]) } },
      { results: { setup: dimResult([row('base_duration', 'PASS', 100)]) } },
      maps(leftConfig),
      maps(rightWithoutLeader)
    );

    const leader = comparison.criteria.find((criterion) => criterion.key === 'leader');
    expect(leader.presence).toBe('only_left');
    expect(leader.status.left).toBe('UNKNOWN');
    expect(leader.status.right).toBeNull();
  });

  test('marks configuration_changed when the immutable criterion configuration differs', () => {
    const changedRight = [
      { key: 'leader', enabled: true, required: true, weight: 30, scoring: { type: 'binary' } },
      { key: 'base_duration', enabled: true, required: true, weight: 5, scoring: { type: 'binary' } }
    ];
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([row('leader', 'PASS', 100)]) } },
      { results: { setup: dimResult([row('leader', 'PASS', 100)]) } },
      maps(leftConfig),
      maps(changedRight)
    );

    const leader = comparison.criteria.find((criterion) => criterion.key === 'leader');
    expect(leader.configuration_changed).toBe(true);
    expect(leader.configuration.left.weight).toBe(20);
    expect(leader.configuration.right.weight).toBe(30);
  });

  test('never produces a combined overall quality score', () => {
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([row('leader', 'PASS', 100)], { score: 91, grade: 'A', compliance: 'PASS', coverage: 100 }) } },
      { results: { setup: dimResult([row('leader', 'PASS', 100)], { score: 88, grade: 'A', compliance: 'PASS', coverage: 100 }) } },
      maps(leftConfig),
      maps(rightConfig)
    );

    expect(comparison).not.toHaveProperty('overall');
    expect(comparison).not.toHaveProperty('overall_score');
    expect(comparison.score_delta).toBe(-3);
  });
});

describe('comparisonService criterion presence semantics (Phase 5 hardening)', () => {
  test('enabled on the left, disabled on the right is only_left (removed on the right)', () => {
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([row('leader', 'PASS', 100)]) } },
      { results: { setup: dimResult([]) } },
      maps([{ key: 'leader', enabled: true, required: true, weight: 100, scoring: { type: 'binary' } }]),
      maps([{ key: 'leader', enabled: false, required: true, weight: 100, scoring: { type: 'binary' } }])
    );
    const leader = comparison.criteria.find((criterion) => criterion.key === 'leader');
    expect(leader.presence).toBe('only_left');
  });

  test('disabled on the left, enabled on the right is only_right (added on the right)', () => {
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([]) } },
      { results: { setup: dimResult([row('leader', 'PASS', 100)]) } },
      maps([{ key: 'leader', enabled: false, required: true, weight: 100, scoring: { type: 'binary' } }]),
      maps([{ key: 'leader', enabled: true, required: true, weight: 100, scoring: { type: 'binary' } }])
    );
    const leader = comparison.criteria.find((criterion) => criterion.key === 'leader');
    expect(leader.presence).toBe('only_right');
  });

  test('disabled on BOTH versions is presence none, never removed/added', () => {
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([]) } },
      { results: { setup: dimResult([]) } },
      maps([{ key: 'leader', enabled: false, required: true, weight: 100, scoring: { type: 'binary' } }]),
      maps([{ key: 'leader', enabled: false, required: true, weight: 100, scoring: { type: 'binary' } }])
    );
    const leader = comparison.criteria.find((criterion) => criterion.key === 'leader');
    expect(leader.presence).toBe('none');
    expect(leader.presence).not.toBe('only_left');
    expect(leader.presence).not.toBe('only_right');
    expect(leader.enabled).toEqual({ left: false, right: false });
  });

  test('absent is distinct from NOT_APPLICABLE', () => {
    const comparison = comparisonService.buildDimensionComparison(
      'setup',
      { results: { setup: dimResult([row('leader', 'NOT_APPLICABLE', null)]) } },
      { results: { setup: dimResult([row('base_duration', 'PASS', 100)]) } },
      maps([{ key: 'leader', enabled: true, required: true, weight: 100, scoring: { type: 'binary' } }]),
      maps([{ key: 'base_duration', enabled: true, required: true, weight: 100, scoring: { type: 'binary' } }])
    );
    const leader = comparison.criteria.find((criterion) => criterion.key === 'leader');
    expect(leader.status.left).toBe('NOT_APPLICABLE');
    expect(leader.status.right).toBeNull();
    expect(leader.presence).toBe('only_left');
  });

  test('missing_data_behavior is part of configuration comparison', () => {
    const left = { key: 'partial_timing', enabled: true, required: true, weight: 20, scoring: { type: 'binary' }, missing_data_behavior: 'unknown' };
    const right = { key: 'partial_timing', enabled: true, required: true, weight: 20, scoring: { type: 'binary' }, missing_data_behavior: 'not_applicable' };

    expect(comparisonService.sameCriterionConfig(left, right)).toBe(false);

    const comparison = comparisonService.buildDimensionComparison(
      'management',
      { results: { management: dimResult([row('partial_timing', 'UNKNOWN', null)]) } },
      { results: { management: dimResult([row('partial_timing', 'NOT_APPLICABLE', null)]) } },
      { setup: new Map(), entry: new Map(), management: configMap([left]) },
      { setup: new Map(), entry: new Map(), management: configMap([right]) }
    );
    const criterion = comparison.criteria.find((entry) => entry.key === 'partial_timing');
    expect(criterion.configuration_changed).toBe(true);
    expect(criterion.configuration.left.missing_data_behavior).toBe('unknown');
    expect(criterion.configuration.right.missing_data_behavior).toBe('not_applicable');
  });

  test('an omitted missing_data_behavior equals the documented default unknown', () => {
    const omitted = { key: 'leader', enabled: true, required: true, weight: 100, scoring: { type: 'binary' } };
    const explicit = { key: 'leader', enabled: true, required: true, weight: 100, scoring: { type: 'binary' }, missing_data_behavior: 'unknown' };
    expect(comparisonService.sameCriterionConfig(omitted, explicit)).toBe(true);
    expect(comparisonService.criterionConfigurationView(omitted).missing_data_behavior).toBe('unknown');
  });
});

describe('comparisonService.compareEvaluations', () => {
  test('rejects when either id is missing', async () => {
    await expect(comparisonService.compareEvaluations('user-1', 'trade-1', null, 'b')).rejects.toMatchObject({
      code: 'COMPARISON_IDS_REQUIRED'
    });
  });

  test('returns EVALUATION_NOT_FOUND without leaking which side is missing', async () => {
    db.query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await expect(
      comparisonService.compareEvaluations('user-1', 'trade-1', 'eval-a', 'eval-b')
    ).rejects.toMatchObject({ code: 'EVALUATION_NOT_FOUND' });
  });

  test('builds metadata and all three dimensions from persisted snapshots', async () => {
    const left = {
      id: 'eval-a',
      status: 'completed',
      trade_id: 'trade-1',
      profile_version_id: 'v1',
      results: { setup: dimResult([row('leader', 'PASS', 90)], { score: 90, grade: 'A', compliance: 'PASS', coverage: 100 }) },
      evaluated_at: '2026-09-03T00:00:00Z',
      created_at: '2026-09-03T00:00:00Z',
      version_number: 1,
      schema_version: 1,
      configuration: { dimensions: { setup: { criteria: [{ key: 'leader', enabled: true, required: true, weight: 20, scoring: {} }] } } },
      profile_id: 'profile-1',
      profile_name: 'Canonical BO',
      current_version_id: 'v3',
      is_current_version: false,
      is_primary: false
    };
    const right = {
      ...left,
      id: 'eval-b',
      profile_version_id: 'v3',
      version_number: 3,
      is_current_version: true,
      evaluated_at: '2026-09-11T00:00:00Z'
    };
    db.query.mockImplementation((sql, params) =>
      Promise.resolve({ rows: [params[0] === 'eval-a' ? left : right] })
    );

    const comparison = await comparisonService.compareEvaluations('user-1', 'trade-1', 'eval-a', 'eval-b');

    expect(comparison.left.evaluation_id).toBe('eval-a');
    expect(comparison.left.version_number).toBe(1);
    expect(comparison.right.version_number).toBe(3);
    expect(Object.keys(comparison.dimensions)).toEqual(['setup', 'entry', 'management']);
    expect(comparison.dimensions.setup.left.score).toBe(90);
    expect(comparison.dimensions.setup.score_delta).toBe(0);
    expect(comparison).not.toHaveProperty('overall_score');
  });
});
