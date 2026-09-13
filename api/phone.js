import { hasRedisConfig, readJson, redisCommand, writeJson } from "./_lib/redis.js";
import {
  cleanText, encryptSecret, hashSecret, isAuthorizedRecord, normalizeRecent,
} from "./_lib/proactive.js";
import { proxyToNodeBackend, shouldProxyToNodeBackend } from "./_lib/node-backend.js";

export const PHONE_CLIENT_SET_KEY = "little-room:phone:clients";
const send = (res, status, payload) => res.status(status).json(payload);

export function phoneClientKey(id) {
  return `little-room:phone:${id}`;
}

export function normalizePhone(value = {}) {
  const wallpaperImage = String(value.wallpaperImage || "");
  return {
    passcode: /^\d{4}$/.test(String(value.passcode || "")) ? String(value.passcode) : "2580",
    passcodeChanged: Boolean(value.passcodeChanged),
    passcodeOwner: ["default", "user", "ai"].includes(value.passcodeOwner) ? value.passcodeOwner : "default",
    passcodeUpdatedAt: Number(value.passcodeUpdatedAt) || 0,
    aiPasscodeControl: Boolean(value.aiPasscodeControl),
    wallpaper: ["aurora", "sunset", "graphite", "photo"].includes(value.wallpaper) ? value.wallpaper : "aurora",
    wallpaperImage: /^data:image\//i.test(wallpaperImage) && wallpaperImage.length < 5 * 1024 * 1024 ? wallpaperImage : "",
    notes: (Array.isArray(value.notes) ? value.notes : []).filter((item) => item?.content).slice(0, 100).map((item) => ({
      id: cleanText(item.id, 100), title: cleanText(item.title || "随手记", 60), content: cleanText(item.content, 2400),
      createdAt: Number(item.createdAt) || Date.now(), updatedAt: Number(item.updatedAt) || Number(item.createdAt) || Date.now(),
    })),
    deletedNoteIds: [...new Set(Array.isArray(value.deletedNoteIds) ? value.deletedNoteIds.map((id) => cleanText(id, 100)).filter(Boolean) : [])].slice(-200),
    todos: (Array.isArray(value.todos) ? value.todos : []).filter((item) => item?.text).slice(0, 100).map((item) => ({
      id: cleanText(item.id, 100), text: cleanText(item.text, 160), done: Boolean(item.done), createdAt: Number(item.createdAt) || Date.now(),
    })),
    browserHistory: (Array.isArray(value.browserHistory) ? value.browserHistory : []).filter((item) => item?.query && item?.summary).slice(0, 80).map((item) => ({
      id: cleanText(item.id, 100), query: cleanText(item.query, 300), summary: cleanText(item.summary, 2400),
      sources: Array.isArray(item.sources) ? item.sources.slice(0, 4).map((source) => ({ title: cleanText(source.title || "网页来源", 100), url: cleanText(source.url, 1200) })) : [],
      createdAt: Number(item.createdAt) || Date.now(),
    })),
    activity: (Array.isArray(value.activity) ? value.activity : []).filter((item) => item?.summary).slice(0, 80).map((item) => ({
      id: cleanText(item.id, 100), type: cleanText(item.type || "note", 20), summary: cleanText(item.summary, 180), createdAt: Number(item.createdAt) || Date.now(),
    })),
    lastAutonomyAt: Number(value.lastAutonomyAt) || 0,
    lastAutonomyActionAt: Number(value.lastAutonomyActionAt) || 0,
    nextAutonomyAt: Number(value.nextAutonomyAt) || 0,
    lastSeenAt: Number(value.lastSeenAt) || 0,
    lastCatchupAt: Number(value.lastCatchupAt) || 0,
    updatedAt: Number(value.updatedAt) || 0,
  };
}

function mergePhoneState(existingValue, incomingValue) {
  const existing = normalizePhone(existingValue);
  const incoming = normalizePhone(incomingValue);
  const deletedNoteIds = [...new Set([...(existing.deletedNoteIds || []), ...(incoming.deletedNoteIds || [])])].slice(-200);
  const mergeById = (left, right, limit, mergeItem = (_old, next) => next) => {
    const map = new Map();
    [...left, ...right].forEach((item) => {
      if (!item?.id) return;
      map.set(item.id, map.has(item.id) ? mergeItem(map.get(item.id), item) : item);
    });
    return [...map.values()].sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0)).slice(0, limit);
  };
  const incomingIsNewer = Number(incomingValue?.updatedAt || 0) >= Number(existingValue?.updatedAt || 0);
  const scalar = incomingIsNewer ? incoming : existing;
  const passcode = Number(incoming.passcodeUpdatedAt || 0) >= Number(existing.passcodeUpdatedAt || 0) ? incoming : existing;
  return {
    ...scalar,
    passcode: passcode.passcode,
    passcodeChanged: passcode.passcodeChanged,
    passcodeOwner: passcode.passcodeOwner,
    passcodeUpdatedAt: passcode.passcodeUpdatedAt,
    aiPasscodeControl: passcode.aiPasscodeControl,
    wallpaperImage: incoming.wallpaperImage || existing.wallpaperImage,
    notes: mergeById(existing.notes, incoming.notes, 100, (oldItem, nextItem) =>
      Number(nextItem.updatedAt || 0) >= Number(oldItem.updatedAt || 0) ? nextItem : oldItem,
    ).filter((item) => !deletedNoteIds.includes(item.id)),
    deletedNoteIds,
    todos: mergeById(existing.todos, incoming.todos, 100, (oldItem, nextItem) => ({
      ...oldItem,
      ...nextItem,
      done: Boolean(oldItem.done || nextItem.done),
    })),
    browserHistory: mergeById(existing.browserHistory, incoming.browserHistory, 80),
    activity: mergeById(existing.activity, incoming.activity, 80),
    updatedAt: Math.max(Number(existing.updatedAt) || 0, Number(incoming.updatedAt) || 0, Date.now()),
  };
}

function mergeRecentMessages(existingValue, incomingValue) {
  const map = new Map();
  [...normalizeRecent(existingValue), ...normalizeRecent(incomingValue)].forEach((message, index) => {
    const key = message.id || `${message.role}:${message.createdAt}:${message.content}:${index}`;
    map.set(key, message);
  });
  return [...map.values()]
    .sort((left, right) => Number(left.createdAt || 0) - Number(right.createdAt || 0))
    .slice(-16);
}

export function normalizeApi(value = {}) {
  return {
    baseUrl: cleanText(value.baseUrl, 500), model: cleanText(value.model, 200),
    temperature: Number(value.temperature) || 0.8, maxTokens: Math.min(1200, Math.max(120, Number(value.maxTokens) || 800)),
    webSearch: {
      enabled: Boolean(value.webSearch?.enabled), provider: cleanText(value.webSearch?.provider || "tavily", 30),
      baseUrl: cleanText(value.webSearch?.baseUrl, 500), model: cleanText(value.webSearch?.model || "openrouter/auto", 200),
    },
  };
}

function snapshotRecord(record, body, now) {
  const snapshot = body.snapshot || {};
  record.recent = mergeRecentMessages(record.recent, snapshot.recent);
  record.phone = mergePhoneState(record.phone, snapshot.phone);
  record.api = normalizeApi(snapshot.api);
  record.persona = { name: cleanText(snapshot.persona?.name, 100), core: cleanText(snapshot.persona?.core, 5000), memory: cleanText(snapshot.persona?.memory, 3000) };
  record.visible = Boolean(snapshot.visible);
  record.lastSeenAt = record.visible ? now : Number(record.lastSeenAt) || now;
  record.phone.nextAutonomyAt = Number(record.phone.nextAutonomyAt) || now + 5 * 60 * 1000;
  if (body.apiKey) record.apiKeyEncrypted = encryptSecret(body.apiKey);
  if (body.webSearchKey) record.webSearchKeyEncrypted = encryptSecret(body.webSearchKey);
  record.updatedAt = now;
  record.revision = (Number(record.revision) || 0) + 1;
  return record;
}

export default async function handler(req, res) {
  if (shouldProxyToNodeBackend()) {
    try { return await proxyToNodeBackend(req, res, "phone"); }
    catch (error) { return send(res, 502, { error: `腾讯后端连接失败：${error?.message || "网络错误"}` }); }
  }
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return send(res, 200, { ready: hasRedisConfig() });
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed." });
  const body = req.body || {};
  const clientId = cleanText(body.clientId, 120);
  const clientSecret = cleanText(body.clientSecret, 200);
  if (!clientId || !clientSecret) return send(res, 400, { error: "设备身份无效。" });
  const key = phoneClientKey(clientId);
  let record = await readJson(key);
  const now = Date.now();
  if (record && !isAuthorizedRecord(record, clientSecret)) return send(res, 403, { error: "设备验证失败。" });
  if (!record) record = { id: clientId, secretHash: hashSecret(clientSecret), createdAt: now, revision: 0 };
  const action = cleanText(body.action, 30);
  if (action === "sync") {
    record = snapshotRecord(record, body, now);
    await writeJson(key, record);
    await redisCommand("SADD", PHONE_CLIENT_SET_KEY, clientId);
    return send(res, 200, { ok: true, updatedAt: record.phone.updatedAt });
  }
  if (action === "pull") {
    return send(res, 200, { ok: true, phone: record.phone || normalizePhone(), updatedAt: Number(record.phone?.updatedAt || 0) });
  }
  if (action === "disable") {
    record.enabled = false;
    await writeJson(key, record);
    await redisCommand("SREM", PHONE_CLIENT_SET_KEY, clientId);
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: "Unknown action." });
}
