'use strict';

jest.mock('../../src/services/quality/entryQualityService', () => {
  const actual = jest.requireActual('../../src/services/quality/entryQualityService');
  return {
    ...actual,
    prepare: jest.fn(),
    evaluate: jest.fn()
  };
});

const EntryQualityService = require('../../src/services/quality/entryQualityService');
const controller = require('../../src/controllers/qualityEntry.controller');

function mockRes() {
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  return res;
}

function mockReq(overrides = {}) {
  return {
    params: { id: 'trade-1' },
    body: {},
    user: { id: 'user-1' },
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('qualityEntry.controller', () => {
  test('prepare forwards evaluationId and returns the payload', async () => {
    EntryQualityService.prepare.mockResolvedValue({ setupDependency: { ready: true } });
    const req = mockReq({ body: { evaluationId: 'eval-1' } });
    const res = mockRes();
    const next = jest.fn();

    await controller.prepareEntryQuality(req, res, next);
    expect(EntryQualityService.prepare).toHaveBeenCalledWith('user-1', 'trade-1', { evaluationId: 'eval-1' });
    expect(res.json).toHaveBeenCalledWith({ setupDependency: { ready: true } });
    expect(next).not.toHaveBeenCalled();
  });

  test('evaluate forwards only the semantic user inputs', async () => {
    EntryQualityService.evaluate.mockResolvedValue({ evaluation: { id: 'eval-1' } });
    const req = mockReq({ body: { evaluationId: 'eval-1', userInputs: { intended_trigger_type: 'BO-PIVOT' } } });
    const res = mockRes();
    const next = jest.fn();

    await controller.evaluateEntryQuality(req, res, next);
    expect(EntryQualityService.evaluate).toHaveBeenCalledWith('user-1', 'trade-1', {
      evaluationId: 'eval-1',
      userInputs: { intended_trigger_type: 'BO-PIVOT' }
    });
    expect(res.json).toHaveBeenCalledWith({ evaluation: { id: 'eval-1' } });
  });

  test('maps ENTRY_SETUP_REQUIRED and EVALUATION_TERMINAL to 409', async () => {
    EntryQualityService.prepare.mockRejectedValue(
      new EntryQualityService.EntryQualityInputError('need setup', 'ENTRY_SETUP_REQUIRED')
    );
    const res = mockRes();
    await controller.prepareEntryQuality(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);

    EntryQualityService.evaluate.mockRejectedValue(
      new EntryQualityService.EntryQualityInputError('terminal', 'EVALUATION_TERMINAL')
    );
    const res2 = mockRes();
    await controller.evaluateEntryQuality(mockReq({ body: { evaluationId: 'e' } }), res2, jest.fn());
    expect(res2.status).toHaveBeenCalledWith(409);
  });

  test('maps not-found errors to 404 and validation errors to 400', async () => {
    EntryQualityService.prepare.mockRejectedValue(
      new EntryQualityService.EntryQualityInputError('missing', 'EVALUATION_NOT_FOUND')
    );
    const res = mockRes();
    await controller.prepareEntryQuality(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);

    EntryQualityService.prepare.mockRejectedValue(
      new EntryQualityService.EntryQualityInputError('bad input', 'INVALID_TRIGGER_TYPE')
    );
    const res2 = mockRes();
    await controller.prepareEntryQuality(mockReq(), res2, jest.fn());
    expect(res2.status).toHaveBeenCalledWith(400);
  });
});
