'use strict';

// Breakout Session criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 23).
//
// The breakout session is the Phase 2 authoritative resolution session: the
// first daily trading session after the confirmed base where price trades above
// the confirmed Pivot. It is NEVER redefined to a later actual-entry date.
//
//   actual_entry_session == breakout_session -> PASS
//   otherwise                                -> FAIL (a late entry fails)
//
// Binary profile scoring (PASS 100 / FAIL 0).

const { CRITERION_STATUS } = require('../../constants');

function calendarDayDelta(fromDate, toDate) {
  if (!fromDate || !toDate) return null;
  const from = Date.parse(`${fromDate}T00:00:00.000Z`);
  const to = Date.parse(`${toDate}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.round((to - from) / (24 * 60 * 60 * 1000));
}

function evaluate({ key = 'breakout_session', setupContext = {}, entryEvidence = {} }) {
  const breakoutSession = setupContext.breakoutSession || null;
  const actualEntrySession = entryEvidence.actualEntrySession || null;

  const evidence = {
    breakout_session: breakoutSession,
    actual_entry_session: actualEntrySession,
    session_delta_calendar_days: calendarDayDelta(breakoutSession, actualEntrySession),
    initial_entry_time: entryEvidence.initialEntryTime || null,
    entry_basis: entryEvidence.entryBasis ?? null,
    original_position_qty: entryEvidence.originalPositionQty ?? null,
    breakout_boundary_source: setupContext.boundarySource || null,
    execution_evidence_source: entryEvidence.provenance ? entryEvidence.provenance.source : null
  };

  if (!breakoutSession) {
    return {
      status: CRITERION_STATUS.UNKNOWN,
      scoring_value: null,
      raw_value: null,
      evidence,
      message: 'The persisted Setup breakout/resolution session is unavailable; breakout-session compliance cannot be established.'
    };
  }
  if (!actualEntrySession) {
    return {
      status: CRITERION_STATUS.UNKNOWN,
      scoring_value: null,
      raw_value: null,
      evidence,
      message: 'The actual initial-entry session is unavailable; breakout-session compliance cannot be established.'
    };
  }

  const matched = actualEntrySession === breakoutSession;
  return {
    status: matched ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: null,
    raw_value: matched ? 'same_session' : 'later_session',
    evidence,
    message: matched
      ? `Initial entry occurred in the setup breakout session ${breakoutSession}.`
      : `Initial entry occurred in ${actualEntrySession}, not the setup breakout session ${breakoutSession}.`
  };
}

module.exports = { evaluate };
