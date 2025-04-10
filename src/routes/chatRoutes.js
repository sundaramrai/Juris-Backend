// src/routes/chatRoutes.js
const express = require("express");
const router = express.Router();
const chatController = require("../controllers/chatController");
const { authenticateToken } = require("../middleware/auth");

router.post("/", authenticateToken, chatController.processChat);
router.get("/all", authenticateToken, chatController.getAllChats);
router.get("/history/:chatId", authenticateToken, chatController.getChatHistory);
router.delete("/history/:chatId", authenticateToken, chatController.clearChatHistory);
router.post("/new", authenticateToken, chatController.createNewChat);
router.patch("/title/:chatId", authenticateToken, chatController.updateChatTitle);
router.post("/cleanup", authenticateToken, chatController.cleanupEmptyChats);

module.exports = router;