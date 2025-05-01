// src/services/queueService.js
const { EventEmitter } = require('events');
const Queue = require('bull');
const Redis = require('ioredis');

EventEmitter.defaultMaxListeners = 20;

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const REDIS_PASSWORD = process.env.REDIS_PASSWORD;
const CONNECTION_RETRY_ATTEMPTS = 5;

const QUEUES = {
    LEGAL_QUERY: 'legal-query-processing',
    NOTIFICATION: 'user-notifications',
    DOCUMENT: 'document-processing',
    ANALYTICS: 'analytics-processing',
    CLEANUP: 'data-cleanup'
};

const defaultConfig = {
    redis: {
        port: 6379,
        host: 'localhost',
        password: REDIS_PASSWORD,
        maxRetriesPerRequest: 3,
        connectTimeout: 5000
    },
    prefix: 'juris',
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000
        },
        removeOnComplete: 100,
        removeOnFail: 200
    }
};

if (REDIS_URL) {
    defaultConfig.redis = REDIS_URL;
}

const PRIORITY = {
    CRITICAL: 1,
    HIGH: 5,
    MEDIUM: 10,
    LOW: 15
};

const queues = new Map();
let redisClient = null;
let metricsCallback = null;
let shutdownInProgress = false;

async function setupQueues(onMetricsUpdate = null) {
    try {
        if (redisClient) {
            console.log('Queues already set up');
            return { queues: Array.from(queues.keys()) };
        }
        metricsCallback = onMetricsUpdate;
        redisClient = new Redis(defaultConfig.redis);

        redisClient.on('error', (err) => {
            console.error('Redis client error:', err);
        });

        await redisClient.ping();
        console.log('✅ Connected to Redis');
        for (const [name, queueName] of Object.entries(QUEUES)) {
            const queue = new Queue(queueName, {
                ...defaultConfig,
                limiter: {
                    max: 50,
                    duration: 1000
                }
            });
            queue.on('error', (err) => {
                console.error(`Queue ${queueName} error:`, err);
            });
            queue.on('stalled', (job) => {
                console.warn(`Job ${job.id} in ${queueName} stalled`);
            });
            queue.on('failed', (job, err) => {
                console.error(`Job ${job.id} in ${queueName} failed:`, err);
            });

            queues.set(queueName, queue);
            console.log(`✅ Queue ${queueName} initialized`);
        }
        startMetricsCollection();

        return {
            queues: Array.from(queues.keys()),
            connected: true
        };
    } catch (err) {
        console.error('Error setting up queues:', err);
        return {
            error: err.message,
            connected: false
        };
    }
}

async function addJob(queueName, data, options = {}) {
    try {
        const queue = queues.get(queueName);
        if (!queue) {
            throw new Error(`Queue ${queueName} not initialized`);
        }

        const jobOptions = {
            ...defaultConfig.defaultJobOptions,
            ...options
        };

        const job = await queue.add(data, jobOptions);
        return job;
    } catch (err) {
        console.error(`Error adding job to ${queueName}:`, err);
        throw err;
    }
}

function processQueue(queueName, processor, options = {}) {
    try {
        const queue = queues.get(queueName);
        if (!queue) {
            throw new Error(`Queue ${queueName} not initialized`);
        }

        const concurrency = options.concurrency || 5;

        queue.process(concurrency, async (job) => {
            try {
                return await processor(job.data, job);
            } catch (err) {
                console.error(`Error processing job ${job.id}:`, err);
                throw err;
            }
        });

        console.log(`✅ Processing ${queueName} with concurrency ${concurrency}`);
        return true;
    } catch (err) {
        console.error(`Error setting up processor for ${queueName}:`, err);
        throw err;
    }
}

async function getQueuesStatus() {
    try {
        if (!redisClient || redisClient.status !== 'ready') {
            return {
                connected: false,
                error: 'Redis connection not available'
            };
        }

        const queueStats = [];
        let totalJobs = 0;
        let totalPending = 0;
        let totalActive = 0;
        let totalFailed = 0;

        const statPromises = Array.from(queues.entries()).map(async ([name, queue]) => {
            try {
                const [counts, isPaused] = await Promise.all([
                    queue.getJobCounts(),
                    queue.isPaused()
                ]);

                totalJobs += Object.values(counts).reduce((sum, count) => sum + count, 0);
                totalPending += counts.waiting || 0;
                totalActive += counts.active || 0;
                totalFailed += counts.failed || 0;

                return {
                    name,
                    status: isPaused ? 'paused' : 'active',
                    jobs: counts,
                    workers: await queue.getWorkers().length
                };
            } catch (err) {
                return {
                    name,
                    status: 'error',
                    error: err.message
                };
            }
        });

        const results = await Promise.all(statPromises);

        return {
            connected: true,
            queues: results,
            summary: {
                totalQueues: queues.size,
                totalJobs,
                totalPending,
                totalActive,
                totalFailed
            }
        };
    } catch (err) {
        console.error('Error getting queue status:', err);
        return {
            connected: false,
            error: err.message
        };
    }
}

function startMetricsCollection() {
    const interval = setInterval(async () => {
        try {
            if (shutdownInProgress) {
                clearInterval(interval);
                return;
            }

            const status = await getQueuesStatus();

            if (metricsCallback && typeof metricsCallback === 'function') {
                metricsCallback({
                    timestamp: new Date().toISOString(),
                    totalQueues: queues.size,
                    totalMessages: status.summary?.totalJobs || 0,
                    pending: status.summary?.totalPending || 0,
                    active: status.summary?.totalActive || 0,
                    failed: status.summary?.totalFailed || 0
                });
            }
        } catch (err) {
            console.error('Error collecting queue metrics:', err);
        }
    }, 15000);
}

async function shutdownQueues() {
    shutdownInProgress = true;
    console.log('Beginning queue shutdown sequence');

    try {
        const closePromises = Array.from(queues.values()).map(async (queue) => {
            try {
                await queue.pause(true);
                console.log(`Queue ${queue.name} paused`);
                const activeJobs = await queue.getActive();
                if (activeJobs.length > 0) {
                    console.log(`Waiting for ${activeJobs.length} active jobs in ${queue.name} to complete...`);
                    await Promise.race([
                        Promise.all(activeJobs.map(job => job.finished())),
                        new Promise(r => setTimeout(r, 10000))
                    ]);
                }

                await queue.close();
                console.log(`Queue ${queue.name} closed`);
                return true;
            } catch (err) {
                console.error(`Error closing queue ${queue.name}:`, err);
                return false;
            }
        });

        await Promise.all(closePromises);
        if (redisClient) {
            await redisClient.quit();
            console.log('Redis client closed');
            redisClient = null;
        }

        queues.clear();
        return true;
    } catch (err) {
        console.error('Error shutting down queues:', err);
        throw err;
    }
}

async function scheduleJob(queueName, data, delayMs, options = {}) {
    try {
        const queue = queues.get(queueName);
        if (!queue) {
            throw new Error(`Queue ${queueName} not initialized`);
        }

        const jobOptions = {
            ...defaultConfig.defaultJobOptions,
            ...options,
            delay: delayMs
        };

        const job = await queue.add(data, jobOptions);
        return job;
    } catch (err) {
        console.error(`Error scheduling job to ${queueName}:`, err);
        throw err;
    }
}

async function createRepeatingJob(queueName, data, pattern, options = {}) {
    try {
        const queue = queues.get(queueName);
        if (!queue) {
            throw new Error(`Queue ${queueName} not initialized`);
        }

        const jobOptions = {
            ...defaultConfig.defaultJobOptions,
            ...options,
            repeat: {
                pattern
            }
        };

        const job = await queue.add(data, jobOptions);
        return job;
    } catch (err) {
        console.error(`Error creating repeating job in ${queueName}:`, err);
        throw err;
    }
}

async function getJob(queueName, jobId) {
    try {
        const queue = queues.get(queueName);
        if (!queue) {
            throw new Error(`Queue ${queueName} not initialized`);
        }

        return await queue.getJob(jobId);
    } catch (err) {
        console.error(`Error getting job ${jobId} from ${queueName}:`, err);
        throw err;
    }
}

module.exports = {
    setupQueues,
    getQueuesStatus,
    shutdownQueues,
    addJob,
    processQueue,
    scheduleJob,
    createRepeatingJob,
    getJob,
    QUEUES,
    PRIORITY
};
