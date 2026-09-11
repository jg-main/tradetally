const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');
const qualityHistoryController = require('../controllers/qualityHistory.controller');

// Quality Profiles — version metadata (Phase 5). Read-only list of the
// immutable versions of one profile owned by the authenticated user.
router.get('/:profileId/versions', authenticate, qualityHistoryController.listVersions);

module.exports = router;
