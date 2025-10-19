const mongoose = require('mongoose');
const Chat = require("../models/Chat");
const { v4: uuidv4 } = require("uuid");
const { encryptText, decryptText } = require("../utils/encryption");
const {
  generateChatTitle,
  processQuery,
  getServiceMetrics,
  withRetry,
  prioritizeQuery
} = require("../services/aiService");
const lockManager = require('../utils/lockManager');
const dbConnection = require('../config/dbConnection');
const LRUCache = require('../utils/lruCache');

const chatCache = new LRUCache({ maxSize: 100, ttlMs: 15 * 60 * 1000 });

const handleError = (res, error, message, statusCode = 500) => {
  const errorId = uuidv4().substring(0, 8);
  console.error(`❌ [${errorId}] ${message}:`, error);

  const errorMap = {
    AIServiceError: 503,
    ValidationError: 400,
    AuthorizationError: 403,
    MongoNetworkError: 503,
    MongoTimeoutError: 503
  };

  const code = errorMap[error.name] || statusCode;

  return res.status(code).json({
    message: error.name in errorMap ? `${error.name.replace('Error', '')} error occurred` : message,
    errorId,
    ...(process.env.NODE_ENV === 'development' && {
      error: error.message,
      stack: error.stack
    })
  });
};

const getCacheKey = (userId, chatId) => `${userId}:${chatId}`;

const getCachedChat = (userId, chatId) => chatCache.get(getCacheKey(userId, chatId));

const setCachedChat = (userId, chatId, data) => chatCache.set(getCacheKey(userId, chatId), data);

const invalidateUserCache = (userId) => chatCache.invalidatePrefix(`${userId}:`);

const decryptMessages = (messages) => {
  if (!messages?.length) return [];

  return messages.map(msg => {
    try {
      const msgObj = msg.toObject?.() || msg;
      return {
        ...msgObj,
        text: decryptText(msgObj.text)
      };
    } catch (error) {
      console.error('Message decryption failed:', error.message);
      return {
        ...(msg.toObject?.() || msg),
        text: '[Decryption failed]',
        error: true
      };
    }
  });
};

const executeDbOperation = async (operation, retries = 2) => {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      if (mongoose.connection.readyState !== 1) {
        console.warn(`DB not ready (state: ${mongoose.connection.readyState}), attempting reconnect...`);
        await dbConnection.connect();
      }

      return await operation();
    } catch (error) {
      const isConnectionError = ['MongoNetworkError', 'MongoTimeoutError', 'MongoServerSelectionError'].includes(error.name);

      if (isConnectionError && attempt < retries) {
        console.warn(`DB operation failed (attempt ${attempt + 1}/${retries + 1}):`, error.message);
        await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
        continue;
      }
      throw error;
    }
  }
};

const saveChat = async (chat, isNew = false) => {
  if (isNew) {
    return await executeDbOperation(() => chat.save());
  }

  return await lockManager.withLock(chat._id.toString(), async () => {
    return await executeDbOperation(async () => {
      const freshChat = await Chat.findById(chat._id);
      if (freshChat) {
        freshChat.messages = chat.messages;
        freshChat.title = chat.title;
        freshChat.lastActivity = chat.lastActivity;
        return await freshChat.save();
      }
      return chat;
    });
  });
};

exports.processChat = async (req, res) => {
  try {
    const { message, chatId } = req.body;
    const userId = req.user.userId;

    if (!message?.trim()) {
      return res.status(400).json({ message: "Message is required and cannot be empty" });
    }

    const priority = message.length < 200 ? await prioritizeQuery(message) : 'normal';
    const processingStart = Date.now();

    const { response: botResponse, classification } = await withRetry(
      () => processQuery(message),
      3,
      1000,
      true
    );

    const processingTime = Date.now() - processingStart;
    const timestamp = new Date();

    let chat;
    let isNewChat = false;

    if (chatId) {
      chat = getCachedChat(userId, chatId) ||
        await executeDbOperation(() => Chat.findOne({ userId, chatId }));
    }

    if (!chat) {
      isNewChat = true;
      chat = new Chat({
        userId,
        chatId: uuidv4(),
        messages: [],
        title: "New Chat"
      });
    }

    const messageCount = chat.messages.length;

    chat.messages.push(
      { type: "user", text: encryptText(message), time: timestamp },
      {
        type: "bot",
        text: encryptText(botResponse),
        time: timestamp,
        metadata: {
          processingTime,
          classification: { category: classification.category, isLegal: classification.isLegal, priority }
        }
      }
    );

    if (isNewChat || chat.title === "New Chat") {
      try {
        chat.title = await generateChatTitle(message, classification);
      } catch (error) {
        console.warn('Title generation failed:', error.message);
        chat.title = message.length <= 50 ? message : message.substring(0, 47) + '...';
      }
    }

    chat.lastActivity = timestamp;

    await saveChat(chat, isNewChat);
    invalidateUserCache(userId);
    setCachedChat(userId, chat.chatId, chat);

    res.json({
      chatId: chat.chatId,
      userMessage: message,
      botResponse,
      title: chat.title,
      category: classification.category,
      isLegal: classification.isLegal,
      messageCount: messageCount + 2,
      processingTime,
      isNewChat
    });
  } catch (error) {
    return handleError(res, error, "Error processing chat");
  }
};

exports.getAllChats = async (req, res) => {
  try {
    const userId = req.user.userId;
    const page = Math.max(1, Number.parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = { userId };
    if (req.query.startDate) filter.updatedAt = { $gte: new Date(req.query.startDate) };
    if (req.query.keyword) filter.title = { $regex: req.query.keyword, $options: 'i' };

    const [chats, totalDocs] = await Promise.all([
      executeDbOperation(() =>
        Chat.find(filter)
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(limit)
          .select('chatId title createdAt updatedAt messages')
          .lean()
      ),
      executeDbOperation(() => Chat.countDocuments(filter))
    ]);

    const formattedChats = chats
      .filter(chat => chat.messages?.length > 0)
      .map(chat => ({
        chatId: chat.chatId,
        title: chat.title,
        messageCount: chat.messages.length,
        lastMessageTime: chat.messages.at(-1)?.time,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt
      }));

    res.json({
      chats: formattedChats,
      pagination: {
        page,
        limit,
        totalPages: Math.ceil(totalDocs / limit),
        totalChats: totalDocs,
        hasMore: chats.length === limit
      }
    });
  } catch (error) {
    return handleError(res, error, "Error fetching chats");
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
      chat = await executeDbOperation(() => Chat.findOne({ userId, chatId }));
      if (chat) setCachedChat(userId, chatId, chat);
    }

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    res.json({
      chatId: chat.chatId,
      title: chat.title,
      messages: decryptMessages(chat.messages),
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

    const chat = await executeDbOperation(() =>
      Chat.findOneAndUpdate(
        { userId, chatId },
        { $set: { messages: [] } },
        { new: true }
      )
    );

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    chatCache.delete(getCacheKey(userId, chatId));
    res.json({ message: "Chat history cleared successfully" });
  } catch (error) {
    return handleError(res, error, "Error clearing chat history");
  }
};

exports.createNewChat = async (req, res) => {
  res.json({
    chatId: null,
    title: "New Chat",
    messages: []
  });
};

exports.updateChatTitle = async (req, res) => {
  try {
    const userId = req.user.userId;
    const { chatId } = req.params;
    const { title } = req.body;

    if (!chatId) {
      return res.status(400).json({ message: "Chat ID is required" });
    }

    if (!title?.trim()) {
      return res.status(400).json({ message: "Title is required and cannot be empty" });
    }

    const chat = await executeDbOperation(() =>
      Chat.findOneAndUpdate(
        { userId, chatId },
        { title: title.trim().substring(0, 100) },
        { new: true }
      )
    );

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    setCachedChat(userId, chatId, chat);
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

    const result = await executeDbOperation(() =>
      Chat.findOneAndDelete({ userId, chatId })
    );

    if (!result) {
      return res.status(404).json({ message: "Chat not found" });
    }

    chatCache.delete(getCacheKey(userId, chatId));
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
    const [metrics, dbStatus, dbStats] = await Promise.all([
      getServiceMetrics(),
      dbConnection.getConnectionStatus(),
      executeDbOperation(async () => {
        const [chatCount, avgSize, recentActivity] = await Promise.all([
          Chat.countDocuments(),
          Chat.aggregate([
            { $project: { messageCount: { $size: "$messages" } } },
            { $group: { _id: null, avg: { $avg: "$messageCount" } } }
          ]).then(result => result[0]?.avg || 0),
          Chat.countDocuments({ updatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } })
        ]);
        return { chatCount, avgChatSize: Math.round(avgSize), recentActivity };
      })
    ]);

    res.json({
      status: "operational",
      cache: chatCache.getStats(),
      performance: metrics.performance,
      database: { ...dbStats, connection: dbStatus },
      system: {
        memoryUsage: process.memoryUsage(),
        uptime: Math.round(process.uptime()),
      },
      aiService: metrics.api
    });
  } catch (error) {
    return handleError(res, error, "Error fetching service status");
  }
};