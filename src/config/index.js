// src/config/index.js
const connectDatabase = require("./database");
const encryption = require("./encryption");

module.exports = {
  connectDatabase,
  encryption,
  GEMINI_API_KEY: process.env.GEMINI_API_KEY
};