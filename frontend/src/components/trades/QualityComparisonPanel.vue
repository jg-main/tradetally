<template>
  <div
    v-if="comparison"
    class="mt-4 rounded-lg border border-gray-200 bg-gray-50 p-3 dark:border-gray-700 dark:bg-gray-900/40"
    data-testid="comparison-panel"
  >
    <div class="mb-3 flex items-start justify-between gap-2">
      <div class="grid flex-1 grid-cols-2 gap-3 text-xs">
        <div data-testid="comparison-left-header">
          <div class="font-semibold text-gray-800 dark:text-gray-100">
            {{ headerLabel(comparison.left) }}
          </div>
          <div class="text-gray-500 dark:text-gray-400">
            evaluated {{ formatDateTime(comparison.left.evaluated_at || comparison.left.created_at) }}
          </div>
          <div class="text-gray-500 dark:text-gray-400" data-testid="comparison-left-status">
            {{ statusLabel(comparison.left.status) }}
            <span v-if="comparison.left.is_primary" class="ml-1 font-semibold text-primary-600">PRIMARY</span>
          </div>
        </div>
        <div data-testid="comparison-right-header">
          <div class="font-semibold text-gray-800 dark:text-gray-100">
            {{ headerLabel(comparison.right) }}
          </div>
          <div class="text-gray-500 dark:text-gray-400">
            evaluated {{ formatDateTime(comparison.right.evaluated_at || comparison.right.created_at) }}
          </div>
          <div class="text-gray-500 dark:text-gray-400" data-testid="comparison-right-status">
            {{ statusLabel(comparison.right.status) }}
            <span v-if="comparison.right.is_primary" class="ml-1 font-semibold text-primary-600">PRIMARY</span>
          </div>
        </div>
      </div>
      <button
        type="button"
        class="rounded-md px-2 py-1 text-xs font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800"
        data-testid="close-comparison"
        @click="$emit('close')"
      >
        Close
      </button>
    </div>

    <!-- No combined overall score is ever shown. -->
    <div
      v-for="dimension in dimensions"
      :key="dimension.dimension"
      class="mb-3 rounded-md bg-white p-3 shadow-sm dark:bg-gray-800"
      data-testid="comparison-dimension"
    >
      <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h4 class="text-xs font-semibold uppercase tracking-wide text-gray-700 dark:text-gray-200">
          {{ dimensionLabel(dimension.dimension) }}
        </h4>
        <div class="flex flex-wrap gap-3 text-xs text-gray-600 dark:text-gray-300">
          <span data-testid="comparison-score">
            {{ summaryText(dimension.left) }} → {{ summaryText(dimension.right) }}
          </span>
          <span v-if="dimension.score_delta !== null" data-testid="comparison-score-delta">
            Δ {{ dimension.score_delta > 0 ? '+' : '' }}{{ dimension.score_delta }}
          </span>
        </div>
      </div>

      <table class="w-full text-left text-xs">
        <thead>
          <tr class="text-gray-500 dark:text-gray-400">
            <th class="pb-1 pr-2 font-medium">Criterion</th>
            <th class="pb-1 pr-2 font-medium">Left</th>
            <th class="pb-1 pr-2 font-medium">Right</th>
            <th class="pb-1 font-medium">Δ / note</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="criterion in dimension.criteria"
            :key="criterion.key"
            class="border-t border-gray-100 dark:border-gray-700"
            data-testid="comparison-criterion"
          >
            <td class="py-1 pr-2">
              <span class="font-medium text-gray-700 dark:text-gray-200">{{ criterionLabel(criterion.key) }}</span>
              <span
                v-if="criterion.presence !== 'both'"
                class="ml-1 rounded px-1 text-[10px] font-semibold"
                :class="criterion.presence === 'only_right' ? 'bg-green-100 text-green-700' : 'bg-amber-100 text-amber-700'"
                data-testid="criterion-presence"
              >
                {{ criterion.presence === 'only_right' ? 'added' : 'removed' }}
              </span>
              <span
                v-if="criterion.configuration_changed"
                class="ml-1 rounded bg-purple-100 px-1 text-[10px] font-semibold text-purple-700"
                data-testid="criterion-config-changed"
              >
                config changed
              </span>
            </td>
            <td class="py-1 pr-2 text-gray-600 dark:text-gray-300" data-testid="criterion-left">
              {{ sideText(criterion, 'left') }}
            </td>
            <td class="py-1 pr-2 text-gray-600 dark:text-gray-300" data-testid="criterion-right">
              {{ sideText(criterion, 'right') }}
            </td>
            <td class="py-1 text-gray-500 dark:text-gray-400" data-testid="criterion-delta">
              <span v-if="criterion.score.delta !== null">
                {{ criterion.score.delta > 0 ? '+' : '' }}{{ criterion.score.delta }}
              </span>
              <span v-else-if="criterion.presence !== 'both'">
                {{ criterion.presence === 'only_right' ? 'not present in left' : 'not present in right' }}
              </span>
              <span v-else>N/A</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'

const props = defineProps({
  comparison: { type: Object, required: true }
})
defineEmits(['close'])

const DIMENSION_LABELS = { setup: 'Setup', entry: 'Entry', management: 'Management' }
const CRITERION_LABELS = {
  leader: 'Leader',
  prior_move: 'Prior Move',
  base_duration: 'Base Duration',
  higher_lows: 'Higher Lows',
  range_contraction: 'Range Contraction',
  volume_contraction: 'Volume Contraction',
  ma_trend: 'SMA Trend Structure',
  pivot_quality: 'Pivot Quality',
  breakout_session: 'Breakout Session',
  trigger_compliance: 'Trigger Compliance',
  volume_pace: 'Volume Pace',
  range_pace: 'Range Pace',
  entry_extension: 'Entry Extension',
  initial_stop: 'Initial Stop',
  stop_width: 'Stop Width',
  partial_timing: 'Partial Timing',
  partial_sizing: 'Partial Sizing',
  no_premature_reduction: 'No Premature Reduction',
  stop_ratchet: 'Stop Ratchet / Never Lower',
  post_partial_breakeven: 'Post-Partial Breakeven',
  trailing_ma: 'Selected MA Trailing Exit'
}

const dimensions = computed(() => {
  const map = props.comparison.dimensions || {}
  return Object.keys(map).map((key) => map[key])
})

function dimensionLabel(key) {
  return DIMENSION_LABELS[key] || key
}

function criterionLabel(key) {
  return CRITERION_LABELS[key] || key
}

function headerLabel(meta) {
  if (!meta) return '—'
  const version = meta.version_number !== null && meta.version_number !== undefined ? ` v${meta.version_number}` : ''
  return `${meta.profile_name || 'Profile'}${version}`
}

function statusLabel(status) {
  if (!status) return '—'
  return String(status).replace(/_/g, ' ').toUpperCase()
}

function formatDateTime(value) {
  if (!value) return 'not evaluated'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return String(value)
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}

function summaryText(summary) {
  if (!summary) return 'N/A'
  const score = summary.score === null || summary.score === undefined ? 'N/A' : summary.score
  const grade = summary.grade || 'N/A'
  const compliance = summary.compliance || 'N/A'
  const coverage = summary.coverage === null || summary.coverage === undefined ? 'N/A' : `${summary.coverage}%`
  return `${grade} ${score} · ${compliance} · ${coverage}`
}

// A side that is absent in the other immutable version is shown as "—", never
// as UNKNOWN: historical absence is not an evaluated UNKNOWN.
function sideText(criterion, side) {
  const status = criterion.status[side]
  if (status === null || status === undefined) return '—'
  const score = criterion.score[side]
  const scoreText = score === null || score === undefined ? 'N/A' : score
  return `${status} · ${scoreText}`
}
</script>
