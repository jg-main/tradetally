import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import TradeQualityCell from './TradeQualityCell.vue'
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

describe('TradeQualityCell', () => {
  it('shows the primary profile Setup grade when a primary exists (legacy ignored)', () => {
    const wrapper = mount(TradeQualityCell, {
      props: { trade: { qualityGrade: 'A', qualityScore: 4.7, qualitySummary: primarySummary() } }
    })
    expect(wrapper.get('[data-testid="trade-quality-grade"]').text()).toBe('C')
    expect(wrapper.text()).toContain('profile')
  })

  it('shows N/A (not the legacy grade) for a primary with a null Setup grade + legacy A', () => {
    const wrapper = mount(TradeQualityCell, {
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
    expect(wrapper.get('[data-testid="trade-quality-na"]').text()).toBe('N/A')
    expect(wrapper.find('[data-testid="trade-quality-grade"]').exists()).toBe(false)
    // The preserved legacy A must not be rendered as the effective grade.
    expect(wrapper.html()).not.toContain('legacy')
  })

  it('shows the legacy grade with a legacy indicator when there is no primary', () => {
    const wrapper = mount(TradeQualityCell, {
      props: { trade: { qualityGrade: 'B', qualityScore: 3.5, qualityMetrics: { coverage: 0.9 } } }
    })
    expect(wrapper.get('[data-testid="trade-quality-grade"]').text()).toBe('B')
    expect(wrapper.text()).toContain('legacy')
  })

  it('shows "-" when no quality data exists', () => {
    const wrapper = mount(TradeQualityCell, {
      props: { trade: { qualityGrade: null, qualityScore: null, qualityMetrics: null } }
    })
    expect(wrapper.get('[data-testid="trade-quality-none"]').text()).toBe('-')
  })
})
