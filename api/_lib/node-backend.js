// The phone PWA is deployed on Vercel, while the long-running Node service
// lives on the Tencent VM. Keep the browser on the original Vercel origin and
// proxy stateful phone/proactive calls server-side to the Node service.
const DEFAULT_NODE_BACKEND_ORIGIN = "http://43.133.163.186:3000";

export function shouldProxyToNodeBackend() {
  return Boolean(process.env.VERCEL);
}

function nodeBackendOrigin() {
  return String(process.env.LITTLE_ROOM_NODE_BACKEND_URL || DEFAULT_NODE_BACKEND_ORIGIN).trim().replace(/\/$/, "");
}

export async function proxyToNodeBackend(req, res, endpoint) {
  const query = req.query && typeof req.query === "object"
    ? new URLSearchParams(Object.entries(req.query).filter(([, value]) => value !== undefined && value !== null)).toString()
    : "";
  const target = `${nodeBackendOrigin()}/api/${endpoint}${query ? `?${query}` : ""}`;
  const headers = { Accept: "application/json" };
  if (req.headers?.authorization) headers.Authorization = req.headers.authorization;
  if (req.headers?.["content-type"]) headers["Content-Type"] = req.headers["content-type"];
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== undefined;
  const response = await fetch(target, {
    method: req.method,
    headers,
    body: hasBody ? JSON.stringify(req.body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const body = await response.text();
  res.status(response.status);
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", response.headers.get("content-type") || "application/json; charset=utf-8");
  return res.send(body);
}
