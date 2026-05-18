import { Platform } from 'react-native';

const CACHE_DIR = 'chat-media-cache';
const PERMANENT_DIR = 'chat-media-saved'; // Permanent storage (not cleared by OS)
// Default cap when the user hasn't picked one. WhatsApp ships uncapped on
// iOS (the OS sandbox is the only limit) and a soft 5GB on Android. We pick
// a conservative 500MB default so accounts with no explicit pref still get
// the LRU sweep — heavier users bump via setMediaCacheCapMb (1GB / 5GB /
// 10GB / Infinity for "unlimited").
const MAX_CACHE_MB_DEFAULT = 500;
// 0 (or any non-positive number) is the sentinel for "unlimited" — skip the
// LRU sweep entirely. Capped above (~64GB) so a typo doesn't blow the math.
const MAX_CACHE_MB_CEILING = 64 * 1024;
let FileSystem = null;

// ── Sync in-memory index: url → local file:// path ─────────────────────
// Populated from MMKV at module-load (instant, survives restarts) + a
// post-splash disk scan that adds anything not yet recorded. Lets
// resolveMediaUri() return file:// synchronously on first paint — no more
// re-downloads after the image was already saved in a previous session.
const syncIndex = new Map();        // filenameKey → local absolute path
let syncInitPromise = null;          // dedupe concurrent init calls
const INDEX_MMKV_KEY = 'media_sync_index_v1';
let _pendingPersist = null;
// Returns true if any entries were loaded.
function _loadIndexFromMmkv() {
  if (Platform.OS === 'web') return false;
  try {
    const mmkv = require('./mmkv');
    const raw = mmkv.getString?.(INDEX_MMKV_KEY);
    if (!raw) return false;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      let n = 0;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') { syncIndex.set(k, v); n++; }
      }
      return n > 0;
    }
  } catch {}
  return false;
}
// The MMKV layer fills its in-memory map asynchronously at splash. If we
// hit it at module-load we get empty; retry once the cache is ready so the
// index is populated before the user navigates into a chat.
// Resolves once `syncIndex` has been refreshed against the actual disk
// state. After install or app update iOS may change the sandbox UUID, so
// the absolute paths persisted in MMKV from a previous launch can be
// stale. `waitForSyncIndexReady` does the disk scan FIRST, overrides any
// stale MMKV entries with current absolute paths, and only then resolves
// — eliminating the "first cold start re-downloads everything" symptom
// the user kept hitting after kill-and-reopen.
let _syncIndexFullPromise = null;
export function waitForSyncIndexReady() {
  if (_syncIndexFullPromise) return _syncIndexFullPromise;
  _syncIndexFullPromise = (async () => {
    if (Platform.OS === 'web') return;
    await _hydrateIndexWhenReady();
    try { await initSyncCache(); } catch {}
  })();
  return _syncIndexFullPromise;
}

async function _hydrateIndexWhenReady() {
  if (Platform.OS === 'web') return;
  if (_loadIndexFromMmkv()) return; // hot start
  try {
    const mmkv = require('./mmkv');
    if (mmkv.waitForCacheReady) {
      await mmkv.waitForCacheReady();
      _loadIndexFromMmkv();
    }
  } catch {}
}
function _schedulePersistIndex() {
  if (Platform.OS === 'web') return;
  if (_pendingPersist) return;
  _pendingPersist = setTimeout(() => {
    _pendingPersist = null;
    try {
      const mmkv = require('./mmkv');
      const obj = {};
      for (const [k, v] of syncIndex.entries()) obj[k] = v;
      mmkv.setString?.(INDEX_MMKV_KEY, JSON.stringify(obj));
    } catch {}
  }, 2000);
}
// Warm the in-memory index from MMKV. First try synchronously (hot start);
// if empty, retry once MMKV's in-mem layer finishes loading from AsyncStorage.
_hydrateIndexWhenReady();

// Lazy load expo-file-system (only on native)
function getFS() {
  if (Platform.OS === 'web') return null;
  if (!FileSystem) {
    try { FileSystem = require('expo-file-system'); } catch { return null; }
  }
  return FileSystem;
}

function getCacheDir() {
  const fs = getFS();
  if (!fs) return null;
  return fs.cacheDirectory + CACHE_DIR + '/';
}

// Permanent directory for saved media (survives OS cache cleanup)
function getSavedDir() {
  const fs = getFS();
  if (!fs) return null;
  return fs.documentDirectory + PERMANENT_DIR + '/';
}

// Hash a URL to a safe filename. Extension list covers every media type
// the chat actually sends: images (jpg/png/gif/webp/heic/heif/bmp), video
// (mp4/mov/webm/mkv/m4v/3gp), audio/voice (mp3/m4a/ogg/opus/wav/aac/flac),
// GIF, sticker (tgs/webp), and generic files (pdf/doc/zip/txt). Unknown
// extensions fall back to `bin` so they still get cached — we just can't
// use the extension to hint content-type.
function urlToKey(url) {
  // Strip query/fragment before hashing so signed-URL token rotation
  // (e.g. `?X-Amz-…&Expires=…`) doesn't bust the cache. Same R2/CDN object
  // with a fresh signature must hit the same local file. Anything that's
  // ACTUALLY a different resource will have a different path component.
  const base = String(url).split('?')[0].split('#')[0];
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = ((hash << 5) - hash) + base.charCodeAt(i);
    hash |= 0;
  }
  const ext = base.match(
    /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|tiff|mp4|mov|webm|mkv|m4v|3gp|avi|mp3|m4a|ogg|opus|wav|aac|flac|tgs|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|txt|csv|json)$/i
  )?.[1] || 'bin';
  return Math.abs(hash).toString(36) + '.' + ext;
}

// ── Synchronous lookup / index bootstrap ───────────────────────────────

// Returns the local file:// path if the URL is already cached on disk,
// otherwise null. Zero latency — reads from an in-memory Map populated
// once at app start. Use this in render closures.
//
// NOTA: a versão anterior retornava um "optimistic guess" (path
// determinístico mesmo se o arquivo não existia). Isso dava falso
// positivo — ExpoImage tentava o file://, falhava no onError, setava
// cachedUris[remote]=remote, e re-baixava TUDO. Removido: agora só
// retorna path se o syncIndex confirma presença. Se não, o render usa
// remoto + cacheMedia dispara em background; na próxima abertura
// (syncIndex populado) vira instantâneo.
export function getLocalUriSyncJs(url) {
  if (!url || Platform.OS === 'web') return null;
  const key = urlToKey(url);
  return syncIndex.get(key) || null;
}

// Public alias — same semantics as getLocalUriSyncJs but with the name the
// rest of the codebase (and external docs) expect. Returns a file:// path if
// the URL is already cached on disk (per the in-memory syncIndex), otherwise
// null. Zero I/O, safe in render closures. Components consult this BEFORE
// using the remote URL — that's the entire "tocando offline" guarantee.
export function getLocalUriIfCached(url) {
  return getLocalUriSyncJs(url);
}

// Scan both cache and saved dirs once, fill syncIndex. Call at app boot
// (post-login) so that subsequent renders hit the Map instantly.
export function initSyncCache() {
  if (Platform.OS === 'web') return Promise.resolve();
  if (syncInitPromise) return syncInitPromise;
  syncInitPromise = (async () => {
    await _hydrateIndexWhenReady();

    const fs = getFS();
    if (!fs) return;
    let changed = false;
    const liveKeys = new Set(); // filenames actually present on disk this boot
    for (const dir of [getCacheDir(), getSavedDir()]) {
      try {
        const info = await fs.getInfoAsync(dir);
        if (!info.exists) continue;
        const entries = await fs.readDirectoryAsync(dir);
        for (const name of entries) {
          liveKeys.add(name);
          const path = dir + name;
          if (syncIndex.get(name) !== path) {
            syncIndex.set(name, path);
            changed = true;
          }
        }
      } catch {}
    }
    // Scrub stale entries — iOS can clear NSCachesDirectory at any time.
    // If the index points to a file that no longer exists, render would
    // hand ExpoImage a broken file:// path and the image stays blank.
    // This sweep evicts those entries so cacheMedia re-downloads cleanly.
    for (const key of [...syncIndex.keys()]) {
      if (!liveKeys.has(key)) {
        syncIndex.delete(key);
        changed = true;
      }
    }
    if (changed) _schedulePersistIndex();
  })();
  return syncInitPromise;
}

// Re-register a single URL → local path (called after every successful
// cacheMedia / saveMediaPermanent so syncIndex stays fresh mid-session).
function registerSyncKey(url, localPath) {
  if (Platform.OS === 'web' || !url || !localPath) return;
  syncIndex.set(urlToKey(url), localPath);
  _schedulePersistIndex();
}

// Get cached URI for a URL, or return the original URL
export async function getCachedUri(url) {
  if (!url || Platform.OS === 'web') return url;
  const fs = getFS();
  if (!fs) return url;

  const key = urlToKey(url);
  // Fast path: if syncIndex already knows where the file lives (e.g. scanned
  // by initSyncCache at boot or registered by cacheMedia mid-session), skip
  // the fs.getInfoAsync round-trip and the getSavedDir fallback below.
  const indexed = syncIndex.get(key);
  if (indexed) return indexed;

  // Check BOTH locations — saveMediaPermanent writes to documentDirectory
  // while cacheMedia writes to cacheDirectory. Only checking the cache dir
  // (the old behavior) meant permanently-saved media got re-downloaded
  // every app launch because it was invisible to this lookup path.
  for (const dir of [getCacheDir(), getSavedDir()]) {
    if (!dir) continue;
    const localPath = dir + key;
    try {
      const info = await fs.getInfoAsync(localPath);
      if (info.exists) {
        registerSyncKey(url, localPath);
        return localPath;
      }
    } catch {}
  }

  return url; // Not cached yet
}

// In-flight download dedup — if the same URL is requested twice before the
// first completes, share the same Promise. Without this, two simultaneous
// cacheMedia(url) calls race on the same local path — one download wins, the
// other fails with EEXIST, both callers fall back to the remote URL, and
// the image appears uncached on next open.
const _inflightDownloads = new Map(); // key → Promise<localPath | url>

// Concurrency throttle — cap simultaneous network downloads so a burst of
// WS-driven prefetches (e.g. 30 messages syncing after reconnect) doesn't
// saturate the radio + heap. WhatsApp parity: small parallel pool, queue
// the rest. 3 is the sweet spot for mobile HTTP/2 — enough to overlap TLS
// handshakes but low enough to leave headroom for foreground requests
// (avatar fetch, message sends, etc).
const _MAX_CONCURRENT_DOWNLOADS = 3;
let _activeDownloads = 0;
const _downloadWaiters = []; // FIFO queue of resolve fns

function _acquireDownloadSlot() {
  if (_activeDownloads < _MAX_CONCURRENT_DOWNLOADS) {
    _activeDownloads++;
    return Promise.resolve();
  }
  return new Promise(resolve => _downloadWaiters.push(resolve));
}

function _releaseDownloadSlot() {
  const next = _downloadWaiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter (no decrement → no race).
    try { next(); } catch { _activeDownloads--; }
  } else {
    _activeDownloads--;
    if (_activeDownloads < 0) _activeDownloads = 0;
  }
}

// ── Media auto-download preferences (WhatsApp Settings → Storage parity) ──
//
// 4 buckets: photos, audio, videos, docs. Each is 'wifi' | 'mobile' | 'never'.
// - 'wifi'   = auto-DL only on Wi-Fi (or no NetInfo signal — fail-safe).
// - 'mobile' = auto-DL on any connection (Wi-Fi + cellular).
// - 'never'  = no auto-DL ever; user must tap to download.
// Defaults match WhatsApp factory: photos+audio on wifi, videos+docs never.
//
// Two extra knobs we accept alongside the 4 bucket prefs:
//   media_auto_dl_roaming  — bool. When FALSE (default), cellular auto-DL is
//                            forcibly downgraded to 'never' regardless of
//                            per-bucket pref. The user toggles this ON when
//                            they're back on their home carrier. Settings.js
//                            wires the UI switch into setMediaDownloadPrefs.
//   media_cache_cap_mb     — number. Hard cap for the LRU sweep. 0/-∞ =
//                            "unlimited" (sweep disabled). Defaults to
//                            MAX_CACHE_MB_DEFAULT (500MB).
//
// Cached in AsyncStorage under MEDIA_DL_PREFS_KEY so cacheMedia() can read
// them synchronously after the first hydrate at app start.
const MEDIA_DL_PREFS_KEY = 'chatyy:media_dl_prefs';
const _defaultMediaDlPrefs = {
  media_auto_dl_photos: 'wifi',
  media_auto_dl_audio:  'wifi',
  media_auto_dl_videos: 'never',
  media_auto_dl_docs:   'never',
  // Bool — when false, cellular acts as 'never' for every bucket. Stored
  // as a real boolean in JSON (settings.js mirrors a String('true')/'false'
  // into local storage too for the UI bootstrap; we accept both here).
  media_auto_dl_roaming: false,
  // Number (MB). 0 → unlimited. Set via setMediaCacheCapMb (preferred) or
  // the generic setMediaDownloadPrefs patch.
  media_cache_cap_mb: MAX_CACHE_MB_DEFAULT,
};
let _mediaDlPrefs = { ..._defaultMediaDlPrefs };
let _mediaDlPrefsHydrated = false;

function _coerceBucket(v) {
  return (v === 'wifi' || v === 'mobile' || v === 'never') ? v : null;
}
function _coerceBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}
function _coerceCapMb(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  if (n <= 0) return 0; // unlimited sentinel
  if (n > MAX_CACHE_MB_CEILING) return MAX_CACHE_MB_CEILING;
  return Math.round(n);
}

// Hydrate cached prefs from AsyncStorage at module load. Best-effort —
// any failure leaves us on the WhatsApp defaults. Public setter is
// `setMediaDownloadPrefs` (used by settings.js after a chat_user_defaults_set
// roundtrip lands).
function _hydrateMediaDlPrefs() {
  if (_mediaDlPrefsHydrated) return;
  _mediaDlPrefsHydrated = true;
  if (Platform.OS === 'web') return; // web has no cellular gate
  try {
    import('@react-native-async-storage/async-storage').then(m => {
      m.default.getItem(MEDIA_DL_PREFS_KEY).then(raw => {
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') {
            for (const k of ['media_auto_dl_photos','media_auto_dl_audio','media_auto_dl_videos','media_auto_dl_docs']) {
              const v = _coerceBucket(parsed[k]);
              if (v !== null) _mediaDlPrefs[k] = v;
            }
            const r = _coerceBool(parsed.media_auto_dl_roaming);
            if (r !== null) _mediaDlPrefs.media_auto_dl_roaming = r;
            const cap = _coerceCapMb(parsed.media_cache_cap_mb);
            if (cap !== null) _mediaDlPrefs.media_cache_cap_mb = cap;
          }
        } catch {}
      }).catch(() => {});
    }).catch(() => {});
  } catch {}
}
_hydrateMediaDlPrefs();

function _persistMediaDlPrefs() {
  if (Platform.OS === 'web') return;
  try {
    import('@react-native-async-storage/async-storage').then(m => {
      m.default.setItem(MEDIA_DL_PREFS_KEY, JSON.stringify(_mediaDlPrefs)).catch(() => {});
    }).catch(() => {});
  } catch {}
}

// Update the in-memory prefs cache + persist to AsyncStorage. Settings UI
// calls this after a successful chat_user_defaults_set so cacheMedia() picks
// up new gates instantly without waiting for the next app launch.
//
// Accepts any subset of the 6 keys above. Unknown keys are ignored; coercion
// (string 'true'/'false' → bool, number-as-string → number) makes this safe
// to call with raw chat_user_defaults_get values.
export function setMediaDownloadPrefs(patch) {
  if (!patch || typeof patch !== 'object') return;
  let dirty = false;
  for (const k of ['media_auto_dl_photos','media_auto_dl_audio','media_auto_dl_videos','media_auto_dl_docs']) {
    if (k in patch) {
      const v = _coerceBucket(patch[k]);
      if (v !== null && _mediaDlPrefs[k] !== v) { _mediaDlPrefs[k] = v; dirty = true; }
    }
  }
  if ('media_auto_dl_roaming' in patch) {
    const r = _coerceBool(patch.media_auto_dl_roaming);
    if (r !== null && _mediaDlPrefs.media_auto_dl_roaming !== r) {
      _mediaDlPrefs.media_auto_dl_roaming = r; dirty = true;
    }
  }
  if ('media_cache_cap_mb' in patch) {
    const cap = _coerceCapMb(patch.media_cache_cap_mb);
    if (cap !== null && _mediaDlPrefs.media_cache_cap_mb !== cap) {
      _mediaDlPrefs.media_cache_cap_mb = cap; dirty = true;
    }
  }
  if (dirty) _persistMediaDlPrefs();
}

// Read-only accessor — used by debug screens / settings preview.
export function getMediaDownloadPrefs() {
  return { ..._mediaDlPrefs };
}

// Dedicated cap setter — used by the storage tela future UI. Accepts
// number-of-MB (1024, 5120, 10240) or 0/Infinity for "unlimited". Returns
// the coerced value so the UI can render the same number it persisted.
export function setMediaCacheCapMb(mb) {
  const cap = _coerceCapMb(mb);
  if (cap === null) return _mediaDlPrefs.media_cache_cap_mb;
  if (_mediaDlPrefs.media_cache_cap_mb !== cap) {
    _mediaDlPrefs.media_cache_cap_mb = cap;
    _persistMediaDlPrefs();
    // Trigger an immediate sweep so the user gets disk freed without
    // waiting for the next download to land. Debounced inside.
    try { evictIfNeeded({ force: true }); } catch {}
  }
  return cap;
}

export function getMediaCacheCapMb() {
  return _mediaDlPrefs.media_cache_cap_mb;
}

// Classify a URL into one of the 4 buckets. Audio/voice → 'audio'; video → 'videos';
// documents (pdf/doc/zip/etc) → 'docs'; everything else (images, gif, sticker) → 'photos'.
function _bucketForUrl(url) {
  if (typeof url !== 'string') return 'photos';
  const lower = url.toLowerCase();
  if (/\.(mp4|mov|m4v|webm|mkv|avi|3gp)(\?|$|#)/.test(lower)) return 'videos';
  if (/\.(mp3|m4a|ogg|opus|wav|aac|flac)(\?|$|#)/.test(lower)) return 'audio';
  if (/\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|txt|csv)(\?|$|#)/.test(lower)) return 'docs';
  return 'photos';
}

// Returns true if the URL should auto-download given the current network +
// user prefs. Used by cacheMedia()'s gate. Callers can bypass via
// { force: true } (explicit tap-to-download UI).
//
// Policy ladder (matches WhatsApp Storage & Data):
//   1. pref === 'never'  → no.
//   2. On Wi-Fi          → yes (every bucket).
//   3. On cellular AND roaming-pref OFF → no (the user's "roaming nunca"
//      switch from settings overrides bucket prefs).
//   4. On cellular AND pref === 'mobile' → yes.
//   5. On cellular AND pref === 'wifi'   → no.
//   6. Network state unknown (NetInfo still probing) → be conservative:
//      allow lightweight buckets (photos/audio), defer heavy (videos/docs).
function _shouldAutoDownload(url) {
  const bucket = _bucketForUrl(url);
  const pref = _mediaDlPrefs[`media_auto_dl_${bucket}`] || _defaultMediaDlPrefs[`media_auto_dl_${bucket}`];
  if (pref === 'never') return false;

  let wifi = false;
  let known = false;
  try {
    const { isWifi, getNetworkState } = require('./networkInfo');
    if (typeof isWifi === 'function') {
      wifi = isWifi() === true;
      known = true;
    }
    const st = typeof getNetworkState === 'function' ? getNetworkState() : null;
    if (st && st.type === 'unknown') known = false;
  } catch {}

  if (wifi) return true; // Wi-Fi never burns cellular bytes.

  // Cellular path — the user can globally veto via the roaming switch.
  // Default pref is FALSE (= "I might be roaming, be conservative") which
  // mirrors WhatsApp's "Roaming → nunca" requirement from the task.
  if (known) {
    if (!_mediaDlPrefs.media_auto_dl_roaming) return false;
    return pref === 'mobile';
  }
  // Network not probed yet — old fallback (photos/audio yes, videos/docs no).
  return bucket === 'photos' || bucket === 'audio';
}

// Download and cache a URL, return local URI.
// `opts.force` (default false): bypass the cellular gate. Use this for the
// user's explicit "tap to download" gesture on a media bubble — the
// background prefetch path leaves opts.force unset so cellular saves data.
export async function cacheMedia(url, opts = {}) {
  if (!url || Platform.OS === 'web') return url;
  const fs = getFS();
  if (!fs) return url;

  // Auto-download gate (WhatsApp parity): read per-bucket user prefs
  // (photos/audio/videos/docs) + current network state. The tap-to-download
  // UI in the bubble passes { force: true } so the user's explicit intent
  // always proceeds regardless of pref. Web bypasses the gate (no cellular).
  if (!opts.force && Platform.OS !== 'web') {
    if (!_shouldAutoDownload(url)) {
      return url; // Return remote URL — bubble shows "tap to download" UI.
    }
  }

  const key = urlToKey(url);
  // Best-effort owner tag so the LRU sweep can protect favorites.
  if (opts && opts.conversationId != null) {
    try { _urlConvOwner.set(key, String(opts.conversationId)); } catch {}
  }
  const indexed = syncIndex.get(key);
  if (indexed) {
    try {
      const info = await fs.getInfoAsync(indexed);
      if (info.exists) return indexed;
    } catch {}
    syncIndex.delete(key);
  }
  for (const d of [getCacheDir(), getSavedDir()]) {
    if (!d) continue;
    const p = d + key;
    try {
      const info = await fs.getInfoAsync(p);
      if (info.exists) { registerSyncKey(url, p); return p; }
    } catch {}
  }

  if (_inflightDownloads.has(key)) return _inflightDownloads.get(key);

  // Salvar direto em documentDirectory (getSavedDir) em vez de cacheDirectory.
  // iOS pode (e faz) despejar o cacheDirectory sempre que o dispositivo fica
  // com pouco storage, então cada mídia que baixava ficava "carregando" de
  // novo na próxima abertura. documentDirectory persiste até o user desinstalar
  // ou limpar manualmente no Settings do app. Mesma estratégia do WhatsApp.
  const dir = getSavedDir();
  const localPath = dir + key;
  const dlPromise = (async () => {
    // Throttle: wait for a free slot before hitting the network. The slot
    // is held only for the actual download — getInfoAsync / mkdir are
    // cheap local FS calls so they run pre-acquire.
    try {
      const dirInfo = await fs.getInfoAsync(dir);
      if (!dirInfo.exists) {
        await fs.makeDirectoryAsync(dir, { intermediates: true });
      }
    } catch {}
    await _acquireDownloadSlot();
    try {
      // Retry com exponential backoff em 5xx / network failures. 4xx
      // (404, 410, 403) são bug nosso ou link expirado — retry só queima
      // bateria. Backoff: 0ms → 500ms → 1500ms (3 tentativas no total).
      const BACKOFFS_MS = [0, 500, 1500];
      let lastStatus = 0;
      for (let attempt = 0; attempt < BACKOFFS_MS.length; attempt++) {
        if (BACKOFFS_MS[attempt] > 0) {
          await new Promise(r => setTimeout(r, BACKOFFS_MS[attempt]));
        }
        try {
          // 20s timeout so a stuck CDN (slow 3G, dead edge node) doesn't hold the
          // promise forever and freeze downstream awaits.
          const download = await Promise.race([
            fs.downloadAsync(url, localPath),
            new Promise((_, rej) => setTimeout(() => rej(new Error('download_timeout')), 20000)),
          ]);
          if (download?.status === 200) { registerSyncKey(url, localPath); return localPath; }
          lastStatus = download?.status || 0;
          try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
          // Abort em 4xx — não vai mudar com retry. Recursos ausentes /
          // tokens inválidos são bug, não flaky network.
          if (lastStatus >= 400 && lastStatus < 500) break;
        } catch {
          // Network/timeout — vale tentar de novo.
          try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
        }
      }
    } catch {
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    } finally {
      _releaseDownloadSlot();
    }
    return url;
  })();
  _inflightDownloads.set(key, dlPromise);
  try { return await dlPromise; }
  finally {
    _inflightDownloads.delete(key);
    // Fire-and-forget LRU sweep (debounced inside) — keeps saved dir
    // bounded after each new download lands.
    try { evictIfNeeded(); } catch {}
  }
}

// Pre-cache an array of URLs (for batch caching when entering a conversation)
export async function preCacheUrls(urls) {
  if (Platform.OS === 'web' || !urls?.length) return;
  // Cache em batches de 20 — antes só processava os 20 primeiros e
  // ignorava o resto, deixando mídias antigas sem cache.
  for (let i = 0; i < urls.length; i += 20) {
    await Promise.allSettled(urls.slice(i, i + 20).map(url => cacheMedia(url)));
  }
}

// Get cache size in bytes
export async function getCacheSize() {
  if (Platform.OS === 'web') return 0;
  const fs = getFS();
  if (!fs) return 0;
  const dir = getCacheDir();
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) return 0;
    return info.size || 0;
  } catch { return 0; }
}

// Save media permanently (won't be cleared by OS)
export async function saveMediaPermanent(url) {
  if (!url || Platform.OS === 'web') return url;
  const fs = getFS();
  if (!fs) return url;

  const dir = getSavedDir();
  const key = urlToKey(url);
  const localPath = dir + key;

  try {
    const info = await fs.getInfoAsync(localPath);
    if (info.exists) return localPath;
  } catch {}

  try {
    const dirInfo = await fs.getInfoAsync(dir);
    if (!dirInfo.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });

    // Check if already in cache — move instead of re-downloading
    const cachedPath = getCacheDir() + key;
    try {
      const cachedInfo = await fs.getInfoAsync(cachedPath);
      if (cachedInfo.exists) {
        await fs.copyAsync({ from: cachedPath, to: localPath });
        registerSyncKey(url, localPath);
        return localPath;
      }
    } catch {}

    // Download fresh — go through the global concurrency throttle so a
    // burst of audio prefetches (e.g. 10 voice notes arriving over WS
    // after a reconnect) can't saturate the radio behind cacheMedia's
    // back. _MAX_CONCURRENT_DOWNLOADS is shared across both code paths.
    await _acquireDownloadSlot();
    try {
      const download = await fs.downloadAsync(url, localPath);
      if (download.status === 200) { registerSyncKey(url, localPath); return localPath; }
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    } finally {
      _releaseDownloadSlot();
    }
  } catch {}

  return url;
}

// Adopt an existing local file (e.g. just-recorded voice note at
// file:///.../voice_xxx.m4a) as the cached copy for a remote CDN URL.
// Used by the SEND path: after the server returns the canonical file_url,
// we already have the bytes on disk — copy them into the cache dir under
// the deterministic key so subsequent loads of the SAME message (or any
// other client viewing it later) hit the local copy instead of re-DLing.
//
// Idempotent: if the destination already exists we skip the copy. Returns
// the local path on success or null on failure / unsupported (web).
export async function adoptLocalFileAsCache(remoteUrl, localUri) {
  if (Platform.OS === 'web' || !remoteUrl || !localUri) return null;
  if (typeof localUri !== 'string' || !localUri.startsWith('file://')) return null;
  const fs = getFS();
  if (!fs) return null;
  const dir = getSavedDir();
  const key = urlToKey(remoteUrl);
  const destPath = dir + key;
  try {
    // Skip if already adopted (deterministic key — same URL → same path).
    try {
      const existing = await fs.getInfoAsync(destPath);
      if (existing.exists && existing.size > 0) {
        registerSyncKey(remoteUrl, destPath);
        return destPath;
      }
    } catch {}
    // Ensure parent dir.
    try {
      const dirInfo = await fs.getInfoAsync(dir);
      if (!dirInfo.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });
    } catch {}
    // Source must still exist (expo-av sometimes purges its recording temp).
    try {
      const src = await fs.getInfoAsync(localUri);
      if (!src.exists || !src.size) return null;
    } catch { return null; }
    await fs.copyAsync({ from: localUri, to: destPath });
    registerSyncKey(remoteUrl, destPath);
    return destPath;
  } catch {
    try { await fs.deleteAsync(destPath, { idempotent: true }); } catch {}
    return null;
  }
}

// Auto-prefetch hook for the WebSocket receive path. Called fire-and-forget
// the moment a `chat_message` / `chat_summary` event lands so the media is
// already on disk by the time the user navigates into the conversation —
// even if they never opened the chat between the WS event and going offline.
//
// Scope by design: ONLY image + audio/voice. Video and documents are heavy
// (10-200MB common) and would burn cellular data + radio + storage on a
// background prefetch. The user can still tap-to-download those via the
// bubble's force-DL UI. WhatsApp parity: photos/audio auto, video/docs gated.
//
// Honors the cellular gate inside cacheMedia (per-bucket prefs). On cellular
// with the default 'wifi' pref, this returns immediately without touching
// the network. Concurrency is capped at _MAX_CONCURRENT_DOWNLOADS so a burst
// of inbound messages doesn't saturate the radio.
//
// Idempotent: if the URL is already cached or in-flight, no-op (cacheMedia
// dedup via syncIndex + _inflightDownloads).
export function prefetchIncomingMessageMedia(message) {
  if (!message || Platform.OS === 'web') return;
  const t = String(message.type || '').toLowerCase();
  // Full scope for offline playback parity (task #1103 round 2): every
  // media-bearing message type is eligible for background download. Heavy
  // types (video/document) still flow through cacheMedia()'s per-bucket
  // policy gate (defaults to never-on-cellular), so we don't blow up the
  // user's data plan — we just *offer* the download when their pref allows.
  const isAudio   = t === 'audio' || t === 'voice';
  const isImage   = t === 'image';
  const isVideo   = t === 'video' || t === 'short_video' || t === 'video_note';
  const isFile    = t === 'file' || t === 'document';
  const isGifLike = t === 'gif' || t === 'sticker';
  if (!isAudio && !isImage && !isVideo && !isFile && !isGifLike) return;

  // GIFs / stickers ship their URL in `content` (Tenor / sticker server),
  // not file_url. Other types use file_url. Support both shapes.
  let rawUrl = message.file_url;
  if (!rawUrl && isGifLike && typeof message.content === 'string' && message.content.startsWith('http')) {
    rawUrl = message.content;
  }
  if (!rawUrl || typeof rawUrl !== 'string') return;
  const url = rawUrl.startsWith('http') ? rawUrl : `https://chatyy.com.br${rawUrl}`;

  // Persist LQIP (thumb_b64) opportunistically so the blur placeholder is
  // available the moment the bubble mounts — even before the row hits the
  // chat-conversation render path.
  if (typeof message.thumb_b64 === 'string' && message.thumb_b64.length > 0) {
    try { persistThumbB64(message.id, message.thumb_b64); } catch {}
  }
  const convId = message.conversation_id ?? message.conversationId;
  try {
    if (isAudio) {
      // Audio is tiny (~50-300KB) and the user expects instant playback —
      // bypass the cellular gate so voice notes always land. Matches the
      // ChatListTab #886 behavior. Goes through saveMediaPermanent which
      // shares the same destination dir as cacheMedia.
      prefetchAudioMessage(url);
      if (convId != null) tagUrlConversation(url, convId);
    } else {
      // Image / video / file / gif / sticker — honor the per-bucket cellular
      // gate via cacheMedia. Photos default to wifi, video/docs default to
      // never; tap-to-download in the bubble bypasses with { force: true }.
      // Fire-and-forget; failures don't bubble up to the WS handler.
      cacheMedia(url, convId != null ? { conversationId: convId } : undefined).catch(() => {});
    }
  } catch {}
}

// Task #886 — prefetch a single audio message's media so the bubble plays
// offline-clean even if the user never tapped it before going dark. Designed
// to be called the instant a `type==='audio'|'voice'` row enters state (WS
// receive, TCP receive, load, sync, etc). Idempotent: if the file is already
// cached, returns the local path without re-downloading. force:true bypasses
// the cellular gate — audio is tiny (~50-300KB), users always want it.
//
// Returns a Promise resolving to the local path on success or the remote URL
// on failure. Callers should treat as fire-and-forget; the AudioPlayer will
// pick up the cached file on its next mount via getCachedAudioUri.
export function prefetchAudioMessage(remoteUrl) {
  if (!remoteUrl || Platform.OS === 'web') return Promise.resolve(remoteUrl);
  try { console.log('[audio_offline] prefetch', String(remoteUrl).slice(0, 80)); } catch {}
  // saveMediaPermanent writes to documentDirectory (the "saved" dir) — same
  // location getCachedAudioUri checks via the mediaCache consolidation hook,
  // so a single download serves both the bubble's player AND the chat list
  // preview. No cellular gate inside saveMediaPermanent → safe for audio.
  return saveMediaPermanent(remoteUrl).catch(() => remoteUrl);
}

// Get permanent saved URI
export async function getSavedUri(url) {
  if (!url || Platform.OS === 'web') return null;
  const fs = getFS();
  if (!fs) return null;
  const path = getSavedDir() + urlToKey(url);
  try {
    const info = await fs.getInfoAsync(path);
    return info.exists ? path : null;
  } catch { return null; }
}

// Auto-save all media from a conversation for offline access. Covers every
// attachment type — image, video, audio/voice, gif, sticker, and plain file.
// Anything with a file_url is eligible; the type filter was previously too
// narrow and left gifs/stickers/files re-downloading every app launch.
export async function saveConversationMedia(messages) {
  if (Platform.OS === 'web' || !messages?.length) return;
  // Voice-message side hook — feed every type==='voice'|'audio' row into
  // voicePrefetch so server-side wave_peaks are persisted in MMKV (bubble
  // paints the real envelope on next mount) and the played-ack bus
  // tracks the messageId → conversationId mapping. Fire-and-forget;
  // idempotent (in-flight set inside voicePrefetch dedupes).
  try {
    const { prefetchVoiceMessages } = require('./voicePrefetch');
    prefetchVoiceMessages?.(messages);
  } catch {}
  // GIFs and stickers (Tenor URLs) live in `m.content`, not `m.file_url`.
  // Treat both as media sources so they get persisted to the local cache
  // and survive across app launches.
  const types = ['image', 'video', 'audio', 'voice', 'gif', 'sticker', 'file'];
  const pickUrl = (m) => {
    if (m.file_url) return m.file_url;
    if ((m.type === 'gif' || m.type === 'sticker') && typeof m.content === 'string' && m.content.startsWith('http')) return m.content;
    return null;
  };
  const mediaMessages = messages.filter(m => types.includes(m.type) && pickUrl(m));
  const BATCH_SIZE = 20;
  for (let i = 0; i < mediaMessages.length; i += BATCH_SIZE) {
    const batch = mediaMessages.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(msg => {
      const raw = pickUrl(msg);
      const url = raw?.startsWith('http') ? raw : `https://chatyy.com.br${raw}`;
      return saveMediaPermanent(url).catch(() => {});
    }));
  }
}

// Get total saved media size
export async function getSavedSize() {
  if (Platform.OS === 'web') return 0;
  const fs = getFS();
  if (!fs) return 0;
  try {
    const dir = getSavedDir();
    const info = await fs.getInfoAsync(dir);
    return info.exists ? (info.size || 0) : 0;
  } catch { return 0; }
}

// LRU eviction: scan saved/cache dirs, sum sizes, if over the configured
// cap delete oldest files (by modificationTime) until under it. Without
// this the saved dir grows unbounded — first-time users hit photos heavy
// channels and end up with multi-GB sandboxes after a few weeks.
// Called opportunistically (debounced) — not blocking on every download.
//
// opts.force = true bypasses the 5-min debounce. Used by setMediaCacheCapMb
// so lowering the cap (e.g. 10GB → 1GB) frees disk immediately instead of
// waiting up to 5 minutes for the next download to trigger a sweep.
let _lastEvictAt = 0;
let _evictInflight = null;
export async function evictIfNeeded(opts) {
  if (Platform.OS === 'web') return;
  const force = !!(opts && opts.force);
  // "Unlimited" sentinel — user explicitly opted out of the cap. Skip the
  // disk walk entirely so big libraries don't burn CPU on every download.
  const capMb = Number(_mediaDlPrefs.media_cache_cap_mb);
  if (!Number.isFinite(capMb) || capMb <= 0) return;
  // Debounce: at most one sweep every 5 min. Scanning the dir on every
  // cacheMedia call is its own perf problem on accounts with thousands
  // of media files.
  const now = Date.now();
  if (!force && now - _lastEvictAt < 5 * 60 * 1000) return;
  if (_evictInflight) return _evictInflight;
  const fs = getFS();
  if (!fs) return;
  _evictInflight = (async () => {
    try {
      const limitBytes = capMb * 1024 * 1024;
      const entries = [];
      for (const dir of [getCacheDir(), getSavedDir()]) {
        if (!dir) continue;
        try {
          const info = await fs.getInfoAsync(dir);
          if (!info.exists) continue;
          const names = await fs.readDirectoryAsync(dir);
          for (const name of names) {
            const path = dir + name;
            try {
              const st = await fs.getInfoAsync(path);
              if (st.exists && !st.isDirectory) {
                entries.push({ path, size: st.size || 0, mtime: st.modificationTime || 0, name });
              }
            } catch {}
          }
        } catch {}
      }
      const total = entries.reduce((a, e) => a + e.size, 0);
      if (total <= limitBytes) return;
      // Oldest first — purge LRU until under cap. Skip files whose owning
      // conversation is flagged Keep-Always (per-conv favorites). If after
      // protecting all favorites we STILL can't free enough, we fall back
      // to evicting protected entries too — better the user loses a few
      // favorites than the device runs out of disk.
      entries.sort((a, b) => a.mtime - b.mtime);
      let freed = 0;
      const need = total - limitBytes;
      const skipped = [];
      for (const e of entries) {
        if (freed >= need) break;
        if (_isFileProtected(e.name)) { skipped.push(e); continue; }
        try {
          await fs.deleteAsync(e.path, { idempotent: true });
          syncIndex.delete(e.name);
          _urlConvOwner.delete(e.name);
          freed += e.size;
        } catch {}
      }
      // Last-resort sweep: only if we still haven't hit the target.
      if (freed < need) {
        for (const e of skipped) {
          if (freed >= need) break;
          try {
            await fs.deleteAsync(e.path, { idempotent: true });
            syncIndex.delete(e.name);
            _urlConvOwner.delete(e.name);
            freed += e.size;
          } catch {}
        }
      }
      _schedulePersistIndex();
    } finally {
      _lastEvictAt = Date.now();
      _evictInflight = null;
    }
  })();
  return _evictInflight;
}

// Clear the entire cache (not saved media)
export async function clearMediaCache() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  const dir = getCacheDir();
  try {
    await fs.deleteAsync(dir, { idempotent: true });
  } catch {}
}

// Clear saved media
export async function clearSavedMedia() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  try {
    await fs.deleteAsync(getSavedDir(), { idempotent: true });
  } catch {}
}

// Delete a single URL's local copies (both cache + permanent). Called when
// a conversation is deleted — WhatsApp-parity: user expects all media tied
// to that chat to leave the device.
export async function deleteCachedUrl(url) {
  if (Platform.OS === 'web' || !url) return;
  const fs = getFS();
  if (!fs) return;
  const key = urlToKey(url);
  for (const dir of [getCacheDir(), getSavedDir()]) {
    try { await fs.deleteAsync(dir + key, { idempotent: true }); } catch {}
  }
  syncIndex.delete(urlToKey(url));
}

// Bulk delete local media for a conversation. Pass the list of messages
// (from the SmartCache / server) before the DB rows are wiped.
export async function deleteConversationMedia(messages) {
  if (Platform.OS === 'web' || !Array.isArray(messages) || messages.length === 0) return;
  const urls = new Set();
  for (const m of messages) {
    if (!m?.file_url) continue;
    const url = m.file_url.startsWith('http') ? m.file_url : `https://chatyy.com.br${m.file_url}`;
    urls.add(url);
  }
  for (const url of urls) {
    try { await deleteCachedUrl(url); } catch {}
  }
}

// ── Storage stats (Settings → Storage section) ─────────────────────────
// Classify a cached file by extension into one of 4 buckets that match the
// WhatsApp Storage UI (Photos / Videos / Audio / Documents). Files with no
// recognized extension fall into "document" so totals still reflect actual
// disk usage. Kept separate from `_bucketForUrl` because the auto-download
// classifier deliberately folds GIFs/stickers into photos — for the storage
// stats card the user expects the same breakdown WhatsApp shows.
const _STATS_EXT_BUCKETS = {
  image:    /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|tiff)$/i,
  video:    /\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i,
  audio:    /\.(mp3|m4a|ogg|opus|wav|aac|flac)$/i,
  document: /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|txt|csv|json)$/i,
};

function _bucketForFilename(name) {
  if (typeof name !== 'string') return 'document';
  for (const bucket of Object.keys(_STATS_EXT_BUCKETS)) {
    if (_STATS_EXT_BUCKETS[bucket].test(name)) return bucket;
  }
  return 'document';
}

// Aggregate cache + saved-media usage broken down by media type. Powers the
// Storage section in settings (WhatsApp Storage & Data parity).
//
// Returns:
//   {
//     totalBytes: number,        // cache + saved combined
//     cacheBytes: number,        // OS-purgeable cache dir
//     savedBytes: number,        // permanent document dir
//     byType: { image, video, audio, document }, // bytes per bucket
//     counts: { image, video, audio, document }, // file counts per bucket
//   }
//
// Web returns zeros (no file-system store); callers should hide the section.
export async function getStorageStats() {
  const capMbEmpty = Number(_mediaDlPrefs.media_cache_cap_mb);
  const empty = {
    totalBytes: 0,
    cacheBytes: 0,
    savedBytes: 0,
    byType:  { image: 0, video: 0, audio: 0, document: 0 },
    counts:  { image: 0, video: 0, audio: 0, document: 0 },
    capBytes: Number.isFinite(capMbEmpty) && capMbEmpty > 0 ? capMbEmpty * 1024 * 1024 : 0,
    capMb:    Number.isFinite(capMbEmpty) ? capMbEmpty : 0,
  };
  if (Platform.OS === 'web') return empty;
  const fs = getFS();
  if (!fs) return empty;

  const byType = { image: 0, video: 0, audio: 0, document: 0 };
  const counts = { image: 0, video: 0, audio: 0, document: 0 };
  let cacheBytes = 0;
  let savedBytes = 0;

  const dirs = [
    { path: getCacheDir(), kind: 'cache' },
    { path: getSavedDir(), kind: 'saved' },
  ];
  for (const { path: dir, kind } of dirs) {
    if (!dir) continue;
    try {
      const info = await fs.getInfoAsync(dir);
      if (!info.exists) continue;
      const names = await fs.readDirectoryAsync(dir);
      for (const name of names) {
        const p = dir + name;
        try {
          const st = await fs.getInfoAsync(p);
          if (!st.exists || st.isDirectory) continue;
          const size = st.size || 0;
          const bucket = _bucketForFilename(name);
          byType[bucket] += size;
          counts[bucket] += 1;
          if (kind === 'cache') cacheBytes += size; else savedBytes += size;
        } catch {}
      }
    } catch {}
  }

  // Surface the cache cap alongside the breakdown so callers (storage UI)
  // can render "X used of Y" without a second mediaCache import. capBytes
  // is 0 when the user picked "unlimited" — the UI should hide the
  // progress bar in that case.
  const capMb = Number(_mediaDlPrefs.media_cache_cap_mb);
  const capBytes = Number.isFinite(capMb) && capMb > 0 ? capMb * 1024 * 1024 : 0;

  return {
    totalBytes: cacheBytes + savedBytes,
    cacheBytes,
    savedBytes,
    byType,
    counts,
    capBytes,
    capMb: Number.isFinite(capMb) ? capMb : 0,
  };
}

// Nuke both cache + saved media in one call. Used by the "Clear cache" button
// in settings. Also clears the in-memory syncIndex so subsequent lookups
// re-scan disk (finding nothing) and the bubbles re-download on demand.
export async function clearAllCache() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  for (const dir of [getCacheDir(), getSavedDir()]) {
    if (!dir) continue;
    try { await fs.deleteAsync(dir, { idempotent: true }); } catch {}
  }
  syncIndex.clear();
  _schedulePersistIndex();
}

// ── Keep-Always set (per-conversation favorites) ─────────────────────────
// Conversations flagged "Manter sempre" never have their media evicted by
// the LRU sweep. Persisted in MMKV under KEEP_ALWAYS_KEY as a string[] of
// conversation IDs. The evict path consults `_isUrlProtected` which walks
// the syncIndex tagging and skips any file whose owner conv is in the set.
const KEEP_ALWAYS_KEY = 'media_keep_always_convs_v1';
const _keepAlwaysConvs = new Set();
const _urlConvOwner = new Map(); // key → conversationId (best-effort tag)
let _keepAlwaysHydrated = false;

function _hydrateKeepAlways() {
  if (_keepAlwaysHydrated) return;
  _keepAlwaysHydrated = true;
  if (Platform.OS === 'web') return;
  try {
    const mmkv = require('./mmkv');
    const raw = mmkv.getString?.(KEEP_ALWAYS_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      for (const id of arr) if (id != null) _keepAlwaysConvs.add(String(id));
    }
  } catch {}
}
_hydrateKeepAlways();

function _persistKeepAlways() {
  if (Platform.OS === 'web') return;
  try {
    const mmkv = require('./mmkv');
    mmkv.setString?.(KEEP_ALWAYS_KEY, JSON.stringify([..._keepAlwaysConvs]));
  } catch {}
}

export function setConversationKeepAlways(conversationId, on) {
  if (conversationId == null) return;
  _hydrateKeepAlways();
  const id = String(conversationId);
  if (on) _keepAlwaysConvs.add(id); else _keepAlwaysConvs.delete(id);
  _persistKeepAlways();
}

export function isConversationKeepAlways(conversationId) {
  if (conversationId == null) return false;
  _hydrateKeepAlways();
  return _keepAlwaysConvs.has(String(conversationId));
}

export function getKeepAlwaysConvs() {
  _hydrateKeepAlways();
  return [..._keepAlwaysConvs];
}

// Tag a URL with the conversation that "owns" it. Best-effort: callers
// pass conversationId when known (cacheMedia from chat path / WS handler).
// Without a tag the file is treated as orphan and evictable normally.
export function tagUrlConversation(url, conversationId) {
  if (!url || conversationId == null || Platform.OS === 'web') return;
  try { _urlConvOwner.set(urlToKey(url), String(conversationId)); } catch {}
}

function _isFileProtected(filename) {
  const owner = _urlConvOwner.get(filename);
  if (!owner) return false;
  return _keepAlwaysConvs.has(owner);
}

// ── Thumbnail b64 (LQIP) persistent cache ────────────────────────────────
// Backend `chat_messages.thumb_b64` (40-50px base64 JPEG, <500 bytes) is the
// blur placeholder the chat bubble paints while the full image downloads.
// We persist a small in-memory map (capped) backed by MMKV so the LQIP
// survives kill-and-reopen and is queryable synchronously in render. Keyed
// by message ID rather than URL because the row already carries it and
// scrolling FlatList wants zero overhead per item.
const THUMB_B64_MMKV_KEY = 'media_thumb_b64_v1';
const THUMB_B64_MAX_ENTRIES = 2000; // ~1MB at 500B per entry
const _thumbB64Cache = new Map(); // messageId(str) → base64 string
let _thumbB64Hydrated = false;
let _thumbB64PersistTimer = null;

function _hydrateThumbB64() {
  if (_thumbB64Hydrated) return;
  _thumbB64Hydrated = true;
  if (Platform.OS === 'web') return;
  try {
    const mmkv = require('./mmkv');
    const raw = mmkv.getString?.(THUMB_B64_MMKV_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string' && v.length < 4096) _thumbB64Cache.set(k, v);
      }
    }
  } catch {}
}
_hydrateThumbB64();

function _scheduleThumbB64Persist() {
  if (Platform.OS === 'web') return;
  if (_thumbB64PersistTimer) return;
  _thumbB64PersistTimer = setTimeout(() => {
    _thumbB64PersistTimer = null;
    try {
      const mmkv = require('./mmkv');
      const obj = {};
      // Cap at THUMB_B64_MAX_ENTRIES by FIFO — Map preserves insertion order,
      // so iterating reverse and keeping the LAST inserted N gives recency.
      const all = [..._thumbB64Cache.entries()];
      const start = Math.max(0, all.length - THUMB_B64_MAX_ENTRIES);
      for (let i = start; i < all.length; i++) {
        const [k, v] = all[i];
        obj[k] = v;
      }
      mmkv.setString?.(THUMB_B64_MMKV_KEY, JSON.stringify(obj));
    } catch {}
  }, 3000);
}

// Store/retrieve LQIP base64 for a message. Synchronous reads from the
// in-memory map (hot on first paint), async persist debounced to MMKV.
export function persistThumbB64(messageId, b64) {
  if (messageId == null || !b64 || typeof b64 !== 'string') return;
  if (b64.length > 4096) return; // sanity guard
  _hydrateThumbB64();
  const k = String(messageId);
  if (_thumbB64Cache.get(k) === b64) return;
  _thumbB64Cache.set(k, b64);
  // Evict oldest if oversized
  if (_thumbB64Cache.size > THUMB_B64_MAX_ENTRIES + 200) {
    const drop = _thumbB64Cache.size - THUMB_B64_MAX_ENTRIES;
    let i = 0;
    for (const key of _thumbB64Cache.keys()) {
      if (i++ >= drop) break;
      _thumbB64Cache.delete(key);
    }
  }
  _scheduleThumbB64Persist();
}

export function getThumbB64Sync(messageId) {
  if (messageId == null) return null;
  _hydrateThumbB64();
  return _thumbB64Cache.get(String(messageId)) || null;
}

// When the optimistic bubble (temp_id) gets replaced by the server's real
// message id, migrate the LQIP entry so the same blur placeholder keeps
// rendering on subsequent loads instead of disappearing for ~80ms while the
// real URL decodes. Cheap O(1) Map operation; safe to call when either id
// is missing.
export function migrateThumbB64TempToReal(tempId, realId) {
  if (tempId == null || realId == null) return;
  _hydrateThumbB64();
  const k = String(tempId);
  const v = _thumbB64Cache.get(k);
  if (!v) return;
  const newK = String(realId);
  if (_thumbB64Cache.get(newK)) return; // already populated by server LQIP
  _thumbB64Cache.set(newK, v);
  _thumbB64Cache.delete(k);
  _scheduleThumbB64Persist();
}

// When the optimistic bubble points at a local file:// URI (camera/picker
// output), pre-seed the sync cache so CachedImage on this device finds the
// local file the moment the message gets its real id — no R2 round-trip,
// no flicker. Used by imageSendPipeline.preflightOutgoing().
export function bindLocalUriToRemoteUrl(localUri, remoteUrl) {
  if (!localUri || !remoteUrl || Platform.OS === 'web') return;
  try {
    const key = urlToKey(remoteUrl);
    if (!key) return;
    if (syncIndex.has(key)) return; // already mapped
    syncIndex.set(key, localUri);
    _schedulePersistIndex();
  } catch {}
}

// Batch ingest — call after a `chat_get_messages` / WS sync lands so all
// LQIPs are persisted in one shot. Iterates safely: missing thumb_b64 keys
// are ignored, no throw on bad rows.
export function ingestThumbB64FromMessages(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return;
  for (const m of messages) {
    if (!m || m.id == null) continue;
    if (typeof m.thumb_b64 === 'string' && m.thumb_b64.length > 0) {
      persistThumbB64(m.id, m.thumb_b64);
    }
  }
}

// ── Offline-aware lookup ─────────────────────────────────────────────────
// Returns:
//   { localUri: file://... }  → cached, render this
//   { localUri: null, offline: true }  → no cache + no network
//   { localUri: null, offline: false } → no cache but online (caller can fetch)
//
// ChatMediaViewer / image bubbles use this to render "Foto não disponível
// offline" when there's no connectivity AND no local copy. Sync, zero I/O.
export function getOfflineMediaStatus(url) {
  if (!url || Platform.OS === 'web') return { localUri: null, offline: false };
  const localUri = getLocalUriSyncJs(url);
  if (localUri) return { localUri, offline: false };
  let online = true;
  try {
    const { isConnected } = require('./networkInfo');
    if (typeof isConnected === 'function') online = !!isConnected();
  } catch {}
  return { localUri: null, offline: !online };
}

// ── Tap-to-download UX helpers ───────────────────────────────────────────
// WhatsApp threshold: photos > 2MB on cellular get the manual tap gate even
// when the user's pref is "wifi". Inside cacheMedia the pref gate already
// blocks the auto-download — these helpers are for the bubble UI to *show*
// the correct affordance (icon + size label).
const TAP_TO_DL_PHOTO_BYTES = 2 * 1024 * 1024;

export function shouldShowTapToDownload(url, sizeBytes) {
  if (!url || Platform.OS === 'web') return false;
  // Already cached → no gate.
  if (getLocalUriSyncJs(url)) return false;
  // Honor user prefs first — 'never' or wifi-pref-on-cellular both block.
  if (!_shouldAutoDownload(url)) return true;
  // On cellular even when allowed, big photos still get the gate.
  try {
    const { isWifi } = require('./networkInfo');
    if (typeof isWifi === 'function' && isWifi() === false) {
      if (typeof sizeBytes === 'number' && sizeBytes > TAP_TO_DL_PHOTO_BYTES) return true;
    }
  } catch {}
  return false;
}

// Format byte count as a short human label ("1.4 MB" / "640 KB"). Plays
// nice with the i18n placeholder `photo.tapToDownload.cellular` = "Tocar
// para baixar ({size})".
export function formatBytesShort(bytes) {
  const n = Number(bytes);
  if (!isFinite(n) || n <= 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Server-backed redownload ────────────────────────────────────────────
// Subscribers for redownload completion. Components mount/unmount via
// `subscribeRedownload(cb)` so a successful resolve can swap the bubble's
// stale URL with the fresh one *without* a full message-list refetch.
const _redlListeners = new Set();
export function subscribeRedownload(cb) {
  if (typeof cb !== 'function') return () => {};
  _redlListeners.add(cb);
  return () => { _redlListeners.delete(cb); };
}
function _emitRedownload(payload) {
  for (const cb of _redlListeners) {
    try { cb(payload); } catch {}
  }
}

// Dedup concurrent calls for the same message — three bubbles tapping
// redownload at once for a forwarded broadcast should only hit the server
// once. Keyed by messageId.
const _inflightRedl = new Map(); // messageId → Promise<{ ok, url, ... }>

/**
 * Ask the backend for a fresh URL for an evicted chat-media message and
 * download it back into the local cache. Returns `{ ok, url, localUri,
 * kind, error }`. Emits to subscribers on success so any open bubble
 * binding the same messageId can re-render with the new URL.
 *
 * Caller pattern (bubble component):
 *   const r = await requestRedownload(msg.id, msg.file_url);
 *   if (r.ok) setUrl(r.localUri || r.url);
 *
 * Error paths:
 *   - 410: message was hard-deleted ("delete for everyone")
 *   - 403: user no longer a member of the conversation
 *   - network: surfaced as { ok: false, error: 'network' } so the bubble
 *     can show a retry button instead of a permanent "unavailable" state.
 */
export async function requestRedownload(messageId, fileUrl = '') {
  const mid = Number(messageId) || 0;
  if (!mid) return { ok: false, error: 'invalid_message_id' };

  if (_inflightRedl.has(mid)) return _inflightRedl.get(mid);

  const work = (async () => {
    let resp;
    try {
      const api = require('./api');
      resp = await api.chatRedownloadMedia(mid);
    } catch (e) {
      return { ok: false, error: 'network', messageId: mid };
    }
    if (!resp || !resp.success) {
      // Pass through the server-side reason so UI can show "deleted" vs
      // "unavailable" copy. status comes from apiCall's wrapped error shape.
      const msg = resp?.message || resp?.error || 'unknown';
      const code = resp?.status || 0;
      return {
        ok: false,
        error: msg,
        status: code,
        messageId: mid,
        deleted: code === 410 || /deleted/i.test(String(msg)),
      };
    }
    const data = resp.data || {};
    const freshUrl = String(data.url || '');
    if (!freshUrl) return { ok: false, error: 'no_url', messageId: mid };

    // Pull into local cache so the next read is offline-friendly. cacheMedia
    // honors per-bucket prefs but we force-download here — user just tapped
    // "redownload", their intent is explicit. Web skips (URL is the cache).
    let localUri = null;
    if (Platform.OS !== 'web') {
      try {
        localUri = await cacheMedia(freshUrl, { force: true });
        // Also bind the ORIGINAL fileUrl to the same local path so other
        // bubbles in the conversation that still reference the stale URL
        // pick up the local file on their next render — avoids forcing
        // every viewer in the thread to re-fetch.
        if (localUri && fileUrl && localUri !== freshUrl && localUri.startsWith('file://')) {
          try { bindLocalUriToRemoteUrl(localUri, fileUrl); } catch {}
        }
      } catch {}
    }

    const payload = {
      ok: true,
      messageId: mid,
      url: freshUrl,
      localUri,
      kind: data.kind || 'cdn',
      type: data.type || '',
      fileName: data.file_name || '',
      fileSize: Number(data.file_size) || 0,
      createdAt: data.created_at || null,
      originalUrl: fileUrl,
    };
    _emitRedownload(payload);
    return payload;
  })();

  _inflightRedl.set(mid, work);
  try { return await work; } finally { _inflightRedl.delete(mid); }
}

// Relative-time helper for "Last downloaded X ago" copy on the redownload
// bubble. Falls back to a date string after a week so really old messages
// don't render as "300d". Locale-aware via toLocaleDateString.
export function formatRelativeAge(timestamp) {
  if (!timestamp) return '';
  const ms = typeof timestamp === 'number' ? timestamp : Date.parse(String(timestamp));
  if (!isFinite(ms) || ms <= 0) return '';
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'agora';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 604_800_000) return `${Math.floor(diff / 86_400_000)}d`;
  try { return new Date(ms).toLocaleDateString(); } catch { return ''; }
}
