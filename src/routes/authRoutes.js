const express = require("express");
const router = express.Router();
const authController = require("../controllers/authController");
const { authenticateToken } = require("../middleware/auth");

router.post("/register", authController.register);
router.post("/login", authController.login);
router.get("/user", authenticateToken, authController.getUser);
router.post("/register/request-otp", authController.requestOTP);
router.post("/register/verify-otp", authController.verifyOTP);

module.exports = router;