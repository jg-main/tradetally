<template>
  <span v-if="grade"
    class="px-2 py-1 inline-block text-xs font-semibold rounded"
    :class="qualityGradeBadgeClass(grade)"
    :title="tooltip"
    data-testid="trade-quality-grade">
    {{ grade }}
  </span>
  <span v-else-if="isPrimary"
    class="px-2 py-1 inline-block text-xs font-semibold text-gray-500 dark:text-gray-400"
    :title="tooltip"
    data-testid="trade-quality-na">N/A</span>
  <span v-else class="text-sm text-gray-500 dark:text-gray-400" data-testid="trade-quality-none">-</span>
  <span v-if="isPrimary"
    class="ml-1 text-[10px] text-primary-600 dark:text-primary-400"
    title="Profile-based Setup Quality">profile</span>
  <span v-else-if="isLegacy"
    class="ml-1 text-[10px] text-gray-400"
    title="Legacy Setup Quality">legacy</span>
</template>

<script setup>
import { computed } from 'vue'
import {
  resolveTradeQualitySummary,
  setupGradeForTrade,
  qualityGradeBadgeClass,
  qualitySummaryTooltip,
  QUALITY_SOURCE
} from '@/utils/tradeQualitySummary'

const props = defineProps({
  trade: { type: Object, required: true }
})

const summary = computed(() => resolveTradeQualitySummary(props.trade))
const grade = computed(() => setupGradeForTrade(props.trade))
const tooltip = computed(() => qualitySummaryTooltip(props.trade))
const isPrimary = computed(() => summary.value.source === QUALITY_SOURCE.PROFILE_PRIMARY)
const isLegacy = computed(() => summary.value.source === QUALITY_SOURCE.LEGACY)
</script>
