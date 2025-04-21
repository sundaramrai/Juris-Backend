// src/index.js
const express = require("express");
const cors = require("cors");
const compression = require("compression");
const helmet = require("helmet");
require("dotenv").config();
const { connectDatabase } = require("./config/database");
const routes = require("./routes");
const { validateEnvVars } = require("./utils/validation");

const PORT = process.env.PORT || 3000;
const TIMEOUT = 120000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const isProduction = NODE_ENV === 'production';

const app = express();
validateEnvVars();

app.use(helmet());
app.use(compression());

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || (!isProduction && origin.startsWith('http://localhost:'))) {
      return callback(null, true);
    }

    const allowedOrigins = process.env.CORS_ORIGINS.split(',');
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

(async function () {
  try {
    await connectDatabase();
    startServer();
  } catch (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  }
})();

app.use("/api", routes);

app.use((err, req, res, next) => {
  console.error('Application error:', err);
  res.status(err.status || 500).json({
    error: isProduction ? 'Internal server error' : err.message
  });
});

function startServer() {
  const server = app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT} in ${NODE_ENV} mode`);

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

  const gracefulShutdown = (force = false) => {
    if (!force && !isNightTime()) {
      return;
    }

    console.log("Shutting down server...");
    server.close(() => {
      console.log("Server closed gracefully");
      if (global.cleanupInterval) clearInterval(global.cleanupInterval);
      process.exit(0);
    });

    setTimeout(() => {
      console.error("Forcing server shutdown after timeout");
      process.exit(1);
    }, 30000);
  };

  process.on("SIGINT", () => gracefulShutdown(true));
  process.on("SIGTERM", () => gracefulShutdown(true));
  process.on("uncaughtException", (error) => {
    console.error("Uncaught exception:", error);
    gracefulShutdown();
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

  return server;
}