import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import ManagementQualitySection from './ManagementQualitySection.vue'

let mockStoreInstance

vi.mock('@/stores/qualityManagement', () => ({
  useQualityManagementStore: () => mockStoreInstance
}))

function createStoreState() {
  return reactive({
    preparing: false,
    evaluating: false,
    finalizing: false,
    loading: false,
    error: null,
    prepared: null,
    evaluation: null,
    evaluations: [],
    prepare: vi.fn(),
    evaluate: vi.fn(),
    finalize: vi.fn(),
    fetchEvaluations: vi.fn(),
    $reset: vi.fn()
  })
}

const TRADE = { id: 'trade-1', user_id: 'user-1', symbol: 'TEST' }

function setupResult() {
  return { score: 96, grade: 'A', compliance: 'PASS', coverage: 100, criterionResults: [] }
}

function entryResult() {
  return { score: 88, grade: 'B', compliance: 'PASS', coverage: 100, criterionResults: [] }
}

function managementResult(overrides = {}) {
  return {
    score: 72,
    grade: 'C',
    compliance: 'INCOMPLETE',
    coverage: 70,
    criterionResults: [
      { key: 'partial_timing', status: 'PASS', score: 100, required: true, weight: 20, message: 'Completed during trigger session.' },
      { key: 'partial_sizing', status: 'PASS', score: 100, required: true, weight: 15, message: '50% reduced.' },
      { key: 'no_premature_reduction', status: 'PASS', score: 100, required: true, weight: 10, message: 'No early reduction.' },
      { key: 'stop_ratchet', status: 'UNKNOWN', score: null, required: true, weight: 20, message: 'No stop-order lifecycle.' },
      { key: 'post_partial_breakeven', status: 'UNKNOWN', score: null, required: true, weight: 15, message: 'No stop-order lifecycle.' },
      { key: 'trailing_ma', status: 'NOT_APPLICABLE', score: null, required: true, weight: 20, message: 'Superseded by protective stop.' }
    ],
    ...overrides
  }
}

function persistedEvaluation(overrides = {}) {
  return {
    id: 'eval-1',
    status: 'draft',
    profile_name: 'Canonical BO',
    version_number: 1,
    results: { setup: setupResult(), entry: entryResult(), management: managementResult() },
    user_inputs: { trailing_ma_period: 20 },
    detected_context: {
      management: { trailing_ma: { value: 20, source: 'user_asserted', timing: 'post_trade' } }
    },
    evidence_snapshot: {
      entry: {
        execution: { entry_basis: 101, original_position_qty: 200 },
        initial_r: { available: true, r_per_share: 2 }
      },
      management: { stop_history: { available: false } }
    },
    ...overrides
  }
}

function preparedPayload(overrides = {}) {
  return {
    evaluation: { id: 'eval-1', status: 'draft' },
    profileVersion: { id: 'version-1', profileName: 'Canonical BO', versionNumber: 1 },
    entryDependency: { ready: true, entryBasis: 101, originalPositionQty: 200, initialR: { available: true, r_per_share: 2 } },
    trailingMa: { value: null, established: false },
    allowedTrailingPeriods: [10, 20],
    requiredManagementUserInputs: ['trailing_ma_period'],
    ...overrides
  }
}

function mountSection() {
  return mount(ManagementQualitySection, { props: { trade: TRADE } })
}

describe('ManagementQualitySection', () => {
  beforeEach(() => {
    mockStoreInstance = createStoreState()
  })

  it('gates on Entry Quality when no Entry result exists', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([{ id: 'eval-1', status: 'draft', results: { setup: setupResult(), entry: null } }])
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.get('[data-testid="entry-required"]').text()).toContain('Evaluate Setup and Entry Quality first')
  })

  it('shows the trailing MA selector before selection is established', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([{ id: 'eval-1', status: 'draft', results: { setup: setupResult(), entry: entryResult(), management: null } }])
    mockStoreInstance.prepare.mockResolvedValue(preparedPayload())
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-management"]').trigger('click')
    await flushPromises()

    const options = wrapper.get('[data-testid="mgmt-trailing-select"]').findAll('option')
    expect(options.map((option) => option.element.value).filter(Boolean)).toEqual(['10', '20'])
  })

  it('evaluates with the selected trailing MA and renders Management summaries', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([{ id: 'eval-1', status: 'draft', results: { setup: setupResult(), entry: entryResult(), management: null } }])
    mockStoreInstance.prepare.mockResolvedValue(preparedPayload())
    mockStoreInstance.evaluate.mockResolvedValue({ evaluation: persistedEvaluation() })
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-management"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="mgmt-trailing-select"]').setValue('20')
    await wrapper.get('[data-testid="run-management"]').trigger('click')
    await flushPromises()

    expect(mockStoreInstance.evaluate).toHaveBeenCalledWith('trade-1', {
      evaluationId: 'eval-1',
      userInputs: { trailing_ma_period: 20 }
    })
    expect(wrapper.get('[data-testid="mgmt-score"]').text()).toBe('72')
    expect(wrapper.get('[data-testid="mgmt-compliance"]').text()).toBe('INCOMPLETE')
    expect(wrapper.findAll('[data-testid="mgmt-criterion-row"]')).toHaveLength(6)
  })

  it('distinguishes UNKNOWN from NOT_APPLICABLE and explains unavailable stop history', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([persistedEvaluation()])
    const wrapper = mountSection()
    await flushPromises()

    const text = wrapper.text()
    expect(text).toContain('UNKNOWN')
    expect(text).toContain('NOT_APPLICABLE')
    expect(wrapper.find('[data-testid="mgmt-stop-history-note"]').exists()).toBe(true)
  })

  it('locks the trailing MA selection once established', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([persistedEvaluation()])
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="mgmt-trailing-select"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="mgmt-trailing-locked"]').text()).toContain('SMA20')
  })

  it('offers Complete Evaluation only when all three dimensions are present', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([persistedEvaluation()])
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="finalize-evaluation"]').exists()).toBe(true)
  })

  it('shows the activation assertion for explicit activation and allows N/A without an SMA', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([{ id: 'eval-1', status: 'draft', results: { setup: setupResult(), entry: entryResult(), management: null } }])
    mockStoreInstance.prepare.mockResolvedValue(preparedPayload({
      policy: { trailingActivation: 'explicit', available: { trailing: true } },
      requiredManagementUserInputs: ['trailing_ma_period', 'trailing_phase'],
      trailingMa: { value: null, established: false, phase: null, phaseEstablished: false }
    }))
    mockStoreInstance.evaluate.mockResolvedValue({ evaluation: persistedEvaluation({ user_inputs: { trailing_phase: 'not_activated' } }) })
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-management"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="mgmt-phase-select"]').exists()).toBe(true)
    await wrapper.get('[data-testid="mgmt-phase-select"]').setValue('not_activated')
    await wrapper.get('[data-testid="run-management"]').trigger('click')
    await flushPromises()

    expect(mockStoreInstance.evaluate).toHaveBeenCalledWith('trade-1', {
      evaluationId: 'eval-1',
      userInputs: { trailing_phase: 'not_activated' }
    })
  })

  it('explains the after-partial activation basis', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([{ id: 'eval-1', status: 'draft', results: { setup: setupResult(), entry: entryResult(), management: null } }])
    mockStoreInstance.prepare.mockResolvedValue(preparedPayload({
      policy: { trailingActivation: 'after_partial', available: { trailing: true } }
    }))
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-management"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="mgmt-activation-after-partial"]').exists()).toBe(true)
  })

  it('collects the activation session for an explicit activated phase', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([{ id: 'eval-1', status: 'draft', results: { setup: setupResult(), entry: entryResult(), management: null } }])
    mockStoreInstance.prepare.mockResolvedValue(preparedPayload({
      policy: { trailingActivation: 'explicit', available: { trailing: true } },
      requiredManagementUserInputs: ['trailing_ma_period', 'trailing_phase', 'trailing_activation_session'],
      trailingMa: { value: null, established: false, phase: null, phaseEstablished: false, activationSession: null, activationSessionEstablished: false, smaRequired: true }
    }))
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-management"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="mgmt-phase-select"]').setValue('activated')
    await flushPromises()
    expect(wrapper.find('[data-testid="mgmt-activation-session"]').exists()).toBe(true)

    await wrapper.get('[data-testid="mgmt-activation-session"]').setValue('2026-03-12')
    await wrapper.get('[data-testid="mgmt-trailing-select"]').setValue('20')
    await wrapper.get('[data-testid="run-management"]').trigger('click')
    await flushPromises()

    expect(mockStoreInstance.evaluate).toHaveBeenCalledWith('trade-1', {
      evaluationId: 'eval-1',
      userInputs: { trailing_phase: 'activated', trailing_activation_session: '2026-03-12', trailing_ma_period: 20 }
    })
  })

  it('does not require an SMA when prepare reports the canonical phase is not applicable', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([{ id: 'eval-1', status: 'draft', results: { setup: setupResult(), entry: entryResult(), management: null } }])
    mockStoreInstance.prepare.mockResolvedValue(preparedPayload({
      policy: { trailingActivation: 'after_partial', available: { trailing: true } },
      requiredManagementUserInputs: [],
      trailingMa: { value: null, established: false, smaRequired: false, applicabilityReason: 'partial_never_triggered' }
    }))
    mockStoreInstance.evaluate.mockResolvedValue({ evaluation: persistedEvaluation() })
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-management"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="mgmt-trailing-select"]').exists()).toBe(false)
    await wrapper.get('[data-testid="run-management"]').trigger('click')
    await flushPromises()
    expect(mockStoreInstance.evaluate).toHaveBeenCalledWith('trade-1', {
      evaluationId: 'eval-1',
      userInputs: {}
    })
  })
})
