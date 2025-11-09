import Feedback from "../models/Feedback.js";
import { encryptText, decryptText } from "../utils/encryption.js";

export async function submitFeedback(req, res) {
  try {
    const { improvements, issues, satisfaction } = req.body;
    const userId = req.user.userId;
    if (!improvements || !issues || satisfaction === undefined) {
      return res.status(400).json({ message: "All fields are required" });
    }
    if (satisfaction < 1 || satisfaction > 5) {
      return res
        .status(400)
        .json({ message: "Satisfaction must be between 1 and 5" });
    }

    const encryptedImprovements = encryptText(improvements);
    const encryptedIssues = encryptText(issues);

    let feedback = await Feedback.findOne({ userId });
    if (!feedback) {
      feedback = new Feedback({ userId, feedback: [] });
    }
    feedback.feedback.push({
      satisfaction,
      issues: encryptedIssues,
      improvements: encryptedImprovements,
    });
    await feedback.save();

    res.status(201).json({ message: "Feedback submitted successfully" });
  } catch (error) {
    console.error("Error submitting feedback:", error);
    res.status(500).json({ message: "Error submitting feedback" });
  }
}

export async function getFeedback(req, res) {
  try {
    const userId = req.user.userId;
    const feedback = await Feedback.findOne({ userId });
    if (!feedback) {
      return res.json({ feedback: [] });
    }
    const decryptedFeedback = feedback.feedback.map((entry) => ({
      satisfaction: entry.satisfaction,
      issues: decryptText(entry.issues),
      improvements: decryptText(entry.improvements),
    }));
    res.json({ feedback: decryptedFeedback });
  } catch (error) {
    console.error("Error fetching feedback:", error);
    res.status(500).json({ message: "Error fetching feedback" });
  }
}
