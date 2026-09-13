export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const authorization = request.headers.authorization || "";
  const {
    baseUrl,
    model,
    messages,
    temperature,
    max_tokens: maxTokens,
    toolState,
    tools,
    tool_choice: toolChoice,
  } = request.body || {};

  if (!authorization.startsWith("Bearer ") || !baseUrl || !model || !Array.isArray(messages)) {
    response.status(400).json({ error: "Missing API config or messages" });
    return;
  }

  try {
    const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
    try {
      new URL(normalizedBaseUrl);
    } catch {
      response.status(400).json({ error: "API 地址格式不对，请填写类似 https://example.com/v1" });
      return;
    }

    const upstreamBody = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };

    if (toolState?.webSearchRequested && isOpenRouterBaseUrl(normalizedBaseUrl)) {
      upstreamBody.plugins = [{ id: "web", max_results: 1 }];
    }
    if (Array.isArray(tools) && tools.length) {
      upstreamBody.tools = tools;
      upstreamBody.tool_choice = toolChoice || "auto";
    }

    const upstream = await fetch(`${normalizedBaseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: authorization,
      },
      body: JSON.stringify(upstreamBody),
    });

    const text = await upstream.text();
    response.status(upstream.status);
    response.setHeader("Content-Type", upstream.headers.get("content-type") || "application/json");
    response.send(text);
  } catch (error) {
    response.status(502).json({ error: error?.message || "Proxy request failed" });
  }
}

function normalizeBaseUrl(value) {
  let url = String(value || "").trim();
  if (!url) return "";
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/i, "")
    .replace(/\/responses$/i, "");
}

function isOpenRouterBaseUrl(value) {
  try {
    return /(^|\.)openrouter\.ai$/i.test(new URL(value).hostname);
  } catch {
    return false;
  }
}
