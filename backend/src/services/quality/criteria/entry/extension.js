'use strict';

// Entry Extension criterion (docs/QUALITY_PROFILES_REQUIREMENT.md section 25).
//
//   TriggerExtensionPct = (EntryBasis / EffectiveTrigger - 1) * 100
//   PivotExtensionPct   = (EntryBasis / ConfirmedPivot  - 1) * 100
//   ExtensionADR        = (EntryBasis - EffectiveTrigger) / Volatility$
//
// The primary normalization is profile configuration ('ADR' or 'ATR'). There is
// no canonical hard compliance limit in v1 ('disabled'); a positive configured
// maximum adds a hard compliance failure. Extension in ADR/ATR units always
// produces a numerical quality score from the immutable profile curve.
//
// Outcome/PnL never influences this measure, and the user is never asked to
// type ADR or extension.

const { CRITERION_STATUS } = require('../../constants');
const { requireStringParameter, unknownResult } = require('./common');

function evaluate({
  key = 'entry_extension',
  criterion = {},
  entryEvidence = {},
  setupContext = {},
  triggerResolution = null,
  volatilityByMethod = {}
}) {
  const parameters = criterion.parameters || {};
  const normalization = requireStringParameter(parameters, 'primary_normalization', key);
  const hardMaximum = parameters.hard_maximum;

  if (entryEvidence.direction && entryEvidence.direction !== 'long') {
    return unknownResult(
      'Canonical Entry extension is defined for long breakouts; a short entry cannot be graded by this profile.'
    );
  }
  const entryBasis = entryEvidence.entryBasis;
  if (typeof entryBasis !== 'number' || !Number.isFinite(entryBasis) || entryBasis <= 0) {
    return unknownResult('Entry basis is unavailable; entry extension cannot be calculated.');
  }
  const effectiveTrigger = triggerResolution ? triggerResolution.effectiveTrigger : null;
  if (typeof effectiveTrigger !== 'number' || !Number.isFinite(effectiveTrigger) || effectiveTrigger <= 0) {
    return unknownResult('The effective trigger is unavailable; entry extension cannot be calculated.');
  }
  const volatility = volatilityByMethod ? volatilityByMethod[normalization] : null;
  if (!volatility || !volatility.available || !(volatility.dollars > 0)) {
    return unknownResult(
      volatility && volatility.reason
        ? `Volatility reference unavailable: ${volatility.reason}`
        : 'The volatility reference is unavailable; entry extension cannot be normalized.'
    );
  }

  const triggerExtensionPct = (entryBasis / effectiveTrigger - 1) * 100;
  const pivotExtensionPct =
    typeof setupContext.confirmedPivot === 'number' && setupContext.confirmedPivot > 0
      ? (entryBasis / setupContext.confirmedPivot - 1) * 100
      : null;
  const extensionNormalized = (entryBasis - effectiveTrigger) / volatility.dollars;

  let status = CRITERION_STATUS.PASS;
  let message = `Entry extension is ${extensionNormalized.toFixed(3)} ${normalization} above the effective trigger.`;
  if (hardMaximum !== 'disabled') {
    const violated = extensionNormalized > hardMaximum;
    status = violated ? CRITERION_STATUS.FAIL : CRITERION_STATUS.PASS;
    message = violated
      ? `Entry extension ${extensionNormalized.toFixed(3)} ${normalization} exceeds the configured maximum ${hardMaximum}.`
      : `Entry extension is ${extensionNormalized.toFixed(3)} ${normalization}, within the configured maximum ${hardMaximum}.`;
  } else if (extensionNormalized < 0) {
    message = `Opening execution is below the effective trigger (${extensionNormalized.toFixed(3)} ${normalization}).`;
  }

  return {
    status,
    scoring_value: extensionNormalized,
    raw_value: extensionNormalized,
    evidence: {
      entry_basis: entryBasis,
      effective_trigger: effectiveTrigger,
      confirmed_pivot: setupContext.confirmedPivot ?? null,
      trigger_extension_pct: triggerExtensionPct,
      pivot_extension_pct: pivotExtensionPct,
      primary_normalization: normalization,
      extension_normalized: extensionNormalized,
      extension_adr: normalization === 'ADR' ? extensionNormalized : null,
      extension_atr: normalization === 'ATR' ? extensionNormalized : null,
      volatility_dollars: volatility.dollars,
      volatility_period: volatility.period,
      hard_maximum: hardMaximum
    },
    message
  };
}

module.exports = { evaluate };
