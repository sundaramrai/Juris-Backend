// src/services/aiService.js
const { model } = require("../config/ai");
require('events').EventEmitter.defaultMaxListeners = 20;

const MAX_CACHE_SIZE = 1000;
const CACHE_TTL = 24 * 60 * 60 * 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const REQUEST_TIMEOUT = 15000;
const BATCH_SIZE = 5;

const INDIAN_LANGUAGE_REGEX = /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0B7F\u0B80-\u0BFF\u0C00-\u0C7F\u0C80-\u0CFF\u0D00-\u0D7F]/;
const EMERGENCY_REGEX = /urgent|emergency|immediately|asap|right now|hurry|quickly/;
const FRUSTRATED_REGEX = /frustrated|angry|upset|annoyed|ridiculous|absurd|unfair|terrible/;
const CONFUSED_REGEX = /confused|don't understand|what does this mean|explain|clarify|unclear/;
const POSITIVE_REGEX = /please|thank you|thanks|appreciate|grateful|kind|helpful/;
const GREETING_REGEX = /^(hi|hello|namaste|greetings|hey)(\s|$)/;
const ABOUT_REGEX = /who are you|what are you|what can you do|what is this|what is juris/;
const CAPABILITIES_REGEX = /what can you (help|do)|how can you help|your capabilities/;
const THANKS_REGEX = /thank|thanks|grateful|appreciate/;

const legalKeywords = new Set([
  "law", "legal", "act", "section", "court", "constitution",
  "rights", "criminal", "civil", "contract", "divorce", "property",
  "injunction", "notice", "case", "litigation", "dispute", "judicial",
  "article", "accident", "injury", "traffic", "offence", "arrest",
  "bail", "sentence", "appeal", "petition", "writ", "hearing",
  "tribunal", "authority", "jurisdiction", "complaint", "plaintiff",
  "defendant", "litigants", "litigant", "lawyer", "advocate",
  "attorney", "counsel", "solicitor", "barrister", "judge", "justice",
  "trial", "order", "judgment", "decree", "argument", "plea",
  "evidence", "proof", "document", "affidavit", "oath", "affirmation",
  "perjury", "witness", "deposition", "examination", "cross-examination",
  "testimony", "verdict", "sentence", "conviction", "acquittal", "appeal",
  "review", "revision", "settlement", "mediation", "arbitration", "mediator",
  "IPC", "CrPC", "CPC", "PIL", "FIR", "NIA", "RTI",
  "panchayat", "lok adalat", "high court", "supreme court", "district court",
  "sessions court", "nyaya panchayat", "judicial magistrate", "executive magistrate",
  "fundamental rights", "directive principles", "scheduled caste", "scheduled tribe",
  "OBC", "GST", "income tax", "RERA", "SEBI", "RBI", "consumer forum",
  "reservation", "domicile", "aadhar", "PAN", "passport", "visa", "NRC", "CAA",
  "Hindu Marriage Act", "Muslim Personal Law", "Christian Marriage Act",
  "Special Marriage Act", "maintenance", "ayodhya", "triple talaq",
  "dowry", "domestic violence", "motor vehicle", "challan", "talaq",
  "khula", "iddat", "mehar", "cruelty", "alimony", "minor", "guardianship",
  "138 NI Act", "cheque bounce", "negotiable", "dishonor", "SARFAESI",
  "cyber crime", "IT Act", "copyright", "trademark", "patent", "defamation",
  "prevention of corruption", "lokpal", "lokayukta", "POCSO", "juvenile",
  "narcotic", "NDPS", "PMLA", "insolvency", "IBC", "arbitration",
  "mediation", "conciliation", "rent control", "eviction", "MACT",
  "compensation", "damages", "recovery", "execution", "attachment"
]);

const nonLegalCategories = {
  "general_chat": new Set(["hello", "hi", "how are you", "your name", "who are you", "what can you do", "help me", "thanks", "thank you"]),
  "technical_support": new Set(["error", "bug", "not working", "problem", "issue", "fix", "broken", "upgrade", "update"]),
  "feedback": new Set(["feedback", "suggestion", "improve", "rate", "review", "like", "dislike"]),
  "related_services": new Set(["government", "policy", "procedure", "document", "application", "form", "process", "service"])
};

const legalCategories = {
  "criminal": new Set(["IPC", "CrPC", "FIR", "arrest", "bail", "criminal", "theft", "murder", "assault", "robbery", "POCSO", "rape", "kidnap", "fraud", "cheating", "forgery", "narcotics", "NDPS", "arms", "terrorism", "cyber crime", "defamation"]),
  "civil": new Set(["CPC", "contract", "property", "tenancy", "rent", "lease", "partition", "succession", "inheritance", "specific performance", "injunction", "possession", "eviction", "recovery", "compensation", "damages"]),
  "family": new Set(["marriage", "divorce", "custody", "maintenance", "adoption", "guardianship", "succession", "hindu marriage", "muslim marriage", "christian marriage", "special marriage", "alimony", "domestic violence", "streedhan", "joint family", "separation", "mutual consent"]),
  "constitutional": new Set(["fundamental rights", "directive principles", "writ", "article", "constitution", "PIL", "supreme court", "high court", "constitutional bench", "review petition", "curative petition", "basic structure", "amendment"]),
  "property": new Set(["property", "land", "registration", "stamp duty", "transfer", "gift", "will", "RERA", "mutation", "possession", "title deed", "encumbrance", "mortgage", "lease", "khata", "encroachment", "adverse possession", "easement"]),
  "labor": new Set(["salary", "wages", "bonus", "gratuity", "PF", "ESI", "termination", "unfair dismissal", "factories act", "industrial dispute", "strike", "lock-out", "layoff", "retrenchment", "workmen compensation", "maternity benefit"]),
  "tax": new Set(["income tax", "GST", "service tax", "TDS", "returns", "assessment", "appeal", "refund", "penalty", "scrutiny", "notice", "exemption", "deduction", "audit", "wealth tax", "professional tax"]),
  "consumer": new Set(["consumer", "deficiency", "product", "service", "refund", "replacement", "unfair trade", "guarantee", "warranty", "manufacturing defect", "misleading advertisement", "unfair contract"]),
  "motor vehicle": new Set(["accident", "compensation", "insurance", "claim", "motor vehicle", "driver", "license", "permit", "registration", "challan", "traffic", "MACT", "hit and run", "DUI", "rash driving", "negligence"]),
  "banking": new Set(["loan", "mortgage", "interest", "default", "NPA", "recovery", "DRT", "SARFAESI", "foreclosure", "credit card", "banking ombudsman", "negotiable instrument", "cheque bounce", "138 NI Act"])
};

class AdvancedPerformanceCache {
  constructor(maxSize = 100, ttlMs = 3600000, name = 'cache') {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.name = name;
    this.hits = 0;
    this.misses = 0;
    this.total = 0;
    this.evictions = 0;
    this.errors = 0;
    this.lastCleanup = Date.now();
    this.cleanupInterval = 60 * 60 * 1000;
  }

  set(key, value) {
    this._performCleanupIfNeeded();

    if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
      this.evictions++;
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      accessCount: 0
    });
    return value;
  }

  get(key) {
    this.total++;
    this._performCleanupIfNeeded();
    if (!this.cache.has(key)) {
      this.misses++;
      return null;
    }

    const entry = this.cache.get(key);
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }
    entry.accessCount++;
    entry.lastAccessed = Date.now();
    this.hits++;
    return entry.value;
  }

  has(key) {
    if (!this.cache.has(key)) return false;
    const entry = this.cache.get(key);
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return false;
    }
    return true;
  }

  _performCleanupIfNeeded() {
    const now = Date.now();
    if (now - this.lastCleanup > this.cleanupInterval) {
      this._cleanup();
      this.lastCleanup = now;
    }
  }

  _cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      if (now - entry.timestamp > this.ttlMs) {
        this.cache.delete(key);
        this.evictions++;
      }
    }
  }

  getStats() {
    return {
      name: this.name,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: this.total > 0 ? (this.hits / this.total) * 100 : 0,
      hits: this.hits,
      misses: this.misses,
      total: this.total,
      evictions: this.evictions,
      errors: this.errors
    };
  }

  clear() {
    this.cache.clear();
    this.hits = 0;
    this.misses = 0;
    this.total = 0;
    this.evictions = 0;
    this.errors = 0;
  }
}

const classificationCache = new AdvancedPerformanceCache(MAX_CACHE_SIZE, CACHE_TTL, 'classification');
const responseCache = new AdvancedPerformanceCache(MAX_CACHE_SIZE * 2, CACHE_TTL, 'response');
const dynamicClassificationCache = new AdvancedPerformanceCache(MAX_CACHE_SIZE, CACHE_TTL, 'dynamicClassification');
const performanceMetrics = {
  aiCalls: 0,
  aiErrors: 0,
  avgResponseTime: 0,
  totalResponseTime: 0,
  maxResponseTime: 0,
  minResponseTime: Number.MAX_SAFE_INTEGER,
  responseTimes: [],
  requestsPerMinute: 0,
  lastMinuteRequests: [],
  startTime: Date.now(),
  timeouts: 0,
  retries: 0,
  successfulRetries: 0
};

async function withRetry(fn, maxRetries = MAX_RETRIES, initialDelay = RETRY_DELAY, shouldThrow = false) {
  let lastError;
  let attempt = 1;

  while (attempt <= maxRetries) {
    try {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(new Error(`Request timed out after ${REQUEST_TIMEOUT}ms`));
        }, REQUEST_TIMEOUT);
      });
      const result = await Promise.race([fn(), timeoutPromise]);
      if (attempt > 1) {
        performanceMetrics.successfulRetries++;
      }

      return result;
    } catch (error) {
      console.error(`Attempt ${attempt}/${maxRetries} failed:`, error.message);
      lastError = error;
      performanceMetrics.retries++;

      if (error.message.includes('timed out')) {
        performanceMetrics.timeouts++;
      }

      if (attempt < maxRetries) {
        const delay = initialDelay * Math.pow(2, attempt - 1);
        await new Promise(resolve => setTimeout(resolve, delay));
        attempt++;
      } else {
        break;
      }
    }
  }

  if (shouldThrow) {
    throw lastError;
  }

  return {
    response: "I'm sorry, I'm having trouble processing your request right now. Please try again in a moment.",
    classification: {
      isLegal: false,
      category: "error",
      confidence: 0
    },
    error: lastError
  };
}

async function batchProcessQueries(queries) {
  if (!queries || !queries.length) return [];

  const results = [];
  for (let i = 0; i < queries.length; i += BATCH_SIZE) {
    const batch = queries.slice(i, i + BATCH_SIZE);
    const batchPromises = batch.map(query => processQuery(query));
    const batchResults = await Promise.all(batchPromises);
    results.push(...batchResults);
  }

  return results;
}

async function classifyQueryWithGemini(query) {
  const cacheKey = query.toLowerCase().trim();
  if (dynamicClassificationCache.has(cacheKey)) {
    return dynamicClassificationCache.get(cacheKey);
  }

  const startTime = Date.now();
  performanceMetrics.aiCalls++;

  try {
    const classificationPrompt = `
Analyze the following query text and classify it according to these parameters. Be very precise in your classification.

Query: "${query}"

Required output format (JSON):
{
  "isLegal": boolean,
  "confidence": number 0-1,
  "category": string,
  "subCategory": string or null,
  "requestType": string,
  "sentiment": string,
  "complexity": number 1-5,
  "specificLaws": string[]
}

For isLegal: true only if the query directly relates to Indian law, regulations, rights, or legal procedures.
For category: Use "legal" if isLegal is true, otherwise use "general_chat", "technical_support", "feedback", or "related_services".
For subCategory: If legal, choose one: "criminal", "civil", "family", "constitutional", "property", "labor", "tax", "consumer", "motor vehicle", "banking", or "general".
For requestType: Choose from "information", "procedural", "advice", or "resource".
For sentiment: Analyze emotion as "neutral", "urgent", "frustrated", "confused", or "positive".
For complexity: Rate 1 (simple) to 5 (complex) based on technical/legal depth required.
For specificLaws: Identify specific Indian laws, acts, or sections mentioned (empty array if none).
`;

    const result = await withRetry(async () => {
      return await model.generateContent(classificationPrompt);
    }, 2);

    const responseText = await result.response.text();
    let extractedJson = responseText.trim();
    const endTime = Date.now();
    const responseTime = endTime - startTime;

    performanceMetrics.totalResponseTime += responseTime;
    performanceMetrics.avgResponseTime = performanceMetrics.totalResponseTime / performanceMetrics.aiCalls;
    performanceMetrics.maxResponseTime = Math.max(performanceMetrics.maxResponseTime, responseTime);
    performanceMetrics.minResponseTime = Math.min(performanceMetrics.minResponseTime, responseTime);
    performanceMetrics.responseTimes.push(responseTime);
    if (performanceMetrics.responseTimes.length > 100) {
      performanceMetrics.responseTimes.shift();
    }
    const now = Date.now();
    performanceMetrics.lastMinuteRequests.push(now);
    performanceMetrics.lastMinuteRequests = performanceMetrics.lastMinuteRequests.filter(t => now - t < 60000);
    performanceMetrics.requestsPerMinute = performanceMetrics.lastMinuteRequests.length;

    if (extractedJson.startsWith('```json')) {
      extractedJson = extractedJson.substring(7, extractedJson.length - 3).trim();
    }
    if (extractedJson.startsWith('{') && extractedJson.endsWith('}')) {
      try {
        const classification = JSON.parse(extractedJson);
        const completeClassification = {
          isLegal: classification.isLegal || false,
          confidence: classification.confidence || 0,
          category: classification.category || "non_legal",
          subCategory: classification.isLegal ? (classification.subCategory || "general") : null,
          requestType: classification.requestType || "information",
          sentiment: classification.sentiment || "neutral",
          complexity: classification.complexity || 1,
          specificLaws: classification.specificLaws || [],
          containsIndianLanguage: INDIAN_LANGUAGE_REGEX.test(query),
          isEmergency: isEmergencyLegalQuery(query)
        };

        return dynamicClassificationCache.set(cacheKey, completeClassification);
      } catch (parseError) {
        console.error("Failed to parse classification JSON:", parseError);
        dynamicClassificationCache.errors++;
      }
    }
  } catch (error) {
    console.error("Error in Gemini classification:", error);
    performanceMetrics.aiErrors++;
  }
  return classifyQuery(query);
}

function classifyQuery(query) {
  const cacheKey = query.toLowerCase().trim();
  if (classificationCache.has(cacheKey)) {
    return classificationCache.get(cacheKey);
  }

  const result = {
    isLegal: false,
    confidence: 0,
    category: "non_legal",
    subCategory: null,
    requestType: "information",
    containsIndianLanguage: INDIAN_LANGUAGE_REGEX.test(query),
    isEmergency: isEmergencyLegalQuery(query),
    sentiment: detectQuerySentiment(query)
  };

  const q = query.toLowerCase();
  let matchingKeywordCount = 0;

  const words = q.split(/\s+/);
  for (const word of words) {
    if (legalKeywords.has(word)) {
      matchingKeywordCount++;
    }
  }

  for (const keyword of legalKeywords) {
    if (keyword.includes(" ") && q.includes(keyword)) {
      matchingKeywordCount++;
    }
  }

  if (matchingKeywordCount > 0) {
    result.isLegal = true;
    result.confidence = Math.min(matchingKeywordCount / 3, 1);
    result.category = "legal";
    result.subCategory = categorizeIndianLegalQuery(query);

    if (q.includes("how to") || q.includes("process") || q.includes("procedure") || q.includes("steps")) {
      result.requestType = "procedural";
    } else if (q.includes("help") || q.includes("advice") || q.includes("should i")) {
      result.requestType = "advice";
    } else if (q.includes("where can i") || q.includes("resources") || q.includes("contact")) {
      result.requestType = "resource";
    }
  } else {
    if (q.length < 5 && (q === "hi" || q === "hey" || q === "hello")) {
      result.category = "general_chat";
    } else {
      for (const [category, keywords] of Object.entries(nonLegalCategories)) {
        if (words.some(word => keywords.has(word)) ||
          Array.from(keywords).some(keyword => keyword.includes(" ") && q.includes(keyword))) {
          result.category = category;
          break;
        }
      }
    }
  }

  if (classificationCache.size >= MAX_CACHE_SIZE) {
    const firstKey = classificationCache.keys().next().value;
    classificationCache.delete(firstKey);
  }
  classificationCache.set(cacheKey, result);

  return result;
}

async function generateGeminiResponse(prompt, queryClassification = null) {
  const cacheKey = prompt + (queryClassification ? JSON.stringify(queryClassification) : '');
  if (responseCache.has(cacheKey)) {
    return responseCache.get(cacheKey);
  }
  if (!queryClassification) {
    queryClassification = await classifyQueryDynamic(prompt);
  }
  if (queryClassification.category === "general_chat") {
    const response = generateChatResponse(prompt, queryClassification);
    return responseCache.set(cacheKey, response);
  } else if (!queryClassification.isLegal) {
    const response = handleNonLegalQuery(prompt, queryClassification);
    return responseCache.set(cacheKey, response);
  }

  const startTime = Date.now();
  performanceMetrics.aiCalls++;

  const generateResponse = async (modPrompt, attempt = 1) => {
    try {
      const result = await withRetry(async () => await model.generateContent(modPrompt), 2);
      const response = await result.response;
      const endTime = Date.now();
      const responseTime = endTime - startTime;

      performanceMetrics.totalResponseTime += responseTime;
      performanceMetrics.avgResponseTime = performanceMetrics.totalResponseTime / performanceMetrics.aiCalls;
      performanceMetrics.maxResponseTime = Math.max(performanceMetrics.maxResponseTime, responseTime);
      performanceMetrics.minResponseTime = Math.min(performanceMetrics.minResponseTime, responseTime);
      performanceMetrics.responseTimes.push(responseTime);
      if (performanceMetrics.responseTimes.length > 100) {
        performanceMetrics.responseTimes.shift();
      }

      return response.text();
    } catch (error) {
      console.error(`AI response generation error (attempt ${attempt}):`, error);
      performanceMetrics.aiErrors++;
      throw error;
    }
  };

  const optimizedPrompt = buildOptimizedPrompt(prompt, queryClassification);

  try {
    const responseText = await generateResponse(optimizedPrompt.mainPrompt, 1);
    let processedResponse = responseText;
    if (queryClassification.isEmergency || queryClassification.complexity >= 4) {
      processedResponse = simplifyLegalTerms(responseText);
    }
    const formattedResponse = formatIndianLegalResponse(
      processedResponse,
      queryClassification.subCategory || "general",
      queryClassification.sentiment
    );

    return responseCache.set(cacheKey, formattedResponse);
  } catch (error) {
    if (error.message?.includes("RECITATION") || error.message?.includes("BLOCKED")) {
      try {
        const fallbackResponse = await generateResponse(optimizedPrompt.fallbackPrompt, 2);
        const formattedFallback = formatIndianLegalResponse(
          fallbackResponse,
          queryClassification.subCategory || "general",
          queryClassification.sentiment
        );
        return responseCache.set(cacheKey, formattedFallback);
      } catch (fallbackError) {
        console.error("Both main and fallback prompts failed:", fallbackError);
        return "I'm experiencing some difficulty providing a complete answer to your legal question. Could you please rephrase your query or ask about a specific aspect of this legal topic?";
      }
    }
    return error.message?.includes("RECITATION")
      ? "I'm sorry, I'm unable to generate a response due to restrictions on reciting pre-existing legal texts. Please ask a more specific question about your legal concern."
      : "I'm sorry, I encountered an error processing your legal query. Please try rephrasing your question.";
  }
}

function buildOptimizedPrompt(query, classification) {
  const category = classification.subCategory || "general";
  const sentiment = classification.sentiment;
  const requestType = classification.requestType;
  const complexity = classification.complexity || 1;
  const specificLaws = classification.specificLaws || [];

  let mainPrompt = `[SYSTEM: You are Juris, an expert legal assistant specializing in Indian law. Provide accurate, clear, and helpful information based on current Indian legal statutes, precedents, and practices. When relevant, cite specific laws, sections, or judgments. Avoid legal jargon when possible and explain complex terms. Structure your answers clearly with relevant headings and bullet points where appropriate. Your goal is to make Indian legal information accessible to citizens.]\n\n`;
  mainPrompt += `[CONTEXT: The following question relates to ${category} law in India. The user's sentiment appears to be ${sentiment}. They seem to be requesting ${requestType} assistance. The query complexity is rated ${complexity}/5.`;

  if (specificLaws.length > 0) {
    mainPrompt += ` The query specifically mentions: ${specificLaws.join(", ")}.`;
  }

  mainPrompt += `]\n\n${query}`;
  if (classification.isEmergency) {
    mainPrompt = `[SYSTEM: This appears to be an URGENT legal situation. Prioritize immediate actionable steps and emergency resources in your response.]\n\n${mainPrompt}`;
  }
  if (classification.containsIndianLanguage) {
    mainPrompt = `[SYSTEM: The query contains text in an Indian language. Try to understand the intent and respond in simple English with cultural sensitivity.]\n\n${mainPrompt}`;
  }
  const fallbackPrompt = mainPrompt + "\n\n[SYSTEM: Generate a completely original analysis. Do not quote any legal texts verbatim. Provide a synthesized explanation entirely in your own words, focusing on practical implications and general principles rather than specific statutory language.]";

  return { mainPrompt, fallbackPrompt };
}

async function generateChatSummary(messages) {
  if (!messages || messages.length === 0) {
    return "No conversation to summarize";
  }
  const recentMessages = messages.slice(-10);

  const chatText = recentMessages
    .map((msg) => `${msg.type === "user" ? "User:" : "Bot:"} ${msg.text}`)
    .join("\n");

  const prompt = `Summarize this legal conversation in exactly 6 words:

${chatText}`;

  try {
    let summary = await generateGeminiResponse(prompt, { isLegal: false, category: "general_chat" });
    summary = summary.trim().replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, " ");
    const words = summary.split(" ").filter(word => word.length > 0).slice(0, 6);
    return words.join(" ");
  } catch (error) {
    console.error("❌ Error generating chat summary:", error);
    return "Summary unavailable";
  }
}

async function processQuery(query) {
  try {
    const classification = await classifyQueryDynamic(query);
    const response = await generateGeminiResponse(query, classification);
    return {
      response,
      classification
    };
  } catch (error) {
    console.error("Error in processQuery:", error);
    return {
      response: "I apologize, but I'm having trouble processing your request right now. Please try again in a moment.",
      classification: {
        isLegal: false,
        category: "error",
        confidence: 0
      },
      error: error.message
    };
  }
}

function getServiceMetrics() {
  const now = Date.now();
  let medianResponseTime = 0;
  if (performanceMetrics.responseTimes.length > 0) {
    const sortedTimes = [...performanceMetrics.responseTimes].sort((a, b) => a - b);
    const midIndex = Math.floor(sortedTimes.length / 2);
    medianResponseTime = sortedTimes.length % 2 === 0
      ? (sortedTimes[midIndex - 1] + sortedTimes[midIndex]) / 2
      : sortedTimes[midIndex];
  }

  return {
    performance: {
      ...performanceMetrics,
      uptime: Math.floor((now - performanceMetrics.startTime) / 1000),
      medianResponseTime,
      p95ResponseTime: calculatePercentile(performanceMetrics.responseTimes, 95),
      lastMinuteRequests: performanceMetrics.lastMinuteRequests.length,
    },
    caches: {
      classification: classificationCache.getStats(),
      response: responseCache.getStats(),
      dynamicClassification: dynamicClassificationCache.getStats()
    },
    system: {
      memory: process.memoryUsage(),
      cpuUsage: process.cpuUsage()
    }
  };
}

function calculatePercentile(array, percentile) {
  if (!array.length) return 0;
  const sorted = [...array].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[index];
}

function detectQuerySentiment(query) {
  const q = query.toLowerCase();
  if (EMERGENCY_REGEX.test(q)) {
    return "urgent";
  }
  if (FRUSTRATED_REGEX.test(q)) {
    return "frustrated";
  }
  if (CONFUSED_REGEX.test(q)) {
    return "confused";
  }
  if (POSITIVE_REGEX.test(q)) {
    return "positive";
  }

  return "neutral";
}

function isLegalQuery(query) {
  return classifyQuery(query).isLegal;
}

function categorizeIndianLegalQuery(query) {
  const q = query.toLowerCase();

  for (const [category, keywords] of Object.entries(legalCategories)) {
    for (const word of q.split(/\s+/)) {
      if (keywords.has(word)) {
        return category;
      }
    }
    for (const keyword of keywords) {
      if (keyword.includes(" ") && q.includes(keyword)) {
        return category;
      }
    }
  }

  return "general";
}

const resourcesCache = {};
function generateIndianLegalResources(category) {
  if (resourcesCache[category]) {
    return resourcesCache[category];
  }

  const resources = {
    "criminal": [
      "National Legal Services Authority (NALSA): https://nalsa.gov.in",
      "State Legal Aid Centers",
      "Police Helpline: 100",
      "Women Helpline: 1091",
      "Child Helpline: 1098",
      "Legal Aid Defense Counsel System",
      "E-Prison Portal: https://eprisons.nic.in"
    ],
    "civil": [
      "District Legal Services Authority",
      "Civil Courts",
      "Lok Adalats",
      "E-Courts Services Portal: https://ecourts.gov.in",
      "National Judicial Data Grid: https://njdg.ecourts.gov.in",
      "Online e-Filing: https://efiling.ecourts.gov.in"
    ],
    "family": [
      "Family Courts",
      "Women and Child Development Ministry Helpline: 1098",
      "National Commission for Women Helpline: 7827170170",
      "Central Adoption Resource Authority: http://cara.nic.in",
      "Family Counseling Centers",
      "Protection Officers under Domestic Violence Act"
    ],
    "constitutional": [
      "High Courts",
      "Supreme Court of India: https://main.sci.gov.in",
      "Human Rights Commission: https://nhrc.nic.in",
      "Right to Information Portal: https://rtionline.gov.in",
      "Law Commission of India: https://lawcommissionofindia.nic.in"
    ],
    "property": [
      "Sub-Registrar Office",
      "Revenue Department",
      "RERA Authority: https://rera.gov.in",
      "Land Records: https://dilrmp.gov.in",
      "PropertyRegistration Portal",
      "Bhulekh portal (for land records)"
    ],
    "labor": [
      "Labor Commissioner Office",
      "Employee Provident Fund Organization: https://www.epfindia.gov.in",
      "Labor Courts",
      "ESIC: https://www.esic.nic.in",
      "Shram Suvidha Portal: https://shramsuvidha.gov.in",
      "Chief Labour Commissioner"
    ],
    "tax": [
      "Income Tax Department: https://www.incometaxindia.gov.in",
      "GST Portal: https://www.gst.gov.in",
      "Tax Information Network: https://www.tin-nsdl.com",
      "Income Tax Appellate Tribunal",
      "AAR (Authority for Advance Ruling)",
      "E-filing Portal: https://www.incometax.gov.in/iec/foportal"
    ],
    "consumer": [
      "Consumer Forums",
      "National Consumer Helpline: 1800-11-4000",
      "Online Consumer Mediation Centre",
      "CONFONET: https://confonet.nic.in",
      "Consumer Affairs Department: https://consumeraffairs.nic.in",
      "Consumer Protection Act, 2019 resources"
    ],
    "motor vehicle": [
      "Motor Accident Claims Tribunal",
      "Traffic Police Helpline",
      "Insurance Regulatory Authority of India: https://www.irdai.gov.in",
      "Parivahan Sewa: https://parivahan.gov.in",
      "Insurance Ombudsman",
      "Road Safety Authority"
    ],
    "banking": [
      "Banking Ombudsman: https://bankingombudsman.rbi.org.in",
      "Debt Recovery Tribunal",
      "RBI Grievance Portal: https://cms.rbi.org.in",
      "SARFAESI Authorities",
      "Financial Redressal Agency",
      "Insolvency and Bankruptcy Board: https://ibbi.gov.in"
    ],
    "general": [
      "NALSA: https://nalsa.gov.in",
      "District Legal Services Authority",
      "E-Courts Services Portal: https://ecourts.gov.in",
      "Tele-Law Service: 1516",
      "Nyaya Mitra Helpline",
      "Legal Information Management & Briefing System: https://limbs.gov.in",
      "Department of Justice: https://doj.gov.in"
    ]
  };

  resourcesCache[category] = resources[category] || resources["general"];
  return resourcesCache[category];
}

function formatIndianLegalResponse(responseText, category, sentiment = "neutral") {
  const resources = generateIndianLegalResources(category);
  const resourcesText = resources.join("\n- ");

  let formattedResponse = responseText.trim();
  formattedResponse += "\n\n**Disclaimer**: This information is meant for general guidance only and should not be construed as professional legal advice. For specific legal issues, please consult with a qualified lawyer.";
  if (resources.length > 0) {
    formattedResponse += "\n\n**Helpful Resources**:\n- " + resourcesText;
  }

  const sentimentPrefixes = {
    "frustrated": "I understand this legal situation can be frustrating. Let me try to help you find clarity.\n\n",
    "urgent": "I recognize the urgency of your situation. Here's information that may help you take immediate action:\n\n",
    "confused": "Legal matters can be complex. Let me break this down in simpler terms:\n\n"
  };

  if (sentimentPrefixes[sentiment]) {
    formattedResponse = sentimentPrefixes[sentiment] + formattedResponse;
  }

  return formattedResponse;
}

function handleNonLegalQuery(query, classification) {
  const handlers = {
    "general_chat": generateChatResponse,
    "technical_support": generateTechnicalSupportResponse,
    "feedback": generateFeedbackResponse,
    "related_services": generateRelatedServiceResponse
  };

  const handler = handlers[classification.category];
  return handler ? handler(query, classification) : redirectToLegalHelp(query, classification);
}

function generateChatResponse(query, _classification) {
  const q = query.toLowerCase().trim();

  if (q === "hi" || q === "hello" || q === "hey" || q === "namaste" || GREETING_REGEX.test(q)) {
    return "Namaste! I'm Juris, your legal assistant for Indian law. How can I help you with your legal query today?";
  }
  if (ABOUT_REGEX.test(q)) {
    return "I'm Juris, an AI assistant specialized in Indian law. I can help answer legal questions, explain legal procedures, provide information about your rights, and guide you to appropriate resources. While I'm designed to assist with legal topics in India, I'm not a lawyer and my responses shouldn't replace professional legal advice.";
  }
  if (CAPABILITIES_REGEX.test(q)) {
    return "As Juris, I can:\n\n- Answer questions about Indian laws and legal procedures\n- Explain legal terms in simple language\n- Guide you to relevant legal resources\n- Help understand documents like notices or summons\n- Provide information on various legal processes\n- Direct you to emergency legal services when needed\n\nWhat legal matter can I assist you with today?";
  }
  if (THANKS_REGEX.test(q)) {
    return "You're welcome! I'm glad I could be of assistance. If you have any other legal questions in the future, feel free to ask. Is there anything else you'd like to know about Indian law?";
  }

  return "I'm here to help with legal questions related to Indian law. Could you please share what legal matter you're inquiring about? For example, you might ask about family law, property rights, or criminal procedures.";
}

function generateTechnicalSupportResponse(query) {
  return "I notice you might be having technical issues. While I'm designed to help with legal questions, I'd be happy to assist with basic troubleshooting. For specific technical problems with the Juris application, you may want to contact our support team. In the meantime, is there a legal question I can help you with?";
}

function generateFeedbackResponse(query) {
  return "Thank you for your feedback! We're constantly working to improve Juris to better serve your legal information needs. Your input helps us grow. If you have specific legal questions or concerns, I'd be happy to address those for you now.";
}

function generateRelatedServiceResponse(query) {
  return "I notice you're asking about government services or procedures. While I specialize in legal information, many government processes have legal components I can help clarify. Could you provide more details about your specific situation so I can guide you appropriately? For comprehensive government service information, you might also find the National Government Services Portal (https://services.india.gov.in) helpful.";
}

function redirectToLegalHelp(query, classification) {
  return "I'm specialized in providing information about Indian law and legal procedures. While I don't have enough context to address your current question, I'd be happy to help with any legal matters you might have. You could ask about rights, procedures, documents, or specific laws in India. How can I assist you with a legal concern today?";
}

async function classifyQueryDynamic(query) {
  const geminiClassification = await classifyQueryWithGemini(query);
  if (geminiClassification) {
    return geminiClassification;
  }
  return classifyQuery(query);
}

function containsIndianLanguage(query) {
  return INDIAN_LANGUAGE_REGEX.test(query);
}

const legalTermsMap = {
  "ab initio": "from the beginning",
  "affidavit": "written statement under oath",
  "caveat": "formal notice or warning",
  "decree": "court order",
  "ex parte": "with only one party present",
  "habeas corpus": "court order to present a detained person",
  "injunction": "court order to stop doing something",
  "jurisprudence": "legal theory or philosophy",
  "locus standi": "right to bring a legal action",
  "mandamus": "court order to perform a duty",
  "sine die": "without setting a date",
  "status quo": "existing state of affairs",
  "suo motu": "on its own motion",
  "ultra vires": "beyond legal authority"
};

function simplifyLegalTerms(text) {
  const termsPattern = new RegExp('\\b(' + Object.keys(legalTermsMap).join('|') + ')\\b', 'gi');

  return text.replace(termsPattern, (match) => {
    const term = match.toLowerCase();
    const definition = legalTermsMap[term];
    return `${match} (${definition})`;
  });
}

const emergencyKeywords = new Set([
  "arrested", "detention", "police custody", "urgent bail",
  "domestic violence", "immediate danger", "threats", "abuse",
  "emergency protection", "assault", "right now", "urgent help"
]);

function isEmergencyLegalQuery(query) {
  const q = query.toLowerCase();
  const words = q.split(/\s+/);

  for (const word of words) {
    if (emergencyKeywords.has(word)) {
      return true;
    }
  }
  return Array.from(emergencyKeywords)
    .filter(keyword => keyword.includes(" "))
    .some(phrase => q.includes(phrase));
}

let emergencyResourcesCache = null;
function getEmergencyLegalResources() {
  if (emergencyResourcesCache) {
    return emergencyResourcesCache;
  }

  emergencyResourcesCache = {
    "police": "100",
    "women_helpline": "1091",
    "child_helpline": "1098",
    "senior_citizen_helpline": "14567",
    "national_legal_services_authority": "1516",
    "domestic_violence_helpline": "181"
  };

  return emergencyResourcesCache;
}

module.exports = {
  isLegalQuery,
  generateGeminiResponse,
  generateChatSummary,
  categorizeIndianLegalQuery,
  generateIndianLegalResources,
  formatIndianLegalResponse,
  containsIndianLanguage,
  simplifyLegalTerms,
  isEmergencyLegalQuery,
  getEmergencyLegalResources,
  classifyQuery,
  handleNonLegalQuery,
  classifyQueryDynamic,
  processQuery,
  getServiceMetrics,
  withRetry,
  batchProcessQueries
};