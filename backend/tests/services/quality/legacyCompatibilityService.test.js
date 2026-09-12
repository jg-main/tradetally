'use strict';

// Phase 6 — compatibility resolver unit contract.
//
// Verifies the single precedence contract used by every compatibility surface:
// primary explicit Phase-5 evaluation > legacy > none, with NO fallback from a
// null primary grade to the legacy grade, and no legacy->profile conversion.

const {
  SOURCE,
  resolveQualitySummary,
  hasLegacyQuality,
  effectiveSetupGradeSql,
  effectiveSetupGradeFilterSql,
  prefixPrimaryColumns
} = require('../../../src/services/quality/legacyCompatibilityService');

const LEGACY_ROW = {
  quality_grade: 'A',
  quality_score: '4.7',
  quality_metrics: { float: 1, coverage: 0.95 }
};

function primaryRow(overrides = {}) {
  return {
    primary_evaluation_id: 'eval-1',
    primary_evaluation_status: 'completed',
    primary_profile_id: 'profile-1',
    primary_profile_name: 'Canonical BO',
    primary_profile_version_id: 'version-3',
    primary_version_number: '3',
    primary_selected_at: '2026-09-03T10:00:00Z',
    primary_setup_score: 92,
    primary_setup_grade: 'A',
    primary_setup_compliance: 'PASS',
    primary_setup_coverage: 94,
    primary_entry_score: null,
    primary_entry_grade: null,
    primary_entry_compliance: null,
    primary_entry_coverage: null,
    primary_management_score: null,
    primary_management_grade: null,
    primary_management_compliance: null,
    primary_management_coverage: null,
    ...overrides
  };
}

describe('legacyCompatibilityService.resolveQualitySummary', () => {
  test('legacy only: uses legacy fields, scoreScale 5, no fabricated compliance', () => {
    const summary = resolveQualitySummary(LEGACY_ROW);
    expect(summary.source).toBe(SOURCE.LEGACY);
    expect(summary.setup).toEqual({
      score: 4.7,
      grade: 'A',
      compliance: null,
      coverage: 95,
      scoreScale: 5
    });
    expect(summary.entry).toBeNull();
    expect(summary.management).toBeNull();
    expect(summary.profile).toBeNull();
  });

  test('legacy metrics with no coverage leaves coverage null', () => {
    const summary = resolveQualitySummary({ quality_grade: 'B', quality_score: 3.5, quality_metrics: { float: 1 } });
    expect(summary.source).toBe(SOURCE.LEGACY);
    expect(summary.setup.coverage).toBeNull();
  });

  test('legacy metrics stored as a JSON string are parsed for coverage', () => {
    const summary = resolveQualitySummary({
      quality_grade: 'B',
      quality_score: 3.5,
      quality_metrics: JSON.stringify({ coverage: 0.4 })
    });
    expect(summary.setup.coverage).toBeCloseTo(40, 5);
  });

  test('primary only: profile metadata, scoreScale 100, independent dimensions', () => {
    const summary = resolveQualitySummary(primaryRow());
    expect(summary.source).toBe(SOURCE.PROFILE_PRIMARY);
    expect(summary.setup).toEqual({
      score: 92,
      grade: 'A',
      compliance: 'PASS',
      coverage: 94,
      scoreScale: 100
    });
    expect(summary.entry).toBeNull();
    expect(summary.management).toBeNull();
    expect(summary.profile).toEqual({
      profileId: 'profile-1',
      profileName: 'Canonical BO',
      profileVersionId: 'version-3',
      versionNumber: 3,
      evaluationId: 'eval-1',
      evaluationStatus: 'completed',
      selectedAt: '2026-09-03T10:00:00Z'
    });
  });

  test('primary includes entry/management when the evaluation graded them', () => {
    const summary = resolveQualitySummary(primaryRow({
      primary_entry_score: 95,
      primary_entry_grade: 'A',
      primary_entry_compliance: 'PASS',
      primary_entry_coverage: 100,
      primary_management_score: 87,
      primary_management_grade: 'B',
      primary_management_compliance: 'FAIL',
      primary_management_coverage: 100
    }));
    expect(summary.entry).toEqual({ score: 95, grade: 'A', compliance: 'PASS', coverage: 100 });
    expect(summary.management).toEqual({ score: 87, grade: 'B', compliance: 'FAIL', coverage: 100 });
  });

  test('both legacy and primary: primary wins and legacy is ignored', () => {
    const summary = resolveQualitySummary({ ...LEGACY_ROW, ...primaryRow({ primary_setup_grade: 'C', primary_setup_score: 72 }) });
    expect(summary.source).toBe(SOURCE.PROFILE_PRIMARY);
    expect(summary.setup.grade).toBe('C');
    expect(summary.setup.score).toBe(72);
    expect(summary.setup.scoreScale).toBe(100);
  });

  test('primary with NULL Setup grade does NOT fall back to the legacy grade', () => {
    const summary = resolveQualitySummary({
      ...LEGACY_ROW,
      ...primaryRow({
        primary_setup_score: null,
        primary_setup_grade: null,
        primary_setup_compliance: 'INCOMPLETE',
        primary_setup_coverage: 40,
        primary_evaluation_status: 'insufficient_data'
      })
    });
    expect(summary.source).toBe(SOURCE.PROFILE_PRIMARY);
    expect(summary.setup.grade).toBeNull();
    expect(summary.setup.score).toBeNull();
    expect(summary.setup.compliance).toBe('INCOMPLETE');
  });

  test('profile evaluations that exist WITHOUT a primary resolve to legacy', () => {
    // No primary_* columns at all: the resolver must not consult history.
    const summary = resolveQualitySummary({ quality_grade: 'C', quality_score: 2.5, quality_metrics: null });
    expect(summary.source).toBe(SOURCE.LEGACY);
    expect(summary.setup.grade).toBe('C');
  });

  test('no primary and no legacy resolves to none with an empty setup', () => {
    const summary = resolveQualitySummary({ quality_grade: null, quality_score: null, quality_metrics: null });
    expect(summary.source).toBe(SOURCE.NONE);
    expect(summary.setup).toEqual({ score: null, grade: null, compliance: null, coverage: null, scoreScale: null });
    expect(summary.profile).toBeNull();
  });

  test('metrics-only legacy data still counts as legacy presence', () => {
    expect(hasLegacyQuality({ quality_grade: null, quality_score: null, quality_metrics: {} })).toBe(true);
    expect(hasLegacyQuality({ quality_grade: null, quality_score: null, quality_metrics: null })).toBe(false);
    const summary = resolveQualitySummary({ quality_grade: null, quality_score: null, quality_metrics: { coverage: 0.5 } });
    expect(summary.source).toBe(SOURCE.LEGACY);
    expect(summary.setup.grade).toBeNull();
    expect(summary.setup.coverage).toBeCloseTo(50, 5);
  });
});

describe('legacyCompatibilityService SQL contract', () => {
  test('effective Setup grade is a CASE, never a COALESCE with the legacy grade', () => {
    const sql = effectiveSetupGradeSql('t');
    expect(sql).toContain('CASE');
    expect(sql).toContain('EXISTS');
    expect(sql).toContain('trade_quality_primary_evaluations');
    expect(sql).toContain('ELSE t.quality_grade');
    // The forbidden naive fallback would mention the legacy grade inside a
    // COALESCE together with the primary grade.
    expect(sql).not.toContain('COALESCE(t.quality_grade');
    expect(sql).not.toContain('COALESCE(pe.setup_grade, t.quality_grade');
  });

  test('effective grade is scoped to the trade owner', () => {
    const sql = effectiveSetupGradeSql('t');
    expect(sql).toContain('qpp_exists.user_id = t.user_id');
    expect(sql).toContain('qpp_grade.user_id = t.user_id');
  });

  test('filter helper binds placeholders for the requested grades', () => {
    const sql = effectiveSetupGradeFilterSql('t', '$2,$3');
    expect(sql).toContain('IN ($2,$3)');
    expect(sql).toContain('CASE');
  });

  test('prefixPrimaryColumns maps a detail lookup into resolver keys', () => {
    const prefixed = prefixPrimaryColumns({ evaluation_id: 'e1', setup_grade: 'C', version_number: 2 });
    expect(prefixed.primary_evaluation_id).toBe('e1');
    expect(prefixed.primary_setup_grade).toBe('C');
    expect(prefixed.primary_version_number).toBe(2);
    expect(prefixed.primary_management_grade).toBeNull();
  });
});
