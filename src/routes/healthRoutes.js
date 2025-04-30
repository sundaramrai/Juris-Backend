const express = require('express');
const router = express.Router();
const healthController = require('../controllers/healthController');
const { authenticate } = require('../middleware/auth');

router.get('/ping', healthController.getBasicHealth);
router.get('/status', healthController.getHealthCheck);
router.get('/metrics', authenticate, healthController.getSystemMetrics);
router.post('/adjust-rate-limits', authenticate, healthController.adjustRateLimits);

module.exports = router;
