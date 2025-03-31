// src/routes/chatRoutes.js
const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const { authenticateToken } = require("../middleware/auth");

router.post("/", authenticateToken, chatController.processChat);
router.get("/history", authenticateToken, chatController.getChatHistory);
router.delete("/history", authenticateToken, chatController.clearChatHistory);

module.exports = router;