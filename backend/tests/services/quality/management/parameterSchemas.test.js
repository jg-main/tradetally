'use strict';

const {
  validateParameters,
  validateManagementCriteria,
  SUPPORTED_TRAILING_PERIODS
} = require('../../../../src/services/quality/criteria/management/parameterSchemas');

describe('validateParameters (Management)', () => {
  it('accepts canonical parameters for every management criterion', () => {
    const valid = {
      partial_timing: { earliest_day: 3, latest_day: 5, minimum_mfe_r: 1.0, completion_window: 'same_session' },
      partial_sizing: { target_pct: 50, target_tolerance_pct: 2 },
      stop_ratchet: { downward_tolerance_ticks: 0 },
      post_partial_breakeven: { minimum_stop: 'original_entry_basis', deadline: 'same_session' },
      trailing_ma: {
        allowed_periods: [10, 20],
        trade_level_selection: 'required',
        exit_signal: 'first_daily_close_below_selected_ma',
        equality_triggers: false,
        execution_window_minutes: 30
      }
    };
    for (const [key, parameters] of Object.entries(valid)) {
      expect(validateParameters(key, parameters)).toEqual([]);
    }
  });

  it('reports missing and mistyped parameters', () => {
    expect(validateParameters('partial_timing', { earliest_day: 3 })).toContain(
      'criterion "partial_timing" parameter "latest_day" is required'
    );
    expect(validateParameters('partial_sizing', { target_pct: 'fifty' })).toEqual(
      expect.arrayContaining([expect.stringContaining('target_pct')])
    );
  });

  it('rejects unsupported trailing periods', () => {
    expect(validateParameters('trailing_ma', {
      allowed_periods: [10, 21],
      trade_level_selection: 'required',
      exit_signal: 'first_daily_close_below_selected_ma',
      equality_triggers: false,
      execution_window_minutes: 30
    })).toEqual(expect.arrayContaining([expect.stringContaining('unsupported period')]));
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
    // The disabled stop_ratchet's missing downward_tolerance_ticks is not enforced.
    expect(validateManagementCriteria(config)).toEqual(
      expect.arrayContaining([expect.stringContaining('latest_day')])
    );
    expect(validateManagementCriteria(config)).not.toEqual(
      expect.arrayContaining([expect.stringContaining('downward_tolerance_ticks')])
    );
  });

  it('rejects earliest_day > latest_day', () => {
    const config = {
      criteria: [
        {
          key: 'partial_timing', enabled: true, required: true, weight: 20,
          parameters: { earliest_day: 6, latest_day: 5, minimum_mfe_r: 1.0, completion_window: 'same_session' }
        }
      ]
    };
    expect(validateManagementCriteria(config)).toEqual(
      expect.arrayContaining([expect.stringContaining('earliest_day must be <= latest_day')])
    );
  });

  it('exposes the canonical trailing periods', () => {
    expect(SUPPORTED_TRAILING_PERIODS).toEqual([10, 20]);
  });
});
