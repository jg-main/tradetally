import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useQualityWorkflowStore } from './qualityWorkflow'

function guardFor(workflow, overrides = {}) {
  return workflow.beginRequest({
    tradeId: 'trade-1',
    expectedEvaluationId: null,
    ...overrides
  })
}

describe('qualityWorkflow store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('activate makes an evaluation the single active row and bumps revision', () => {
    const workflow = useQualityWorkflowStore()
    const before = workflow.revision

    workflow.activate({ id: 'E2', trade_id: 'trade-1', status: 'draft' })

    expect(workflow.activeEvaluationId).toBe('E2')
    expect(workflow.activeEvaluation.id).toBe('E2')
    expect(workflow.activeTradeId).toBe('trade-1')
    expect(workflow.revision).toBe(before + 1)
    expect(workflow.activeIsTerminal).toBe(false)
  })

  it('updateActive keeps the active row in sync when the same id progresses', () => {
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'E2', trade_id: 'trade-1', status: 'draft' })

    expect(workflow.updateActive({ id: 'E2', trade_id: 'trade-1', status: 'completed' })).toBe(true)

    expect(workflow.activeEvaluation.status).toBe('completed')
    expect(workflow.activeIsTerminal).toBe(true)
  })

  it('updateActive ignores a different evaluation', () => {
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'E2', trade_id: 'trade-1', status: 'draft' })
    const revision = workflow.revision

    expect(workflow.updateActive({ id: 'OTHER', trade_id: 'trade-1', status: 'draft' })).toBe(false)
    expect(workflow.activeEvaluationId).toBe('E2')
    expect(workflow.activeEvaluation.id).toBe('E2')
    expect(workflow.revision).toBe(revision)
  })

  it('updateActive never adopts when empty (no resurrection)', () => {
    const workflow = useQualityWorkflowStore()
    expect(workflow.updateActive({ id: 'E1', trade_id: 'trade-1', status: 'draft' })).toBe(false)
    expect(workflow.activeEvaluationId).toBeNull()
  })

  it('ensureTrade records the scope and clears + invalidates when the trade changes', () => {
    const workflow = useQualityWorkflowStore()
    workflow.ensureTrade('trade-1')
    expect(workflow.activeTradeId).toBe('trade-1')

    workflow.activate({ id: 'E2', trade_id: 'trade-1', status: 'draft' })
    const guard = workflow.beginRequest({ tradeId: 'trade-1', expectedEvaluationId: 'E2' })

    workflow.ensureTrade('trade-2')

    expect(workflow.activeEvaluationId).toBeNull()
    expect(workflow.activeEvaluation).toBeNull()
    expect(workflow.activeTradeId).toBe('trade-2')
    // The in-flight Trade-1 request is invalidated.
    expect(workflow.commitProgress(guard, { id: 'E2', trade_id: 'trade-1' })).toBe(false)
    expect(workflow.activeEvaluationId).toBeNull()

    // Same trade keeps the active row and does not invalidate.
    workflow.activate({ id: 'E3', trade_id: 'trade-2', status: 'draft' })
    const sameTradeGuard = workflow.beginRequest({ tradeId: 'trade-2', expectedEvaluationId: 'E3' })
    workflow.ensureTrade('trade-2')
    expect(workflow.activeEvaluationId).toBe('E3')
    expect(workflow.commitProgress(sameTradeGuard, { id: 'E3', trade_id: 'trade-2', status: 'completed' })).toBe(true)
  })

  it('clear resets the active evaluation and invalidates outstanding requests', () => {
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'E2', trade_id: 'trade-1', status: 'completed' })
    const guard = workflow.beginRequest({ tradeId: 'trade-1', expectedEvaluationId: 'E2' })

    workflow.clear()

    expect(workflow.activeEvaluationId).toBeNull()
    expect(workflow.activeEvaluation).toBeNull()
    expect(workflow.activeIsTerminal).toBe(false)
    expect(workflow.commitProgress(guard, { id: 'E2', trade_id: 'trade-1' })).toBe(false)
    expect(workflow.adoptPreparedEvaluation(guard, { id: 'E2', trade_id: 'trade-1' })).toBe(false)
    expect(workflow.activeEvaluationId).toBeNull()
  })

  describe('beginRequest / isRequestCurrent', () => {
    it('is current until clear, trade change, or explicit re-selection', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })
      const guard = guardFor(workflow, { expectedEvaluationId: 'E1' })
      expect(workflow.isRequestCurrent(guard)).toBe(true)

      // Same-id progress does not invalidate.
      workflow.updateActive({ id: 'E1', trade_id: 'trade-1', status: 'completed' })
      expect(workflow.isRequestCurrent(guard)).toBe(true)

      // Explicit re-selection does.
      workflow.activate({ id: 'E3', trade_id: 'trade-1', status: 'draft' })
      expect(workflow.isRequestCurrent(guard)).toBe(false)
    })
  })

  describe('commitProgress', () => {
    it('adopts the first row for a current request when nothing is active', () => {
      const workflow = useQualityWorkflowStore()
      const guard = guardFor(workflow)

      expect(workflow.commitProgress(guard, { id: 'E1', trade_id: 'trade-1' })).toBe(true)
      expect(workflow.activeEvaluationId).toBe('E1')
    })

    it('rejects a stale (cleared) response', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })
      const guard = guardFor(workflow, { expectedEvaluationId: 'E1' })
      workflow.clear()

      expect(workflow.commitProgress(guard, { id: 'E1', trade_id: 'trade-1' })).toBe(false)
      expect(workflow.activeEvaluationId).toBeNull()
    })

    it('never replaces a different active row', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })
      const guard = guardFor(workflow, { expectedEvaluationId: 'E1' })

      expect(workflow.commitProgress(guard, { id: 'E2', trade_id: 'trade-1' })).toBe(false)
      expect(workflow.activeEvaluationId).toBe('E1')
    })
  })

  describe('adoptPreparedEvaluation (race-safe handoff)', () => {
    it('activates the returned row when nothing is active', () => {
      const workflow = useQualityWorkflowStore()
      const guard = guardFor(workflow)
      expect(workflow.adoptPreparedEvaluation(guard, { id: 'E1', trade_id: 'trade-1' })).toBe(true)
      expect(workflow.activeEvaluationId).toBe('E1')
    })

    it('treats a same-id response as an ordinary update', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })
      const guard = guardFor(workflow, { expectedEvaluationId: 'E1' })

      expect(workflow.adoptPreparedEvaluation(guard, { id: 'E1', trade_id: 'trade-1', status: 'completed' })).toBe(true)
      expect(workflow.activeEvaluationId).toBe('E1')
      expect(workflow.activeEvaluation.status).toBe('completed')
    })

    it('replaces the active row when the request matched the active id (terminal E1 -> fresh E2)', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'completed' })
      const guard = guardFor(workflow, { expectedEvaluationId: 'E1' })

      expect(workflow.adoptPreparedEvaluation(guard, { id: 'E2', trade_id: 'trade-1', status: 'draft' })).toBe(true)
      expect(workflow.activeEvaluationId).toBe('E2')
      expect(workflow.activeEvaluation.id).toBe('E2')
    })

    it('adopts a model-B replacement for a non-terminal active row', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })
      const guard = guardFor(workflow, { expectedEvaluationId: 'E1' })

      expect(workflow.adoptPreparedEvaluation(guard, { id: 'E2', trade_id: 'trade-1', status: 'draft' })).toBe(true)
      expect(workflow.activeEvaluationId).toBe('E2')
    })

    it('ignores a stale response when the active id changed in flight', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })
      const guard = guardFor(workflow, { expectedEvaluationId: 'E1' })
      workflow.activate({ id: 'E3', trade_id: 'trade-1', status: 'draft' })

      expect(workflow.adoptPreparedEvaluation(guard, { id: 'E2', trade_id: 'trade-1', status: 'draft' })).toBe(false)
      expect(workflow.activeEvaluationId).toBe('E3')
    })

    it('ignores a stale response after clear', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })
      const guard = guardFor(workflow, { expectedEvaluationId: 'E1' })
      workflow.clear()

      expect(workflow.adoptPreparedEvaluation(guard, { id: 'E2', trade_id: 'trade-1', status: 'draft' })).toBe(false)
      expect(workflow.activeEvaluationId).toBeNull()
    })

    it('ignores a response with no id', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })
      const guard = guardFor(workflow, { expectedEvaluationId: 'E1' })
      expect(workflow.adoptPreparedEvaluation(guard, null)).toBe(false)
      expect(workflow.activeEvaluationId).toBe('E1')
    })
  })
})
