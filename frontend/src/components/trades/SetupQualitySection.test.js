import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import SetupQualitySection from './SetupQualitySection.vue'
import { useQualityWorkflowStore } from '@/stores/qualityWorkflow'

let mockStoreInstance

// The section also reads the shared active-evaluation workflow store.
beforeEach(() => {
  setActivePinia(createPinia())
})

vi.mock('@/stores/qualitySetup', () => ({
  useQualitySetupStore: () => mockStoreInstance
}))

function createStoreState() {
  return reactive({
    preparing: false,
    evaluating: false,
    loading: false,
    error: null,
    prepared: null,
    evaluation: null,
    evaluations: [],
    prepare: vi.fn(),
    evaluate: vi.fn(),
    fetchEvaluations: vi.fn(),
    $reset: vi.fn()
  })
}

const TRADE = { id: 'trade-1', user_id: 'user-1', symbol: 'TEST' }

function detectedPayload() {
  return {
    evaluation: { id: 'eval-1', status: 'draft' },
    profile: { id: 'profile-1', name: 'Canonical BO' },
    profileVersion: { id: 'version-1', versionNumber: 1, schemaVersion: 1 },
    setupCriterionKeys: ['leader', 'prior_move', 'base_duration', 'higher_lows', 'range_contraction', 'volume_contraction', 'ma_trend', 'pivot_quality'],
    detectedBaseStart: { date: '2026-03-12', price: 102 },
    detectedPivot: {
      date: '2026-03-12',
      price: 102,
      detectionConfidence: 'high',
      method: 'cluster',
      derivedFromBaseStart: '2026-03-12'
    },
    pivotBaseStartDate: '2026-03-12',
    pivotBaseStartSource: 'detected',
    evidence: { symbol: 'TEST', source: 'finnhub', sessionCount: 130 },
    requiredUserInputs: ['leader_confirmed', 'base_start', 'pivot'],
    unavailableEvidence: []
  }
}

function evaluationResult(overrides = {}) {
  return {
    id: 'eval-1',
    status: 'draft',
    setup_compliance: 'PASS',
    setup_grade: 'A',
    setup_coverage: 100,
    results: {
      setup: {
        score: 96.15,
        grade: 'A',
        compliance: 'PASS',
        coverage: 100,
        criterionResults: [
          { key: 'leader', status: 'PASS', score: 100, required: true, weight: 20, message: 'Leader confirmed.' },
          { key: 'prior_move', status: 'PASS', score: 100, required: true, weight: 20, message: 'Prior move of 104%.' },
          { key: 'base_duration', status: 'PASS', score: 100, required: true, weight: 5, message: '25 sessions.' },
          { key: 'higher_lows', status: 'PASS', score: 100, required: true, weight: 10, message: 'Higher lows held.' },
          { key: 'range_contraction', status: 'PASS', score: 75, required: true, weight: 15, message: 'Ratio 0.58.' },
          { key: 'volume_contraction', status: 'PASS', score: 100, required: true, weight: 15, message: 'Volume ratio 0.21.' },
          { key: 'ma_trend', status: 'PASS', score: 100, required: true, weight: 5, message: 'All components pass.' },
          { key: 'pivot_quality', status: 'PASS', score: 96.12, required: true, weight: 10, message: 'Pivot quality passes.' }
        ]
      }
    },
    ...overrides
  }
}

function mountSection() {
  return mount(SetupQualitySection, {
    props: { trade: TRADE }
  })
}

describe('SetupQualitySection', () => {
  beforeEach(() => {
    mockStoreInstance = createStoreState()
  })

  it('shows an empty state with a Prepare CTA when nothing has been prepared', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([])
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.get('[data-testid="prepare-setup"]').text()).toContain('Prepare Setup')
    expect(wrapper.text()).toContain('detects the Base Start and Pivot')
  })

  it('displays the profile/version, detected Base Start and detected Pivot after prepare', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([])
    mockStoreInstance.prepare.mockResolvedValue(detectedPayload())
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Canonical BO v1')
    expect(wrapper.text()).toContain('2026-03-12')
    expect(wrapper.text()).toContain('confidence high')
    expect(wrapper.get('[data-testid="confirm-base-start"]').exists()).toBe(true)
    expect(wrapper.get('[data-testid="confirm-pivot"]').exists()).toBe(true)
  })

  it('runs Setup Quality with the confirmed semantic inputs and renders results', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([])
    mockStoreInstance.prepare.mockResolvedValue(detectedPayload())
    mockStoreInstance.evaluate.mockResolvedValue({ evaluation: evaluationResult() })

    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="leader-yes"]').setValue(true)
    await wrapper.get('[data-testid="confirm-base-start"]').trigger('click')
    await wrapper.get('[data-testid="confirm-pivot"]').trigger('click')
    await wrapper.get('[data-testid="run-setup"]').trigger('click')
    await flushPromises()

    expect(mockStoreInstance.evaluate).toHaveBeenCalledWith('trade-1', {
      evaluationId: 'eval-1',
      userInputs: {
        leader_confirmed: true,
        base_start: { date: '2026-03-12', source: 'detected_confirmed' },
        pivot: expect.objectContaining({ price: 102, source: 'detected_confirmed' })
      }
    })

    expect(wrapper.get('[data-testid="setup-score"]').text()).toBe('96.15')
    expect(wrapper.get('[data-testid="setup-grade"]').text()).toBe('A')
    expect(wrapper.get('[data-testid="setup-compliance"]').text()).toBe('PASS')
    expect(wrapper.get('[data-testid="setup-coverage"]').text()).toBe('100%')
    expect(wrapper.findAll('[data-testid="criterion-row"]')).toHaveLength(8)
    expect(wrapper.text()).toContain('SMA Trend Structure')
  })

  it('restores persisted results and renders FAIL / UNKNOWN / INCOMPLETE states', async () => {
    const persisted = evaluationResult({
      setup_compliance: 'INCOMPLETE',
      setup_coverage: 85,
      results: {
        setup: {
          score: 66.67,
          grade: 'D',
          compliance: 'INCOMPLETE',
          coverage: 85,
          criterionResults: [
            { key: 'leader', status: 'PASS', score: 100, required: true, weight: 20, message: 'Leader confirmed.' },
            { key: 'prior_move', status: 'FAIL', score: 0, required: true, weight: 20, message: 'No qualifying impulse.' },
            { key: 'volume_contraction', status: 'UNKNOWN', score: null, required: true, weight: 15, message: 'Insufficient volume history.' }
          ]
        }
      }
    })
    mockStoreInstance.evaluations = [persisted]
    mockStoreInstance.evaluation = persisted
    mockStoreInstance.fetchEvaluations.mockResolvedValue([persisted])

    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.get('[data-testid="setup-score"]').text()).toBe('66.67')
    expect(wrapper.get('[data-testid="setup-grade"]').text()).toBe('D')
    expect(wrapper.get('[data-testid="setup-compliance"]').text()).toBe('INCOMPLETE')
    expect(wrapper.get('[data-testid="setup-coverage"]').text()).toBe('85%')
    expect(wrapper.text()).toContain('FAIL')
    expect(wrapper.text()).toContain('UNKNOWN')
    expect(wrapper.text()).toContain('Insufficient volume history.')
  })

  it('marks user-adjusted provenance and keeps the panel non-terminal', async () => {
    const persisted = evaluationResult({
      user_inputs: {
        leader_confirmed: true,
        base_start: { date: '2026-03-10', source: 'user_adjusted' },
        pivot: { price: 103, source: 'user_adjusted' }
      },
      results: {
        setup: {
          score: 90,
          grade: 'A',
          compliance: 'PASS',
          coverage: 100,
          criterionResults: []
        }
      }
    })
    mockStoreInstance.evaluations = [persisted]
    mockStoreInstance.evaluation = persisted
    mockStoreInstance.fetchEvaluations.mockResolvedValue([persisted])
    mockStoreInstance.prepare.mockResolvedValue(detectedPayload())

    const wrapper = mountSection()
    await flushPromises()

    // The persisted Setup summary is displayed even before a fresh prepare.
    expect(wrapper.get('[data-testid="setup-score"]').text()).toBe('90')

    // Re-detect, then the persisted user-adjusted Base Start is restored with
    // user-adjusted provenance (it differs from the newly detected date).
    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('User Adjusted')
    expect(wrapper.get('[data-testid="base-start-date-input"]').element.value).toBe('2026-03-10')
    expect(wrapper.text()).toContain('Draft progress')
  })

  it('displays profile + version from the persisted evaluation after a reload (no prepare needed)', async () => {
    const persisted = evaluationResult({
      profile_name: 'Canonical BO',
      version_number: 1
    })
    mockStoreInstance.evaluations = [persisted]
    mockStoreInstance.evaluation = persisted
    mockStoreInstance.fetchEvaluations.mockResolvedValue([persisted])

    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.text()).toContain('Canonical BO v1')
    expect(wrapper.get('[data-testid="setup-grade"]').text()).toBe('A')
  })

  it('drill-down reads persisted camelCase rawValue/scoringValue aggregate fields', async () => {
    const persisted = evaluationResult({
      results: {
        setup: {
          score: 75,
          grade: 'B',
          compliance: 'PASS',
          coverage: 100,
          criterionResults: [
            {
              key: 'range_contraction',
              status: 'PASS',
              score: 75,
              required: true,
              weight: 15,
              scoringValue: 0.5769,
              rawValue: 0.5769,
              message: 'Recent range contracted.',
              evidence: { contraction_ratio: 0.5769 }
            }
          ]
        }
      }
    })
    mockStoreInstance.evaluations = [persisted]
    mockStoreInstance.evaluation = persisted
    mockStoreInstance.fetchEvaluations.mockResolvedValue([persisted])

    const wrapper = mountSection()
    await flushPromises()

    // rawValue/scoringValue are present in the drill-down (textContent includes
    // the collapsed <details> payload).
    expect(wrapper.text()).toContain('0.5769')
    expect(wrapper.text()).toContain('Recent range contracted.')
  })

  it('an adjusted Base Start re-detects the Pivot from that Base Start before it can be confirmed', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([])
    mockStoreInstance.prepare
      .mockResolvedValueOnce(detectedPayload())
      .mockResolvedValueOnce({
        ...detectedPayload(),
        detectedPivot: {
          date: '2026-03-18',
          price: 103.5,
          detectionConfidence: 'high',
          method: 'cluster',
          derivedFromBaseStart: '2026-03-10'
        },
        pivotBaseStartDate: '2026-03-10',
        pivotBaseStartSource: 'user_adjusted',
        evaluation: {
          id: 'eval-1',
          status: 'draft',
          user_inputs: { base_start: { date: '2026-03-10', source: 'user_adjusted' } }
        }
      })

    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()

    // Confirm the detected Base Start first (machine date), then adjust it to
    // an earlier session.
    await wrapper.get('[data-testid="adjust-base-start"]').trigger('click')
    await wrapper.get('[data-testid="base-start-date-input"]').setValue('2026-03-10')
    await flushPromises()

    // The previously detected Pivot was derived from 2026-03-12, so confirming
    // it as machine-detected is no longer valid until re-detection.
    expect(wrapper.find('[data-testid="confirm-pivot"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="detect-pivot-with-base"]').exists()).toBe(true)

    await wrapper.get('[data-testid="detect-pivot-with-base"]').trigger('click')
    await flushPromises()

    expect(mockStoreInstance.prepare).toHaveBeenLastCalledWith('trade-1', {
      confirmedBaseStart: { date: '2026-03-10', source: 'user_adjusted' },
      // Phase 5: a re-prepare on a non-terminal evaluation stays pinned to it.
      evaluationId: 'eval-1'
    })
    expect(wrapper.text()).toContain('103.5')
    expect(wrapper.get('[data-testid="confirm-pivot"]').exists()).toBe(true)
  })

  it('prefers the explicitly active workflow evaluation over the discovered draft', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([
      { id: 'latest-1', status: 'draft', results: {} }
    ])
    mockStoreInstance.prepare.mockResolvedValue({
      evaluation: { id: 'active-99', status: 'draft', results: {} }
    })
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'active-99', trade_id: 'trade-1', status: 'draft' })

    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()

    expect(mockStoreInstance.prepare).toHaveBeenCalledWith(
      'trade-1',
      expect.objectContaining({ evaluationId: 'active-99' })
    )
  })

  it('adopts a replacement evaluation returned by prepare and evaluates that replacement', async () => {
    const terminal = evaluationResult({ id: 'E1', status: 'completed' })
    mockStoreInstance.fetchEvaluations.mockResolvedValue([terminal])
    mockStoreInstance.evaluation = terminal
    mockStoreInstance.prepare.mockResolvedValue({
      ...detectedPayload(),
      evaluation: { id: 'E2', status: 'draft' }
    })
    mockStoreInstance.evaluate.mockResolvedValue({
      evaluation: { id: 'E2', status: 'draft', results: { setup: { score: 88, grade: 'B' } } }
    })
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'completed' })

    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()

    // The returned fresh draft replaced the terminal row as the active workflow.
    expect(workflow.activeEvaluationId).toBe('E2')

    await wrapper.get('[data-testid="leader-yes"]').setValue(true)
    await wrapper.get('[data-testid="confirm-base-start"]').trigger('click')
    await wrapper.get('[data-testid="confirm-pivot"]').trigger('click')
    await wrapper.get('[data-testid="run-setup"]').trigger('click')
    await flushPromises()

    expect(mockStoreInstance.evaluate).toHaveBeenCalledWith(
      'trade-1',
      expect.objectContaining({ evaluationId: 'E2' })
    )
  })

  it('does not leak D1 Setup assertions into a fresh D2', async () => {
    const d1 = evaluationResult({
      id: 'D1',
      user_inputs: {
        leader_confirmed: true,
        base_start: { date: '2026-03-10', source: 'user_adjusted' },
        pivot: { price: 103, source: 'user_adjusted' }
      }
    })
    mockStoreInstance.fetchEvaluations.mockResolvedValue([d1])
    mockStoreInstance.evaluation = d1
    mockStoreInstance.prepare.mockResolvedValue({
      ...detectedPayload(),
      evaluation: { id: 'D1', status: 'draft' }
    })
    const workflow = useQualityWorkflowStore()
    workflow.activate({
      id: 'D1',
      trade_id: 'trade-1',
      status: 'draft',
      user_inputs: d1.user_inputs,
      results: d1.results
    })

    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()
    // D1 persisted assertions are visible.
    expect(wrapper.get('[data-testid="leader-yes"]').element.checked).toBe(true)
    expect(wrapper.get('[data-testid="base-start-date-input"]').element.value).toBe('2026-03-10')

    // Switch to a fresh evaluation with no persisted assertions.
    workflow.activate({
      id: 'D2',
      trade_id: 'trade-1',
      status: 'draft',
      user_inputs: null,
      results: null,
      detected_context: null
    })
    await flushPromises()

    // Re-prepare D2: no D1 assertion may survive.
    mockStoreInstance.prepare.mockResolvedValue({
      ...detectedPayload(),
      evaluation: { id: 'D2', status: 'draft' }
    })
    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="leader-yes"]').element.checked).toBe(false)
    // Base Start is not pre-confirmed from D1's user-adjusted value.
    expect(wrapper.find('[data-testid="base-start-date-input"]').exists()).toBe(false)
    // D2 cannot evaluate without its own required inputs.
    await wrapper.get('[data-testid="run-setup"]').trigger('click')
    await flushPromises()
    expect(mockStoreInstance.evaluate).not.toHaveBeenCalled()
  })

  it('clears evaluation-local Setup state when the workflow is cleared (trade change)', async () => {
    const persisted = evaluationResult({
      id: 'D1',
      user_inputs: { leader_confirmed: true }
    })
    mockStoreInstance.fetchEvaluations.mockResolvedValue([persisted])
    mockStoreInstance.evaluation = persisted
    mockStoreInstance.prepare.mockResolvedValue({
      ...detectedPayload(),
      evaluation: { id: 'D1', status: 'draft' }
    })
    const workflow = useQualityWorkflowStore()
    workflow.activate({
      id: 'D1',
      trade_id: 'trade-1',
      status: 'draft',
      user_inputs: persisted.user_inputs,
      results: persisted.results
    })

    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="leader-yes"]').element.checked).toBe(true)

    workflow.clear()
    await flushPromises()

    expect(wrapper.find('[data-testid="leader-yes"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="run-setup"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="prepare-setup"]').exists()).toBe(true)
  })

  it('resets locally-loaded D1 assertions when History activates a fresh E2 (workflow was null)', async () => {
    const d1 = evaluationResult({
      id: 'D1',
      user_inputs: {
        leader_confirmed: true,
        base_start: { date: '2026-03-10', source: 'user_adjusted' },
        pivot: { price: 103, source: 'user_adjusted' }
      }
    })
    mockStoreInstance.fetchEvaluations.mockResolvedValue([d1])
    mockStoreInstance.evaluation = d1
    mockStoreInstance.prepare.mockResolvedValue({
      ...detectedPayload(),
      evaluation: { id: 'E2', status: 'draft' }
    })
    const workflow = useQualityWorkflowStore()
    workflow.ensureTrade('trade-1')
    // Normal page load: the section discovers D1 locally while the workflow has
    // no active evaluation yet.
    const wrapper = mountSection()
    await flushPromises()

    // History "Evaluate with current version" activates a fresh E2.
    workflow.activate({
      id: 'E2',
      trade_id: 'trade-1',
      status: 'draft',
      user_inputs: null,
      results: null,
      detected_context: null
    })
    await flushPromises()

    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()

    // No D1 semantic field leaked into E2.
    expect(wrapper.get('[data-testid="leader-yes"]').element.checked).toBe(false)
    expect(wrapper.find('[data-testid="base-start-date-input"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="pivot-price-input"]').exists()).toBe(false)
    await wrapper.get('[data-testid="run-setup"]').trigger('click')
    await flushPromises()
    expect(mockStoreInstance.evaluate).not.toHaveBeenCalled()
  })

  it('does not erase locally-bound D1 state when the workflow activates the same D1', async () => {
    const d1 = evaluationResult({
      id: 'D1',
      user_inputs: {
        leader_confirmed: true,
        base_start: { date: '2026-03-10', source: 'user_adjusted' }
      }
    })
    mockStoreInstance.fetchEvaluations.mockResolvedValue([d1])
    mockStoreInstance.evaluation = d1
    mockStoreInstance.prepare.mockResolvedValue({
      ...detectedPayload(),
      evaluation: { id: 'D1', status: 'draft', user_inputs: d1.user_inputs }
    })
    const workflow = useQualityWorkflowStore()
    workflow.ensureTrade('trade-1')
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()
    expect(wrapper.get('[data-testid="leader-yes"]').element.checked).toBe(true)

    workflow.activate({
      id: 'D1',
      trade_id: 'trade-1',
      status: 'draft',
      user_inputs: d1.user_inputs,
      results: d1.results
    })
    await flushPromises()

    expect(wrapper.get('[data-testid="leader-yes"]').element.checked).toBe(true)
    expect(wrapper.get('[data-testid="base-start-date-input"]').element.value).toBe('2026-03-10')
  })

  it('a clear() while Setup prepare is in flight leaves the workflow cleared', async () => {
    const d1 = evaluationResult({ id: 'D1' })
    mockStoreInstance.fetchEvaluations.mockResolvedValue([d1])
    mockStoreInstance.evaluation = d1
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'D1', trade_id: 'trade-1', status: 'draft', results: d1.results })

    let resolvePrepare
    mockStoreInstance.prepare.mockReturnValue(
      new Promise((resolve) => {
        resolvePrepare = resolve
      })
    )

    const wrapper = mountSection()
    await flushPromises()
    wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()

    workflow.clear()
    await flushPromises()

    resolvePrepare({ ...detectedPayload(), evaluation: { id: 'E2', status: 'draft' } })
    await flushPromises()

    expect(workflow.activeEvaluationId).toBeNull()
    expect(workflow.activeEvaluation).toBeNull()
    // No stale hydration into local state.
    expect(wrapper.find('[data-testid="leader-yes"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="prepare-setup"]').exists()).toBe(true)
  })

  it('a trade change while Setup prepare is in flight ignores the late Trade-1 response', async () => {
    const d1 = evaluationResult({ id: 'D1' })
    mockStoreInstance.fetchEvaluations.mockResolvedValue([d1])
    mockStoreInstance.evaluation = d1
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'D1', trade_id: 'trade-1', status: 'draft', results: d1.results })

    let resolvePrepare
    mockStoreInstance.prepare.mockReturnValue(
      new Promise((resolve) => {
        resolvePrepare = resolve
      })
    )

    const wrapper = mountSection()
    await flushPromises()
    wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()

    workflow.ensureTrade('trade-2')
    await flushPromises()

    resolvePrepare({ ...detectedPayload(), evaluation: { id: 'E2', status: 'draft' } })
    await flushPromises()

    expect(workflow.activeTradeId).toBe('trade-2')
    expect(workflow.activeEvaluationId).toBeNull()
    expect(wrapper.find('[data-testid="leader-yes"]').exists()).toBe(false)
  })
})

describe('SetupQualitySection dynamic execution contract (requiredUserInputs)', () => {
  beforeEach(() => {
    mockStoreInstance = createStoreState()
  })

  function prepareThen(payload) {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([])
    mockStoreInstance.prepare.mockResolvedValue(payload)
    return mountSection()
  }

  async function runSetup(wrapper) {
    await flushPromises()
    await wrapper.get('[data-testid="prepare-setup"]').trigger('click')
    await flushPromises()
  }

  it('Leader disabled: Leader control is absent and evaluation proceeds with Base/Pivot only', async () => {
    const payload = {
      ...detectedPayload(),
      requiredUserInputs: ['base_start', 'pivot']
    }
    const wrapper = prepareThen(payload)
    await runSetup(wrapper)

    expect(wrapper.find('[data-testid="leader-yes"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="leader-no"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="confirm-base-start"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="confirm-pivot"]').exists()).toBe(true)

    mockStoreInstance.evaluate.mockResolvedValue({
      evaluation: evaluationResult({ results: { setup: { score: 90, grade: 'A', compliance: 'PASS', coverage: 100, criterionResults: [] } } })
    })
    await wrapper.get('[data-testid="confirm-base-start"]').trigger('click')
    await wrapper.get('[data-testid="confirm-pivot"]').trigger('click')
    await wrapper.get('[data-testid="run-setup"]').trigger('click')
    await flushPromises()

    const userInputs = mockStoreInstance.evaluate.mock.calls[0][1].userInputs
    expect(userInputs.leader_confirmed).toBeUndefined()
    expect(userInputs.base_start).toEqual({ date: '2026-03-12', source: 'detected_confirmed' })
    expect(userInputs.pivot).toEqual(expect.objectContaining({ price: 102, source: 'detected_confirmed' }))
  })

  it('Leader-only profile: only Leader is required and no structural inputs are sent', async () => {
    const payload = {
      ...detectedPayload(),
      requiredUserInputs: ['leader_confirmed'],
      detectedBaseStart: null,
      detectedPivot: null,
      pivotBaseStartDate: null,
      pivotBaseStartSource: null
    }
    const wrapper = prepareThen(payload)
    await runSetup(wrapper)

    expect(wrapper.find('[data-testid="leader-yes"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="confirm-base-start"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="confirm-pivot"]').exists()).toBe(false)

    mockStoreInstance.evaluate.mockResolvedValue({
      evaluation: evaluationResult({ results: { setup: { score: 100, grade: 'A', compliance: 'PASS', coverage: 100, criterionResults: [] } } })
    })
    await wrapper.get('[data-testid="leader-yes"]').setValue(true)
    await wrapper.get('[data-testid="run-setup"]').trigger('click')
    await flushPromises()

    const userInputs = mockStoreInstance.evaluate.mock.calls[0][1].userInputs
    expect(userInputs).toEqual({ leader_confirmed: true })
  })

  it('Canonical profile still shows and requires all three inputs', async () => {
    const wrapper = prepareThen(detectedPayload())
    await runSetup(wrapper)

    expect(wrapper.find('[data-testid="leader-yes"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="confirm-base-start"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="confirm-pivot"]').exists()).toBe(true)
  })
})
