// Service worker: cache the app shell so it loads offline and installs as a PWA.
// Bump CACHE when any cached asset changes to force an update.
const CACHE = 'vibe-convolver-v2';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './version.json',
  './src/styles.css',
  './src/app.js',
  './src/worker.js',
  './src/dsp/index.js',
  './src/dsp/fft.js',
  './src/dsp/wav.js',
  './src/dsp/convolve.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      // Tolerate any single missing asset so install never wholesale-fails.
      .then((c) => Promise.all(ASSETS.map((a) => c.add(a).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Stale-while-revalidate for same-origin GETs: serve from cache immediately
// (fast, works offline) while fetching a fresh copy in the background. This is
// what lets a new deploy actually propagate — the version footer flips to the
// new build on the next reload instead of being pinned to a stale cache.
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    const network = fetch(req).then((res) => {
      if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
      return res;
    }).catch(() => null);
    return cached || (await network) || new Response('', { status: 504 });
  })());
});
