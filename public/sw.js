// Lexterra service worker: app shell caching (installable/offline-friendly) and push notifications.
// Pages are fetched network-first so players always get the latest version when online.

const CACHE = "lexterra-v4";
const SHELL = ["/", "/words.js", "/botwords.js", "/js/daily.js", "/js/tutorial.js", "/js/ui.js", "/js/botai.js", "/js/vendor/partysocket/index.js", "/js/vendor/partysocket/ws.js", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return; // never touch API or CDN calls
  const big = url.pathname === "/words.js" || url.pathname === "/botwords.js";
  if (big) {
    // Dictionaries rarely change: serve cached instantly, refresh in the background
    event.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(req);
      const fresh = fetch(req).then((res) => { if (res.ok) c.put(req, res.clone()); return res; }).catch(() => hit);
      return hit ?? fresh;
    }));
    return;
  }
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && url.search === "") caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(async () => (await caches.match(req)) ?? (req.mode === "navigate" ? caches.match("/") : Response.error()))
  );
});

// Notification links may only open pages on this site
function sameOrigin(u) {
  try {
    const url = new URL(typeof u === "string" ? u : "/", self.location.origin);
    return url.origin === self.location.origin ? url.pathname + url.search : "/";
  } catch { return "/"; }
}

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data?.text() }; }
  const title = typeof data.title === "string" ? data.title : "Lexterra";
  event.waitUntil(self.registration.showNotification(title, {
    body: typeof data.body === "string" ? data.body : "",
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    tag: typeof data.tag === "string" ? data.tag : undefined,
    renotify: true,
    data: { url: sameOrigin(data.url) },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url ?? "/", self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) { await w.focus(); return w.navigate(target); }
    }
    return self.clients.openWindow(target);
  })());
});
