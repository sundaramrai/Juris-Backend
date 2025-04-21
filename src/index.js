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
const app = express();
validateEnvVars();
app.use(helmet());
app.use(compression());

const corsOptions = {
  origin: function (origin, callback) {
    if (!origin || origin.startsWith('http://localhost:')) {
      return callback(null, true);
    }
    const allowedOrigins = process.env.CORS_ORIGINS.split(',');
    if (allowedOrigins.indexOf(origin) !== -1) {
      callback(null, true);
    } else {
      console.log(`CORS blocked origin: ${origin}`);
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true
};

app.use(cors(corsOptions));
app.use(express.json({ limit: '10mb' }));

(async function () {
  try {
    await connectDatabase();
  } catch (err) {
    console.error('Database connection failed:', err);
    process.exit(1);
  }
})();

app.use("/api", routes);

app.use((err, res) => {
  console.error('Application error:', err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'Internal server error' : err.message
  });
});

const server = app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);

  const { startCleanupInterval } = require("./services/cleanupService");
  global.cleanupInterval = startCleanupInterval(60);
});

server.timeout = TIMEOUT;
server.keepAliveTimeout = TIMEOUT;
server.headersTimeout = TIMEOUT;

server.on("connection", (socket) => {
  socket.setTimeout(TIMEOUT);
});

const gracefulShutdown = () => {
  console.log("Shutting down server...");
  server.close(() => {
    console.log("Server closed");
    if (global.cleanupInterval) clearInterval(global.cleanupInterval);
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forcing server shutdown");
    process.exit(1);
  }, 30000);
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
  gracefulShutdown();
});

server.on('error', (error) => {
  console.error('Server error:', error);
});