import express from "express";
import * as chatController from "../controllers/chatController.js";
import { authenticateToken } from "../middleware/auth.js";

const router = express.Router();

router.post("/", authenticateToken, chatController.processChat);
router.get("/all", authenticateToken, chatController.getAllChats);
router.get(
    "/history/:chatId",
    authenticateToken,
    chatController.getChatHistory
);
router.delete(
    "/history/:chatId",
    authenticateToken,
    chatController.clearChatHistory
);
router.post("/new", authenticateToken, chatController.createNewChat);
router.patch(
    "/title/:chatId",
    authenticateToken,
    chatController.updateChatTitle
);

export default router;
