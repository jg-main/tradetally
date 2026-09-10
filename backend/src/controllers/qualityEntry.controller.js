'use strict';

// HTTP controller for the Entry Quality workflow (Phase 3):
//   POST /api/trades/:tradeId/quality/entry/prepare
//   POST /api/trades/:tradeId/quality/entry/evaluate
//
// All endpoints require an authenticated user. Ownership of the trade,
// evaluation and profile version is enforced inside the Entry Quality service
// (a user can never prepare or evaluate another user's trade/evaluation).
// Evaluation history is served by the existing Setup evaluations endpoint.

const EntryQualityService = require('../services/quality/entryQualityService');

function respondError(res, error) {
  if (error instanceof EntryQualityService.EntryQualityInputError) {
    const notFoundCodes = ['TRADE_NOT_FOUND', 'EVALUATION_NOT_FOUND', 'VERSION_NOT_FOUND'];
    const conflictCodes = [
      'EVALUATION_TERMINAL',
      'ENTRY_SETUP_REQUIRED',
      'INTENDED_TRIGGER_IMMUTABLE',
      'STALE_DEPENDENCY',
      'STALE_SETUP_CONTEXT'
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

const qualityEntryController = {
  async prepareEntryQuality(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const body = req.body || {};
      const evaluationId = body.evaluationId ? String(body.evaluationId) : undefined;
      const payload = await EntryQualityService.prepare(req.user.id, tradeId, { evaluationId });
      return res.json({ ...payload });
    } catch (error) {
      if (error instanceof EntryQualityService.EntryQualityInputError) {
        return respondError(res, error);
      }
      next(error);
    }
  },

  async evaluateEntryQuality(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const body = req.body || {};
      const evaluationId = body.evaluationId ? String(body.evaluationId) : undefined;
      const userInputs = body.userInputs;
      const payload = await EntryQualityService.evaluate(req.user.id, tradeId, {
        evaluationId,
        userInputs
      });
      return res.json({ ...payload });
    } catch (error) {
      if (error instanceof EntryQualityService.EntryQualityInputError) {
        return respondError(res, error);
      }
      next(error);
    }
  }
};

module.exports = qualityEntryController;
