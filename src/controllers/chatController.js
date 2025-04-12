// src/controllers/chatController.js
const Chat = require("../models/Chat");
const { v4: uuidv4 } = require("uuid");
const { encryptText, decryptText } = require("../utils/encryption");
const {
  generateChatSummary,
  processQuery,
  getServiceMetrics,
  withRetry
} = require("../services/aiService");

const chatCache = new Map();
const CHAT_CACHE_SIZE = 100;
const CHAT_CACHE_TTL = 15 * 60 * 1000;

const handleError = (res, error, message, statusCode = 500) => {
  console.error(`❌ ${message}:`, error);
  return res.status(statusCode).json({
    message,
    error: process.env.NODE_ENV === 'development' ? error.message : undefined
  });
};

const getCachedChat = (userId, chatId) => {
  const key = `${userId}:${chatId}`;
  const cached = chatCache.get(key);
  if (cached && Date.now() - cached.timestamp < CHAT_CACHE_TTL) {
    return cached.data;
  }
  chatCache.delete(key);
  return null;
};

const setCachedChat = (userId, chatId, data) => {
  const key = `${userId}:${chatId}`;
  if (chatCache.size >= CHAT_CACHE_SIZE) {
    const oldestKey = chatCache.keys().next().value;
    chatCache.delete(oldestKey);
  }
  chatCache.set(key, {
    data,
    timestamp: Date.now()
  });
  return data;
};

const invalidateUserChatCache = (userId) => {
  for (const [key] of chatCache) {
    if (key.startsWith(`${userId}:`)) {
      chatCache.delete(key);
    }
  }
};

exports.processChat = async (req, res) => {
  try {
    const { message, chatId } = req.body;
    const userId = req.user.userId;

    if (!message || message.trim() === '') {
      return res.status(400).json({ message: "Message is required and cannot be empty" });
    }
    const { response: botResponse, classification: queryClassification } =
      await withRetry(() => processQuery(message), 2);

    const currentTime = new Date();
    const userMessagePlain = { type: "user", text: message, time: currentTime };
    const botMessagePlain = { type: "bot", text: botResponse, time: currentTime };

    let chat;
    if (chatId) {
      chat = getCachedChat(userId, chatId);
      if (!chat) {
        chat = await Chat.findOne({ userId, chatId });
      }
    }

    let plainMessagesForSummary = [];
    let messageCount = 0;

    if (chat) {
      if (chat.messages) {
        plainMessagesForSummary = chat.messages.map(m => ({
          type: m.type,
          text: typeof m.text === 'string' ? decryptText(m.text) : m.text,
          time: m.time
        }));
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
      if (queryClassification.isLegal) {
        const titleMatch = botResponse.match(/\*\*Title:\*\*\s*(.*?)(?:\n|$)/i) ||
          botResponse.match(/^Title:\s*(.*?)(?:\n|$)/i);
        if (titleMatch && titleMatch[1]) {
          chat.title = titleMatch[1].trim().substring(0, 100);
        } else if (queryClassification.specificLaws && queryClassification.specificLaws.length > 0) {
          chat.title = `Query about ${queryClassification.specificLaws[0]}`;
        } else {
          chat.title = `${queryClassification.subCategory || 'Legal'} Query`;
        }
      } else {
        chat.title = queryClassification.category === "general_chat"
          ? "General Conversation"
          : `${queryClassification.category.replace(/_/g, ' ')} Query`;
      }
    }

    const summaryPlain = await generateChatSummary(plainMessagesForSummary);
    chat.chatSummary = summaryPlain ? encryptText(summaryPlain) : "";
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
      .map(chat => {
        const chatItem = {
          chatId: chat.chatId,
          title: chat.title,
          messageCount: chat.messages.length,
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
      });

    formattedChats.forEach(chat => {
      const fullChat = chats.find(c => c.chatId === chat.chatId);
      if (fullChat) {
        setCachedChat(userId, chat.chatId, fullChat);
      }
    });

    res.json({
      chats: formattedChats,
      pagination: {
        page,
        limit,
        hasMore: chats.length === limit,
        totalPages: Math.ceil(await Chat.countDocuments({ userId }) / limit)
      }
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
        chatCache: {
          size: chatCache.size,
          maxSize: CHAT_CACHE_SIZE
        },
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