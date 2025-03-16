// src/routes/index.js
const express = require("express");
const router = express.Router();
const authRoutes = require("./authRoutes");
const chatRoutes = require("./chatRoutes");
const feedbackRoutes = require("./feedbackRoutes");

router.use("/auth", authRoutes);
router.use("/chat", chatRoutes);
router.use("/feedback", feedbackRoutes);

module.exports = router;