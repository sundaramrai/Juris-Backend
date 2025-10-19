const express = require("express");
const router = express.Router();
const authRoutes = require("./authRoutes");
const chatRoutes = require("./chatRoutes");
const feedbackRoutes = require("./feedbackRoutes");
const healthCheckRoutes = require("./healthCheck");

router.use("/", authRoutes);
router.use("/chat", chatRoutes);
router.use("/feedback", feedbackRoutes);
router.use("/health", healthCheckRoutes);

module.exports = router;