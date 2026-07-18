const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL = "openrouter/free";

const getOpenRouterHeaders = () => {
  const headers = {
    Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
  };

  if (process.env.OPENROUTER_SITE_URL) {
    headers["HTTP-Referer"] = process.env.OPENROUTER_SITE_URL;
  }

  if (process.env.OPENROUTER_APP_NAME) {
    headers["X-Title"] = process.env.OPENROUTER_APP_NAME;
  }

  return headers;
};

async function generateAIText(prompt, options = {}) {
  const response = await fetch(OPENROUTER_API_URL, {
    method: "POST",
    headers: getOpenRouterHeaders(),
    body: JSON.stringify({
      model: process.env.AI_MODEL || DEFAULT_MODEL,
      messages: [
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature: options.temperature ?? 0.3,
      max_tokens: options.maxTokens ?? 1200,
    }),
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      data.error?.message || `OpenRouter request failed with ${response.status}`
    );
    error.status = response.status;
    error.statusText = response.statusText;
    error.errorDetails = data.error;
    throw error;
  }

  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error("OpenRouter response did not include text content");

  return text;
}

export { generateAIText };
