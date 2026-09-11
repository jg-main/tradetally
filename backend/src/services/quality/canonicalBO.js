'use strict';

// Canonical BO (Qullamägi Breakout) default profile configuration
// (spec sections 11, 61, 62, 63).
//
// This module is the single source of truth for the seeded Canonical BO v1
// profile. Every trading-policy value below — including the typed `scoring`
// curves from the spec scoring sections and `missing_data_behavior` — is a
// profile-configurable default; the application may only hard-code
// mathematical definitions and evaluator types.
//
// Scoring envelope semantics (see backend/src/services/quality/validation.js):
//   binary            - two-outcome scoring (pass_score / fail_score)
//   step              - monotone constant bands; mode 'gte' matches the largest
//                       threshold the value reaches, mode 'lte' matches the
//                       smallest threshold the value stays under; otherwise
//                       default_score applies.
//   piecewise_linear  - linear interpolation between points, clamped to the
//                       endpoint scores outside the point range.
//   discrete          - outcome-category -> score map (management timing rules).
//   composite         - weighted combination of sub-component scoring configs.
//
// Criterion states (PASS/FAIL/NOT_APPLICABLE/UNKNOWN) are independent of the
// numeric score; compliance comes from `required` + the criterion result
// status, exactly as specified in sections 7-9.
//
// Conditional management criteria (Partial Timing, Partial Sizing,
// Post-Partial BE, Trailing MA) are `required: true` and declare
// `missing_data_behavior: 'not_applicable'`: their evaluators return
// NOT_APPLICABLE when the rule never becomes applicable (e.g. +1R never
// reached through Day 5, or a protective stop supersedes the MA exit), and
// NOT_APPLICABLE is excluded from coverage and from required-criteria
// compliance by the aggregation engine (sections 33, 36.3, 42, 45, 46).
// Missing evidence for a rule that DOES apply still yields UNKNOWN.

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

// Scoring factory functions. Each call returns a FRESH object so every
// criterion/component owns an independent scoring configuration: mutating one
// criterion's scoring in an editable copy can never alias another criterion's
// scoring (structuredClone preserves aliasing, so the source graph must not
// share mutable nested references).
function binaryScoring(passScore, failScore) {
  return { type: 'binary', pass_score: passScore, fail_score: failScore };
}

function contractionBands() {
  return {
    type: 'step',
    mode: 'lte',
    default_score: 0,
    thresholds: [
      { value: 0.4, score: 100 },
      { value: 0.55, score: 90 },
      { value: 0.7, score: 75 },
      { value: 0.85, score: 50 },
      { value: 1.0, score: 25 }
    ]
  };
}

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
          },
          // Section 13: YES = 100 / NO = 0.
          scoring: binaryScoring(100, 0)
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
          },
          // Section 14.5 (value = prior_move_pct).
          scoring: {
            type: 'step',
            mode: 'gte',
            default_score: 0,
            thresholds: [
              { value: 20, score: 40 },
              { value: 30, score: 60 },
              { value: 40, score: 80 },
              { value: 60, score: 90 },
              { value: 100, score: 100 }
            ]
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
          },
          // Section 15.5: binary v1 — in-range duration (10-40 sessions) = 100,
          // otherwise 0. The in-range rule comes from the parameters above.
          scoring: binaryScoring(100, 0)
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
          },
          // Section 16.5: score = 100 * non_lower_transitions / total_transitions.
          scoring: {
            type: 'piecewise_linear',
            points: [
              { value: 0, score: 0 },
              { value: 1, score: 100 }
            ]
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
          },
          // Section 17.4 (value = contraction ratio).
          scoring: contractionBands()
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
          },
          // Section 18.3 (value = volume ratio).
          scoring: contractionBands()
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
          },
          // Section 19.3 (value = number of passing subcomponents, 0-3).
          scoring: {
            type: 'step',
            mode: 'gte',
            default_score: 0,
            thresholds: [
              { value: 1, score: 33 },
              { value: 2, score: 67 },
              { value: 3, score: 100 }
            ]
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
          },
          // Section 21.4 composite with canonical subweights (30/20/30/20).
          scoring: {
            type: 'composite',
            components: [
              {
                key: 'resistance_touches',
                weight: 30,
                // 0 -> 0, 1 -> 40, 2 -> 80, >=3 -> 100.
                scoring: {
                  type: 'step',
                  mode: 'gte',
                  default_score: 0,
                  thresholds: [
                    { value: 1, score: 40 },
                    { value: 2, score: 80 },
                    { value: 3, score: 100 }
                  ]
                }
              },
              {
                key: 'recent_touch',
                weight: 20,
                // Recent touch within final window: YES 100 / NO 0.
                scoring: binaryScoring(100, 0)
              },
              {
                key: 'd1_proximity',
                weight: 30,
                // Section 21.4: <=2% -> 100, 2-5% linear 100->70,
                // 5-10% linear 70->0, >10% -> 0 (value = pivot distance pct).
                scoring: {
                  type: 'piecewise_linear',
                  points: [
                    { value: 2, score: 100 },
                    { value: 5, score: 70 },
                    { value: 10, score: 0 }
                  ]
                }
              },
              {
                key: 'no_prior_resolution',
                weight: 20,
                // No pre-breakout close materially above the pivot: YES 100 / NO 0.
                scoring: binaryScoring(100, 0)
              }
            ]
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
          parameters: {},
          // Section 23: entry in the breakout session = 100, otherwise 0.
          scoring: binaryScoring(100, 0)
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
          },
          // Section 24 defines trigger evidence and compliance. The canonical
          // quality scoring for this compliance-only rule is binary:
          // PASS = 100 / FAIL = 0 (no partial credit).
          scoring: binaryScoring(100, 0)
        },
        {
          key: 'volume_pace',
          enabled: true,
          required: false,
          weight: 10,
          parameters: {
            reference_sessions: 20,
            target_multiple: 1.4
          },
          // Section 26 (value = volume pace multiple).
          scoring: {
            type: 'step',
            mode: 'gte',
            default_score: 0,
            thresholds: [
              { value: 0.8, score: 25 },
              { value: 1.0, score: 60 },
              { value: 1.4, score: 85 },
              { value: 2.0, score: 100 }
            ]
          }
        },
        {
          key: 'range_pace',
          enabled: true,
          required: false,
          weight: 5,
          parameters: {
            reference_sessions: 20
          },
          // Section 27 (value = range pace multiple).
          scoring: {
            type: 'step',
            mode: 'gte',
            default_score: 0,
            thresholds: [
              { value: 0.75, score: 40 },
              { value: 1.0, score: 70 },
              { value: 1.25, score: 90 },
              { value: 1.5, score: 100 }
            ]
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
          },
          // Section 25 (value = extension in ADR units).
          scoring: {
            type: 'step',
            mode: 'lte',
            default_score: 0,
            thresholds: [
              { value: 0.05, score: 100 },
              { value: 0.1, score: 90 },
              { value: 0.2, score: 75 },
              { value: 0.3, score: 50 },
              { value: 0.5, score: 25 }
            ]
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
          },
          // Section 29 defines stop compliance/UNKNOWN. The canonical quality
          // scoring for this compliance-only rule is binary:
          // PASS = 100 / FAIL = 0 (no partial credit).
          scoring: binaryScoring(100, 0)
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
          },
          // Section 31 (value = stop width / ADR$).
          scoring: {
            type: 'step',
            mode: 'lte',
            default_score: 0,
            thresholds: [
              { value: 0.5, score: 100 },
              { value: 0.75, score: 90 },
              { value: 1.0, score: 75 },
              { value: 1.25, score: 40 }
            ]
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
          },
          missing_data_behavior: 'not_applicable',
          // Section 38 (outcome categories).
          scoring: {
            type: 'discrete',
            scores: {
              same_trigger_session: 100,
              next_session: 50,
              later_or_not_completed: 0
            }
          }
        },
        {
          key: 'partial_sizing',
          enabled: true,
          required: true,
          weight: 15,
          parameters: {
            target_pct: 50,
            // Section 39: compliance uses the configured target/tolerance policy;
            // achieved partial within +/- tolerance_pct of the target passes.
            target_tolerance_pct: 2
          },
          missing_data_behavior: 'not_applicable',
          // Section 39. Achieved partial pct is evaluated as absolute
          // deviation from target_pct (50%): <=2pp -> 100, <=5pp -> 90,
          // <=10pp -> 70, <=20pp -> 40, beyond -> 0, mirroring the
          // 48-52 / 45-48+52-55 / 40-45+55-60 / 30-40+60-70 bands.
          scoring: {
            type: 'step',
            mode: 'lte',
            default_score: 0,
            thresholds: [
              { value: 0.02, score: 100 },
              { value: 0.05, score: 90 },
              { value: 0.1, score: 70 },
              { value: 0.2, score: 40 }
            ]
          }
        },
        {
          key: 'no_premature_reduction',
          enabled: true,
          required: true,
          weight: 10,
          parameters: {},
          // Section 40 (value = fraction of position reduced before trigger).
          scoring: {
            type: 'step',
            mode: 'lte',
            default_score: 0,
            thresholds: [
              { value: 0, score: 100 },
              { value: 0.1, score: 75 },
              { value: 0.25, score: 50 }
            ]
          }
        },
        {
          key: 'stop_ratchet',
          enabled: true,
          required: true,
          weight: 20,
          parameters: {
            downward_tolerance_ticks: 0
          },
          // Section 41 defines the no-lowering rule and UNKNOWN on missing
          // stop history. The canonical quality scoring for this
          // compliance-only rule is binary: PASS = 100 / FAIL = 0
          // (no partial credit).
          scoring: binaryScoring(100, 0)
        },
        {
          key: 'post_partial_breakeven',
          enabled: true,
          required: true,
          weight: 15,
          parameters: {
            minimum_stop: 'original_entry_basis',
            deadline: 'same_session'
          },
          missing_data_behavior: 'not_applicable',
          // Section 42 (outcome categories).
          scoring: {
            type: 'discrete',
            scores: {
              same_session_at_or_above_be: 100,
              before_next_session: 70,
              raised_below_be: 40,
              no_meaningful_reduction: 0
            }
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
            execution_window_minutes: 30,
            // Section 46: the trailing phase activates only after the canonical
            // partial is completed; a close below the MA before activation is
            // irrelevant.
            activation: 'after_partial'
          },
          missing_data_behavior: 'not_applicable',
          // Section 44 (outcome categories).
          scoring: {
            type: 'discrete',
            scores: {
              within_window: 100,
              later_same_next_session: 70,
              one_session_late: 40,
              later_or_ignored: 0
            }
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
