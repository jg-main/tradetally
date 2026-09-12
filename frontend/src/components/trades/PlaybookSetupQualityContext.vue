<template>
  <div class="mb-5 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
    <div class="flex flex-wrap items-center gap-3">
      <div class="text-sm font-medium text-gray-700 dark:text-gray-300">Setup Quality</div>
      <!-- Phase 6: when an explicit primary is authoritative, this contextual
           card shows that profile-based result, never an unlabeled legacy grade. -->
      <template v-if="summary.source === QUALITY_SOURCE.PROFILE_PRIMARY">
        <span
          class="inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold"
          :class="qualityGradeBadgeClass(summary.setup.grade)"
          data-testid="playbook-profile-setup-grade"
        >
          Grade {{ summary.setup.grade || 'N/A' }}
        </span>
        <span v-if="typeof summary.setup.score === 'number'" class="text-sm text-gray-500 dark:text-gray-400">
          {{ summary.setup.score }}/100
        </span>
        <span
          v-if="summary.profile?.profileName"
          class="inline-flex items-center rounded-full bg-primary-100 px-2 py-0.5 text-xs font-medium text-primary-800 dark:bg-primary-900/20 dark:text-primary-300"
        >
          {{ summary.profile.profileName }}<span v-if="summary.profile.versionNumber"> v{{ summary.profile.versionNumber }}</span>
        </span>
        <span v-if="summary.setup.compliance" class="text-xs text-gray-500 dark:text-gray-400">
          Compliance {{ summary.setup.compliance }}
        </span>
        <span v-if="typeof summary.setup.coverage === 'number'" class="text-xs text-gray-500 dark:text-gray-400">
          Coverage {{ summary.setup.coverage }}%
        </span>
      </template>
      <template v-else>
        <span
          v-if="trade.setupQuality?.grade"
          class="inline-flex items-center rounded-full px-3 py-1 text-sm font-semibold"
          :class="legacyBadgeClass(trade.setupQuality.grade)"
          data-testid="playbook-legacy-setup-grade"
        >
          Grade {{ trade.setupQuality.grade }}
        </span>
        <span v-if="trade.setupQuality?.score" class="text-sm text-gray-500 dark:text-gray-400">
          {{ Number(trade.setupQuality.score).toFixed(1) }}/5.0
        </span>
        <span v-else class="text-sm text-gray-500 dark:text-gray-400">
          Calculate setup quality to pair setup context with adherence.
        </span>
      </template>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { resolveTradeQualitySummary, qualityGradeBadgeClass, QUALITY_SOURCE } from '@/utils/tradeQualitySummary'

const props = defineProps({
  trade: { type: Object, default: null }
})

const summary = computed(() => resolveTradeQualitySummary(props.trade))

function legacyBadgeClass(grade) {
  return {
    'bg-green-100 text-green-800 dark:bg-green-900/20 dark:text-green-400': grade === 'A',
    'bg-blue-100 text-blue-800 dark:bg-blue-900/20 dark:text-blue-400': grade === 'B',
    'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-400': grade === 'C',
    'bg-orange-100 text-orange-800 dark:bg-orange-900/20 dark:text-orange-400': grade === 'D',
    'bg-red-100 text-red-800 dark:bg-red-900/20 dark:text-red-400': grade === 'F'
  }
}
</script>
