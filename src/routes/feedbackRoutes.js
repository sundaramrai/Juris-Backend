import express from "express";
import * as feedbackController from "../controllers/feedbackController.js";
import { authenticateToken } from "../middleware/auth.js";

const router = express.Router();

router.post("/", authenticateToken, feedbackController.submitFeedback);
router.get("/", authenticateToken, feedbackController.getFeedback);

export default router;
