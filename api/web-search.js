export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { provider = "tavily", baseUrl, apiKey, model = "openrouter/auto", query } = request.body || {};
  if (!apiKey || !String(query || "").trim()) {
    response.status(400).json({ error: "网页搜索还没有填写 API Key。" });
    return;
  }

  try {
    const normalizedProvider = provider === "openrouter" ? "openrouter" : "tavily";
    const result = normalizedProvider === "openrouter"
      ? await searchWithOpenRouter({ baseUrl, apiKey, model, query })
      : await searchWithTavily({ baseUrl, apiKey, query });
    response.status(200).json(result);
  } catch (error) {
    response.status(502).json({ error: error?.message || "网页搜索请求失败。" });
  }
}

async function searchWithTavily({ baseUrl = "https://api.tavily.com", apiKey, query }) {
  const normalizedBaseUrl = normalizeTavilyBaseUrl(baseUrl);
  const upstream = await fetch(`${normalizedBaseUrl}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      query: String(query).trim().slice(0, 500),
      search_depth: "basic",
      include_answer: "basic",
      include_raw_content: false,
      include_images: false,
      max_results: 5,
    }),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(normalizeTavilyError(data, upstream.status));
  return {
    query: String(data.query || query),
    answer: String(data.answer || ""),
    results: normalizeResults(data.results),
  };
}

async function searchWithOpenRouter({ baseUrl = "https://openrouter.ai/api/v1", apiKey, model, query }) {
  const normalizedBaseUrl = normalizeOpenRouterBaseUrl(baseUrl);
  const upstream = await fetch(`${normalizedBaseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: String(model || "openrouter/auto").trim().slice(0, 160) || "openrouter/auto",
      messages: [
        {
          role: "system",
          content: "必须使用网页搜索回答。只根据真实搜索结果写简洁中文摘要，并保留来源。",
        },
        { role: "user", content: String(query).trim().slice(0, 500) },
      ],
      tools: [
        {
          type: "openrouter:web_search",
          parameters: { engine: "auto", max_results: 5, max_total_results: 5 },
        },
      ],
    }),
  });
  const data = await upstream.json().catch(() => ({}));
  if (!upstream.ok) throw new Error(normalizeOpenRouterError(data, upstream.status));
  const message = data?.choices?.[0]?.message || {};
  const answer = getMessageText(message);
  const results = normalizeOpenRouterAnnotations(message.annotations);
  if (!answer) throw new Error("OpenRouter 没有返回可保存的搜索内容。");
  return { query: String(query), answer, results };
}

function normalizeResults(results = []) {
  return (Array.isArray(results) ? results : []).slice(0, 5).map((result) => ({
    title: String(result?.title || "网页来源"),
    url: String(result?.url || ""),
    content: String(result?.content || ""),
  }));
}

function normalizeOpenRouterAnnotations(annotations = []) {
  const results = (Array.isArray(annotations) ? annotations : [])
    .map((annotation) => annotation?.url_citation || annotation)
    .filter((citation) => /^https?:\/\//i.test(String(citation?.url || "")))
    .map((citation) => ({
      title: String(citation?.title || "网页来源"),
      url: String(citation.url),
      content: String(citation?.content || ""),
    }));
  return [...new Map(results.map((result) => [result.url, result])).values()].slice(0, 5);
}

function getMessageText(message = {}) {
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .map((part) => typeof part === "string" ? part : part?.text || part?.content || "")
    .filter(Boolean)
    .join("\n")
    .trim();
}

function normalizeTavilyBaseUrl(value) {
  const url = new URL(/^https?:\/\//i.test(String(value || "")) ? String(value) : `https://${value}`);
  if (!/(^|\.)tavily\.com$/i.test(url.hostname)) {
    throw new Error("搜索 API 地址需要使用 Tavily。" );
  }
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "").replace(/\/search$/i, "")}`;
}

function normalizeOpenRouterBaseUrl(value) {
  const url = new URL(/^https?:\/\//i.test(String(value || "")) ? String(value) : `https://${value}`);
  if (!/(^|\.)openrouter\.ai$/i.test(url.hostname)) {
    throw new Error("搜索 API 地址需要使用 OpenRouter。");
  }
  const pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/i, "");
  return `${url.protocol}//${url.host}${pathname || "/api/v1"}`;
}

function normalizeTavilyError(data, status) {
  const detail = data?.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((item) => item?.msg || item).filter(Boolean).join("；");
  return data?.error || data?.message || `网页搜索失败（${status}）。`;
}

function normalizeOpenRouterError(data, status) {
  return data?.error?.message || data?.error || data?.message || `OpenRouter 网页搜索失败（${status}）。`;
}
