const os = require('os');
const cacheService = require('./cacheService');
const dbConnection = require('../config/dbConnection');
const { rateLimiter } = require('../middleware');

class MonitoringService {
    constructor() {
        this.metrics = {
            system: {
                cpuUsage: [],
                memoryUsage: [],
                loadAverage: []
            },
            process: {
                memory: [],
                uptime: 0
            },
            database: {
                connectionStatus: 'unknown',
                operations: {
                    reads: 0,
                    writes: 0,
                    errors: 0
                }
            },
            cache: {
                hitRate: 0,
                size: 0,
                operations: {
                    gets: 0,
                    sets: 0,
                    errors: 0
                }
            },
            requests: {
                total: 0,
                success: 0,
                failed: 0,
                rateLimited: 0
            },
            startTime: Date.now()
        };

        this.maxDataPoints = 60;
        this.sampleInterval = 60000;
        this.isActive = false;
    }

    start() {
        if (this.isActive) return;

        this.isActive = true;
        this.metrics.startTime = Date.now();
        this.intervalId = setInterval(() => {
            this.updateMetrics();
        }, this.sampleInterval);

        console.log('Monitoring service started');
        this.updateMetrics();
    }

    stop() {
        if (!this.isActive) return;

        clearInterval(this.intervalId);
        this.isActive = false;
        console.log('Monitoring service stopped');
    }

    updateMetrics() {
        this.updateSystemMetrics();
        this.updateProcessMetrics();
        this.updateDatabaseMetrics();
        this.updateCacheMetrics();
        this.adjustRateLimits();
    }

    updateSystemMetrics() {
        try {
            const cpus = os.cpus();
            const loadAvg = os.loadavg();
            const totalMem = os.totalmem();
            const freeMem = os.freemem();
            const usedMemPercentage = ((totalMem - freeMem) / totalMem) * 100;
            this.metrics.system.cpuUsage.unshift(loadAvg[0] / cpus.length);
            this.metrics.system.memoryUsage.unshift(usedMemPercentage);
            this.metrics.system.loadAverage.unshift(loadAvg[0]);

            if (this.metrics.system.cpuUsage.length > this.maxDataPoints) {
                this.metrics.system.cpuUsage.pop();
                this.metrics.system.memoryUsage.pop();
                this.metrics.system.loadAverage.pop();
            }

        } catch (error) {
            console.error('Error updating system metrics:', error);
        }
    }

    updateProcessMetrics() {
        try {
            const memUsage = process.memoryUsage();

            this.metrics.process.memory.unshift({
                rss: memUsage.rss / (1024 * 1024),
                heapTotal: memUsage.heapTotal / (1024 * 1024),
                heapUsed: memUsage.heapUsed / (1024 * 1024),
                external: memUsage.external / (1024 * 1024)
            });

            if (this.metrics.process.memory.length > this.maxDataPoints) {
                this.metrics.process.memory.pop();
            }

            this.metrics.process.uptime = process.uptime();
        } catch (error) {
            console.error('Error updating process metrics:', error);
        }
    }

    updateDatabaseMetrics() {
        try {
            const status = dbConnection.getConnectionStatus();
            this.metrics.database.connectionStatus = status.readyStateText;
        } catch (error) {
            console.error('Error updating database metrics:', error);
        }
    }

    updateCacheMetrics() {
        try {
            const stats = cacheService.getStats();

            this.metrics.cache.hitRate = stats.hitRate;
            this.metrics.cache.size = stats.isRedisAvailable ?
                'Redis' : stats.fallbackCacheSize;
            this.metrics.cache.operations.gets = stats.hits + stats.misses;
            this.metrics.cache.operations.sets = stats.sets;
            this.metrics.cache.operations.errors = stats.errors;
        } catch (error) {
            console.error('Error updating cache metrics:', error);
        }
    }

    adjustRateLimits() {
        try {
            const recentCpuUsage = this.metrics.system.cpuUsage
                .slice(0, 3)
                .reduce((sum, usage) => sum + usage, 0) /
                Math.min(3, this.metrics.system.cpuUsage.length);
            if (rateLimiter && typeof rateLimiter.adjustRateLimits === 'function') {
                rateLimiter.adjustRateLimits(recentCpuUsage);
            } else {
            }
        } catch (error) {
            console.error('Error adjusting rate limits:', error);
        }
    }

    getMetrics() {
        return {
            ...this.metrics,
            summary: {
                avgCpuUsage: this.getAverageFromArray(this.metrics.system.cpuUsage),
                avgMemoryUsage: this.getAverageFromArray(this.metrics.system.memoryUsage),
                uptime: (Date.now() - this.metrics.startTime) / 1000,
                currentLoad: this.metrics.system.loadAverage[0] || 0
            }
        };
    }

    getAverageFromArray(arr) {
        if (!arr || arr.length === 0) return 0;
        return arr.reduce((sum, value) => sum + value, 0) / arr.length;
    }

    logRequest(success, isRateLimited = false) {
        this.metrics.requests.total++;

        if (isRateLimited) {
            this.metrics.requests.rateLimited++;
        } else if (success) {
            this.metrics.requests.success++;
        } else {
            this.metrics.requests.failed++;
        }
    }
}

const monitoringService = new MonitoringService();
module.exports = monitoringService;
