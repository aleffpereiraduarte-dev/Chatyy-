// Chatyy Service Worker v6 — bump triggers cache wipe + fresh asset refetch.
// Previous v5 on Chrome was holding stale bundles + cached API responses
// that showed empty inbox after the auth fix landed.
const CACHE_NAME = 'chatyy-v6';
const API_CACHE = 'chatyy-api-v3';
const APP_SHELL = ['/', '/index.html', '/manifest.json', '/favicon.ico'];

const offlineJson = () => new Response(
  JSON.stringify({ success: false, message: 'Offline', offline: true }),
  { headers: { 'Content-Type': 'application/json' } }
);
const errorResponse = (status = 504, text = 'Network unavailable') =>
  new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const url of APP_SHELL) { try { await cache.add(url); } catch {} }
      try {
        const r = await fetch('/');
        const html = await r.text();
        const js = html.match(/\/_expo\/static\/js\/web\/[^"]+/g) || [];
        for (const f of js) { try { await cache.add(f); } catch {} }
      } catch {}
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((k) => Promise.all(k.filter(n => n !== CACHE_NAME && n !== API_CACHE).map(n => caches.delete(n))))
    .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  // Only handle our own origin — cross-origin requests (CDN media, analytics,
  // etc.) stay untouched so the browser's default handling wins.
  let url;
  try { url = new URL(e.request.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  if (e.request.method !== 'GET') return;

  // Bypass media blobs and anything that isn't cache-safe.
  if (
    url.pathname.match(/\.(mp4|webm|mov|avi|mp3|wav|ogg|m4a|aac)$/i) ||
    url.pathname.includes('/feed-files/') ||
    url.pathname.includes('/chat-files/') ||
    url.pathname.includes('/data/') ||
    url.pathname === '/health'
  ) {
    return;
  }

  if (url.pathname.startsWith('/api/')) {
    e.respondWith((async () => {
      try {
        const r = await fetch(e.request);
        if (r && r.ok) {
          try { const c = r.clone(); caches.open(API_CACHE).then((cache) => cache.put(e.request, c)); } catch {}
        }
        return r;
      } catch {
        const cached = await caches.match(e.request);
        return cached || offlineJson();
      }
    })());
    return;
  }

  if (url.pathname.startsWith('/_expo/') || url.pathname.match(/\.(js|css|png|jpg|jpeg|webp|gif|svg|woff2?)$/)) {
    e.respondWith((async () => {
      const cached = await caches.match(e.request);
      if (cached) return cached;
      try {
        const r = await fetch(e.request);
        if (r && r.ok) {
          try { const cl = r.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(e.request, cl)); } catch {}
        }
        return r;
      } catch {
        return errorResponse();
      }
    })());
    return;
  }

  if (e.request.headers.get('accept')?.includes('text/html')) {
    e.respondWith((async () => {
      try {
        const r = await fetch(e.request);
        if (r && r.ok) {
          try { const c = r.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(e.request, c)); } catch {}
        }
        return r;
      } catch {
        const cached = await caches.match(e.request);
        if (cached) return cached;
        const shell = await caches.match('/index.html');
        return shell || errorResponse(503, 'Offline');
      }
    })());
    return;
  }

  e.respondWith((async () => {
    try {
      return await fetch(e.request);
    } catch {
      const cached = await caches.match(e.request);
      return cached || errorResponse();
    }
  })());
});
