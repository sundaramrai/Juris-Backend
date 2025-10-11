const mongoose = require('mongoose');
const Chat = require("../models/Chat");
const { v4: uuidv4 } = require("uuid");
const { encryptText, decryptText } = require("../utils/encryption");
const {
  generateGeminiResponse,
  generateChatSummary,
  processQuery,
  getServiceMetrics,
  withRetry,
  prioritizeQuery
} = require("../services/aiService");
const lockManager = require('../utils/lockManager');
const dbConnection = require('../config/dbConnection');

class LRUCache {
  constructor(options = {}) {
    this.cache = new Map();
    this.config = {
      maxSize: options.maxSize || 100,
      ttlMs: options.ttlMs || 15 * 60 * 1000,
      maxMemoryMB: options.maxMemoryMB || 100,
      cleanupIntervalMs: options.cleanupIntervalMs || 60 * 1000
    };

    this.metrics = {
      hits: 0,
      misses: 0,
      evictions: 0,
      estimatedMemoryBytes: 0
    };

    this.lastCleanup = Date.now();
  }

  get(key) {
    const now = Date.now();
    this._maybeCleanup(now);

    const item = this.cache.get(key);

    if (!item) {
      this.metrics.misses++;
      return undefined;
    }

    if (item.expiry < now) {
      this._removeItem(key);
      this.metrics.misses++;
      return undefined;
    }

    this.cache.delete(key);
    this.cache.set(key, item);
    this.metrics.hits++;

    return item.value;
  }

  set(key, value) {
    const now = Date.now();
    this._maybeCleanup(now);

    const itemSize = this._estimateSize(value);

    while (
      this.metrics.estimatedMemoryBytes + itemSize > this.config.maxMemoryMB * 1024 * 1024 &&
      this.cache.size > 0
    ) {
      this._evictOldest();
    }

    const existingItem = this.cache.get(key);
    if (existingItem) {
      this.metrics.estimatedMemoryBytes -= existingItem.size;
    }

    const item = {
      value,
      expiry: now + this.config.ttlMs,
      size: itemSize
    };

    this.cache.set(key, item);
    this.metrics.estimatedMemoryBytes += itemSize;

    if (this.cache.size > this.config.maxSize) {
      this._evictOldest();
    }

    return true;
  }

  delete(key) {
    return this._removeItem(key);
  }

  has(key) {
    const now = Date.now();
    const item = this.cache.get(key);

    if (!item) return false;

    if (item.expiry < now) {
      this._removeItem(key);
      return false;
    }

    return true;
  }

  clear() {
    this.cache.clear();
    this.metrics.estimatedMemoryBytes = 0;
  }

  keys() {
    return Array.from(this.cache.keys());
  }

  get size() {
    return this.cache.size;
  }

  getStats() {
    const totalRequests = this.metrics.hits + this.metrics.misses;
    const hitRate = totalRequests > 0 ? this.metrics.hits / totalRequests : 0;

    return {
      size: this.cache.size,
      maxSize: this.config.maxSize,
      hits: this.metrics.hits,
      misses: this.metrics.misses,
      evictions: this.metrics.evictions,
      hitRate: hitRate,
      hitRatePercent: (hitRate * 100).toFixed(2),
      memoryUsageMB: (this.metrics.estimatedMemoryBytes / (1024 * 1024)).toFixed(2),
      maxMemoryMB: this.config.maxMemoryMB
    };
  }

  _removeItem(key) {
    const item = this.cache.get(key);
    if (item) {
      this.metrics.estimatedMemoryBytes -= item.size;
      this.cache.delete(key);
      return true;
    }
    return false;
  }

  _evictOldest() {
    const oldestKey = this.cache.keys().next().value;
    if (oldestKey) {
      this._removeItem(oldestKey);
      this.metrics.evictions++;
    }
  }

  _maybeCleanup(now) {
    if (now - this.lastCleanup < this.config.cleanupIntervalMs) {
      return;
    }

    let removedCount = 0;
    let freedBytes = 0;

    for (const [key, item] of this.cache.entries()) {
      if (item.expiry < now) {
        freedBytes += item.size;
        this.cache.delete(key);
        removedCount++;
      }
    }

    this.metrics.estimatedMemoryBytes -= freedBytes;
    this.metrics.evictions += removedCount;
    this.lastCleanup = now;

    if (removedCount > 0) {
      console.log(
        `Cache cleanup: removed ${removedCount} items, freed ${(freedBytes / (1024 * 1024)).toFixed(2)} MB`
      );
    }
  }

  _estimateSize(obj) {
    try {
      return JSON.stringify(obj).length * 2;
    } catch {
      return 1024;
    }
  }
}

const chatCache = new LRUCache({ maxSize: 100, ttlMs: 15 * 60 * 1000 });

const handleError = (res, error, message, statusCode = 500) => {
  const errorId = uuidv4().substring(0, 8);
  const isDev = process.env.NODE_ENV === 'development';

  console.error(`❌ [${errorId}] ${message}:`, error);

  const errorMappings = {
    AIServiceError: { code: 503, message: 'AI service temporarily unavailable' },
    ValidationError: { code: 400, message: 'Validation failed' },
    AuthorizationError: { code: 403, message: 'Unauthorized access' },
    MongoNetworkError: { code: 503, message: 'Database temporarily unavailable' },
    MongoTimeoutError: { code: 503, message: 'Database request timeout' }
  };

  const errorConfig = errorMappings[error.name];
  if (errorConfig) {
    statusCode = errorConfig.code;
    message = errorConfig.message;
  }

  return res.status(statusCode).json({
    message,
    errorId,
    ...(isDev && {
      errorType: error.name,
      errorDetails: error.message,
      stack: error.stack
    })
  });
};

const getCacheKey = (userId, chatId) => `${userId}:${chatId}`;

const getCachedChat = (userId, chatId) => {
  return chatCache.get(getCacheKey(userId, chatId));
};

const setCachedChat = (userId, chatId, data) => {
  return chatCache.set(getCacheKey(userId, chatId), data);
};

const invalidateUserCache = (userId) => {
  const prefix = `${userId}:`;
  chatCache.keys()
    .filter(key => key.startsWith(prefix))
    .forEach(key => chatCache.delete(key));
};

const batchDecryptMessages = (messages) => {
  if (!messages?.length) return [];

  return messages.map(msg => {
    try {
      const msgObj = msg.toObject ? msg.toObject() : msg;
      return {
        ...msgObj,
        text: typeof msgObj.text === 'string' ? decryptText(msgObj.text) : msgObj.text
      };
    } catch (error) {
      console.error('Message decryption failed:', error.message);
      return {
        ...(msg.toObject ? msg.toObject() : msg),
        text: '[Decryption failed]',
        decryptionError: true
      };
    }
  });
};

const isConnectionError = (error) => {
  const connectionErrors = [
    'MongoNetworkError',
    'MongoTimeoutError',
    'MongoServerSelectionError'
  ];

  return connectionErrors.includes(error.name) ||
    error.message?.includes('topology') ||
    error.message?.includes('connection');
};

const ensureDbConnection = async () => {
  if (mongoose.connection.readyState === 1) return;

  console.warn(`MongoDB not connected (state: ${mongoose.connection.readyState}). Reconnecting...`);

  await new Promise(resolve => setTimeout(resolve, 1000));

  if (mongoose.connection.readyState !== 1) {
    try {
      await dbConnection.connect();
    } catch (error) {
      console.error('Reconnection failed:', error.message);
      throw error;
    }
  }
};

const executeDbOperation = async (operation, maxRetries = 3) => {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await ensureDbConnection();
      return await operation();
    } catch (error) {
      const isLastAttempt = attempt === maxRetries;

      if (isConnectionError(error) && !isLastAttempt) {
        console.warn(`DB operation failed. Retry ${attempt}/${maxRetries}...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * attempt));

        try {
          await dbConnection.connect();
        } catch (connError) {
          console.error('Reconnection attempt failed:', connError.message);
        }
      } else {
        throw error;
      }
    }
  }
};

const generateChatTitle = (botResponse, classification, query) => {
  if (classification.isLegal) {
    const titleMatch = botResponse.match(/\*\*Title:\*\*\s*(.*?)(?:\n|$)/i) ||
      botResponse.match(/^Title:\s*(.*?)(?:\n|$)/i);

    if (titleMatch?.[1]) {
      return titleMatch[1].trim().substring(0, 100);
    }

    if (classification.specificLaws?.length > 0) {
      return `Query about ${classification.specificLaws[0]}`;
    }

    return `${classification.subCategory || 'Legal'} Query`;
  }

  if (query.length <= 50) {
    return query;
  }

  return classification.category === 'general_chat'
    ? 'General Conversation'
    : `${classification.category.replace(/_/g, ' ')} Query`;
};

const warmCacheInBackground = (userId, chatIds) => {
  if (!chatIds.length) return;

  const BATCH_SIZE = 5;
  const batches = [];

  for (let i = 0; i < chatIds.length; i += BATCH_SIZE) {
    batches.push(chatIds.slice(i, i + BATCH_SIZE));
  }

  batches.forEach((batch, index) => {
    setTimeout(async () => {
      try {
        const chats = await executeDbOperation(async () => {
          return await Chat.find({
            userId,
            chatId: { $in: batch }
          }).maxTimeMS(10000);
        });

        chats.forEach(chat => setCachedChat(userId, chat.chatId, chat));
      } catch (error) {
        console.error('Cache warming error:', error.message);
      }
    }, index * 2000);
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

    const { response: botResponse, classification: queryClassification } =
      await withRetry(() => processQuery(message), 3, 1000, true);

    const processingTime = Date.now() - processingStart;

    const timestamp = new Date();
    const userMessage = { type: "user", text: message, time: timestamp };
    const botMessage = {
      type: "bot",
      text: botResponse,
      time: timestamp,
      metadata: {
        processingTime,
        classification: {
          category: queryClassification.category,
          isLegal: queryClassification.isLegal,
          priority
        }
      }
    };

    let chat;
    let messageCount = 0;
    let plainMessages = [];

    if (chatId) {
      chat = getCachedChat(userId, chatId) ||
        await executeDbOperation(() => Chat.findOne({ userId, chatId }).maxTimeMS(5000));
    }

    if (chat) {
      plainMessages = batchDecryptMessages(chat.messages || []);
      messageCount = chat.messages?.length || 0;

      plainMessages.push(userMessage, botMessage);
      chat.messages.push(
        { type: "user", text: encryptText(message), time: timestamp },
        { type: "bot", text: encryptText(botResponse), time: timestamp, metadata: botMessage.metadata }
      );
    } else {
      const newChatId = chatId || uuidv4();
      plainMessages = [userMessage, botMessage];

      chat = new Chat({
        userId,
        chatId: newChatId,
        messages: [
          { type: "user", text: encryptText(message), time: timestamp },
          { type: "bot", text: encryptText(botResponse), time: timestamp, metadata: botMessage.metadata }
        ]
      });
    }

    if (!chat.title || chat.title === "New Chat") {
      chat.title = generateChatTitle(botResponse, queryClassification, message);
    }

    let summaryPlain = "";
    if (plainMessages.length >= 4) {
      summaryPlain = await generateChatSummary(plainMessages);
      if (summaryPlain) {
        chat.chatSummary = encryptText(summaryPlain);
      }
    }

    const saveChatPromise = lockManager.withLock(chat._id.toString(), async () => {
      try {
        await executeDbOperation(async () => {
          const freshChat = await Chat.findById(chat._id);
          if (freshChat) {
            Object.assign(freshChat, {
              messages: chat.messages,
              lastActivity: chat.lastActivity,
              chatSummary: chat.chatSummary,
              title: chat.title
            });
            await freshChat.save();
          }
        });
      } catch (error) {
        console.error('Error saving with lock:', error.message);
        await executeDbOperation(() => chat.save());
      }
    });

    invalidateUserCache(userId);
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
      complexity: queryClassification.complexity || 1,
      processingTime
    });

    await saveChatPromise;
  } catch (error) {
    return handleError(res, error, "Error processing chat");
  }
};

exports.getAllChats = async (req, res) => {
  try {
    const userId = req.user.userId;
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
    const skip = (page - 1) * limit;

    const filter = { userId };

    if (req.query.startDate) {
      filter.updatedAt = { $gte: new Date(req.query.startDate) };
    }

    if (req.query.keyword) {
      filter.title = { $regex: req.query.keyword, $options: 'i' };
    }

    const [chats, totalDocs] = await Promise.all([
      executeDbOperation(() =>
        Chat.find(filter)
          .sort({ updatedAt: -1 })
          .skip(skip)
          .limit(limit)
          .select('chatId title chatSummary createdAt updatedAt messages.time')
          .lean()
          .maxTimeMS(5000)
      ),
      executeDbOperation(() => Chat.countDocuments(filter).maxTimeMS(3000))
    ]);

    const formattedChats = chats
      .filter(chat => chat.messages?.length > 0)
      .map(chat => ({
        chatId: chat.chatId,
        title: chat.title,
        messageCount: chat.messages.length,
        lastMessageTime: chat.messages[chat.messages.length - 1]?.time,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt,
        summary: chat.chatSummary ?
          (() => {
            try {
              return decryptText(chat.chatSummary);
            } catch {
              return "Summary unavailable";
            }
          })() : ""
      }));

    const chatIds = formattedChats.map(c => c.chatId);
    setImmediate(() => warmCacheInBackground(userId, chatIds));

    res.json({
      chats: formattedChats,
      pagination: {
        page,
        limit,
        totalPages: Math.ceil(totalDocs / limit),
        totalChats: totalDocs,
        hasMore: chats.length === limit
      },
      cacheStats: chatCache.getStats()
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
      if (chat) {
        setCachedChat(userId, chatId, chat);
      }
    }

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    const messages = batchDecryptMessages(chat.messages);

    let summary = "";
    if (chat.chatSummary) {
      try {
        summary = decryptText(chat.chatSummary);
      } catch {
        summary = "Summary unavailable";
      }
    }

    res.json({
      chatId: chat.chatId,
      title: chat.title,
      messages,
      chatSummary: summary,
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
        { $set: { messages: [], chatSummary: "" } },
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

exports.cleanupEmptyChats = async (req, res) => {
  try {
    if (!req.user.isAdmin) {
      return res.status(403).json({ message: "Unauthorized" });
    }

    const result = await executeDbOperation(() =>
      Chat.deleteMany({ messages: { $size: 0 } })
    );

    res.json({
      message: "Cleanup completed",
      deletedCount: result.deletedCount
    });
  } catch (error) {
    return handleError(res, error, "Error during cleanup");
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

    await lockManager.withLock(newChat._id.toString(), async () => {
      await executeDbOperation(() => newChat.save());
    });

    res.json({
      chatId: newChat.chatId,
      title: newChat.title,
      messages: [],
      chatSummary: ""
    });
  } catch (error) {
    return handleError(res, error, "Error creating chat");
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

    if (!title?.trim()) {
      return res.status(400).json({ message: "Title is required and cannot be empty" });
    }

    const sanitizedTitle = title.trim().substring(0, 100);

    const chat = await executeDbOperation(() =>
      Chat.findOneAndUpdate(
        { userId, chatId },
        { title: sanitizedTitle },
        { new: true }
      )
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
      Promise.resolve(getServiceMetrics()),
      Promise.resolve(dbConnection.getConnectionStatus()),
      executeDbOperation(async () => {
        const [chatCount, avgSize, recentActivity] = await Promise.all([
          Chat.countDocuments(),
          Chat.aggregate([
            { $project: { messageCount: { $size: "$messages" } } },
            { $group: { _id: null, avg: { $avg: "$messageCount" } } }
          ]).then(result => result[0]?.avg || 0),
          Chat.countDocuments({
            updatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
          })
        ]);

        return { chatCount, avgChatSize: avgSize, recentActivity };
      })
    ]);

    const systemLoad = {
      cpuUsage: process.cpuUsage(),
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
      loadAverage: process.platform === 'win32' ? [0, 0, 0] : require('os').loadavg()
    };

    res.json({
      status: "operational",
      cacheStatus: {
        chatCache: chatCache.getStats(),
        ...metrics.caches
      },
      performance: metrics.performance,
      database: {
        ...dbStats,
        connection: dbStatus
      },
      system: systemLoad,
      aiService: metrics.api
    });
  } catch (error) {
    return handleError(res, error, "Error fetching service status");
  }
};