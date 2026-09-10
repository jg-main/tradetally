'use strict';

// Initial Stop Placement criterion (docs/QUALITY_PROFILES_REQUIREMENT.md
// sections 29.1-29.4).
//
// The criterion grades the FIRST ACTUAL protective stop associated with the
// opening position against the observable LOD from the regular-session open
// through the stop-establishment reference time:
//
//   InitialStop <= LOD_observable - Buffer  -> PASS
//   otherwise                               -> FAIL
//
// Later lows never affect the grade. If the actual initial stop or the
// reference-time LOD cannot be established, the result is UNKNOWN (never a
// fabricated PASS/FAIL). A hypothetical/reference stop (e.g. LOD - buffer) is
// never treated as the user's real stop.
//
// Binary profile scoring (PASS 100 / FAIL 0).

const { CRITERION_STATUS } = require('../../constants');
const { unknownResult } = require('./common');

function evaluate({ key = 'initial_stop', entryEvidence = {}, stopEvidence = {}, buffer = {}, intradayMetrics = {} }) {
  if (entryEvidence.direction && entryEvidence.direction !== 'long') {
    return unknownResult(
      'Canonical Initial Stop is defined for long breakouts; a short entry cannot be graded by this profile.'
    );
  }
  if (!stopEvidence || !stopEvidence.available) {
    return {
      status: CRITERION_STATUS.UNKNOWN,
      scoring_value: null,
      raw_value: null,
      evidence: {
        initial_stop_price: null,
        stop_evidence_source: stopEvidence ? stopEvidence.source : null,
        reason: stopEvidence ? stopEvidence.reason : 'No actual initial protective stop evidence is available.',
        provenance: stopEvidence ? stopEvidence.provenance || null : null
      },
      message: stopEvidence && stopEvidence.reason
        ? stopEvidence.reason
        : 'The actual initial protective stop could not be established; Initial Stop is UNKNOWN.'
    };
  }

  const lod = intradayMetrics.lod || {};
  if (typeof lod.low !== 'number' || !Number.isFinite(lod.low)) {
    return unknownResult(
      lod.reason
        ? `The observable LOD through the stop-establishment reference time could not be established: ${lod.reason}`
        : 'The observable LOD through the stop-establishment reference time could not be established; Initial Stop is UNKNOWN.',
      {
        initial_stop_price: stopEvidence.price,
        stop_evidence_source: stopEvidence.source,
        reference_time: stopEvidence.referenceTime,
        lod_precision: lod.precision || null,
        lod_reason: lod.reason || null
      }
    );
  }
  if (!buffer || !buffer.available || !(buffer.buffer >= 0)) {
    return unknownResult(
      buffer && buffer.reason
        ? `Stop buffer unavailable: ${buffer.reason}`
        : 'The configured stop buffer could not be resolved; Initial Stop is UNKNOWN.',
      {
        initial_stop_price: stopEvidence.price,
        stop_evidence_source: stopEvidence.source,
        reference_time: stopEvidence.referenceTime
      }
    );
  }

  const requiredLevel = lod.low - buffer.buffer;
  const passed = stopEvidence.price <= requiredLevel;

  return {
    status: passed ? CRITERION_STATUS.PASS : CRITERION_STATUS.FAIL,
    scoring_value: null,
    raw_value: stopEvidence.price,
    evidence: {
      initial_stop_price: stopEvidence.price,
      stop_evidence_source: stopEvidence.source,
      stop_establishment_time: stopEvidence.stopEstablishmentTime || null,
      reference_time: stopEvidence.referenceTime,
      reference_time_source: stopEvidence.referenceTimeSource,
      reference_time_epoch: stopEvidence.referenceEpoch,
      regular_session_open: intradayMetrics.regularSessionOpenEpoch ?? null,
      lod_observable: lod.low,
      lod_last_observable_epoch: lod.lastObservableEpoch ?? null,
      lod_observable_bars: lod.observableBars ?? null,
      buffer_method: buffer.method,
      buffer_value: buffer.value,
      buffer: buffer.buffer,
      buffer_source: buffer.source || null,
      required_stop_ceiling: requiredLevel,
      evidence_resolution: intradayMetrics.resolution || '1min',
      provenance: stopEvidence.provenance || null
    },
    message: passed
      ? `Initial stop ${stopEvidence.price} is at or below the observable LOD ${lod.low} minus the required buffer ${buffer.buffer} (ceiling ${requiredLevel}).`
      : `Initial stop ${stopEvidence.price} is above the observable-LOD ceiling ${requiredLevel} (LOD ${lod.low} minus buffer ${buffer.buffer}).`
  };
}

module.exports = { evaluate };
