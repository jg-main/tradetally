import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/services/api'

/**
 * Entry Quality evaluation store (Phase 3 Quality Profiles).
 *
 * Drives the Prepare Entry -> Assert intended trigger -> Evaluate Entry workflow
 * shown on Trade Detail beneath Setup Quality. Entry results are NON-TERMINAL
 * draft progress until Management is implemented; the valid Setup result is
 * always preserved.
 */
export const useQualityEntryStore = defineStore('qualityEntry', () => {
  const preparing = ref(false)
  const evaluating = ref(false)
  const loading = ref(false)
  const error = ref(null)

  const prepared = ref(null)
  const evaluation = ref(null)
  const evaluations = ref([])

  function setError(err) {
    error.value = err?.response?.data?.error || err?.message || 'Entry Quality request failed'
  }

  async function prepare(tradeId, { evaluationId } = {}) {
    preparing.value = true
    error.value = null
    try {
      const response = await api.post(`/trades/${tradeId}/quality/entry/prepare`, {
        evaluationId: evaluationId || undefined
      })
      prepared.value = response.data
      return response.data
    } catch (err) {
      setError(err)
      throw err
    } finally {
      preparing.value = false
    }
  }

  async function evaluate(tradeId, { evaluationId, userInputs }) {
    evaluating.value = true
    error.value = null
    try {
      const response = await api.post(`/trades/${tradeId}/quality/entry/evaluate`, {
        evaluationId,
        userInputs
      })
      evaluation.value = response.data.evaluation
      return response.data
    } catch (err) {
      setError(err)
      throw err
    } finally {
      evaluating.value = false
    }
  }

  async function fetchEvaluations(tradeId) {
    loading.value = true
    error.value = null
    try {
      const response = await api.get(`/trades/${tradeId}/quality/evaluations`)
      evaluations.value = response.data.evaluations || []
      const latestDraft = evaluations.value.find(
        (item) => item.status !== 'completed' && item.status !== 'insufficient_data'
      )
      if (latestDraft) evaluation.value = latestDraft
      return evaluations.value
    } catch (err) {
      setError(err)
      throw err
    } finally {
      loading.value = false
    }
  }

  function $reset() {
    prepared.value = null
    evaluation.value = null
    evaluations.value = []
    error.value = null
    preparing.value = false
    evaluating.value = false
    loading.value = false
  }

  return {
    preparing,
    evaluating,
    loading,
    error,
    prepared,
    evaluation,
    evaluations,
    prepare,
    evaluate,
    fetchEvaluations,
    $reset
  }
})
