// src/index.js
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
const cluster = require('cluster');
const os = require('os');
require("dotenv").config();
const { connectDatabase } = require("./config/database");
const routes = require("./routes");
const { validateEnvVars } = require("./utils/validation");
const { errorHandler, errorMiddleware, requestMonitoring } = require('./middleware');
const { setupQueues, getQueuesStatus, shutdownQueues } = require('./services/queueService');

const PORT = process.env.PORT || 3000;
const TIMEOUT = 120000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const WORKERS = process.env.WEB_CONCURRENCY || os.cpus().length;
const isProduction = NODE_ENV === 'production';

if (isProduction && cluster.isMaster) {
  console.log(`Master ${process.pid} is running`);
  console.log(`Starting ${WORKERS} workers...`);

  const workerStats = new Map();
  cluster.on('message', (worker, message) => {
    if (message.type === 'stats') {
      workerStats.set(worker.id, {
        ...message.data,
        lastUpdated: Date.now()
      });
    }
  });

  setInterval(() => {
    const stats = {
      workers: workerStats.size,
      totalRequests: 0,
      avgResponseTime: 0,
      queueBacklog: 0,
    };

    let validStatsCount = 0;
    workerStats.forEach(workerStat => {
      if (workerStat && Date.now() - workerStat.lastUpdated < 300000) {
        stats.totalRequests += workerStat.requestCount || 0;
        stats.queueBacklog += workerStat.queueSize || 0;
        if (workerStat.avgResponseTime) {
          stats.avgResponseTime += workerStat.avgResponseTime;
          validStatsCount++;
        }
      }
    });

    if (validStatsCount > 0) {
      stats.avgResponseTime /= validStatsCount;
    }

    console.log('System Stats:', stats);
  }, 60000);

  for (let i = 0; i < WORKERS; i++) {
    cluster.fork();
  }

  cluster.on('exit', (worker, code, signal) => {
    console.log(`Worker ${worker.process.pid} died with code: ${code} and signal: ${signal}`);
    console.log('Starting a new worker');
    workerStats.delete(worker.id);
    cluster.fork();
  });

  ['SIGINT', 'SIGTERM'].forEach(signal => {
    process.on(signal, () => {
      console.log(`Master ${process.pid} received ${signal}, shutting down...`);
      for (const id in cluster.workers) {
        cluster.workers[id].send({ command: 'shutdown' });
      }
      setTimeout(() => {
        console.log('Forcing master process exit');
        process.exit(0);
      }, 45000);
    });
  });
} else {
  const app = express();
  validateEnvVars();

  app.use(helmet({
    contentSecurityPolicy: isProduction ? undefined : false
  }));
  app.use(compression());

  app.use(requestMonitoring);

  const performanceMetrics = {
    startTime: Date.now(),
    requestCount: 0,
    responseTimeTotal: 0,
    errors: 0,
    queueSize: 0,
    lastReported: Date.now()
  };

  app.use((req, res, next) => {
    const start = Date.now();
    performanceMetrics.requestCount++;

    res.on('finish', () => {
      const duration = Date.now() - start;
      performanceMetrics.responseTimeTotal += duration;

      if (res.statusCode >= 400) {
        performanceMetrics.errors++;
      }
    });

    next();
  });

  if (isProduction && process.send) {
    setInterval(() => {
      const timeSinceStart = Date.now() - performanceMetrics.startTime;
      const avgResponseTime = performanceMetrics.requestCount > 0
        ? performanceMetrics.responseTimeTotal / performanceMetrics.requestCount
        : 0;

      process.send({
        type: 'stats',
        data: {
          requestCount: performanceMetrics.requestCount,
          avgResponseTime,
          errors: performanceMetrics.errors,
          uptime: timeSinceStart / 1000,
          queueSize: performanceMetrics.queueSize,
          memory: process.memoryUsage().rss
        }
      });
    }, 30000);
  }

  const corsOptions = {
    origin: function (origin, callback) {
      if (!origin || (!isProduction && origin.startsWith('http://localhost:'))) {
        return callback(null, true);
      }

      const allowedOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [];
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 86400
  };

  app.use(cors(corsOptions));
  app.use(express.json({ limit: '10mb' }));

  app.get('/health', async (req, res) => {
    try {
      const dbConnection = require('./config/dbConnection');
      const dbStatus = dbConnection.getConnectionStatus();
      const queuesStatus = await getQueuesStatus();

      const systemLoad = {
        memory: process.memoryUsage(),
        cpu: {
          load: process.platform === 'win32' ? [0, 0, 0] : os.loadavg(),
          cores: os.cpus().length
        }
      };

      const timeSinceStart = Date.now() - performanceMetrics.startTime;
      const avgResponseTime = performanceMetrics.requestCount > 0
        ? performanceMetrics.responseTimeTotal / performanceMetrics.requestCount
        : 0;

      const healthStatus = {
        status: dbStatus.connected && queuesStatus.connected ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        hostname: os.hostname(),
        worker: {
          pid: process.pid,
          requests: performanceMetrics.requestCount,
          avgResponseTime: Math.round(avgResponseTime),
          errors: performanceMetrics.errors,
          uptime: Math.round(timeSinceStart / 1000)
        },
        system: systemLoad,
        services: {
          database: dbStatus,
          queues: queuesStatus
        }
      };

      res.status(healthStatus.status === 'ok' ? 200 : 207).json(healthStatus);
    } catch (error) {
      console.error('Health check error:', error);
      res.status(500).json({
        status: 'error',
        timestamp: new Date().toISOString(),
        error: error.message
      });
    }
  });

  (async function () {
    try {
      await connectDatabase();
      await setupQueues(data => {
        performanceMetrics.queueSize = data.totalMessages || 0;
      });
      startServer();
    } catch (err) {
      console.error('Initialization failed:', err);
      process.exit(1);
    }
  })();

  app.use("/api", routes);

  app.use(errorMiddleware);

  function startServer() {
    const server = app.listen(PORT, () => {
      console.log(`🚀 Worker ${process.pid} running on port ${PORT} in ${NODE_ENV} mode`);

      const { startCleanupInterval } = require("./services/cleanupService");
      global.cleanupInterval = startCleanupInterval(60);
    });

    server.timeout = TIMEOUT;
    server.keepAliveTimeout = TIMEOUT;
    server.headersTimeout = TIMEOUT;

    server.on("connection", (socket) => {
      socket.setTimeout(TIMEOUT);
    });

    const isNightTime = () => {
      const currentHour = new Date().getHours();
      return currentHour >= 0 && currentHour < 8;
    };

    const gracefulShutdown = async (force = false) => {
      if (!force && !isNightTime()) {
        return;
      }

      console.log(`Worker ${process.pid} shutting down...`);
      server.close(async () => {
        console.log(`Worker ${process.pid} HTTP server closed`);

        try {
          await shutdownQueues();
          console.log(`Worker ${process.pid} queue connections closed`);
        } catch (err) {
          console.error('Error shutting down queues:', err);
        }

        if (global.cleanupInterval) clearInterval(global.cleanupInterval);
        console.log(`Worker ${process.pid} closed gracefully`);
        process.exit(0);
      });

      setTimeout(() => {
        console.error(`Forcing worker ${process.pid} shutdown after timeout`);
        process.exit(1);
      }, 30000);
    };

    process.on("SIGINT", () => gracefulShutdown(true));
    process.on("SIGTERM", () => gracefulShutdown(true));
    process.on("uncaughtException", (error) => {
      console.error("Uncaught exception:", error);
      gracefulShutdown(false);
    });

    process.on("unhandledRejection", (reason, promise) => {
      console.error("Unhandled rejection at:", promise, "reason:", reason);
    });

    server.on('error', (error) => {
      console.error('Server error:', error);
    });

    if (isProduction) {
      const checkScheduledShutdown = () => {
        if (isNightTime()) {
          console.log("Scheduled maintenance window (12 AM - 8 AM): Initiating shutdown");
          gracefulShutdown();
        }
      };

      setInterval(checkScheduledShutdown, 60 * 60 * 1000);
    }
    process.on('message', async (msg) => {
      if (msg.command === 'shutdown') {
        await gracefulShutdown(true);
      }
    });

    return server;
  }
}