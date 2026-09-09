'use strict';

// Pure dimension aggregation engine for the versioned Quality Profile
// framework (spec sections 7, 8, 9, 10, 46).
//
// Score, Compliance, and Coverage are computed independently for each
// dimension (Setup / Entry / Management). This module never computes a
// combined overall quality score and never reads the database.
//
// Score formula (section 9), applied to the criteria enabled in the
// dimension configuration:
//
//   quality = sum(score_i * weight_i) / sum(available_applicable_weight_i)
//
// Rules:
//   - PASS and FAIL contribute their numerical score.
//   - UNKNOWN is removed from the score denominator but reduces coverage.
//   - NOT_APPLICABLE is removed from both the score denominator and the
//     applicable-weight (coverage) denominator.
//   - Below the configured minimum coverage the Score and Grade are N/A,
//     while Compliance is still derived from required criteria.

const {
  CRITERION_STATUS,
  COMPLIANCE,
  DEFAULT_GRADE_THRESHOLDS,
  DEFAULT_MINIMUM_COVERAGE,
  DIMENSION_KEYS,
  round2
} = require('./constants');
const {
  isKnownStatus,
  isNotApplicableStatus,
  isUnknownStatus,
  validateCriterionResult
} = require('./criterionResult');
const { assertDimensionConfig, assertProfileVersionConfiguration } = require('./validation');

function hasOwn(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

// Grade for a score using configured thresholds. `thresholds` maps grade to
// the minimum score required for that grade; F is implied below the D
// threshold. Returns null when score is null.
function gradeForScore(score, thresholds = DEFAULT_GRADE_THRESHOLDS) {
  if (score === null || score === undefined || !Number.isFinite(score)) {
    return null;
  }
  const th = thresholds || DEFAULT_GRADE_THRESHOLDS;
  const order = ['A', 'B', 'C', 'D'];
  for (const grade of order) {
    if (typeof th[grade] === 'number' && score >= th[grade]) {
      return grade;
    }
  }
  return 'F';
}

function normalizeResultsArray(criterionResults) {
  if (criterionResults === undefined || criterionResults === null) {
    return [];
  }
  if (!Array.isArray(criterionResults)) {
    throw new Error('criterion results must be provided as an array');
  }
  const seen = new Set();
  return criterionResults.map((result) => {
    const { valid, errors } = validateCriterionResult(result);
    if (!valid) {
      const key = result && typeof result.key === 'string' ? result.key : '<unknown>';
      throw new Error(`Invalid criterion result for "${key}": ${errors.join('; ')}`);
    }
    if (seen.has(result.key)) {
      throw new Error(`Duplicate criterion result for "${result.key}"`);
    }
    seen.add(result.key);
    return result;
  });
}

/**
 * Aggregate one dimension.
 *
 * @param {object} dimensionConfig - { minimum_coverage?, grade_thresholds?, criteria: [] }
 * @param {Array} criterionResults - validated criterion results for this dimension.
 * @param {object} [options]
 * @param {boolean} [options.treatMissingAsUnknown=true] - enabled criteria without a
 *   supplied result are treated as UNKNOWN (evidence not obtained).
 * @returns {object} dimension result: score/grade/compliance/coverage plus bookkeeping.
 */
function aggregateDimension(dimensionConfig, criterionResults, options = {}) {
  const treatMissingAsUnknown = options.treatMissingAsUnknown !== false;
  assertDimensionConfig(dimensionConfig);

  const minimumCoverage = Number.isFinite(dimensionConfig.minimum_coverage)
    ? dimensionConfig.minimum_coverage
    : DEFAULT_MINIMUM_COVERAGE;
  const thresholds = dimensionConfig.grade_thresholds || DEFAULT_GRADE_THRESHOLDS;

  const results = normalizeResultsArray(criterionResults);
  const resultByKey = new Map(results.map((result) => [result.key, result]));

  const enriched = [];
  let knownWeight = 0;
  let unknownWeight = 0;
  let notApplicableWeight = 0;
  let weightedScoreSum = 0;

  for (const criterion of dimensionConfig.criteria) {
    const enabled = criterion.enabled !== undefined ? criterion.enabled : true;
    if (!enabled) {
      continue;
    }
    const key = criterion.key;
    const weight = criterion.weight;
    const required = criterion.required === true;

    let result = resultByKey.get(key);
    let evidenceMissing = false;
    if (!result) {
      if (!treatMissingAsUnknown) {
        throw new Error(`No criterion result supplied for enabled criterion "${key}"`);
      }
      evidenceMissing = true;
      result = {
        key,
        status: CRITERION_STATUS.UNKNOWN,
        score: null,
        raw_value: null,
        evidence: null,
        message: 'No evidence obtained for this criterion.'
      };
    }

    const status = result.status;
    const applicable = isKnownStatus(status) || isUnknownStatus(status);

    if (isKnownStatus(status)) {
      knownWeight += weight;
      weightedScoreSum += result.score * weight;
    } else if (isUnknownStatus(status)) {
      unknownWeight += weight;
    } else if (isNotApplicableStatus(status)) {
      notApplicableWeight += weight;
    }

    enriched.push({
      key,
      status,
      score: isKnownStatus(status) ? result.score : null,
      scoringValue: result.scoring_value ?? null,
      weight,
      required,
      applicable,
      known: isKnownStatus(status),
      evidenceMissing,
      rawValue: result.raw_value ?? null,
      evidence: result.evidence ?? null,
      message: result.message ?? null
    });
  }

  const applicableWeight = knownWeight + unknownWeight;
  const coverage = applicableWeight === 0
    ? 100
    : round2((knownWeight / applicableWeight) * 100);
  const coverageMet = coverage >= minimumCoverage;

  let score = null;
  if (knownWeight > 0) {
    const rawScore = round2(weightedScoreSum / knownWeight);
    score = coverageMet ? rawScore : null;
  }

  const grade = score === null ? null : gradeForScore(score, thresholds);

  // Compliance (section 8) only considers applicable required criteria.
  // NOT_APPLICABLE required criteria are excluded; a required UNKNOWN makes
  // the dimension INCOMPLETE only when no known required failure exists.
  const requiredApplicable = enriched.filter(
    (entry) => entry.required && entry.applicable
  );
  const requiredFailed = requiredApplicable.some((entry) => entry.status === CRITERION_STATUS.FAIL);
  const requiredUnknown = requiredApplicable.some((entry) => entry.status === CRITERION_STATUS.UNKNOWN);

  let compliance;
  if (requiredFailed) {
    compliance = COMPLIANCE.FAIL;
  } else if (requiredUnknown) {
    compliance = COMPLIANCE.INCOMPLETE;
  } else {
    compliance = COMPLIANCE.PASS;
  }

  return {
    score,
    grade,
    compliance,
    coverage,
    coverageMet,
    minimumCoverage,
    applicableWeight: round2(applicableWeight),
    knownWeight: round2(knownWeight),
    unknownWeight: round2(unknownWeight),
    notApplicableWeight: round2(notApplicableWeight),
    criterionResults: enriched
  };
}

/**
 * Aggregate every dimension present in a profile version configuration.
 * Returns an object keyed by dimension (setup/entry/management) with no
 * combined overall score.
 *
 * @param {object} versionConfiguration - { dimensions: { setup, entry, management } }
 * @param {object} resultsByDimension - { setup: [], entry: [], management: [] }
 */
function aggregateAllDimensions(versionConfiguration, resultsByDimension) {
  if (
    versionConfiguration === null ||
    typeof versionConfiguration !== 'object' ||
    versionConfiguration.dimensions === null ||
    typeof versionConfiguration.dimensions !== 'object'
  ) {
    throw new Error('profile version configuration requires a dimensions object');
  }

  const resultsBy = resultsByDimension || {};
  const output = {};
  for (const dimension of DIMENSION_KEYS) {
    if (hasOwn(versionConfiguration.dimensions, dimension)) {
      output[dimension] = aggregateDimension(
        versionConfiguration.dimensions[dimension],
        resultsBy[dimension] || []
      );
    }
  }
  return output;
}

module.exports = {
  // Structural validators live in ./validation and are re-exported here for
  // convenience so callers that already import them from aggregation keep
  // working.
  assertDimensionConfig,
  assertProfileVersionConfiguration,
  gradeForScore,
  aggregateDimension,
  aggregateAllDimensions
};
