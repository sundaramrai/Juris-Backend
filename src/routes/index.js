import express from "express";
import authRoutes from "./authRoutes.js";
import chatRoutes from "./chatRoutes.js";
import feedbackRoutes from "./feedbackRoutes.js";
import healthCheckRoutes from "./healthCheck.js";

const router = express.Router();

router.use("/", authRoutes);
router.use("/chat", chatRoutes);
router.use("/feedback", feedbackRoutes);
router.use("/health", healthCheckRoutes);

export default router;
