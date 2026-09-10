'use strict';

// Stop Width / Volatility criterion (docs/QUALITY_PROFILES_REQUIREMENT.md
// section 31). Kept separate from Initial Stop placement.
//
//   StopWidth       = EntryBasis - InitialStop          (long)
//   StopWidthRatio  = StopWidth / Volatility$           (ADR$ or ATR$)
//
//   StopWidthRatio <= maximum_multiple -> PASS, otherwise FAIL.
//
// The volatility method/period come from this criterion's immutable profile
// configuration (no ADR-only assumption in code). A non-protective / invalid
// stop can never obtain a misleading PASS merely because its arithmetic width
// is zero or negative: it yields UNKNOWN with the evidence problem recorded.

const { CRITERION_STATUS } = require('../../constants');
const { requireNumberParameter, requireStringParameter, unknownResult } = require('./common');

function evaluate({ key = 'stop_width', criterion = {}, entryEvidence = {}, stopEvidence = {}, volatilityByMethod = {} }) {
  const parameters = criterion.parameters || {};
  const method = requireStringParameter(parameters, 'volatility_method', key);
  const period = requireNumberParameter(parameters, 'period', key);
  const maximumMultiple = requireNumberParameter(parameters, 'maximum_multiple', key);

  if (entryEvidence.direction && entryEvidence.direction !== 'long') {
    return unknownResult(
      'Canonical Stop Width is defined for long breakouts; a short entry cannot be graded by this profile.'
    );
  }
  const entryBasis = entryEvidence.entryBasis;
  if (typeof entryBasis !== 'number' || !Number.isFinite(entryBasis) || entryBasis <= 0) {
    return unknownResult('Entry basis is unavailable; Stop Width cannot be calculated.');
  }
  if (!stopEvidence || !stopEvidence.available) {
    return unknownResult(
      stopEvidence && stopEvidence.reason
        ? stopEvidence.reason
        : 'The actual initial protective stop could not be established; Stop Width is UNKNOWN.'
    );
  }
  if (!(stopEvidence.price < entryBasis)) {
    return unknownResult(
      'The recorded initial stop is not a valid protective stop below the entry basis; Stop Width is UNKNOWN rather than a misleading zero/negative width.',
      {
        initial_stop_price: stopEvidence.price,
        entry_basis: entryBasis,
        stop_evidence_source: stopEvidence.source
      }
    );
  }

  const volatility = volatilityByMethod ? volatilityByMethod[method] : null;
  if (!volatility || !volatility.available || !(volatility.dollars > 0)) {
    return unknownResult(
      volatility && volatility.reason
        ? `Volatility reference unavailable: ${volatility.reason}`
        : 'The configured volatility reference is unavailable; Stop Width is UNKNOWN.'
    );
  }

  const stopWidth = entryBasis - stopEvidence.price;
  const ratio = stopWidth / volatility.dollars;
  const passed = ratio <= maximumMultiple;

  return {
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: ratio,
    raw_value: ratio,
    evidence: {
      entry_basis: entryBasis,
      initial_stop_price: stopEvidence.price,
      stop_width: stopWidth,
      volatility_method: method,
      volatility_period: period,
      volatility_dollars: volatility.dollars,
      volatility_pct: volatility.pct ?? null,
      stop_width_ratio: ratio,
      maximum_multiple: maximumMultiple,
      stop_evidence_source: stopEvidence.source,
      volatility_sessions: volatility.sessions ? volatility.sessions.length : null
    },
    message: passed
      ? `Stop width is ${ratio.toFixed(3)} ${method} (<= ${maximumMultiple}).`
      : `Stop width is ${ratio.toFixed(3)} ${method}, above the configured maximum ${maximumMultiple}.`
  };
}

module.exports = { evaluate };
