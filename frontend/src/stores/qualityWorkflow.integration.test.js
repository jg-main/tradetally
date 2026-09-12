import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { api } = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn()
  }
}))

vi.mock('@/services/api', () => ({ default: api }))

import { useQualityHistoryStore } from './qualityHistory'
import { useQualitySetupStore } from './qualitySetup'
import { useQualityEntryStore } from './qualityEntry'
import { useQualityManagementStore } from './qualityManagement'
import { useQualityWorkflowStore } from './qualityWorkflow'

const TRADE = 'trade-1'

// End-to-end Phase 5 hardening regression: an explicit historical re-evaluation
// must run the ENTIRE Setup -> Entry -> Management -> Finalize workflow on the
// SAME new evaluation row, update History, keep the old evaluation, and never
// change the primary.
describe('Phase 5 active-evaluation coordination (store integration)', () => {
  let history
  let setup
  let entry
  let management
  let workflow
  let list
  let e2
  let posted

  beforeEach(() => {
    setActivePinia(createPinia())
    api.get.mockReset()
    api.post.mockReset()
    api.put.mockReset()

    history = useQualityHistoryStore()
    setup = useQualitySetupStore()
    entry = useQualityEntryStore()
    management = useQualityManagementStore()
    workflow = useQualityWorkflowStore()

    // v1 is the existing completed evaluation and the current primary.
    const v1 = {
      id: 'v1',
      trade_id: TRADE,
      status: 'completed',
      profile_version_id: 'pv1',
      profile_name: 'Canonical BO',
      version_number: 1,
      is_primary: true,
      is_current_version: false,
      current_version_id: 'pv2',
      current_version_number: 2,
      results: { setup: { score: 90 }, entry: null, management: null }
    }
    e2 = {
      id: 'E2',
      trade_id: TRADE,
      status: 'draft',
      profile_version_id: 'pv2',
      profile_name: 'Canonical BO',
      version_number: 2,
      is_primary: false,
      is_current_version: true,
      current_version_number: 2,
      results: { setup: null, entry: null, management: null }
    }
    list = [v1]
    posted = []

    api.get.mockImplementation((url) => {
      if (url.endsWith('/quality/evaluations')) {
        return Promise.resolve({ data: { evaluations: list.map((row) => ({ ...row })) } })
      }
      return Promise.reject(new Error(`unexpected GET ${url}`))
    })
    api.put.mockImplementation(() => Promise.reject(new Error('primary must not change')))

    api.post.mockImplementation((url, body) => {
      posted.push({ url, body })
      if (url.endsWith('/quality/evaluations')) {
        list = [{ ...e2 }, ...list]
        return Promise.resolve({ data: { evaluation: { ...e2 } } })
      }
      if (url.endsWith('/quality/prepare')) {
        return Promise.resolve({ data: { evaluation: { ...e2, results: { ...e2.results, setup: { score: 95 } } } } })
      }
      if (url.endsWith('/quality/evaluate')) {
        return Promise.resolve({ data: { evaluation: { ...e2, results: { ...e2.results, setup: { score: 95 } } } } })
      }
      if (url.endsWith('/entry/prepare')) {
        return Promise.resolve({ data: { evaluation: { ...e2, results: { ...e2.results, setup: { score: 95 } } } } })
      }
      if (url.endsWith('/entry/evaluate')) {
        return Promise.resolve({ data: { evaluation: { ...e2, results: { ...e2.results, setup: { score: 95 }, entry: { score: 88 } } } } })
      }
      if (url.endsWith('/management/prepare')) {
        return Promise.resolve({ data: { evaluation: { ...e2, results: { ...e2.results, setup: { score: 95 }, entry: { score: 88 } } } } })
      }
      if (url.endsWith('/management/evaluate')) {
        return Promise.resolve({ data: { evaluation: { ...e2, results: { ...e2.results, setup: { score: 95 }, entry: { score: 88 }, management: { score: 80 } } } } })
      }
      if (url.endsWith('/finalize')) {
        e2 = {
          ...e2,
          status: 'completed',
          results: { setup: { score: 95 }, entry: { score: 88 }, management: { score: 80 } }
        }
        list = list.map((row) => (row.id === 'E2' ? { ...e2 } : row))
        return Promise.resolve({ data: { evaluation: { ...e2 } } })
      }
      return Promise.reject(new Error(`unexpected POST ${url}`))
    })
  })

  it('runs Setup -> Entry -> Management -> Finalize on the new E2 row only', async () => {
    // 1. History has the completed v1 (primary).
    await history.fetchEvaluations(TRADE)
    expect(history.evaluations.map((row) => row.id)).toEqual(['v1'])

    // 2-3. "Evaluate with v2" creates E2 and makes it active.
    const created = await history.startEvaluation(TRADE, 'pv2')
    workflow.activate(created)
    expect(workflow.activeEvaluationId).toBe('E2')

    // 4. Setup prepare/evaluate on E2, then publish the progressed row.
    const setupPrepared = await setup.prepare(TRADE, { evaluationId: workflow.activeEvaluationId })
    workflow.updateActive(setupPrepared.evaluation)
    const setupEvaluated = await setup.evaluate(TRADE, {
      evaluationId: workflow.activeEvaluationId,
      userInputs: { leader_confirmed: true }
    })
    workflow.updateActive(setupEvaluated.evaluation)
    expect(workflow.activeEvaluationId).toBe('E2')

    // 5. Entry prepare/evaluate on the SAME E2, seeing the Setup result.
    const entryPrepared = await entry.prepare(TRADE, { evaluationId: workflow.activeEvaluationId })
    expect(entryPrepared.evaluation.results.setup.score).toBe(95)
    const entryEvaluated = await entry.evaluate(TRADE, {
      evaluationId: workflow.activeEvaluationId,
      userInputs: { intended_trigger_type: 'BO-PIVOT' }
    })
    workflow.updateActive(entryEvaluated.evaluation)
    expect(workflow.activeEvaluationId).toBe('E2')

    // 6. Management prepare/evaluate/finalize on the SAME E2.
    const managementPrepared = await management.prepare(TRADE, { evaluationId: workflow.activeEvaluationId })
    expect(managementPrepared.evaluation.results.entry.score).toBe(88)
    const managementEvaluated = await management.evaluate(TRADE, {
      evaluationId: workflow.activeEvaluationId,
      userInputs: { trailing_ma_period: 20 }
    })
    workflow.updateActive(managementEvaluated.evaluation)
    const finalized = await management.finalize(TRADE, { evaluationId: workflow.activeEvaluationId })
    workflow.updateActive(finalized.evaluation)
    expect(finalized.evaluation.status).toBe('completed')

    // 7. History refresh reflects the terminal E2.
    await history.fetchEvaluations(TRADE)
    expect(history.evaluations.find((row) => row.id === 'E2').status).toBe('completed')

    // 8. v1 remains present.
    expect(history.evaluations.find((row) => row.id === 'v1')).toBeTruthy()

    // 9. The primary is unchanged and no primary selection happened.
    expect(history.evaluations.find((row) => row.id === 'v1').is_primary).toBe(true)
    expect(history.evaluations.find((row) => row.id === 'E2').is_primary).toBe(false)
    expect(api.put).not.toHaveBeenCalled()

    // Every workflow write targeted E2.
    const workflowPosts = posted.filter((call) => call.body && call.body.evaluationId)
    expect(workflowPosts.length).toBeGreaterThanOrEqual(7)
    expect(workflowPosts.every((call) => call.body.evaluationId === 'E2')).toBe(true)
    // The start call pinned the explicit immutable version.
    const startCall = posted.find((call) => call.url.endsWith('/quality/evaluations'))
    expect(startCall.body).toEqual({ profileVersionId: 'pv2' })
  })

  it('adopts a replacement from Setup prepare and continues the workflow on the new row', async () => {
    // A terminal evaluation is active; Setup prepare legitimately returns E2.
    await history.fetchEvaluations(TRADE)
    const v1 = history.evaluations.find((row) => row.id === 'v1')
    workflow.activate(v1)

    const guard = workflow.beginRequest({
      tradeId: TRADE,
      expectedEvaluationId: workflow.activeEvaluationId
    })
    const prepared = await setup.prepare(TRADE, { evaluationId: workflow.activeEvaluationId })
    expect(prepared.evaluation.id).toBe('E2')
    const adopted = workflow.adoptPreparedEvaluation(guard, prepared.evaluation)
    expect(adopted).toBe(true)
    expect(workflow.activeEvaluationId).toBe('E2')
    // The replacement row now exists in history.
    list = [{ ...e2 }, ...list]

    const setupEvaluated = await setup.evaluate(TRADE, {
      evaluationId: workflow.activeEvaluationId,
      userInputs: { leader_confirmed: true }
    })
    workflow.updateActive(setupEvaluated.evaluation)
    const entryEvaluated = await entry.evaluate(TRADE, {
      evaluationId: workflow.activeEvaluationId,
      userInputs: { intended_trigger_type: 'BO-PIVOT' }
    })
    workflow.updateActive(entryEvaluated.evaluation)
    const finalized = await management.finalize(TRADE, {
      evaluationId: workflow.activeEvaluationId
    })
    workflow.updateActive(finalized.evaluation)

    await history.fetchEvaluations(TRADE)
    expect(history.evaluations.find((row) => row.id === 'E2').status).toBe('completed')
    expect(history.evaluations.find((row) => row.id === 'v1')).toBeTruthy()
    expect(history.evaluations.find((row) => row.id === 'v1').is_primary).toBe(true)
    expect(api.put).not.toHaveBeenCalled()

    // The request that produced the replacement targeted v1; every later
    // workflow write targeted E2.
    const evaluationIds = posted
      .filter((call) => call.body && call.body.evaluationId)
      .map((call) => call.body.evaluationId)
    expect(evaluationIds[0]).toBe('v1')
    expect(evaluationIds.slice(1).every((id) => id === 'E2')).toBe(true)
  })
})
