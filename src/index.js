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
const allowedOrigins = process.env.CORS_ORIGINS?.split(',').filter(Boolean) || [];

validateEnvVars();

const app = express();

if (isProduction) {
  app.set('trust proxy', 1);
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true
  },
  noSniff: true,
  xssFilter: true,
  hidePoweredBy: true
}));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isProduction ? 100 : 1000,
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !isProduction && req.ip === '127.0.0.1'
});

app.use('/api', limiter);
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    const contentType = (typeof res.getHeader === 'function') ? res.getHeader('Content-Type') : undefined;
    return compressible(contentType);
  },
  level: 6
}));

const originCache = new Map();
app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (originCache.has(origin)) {
      return callback(null, originCache.get(origin));
    }
    const isAllowed = (!isProduction && origin.startsWith('http://localhost:')) ||
      allowedOrigins.includes(origin);
    originCache.set(origin, isAllowed);
    callback(null, isAllowed);
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
  req.setTimeout(30000, () => {
    res.status(408).json({ error: 'Request timeout' });
  });
  res.setTimeout(30000, () => {
    res.status(503).json({ error: 'Service timeout' });
  });
  next();
});

app.use("/api", routes);

app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use((err, req, res, next) => {
  if (!isProduction) {
    console.error('Error:', err);
  }

  const statusCode = err.status || err.statusCode || 500;
  res.status(statusCode).json({
    error: isProduction ? 'Internal server error' : err.message,
    ...((!isProduction && err.stack) && { stack: err.stack })
  });
});

let server;
const SHUTDOWN_TIMEOUT = 10000;

const shutdown = (signal) => (error) => {
  if (error) console.error(`${signal} error:`, error);
  console.log(`${signal} received. Shutting down gracefully...`);

  const dbConnection = require('./config/dbConnection');
  if (dbConnection) {
    dbConnection.disconnect().catch(err => console.error('DB disconnect error:', err));
  }

  if (server) {
    const forceShutdown = setTimeout(() => {
      console.error('Forced shutdown due to timeout');
      process.exit(1);
    }, SHUTDOWN_TIMEOUT);

    server.close((err) => {
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

    for (const signal of ["SIGINT", "SIGTERM", "uncaughtException", "unhandledRejection"]) {
      process.on(signal, shutdown(signal));
    }
  } catch (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  }
})();