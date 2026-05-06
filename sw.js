const CACHE = 'ba-v44';
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

// Network-first：先從網路拿，失敗才用快取
// 好處：更新後自動生效，不需手動清快取
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // Google API → network only（不快取）
  if (
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('accounts.google.com') ||
    url.hostname.includes('workers.dev')
  ) {
    e.respondWith(fetch(e.request));
    return;
  }

  // App shell → network first, fallback to cache
  e.respondWith(
    fetch(e.request)
      .then(res => {
        // 成功則同步更新快取
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
