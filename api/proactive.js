import { hasRedisConfig, readJson, redisCommand, writeJson } from "./_lib/redis.js";
import {
  CLIENT_SET_KEY, clientKey, cleanText, encryptSecret, hashSecret,
  isAuthorizedRecord, normalizeConfig, normalizeRecent
} from "./_lib/proactive.js";
import { getRuntimeSecret } from "./_lib/runtime-secrets.js";
import { proxyToNodeBackend, shouldProxyToNodeBackend } from "./_lib/node-backend.js";

const send = (res, status, payload) => res.status(status).json(payload);
const configured = () => Boolean(
  hasRedisConfig() && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY &&
  getRuntimeSecret("PROACTIVE_ENCRYPTION_KEY")
);

function normalizeSnapshot(value = {}) {
  return {
    recent: normalizeRecent(value.recent),
    visible: Boolean(value.visible),
    api: {
      baseUrl: cleanText(value.api?.baseUrl, 500), model: cleanText(value.api?.model, 200),
      temperature: Number(value.api?.temperature) || 0.5,
      maxTokens: Math.min(1200, Math.max(120, Number(value.api?.maxTokens) || 500))
    },
    persona: {
      name: cleanText(value.persona?.name, 100), core: cleanText(value.persona?.core, 5000),
      memory: cleanText(value.persona?.memory, 3000)
    }
  };
}

function applySnapshot(record, snapshot, now) {
  const latest = snapshot.recent.at(-1) || null;
  const previous = record.recent?.at(-1) || null;
  const changed = latest && (!previous || latest.id !== previous.id || latest.createdAt !== previous.createdAt);
  record.recent = snapshot.recent;
  record.api = { ...(record.api || {}), ...snapshot.api };
  record.persona = snapshot.persona;
  record.clientVisibleAt = snapshot.visible ? now : record.clientVisibleAt || 0;
  if (changed && latest.role === "user") {
    record.lastUserAt = latest.createdAt;
    record.followUpsSent = 0;
    record.pending = [];
    record.nextEligibleAt = 0;
  } else if (changed && latest.role === "assistant" && !latest.proactive) {
    record.lastAssistantAt = latest.createdAt;
    record.followUpsSent = 0;
    record.nextEligibleAt = 0;
  }
  return record;
}

export default async function handler(req, res) {
  if (shouldProxyToNodeBackend()) {
    try { return await proxyToNodeBackend(req, res, "proactive"); }
    catch (error) { return send(res, 502, { error: `腾讯后端连接失败：${error?.message || "网络错误"}` }); }
  }
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") {
    return send(res, 200, { ready: configured(), publicKey: configured() ? process.env.VAPID_PUBLIC_KEY : "" });
  }
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed." });
  if (!configured()) return send(res, 503, { error: "主动消息后台还没有配置完成。" });

  const body = req.body || {};
  const action = cleanText(body.action, 30);
  const clientId = cleanText(body.clientId, 120);
  const clientSecret = cleanText(body.clientSecret, 200);
  if (!clientId || !clientSecret) return send(res, 400, { error: "设备身份无效。" });
  const key = clientKey(clientId);
  let record = await readJson(key);
  const now = Date.now();

  if (action === "register") {
    if (record && !isAuthorizedRecord(record, clientSecret)) return send(res, 403, { error: "设备验证失败。" });
    record = applySnapshot(record || {
      id: clientId, secretHash: hashSecret(clientSecret), createdAt: now, pending: [],
      followUpsSent: 0, dailyCount: 0, dailyDate: "", revision: 0
    }, normalizeSnapshot(body.snapshot), now);
    record.enabled = Boolean(body.enabled);
    record.subscription = body.subscription || record.subscription || null;
    record.config = normalizeConfig(body.config);
    if (body.apiKey) record.apiKeyEncrypted = encryptSecret(body.apiKey);
    record.updatedAt = now;
    record.revision = (Number(record.revision) || 0) + 1;
    await writeJson(key, record);
    await redisCommand("SADD", CLIENT_SET_KEY, clientId);
    return send(res, 200, { ok: true, subscribed: Boolean(record.subscription) });
  }

  if (!record || !isAuthorizedRecord(record, clientSecret)) {
    return send(res, 404, { error: "还没有找到这台设备的主动消息设置。" });
  }
  if (action === "sync") {
    record = applySnapshot(record, normalizeSnapshot(body.snapshot), now);
    record.enabled = Boolean(body.enabled);
    record.config = normalizeConfig(body.config || record.config);
    if (body.apiKey) record.apiKeyEncrypted = encryptSecret(body.apiKey);
    record.updatedAt = now;
    record.revision = (Number(record.revision) || 0) + 1;
    await writeJson(key, record);
    return send(res, 200, { ok: true });
  }
  if (action === "user-active") {
    record.pending = [];
    record.followUpsSent = 0;
    record.nextEligibleAt = 0;
    record.lastUserAt = Math.max(Number(record.lastUserAt) || 0, Number(body.createdAt) || now);
    record.updatedAt = now;
    record.revision = (Number(record.revision) || 0) + 1;
    await writeJson(key, record);
    return send(res, 200, { ok: true });
  }
  if (action === "pull") {
    const pending = Array.isArray(record.pending) ? record.pending : [];
    record.pending = [];
    record.clientVisibleAt = now;
    record.updatedAt = now;
    record.revision = (Number(record.revision) || 0) + 1;
    await writeJson(key, record);
    return send(res, 200, { ok: true, messages: pending });
  }
  if (action === "unsubscribe") {
    record.enabled = false;
    record.subscription = null;
    record.pending = [];
    record.updatedAt = now;
    record.revision = (Number(record.revision) || 0) + 1;
    await writeJson(key, record);
    await redisCommand("SREM", CLIENT_SET_KEY, clientId);
    return send(res, 200, { ok: true });
  }
  return send(res, 400, { error: "Unknown action." });
}
