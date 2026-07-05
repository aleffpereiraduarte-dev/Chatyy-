// Chatyy Service Worker v9 — offline-first PWA.
//
// Strategies:
//   - App shell (/, /index.html, /manifest.json, /favicon.ico) → precached
//     on install + cache fallback at runtime so offline boot works.
//   - Static assets under /_expo/static + .js/.css/.woff2/.png/etc on the
//     same origin → stale-while-revalidate. Serves cached copy instantly,
//     fetches fresh in background. v8 was pure cache-first which meant
//     deployed JS updates only landed after CACHE_NAME bump; SWR catches
//     them on the second visit after deploy.
//   - HTML navigations → network-first with index.html fallback (SPA
//     routing means deep links must boot from the shell when offline).
//   - /api/chat.php?action=chat_list|chat_messages|chat_messages_list →
//     stale-while-revalidate (5 min TTL on the cached copy); reload-tab
//     paints from cache, fresh data lands for next visit.
//   - /api/ (everything else) → network-first; idempotent GETs fall back
//     to cached response if the network fails; non-GET never cached.
//   - media.chatyy.com.br (cross-origin CDN) → cache-first with TTL: 24h
//     for avatars, 7d for chat-files/feed-files/status thumbs. Other
//     origins are untouched (browser default).
//   - Real-time stuff (WS, /health, /data/, raw mp4/mp3) → bypassed.
//
// Bumping CACHE_NAME triggers the activate handler's eviction so old SW
// users pick up the new code on their next visit. v8 → v9: added SWR,
// LRU caps, media-CDN cache, navigation preload, NUKE_CACHES message.
// v9 → v10: added stale-while-revalidate on idempotent chat-read API
// endpoints (chat_list / chat_messages) so reload-tab paints from the
// SW cache while the network refresh happens in the background. Cuts
// the visible round-trip on cold tab open from ~150 ms to ~5 ms.
// v11 → v12: NUKE_CACHES (logout) now hard-evicts API_CACHE /api/* entries
// + a `_nuking` flag blocks the SWR branch mid-nuke so a new user on the
// same browser can't see the previous user's cached chat_list. activate
// now claims clients BEFORE cache eviction. CACHE_NAME bumped so this
// deploy's activate clears the prior generation.

const CACHE_NAME  = 'chatyy-v23';
const API_CACHE   = 'chatyy-api-v4';
const MEDIA_CACHE = 'chatyy-media-v1';

// Set true while a NUKE_CACHES (logout / account switch) is in flight so the
// SWR branch refuses to serve a cached API response mid-nuke — otherwise a
// reload that races the nuke could paint the previous user's chat_list from
// a cache slot that's about to be deleted. See MEMORY.md
// "Login deve nukar cache (2026-05-11)".
let _nuking = false;

// Chat-read endpoints eligible for stale-while-revalidate. The cached
// response paints instantly; a background fetch updates the cache for
// the next visit. The page enforces freshness via WS push + the normal
// merge path, so even a 5-minute stale read is corrected within seconds.
// Only LIST endpoints (purely idempotent reads) are eligible; mutations
// and per-message GETs stay on the network-first branch.
const SWR_CHAT_ACTIONS = new Set([
  'chat_messages',          // PHP path
  'chat_messages_list',     // legacy alias kept for older clients
  'chat_list',              // conversation list
]);
const SWR_CHAT_TTL_MS = 5 * 60 * 1000;

// Cap entries per cache so a long-lived install doesn't fill the user's
// disk. Browsers evict CacheStorage under pressure but only at quota
// exhaustion, which can mean GBs before they kick in. Trim proactively.
const CACHE_LIMITS = {
  [CACHE_NAME]:  120,  // app shell + JS/CSS/font/img
  [API_CACHE]:    40,  // last N API GETs
  [MEDIA_CACHE]: 200,  // avatars + thumbnails
};

// Cross-origin CDN we own. Cache aggressively; everything else stays uncached.
const MEDIA_HOSTS = new Set(['media.chatyy.com.br']);

const APP_SHELL = ['/', '/index.html', '/manifest.json', '/favicon.ico'];

const offlineJson = () => new Response(
  JSON.stringify({ success: false, message: 'Offline', offline: true }),
  { headers: { 'Content-Type': 'application/json' } }
);
const errorResponse = (status = 504, text = 'Network unavailable') =>
  new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });

// ─── LRU eviction ────────────────────────────────────────────────────
// Cache API has no built-in LRU. Approximate by trimming oldest entries
// (insertion order is preserved on `cache.keys()`) once over cap.
async function trimCache(cacheName, limit) {
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length <= limit) return;
    // Never evict the app shell — without it the offline navigation branch
    // (caches.match('/index.html') || caches.match('/')) misses and boot
    // white-screens. The shell is inserted at install so it is the OLDEST
    // entry and would otherwise be the first thing trimmed.
    const isShell = (req) => {
      try { return APP_SHELL.includes(new URL(req.url).pathname); }
      catch { return false; }
    };
    const evictable = (cacheName === CACHE_NAME)
      ? keys.filter((req) => !isShell(req))
      : keys;
    // Recompute excess against the total, but only delete from evictable.
    const excess = keys.length - limit;
    for (let i = 0; i < excess && i < evictable.length; i++) {
      try { await cache.delete(evictable[i]); } catch {}
    }
  } catch {}
}

async function cachePut(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
    const limit = CACHE_LIMITS[cacheName];
    if (limit) trimCache(cacheName, limit);
  } catch {}
}

// ─── TTL helper for cross-origin media ───────────────────────────────
// Cache API doesn't natively support TTL. Tag responses with `sw-cached-at`
// header so we can decide at read time whether to revalidate.
function withTimestamp(response) {
  try {
    const headers = new Headers(response.headers);
    headers.set('sw-cached-at', String(Date.now()));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch {
    return response;
  }
}

function isExpired(response, ttlMs) {
  try {
    const ts = parseInt(response.headers.get('sw-cached-at') || '0', 10);
    if (!ts) return false; // legacy entry — keep until natural eviction
    return (Date.now() - ts) > ttlMs;
  } catch {
    return false;
  }
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const url of APP_SHELL) { try { await cache.add(url); } catch {} }
      // Best-effort: extract the JS bundle hashes from the shell HTML so the
      // first offline boot after install doesn't 404 on the bundle.
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
  e.waitUntil((async () => {
    // Take control of open clients BEFORE cleanup so the new SW is the one
    // serving requests during eviction (avoids the old SW handing out stale
    // entries we're about to delete).
    try { await self.clients.claim(); } catch {}
    // Drop any cache whose name isn't in our current generation. The explicit
    // keep-set handles our three known stores; the chatyy-* prefix sweep is
    // defensive so a stale install with an unexpected `chatyy-*` cache name
    // (e.g. a future-renamed store left behind by a half-applied deploy)
    // self-heals instead of lingering forever.
    const keep = new Set([CACHE_NAME, API_CACHE, MEDIA_CACHE]);
    const names = await caches.keys();
    await Promise.all(
      names.filter(n => !keep.has(n)).map(n => caches.delete(n))
    );
    // Enable navigation preload so the browser can start the HTML fetch in
    // parallel with the SW boot, shaving a round-trip on cold navigations.
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.enable(); } catch {}
    }
  })());
});

self.addEventListener('fetch', (e) => {
  let url;
  try { url = new URL(e.request.url); } catch { return; }
  if (e.request.method !== 'GET') return;

  // ── Cross-origin: cache media CDN only, ignore everything else ──
  if (url.origin !== self.location.origin) {
    if (MEDIA_HOSTS.has(url.host)) {
      // Avatars get a shorter TTL (might change when user updates pic) than
      // chat-files/status thumbs (content-addressed, effectively immutable).
      const isAvatar = /\/avatars?\//i.test(url.pathname);
      const ttlMs = isAvatar ? 24 * 3600 * 1000 : 7 * 24 * 3600 * 1000;
      e.respondWith((async () => {
        const cached = await caches.match(e.request, { cacheName: MEDIA_CACHE });
        if (cached && !isExpired(cached, ttlMs)) return cached;
        try {
          const r = await fetch(e.request);
          if (r && r.ok) {
            cachePut(MEDIA_CACHE, e.request, withTimestamp(r.clone()));
          }
          return r;
        } catch {
          // Expired but still cached → better stale than broken.
          return cached || errorResponse();
        }
      })());
    }
    return; // other cross-origin: browser default
  }

  // ── Bypass: real-time, user data, raw media blobs ──
  if (
    url.pathname.match(/\.(mp4|webm|mov|avi|mp3|wav|ogg|m4a|aac)$/i) ||
    url.pathname.includes('/feed-files/') ||
    url.pathname.includes('/chat-files/') ||
    url.pathname.includes('/data/') ||
    url.pathname === '/health' ||
    url.pathname.startsWith('/ws')
  ) {
    return;
  }

  // ── API: chat-list reads SWR; everything else network-first ──
  if (url.pathname.startsWith('/api/')) {
    // Stale-while-revalidate for chat read endpoints. Keyed by the full
    // URL (includes ?action=&conversation_id=&since_id= etc.) so each
    // conversation + offset gets its own cache slot. Tag responses with
    // a `sw-cached-at` header so we can detect "too stale to serve" and
    // wait for the network instead of returning a hour-old payload.
    const action = url.searchParams.get('action');
    if (action && SWR_CHAT_ACTIONS.has(action) && url.pathname.endsWith('/api/chat.php')) {
      e.respondWith((async () => {
        // Mid-nuke (logout / account switch): never serve from API_CACHE, the
        // cached payload may belong to the user we're logging out. Go straight
        // to network so the new user only ever sees their own data.
        if (_nuking) {
          try { return await fetch(e.request); } catch { return offlineJson(); }
        }
        const cached = await caches.match(e.request, { cacheName: API_CACHE });
        const network = fetch(e.request).then((r) => {
          if (r && r.ok) {
            // Stamp + cache. Stamp survives because we re-wrap the body.
            cachePut(API_CACHE, e.request, withTimestamp(r.clone()));
          }
          return r;
        }).catch(() => null);
        // If we have a fresh-enough cached copy, return it and let the
        // network update in the background. "Fresh enough" = within
        // SWR_CHAT_TTL_MS. Beyond that, prefer the network so we don't
        // ship a really old chat list on the first paint of a long-
        // backgrounded tab. If the network ALSO fails, fall back to the
        // stale cache rather than show offline.
        if (cached && !isExpired(cached, SWR_CHAT_TTL_MS)) {
          network.catch(() => {});
          return cached;
        }
        const r = await network;
        if (r) return r;
        return cached || offlineJson();
      })());
      return;
    }

    // Default API path — network-first, fall back to last good cached response.
    e.respondWith((async () => {
      try {
        const r = await fetch(e.request);
        if (r && r.ok) cachePut(API_CACHE, e.request, r.clone());
        return r;
      } catch {
        const cached = await caches.match(e.request, { cacheName: API_CACHE });
        return cached || offlineJson();
      }
    })());
    return;
  }

  // ── Static assets: stale-while-revalidate ──
  if (url.pathname.startsWith('/_expo/') || url.pathname.match(/\.(js|css|png|jpg|jpeg|webp|gif|svg|woff2?|ico)$/i)) {
    e.respondWith((async () => {
      const cached = await caches.match(e.request, { cacheName: CACHE_NAME });
      const network = fetch(e.request).then((r) => {
        if (r && r.ok) cachePut(CACHE_NAME, e.request, r.clone());
        return r;
      }).catch(() => null);
      if (cached) {
        // Fire-and-forget revalidate so the next visit gets fresh bytes.
        network.catch(() => {});
        return cached;
      }
      const r = await network;
      return r || errorResponse();
    })());
    return;
  }

  // ── HTML navigations: network-first, fall back to shell for SPA routing ──
  const isNav = e.request.mode === 'navigate' ||
                (e.request.headers.get('accept') || '').includes('text/html');
  if (isNav) {
    e.respondWith((async () => {
      try {
        // Use preloaded response if navigation preload is on.
        const preload = await e.preloadResponse;
        if (preload) {
          if (preload.ok) cachePut(CACHE_NAME, e.request, preload.clone());
          return preload;
        }
        const r = await fetch(e.request);
        if (r && r.ok) cachePut(CACHE_NAME, e.request, r.clone());
        return r;
      } catch {
        // Try exact match first (cached e.g. when offline mid-session); then
        // fall back to the app shell so deep links boot the SPA which then
        // hydrates from local storage.
        const exact = await caches.match(e.request, { cacheName: CACHE_NAME });
        if (exact) return exact;
        const shell = await caches.match('/index.html', { cacheName: CACHE_NAME }) ||
                      await caches.match('/', { cacheName: CACHE_NAME });
        return shell || errorResponse(503, 'Offline');
      }
    })());
    return;
  }

  // ── Default: network with cache fallback ──
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
  const url   = conv ? '/chat-conversation?id=' + encodeURIComponent(conv) : '/chat';
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
  // Page can ask SW to nuke all caches (logout / account switch). Without
  // this the next user sees a flash of the previous user's data restored
  // from the API cache before their own response lands. See MEMORY.md
  // "Login deve nukar cache (2026-05-11)".
  if (e.data?.type === 'NUKE_CACHES') {
    e.waitUntil((async () => {
      // Block the SWR branch from serving any cached API response while the
      // nuke is in flight. Without this, a reload racing the nuke could paint
      // the previous user's chat_list from a cache slot mid-delete.
      _nuking = true;
      try {
        // Delete EVERY cache store (CACHE_NAME, API_CACHE, MEDIA_CACHE, and
        // any stragglers). This evicts all /api/* entries from API_CACHE so
        // a new user on the same browser can't get the previous user's
        // cached chat_list via the SWR path.
        const names = await caches.keys();
        await Promise.all(names.map(n => caches.delete(n)));
        // Belt-and-suspenders: API_CACHE may have been re-created by an
        // in-flight cachePut between keys() and delete(). Sweep its /api/*
        // entries explicitly so nothing user-scoped survives the nuke.
        try {
          const apiCache = await caches.open(API_CACHE);
          const reqs = await apiCache.keys();
          await Promise.all(
            reqs
              .filter(r => { try { return new URL(r.url).pathname.startsWith('/api/'); } catch { return true; } })
              .map(r => apiCache.delete(r))
          );
          await caches.delete(API_CACHE);
        } catch {}
      } catch {}
      finally { _nuking = false; }
    })());
  }
});
