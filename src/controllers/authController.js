const User = require("../models/User");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { encryptText, decryptText, hashUsername } = require("../utils/encryption");
const { transporter } = require("../config/email");
const crypto = require("node:crypto");

const otpStorage = new Map();

function generateOTP() {
  return crypto.randomInt(100000, 999999).toString();
}

function sendOTPEmail(email, otp) {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: email,
    subject: 'Verify Your Email - Juris Legal AI Registration',
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
        <div style="text-align: center; padding: 20px; background-color: #f4f4f4; border-bottom: 2px solid #007bff;">
          <h1 style="color: #007bff; margin: 0;">Juris Legal AI</h1>
          <p style="margin: 0; font-size: 16px;">Your Trusted Legal Assistance Platform</p>
        </div>
        <div style="padding: 20px;">
          <h2 style="color: #007bff;">Email Verification</h2>
          <p>Dear User,</p>
          <p>Thank you for registering with Juris Legal AI. To complete your registration, please use the following One-Time Password (OTP):</p>
          <div style="text-align: center; margin: 20px 0;">
            <span style="font-size: 24px; font-weight: bold; color: #007bff;">${otp}</span>
          </div>
          <p>This OTP is valid for <strong>10 minutes</strong>. Please enter it on the registration page to verify your email address.</p>
          <p>If you did not request this email, please ignore it. Your account will not be created unless the OTP is used.</p>
        </div>
        <div style="text-align: center; padding: 10px; background-color: #f4f4f4; border-top: 2px solid #007bff;">
          <p style="margin: 0; font-size: 14px; color: #555;">&copy; ${new Date().getFullYear()} Juris Legal AI. All rights reserved.</p>
        </div>
      </div>
    `
  };

  return transporter.sendMail(mailOptions);
}

exports.register = async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const usernameHash = hashUsername(username);

    const existingUser = await User.findOne({ $or: [{ email }, { usernameHash }] });
    if (existingUser) {
      return res.status(400).json({
        message: existingUser.email === email ? "Email already exists" : "Username already exists",
      });
    }

    const encryptedEmail = encryptText(email);
    const encryptedUsername = encryptText(username);
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      email: encryptedEmail,
      username: encryptedUsername,
      usernameHash,
      password: hashedPassword,
    });
    await user.save();

    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    console.error("❌ Registration Error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;
    const usernameHash = hashUsername(username);

    const user = await User.findOne({ usernameHash });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const token = jwt.sign(
      { userId: user._id, username: decryptText(user.username) },
      process.env.JWT_SECRET,
      { expiresIn: "12h" }
    );
    const decryptedEmail = decryptText(user.email);

    res.json({
      token,
      user: {
        username: decryptText(user.username),
        email: decryptedEmail,
        id: user._id,
      },
    });
  } catch (error) {
    console.error("❌ Login Error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (error) {
    console.error("❌ Error fetching user:", error);
    res.status(500).json({ message: "Server error" });
  }
};

exports.requestOTP = async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const usernameHash = hashUsername(username);

    const existingUser = await User.findOne({ $or: [{ email }, { usernameHash }] });
    if (existingUser) {
      return res.status(400).json({
        message: existingUser.email === email ? "Email already exists" : "Username already exists",
      });
    }

    const otp = generateOTP();
    const otpExpiry = Date.now() + 10 * 60 * 1000;

    otpStorage.set(email, {
      otp: crypto.createHmac('sha256', process.env.OTP_SECRET).update(otp).digest('hex'),
      expiry: otpExpiry,
      userData: { email, username, password }
    });

    await sendOTPEmail(email, otp);

    res.status(200).json({ message: "OTP sent successfully", email });
  } catch (error) {
    console.error("❌ OTP Request Error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};

exports.verifyOTP = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const otpData = otpStorage.get(email);

    if (!otpData) {
      return res.status(400).json({ message: "No OTP request found" });
    }

    if (Date.now() > otpData.expiry) {
      otpStorage.delete(email);
      return res.status(400).json({ message: "OTP has expired" });
    }

    const hashedOTP = crypto.createHmac('sha256', process.env.OTP_SECRET).update(otp).digest('hex');
    if (hashedOTP !== otpData.otp) {
      return res.status(400).json({ message: "Invalid OTP" });
    }
    const { username, password } = otpData.userData;
    const usernameHash = hashUsername(username);

    const encryptedEmail = encryptText(email);
    const encryptedUsername = encryptText(username);
    const hashedPassword = await bcrypt.hash(password, 10);

    const user = new User({
      email: encryptedEmail,
      username: encryptedUsername,
      usernameHash,
      password: hashedPassword,
    });
    await user.save();

    otpStorage.delete(email);

    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    console.error("❌ OTP Verification Error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};