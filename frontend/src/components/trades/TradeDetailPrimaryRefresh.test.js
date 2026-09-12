import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent, reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import TradeSetupQualitySummary from './TradeSetupQualitySummary.vue'
import QualityEvaluationHistory from './QualityEvaluationHistory.vue'
import { applyPrimaryChange, QUALITY_SOURCE } from '@/utils/tradeQualitySummary'

let historyStore
let setupStore

beforeEach(() => {
  setActivePinia(createPinia())
})

vi.mock('@/stores/qualityHistory', () => ({
  useQualityHistoryStore: () => historyStore
}))

vi.mock('@/stores/qualitySetup', () => ({
  useQualitySetupStore: () => setupStore
}))

function historyRow(overrides = {}) {
  return {
    id: 'eval-c',
    status: 'completed',
    profile_id: 'profile-1',
    profile_name: 'Canonical BO',
    profile_version_id: 'v3',
    version_number: 3,
    current_version_id: 'v3',
    current_version_number: 3,
    is_current_version: true,
    is_primary: false,
    setup_score: 72,
    setup_grade: 'C',
    setup_compliance: 'FAIL',
    setup_coverage: 95,
    entry_score: null,
    entry_grade: null,
    entry_compliance: null,
    entry_coverage: null,
    management_score: null,
    management_grade: null,
    management_compliance: null,
    management_coverage: null,
    created_at: '2026-09-03T10:00:00Z',
    evaluated_at: '2026-09-03T10:05:00Z',
    ...overrides
  }
}

function createHistoryStore() {
  return reactive({
    loading: false,
    starting: false,
    selectingPrimary: false,
    comparing: false,
    error: null,
    evaluations: [],
    versions: [],
    comparison: null,
    fetchEvaluations: vi.fn().mockResolvedValue([]),
    fetchVersions: vi.fn(),
    startEvaluation: vi.fn(),
    selectPrimary: vi.fn(),
    compareEvaluations: vi.fn(),
    $reset: vi.fn()
  })
}

// Mirrors TradeDetailView's wiring: the same shared applyPrimaryChange helper
// patches the trade object from the QualityEvaluationHistory event, and a
// fallback refetch reconciles when a successful selection carried no summary.
const Parent = defineComponent({
  components: { TradeSetupQualitySummary, QualityEvaluationHistory },
  props: { refresh: { type: Function, default: null } },
  setup(props) {
    const trade = reactive({
      id: 'trade-1',
      qualityGrade: 'A',
      qualityScore: 4.7,
      qualityMetrics: { coverage: 0.9 },
      qualitySummary: {
        source: QUALITY_SOURCE.LEGACY,
        setup: { grade: 'A', score: 4.7, compliance: null, coverage: 90, scoreScale: 5 },
        entry: null,
        management: null,
        profile: null
      }
    })
    async function onPrimaryChanged(payload) {
      const applied = applyPrimaryChange(trade, payload)
      if (!applied && props.refresh) {
        const fresh = await props.refresh()
        if (fresh && Object.prototype.hasOwnProperty.call(fresh, 'qualitySummary')) {
          trade.qualitySummary = fresh.qualitySummary
        }
      }
    }
    return { trade, onPrimaryChanged }
  },
  template: `
    <div>
      <TradeSetupQualitySummary :trade="trade" :calculating="false" />
      <QualityEvaluationHistory :trade="trade" @primary-changed="onPrimaryChanged" />
    </div>
  `
})

const SUMMARY_C = {
  source: QUALITY_SOURCE.PROFILE_PRIMARY,
  setup: { score: 72, grade: 'C', compliance: 'FAIL', coverage: 95, scoreScale: 100 },
  entry: null,
  management: null,
  profile: { profileName: 'Canonical BO', versionNumber: 3 }
}

const SUMMARY_NULL_GRADE = {
  source: QUALITY_SOURCE.PROFILE_PRIMARY,
  setup: { score: null, grade: null, compliance: 'INCOMPLETE', coverage: 40, scoreScale: 100 },
  entry: null,
  management: null,
  profile: { profileName: 'Canonical BO', versionNumber: 3 }
}

function mountHarness(props = {}) {
  return mount(Parent, { props })
}

describe('Trade Detail primary refresh contract', () => {
  beforeEach(() => {
    historyStore = createHistoryStore()
    setupStore = reactive({ prepare: vi.fn().mockResolvedValue({}), error: null })
    historyStore.evaluations = [historyRow()]
    historyStore.fetchEvaluations.mockImplementation(async () => historyStore.evaluations)
  })

  it('starts on legacy A, then immediately shows primary C after Set Primary without reload', async () => {
    historyStore.selectPrimary.mockResolvedValue({ primary: { evaluation_id: 'eval-c' }, qualitySummary: SUMMARY_C })
    const wrapper = mountHarness()
    await flushPromises()

    // Legacy start state.
    expect(wrapper.find('[data-testid="profile-setup-quality"]').exists()).toBe(false)

    await wrapper.get('[data-testid="set-primary"]').trigger('click')
    await flushPromises()

    const profile = wrapper.get('[data-testid="profile-setup-quality"]')
    expect(profile.text()).toContain('Grade C')
    expect(profile.text()).toContain('72 / 100')
    expect(profile.text()).toContain('Canonical BO v3')
    // Legacy A preserved in the clearly-labelled block, not as the current grade.
    expect(wrapper.get('[data-testid="legacy-setup-quality"]').text()).toContain('Grade A')
  })

  it('switching to another primary updates the display in place', async () => {
    const wrapper = mountHarness()
    await flushPromises()

    historyStore.selectPrimary.mockResolvedValue({
      primary: { evaluation_id: 'eval-c' },
      qualitySummary: SUMMARY_C
    })
    await wrapper.get('[data-testid="set-primary"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="profile-setup-quality"]').text()).toContain('Grade C')

    historyStore.evaluations = [historyRow({ id: 'eval-b', is_primary: true, setup_grade: 'B', setup_score: 85 })]
    historyStore.selectPrimary.mockResolvedValue({
      primary: { evaluation_id: 'eval-b' },
      qualitySummary: {
        ...SUMMARY_C,
        setup: { score: 85, grade: 'B', compliance: 'PASS', coverage: 100, scoreScale: 100 }
      }
    })
    await wrapper.get('[data-testid="set-primary"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="profile-setup-quality"]').text()).toContain('Grade B')
  })

  it('a primary with NULL Setup grade shows N/A and never falls back to legacy A', async () => {
    historyStore.selectPrimary.mockResolvedValue({
      primary: { evaluation_id: 'eval-c' },
      qualitySummary: SUMMARY_NULL_GRADE
    })
    const wrapper = mountHarness()
    await flushPromises()

    await wrapper.get('[data-testid="set-primary"]').trigger('click')
    await flushPromises()

    const profile = wrapper.get('[data-testid="profile-setup-quality"]')
    expect(profile.text()).toContain('N/A')
    // The effective (first) badge is N/A, not the preserved legacy grade.
    expect(profile.findAll('span')[0].text()).toBe('N/A')
    // Legacy A stays separately preserved in its labelled block.
    expect(wrapper.get('[data-testid="legacy-setup-quality"]').text()).toContain('Grade A')
  })

  it('does not change the display when the selection is rejected', async () => {
    historyStore.selectPrimary.mockRejectedValue(new Error('forbidden'))
    const wrapper = mountHarness()
    await flushPromises()

    await wrapper.get('[data-testid="set-primary"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="profile-setup-quality"]').exists()).toBe(false)
    // Legacy A still shown as the legacy-only display.
    expect(wrapper.text()).toContain('Grade A')
  })

  it('refetches the backend-resolved summary when a successful selection carries no summary', async () => {
    historyStore.selectPrimary.mockResolvedValue({ primary: { evaluation_id: 'eval-c' }, qualitySummary: null })
    const refresh = vi.fn().mockResolvedValue({ id: 'trade-1', qualitySummary: SUMMARY_C })
    const wrapper = mountHarness({ refresh })
    await flushPromises()

    await wrapper.get('[data-testid="set-primary"]').trigger('click')
    await flushPromises()

    expect(refresh).toHaveBeenCalled()
    // Reconciled from the backend, NOT by falling back to legacy A.
    expect(wrapper.get('[data-testid="profile-setup-quality"]').text()).toContain('Grade C')
  })
})
