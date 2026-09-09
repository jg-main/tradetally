import { defineStore } from 'pinia'
import { ref } from 'vue'
import api from '@/services/api'

/**
 * Setup Quality evaluation store (Phase 2 Quality Profiles).
 *
 * Drives the Prepare -> Confirm/Adjust -> Evaluate workflow shown on Trade
 * Detail. All Setup results are NON-TERMINAL draft progress until later
 * phases complete the Entry/Management dimensions.
 */
export const useQualitySetupStore = defineStore('qualitySetup', () => {
  const preparing = ref(false)
  const evaluating = ref(false)
  const loading = ref(false)
  const error = ref(null)

  const prepared = ref(null) // prepare() payload: profile/version, detections, evidence
  const evaluation = ref(null) // latest persisted draft evaluation (results JSONB)
  const evaluations = ref([])

  function setError(err) {
    error.value = err?.response?.data?.error || err?.message || 'Setup Quality request failed'
  }

  async function prepare(tradeId, { profileId, confirmedBaseStart } = {}) {
    preparing.value = true
    error.value = null
    try {
      const response = await api.post(`/trades/${tradeId}/quality/prepare`, {
        profileId: profileId || undefined,
        confirmedBaseStart: confirmedBaseStart || undefined
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
      const response = await api.post(`/trades/${tradeId}/quality/evaluate`, {
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
      // The UI resumes the most recent draft with persisted results.
      const latestDraft = evaluations.value.find(
        (item) => item.status !== 'completed' && item.status !== 'insufficient_data'
      )
      if (latestDraft && latestDraft.results && latestDraft.results.setup) {
        evaluation.value = latestDraft
      } else if (latestDraft) {
        evaluation.value = latestDraft
      }
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
