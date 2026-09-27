// Offline shell for the PWA. Network-first so users always get the latest
// pages and data; the cache is only a fallback when the network is down.
// Bump CACHE whenever SHELL changes — old caches are deleted on activate.
const CACHE = 'bat-shell-v2';
const SHELL = ['/', '/index.html', '/dashboard.html', '/report.html', '/emergency.html', '/civic.html', '/css/main.css', '/css/dashboard.css', '/css/sidebar.css', '/js/bat-config.js', '/js/sidebar.js', '/js/i18n.js', '/js/pwa.js', '/logo.png', '/logo-mark.png'];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // Live data, auth and streams always go straight to the network.
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (req.headers.get('accept')?.includes('text/event-stream')) return;

  event.respondWith(
    fetch(req)
      .then(response => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(req, copy));
        }
        return response;
      })
      .catch(() => caches.match(req).then(cached => cached || (req.mode === 'navigate' ? caches.match('/index.html') : Response.error())))
  );
});
