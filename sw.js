const CACHE = 'ba-v6';
const SHELL = [
  './index.html',
  './css/main.css',
  './css/components.css',
  './js/config.js',
  './js/router.js',
  './js/auth.js',
  './js/sheets.js',
  './js/home.js',
  './js/ledger.js',
  './js/add.js',
  './js/scan.js',
  './js/pending.js',
  './js/stats.js',
  './js/settings.js',
  './js/app.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// App shell + network-first for Google APIs
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Google Sheets API → network only（不快取）
  if (url.hostname.includes('googleapis.com') || url.hostname.includes('accounts.google.com')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // App shell → cache first, fallback to network
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
