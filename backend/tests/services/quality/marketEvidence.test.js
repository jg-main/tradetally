'use strict';

jest.mock('../../../src/config/database', () => ({ query: jest.fn() }));
jest.mock('../../../src/utils/finnhub', () => ({
  isConfigured: jest.fn(),
  getStockCandles: jest.fn(),
  providerName: 'finnhub'
}));
jest.mock('../../../src/utils/historicalPriceCache', () => ({
  getRange: jest.fn(),
  hasRange: jest.fn(),
  insertCandles: jest.fn()
}));
jest.mock('../../../src/utils/yahooFinance', () => ({
  isEnabled: jest.fn(),
  getCandlesInWindow: jest.fn()
}));
jest.mock('../../../src/utils/alphaVantage', () => ({
  isConfigured: jest.fn(),
  getDailyData: jest.fn()
}));

const marketData = require('../../../src/utils/finnhub');
const historicalPriceCache = require('../../../src/utils/historicalPriceCache');
const yahooFinance = require('../../../src/utils/yahooFinance');
const alphaVantage = require('../../../src/utils/alphaVantage');
const { loadDailyEvidence, supplementProviderSessions } = require('../../../src/services/quality/marketEvidenceService');

function cacheRow(date, close, volume = 1000) {
  return { time: Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000), open: close - 1, high: close + 1, low: close - 2, close, volume };
}

function rawCandle(date, close, volume = 1000) {
  return { time: Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000), open: close - 1, high: close + 1, low: close - 2, close, volume };
}

beforeEach(() => {
  marketData.isConfigured.mockReset().mockReturnValue(false);
  marketData.getStockCandles.mockReset();
  historicalPriceCache.getRange.mockReset();
  historicalPriceCache.hasRange.mockReset();
  historicalPriceCache.insertCandles.mockReset();
  yahooFinance.isEnabled.mockReset().mockReturnValue(false);
  yahooFinance.getCandlesInWindow.mockReset();
  alphaVantage.isConfigured.mockReset().mockReturnValue(false);
  alphaVantage.getDailyData.mockReset();
});

describe('marketEvidenceService.loadDailyEvidence (hardened)', () => {
  test('never treats a 50%-complete cache as verified Quality evidence', async () => {
    // Cache holds only every other weekday (50% coverage). hasRange() would
    // have returned true, but the Quality path must not accept it as
    // authoritative. With a provider available, the provider session set wins.
    historicalPriceCache.getRange.mockResolvedValue([
      cacheRow('2026-01-02', 10),
      cacheRow('2026-01-06', 11),
      cacheRow('2026-01-08', 12)
    ]);
    marketData.isConfigured.mockReturnValue(true);
    marketData.getStockCandles.mockResolvedValue([
      rawCandle('2026-01-02', 10),
      rawCandle('2026-01-05', 10.5),
      rawCandle('2026-01-06', 11),
      rawCandle('2026-01-07', 11.5),
      rawCandle('2026-01-08', 12),
      rawCandle('2026-01-09', 12.5)
    ]);

    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.completeness).toBe('verified');
    expect(result.source).toBe('finnhub');
    // Provider sessions are authoritative and the cache is not consulted for
    // completeness (hasRange must never gate Quality evidence).
    expect(result.bars.map((bar) => bar.date)).toEqual(
      ['2026-01-02', '2026-01-05', '2026-01-06', '2026-01-07', '2026-01-08', '2026-01-09']
    );
    expect(historicalPriceCache.hasRange).not.toHaveBeenCalled();
  });

  test('a missing entry-session cache bar triggers provider completion, not an unavailable result', async () => {
    // Cache is missing 2026-01-05 (the entry session).
    historicalPriceCache.getRange.mockResolvedValue([
      cacheRow('2026-01-02', 10),
      cacheRow('2026-01-06', 11)
    ]);
    marketData.isConfigured.mockReturnValue(true);
    marketData.getStockCandles.mockResolvedValue([
      rawCandle('2026-01-02', 10),
      rawCandle('2026-01-05', 10.5),
      rawCandle('2026-01-06', 11)
    ]);

    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.completeness).toBe('verified');
    expect(result.bars.some((bar) => bar.date === '2026-01-05')).toBe(true);
    expect(result.error).toBeNull();
  });

  test('missing volume stays missing (null) and is never persisted as zero', async () => {
    historicalPriceCache.getRange.mockResolvedValue([]);
    marketData.isConfigured.mockReturnValue(true);
    marketData.getStockCandles.mockResolvedValue([
      rawCandle('2026-01-05', 10, null), // provider session without volume
      rawCandle('2026-01-06', 11, 5000)
    ]);

    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.completeness).toBe('verified');
    const missing = result.bars.find((bar) => bar.date === '2026-01-05');
    expect(missing.volume).toBeNull();
    // The null-volume session must not be written to the shared cache as 0.
    expect(historicalPriceCache.insertCandles).toHaveBeenCalledWith(
      'TEST',
      expect.arrayContaining([expect.not.objectContaining({ date: '2026-01-05' })]),
      'finnhub'
    );
    const inserted = historicalPriceCache.insertCandles.mock.calls[0][1];
    expect(inserted.some((bar) => bar.date === '2026-01-05')).toBe(false);
    expect(inserted.some((bar) => bar.date === '2026-01-06')).toBe(true);
  });

  test('repeated cache reads cannot turn UNKNOWN volume into a zero-volume PASS', async () => {
    // First run: provider returns a null-volume session (verified, UNKNOWN for
    // the volume criterion).
    marketData.isConfigured.mockReturnValue(true);
    historicalPriceCache.getRange.mockResolvedValueOnce([]);
    marketData.getStockCandles.mockResolvedValueOnce([
      rawCandle('2026-01-05', 10, null),
      rawCandle('2026-01-06', 11, 2000)
    ]);
    const first = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(first.bars[0].volume).toBeNull();

    // Second run: provider unavailable; a cache row that would have coerced the
    // missing volume to 0 must still surface as missing volume (null), so the
    // volume criterion stays UNKNOWN instead of seeing 0 volume.
    marketData.isConfigured.mockReturnValue(false);
    historicalPriceCache.getRange.mockResolvedValueOnce([
      cacheRow('2026-01-05', 10, 0), // shared cache coercion artifact
      cacheRow('2026-01-06', 11, 2000)
    ]);
    const second = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(second.completeness).toBe('unverified');
    const cachedMissing = second.bars.find((bar) => bar.date === '2026-01-05');
    expect(cachedMissing.volume).toBeNull();
  });

  test('a cache Sunday / cache-only date never enters a verified provider session set', async () => {
    // 2026-01-04 is a Sunday. The provider correctly omits it; the cache must
    // not be able to inject it into verified evidence.
    historicalPriceCache.getRange.mockResolvedValue([cacheRow('2026-01-04', 999)]);
    marketData.isConfigured.mockReturnValue(true);
    marketData.getStockCandles.mockResolvedValue([
      rawCandle('2026-01-05', 10),
      rawCandle('2026-01-06', 11)
    ]);

    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.completeness).toBe('verified');
    expect(result.bars.map((bar) => bar.date)).toEqual(['2026-01-05', '2026-01-06']);
  });

  test('a stale cache-only weekday never enters the provider session set', async () => {
    // 2026-01-02 is a weekday the provider does not return for this symbol.
    historicalPriceCache.getRange.mockResolvedValue([cacheRow('2026-01-02', 500)]);
    marketData.isConfigured.mockReturnValue(true);
    marketData.getStockCandles.mockResolvedValue([
      rawCandle('2026-01-05', 10),
      rawCandle('2026-01-06', 11)
    ]);

    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.completeness).toBe('verified');
    expect(result.bars.map((bar) => bar.date)).toEqual(['2026-01-05', '2026-01-06']);
  });

  test('provider wins conflicts and only supplements the same provider-confirmed session', () => {
    const provider = [
      { date: '2026-01-05', open: 9, high: 11, low: 8, close: 10, volume: null },
      { date: '2026-01-06', open: 10, high: 12, low: 9, close: 11, volume: 100 }
    ];
    const cache = [
      { date: '2026-01-04', open: 1, high: 1, low: 1, close: 1, volume: 9 }, // extra date: ignored
      { date: '2026-01-05', open: 99, high: 99, low: 99, close: 99, volume: 5000 } // same date: volume supplement only
    ];
    const merged = supplementProviderSessions(provider, cache);
    expect(merged).toHaveLength(2); // never two sessions for one date
    expect(merged.map((bar) => bar.date)).toEqual(['2026-01-05', '2026-01-06']);
    // Provider OHLC wins; provider-null volume is safely supplemented from the
    // same provider-confirmed session.
    expect(merged[0].open).toBe(9);
    expect(merged[0].volume).toBe(5000);
    expect(merged[1].volume).toBe(100);
  });

  test('an extra cache-only date cannot change session-count-sensitive evidence', async () => {
    const providerCandles = [
      rawCandle('2026-01-05', 10),
      rawCandle('2026-01-06', 11),
      rawCandle('2026-01-07', 12)
    ];
    marketData.isConfigured.mockReturnValue(true);
    marketData.getStockCandles.mockResolvedValue(providerCandles);

    // Without cache extras.
    historicalPriceCache.getRange.mockResolvedValueOnce([]);
    const clean = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    // With cache-only extra dates (including a Sunday with otherwise valid OHLCV).
    historicalPriceCache.getRange.mockResolvedValueOnce([
      cacheRow('2026-01-04', 10),
      cacheRow('2026-01-08', 11)
    ]);
    const withExtras = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });

    expect(withExtras.bars).toEqual(clean.bars);
    expect(withExtras.bars).toHaveLength(3);
  });

  test('uses Yahoo Finance and Alpha Vantage as fallbacks when the provider is unavailable', async () => {
    historicalPriceCache.getRange.mockResolvedValue([]);
    marketData.isConfigured.mockReturnValue(true);
    marketData.getStockCandles.mockRejectedValue(new Error('provider down'));
    yahooFinance.isEnabled.mockReturnValue(true);
    yahooFinance.getCandlesInWindow.mockResolvedValue([rawCandle('2026-01-05', 10)]);
    const yahooResult = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(yahooResult.source).toBe('yahoo');
    expect(yahooResult.completeness).toBe('verified');

    yahooFinance.isEnabled.mockReturnValue(true);
    yahooFinance.getCandlesInWindow.mockRejectedValue(new Error('yahoo down'));
    alphaVantage.isConfigured.mockReturnValue(true);
    alphaVantage.getDailyData.mockResolvedValue([
      rawCandle('2026-01-05', 10),
      rawCandle('2020-01-01', 1) // outside requested window -> filtered
    ]);
    const alphaResult = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(alphaResult.source).toBe('alphavantage');
    expect(alphaResult.bars).toHaveLength(1);
  });

  test('reports unavailable evidence when every source fails', async () => {
    historicalPriceCache.getRange.mockResolvedValue([]);
    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.bars).toEqual([]);
    expect(result.completeness).toBe('unverified');
    expect(result.error).toContain('No daily market data available');
  });
});
