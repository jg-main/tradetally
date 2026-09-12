import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import PlaybookSetupQualityContext from './PlaybookSetupQualityContext.vue'
import { QUALITY_SOURCE } from '@/utils/tradeQualitySummary'

function legacyTrade(overrides = {}) {
  return {
    qualityGrade: 'A',
    qualityScore: 4.7,
    setupQuality: { grade: 'A', score: 4.7 },
    ...overrides
  }
}

describe('PlaybookSetupQualityContext', () => {
  it('legacy-only: preserves the legacy Setup Quality display', () => {
    const wrapper = mount(PlaybookSetupQualityContext, { props: { trade: legacyTrade() } })
    expect(wrapper.get('[data-testid="playbook-legacy-setup-grade"]').text()).toBe('Grade A')
    expect(wrapper.text()).toContain('4.7/5.0')
  })

  it('legacy-only ungraded: keeps the historical calculate hint', () => {
    const wrapper = mount(PlaybookSetupQualityContext, {
      props: { trade: { setupQuality: { grade: null, score: null } } }
    })
    expect(wrapper.text()).toContain('Calculate setup quality to pair setup context with adherence.')
  })

  it('primary authoritative + legacy A: shows the profile result, never an unlabeled legacy A', () => {
    const wrapper = mount(PlaybookSetupQualityContext, {
      props: {
        trade: legacyTrade({
          qualitySummary: {
            source: QUALITY_SOURCE.PROFILE_PRIMARY,
            setup: { score: 72, grade: 'C', compliance: 'FAIL', coverage: 95, scoreScale: 100 },
            profile: { profileName: 'Canonical BO', versionNumber: 3 }
          }
        })
      }
    })
    expect(wrapper.get('[data-testid="playbook-profile-setup-grade"]').text()).toBe('Grade C')
    expect(wrapper.text()).toContain('72/100')
    expect(wrapper.text()).toContain('Canonical BO v3')
    expect(wrapper.find('[data-testid="playbook-legacy-setup-grade"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Grade A')
  })

  it('primary with NULL grade shows N/A, not legacy A', () => {
    const wrapper = mount(PlaybookSetupQualityContext, {
      props: {
        trade: legacyTrade({
          qualitySummary: {
            source: QUALITY_SOURCE.PROFILE_PRIMARY,
            setup: { score: null, grade: null, compliance: 'INCOMPLETE', coverage: 40, scoreScale: 100 },
            profile: { profileName: 'Canonical BO', versionNumber: 3 }
          }
        })
      }
    })
    expect(wrapper.get('[data-testid="playbook-profile-setup-grade"]').text()).toBe('Grade N/A')
    expect(wrapper.find('[data-testid="playbook-legacy-setup-grade"]').exists()).toBe(false)
  })
})
