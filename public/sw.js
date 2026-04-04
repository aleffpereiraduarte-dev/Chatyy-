// Chatyy Service Worker v2 — Offline-First
const CACHE_NAME = 'chatyy-v2';
const API_CACHE = 'chatyy-api-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.json', '/favicon.ico'];

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
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Skip caching for large media files (videos, audio) — causes ERR_CACHE_OPERATION_NOT_SUPPORTED
  if (url.pathname.match(/\.(mp4|webm|mov|avi|mp3|wav|ogg|m4a|aac)$/i) || url.pathname.includes('/feed-files/') || url.pathname.includes('/chat-files/')) {
    return; // Let browser handle directly, no SW interception
  }
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).then((r) => {
        if (r.ok) { const c = r.clone(); caches.open(API_CACHE).then((cache) => cache.put(e.request, c)); }
        return r;
      }).catch(() => caches.match(e.request).then((c) => c || new Response(JSON.stringify({success:false,message:'Offline',offline:true}), {headers:{'Content-Type':'application/json'}})))
    );
    return;
  }
  if (url.pathname.startsWith('/_expo/') || url.pathname.match(/\.(js|css|png|jpg|jpeg|webp|gif|svg|woff2?)$/)) {
    e.respondWith(
      caches.match(e.request).then((c) => {
        if (c) return c;
        return fetch(e.request).then((r) => { if (r.ok) { const cl = r.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(e.request, cl)); } return r; });
      })
    );
    return;
  }
  if (e.request.headers.get('accept')?.includes('text/html')) {
    e.respondWith(
      fetch(e.request).then((r) => { if (r.ok) { const c = r.clone(); caches.open(CACHE_NAME).then((cache) => cache.put(e.request, c)); } return r; })
      .catch(() => caches.match(e.request).then((c) => c || caches.match('/index.html')))
    );
    return;
  }
  e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
});
