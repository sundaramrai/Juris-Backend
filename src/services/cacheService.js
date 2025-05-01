// src/services/cacheService.js
const Redis = require('ioredis');
const { promisify } = require('util');

class CacheService {
    constructor() {
        this.redisClient = null;
        this.isRedisAvailable = false;
        this.fallbackCache = new Map();
        this.initRedisClient();
        this.stats = {
            hits: 0,
            misses: 0,
            sets: 0,
            errors: 0
        };
    }

    initRedisClient() {
        try {
            const redisUrl = process.env.REDIS_URL;

            this.redisClient = new Redis(redisUrl, {
                maxRetriesPerRequest: 3,
                enableReadyCheck: true,
                connectTimeout: 10000,
                retryStrategy: (times) => {
                    const delay = Math.min(times * 50, 2000);
                    return delay;
                }
            });

            this.redisClient.on('connect', () => {
                console.log('Redis client connected');
                this.isRedisAvailable = true;
            });

            this.redisClient.on('error', (err) => {
                console.error('Redis connection error:', err);
                this.isRedisAvailable = false;
            });

            this.redisClient.on('reconnecting', () => {
                console.log('Redis client reconnecting');
            });

            this.redisClient.on('ready', () => {
                console.log('Redis client ready');
                this.isRedisAvailable = true;
            });

        } catch (error) {
            console.error('Redis initialization error:', error);
            this.isRedisAvailable = false;
        }
    }

    async get(key, namespace = 'default') {
        const fullKey = `${namespace}:${key}`;

        try {
            if (!this.isRedisAvailable) {
                const result = this.fallbackCache.get(fullKey);
                this.stats[result ? 'hits' : 'misses']++;
                return result ? JSON.parse(result) : null;
            }

            const result = await this.redisClient.get(fullKey);
            this.stats[result ? 'hits' : 'misses']++;
            return result ? JSON.parse(result) : null;
        } catch (error) {
            console.error(`Cache get error for key ${fullKey}:`, error);
            this.stats.errors++;
            return null;
        }
    }

    async set(key, value, ttlSeconds = 3600, namespace = 'default') {
        const fullKey = `${namespace}:${key}`;
        const serialized = JSON.stringify(value);

        try {
            if (!this.isRedisAvailable) {
                this.fallbackCache.set(fullKey, serialized);
                this.stats.sets++;
                return true;
            }

            if (ttlSeconds > 0) {
                await this.redisClient.setex(fullKey, ttlSeconds, serialized);
            } else {
                await this.redisClient.set(fullKey, serialized);
            }
            this.stats.sets++;
            return true;
        } catch (error) {
            console.error(`Cache set error for key ${fullKey}:`, error);
            this.stats.errors++;
            return false;
        }
    }

    async del(key, namespace = 'default') {
        const fullKey = `${namespace}:${key}`;

        try {
            if (!this.isRedisAvailable) {
                return this.fallbackCache.delete(fullKey);
            }

            await this.redisClient.del(fullKey);
            return true;
        } catch (error) {
            console.error(`Cache delete error for key ${fullKey}:`, error);
            this.stats.errors++;
            return false;
        }
    }

    async flush(namespace = 'default') {
        try {
            if (!this.isRedisAvailable) {
                this.fallbackCache.clear();
                return true;
            }

            const keys = await this.redisClient.keys(`${namespace}:*`);
            if (keys.length > 0) {
                await this.redisClient.del(keys);
            }
            return true;
        } catch (error) {
            console.error(`Cache flush error for namespace ${namespace}:`, error);
            this.stats.errors++;
            return false;
        }
    }

    getStats() {
        const hitRate = this.stats.hits + this.stats.misses === 0 ? 0 :
            this.stats.hits / (this.stats.hits + this.stats.misses);

        return {
            ...this.stats,
            hitRate: hitRate * 100,
            isRedisAvailable: this.isRedisAvailable,
            fallbackCacheSize: this.fallbackCache.size
        };
    }
}

const cacheService = new CacheService();
module.exports = cacheService;
