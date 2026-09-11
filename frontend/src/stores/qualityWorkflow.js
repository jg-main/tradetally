import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

const TERMINAL_STATUSES = ['completed', 'insufficient_data']

/**
 * Single source of truth for the ACTIVE profile-based quality evaluation in a
 * Trade Detail session (Phase 5 hardening).
 *
 * Setup, Entry, Management and History all read `activeEvaluationId`; none of
 * them may fall back to an independent "latest draft" once an evaluation has
 * been explicitly selected (e.g. by "Evaluate with vN"). Sections publish
 * progress with `updateActive` so every other section and the history list see
 * the SAME row. The store never selects a primary and never promotes anything
 * automatically.
 */
export const useQualityWorkflowStore = defineStore('qualityWorkflow', () => {
  // Explicitly selected active evaluation (id + best-known row).
  const activeEvaluationId = ref(null)
  const activeEvaluation = ref(null)
  // The trade the active evaluation belongs to, so a different trade clears it.
  const activeTradeId = ref(null)
  // Bumped on every activation/progress so observers (History) can refresh.
  const revision = ref(0)

  function activate(evaluation) {
    if (!evaluation || !evaluation.id) return
    activeEvaluationId.value = evaluation.id
    activeEvaluation.value = evaluation
    if (evaluation.trade_id) activeTradeId.value = evaluation.trade_id
    revision.value += 1
  }

  function updateActive(evaluation) {
    if (!evaluation || !evaluation.id) return
    if (!activeEvaluationId.value) {
      activeEvaluationId.value = evaluation.id
      if (evaluation.trade_id) activeTradeId.value = evaluation.trade_id
    }
    if (evaluation.id === activeEvaluationId.value) {
      activeEvaluation.value = evaluation
      if (evaluation.trade_id) activeTradeId.value = evaluation.trade_id
      revision.value += 1
    }
  }

  // Clears the active evaluation when it belongs to a different trade (or on
  // explicit reset). Keeps the workflow unambiguous when the trade changes.
  function ensureTrade(tradeId) {
    if (activeTradeId.value && tradeId && activeTradeId.value !== tradeId) {
      clear()
    }
  }

  function clear() {
    activeEvaluationId.value = null
    activeEvaluation.value = null
    activeTradeId.value = null
    revision.value += 1
  }

  const activeIsTerminal = computed(
    () => !!activeEvaluation.value && TERMINAL_STATUSES.includes(activeEvaluation.value.status)
  )

  return {
    activeEvaluationId,
    activeEvaluation,
    activeTradeId,
    revision,
    activeIsTerminal,
    activate,
    updateActive,
    ensureTrade,
    clear
  }
})
