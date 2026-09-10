<template>
  <div
    v-if="trade"
    class="rounded-lg border border-gray-200 bg-white p-4 shadow dark:border-gray-700 dark:bg-gray-800"
  >
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center gap-2">
        <h3 class="text-sm font-semibold text-gray-800 dark:text-gray-100">Setup Quality</h3>
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
          :disabled="store.preparing"
          class="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-60 dark:text-gray-300 dark:hover:bg-gray-800"
          data-testid="prepare-setup"
          @click="runPrepare"
        >
          <span v-if="store.preparing">Preparing…</span>
          <span v-else>{{ prepared ? 'Re-detect' : 'Prepare Setup' }}</span>
        </button>
        <button
          v-if="hasPersistedResults"
          type="button"
          class="rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
          data-testid="clear-setup"
          @click="resetPanel"
        >
          Reset
        </button>
      </div>
    </div>

    <p
      v-if="store.error"
      class="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400"
      data-testid="setup-error"
    >
      {{ store.error }}
    </p>

    <div v-if="evidenceUnavailable.length" class="mb-3">
      <p class="text-xs font-medium text-gray-500 dark:text-gray-400">Unavailable evidence</p>
      <ul class="mt-1 list-inside list-disc text-xs text-gray-500 dark:text-gray-400">
        <li v-for="reason in evidenceUnavailable" :key="reason">{{ reasonLabel(reason) }}</li>
      </ul>
    </div>

    <!-- Not prepared yet -->
    <div v-if="!prepared && !loadingExisting" class="py-2">
      <p class="text-xs text-gray-500 dark:text-gray-400">
        Evaluate the setup quality of this trade against a Quality Profile (Canonical BO v1 by
        default). TradeTally detects the Base Start and Pivot from daily market data; you confirm
        or adjust them and answer the leader question.
      </p>
    </div>

    <template v-else-if="prepared">
      <!-- Leader (only when the active profile requires the leader assertion) -->
      <div v-if="requiresInput('leader_confirmed')" class="mb-3 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-700 dark:text-gray-300">Leader</span>
          <span
            v-if="leader !== null"
            class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400"
          >
            User asserted
          </span>
        </div>
        <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
          Is this stock a leader? (canonical source is your confirmation — TradeTally does not
          calculate relative strength)
        </p>
        <div class="mt-2 flex gap-4">
          <label class="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
            <input v-model="leader" type="radio" :value="true" data-testid="leader-yes" />
            Yes
          </label>
          <label class="inline-flex items-center gap-1.5 text-sm text-gray-700 dark:text-gray-300">
            <input v-model="leader" type="radio" :value="false" data-testid="leader-no" />
            No
          </label>
        </div>
      </div>

      <!-- Base Start (only when the active profile depends on structural context) -->
      <div v-if="requiresInput('base_start')" class="mb-3 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-700 dark:text-gray-300">Base Start</span>
          <span v-if="baseStartInput" class="provenance-badge" :class="provenanceClass(baseStartInput.source)">
            {{ provenanceLabel(baseStartInput.source) }}
          </span>
        </div>
        <template v-if="prepared.detectedBaseStart">
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Detected:
            <span class="font-medium text-gray-700 dark:text-gray-300">
              {{ formatDate(prepared.detectedBaseStart.date) }}
            </span>
            <span v-if="prepared.detectedBaseStart.price != null"> at ${{ formatPrice(prepared.detectedBaseStart.price) }}</span>
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              class="rounded-md bg-primary-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-primary-700"
              data-testid="confirm-base-start"
              @click="confirmBaseStart"
            >
              Confirm
            </button>
            <button
              type="button"
              class="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              data-testid="adjust-base-start"
              @click="adjustBaseStart"
            >
              Adjust
            </button>
          </div>
        </template>
        <p v-else class="mt-1 text-xs text-amber-600 dark:text-amber-400">
          No Base Start could be detected from the available evidence — use Adjust to enter the
          session where the base began.
        </p>

        <div v-if="baseStartAdjusted" class="mt-2 flex flex-wrap items-center gap-2">
          <input
            v-model="baseStartDateInput"
            type="date"
            class="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
            data-testid="base-start-date-input"
          />
          <span class="text-xs text-gray-500 dark:text-gray-400">
            Trading session date (must exist in the evidence and be before the entry session)
          </span>
        </div>
      </div>

      <!-- Pivot (only when the active profile depends on structural context) -->
      <div v-if="requiresInput('pivot')" class="mb-3 rounded-md bg-gray-50 px-3 py-2 dark:bg-gray-800">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-gray-700 dark:text-gray-300">Pivot</span>
          <div class="flex items-center gap-2">
            <span
              v-if="prepared.detectedPivot"
              class="px-2 inline-flex text-xs leading-5 font-semibold rounded-full bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
              :title="`Detection confidence: ${prepared.detectedPivot.detectionConfidence || 'n/a'} — evidence only, never part of the score`"
            >
              confidence {{ prepared.detectedPivot.detectionConfidence || 'n/a' }}
            </span>
            <span v-if="pivotInput" class="provenance-badge" :class="provenanceClass(pivotInput.source)">
              {{ provenanceLabel(pivotInput.source) }}
            </span>
          </div>
        </div>
        <template v-if="prepared.detectedPivot">
          <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            Detected:
            <span class="font-medium text-gray-700 dark:text-gray-300">${{ formatPrice(prepared.detectedPivot.price) }}</span>
            <span v-if="prepared.detectedPivot.date"> on {{ formatDate(prepared.detectedPivot.date) }}</span>
          </p>
          <div class="mt-2 flex flex-wrap gap-2">
            <button
              v-if="!pivotNeedsBaseReDetect"
              type="button"
              class="rounded-md bg-primary-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-primary-700"
              data-testid="confirm-pivot"
              @click="confirmPivot"
            >
              Confirm
            </button>
            <button
              type="button"
              class="rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              data-testid="adjust-pivot"
              @click="adjustPivot"
            >
              Adjust
            </button>
          </div>
          <div
            v-if="pivotNeedsBaseReDetect"
            class="mt-2 flex flex-wrap items-center gap-2 rounded-md bg-amber-50 px-2 py-1.5 text-xs text-amber-800 dark:bg-amber-900/20 dark:text-amber-300"
          >
            <span>
              The detected Pivot was derived from a different Base Start. Re-detect it against the
              current Base Start before confirming it as machine-detected (or adjust the Pivot
              manually).
            </span>
            <button
              type="button"
              class="rounded-md bg-amber-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-amber-700"
              data-testid="detect-pivot-with-base"
              @click="detectPivotForConfirmedBase"
            >
              Detect Pivot using confirmed Base Start
            </button>
          </div>
        </template>
        <p v-else class="mt-1 text-xs text-amber-600 dark:text-amber-400">
          No Pivot could be detected from the available evidence — use Adjust to enter the pivot
          price the setup must clear.
        </p>

        <div v-if="pivotAdjusted" class="mt-2 flex flex-wrap items-center gap-2">
          <label class="text-xs text-gray-500 dark:text-gray-400">Price</label>
          <input
            v-model="pivotPriceInput"
            type="number"
            min="0"
            step="0.01"
            class="rounded-md border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 dark:border-gray-600 dark:bg-gray-900 dark:text-gray-200"
            data-testid="pivot-price-input"
          />
        </div>
      </div>

      <div class="mt-2 flex flex-wrap items-center gap-3">
        <button
          type="button"
          :disabled="store.evaluating || !canEvaluate"
          class="rounded-md bg-primary-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-60"
          data-testid="run-setup"
          @click="runEvaluate"
        >
          {{ store.evaluating ? 'Evaluating…' : 'Run / Recalculate Setup Quality' }}
        </button>
        <span v-if="!canEvaluate" class="text-xs text-amber-600 dark:text-amber-400">
          {{ missingInputsText }}
        </span>
        <span v-if="evaluation && evaluation.status !== 'completed'" class="text-xs text-gray-400">
          Draft progress — Entry/Management are added in later phases.
        </span>
      </div>
    </template>

    <!-- Persisted Setup results -->
    <div v-if="evaluation && evaluation.results && evaluation.results.setup" class="mt-4">
      <div class="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Score</div>
          <div class="text-lg font-semibold text-gray-800 dark:text-gray-100" data-testid="setup-score">
            {{ scoreText }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Grade</div>
          <div class="text-lg font-semibold text-gray-800 dark:text-gray-100" data-testid="setup-grade">
            {{ gradeText }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Compliance</div>
          <div class="text-lg font-semibold" :class="complianceClass" data-testid="setup-compliance">
            {{ complianceText }}
          </div>
        </div>
        <div class="rounded-md bg-gray-50 px-3 py-2 text-center dark:bg-gray-800">
          <div class="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400">Coverage</div>
          <div class="text-lg font-semibold text-gray-800 dark:text-gray-100" data-testid="setup-coverage">
            {{ coverageText }}
          </div>
        </div>
      </div>

      <ul class="mt-3 divide-y divide-gray-100 dark:divide-gray-800">
        <li
          v-for="row in criterionRows"
          :key="row.key"
          class="py-2"
          data-testid="criterion-row"
        >
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
              <span data-testid="criterion-score">{{ scoreOrNa(row) }}</span>
            </div>
          </div>
          <p v-if="row.message" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
            {{ row.message }}
          </p>
          <details class="mt-1">
            <summary class="cursor-pointer text-[11px] text-primary-600 dark:text-primary-400">
              Evidence
            </summary>
            <pre class="mt-1 overflow-x-auto rounded bg-gray-50 p-2 text-[10px] text-gray-600 dark:bg-gray-800 dark:text-gray-300">{{ evidenceText(row) }}</pre>
          </details>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useQualitySetupStore } from '@/stores/qualitySetup'

const props = defineProps({
  trade: { type: Object, required: true }
})

const store = useQualitySetupStore()

const prepared = ref(null)
const evaluation = ref(null)
const loadingExisting = ref(false)

const leader = ref(null)
const baseStartInput = ref(null) // { date, source }
const pivotInput = ref(null) // { price, date, source }
const baseStartAdjusted = ref(false)
const baseStartDateInput = ref('')
const pivotAdjusted = ref(false)
const pivotPriceInput = ref('')

const CRITERION_LABELS = {
  leader: 'Leader',
  prior_move: 'Prior Move',
  base_duration: 'Base Duration',
  higher_lows: 'Higher Lows',
  range_contraction: 'Range Contraction',
  volume_contraction: 'Volume Contraction',
  ma_trend: 'SMA Trend Structure',
  pivot_quality: 'Pivot Quality'
}

watch(
  () => store.evaluation,
  (value) => {
    evaluation.value = value
    hydrateFromEvaluation(value)
  }
)

watch(
  () => store.prepared,
  (value) => {
    prepared.value = value
    // After a fresh prepare, keep persisted confirmations if present.
    hydrateFromEvaluation(store.evaluation)
  }
)

const profileLabel = computed(() => {
  const prep = prepared.value
  if (prep && prep.profile && prep.profileVersion) {
    return `${prep.profile.name} v${prep.profileVersion.versionNumber}`
  }
  // A persisted evaluation (page reload, no fresh prepare) carries the profile
  // name/version metadata from the evaluations list endpoint.
  const ev = evaluation.value
  if (ev && ev.profile_name && ev.version_number !== undefined && ev.version_number !== null) {
    return `${ev.profile_name} v${ev.version_number}`
  }
  return null
})

const evidenceUnavailable = computed(() => (prepared.value ? prepared.value.unavailableEvidence || [] : []))
const hasPersistedResults = computed(() => !!(evaluation.value && evaluation.value.results && evaluation.value.results.setup))

// The UI consumes the server-provided execution contract: requiredUserInputs
// is derived from the immutable active Setup criteria. Fall back to the
// canonical triple for older server responses that omit the field.
const requiredInputs = computed(() => {
  const list = prepared.value && prepared.value.requiredUserInputs
  if (Array.isArray(list) && list.length > 0) return list
  return ['leader_confirmed', 'base_start', 'pivot']
})

function requiresInput(key) {
  return requiredInputs.value.includes(key)
}

const INPUT_LABELS = {
  leader_confirmed: 'Leader',
  base_start: 'the Base Start',
  pivot: 'the Pivot'
}

const missingInputsText = computed(() => {
  const missing = requiredInputs.value.filter((key) => {
    if (key === 'leader_confirmed') return leader.value === null
    if (key === 'base_start') return !baseStartInput.value
    if (key === 'pivot') return !pivotInput.value
    return true
  })
  if (missing.length === 0) return ''
  const labels = missing.map((key) => INPUT_LABELS[key] || key).join(', ')
  return `Confirm or adjust ${labels} first.`
})

const canEvaluate = computed(() => {
  if (!prepared.value) return false
  if (requiresInput('leader_confirmed') && leader.value === null) return false
  if (requiresInput('base_start') && !baseStartInput.value) return false
  if (requiresInput('pivot') && !pivotInput.value) return false
  return true
})

// A machine-detected Pivot can only be confirmed as detected_confirmed when it
// was derived from the currently selected Base Start.
const pivotNeedsBaseReDetect = computed(() => {
  const prep = prepared.value
  const base = baseStartInput.value
  if (!prep || !base) return false
  const detected = prep.detectedPivot
  if (!detected) return false
  return detected.derivedFromBaseStart !== base.date
})

const setupSummary = computed(() => {
  if (!evaluation.value || !evaluation.value.results || !evaluation.value.results.setup) return null
  return evaluation.value.results.setup
})

const criterionRows = computed(() => {
  const summary = setupSummary.value
  if (!summary || !Array.isArray(summary.criterionResults)) return []
  return summary.criterionResults
})

const scoreText = computed(() => (setupSummary.value && typeof setupSummary.value.score === 'number' ? setupSummary.value.score : 'N/A'))
const gradeText = computed(() => (setupSummary.value && setupSummary.value.grade ? setupSummary.value.grade : 'N/A'))
const complianceText = computed(() => (setupSummary.value ? setupSummary.value.compliance || 'N/A' : 'N/A'))
const complianceClass = computed(() => {
  const value = complianceText.value
  if (value === 'PASS') return 'text-green-600 dark:text-green-400'
  if (value === 'FAIL') return 'text-red-600 dark:text-red-400'
  if (value === 'INCOMPLETE') return 'text-amber-600 dark:text-amber-400'
  return 'text-gray-500'
})
const coverageText = computed(() => (setupSummary.value && typeof setupSummary.value.coverage === 'number' ? `${setupSummary.value.coverage}%` : 'N/A'))

function hydrateFromEvaluation(value) {
  if (!value || !value.user_inputs) return
  const inputs = value.user_inputs
  if (typeof inputs.leader_confirmed === 'boolean') leader.value = inputs.leader_confirmed
  if (inputs.base_start && inputs.base_start.date) {
    baseStartInput.value = { date: inputs.base_start.date, source: inputs.base_start.source }
    baseStartDateInput.value = inputs.base_start.date
    baseStartAdjusted.value = inputs.base_start.source === 'user_adjusted'
  }
  if (inputs.pivot && inputs.pivot.price != null) {
    pivotInput.value = {
      price: Number(inputs.pivot.price),
      date: inputs.pivot.date || null,
      source: inputs.pivot.source,
      detectionConfidence: inputs.pivot.detectionConfidence || null
    }
    pivotPriceInput.value = String(inputs.pivot.price)
    pivotAdjusted.value = inputs.pivot.source === 'user_adjusted'
  }
}

async function runPrepare() {
  prepared.value = null
  try {
    const payload = await store.prepare(props.trade.id)
    prepared.value = payload
    // Keep the displayed evaluation in sync with the returned row: a
    // re-prepare that invalidated stale Setup results must not keep showing
    // the old grade.
    evaluation.value = payload.evaluation || evaluation.value
  } catch (err) {
    // store.error is already surfaced in the template
  }
}

function confirmBaseStart() {
  if (!prepared.value || !prepared.value.detectedBaseStart) return
  baseStartInput.value = { date: prepared.value.detectedBaseStart.date, source: 'detected_confirmed' }
  baseStartDateInput.value = prepared.value.detectedBaseStart.date
  baseStartAdjusted.value = false
  realignPivotToBase()
}

function adjustBaseStart() {
  baseStartAdjusted.value = true
  if (prepared.value && prepared.value.detectedBaseStart && !baseStartDateInput.value) {
    baseStartDateInput.value = prepared.value.detectedBaseStart.date
  }
  if (baseStartDateInput.value) {
    baseStartInput.value = { date: baseStartDateInput.value, source: 'user_adjusted' }
  } else {
    baseStartInput.value = null
  }
  realignPivotToBase()
}

// Once the Base Start changes away from the one a confirmed Pivot was derived
// from, that Pivot confirmation is no longer valid for this evidence context
// and is cleared until the user re-detects or manually adjusts the Pivot.
function realignPivotToBase() {
  const detected = prepared.value && prepared.value.detectedPivot
  const baseDate = baseStartInput.value && baseStartInput.value.date
  if (!pivotInput.value) return
  if (!detected || !baseDate || detected.derivedFromBaseStart !== baseDate) {
    pivotInput.value = null
    pivotAdjusted.value = false
    pivotPriceInput.value = ''
  }
}

// Server-side Pivot re-detection against the confirmed/adjusted Base Start on
// the SAME evidence snapshot (prepare stores the coherent context).
async function detectPivotForConfirmedBase() {
  if (!baseStartInput.value || !baseStartInput.value.date) return
  try {
    const payload = await store.prepare(props.trade.id, {
      confirmedBaseStart: {
        date: baseStartInput.value.date,
        source: baseStartInput.value.source
      }
    })
    prepared.value = payload
    // Sync the displayed evaluation: the server may have invalidated stale
    // Setup results when the Base Start context changed.
    evaluation.value = payload.evaluation || evaluation.value
    pivotInput.value = null
    pivotAdjusted.value = false
    pivotPriceInput.value = ''
  } catch (err) {
    // store.error is already surfaced in the template
  }
}

function confirmPivot() {
  if (!prepared.value || !prepared.value.detectedPivot) return
  pivotInput.value = {
    price: Number(prepared.value.detectedPivot.price),
    date: prepared.value.detectedPivot.date || null,
    source: 'detected_confirmed',
    detectionConfidence: prepared.value.detectedPivot.detectionConfidence || null
  }
  pivotPriceInput.value = String(prepared.value.detectedPivot.price)
  pivotAdjusted.value = false
}

function adjustPivot() {
  pivotAdjusted.value = true
  const detected = prepared.value && prepared.value.detectedPivot
  if (!pivotPriceInput.value) {
    pivotPriceInput.value = detected ? String(detected.price) : ''
  }
  if (pivotPriceInput.value) {
    pivotInput.value = {
      price: Number(pivotPriceInput.value),
      source: 'user_adjusted',
      detectionConfidence: detected ? detected.detectionConfidence : null
    }
  } else {
    pivotInput.value = null
  }
}

watch(baseStartDateInput, (date) => {
  if (baseStartAdjusted.value && date) {
    baseStartInput.value = { date, source: 'user_adjusted' }
    realignPivotToBase()
  }
})

watch(pivotPriceInput, (value) => {
  if (pivotAdjusted.value && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0) {
    pivotInput.value = {
      ...(pivotInput.value || {}),
      price: Number(value),
      source: 'user_adjusted'
    }
  }
})

async function runEvaluate() {
  if (!canEvaluate.value) return
  const evaluationId = (prepared.value && prepared.value.evaluation && prepared.value.evaluation.id) ||
    (evaluation.value && evaluation.value.id)
  if (!evaluationId) {
    store.error = 'Run Prepare Setup first.'
    return
  }
  try {
    // Send ONLY the semantic inputs the active execution contract requires.
    const userInputs = {}
    if (requiresInput('leader_confirmed')) userInputs.leader_confirmed = leader.value
    if (requiresInput('base_start')) {
      userInputs.base_start = {
        date: baseStartInput.value.date,
        source: baseStartInput.value.source
      }
    }
    if (requiresInput('pivot')) {
      userInputs.pivot = {
        price: Number(pivotInput.value.price),
        date: pivotInput.value.date || undefined,
        source: pivotInput.value.source
      }
    }
    const payload = await store.evaluate(props.trade.id, {
      evaluationId,
      userInputs
    })
    evaluation.value = payload.evaluation
    prepared.value = { ...(prepared.value || {}), evaluation: payload.evaluation }
  } catch (err) {
    // store.error is already surfaced in the template
  }
}

function resetPanel() {
  prepared.value = null
  evaluation.value = null
  leader.value = null
  baseStartInput.value = null
  pivotInput.value = null
  baseStartAdjusted.value = false
  pivotAdjusted.value = false
  store.$reset()
}

onMounted(async () => {
  loadingExisting.value = true
  try {
    await store.fetchEvaluations(props.trade.id)
    evaluation.value = store.evaluation
    hydrateFromEvaluation(store.evaluation)
  } catch (err) {
    // Ignore — the panel shows the Prepare CTA instead.
  } finally {
    loadingExisting.value = false
  }
})

// ---- Display helpers ----
function criterionLabel(key) {
  return CRITERION_LABELS[key] || key
}

function formatDate(value) {
  if (!value) return '—'
  return String(value)
}

function formatPrice(value) {
  if (value === null || value === undefined) return '—'
  return Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function scoreOrNa(row) {
  if (row.status === 'PASS' || row.status === 'FAIL') {
    return typeof row.score === 'number' ? `score ${row.score}` : 'score N/A'
  }
  return row.status === 'NOT_APPLICABLE' ? 'N/A' : 'no score'
}

// Persisted aggregates use camelCase rawValue/scoringValue; evaluator
// fragments (and legacy draft shapes) use raw_value/scoring_value. Normalize
// explicitly in this one place.
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
  const labels = {
    daily_ohlcv: 'Daily OHLCV data unavailable',
    entry_session_bar: 'No daily bar for the trade entry session',
    evidence_completeness: 'Daily market data could not be verified against a provider'
  }
  return labels[reason] || reason
}

function provenanceLabel(source) {
  const labels = {
    detected_confirmed: 'Confirmed',
    user_adjusted: 'User Adjusted',
    user_asserted: 'User Asserted',
    detected: 'Detected'
  }
  return labels[source] || source
}

function provenanceClass(source) {
  if (source === 'user_adjusted') return 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300'
  return 'bg-purple-100 text-purple-800 dark:bg-purple-900/20 dark:text-purple-400'
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
.provenance-badge {
  @apply px-2 inline-flex text-xs leading-5 font-semibold rounded-full;
}
</style>
