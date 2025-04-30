// src/routes/index.js
const express = require("express");
const router = express.Router();
const authRoutes = require("./authRoutes");
const chatRoutes = require("./chatRoutes");
const feedbackRoutes = require("./feedbackRoutes");
const healthRoutes = require("./healthRoutes");
const { rateLimiter } = require("../middleware");

router.use("/health", healthRoutes);
router.use("/auth", rateLimiter.standard, authRoutes);
router.use("/chat", rateLimiter.chat, chatRoutes);
router.use("/feedback", feedbackRoutes);

router.get("/", (req, res) => {
    res.json({
        message: "Juris-Backend API",
        version: "1.0.0",
        status: "online",
        worker: process.pid,
        timestamp: new Date().toISOString(),
    });
});

module.exports = router;