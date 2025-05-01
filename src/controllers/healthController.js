// src/controllers/healthController.js
const os = require('os');
const mongoose = require('mongoose');
const cacheService = require('../services/cacheService');
const rateLimiter = require('../middleware/rateLimiter');

exports.getBasicHealth = (req, res) => {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        hostname: os.hostname(),
        pid: process.pid
    });
};

exports.getHealthCheck = (req, res) => {
    try {
        const healthStatus = {
            status: 'healthy',
            components: {
                database: {
                    status: mongoose.connection.readyState === 1 ? 'connected' : 'disconnected'
                },
                system: {
                    status: 'healthy',
                    memory: {
                        total: os.totalmem(),
                        free: os.freemem(),
                        used: os.totalmem() - os.freemem(),
                        usagePercent: ((os.totalmem() - os.freemem()) / os.totalmem() * 100).toFixed(2)
                    }
                }
            },
            timestamp: new Date().toISOString()
        };

        return res.status(200).json(healthStatus);
    } catch (error) {
        console.error('Health check endpoint error:', error);
        return res.status(500).json({
            status: 'error',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
};

exports.getSystemMetrics = (req, res) => {
    if (req.user && !req.user.isAdmin) {
        return res.status(403).json({ message: 'Unauthorized' });
    }

    try {
        const metrics = {
            system: {
                platform: os.platform(),
                arch: os.arch(),
                release: os.release(),
                uptime: os.uptime(),
                loadAvg: os.loadavg(),
                totalMem: os.totalmem(),
                freeMem: os.freemem(),
                cpus: os.cpus().length,
                hostname: os.hostname()
            },
            process: {
                pid: process.pid,
                uptime: process.uptime(),
                memoryUsage: process.memoryUsage(),
                version: process.version,
                env: process.env.NODE_ENV
            },
            database: {
                status: mongoose.connection.readyState,
                name: mongoose.connection.name,
                host: mongoose.connection.host,
                port: mongoose.connection.port
            }
        };
        if (cacheService && typeof cacheService.getStats === 'function') {
            metrics.cache = cacheService.getStats();
        }

        return res.status(200).json(metrics);
    } catch (error) {
        console.error('Error getting system metrics:', error);
        return res.status(500).json({ error: 'Failed to get system metrics' });
    }
};

exports.adjustRateLimits = (req, res) => {
    if (req.user && !req.user.isAdmin) {
        return res.status(403).json({ message: 'Unauthorized' });
    }

    try {
        const { mode } = req.body;

        if (!mode || !['strict', 'normal', 'lenient'].includes(mode)) {
            return res.status(400).json({ error: 'Invalid mode. Use strict, normal, or lenient.' });
        }

        if (typeof rateLimiter.adjustRateLimits === 'function') {
            rateLimiter.adjustRateLimits(mode === 'strict' ? 0.9 : mode === 'lenient' ? 0.3 : 0.6);
            return res.status(200).json({
                message: `Rate limits set to ${mode} mode`,
                success: true
            });
        } else {
            return res.status(500).json({
                error: 'Rate limiter adjustment not available',
                success: false
            });
        }
    } catch (error) {
        console.error('Error adjusting rate limits:', error);
        return res.status(500).json({ error: 'Failed to adjust rate limits' });
    }
};
