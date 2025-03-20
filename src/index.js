// src/index.js
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcrypt");
const mongoose = require("mongoose");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const crypto = require("crypto");
require("dotenv").config();

const requiredEnvVars = [
  "MONGO_URI",
  "JWT_SECRET",
  "GEMINI_API_KEY",
  "ENCRYPTION_KEY",
  "USERNAME_HASH_SALT"
];
const missingVars = requiredEnvVars.filter(key => !process.env[key]);
if (missingVars.length > 0) {
  console.error("Missing environment variables:", missingVars.join(', '));
  process.exit(1);
}

const app = express();
const corsOptions = {
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(express.json());

const MONGO_URI = process.env.MONGO_URI;
const JWT_SECRET = process.env.JWT_SECRET;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
const USERNAME_HASH_SALT = process.env.USERNAME_HASH_SALT;

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const algorithm = "aes-256-gcm";
const IV_LENGTH = 16;

mongoose
  .connect(MONGO_URI, {
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
  usernameHash: { type: String, required: true, unique: true },
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

function encryptText(text) {
  if (typeof text !== 'string') {
    text = text ? text.toString() : "";
  }
  if (!ENCRYPTION_KEY) {
    throw new Error("ENCRYPTION_KEY environment variable is not defined");
  }
  const keyBuffer = Buffer.from(ENCRYPTION_KEY, 'hex');
  if (keyBuffer.length !== 32) {
    throw new Error("Invalid ENCRYPTION_KEY length. It must be a 64-character hex string representing 32 bytes.");
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(algorithm, keyBuffer, iv);
  let encrypted = cipher.update(text, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');
  return iv.toString('hex') + ':' + encrypted + ':' + authTag;
}

function decryptText(encryptedText) {
  const parts = encryptedText.split(':');
  if (parts.length !== 3) {
    throw new Error("Invalid encrypted text format");
  }
  const iv = Buffer.from(parts[0], 'hex');
  const encrypted = parts[1];
  const authTag = Buffer.from(parts[2], 'hex');
  const decipher = crypto.createDecipheriv(algorithm, Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  decipher.setAuthTag(authTag);
  let decrypted = decipher.update(encrypted, 'hex', 'utf8');
  decrypted += decipher.final('utf8');
  return decrypted;
}

function hashUsername(username) {
  return crypto
    .createHmac("sha256", USERNAME_HASH_SALT)
    .update(username.toLowerCase().trim())
    .digest("hex");
}

async function generateGeminiResponse(prompt) {
  const attemptResponse = async (modPrompt) => {
    const result = await model.generateContent(modPrompt);
    const response = await result.response;
    return response.text();
  };

  const promptAttempts = [
    prompt,
    prompt + "\n\nIMPORTANT: Generate a completely original analysis. Do not quote or recite any legal texts or excerpts. Provide a precise, synthesized explanation entirely in your own words.",
    prompt + "\n\nIMPORTANT: DO NOT include any verbatim legal text. Synthesize a fully original and accurate explanation by summarizing the legal principles in your own words without reciting any existing legal material."
  ];

  for (let i = 0; i < promptAttempts.length; i++) {
    try {
      const responseText = await attemptResponse(promptAttempts[i]);
      return responseText;
    } catch (error) {
      console.error(`❌ Error in attempt ${i + 1}:`, error);
      if (!(error.message && error.message.includes("RECITATION"))) {
        return "I'm sorry, I encountered an error processing your request.";
      }
    }
  }
  return "I'm sorry, I'm unable to generate a response due to restrictions on reciting pre-existing legal texts.";
}

async function generateChatSummary(messages) {
  const chatText = messages
    .map((msg) => `${msg.type === "user" ? "User:" : "Bot:"} ${msg.text}`)
    .join("\n");

  const prompt = `Write a concise, highly accurate summary of the following chat conversation in exactly 6 words. Each word must be essential and there should be no extra text or punctuation beyond the six words.

Chat Conversation:
${chatText}`;

  try {
    let summary = await generateGeminiResponse(prompt);
    summary = summary.trim();
    summary = summary.replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, " ");
    const words = summary.split(" ");
    if (words.length > 6) {
      summary = words.slice(0, 6).join(" ");
    }
    return summary;
  } catch (error) {
    console.error("❌ Error generating chat summary:", error);
    return "Summary unavailable";
  }
}

function isLegalQuery(query) {
  const legalKeywords = [
    "law", "legal", "act", "section", "court", "constitution",
    "rights", "criminal", "civil", "contract", "divorce", "property",
    "injunction", "notice", "case", "litigation", "dispute", "judicial",
    "article", "accident", "injury", "traffic", "offence", "arrest",
    "bail", "sentence", "appeal", "petition", "writ", "hearing",
    "tribunal", "authority", "jurisdiction", "complaint", "plaintiff",
    "defendant", "litigants", "litigant", "legal", "lawyer", "advocate",
    "attorney", "counsel", "solicitor", "barrister", "judge", "justice",
    "trial", "order", "judgment", "decree", "argument", "plea",
    "evidence", "proof", "document", "affidavit", "oath", "affirmation",
    "perjury", "witness", "deposition", "examination", "cross-examination",
    "testimony", "verdict"
  ];
  const q = query.toLowerCase();
  return legalKeywords.some(keyword => new RegExp(`\\b${keyword}\\b`).test(q));
}

app.post("/api/register", async (req, res) => {
  try {
    const { email, username, password } = req.body;
    const usernameHash = hashUsername(username);

    const existingUser = await User.findOne({ $or: [{ email }, { usernameHash }] });
    if (existingUser) {
      return res.status(400).json({
        message: existingUser.email === email ? "Email already exists" : "Username already exists",
      });
    }

    const encryptedEmail = encryptText(email);
    const encryptedUsername = encryptText(username);
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = new User({
      email: encryptedEmail,
      username: encryptedUsername,
      usernameHash,
      password: hashedPassword,
    });
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
    const usernameHash = hashUsername(username);

    const user = await User.findOne({ usernameHash });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
    const token = jwt.sign(
      { userId: user._id, username: decryptText(user.username) },
      JWT_SECRET,
      { expiresIn: "12h" }
    );
    const decryptedEmail = decryptText(user.email);

    res.json({
      token,
      user: {
        username: decryptText(user.username),
        email: decryptedEmail,
        id: user._id,
      },
    });
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

    const legalFlag = isLegalQuery(message);
    if (!legalFlag) {
      return res.json({
        userMessage: message,
        botResponse: "**This query does not appear to be related to legal matters. Please ask questions related to legal queries for accurate guidance.**",
        chatSummary: "Non-legal query detected."
      });
    }

    const prompt = `
You are Juris, an AI Legal Assistance Chatbot for Indian Citizens. You answer legal queries using Indian law with exceptional accuracy by leveraging advanced language models (similar to those used by Gemini, Claude, or OpenAI). Please provide your response in the following structured format:

1. **Title:** [A short title reflecting the query]
2. **Summary:** A brief overview of the legal issue.
3. **Relevant Legal Provisions:** List the specific acts, sections, or legal precedents relevant to the query.
4. **Analysis:** A detailed explanation of how the law applies to the query.
5. **Real life incidents:** Provide examples of real-life incidents related to this query in India.
6. **Conclusion:** Summarize the main points and provide a clear answer.
7. **References:** Cite any relevant sources or legal references.

Query: ${message}

Please provide your answer.
    `;

    let botResponseRaw = await generateGeminiResponse(prompt);
    const botResponse = botResponseRaw ? botResponseRaw : "I'm sorry, I encountered an error generating a response.";
    const currentTime = new Date();

    const userMessagePlain = { type: "user", text: message, time: currentTime };
    const botMessagePlain = { type: "bot", text: botResponse, time: currentTime };

    let chat = await Chat.findOne({ userId });
    let plainMessagesForSummary = [];
    if (chat) {
      plainMessagesForSummary = chat.messages.map(m => ({
        type: m.type,
        text: decryptText(m.text),
        time: m.time
      }));
      plainMessagesForSummary.push(userMessagePlain, botMessagePlain);
      chat.messages.push({ type: "user", text: encryptText(message), time: currentTime });
      chat.messages.push({ type: "bot", text: encryptText(botResponse), time: currentTime });
    } else {
      plainMessagesForSummary = [userMessagePlain, botMessagePlain];
      chat = new Chat({
        userId,
        messages: [
          { type: "user", text: encryptText(message), time: currentTime },
          { type: "bot", text: encryptText(botResponse), time: currentTime }
        ]
      });
    }

    const summaryPlain = await generateChatSummary(plainMessagesForSummary);
    chat.chatSummary = encryptText(summaryPlain);
    await chat.save();

    res.json({ userMessage: message, botResponse, chatSummary: summaryPlain });
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

    const encryptedImprovements = encryptText(improvements);
    const encryptedIssues = encryptText(issues);

    let feedback = await Feedback.findOne({ userId });
    if (!feedback) {
      feedback = new Feedback({ userId, feedback: [] });
    }
    feedback.feedback.push({
      satisfaction,
      issues: encryptedIssues,
      improvements: encryptedImprovements
    });
    await feedback.save();

    res.status(201).json({ message: "Feedback submitted successfully" });
  } catch (error) {
    console.error("❌ Error submitting feedback:", error);
    res.status(500).json({ message: "Error submitting feedback" });
  }
});

app.get("/api/feedback", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const feedback = await Feedback.findOne({ userId });
    if (!feedback) {
      return res.json({ feedback: [] });
    }
    const decryptedFeedback = feedback.feedback.map(entry => ({
      satisfaction: entry.satisfaction,
      issues: decryptText(entry.issues),
      improvements: decryptText(entry.improvements)
    }));
    res.json({ feedback: decryptedFeedback });
  } catch (error) {
    console.error("❌ Error fetching feedback:", error);
    res.status(500).json({ message: "Error fetching feedback" });
  }
});

app.get("/api/chat/history", authenticateToken, async (req, res) => {
  try {
    const userId = req.user.userId;
    const chat = await Chat.findOne({ userId });
    if (!chat) {
      return res.json({ messages: [], chatSummary: "" });
    }
    const decodedMessages = chat.messages.map(m => ({
      ...m.toObject(),
      text: decryptText(m.text)
    }));
    const decodedSummary = chat.chatSummary ? decryptText(chat.chatSummary) : "";
    res.json({ messages: decodedMessages, chatSummary: decodedSummary });
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
});
