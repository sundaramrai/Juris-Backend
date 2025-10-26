const express = require("express");
const cors = require("cors");
const compression = require("compression");
const compressible = require("compressible");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const mongoSanitize = require("express-mongo-sanitize");
require("dotenv").config();
const { connectDatabase } = require("./config/database");
const routes = require("./routes");
const { validateEnvVars } = require("./utils/validation");

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';
const rawCorsOrigins = process.env.CORS_ORIGINS || '';
console.log('Raw CORS_ORIGINS env:', rawCorsOrigins);

const allowedOrigins = new Set(
  rawCorsOrigins
    .split(',')
    .map(origin => origin.trim())
    .filter(Boolean)
);

console.log('Allowed CORS origins:', Array.from(allowedOrigins));
Array.from(allowedOrigins).forEach((origin, idx) => {
  console.log(`Allowed Origin [${idx}]: "${origin}"`);
});

validateEnvVars();

const app = express();

function setupMiddleware(app) {
  if (isProduction) app.set('trust proxy', 1);

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
    noSniff: true,
    xssFilter: true,
    hidePoweredBy: true
  }));

  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,
    max: isProduction ? 100 : 1000,
    message: 'Too many requests from this IP, please try again later.',
    standardHeaders: true,
    legacyHeaders: false,
    skip: req => !isProduction && req.ip === '127.0.0.1'
  }));

  app.use(compression({
    filter: (req, res) => {
      if (req.headers['x-no-compression']) return false;
      const contentType = typeof res.getHeader === 'function' ? res.getHeader('Content-Type') : undefined;
      return compressible(contentType);
    },
    level: 6
  }));

  const originCache = new Map();
  app.use(cors({
    origin: (origin, callback) => {
      console.log(`[CORS] Incoming Origin: "${origin}"`);
      console.log(`[CORS] Allowed Origins:`, Array.from(allowedOrigins));
      if (!origin) return callback(null, true);
      if (originCache.has(origin)) {
        console.log(`[CORS] Origin: ${origin} Allowed: ${originCache.get(origin)}`);
        return callback(null, originCache.get(origin));
      }
      const isAllowed = (!isProduction && origin.startsWith('http://localhost:')) ||
        allowedOrigins.has(origin);
      originCache.set(origin, isAllowed);
      console.log(`[CORS] Origin: ${origin} Allowed: ${isAllowed}`);
      if (!isAllowed) {
        return callback(new Error('Not allowed by CORS'), false);
      }
      callback(null, true);
    },
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
    maxAge: 86400
  }));

  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true, limit: '10mb' }));

  app.use(mongoSanitize({
    replaceWith: '_',
    onSanitize: ({ req, key }) => {
      console.warn(`Sanitized field ${key} in request from ${req.ip}`);
    }
  }));

  app.use((req, res, next) => {
    req.setTimeout(30000, () => res.status(408).json({ error: 'Request timeout' }));
    res.setTimeout(30000, () => res.status(503).json({ error: 'Service timeout' }));
    next();
  });
}

setupMiddleware(app);

app.use("/api", routes);

app.use((req, res) => res.status(404).json({ error: 'Route not found' }));

app.use((err, req, res, next) => {
  if (!isProduction) console.error('Error:', err);
  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: isProduction ? 'Internal server error' : err.message,
    ...(!isProduction && err.stack ? { stack: err.stack } : {})
  });
});

let server;
const SHUTDOWN_TIMEOUT = 10000;
let isShuttingDown = false;

const shutdown = signal => async error => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  if (error && !['SIGINT', 'SIGTERM'].includes(signal)) console.error(`${signal}:`, error);
  console.log(`${signal} received. Shutting down gracefully...`);

  try {
    const dbConnection = require('./config/dbConnection');
    if (dbConnection) {
      await dbConnection.disconnect();
      console.log('Database disconnected successfully');
    }
  } catch (err) {
    console.error('DB disconnect error:', err);
  }

  if (server) {
    const forceShutdown = setTimeout(() => {
      console.error('Forced shutdown due to timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT);

    server.close(err => {
      clearTimeout(forceShutdown);
      console.log(err ? 'Server shutdown with errors' : 'Server closed successfully');
      process.exit(err ? 1 : 0);
    });
    server.closeAllConnections?.();
  } else {
    process.exit(error ? 1 : 0);
  }
};

(async () => {
  try {
    await connectDatabase();
    server = app.listen(PORT, () => {
      console.log(`Server running on port ${PORT} in ${NODE_ENV} mode`);
    });
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, shutdown(signal));
    }
    process.on("uncaughtException", error => {
      console.error('Uncaught Exception:', error);
      shutdown("uncaughtException")(error);
    });
    process.on("unhandledRejection", (reason, promise) => {
      console.error('Unhandled Rejection at:', promise, 'reason:', reason);
      shutdown("unhandledRejection")(reason);
    });
  } catch (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  }
})();