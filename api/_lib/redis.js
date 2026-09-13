import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = process.env.LITTLE_ROOM_DATA_DIR || path.join(ROOT, ".data");
const STORE_FILE = path.join(DATA_DIR, "storage.json");
const LOCKS = new Map();

function getRedisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "";
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
  return { url: url.replace(/\/$/, ""), token };
}

function useFileStorage() {
  const { url, token } = getRedisConfig();
  return !url || !token;
}

async function readStore() {
  try {
    const raw = await fsp.readFile(STORE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function writeStore(store) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const temporary = `${STORE_FILE}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, JSON.stringify(store), "utf8");
  await fsp.rename(temporary, STORE_FILE);
}

async function fileCommand(...args) {
  const [command, key, value, mode, ttlMode, ttl] = args;
  const store = await readStore();
  if (command === "GET") return store[key] ?? null;
  if (command === "SET") {
    if (mode === "NX" && store[key] !== undefined) {
      const expiresAt = Number(store.__expires?.[key] || 0);
      if (!expiresAt || expiresAt > Date.now()) return null;
      delete store[key];
    }
    store[key] = value;
    if (ttlMode === "EX" && Number(ttl) > 0) {
      store.__expires = { ...(store.__expires || {}), [key]: Date.now() + Number(ttl) * 1000 };
    }
    await writeStore(store);
    return "OK";
  }
  if (command === "SADD") {
    const set = new Set(Array.isArray(store[key]) ? store[key] : []);
    set.add(value);
    store[key] = [...set];
    await writeStore(store);
    return 1;
  }
  if (command === "SREM") {
    store[key] = (Array.isArray(store[key]) ? store[key] : []).filter((item) => item !== value);
    await writeStore(store);
    return 1;
  }
  if (command === "SMEMBERS") return Array.isArray(store[key]) ? store[key] : [];
  throw new Error(`Unsupported storage command: ${command}`);
}

export function hasRedisConfig() {
  const { url, token } = getRedisConfig();
  return Boolean((url && token) || useFileStorage());
}

export async function redisCommand(...args) {
  const { url, token } = getRedisConfig();
  if (useFileStorage()) {
    const [command, key] = args;
    if (command === "SET" && args[3] === "NX") {
      const existing = LOCKS.get(key);
      if (existing && existing > Date.now()) return null;
      LOCKS.set(key, Date.now() + Number(args[5] || 90) * 1000);
    }
    return fileCommand(...args);
  }
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(args)
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new Error(payload.error || `Storage request failed (${response.status}).`);
  }
  return payload.result;
}

export async function readJson(key) {
  const value = await redisCommand("GET", key);
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function writeJson(key, value) {
  return redisCommand("SET", key, JSON.stringify(value));
}
