import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const { api } = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn()
  }
}))

vi.mock('@/services/api', () => ({ default: api }))

import { useQualityHistoryStore } from './qualityHistory'

describe('qualityHistory store', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    api.get.mockReset()
    api.post.mockReset()
    api.put.mockReset()
    api.delete.mockReset()
  })

  it('loads the immutable evaluation history for a trade', async () => {
    api.get.mockResolvedValue({ data: { evaluations: [{ id: 'e1', is_primary: true }] } })

    const store = useQualityHistoryStore()
    const rows = await store.fetchEvaluations('trade-1')

    expect(api.get).toHaveBeenCalledWith('/trades/trade-1/quality/evaluations')
    expect(rows).toHaveLength(1)
    expect(store.evaluations[0].is_primary).toBe(true)
    expect(store.loading).toBe(false)
  })

  it('loads profile version metadata', async () => {
    api.get.mockResolvedValue({ data: { versions: [{ id: 'v1', version_number: 1 }] } })
    const store = useQualityHistoryStore()
    await store.fetchVersions('profile-1')
    expect(api.get).toHaveBeenCalledWith('/quality-profiles/profile-1/versions')
    expect(store.versions).toHaveLength(1)
  })

  it('starts a version-pinned evaluation via POST', async () => {
    api.post.mockResolvedValue({ data: { evaluation: { id: 'new-eval', status: 'draft' } } })
    const store = useQualityHistoryStore()

    const created = await store.startEvaluation('trade-1', 'v3')

    expect(api.post).toHaveBeenCalledWith('/trades/trade-1/quality/evaluations', {
      profileVersionId: 'v3'
    })
    expect(created.id).toBe('new-eval')
  })

  it('selects a primary evaluation and returns the backend-resolved summary', async () => {
    api.put.mockResolvedValue({
      data: {
        primary: { evaluation_id: 'e2' },
        qualitySummary: { source: 'profile_primary', setup: { grade: 'C', score: 72 } }
      }
    })
    const store = useQualityHistoryStore()
    store.evaluations = [
      { id: 'e1', is_primary: true },
      { id: 'e2', is_primary: false }
    ]

    const result = await store.selectPrimary('trade-1', 'e2')

    expect(api.put).toHaveBeenCalledWith('/trades/trade-1/quality/evaluations/e2/primary')
    expect(store.evaluations.map((row) => row.is_primary)).toEqual([false, true])
    expect(result.primary.evaluation_id).toBe('e2')
    expect(result.qualitySummary.source).toBe('profile_primary')
  })

  it('clears the primary and returns the resolved legacy/none summary', async () => {
    api.delete.mockResolvedValue({
      data: {
        cleared: { trade_id: 'trade-1', evaluation_id: 'e1' },
        qualitySummary: { source: 'legacy', setup: { grade: 'A', score: 4.5 } }
      }
    })
    const store = useQualityHistoryStore()
    store.evaluations = [{ id: 'e1', is_primary: true }]

    const result = await store.clearPrimary('trade-1')

    expect(api.delete).toHaveBeenCalledWith('/trades/trade-1/quality/evaluations/primary')
    expect(store.evaluations.map((row) => row.is_primary)).toEqual([false])
    expect(result.qualitySummary.source).toBe('legacy')
  })

  it('compares two evaluations using the compare endpoint', async () => {
    api.get.mockResolvedValue({ data: { comparison: { trade_id: 'trade-1' } } })
    const store = useQualityHistoryStore()

    const comparison = await store.compareEvaluations('trade-1', 'a', 'b')

    expect(api.get).toHaveBeenCalledWith('/trades/trade-1/quality/evaluations/compare', {
      params: { left: 'a', right: 'b' }
    })
    expect(comparison.trade_id).toBe('trade-1')
  })

  it('surfaces API errors without throwing away state', async () => {
    api.get.mockRejectedValue({ response: { data: { error: 'Trade not found' } } })
    const store = useQualityHistoryStore()

    await expect(store.fetchEvaluations('missing')).rejects.toBeTruthy()
    expect(store.error).toBe('Trade not found')
  })
})
