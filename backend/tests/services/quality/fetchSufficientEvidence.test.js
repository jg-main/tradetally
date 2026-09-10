'use strict';

const { getCanonicalBOConfig } = require('../../../src/services/quality/canonicalBO');
const {
  fetchSufficientDailyEvidence,
  requiredHistorySessions,
  MAX_FETCH_EXPANSIONS
} = require('../../../src/services/quality/setupQualityService');
const { buildBars, candle, addDays } = require('./barFactory');

const SETUP_DIM = getCanonicalBOConfig().dimensions.setup;
const ENTRY_DATE = '2026-12-31'; // far after every synthetic series -> all bars pre-entry

function sessionsBefore(bars, entryDate) {
  return bars.filter((bar) => bar.date < entryDate).length;
}

function barsFrom(fromDate, count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) rows.push(candle(100));
  return buildBars(fromDate, rows);
}

function verifiedEvidence(fromDate, count) {
  return {
    bars: barsFrom(fromDate, count),
    source: 'finnhub',
    completeness: 'verified',
    error: null
  };
}

describe('fetchSufficientDailyEvidence (calendar fetch sizing + expansion)', () => {
  test('a narrow first window is expanded until the profile-derived session requirement is met', async () => {
    const required = requiredHistorySessions(SETUP_DIM);
    const calls = [];
    const loader = async ({ fromDate }) => {
      calls.push(fromDate);
      // First (narrow) attempt: earliest bar sits exactly at the requested left
      // boundary and supplies too few sessions. Expanded attempts supply enough.
      if (calls.length === 1) return verifiedEvidence(fromDate, 20);
      return verifiedEvidence(fromDate, required + 40);
    };

    const result = await fetchSufficientDailyEvidence({
      symbol: 'TEST',
      userId: 'u1',
      entryDate: ENTRY_DATE,
      setupConfig: SETUP_DIM,
      loader
    });

    expect(calls).toHaveLength(2);
    expect(calls[1] < calls[0]).toBe(true);
    expect(result.expansions).toBe(1);
    expect(sessionsBefore(result.result.bars, ENTRY_DATE)).toBeGreaterThanOrEqual(required);
    expect(result.result.completeness).toBe('verified');
  });

  test('large configured lookbacks obtain at least the requested available sessions', async () => {
    const clone = () => JSON.parse(JSON.stringify(getCanonicalBOConfig()));
    const big = clone();
    big.dimensions.setup.criteria.find((c) => c.key === 'base_duration').parameters.detection_lookback = 500;
    big.dimensions.setup.criteria.find((c) => c.key === 'prior_move').parameters.search_lookback = 500;
    const bigDim = big.dimensions.setup;
    const required = requiredHistorySessions(bigDim);
    expect(required).toBeGreaterThan(1000);

    const calls = [];
    const loader = async ({ fromDate }) => {
      calls.push(fromDate);
      const supply = calls.length === 1 ? required - 50 : required + 100;
      return verifiedEvidence(fromDate, supply);
    };

    const result = await fetchSufficientDailyEvidence({
      symbol: 'TEST',
      userId: 'u1',
      entryDate: ENTRY_DATE,
      setupConfig: bigDim,
      loader
    });
    expect(result.expansions).toBe(1);
    expect(sessionsBefore(result.result.bars, ENTRY_DATE)).toBeGreaterThanOrEqual(required);
  });

  test('genuinely insufficient symbol history terminates safely without retry', async () => {
    const calls = [];
    const loader = async ({ fromDate }) => {
      calls.push(fromDate);
      // Provider history genuinely begins well after the requested window.
      const realStart = addDays(fromDate, 60);
      return { bars: barsFrom(realStart, 15), source: 'finnhub', completeness: 'verified', error: null };
    };

    const result = await fetchSufficientDailyEvidence({
      symbol: 'TEST',
      userId: 'u1',
      entryDate: ENTRY_DATE,
      setupConfig: SETUP_DIM,
      loader
    });
    expect(calls).toHaveLength(1);
    expect(result.expansions).toBe(0);
    expect(result.result.bars).toHaveLength(15);
    // Downstream criteria see a short but real history -> UNKNOWN, no crash.
  });

  test('a provider that always hits the requested boundary cannot cause infinite retries', async () => {
    const calls = [];
    const loader = async ({ fromDate }) => {
      calls.push(fromDate);
      return verifiedEvidence(fromDate, 20); // always narrow + boundary-hit
    };

    const result = await fetchSufficientDailyEvidence({
      symbol: 'TEST',
      userId: 'u1',
      entryDate: ENTRY_DATE,
      setupConfig: SETUP_DIM,
      loader
    });
    expect(calls).toHaveLength(MAX_FETCH_EXPANSIONS + 1);
    expect(result.expansions).toBe(MAX_FETCH_EXPANSIONS);
    expect(result.result.bars).toHaveLength(20);
  });

  test('unverified evidence is returned as-is (caller handles unverified)', async () => {
    const calls = [];
    const loader = async ({ fromDate }) => {
      calls.push(fromDate);
      return { bars: barsFrom(fromDate, 20), source: 'historical_cache', completeness: 'unverified', error: 'x' };
    };
    const result = await fetchSufficientDailyEvidence({
      symbol: 'TEST',
      userId: 'u1',
      entryDate: ENTRY_DATE,
      setupConfig: SETUP_DIM,
      loader
    });
    expect(calls).toHaveLength(1);
    expect(result.result.completeness).toBe('unverified');
  });

  test('Canonical BO remains efficient: a sufficient first window is not expanded', async () => {
    const calls = [];
    const loader = async ({ fromDate }) => {
      calls.push(fromDate);
      return verifiedEvidence(fromDate, 200);
    };
    const result = await fetchSufficientDailyEvidence({
      symbol: 'TEST',
      userId: 'u1',
      entryDate: ENTRY_DATE,
      setupConfig: SETUP_DIM,
      loader
    });
    expect(calls).toHaveLength(1);
    expect(result.expansions).toBe(0);
  });
});
