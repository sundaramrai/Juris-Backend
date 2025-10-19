const express = require("express");
const router = express.Router();
const feedbackController = require("../controllers/feedbackController");
const { authenticateToken } = require("../middleware/auth");

router.post("/", authenticateToken, feedbackController.submitFeedback);
router.get("/", authenticateToken, feedbackController.getFeedback);

module.exports = router;