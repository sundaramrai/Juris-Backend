// src/models/Feedback.js
const mongoose = require("mongoose");

const FeedbackSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  feedback: [{
    satisfaction: { type: Number, required: true, min: 1, max: 5 },
    issues: { type: String, required: true },
    improvements: { type: String, required: true },
  }]
});

module.exports = mongoose.model('Feedback', FeedbackSchema);