const User = require("../models/User");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { encryptText, decryptText, hashUsername } = require("../utils/encryption");

function sendError(res, status, message, error = null) {
  const payload = { message };
  if (error) payload.error = error.message || error;
  return res.status(status).json(payload);
}

async function findExistingUser(email, usernameHash) {
  return await User.findOne({ $or: [{ email }, { usernameHash }] });
}

exports.register = async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const usernameHash = hashUsername(username);

    const existingUser = await findExistingUser(email, usernameHash);
    if (existingUser) {
      if (existingUser.email === email) {
        return sendError(res, 400, "The email address you entered is already registered. Please use a different email.");
      }
      return sendError(res, 400, "The username you entered is already taken. Please choose another username.");
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

    res.status(201).json({ message: "Registration successful! You can now log in." });
  } catch (error) {
    console.error("❌ Registration Error:", error);
    sendError(res, 500, "An unexpected server error occurred during registration. Please try again later.", error);
  }
};

exports.login = async (req, res) => {
  try {
    const { username, password } = req.body;
    const usernameHash = hashUsername(username);

    const user = await User.findOne({ usernameHash });
    if (!user) {
      return sendError(res, 401, "No account found with that username.");
    }
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return sendError(res, 401, "Incorrect password. Please try again.");
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
    sendError(res, 500, "An unexpected server error occurred during login. Please try again later.", error);
  }
};

exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password");
    if (!user) return sendError(res, 404, "User not found. Please log in again.");
    res.json(user);
  } catch (error) {
    console.error("❌ Error fetching user:", error);
    sendError(res, 500, "An error occurred while fetching user details. Please try again later.", error);
  }
};