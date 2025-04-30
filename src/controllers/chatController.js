// src/controllers/chatController.js
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
  batchProcessQueries,
  prioritizeQuery
} = require("../services/aiService");
const lockManager = require('../utils/lockManager');
const dbConnection = require('../config/dbConnection');
const cacheService = require('../services/cacheService');

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

async function getChatResponse(query, userId, sessionId) {
  const cacheKey = `response:${query.toLowerCase().trim()}`;

  try {
    const cachedResponse = await cacheService.get(cacheKey, 'chat');
    if (cachedResponse) {
      console.log('Cache hit for query');
      return cachedResponse;
    }

    console.log('Cache miss for query, generating response');
    const result = await processQuery(query);
    await cacheService.set(cacheKey, result, 3600, 'chat');

    return result;
  } catch (error) {
    console.error('Error getting chat response:', error);
    throw error;
  }
}

const getCachedChat = async (userId, chatId) => {
  const key = `${userId}:${chatId}`;
  return await cacheService.get(key, 'chat');
};

const setCachedChat = async (userId, chatId, data) => {
  const key = `${userId}:${chatId}`;
  return await cacheService.set(key, data, 3600, 'chat');
};

const invalidateUserChatCache = async (userId) => {
  await cacheService.flush(`chat:user:${userId}`);
};

const batchDecryptMessages = (messages) => {
  if (!messages || !messages.length) return [];
  const batchSize = 50;
  const results = [];

  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const decryptedBatch = batch.map(m => ({
      ...m.toObject ? m.toObject() : m,
      text: typeof m.text === 'string' ? decryptText(m.text) : m.text
    }));
    results.push(...decryptedBatch);
  }

  return results;
};

const executeDbOperation = async (operation, maxRetries = 3) => {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      if (mongoose.connection.readyState !== 1) {
        console.warn(`MongoDB not connected (state: ${mongoose.connection.readyState}). Attempting to reconnect...`);
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (mongoose.connection.readyState !== 1) {
          try {
            await dbConnection.connect();
          } catch (connError) {
            console.error("Reconnection attempt failed:", connError.message);
          }
        }
      }

      return await operation();
    } catch (error) {
      retries++;
      const isConnectionError =
        error.name === 'MongoNetworkError' ||
        error.name === 'MongoTimeoutError' ||
        error.message.includes('topology') ||
        error.message.includes('connection') ||
        error.name === 'MongoServerSelectionError';

      if (isConnectionError && retries < maxRetries) {
        console.warn(`MongoDB operation failed due to connection issue. Retrying (${retries}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, 1000 * retries));
        try {
          await dbConnection.connect();
        } catch (connError) {
          console.error("Reconnection attempt failed:", connError.message);
        }
      } else {
        throw error;
      }
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
    const priority = message.length < 200 ? await prioritizeQuery(message) : 'normal';

    const processingStart = Date.now();
    const { response: botResponse, classification: queryClassification } =
      await withRetry(() => processQuery(message), 3, 1000, true);
    const processingTime = Date.now() - processingStart;

    const currentTime = new Date();
    const userMessagePlain = { type: "user", text: message, time: currentTime };
    const botMessagePlain = {
      type: "bot",
      text: botResponse,
      time: currentTime,
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
    if (chatId) {
      chat = await getCachedChat(userId, chatId);
      if (!chat) {
        chat = await executeDbOperation(async () => {
          return await Chat.findOne({ userId, chatId }).maxTimeMS(5000);
        });
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
      chat.messages.push({ type: "bot", text: encryptText(botResponse), time: currentTime, metadata: botMessagePlain.metadata });
    } else {
      const newChatId = chatId || uuidv4();
      plainMessagesForSummary = [userMessagePlain, botMessagePlain];
      chat = new Chat({
        userId,
        chatId: newChatId,
        messages: [
          { type: "user", text: encryptText(message), time: currentTime },
          { type: "bot", text: encryptText(botResponse), time: currentTime, metadata: botMessagePlain.metadata }
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
    const chatSavePromise = lockManager.withLock(chat._id.toString(), async () => {
      try {
        await executeDbOperation(async () => {
          const freshChat = await Chat.findById(chat._id);
          if (freshChat) {
            freshChat.messages = chat.messages;
            freshChat.lastActivity = chat.lastActivity;
            freshChat.chatSummary = chat.chatSummary;
            freshChat.title = chat.title;
            await freshChat.save();
          }
        });
      } catch (error) {
        console.error("Error saving chat with lock:", error);
        await executeDbOperation(async () => {
          await chat.save();
        });
      }
    });

    await invalidateUserChatCache(userId);
    await setCachedChat(userId, chat.chatId, chat);

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
    await chatSavePromise;
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

    const filter = { userId };

    if (req.query.startDate) {
      filter.updatedAt = { $gte: new Date(req.query.startDate) };
    }

    if (req.query.keyword) {
      filter.title = { $regex: req.query.keyword, $options: 'i' };
    }

    const chats = await executeDbOperation(async () => {
      return await Chat.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .select('chatId title chatSummary createdAt updatedAt messages.time')
        .lean()
        .maxTimeMS(5000);
    });

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

    const cacheBatchSize = 5;
    setTimeout(async () => {
      try {
        const chatIds = formattedChats.slice(0, cacheBatchSize).map(c => c.chatId);
        const fullChats = await executeDbOperation(async () => {
          return await Chat.find({
            userId,
            chatId: { $in: chatIds }
          }).maxTimeMS(10000);
        });

        fullChats.forEach(chat => {
          setCachedChat(userId, chat.chatId, chat);
        });
        if (formattedChats.length > cacheBatchSize) {
          const remainingChatIds = formattedChats.slice(cacheBatchSize).map(c => c.chatId);
          setTimeout(async () => {
            try {
              const remainingChats = await executeDbOperation(async () => {
                return await Chat.find({
                  userId,
                  chatId: { $in: remainingChatIds }
                }).maxTimeMS(10000);
              });

              remainingChats.forEach(chat => {
                setCachedChat(userId, chat.chatId, chat);
              });
            } catch (error) {
              console.error("Delayed background caching error:", error);
            }
          }, 2000);
        }
      } catch (error) {
        console.error("Background caching error:", error);
      }
    }, 0);

    const totalDocs = await executeDbOperation(async () => {
      return await Chat.countDocuments(filter).maxTimeMS(3000);
    });

    res.json({
      chats: formattedChats,
      pagination: {
        page,
        limit,
        hasMore: chats.length === limit,
        totalPages: Math.ceil(totalDocs / limit),
        totalChats: totalDocs
      },
      cacheStats: cacheService.getStats()
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
    let chat = await getCachedChat(userId, chatId);
    if (!chat) {
      chat = await executeDbOperation(async () => {
        return await Chat.findOne({ userId, chatId });
      });
      if (chat) {
        await setCachedChat(userId, chatId, chat);
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
    const chat = await executeDbOperation(async () => {
      return await Chat.findOneAndUpdate(
        { userId, chatId },
        { $set: { messages: [], chatSummary: "" } },
        { new: true }
      );
    });

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

    const result = await executeDbOperation(async () => {
      return await Chat.deleteMany({ "messages": { $size: 0 } });
    });

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

    await lockManager.withLock(newChat._id.toString(), async () => {
      await executeDbOperation(async () => {
        await newChat.save();
      });
    });

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
    const chat = await executeDbOperation(async () => {
      return await Chat.findOneAndUpdate(
        { userId, chatId },
        { title: sanitizedTitle },
        { new: true }
      );
    });

    if (!chat) {
      return res.status(404).json({ message: "Chat not found" });
    }

    if (await getCachedChat(userId, chatId)) {
      await setCachedChat(userId, chatId, chat);
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

    const result = await executeDbOperation(async () => {
      return await Chat.findOneAndDelete({ userId, chatId });
    });

    if (!result) {
      return res.status(404).json({ message: "Chat not found" });
    }
    const key = `${userId}:${chatId}`;
    await cacheService.del(key, 'chat');

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
    const dbStatus = dbConnection.getConnectionStatus();

    const dbStats = await executeDbOperation(async () => {
      return {
        chatCount: await Chat.countDocuments(),
        avgChatSize: await Chat.aggregate([
          { $project: { messageCount: { $size: "$messages" } } },
          { $group: { _id: null, avg: { $avg: "$messageCount" } } }
        ]).then(result => result[0]?.avg || 0),
        recentActivity: await Chat.countDocuments({
          updatedAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) }
        })
      };
    });

    const systemLoad = {
      cpuUsage: process.cpuUsage(),
      memoryUsage: process.memoryUsage(),
      uptime: process.uptime(),
      loadAverage: process.platform === 'win32' ? [0, 0, 0] : require('os').loadavg()
    };

    res.json({
      status: "operational",
      cacheStatus: {
        chatCache: cacheService.getStats(),
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

exports.clearUserCache = async function (req, res) {
  try {
    const userId = req.params.userId;
    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    await cacheService.flush(`chat:user:${userId}`);
    return res.status(200).json({ message: 'Cache cleared successfully' });
  } catch (error) {
    handleError(res, error, 'Error clearing user cache');
  }
};

exports.getCacheStats = async function (req, res) {
  try {
    const stats = cacheService.getStats();
    return res.status(200).json(stats);
  } catch (error) {
    handleError(res, error, 'Error getting cache statistics');
  }
};