// src/config/encryption.js
require("dotenv").config();

module.exports = {
  ENCRYPTION_KEY: process.env.ENCRYPTION_KEY,
  JWT_SECRET: process.env.JWT_SECRET,
  algorithm: 'aes-256-gcm',
  IV_LENGTH: 16
};