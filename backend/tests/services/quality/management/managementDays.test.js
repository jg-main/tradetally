'use strict';

const {
  managementDayForSession,
  buildDayEvidence,
  resolvePartialTrigger,
  findCrossingInSession
} = require('../../../../src/services/quality/management/managementDays');

const PARAMS = { earliest_day: 3, latest_day: 5, minimum_mfe_r: 1.0 };
const ENTRY_BASIS = 100;
const R_PER_SHARE = 5; // +1R => high >= 105

// Day evidence with Day 1..N highs. Day 1 is already post-entry-adjusted.
function days(highs, { completedThrough = highs.length, day1Known = true, day1PossibleX = false } = {}) {
  return highs.map((high, i) => {
    const openEpoch = 1_000_000 + i * 86_400;
    return {
      day: i + 1,
      sessionIndex: 10 + i,
      sessionDate: `2026-03-${String(10 + i).padStart(2, '0')}`,
      sessionOpenEpoch: openEpoch,
      sessionCloseEpoch: openEpoch + 6.5 * 3600,
      high: i === 0 && !day1Known ? null : high,
      highKnown: i === 0 ? day1Known : true,
      source: 'daily_bar',
      precision: 'daily_bar',
      sessionCompleted: i < completedThrough,
      requiresEntryAdjustment: false,
      possibleX: i === 0 ? day1PossibleX : false
    };
  });
}

const SESSION_BOUNDS = (date) => ({ date, openEpoch: 1_000_000, closeEpoch: 1_000_000 + 6.5 * 3600 });

describe('managementDayForSession', () => {
  it('counts Day 1 as the actual entry session', () => {
    expect(managementDayForSession(0, 0)).toBe(1);
    expect(managementDayForSession(2, 2)).toBe(1);
  });
  it('counts subsequent sessions as Day 2, Day 3, ...', () => {
    expect(managementDayForSession(0, 1)).toBe(2);
    expect(managementDayForSession(0, 4)).toBe(5);
  });
  it('returns null before entry', () => {
    expect(managementDayForSession(2, 1)).toBeNull();
  });
});

describe('buildDayEvidence', () => {
  it('maps adjacent daily bars to management days (weekends never counted)', () => {
    const bars = [
      { date: '2026-03-05', high: 101 },
      { date: '2026-03-06', high: 102 },
      { date: '2026-03-09', high: 103 }, // weekend skipped: next session is Monday
      { date: '2026-03-10', high: 104 }
    ];
    const evidence = buildDayEvidence({
      bars,
      entryIndex: 1,
      latestDay: 3,
      isSessionCompleted: () => true,
      sessionBoundsForDate: SESSION_BOUNDS
    });
    expect(evidence.map((d) => d.day)).toEqual([1, 2, 3]);
    expect(evidence.map((d) => d.sessionDate)).toEqual(['2026-03-06', '2026-03-09', '2026-03-10']);
    expect(evidence[0].requiresEntryAdjustment).toBe(true);
    expect(evidence[1].requiresEntryAdjustment).toBe(false);
    expect(evidence[0].sessionOpenEpoch).toBe(1_000_000);
    expect(evidence[0].sessionCloseEpoch).toBe(1_000_000 + 6.5 * 3600);
  });
});

describe('resolvePartialTrigger — cumulative MFE and trigger sessions', () => {
  it('never resets: cumulative MFE is the running highest high', () => {
    const result = resolvePartialTrigger({
      dayEvidence: days([102, 108, 101, 109, 109]),
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.mfeByDay.map((d) => d.mfeR)).toEqual([0.4, 1.6, 1.6, 1.8, 1.8]);
  });

  it('+1R before Day 3 -> partial due Day 3', () => {
    const result = resolvePartialTrigger({
      dayEvidence: days([106, 104, 103, 103, 103]),
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.status).toBe('triggered');
    expect(result.firstReachDay).toBe(1);
    expect(result.reachedEarly).toBe(true);
    expect(result.dueDay).toBe(3);
  });

  it('+1R first reached Day 4 -> due Day 4', () => {
    const result = resolvePartialTrigger({
      dayEvidence: days([101, 101, 101, 106, 106]),
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.firstReachDay).toBe(4);
    expect(result.dueDay).toBe(4);
    expect(result.status).toBe('triggered');
  });

  it('+1R first reached Day 6 -> no canonical partial trigger', () => {
    const result = resolvePartialTrigger({
      dayEvidence: days([101, 101, 101, 101, 101, 106], { completedThrough: 6 }),
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.status).toBe('never_reached');
    expect(result.triggered).toBe(false);
  });

  it('never reaches +1R through Day 5 -> never_reached only once the horizon completed', () => {
    const result = resolvePartialTrigger({
      dayEvidence: days([101, 101, 101, 101, 101]),
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.status).toBe('never_reached');
    expect(result.horizonComplete).toBe(true);
  });
});

describe('resolvePartialTrigger — observation maturity (F3)', () => {
  it('is pending, not never_reached, before the window elapses', () => {
    const result = resolvePartialTrigger({
      dayEvidence: days([101, 101], { completedThrough: 2 }),
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.status).toBe('pending');
    expect(result.horizonComplete).toBe(false);
  });

  it('is pending, not late, when early +1R means due Day 3 but Day 3 has not completed', () => {
    const result = resolvePartialTrigger({
      dayEvidence: days([106, 104], { completedThrough: 2 }),
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.status).toBe('pending');
    expect(result.dueDay).toBe(3);
    expect(result.dueSessionCompleted).toBe(false);
  });

  it('is insufficient_evidence when Day 1 post-entry evidence is unavailable and the first confirmed crossing is late', () => {
    const evidence = days([101, 101, 101, 106, 106], { day1Known: false, day1PossibleX: true });
    const result = resolvePartialTrigger({
      dayEvidence: evidence,
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.status).toBe('insufficient_evidence');
    expect(result.reason).toBe('day1_post_entry_evidence_unavailable');
  });

  it('remains triggered when an unknown Day-1 high first confirms +1R on earliest_day (no ambiguity)', () => {
    // Day 3 is earliest_day: whether or not Day 1 crossed, the partial is due Day 3.
    const evidence = days([101, 101, 106, 106, 106], { day1Known: false, day1PossibleX: true });
    const result = resolvePartialTrigger({
      dayEvidence: evidence,
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.status).toBe('triggered');
    expect(result.firstReachDay).toBe(3);
    expect(result.dueDay).toBe(3);
  });

  it('treats Day 1 as unable-to-cross when the daily upper bound is below +1R', () => {
    const evidence = days([101, 101, 106, 106, 106], { day1Known: false, day1PossibleX: false });
    const result = resolvePartialTrigger({
      dayEvidence: evidence,
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.status).toBe('triggered');
    expect(result.firstReachDay).toBe(3);
  });
});

describe('findCrossingInSession', () => {
  const bars = [
    { time: 1000, high: 101 },
    { time: 1060, high: 104 },
    { time: 1120, high: 106 },
    { time: 1180, high: 108 }
  ];

  it('returns the first bar whose high crosses the threshold as an INTERVAL, not an exact instant', () => {
    const result = findCrossingInSession({
      bars,
      priorHighest: 101,
      thresholdPrice: 105,
      entryEpoch: null,
      sessionOpenEpoch: 1000,
      sessionCloseEpoch: 2000,
      observations: []
    });
    expect(result.crossed).toBe(true);
    expect(result.crossingEpoch).toBeNull();
    expect(result.crossingStartEpoch).toBe(1120);
    expect(result.crossingEndEpoch).toBe(1180);
    expect(result.precision).toBe('1min_bar');
  });

  it('excludes bars before the entry (Day 1 point-in-time)', () => {
    const result = findCrossingInSession({
      bars,
      priorHighest: -Infinity,
      thresholdPrice: 105,
      entryEpoch: 1120,
      sessionOpenEpoch: 1000,
      sessionCloseEpoch: 2000,
      observations: []
    });
    expect(result.crossed).toBe(true);
    expect(result.crossingStartEpoch).toBe(1120);
    expect(result.crossingEndEpoch).toBe(1180);
  });

  it('uses an observed execution print as an exact crossing instant', () => {
    const result = findCrossingInSession({
      bars,
      priorHighest: -Infinity,
      thresholdPrice: 103,
      entryEpoch: null,
      sessionOpenEpoch: 1000,
      sessionCloseEpoch: 2000,
      observations: [{ epoch: 1030, price: 103.5 }]
    });
    expect(result.crossed).toBe(true);
    expect(result.precision).toBe('execution_print');
    expect(result.crossingEpoch).toBe(1030);
    expect(result.crossingStartEpoch).toBeNull();
  });

  it('never uses an observation outside the regular session or before the entry', () => {
    // A pre-session print that crosses and a previous-day entry print must not
    // establish the crossing; only the in-session bar may.
    const result = findCrossingInSession({
      bars,
      priorHighest: -Infinity,
      thresholdPrice: 103,
      entryEpoch: 1060,
      sessionOpenEpoch: 1000,
      sessionCloseEpoch: 2000,
      observations: [
        { epoch: 500, price: 200 },   // before session open
        { epoch: 1030, price: 200 },  // within session but before entry
        { epoch: 1050, price: 200 }   // before entry
      ]
    });
    expect(result.crossed).toBe(true);
    // Falls back to the first in-session bar at/after the entry (as an interval).
    expect(result.precision).toBe('1min_bar');
    expect(result.crossingStartEpoch).toBe(1060);
  });

  it('does not cross when nothing reaches the threshold', () => {
    const result = findCrossingInSession({
      bars,
      priorHighest: 101,
      thresholdPrice: 200,
      entryEpoch: null,
      sessionOpenEpoch: 1000,
      sessionCloseEpoch: 2000,
      observations: []
    });
    expect(result.crossed).toBe(false);
  });
});

describe('resolvePartialTrigger — authoritative boundary (F1)', () => {
  it('+1R before Day 3 sets the boundary to the Day-3 regular-session OPEN', () => {
    const evidence = days([106, 104, 103, 103, 103]);
    const result = resolvePartialTrigger({
      dayEvidence: evidence,
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.reachedEarly).toBe(true);
    expect(result.boundary.kind).toBe('session_open');
    expect(result.boundary.mode).toBe('instant');
    expect(result.boundary.sessionDate).toBe(evidence[2].sessionDate);
    expect(result.boundary.epoch).toBe(evidence[2].sessionOpenEpoch);
    expect(result.boundary.precision).toBe('session_open');
    expect(result.boundary.orderingKnown).toBe(true);
  });

  it('a same-or-later first reach sets an ordering-unknown crossing boundary until resolved', () => {
    const evidence = days([101, 101, 101, 106, 106]);
    const result = resolvePartialTrigger({
      dayEvidence: evidence,
      entryBasis: ENTRY_BASIS,
      rPerShare: R_PER_SHARE,
      parameters: PARAMS
    });
    expect(result.firstReachDay).toBe(4);
    expect(result.boundary.kind).toBe('crossing');
    expect(result.boundary.mode).toBe('instant');
    expect(result.boundary.sessionDate).toBe(evidence[3].sessionDate);
    expect(result.boundary.epoch).toBeNull();
    expect(result.boundary.orderingKnown).toBe(false);
  });
});
