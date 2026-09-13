const CACHE_NAME = "vela-ai-v602";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=602",
  "./app.js?v=602",
  "./icons/chat-send-button.svg",
  "./icons/chat-sticker-button.svg",
  "./icons/chat-add-button.svg",
  "./fonts/MiSans-Light.woff2",
  "./fonts/MiSans-Regular.woff2",
  "./fonts/MiSans-Medium.woff2",
  "./fonts/MiSans-Semibold.woff2",
  "./fonts/MiSans-Bold.woff2",
  "./fonts/MiSans-Heavy.woff2",
  "./YunFengHanChanTi/YunFengHanChanTi-2.ttf",
  "./image/%E4%B8%8D%E8%A1%8C.jpg",
  "./image/%E4%BA%BA%E5%91%A2.jpg",
  "./image/%E5%93%AD%E5%93%AD.jpg",
  "./image/%E5%93%BC.jpg",
  "./image/%E8%B4%B4%E8%B4%B4.jpg",
  "./image/%E9%81%93%E6%AD%89.jpg",
  "./image/%E6%88%91%E7%9D%A1%E7%9D%A1%E7%9D%A1%E7%9D%A1.jpg",
  "./image/%E4%BD%A0%E4%BB%96%E5%A6%88%E4%B8%8D%E8%A6%81%E6%88%91%E4%BA%86%E5%90%97.jpg",
  "./image/%E5%8E%8B%E5%8A%9B%E4%B8%80%E5%8F%AA%E5%B0%8F%E7%8C%AB%EF%BC%9F.jpg",
  "./image/%E5%92%AC%E4%BD%A0.jpg",
  "./image/%E5%96%B5.jpg",
  "./image/%E6%91%B8%E5%A4%B4.jpg",
  "./image/%E5%B0%8F%E7%9A%87%E5%B8%9D%E9%A9%BE%E5%88%B0.jpg",
  "./image/%E6%88%91%E5%92%84%E5%92%84%E9%80%BC%E4%BA%BA%EF%BC%9F.jpg",
  "./image/%E4%B9%96%E5%AE%9D%E5%AE%9D.jpg",
  "./image/%E9%86%92%E9%86%92.jpg",
  "./image/%E6%88%91%E5%8E%BB%E4%BD%A0%E7%9A%84.jpg",
  "./image/%E4%BD%A0%E5%9C%A8%E5%B9%B2%E5%98%9B.jpg",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      Promise.all(
        ASSETS.map((asset) =>
          cache.add(asset).catch(() => {
            // Optional files, like a custom background image, should not break updates.
          }),
        ),
      ),
    ).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const requestUrl = new URL(event.request.url);
  const isDocumentRequest =
    event.request.mode === "navigate" ||
    event.request.destination === "document" ||
    requestUrl.pathname.endsWith(".html") ||
    requestUrl.pathname === "/";

  if (isDocumentRequest) {
    event.respondWith(
      fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {}));
          return response;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match("./index.html"))),
    );
    return;
  }

  const isCoreAsset =
    event.request.destination === "script" ||
    event.request.destination === "style" ||
    requestUrl.pathname.endsWith("/app.js") ||
    requestUrl.pathname.endsWith("/styles.css");
  if (isCoreAsset) {
    event.respondWith(
      fetch(event.request, { cache: "no-store" })
        .then((response) => {
          const copy = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {}));
          return response;
        })
        .catch(() => caches.match(event.request)),
    );
    return;
  }

  event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request)));
});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let payload = {};
    try {
      payload = event.data?.json() || {};
    } catch {
      payload = { body: event.data?.text() || "收到一条新消息。" };
    }
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    clients.forEach((client) => client.postMessage({ type: "PROACTIVE_MESSAGE", id: payload.id || "" }));
    if (clients.some((client) => client.visibilityState === "visible")) return;
    await self.registration.showNotification(payload.title || "Vela", {
      body: payload.body || "收到一条新消息。",
      tag: payload.tag || "vela-ai-proactive",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      data: { url: payload.url || "/?open=chat", id: payload.id || "" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const targetUrl = new URL(event.notification.data?.url || "/?open=chat", self.location.origin).href;
    const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = clients.find((client) => new URL(client.url).origin === self.location.origin);
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: "PROACTIVE_MESSAGE", id: event.notification.data?.id || "" });
      return;
    }
    await self.clients.openWindow(targetUrl);
  })());
});
