const mongoose = require("mongoose");

const chatSchema = new mongoose.Schema({
  userId: {
    type: String,
    required: true
  },
  chatId: {
    type: String,
    required: true,
    unique: true
  },
  title: {
    type: String,
    default: "New Chat"
  },
  messages: [
    {
      type: {
        type: String,
        enum: ["user", "bot"],
        required: true
      },
      text: {
        type: String,
        required: true
      },
      time: {
        type: Date,
        default: Date.now
      }
    }
  ],
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

chatSchema.pre("save", function (next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model("Chat", chatSchema);