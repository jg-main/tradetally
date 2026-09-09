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
const { loadDailyEvidence } = require('../../../src/services/quality/marketEvidenceService');

function rawCandle(date, close) {
  return { time: Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000), open: close - 1, high: close + 1, low: close - 2, close, volume: 1000 };
}

beforeEach(() => {
  jest.clearAllMocks();
  marketData.isConfigured.mockReturnValue(false);
  yahooFinance.isEnabled.mockReturnValue(false);
  alphaVantage.isConfigured.mockReturnValue(false);
});

describe('marketEvidenceService.loadDailyEvidence', () => {
  test('serves normalized bars from the historical cache when coverage exists', async () => {
    historicalPriceCache.getRange.mockResolvedValue([
      rawCandle('2026-01-05', 10),
      rawCandle('2026-01-02', 9),
      rawCandle('2026-01-02', 9) // duplicate session
    ]);
    historicalPriceCache.hasRange.mockResolvedValue(true);

    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.source).toBe('historical_cache');
    expect(result.error).toBeNull();
    expect(result.bars.map((bar) => bar.date)).toEqual(['2026-01-02', '2026-01-05']);
    expect(marketData.getStockCandles).not.toHaveBeenCalled();
  });

  test('falls back to the configured provider and persists to the cache', async () => {
    historicalPriceCache.getRange.mockResolvedValue([]);
    historicalPriceCache.hasRange.mockResolvedValue(false);
    marketData.isConfigured.mockReturnValue(true);
    marketData.getStockCandles.mockResolvedValue([rawCandle('2026-01-05', 10), rawCandle('2026-01-06', 11)]);
    historicalPriceCache.insertCandles.mockResolvedValue(undefined);

    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.source).toBe('finnhub');
    expect(result.bars).toHaveLength(2);
    expect(historicalPriceCache.insertCandles).toHaveBeenCalledWith('TEST', expect.any(Array), 'finnhub');
    expect(marketData.getStockCandles).toHaveBeenCalledWith('TEST', 'D', expect.any(Number), expect.any(Number), 'u1', { source: 'quality_setup' });
  });

  test('uses Yahoo Finance when the configured provider fails', async () => {
    historicalPriceCache.getRange.mockResolvedValue([]);
    historicalPriceCache.hasRange.mockResolvedValue(false);
    marketData.isConfigured.mockReturnValue(true);
    marketData.getStockCandles.mockRejectedValue(new Error('provider down'));
    yahooFinance.isEnabled.mockReturnValue(true);
    yahooFinance.getCandlesInWindow.mockResolvedValue([rawCandle('2026-01-05', 10)]);

    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.source).toBe('yahoo');
    expect(result.bars).toHaveLength(1);
  });

  test('uses Alpha Vantage as the last daily fallback', async () => {
    historicalPriceCache.getRange.mockResolvedValue([]);
    historicalPriceCache.hasRange.mockResolvedValue(false);
    marketData.isConfigured.mockReturnValue(false);
    yahooFinance.isEnabled.mockReturnValue(true);
    yahooFinance.getCandlesInWindow.mockRejectedValue(new Error('yahoo down'));
    alphaVantage.isConfigured.mockReturnValue(true);
    alphaVantage.getDailyData.mockResolvedValue([
      rawCandle('2026-01-05', 10),
      rawCandle('2020-01-01', 1) // outside requested window -> filtered
    ]);

    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.source).toBe('alphavantage');
    expect(result.bars).toHaveLength(1);
  });

  test('reports unavailable evidence (never fabricates) when every source fails', async () => {
    historicalPriceCache.getRange.mockResolvedValue([]);
    historicalPriceCache.hasRange.mockResolvedValue(false);

    const result = await loadDailyEvidence({ symbol: 'test', userId: 'u1', fromDate: '2026-01-01', toDate: '2026-01-31' });
    expect(result.bars).toEqual([]);
    expect(result.source).toBeNull();
    expect(result.error).toContain('No daily market data available');
  });
});
