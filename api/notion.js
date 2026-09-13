const NOTION_VERSION = "2022-06-28";
const MAX_BLOCKS = 240;
const MAX_DEPTH = 5;

export default async function handler(request, response) {
  if (request.method !== "POST") {
    response.setHeader("Allow", "POST");
    response.status(405).json({ error: "Method not allowed" });
    return;
  }

  const { token, pageId, query, maxChars = 7000 } = request.body || {};
  const apiKey = String(token || process.env.NOTION_API_KEY || "").trim();
  if (!apiKey) {
    response.status(400).json({ error: "还没填写 Notion Token，或还没配置 NOTION_API_KEY。" });
    return;
  }

  try {
    const cleanPageId = extractNotionId(pageId);
    const cleanQuery = String(query || "").trim();
    const limit = Math.min(10000, Math.max(1200, Number(maxChars) || 7000));
    const matches = [];
    let pages = [];

    if (cleanPageId) {
      const page = await retrievePage(apiKey, cleanPageId);
      pages.push({
        id: page.id,
        title: getPageTitle(page) || "Notion 页面",
      });
    } else if (cleanQuery) {
      const results = await searchPages(apiKey, cleanQuery);
      const normalizedQuery = normalizeMatchText(cleanQuery);
      const exactMatches = results.filter((page) => normalizeMatchText(getPageTitle(page)) === normalizedQuery);
      const selected = exactMatches.length
        ? exactMatches
        : [...results].sort((left, right) => scorePageTitle(right, normalizedQuery) - scorePageTitle(left, normalizedQuery));
      pages = selected.slice(0, 2).map((page) => ({
        id: page.id,
        title: getPageTitle(page) || "Notion 页面",
      }));
    }

    for (const page of pages) {
      const lines = [];
      await collectBlockLines(apiKey, page.id, lines, 0, { count: 0 });
      matches.push({
        id: page.id,
        title: page.title,
        content: trimText(lines.join("\n"), limit),
      });
    }

    response.status(200).json({
      query: cleanQuery,
      matches,
      content: trimText(
        matches.map((match, index) => `# ${index + 1}. ${match.title}\n${match.content}`).join("\n\n"),
        limit,
      ),
    });
  } catch (error) {
    response.status(502).json({ error: error?.message || "Notion request failed" });
  }
}

function normalizeMatchText(value = "") {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .trim();
}

function scorePageTitle(page, normalizedQuery) {
  const title = normalizeMatchText(getPageTitle(page));
  if (!title || !normalizedQuery) return 0;
  if (title === normalizedQuery) return 1000;
  if (title.includes(normalizedQuery) || normalizedQuery.includes(title)) {
    return 500 - Math.abs(title.length - normalizedQuery.length);
  }
  let shared = 0;
  for (const character of new Set(normalizedQuery)) {
    if (title.includes(character)) shared += 1;
  }
  return shared;
}

async function notionFetch(apiKey, path, options = {}) {
  const upstream = await fetch(`https://api.notion.com${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "Notion-Version": NOTION_VERSION,
      ...(options.headers || {}),
    },
  });
  const text = await upstream.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = {};
  }
  if (!upstream.ok) {
    throw new Error(data?.message || `Notion 接口请求失败：${upstream.status}`);
  }
  return data;
}

async function searchPages(apiKey, query) {
  const data = await notionFetch(apiKey, "/v1/search", {
    method: "POST",
    body: JSON.stringify({
      query,
      page_size: 5,
      filter: {
        value: "page",
        property: "object",
      },
    }),
  });
  return Array.isArray(data.results) ? data.results : [];
}

async function retrievePage(apiKey, pageId) {
  return notionFetch(apiKey, `/v1/pages/${encodeURIComponent(pageId)}`);
}

async function retrieveBlockChildren(apiKey, blockId, cursor = "") {
  const params = new URLSearchParams({ page_size: "100" });
  if (cursor) params.set("start_cursor", cursor);
  return notionFetch(apiKey, `/v1/blocks/${encodeURIComponent(blockId)}/children?${params.toString()}`, {
    method: "GET",
  });
}

async function collectBlockLines(apiKey, blockId, lines, depth, stats) {
  if (depth > MAX_DEPTH || stats.count >= MAX_BLOCKS) return;
  let cursor = "";
  do {
    const data = await retrieveBlockChildren(apiKey, blockId, cursor);
    const blocks = Array.isArray(data.results) ? data.results : [];
    for (const block of blocks) {
      if (stats.count >= MAX_BLOCKS) return;
      stats.count += 1;
      const line = blockToLine(block, depth);
      if (line) lines.push(line);
      if (block.has_children && depth < MAX_DEPTH) {
        await collectBlockLines(apiKey, block.id, lines, depth + 1, stats);
      }
    }
    cursor = data.has_more ? data.next_cursor || "" : "";
  } while (cursor && stats.count < MAX_BLOCKS);
}

function getPageTitle(page) {
  const properties = page?.properties || {};
  for (const property of Object.values(properties)) {
    if (property?.type !== "title") continue;
    const title = richTextToPlain(property.title);
    if (title) return title;
  }
  return "";
}

function blockToLine(block, depth = 0) {
  const type = block?.type;
  if (!type) return "";
  const value = block[type] || {};
  const indent = "  ".repeat(depth);
  const text = richTextToPlain(value.rich_text);
  if (type === "child_page") return `${indent}[页面] ${value.title || "未命名页面"}`;
  if (type === "child_database") return `${indent}[数据库] ${value.title || "未命名数据库"}`;
  if (type === "to_do") return `${indent}${value.checked ? "[x]" : "[ ]"} ${text}`;
  if (type === "bulleted_list_item") return `${indent}- ${text}`;
  if (type === "numbered_list_item") return `${indent}1. ${text}`;
  if (type === "toggle") return `${indent}> ${text}`;
  if (type === "quote") return `${indent}> ${text}`;
  if (type === "callout") return `${indent}${text}`;
  if (/^heading_/.test(type)) return `${indent}${"#".repeat(Number(type.slice(-1)) || 2)} ${text}`;
  if (type === "paragraph") return text ? `${indent}${text}` : "";
  if (type === "code") return text ? `${indent}${text}` : "";
  return text ? `${indent}${text}` : "";
}

function richTextToPlain(richText = []) {
  if (!Array.isArray(richText)) return "";
  return richText.map((item) => item?.plain_text || "").join("").trim();
}

function extractNotionId(value = "") {
  const text = String(value || "").trim();
  if (!text) return "";
  const compact = text.replace(/-/g, "");
  const match = compact.match(/[0-9a-f]{32}/i);
  if (!match) return text;
  const id = match[0];
  return `${id.slice(0, 8)}-${id.slice(8, 12)}-${id.slice(12, 16)}-${id.slice(16, 20)}-${id.slice(20)}`;
}

function trimText(text, limit) {
  const value = String(text || "").trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit).trim()}\n...`;
}
