import webpush from "web-push";
import { readJson, redisCommand, writeJson } from "./_lib/redis.js";
import {
  CLIENT_SET_KEY, clientKey, cleanText, decryptSecret, isActiveWindow, shanghaiParts
} from "./_lib/proactive.js";

function authorized(req) {
  const secret = String(process.env.CRON_SECRET || "");
  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return Boolean(secret && (bearer === secret || String(req.query?.secret || "") === secret));
}

function chatEndpoint(baseUrl) {
  const value = String(baseUrl || "").trim().replace(/\/$/, "");
  if (!value) return "";
  return /\/chat\/completions$/i.test(value) ? value : `${value}/chat/completions`;
}

function parseDecision(raw) {
  const candidate = String(raw || "").match(/\{[\s\S]*\}/)?.[0] || "";
  try {
    const value = JSON.parse(candidate);
    return { send: value.send === true, message: cleanText(value.message, 240) };
  } catch { return { send: false, message: "" }; }
}

function responseText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => typeof part === "string" ? part : part?.text || "").join("");
}

async function decideMessage(record, nowLabel) {
  const apiKey = decryptSecret(record.apiKeyEncrypted);
  const url = chatEndpoint(record.api?.baseUrl);
  if (!apiKey || !url || !record.api?.model) return { send: false, message: "" };
  const recent = (record.recent || []).slice(-12)
    .map((item) => `${item.role === "user" ? "用户" : "你"}：${item.content}`).join("\n");
  const system = [
    `你是${record.persona?.name || "用户熟悉的人"}。`, record.persona?.core || "",
    record.persona?.memory ? `自然参考这些稳定信息：${record.persona.memory}` : "",
    "判断是否要主动补发一条消息。只有确实自然、有必要时才发送；普通沉默、刚聊完或没有新话可说时不要发。",
    "不要编造刚看到的事、地点、身体状况或共同经历。不要责怪、催促，或用‘怎么不理我’施压。",
    "如果上一段对话有争执或情绪未落，可以克制地缓和或留一句台阶；否则宁可不发。",
    "消息像真实私聊，1到2句，自然完整的现代中文，不要动作描写，不要解释这是自动消息。",
    "只输出 JSON：{\"send\":true或false,\"message\":\"要发送的文字，或空字符串\"}。"
  ].filter(Boolean).join("\n");
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(25000),
    body: JSON.stringify({
      model: record.api.model,
      temperature: Math.min(0.8, Math.max(0.2, Number(record.api.temperature) || 0.5)),
      max_tokens: Math.min(400, Number(record.api.maxTokens) || 300),
      messages: [
        { role: "system", content: system },
        { role: "user", content: `当前北京时间：${nowLabel}\n最近对话：\n${recent || "没有足够上下文"}` }
      ]
    })
  });
  if (!response.ok) return { send: false, message: "" };
  const payload = await response.json();
  return parseDecision(responseText(payload?.choices?.[0]?.message?.content));
}

function eligible(record, now) {
  if (!record?.enabled || !record.apiKeyEncrypted) return false;
  // 后台每 90 分钟只做一次“要不要说话”的判断；不再设置距离上次聊天
  // 或本次拒绝后的强制等待。是否发送完全交给模型和最近对话语境决定。
  return Array.isArray(record.recent) && record.recent.length > 0;
}

async function processClient(id, now) {
  const key = clientKey(id);
  const lock = await redisCommand("SET", `little-room:proactive-lock:${id}`, String(now), "NX", "EX", 90);
  if (lock !== "OK") return "skipped";
  const record = await readJson(key);
  if (!eligible(record, now)) return "skipped";
  const startingRevision = Number(record.revision) || 0;
  const startingLatestId = String(record.recent?.at(-1)?.id || "");
  const parts = shanghaiParts(now);
  const decision = await decideMessage(record, parts.label);
  const current = await readJson(key);
  const currentLatestId = String(current?.recent?.at(-1)?.id || "");
  if (
    !current ||
    (Number(current.revision) || 0) !== startingRevision ||
    currentLatestId !== startingLatestId ||
    !eligible(current, Date.now())
  ) {
    return "skipped";
  }
  if (!decision.send || !decision.message) {
    current.updatedAt = Date.now();
    current.revision = startingRevision + 1;
    await writeJson(key, current);
    return "declined";
  }
  const message = {
    id: `proactive-${now}-${Math.random().toString(36).slice(2, 8)}`,
    role: "assistant", content: decision.message, createdAt: now, proactive: true
  };
  current.pending = [...(current.pending || []), message].slice(-5);
  current.recent = [...(current.recent || []), message].slice(-16);
  current.lastAssistantAt = now;
  current.updatedAt = Date.now();
  current.revision = startingRevision + 1;
  await writeJson(key, current);
  if (!current.subscription) return "sent";
  try {
    await webpush.sendNotification(current.subscription, JSON.stringify({
      title: current.persona?.name || "小屋", body: decision.message,
      id: message.id, tag: "little-room-proactive", url: "/?open=chat"
    }));
  } catch (error) {
    if ([404, 410].includes(error?.statusCode)) {
      current.subscription = null;
      current.enabled = false;
      current.updatedAt = Date.now();
      current.revision += 1;
      await writeJson(key, current);
      await redisCommand("SREM", CLIENT_SET_KEY, id);
    }
  }
  return "sent";
}

export async function runProactiveTick() {
  if (!isActiveWindow()) return { ok: true, checked: 0, sent: 0, skipped: 0, declined: 0, failed: 0, outsideWindow: true };
  const vapidPublicKey = process.env.VAPID_PUBLIC_KEY;
  const vapidPrivateKey = process.env.VAPID_PRIVATE_KEY;
  if (!vapidPublicKey || !vapidPrivateKey) {
    return { ok: false, error: "VAPID is not configured." };
  }
  webpush.setVapidDetails(
    process.env.VAPID_CONTACT || "mailto:admin@example.com",
    vapidPublicKey,
    vapidPrivateKey
  );
  const ids = (await redisCommand("SMEMBERS", CLIENT_SET_KEY)) || [];
  const results = { sent: 0, skipped: 0, declined: 0, failed: 0 };
  for (const id of ids.slice(0, 50)) {
    try {
      const result = await processClient(id, Date.now());
      results[result] = (results[result] || 0) + 1;
    } catch { results.failed += 1; }
  }
  return { ok: true, checked: Math.min(ids.length, 50), ...results };
}

export default async function handler(req, res) {
  if (!authorized(req)) return res.status(401).json({ error: "Unauthorized." });
  const result = await runProactiveTick();
  if (!result.ok) return res.status(503).json(result);
  return res.status(200).json(result);
}
