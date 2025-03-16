// src/controllers/chatController.js
const Chat = require("../models/Chat");
const { isLegalQuery } = require("../utils/legalUtils");
const { generateGeminiResponse, generateChatSummary } = require("../services/aiService");
const { encryptText, decryptText } = require("../services/encryptionService");

const processChat = async (req, res) => {
  try {
    const { message } = req.body;
    const userId = req.user.userId;

    if (!message) {
      return res.status(400).json({ message: "Message is required" });
    }

    // Determine if the query is legally related.
    const legalFlag = isLegalQuery(message);

    // Handle non-legal queries gracefully.
    if (!legalFlag) {
      return res.json({
        userMessage: message,
        botResponse: "**This query does not appear to be related to legal matters. Please ask questions related to legal queries for accurate guidance.**",
        chatSummary: "Non-legal query detected."
      });
    }

    // Structured Prompt for Legal Queries.
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

    // Generate bot response.
    let botResponseRaw = await generateGeminiResponse(prompt);
    // Fallback to a default response if the generated response is undefined.
    const botResponse = botResponseRaw ? botResponseRaw : "I'm sorry, I encountered an error generating a response.";

    const currentTime = new Date();

    // Create plain text objects for summary generation.
    const userMessagePlain = { type: "user", text: message, time: currentTime };
    const botMessagePlain = { type: "bot", text: botResponse, time: currentTime };

    // Retrieve or create chat history.
    let chat = await Chat.findOne({ userId });
    let plainMessagesForSummary = [];
    if (chat) {
      // Decode all existing messages for summary generation.
      plainMessagesForSummary = chat.messages.map(m => ({
        type: m.type,
        text: decryptText(m.text),
        time: m.time
      }));
      // Append new messages.
      plainMessagesForSummary.push(userMessagePlain, botMessagePlain);
      // Save new messages encoded.
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

    // Generate a chat summary using the decoded messages.
    const summaryPlain = await generateChatSummary(plainMessagesForSummary);
    // Store the summary encoded.
    chat.chatSummary = encryptText(summaryPlain);
    await chat.save();

    // Send back the plain text messages and summary.
    res.json({ userMessage: message, botResponse, chatSummary: summaryPlain });
  } catch (error) {
    console.error("❌ Error processing chat:", error);
    res.status(500).json({ message: "Error processing chat" });
  }
};

const getChatHistory = async (req, res) => {
  try {
    const userId = req.user.userId;
    const chat = await Chat.findOne({ userId });
    if (!chat) {
      return res.json({ messages: [], chatSummary: "" });
    }
    // Decode each stored message.
    const decodedMessages = chat.messages.map(m => ({
      ...m.toObject(),
      text: decryptText(m.text)
    }));
    // Decode the chat summary.
    const decodedSummary = chat.chatSummary ? decryptText(chat.chatSummary) : "";
    res.json({ messages: decodedMessages, chatSummary: decodedSummary });
  } catch (error) {
    console.error("❌ Error fetching chat history:", error);
    res.status(500).json({ message: "Error fetching chat history" });
  }
};

const clearChatHistory = async (req, res) => {
  try {
    const userId = req.user.userId;
    await Chat.findOneAndDelete({ userId });
    res.json({ message: "Chat history cleared" });
  } catch (error) {
    console.error("❌ Error clearing chat history:", error);
    res.status(500).json({ message: "Error clearing chat history" });
  }
};

module.exports = {
  processChat,
  getChatHistory,
  clearChatHistory
};