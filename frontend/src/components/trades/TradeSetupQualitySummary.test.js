import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TradeSetupQualitySummary from './TradeSetupQualitySummary.vue'
import { QUALITY_SOURCE } from '@/utils/tradeQualitySummary'

function primarySummary(overrides = {}) {
  return {
    source: QUALITY_SOURCE.PROFILE_PRIMARY,
    setup: { score: 72, grade: 'C', compliance: 'FAIL', coverage: 95, scoreScale: 100 },
    entry: null,
    management: null,
    profile: { profileName: 'Canonical BO', versionNumber: 3 },
    ...overrides
  }
}

describe('TradeSetupQualitySummary', () => {
  it('legacy-only trade preserves the legacy grade/score and shows no profile block', () => {
    const wrapper = mount(TradeSetupQualitySummary, {
      props: { trade: { qualityGrade: 'A', qualityScore: 4.5, qualityMetrics: { coverage: 0.9 } } }
    })
    expect(wrapper.text()).toContain('Grade A')
    expect(wrapper.text()).toContain('4.5/5.0')
    expect(wrapper.find('[data-testid="profile-setup-quality"]').exists()).toBe(false)
  })

  it('ungraded legacy trade keeps the historical Calculate Setup Quality action', () => {
    const wrapper = mount(TradeSetupQualitySummary, {
      props: { trade: { qualityGrade: null, qualityScore: null, qualityMetrics: { coverage: 0.2 } } }
    })
    expect(wrapper.text()).toContain('Not calculated')
    expect(wrapper.text()).toContain('Calculate Setup Quality')
  })

  it('primary-only trade shows the selected profile Setup result', () => {
    const wrapper = mount(TradeSetupQualitySummary, {
      props: { trade: { qualitySummary: primarySummary() } }
    })
    const profile = wrapper.get('[data-testid="profile-setup-quality"]')
    expect(profile.text()).toContain('Grade C')
    expect(profile.text()).toContain('72 / 100')
    expect(profile.text()).toContain('Canonical BO v3')
    expect(profile.text()).toContain('Compliance FAIL')
    expect(profile.text()).toContain('Coverage 95%')
    // No legacy block when there is no legacy data.
    expect(wrapper.find('[data-testid="legacy-setup-quality"]').exists()).toBe(false)
  })

  it('both systems: primary is current and legacy remains clearly labelled and separate', () => {
    const wrapper = mount(TradeSetupQualitySummary, {
      props: {
        trade: { qualityGrade: 'A', qualityScore: 4.7, qualitySummary: primarySummary() }
      }
    })
    expect(wrapper.get('[data-testid="profile-setup-quality"]').text()).toContain('Grade C')
    const legacy = wrapper.get('[data-testid="legacy-setup-quality"]')
    expect(legacy.text()).toContain('Legacy Setup Quality')
    expect(legacy.text()).toContain('Grade A')
    expect(legacy.text()).toContain('4.7/5.0')
    expect(legacy.text()).toContain('Calculate Legacy Setup Quality')
  })

  it('primary with null grade does NOT fall back to legacy A', () => {
    const wrapper = mount(TradeSetupQualitySummary, {
      props: {
        trade: {
          qualityGrade: 'A',
          qualityScore: 4.8,
          qualitySummary: primarySummary({
            setup: { score: null, grade: null, compliance: 'INCOMPLETE', coverage: 40, scoreScale: 100 }
          })
        }
      }
    })
    const profile = wrapper.get('[data-testid="profile-setup-quality"]')
    expect(profile.text()).toContain('N/A')
    // Legacy A is still available, but only inside the clearly labelled block.
    expect(wrapper.get('[data-testid="legacy-setup-quality"]').text()).toContain('Grade A')
  })

  it('neither system shows an honest not-calculated state', () => {
    const wrapper = mount(TradeSetupQualitySummary, {
      props: { trade: { qualityGrade: null, qualityScore: null, qualityMetrics: null } }
    })
    expect(wrapper.text()).toContain('Not calculated')
    expect(wrapper.text()).toContain('Calculate Setup Quality')
  })

  it('emits calculate when the legacy button is clicked', async () => {
    const wrapper = mount(TradeSetupQualitySummary, {
      props: { trade: { qualityGrade: null, qualityScore: null, qualityMetrics: { coverage: 0.2 } } }
    })
    await wrapper.findAll('button')[0].trigger('click')
    expect(wrapper.emitted('calculate')).toHaveLength(1)
  })
})
