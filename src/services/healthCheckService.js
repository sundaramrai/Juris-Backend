const os = require('os');
const mongoose = require('mongoose');
const cacheService = require('./cacheService');

class HealthCheckService {
    constructor() {
        this.lastCheck = null;
        this.healthStatus = {
            status: 'starting',
            components: {
                database: { status: 'unknown' },
                cache: { status: 'unknown' },
                system: { status: 'unknown' }
            },
            metrics: {},
            timestamp: new Date().toISOString()
        };
    }

    async performHealthCheck() {
        try {
            const now = new Date();
            if (this.lastCheck && now - this.lastCheck < 10000) {
                return this.healthStatus;
            }

            this.lastCheck = now;
            this.healthStatus.timestamp = now.toISOString();
            await this.checkDatabaseHealth();
            await this.checkCacheHealth();
            await this.checkSystemHealth();
            const componentStatuses = Object.values(this.healthStatus.components)
                .map(component => component.status);

            if (componentStatuses.includes('down')) {
                this.healthStatus.status = 'unhealthy';
            } else if (componentStatuses.includes('degraded')) {
                this.healthStatus.status = 'degraded';
            } else {
                this.healthStatus.status = 'healthy';
            }

            return this.healthStatus;
        } catch (error) {
            console.error('Health check error:', error);
            this.healthStatus.status = 'error';
            this.healthStatus.error = error.message;
            return this.healthStatus;
        }
    }

    async checkDatabaseHealth() {
        try {
            if (!mongoose.connection || mongoose.connection.readyState !== 1) {
                this.healthStatus.components.database = {
                    status: 'down',
                    message: 'Database disconnected'
                };
                return;
            }
            const startTime = Date.now();
            await mongoose.connection.db.admin().ping();
            const pingTime = Date.now() - startTime;

            this.healthStatus.components.database = {
                status: pingTime < 500 ? 'healthy' : 'degraded',
                responseTime: `${pingTime}ms`,
                details: {
                    host: mongoose.connection.host,
                    name: mongoose.connection.name,
                    connectionLatency: pingTime
                }
            };
        } catch (error) {
            this.healthStatus.components.database = {
                status: 'down',
                message: error.message
            };
        }
    }

    async checkCacheHealth() {
        try {
            const cacheStats = cacheService.getStats();

            if (!cacheStats.isRedisAvailable) {
                this.healthStatus.components.cache = {
                    status: 'degraded',
                    message: 'Using fallback local cache',
                    details: {
                        fallbackSize: cacheStats.fallbackCacheSize,
                        hitRate: cacheStats.hitRate
                    }
                };
                return;
            }

            this.healthStatus.components.cache = {
                status: 'healthy',
                details: {
                    hits: cacheStats.hits,
                    misses: cacheStats.misses,
                    hitRate: cacheStats.hitRate,
                    errors: cacheStats.errors
                }
            };
        } catch (error) {
            this.healthStatus.components.cache = {
                status: 'degraded',
                message: error.message
            };
        }
    }

    async checkSystemHealth() {
        try {
            const loadAverage = os.loadavg();
            const cpuCount = os.cpus().length;
            const normalizedLoad = loadAverage[0] / cpuCount;
            const freeMemory = os.freemem();
            const totalMemory = os.totalmem();
            const memoryUsagePercent = 100 * (1 - freeMemory / totalMemory);

            const status = normalizedLoad > 0.9 || memoryUsagePercent > 90
                ? 'degraded'
                : 'healthy';

            this.healthStatus.components.system = {
                status,
                details: {
                    load: loadAverage,
                    normalizedLoad,
                    cpuCount,
                    uptime: os.uptime(),
                    memory: {
                        free: freeMemory,
                        total: totalMemory,
                        usagePercent: memoryUsagePercent.toFixed(2)
                    },
                    platform: os.platform(),
                    hostname: os.hostname(),
                    processId: process.pid
                }
            };

            this.healthStatus.metrics = {
                cpuUsage: normalizedLoad.toFixed(2),
                memoryUsage: memoryUsagePercent.toFixed(2),
                uptime: os.uptime(),
                processUptime: process.uptime()
            };
        } catch (error) {
            this.healthStatus.components.system = {
                status: 'unknown',
                message: error.message
            };
        }
    }
}

const healthCheckService = new HealthCheckService();
module.exports = healthCheckService;
