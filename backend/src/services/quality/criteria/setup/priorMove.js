'use strict';

// Prior Move criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 14).
//
// Prior Move is the percentage advance from the most recent qualifying
// structural swing low preceding the base to the confirmed pivot:
//
//   PriorMovePct = (ConfirmedPivot / ImpulseLow - 1) * 100
//
// Search: up to `search_lookback` trading sessions before the confirmed Base
// Start. Structural swing low at i:
//
//   low[i] < lows of previous `swing_left` sessions
//   AND low[i] <= lows of following `swing_right` sessions
//
// Selection: among qualifying swing lows producing at least the configured
// minimum Prior Move, the MOST RECENT one wins. An older low is never chosen
// merely because it produces a larger return.
//
// No qualifying structural swing low under the configured definition makes the
// criterion FAIL per the Canonical BO rule (evidence retains why), never a
// fabricated swing low. Insufficient pre-base history makes it UNKNOWN.

const { CRITERION_STATUS } = require('../../constants');
const { requireNumberParameter } = require('./common');
const { findSwingLows } = require('../../detectors/swingPoints');

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function evaluate({ key = 'prior_move', criterion = {}, setup = {}, bars = [] }) {
  const parameters = criterion.parameters || {};
  const minimumPct = requireNumberParameter(parameters, 'minimum_pct', key);
  const searchLookback = requireNumberParameter(parameters, 'search_lookback', key);
  const swingLeft = requireNumberParameter(parameters, 'swing_left', key);
  const swingRight = requireNumberParameter(parameters, 'swing_right', key);

  const baseStart = setup.baseStart;
  const pivot = setup.pivot;
  if (!baseStart || !pivot || typeof pivot.price !== 'number') {
    return {
      status: CRITERION_STATUS.UNKNOWN,
      scoring_value: null,
      raw_value: null,
      evidence: {
        required: { base_start: !!baseStart, pivot: !!(pivot && typeof pivot.price === 'number') }
      },
      message: 'Prior Move requires a confirmed Base Start and confirmed Pivot.'
    };
  }

  const baseStartIndex = baseStart.index;
  if (baseStartIndex < swingLeft + swingRight + 1) {
    return {
      status: CRITERION_STATUS.UNKNOWN,
      scoring_value: null,
      raw_value: null,
      evidence: {
        search: {
          lookbackSessions: searchLookback,
          availablePreBaseSessions: baseStartIndex
        },
        requiredPreBaseSessions: swingLeft + swingRight + 1
      },
      message: 'Insufficient pre-base session history to detect a structural swing low.'
    };
  }

  const searchStartIndex = Math.max(0, baseStartIndex - searchLookback);
  const lows = findSwingLows(bars, { left: swingLeft, right: swingRight }).filter(
    (point) => point.index >= searchStartIndex && point.index < baseStartIndex
  );

  const qualifying = lows
    .map((low) => ({
      index: low.index,
      date: low.date,
      impulse_low_price: low.price,
      prior_move_pct: round2((pivot.price / low.price - 1) * 100)
    }))
    .filter((candidate) => candidate.prior_move_pct >= minimumPct);

  const searchWindow = {
    startDate: bars[searchStartIndex].date,
    endDate: bars[baseStartIndex - 1].date,
    lookbackSessions: searchLookback
  };

  if (qualifying.length === 0) {
    // Canonical FAIL when no qualifying structural swing low exists under the
    // configured search definition. Evidence never fabricates a swing low. The
    // scoring envelope still needs a finite numeric input, so the score is
    // derived from the most recent structural swing low actually found (its
    // measured impulse to the pivot) — or 0 when no structural low exists at
    // all in the search window. `prior_move_pct` in evidence stays null so the
    // persisted result never claims a qualifying impulse existed.
    const mostRecentLow = lows.length > 0 ? lows[lows.length - 1] : null;
    const fallbackPct = mostRecentLow
      ? round2((pivot.price / mostRecentLow.price - 1) * 100)
      : 0;

    return {
      status: CRITERION_STATUS.FAIL,
      scoring_value: fallbackPct,
      raw_value: null,
      evidence: {
        confirmed_pivot: pivot.price,
        impulse_low_date: null,
        impulse_low_price: null,
        prior_move_pct: null,
        searchWindow,
        minimum_pct: minimumPct,
        structuralLowsFound: lows.map((low) => ({
          date: low.date,
          price: low.price
        })),
        most_recent_swing_low: mostRecentLow
          ? { date: mostRecentLow.date, price: mostRecentLow.price, prior_move_pct: fallbackPct }
          : null,
        reason: `No qualifying structural swing low produced a prior move of at least ${minimumPct}% before the confirmed Base Start.`
      },
      message: `No qualifying impulse low with a prior move of at least ${minimumPct}% was found.`
    };
  }

  // Most recent qualifying swing low (chronological order -> last element).
  const selected = qualifying[qualifying.length - 1];
  return {
    status: CRITERION_STATUS.PASS,
    scoring_value: selected.prior_move_pct,
    raw_value: selected.prior_move_pct,
    evidence: {
      confirmed_pivot: pivot.price,
      impulse_low_date: selected.date,
      impulse_low_price: selected.impulse_low_price,
      prior_move_pct: selected.prior_move_pct,
      prior_move_duration_sessions: baseStartIndex - selected.index,
      searchWindow,
      minimum_pct: minimumPct,
      selection: 'most_recent_qualifying',
      qualifyingCandidates: qualifying.map((candidate) => ({
        date: candidate.date,
        impulse_low_price: candidate.impulse_low_price,
        prior_move_pct: candidate.prior_move_pct
      }))
    },
    message: `Prior move of ${selected.prior_move_pct}% from ${selected.date} to the confirmed pivot.`
  };
}

module.exports = { evaluate };
