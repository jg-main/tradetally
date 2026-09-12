<template>
  <div class="sm:col-span-2">
    <dt class="text-sm font-medium text-gray-500 dark:text-gray-400">Setup Quality</dt>
    <dd class="mt-1">
      <!-- Explicit Phase-5 primary profile evaluation is authoritative. -->
      <div v-if="summary.source === QUALITY_SOURCE.PROFILE_PRIMARY" class="space-y-2" data-testid="profile-setup-quality">
        <div class="flex items-center space-x-3">
          <span class="px-3 py-1 inline-flex text-sm font-semibold rounded"
            :class="qualityGradeBadgeClass(summary.setup.grade)">
            {{ summary.setup.grade ? `Grade ${summary.setup.grade}` : 'N/A' }}
          </span>
          <span v-if="typeof summary.setup.score === 'number'" class="text-sm text-gray-600 dark:text-gray-400">
            ({{ summary.setup.score }} / 100)
          </span>
        </div>
        <div class="text-xs text-gray-500 dark:text-gray-400">
          <span v-if="summary.profile?.profileName" class="font-medium text-gray-700 dark:text-gray-300">
            {{ summary.profile.profileName }}<span v-if="summary.profile.versionNumber"> v{{ summary.profile.versionNumber }}</span>
          </span>
          <span v-if="summary.setup.compliance"> · Compliance {{ summary.setup.compliance }}</span>
          <span v-if="typeof summary.setup.coverage === 'number'"> · Coverage {{ summary.setup.coverage }}%</span>
        </div>
        <!-- Preserved legacy Setup Quality, clearly labelled as historical. -->
        <div v-if="hasLegacySetupQuality" class="rounded-md border border-gray-200 dark:border-gray-700 p-2" data-testid="legacy-setup-quality">
          <div class="text-xs font-medium text-gray-500 dark:text-gray-400">Legacy Setup Quality (historical, 0-5 scale)</div>
          <div class="mt-1 flex flex-wrap items-center gap-2">
            <span v-if="trade.qualityGrade" class="px-2 py-0.5 inline-flex text-xs font-semibold rounded"
              :class="qualityGradeBadgeClass(trade.qualityGrade)">
              Grade {{ trade.qualityGrade }}
            </span>
            <span v-if="trade.qualityScore" class="text-xs text-gray-600 dark:text-gray-400">
              {{ Number(trade.qualityScore).toFixed(1) }}/5.0
            </span>
            <button
              @click="$emit('calculate')"
              :disabled="calculating"
              class="text-[11px] px-2 py-0.5 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
            >
              {{ calculating ? 'Calculating...' : 'Calculate Legacy Setup Quality' }}
            </button>
          </div>
          <p class="mt-1 text-[11px] text-gray-400 dark:text-gray-500">
            Historical legacy grading, preserved and not the selected profile result.
          </p>
        </div>
        <div v-else class="flex items-center gap-2">
          <button
            @click="$emit('calculate')"
            :disabled="calculating"
            class="text-xs px-3 py-1 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 disabled:opacity-50 dark:bg-gray-700 dark:text-gray-200 dark:hover:bg-gray-600"
          >
            {{ calculating ? 'Calculating...' : 'Calculate Legacy Setup Quality' }}
          </button>
        </div>
      </div>

      <!-- No explicit primary: legacy experience is unchanged. -->
      <template v-else>
        <div v-if="trade.qualityGrade" class="flex items-center space-x-3">
          <span class="px-3 py-1 inline-flex text-sm font-semibold rounded"
            :class="qualityGradeBadgeClass(trade.qualityGrade)">
            Grade {{ trade.qualityGrade }}
          </span>
          <span v-if="trade.qualityScore" class="text-sm text-gray-600 dark:text-gray-400">
            ({{ Number(trade.qualityScore).toFixed(1) }}/5.0)
          </span>
          <span v-if="summary.source === QUALITY_SOURCE.LEGACY" class="text-[11px] text-gray-400">Legacy</span>
        </div>
        <div v-else-if="trade.instrument_type === 'future'">
          <span class="text-sm text-gray-500 dark:text-gray-400">Not available for futures</span>
        </div>
        <div v-else class="flex items-center space-x-2">
          <span class="text-sm text-gray-500 dark:text-gray-400">Not calculated</span>
          <button
            @click="$emit('calculate')"
            :disabled="calculating"
            class="text-xs px-3 py-1 bg-primary-600 text-white rounded hover:bg-primary-700 disabled:opacity-50"
          >
            {{ calculating ? 'Calculating...' : 'Calculate Setup Quality' }}
          </button>
        </div>
      </template>
    </dd>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import {
  resolveTradeQualitySummary,
  qualityGradeBadgeClass,
  QUALITY_SOURCE
} from '@/utils/tradeQualitySummary'

const props = defineProps({
  trade: { type: Object, default: null },
  calculating: { type: Boolean, default: false }
})

defineEmits(['calculate'])

const summary = computed(() => resolveTradeQualitySummary(props.trade))

const hasLegacySetupQuality = computed(() => {
  const t = props.trade
  if (!t) return false
  return (
    (t.qualityGrade !== null && t.qualityGrade !== undefined) ||
    (t.qualityScore !== null && t.qualityScore !== undefined) ||
    (t.qualityMetrics !== null && t.qualityMetrics !== undefined)
  )
})
</script>
