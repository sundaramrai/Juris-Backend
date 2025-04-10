// src/controllers/chatController.js
const Chat = require("../models/Chat");
const { v4: uuidv4 } = require("uuid");
const { encryptText, decryptText } = require("../utils/encryption");
const { isLegalQuery, generateGeminiResponse, generateChatSummary } = require("../services/aiService");

exports.processChat = async (req, res) => {
  try {
    const { message, chatId } = req.body;
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

    let chat;
    if (chatId) {
      chat = await Chat.findOne({ userId, chatId });
    }
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
      const newChatId = chatId || uuidv4();
      plainMessagesForSummary = [userMessagePlain, botMessagePlain];
      chat = new Chat({
        userId,
        chatId: newChatId,
        messages: [
          { type: "user", text: encryptText(message), time: currentTime },
          { type: "bot", text: encryptText(botResponse), time: currentTime }
        ]
      });
    }

    if (!chat.title || chat.title === "New Chat") {
      const titleMatch = botResponse.match(/\*\*Title:\*\*\s*(.*?)(?:\n|$)/i) ||
        botResponse.match(/^Title:\s*(.*?)(?:\n|$)/i);
      if (titleMatch && titleMatch[1]) {
        chat.title = titleMatch[1].trim().substring(0, 100);
      }
    }

    const summaryPlain = await generateChatSummary(plainMessagesForSummary);
    chat.chatSummary = summaryPlain ? encryptText(summaryPlain) : "";
    await chat.save();

    res.json({ chatId: chat.chatId, userMessage: message, botResponse, chatSummary: summaryPlain, title: chat.title });
  } catch (error) {
    console.error("❌ Error processing chat:", error);
    res.status(500).json({ message: "Error processing chat" });
  }
};

exports.getAllChats = async (req, res) => {
  try {
    const userId = req.user.userId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const skip = (page - 1) * limit;

    const chats = await Chat.find({ userId })
      .sort({ updatedAt: -1 })
      .skip(skip)
      .limit(limit)
      .select('chatId title chatSummary createdAt updatedAt messages')
      .maxTimeMS(30000);

    const formattedChats = chats
      .filter(chat => chat.messages && chat.messages.length > 0)
      .map(chat => ({
        chatId: chat.chatId,
        title: chat.title,
        summary: chat.chatSummary ? decryptText(chat.chatSummary) : "",
        messageCount: chat.messages.length,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt
      }));

    res.json({
      chats: formattedChats,
      pagination: {
        page,
        limit,
        hasMore: chats.length === limit
      }
    });
  } catch (error) {
    console.error("❌ Error fetching all chats:", error);
    res.status(500).json({ message: "Error fetching chats. Please try again." });
  }
};

exports.getChatHistory = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { chatId } = req.params;

    if (!chatId) {
      return res.status(400).json({ message: "Chat ID is required" });
    }
    const chat = await Chat.findOne({ userId, chatId });
    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }
    const decodedMessages = chat.messages.map(m => ({
      ...m.toObject(),
      text: decryptText(m.text)
    }));
    const decodedSummary = chat.chatSummary ? decryptText(chat.chatSummary) : "";
    res.json({
      chatId: chat.chatId,
      title: chat.title,
      messages: decodedMessages,
      chatSummary: decodedSummary
    });
  } catch (error) {
    console.error("❌ Error fetching chat history:", error);
    res.status(500).json({ message: "Error fetching chat history" });
  }
};

exports.clearChatHistory = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { chatId } = req.params;

    if (!chatId) {
      return res.status(400).json({ message: "Chat ID is required" });
    }
    const chat = await Chat.findOneAndUpdate(
      { userId, chatId },
      { $set: { messages: [], chatSummary: "" } },
      { new: true }
    );

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    res.json({ message: "Chat history cleared" });
  } catch (error) {
    console.error("❌ Error clearing chat history:", error);
    res.status(500).json({ message: "Error clearing chat history" });
  }
};

exports.cleanupEmptyChats = async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    const result = await Chat.deleteMany({ "messages": { $size: 0 } });

    res.json({
      message: "Cleanup completed",
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error("❌ Error during manual chat cleanup:", error);
    res.status(500).json({ message: "Error during cleanup" });
  }
};

exports.createNewChat = async (req, res) => {
  try {
    const userId = req.user.userId;
    const chatId = uuidv4();

    const newChat = new Chat({
      userId,
      chatId,
      title: "New Chat",
      messages: []
    });

    await newChat.save();
    res.json({
      chatId: newChat.chatId,
      title: newChat.title,
      messages: [],
      chatSummary: ""
    });
  } catch (error) {
    console.error("❌ Error creating new chat:", error);
    res.status(500).json({ message: "Error creating new chat" });
  }
};

exports.updateChatTitle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { chatId } = req.params;
    const { title } = req.body;

    if (!chatId) {
      return res.status(400).json({ message: "Chat ID is required" });
    }

    if (!title) {
      return res.status(400).json({ message: "Title is required" });
    }

    const chat = await Chat.findOneAndUpdate(
      { userId, chatId },
      { title },
      { new: true }
    );

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    res.json({ chatId: chat.chatId, title: chat.title });
  } catch (error) {
    console.error("❌ Error updating chat title:", error);
    res.status(500).json({ message: "Error updating chat title" });
  }
};