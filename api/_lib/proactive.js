import crypto from "node:crypto";
import { getRuntimeSecret } from "./runtime-secrets.js";

export const CLIENT_SET_KEY = "little-room:proactive:clients";
export const clientKey = (clientId) => `little-room:proactive:${clientId}`;

export function hashSecret(secret) {
  return crypto.createHash("sha256").update(String(secret || "")).digest("hex");
}

function encryptionKey() {
  const source = getRuntimeSecret("PROACTIVE_ENCRYPTION_KEY");
  return crypto.createHash("sha256").update(source).digest();
}

export function encryptSecret(value) {
  if (!value) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  return [iv, cipher.getAuthTag(), encrypted].map((item) => item.toString("base64url")).join(".");
}

export function decryptSecret(value) {
  if (!value) return "";
  const [ivText, tagText, encryptedText] = String(value).split(".");
  if (!ivText || !tagText || !encryptedText) return "";
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(encryptedText, "base64url")), decipher.final()]).toString("utf8");
}

export function cleanText(value, maxLength = 1000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function normalizeConfig(value = {}) {
  const number = (input, fallback, min, max) => {
    const parsed = Number(input);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };
  return {
    firstDelayHours: number(value.firstDelayHours, 6, 1, 48),
    followUpDelayHours: number(value.followUpDelayHours, 8, 1, 48),
    maxFollowUps: Math.round(number(value.maxFollowUps, 2, 1, 2)),
    dailyLimit: Math.round(number(value.dailyLimit, 2, 1, 2)),
    quietStart: Math.round(number(value.quietStart, 23, 0, 23)),
    quietEnd: Math.round(number(value.quietEnd, 9, 0, 23))
  };
}

export function normalizeRecent(messages) {
  return (Array.isArray(messages) ? messages : [])
    .filter((item) => item && ["user", "assistant"].includes(item.role) && item.content)
    .slice(-16)
    .map((item) => ({
      id: cleanText(item.id, 100), role: item.role, content: cleanText(item.content, 600),
      createdAt: Number(item.createdAt) || Date.now(), proactive: Boolean(item.proactive)
    }));
}

export function shanghaiParts(timestamp = Date.now()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    label: `${values.year}年${values.month}月${values.day}日 ${values.hour}:${values.minute}`
  };
}

export function isActiveWindow(timestamp = Date.now()) {
  const { hour } = shanghaiParts(timestamp);
  return hour >= 9 && hour < 24;
}

export function isQuietHour(hour, config) {
  const { quietStart, quietEnd } = config;
  if (quietStart === quietEnd) return false;
  if (quietStart < quietEnd) return hour >= quietStart && hour < quietEnd;
  return hour >= quietStart || hour < quietEnd;
}

export function isAuthorizedRecord(record, secret) {
  if (!record?.secretHash || !secret) return false;
  const expected = Buffer.from(record.secretHash);
  const actual = Buffer.from(hashSecret(secret));
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
