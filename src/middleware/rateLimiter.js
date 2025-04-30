const Redis = require('ioredis');
const { RateLimiterRedis } = require('rate-limiter-flexible');
const os = require('os');

class RateLimitManager {
    constructor() {
        this.limiters = {};
        this.redisClient = null;
        this.fallbackLimiters = new Map();
        this.isRedisAvailable = false;
        this.initRedisClient();
    }

    initRedisClient() {
        try {
            const redisUrl = process.env.REDIS_URL;

            this.redisClient = new Redis(redisUrl, {
                enableOfflineQueue: false,
                maxRetriesPerRequest: 3
            });

            this.redisClient.on('connect', () => {
                console.log('Rate limiter Redis client connected');
                this.isRedisAvailable = true;
                this.createLimiters();
            });

            this.redisClient.on('error', (err) => {
                console.error('Rate limiter Redis error:', err);
                this.isRedisAvailable = false;
            });

            this.redisClient.on('ready', () => {
                this.isRedisAvailable = true;
            });

        } catch (error) {
            console.error('Rate limiter initialization error:', error);
            this.isRedisAvailable = false;
        }
    }

    createLimiters() {
        this.limiters.standard = new RateLimiterRedis({
            storeClient: this.redisClient,
            keyPrefix: 'ratelimit:standard',
            points: 100,
            duration: 60,
            blockDuration: 60,
        });

        this.limiters.chat = new RateLimiterRedis({
            storeClient: this.redisClient,
            keyPrefix: 'ratelimit:chat',
            points: 30,
            duration: 60,
            blockDuration: 120,
        });

        this.limiters.strict = new RateLimiterRedis({
            storeClient: this.redisClient,
            keyPrefix: 'ratelimit:strict',
            points: 5,
            duration: 60,
            blockDuration: 300,
        });
    }

    middleware(limiterId = 'standard') {
        return async (req, res, next) => {
            try {
                if (req.path === '/health' || req.path.startsWith('/public/')) {
                    return next();
                }
                const key = req.user ? req.user.id : req.ip;
                if (!this.isRedisAvailable) {
                    return this.fallbackRateLimiter(key, limiterId, req, res, next);
                }

                const limiter = this.limiters[limiterId] || this.limiters.standard;

                try {
                    await limiter.consume(key);
                    next();
                } catch (error) {
                    if (error.msBeforeNext) {
                        res.set('Retry-After', Math.ceil(error.msBeforeNext / 1000));
                        res.set('X-RateLimit-Limit', limiter.points);
                        res.set('X-RateLimit-Remaining', 0);
                        res.set('X-RateLimit-Reset', new Date(Date.now() + error.msBeforeNext).toUTCString());

                        return res.status(429).json({
                            error: 'Too many requests',
                            message: 'Please try again later',
                            retryAfter: Math.ceil(error.msBeforeNext / 1000)
                        });
                    } else {
                        throw error;
                    }
                }
            } catch (error) {
                console.error('Rate limiter error:', error);
                next();
            }
        };
    }

    fallbackRateLimiter(key, limiterId, req, res, next) {
        if (!this.fallbackLimiters.has(key)) {
            this.fallbackLimiters.set(key, {
                count: 0,
                resetTime: Date.now() + 60000,
                blocked: false
            });
        }

        const limit = limiterId === 'strict' ? 5 :
            limiterId === 'chat' ? 30 : 100;

        const entry = this.fallbackLimiters.get(key);

        if (Date.now() > entry.resetTime) {
            entry.count = 0;
            entry.resetTime = Date.now() + 60000;
            entry.blocked = false;
        }
        if (entry.blocked) {
            return res.status(429).json({
                error: 'Too many requests',
                message: 'Please try again later',
                retryAfter: Math.ceil((entry.resetTime - Date.now()) / 1000)
            });
        }
        entry.count++;

        if (entry.count > limit) {
            entry.blocked = true;
            return res.status(429).json({
                error: 'Too many requests',
                message: 'Please try again later',
                retryAfter: 60
            });
        }

        next();
    }

    adjustRateLimits() {
        if (!this.isRedisAvailable) {
            return;
        }

        try {
            const cpuUsage = os.loadavg()[0] / os.cpus().length;
            if (cpuUsage > 0.8) {
                this.createStrictLimits();
            }
            else if (cpuUsage < 0.3) {
                this.createLenientLimits();
            }
            else {
                this.createDefaultLimits();
            }
        } catch (error) {
            console.error('Error adjusting rate limits:', error);
        }
    }

    createStrictLimits() {
        if (!this.limiters.standard) return;

        this.limiters.standard.points = 50;
        this.limiters.chat.points = 15;
        this.limiters.strict.points = 3;
        console.log('Applied strict rate limits due to high server load');
    }

    createLenientLimits() {
        if (!this.limiters.standard) return;

        this.limiters.standard.points = 150;
        this.limiters.chat.points = 45;
        this.limiters.strict.points = 8;
        console.log('Applied lenient rate limits due to low server load');
    }

    createDefaultLimits() {
        if (!this.limiters.standard) return;

        this.limiters.standard.points = 100;
        this.limiters.chat.points = 30;
        this.limiters.strict.points = 5;
    }
}

const rateLimitManager = new RateLimitManager();
setInterval(() => {
    rateLimitManager.adjustRateLimits();
}, 5 * 60 * 1000);

module.exports = {
    standard: (req, res, next) => rateLimitManager.middleware('standard')(req, res, next),
    chat: (req, res, next) => rateLimitManager.middleware('chat')(req, res, next),
    strict: (req, res, next) => rateLimitManager.middleware('strict')(req, res, next)
};
