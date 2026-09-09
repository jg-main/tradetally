'use strict';

// HTTP controller for the Setup Quality workflow (Phase 2):
//   POST /api/trades/:tradeId/quality/prepare
//   POST /api/trades/:tradeId/quality/evaluate
//   GET  /api/trades/:tradeId/quality/evaluations
//
// All endpoints require an authenticated user and enforce trade/profile/
// evaluation ownership inside the Setup Quality service (a user can never
// prepare or evaluate another user's trade or profile version).

const SetupQualityService = require('../services/quality/setupQualityService');

function respondError(res, error) {
  if (error instanceof SetupQualityService.SetupQualityInputError) {
    const notFoundCodes = ['TRADE_NOT_FOUND', 'EVALUATION_NOT_FOUND', 'PROFILE_NOT_FOUND', 'VERSION_NOT_FOUND'];
    const status = error.code === 'EVALUATION_TERMINAL'
      ? 409
      : notFoundCodes.includes(error.code)
        ? 404
        : 400;
    return res.status(status).json({
      error: error.message,
      code: error.code,
      details: error.details || null
    });
  }
  return res.status(500).json({ error: error.message || 'Internal server error' });
}

const qualitySetupController = {
  async prepareQualitySetup(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const body = req.body || {};
      const profileId = body.profileId ? String(body.profileId) : undefined;
      // Forward confirmedBaseStart untouched; SetupQualityService validation is
      // authoritative (date/session/source checks happen server-side).
      const confirmedBaseStart =
        body.confirmedBaseStart && typeof body.confirmedBaseStart === 'object'
          ? {
              date: body.confirmedBaseStart.date,
              source: body.confirmedBaseStart.source
            }
          : undefined;
      const payload = await SetupQualityService.prepare(req.user.id, tradeId, {
        profileId,
        confirmedBaseStart
      });
      return res.json({ ...payload });
    } catch (error) {
      if (error instanceof SetupQualityService.SetupQualityInputError) {
        return respondError(res, error);
      }
      next(error);
    }
  },

  async evaluateQualitySetup(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const body = req.body || {};
      const evaluationId = body.evaluationId ? String(body.evaluationId) : undefined;
      const userInputs = body.userInputs;
      const payload = await SetupQualityService.evaluate(req.user.id, tradeId, {
        evaluationId,
        userInputs
      });
      return res.json({ ...payload });
    } catch (error) {
      if (error instanceof SetupQualityService.SetupQualityInputError) {
        return respondError(res, error);
      }
      next(error);
    }
  },

  async listQualityEvaluations(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const evaluations = await SetupQualityService.listEvaluations(req.user.id, tradeId);
      return res.json({ evaluations });
    } catch (error) {
      next(error);
    }
  }
};

module.exports = qualitySetupController;
