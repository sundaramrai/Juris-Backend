// src/controllers/chatController.js
const Chat = require("../models/Chat");
const { v4: uuidv4 } = require("uuid");
const { encryptText, decryptText } = require("../utils/encryption");
const {
  generateGeminiResponse,
  generateChatSummary,
  processQuery,
  getServiceMetrics,
  withRetry,
  batchProcessQueries
} = require("../services/aiService");

class LRUCache {
  constructor(maxSize = 100, ttlMs = 15 * 60 * 1000) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.stats = { hits: 0, misses: 0, evictions: 0 };
  }

  get(key) {
    if (!this.cache.has(key)) {
      this.stats.misses++;
      return null;
    }

    const item = this.cache.get(key);
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      this.stats.evictions++;
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, item);
    this.stats.hits++;
    return item.value;
  }

  set(key, value) {
    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.stats.evictions++;
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + this.ttlMs
    });
    return value;
  }

  delete(key) {
    return this.cache.delete(key);
  }

  has(key) {
    if (!this.cache.has(key)) return false;
    const item = this.cache.get(key);
    if (Date.now() > item.expiry) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  clear() {
    this.cache.clear();
  }

  keys() {
    return this.cache.keys();
  }

  get size() {
    return this.cache.size;
  }

  getStats() {
    return {
      ...this.stats,
      size: this.cache.size,
      hitRate: this.stats.hits + this.stats.misses > 0
        ? (this.stats.hits / (this.stats.hits + this.stats.misses)) * 100
        : 0
    };
  }
}

const chatCache = new LRUCache(100, 15 * 60 * 1000);
const handleError = (res, error, message, statusCode = 500) => {
  const errorType = error.name || 'GeneralError';
  const errorId = uuidv4().substring(0, 8);

  console.error(`❌ [${errorId}] ${message} (${errorType}):`, error);
  if (error.name === 'AIServiceError') {
    statusCode = 503;
    message = 'AI service temporarily unavailable';
  } else if (error.name === 'ValidationError') {
    statusCode = 400;
  } else if (error.name === 'AuthorizationError') {
    statusCode = 403;
  }

  return res.status(statusCode).json({
    message,
    errorId,
    errorType: process.env.NODE_ENV === 'development' ? errorType : undefined,
    errorDetails: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
};

const getCachedChat = (userId, chatId) => {
  const key = `${userId}:${chatId}`;
  return chatCache.get(key);
};

const setCachedChat = (userId, chatId, data) => {
  const key = `${userId}:${chatId}`;
  return chatCache.set(key, data);
};

const invalidateUserChatCache = (userId) => {
  for (const key of chatCache.keys()) {
    if (key.startsWith(`${userId}:`)) {
      chatCache.delete(key);
    }
  }
};

const batchDecryptMessages = (messages) => {
  if (!messages || !messages.length) return [];

  return messages.map(m => ({
    ...m.toObject ? m.toObject() : m,
    text: typeof m.text === 'string' ? decryptText(m.text) : m.text
  }));
};

exports.processChat = async (req, res) => {
  try {
    const { message, chatId } = req.body;
    const userId = req.user.userId;

    if (!message || message.trim() === '') {
      return res.status(400).json({ message: "Message is required and cannot be empty" });
    }
    const { response: botResponse, classification: queryClassification } =
      await withRetry(() => processQuery(message), 3, 1000, true);

    const currentTime = new Date();
    const userMessagePlain = { type: "user", text: message, time: currentTime };
    const botMessagePlain = { type: "bot", text: botResponse, time: currentTime };

    let chat;
    if (chatId) {
      chat = getCachedChat(userId, chatId);
      if (!chat) {
        chat = await Chat.findOne({ userId, chatId })
          .maxTimeMS(5000);
      }
    }

    let plainMessagesForSummary = [];
    let messageCount = 0;

    if (chat) {
      if (chat.messages) {
        plainMessagesForSummary = batchDecryptMessages(chat.messages);
        messageCount = chat.messages.length;
      } else {
        plainMessagesForSummary = [];
        chat.messages = [];
      }

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
      chat.title = await generateChatTitle(botResponse, queryClassification, message);
    }
    let summaryPlain = "";
    if (plainMessagesForSummary.length >= 4) {
      summaryPlain = await generateChatSummary(plainMessagesForSummary);
      chat.chatSummary = summaryPlain ? encryptText(summaryPlain) : "";
    }

    await chat.save();

    invalidateUserChatCache(userId);
    setCachedChat(userId, chat.chatId, chat);

    res.json({
      chatId: chat.chatId,
      userMessage: message,
      botResponse,
      chatSummary: summaryPlain,
      title: chat.title,
      category: queryClassification.category,
      isLegal: queryClassification.isLegal,
      messageCount: messageCount + 2,
      complexity: queryClassification.complexity || 1
    });
  } catch (error) {
    return handleError(res, error, "Error processing chat");
  }
};

async function generateChatTitle(botResponse, classification, query) {
  if (classification.isLegal) {
    const titleMatch = botResponse.match(/\*\*Title:\*\*\s*(.*?)(?:\n|$)/i) ||
      botResponse.match(/^Title:\s*(.*?)(?:\n|$)/i);

    if (titleMatch && titleMatch[1]) {
      return titleMatch[1].trim().substring(0, 100);
    }

    if (classification.specificLaws && classification.specificLaws.length > 0) {
      return `Query about ${classification.specificLaws[0]}`;
    }

    return `${classification.subCategory || 'Legal'} Query`;
  }

  if (query.length <= 50) {
    return query;
  }

  return classification.category === "general_chat"
    ? "General Conversation"
    : `${classification.category.replace(/_/g, ' ')} Query`;
}

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
      .select('chatId title chatSummary createdAt updatedAt messages.time')
      .lean()
      .maxTimeMS(5000);

    const formattedChats = await Promise.all(chats
      .filter(chat => chat.messages && chat.messages.length > 0)
      .map(async chat => {
        const chatItem = {
          chatId: chat.chatId,
          title: chat.title,
          messageCount: chat.messages.length,
          lastMessageTime: chat.messages.length > 0 ?
            chat.messages[chat.messages.length - 1].time : null,
          createdAt: chat.createdAt,
          updatedAt: chat.updatedAt
        };
        if (chat.chatSummary) {
          try {
            chatItem.summary = decryptText(chat.chatSummary);
          } catch (e) {
            chatItem.summary = "Summary unavailable";
          }
        } else {
          chatItem.summary = "";
        }

        return chatItem;
      }));

    setTimeout(async () => {
      try {
        const fullChats = await Chat.find({
          userId,
          chatId: { $in: formattedChats.map(c => c.chatId) }
        }).maxTimeMS(10000);

        fullChats.forEach(chat => {
          setCachedChat(userId, chat.chatId, chat);
        });
      } catch (error) {
        console.error("Background caching error:", error);
      }
    }, 0);
    const totalDocs = await Chat.countDocuments({ userId })
      .maxTimeMS(3000);

    res.json({
      chats: formattedChats,
      pagination: {
        page,
        limit,
        hasMore: chats.length === limit,
        totalPages: Math.ceil(totalDocs / limit),
        totalChats: totalDocs
      },
      cacheStats: chatCache.getStats()
    });
  } catch (error) {
    return handleError(res, error, "Error fetching all chats");
  }
};

exports.getChatHistory = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { chatId } = req.params;

    if (!chatId) {
      return res.status(400).json({ message: "Chat ID is required" });
    }
    let chat = getCachedChat(userId, chatId);
    if (!chat) {
      chat = await Chat.findOne({ userId, chatId });
      if (chat) {
        setCachedChat(userId, chatId, chat);
      }
    }

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }
    const decodedMessages = chat.messages.map(m => {
      try {
        return {
          ...m.toObject ? m.toObject() : m,
          text: decryptText(m.text)
        };
      } catch (e) {
        return {
          ...m.toObject ? m.toObject() : m,
          text: "Message couldn't be decrypted"
        };
      }
    });

    let decodedSummary = "";
    if (chat.chatSummary) {
      try {
        decodedSummary = decryptText(chat.chatSummary);
      } catch (e) {
        decodedSummary = "Summary unavailable";
      }
    }

    res.json({
      chatId: chat.chatId,
      title: chat.title,
      messages: decodedMessages,
      chatSummary: decodedSummary,
      createdAt: chat.createdAt,
      updatedAt: chat.updatedAt
    });
  } catch (error) {
    return handleError(res, error, "Error fetching chat history");
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

    if (!title || title.trim() === '') {
      return res.status(400).json({ message: "Title is required and cannot be empty" });
    }

    const sanitizedTitle = title.trim().substring(0, 100);
    const chat = await Chat.findOneAndUpdate(
      { userId, chatId },
      { title: sanitizedTitle },
      { new: true }
    );

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    if (getCachedChat(userId, chatId)) {
      setCachedChat(userId, chatId, chat);
    }

    res.json({ chatId: chat.chatId, title: chat.title });
  } catch (error) {
    return handleError(res, error, "Error updating chat title");
  }
};

exports.deleteChat = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { chatId } = req.params;

    if (!chatId) {
      return res.status(400).json({ message: "Chat ID is required" });
    }

    const result = await Chat.findOneAndDelete({ userId, chatId });

    if (!result) {
      return res.status(404).json({ message: "Chat not found" });
    }
    const key = `${userId}:${chatId}`;
    chatCache.delete(key);

    res.json({ message: "Chat deleted successfully", chatId });
  } catch (error) {
    return handleError(res, error, "Error deleting chat");
  }
};

exports.getServiceStatus = async (req, res) => {
  if (!req.user.isAdmin) {
    return res.status(403).json({ message: "Unauthorized" });
  }

  try {
    const metrics = getServiceMetrics();
    const dbStats = {
      chatCount: await Chat.countDocuments(),
      avgChatSize: await Chat.aggregate([
        { $project: { messageCount: { $size: "$messages" } } },
        { $group: { _id: null, avg: { $avg: "$messageCount" } } }
      ]).then(result => result[0]?.avg || 0)
    };

    res.json({
      status: "operational",
      cacheStatus: {
        chatCache: chatCache.getStats(),
        ...metrics.caches
      },
      performance: metrics.performance,
      database: dbStats,
      memory: process.memoryUsage()
    });
  } catch (error) {
    return handleError(res, error, "Error fetching service status");
  }
};