import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/services/api'

/**
 * Management Quality evaluation store (Phase 4 Quality Profiles).
 *
 * Drives the Prepare Management -> Select trailing MA -> Evaluate Management
 * workflow shown on Trade Detail beneath Entry Quality. Management results are
 * NON-TERMINAL draft progress until the evaluation is finalized; the valid
 * Setup and Entry results are always preserved.
 */
export const useQualityManagementStore = defineStore('qualityManagement', () => {
  const preparing = ref(false)
  const evaluating = ref(false)
  const finalizing = ref(false)
  const loading = ref(false)
  const error = ref(null)

  const prepared = ref(null)
  const evaluation = ref(null)
  const evaluations = ref([])

  function setError(err) {
    error.value = err?.response?.data?.error || err?.message || 'Management Quality request failed'
  }

  async function prepare(tradeId, { evaluationId } = {}) {
    preparing.value = true
    error.value = null
    try {
      const response = await api.post(`/trades/${tradeId}/quality/management/prepare`, {
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
      const response = await api.post(`/trades/${tradeId}/quality/management/evaluate`, {
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

  async function finalize(tradeId, { evaluationId }) {
    finalizing.value = true
    error.value = null
    try {
      const response = await api.post(`/trades/${tradeId}/quality/finalize`, {
        evaluationId
      })
      evaluation.value = response.data.evaluation
      return response.data
    } catch (err) {
      setError(err)
      throw err
    } finally {
      finalizing.value = false
    }
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

  function $reset() {
    prepared.value = null
    evaluation.value = null
    evaluations.value = []
    error.value = null
    preparing.value = false
    evaluating.value = false
    finalizing.value = false
    loading.value = false
  }

  return {
    preparing,
    evaluating,
    finalizing,
    loading,
    error,
    prepared,
    evaluation,
    evaluations,
    prepare,
    evaluate,
    finalize,
    fetchEvaluations,
    $reset
  }
})
