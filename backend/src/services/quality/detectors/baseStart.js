'use strict';

// Base Start detection (docs/QUALITY_PROFILES_REQUIREMENT.md section 15.1).
//
// Canonical rules (all sourced from the profile base_duration criterion
// parameters):
//   - search horizon: up to `detection_lookback` sessions before the
//     evaluation boundary D-1;
//   - structural swing high at i: high[i] > previous `swing_high_left`
//     session highs AND high[i] >= following `swing_high_right` session highs;
//   - candidate qualification: maximum subsequent high from the candidate
//     through D-1 <= candidate high * (1 + max_post_high_advance_pct / 100);
//   - candidate selection: earliest qualifying candidate.
//
// The detector NEVER shortens/truncates a detected base to force it into a
// duration window: it returns the earliest qualifying candidate under the
// configured structural rules, and duration compliance is evaluated later by
// the base_duration criterion (a 47-session base must remain 47 sessions).
//
// Detection output is a PROPOSAL. The confirmed Base Start (user
// Confirm/Adjust) is authoritative for downstream calculations; a detector
// rerun never silently overwrites a confirmed value.

const { findSwingHighs } = require('./swingPoints');

function requireParam(parameters, key) {
  if (!Object.prototype.hasOwnProperty.call(parameters, key)) {
    throw new Error(`Base Start detector is missing required parameter "${key}"`);
  }
  const value = parameters[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Base Start detector parameter "${key}" must be a finite number`);
  }
  return value;
}

function qualifyCandidate(bars, candidateIndex, endIndex, allowancePct) {
  const cap = bars[candidateIndex].high * (1 + allowancePct / 100);
  for (let i = candidateIndex; i <= endIndex; i += 1) {
    if (bars[i].high > cap) return false;
  }
  return true;
}

/**
 * Detects a proposed Base Start.
 *
 * Point-in-time: swing-high detection is bounded by `endIndex`, so a candidate
 * is only confirmed as a structural swing high when ALL of its
 * `swing_high_right` confirmation bars lie at or before endIndex. Bars after
 * endIndex can never confirm or disqualify a candidate.
 *
 * @param {object} params
 * @param {Array} params.bars - normalized daily bars (chronological).
 * @param {number} params.endIndex - index of the session to treat as D-1.
 * @param {object} params.parameters - detector parameters read from the
 *   profile base_duration criterion: detection_lookback, swing_high_left,
 *   swing_high_right, max_post_high_advance_pct.
 * @returns {object|null} null when no qualifying candidate exists; otherwise
 *   { index, date, price, lookbackStartIndex, allowancePct, candidateCount }.
 */
function detectBaseStart({ bars, endIndex, parameters = {} }) {
  if (!Array.isArray(bars) || bars.length === 0 || !Number.isInteger(endIndex) || endIndex < 0) {
    return null;
  }
  const lookback = requireParam(parameters, 'detection_lookback');
  const swingHighLeft = requireParam(parameters, 'swing_high_left');
  const swingHighRight = requireParam(parameters, 'swing_high_right');
  const allowancePct = requireParam(parameters, 'max_post_high_advance_pct');

  // A configured `lookback` of N sessions covers exactly N sessions:
  // [endIndex - N + 1, endIndex]. Candidates are swing highs whose
  // confirmation windows lie entirely at or before endIndex.
  const searchStart = Math.max(0, endIndex - lookback + 1);
  const swingHighs = findSwingHighs(bars, {
    left: swingHighLeft,
    right: swingHighRight,
    maxIndex: endIndex
  });
  const candidates = swingHighs.filter(
    (point) => point.index >= searchStart && point.index <= endIndex
  );

  // Candidates are chronological; the earliest qualifying candidate wins.
  for (const candidate of candidates) {
    if (qualifyCandidate(bars, candidate.index, endIndex, allowancePct)) {
      return {
        index: candidate.index,
        date: bars[candidate.index].date,
        price: bars[candidate.index].high,
        lookbackStartIndex: searchStart,
        allowancePct,
        candidateCount: candidates.length
      };
    }
  }
  return null;
}

module.exports = { detectBaseStart };
