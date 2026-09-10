import { mount, flushPromises } from '@vue/test-utils'
import { reactive } from 'vue'
import { describe, expect, it, beforeEach, vi } from 'vitest'
import EntryQualitySection from './EntryQualitySection.vue'

let mockStoreInstance

vi.mock('@/stores/qualityEntry', () => ({
  useQualityEntryStore: () => mockStoreInstance
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

function setupReadyEvaluation() {
  return { id: 'eval-1', status: 'draft', results: { setup: setupResult(), entry: null, management: null } }
}

function setupResult() {
  return { score: 96, grade: 'A', compliance: 'PASS', coverage: 100, criterionResults: [] }
}

function entryResult(overrides = {}) {
  return {
    score: 88,
    grade: 'B',
    compliance: 'INCOMPLETE',
    coverage: 85,
    criterionResults: [
      { key: 'breakout_session', status: 'PASS', score: 100, required: true, weight: 10, message: 'Same session.' },
      { key: 'trigger_compliance', status: 'PASS', score: 100, required: true, weight: 20, message: 'Above pivot.' },
      { key: 'volume_pace', status: 'PASS', score: 85, required: false, weight: 10, message: '1.6x.' },
      { key: 'range_pace', status: 'PASS', score: 70, required: false, weight: 5, message: '1.1x.' },
      { key: 'entry_extension', status: 'PASS', score: 75, required: false, weight: 20, message: '0.15 ADR.' },
      { key: 'initial_stop', status: 'UNKNOWN', score: null, required: true, weight: 20, message: 'No intraday evidence.' },
      { key: 'stop_width', status: 'PASS', score: 100, required: true, weight: 15, message: '0.5 ADR.' }
    ],
    ...overrides
  }
}

function persistedEvaluation() {
  return {
    id: 'eval-1',
    status: 'draft',
    profile_name: 'Canonical BO',
    version_number: 1,
    results: { setup: setupResult(), entry: entryResult(), management: null },
    user_inputs: { intended_trigger_type: 'BO-PIVOT' },
    detected_context: {
      boundary: { pivotPrice: 100, resolutionDate: '2026-03-10' },
      entry: {
        allowed_trigger_types: ['BO-PIVOT', 'BO-ORH-1', 'BO-ORH-5', 'BO-ORH-60'],
        intended_trigger: { value: 'BO-PIVOT', source: 'user_asserted' },
        breakout_session: '2026-03-10',
        actual_entry_session: '2026-03-10'
      }
    },
    evidence_snapshot: {
      entry: {
        execution: {
          entry_basis: 101,
          initial_entry_time: '2026-03-10T14:31:30.000Z',
          original_position_qty: 100,
          provenance: { source: 'executions_jsonb' }
        },
        trigger: { effective_trigger: 100 },
        initial_r: { available: true, r_per_share: 2 }
      }
    }
  }
}

function preparedPayload(overrides = {}) {
  return {
    evaluation: { id: 'eval-1', status: 'draft' },
    profileVersion: { id: 'version-1', profileName: 'Canonical BO', versionNumber: 1 },
    setupDependency: { ready: true, confirmedPivot: 100, breakoutSession: '2026-03-10' },
    executionEvidence: {
      available: true,
      entryBasis: 101,
      originalPositionQty: 100,
      initialEntryTime: '2026-03-10T14:31:30.000Z',
      actualEntrySession: '2026-03-10',
      provenance: { source: 'executions_jsonb' }
    },
    intradayEvidence: { entrySession: { available: true } },
    allowedTriggerTypes: ['BO-PIVOT', 'BO-ORH-1', 'BO-ORH-5', 'BO-ORH-60'],
    requiredEntryUserInputs: ['intended_trigger_type'],
    unavailableEvidence: [],
    ...overrides
  }
}

function mountSection() {
  return mount(EntryQualitySection, { props: { trade: TRADE } })
}

describe('EntryQualitySection', () => {
  beforeEach(() => {
    mockStoreInstance = createStoreState()
  })

  it('gates on Setup Quality when no Setup result exists', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([{ id: 'eval-1', status: 'draft', results: { setup: null } }])
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.get('[data-testid="setup-required"]').text()).toContain('Evaluate Setup Quality first')
  })

  it('shows execution evidence and the allowed intended-trigger options from the profile', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([setupReadyEvaluation()])
    mockStoreInstance.prepare.mockResolvedValue(preparedPayload())
    const wrapper = mountSection()
    await flushPromises()

    await wrapper.get('[data-testid="prepare-entry"]').trigger('click')
    await flushPromises()

    expect(wrapper.get('[data-testid="entry-confirmed-pivot"]').text()).toBe('100.00')
    expect(wrapper.get('[data-testid="entry-breakout-session"]').text()).toBe('2026-03-10')
    expect(wrapper.get('[data-testid="entry-basis"]').text()).toContain('101.00')
    const options = wrapper.get('[data-testid="entry-intended-trigger"]').findAll('option')
    const values = options.map((option) => option.element.value).filter(Boolean)
    expect(values).toEqual(['BO-PIVOT', 'BO-ORH-1', 'BO-ORH-5', 'BO-ORH-60'])
  })

  it('only shows the trigger values permitted by criterionConfig.parameters.allowed_types', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([setupReadyEvaluation()])
    mockStoreInstance.prepare.mockResolvedValue(preparedPayload({ allowedTriggerTypes: ['BO-PIVOT'] }))
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-entry"]').trigger('click')
    await flushPromises()

    const values = wrapper.get('[data-testid="entry-intended-trigger"]').findAll('option')
      .map((option) => option.element.value)
      .filter(Boolean)
    expect(values).toEqual(['BO-PIVOT'])
  })

  it('evaluates with the asserted intended trigger and renders Entry summaries and drill-down', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([setupReadyEvaluation()])
    mockStoreInstance.prepare.mockResolvedValue(preparedPayload())
    mockStoreInstance.evaluate.mockResolvedValue({ evaluation: persistedEvaluation() })
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-entry"]').trigger('click')
    await flushPromises()

    await wrapper.get('[data-testid="entry-intended-trigger"]').setValue('BO-PIVOT')
    await wrapper.get('[data-testid="run-entry"]').trigger('click')
    await flushPromises()

    expect(mockStoreInstance.evaluate).toHaveBeenCalledWith('trade-1', {
      evaluationId: 'eval-1',
      userInputs: { intended_trigger_type: 'BO-PIVOT' }
    })
    expect(wrapper.get('[data-testid="entry-score"]').text()).toBe('88')
    expect(wrapper.get('[data-testid="entry-grade"]').text()).toBe('B')
    expect(wrapper.get('[data-testid="entry-compliance"]').text()).toBe('INCOMPLETE')
    expect(wrapper.get('[data-testid="entry-coverage"]').text()).toBe('85%')
    expect(wrapper.findAll('[data-testid="entry-criterion-row"]')).toHaveLength(7)
  })

  it('does not require an intended trigger when the active criteria do not depend on it', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([setupReadyEvaluation()])
    mockStoreInstance.prepare.mockResolvedValue(preparedPayload({ requiredEntryUserInputs: [], allowedTriggerTypes: [] }))
    mockStoreInstance.evaluate.mockResolvedValue({ evaluation: persistedEvaluation() })
    const wrapper = mountSection()
    await flushPromises()
    await wrapper.get('[data-testid="prepare-entry"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="entry-intended-trigger"]').exists()).toBe(false)
    await wrapper.get('[data-testid="run-entry"]').trigger('click')
    await flushPromises()
    expect(mockStoreInstance.evaluate).toHaveBeenCalledWith('trade-1', {
      evaluationId: 'eval-1',
      userInputs: {}
    })
  })

  it('reloads a persisted Entry evaluation without a fresh prepare and keeps Setup visible in context', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([persistedEvaluation()])
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.find('[data-testid="setup-required"]').exists()).toBe(false)
    expect(wrapper.get('[data-testid="entry-score"]').text()).toBe('88')
    expect(wrapper.get('[data-testid="entry-breakout-session"]').text()).toBe('2026-03-10')
    expect(wrapper.get('[data-testid="entry-intended-trigger"]').element.value).toBe('BO-PIVOT')
    // The persisted evaluation (which still carries the valid Setup result) was
    // loaded without any fresh prepare call.
    expect(mockStoreInstance.fetchEvaluations).toHaveBeenCalledWith('trade-1')
    expect(mockStoreInstance.prepare).not.toHaveBeenCalled()
  })

  it('shows the first execution print distinctly and marks the actual initial stop UNKNOWN with a reference stop', async () => {
    const evaluation = persistedEvaluation()
    evaluation.evidence_snapshot.entry.execution.initial_entry_fill_price = 101
    evaluation.evidence_snapshot.entry.execution.initial_entry_fill_trustworthy = true
    evaluation.evidence_snapshot.entry.stop = {
      available: false,
      reference_stop: { price: 99, source: 'trade_stop_loss_field', semantics: 'planned_or_current_trade_stop' }
    }
    evaluation.evidence_snapshot.entry.initial_r = { available: false }
    mockStoreInstance.fetchEvaluations.mockResolvedValue([evaluation])
    const wrapper = mountSection()
    await flushPromises()

    expect(wrapper.get('[data-testid="entry-initial-fill"]').text()).toContain('101.00')
    expect(wrapper.get('[data-testid="entry-actual-stop"]').text()).toContain('UNKNOWN')
    expect(wrapper.get('[data-testid="entry-reference-stop"]').text()).toContain('99.00')
    expect(wrapper.get('[data-testid="entry-initial-r"]').text()).toBe('N/A')
  })

  it('renders FAIL and UNKNOWN criterion states distinctly', async () => {
    mockStoreInstance.fetchEvaluations.mockResolvedValue([
      persistedEvaluation()
    ])
    const wrapper = mountSection()
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('UNKNOWN')
    expect(text).toContain('PASS')
  })
})
