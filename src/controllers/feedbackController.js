// src/controllers/feedbackController.js
const Feedback = require("../models/Feedback");

const submitFeedback = async (req, res) => {
  try {
    const { improvements, issues, satisfaction } = req.body;
    const userId = req.user.userId;
    if (!improvements || !issues || satisfaction === undefined) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (satisfaction < 1 || satisfaction > 5) {
      return res.status(400).json({ message: "Satisfaction must be between 1 and 5" });
    }
    let feedback = await Feedback.findOne({ userId });
    if (!feedback) {
      feedback = new Feedback({ userId, feedback: [] });
    }
    feedback.feedback.push({ improvements, issues, satisfaction });
    await feedback.save();
    res.status(201).json({ message: "Feedback submitted successfully" });
  } catch (error) {
    console.error("❌ Error submitting feedback:", error);
    res.status(500).json({ message: "Error submitting feedback" });
  }
};

module.exports = {
  submitFeedback
};