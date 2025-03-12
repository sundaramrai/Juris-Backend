const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const { GoogleGenerativeAI } = require("@google/generative-ai");
require("dotenv").config();

const app = express();
const corsOptions = {
  origin : "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

mongoose
  .connect(MONGO_URI, {
    useNewUrlParser: true,
    useUnifiedTopology: true,
    serverSelectionTimeoutMS: 10000,
  })
  .then(() => console.log("✅ MongoDB Connected Successfully"))
  .catch((err) => {
    console.error("❌ MongoDB Connection Error:", err.message);
    process.exit(1);
  });

const userSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  username: { type: String, required: true, unique: true },
  password: { type: String, required: true },
});
const User = mongoose.model("User", userSchema);

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
const Chat = mongoose.model("Chat", chatSchema);

const FeedbackSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  feedback: [{
    satisfaction: { type: Number, required: true, min: 1, max: 5 },
    issues: { type: String, required: true },
    improvements: { type: String, required: true },
  }]
});
const Feedback = mongoose.model('Feedback', FeedbackSchema);

const authenticateToken = (req, res, next) => {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ message: "No token provided" });
  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ message: "Invalid token" });
    req.user = decoded;
    next();
  });
};

async function generateGeminiResponse(prompt) {
  try {
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
  } catch (error) {
    console.error("❌ Error generating Gemini response:", error);
    // Check if error message indicates recitation block.
    if (error.message && error.message.includes("RECITATION")) {
      // Append an instruction to avoid recitation.
      const fallbackPrompt = prompt + "\nNote: Please provide an original analysis without reciting any pre-existing legal texts or copyrighted material.";
      try {
        const resultFallback = await model.generateContent(fallbackPrompt);
        const responseFallback = await resultFallback.response;
        return responseFallback.text();
      } catch (fallbackError) {
        console.error("❌ Fallback Error generating Gemini response:", fallbackError);
        return "I'm sorry, I encountered an error processing your request.";
      }
    }
    return "I'm sorry, I encountered an error processing your request.";
  }
}

async function generateChatSummary(messages) {
  const chatText = messages
    .map((msg) => `${msg.type === "user" ? "User" : "Bot"}: ${msg.text}`)
    .join("\n");
  const prompt = `Provide a very short summary of the following chat conversation in exactly 5-6 words (no more than 6 words):\n${chatText}`;
  try {
    let summary = await generateGeminiResponse(prompt);
    const words = summary.trim().split(/\s+/);
    if (words.length > 6) {
      summary = words.slice(0, 6).join(" ");
    }
    return summary;
  } catch (error) {
    console.error("❌ Error generating chat summary:", error);
    return "Summary unavailable";
  }
}

// Updated isLegalQuery using regex word boundaries for better matching.
function isLegalQuery(query) {
  const legalKeywords = [
    "law", "legal", "act", "section", "court", "constitution",
    "rights", "criminal", "civil", "contract", "divorce", "property",
    "injunction", "notice", "case", "litigation", "dispute", "judicial",
    "article", "accident", "injury", "traffic"
  ];
  const q = query.toLowerCase();
  return legalKeywords.some(keyword => new RegExp(`\\b${keyword}\\b`).test(q));
}

app.post("/api/register", async (req, res) => {
  try {
    const { email, username, password, confirmPassword } = req.body;
    if (password !== confirmPassword) {
      return res.status(400).json({ message: "Passwords do not match" });
    }
    const existingUser = await User.findOne({ $or: [{ email }, { username }] });
    if (existingUser) {
      return res.status(400).json({
        message: existingUser.email === email ? "Email already exists" : "Username already exists",
      });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({ email, username, password: hashedPassword });
    await user.save();
    res.status(201).json({ message: "User registered successfully" });
  } catch (error) {
    console.error("❌ Registration Error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const token = jwt.sign({ userId: user._id, username: user.username }, JWT_SECRET, { expiresIn: "12h" });
    res.json({ token, user: { username: user.username, email: user.email, id: user._id } });
  } catch (error) {
    console.error("❌ Login Error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});

app.get("/api/user", authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.user.userId).select("-password");
    if (!user) return res.status(404).json({ message: "User not found" });
    res.json(user);
  } catch (error) {
    console.error("❌ Error fetching user:", error);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/chat", authenticateToken, async (req, res) => {
  try {
    const { message } = req.body;
    const userId = req.user.userId;
    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }
    // Determine if query is legally related.
    const legalFlag = isLegalQuery(message);
    let prompt;
    if (!legalFlag) {
      // Even if the query is only slightly related, we attempt to provide a legal perspective.
      prompt = `
You are Juris, an AI Legal Assistance Chatbot for Indian Citizens. Although the query does not appear strictly legal-related, please provide a response from a legal perspective using Indian law. Use the following structured format:

Title: [Short Title Reflecting the Query]

Summary:
  - A brief overview of the legal issue.

Relevant Legal Provisions:
  - List the specific acts, sections, or legal precedents relevant to the query.

Analysis:
  - Detailed explanation of how the law applies to the query.

Conclusion:
  - Summarize the main points and provide a clear answer.

Disclaimer:
  - "Disclaimer: I am an AI legal assistance tool and my responses are for informational purposes only. They do not constitute legal advice. For personalized legal advice, please consult a qualified legal professional."

Query: ${message}

Please provide your answer.
      `;
    } else {
      prompt = `
You are Juris, an AI Legal Assistance Chatbot for Indian Citizens. You answer legal queries using Indian law. Please provide your response in the following structured format:

Title: [Short Title Reflecting the Query]

Summary:
  - A brief overview of the legal issue.

Relevant Legal Provisions:
  - List the specific acts, sections, or legal precedents relevant to the query.

Analysis:
  - Detailed explanation of how the law applies to the query.

Conclusion:
  - Summarize the main points and provide a clear answer.

Disclaimer:
  - "Disclaimer: I am an AI legal assistance tool and my responses are for informational purposes only. They do not constitute legal advice. For personalized legal advice, please consult a qualified legal professional."

Query: ${message}

Please provide your answer.
      `;
    }
    const botResponse = await generateGeminiResponse(prompt);
    let chat = await Chat.findOne({ userId });
    if (!chat) {
      chat = new Chat({ userId, messages: [] });
    }
    const currentTime = new Date();
    chat.messages.push({ type: "user", text: message, time: currentTime });
    chat.messages.push({ type: "bot", text: botResponse, time: currentTime });
    chat.chatSummary = await generateChatSummary(chat.messages);
    await chat.save();
    res.json({ userMessage: message, botResponse, chatSummary: chat.chatSummary });
  } catch (error) {
    console.error("❌ Error processing chat:", error);
    res.status(500).json({ message: "Error processing chat" });
  }
});

app.post("/api/feedback", authenticateToken, async (req, res) => {
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
});

app.get("/api/chat/history", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const chat = await Chat.findOne({ userId });
    if (!chat) {
      return res.json({ messages: [], chatSummary: "" });
    }
    res.json({ 
      messages: chat.messages, 
      chatSummary: chat.chatSummary || "",
    });
  } catch (error) {
    console.error("❌ Error fetching chat history:", error);
    res.status(500).json({ message: "Error fetching chat history" });
  }
});

app.delete("/api/chat/history", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    await Chat.findOneAndDelete({ userId });
    res.json({ message: "Chat history cleared" });
  } catch (error) {
    console.error("❌ Error clearing chat history:", error);
    res.status(500).json({ message: "Error clearing chat history" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`✅ API Endpoints available at http://localhost:${PORT}/api`);
});
