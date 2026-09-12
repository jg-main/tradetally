<template>
  <div
    v-if="trade"
    class="rounded-lg border border-gray-200 bg-white p-4 shadow dark:border-gray-700 dark:bg-gray-800"
    data-testid="quality-history"
  >
    <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h3 class="text-sm font-semibold text-gray-800 dark:text-gray-100">Quality Evaluation History</h3>
      <button
        type="button"
        :disabled="store.loading"
        class="inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-100 disabled:opacity-60 dark:text-gray-300 dark:hover:bg-gray-800"
        data-testid="refresh-history"
        @click="load"
      >
        <span v-if="store.loading">Loading…</span>
        <span v-else>Refresh</span>
      </button>
    </div>

    <p
      v-if="store.error"
      class="mb-3 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-900/20 dark:text-red-400"
      data-testid="history-error"
    >
      {{ store.error }}
    </p>

    <p v-if="!store.loading && evaluations.length === 0" class="py-2 text-xs text-gray-500 dark:text-gray-400">
      No quality evaluations for this trade yet.
    </p>

    <ul v-else class="divide-y divide-gray-100 dark:divide-gray-800">
      <li
        v-for="row in evaluations"
        :key="row.id"
        class="py-3"
        data-testid="history-row"
      >
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div class="flex flex-wrap items-center gap-2">
            <span class="text-xs font-semibold text-gray-800 dark:text-gray-100" data-testid="history-profile">
              {{ row.profile_name || 'Quality Profile' }} v{{ row.version_number }}
            </span>
            <span
              v-if="row.is_current_version"
              class="rounded-full bg-gray-100 px-2 text-[10px] font-semibold text-gray-600 dark:bg-gray-700 dark:text-gray-200"
              data-testid="current-version-badge"
            >
              Current
            </span>
            <span
              v-if="row.is_primary"
              class="rounded-full bg-amber-100 px-2 text-[10px] font-semibold text-amber-800"
              data-testid="primary-badge"
            >
              PRIMARY
            </span>
            <span
              class="rounded-full px-2 text-[10px] font-semibold"
              :class="statusClass(row.status)"
              data-testid="history-status"
            >
              {{ statusLabel(row.status) }}
            </span>
          </div>
          <span class="text-[11px] text-gray-500 dark:text-gray-400" data-testid="history-date">
            {{ formatDateTime(row.evaluated_at || row.created_at) }}
          </span>
        </div>

        <!-- Three independent dimensions. No combined overall grade. -->
        <div class="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-3">
          <div
            v-for="dimension in DIMENSIONS"
            :key="dimension"
            class="rounded-md bg-gray-50 px-2 py-1.5 text-[11px] dark:bg-gray-900/40"
            :data-testid="`history-${dimension}`"
          >
            <div class="font-semibold text-gray-600 dark:text-gray-300">{{ dimensionLabel(dimension) }}</div>
            <div class="text-gray-700 dark:text-gray-200">
              {{ dimensionSummary(row, dimension) }}
            </div>
          </div>
        </div>

        <div class="mt-2 flex flex-wrap items-center gap-2">
          <button
            v-if="canSetPrimary(row)"
            type="button"
            :disabled="store.selectingPrimary"
            class="rounded-md border border-amber-300 px-2 py-1 text-[11px] font-medium text-amber-700 hover:bg-amber-50 disabled:opacity-60"
            data-testid="set-primary"
            @click="setPrimary(row)"
          >
            Set Primary
          </button>

          <button
            type="button"
            class="rounded-md border border-gray-300 px-2 py-1 text-[11px] font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-800"
            data-testid="compare"
            @click="toggleCompare(row)"
          >
            {{ compareSelection.includes(row.id) ? 'Cancel Compare' : 'Compare' }}
          </button>

          <template v-if="hasNewerVersion(row)">
            <span class="text-[11px] text-gray-500 dark:text-gray-400" data-testid="current-version-note">
              Current profile version: v{{ row.current_version_number }}
            </span>
            <button
              type="button"
              :disabled="store.starting"
              class="rounded-md bg-primary-600 px-2 py-1 text-[11px] font-medium text-white hover:bg-primary-700 disabled:opacity-60"
              data-testid="evaluate-with-current"
              @click="evaluateWithCurrent(row)"
            >
              Evaluate with v{{ row.current_version_number }}
            </button>
          </template>
        </div>
      </li>
    </ul>

    <p
      v-if="compareSelection.length === 1"
      class="mt-3 rounded-md bg-gray-50 px-3 py-2 text-[11px] text-gray-500 dark:bg-gray-900/40 dark:text-gray-400"
      data-testid="compare-hint"
    >
      Select another evaluation to compare.
    </p>

    <QualityComparisonPanel
      v-if="store.comparison"
      :comparison="store.comparison"
      @close="closeComparison"
    />
  </div>
</template>

<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useQualityHistoryStore } from '@/stores/qualityHistory'
import { useQualitySetupStore } from '@/stores/qualitySetup'
import { useQualityWorkflowStore } from '@/stores/qualityWorkflow'
import QualityComparisonPanel from './QualityComparisonPanel.vue'

const props = defineProps({
  trade: { type: Object, required: true }
})

// Phase 6: after an explicit primary change the backend returns the resolved
// compatibility summary; the parent Trade Detail patches its display from this
// event instead of re-deriving primary-vs-legacy precedence.
const emit = defineEmits(['primary-changed'])

const store = useQualityHistoryStore()
const setupStore = useQualitySetupStore()
const workflow = useQualityWorkflowStore()
const evaluations = computed(() => store.evaluations)

const compareSelection = ref([])

const DIMENSIONS = ['setup', 'entry', 'management']
const DIMENSION_LABELS = { setup: 'Setup', entry: 'Entry', management: 'Management' }
const TERMINAL_STATUSES = ['completed', 'insufficient_data']

function dimensionLabel(dimension) {
  return DIMENSION_LABELS[dimension] || dimension
}

function statusLabel(status) {
  if (!status) return '—'
  return String(status).replace(/_/g, ' ').toUpperCase()
}

function statusClass(status) {
  if (status === 'completed') return 'bg-green-100 text-green-800'
  if (status === 'insufficient_data') return 'bg-amber-100 text-amber-800'
  if (status === 'error') return 'bg-red-100 text-red-700'
  return 'bg-gray-100 text-gray-700'
}

function formatDateTime(value) {
  if (!value) return 'not evaluated'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function isTerminal(row) {
  return TERMINAL_STATUSES.includes(row.status)
}

// A primary must be a terminal evaluation; drafts cannot be promoted.
function canSetPrimary(row) {
  return isTerminal(row) && !row.is_primary
}

// "Evaluate with current version" is offered when a newer immutable version
// exists for the profile than the one that produced this row.
function hasNewerVersion(row) {
  return !!row.current_version_id && row.current_version_id !== row.profile_version_id
}

function scoreText(row, dimension) {
  const value = row[`${dimension}_score`]
  return value === null || value === undefined ? 'N/A' : value
}

function dimensionSummary(row, dimension) {
  const grade = row[`${dimension}_grade`] || 'N/A'
  const score = scoreText(row, dimension)
  const compliance = row[`${dimension}_compliance`] || 'N/A'
  const coverage = row[`${dimension}_coverage`]
  const coverageText = coverage === null || coverage === undefined ? 'N/A' : `${coverage}%`
  return `${grade} ${score} · ${compliance} · ${coverageText}`
}

async function load() {
  try {
    await store.fetchEvaluations(props.trade.id)
  } catch (err) {
    // surfaced via store.error
  }
}

function toggleCompare(row) {
  const index = compareSelection.value.indexOf(row.id)
  if (index >= 0) {
    compareSelection.value = compareSelection.value.filter((id) => id !== row.id)
  } else {
    compareSelection.value = [...compareSelection.value, row.id].slice(-2)
  }
  if (compareSelection.value.length === 2) {
    runComparison()
  }
}

async function runComparison() {
  const [left, right] = compareSelection.value
  try {
    await store.compareEvaluations(props.trade.id, left, right)
  } catch (err) {
    // surfaced via store.error
  }
}

function closeComparison() {
  store.comparison = null
  compareSelection.value = []
}

async function setPrimary(row) {
  try {
    const result = await store.selectPrimary(props.trade.id, row.id)
    emit('primary-changed', result)
  } catch (err) {
    // surfaced via store.error
  }
}

// Creates a NEW draft pinned to the profile's current immutable version,
// makes it the active workflow evaluation (Setup -> Entry -> Management all
// operate on the SAME row), and leaves primary/history untouched (old
// evaluations stay visible; primary is never auto-promoted).
async function evaluateWithCurrent(row) {
  try {
    // Guard the start request too: a trade change/clear in flight must not let a
    // stale new draft become active.
    const startGuard = workflow.beginRequest({
      tradeId: props.trade.id,
      expectedEvaluationId: null
    })
    const evaluation = await store.startEvaluation(props.trade.id, row.current_version_id)
    if (!evaluation || !workflow.isRequestCurrent(startGuard)) return
    // Publish the new active row FIRST so Entry/Management follow it, then
    // prepare Setup on that exact id (the history watcher refreshes the list).
    workflow.activate(evaluation)
    const guard = workflow.beginRequest({
      tradeId: props.trade.id,
      expectedEvaluationId: evaluation.id
    })
    const prepared = await setupStore.prepare(props.trade.id, {
      evaluationId: evaluation.id
    })
    // The backend may legitimately return a replacement draft; adopt it only
    // against the id this request was issued for.
    workflow.adoptPreparedEvaluation(guard, prepared && prepared.evaluation)
    await store.fetchEvaluations(props.trade.id)
  } catch (err) {
    // surfaced via store.error
  }
}

onMounted(() => {
  workflow.ensureTrade(props.trade.id)
  load()
})
watch(() => props.trade.id, (tradeId) => {
  workflow.ensureTrade(tradeId)
  load()
})

// Any Setup/Entry/Management progress or finalize bumps the workflow revision;
// refresh the history rows so the active evaluation's summaries/status update
// without a page reload. Primary is never changed here.
watch(
  () => workflow.revision,
  () => {
    load()
  }
)
</script>
