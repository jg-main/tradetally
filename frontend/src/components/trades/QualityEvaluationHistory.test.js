import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import QualityEvaluationHistory from './QualityEvaluationHistory.vue'
import { useQualityWorkflowStore } from '@/stores/qualityWorkflow'

let historyStore
let setupStore

// The history panel also reads the shared active-evaluation workflow store.
beforeEach(() => {
  setActivePinia(createPinia())
})

vi.mock('@/stores/qualityHistory', () => ({
  useQualityHistoryStore: () => historyStore
}))

vi.mock('@/stores/qualitySetup', () => ({
  useQualitySetupStore: () => setupStore
}))

const TRADE = { id: 'trade-1', symbol: 'TEST' }

function historyRow(overrides = {}) {
  return {
    id: 'eval-1',
    status: 'completed',
    profile_id: 'profile-1',
    profile_name: 'Canonical BO',
    profile_version_id: 'v1',
    version_number: 1,
    schema_version: 1,
    current_version_id: 'v2',
    current_version_number: 2,
    is_current_version: false,
    is_primary: false,
    setup_score: 91,
    setup_grade: 'A',
    setup_compliance: 'PASS',
    setup_coverage: 100,
    entry_score: 95,
    entry_grade: 'A',
    entry_compliance: 'PASS',
    entry_coverage: 92,
    management_score: 87,
    management_grade: 'B',
    management_compliance: 'FAIL',
    management_coverage: 85,
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

function createSetupStore() {
  return reactive({
    prepare: vi.fn().mockResolvedValue({}),
    error: null
  })
}

function mountSection() {
  return mount(QualityEvaluationHistory, { props: { trade: TRADE } })
}

describe('QualityEvaluationHistory', () => {
  beforeEach(() => {
    historyStore = createHistoryStore()
    setupStore = createSetupStore()
    // Return whatever the test seeded; the component's onMounted load must not
    // clobber the test fixture.
    historyStore.fetchEvaluations.mockImplementation(async () => historyStore.evaluations)
  })

  it('renders version, status, primary badge, current-version indicator, and the three dimensions', async () => {
    historyStore.evaluations = [historyRow({ is_primary: true })]
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.text()).toContain('Canonical BO v1')
    expect(wrapper.get('[data-testid="primary-badge"]').text()).toBe('PRIMARY')
    expect(wrapper.get('[data-testid="history-status"]').text()).toBe('COMPLETED')
    expect(wrapper.find('[data-testid="history-setup"]').text()).toContain('A 91')
    expect(wrapper.find('[data-testid="history-entry"]').text()).toContain('A 95')
    expect(wrapper.find('[data-testid="history-management"]').text()).toContain('B 87')
    // No combined overall grade anywhere.
    expect(wrapper.text()).not.toMatch(/overall/i)
  })

  it('renders UNKNOWN / INCOMPLETE / N/A honestly without an overall grade', async () => {
    historyStore.evaluations = [
      historyRow({
        status: 'draft',
        setup_grade: null,
        setup_score: null,
        setup_compliance: 'INCOMPLETE',
        setup_coverage: 50,
        entry_grade: null,
        entry_score: null,
        entry_compliance: null,
        entry_coverage: null,
        management_grade: null,
        management_score: null,
        management_compliance: null,
        management_coverage: null,
        is_primary: false
      })
    ]
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="history-setup"]').text()).toContain('N/A')
    expect(wrapper.find('[data-testid="history-setup"]').text()).toContain('INCOMPLETE')
    expect(wrapper.find('[data-testid="history-entry"]').text()).toContain('N/A')
    expect(wrapper.get('[data-testid="history-status"]').text()).toBe('DRAFT')
  })

  it('offers Set Primary only for a terminal, non-primary evaluation', async () => {
    historyStore.evaluations = [historyRow({ status: 'completed', is_primary: false })]
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.get('[data-testid="set-primary"]').trigger('click')
    await flushPromises()

    expect(historyStore.selectPrimary).toHaveBeenCalledWith('trade-1', 'eval-1')
  })

  it('emits primary-changed with the backend-resolved summary after a successful selection', async () => {
    historyStore.evaluations = [historyRow({ status: 'completed', is_primary: false })]
    historyStore.selectPrimary.mockResolvedValue({
      primary: { evaluation_id: 'eval-1' },
      qualitySummary: { source: 'profile_primary', setup: { grade: 'C', score: 72, compliance: 'FAIL', coverage: 95 } }
    })
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.get('[data-testid="set-primary"]').trigger('click')
    await flushPromises()

    const emitted = wrapper.emitted('primary-changed')
    expect(emitted).toHaveLength(1)
    expect(emitted[0][0].qualitySummary.setup.grade).toBe('C')
  })

  it('does not emit primary-changed when the selection is rejected', async () => {
    historyStore.evaluations = [historyRow({ status: 'completed', is_primary: false })]
    historyStore.selectPrimary.mockRejectedValue(new Error('forbidden'))
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.get('[data-testid="set-primary"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('primary-changed')).toBeUndefined()
  })

  it('does not offer Set Primary for a draft row', async () => {
    historyStore.evaluations = [historyRow({ status: 'draft', is_primary: false })]
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="set-primary"]').exists()).toBe(false)
  })

  it('Evaluate with current version starts a new pinned evaluation and switches the workflow', async () => {
    historyStore.evaluations = [historyRow()]
    historyStore.startEvaluation.mockResolvedValue({ id: 'eval-new', status: 'draft' })
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.get('[data-testid="current-version-note"]').text()).toContain('v2')
    await wrapper.get('[data-testid="evaluate-with-current"]').trigger('click')
    await flushPromises()

    expect(historyStore.startEvaluation).toHaveBeenCalledWith('trade-1', 'v2')
    expect(setupStore.prepare).toHaveBeenCalledWith('trade-1', { evaluationId: 'eval-new' })
    // The new evaluation becomes the single active workflow row.
    expect(useQualityWorkflowStore().activeEvaluationId).toBe('eval-new')
    // History is refreshed (activate + explicit refresh) and the old evaluation
    // remains present.
    expect(historyStore.fetchEvaluations.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(historyStore.selectPrimary).not.toHaveBeenCalled()
  })

  it('refreshes history when the active evaluation progresses or finalizes', async () => {
    historyStore.evaluations = [historyRow({ id: 'eval-new', status: 'draft' })]
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'eval-new', trade_id: 'trade-1', status: 'draft' })
    mountSection()
    await flushPromises()
    const before = historyStore.fetchEvaluations.mock.calls.length

    // Simulates Setup/Entry/Management publishing progress and finalize.
    workflow.updateActive({ id: 'eval-new', trade_id: 'trade-1', status: 'completed' })

    await flushPromises()
    expect(historyStore.fetchEvaluations.mock.calls.length).toBeGreaterThan(before)
  })

  it('does not offer Evaluate with newer version when the row is already the current version', async () => {
    historyStore.evaluations = [
      historyRow({ is_current_version: true, profile_version_id: 'v2', version_number: 2, current_version_number: 2 })
    ]
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="evaluate-with-current"]').exists()).toBe(false)
  })

  it('compares two selected evaluations and renders the comparison panel', async () => {
    historyStore.evaluations = [
      historyRow({ id: 'eval-1', evaluated_at: '2026-09-03T10:05:00Z' }),
      historyRow({ id: 'eval-2', version_number: 3, evaluated_at: '2026-09-11T10:05:00Z' })
    ]
    historyStore.compareEvaluations.mockImplementation(async () => {
      historyStore.comparison = {
        trade_id: 'trade-1',
        left: { profile_name: 'Canonical BO', version_number: 1, status: 'completed', evaluated_at: null, created_at: null, is_primary: false },
        right: { profile_name: 'Canonical BO', version_number: 3, status: 'completed', evaluated_at: null, created_at: null, is_primary: false },
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
              }
            ]
          },
          entry: { dimension: 'entry', left: {}, right: {}, score_delta: null, coverage_delta: null, criteria: [] },
          management: { dimension: 'management', left: {}, right: {}, score_delta: null, coverage_delta: null, criteria: [] }
        }
      }
      return historyStore.comparison
    })

    const wrapper = mountSection()
    await flushPromises()

    const compareButtons = wrapper.findAll('[data-testid="compare"]')
    await compareButtons[0].trigger('click')
    await compareButtons[1].trigger('click')
    await flushPromises()

    expect(historyStore.compareEvaluations).toHaveBeenCalledWith('trade-1', 'eval-1', 'eval-2')
    expect(wrapper.find('[data-testid="comparison-panel"]').exists()).toBe(true)
    const criteria = wrapper.findAll('[data-testid="comparison-criterion"]')
    expect(criteria).toHaveLength(3)
    expect(wrapper.text()).toContain('added')
    expect(wrapper.text()).toContain('removed')
    expect(wrapper.text()).toContain('config changed')
  })

  it('a newly completed evaluation is not auto-promoted to primary', async () => {
    historyStore.evaluations = [historyRow({ id: 'eval-1', is_primary: true }), historyRow({ id: 'eval-2', is_primary: false })]
    mountSection()
    await flushPromises()

    expect(historyStore.selectPrimary).not.toHaveBeenCalled()
    expect(historyStore.evaluations.find((row) => row.id === 'eval-1').is_primary).toBe(true)
  })
})
