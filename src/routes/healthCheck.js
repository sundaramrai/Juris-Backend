const express = require('express');
const router = express.Router();
const os = require('os');
const { errorHandler } = require('../middleware/errorHandler');
const lockManager = require('../utils/lockManager');
const dbManager = require('../utils/dbManager');
const { getServiceMetrics, checkGeminiApiStatus } = require('../services/aiService');

router.get('/', (req, res) => {
    res.status(200).json({
        status: 'up',
        timestamp: new Date().toISOString()
    });
});

router.get('/system', async (req, res) => {
    try {
        const aiStatus = await checkGeminiApiStatus();

        const systemInfo = {
            status: 'ok',
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            memory: {
                total: os.totalmem(),
                free: os.freemem(),
                used: os.totalmem() - os.freemem(),
                rss: process.memoryUsage().rss,
                heapTotal: process.memoryUsage().heapTotal,
                heapUsed: process.memoryUsage().heapUsed,
                external: process.memoryUsage().external
            },
            cpu: {
                model: os.cpus()[0].model,
                cores: os.cpus().length,
                loadAvg: os.loadavg(),
            },
            os: {
                platform: os.platform(),
                release: os.release(),
                hostname: os.hostname()
            },
            process: {
                pid: process.pid,
                versions: process.versions,
                env: process.env.NODE_ENV
            },
            aiService: {
                status: aiStatus ? 'up' : 'down',
                metrics: getServiceMetrics()
            },
            lockManager: lockManager.getMetrics()
        };

        try {
            systemInfo.database = dbManager.getConnectionStatus();
        } catch (err) {
            systemInfo.database = { status: 'error', message: err.message };
        }

        res.status(200).json(systemInfo);
    } catch (error) {
        console.error('Health check error:', error);
        res.status(500).json({
            status: 'error',
            message: error.message
        });
    }
});

router.get('/errors', (req, res) => {
    const isAdmin = req.query.key === process.env.ADMIN_API_KEY;
    const isDev = process.env.NODE_ENV !== 'production';

    if (!isDev && !isAdmin) {
        return res.status(403).json({ error: 'Unauthorized access' });
    }

    const limit = parseInt(req.query.limit) || 50;
    const errors = errorHandler.getRecentErrors(limit);

    res.status(200).json({
        count: errors.length,
        errors
    });
});

module.exports = router;
