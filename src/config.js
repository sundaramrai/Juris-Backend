require('dotenv').config();

const config = {
    port: parseInt(process.env.PORT || '3000'),
    nodeEnv: process.env.NODE_ENV || 'development',

    mongodb: {
        uri: process.env.MONGODB_URI,
        options: {
            useNewUrlParser: true,
            useUnifiedTopology: true
        }
    },

    api: {
        rateLimits: {
            window: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
            maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '60')
        }
    },

    auth: {
        jwtSecret: process.env.JWT_SECRET || 'juris-dev-secret-key',
        jwtExpiration: process.env.JWT_EXPIRATION || '1d',
        adminApiKey: process.env.ADMIN_API_KEY
    },

    cache: {
        ttl: parseInt(process.env.CACHE_TTL || '900000'),
        maxSize: parseInt(process.env.CACHE_MAX_SIZE || '1000'),
        maxMemoryMB: parseInt(process.env.CACHE_MAX_MEMORY_MB || '100')
    },

    ai: {
        apiKey: process.env.GEMINI_API_KEY,
        maxRetries: parseInt(process.env.AI_MAX_RETRIES || '3'),
        retryDelay: parseInt(process.env.AI_RETRY_DELAY || '1000'),
        timeout: parseInt(process.env.AI_TIMEOUT || '30000')
    },

    logging: {
        level: process.env.LOG_LEVEL || 'info'
    }
};

module.exports = config;
