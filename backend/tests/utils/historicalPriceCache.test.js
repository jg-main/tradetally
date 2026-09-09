'use strict';

jest.mock('../../src/config/database', () => ({ query: jest.fn() }));

const db = require('../../src/config/database');
const historicalPriceCache = require('../../src/utils/historicalPriceCache');

describe('historicalPriceCache.getRange', () => {
  beforeEach(() => jest.clearAllMocks());

  test('coerces NULL volume to 0 by default (legacy behavior unchanged)', async () => {
    db.query.mockResolvedValue({
      rows: [
        { price_date: '2026-01-05', open: '1', high: '2', low: '1', close: '1.5', volume: null }
      ]
    });
    const candles = await historicalPriceCache.getRange('TEST', '2026-01-01', '2026-01-31');
    expect(candles[0].volume).toBe(0);
  });

  test('preserves NULL volume when preserveNullVolume is set (Setup Quality path)', async () => {
    db.query.mockResolvedValue({
      rows: [
        { price_date: '2026-01-05', open: '1', high: '2', low: '1', close: '1.5', volume: null },
        { price_date: '2026-01-06', open: '1', high: '2', low: '1', close: '1.5', volume: '5000' }
      ]
    });
    const candles = await historicalPriceCache.getRange('TEST', '2026-01-01', '2026-01-31', {
      preserveNullVolume: true
    });
    expect(candles[0].volume).toBeNull();
    expect(candles[1].volume).toBe(5000);
  });
});
