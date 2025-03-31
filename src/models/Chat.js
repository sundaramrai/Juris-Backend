// src/models/Chat.js
const mongoose = require("mongoose");

const chatSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  messages: [
    {
      type: { type: String, enum: ["user", "bot"], required: true },
      text: { type: String, required: true },
      time: { type: Date, default: Date.now },
    },
  ],
  chatSummary: { type: String },
});

module.exports = mongoose.model("Chat", chatSchema);