// Personal Organizer — service worker.
//
// Deliberately conservative. Its job is to make the app installable and to
// let the shell open when offline. It must NEVER serve cached API data:
// this app already had a hard-to-spot bug where one device showed stale
// data and then saved it back over newer data. A caching service worker
// would reintroduce exactly that, so /api/* always goes to the network.

const CACHE = 'organizer-shell-v11';
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

// ── Web push ──────────────────────────────────────────────
// Shows a notification even when the app is closed. Wrapped defensively:
// a malformed payload must still produce *something*, otherwise the
// browser falls back to a generic "site updated in the background"
// message, which is worse than a plain title.
self.addEventListener('push', event => {
  let title = 'Personal Organizer';
  let body = '';
  let data = {};
  try {
    if (event.data) {
      const p = event.data.json();
      title = p.title || title;
      body = p.body || '';
      data = p.data || {};
    }
  } catch (e) {
    try { body = event.data ? event.data.text() : ''; } catch (e2) {}
  }
  event.waitUntil((async () => {
    await self.registration.showNotification(title, {
      body,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag || 'organizer',
      renotify: true,
      data
    });
    // App-icon badge (the dot/number like WhatsApp). Counts unread pushes
    // and is cleared when the app is next opened. Not supported
    // everywhere, so failure is ignored rather than breaking the
    // notification itself.
    try {
      const cache = await caches.open('organizer-badge');
      const prev = await cache.match('count');
      const n = prev ? (parseInt(await prev.text()) || 0) + 1 : 1;
      await cache.put('count', new Response(String(n)));
      if (self.navigator && self.navigator.setAppBadge) await self.navigator.setAppBadge(n);
    } catch (e) {}
  })());
});

// The page asks for the badge to be cleared once it's been seen.
self.addEventListener('message', event => {
  // Triggered by the "Check for updates" button. Without this a freshly
  // installed worker stays in "waiting" until every tab is closed, which
  // on a phone can mean days.
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }
  if (event.data && event.data.type === 'CLEAR_BADGE') {
    event.waitUntil((async () => {
      try {
        const cache = await caches.open('organizer-badge');
        await cache.put('count', new Response('0'));
        if (self.navigator && self.navigator.clearAppBadge) await self.navigator.clearAppBadge();
      } catch (e) {}
    })());
  }
});

// Tapping a notification focuses an existing window rather than piling up
// new tabs each time.
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL('/', self.location.origin).href;
  event.waitUntil((async () => {
    const list = await clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Prefer an existing window belonging to this app. On iOS the installed
    // PWA often isn't returned as a focusable client, in which case the tap
    // appeared to do nothing — the notification simply vanished. Falling
    // through to openWindow fixes that.
    for (const c of list) {
      if (c.url && c.url.startsWith(self.location.origin)) {
        if ('focus' in c) {
          try {
            if ('navigate' in c && c.url !== target) await c.navigate(target);
          } catch (e) {}
          return c.focus();
        }
      }
    }
    if (clients.openWindow) return clients.openWindow(target);
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // The icon font and stylesheet come from a CDN. Cache them (cache-first,
  // they're versioned and never change) so the app still looks right
  // offline instead of losing every icon.
  if (url.hostname === 'cdn.jsdelivr.net') {
    event.respondWith(
      caches.open(CACHE).then(async c => {
        const hit = await c.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && (res.ok || res.type === 'opaque')) c.put(req, res.clone()).catch(()=>{});
          return res;
        } catch (e) { return hit || Response.error(); }
      })
    );
    return;
  }

  // Anything else from another origin: straight to network.
  if (url.origin !== self.location.origin) return;

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
