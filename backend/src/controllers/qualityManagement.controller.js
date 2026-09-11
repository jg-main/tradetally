'use strict';

// HTTP controller for the Management Quality workflow (Phase 4):
//   POST /api/trades/:tradeId/quality/management/prepare
//   POST /api/trades/:tradeId/quality/management/evaluate
//   POST /api/trades/:tradeId/quality/finalize
//
// All endpoints require an authenticated user. Ownership of the trade,
// evaluation and profile version is enforced inside the Management Quality
// service.

const ManagementQualityService = require('../services/quality/managementQualityService');

function respondError(res, error) {
  if (error instanceof ManagementQualityService.ManagementQualityInputError) {
    const notFoundCodes = ['TRADE_NOT_FOUND', 'EVALUATION_NOT_FOUND', 'VERSION_NOT_FOUND'];
    const conflictCodes = [
      'EVALUATION_TERMINAL',
      'MANAGEMENT_ENTRY_REQUIRED',
      'MANAGEMENT_ENTRY_INCOMPLETE',
      'MANAGEMENT_INCOMPLETE',
      'TRAILING_MA_IMMUTABLE',
      'STALE_DEPENDENCY',
      'STALE_ENTRY_DEPENDENCY'
    ];
    const status = conflictCodes.includes(error.code)
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

const qualityManagementController = {
  async prepareManagementQuality(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const body = req.body || {};
      const evaluationId = body.evaluationId ? String(body.evaluationId) : undefined;
      const payload = await ManagementQualityService.prepare(req.user.id, tradeId, { evaluationId });
      return res.json({ ...payload });
    } catch (error) {
      if (error instanceof ManagementQualityService.ManagementQualityInputError) {
        return respondError(res, error);
      }
      next(error);
    }
  },

  async evaluateManagementQuality(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const body = req.body || {};
      const evaluationId = body.evaluationId ? String(body.evaluationId) : undefined;
      const userInputs = body.userInputs;
      const payload = await ManagementQualityService.evaluate(req.user.id, tradeId, {
        evaluationId,
        userInputs
      });
      return res.json({ ...payload });
    } catch (error) {
      if (error instanceof ManagementQualityService.ManagementQualityInputError) {
        return respondError(res, error);
      }
      next(error);
    }
  },

  async finalizeEvaluation(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const body = req.body || {};
      const evaluationId = body.evaluationId ? String(body.evaluationId) : undefined;
      const payload = await ManagementQualityService.finalize(req.user.id, tradeId, { evaluationId });
      return res.json({ ...payload });
    } catch (error) {
      if (error instanceof ManagementQualityService.ManagementQualityInputError) {
        return respondError(res, error);
      }
      next(error);
    }
  }
};

module.exports = qualityManagementController;
