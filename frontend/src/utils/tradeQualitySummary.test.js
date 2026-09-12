import { describe, expect, it } from 'vitest'
import {
  resolveTradeQualitySummary,
  setupGradeForTrade,
  qualityGradeBadgeClass,
  qualitySummaryTooltip,
  QUALITY_SOURCE
} from './tradeQualitySummary'

describe('tradeQualitySummary', () => {
  it('prefers the backend-resolved qualitySummary over raw legacy fields', () => {
    const trade = {
      qualityGrade: 'A',
      qualityScore: 4.6,
      qualitySummary: {
        source: QUALITY_SOURCE.PROFILE_PRIMARY,
        setup: { score: 72, grade: 'C', compliance: 'FAIL', coverage: 95, scoreScale: 100 },
        entry: null,
        management: null,
        profile: { profileName: 'Canonical BO', versionNumber: 3 }
      }
    }
    const summary = resolveTradeQualitySummary(trade)
    expect(summary.source).toBe(QUALITY_SOURCE.PROFILE_PRIMARY)
    expect(setupGradeForTrade(trade)).toBe('C')
  })

  it('falls back to a legacy-only projection when qualitySummary is absent', () => {
    const summary = resolveTradeQualitySummary({
      qualityGrade: 'A',
      qualityScore: 4.5,
      qualityMetrics: { coverage: 0.95 }
    })
    expect(summary.source).toBe(QUALITY_SOURCE.LEGACY)
    expect(summary.setup).toEqual({ score: 4.5, grade: 'A', compliance: null, coverage: 95, scoreScale: 5 })
  })

  it('reports none when neither a summary nor legacy data exists', () => {
    const summary = resolveTradeQualitySummary({ qualityGrade: null, qualityScore: null, qualityMetrics: null })
    expect(summary.source).toBe(QUALITY_SOURCE.NONE)
    expect(setupGradeForTrade({})).toBeNull()
  })

  it('never falls back to legacy when a primary summary has a null grade', () => {
    const trade = {
      qualityGrade: 'A',
      qualitySummary: {
        source: QUALITY_SOURCE.PROFILE_PRIMARY,
        setup: { score: null, grade: null, compliance: 'INCOMPLETE', coverage: 40, scoreScale: 100 },
        profile: { profileName: 'Canonical BO', versionNumber: 3 }
      }
    }
    expect(setupGradeForTrade(trade)).toBeNull()
    expect(resolveTradeQualitySummary(trade).source).toBe(QUALITY_SOURCE.PROFILE_PRIMARY)
  })

  it('maps grades to badge classes', () => {
    expect(qualityGradeBadgeClass('A')['bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400']).toBe(true)
    expect(qualityGradeBadgeClass('F')['bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400']).toBe(true)
    expect(qualityGradeBadgeClass(null)).toEqual({
      'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400': false,
      'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400': false,
      'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400': false,
      'bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400': false,
      'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400': false
    })
  })

  it('describes the source in the tooltip', () => {
    const legacy = qualitySummaryTooltip({ qualityGrade: 'B', qualityScore: 3.5 })
    expect(legacy).toContain('Legacy')
    const primary = qualitySummaryTooltip({
      qualitySummary: {
        source: QUALITY_SOURCE.PROFILE_PRIMARY,
        setup: { score: 92, grade: 'A', compliance: 'PASS', coverage: 94, scoreScale: 100 },
        profile: { profileName: 'Canonical BO', versionNumber: 3 }
      }
    })
    expect(primary).toContain('Canonical BO v3')
    expect(primary).toContain('92 / 100')
  })
})
