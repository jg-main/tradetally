'use strict';

// HTTP controller for Phase 5 (Version / Evaluation History):
//   GET    /api/quality-profiles/:profileId/versions
//   GET    /api/trades/:tradeId/quality/evaluations
//   POST   /api/trades/:tradeId/quality/evaluations        (start reevaluation)
//   PUT    /api/trades/:tradeId/quality/evaluations/:evaluationId/primary
//   DELETE /api/trades/:tradeId/quality/evaluations/primary
//   GET    /api/trades/:tradeId/quality/evaluations/compare?left=&right=
//
// All endpoints require an authenticated user. Ownership of the trade,
// evaluation and profile/version is enforced inside the generic history and
// comparison services (a user can never observe or act on another user's
// data through these routes).

const historyService = require('../services/quality/historyService');
const comparisonService = require('../services/quality/comparisonService');
const profileService = require('../services/quality/profileService');

const NOT_FOUND_CODES = [
  'TRADE_NOT_FOUND',
  'EVALUATION_NOT_FOUND',
  'VERSION_NOT_FOUND',
  'PROFILE_NOT_FOUND'
];

const CONFLICT_CODES = ['EVALUATION_NOT_TERMINAL'];

function respondError(res, error) {
  if (error instanceof historyService.QualityHistoryInputError) {
    const status = CONFLICT_CODES.includes(error.code)
      ? 409
      : NOT_FOUND_CODES.includes(error.code)
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

const qualityHistoryController = {
  async listVersions(req, res, next) {
    try {
      const { profileId } = req.params;
      const versions = await profileService.listVersions(profileId, req.user.id);
      if (versions.length === 0) {
        // Distinguish "profile missing / not owned" from "profile with no
        // versions" without leaking anything about other users' profiles:
        // both are an empty list to an unauthorized caller.
        return res.json({ versions: [] });
      }
      return res.json({ versions });
    } catch (error) {
      next(error);
    }
  },

  async listEvaluations(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const evaluations = await historyService.listEvaluationsForTrade(req.user.id, tradeId);
      return res.json({ evaluations });
    } catch (error) {
      return respondError(res, error);
    }
  },

  async startEvaluation(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const body = req.body || {};
      const profileVersionId = body.profileVersionId ? String(body.profileVersionId) : undefined;
      const evaluation = await historyService.startEvaluation(
        req.user.id,
        tradeId,
        profileVersionId
      );
      return res.status(201).json({ evaluation });
    } catch (error) {
      return respondError(res, error);
    }
  },

  async selectPrimary(req, res, next) {
    try {
      const { id: tradeId, evaluationId } = req.params;
      const primary = await historyService.selectPrimary(req.user.id, tradeId, evaluationId);
      return res.json({ primary });
    } catch (error) {
      return respondError(res, error);
    }
  },

  async clearPrimary(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const cleared = await historyService.clearPrimary(req.user.id, tradeId);
      return res.json({ cleared });
    } catch (error) {
      return respondError(res, error);
    }
  },

  async compareEvaluations(req, res, next) {
    try {
      const { id: tradeId } = req.params;
      const left = req.query.left ? String(req.query.left) : undefined;
      const right = req.query.right ? String(req.query.right) : undefined;
      const comparison = await comparisonService.compareEvaluations(
        req.user.id,
        tradeId,
        left,
        right
      );
      return res.json({ comparison });
    } catch (error) {
      return respondError(res, error);
    }
  }
};

module.exports = qualityHistoryController;
