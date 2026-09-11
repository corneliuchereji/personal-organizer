// Personal Organizer — service worker.
//
// Deliberately conservative. Its job is to make the app installable and to
// let the shell open when offline. It must NEVER serve cached API data:
// this app already had a hard-to-spot bug where one device showed stale
// data and then saved it back over newer data. A caching service worker
// would reintroduce exactly that, so /api/* always goes to the network.

const CACHE = 'organizer-shell-v1';
const SHELL = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(c => c.addAll(SHELL).catch(() => {})) // a missing file must not block install
      .then(() => self.skipWaiting())
  );
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
  const url = new URL(req.url);

  // Anything that isn't a plain GET of our own origin: straight to network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;

  // API traffic is never cached, never intercepted — freshness matters far
  // more than offline access for tasks, fixtures and settings.
  if (url.pathname.startsWith('/api/')) return;

  // Shell assets: network first (so a deploy is picked up immediately),
  // falling back to cache only when genuinely offline.
  event.respondWith(
    fetch(req)
      .then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then(hit => hit || caches.match('/')))
  );
});
