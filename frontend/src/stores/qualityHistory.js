import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/services/api'

/**
 * Phase 5 quality history store.
 *
 * Owns the generic evaluation history, profile version metadata, explicit
 * primary selection, version-pinned re-evaluation, and pairwise comparison.
 * Historical rows are read-only snapshots; none of these actions recalculates
 * or mutates a past evaluation.
 */
export const useQualityHistoryStore = defineStore('qualityHistory', () => {
  const loading = ref(false)
  const starting = ref(false)
  const selectingPrimary = ref(false)
  const comparing = ref(false)
  const error = ref(null)

  const evaluations = ref([])
  const versions = ref([])
  const comparison = ref(null)

  function setError(err) {
    error.value = err?.response?.data?.error || err?.message || 'Quality history request failed'
  }

  async function fetchEvaluations(tradeId) {
    loading.value = true
    error.value = null
    try {
      const response = await api.get(`/trades/${tradeId}/quality/evaluations`)
      evaluations.value = response.data.evaluations || []
      return evaluations.value
    } catch (err) {
      setError(err)
      throw err
    } finally {
      loading.value = false
    }
  }

  async function fetchVersions(profileId) {
    error.value = null
    try {
      const response = await api.get(`/quality-profiles/${profileId}/versions`)
      versions.value = response.data.versions || []
      return versions.value
    } catch (err) {
      setError(err)
      throw err
    }
  }

  /** Starts/resumes a draft pinned to an exact immutable profile version. */
  async function startEvaluation(tradeId, profileVersionId) {
    starting.value = true
    error.value = null
    try {
      const response = await api.post(`/trades/${tradeId}/quality/evaluations`, {
        profileVersionId
      })
      return response.data.evaluation
    } catch (err) {
      setError(err)
      throw err
    } finally {
      starting.value = false
    }
  }

  /** Explicit user intent only; never called automatically. */
  async function selectPrimary(tradeId, evaluationId) {
    selectingPrimary.value = true
    error.value = null
    try {
      const response = await api.put(
        `/trades/${tradeId}/quality/evaluations/${evaluationId}/primary`
      )
      evaluations.value = evaluations.value.map((row) => ({
        ...row,
        is_primary: row.id === evaluationId
      }))
      return response.data.primary
    } catch (err) {
      setError(err)
      throw err
    } finally {
      selectingPrimary.value = false
    }
  }

  async function compareEvaluations(tradeId, leftId, rightId) {
    comparing.value = true
    error.value = null
    try {
      const response = await api.get(`/trades/${tradeId}/quality/evaluations/compare`, {
        params: { left: leftId, right: rightId }
      })
      comparison.value = response.data.comparison
      return comparison.value
    } catch (err) {
      setError(err)
      throw err
    } finally {
      comparing.value = false
    }
  }

  function $reset() {
    evaluations.value = []
    versions.value = []
    comparison.value = null
    error.value = null
    loading.value = false
    starting.value = false
    selectingPrimary.value = false
    comparing.value = false
  }

  return {
    loading,
    starting,
    selectingPrimary,
    comparing,
    error,
    evaluations,
    versions,
    comparison,
    fetchEvaluations,
    fetchVersions,
    startEvaluation,
    selectPrimary,
    compareEvaluations,
    $reset
  }
})
