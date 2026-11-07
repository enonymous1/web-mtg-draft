// Offline shell for MTG Draft. Card data and images still come from
// Scryfall at runtime; only the app shell is cached here.
const CACHE = "mtg-draft-v2";
const SHELL = [
  "index.html",
  "styles.css",
  "app.js",
  "logic.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "assets/vendor/bootstrap.min.css",
  "assets/vendor/bootstrap-icons.min.css",
  "assets/vendor/adminlte.min.css",
  "assets/vendor/bootstrap.bundle.min.js",
  "assets/vendor/adminlte.min.js",
  "assets/vendor/fonts/bootstrap-icons.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // Never cache Scryfall: the app already caches pools in localStorage
  // for 24 hours, and the API asks clients not to over-fetch.
  if (url.hostname.includes("scryfall")) return;
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request)),
  );
});
