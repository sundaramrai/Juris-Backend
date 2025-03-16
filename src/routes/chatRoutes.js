// src/routes/chatRoutes.js
const express = require("express");
const router = express.Router();
const { processChat, getChatHistory, clearChatHistory } = require("../controllers/chatController");
const { authenticateToken } = require("../middleware/auth");

router.post("/", authenticateToken, processChat);
router.get("/history", authenticateToken, getChatHistory);
router.delete("/history", authenticateToken, clearChatHistory);

module.exports = router;