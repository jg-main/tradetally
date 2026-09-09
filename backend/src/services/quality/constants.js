'use strict';

// Shared constants for the versioned Quality Profile framework.
// See docs/QUALITY_PROFILES_REQUIREMENT.md (sections 1, 5, 7, 8, 9, 10).
// Legacy stock/option Setup Quality grading (tradeQuality.service.js) is
// intentionally separate and untouched.

const CRITERION_STATUS = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  UNKNOWN: 'UNKNOWN'
});

// Order matters for deterministic rendering/tests.
const CRITERION_STATUS_VALUES = Object.freeze([
  CRITERION_STATUS.PASS,
  CRITERION_STATUS.FAIL,
  CRITERION_STATUS.NOT_APPLICABLE,
  CRITERION_STATUS.UNKNOWN
]);

const COMPLIANCE = Object.freeze({
  PASS: 'PASS',
  FAIL: 'FAIL',
  INCOMPLETE: 'INCOMPLETE'
});

const COMPLIANCE_VALUES = Object.freeze([
  COMPLIANCE.PASS,
  COMPLIANCE.FAIL,
  COMPLIANCE.INCOMPLETE
]);

const GRADES = Object.freeze({
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  F: 'F'
});

const GRADE_VALUES = Object.freeze([
  GRADES.A,
  GRADES.B,
  GRADES.C,
  GRADES.D,
  GRADES.F
]);

// Canonical grade thresholds (spec section 10). F is implied below the D
// threshold. Thresholds are configurable at profile/dimension level.
const DEFAULT_GRADE_THRESHOLDS = Object.freeze({
  A: 90,
  B: 80,
  C: 70,
  D: 60
});

// Canonical minimum evidence coverage before a dimension is graded
// (spec section 9). Profile-configurable.
const DEFAULT_MINIMUM_COVERAGE = 70;

const DIMENSIONS = Object.freeze({
  SETUP: 'setup',
  ENTRY: 'entry',
  MANAGEMENT: 'management'
});

const DIMENSION_KEYS = Object.freeze([
  DIMENSIONS.SETUP,
  DIMENSIONS.ENTRY,
  DIMENSIONS.MANAGEMENT
]);

// Evaluation lifecycle statuses (spec section 5.3).
const EVALUATION_STATUS = Object.freeze({
  DRAFT: 'draft',
  NEEDS_INPUT: 'needs_input',
  COMPLETED: 'completed',
  INSUFFICIENT_DATA: 'insufficient_data',
  ERROR: 'error'
});

const EVALUATION_STATUS_VALUES = Object.freeze([
  EVALUATION_STATUS.DRAFT,
  EVALUATION_STATUS.NEEDS_INPUT,
  EVALUATION_STATUS.COMPLETED,
  EVALUATION_STATUS.INSUFFICIENT_DATA,
  EVALUATION_STATUS.ERROR
]);

const DEFAULT_SCHEMA_VERSION = 1;

// A dimension is only gradeable once its evaluated/known weight reaches the
// configured minimum coverage; below that the Score and Grade are N/A.
// Coverage is expressed as a percentage (0-100).
const MAX_SCORE = 100;

function round2(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

module.exports = {
  CRITERION_STATUS,
  CRITERION_STATUS_VALUES,
  COMPLIANCE,
  COMPLIANCE_VALUES,
  GRADES,
  GRADE_VALUES,
  DEFAULT_GRADE_THRESHOLDS,
  DEFAULT_MINIMUM_COVERAGE,
  DIMENSIONS,
  DIMENSION_KEYS,
  EVALUATION_STATUS,
  EVALUATION_STATUS_VALUES,
  DEFAULT_SCHEMA_VERSION,
  MAX_SCORE,
  round2
};
