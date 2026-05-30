const CACHE_NAME = "polysoko-shell-v1";
const SHELL_ASSETS = [
    "./",
    "./index.html",
    "./login.html",
    "./style.css",
    "./api.js",
    "./ui.js",
    "./app.js",
    "./pwa.js",
    "./site.webmanifest",
    "./logo-mark.png",
    "./favicon.png",
    "./icon-192.png",
    "./icon-512.png"
];

self.addEventListener("install", (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(SHELL_ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener("activate", (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    if (request.method !== "GET") return;

    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/uploads/") || url.pathname.includes("/socket.io/")) {
        return;
    }

    if (request.mode === "navigate") {
        event.respondWith(
            fetch(request).catch(() => caches.match("./index.html"))
        );
        return;
    }

    event.respondWith(
        caches.match(request).then((cached) => cached || fetch(request).then((response) => {
            if (!response || response.status !== 200 || response.type === "opaque") return response;
            const copy = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            return response;
        }))
    );
});
