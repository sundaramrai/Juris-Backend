const User = require("../models/User");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { encryptText, decryptText, hashUsername } = require("../utils/encryption");
const crypto = require("node:crypto");


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