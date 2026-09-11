'use strict';

// Session-window policy resolution for Management criteria
// (docs/QUALITY_PROFILES_REQUIREMENT.md sections 36, 38, 42, 44, 63).
//
// Completion deadlines and execution windows are profile-configurable. The
// canonical seed uses `same_session` (0 sessions after the reference session),
// but a profile may configure an explicit number of regular sessions. Values
// are resolved from the immutable profile version only; this module never
// injects a canonical default.

const SAME_SESSION = 'same_session';
const NEXT_SESSION = 'next_session';

function isFiniteInteger(value) {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Resolves a session-window configuration value to a non-negative number of
 * sessions after the reference session.
 *
 * Accepted forms:
 *   - 'same_session'  -> 0
 *   - 'next_session'  -> 1
 *   - integer >= 0    -> that many sessions
 *
 * @returns {{valid:boolean, sessions:(number|null), normalized:(string|null), error:(string|null)}}
 */
function resolveSessionWindow(value) {
  if (typeof value === 'string') {
    if (value === SAME_SESSION) return { valid: true, sessions: 0, normalized: SAME_SESSION, error: null };
    if (value === NEXT_SESSION) return { valid: true, sessions: 1, normalized: NEXT_SESSION, error: null };
    return {
      valid: false,
      sessions: null,
      normalized: null,
      error: `unsupported session window ${JSON.stringify(value)}; supported: ${SAME_SESSION}, ${NEXT_SESSION}, or a non-negative integer`
    };
  }
  if (isFiniteInteger(value)) {
    return { valid: true, sessions: value, normalized: String(value), error: null };
  }
  return {
    valid: false,
    sessions: null,
    normalized: null,
    error: `session window must be ${SAME_SESSION}, ${NEXT_SESSION}, or a non-negative integer; got ${JSON.stringify(value)}`
  };
}

function sessionIndexForWindow(baseSessionIndex, sessions) {
  if (!Number.isInteger(baseSessionIndex) || !Number.isInteger(sessions)) return null;
  return baseSessionIndex + sessions;
}

module.exports = {
  SAME_SESSION,
  NEXT_SESSION,
  resolveSessionWindow,
  sessionIndexForWindow
};
