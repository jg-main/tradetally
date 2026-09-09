'use strict';

// Pivot detection (docs/QUALITY_PROFILES_REQUIREMENT.md section 20).
//
// Search only inside the base range: Confirmed Base Start -> D-1 (during
// preparation, the provisional base range). Structural swing highs use the
// configured left/right windows, then resistance clustering:
//   - cluster_tolerance_pct: a structural high belongs to a cluster when its
//     price is within tolerance below the cluster's highest high;
//   - minimum_touches: cluster must contain at least this many structural
//     highs;
//   - recent_touch_window: at least one structural-high touch must fall in
//     the final N sessions of the base range;
//   - when multiple clusters qualify, the highest qualifying cluster is
//     selected and the detected pivot is its highest high.
//
// Fallback when no qualifying cluster exists:
//   1. highest structural swing high in the final recent window (medium
//      confidence);
//   2. otherwise highest daily high in the final recent window (low
//      confidence).
//
// Detection confidence is EVIDENCE ONLY. It must never directly change a
// quality score; Pivot Quality is graded from the CONFIRMED pivot.

const { findSwingHighs } = require('./swingPoints');

function requireParam(parameters, key) {
  if (!Object.prototype.hasOwnProperty.call(parameters, key)) {
    throw new Error(`Pivot detector is missing required parameter "${key}"`);
  }
  const value = parameters[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Pivot detector parameter "${key}" must be a finite number`);
  }
  return value;
}

/**
 * Builds greedy resistance clusters from structural swing highs.
 * Clusters are seeded from the highest remaining high downward; every
 * unassigned high within tolerance below the anchor joins the anchor's
 * cluster (a higher high would have seeded its own earlier cluster).
 */
function buildClusters(highs, tolerancePct) {
  const sorted = [...highs].sort((a, b) => b.price - a.price || a.index - b.index);
  const assigned = new Set();
  const clusters = [];
  for (const anchor of sorted) {
    if (assigned.has(anchor.index)) continue;
    const floor = anchor.price * (1 - tolerancePct / 100);
    const members = [];
    for (const high of sorted) {
      if (assigned.has(high.index)) continue;
      if (high.price >= floor && high.price <= anchor.price) {
        assigned.add(high.index);
        members.push(high);
      }
    }
    clusters.push({ members });
  }
  return clusters;
}

function toClusterSummary(cluster) {
  const members = [...cluster.members].sort((a, b) => a.index - b.index);
  const pivotPoint = [...members].sort((a, b) => b.price - a.price || a.index - b.index)[0];
  return {
    touches: members.length,
    members,
    level: pivotPoint.price,
    pivotIndex: pivotPoint.index,
    pivotDate: pivotPoint.date
  };
}

/**
 * Detects a proposed Pivot.
 *
 * @param {object} params
 * @param {Array} params.bars - normalized daily bars.
 * @param {number} params.rangeStartIndex - inclusive lower bound (base start).
 * @param {number} params.rangeEndIndex - inclusive upper bound (D-1).
 * @param {object} params.parameters - detector parameters read from the
 *   profile pivot_quality criterion: swing_left, swing_right,
 *   cluster_tolerance_pct, minimum_touches, recent_touch_window.
 * @returns {object|null} null when no pivot can be proposed; otherwise
 *   { pivot: {index,date,price}, confidence, method, evidence }.
 */
function detectPivot({ bars, rangeStartIndex, rangeEndIndex, parameters = {} }) {
  if (
    !Array.isArray(bars) ||
    bars.length === 0 ||
    !Number.isInteger(rangeStartIndex) ||
    !Number.isInteger(rangeEndIndex) ||
    rangeStartIndex < 0 ||
    rangeEndIndex < rangeStartIndex
  ) {
    return null;
  }
  const swingLeft = requireParam(parameters, 'swing_left');
  const swingRight = requireParam(parameters, 'swing_right');
  const clusterTolerancePct = requireParam(parameters, 'cluster_tolerance_pct');
  const minimumTouches = requireParam(parameters, 'minimum_touches');
  const recentTouchWindow = requireParam(parameters, 'recent_touch_window');

  const rangeEnd = Math.min(bars.length - 1, rangeEndIndex);
  const recentStart = Math.max(rangeStartIndex, rangeEnd - recentTouchWindow + 1);

  const allSwingHighs = findSwingHighs(bars, { left: swingLeft, right: swingRight });
  const inRangeHighs = allSwingHighs.filter(
    (point) => point.index >= rangeStartIndex && point.index <= rangeEnd
  );
  const recentHighs = inRangeHighs.filter((point) => point.index >= recentStart);

  const clusters = buildClusters(inRangeHighs, clusterTolerancePct)
    .filter((cluster) => cluster.members.length > 0)
    .map(toClusterSummary)
    .sort((a, b) => b.level - a.level);

  const qualifying = clusters.find(
    (cluster) =>
      cluster.touches >= minimumTouches &&
      cluster.members.some((member) => member.index >= recentStart)
  );

  if (qualifying) {
    return {
      pivot: {
        index: qualifying.pivotIndex,
        date: qualifying.pivotDate,
        price: qualifying.level
      },
      confidence: 'high',
      method: 'cluster',
      evidence: {
        range: {
          startDate: bars[rangeStartIndex].date,
          endDate: bars[rangeEnd].date
        },
        clusterTolerancePct,
        minimumTouches,
        recentTouchWindow,
        swingLeft,
        swingRight,
        clusters: clusters.map((cluster) => ({
          level: cluster.level,
          touches: cluster.touches,
          recentTouch: cluster.members.some((member) => member.index >= recentStart),
          memberDates: cluster.members.map((member) => member.date),
          memberPrices: cluster.members.map((member) => member.price)
        })),
        selectedCluster: {
          level: qualifying.level,
          touches: qualifying.touches,
          recentTouch: qualifying.members.some((member) => member.index >= recentStart),
          memberDates: qualifying.members.map((member) => member.date),
          memberPrices: qualifying.members.map((member) => member.price)
        }
      }
    };
  }

  // Fallback 1: highest structural swing high in the final recent window.
  if (recentHighs.length > 0) {
    const best = [...recentHighs].sort((a, b) => b.price - a.price || a.index - b.index)[0];
    return {
      pivot: { index: best.index, date: best.date, price: best.price },
      confidence: 'medium',
      method: 'recent_swing_high',
      evidence: {
        range: {
          startDate: bars[rangeStartIndex].date,
          endDate: bars[rangeEnd].date
        },
        clusterTolerancePct,
        minimumTouches,
        recentTouchWindow,
        swingLeft,
        swingRight,
        reason: 'no qualifying resistance cluster; fell back to the highest structural swing high in the final recent window',
        clusters: clusters.map((cluster) => ({
          level: cluster.level,
          touches: cluster.touches,
          recentTouch: cluster.members.some((member) => member.index >= recentStart),
          memberDates: cluster.members.map((member) => member.date),
          memberPrices: cluster.members.map((member) => member.price)
        }))
      }
    };
  }

  // Fallback 2: highest daily high in the final recent window.
  let bestIndex = -1;
  for (let i = recentStart; i <= rangeEnd; i += 1) {
    if (bestIndex === -1 || bars[i].high > bars[bestIndex].high) {
      bestIndex = i;
    }
  }
  if (bestIndex >= 0) {
    const bestBar = bars[bestIndex];
    return {
      pivot: { index: bestIndex, date: bestBar.date, price: bestBar.high },
      confidence: 'low',
      method: 'recent_daily_high',
      evidence: {
        range: {
          startDate: bars[rangeStartIndex].date,
          endDate: bars[rangeEnd].date
        },
        clusterTolerancePct,
        minimumTouches,
        recentTouchWindow,
        swingLeft,
        swingRight,
        reason: 'no qualifying resistance cluster and no recent structural swing high; fell back to the highest daily high in the final recent window',
        clusters: clusters.map((cluster) => ({
          level: cluster.level,
          touches: cluster.touches,
          recentTouch: cluster.members.some((member) => member.index >= recentStart),
          memberDates: cluster.members.map((member) => member.date),
          memberPrices: cluster.members.map((member) => member.price)
        }))
      }
    };
  }

  return null;
}

module.exports = { detectPivot, buildClusters };
