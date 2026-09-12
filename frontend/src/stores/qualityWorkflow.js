import { defineStore } from 'pinia'
import { computed, ref } from 'vue'

const TERMINAL_STATUSES = ['completed', 'insufficient_data']

/**
 * Single source of truth for the ACTIVE profile-based quality evaluation in a
 * Trade Detail session (Phase 5 lifecycle hardening).
 *
 * Setup, Entry, Management and History all read `activeEvaluationId`; none of
 * them may fall back to an independent "latest draft" once an evaluation has
 * been explicitly selected (e.g. by "Evaluate with vN"). Sections publish
 * progress with `commitProgress` / `adoptPreparedEvaluation` so every section
 * and the history list see the SAME row. The store never selects a primary.
 *
 * Request scoping:
 *   - `activeTradeId` records the CURRENT trade scope even when no evaluation
 *     is active;
 *   - `generation` is bumped by `clear()`, by a trade change and by an explicit
 *     selection of another evaluation. It is NOT bumped by same-id progress.
 *
 * Callers capture a request guard with `beginRequest(...)` BEFORE dispatching an
 * async quality call and may mutate workflow state only if
 * `isRequestCurrent(guard)` is still true. A guard from before a clear / trade
 * change / other selection can never resurrect an invalidated evaluation.
 */
export const useQualityWorkflowStore = defineStore('qualityWorkflow', () => {
  // Explicitly selected active evaluation (id + best-known row).
  const activeEvaluationId = ref(null)
  const activeEvaluation = ref(null)
  // The current trade scope, recorded even when no evaluation is active.
  const activeTradeId = ref(null)
  // Invalidates outstanding requests on clear / trade change / re-selection.
  const generation = ref(0)
  // Bumped on every accepted activation/progress so observers (History) refresh.
  const revision = ref(0)

  function setActive(evaluation, { bumpGeneration = false } = {}) {
    if (!evaluation || !evaluation.id) return false
    const changed = evaluation.id !== activeEvaluationId.value
    if (changed && bumpGeneration) generation.value += 1
    activeEvaluationId.value = evaluation.id
    activeEvaluation.value = evaluation
    if (evaluation.trade_id) activeTradeId.value = evaluation.trade_id
    revision.value += 1
    return true
  }

  // Explicit selection (e.g. History "Evaluate with vN"): invalidates requests
  // started under the previous selection.
  function activate(evaluation) {
    return setActive(evaluation, { bumpGeneration: true })
  }

  // Same-row progress ONLY. Never adopts and never resurrects a cleared row
  // from an old async response.
  function updateActive(evaluation) {
    if (!evaluation || !evaluation.id) return false
    if (evaluation.id !== activeEvaluationId.value) return false
    activeEvaluation.value = evaluation
    if (evaluation.trade_id) activeTradeId.value = evaluation.trade_id
    revision.value += 1
    return true
  }

  // Captures the request scope before dispatch.
  function beginRequest({ tradeId, expectedEvaluationId = null } = {}) {
    if (tradeId && !activeTradeId.value) activeTradeId.value = tradeId
    return {
      tradeId: tradeId || activeTradeId.value || null,
      expectedEvaluationId,
      generation: generation.value
    }
  }

  function isRequestCurrent(guard) {
    if (!guard) return false
    // Trade scope must still match (when both sides are known) and no clear /
    // trade change / re-selection may have happened since the request began.
    if (guard.tradeId && activeTradeId.value && guard.tradeId !== activeTradeId.value) return false
    return guard.generation === generation.value
  }

  // Ordinary progress from a current request (Setup/Entry/Management evaluate,
  // finalize). May adopt the first row for a still-current request, but never
  // replaces a different active row.
  function commitProgress(guard, evaluation) {
    if (!evaluation || !evaluation.id) return false
    if (!isRequestCurrent(guard)) return false
    if (activeEvaluationId.value === null) {
      return setActive(evaluation)
    }
    return updateActive(evaluation)
  }

  /**
   * Race-safe handoff for endpoints that may legitimately return a DIFFERENT
   * evaluation than the one requested (Setup prepare can create a replacement
   * draft: terminal pinned row, or model-B refresh of a non-reusable snapshot).
   *
   * - guard stale                        -> reject (no resurrection);
   * - no active evaluation               -> adopt the returned row;
   * - returned id === active id          -> ordinary same-row update;
   * - returned id !== active id          -> replace ONLY when the guard's
   *   expected id still equals the active id (the request was issued against
   *   the current selection).
   */
  function adoptPreparedEvaluation(guard, returnedEvaluation) {
    if (!returnedEvaluation || !returnedEvaluation.id) return false
    if (!isRequestCurrent(guard)) return false
    if (activeEvaluationId.value === null) {
      return setActive(returnedEvaluation)
    }
    if (returnedEvaluation.id === activeEvaluationId.value) {
      return updateActive(returnedEvaluation)
    }
    const expected = guard && guard.expectedEvaluationId
    if (expected && expected === activeEvaluationId.value) {
      return setActive(returnedEvaluation, { bumpGeneration: true })
    }
    return false
  }

  // Records the current trade scope and invalidates everything when it changes,
  // so a late response from a previous trade can never become active.
  function ensureTrade(tradeId) {
    if (!tradeId) return
    if (activeTradeId.value === tradeId) return
    generation.value += 1
    activeEvaluationId.value = null
    activeEvaluation.value = null
    activeTradeId.value = tradeId
    revision.value += 1
  }

  function clear() {
    generation.value += 1
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
    generation,
    revision,
    activeIsTerminal,
    activate,
    updateActive,
    beginRequest,
    isRequestCurrent,
    commitProgress,
    adoptPreparedEvaluation,
    ensureTrade,
    clear
  }
})
