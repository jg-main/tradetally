import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useQualityWorkflowStore } from './qualityWorkflow'

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

    workflow.updateActive({ id: 'E2', trade_id: 'trade-1', status: 'completed' })

    expect(workflow.activeEvaluation.status).toBe('completed')
    expect(workflow.activeIsTerminal).toBe(true)
  })

  it('updateActive ignores a different evaluation once one is active', () => {
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'E2', trade_id: 'trade-1', status: 'draft' })
    const revision = workflow.revision

    workflow.updateActive({ id: 'OTHER', trade_id: 'trade-1', status: 'draft' })

    expect(workflow.activeEvaluationId).toBe('E2')
    expect(workflow.activeEvaluation.id).toBe('E2')
    expect(workflow.revision).toBe(revision)
  })

  it('updateActive adopts the first progress row when nothing is active yet', () => {
    const workflow = useQualityWorkflowStore()
    workflow.updateActive({ id: 'E1', trade_id: 'trade-1', status: 'draft' })

    expect(workflow.activeEvaluationId).toBe('E1')
  })

  it('ensureTrade clears the active evaluation when the trade changes', () => {
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'E2', trade_id: 'trade-1', status: 'draft' })

    workflow.ensureTrade('trade-2')

    expect(workflow.activeEvaluationId).toBeNull()
    expect(workflow.activeEvaluation).toBeNull()
    expect(workflow.activeTradeId).toBeNull()

    // Same trade keeps the active row.
    workflow.activate({ id: 'E3', trade_id: 'trade-2', status: 'draft' })
    workflow.ensureTrade('trade-2')
    expect(workflow.activeEvaluationId).toBe('E3')
  })

  it('clear resets the active evaluation', () => {
    const workflow = useQualityWorkflowStore()
    workflow.activate({ id: 'E2', trade_id: 'trade-1', status: 'completed' })
    workflow.clear()
    expect(workflow.activeEvaluationId).toBeNull()
    expect(workflow.activeIsTerminal).toBe(false)
  })

  describe('adoptPreparedEvaluation (race-safe handoff)', () => {
    it('activates the returned row when nothing is active', () => {
      const workflow = useQualityWorkflowStore()
      expect(workflow.adoptPreparedEvaluation(undefined, { id: 'E1', trade_id: 'trade-1' })).toBe(true)
      expect(workflow.activeEvaluationId).toBe('E1')
    })

    it('treats a same-id response as an ordinary update', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })

      expect(workflow.adoptPreparedEvaluation('E1', { id: 'E1', trade_id: 'trade-1', status: 'completed' })).toBe(true)
      expect(workflow.activeEvaluationId).toBe('E1')
      expect(workflow.activeEvaluation.status).toBe('completed')
    })

    it('replaces the active row when the request matched the active id (terminal E1 -> fresh E2)', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'completed' })

      expect(workflow.adoptPreparedEvaluation('E1', { id: 'E2', trade_id: 'trade-1', status: 'draft' })).toBe(true)
      expect(workflow.activeEvaluationId).toBe('E2')
      expect(workflow.activeEvaluation.id).toBe('E2')
    })

    it('adopts a model-B replacement for a non-terminal active row', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })

      expect(workflow.adoptPreparedEvaluation('E1', { id: 'E2', trade_id: 'trade-1', status: 'draft' })).toBe(true)
      expect(workflow.activeEvaluationId).toBe('E2')
    })

    it('ignores a stale response when the active id changed in flight', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })
      workflow.activate({ id: 'E3', trade_id: 'trade-1', status: 'draft' })

      expect(workflow.adoptPreparedEvaluation('E1', { id: 'E2', trade_id: 'trade-1', status: 'draft' })).toBe(false)
      expect(workflow.activeEvaluationId).toBe('E3')
    })

    it('ignores a response with no id', () => {
      const workflow = useQualityWorkflowStore()
      workflow.activate({ id: 'E1', trade_id: 'trade-1', status: 'draft' })
      expect(workflow.adoptPreparedEvaluation('E1', null)).toBe(false)
      expect(workflow.activeEvaluationId).toBe('E1')
    })
  })
})
