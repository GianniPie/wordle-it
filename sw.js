// Keeps a copy of the app on the device so it opens and can be played without network.
// Pages and app files: the copy first (the app opens at once even with a weak network), updated in the
// background, so a new version arrives at the opening after it is published.
// Libraries from the CDNs: the copy first (their addresses don't change), downloaded once.
// Supabase data is never handled here: the pages keep their own last data.
const CACHE = "parle-v7";
const APP_FILES = [
  "./",
  "index.html",
  "wordle-it.js",
  "manifest.json",
  "images/parle_logo.svg",
  "images/parle_logo_32x32.png",
  "images/parle_logo_192x192.png",
  "classifica/",
  "classifica/index.html",
  "classifica/app.js",
  "classifica/style.css",
  "classifica/db.js",
  "classifica/sync.js",
  "classifica/vendor/supabase.js",
];
const LIBRARIES = [
  "https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/Sortable/1.15.2/Sortable.min.js",
];
const CDN_HOSTS = ["cdn.jsdelivr.net", "cdnjs.cloudflare.com"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(APP_FILES);
      // Libraries are useful but not essential to install: a failure here doesn't block the app.
      await Promise.allSettled(LIBRARIES.map((url) => cache.add(url)));
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((res) => {
            if (res.ok) caches.open(CACHE).then((c) => c.put(request, res.clone()));
            return res;
          })
      )
    );
    return;
  }

  if (url.origin !== self.location.origin) return; // Supabase, Wiktionary, analytics: not cached

  // The copy on the device first, so the app opens at once even with a weak network; the new version is
  // downloaded in the background and used from the next opening. Pages like classifica/?account use the
  // copy of classifica/. Without a copy yet: the network.
  // A page is kept once, without its ?…, so every address of it opens the latest copy.
  const key = request.mode === "navigate" ? url.origin + url.pathname : request;
  const update = fetch(request).then((res) => {
    if (res.ok && !res.redirected) {
      const copy = res.clone();
      event.waitUntil(caches.open(CACHE).then((c) => c.put(key, copy)));
    }
    return res;
  });
  event.waitUntil(update.catch(() => {}));
  event.respondWith(caches.match(key).then((hit) => hit || update));
});
