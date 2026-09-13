import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = process.env.LITTLE_ROOM_DATA_DIR || path.join(ROOT, ".data");
const FILE = path.join(DATA_DIR, "runtime-secrets.json");

export function getRuntimeSecret(name) {
  const configured = String(process.env[name] || "").trim();
  if (configured) return configured;
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (parsed?.[name]) return String(parsed[name]);
  } catch {}
  const value = crypto.randomBytes(32).toString("hex");
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    let parsed = {};
    try { parsed = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
    parsed[name] = value;
    fs.writeFileSync(FILE, JSON.stringify(parsed), { mode: 0o600 });
  } catch {}
  return value;
}

export async function ensureVapidKeys() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, "utf8"));
    if (parsed?.VAPID_PUBLIC_KEY && parsed?.VAPID_PRIVATE_KEY) return parsed;
  } catch {}
  const module = await import("web-push");
  const keys = (module.default || module).generateVAPIDKeys();
  let parsed = {};
  try { parsed = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch {}
  parsed.VAPID_PUBLIC_KEY = keys.publicKey;
  parsed.VAPID_PRIVATE_KEY = keys.privateKey;
  parsed.VAPID_CONTACT = parsed.VAPID_CONTACT || "mailto:admin@example.com";
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(parsed), { mode: 0o600 });
  return parsed;
}
