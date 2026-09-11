'use strict';

const {
  validateParameters,
  validateManagementCriteria,
  validatePolicyBlock,
  SUPPORTED_TRAILING_PERIODS
} = require('../../../../src/services/quality/criteria/management/parameterSchemas');

describe('validateParameters (Management)', () => {
  it('accepts canonical parameters', () => {
    expect(validateParameters('partial_timing', { earliest_day: 3, latest_day: 5, minimum_mfe_r: 1.0, completion_window: 'same_session' })).toEqual([]);
    expect(validateParameters('partial_sizing', { target_pct: 50, target_tolerance_pct: 2 })).toEqual([]);
    expect(validateParameters('post_partial_breakeven', { minimum_stop: 'original_entry_basis', deadline: 'same_session' })).toEqual([]);
    expect(validateParameters('trailing_ma', {
      allowed_periods: [10, 20], trade_level_selection: 'required',
      exit_signal: 'first_daily_close_below_selected_ma', equality_triggers: false,
      execution_window_minutes: 30, activation: 'after_partial'
    })).toEqual([]);
  });

  it('accepts a pre-Phase-4 partial_sizing without target_tolerance_pct (F9)', () => {
    expect(validateParameters('partial_sizing', { target_pct: 50 })).toEqual([]);
  });

  it('accepts the expanded session-window forms', () => {
    expect(validateParameters('partial_timing', { earliest_day: 3, latest_day: 5, minimum_mfe_r: 1, completion_window: 'next_session' })).toEqual([]);
    expect(validateParameters('partial_timing', { earliest_day: 3, latest_day: 5, minimum_mfe_r: 1, completion_window: 2 })).toEqual([]);
    expect(validateParameters('partial_timing', { earliest_day: 3, latest_day: 5, minimum_mfe_r: 1, completion_window: 'whenever' }))
      .toEqual(expect.arrayContaining([expect.stringContaining('session window')]));
  });

  it('rejects unsupported trailing periods and activation values', () => {
    expect(validateParameters('trailing_ma', {
      allowed_periods: [10, 21], trade_level_selection: 'required',
      exit_signal: 'first_daily_close_below_selected_ma', equality_triggers: false, execution_window_minutes: 30
    })).toEqual(expect.arrayContaining([expect.stringContaining('unsupported period')]));
    expect(validateParameters('trailing_ma', {
      allowed_periods: [10, 20], trade_level_selection: 'required',
      exit_signal: 'first_daily_close_below_selected_ma', equality_triggers: false,
      execution_window_minutes: 30, activation: 'sometimes'
    })).toEqual(expect.arrayContaining([expect.stringContaining('activation')]));
  });

  it('rejects a mistyped target_pct', () => {
    expect(validateParameters('partial_sizing', { target_pct: 'fifty' })).toEqual(
      expect.arrayContaining([expect.stringContaining('target_pct')])
    );
  });
});

describe('validatePolicyBlock', () => {
  it('accepts a valid explicit policy block', () => {
    expect(validatePolicyBlock({
      partial_trigger: { earliest_day: 2, latest_day: 4, minimum_mfe_r: 1.5, completion_window: 1 },
      partial_target: { target_pct: 40, target_tolerance_pct: 3 },
      completion_window: 'next_session',
      execution_window_minutes: 15,
      trailing_activation: 'explicit'
    })).toEqual([]);
  });

  it('rejects an inverted trigger window', () => {
    expect(validatePolicyBlock({ partial_trigger: { earliest_day: 5, latest_day: 3, minimum_mfe_r: 1 } })).toEqual(
      expect.arrayContaining([expect.stringContaining('earliest_day must be <= latest_day')])
    );
  });
});

describe('validateManagementCriteria', () => {
  it('only enforces enabled criteria', () => {
    const config = {
      criteria: [
        { key: 'partial_timing', enabled: true, required: true, weight: 20, parameters: { earliest_day: 3 } },
        { key: 'stop_ratchet', enabled: false, required: true, weight: 20, parameters: {} }
      ]
    };
    const violations = validateManagementCriteria(config);
    expect(violations).toEqual(expect.arrayContaining([expect.stringContaining('latest_day')]));
    expect(violations).not.toEqual(expect.arrayContaining([expect.stringContaining('downward_tolerance_ticks')]));
  });

  it('exposes the canonical trailing periods', () => {
    expect(SUPPORTED_TRAILING_PERIODS).toEqual([10, 20]);
  });
});
