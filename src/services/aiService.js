// src/services/aiService.js
const { model } = require("../config/ai");
require('events').EventEmitter.defaultMaxListeners = 20;

const CONFIG = {
  CACHE: {
    MAX_SIZE: 1000,
    TTL: 24 * 60 * 60 * 1000,
  },
  REQUEST: {
    MAX_RETRIES: 3,
    RETRY_DELAY: 1000,
    TIMEOUT: 15000,
    MAX_CONCURRENT: 10,
    BATCH_SIZE: 5
  },
  HEALTH: {
    CHECK_INTERVAL: 30000,
    MAX_CONSECUTIVE_ERRORS: 3
  }
};

const REGEX = {
  INDIAN_LANGUAGE: /[\u0900-\u097F\u0980-\u09FF\u0A00-\u0A7F\u0A80-\u0AFF\u0B00-\u0BFF]|\u0C00|[\u0C01-\u0C7F]|\u0C80|[\u0C81-\u0CFF]|\u0D00|[\u0D01-\u0D7F]/,
  EMERGENCY: /urgent|emergency|immediately|asap|right now|hurry|quickly/i,
  FRUSTRATED: /frustrated|angry|upset|annoyed|ridiculous|absurd|unfair|terrible/i,
  CONFUSED: /confused|don't understand|what does this mean|explain|clarify|unclear/i,
  POSITIVE: /please|thank you|thanks|appreciate|grateful|kind|helpful/i,
  GREETING: /^(hi|hello|namaste|greetings|hey)(\s|$)/i,
  ABOUT: /who are you|what are you|what can you do|what is this|what is juris/i,
  CAPABILITIES: /what can you (help|do)|how can you help|your capabilities/i,
  THANKS: /thank|thanks|grateful|appreciate/i
};

const KEYWORDS = {
  legal: new Set([
    "law", "legal", "act", "section", "court", "constitution", "rights",
    "criminal", "civil", "contract", "divorce", "property", "injunction",
    "notice", "case", "litigation", "dispute", "judicial", "article",
    "accident", "injury", "traffic", "offence", "arrest", "bail", "sentence",
    "appeal", "petition", "writ", "hearing", "tribunal", "authority",
    "jurisdiction", "complaint", "plaintiff", "defendant", "lawyer", "advocate",
    "attorney", "counsel", "judge", "justice", "trial", "order", "judgment",
    "decree", "evidence", "witness", "testimony", "verdict", "conviction",
    "acquittal", "settlement", "mediation", "arbitration", "IPC", "CrPC",
    "CPC", "PIL", "FIR", "RTI", "GST", "RERA", "SEBI", "RBI", "POCSO",
    "NDPS", "PMLA", "IBC", "SARFAESI", "NI Act", "cheque bounce", "dowry",
    "domestic violence", "maintenance", "alimony", "custody", "guardianship"
  ]),

  nonLegal: {
    general_chat: new Set(["hello", "hi", "how are you", "your name", "who are you", "thanks"]),
    technical_support: new Set(["error", "bug", "not working", "problem", "fix", "broken"]),
    feedback: new Set(["feedback", "suggestion", "improve", "rate", "review"]),
    related_services: new Set(["government", "policy", "document", "application", "form"])
  },

  emergency: new Set([
    "arrested", "detention", "police custody", "urgent bail", "domestic violence",
    "immediate danger", "threats", "abuse", "emergency protection", "assault"
  ])
};

const LEGAL_CATEGORIES = {
  criminal: new Set(["IPC", "CrPC", "FIR", "arrest", "bail", "theft", "murder", "assault", "POCSO", "rape", "kidnap", "fraud", "NDPS"]),
  civil: new Set(["CPC", "contract", "property", "tenancy", "rent", "lease", "partition", "succession", "injunction", "possession"]),
  family: new Set(["marriage", "divorce", "custody", "maintenance", "adoption", "guardianship", "alimony", "domestic violence"]),
  constitutional: new Set(["fundamental rights", "writ", "article", "constitution", "PIL", "supreme court", "high court"]),
  property: new Set(["property", "land", "registration", "stamp duty", "RERA", "mutation", "title deed", "mortgage"]),
  labor: new Set(["salary", "wages", "bonus", "gratuity", "PF", "ESI", "termination", "unfair dismissal"]),
  tax: new Set(["income tax", "GST", "service tax", "TDS", "returns", "assessment", "appeal"]),
  consumer: new Set(["consumer", "deficiency", "product", "service", "refund", "warranty"]),
  motor_vehicle: new Set(["accident", "compensation", "insurance", "motor vehicle", "license", "challan", "MACT"]),
  banking: new Set(["loan", "mortgage", "NPA", "recovery", "DRT", "SARFAESI", "cheque bounce", "138 NI Act"])
};

const LEGAL_RESOURCES = {
  criminal: [
    "National Legal Services Authority (NALSA): https://nalsa.gov.in",
    "Police Helpline: 100",
    "Women Helpline: 1091",
    "Child Helpline: 1098"
  ],
  civil: [
    "E-Courts Services Portal: https://ecourts.gov.in",
    "National Judicial Data Grid: https://njdg.ecourts.gov.in",
    "Lok Adalats"
  ],
  family: [
    "Family Courts",
    "National Commission for Women: 7827170170",
    "Central Adoption Resource Authority: http://cara.nic.in"
  ],
  constitutional: [
    "Supreme Court: https://main.sci.gov.in",
    "Human Rights Commission: https://nhrc.nic.in",
    "RTI Portal: https://rtionline.gov.in"
  ],
  property: [
    "RERA Authority: https://rera.gov.in",
    "Land Records: https://dilrmp.gov.in"
  ],
  labor: [
    "EPFO: https://www.epfindia.gov.in",
    "ESIC: https://www.esic.nic.in",
    "Shram Suvidha: https://shramsuvidha.gov.in"
  ],
  tax: [
    "Income Tax: https://www.incometaxindia.gov.in",
    "GST Portal: https://www.gst.gov.in"
  ],
  consumer: [
    "Consumer Helpline: 1800-11-4000",
    "CONFONET: https://confonet.nic.in"
  ],
  motor_vehicle: [
    "Parivahan Sewa: https://parivahan.gov.in",
    "IRDA: https://www.irdai.gov.in"
  ],
  banking: [
    "Banking Ombudsman: https://bankingombudsman.rbi.org.in",
    "RBI Grievance: https://cms.rbi.org.in"
  ],
  general: [
    "NALSA: https://nalsa.gov.in",
    "E-Courts: https://ecourts.gov.in",
    "Tele-Law: 1516"
  ]
};

const RESPONSE_TEMPLATES = {
  greeting: {
    formal: "Namaste! I'm Juris, your legal assistant for Indian law. How may I be of service?",
    casual: "Hi! I'm Juris, here to help with Indian law questions. What's on your mind?",
    neutral: "Namaste! I'm Juris. How can I help you with your legal query today?"
  },
  about: {
    short: "I'm Juris, an AI legal assistant for Indian law.",
    neutral: "I'm Juris, an AI assistant specialized in Indian law. I can help answer legal questions, explain procedures, and guide you to appropriate resources."
  },
  capabilities: {
    neutral: "I can help with:\n- Indian laws and procedures\n- Legal term explanations\n- Relevant resources\n- Document understanding\n- Emergency services\n\nWhat can I help you with?"
  },
  thanks: {
    neutral: "You're welcome! Feel free to ask if you have other legal questions."
  }
};

const LEGAL_TERMS = {
  "ab initio": "from the beginning",
  "affidavit": "written statement under oath",
  "decree": "court order",
  "habeas corpus": "court order to present a detained person",
  "injunction": "court order to stop something",
  "mandamus": "court order to perform a duty",
  "suo motu": "on its own motion"
};

class AdvancedCache {
  constructor(maxSize = 100, ttl = 3600000, name = 'cache') {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttl = ttl;
    this.name = name;
    this.stats = {
      hits: 0,
      misses: 0,
      evictions: 0,
      errors: 0
    };
    this.accessOrder = [];
    this.priorityKeys = new Set();
  }

  set(key, value, isPriority = false) {
    try {
      if (this.cache.size >= this.maxSize) {
        this._evictLRU(isPriority);
      }

      this._updateAccessOrder(key);
      this.cache.set(key, {
        value,
        timestamp: Date.now(),
        accessCount: 0,
        isPriority
      });

      if (isPriority) this.priorityKeys.add(key);
      return value;
    } catch (error) {
      this.stats.errors++;
      console.error(`Cache error in ${this.name}.set():`, error);
      throw error;
    }
  }

  get(key) {
    try {
      if (!this.cache.has(key)) {
        this.stats.misses++;
        return null;
      }

      const entry = this.cache.get(key);
      if (Date.now() - entry.timestamp > this.ttl) {
        this._remove(key);
        this.stats.misses++;
        return null;
      }

      this._updateAccessOrder(key);
      entry.accessCount++;
      this.stats.hits++;
      return entry.value;
    } catch (error) {
      this.stats.errors++;
      console.error(`Cache error in ${this.name}.get():`, error);
      return null;
    }
  }

  has(key) {
    const entry = this.cache.get(key);
    if (!entry) return false;

    if (Date.now() - entry.timestamp > this.ttl) {
      this._remove(key);
      return false;
    }
    return true;
  }

  _updateAccessOrder(key) {
    const idx = this.accessOrder.indexOf(key);
    if (idx > -1) this.accessOrder.splice(idx, 1);
    this.accessOrder.push(key);
  }

  _evictLRU(protectPriority = false) {
    if (protectPriority) {
      for (const key of this.accessOrder) {
        if (this.cache.has(key) && !this.priorityKeys.has(key)) {
          this._remove(key);
          return;
        }
      }
    }

    const lruKey = this.accessOrder.shift();
    if (lruKey) this._remove(lruKey);
  }

  _remove(key) {
    this.cache.delete(key);
    this.priorityKeys.delete(key);
    this.stats.evictions++;
  }

  getStats() {
    const total = this.stats.hits + this.stats.misses;
    return {
      name: this.name,
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: total > 0 ? ((this.stats.hits / total) * 100).toFixed(2) : 0,
      ...this.stats
    };
  }

  clear() {
    this.cache.clear();
    this.accessOrder = [];
    this.priorityKeys.clear();
    this.stats = { hits: 0, misses: 0, evictions: 0, errors: 0 };
  }
}

class Semaphore {
  constructor(max) {
    this.max = max;
    this.count = 0;
    this.waiters = [];
  }

  async acquire() {
    if (this.count < this.max) {
      this.count++;
      return;
    }
    return new Promise(resolve => this.waiters.push(resolve));
  }

  release() {
    if (this.waiters.length > 0) {
      this.waiters.shift()();
    } else {
      this.count--;
    }
  }
}

const caches = {
  classification: new AdvancedCache(CONFIG.CACHE.MAX_SIZE, CONFIG.CACHE.TTL, 'classification'),
  response: new AdvancedCache(CONFIG.CACHE.MAX_SIZE * 2, CONFIG.CACHE.TTL, 'response'),
  dynamic: new AdvancedCache(CONFIG.CACHE.MAX_SIZE, CONFIG.CACHE.TTL, 'dynamic')
};

const metrics = {
  aiCalls: 0,
  aiErrors: 0,
  timeouts: 0,
  retries: 0,
  successfulRetries: 0,
  totalResponseTime: 0,
  responseTimes: [],
  startTime: Date.now()
};

const health = {
  api: {
    isAvailable: true,
    lastCheck: Date.now(),
    consecutiveFailures: 0
  },
  connection: {
    lastSuccessful: Date.now(),
    consecutiveErrors: 0,
    isStable: true,
    errorTypes: {}
  }
};

const semaphore = new Semaphore(CONFIG.REQUEST.MAX_CONCURRENT);

const Utils = {
  normalizeQuery: (query) => query.toLowerCase().trim(),

  analyzeQuery: (query) => {
    const words = query.split(/\s+/).filter(w => w.length > 0);
    return {
      length: query.length,
      wordCount: words.length,
      hasQuestion: /\?/.test(query),
      isShort: words.length <= 5,
      isLong: words.length > 15,
      startsWithGreeting: REGEX.GREETING.test(query),
      containsPlease: /please/i.test(query),
      hasAllCaps: /[A-Z]{3,}/.test(query)
    };
  },

  detectSentiment: (query) => {
    const q = query.toLowerCase();
    if (REGEX.EMERGENCY.test(q)) return "urgent";
    if (REGEX.FRUSTRATED.test(q)) return "frustrated";
    if (REGEX.CONFUSED.test(q)) return "confused";
    if (REGEX.POSITIVE.test(q)) return "positive";
    return "neutral";
  },

  matchKeywords: (query, keywords) => {
    const q = query.toLowerCase();
    const words = q.split(/\s+/);
    let count = 0;

    for (const word of words) {
      if (keywords.has(word)) count++;
    }

    for (const keyword of keywords) {
      if (keyword.includes(" ") && q.includes(keyword)) count++;
    }

    return count;
  },

  simplifyLegalTerms: (text) => {
    const pattern = new RegExp('\\b(' + Object.keys(LEGAL_TERMS).join('|') + ')\\b', 'gi');
    return text.replace(pattern, (match) => {
      const term = LEGAL_TERMS[match.toLowerCase()];
      return `${match} (${term})`;
    });
  },

  formatResponse: (text, category, sentiment = "neutral") => {
    let formatted = text.trim();

    const sentimentPrefixes = {
      frustrated: "I understand this can be frustrating. Let me help clarify.\n\n",
      urgent: "I recognize the urgency. Here's what you need to know:\n\n",
      confused: "Let me break this down in simpler terms:\n\n"
    };

    if (sentimentPrefixes[sentiment]) {
      formatted = sentimentPrefixes[sentiment] + formatted;
    }

    formatted += "\n\n**Disclaimer**: This information is for general guidance only and should not be construed as professional legal advice. For specific legal issues, please consult with a qualified lawyer.";

    const resources = LEGAL_RESOURCES[category] || LEGAL_RESOURCES.general;
    if (resources.length > 0) {
      formatted += "\n\n**Helpful Resources**:\n- " + resources.join("\n- ");
    }

    return formatted;
  }
};

const Classifier = {
  basic: (query) => {
    const cacheKey = Utils.normalizeQuery(query);
    const cached = caches.classification.get(cacheKey);
    if (cached) return cached;

    const matchCount = Utils.matchKeywords(query, KEYWORDS.legal);
    const result = {
      isLegal: matchCount > 0,
      confidence: Math.min(matchCount / 3, 1),
      category: matchCount > 0 ? "legal" : "non_legal",
      subCategory: null,
      requestType: "information",
      sentiment: Utils.detectSentiment(query),
      containsIndianLanguage: REGEX.INDIAN_LANGUAGE.test(query),
      isEmergency: Utils.matchKeywords(query, KEYWORDS.emergency) > 0
    };

    if (result.isLegal) {
      result.subCategory = Classifier.categorize(query);
      const q = query.toLowerCase();
      if (q.includes("how to") || q.includes("process") || q.includes("procedure")) {
        result.requestType = "procedural";
      } else if (q.includes("help") || q.includes("advice")) {
        result.requestType = "advice";
      } else if (q.includes("where can i") || q.includes("resources")) {
        result.requestType = "resource";
      }
    } else {
      for (const [cat, keywords] of Object.entries(KEYWORDS.nonLegal)) {
        if (Utils.matchKeywords(query, keywords) > 0) {
          result.category = cat;
          break;
        }
      }
    }

    caches.classification.set(cacheKey, result);
    return result;
  },

  categorize: (query) => {
    const q = query.toLowerCase();
    for (const [category, keywords] of Object.entries(LEGAL_CATEGORIES)) {
      if (Utils.matchKeywords(q, keywords) > 0) {
        return category;
      }
    }
    return "general";
  },

  async withAI(query) {
    const cacheKey = Utils.normalizeQuery(query);
    const cached = caches.dynamic.get(cacheKey);
    if (cached) return cached;

    const prompt = `Analyze this query and classify it. Return JSON only:
Query: "${query}"

Format:
{
  "isLegal": boolean,
  "confidence": 0-1,
  "category": "legal" or "general_chat/technical_support/feedback/related_services",
  "subCategory": "criminal/civil/family/constitutional/property/labor/tax/consumer/motor_vehicle/banking/general" or null,
  "requestType": "information/procedural/advice/resource",
  "sentiment": "neutral/urgent/frustrated/confused/positive",
  "complexity": 1-5,
  "specificLaws": string[]
}`;

    try {
      metrics.aiCalls++;
      const result = await RetryHandler.execute(() => model.generateContent(prompt), 2);

      let text = result.response?.text?.() ||
        result.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
        result.text?.();

      text = text.trim().replace(/```json\n?|\n?```/g, '');

      if (text.startsWith('{') && text.endsWith('}')) {
        const classification = JSON.parse(text);
        const complete = {
          isLegal: classification.isLegal || false,
          confidence: classification.confidence || 0,
          category: classification.category || "non_legal",
          subCategory: classification.isLegal ? (classification.subCategory || "general") : null,
          requestType: classification.requestType || "information",
          sentiment: classification.sentiment || "neutral",
          complexity: classification.complexity || 1,
          specificLaws: classification.specificLaws || [],
          containsIndianLanguage: REGEX.INDIAN_LANGUAGE.test(query),
          isEmergency: Utils.matchKeywords(query, KEYWORDS.emergency) > 0
        };

        return caches.dynamic.set(cacheKey, complete);
      }
    } catch (error) {
      console.error("AI classification error:", error);
      metrics.aiErrors++;
    }

    return Classifier.basic(query);
  }
};

const RetryHandler = {
  async execute(fn, maxRetries = CONFIG.REQUEST.MAX_RETRIES) {
    let lastError;
    let attempt = 1;

    await semaphore.acquire();

    try {
      while (attempt <= maxRetries) {
        try {
          const timeout = CONFIG.REQUEST.TIMEOUT * (1 + (attempt - 1) * 0.5);
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Timeout after ${timeout}ms`)), timeout)
          );

          const result = await Promise.race([fn(), timeoutPromise]);

          if (attempt > 1) metrics.successfulRetries++;
          return result;
        } catch (error) {
          lastError = error;
          metrics.retries++;

          if (error.message.includes('Timeout')) {
            metrics.timeouts++;
          }

          if (attempt < maxRetries) {
            const delay = CONFIG.REQUEST.RETRY_DELAY * Math.pow(2, attempt - 1);
            await new Promise(resolve => setTimeout(resolve, delay));
            attempt++;
          } else {
            break;
          }
        }
      }
    } finally {
      semaphore.release();
    }

    throw lastError;
  }
};

const ResponseGenerator = {
  chat: (query) => {
    const q = Utils.normalizeQuery(query);
    const analysis = Utils.analyzeQuery(query);

    if (REGEX.GREETING.test(q)) {
      return analysis.isShort ? RESPONSE_TEMPLATES.greeting.casual : RESPONSE_TEMPLATES.greeting.neutral;
    }
    if (REGEX.ABOUT.test(q)) {
      return RESPONSE_TEMPLATES.about.neutral;
    }
    if (REGEX.CAPABILITIES.test(q)) {
      return RESPONSE_TEMPLATES.capabilities.neutral;
    }
    if (REGEX.THANKS.test(q)) {
      return RESPONSE_TEMPLATES.thanks.neutral;
    }

    return "I'm here to help with legal questions related to Indian law. What specific legal matter are you interested in?";
  },

  technical: (query) => {
    return "I notice you might have technical issues. While I focus on legal questions, I've noted your concern. For technical support, contact support@juris.ai. How can I help with legal questions?";
  },

  feedback: (query) => {
    if (/thank|great|good/i.test(query)) {
      return "Thank you for your positive feedback! Is there anything specific about the service you appreciate?";
    }
    return "Thank you for your feedback! Your input helps us improve. Do you have specific legal questions I can address?";
  },

  relatedServices: () => {
    return "I specialize in legal information. For government service details, visit the National Government Services Portal (https://services.india.gov.in). What legal aspect can I help clarify?";
  },

  async legal(prompt, classification) {
    const cacheKey = prompt + JSON.stringify(classification);
    const cached = caches.response.get(cacheKey);
    if (cached) return cached;

    metrics.aiCalls++;
    const startTime = Date.now();

    const systemPrompt = `[SYSTEM: You are Juris, an expert legal assistant for Indian law. Provide accurate, clear information. Cite specific laws when relevant. Avoid jargon and explain complex terms. Structure answers clearly.]\n\n`;

    const contextPrompt = `[CONTEXT: ${classification.subCategory || 'general'} law, ${classification.sentiment} sentiment, ${classification.requestType} request, complexity ${classification.complexity || 1}/5]\n\n`;

    let mainPrompt = systemPrompt + contextPrompt + prompt;

    if (classification.isEmergency) {
      mainPrompt = `[URGENT: Prioritize immediate actionable steps]\n\n` + mainPrompt;
    }

    try {
      const result = await RetryHandler.execute(() => model.generateContent(mainPrompt), 2);
      const text = result.response?.text?.() ||
        result.response?.candidates?.[0]?.content?.parts?.[0]?.text ||
        result.text?.();

      const responseTime = Date.now() - startTime;
      metrics.totalResponseTime += responseTime;
      metrics.responseTimes.push(responseTime);
      if (metrics.responseTimes.length > 100) metrics.responseTimes.shift();

      let processed = text;
      if (classification.isEmergency || (classification.complexity || 1) >= 4) {
        processed = Utils.simplifyLegalTerms(text);
      }

      const formatted = Utils.formatResponse(
        processed,
        classification.subCategory || "general",
        classification.sentiment
      );

      return caches.response.set(cacheKey, formatted, classification.isLegal);
    } catch (error) {
      console.error("AI response error:", error);
      metrics.aiErrors++;
      return "I'm experiencing difficulty answering your legal question. Please try rephrasing or ask about a specific aspect.";
    }
  }
};

const HealthMonitor = {
  async checkAPI() {
    const now = Date.now();
    if (!health.api.isAvailable && (now - health.api.lastCheck) < CONFIG.HEALTH.CHECK_INTERVAL) {
      return false;
    }

    try {
      await model.generateContent("Hello");
      health.api.isAvailable = true;
      health.api.consecutiveFailures = 0;
      health.api.lastCheck = now;
      return true;
    } catch (error) {
      health.api.isAvailable = false;
      health.api.consecutiveFailures++;
      health.api.lastCheck = now;
      console.error(`API unavailable (failure #${health.api.consecutiveFailures})`, error);
      return false;
    }
  },

  async checkConnection() {
    try {
      await fetch('https://generativelanguage.googleapis.com/v1/models', {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });

      health.connection.lastSuccessful = Date.now();
      health.connection.consecutiveErrors = 0;
      health.connection.isStable = true;
      return true;
    } catch (error) {
      health.connection.consecutiveErrors++;
      const errorType = error.code || 'UNKNOWN';
      health.connection.errorTypes[errorType] = (health.connection.errorTypes[errorType] || 0) + 1;

      if (health.connection.consecutiveErrors >= CONFIG.HEALTH.MAX_CONSECUTIVE_ERRORS) {
        health.connection.isStable = false;
      }
      return false;
    }
  }
};

async function processQuery(query) {
  try {
    const cacheKey = Utils.normalizeQuery(query);
    const cachedResponse = caches.response.get(cacheKey);
    const cachedClassification = caches.dynamic.get(cacheKey);

    if (cachedResponse && cachedClassification) {
      return {
        response: cachedResponse,
        classification: cachedClassification,
        fromCache: true
      };
    }

    const basicClassification = Classifier.basic(query);

    if (!health.connection.isStable || !health.api.isAvailable) {
      if (basicClassification.category === "general_chat" || !basicClassification.isLegal) {
        return {
          response: ResponseGenerator[basicClassification.category]?.(query) || ResponseGenerator.chat(query),
          classification: basicClassification,
          fromCache: true
        };
      }
      return {
        response: "Our AI service is temporarily unavailable. Please try again shortly.",
        classification: { isLegal: false, category: "service_unavailable", confidence: 1.0 }
      };
    }

    const classification = await Classifier.withAI(query);

    let response;
    if (classification.category === "general_chat") {
      response = ResponseGenerator.chat(query);
    } else if (!classification.isLegal) {
      const handler = ResponseGenerator[classification.category];
      response = handler ? handler(query) : ResponseGenerator.chat(query);
    } else {
      response = await ResponseGenerator.legal(query, classification);
    }

    if (health.connection.consecutiveErrors > 0) {
      health.connection.consecutiveErrors = 0;
      health.connection.isStable = true;
    }

    return { response, classification };
  } catch (error) {
    console.error("Error processing query:", error);
    return {
      response: "I apologize, but I'm having trouble processing your request. Please try again.",
      classification: { isLegal: false, category: "error", confidence: 0 },
      error: error.message
    };
  }
}

async function generateChatSummary(messages) {
  if (!messages || messages.length === 0) {
    return "No conversation to summarize";
  }

  const recentMessages = messages.slice(-10);
  const chatText = recentMessages
    .map((msg) => `${msg.type === "user" ? "User:" : "Bot:"} ${msg.text}`)
    .join("\n");

  const prompt = `Summarize this legal conversation in exactly 6 words:\n\n${chatText}`;

  try {
    let summary = await ResponseGenerator.legal(prompt, {
      isLegal: false,
      category: "general_chat"
    });
    summary = summary.trim().replace(/[^a-zA-Z0-9\s]/g, "").replace(/\s+/g, " ");
    const words = summary.split(" ").filter(w => w.length > 0).slice(0, 6);
    return words.join(" ");
  } catch (error) {
    console.error("Error generating chat summary:", error);
    return "Summary unavailable";
  }
}

async function batchProcessQueries(queries) {
  if (!queries?.length) return [];

  const prioritized = queries.map(query => ({
    query,
    priority: determinePriority(query)
  }));

  prioritized.sort((a, b) => {
    const order = { high: 0, medium: 1, normal: 2 };
    return order[a.priority] - order[b.priority];
  });

  const results = [];
  let currentBatch = [];

  for (const { query, priority } of prioritized) {
    if (priority === 'high' && currentBatch.length > 0) {
      results.push(...await Promise.all(currentBatch.map(q => processQuery(q))));
      currentBatch = [];
    }

    currentBatch.push(query);
    const limit = priority === 'high' ? 2 : CONFIG.REQUEST.BATCH_SIZE;

    if (currentBatch.length >= limit) {
      results.push(...await Promise.all(currentBatch.map(q => processQuery(q))));
      currentBatch = [];
    }
  }

  if (currentBatch.length > 0) {
    results.push(...await Promise.all(currentBatch.map(q => processQuery(q))));
  }

  return results;
}

function determinePriority(query) {
  if (Utils.matchKeywords(query, KEYWORDS.emergency) > 0) {
    return 'high';
  }

  const q = query.toLowerCase();
  if (/deadline|urgent|tomorrow|today|immediately|asap/.test(q)) {
    return 'high';
  }

  if (query.length < 50 || /how (do|can)|what (is|are)/.test(q)) {
    return 'medium';
  }

  return 'normal';
}

function getServiceMetrics() {
  const now = Date.now();
  const uptime = Math.floor((now - metrics.startTime) / 1000);

  let medianResponseTime = 0;
  if (metrics.responseTimes.length > 0) {
    const sorted = [...metrics.responseTimes].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    medianResponseTime = sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  }

  const avgResponseTime = metrics.aiCalls > 0
    ? metrics.totalResponseTime / metrics.aiCalls
    : 0;

  return {
    performance: {
      aiCalls: metrics.aiCalls,
      aiErrors: metrics.aiErrors,
      timeouts: metrics.timeouts,
      retries: metrics.retries,
      successfulRetries: metrics.successfulRetries,
      avgResponseTime: avgResponseTime.toFixed(2),
      medianResponseTime: medianResponseTime.toFixed(2),
      uptime
    },
    caches: {
      classification: caches.classification.getStats(),
      response: caches.response.getStats(),
      dynamic: caches.dynamic.getStats()
    },
    health: {
      api: {
        available: health.api.isAvailable,
        lastCheck: health.api.lastCheck,
        consecutiveFailures: health.api.consecutiveFailures
      },
      connection: {
        ...health.connection,
        timeSinceLastSuccess: now - health.connection.lastSuccessful
      }
    },
    system: {
      memory: process.memoryUsage(),
      cpuUsage: process.cpuUsage()
    }
  };
}

module.exports = {
  processQuery,
  generateChatSummary,
  batchProcessQueries,
  isLegalQuery: (query) => Classifier.basic(query).isLegal,
  classifyQuery: Classifier.basic,
  classifyQueryDynamic: Classifier.withAI,
  categorizeIndianLegalQuery: Classifier.categorize,
  generateGeminiResponse: ResponseGenerator.legal,
  handleNonLegalQuery: (query, classification) => {
    const handler = ResponseGenerator[classification.category];
    return handler ? handler(query) : ResponseGenerator.chat(query);
  },
  generateIndianLegalResources: (category) => LEGAL_RESOURCES[category] || LEGAL_RESOURCES.general,
  formatIndianLegalResponse: Utils.formatResponse,
  containsIndianLanguage: (query) => REGEX.INDIAN_LANGUAGE.test(query),
  simplifyLegalTerms: Utils.simplifyLegalTerms,
  isEmergencyLegalQuery: (query) => Utils.matchKeywords(query, KEYWORDS.emergency) > 0,
  getEmergencyLegalResources: () => ({
    police: "100",
    women_helpline: "1091",
    child_helpline: "1098",
    senior_citizen_helpline: "14567",
    nalsa: "1516",
    domestic_violence: "181"
  }),
  checkGeminiApiStatus: HealthMonitor.checkAPI,
  checkConnectionHealth: HealthMonitor.checkConnection,
  getServiceMetrics,
  getUnavailableServiceResponse: () => ({
    response: "Our AI service is temporarily unavailable. We're working to restore service. Please try again later.",
    classification: { isLegal: false, category: "service_unavailable", confidence: 1.0 }
  }),
  withRetry: RetryHandler.execute,
  prioritizeQuery: determinePriority,
  adjustThrottling: () => { }
};