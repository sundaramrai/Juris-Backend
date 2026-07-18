const TAVILY_SEARCH_URL = "https://api.tavily.com/search";

const SEARCH_CONFIG = {
  timeout: 10000,
  maxResults: 5,
  deepMaxResults: 8,
  prioritySites: [
    "indiankanoon.org",
    "supremecourtofindia.nic.in",
    "legislative.gov.in",
    "egazette.nic.in",
    "sci.gov.in",
    "lawcommissionofindia.nic.in",
    "mha.gov.in",
    "meity.gov.in",
    "mca.gov.in",
    "incometaxindia.gov.in",
    "gst.gov.in",
    "cbic.gov.in",
    "sebi.gov.in",
    "rbi.org.in",
    "barandbench.com",
    "livelaw.in",
  ],
};

const legalKeywords = {
  criminal: "Indian Penal Code IPC CrPC criminal law",
  civil: "Civil Procedure Code CPC civil law India",
  constitutional: "Constitution of India Supreme Court fundamental rights",
  tax: "Income Tax GST taxation India revenue",
  family: "family law marriage divorce custody India",
  property: "property law real estate RERA India",
  labor: "labor law employment ESI PF India",
  consumer: "consumer protection COPRA India",
  motor_vehicle: "Motor Vehicles Act accident compensation India",
  banking: "banking law RBI SARFAESI India",
  general: "Indian law legal",
};

async function performDeepSearch(query, category = "general", options = {}) {
  const apiKey = process.env.TAVILY_API_KEY;
  if (!apiKey) {
    console.warn("Tavily search is not configured");
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SEARCH_CONFIG.timeout);

  try {
    const contextKeywords = legalKeywords[category] || legalKeywords.general;
    const response = await fetch(TAVILY_SEARCH_URL, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `${query} ${contextKeywords}`,
        search_depth: options.deepSearch ? "advanced" : "basic",
        max_results: options.deepSearch
          ? SEARCH_CONFIG.deepMaxResults
          : SEARCH_CONFIG.maxResults,
        include_answer: false,
        include_raw_content: false,
        country: "india",
      }),
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.error ||
        data.message ||
        `Tavily search failed with ${response.status}`
      );
    }

    if (!Array.isArray(data.results) || data.results.length === 0) return null;

    return data.results
      .map((item) => ({
        title: item.title,
        snippet: item.content,
        link: item.url,
        displayLink: getHost(item.url),
        date: item.published_date || "Recent",
        isPriority: isPrioritySite(item.url),
        relevance: item.score || calculateRelevance(item, query),
      }))
      .sort((a, b) => {
        if (a.isPriority && !b.isPriority) return -1;
        if (!a.isPriority && b.isPriority) return 1;
        return b.relevance - a.relevance;
      });
  } catch (error) {
    console.error("Tavily search error:", error.message || "Search request failed");
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function getRecentLegalUpdates(category, options = {}) {
  const categoryQueries = {
    criminal: "latest criminal law amendments judgments India",
    civil: "recent civil procedure changes court decisions India",
    constitutional: "latest Supreme Court constitutional judgments India",
    tax: "recent GST Income Tax amendments notifications India",
    family: "latest family law judgments divorce custody India",
    property: "recent property law RERA judgments India",
    labor: "latest labor law employment amendments India",
    consumer: "recent consumer protection court decisions India",
    motor_vehicle: "latest motor vehicle accident compensation judgments India",
    banking: "recent banking law RBI notifications judgments India",
    general: "latest legal updates court judgments India",
  };

  return performDeepSearch(categoryQueries[category] || categoryQueries.general, category, {
    ...options,
    deepSearch: true,
  });
}

async function searchSpecificTopic(topic, options = {}) {
  const category = detectCategory(topic);
  const results = await performDeepSearch(topic, category, {
    ...options,
    deepSearch: true,
  });

  if (!options.includeRelated || !results?.length) return results;

  const relatedResults = await Promise.all(
    generateRelatedQueries(topic, category)
      .slice(0, 2)
      .map((relatedQuery) => performDeepSearch(relatedQuery, category))
  );

  return {
    main: results,
    related: relatedResults.filter(Boolean).flat(),
  };
}

function getHost(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

function isPrioritySite(url) {
  const host = getHost(url);
  return SEARCH_CONFIG.prioritySites.some((site) => host.includes(site));
}

function calculateRelevance(item, query) {
  const title = (item.title || "").toLowerCase();
  const content = (item.content || item.snippet || "").toLowerCase();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  return words.reduce((score, word) => {
    if (title.includes(word)) score += 3;
    if (content.includes(word)) score += 1;
    return score;
  }, isPrioritySite(item.url || item.link || "") ? 10 : 0);
}

function detectCategory(topic) {
  const q = topic.toLowerCase();
  const categoryKeywords = {
    criminal: ["ipc", "crpc", "criminal", "arrest", "bail", "fir", "police"],
    civil: ["cpc", "civil", "contract", "suit", "injunction", "damages"],
    constitutional: ["constitution", "fundamental rights", "writ", "supreme court", "article"],
    tax: ["gst", "income tax", "tax", "tds", "assessment", "revenue"],
    family: ["marriage", "divorce", "custody", "maintenance", "domestic violence"],
    property: ["property", "land", "rera", "real estate", "registration"],
    labor: ["labor", "employment", "salary", "wages", "pf", "esi", "termination"],
    consumer: ["consumer", "deficiency", "product", "service", "warranty", "refund"],
    motor_vehicle: ["accident", "motor vehicle", "insurance", "compensation", "license"],
    banking: ["bank", "loan", "npa", "sarfaesi", "cheque bounce", "recovery"],
  };

  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some((keyword) => q.includes(keyword))) return category;
  }

  return "general";
}

function generateRelatedQueries(topic, category) {
  const categorySpecific = {
    criminal: [`${topic} FIR procedure`, `${topic} bail conditions`],
    civil: [`${topic} civil suit procedure`, `${topic} limitation period`],
    constitutional: [`${topic} fundamental rights`, `${topic} Supreme Court cases`],
    tax: [`${topic} tax implications`, `${topic} compliance requirements`],
    family: [`${topic} family court procedure`, `${topic} custody rights`],
    property: [`${topic} registration procedure`, `${topic} stamp duty`],
    labor: [`${topic} employee rights`, `${topic} labor laws`],
    consumer: [`${topic} consumer rights`, `${topic} consumer forum`],
    motor_vehicle: [`${topic} accident claims`, `${topic} insurance coverage`],
    banking: [`${topic} banking regulations`, `${topic} loan recovery`],
  };

  return [
    `${topic} latest updates India`,
    `${topic} court judgments India`,
    `${topic} legal procedure India`,
    ...(categorySpecific[category] || []),
  ];
}

function formatSearchResults(results, options = {}) {
  if (!results?.length) return "";

  return results
    .slice(0, options.maxResults || results.length)
    .map((result, index) => {
      const priorityMarker = result.isPriority ? " [Official Source]" : "";
      return `\n**${index + 1}. ${result.title}${priorityMarker}**\n   ${result.snippet}\n   ${result.date} - [Read more](${result.link})`;
    })
    .join("\n");
}

export {
  performDeepSearch as searchLegalUpdates,
  performDeepSearch,
  getRecentLegalUpdates,
  searchSpecificTopic,
  formatSearchResults,
  detectCategory,
  isPrioritySite,
  calculateRelevance,
};
