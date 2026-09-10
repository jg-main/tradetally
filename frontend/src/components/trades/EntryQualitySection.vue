<template>
  <div
    v-if="trade"
    class="rounded-lg border border-gray-200 bg-white p-4 shadow dark:border-gray-700 dark:bg-gray-800"
  >
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-semibold text-gray-800 dark:text-gray-100">Entry Quality</h3>
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
          :disabled="store.preparing || !setupReady"
          class="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-60 dark:text-gray-300 dark:hover:bg-gray-800"
          data-testid="prepare-entry"
          @click="runPrepare"
        >
          <span v-if="store.preparing">Preparing…</span>
          <span v-else>{{ prepared ? 'Re-prepare Entry' : 'Prepare Entry' }}</span>
        </button>
      </div>
    </div>

    <p
      v-if="store.error"
      class="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400"
      data-testid="entry-error"
    >
      {{ store.error }}
    </p>

    <!-- Setup dependency gate -->
    <div v-if="!setupReady" class="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300" data-testid="setup-required">
      Evaluate Setup Quality first. Entry Quality uses the persisted confirmed Pivot and breakout
      session; it never re-detects them.
    </div>

    <template v-else>
      <div v-if="evidenceUnavailable.length" class="mb-3">
        <p class="text-xs font-medium text-gray-500 dark:text-gray-400">Unavailable evidence</p>
        <ul class="mt-1 list-inside list-disc text-xs text-gray-500 dark:text-gray-400">
          <li v-for="reason in evidenceUnavailable" :key="reason">{{ reasonLabel(reason) }}</li>
        </ul>
      </div>

      <!-- Setup dependency / entry context summary -->
      <div class="mb-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Confirmed Pivot</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-confirmed-pivot">
            {{ formatPrice(pivot) }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Breakout Session</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-breakout-session">
            {{ breakoutSession || '—' }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Actual Entry Session</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-actual-session">
            {{ actualEntrySession || '—' }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Initial Entry Time</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-initial-time">
            {{ formatDateTime(initialEntryTime) }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Entry Basis</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-basis">
            {{ formatPrice(entryBasis) }}
          </div>
          <div class="text-[10px] text-gray-400">{{ executionSourceLabel }}</div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Original Position</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-original-position">
            {{ originalPositionQty != null ? originalPositionQty : '—' }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Effective Trigger</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-effective-trigger">
            {{ effectiveTrigger != null ? formatPrice(effectiveTrigger) : '—' }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Initial R</div>
          <div class="font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-initial-r">
            {{ initialRText }}
          </div>
        </div>
      </div>

      <!-- Intended trigger (only when the active criteria require it) -->
      <div v-if="requiresIntendedTrigger" class="mb-3 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-700 dark:text-gray-300">Intended trigger</span>
          <span class="px-2 inline-flex text-xs font-semibold rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400">
            User asserted
          </span>
        </div>
        <select
          v-model="intendedTriggerType"
          class="mt-2 rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
          data-testid="entry-intended-trigger"
        >
          <option value="">Select…</option>
          <option v-for="type in allowedTriggerTypes" :key="type" :value="type">{{ type }}</option>
        </select>
        <p class="mt-1 text-[10px] text-gray-400">
          The intended trigger is stored with provenance user_asserted and cannot be relabelled after
          the fact to improve the grade.
        </p>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          :disabled="store.evaluating || !canEvaluate"
          class="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="run-entry"
          @click="runEvaluate"
        >
          {{ store.evaluating ? 'Evaluating…' : 'Run / Recalculate Entry Quality' }}
        </button>
        <span v-if="!canEvaluate" class="text-xs text-amber-600 dark:text-amber-400">
          Select the intended trigger first.
        </span>
        <span v-if="evaluation && evaluation.status !== 'completed'" class="text-xs text-gray-400">
          Draft progress — Management is added in a later phase.
        </span>
      </div>
    </template>

    <!-- Persisted Entry results -->
    <div v-if="entrySummary" class="mt-4">
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Score</div>
          <div class="text-lg font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-score">
            {{ scoreText }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Grade</div>
          <div class="text-lg font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-grade">
            {{ gradeText }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Compliance</div>
          <div class="text-lg font-semibold" :class="complianceClass" data-testid="entry-compliance">
            {{ complianceText }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Coverage</div>
          <div class="text-lg font-semibold text-gray-800 dark:text-gray-100" data-testid="entry-coverage">
            {{ coverageText }}
          </div>
        </div>
      </div>

      <ul class="mt-3 divide-y divide-gray-100 dark:divide-gray-800">
        <li v-for="row in criterionRows" :key="row.key" class="py-2" data-testid="entry-criterion-row">
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
              <span data-testid="entry-criterion-score">{{ scoreOrNa(row) }}</span>
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
import { useQualityEntryStore } from '@/stores/qualityEntry'

const props = defineProps({
  trade: { type: Object, required: true }
})

const store = useQualityEntryStore()

const prepared = ref(null)
const evaluation = ref(null)
const intendedTriggerType = ref('')

const CRITERION_LABELS = {
  breakout_session: 'Breakout Session',
  trigger_compliance: 'Trigger Compliance',
  volume_pace: 'Volume Pace',
  range_pace: 'Range Pace',
  entry_extension: 'Entry Extension',
  initial_stop: 'Initial Stop',
  stop_width: 'Stop Width / Volatility'
}

const EVIDENCE_REASON_LABELS = {
  daily_setup_snapshot: 'Setup daily evidence snapshot unavailable',
  entry_session_daily_bar: 'No daily bar for the actual entry session',
  execution_evidence: 'Actual opening execution evidence unavailable',
  actual_initial_stop: 'No actual initial protective stop is stored',
  entry_session_intraday: 'Entry-session intraday evidence unavailable'
}

watch(() => store.evaluation, (value) => {
  evaluation.value = value
  hydrateFromEvaluation(value)
})

watch(() => store.prepared, (value) => {
  prepared.value = value
  if (value) hydrateFromPrepared(value)
})

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

const setupReady = computed(() => {
  if (prepared.value && prepared.value.setupDependency && prepared.value.setupDependency.ready) return true
  const ev = evaluation.value
  return !!(ev && ev.results && ev.results.setup)
})

const entrySummary = computed(() => {
  const ev = evaluation.value
  if (!ev || !ev.results || !ev.results.entry) return null
  return ev.results.entry
})

const criterionRows = computed(() => {
  const summary = entrySummary.value
  return summary && Array.isArray(summary.criterionResults) ? summary.criterionResults : []
})

const evidenceUnavailable = computed(() => (prepared.value ? prepared.value.unavailableEvidence || [] : []))

const allowedTriggerTypes = computed(() => {
  if (prepared.value && Array.isArray(prepared.value.allowedTriggerTypes)) return prepared.value.allowedTriggerTypes
  const detected = evaluation.value && evaluation.value.detected_context
  if (detected && detected.entry && Array.isArray(detected.entry.allowed_trigger_types)) {
    return detected.entry.allowed_trigger_types
  }
  return []
})

function hydratedRequiredInputs() {
  if (prepared.value && Array.isArray(prepared.value.requiredEntryUserInputs)) {
    return prepared.value.requiredEntryUserInputs
  }
  // On reload, fall back to persisted entry context presence.
  const detected = evaluation.value && evaluation.value.detected_context
  if (detected && detected.entry && detected.entry.intended_trigger) return ['intended_trigger_type']
  return allowedTriggerTypes.value.length > 0 ? ['intended_trigger_type'] : []
}

const requiredInputs = computed(() => hydratedRequiredInputs())
const requiresIntendedTrigger = computed(() => requiredInputs.value.includes('intended_trigger_type'))

const canEvaluate = computed(() => {
  if (!setupReady.value) return false
  if (requiresIntendedTrigger.value && !intendedTriggerType.value) return false
  return true
})

const pivot = computed(() => {
  if (prepared.value && prepared.value.setupDependency) return prepared.value.setupDependency.confirmedPivot
  const detected = evaluation.value && evaluation.value.detected_context
  if (detected && detected.boundary) return detected.boundary.pivotPrice
  const inputs = evaluation.value && evaluation.value.user_inputs
  if (inputs && inputs.pivot) return inputs.pivot.price
  return null
})

const breakoutSession = computed(() => {
  if (prepared.value && prepared.value.setupDependency) return prepared.value.setupDependency.breakoutSession
  const detected = evaluation.value && evaluation.value.detected_context
  return detected && detected.entry ? detected.entry.breakout_session : null
})

const actualEntrySession = computed(() => {
  if (prepared.value && prepared.value.executionEvidence) return prepared.value.executionEvidence.actualEntrySession
  const detected = evaluation.value && evaluation.value.detected_context
  return detected && detected.entry ? detected.entry.actual_entry_session : null
})

const initialEntryTime = computed(() => {
  if (prepared.value && prepared.value.executionEvidence) return prepared.value.executionEvidence.initialEntryTime
  const execution = evaluation.value?.evidence_snapshot?.entry?.execution
  return execution ? execution.initial_entry_time : null
})

const entryBasis = computed(() => {
  if (prepared.value && prepared.value.executionEvidence) return prepared.value.executionEvidence.entryBasis
  const execution = evaluation.value?.evidence_snapshot?.entry?.execution
  return execution ? execution.entry_basis : null
})

const originalPositionQty = computed(() => {
  if (prepared.value && prepared.value.executionEvidence) return prepared.value.executionEvidence.originalPositionQty
  const execution = evaluation.value?.evidence_snapshot?.entry?.execution
  return execution ? execution.original_position_qty : null
})

const effectiveTrigger = computed(() => {
  if (prepared.value && prepared.value.effectiveTrigger != null) return prepared.value.effectiveTrigger
  const trigger = evaluation.value?.evidence_snapshot?.entry?.trigger
  return trigger ? trigger.effective_trigger : null
})

const executionSourceLabel = computed(() => {
  const source = prepared.value?.executionEvidence?.provenance?.source
    || evaluation.value?.evidence_snapshot?.entry?.execution?.provenance?.source
  if (source === 'executions_jsonb') return 'actual fills'
  if (source === 'trade_level_fields') return 'trade-level fallback'
  return source || ''
})

const initialRText = computed(() => {
  const initialR = prepared.value?.initialR
    || evaluation.value?.evidence_snapshot?.entry?.initial_r
  if (initialR && initialR.available) return `$${formatPrice(initialR.r_per_share)} / share`
  return 'N/A'
})

const scoreText = computed(() => (entrySummary.value && typeof entrySummary.value.score === 'number' ? entrySummary.value.score : 'N/A'))
const gradeText = computed(() => (entrySummary.value && entrySummary.value.grade ? entrySummary.value.grade : 'N/A'))
const complianceText = computed(() => (entrySummary.value ? entrySummary.value.compliance || 'N/A' : 'N/A'))
const coverageText = computed(() => (entrySummary.value && typeof entrySummary.value.coverage === 'number' ? `${entrySummary.value.coverage}%` : 'N/A'))
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
  if (typeof inputs.intended_trigger_type === 'string') {
    intendedTriggerType.value = inputs.intended_trigger_type
  }
}

function hydrateFromPrepared(value) {
  if (value.executionEvidence) {
    // Surface provenance/context already computed by prepare.
  }
  const detected = value.evaluation && value.evaluation.detected_context
  const inputs = value.evaluation && value.evaluation.user_inputs
  if (inputs && typeof inputs.intended_trigger_type === 'string') {
    intendedTriggerType.value = inputs.intended_trigger_type
  } else if (detected && detected.entry && detected.entry.intended_trigger) {
    intendedTriggerType.value = detected.entry.intended_trigger.value
  }
}

async function runPrepare() {
  const evaluationId = evaluation.value && evaluation.value.id
  try {
    const payload = await store.prepare(props.trade.id, { evaluationId })
    prepared.value = payload
    evaluation.value = payload.evaluation || evaluation.value
  } catch (err) {
    // store.error is already surfaced
  }
}

async function runEvaluate() {
  if (!canEvaluate.value) return
  const evaluationId = (prepared.value && prepared.value.evaluation && prepared.value.evaluation.id)
    || (evaluation.value && evaluation.value.id)
  if (!evaluationId) {
    store.error = 'Prepare Entry first.'
    return
  }
  const userInputs = {}
  if (requiresIntendedTrigger.value) userInputs.intended_trigger_type = intendedTriggerType.value
  try {
    const payload = await store.evaluate(props.trade.id, { evaluationId, userInputs })
    evaluation.value = payload.evaluation
    prepared.value = { ...(prepared.value || {}), evaluation: payload.evaluation }
  } catch (err) {
    // store.error is already surfaced
  }
}

onMounted(async () => {
  try {
    const list = await store.fetchEvaluations(props.trade.id)
    const latestDraft = Array.isArray(list)
      ? list.find((item) => item.status !== 'completed' && item.status !== 'insufficient_data')
      : null
    evaluation.value = store.evaluation || latestDraft || null
    hydrateFromEvaluation(evaluation.value)
  } catch (err) {
    // The panel shows the Setup gate/CTA instead.
  }
})

function criterionLabel(key) {
  return CRITERION_LABELS[key] || key
}

function formatDate(value) {
  return value || '—'
}

function formatDateTime(value) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString()
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

function reasonLabel(reason) {
  return EVIDENCE_REASON_LABELS[reason] || reason
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
