<template>
  <div
    v-if="trade"
    class="rounded-lg border border-gray-200 bg-white p-4 shadow dark:border-gray-700 dark:bg-gray-800"
  >
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-semibold text-gray-800 dark:text-gray-100">Management Quality</h3>
        <span
          v-if="profileLabel"
          class="px-2 inline-flex text-xs font-semibold rounded-full bg-primary-100 text-primary-800 dark:bg-primary-900/20 dark:text-primary-400 whitespace-nowrap"
        >
          {{ profileLabel }}
        </span>
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          :disabled="store.preparing || !entryReady"
          class="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-60 dark:text-gray-300 dark:hover:bg-gray-800"
          data-testid="prepare-management"
          @click="runPrepare"
        >
          <span v-if="store.preparing">Preparing…</span>
          <span v-else>{{ prepared ? 'Re-prepare Management' : 'Prepare Management' }}</span>
        </button>
      </div>
    </div>

    <p
      v-if="store.error"
      class="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400"
      data-testid="management-error"
    >
      {{ store.error }}
    </p>

    <!-- Entry dependency gate -->
    <div
      v-if="!entryReady"
      class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
      data-testid="entry-required"
    >
      Evaluate Setup and Entry Quality first. Management Quality uses the immutable Initial R, Entry
      Basis, and original position persisted by Entry Quality; it never re-derives them.
    </div>

    <template v-else>
      <!-- Entry dependency summary -->
      <div class="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Entry Basis</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="mgmt-entry-basis">
            {{ formatPrice(entryBasis) }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Original Position</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="mgmt-original-position">
            {{ originalPositionQty != null ? originalPositionQty : '—' }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Initial R</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="mgmt-initial-r">
            {{ initialRText }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Stop History</div>
          <div class="font-semibold text-amber-600 dark:text-amber-400" data-testid="mgmt-stop-history">
            Unavailable
          </div>
        </div>
      </div>

      <p v-if="stopHistoryUnavailable" class="mb-3 text-[11px] text-gray-500 dark:text-gray-400" data-testid="mgmt-stop-history-note">
        TradeTally stores a single mutable stop-loss value plus a UI-only change log, not a complete
        stop-order lifecycle. Stop Ratchet and Post-Partial Breakeven therefore report UNKNOWN rather
        than a fabricated PASS/FAIL.
      </p>

      <!-- Trailing phase activation -->
      <div v-if="requiresActivationAssertion" class="mb-3 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-700 dark:text-gray-300">Trailing phase activated?</span>
          <span class="px-2 inline-flex text-xs font-semibold rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400">
            User asserted (post-trade)
          </span>
        </div>
        <div v-if="phaseLocked" class="mt-2" data-testid="mgmt-phase-locked">
          <span class="rounded-md border border-gray-300 bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200">
            {{ trailingPhase === 'activated' ? 'Activated' : 'Not activated' }}
          </span>
        </div>
        <select
          v-else
          v-model="trailingPhase"
          class="mt-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
          data-testid="mgmt-phase-select"
        >
          <option value="">Select…</option>
          <option value="activated">Activated</option>
          <option value="not_activated">Not activated</option>
        </select>
        <div v-if="activationSessionNeeded" class="mt-2" data-testid="mgmt-activation-session-block">
          <label class="text-[11px] text-gray-500 dark:text-gray-400">Activation session (YYYY-MM-DD)</label>
          <input
            v-model="trailingActivationSession"
            type="date"
            class="mt-1 block rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
            data-testid="mgmt-activation-session"
          />
          <p class="mt-1 text-[10px] text-gray-400">
            The authoritative session at which the trailing rule became active. Signals before this
            session are not evaluated.
          </p>
        </div>
        <div
          v-else-if="activationSessionLocked && trailingPhase === 'activated'"
          class="mt-2"
          data-testid="mgmt-activation-session-locked"
        >
          <span class="rounded-md border border-gray-300 bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200">
            Active from {{ trailingActivationSession || 'asserted session' }}
          </span>
        </div>
        <p class="mt-1 text-[10px] text-gray-400">
          The trailing phase is applicable only if it activated. If it never activated, the trailing MA
          exit is NOT_APPLICABLE and no MA selection is required.
        </p>
      </div>
      <p
        v-else-if="trailingActivation === 'after_partial'"
        class="mb-3 text-[11px] text-gray-500 dark:text-gray-400"
        data-testid="mgmt-activation-after-partial"
      >
        Trailing phase activates only after the canonical partial is completed; a close below the MA
        before activation is irrelevant.
      </p>

      <!-- Trailing MA selection -->
      <div v-if="smaRequired" class="mb-3 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-700 dark:text-gray-300">Trailing MA (exit signal)</span>
          <span class="px-2 inline-flex text-xs font-semibold rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400">
            User asserted (post-trade)
          </span>
        </div>
        <div v-if="trailingLocked" class="mt-2 flex items-center gap-2" data-testid="mgmt-trailing-locked">
          <span class="rounded-md border border-gray-300 bg-gray-100 px-2 py-1 text-xs font-semibold text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200">
            SMA{{ trailingPeriod }}
          </span>
          <span class="text-[10px] text-gray-400">locked</span>
        </div>
        <select
          v-else
          v-model="trailingPeriod"
          class="mt-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
          data-testid="mgmt-trailing-select"
        >
          <option value="">Select…</option>
          <option v-for="period in allowedTrailingPeriods" :key="period" :value="period">SMA{{ period }}</option>
        </select>
        <p class="mt-1 text-[10px] text-gray-400">
          The trailing MA selection is stored with honest post-trade provenance. Once saved it is
          frozen for this evaluation; the non-selected MA does not affect grading.
        </p>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          :disabled="store.evaluating || !canEvaluate"
          class="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="run-management"
          @click="runEvaluate"
        >
          {{ store.evaluating ? 'Evaluating…' : 'Run / Recalculate Management Quality' }}
        </button>
        <button
          v-if="canFinalize"
          type="button"
          :disabled="store.finalizing || evaluationIsTerminal"
          class="rounded-md bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="finalize-evaluation"
          @click="runFinalize"
        >
          {{ store.finalizing ? 'Completing…' : 'Complete Evaluation' }}
        </button>
        <span v-if="!canEvaluate" class="text-xs text-amber-600 dark:text-amber-400">
          {{ activationSessionNeeded && !trailingActivationSession
            ? 'Enter the activation session first.'
            : (smaRequired && !trailingPeriod ? 'Select a trailing MA first.' : '') }}
        </span>
      </div>
    </template>

    <!-- Persisted Management results -->
    <div v-if="managementSummary" class="mt-4">
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Score</div>
          <div class="text-lg font-semibold text-gray-800 dark:text-gray-100" data-testid="mgmt-score">
            {{ scoreText }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Grade</div>
          <div class="text-lg font-semibold text-gray-800 dark:text-gray-100" data-testid="mgmt-grade">
            {{ gradeText }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Compliance</div>
          <div class="text-lg font-semibold" :class="complianceClass" data-testid="mgmt-compliance">
            {{ complianceText }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Coverage</div>
          <div class="text-lg font-semibold text-gray-800 dark:text-gray-100" data-testid="mgmt-coverage">
            {{ coverageText }}
          </div>
        </div>
      </div>

      <ul class="mt-3 divide-y divide-gray-100 dark:divide-gray-800">
        <li v-for="row in criterionRows" :key="row.key" class="py-2" data-testid="mgmt-criterion-row">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <div class="flex items-center gap-2">
              <span class="text-xs font-semibold text-gray-700 dark:text-gray-200">
                {{ criterionLabel(row.key) }}
              </span>
              <span class="status-badge" :class="statusClass(row.status)">{{ row.status }}</span>
              <span v-if="row.required" class="text-[10px] text-gray-400">required</span>
            </div>
            <div class="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
              <span>weight {{ row.weight }}%</span>
              <span data-testid="mgmt-criterion-score">{{ scoreOrNa(row) }}</span>
            </div>
          </div>
          <p v-if="row.message" class="mt-1 text-xs text-gray-500 dark:text-gray-400">{{ row.message }}</p>
          <details class="mt-1">
            <summary class="cursor-pointer text-[11px] text-primary-600 dark:text-primary-400">Evidence</summary>
            <pre class="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">{{ evidenceText(row) }}</pre>
          </details>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useQualityManagementStore } from '@/stores/qualityManagement'
import { useQualityWorkflowStore } from '@/stores/qualityWorkflow'

const props = defineProps({
  trade: { type: Object, required: true }
})

const store = useQualityManagementStore()
const workflow = useQualityWorkflowStore()

const prepared = ref(null)
const evaluation = ref(null)
const trailingPeriod = ref('')
const trailingPhase = ref('')
const trailingActivationSession = ref('')

const CRITERION_LABELS = {
  partial_timing: 'Partial Timing',
  partial_sizing: 'Partial Sizing',
  no_premature_reduction: 'No Premature Reduction',
  stop_ratchet: 'Stop Ratchet (Never Lower)',
  post_partial_breakeven: 'Post-Partial Breakeven',
  trailing_ma: 'Trailing MA Exit'
}

watch(() => store.evaluation, (value) => {
  // An explicitly selected active evaluation must not be overridden by the
  // store's independent "latest draft" discovery.
  if (workflow.activeEvaluationId && value && value.id !== workflow.activeEvaluationId) return
  evaluation.value = value
  hydrateFromEvaluation(value)
})

// Follow the active workflow row (started by History or progressed by
// Setup/Entry) so Management always operates on the SAME evaluation.
watch(() => workflow.activeEvaluation, (value) => {
  if (value && value.id === workflow.activeEvaluationId) {
    evaluation.value = value
    hydrateFromEvaluation(value)
  }
})

// Evaluation-local state must not leak from D1 into a fresh D2 (in particular
// the trailing selections and the prepared entryDependency). Reset on an actual
// identity change only; same-id progress keeps its state, and an initial
// activation (null -> first id) must not wipe state hydrated from the persisted
// row.
watch(() => workflow.activeEvaluationId, (newId, oldId) => {
  if (newId === oldId) return
  if (newId === null || newId === undefined) {
    resetEvaluationLocalState()
    return
  }
  const identityChanged = oldId !== null && oldId !== undefined
  if (identityChanged) {
    const keepPrepared = !!(
      prepared.value &&
      prepared.value.evaluation &&
      prepared.value.evaluation.id === newId
    )
    resetEvaluationLocalState({ keepPrepared })
  }
  if (workflow.activeEvaluation && workflow.activeEvaluation.id === newId) {
    evaluation.value = workflow.activeEvaluation
    hydrateFromEvaluation(workflow.activeEvaluation)
  }
  if (store.evaluation && store.evaluation.id === newId) {
    evaluation.value = store.evaluation
    hydrateFromEvaluation(store.evaluation)
  }
})

watch(() => store.prepared, (value) => {
  // A stale prepare response for a superseded evaluation must not hydrate the
  // explicit active workflow row.
  if (
    workflow.activeEvaluationId &&
    value &&
    value.evaluation &&
    value.evaluation.id !== workflow.activeEvaluationId
  ) {
    return
  }
  prepared.value = value
  if (value) hydrateFromPrepared(value)
})

// Clears every evaluation-local ref so a fresh evaluation cannot inherit the
// previous one's trailing selections or prepared dependency gate.
function resetEvaluationLocalState({ keepPrepared = false } = {}) {
  if (!keepPrepared) prepared.value = null
  evaluation.value = null
  trailingPeriod.value = ''
  trailingPhase.value = ''
  trailingActivationSession.value = ''
}

const profileLabel = computed(() => {
  const prep = prepared.value
  if (prep && prep.profileVersion) {
    return `${prep.profileVersion.profileName || 'Quality Profile'} v${prep.profileVersion.versionNumber}`
  }
  const ev = evaluation.value
  if (ev && ev.profile_name && ev.version_number != null) {
    return `${ev.profile_name} v${ev.version_number}`
  }
  return null
})

const entryReady = computed(() => {
  if (prepared.value && prepared.value.entryDependency && prepared.value.entryDependency.ready) return true
  const ev = evaluation.value
  return !!(ev && ev.results && ev.results.entry)
})

const managementSummary = computed(() => {
  const ev = evaluation.value
  if (!ev || !ev.results || !ev.results.management) return null
  return ev.results.management
})

const criterionRows = computed(() => {
  const summary = managementSummary.value
  return summary && Array.isArray(summary.criterionResults) ? summary.criterionResults : []
})

const allowedTrailingPeriods = computed(() => {
  if (prepared.value && Array.isArray(prepared.value.allowedTrailingPeriods)) {
    return prepared.value.allowedTrailingPeriods
  }
  return []
})

const requiresTrailingMa = computed(() => {
  if (prepared.value && Array.isArray(prepared.value.requiredManagementUserInputs)) {
    return prepared.value.requiredManagementUserInputs.includes('trailing_ma_period')
  }
  const detected = evaluation.value && evaluation.value.detected_context
  if (detected && detected.management && detected.management.trailing_ma) return true
  return allowedTrailingPeriods.value.length > 0
})

const trailingLocked = computed(() => {
  const prep = prepared.value && prepared.value.trailingMa
  if (prep && prep.established) return true
  const inputs = evaluation.value && evaluation.value.user_inputs
  if (inputs && typeof inputs.trailing_ma_period === 'number') return true
  const detected = evaluation.value && evaluation.value.detected_context
  return !!(detected && detected.management && detected.management.trailing_ma && detected.management.trailing_ma.value)
})

const trailingActivation = computed(() => {
  if (prepared.value && prepared.value.policy && prepared.value.policy.trailingActivation) {
    return prepared.value.policy.trailingActivation
  }
  const evidence = evaluation.value?.evidence_snapshot?.management
  return (evidence && evidence.policy && evidence.policy.trailing_activation) || null
})

const requiresActivationAssertion = computed(() => trailingActivation.value === 'explicit')

const phaseLocked = computed(() => {
  const prep = prepared.value && prepared.value.trailingMa
  if (prep && prep.phaseEstablished) return true
  const inputs = evaluation.value && evaluation.value.user_inputs
  if (inputs && (inputs.trailing_phase === 'activated' || inputs.trailing_phase === 'not_activated')) return true
  const detected = evaluation.value && evaluation.value.detected_context
  return !!(detected && detected.management && detected.management.trailing_phase && detected.management.trailing_phase.value)
})

const phaseNotActivated = computed(() => trailingPhase.value === 'not_activated')

// Whether the SMA selection is actually required. prepare() resolves
// deterministic applicability (e.g. canonical after_partial with a
// never-triggered partial needs no SMA), falling back to the config-level
// requirement for older payloads.
const smaRequired = computed(() => {
  // For explicit activation the requirement follows the local phase assertion
  // (the prepared payload was computed before the user asserted the phase).
  if (requiresActivationAssertion.value) return trailingPhase.value === 'activated'
  const prep = prepared.value && prepared.value.trailingMa
  if (prep && typeof prep.smaRequired === 'boolean') return prep.smaRequired
  if (prepared.value && Array.isArray(prepared.value.requiredManagementUserInputs)) {
    return prepared.value.requiredManagementUserInputs.includes('trailing_ma_period')
  }
  return requiresTrailingMa.value
})

const activationSessionLocked = computed(() => {
  const prep = prepared.value && prepared.value.trailingMa
  if (prep && prep.activationSessionEstablished) return true
  const inputs = evaluation.value && evaluation.value.user_inputs
  if (inputs && typeof inputs.trailing_activation_session === 'string' && inputs.trailing_activation_session) return true
  const detected = evaluation.value && evaluation.value.detected_context
  return !!(detected && detected.management && detected.management.trailing_activation && detected.management.trailing_activation.session)
})

const activationSessionNeeded = computed(
  () => requiresActivationAssertion.value && trailingPhase.value === 'activated' && !activationSessionLocked.value
)

const canEvaluate = computed(() => {
  if (!entryReady.value) return false
  if (requiresActivationAssertion.value && !phaseLocked.value && !trailingPhase.value) return false
  if (activationSessionNeeded.value && !trailingActivationSession.value) return false
  if (smaRequired.value && !trailingLocked.value && !trailingPeriod.value && !phaseNotActivated.value) return false
  return true
})

const evaluationIsTerminal = computed(() => {
  const status = evaluation.value && evaluation.value.status
  return status === 'completed' || status === 'insufficient_data'
})

const canFinalize = computed(() => {
  const ev = evaluation.value
  if (!ev || !ev.results) return false
  return !!(ev.results.setup && ev.results.entry && ev.results.management)
})

const entryBasis = computed(() => {
  if (prepared.value && prepared.value.entryDependency) return prepared.value.entryDependency.entryBasis
  const execution = evaluation.value?.evidence_snapshot?.entry?.execution
  return execution ? execution.entry_basis : null
})

const originalPositionQty = computed(() => {
  if (prepared.value && prepared.value.entryDependency) return prepared.value.entryDependency.originalPositionQty
  const execution = evaluation.value?.evidence_snapshot?.entry?.execution
  return execution ? execution.original_position_qty : null
})

const initialRText = computed(() => {
  const initialR = prepared.value?.entryDependency?.initialR
    || evaluation.value?.evidence_snapshot?.entry?.initial_r
  if (initialR && initialR.available) return `$${formatPrice(initialR.r_per_share)} / share`
  return 'UNKNOWN'
})

const stopHistoryUnavailable = computed(() => {
  const evidence = evaluation.value?.evidence_snapshot?.management
  if (evidence && evidence.stop_history && evidence.stop_history.available === false) return true
  return criterionRows.value.some(
    (row) => (row.key === 'stop_ratchet' || row.key === 'post_partial_breakeven') && row.status === 'UNKNOWN'
  )
})

const scoreText = computed(() => (managementSummary.value && typeof managementSummary.value.score === 'number' ? managementSummary.value.score : 'N/A'))
const gradeText = computed(() => (managementSummary.value && managementSummary.value.grade ? managementSummary.value.grade : 'N/A'))
const complianceText = computed(() => (managementSummary.value ? managementSummary.value.compliance || 'N/A' : 'N/A'))
const coverageText = computed(() => (managementSummary.value && typeof managementSummary.value.coverage === 'number' ? `${managementSummary.value.coverage}%` : 'N/A'))
const complianceClass = computed(() => {
  const value = complianceText.value
  if (value === 'PASS') return 'text-green-600 dark:text-green-400'
  if (value === 'FAIL') return 'text-red-600 dark:text-red-400'
  if (value === 'INCOMPLETE') return 'text-amber-600 dark:text-amber-400'
  return 'text-gray-500'
})

function hydrateFromEvaluation(value) {
  if (!value) return
  const inputs = value.user_inputs || {}
  if (typeof inputs.trailing_ma_period === 'number' && inputs.trailing_ma_period) {
    trailingPeriod.value = inputs.trailing_ma_period
  }
  if (inputs.trailing_phase === 'activated' || inputs.trailing_phase === 'not_activated') {
    trailingPhase.value = inputs.trailing_phase
  }
  if (typeof inputs.trailing_activation_session === 'string' && inputs.trailing_activation_session) {
    trailingActivationSession.value = inputs.trailing_activation_session
  }
  const detected = value.detected_context
  if (!trailingPeriod.value && detected && detected.management && detected.management.trailing_ma) {
    trailingPeriod.value = detected.management.trailing_ma.value
  }
  if (!trailingPhase.value && detected && detected.management && detected.management.trailing_phase) {
    trailingPhase.value = detected.management.trailing_phase.value
  }
  if (!trailingActivationSession.value && detected && detected.management && detected.management.trailing_activation) {
    trailingActivationSession.value = detected.management.trailing_activation.session
  }
}

function hydrateFromPrepared(value) {
  if (value.trailingMa && value.trailingMa.established) {
    trailingPeriod.value = value.trailingMa.value
  }
  if (value.trailingMa && value.trailingMa.phase) {
    trailingPhase.value = value.trailingMa.phase
  }
  if (value.trailingMa && value.trailingMa.activationSession) {
    trailingActivationSession.value = value.trailingMa.activationSession
  }
  const inputs = value.evaluation && value.evaluation.user_inputs
  if (!trailingPeriod.value && inputs && typeof inputs.trailing_ma_period === 'number') {
    trailingPeriod.value = inputs.trailing_ma_period
  }
  if (!trailingPhase.value && inputs && (inputs.trailing_phase === 'activated' || inputs.trailing_phase === 'not_activated')) {
    trailingPhase.value = inputs.trailing_phase
  }
  if (!trailingActivationSession.value && inputs && typeof inputs.trailing_activation_session === 'string') {
    trailingActivationSession.value = inputs.trailing_activation_session
  }
}

async function runPrepare() {
  const evaluationId = workflow.activeEvaluationId || (evaluation.value && evaluation.value.id)
  try {
    const payload = await store.prepare(props.trade.id, { evaluationId })
    prepared.value = payload
    evaluation.value = payload.evaluation || evaluation.value
    if (payload.evaluation) workflow.updateActive(payload.evaluation)
  } catch (err) {
    // store.error is already surfaced
  }
}

async function runEvaluate() {
  if (!canEvaluate.value) return
  const evaluationId = workflow.activeEvaluationId
    || (prepared.value && prepared.value.evaluation && prepared.value.evaluation.id)
    || (evaluation.value && evaluation.value.id)
  if (!evaluationId) {
    store.error = 'Prepare Management first.'
    return
  }
  const userInputs = {}
  if (requiresActivationAssertion.value && trailingPhase.value) userInputs.trailing_phase = trailingPhase.value
  if (trailingPhase.value === 'activated' && trailingActivationSession.value && !activationSessionLocked.value) {
    userInputs.trailing_activation_session = trailingActivationSession.value
  }
  if (smaRequired.value && trailingPeriod.value && !phaseNotActivated.value) {
    userInputs.trailing_ma_period = trailingPeriod.value
  }
  try {
    const payload = await store.evaluate(props.trade.id, { evaluationId, userInputs })
    evaluation.value = payload.evaluation
    prepared.value = { ...(prepared.value || {}), evaluation: payload.evaluation }
    if (payload.evaluation) workflow.updateActive(payload.evaluation)
  } catch (err) {
    // store.error is already surfaced
  }
}

async function runFinalize() {
  const evaluationId = workflow.activeEvaluationId || (evaluation.value && evaluation.value.id)
  if (!evaluationId) return
  try {
    const payload = await store.finalize(props.trade.id, { evaluationId })
    evaluation.value = payload.evaluation
    // Publishing the terminal row updates History from draft to terminal
    // without a page reload, and never changes the primary.
    if (payload.evaluation) workflow.updateActive(payload.evaluation)
  } catch (err) {
    // store.error is already surfaced
  }
}

onMounted(async () => {
  try {
    workflow.ensureTrade(props.trade.id)
    const list = await store.fetchEvaluations(props.trade.id)
    if (
      workflow.activeEvaluationId &&
      workflow.activeEvaluation &&
      workflow.activeEvaluation.id === workflow.activeEvaluationId
    ) {
      evaluation.value = workflow.activeEvaluation
    } else {
      const latestDraft = Array.isArray(list)
        ? list.find((item) => item.status !== 'completed' && item.status !== 'insufficient_data')
        : null
      evaluation.value = store.evaluation || latestDraft || null
    }
    hydrateFromEvaluation(evaluation.value)
  } catch (err) {
    // The panel shows the Entry gate/CTA instead.
  }
})

function criterionLabel(key) {
  return CRITERION_LABELS[key] || key
}

function formatPrice(value) {
  if (value === null || value === undefined || value === '') return '—'
  const number = Number(value)
  return Number.isFinite(number)
    ? number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '—'
}

function scoreOrNa(row) {
  if (row.status === 'PASS' || row.status === 'FAIL') {
    return typeof row.score === 'number' ? `score ${row.score}` : 'score N/A'
  }
  return row.status === 'NOT_APPLICABLE' ? 'N/A' : 'no score'
}

function rowValue(row, camelKey, snakeKey) {
  if (row[camelKey] !== undefined && row[camelKey] !== null) return row[camelKey]
  return row[snakeKey] ?? null
}

function evidenceText(row) {
  const payload = {
    status: row.status,
    rawValue: rowValue(row, 'rawValue', 'raw_value'),
    scoringValue: rowValue(row, 'scoringValue', 'scoring_value'),
    message: row.message || null,
    evidence: row.evidence || null
  }
  return JSON.stringify(payload, null, 2)
}

function statusClass(status) {
  const map = {
    PASS: 'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400',
    FAIL: 'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400',
    NOT_APPLICABLE: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
    UNKNOWN: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
  }
  return map[status] || 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
}
</script>

<style scoped>
.status-badge {
  @apply px-2 inline-flex text-xs leading-5 font-semibold rounded-full;
}
</style>
