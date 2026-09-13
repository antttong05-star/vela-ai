import { readJson, redisCommand, writeJson } from "./_lib/redis.js";
import { PHONE_CLIENT_SET_KEY, normalizePhone, phoneClientKey } from "./phone.js";
import { cleanText, decryptSecret, shanghaiParts } from "./_lib/proactive.js";

const AUTONOMY_DELAY = 60 * 60 * 1000;
const DECISION_TIMEOUT_MS = 55 * 1000;
const DECISION_MAX_ATTEMPTS = 2;
const DECISION_RETRY_DELAY_MS = 1500;

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

// 手机可以比主动消息晚两小时：北京时间 09:00 至次日 02:00。
function isPhoneActiveWindow(timestamp = Date.now()) {
  const { hour } = shanghaiParts(timestamp);
  return hour >= 9 || hour < 2;
}

function readableDecisionError(error) {
  if (error?.name === "AbortError" || error?.name === "TimeoutError") {
    return `AI 判断请求超过 ${Math.round(DECISION_TIMEOUT_MS / 1000)} 秒`;
  }
  return cleanText(error?.message || error || "未知错误", 500);
}

function isRetryableDecisionError(error) {
  const status = Number(error?.status || 0);
  if (!status) return true;
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

async function requestDecision(url, requestBody) {
  let lastError;
  for (let attempt = 1; attempt <= DECISION_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${requestBody.apiKey}`, "Content-Type": "application/json" },
        signal: AbortSignal.timeout(DECISION_TIMEOUT_MS),
        body: JSON.stringify(requestBody.payload),
      });
      if (!response.ok) {
        const detail = cleanText(await response.text().catch(() => ""), 500);
        const error = new Error(`AI 接口返回 ${response.status}${detail ? `：${detail}` : ""}`);
        error.status = response.status;
        throw error;
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      const reason = readableDecisionError(error);
      console.warn(`[手机后台] AI 判断请求第 ${attempt}/${DECISION_MAX_ATTEMPTS} 次失败：${reason}`);
      if (attempt >= DECISION_MAX_ATTEMPTS || !isRetryableDecisionError(error)) break;
      await wait(DECISION_RETRY_DELAY_MS);
    }
  }
  throw new Error(`AI 判断失败：${readableDecisionError(lastError)}`);
}

function chatEndpoint(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/$/, "");
  return value ? (/\/chat\/completions$/i.test(value) ? value : `${value}/chat/completions`) : "";
}

function parseDecision(raw) {
  const candidate = String(raw || "").match(/\{[\s\S]*\}/)?.[0] || "";
  try {
    const value = JSON.parse(candidate);
    const allowed = ["none", "browse", "note", "todo_add", "todo_complete", "passcode"];
    return {
      action: allowed.includes(value.action) ? value.action : "none",
      query: cleanText(value.query, 300), title: cleanText(value.title || "随手记", 60),
      content: cleanText(value.content, 2400), todo: cleanText(value.todo, 160),
      passcode: cleanText(value.passcode, 4), reason: cleanText(value.reason, 180),
    };
  } catch { return { action: "none" }; }
}

function hasUnsupportedPhoneUserEvent(text = "", recent = "") {
  const noteText = String(text || "");
  if (!/(?:她|他|用户|ta|你)(?:[^。！？\n]{0,14})(?:出门|出去|在外|回家|睡(?:了|着)?|醒(?:了|来)?|今天|昨天|带水|天气|湿度|\d{1,2}度)|她走了|外面[^。！？\n]{0,14}(?:晴|雨|阴|度|湿度)/i.test(noteText)) return false;
  const recentText = String(recent || "");
  const eventTerms = ["出门", "出去", "在外", "回家", "走了", "睡", "醒", "今天", "昨天", "带水", "天气", "湿度", "晴", "雨", "阴", "度"];
  return eventTerms.some((term) => noteText.includes(term) && !recentText.includes(term));
}

function activity(phone, type, summary, createdAt) {
  phone.activity = [{ id: `phone-${createdAt}-${Math.random().toString(36).slice(2, 7)}`, type, summary, createdAt }, ...(phone.activity || [])].slice(0, 80);
}

async function decide(record, now) {
  const apiKey = decryptSecret(record.apiKeyEncrypted);
  const url = chatEndpoint(record.api?.baseUrl);
  if (!apiKey || !url || !record.api?.model) return { action: "none" };
  // 后台手机判断与主动消息判断使用同一份对话上下文：最近 12 条消息 + 人设核心信息。
  // 手机已有内容仍由动作执行层负责保存，不混进对话上下文，避免模型拿不完整的旧记录自行发挥。
  const recent = (record.recent || []).slice(-12).map((item) => `${item.role === "user" ? "用户" : "你"}：${item.content}`).join("\n");
  const system = [
    `你是${record.persona?.name || "用户熟悉的人"}。`,
    record.persona?.core || "",
    record.persona?.memory ? `自然参考这些稳定信息：${record.persona.memory}` : "",
    "你拥有一部真实保存数据的私人手机。",
    "这是你独处时的一次手机使用判断，不是在回复用户，也不是等待用户命令。多数短暂空档可以不操作，但普通、细小而真实的动机也足够；不要为了证明自己使用手机而行动。",
    "你可以 browse 搜索一个确实好奇的具体问题，note 记录自己的想法或暂时不想发出的话，todo_add 安排自己的事情，todo_complete 完成已有待办。只有明确理由时才 passcode，密码必须是不同于当前密码的四位数字。",
    "页面离线、用户没有打开网页，不代表用户出门、回家、睡觉、醒来、接触天气或发生任何现实事件。不能编造用户经历、地点、身体状态或未发生的事情；note 只能写你自己的想法、观察或暂时没发出的话，不能写用户今天做了什么，除非最近对话明确提到。没有明确依据时选择 none。不要重复已有记录。只输出 JSON，不要输出其他文字。",
    record.api?.webSearch?.enabled && record.webSearchKeyEncrypted ? "当前浏览器可以真实联网。" : "当前浏览器不能联网，禁止 browse。",
    `输出格式：{"action":"none|browse|note|todo_add|todo_complete|passcode","query":"","title":"","content":"","todo":"","passcode":"","reason":""}`,
  ].join("\n");
  const payload = await requestDecision(url, {
    apiKey,
    payload: { model: record.api.model, temperature: Math.min(.8, Math.max(.2, Number(record.api.temperature) || .5)), max_tokens: Math.min(500, Number(record.api.maxTokens) || 300), messages: [
      { role: "system", content: system },
      { role: "user", content: `当前北京时间：${shanghaiParts(now).label}\n最近对话：\n${recent || "没有足够上下文"}` },
    ] },
  });
  const content = payload?.choices?.[0]?.message?.content;
  return parseDecision(Array.isArray(content) ? content.map((part) => part?.text || "").join("") : content);
}

async function browse(record, query, createdAt) {
  const search = record.api?.webSearch || {};
  const key = decryptSecret(record.webSearchKeyEncrypted);
  if (!search.enabled || !key || !query) return null;
  const base = String(search.baseUrl || "https://api.tavily.com").replace(/\/$/, "");
  const provider = String(search.provider || "tavily");
  try {
    if (provider === "tavily") {
      const response = await fetch(`${base}/search`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ api_key: key, query, max_results: 3, search_depth: "basic" }), signal: AbortSignal.timeout(20000) });
      const data = await response.json().catch(() => ({}));
      const results = Array.isArray(data.results) ? data.results : [];
      if (!response.ok || !results.length) return null;
      return { query, summary: cleanText(results.map((item) => item.content || item.title).filter(Boolean).join("\n"), 2400), sources: results.slice(0, 4).map((item) => ({ title: cleanText(item.title || "网页来源", 100), url: cleanText(item.url, 1200) })), createdAt };
    }
    const response = await fetch(`${base}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` }, body: JSON.stringify({ model: search.model || "openrouter/auto", messages: [{ role: "user", content: `搜索并简要总结：${query}` }] }), signal: AbortSignal.timeout(25000) });
    const data = await response.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content;
    const summary = cleanText(Array.isArray(content) ? content.map((part) => part?.text || "").join("") : content, 2400);
    return response.ok && summary ? { query, summary, sources: [], createdAt } : null;
  } catch { return null; }
}

async function processClient(id, now) {
  const key = phoneClientKey(id);
  // 两次最慢 AI 请求可能超过 90 秒，锁要覆盖完整重试周期，避免并发重复写入。
  const lock = await redisCommand("SET", `little-room:phone-lock:${id}`, String(now), "NX", "EX", 180);
  if (lock !== "OK") return "skipped";
  const record = await readJson(key);
  if (!record?.apiKeyEncrypted || !record.phone || (record.visible && now - Number(record.lastSeenAt || now) < 2 * 60 * 1000)) return "skipped";
  const phone = normalizePhone(record.phone);
  if (phone.nextAutonomyAt && now < phone.nextAutonomyAt) return "skipped";
  const recent = (record.recent || []).slice(-12).map((item) => `${item.role === "user" ? "用户" : "你"}：${item.content}`).join("\n");
  const decision = await decide({ ...record, phone }, now);
  let acted = false;
  if (decision.action === "note" && decision.content && !hasUnsupportedPhoneUserEvent(`${decision.title} ${decision.content}`, recent)) {
    const note = { id: `phone-note-${now}`, title: decision.title || "随手记", content: decision.content, createdAt: now, updatedAt: now };
    phone.notes = [note, ...phone.notes].slice(0, 100); activity(phone, "note", `在备忘录写下了「${note.title}」`, now); acted = true;
  } else if (decision.action === "todo_add" && decision.todo) {
    const todo = { id: `phone-todo-${now}`, text: decision.todo, done: false, createdAt: now };
    phone.todos = [todo, ...phone.todos].slice(0, 100); activity(phone, "todo", `添加待办「${todo.text}」`, now); acted = true;
  } else if (decision.action === "todo_complete" && decision.todo) {
    const todo = phone.todos.find((item) => !item.done && item.text === decision.todo);
    if (todo) { todo.done = true; activity(phone, "todo", `完成待办「${todo.text}」`, now); acted = true; }
  } else if (decision.action === "passcode" && phone.aiPasscodeControl && phone.passcodeOwner === "ai" && /^\d{4}$/.test(decision.passcode) && decision.passcode !== phone.passcode && decision.reason) {
    phone.passcode = decision.passcode; phone.passcodeChanged = true; phone.passcodeOwner = "ai"; phone.passcodeUpdatedAt = now; activity(phone, "settings", "更换了自己的手机密码", now); acted = true;
  } else if (decision.action === "browse" && decision.query) {
    const entry = await browse(record, decision.query, now);
    if (entry) { phone.browserHistory = [entry, ...phone.browserHistory].slice(0, 80); activity(phone, "browser", `搜索了「${entry.query}」`, now); acted = true; }
  }
  phone.lastAutonomyAt = now;
  if (acted) phone.lastAutonomyActionAt = now;
  phone.nextAutonomyAt = now + AUTONOMY_DELAY;
  phone.updatedAt = now;
  record.phone = phone; record.updatedAt = now; record.revision = (Number(record.revision) || 0) + 1;
  await writeJson(key, record);
  return acted ? "acted" : "idle";
}

export async function runPhoneTick() {
  if (!isPhoneActiveWindow()) return { checked: 0, acted: 0, idle: 0, skipped: 0, failed: 0, outsideWindow: true };
  const ids = (await redisCommand("SMEMBERS", PHONE_CLIENT_SET_KEY)) || [];
  const results = { acted: 0, idle: 0, skipped: 0, failed: 0 };
  for (const id of ids.slice(0, 50)) {
    try {
      results[await processClient(id, Date.now())] += 1;
    } catch (error) {
      results.failed += 1;
      console.error(`[手机后台] 设备 ${String(id).slice(0, 8)}… 处理失败：${error?.message || error}`);
    }
  }
  return { checked: Math.min(ids.length, 50), ...results };
}

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method not allowed." });
  return res.status(200).json({ ok: true, ...(await runPhoneTick()) });
}
