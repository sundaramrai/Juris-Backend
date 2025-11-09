import mongoose from "mongoose";

const FeedbackSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  feedback: [
    {
      satisfaction: { type: Number, required: true, min: 1, max: 5 },
      issues: { type: String, required: true },
      improvements: { type: String, required: true },
    },
  ],
});

export default mongoose.model("Feedback", FeedbackSchema);
