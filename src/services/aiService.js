// src/services/aiService.js
const { model } = require("../config/ai");

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

module.exports = { isLegalQuery, generateGeminiResponse, generateChatSummary };