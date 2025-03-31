// src/config/database.js
const mongoose = require("mongoose");

const connectDatabase = () => {
  const MONGO_URI = process.env.MONGO_URI;
  
  mongoose
    .connect(MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    })
    .then(() => console.log("✅ MongoDB Connected Successfully"))
    .catch((err) => {
      console.error("❌ MongoDB Connection Error:", err.message);
      process.exit(1);
    });
};

module.exports = { connectDatabase };