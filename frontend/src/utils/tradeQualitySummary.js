// Phase 6 — frontend consumer for the backend-resolved quality compatibility
// contract (docs/QUALITY_PROFILES_REQUIREMENT.md s.47, s.54, s.66).
//
// The backend owns the precedence decision (explicit Phase-5 primary profile
// evaluation > legacy > none) and ships it as `trade.qualitySummary`. The UI
// must NOT re-derive precedence: it only reads the resolved summary. The
// legacy fallback below exists solely for payloads that predate the additive
// field (e.g. a cached list response); it never overrides a resolved summary.

export const QUALITY_SOURCE = Object.freeze({
  PROFILE_PRIMARY: 'profile_primary',
  LEGACY: 'legacy',
  NONE: 'none'
})

const EMPTY_SETUP = Object.freeze({
  score: null,
  grade: null,
  compliance: null,
  coverage: null,
  scoreScale: null
})

function legacyCoverage(metrics) {
  if (!metrics || typeof metrics !== 'object') return null
  const raw = metrics.coverage
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null
  const percent = raw >= 0 && raw <= 1 ? raw * 100 : raw
  return Math.round(percent * 100) / 100
}

function legacySummary(trade) {
  const hasLegacy =
    trade.qualityGrade !== null && trade.qualityGrade !== undefined ||
    trade.qualityScore !== null && trade.qualityScore !== undefined ||
    trade.qualityMetrics !== null && trade.qualityMetrics !== undefined

  if (!hasLegacy) return null

  return {
    source: QUALITY_SOURCE.LEGACY,
    setup: {
      score: trade.qualityScore != null ? Number(trade.qualityScore) : null,
      grade: trade.qualityGrade || null,
      compliance: null,
      coverage: legacyCoverage(trade.qualityMetrics),
      scoreScale: 5
    },
    entry: null,
    management: null,
    profile: null
  }
}

/**
 * Returns the resolved compatibility summary for a trade. Prefers the
 * backend-provided `qualitySummary`; otherwise falls back to a legacy-only
 * projection so older payloads keep rendering.
 */
export function resolveTradeQualitySummary(trade) {
  if (!trade) {
    return { source: QUALITY_SOURCE.NONE, setup: { ...EMPTY_SETUP }, entry: null, management: null, profile: null }
  }
  if (trade.qualitySummary && trade.qualitySummary.source) {
    return trade.qualitySummary
  }
  return (
    legacySummary(trade) || {
      source: QUALITY_SOURCE.NONE,
      setup: { ...EMPTY_SETUP },
      entry: null,
      management: null,
      profile: null
    }
  )
}

/** Effective Setup grade for compact display (null => N/A or "-"). */
export function setupGradeForTrade(trade) {
  return resolveTradeQualitySummary(trade).setup?.grade || null
}

/** Tailwind classes for a grade badge. */
export function qualityGradeBadgeClass(grade) {
  return {
    'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400': grade === 'A',
    'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400': grade === 'B',
    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400': grade === 'C',
    'bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400': grade === 'D',
    'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400': grade === 'F'
  }
}

/**
 * Compact tooltip text describing the compatibility source so a user can tell
 * a profile-based Setup grade apart from a preserved legacy grade.
 */
export function qualitySummaryTooltip(trade) {
  const summary = resolveTradeQualitySummary(trade)
  if (summary.source === QUALITY_SOURCE.PROFILE_PRIMARY) {
    const parts = ['Profile-based Setup Quality']
    if (summary.profile?.profileName) {
      parts.push(summary.profile.versionNumber ? `${summary.profile.profileName} v${summary.profile.versionNumber}` : summary.profile.profileName)
    }
    if (typeof summary.setup?.score === 'number') parts.push(`${summary.setup.score} / 100`)
    if (summary.setup?.compliance) parts.push(`Compliance ${summary.setup.compliance}`)
    if (typeof summary.setup?.coverage === 'number') parts.push(`Coverage ${summary.setup.coverage}%`)
    return parts.join(' · ')
  }
  if (summary.source === QUALITY_SOURCE.LEGACY) {
    return 'Legacy Setup Quality (0-5 scale, historical)'
  }
  return 'No Setup Quality available'
}
