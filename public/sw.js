// Chatyy Service Worker v7 — adds web push + notification click + background sync.
// v6 had install/fetch already (app shell + static + API). Bump = forced refresh
// para users pegarem o novo handler.
const CACHE_NAME = 'chatyy-v7';
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

// ─── Web Push (FCM) ──────────────────────────────────────────────────
// Recebe push do FCM e mostra notification mesmo com app fechado.
// Click → abre/foca o app na conv certa.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data?.json() || {}; } catch { try { data = { body: e.data?.text() }; } catch {} }
  const title = data.title || data.notification?.title || 'Chatyy';
  const body  = data.body  || data.notification?.body  || '';
  const tag   = data.tag   || data.notification?.tag   || data.data?.conversation_id || 'chatyy';
  const icon  = data.icon  || '/favicon.ico';
  const badge = data.badge || '/favicon.ico';
  const conv  = data.data?.conversation_id || data.conversation_id || '';
  const url   = conv ? '/chat-conversation?conversation_id=' + encodeURIComponent(conv) : '/chat';
  const opts = {
    body, tag, icon, badge,
    data: { url, ...(data.data || {}) },
    renotify: true,
    requireInteraction: false,
    silent: false,
  };
  e.waitUntil(self.registration.showNotification(title, opts));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || '/chat';
  e.waitUntil((async () => {
    const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of allClients) {
      // If a Chatyy tab already open on same origin, focus + nav it.
      try {
        const cu = new URL(c.url);
        if (cu.origin === self.location.origin) {
          await c.focus();
          if ('navigate' in c) try { await c.navigate(url); } catch {}
          return;
        }
      } catch {}
    }
    // No tab open → open new one.
    try { await self.clients.openWindow(url); } catch {}
  })());
});

// ─── Background sync ─────────────────────────────────────────────────
// Quando o user envia msg offline, o app pede sync.register('chat-outbox').
// Ao voltar online, browser dispara este event → drainamos a outbox.
self.addEventListener('sync', (e) => {
  if (e.tag === 'chat-outbox') {
    e.waitUntil((async () => {
      try {
        // Notifica clients that they should drain the outbox now.
        const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const c of clients) {
          try { c.postMessage({ type: 'sw_drain_outbox' }); } catch {}
        }
      } catch {}
    })());
  }
});

// Allow page to skip waiting via postMessage (used by an in-app "update available" toast).
self.addEventListener('message', (e) => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
