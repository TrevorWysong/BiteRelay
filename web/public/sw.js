// Minimal, hand-rolled service worker -- deliberately not a full Workbox/
// vite-plugin-pwa setup, matching this project's existing dependency-light
// approach. Only registered in production builds (see main.tsx) -- running
// it under `vite dev` would intercept and stale-cache the dev server's own
// module graph, a well-known footgun.
//
// This app is fundamentally live/p2p: every screen either polls a real
// conductor or listens for a signal. A cached response is actively wrong
// for anything that touches it, so this SW only caches the *static app
// shell* (enough to satisfy PWA installability and let the app shell
// render offline), never zome-call data -- and there's nothing to
// accidentally cache wrong here anyway, since zome calls go over a
// WebSocket, which fetch/service-worker interception never sees.
const CACHE_NAME = "relay-shell-v1";
const APP_SHELL = ["/", "/index.html", "/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Network-first, falling back to the cached shell only when genuinely
// offline -- never serve a stale shell over a working connection.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached ?? caches.match("/index.html"))),
  );
});
