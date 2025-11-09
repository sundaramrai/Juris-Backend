import axios from "axios";

const SEARCH_CONFIG = {
  timeout: 8000,
  maxResults: 5,
  deepSearch: {
    maxResults: 8,
    timeout: 10000,
  },
  priority_sites: [
    "indiankanoon.org",
    "supremecourtofindia.nic.in",
    "legislative.gov.in",
    "egazette.nic.in",
    "sci.gov.in",
    "highcourt.*.nic.in",
    "indiancourts.nic.in",
    "lawcommissionofindia.nic.in",
    "mha.gov.in",
    "meity.gov.in",
    "mca.gov.in",
    "dea.gov.in",
    "incometaxindia.gov.in",
    "gst.gov.in",
    "cbic.gov.in",
    "sebi.gov.in",
    "rbi.org.in",
    "nhrc.nic.in",
    "ncw.nic.in",
    "scconline.com",
    "manupatra.com",
    "barandbench.com",
    "livelaw.in",
    "thehindu.com/news/national",
    "economictimes.indiatimes.com/news/economy/policy",
    "business-standard.com/india-news",
  ],
};

async function performDeepSearch(query, category = "general", options = {}) {
  try {
    const apiKey = process.env.GOOGLE_SEARCH_API_KEY;
    const searchEngineId = process.env.GOOGLE_SEARCH_ENGINE_ID;
    if (!apiKey) {
      console.warn("Search API not configured");
      return null;
    }

    const cx = searchEngineId;

    if (!cx) {
      console.warn("No search engine ID available");
      return null;
    }

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
      default: "Indian law legal",
    };

    const contextKeywords = legalKeywords[category] || legalKeywords.default;
    const enhancedQuery = `${query} ${contextKeywords}`;

    const searchParams = {
      key: apiKey,
      cx: cx,
      q: enhancedQuery,
      num: options.deepSearch
        ? SEARCH_CONFIG.deepSearch.maxResults
        : SEARCH_CONFIG.maxResults,
      dateRestrict: options.dateRestrict || "m12",
      lr: "lang_en",
      gl: "in",
      safe: "active",
    };

    if (options.includeImages) {
      searchParams.searchType = "image";
      searchParams.imgSize = "medium";
      searchParams.imgType = "photo";
    }

    const timeout = options.deepSearch
      ? SEARCH_CONFIG.deepSearch.timeout
      : SEARCH_CONFIG.timeout;

    const response = await axios.get(
      "https://www.googleapis.com/customsearch/v1",
      {
        params: searchParams,
        timeout: timeout,
      }
    );

    if (response.data?.items) {
      const results = response.data.items.map((item) => ({
        title: item.title,
        snippet: item.snippet || item.htmlSnippet?.replaceAll(/<[^>]*>/g, ""),
        link: item.link,
        displayLink: item.displayLink,
        date: extractDate(item),
        isPriority: isPrioritySite(item.link),
        thumbnail: item.pagemap?.cse_thumbnail?.[0]?.src,
        images: item.pagemap?.cse_image || [],
        fileFormat: item.fileFormat,
        relevance: calculateRelevance(item, query),
      }));

      return results.sort((a, b) => {
        if (a.isPriority && !b.isPriority) return -1;
        if (!a.isPriority && b.isPriority) return 1;
        return b.relevance - a.relevance;
      });
    }

    return null;
  } catch (error) {
    console.error("Deep search error:", error.message);
    return null;
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
    default: "latest legal updates court judgments India",
  };

  const query = categoryQueries[category] || categoryQueries.default;

  const results = await performDeepSearch(query, category, {
    deepSearch: true,
    dateRestrict: "m6",
    ...options,
  });

  return results;
}

async function searchWithImages(query, category = "general") {
  try {
    const [textResults, imageResults] = await Promise.all([
      performDeepSearch(query, category, { deepSearch: true }),
      performDeepSearch(query, category, {
        includeImages: true,
        deepSearch: false,
      }),
    ]);

    return {
      textResults: textResults || [],
      imageResults: imageResults || [],
    };
  } catch (error) {
    console.error("Search with images error:", error.message);
    return {
      textResults: [],
      imageResults: [],
    };
  }
}

async function searchSpecificTopic(topic, options = {}) {
  try {
    const searchOptions = {
      deepSearch: true,
      dateRestrict: options.dateRestrict || "m12",
      useCustomEngine: options.useCustomEngine || false,
      ...options,
    };

    const category = detectCategory(topic);

    const results = await performDeepSearch(topic, category, searchOptions);

    if (options.includeRelated && results && results.length > 0) {
      const relatedQueries = generateRelatedQueries(topic, category);
      const relatedResults = await Promise.all(
        relatedQueries
          .slice(0, 2)
          .map((q) =>
            performDeepSearch(q, category, {
              ...searchOptions,
              deepSearch: false,
            })
          )
      );

      return {
        main: results,
        related: relatedResults.filter((r) => r !== null).flat(),
      };
    }

    return results;
  } catch (error) {
    console.error("Topic search error:", error.message);
    return null;
  }
}

function extractDate(item) {
  const dateStr =
    item.pagemap?.metatags?.[0]?.["article:published_time"] ||
    item.pagemap?.metatags?.[0]?.["og:updated_time"] ||
    item.pagemap?.metatags?.[0]?.["date"] ||
    item.snippet?.match(
      /\b(\d{1,2}\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4})\b/i
    )?.[0];

  if (dateStr) {
    const parsed = new Date(dateStr);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toLocaleDateString("en-IN", {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
    }
  }

  return "Recent";
}

function isPrioritySite(url) {
  return SEARCH_CONFIG.priority_sites.some((site) => {
    const pattern = site.replaceAll("*", "[^.]*");
    return new RegExp(pattern, "i").test(url);
  });
}

function calculateRelevance(item, query) {
  let score = 0;
  const queryWords = query.toLowerCase().split(/\s+/);
  const titleLower = item.title.toLowerCase();
  const snippetLower = (item.snippet || "").toLowerCase();

  for (const word of queryWords) {
    if (titleLower.includes(word)) score += 3;
    if (snippetLower.includes(word)) score += 1;
  }

  if (titleLower.includes(query.toLowerCase())) score += 5;
  if (isPrioritySite(item.link)) score += 10;

  if (item.pagemap?.metatags?.[0]?.["article:published_time"]) {
    const date = new Date(item.pagemap.metatags[0]["article:published_time"]);
    const monthsOld =
      (Date.now() - date.getTime()) / (1000 * 60 * 60 * 24 * 30);
    if (monthsOld < 6) score += 5;
    else if (monthsOld < 12) score += 2;
  }

  return score;
}

function detectCategory(topic) {
  const topicLower = topic.toLowerCase();
  const categoryKeywords = {
    criminal: [
      "ipc",
      "crpc",
      "criminal",
      "arrest",
      "bail",
      "fir",
      "police",
      "theft",
      "murder",
      "assault",
    ],
    civil: [
      "cpc",
      "civil",
      "contract",
      "suit",
      "injunction",
      "damages",
      "decree",
    ],
    constitutional: [
      "constitution",
      "fundamental rights",
      "writ",
      "supreme court",
      "article",
      "pil",
    ],
    tax: ["gst", "income tax", "tax", "tds", "assessment", "revenue"],
    family: [
      "marriage",
      "divorce",
      "custody",
      "maintenance",
      "alimony",
      "domestic violence",
    ],
    property: [
      "property",
      "land",
      "rera",
      "real estate",
      "registration",
      "mutation",
    ],
    labor: [
      "labor",
      "employment",
      "salary",
      "wages",
      "pf",
      "esi",
      "termination",
    ],
    consumer: [
      "consumer",
      "deficiency",
      "product",
      "service",
      "warranty",
      "refund",
    ],
    motor_vehicle: [
      "accident",
      "motor vehicle",
      "insurance",
      "compensation",
      "license",
    ],
    banking: ["bank", "loan", "npa", "sarfaesi", "cheque bounce", "recovery"],
  };

  for (const [category, keywords] of Object.entries(categoryKeywords)) {
    if (keywords.some((keyword) => topicLower.includes(keyword))) {
      return category;
    }
  }

  return "general";
}

function generateRelatedQueries(topic, category) {
  const baseQueries = [
    `${topic} latest updates India`,
    `${topic} court judgments India`,
    `${topic} legal procedure India`,
    `${topic} laws and regulations India`,
  ];

  const categorySpecific = {
    criminal: [`${topic} FIR procedure`, `${topic} bail conditions`],
    civil: [`${topic} civil suit procedure`, `${topic} limitation period`],
    constitutional: [
      `${topic} fundamental rights`,
      `${topic} Supreme Court cases`,
    ],
    tax: [`${topic} tax implications`, `${topic} compliance requirements`],
    family: [`${topic} family court procedure`, `${topic} custody rights`],
    property: [`${topic} registration procedure`, `${topic} stamp duty`],
    labor: [`${topic} employee rights`, `${topic} labor laws`],
    consumer: [`${topic} consumer rights`, `${topic} consumer forum`],
    motor_vehicle: [`${topic} accident claims`, `${topic} insurance coverage`],
    banking: [`${topic} banking regulations`, `${topic} loan recovery`],
  };

  return [...baseQueries, ...(categorySpecific[category] || [])];
}

function formatSearchResults(results, options = {}) {
  if (!results || results.length === 0) return "";

  let formatted = "";
  const maxResults = options.maxResults || results.length;
  const resultsToShow = results.slice(0, maxResults);

  for (let i = 0; i < resultsToShow.length; i++) {
    const result = resultsToShow[i];
    const priorityMarker = result.isPriority ? " [Official Source]" : "";
    formatted += `\n**${i + 1}. ${result.title}${priorityMarker}**\n`;
    formatted += `   ${result.snippet}\n`;
    formatted += `   ${result.date} • [Read more](${result.link})\n`;

    if (options.includeImages && result.thumbnail) {
      formatted += `   [View related image](${result.thumbnail})\n`;
    }
  }

  return formatted;
}

function formatSearchResultsWithImages(
  textResults,
  imageResults,
  options = {}
) {
  let formatted = "";

  if (textResults && textResults.length > 0) {
    formatted += formatSearchResults(textResults, {
      ...options,
      maxResults: 5,
    });
  }

  if (imageResults && imageResults.length > 0 && options.includeImages) {
    formatted += "\n\n**Related Images:**\n";
    for (const [i, img] of imageResults.slice(0, 3).entries()) {
      formatted += `${i + 1}. [${img.title}](${img.link})\n`;
      if (img.thumbnail) {
        formatted += `   ![${img.title}](${img.thumbnail})\n`;
      }
    }
  }

  return formatted;
}

export {
  performDeepSearch as searchLegalUpdates,
  performDeepSearch,
  getRecentLegalUpdates,
  searchWithImages,
  searchSpecificTopic,
  formatSearchResults,
  formatSearchResultsWithImages,
  detectCategory,
  isPrioritySite,
  calculateRelevance,
};
