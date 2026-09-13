import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY_BYTES = 16 * 1024 * 1024;

loadDotEnv(path.join(ROOT, ".env"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
};

const handlerCache = new Map();
const PHONE_TICK_INTERVAL = 60 * 60 * 1000;
const PROACTIVE_TICK_INTERVAL = 90 * 60 * 1000;

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2];
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[match[1]] = value.replace(/\\n/g, "\n");
  }
}

function safeApiName(pathname) {
  const name = pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : "";
}

async function getApiHandler(name) {
  if (!handlerCache.has(name)) {
    const moduleUrl = pathToFileURL(path.join(ROOT, "api", `${name}.js`)).href;
    handlerCache.set(name, import(moduleUrl).then((module) => module.default));
  }
  return handlerCache.get(name);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let total = 0;
    const chunks = [];
    request.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(Object.assign(new Error("请求体太大"), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve(undefined);
      const type = String(request.headers["content-type"] || "").toLowerCase();
      if (type.includes("application/json") || /^[\[{]/.test(raw.trim())) {
        try { return resolve(JSON.parse(raw)); } catch { return reject(Object.assign(new Error("JSON 格式不正确"), { statusCode: 400 })); }
      }
      resolve(raw);
    });
    request.on("error", reject);
  });
}

function makeResponse(nativeResponse) {
  const response = {
    status(code) { nativeResponse.statusCode = code; return response; },
    setHeader(name, value) { nativeResponse.setHeader(name, value); return response; },
    json(value) {
      if (!nativeResponse.headersSent) nativeResponse.setHeader("Content-Type", "application/json; charset=utf-8");
      nativeResponse.end(JSON.stringify(value));
      return response;
    },
    send(value) {
      if (value !== undefined && !nativeResponse.getHeader("Content-Type")) {
        nativeResponse.setHeader("Content-Type", typeof value === "string" ? "text/plain; charset=utf-8" : "application/octet-stream");
      }
      nativeResponse.end(value);
      return response;
    },
  };
  return response;
}

async function serveStatic(nativeResponse, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(ROOT, `.${requested}`);
  if (filePath !== ROOT && !filePath.startsWith(`${ROOT}${path.sep}`)) return false;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return false;
    nativeResponse.statusCode = 200;
    nativeResponse.setHeader("Content-Type", MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream");
    if (path.basename(filePath) === "sw.js" || path.basename(filePath) === "index.html") {
      nativeResponse.setHeader("Cache-Control", "no-cache");
    }
    fs.createReadStream(filePath).pipe(nativeResponse);
    return true;
  } catch {
    return false;
  }
}

const server = http.createServer(async (nativeRequest, nativeResponse) => {
  const parsed = new URL(nativeRequest.url || "/", `http://${nativeRequest.headers.host || "localhost"}`);
  nativeResponse.setHeader("Access-Control-Allow-Origin", "*");
  nativeResponse.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  nativeResponse.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (nativeRequest.method === "OPTIONS") return nativeResponse.end();

  if (parsed.pathname.startsWith("/api/")) {
    const name = safeApiName(parsed.pathname);
    if (!name) return makeResponse(nativeResponse).status(404).json({ error: "API not found" });
    try {
      const handler = await getApiHandler(name);
      if (typeof handler !== "function") throw new Error("API handler is invalid");
      const request = Object.assign(nativeRequest, {
        body: await readBody(nativeRequest),
        query: Object.fromEntries(parsed.searchParams.entries()),
      });
      return await handler(request, makeResponse(nativeResponse));
    } catch (error) {
      const status = Number(error?.statusCode) || 500;
      if (!nativeResponse.headersSent) makeResponse(nativeResponse).status(status).json({ error: error?.message || "服务器内部错误" });
      else nativeResponse.end();
      return;
    }
  }

  if (await serveStatic(nativeResponse, parsed.pathname)) return;
  makeResponse(nativeResponse).status(404).json({ error: "Not found" });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`小屋后端已启动：http://0.0.0.0:${PORT}`);
  startBackgroundSchedulers();
});

async function startBackgroundSchedulers() {
  try {
    const runtime = await import(pathToFileURL(path.join(ROOT, "api", "_lib", "runtime-secrets.js")).href);
    const vapid = await runtime.ensureVapidKeys();
    process.env.VAPID_PUBLIC_KEY ||= vapid.VAPID_PUBLIC_KEY;
    process.env.VAPID_PRIVATE_KEY ||= vapid.VAPID_PRIVATE_KEY;
    process.env.VAPID_CONTACT ||= vapid.VAPID_CONTACT || "mailto:admin@example.com";
    const phoneTick = await import(pathToFileURL(path.join(ROOT, "api", "phone-tick.js")).href);
    const proactiveTick = await import(pathToFileURL(path.join(ROOT, "api", "proactive-tick.js")).href);
    const runPhone = async () => {
      try { await phoneTick.runPhoneTick(); } catch (error) { console.error("手机后台任务失败：", error?.message || error); }
    };
    const runProactive = async () => {
      if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
        try { await proactiveTick.runProactiveTick(); } catch (error) { console.error("主动消息后台任务失败：", error?.message || error); }
      }
    };
    setTimeout(() => { void runPhone(); void runProactive(); }, 15 * 1000);
    setInterval(runPhone, PHONE_TICK_INTERVAL);
    setInterval(async () => {
      await runProactive();
    }, PROACTIVE_TICK_INTERVAL);
    console.log("小屋后台任务已开启：手机每天 09:00–次日 02:00、每 1 小时检查；主动消息每天 09:00–24:00、每 90 分钟检查。");
  } catch (error) {
    console.error("后台任务初始化失败：", error?.message || error);
  }
}

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
