'use strict';

// Generic criterion result contract (spec sections 7 and 56).
//
// Every criterion evaluator returns a standardized result:
//
//   {
//     key: string,                       // criterion key from the profile version config
//     status: 'PASS'|'FAIL'|'NOT_APPLICABLE'|'UNKNOWN',
//     score: number|null,                // 0-100; required for PASS/FAIL, null otherwise
//     scoring_value: number|string|object|null, // NEW normalized scoring input
//     raw_value: any|null,               // measured value backing the decision
//     evidence: object|null,             // drill-down evidence snapshot
//     message: string|null               // human-readable summary
//   }
//
// `scoring_value` is the normalized input to the criterion's immutable
// profile `scoring` envelope used to derive `score` for PASS/FAIL:
//   - binary:            unused (score derives from PASS/FAIL).
//   - step/piecewise_linear: finite numeric value on the configured curve.
//   - discrete:          configured outcome-key string.
//   - composite:         object keyed by component.key whose values are the
//                        component inputs (boolean for binary components,
//                        number for step/piecewise, string for discrete).
// A PASS/FAIL score that contradicts the configured envelope is invalid.
// UNKNOWN / NOT_APPLICABLE never carry a numeric score.
//
// The optional `compliance` field (spec 56 example) is accepted for
// compatibility but must agree with the status. Aggregation derives the
// authoritative value from `status`.

const { CRITERION_STATUS, CRITERION_STATUS_VALUES, MAX_SCORE } = require('./constants');

const isKnownStatus = (status) => status === CRITERION_STATUS.PASS || status === CRITERION_STATUS.FAIL;
const isUnknownStatus = (status) => status === CRITERION_STATUS.UNKNOWN;
const isNotApplicableStatus = (status) => status === CRITERION_STATUS.NOT_APPLICABLE;

// Criterion-level compliance meaning: PASS => true, FAIL => false,
// NOT_APPLICABLE / UNKNOWN => null (compliance not determined here).
function complianceForStatus(status) {
  switch (status) {
    case CRITERION_STATUS.PASS:
      return true;
    case CRITERION_STATUS.FAIL:
      return false;
    default:
      return null;
  }
}

function isFiniteScore(score) {
  return typeof score === 'number' && Number.isFinite(score);
}

function validateCriterionResult(result) {
  const errors = [];

  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return { valid: false, errors: ['criterion result must be an object'] };
  }

  if (typeof result.key !== 'string' || result.key.trim() === '') {
    errors.push('criterion result requires a non-empty string key');
  }

  if (!CRITERION_STATUS_VALUES.includes(result.status)) {
    errors.push(
      `status must be one of ${CRITERION_STATUS_VALUES.join(', ')}; got ${JSON.stringify(result.status)}`
    );
  } else if (isKnownStatus(result.status)) {
    // PASS/FAIL carry a numerical quality score (0-100). FAIL may still carry
    // a non-zero score; compliance and score are independent.
    if (!isFiniteScore(result.score) || result.score < 0 || result.score > MAX_SCORE) {
      errors.push(`${result.status} requires a numeric score between 0 and ${MAX_SCORE}`);
    }
  } else if (result.score !== undefined && result.score !== null) {
    // NOT_APPLICABLE/UNKNOWN never contribute a score.
    errors.push(`${result.status} must not carry a quality score`);
  }

  if (result.compliance !== undefined && result.compliance !== null) {
    const derived = complianceForStatus(result.status);
    if (derived === null || result.compliance !== derived) {
      errors.push(`compliance field must agree with status ${result.status}`);
    }
  }

  if (result.evidence !== undefined && result.evidence !== null) {
    if (typeof result.evidence !== 'object' || Array.isArray(result.evidence)) {
      errors.push('evidence must be an object or null');
    }
  }

  if (result.scoring_value !== undefined && result.scoring_value !== null) {
    const scoringValue = result.scoring_value;
    const isNumber = typeof scoringValue === 'number' && Number.isFinite(scoringValue);
    const isString = typeof scoringValue === 'string' && scoringValue.length > 0;
    const isObject = Object.prototype.toString.call(scoringValue) === '[object Object]';
    if (!isNumber && !isString && !isObject) {
      errors.push('scoring_value must be a finite number, non-empty string, plain object, or null');
    }
  }

  if (result.message !== undefined && result.message !== null) {
    if (typeof result.message !== 'string') {
      errors.push('message must be a string or null');
    }
  }

  return { valid: errors.length === 0, errors };
}

// Throws a descriptive Error when the result violates the contract.
function assertValidCriterionResult(result) {
  const { valid, errors } = validateCriterionResult(result);
  if (!valid) {
    const key = result && typeof result.key === 'string' ? result.key : '<unknown>';
    throw new Error(`Invalid criterion result for "${key}": ${errors.join('; ')}`);
  }
  return result;
}

// Derives a criterion-level compliance value from a validated status.
function criterionCompliance(result) {
  return result ? complianceForStatus(result.status) : null;
}

module.exports = {
  isKnownStatus,
  isUnknownStatus,
  isNotApplicableStatus,
  complianceForStatus,
  validateCriterionResult,
  assertValidCriterionResult,
  criterionCompliance
};
