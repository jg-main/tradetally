'use strict';

// Canonical BO (Qullamägi Breakout) default profile configuration
// (spec sections 11, 61, 62, 63).
//
// This module is the single source of truth for the seeded Canonical BO v1
// profile. Every trading-policy value below is a profile-configurable
// default; the application may only hard-code mathematical definitions and
// evaluator types.
//
// Conditional management criteria (Partial Timing, Partial Sizing,
// Post-Partial BE, Trailing MA) are `required: true` in the generic
// contract: their evaluators return NOT_APPLICABLE when the rule never
// becomes applicable (e.g. +1R never reached through Day 5), and
// NOT_APPLICABLE is excluded from coverage and from required-criteria
// compliance by the aggregation engine (sections 33, 46).

const {
  DEFAULT_GRADE_THRESHOLDS,
  DEFAULT_MINIMUM_COVERAGE,
  DIMENSIONS
} = require('./constants');

const CANONICAL_BO_NAME = 'Canonical BO';

const CANONICAL_BO_DESCRIPTION =
  'Leading stock after a substantial prior advance that forms an orderly multi-week ' +
  'consolidation (higher lows, contracting ranges, declining volume) while preserving ' +
  'its intermediate-term uptrend, resolving above a clear pivot.';

// Weights are stored as integer percentages and sum to 100 per dimension.
const CANONICAL_BO_CONFIG = {
  dimensions: {
    [DIMENSIONS.SETUP]: {
      minimum_coverage: DEFAULT_MINIMUM_COVERAGE,
      grade_thresholds: { ...DEFAULT_GRADE_THRESHOLDS },
      criteria: [
        {
          key: 'leader',
          enabled: true,
          required: true,
          weight: 20,
          parameters: {
            source: 'user_asserted'
          }
        },
        {
          key: 'prior_move',
          enabled: true,
          required: true,
          weight: 20,
          parameters: {
            minimum_pct: 30,
            search_lookback: 60,
            swing_left: 3,
            swing_right: 3,
            selection: 'most_recent_qualifying'
          }
        },
        {
          key: 'base_duration',
          enabled: true,
          required: true,
          weight: 5,
          parameters: {
            minimum_sessions: 10,
            maximum_sessions: 40,
            detection_lookback: 60,
            swing_high_left: 3,
            swing_high_right: 3,
            max_post_high_advance_pct: 5,
            candidate_selection: 'earliest_qualifying'
          }
        },
        {
          key: 'higher_lows',
          enabled: true,
          required: true,
          weight: 10,
          parameters: {
            swing_left: 2,
            swing_right: 2,
            minimum_lows: 2,
            tolerance_pct: 0.5,
            sequence_rule: 'no_material_lower_low'
          }
        },
        {
          key: 'range_contraction',
          enabled: true,
          required: true,
          weight: 15,
          parameters: {
            recent_window: 5,
            prior_window: 10,
            maximum_ratio: 0.7,
            require_full_windows: true
          }
        },
        {
          key: 'volume_contraction',
          enabled: true,
          required: true,
          weight: 15,
          parameters: {
            recent_window: 5,
            prior_window: 10,
            maximum_ratio: 0.7,
            require_full_windows: true
          }
        },
        {
          key: 'ma_trend',
          enabled: true,
          required: true,
          weight: 5,
          parameters: {
            type: 'SMA',
            fast_period: 10,
            slow_period: 20,
            slope_lookback: 5,
            support_period: 20,
            max_close_below_support_pct: 2,
            require_fast_above_slow: false
          }
        },
        {
          key: 'pivot_quality',
          enabled: true,
          required: true,
          weight: 10,
          parameters: {
            swing_left: 2,
            swing_right: 2,
            cluster_tolerance_pct: 2,
            minimum_touches: 2,
            recent_touch_window: 10,
            max_d1_distance_pct: 5,
            prior_close_tolerance_pct: 1,
            require_confirmation: true
          }
        }
      ]
    },
    [DIMENSIONS.ENTRY]: {
      minimum_coverage: DEFAULT_MINIMUM_COVERAGE,
      grade_thresholds: { ...DEFAULT_GRADE_THRESHOLDS },
      criteria: [
        {
          key: 'breakout_session',
          enabled: true,
          required: true,
          weight: 10,
          parameters: {}
        },
        {
          key: 'trigger_compliance',
          enabled: true,
          required: true,
          weight: 20,
          parameters: {
            allowed_types: ['BO-PIVOT', 'BO-ORH-1', 'BO-ORH-5', 'BO-ORH-60'],
            require_pivot_resolution: true,
            minimum_penetration_pct: 0
          }
        },
        {
          key: 'volume_pace',
          enabled: true,
          required: false,
          weight: 10,
          parameters: {
            reference_sessions: 20,
            target_multiple: 1.4
          }
        },
        {
          key: 'range_pace',
          enabled: true,
          required: false,
          weight: 5,
          parameters: {
            reference_sessions: 20
          }
        },
        {
          key: 'entry_extension',
          enabled: true,
          required: false,
          weight: 20,
          parameters: {
            primary_normalization: 'ADR',
            hard_maximum: 'disabled'
          }
        },
        {
          key: 'initial_stop',
          enabled: true,
          required: true,
          weight: 20,
          parameters: {
            reference: 'observable_lod_at_stop_establishment',
            session: 'regular',
            minimum_buffer_method: 'minimum_tick',
            minimum_buffer_value: 1
          }
        },
        {
          key: 'stop_width',
          enabled: true,
          required: true,
          weight: 15,
          parameters: {
            volatility_method: 'ADR',
            period: 20,
            maximum_multiple: 1.0
          }
        }
      ]
    },
    [DIMENSIONS.MANAGEMENT]: {
      minimum_coverage: DEFAULT_MINIMUM_COVERAGE,
      grade_thresholds: { ...DEFAULT_GRADE_THRESHOLDS },
      criteria: [
        {
          key: 'partial_timing',
          enabled: true,
          required: true,
          weight: 20,
          parameters: {
            earliest_day: 3,
            latest_day: 5,
            minimum_mfe_r: 1.0,
            completion_window: 'same_session'
          }
        },
        {
          key: 'partial_sizing',
          enabled: true,
          required: true,
          weight: 15,
          parameters: {
            target_pct: 50
          }
        },
        {
          key: 'no_premature_reduction',
          enabled: true,
          required: true,
          weight: 10,
          parameters: {}
        },
        {
          key: 'stop_ratchet',
          enabled: true,
          required: true,
          weight: 20,
          parameters: {
            downward_tolerance_ticks: 0
          }
        },
        {
          key: 'post_partial_breakeven',
          enabled: true,
          required: true,
          weight: 15,
          parameters: {
            minimum_stop: 'original_entry_basis',
            deadline: 'same_session'
          }
        },
        {
          key: 'trailing_ma',
          enabled: true,
          required: true,
          weight: 20,
          parameters: {
            allowed_periods: [10, 20],
            trade_level_selection: 'required',
            exit_signal: 'first_daily_close_below_selected_ma',
            equality_triggers: false,
            execution_window_minutes: 30
          }
        }
      ]
    }
  }
};

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
  }
  return value;
}

deepFreeze(CANONICAL_BO_CONFIG);

// Returns an editable deep copy so callers never mutate the canonical default.
function getCanonicalBOConfig() {
  return structuredClone(CANONICAL_BO_CONFIG);
}

module.exports = {
  CANONICAL_BO_NAME,
  CANONICAL_BO_DESCRIPTION,
  CANONICAL_BO_CONFIG,
  getCanonicalBOConfig
};
