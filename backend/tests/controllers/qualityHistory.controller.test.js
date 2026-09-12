'use strict';

jest.mock('../../src/services/quality/historyService', () => {
  const actual = jest.requireActual('../../src/services/quality/historyService');
  return {
    ...actual,
    listEvaluationsForTrade: jest.fn(),
    startEvaluation: jest.fn(),
    selectPrimary: jest.fn(),
    clearPrimary: jest.fn()
  };
});

jest.mock('../../src/services/quality/comparisonService', () => ({
  compareEvaluations: jest.fn()
}));

jest.mock('../../src/services/quality/profileService', () => {
  const actual = jest.requireActual('../../src/services/quality/profileService');
  return { ...actual, listVersions: jest.fn() };
});

jest.mock('../../src/services/quality/legacyCompatibilityService', () => ({
  resolveForTradeId: jest.fn()
}));

const historyService = require('../../src/services/quality/historyService');
const comparisonService = require('../../src/services/quality/comparisonService');
const profileService = require('../../src/services/quality/profileService');
const legacyCompatibilityService = require('../../src/services/quality/legacyCompatibilityService');
const controller = require('../../src/controllers/qualityHistory.controller');
const { QualityHistoryInputError } = jest.requireActual('../../src/services/quality/historyService');

function mockRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res;
}

function mockReq(overrides = {}) {
  return {
    params: { id: 'trade-1' },
    query: {},
    body: {},
    user: { id: 'user-1' },
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('qualityHistory.controller', () => {
  test('listEvaluations scopes to the authenticated user and trade', async () => {
    historyService.listEvaluationsForTrade.mockResolvedValue([{ id: 'eval-1' }]);
    const res = mockRes();

    await controller.listEvaluations(mockReq(), res, jest.fn());

    expect(historyService.listEvaluationsForTrade).toHaveBeenCalledWith('user-1', 'trade-1');
    expect(res.json).toHaveBeenCalledWith({ evaluations: [{ id: 'eval-1' }] });
  });

  test('startEvaluation creates a version-pinned evaluation', async () => {
    historyService.startEvaluation.mockResolvedValue({ id: 'eval-new', profile_version_id: 'v3' });
    const req = mockReq({ body: { profileVersionId: 'v3' } });
    const res = mockRes();

    await controller.startEvaluation(req, res, jest.fn());

    expect(historyService.startEvaluation).toHaveBeenCalledWith('user-1', 'trade-1', 'v3');
    expect(res.status).toHaveBeenCalledWith(201);
    expect(res.json).toHaveBeenCalledWith({ evaluation: { id: 'eval-new', profile_version_id: 'v3' } });
  });

  test('selectPrimary forwards the evaluation id from the route', async () => {
    historyService.selectPrimary.mockResolvedValue({ evaluation_id: 'eval-2' });
    legacyCompatibilityService.resolveForTradeId.mockResolvedValue({
      source: 'profile_primary',
      setup: { score: 72, grade: 'C', compliance: 'FAIL', coverage: 95, scoreScale: 100 }
    });
    const req = mockReq({ params: { id: 'trade-1', evaluationId: 'eval-2' } });
    const res = mockRes();

    await controller.selectPrimary(req, res, jest.fn());

    expect(historyService.selectPrimary).toHaveBeenCalledWith('user-1', 'trade-1', 'eval-2');
    expect(legacyCompatibilityService.resolveForTradeId).toHaveBeenCalledWith('user-1', 'trade-1');
    expect(res.json).toHaveBeenCalledWith({
      primary: { evaluation_id: 'eval-2' },
      qualitySummary: expect.objectContaining({ source: 'profile_primary' })
    });
  });

  test('clearPrimary returns the resolved compatibility summary', async () => {
    historyService.clearPrimary.mockResolvedValue({ trade_id: 'trade-1' });
    legacyCompatibilityService.resolveForTradeId.mockResolvedValue({
      source: 'legacy',
      setup: { grade: 'A', score: 4.5, compliance: null, coverage: 95, scoreScale: 5 }
    });
    const req = mockReq({ params: { id: 'trade-1' } });
    const res = mockRes();

    await controller.clearPrimary(req, res, jest.fn());

    expect(historyService.clearPrimary).toHaveBeenCalledWith('user-1', 'trade-1');
    expect(res.json).toHaveBeenCalledWith({
      cleared: { trade_id: 'trade-1' },
      qualitySummary: expect.objectContaining({ source: 'legacy' })
    });
  });

  test('selectPrimary still succeeds when the summary lookup fails', async () => {
    historyService.selectPrimary.mockResolvedValue({ evaluation_id: 'eval-2' });
    legacyCompatibilityService.resolveForTradeId.mockRejectedValue(new Error('db down'));
    const req = mockReq({ params: { id: 'trade-1', evaluationId: 'eval-2' } });
    const res = mockRes();

    await controller.selectPrimary(req, res, jest.fn());

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ primary: { evaluation_id: 'eval-2' }, qualitySummary: null });
  });

  test('compareEvaluations forwards left/right query ids', async () => {
    comparisonService.compareEvaluations.mockResolvedValue({ trade_id: 'trade-1' });
    const req = mockReq({ query: { left: 'a', right: 'b' } });
    const res = mockRes();

    await controller.compareEvaluations(req, res, jest.fn());

    expect(comparisonService.compareEvaluations).toHaveBeenCalledWith('user-1', 'trade-1', 'a', 'b');
    expect(res.json).toHaveBeenCalledWith({ comparison: { trade_id: 'trade-1' } });
  });

  test('listVersions returns an empty list for a profile the user does not own', async () => {
    profileService.listVersions.mockResolvedValue([]);
    const req = mockReq({ params: { profileId: 'p1' } });
    const res = mockRes();

    await controller.listVersions(req, res, jest.fn());

    expect(profileService.listVersions).toHaveBeenCalledWith('p1', 'user-1');
    expect(res.json).toHaveBeenCalledWith({ versions: [] });
  });

  test('maps a non-terminal primary selection to 409', async () => {
    historyService.selectPrimary.mockRejectedValue(
      new QualityHistoryInputError('only terminal', 'EVALUATION_NOT_TERMINAL')
    );
    const req = mockReq({ params: { id: 'trade-1', evaluationId: 'eval-1' } });
    const res = mockRes();

    await controller.selectPrimary(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'EVALUATION_NOT_TERMINAL' })
    );
  });

  test('maps a foreign trade to 404 without leaking details', async () => {
    historyService.selectPrimary.mockRejectedValue(
      new QualityHistoryInputError('Trade not found', 'TRADE_NOT_FOUND')
    );
    const req = mockReq({ params: { id: 'trade-x', evaluationId: 'eval-1' } });
    const res = mockRes();

    await controller.selectPrimary(req, res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(404);
  });
});
