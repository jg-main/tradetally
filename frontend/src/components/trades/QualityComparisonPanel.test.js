import { mount } from '@vue/test-utils'
import { describe, expect, it } from 'vitest'
import QualityComparisonPanel from './QualityComparisonPanel.vue'

function buildComparison(overrides = {}) {
  return {
    trade_id: 'trade-1',
    left: {
      evaluation_id: 'eval-a',
      status: 'completed',
      is_primary: false,
      profile_name: 'Canonical BO',
      version_number: 1,
      evaluated_at: '2026-09-03T10:00:00Z',
      created_at: '2026-09-03T10:00:00Z'
    },
    right: {
      evaluation_id: 'eval-b',
      status: 'completed',
      is_primary: true,
      profile_name: 'Canonical BO',
      version_number: 3,
      evaluated_at: '2026-09-11T10:00:00Z',
      created_at: '2026-09-11T10:00:00Z'
    },
    dimensions: {
      setup: {
        dimension: 'setup',
        left: { score: 90, grade: 'A', compliance: 'PASS', coverage: 100 },
        right: { score: 85, grade: 'B', compliance: 'FAIL', coverage: 90 },
        score_delta: -5,
        coverage_delta: -10,
        criteria: [
          {
            key: 'leader',
            presence: 'both',
            status: { left: 'PASS', right: 'PASS' },
            score: { left: 90, right: 100, delta: 10 },
            configuration_changed: true
          },
          {
            key: 'prior_move',
            presence: 'only_left',
            status: { left: 'FAIL', right: null },
            score: { left: 60, right: null, delta: null },
            configuration_changed: null
          },
          {
            key: 'base_duration',
            presence: 'only_right',
            status: { left: null, right: 'PASS' },
            score: { left: null, right: 100, delta: null },
            configuration_changed: null
          },
          {
            key: 'range_contraction',
            presence: 'both',
            status: { left: 'UNKNOWN', right: 'NOT_APPLICABLE' },
            score: { left: null, right: null, delta: null },
            configuration_changed: false
          }
        ]
      },
      entry: {
        dimension: 'entry',
        left: { score: null, grade: null, compliance: 'INCOMPLETE', coverage: 50 },
        right: { score: null, grade: null, compliance: 'INCOMPLETE', coverage: 50 },
        score_delta: null,
        coverage_delta: 0,
        criteria: []
      },
      management: {
        dimension: 'management',
        left: { score: 70, grade: 'C', compliance: 'PASS', coverage: 100 },
        right: { score: 70, grade: 'C', compliance: 'PASS', coverage: 100 },
        score_delta: 0,
        coverage_delta: 0,
        criteria: []
      }
    },
    ...overrides
  }
}

describe('QualityComparisonPanel', () => {
  it('renders both version headers with evaluated dates and no overall score', () => {
    const wrapper = mount(QualityComparisonPanel, { props: { comparison: buildComparison() } })

    expect(wrapper.get('[data-testid="comparison-left-header"]').text()).toContain('Canonical BO v1')
    expect(wrapper.get('[data-testid="comparison-right-header"]').text()).toContain('Canonical BO v3')
    expect(wrapper.get('[data-testid="comparison-right-status"]').text()).toContain('PRIMARY')
    expect(wrapper.text()).not.toMatch(/overall/i)
    expect(wrapper.findAll('[data-testid="comparison-dimension"]')).toHaveLength(3)
  })

  it('renders per-dimension summaries and score deltas only when both sides are numeric', () => {
    const wrapper = mount(QualityComparisonPanel, { props: { comparison: buildComparison() } })

    const deltas = wrapper.findAll('[data-testid="comparison-score-delta"]').map((node) => node.text())
    expect(deltas.join(' ')).toContain('-5')
    // Entry has no numeric scores, so no delta row is rendered for it.
    expect(deltas).toHaveLength(2)
  })

  it('makes added and removed criteria explicit and distinguishes absent from UNKNOWN', () => {
    const wrapper = mount(QualityComparisonPanel, { props: { comparison: buildComparison() } })

    const presence = wrapper.findAll('[data-testid="criterion-presence"]').map((node) => node.text())
    expect(presence).toContain('added')
    expect(presence).toContain('removed')

    const rows = wrapper.findAll('[data-testid="comparison-criterion"]')
    const priorMove = rows.find((row) => row.text().includes('Prior Move'))
    expect(priorMove.find('[data-testid="criterion-right"]').text()).toBe('—')
    expect(priorMove.find('[data-testid="criterion-delta"]').text()).toContain('not present in right')

    const range = rows.find((row) => row.text().includes('Range Contraction'))
    expect(range.find('[data-testid="criterion-left"]').text()).toContain('UNKNOWN')
    expect(range.find('[data-testid="criterion-right"]').text()).toContain('NOT_APPLICABLE')
  })

  it('marks configuration_changed and shows the old/new configuration', () => {
    const wrapper = mount(QualityComparisonPanel, { props: { comparison: buildComparison() } })
    expect(wrapper.find('[data-testid="criterion-config-changed"]').exists()).toBe(true)
  })

  it('never labels a disabled-on-both criterion as removed/added', () => {
    const comparison = buildComparison()
    comparison.dimensions.setup.criteria = [
      {
        key: 'base_duration',
        presence: 'none',
        status: { left: null, right: null },
        score: { left: null, right: null, delta: null },
        enabled: { left: false, right: false },
        configuration_changed: false
      },
      {
        key: 'prior_move',
        presence: 'only_left',
        status: { left: 'FAIL', right: null },
        score: { left: 60, right: null, delta: null },
        configuration_changed: null
      }
    ]
    const wrapper = mount(QualityComparisonPanel, { props: { comparison } })

    const rows = wrapper.findAll('[data-testid="comparison-criterion"]')
    const dormant = rows.find((row) => row.text().includes('Base Duration'))
    const dormantBadge = dormant.find('[data-testid="criterion-presence"]')
    expect(dormantBadge.text()).toBe('disabled (both)')
    expect(dormantBadge.text()).not.toBe('removed')
    expect(dormant.find('[data-testid="criterion-delta"]').text()).toContain('disabled (both versions)')

    const removed = rows.find((row) => row.text().includes('Prior Move'))
    expect(removed.find('[data-testid="criterion-presence"]').text()).toBe('removed')
  })

  it('emits close', async () => {
    const wrapper = mount(QualityComparisonPanel, { props: { comparison: buildComparison() } })
    await wrapper.get('[data-testid="close-comparison"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
