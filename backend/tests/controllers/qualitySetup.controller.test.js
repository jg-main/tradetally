'use strict';

jest.mock('../../src/services/quality/setupQualityService', () => {
  const actualModule = jest.requireActual('../../src/services/quality/setupQualityService');
  return {
    ...actualModule,
    prepare: jest.fn(),
    evaluate: jest.fn(),
    listEvaluations: jest.fn()
  };
});

const SetupQualityService = require('../../src/services/quality/setupQualityService');
const controller = require('../../src/controllers/qualitySetup.controller');

const { SetupQualityInputError } = jest.requireActual('../../src/services/quality/setupQualityService');

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

describe('qualitySetup.controller', () => {
  test('prepare passes profileId and returns the payload', async () => {
    const payload = { evaluationId: 'eval-1', detectedBaseStart: null };
    SetupQualityService.prepare.mockResolvedValue(payload);
    const req = mockReq({ body: { profileId: 'profile-1' } });
    const res = mockRes();
    const next = jest.fn();

    await controller.prepareQualitySetup(req, res, next);
    expect(SetupQualityService.prepare).toHaveBeenCalledWith('user-1', 'trade-1', { profileId: 'profile-1' });
    expect(res.json).toHaveBeenCalledWith(payload);
    expect(next).not.toHaveBeenCalled();
  });

  test('evaluate forwards evaluationId + userInputs', async () => {
    const payload = { evaluation: { status: 'draft' } };
    SetupQualityService.evaluate.mockResolvedValue(payload);
    const userInputs = { leader_confirmed: true };
    const req = mockReq({ body: { evaluationId: 'eval-1', userInputs } });
    const res = mockRes();
    const next = jest.fn();

    await controller.evaluateQualitySetup(req, res, next);
    expect(SetupQualityService.evaluate).toHaveBeenCalledWith('user-1', 'trade-1', {
      evaluationId: 'eval-1',
      userInputs
    });
    expect(res.json).toHaveBeenCalledWith(payload);
  });

  test('lists evaluations', async () => {
    SetupQualityService.listEvaluations.mockResolvedValue([{ id: 'eval-1' }]);
    const req = mockReq();
    const res = mockRes();
    await controller.listQualityEvaluations(req, res);
    expect(res.json).toHaveBeenCalledWith({ evaluations: [{ id: 'eval-1' }] });
  });

  test('maps SetupQualityInputError codes to 404/409/400', async () => {
    SetupQualityService.prepare.mockRejectedValue(
      new SetupQualityInputError('no trade', 'TRADE_NOT_FOUND')
    );
    let res = mockRes();
    await controller.prepareQualitySetup(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'TRADE_NOT_FOUND' }));

    SetupQualityService.prepare.mockRejectedValue(
      new SetupQualityInputError('terminal', 'EVALUATION_TERMINAL')
    );
    res = mockRes();
    await controller.prepareQualitySetup(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(409);

    SetupQualityService.prepare.mockRejectedValue(
      new SetupQualityInputError('bad input', 'INVALID_INPUT', { field: 'base_start' })
    );
    res = mockRes();
    await controller.prepareQualitySetup(mockReq(), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ details: { field: 'base_start' } }));
  });

  test('unexpected errors are forwarded to the error middleware', async () => {
    SetupQualityService.evaluate.mockRejectedValue(new Error('boom'));
    const next = jest.fn();
    await controller.evaluateQualitySetup(mockReq({ body: {} }), mockRes(), next);
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'boom' }));
  });
});
