// src/services/aiService.js
const { GoogleGenerativeAI } = require("@google/generative-ai");
const { GEMINI_API_KEY } = require('../config');

const genAI = new GoogleGenerativeAI(GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

async function generateGeminiResponse(prompt) {
  // Helper function to attempt generating a response with a given prompt.
  const attemptResponse = async (modPrompt) => {
    const result = await model.generateContent(modPrompt);
    const response = await result.response;
    return response.text();
  };

  // Define a series of prompts with progressively stricter instructions to avoid recitation.
  const promptAttempts = [
    prompt,
    prompt + "\n\nIMPORTANT: Generate a completely original analysis. Do not quote or recite any legal texts or excerpts. Provide a precise, synthesized explanation entirely in your own words.",
    prompt + "\n\nIMPORTANT: DO NOT include any verbatim legal text. Synthesize a fully original and accurate explanation by summarizing the legal principles in your own words without reciting any existing legal material."
  ];

  // Try each prompt in sequence.
  for (let i = 0; i < promptAttempts.length; i++) {
    try {
      const responseText = await attemptResponse(promptAttempts[i]);
      return responseText;
    } catch (error) {
      console.error(`❌ Error in attempt ${i + 1}:`, error);
      // If error message is due to RECITATION, try the next fallback prompt.
      if (!(error.message && error.message.includes("RECITATION"))) {
        // For any other error, return a generic error message.
        return "I'm sorry, I encountered an error processing your request.";
      }
      // Otherwise, continue to next attempt.
    }
  }

  // If all attempts result in a recitation error, return a safe fallback message.
  return "I'm sorry, I'm unable to generate a response due to restrictions on reciting pre-existing legal texts.";
}

async function generateChatSummary(messages) {
  // Construct a clear, structured conversation text.
  const chatText = messages
    .map((msg) => `${msg.type === "user" ? "User:" : "Bot:"} ${msg.text}`)
    .join("\n");

  // Revised prompt instructing exactly 6 essential words.
  const prompt = `Write a concise, highly accurate summary of the following chat conversation in exactly 6 words. Each word must be essential and there should be no extra text or punctuation beyond the six words.

Chat Conversation:
${chatText}`;

  try {
    let summary = await generateGeminiResponse(prompt);
    summary = summary.trim();

    // Clean up potential punctuation or extra spacing.
    summary = summary.replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, " ");

    // Enforce exactly 6 words.
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

module.exports = {
  generateGeminiResponse,
  generateChatSummary
};