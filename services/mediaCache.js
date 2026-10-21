import { Platform } from 'react-native';

const CACHE_DIR = 'chat-media-cache';
const PERMANENT_DIR = 'chat-media-saved'; // Permanent storage (not cleared by OS)
// Default cap when the user hasn't picked one. WhatsApp ships uncapped on
// iOS (the OS sandbox is the only limit) and a soft 5GB on Android. We pick
// a conservative 500MB default so accounts with no explicit pref still get
// the LRU sweep — heavier users bump via setMediaCacheCapMb (1GB / 5GB /
// 10GB / Infinity for "unlimited").
const MAX_CACHE_MB_DEFAULT = 500;
// [2026-10-14 offline-media] Piso do limite do store permanente (mídia aberta).
const STORE_MIN_CAP_MB = 2048;
// 0 (or any non-positive number) is the sentinel for "unlimited" — skip the
// LRU sweep entirely. Capped above (~64GB) so a typo doesn't blow the math.
const MAX_CACHE_MB_CEILING = 64 * 1024;
let FileSystem = null;

// [2026-10-08 media-local-store] Store permanente por conta/conversa
// (documentDirectory/media/<conta>/<conv>/<msgId>.<ext>) — ver services/mediaStore.js.
let _mediaStoreMod = null;
function _store() {
  if (Platform.OS === 'web') return null;
  if (_mediaStoreMod) return _mediaStoreMod;
  try { _mediaStoreMod = require('./mediaStore'); } catch { _mediaStoreMod = null; }
  return _mediaStoreMod;
}
// Mídia de CONVERSA (vai pro store permanente mesmo sem conversationId).
// Status/feed/reels/GIF externos seguem no cacheDirectory (transitório).
function _isChatMediaUrl(url) {
  if (typeof url !== 'string') return false;
  return /\/data\/chat-files\//.test(url) || /^https?:\/\/media\.chatyy\.com\.br\/chat\//i.test(url)
    // [2026-10-14 offline-media] mídia importada do WhatsApp também é de conversa
    // → store permanente (antes ia p/ o cacheDirectory purgável pelo iOS).
    || /[?&]action=wa_import_file(&|$)/.test(url);
}

// [2026-10-14 wa-audio-m4a] Áudio importado do WhatsApp (OGG/Opus) não toca no
// iOS. O servidor serve uma cópia AAC (.m4a) — pedimos explicitamente com
// &fmt=m4a: URL nova = chave de cache nova (o .opus antigo já baixado no
// aparelho é ignorado) e o arquivo local ganha a extensão .m4a.
export function playableAudioUrl(url) {
  if (typeof url !== 'string' || !url) return url;
  if (!/[?&]action=wa_import_file(&|$)/.test(url) || /[?&]fmt=/.test(url)) return url;
  const i = url.indexOf('#');
  return i >= 0 ? url.slice(0, i) + '&fmt=m4a' + url.slice(i) : url + '&fmt=m4a';
}

// Content-Type → extensão (p/ arquivo baixado de URL sem extensão).
const _CT_EXT = {
  'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'image/heic': 'heic', 'image/heif': 'heif', 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/3gpp': '3gp',
  'video/webm': 'webm', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac', 'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg', 'audio/wav': 'wav', 'audio/amr': 'amr', 'application/pdf': 'pdf', 'text/vcard': 'vcf',
  'text/plain': 'txt', 'text/csv': 'csv', 'application/zip': 'zip',
  'application/msword': 'doc', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt', 'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};
function _extFromContentType(ct) {
  const k = String(ct || '').split(';')[0].trim().toLowerCase();
  return _CT_EXT[k] || null;
}
function _extFromFileName(name) {
  const m = String(name || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/);
  return m ? m[1] : null;
}

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
      // [2026-10-07 coldstart] The disk re-scan (initSyncCache) no longer runs
      // before first paint, so guard here against the one case it fixed: after
      // an app update/reinstall iOS can move the sandbox (new container UUID)
      // and the absolute paths persisted last session point nowhere. Only
      // accept entries under the CURRENT cache/saved dirs; stale ones are
      // dropped (render falls back to the remote URL, exactly like a miss)
      // until the post-paint scan re-adds them with the right prefix.
      let okPrefixes = null;
      try {
        const c = getCacheDir(); const sdir = getSavedDir();
        let sroot = null; try { sroot = _store()?.rootDir?.() || null; } catch {}
        okPrefixes = [c, sdir, sroot].filter(Boolean);
        if (!okPrefixes.length) okPrefixes = null;
      } catch { okPrefixes = null; }
      let n = 0;
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v !== 'string') continue;
        if (okPrefixes && !okPrefixes.some(p => v.startsWith(p))) continue;
        syncIndex.set(k, v); n++;
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
      let json = JSON.stringify(obj);
      // [2026-10-06 android-storage-ceiling] mmkv refuses values > 1.5 MB on
      // Android (CursorWindow). Keep the newest entries (Map insertion order)
      // so the index keeps persisting instead of freezing at an old snapshot.
      const cap = Math.floor((mmkv.MAX_VALUE_BYTES || 1572864) * 0.8);
      if (json.length > cap / 3) {
        const entries = Object.entries(obj);
        let keep = entries.length;
        while (keep > 0 && (mmkv.utf8Bytes ? mmkv.utf8Bytes(json) : json.length * 3) > cap) {
          keep = Math.floor(keep * 0.8);
          json = JSON.stringify(Object.fromEntries(entries.slice(entries.length - keep)));
        }
      }
      mmkv.setString?.(INDEX_MMKV_KEY, json);
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
    // SDK 55: legacy export retains downloadAsync. The new File/Directory
    // API at the default export drops it, so calls become no-ops and
    // local_path never persists → offline media stays broken (2026-05-20).
    try { FileSystem = require('expo-file-system/legacy'); } catch { try { FileSystem = require('expo-file-system'); } catch { return null; } }
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
//
// [#1239 2026-05-20] Host normalization. api.getMediaUrl rewrites
// `chatyy.com.br/data/chat-files/x.jpg` → `media.chatyy.com.br/data/chat-files/x.jpg`,
// so the SAME physical R2 object can show up under either hostname depending
// on where it was first observed (WS payload vs hydrate vs prefetch). Hashing
// the full URL meant the prefetch saved under host A while the render lookup
// hit host B → eternal cache miss + every paint re-downloads. Strip known CDN
// aliases before hashing so both URLs collide on the same key.
function _normalizeForKey(url) {
  try {
    const u = new URL(String(url));
    const host = u.hostname.toLowerCase();
    if (
      host === 'media.chatyy.com.br' ||
      host === 'chatyy.com.br' ||
      host === 'www.chatyy.com.br' ||
      host === 'mail.onemundo.com.br' ||
      // [2026-10-08 media-local-store] edges regionais servem o MESMO arquivo
      // (/data/* via proxy) → mesma chave que a origem/CDN.
      /^api(-[a-z]+)?(-edge)?\.chatyy\.com\.br$/.test(host)
    ) {
      // Path-only key — host stripped, query/fragment dropped by the caller.
      // [2026-10-13] …exceto endpoints dinâmicos (*.php / /api/): a query é que
      // identifica o arquivo (urlToKey filtra os parâmetros voláteis).
      if (/\.php$/i.test(u.pathname) || /\/api\//i.test(u.pathname)) return u.pathname + (u.search || '');
      return u.pathname;
    }
    return String(url);
  } catch {
    return String(url);
  }
}
// Stable ~128-bit non-cryptographic key for a string. The previous key used a
// single 32-bit djb2 hash (`Math.abs(hash).toString(36)`) — only ~31 usable
// bits, so two distinct media URLs could collide on the SAME cache filename
// and the cache would happily serve the WRONG media. We fold the string
// through FOUR independent 32-bit lanes (FNV-1a, djb2, sdbm, golden-ratio
// mixer), each avalanched, and concatenate them to a 32-char hex string =
// 128 bits of key space. Kept fully synchronous + dependency-free (no
// expo-crypto async digest) so urlToKey stays callable inside render closures
// (getLocalUriSyncJs). NOTE: this changes the filename for every URL, so the
// first run after this lands re-derives keys — pre-existing files under the
// old key are simply orphaned and get re-downloaded / LRU-reclaimed once.
function _hash128(str) {
  let h1 = 0x811c9dc5;       // FNV-1a offset basis
  let h2 = 5381;             // djb2
  let h3 = 0;                // sdbm
  let h4 = 0x9e3779b9;       // golden-ratio seed
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = ((h2 << 5) + h2) + c;          // h2*33 + c
    h3 = c + (h3 << 6) + (h3 << 16) - h3;
    h4 = Math.imul(h4 ^ c, 0x85ebca6b);
    h4 ^= h4 >>> 13;
  }
  // Final avalanche per lane so trailing-byte differences spread across bits.
  h1 ^= h1 >>> 15; h2 ^= h2 >>> 13; h3 ^= h3 >>> 7; h4 ^= h4 >>> 16;
  const u = (x) => (x >>> 0).toString(16).padStart(8, '0');
  return u(h1) + u(h2) + u(h3) + u(h4);
}
function urlToKey(url) {
  // Normalize host BEFORE stripping query/fragment so cross-host aliases
  // (CDN vs origin) hash to the same key. See _normalizeForKey for why.
  const normalized = _normalizeForKey(url);
  // Strip query/fragment so signed-URL token rotation (e.g. `?X-Amz-…&Expires=…`)
  // doesn't bust the cache. Same R2/CDN object with a fresh signature must hit
  // the same local file. Anything that's ACTUALLY a different resource will
  // have a different path component.
  let base = normalized.split('?')[0].split('#')[0];
  // [2026-10-13] Endpoints dinâmicos (…/api/*.php?action=…&m=ID) identificam o
  // ARQUIVO pela query (ex.: mídia importada do WhatsApp: wa_import_file&m=174).
  // Sem a query, TODAS as mídias importadas viravam a MESMA chave de cache →
  // fotos/áudios trocados ou em branco. Mantém a query (sem parâmetros voláteis
  // de assinatura/expiração) só nesses endpoints; CDN/R2 seguem sem query.
  if (/\.php$/i.test(base) || /\/api\//i.test(base)) {
    const q = normalized.split('#')[0].split('?')[1] || '';
    if (q) {
      const keep = q.split('&').filter((kv) => kv && !/^(x-amz-[^=]*|expires|exp|ts|t|token|sig|signature|_)=/i.test(kv)).sort().join('&');
      if (keep) base = base + '?' + keep;
    }
  }
  let ext = base.split('?')[0].match(
    /\.(jpg|jpeg|png|gif|webp|heic|heif|bmp|tiff|mp4|mov|webm|mkv|m4v|3gp|avi|mp3|m4a|ogg|opus|wav|aac|flac|tgs|pdf|doc|docx|xls|xlsx|ppt|pptx|zip|rar|7z|txt|csv|json)$/i
  )?.[1] || 'bin';
  // [2026-10-14 wa-audio-m4a] endpoint dinâmico com formato pedido (&fmt=m4a).
  if (ext === 'bin') { const f = base.match(/[?&]fmt=(m4a|mp4)(&|$)/i); if (f) ext = f[1].toLowerCase(); }
  return _hash128(base) + '.' + ext;
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
  // [2026-10-08 media-local-store] 1º o store permanente DA CONTA ATIVA; depois
  // o syncIndex legado — ignorando arquivo do store de OUTRA conta.
  const st = _store();
  if (st) {
    try {
      const p = st.lookupByUrlKey(key);
      if (p) return p;
    } catch {}
  }
  const p2 = syncIndex.get(key) || null;
  if (p2 && st) { try { if (st.isForeignPath(p2)) return null; } catch {} }
  return p2;
}

// Arquivo local de uma MENSAGEM (store permanente da conta ativa), mesmo se a
// URL mudou (ex.: "Baixar de novo" devolveu URL nova). Sync, zero I/O.
export function getLocalUriForMessage(messageId) {
  if (messageId == null || Platform.OS === 'web') return null;
  try { return _store()?.lookupByMessage(messageId) || null; } catch { return null; }
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
    // [2026-10-08 media-local-store] Só varre entradas dos dirs planos
    // (cache/saved). Entradas do store permanente (media/<conta>/...) têm nome
    // <msgId>.<ext> ≠ chave → antes seriam apagadas aqui por engano.
    const _flatDirs = [getCacheDir(), getSavedDir()].filter(Boolean);
    for (const key of [...syncIndex.keys()]) {
      const v = syncIndex.get(key);
      const inFlat = typeof v === 'string' && _flatDirs.some(d => v.startsWith(d));
      if (inFlat && !liveKeys.has(key)) {
        syncIndex.delete(key);
        changed = true;
      }
    }
    try {
      const st = _store();
      if (st) {
        for (const [k, p] of st.entriesForSyncIndex()) {
          if (syncIndex.get(k) !== p) { syncIndex.set(k, p); changed = true; }
        }
      }
    } catch {}
    if (changed) _schedulePersistIndex();
    // Promove (1×, em background) mídia de conversa que ainda está no
    // cacheDirectory purgável p/ o store permanente.
    try { setTimeout(() => { _migrateLegacyCacheToStore().catch(() => {}); }, 8000); } catch {}
    // [2026-10-12 P0 view-once] limpeza única de view-once já gravado.
    try { setTimeout(() => { runViewOnceCacheCleanupOnce().catch(() => {}); }, 12000); } catch {}
    // [2026-10-13 delete-for-all] mídia de mensagens apagadas que ficou no disco.
    try { setTimeout(() => { runDeletedMediaSweep().catch(() => {}); }, 15000); } catch {}
    // [2026-10-14 offline-media] arquivos ".bin" antigos (mídia importada) → extensão real.
    try { setTimeout(() => { _fixBinExtOnce().catch(() => {}); }, 20000); } catch {}
  })();
  return syncInitPromise;
}

// [2026-10-14 offline-media] Store com arquivos "<id>.bin" (URL sem extensão,
// ex.: wa_import_file) → o iOS não abre vídeo/documento/áudio .bin. Detecta o
// tipo pelos primeiros bytes e renomeia (1× por sessão, em lotes).
let _binFixDone = false;
function _extFromMagic(b64) {
  let bin = '';
  try { bin = typeof atob === 'function' ? atob(b64) : ''; } catch { bin = ''; }
  if (!bin && typeof Buffer !== 'undefined') { try { bin = Buffer.from(b64, 'base64').toString('binary'); } catch {} }
  if (!bin || bin.length < 12) return null;
  const at = (i) => bin.charCodeAt(i);
  const str = (i, n) => bin.substr(i, n);
  if (at(0) === 0xFF && at(1) === 0xD8) return 'jpg';
  if (str(1, 3) === 'PNG') return 'png';
  if (str(0, 4) === 'GIF8') return 'gif';
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WEBP') return 'webp';
  if (str(0, 4) === 'RIFF' && str(8, 4) === 'WAVE') return 'wav';
  if (str(0, 4) === '%PDF') return 'pdf';
  if (str(0, 4) === 'OggS') return 'ogg';
  if (str(0, 3) === 'ID3' || (at(0) === 0xFF && (at(1) & 0xE0) === 0xE0)) return 'mp3';
  if (str(4, 4) === 'ftyp') {
    const brand = str(8, 4);
    if (brand === 'M4A ' || brand === 'M4B ') return 'm4a';
    if (brand === 'qt  ') return 'mov';
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return 'heic';
    return 'mp4';
  }
  if (str(0, 5) === 'BEGIN') return 'vcf';
  return null;
}
async function _fixBinExtOnce() {
  if (_binFixDone || Platform.OS === 'web') return;
  _binFixDone = true;
  const fs = getFS(); const st = _store();
  if (!fs || !st || typeof st.listBinEntries !== 'function') return;
  const list = st.listBinEntries(500);
  const renamed = [];
  for (const it of list) {
    try {
      if (!it.abs) continue;
      const head = await fs.readAsStringAsync(it.abs, { encoding: 'base64', position: 0, length: 16 });
      const ext = _extFromMagic(head);
      if (!ext) continue;
      const to = it.abs.replace(/\.bin$/i, '.' + ext);
      await fs.moveAsync({ from: it.abs, to });
      const nAbs = st.setEntryExt(it.c, it.k, ext);
      if (nAbs && it.urlKey) syncIndex.set(it.urlKey, nAbs);
      renamed.push(it.abs.split('/').slice(-2).join('/'));
    } catch {}
  }
  // local_path antigo (".bin") no SQLite → NULL (o render resolve pelo índice).
  if (renamed.length) { try { require('./db').dbClearLocalPathByFilenames?.(renamed)?.catch?.(() => {}); } catch {} }
  _schedulePersistIndex();
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
  try { const _s0 = _store(); const sp = _s0?.lookupByUrlKey(key); if (sp) { try { _s0.touch?.(key); } catch {} return sp; } } catch {}
  // Fast path: if syncIndex already knows where the file lives (e.g. scanned
  // by initSyncCache at boot or registered by cacheMedia mid-session), skip
  // the fs.getInfoAsync round-trip and the getSavedDir fallback below.
  const indexed = syncIndex.get(key);
  if (indexed && !_store()?.isForeignPath?.(indexed)) return indexed;

  // Check BOTH locations — saveMediaPermanent writes to documentDirectory
  // while cacheMedia writes to cacheDirectory. Only checking the cache dir
  // (the old behavior) meant permanently-saved media got re-downloaded
  // every app launch because it was invisible to this lookup path.
  for (const dir of [getCacheDir(), getSavedDir()]) {
    if (!dir) continue;
    const localPath = dir + key;
    try {
      const info = await fs.getInfoAsync(localPath);
      // Integrity check: a file that exists but is 0 bytes is a corrupt /
      // truncated download — serving it gives a permanently-blank bubble.
      // Only accept non-empty files; evict the empty one so cacheMedia
      // re-downloads cleanly on the next request.
      if (info.exists && info.size > 0) {
        registerSyncKey(url, localPath);
        return localPath;
      }
      if (info.exists) {
        try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
        syncIndex.delete(key);
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

// [2026-10-14 dl-progress] Progresso de download (vídeo/documento grandes) p/ a
// bolha mostrar o anel com % + "3,2 / 12 MB" igual WhatsApp — antes o auto-
// download (WS/lista) baixava em silêncio e a bolha só mostrava o play.
// Eventos: { key, url, messageId, state:'queued'|'progress'|'done'|'failed'|'cancelled',
//            pct (0-100), loaded, total, local }.
const _dlProgress = new Map(); // key → último evento (só enquanto em andamento)
const _dlProgressSubs = new Set();
const _dlCancelFns = new Map(); // key → () => void
const _dlUserCancelled = new Set(); // keys canceladas pelo usuário → auto-download não religa
function _emitDlProgress(key, ev) {
  const e = { key, ...ev };
  if (e.state === 'done' || e.state === 'failed' || e.state === 'cancelled') _dlProgress.delete(key);
  else {
    const prev = _dlProgress.get(key);
    // Throttle: só re-emite quando o % inteiro muda (bg/resumable chamam várias vezes/s).
    if (prev && prev.state === e.state && Math.floor(prev.pct || 0) === Math.floor(e.pct || 0)) { _dlProgress.set(key, e); return; }
    _dlProgress.set(key, e);
  }
  for (const cb of Array.from(_dlProgressSubs)) { try { cb(e); } catch {} }
}
export function subscribeDownloadProgress(cb) {
  if (typeof cb !== 'function') return () => {};
  _dlProgressSubs.add(cb);
  return () => { _dlProgressSubs.delete(cb); };
}
/** Chave de cache da URL (a mesma dos eventos de progresso). */
export function mediaUrlKey(url) {
  try { return url ? urlToKey(url) : null; } catch { return null; }
}
export function listDownloadProgress() { return Array.from(_dlProgress.values()); }
export function getDownloadProgress(url) {
  const k = mediaUrlKey(url);
  return k ? (_dlProgress.get(k) || null) : null;
}
/** Usuário tocou no X do anel: aborta o download em andamento (bg nativo ou
 *  resumable JS), apaga o parcial e impede o auto-download de religar. */
export function cancelDownload(url) {
  const k = mediaUrlKey(url);
  if (!k) return false;
  _dlUserCancelled.add(k);
  const fn = _dlCancelFns.get(k);
  if (fn) { try { fn(); } catch {} return true; }
  return false;
}

// ── [2026-10-15 native-media-dl] Download feito pela LISTA NATIVA ─────────
// A lista de mensagens nativa (modules/expo-chat-message-list, apiVersion 5)
// baixa a mídia recebida com progresso real (URLSession/OkHttp) direto em
// getCacheDir() + urlToKey(url) — o MESMO arquivo que cacheMedia procuraria.
// begin → cacheMedia da mesma URL espera o nativo (sem download duplicado);
// finish → adota o arquivo (syncIndex + store da conversa + galeria + local_path).
const _extResolvers = new Map(); // key → resolve(path|url)
/** Pasta (file://…/) onde o nativo grava. null no web. */
export function getMediaCacheDirUri() { try { return getCacheDir(); } catch { return null; } }
/** Hosts alternativos da mesma mídia (edge → origem → CDN). */
export function fallbackUrlsFor(url) { return url ? _fallbackUrls(url) : []; }
/** Promise do download JS em andamento desta URL (null = nenhum). */
export function getInflightDownload(url) {
  const k = mediaUrlKey(url);
  return k ? (_inflightDownloads.get(k) || null) : null;
}
/** Nativo começou a baixar `url`. false = o JS já baixava (não marca). */
export function beginExternalDownload(url) {
  if (!url || Platform.OS === 'web') return false;
  const key = mediaUrlKey(url);
  if (!key || _inflightDownloads.has(key)) return false;
  let res = null;
  const p = new Promise((r) => { res = r; });
  const fin = (v) => {
    if (_extResolvers.get(key) !== fin) return;
    _extResolvers.delete(key);
    if (_inflightDownloads.get(key) === p) _inflightDownloads.delete(key);
    try { res(v); } catch {}
  };
  _extResolvers.set(key, fin);
  _inflightDownloads.set(key, p);
  // rede longa / app em segundo plano: nunca prende o cacheMedia p/ sempre
  setTimeout(() => fin(url), 10 * 60 * 1000);
  return true;
}
/**
 * Nativo terminou. local = file:// (ok) ou null (falhou/cancelou).
 * opts: { messageId, conversationId, mediaType, received, noStore }.
 * Devolve o caminho final (pode ter ido p/ o store da conversa) ou null.
 */
export async function finishExternalDownload(url, local, opts = {}) {
  if (!url || Platform.OS === 'web') return null;
  const key = mediaUrlKey(url);
  if (!key) return null;
  const fin = _extResolvers.get(key);
  let result = null;
  try {
    if (typeof local === 'string' && local) {
      const fs = getFS();
      const p = local.startsWith('file://') ? local : ('file://' + local);
      let ok = false;
      try { const st = fs ? await fs.getInfoAsync(p) : null; ok = !!(st && st.exists && st.size > 0); } catch {}
      if (ok) {
        if (!opts.noStore) {
          const plan = _planStore(url, key, opts);
          if (plan && fs) { try { result = await _promoteToStore(fs, p, plan, url, key, opts); } catch { result = null; } }
        }
        if (!result) { registerSyncKey(url, p); result = p; }
        _dlFailStatus.delete(key);
        _dlUserCancelled.delete(key);
        _countDownloadedBytes(fs, result);
        if (opts.received && !opts.noStore) {
          try { maybeAutoSaveToGallery(result, key, opts.mediaType || _bucketForUrl(url), { messageId: opts.messageId, url, conversationId: opts.conversationId }); } catch {}
        }
        if (opts.messageId != null && opts.conversationId != null && !opts.noStore) {
          try {
            const nativeDb = require('./db');
            if (typeof nativeDb.dbUpdateMessageFields === 'function') {
              await nativeDb.dbUpdateMessageFields(opts.conversationId, opts.messageId, { local_path: result });
            }
          } catch {}
        }
      }
    }
  } finally {
    if (fin) fin(result || url);
  }
  if (result) _emitDlProgress(key, { url, messageId: opts.messageId != null ? opts.messageId : null, state: 'done', pct: 100, loaded: 0, total: 0, local: result });
  // [2026-10-21 tg3] download nativo também respeita o limite do cache (debounce 5 min).
  if (result) { try { evictIfNeeded(); } catch {} }
  return result;
}

// [#1218 2026-05-20] WhatsApp-parity reconnect sweep.
// When the network is 'none' or 'unknown', cacheMedia's auto-download gate
// returns the remote URL (= unsaved). WhatsApp records these and flushes
// them when the radio comes back. Without this, a voice note that arrived
// during a subway dip stays unviewable until the user manually taps Play —
// which surfaces the dreaded "sem internet, mídia não baixada" toast.
//
// Map key is the urlToKey() bucket so the dedup matches cacheMedia's own
// inflight set. Value carries enough context (messageId, conversationId,
// isAudio) to redispatch into the right path on reconnect.
const _deferredMedia = new Map(); // key → { url, messageId, conversationId, isAudio }

export function _enqueueDeferred(url, opts = {}) {
  if (!url || Platform.OS === 'web') return;
  try {
    const key = urlToKey(url);
    if (_deferredMedia.has(key)) return;
    _deferredMedia.set(key, {
      url,
      messageId: opts.messageId ?? null,
      conversationId: opts.conversationId ?? null,
      isAudio: !!opts.isAudio,
    });
  } catch {}
}

function _drainDeferred() {
  if (!_deferredMedia.size) return;
  const items = Array.from(_deferredMedia.values());
  _deferredMedia.clear();
  for (const item of items) {
    try {
      if (item.isAudio) {
        // Voice notes — bypass gate (always download, see audioCache).
        prefetchAudioMessage(item.url, {
          messageId: item.messageId,
          conversationId: item.conversationId,
        });
      } else {
        const _opts = {};
        if (item.messageId != null) _opts.messageId = item.messageId;
        if (item.conversationId != null) _opts.conversationId = item.conversationId;
        // Don't force — respect the user's auto-download policy. The user
        // already saw the bubble; if they wanted it on cellular they'd have
        // toggled the bucket. We just retry when their original network gate
        // would have passed (e.g. they're back on wifi).
        cacheMedia(item.url, _opts).catch(() => {});
      }
    } catch {}
  }
}

// Subscribe once to network change. Re-fire the deferred queue any time we
// transition from disconnected → connected (or unknown → wifi/cellular).
if (Platform.OS !== 'web' && !globalThis.__mediaCache_reconnect_sub) {
  try {
    const ni = require('./networkInfo');
    if (typeof ni.onNetworkChange === 'function') {
      let prevState = ni.getNetworkState?.() || { type: 'unknown', isConnected: true };
      globalThis.__mediaCache_reconnect_sub = ni.onNetworkChange((state) => {
        const wasOffline = prevState.type === 'none' || prevState.type === 'unknown' || !prevState.isConnected;
        const nowOnline = state.isConnected && (state.type === 'wifi' || state.type === 'cellular' || state.type === 'ethernet');
        if (wasOffline && nowOnline) _drainDeferred();
        prevState = state;
      });
    }
  } catch {}
}


// Concurrency throttle — cap simultaneous network downloads so a burst of
// WS-driven prefetches (e.g. 30 messages syncing after reconnect) doesn't
// saturate the radio + heap. WhatsApp parity: small parallel pool, queue
// the rest. 3 is the sweet spot for mobile HTTP/2 — enough to overlap TLS
// handshakes but low enough to leave headroom for foreground requests
// (avatar fetch, message sends, etc).
const _MAX_CONCURRENT_DOWNLOADS = 3;
let _activeDownloads = 0;
// [PRIORITY LANES 2026-05-26] Two waiter queues instead of one FIFO. The
// on-demand / visible-viewport path (a bubble the user is looking at, a
// tap-to-download, a redownload) MUST jump ahead of the background prefetch
// firehose (WS auto-prefetch, mediaAutoSync sweep, full-history backfill).
// Before this, a burst of 30 inbound-message prefetches could grab all 3
// slots and the foreground image the user is staring at would sit behind
// them — perceived as "the photo I opened won't load". The high lane is
// always drained first; prefetch only gets a slot when no foreground request
// is waiting. Behavior (which files get cached, persistence) is unchanged —
// only the ORDER under contention changes.
const _hiWaiters = [];  // FIFO queue of resolve fns — foreground/on-demand
const _loWaiters = [];  // FIFO queue of resolve fns — background prefetch

function _acquireDownloadSlot(priority) {
  if (_activeDownloads < _MAX_CONCURRENT_DOWNLOADS) {
    _activeDownloads++;
    return Promise.resolve();
  }
  const q = priority === 'low' ? _loWaiters : _hiWaiters;
  return new Promise(resolve => q.push(resolve));
}

function _releaseDownloadSlot() {
  // Drain the high-priority lane first so foreground/on-demand downloads
  // never starve behind a backlog of background prefetches.
  const next = _hiWaiters.shift() || _loWaiters.shift();
  if (next) {
    // Hand the slot directly to the next waiter (no decrement → no race).
    try { next(); } catch { _activeDownloads--; }
  } else {
    _activeDownloads--;
    if (_activeDownloads < 0) _activeDownloads = 0;
  }
}

// [P2 concurrency 2026-05-26] Public funnel for the shared download semaphore.
// cacheMedia/saveMediaPermanent already gate every network download through the
// internal _acquire/_releaseDownloadSlot pair (cap _MAX_CONCURRENT_DOWNLOADS),
// so any caller that routes its downloads through cacheMedia is ALREADY
// throttled by this single source. These exports let external schedulers (e.g.
// mediaAutoSync's own worker pool) that perform raw fs.downloadAsync calls
// outside cacheMedia funnel through the SAME slot pool instead of opening an
// independent N-way pool that contends with foreground fetches. Always pair an
// acquire with exactly one release (use try/finally). No-op-safe on web.
export function acquireDownloadSlot(priority) {
  if (Platform.OS === 'web') return Promise.resolve();
  // External callers default to the high lane (current behavior). Pass
  // 'low' to yield to foreground/on-demand downloads (e.g. a background
  // backfill worker that shouldn't out-compete a visible image).
  return _acquireDownloadSlot(priority);
}
export function releaseDownloadSlot() {
  if (Platform.OS === 'web') return;
  _releaseDownloadSlot();
}
// Read-only accessor so a caller can size its own queue to match the shared
// pool rather than hard-coding a higher number that just waits on the gate.
export function getMaxConcurrentDownloads() {
  return _MAX_CONCURRENT_DOWNLOADS;
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
  // ── Translate the legacy enum prefs into the matrix policy ──────────────
  // settings.js writes these `media_auto_dl_*` enums via this setter, but the
  // real gate (shouldAutoDownload) reads the `_autoDlPolicy` MATRIX set by
  // setAutoDownloadPolicy. Without this bridge the settings pills did nothing.
  // We start from the CURRENT matrix (so untouched buckets keep their cells)
  // and overlay the columns the enum/roaming flag imply, then push the result
  // through setAutoDownloadPolicy — the single source of truth for the gate.
  // [2026-10-20 media-wa] só os tipos que ESTE patch trouxe (antes reescrevia os 4
  // a partir dos enums locais — padrão fotos/áudio Wi-Fi, vídeo/docs nunca — e
  // mudar 1 linha/roaming desligava "dados móveis" dos outros até o servidor reaplicar).
  _syncEnumPrefsToPolicy(Object.keys(patch));
}

// Bucket enum → matrix columns. wifi-only, wifi+mobile, or none. Roaming is
// folded in separately from the media_auto_dl_roaming flag so the user's
// "auto-download while roaming" master switch controls the roaming column
// across every bucket at once.
const _ENUM_TO_COLUMNS = {
  wifi:   { wifi: 1, mobile: 0 },
  mobile: { wifi: 1, mobile: 1 },
  never:  { wifi: 0, mobile: 0 },
};
// Map the legacy pref key → matrix bucket name.
const _PREF_KEY_TO_BUCKET = {
  media_auto_dl_photos: 'photos',
  media_auto_dl_audio:  'audio',
  media_auto_dl_videos: 'videos',
  media_auto_dl_docs:   'documents',
};

function _syncEnumPrefsToPolicy(changedKeys) {
  // Clone the current matrix so untouched cells survive the merge.
  const next = JSON.parse(JSON.stringify(_autoDlPolicy || _defaultPolicy));
  const roamingOn = _mediaDlPrefs.media_auto_dl_roaming === true ? 1 : 0;
  const only = Array.isArray(changedKeys) ? changedKeys : null;
  for (const [prefKey, bucket] of Object.entries(_PREF_KEY_TO_BUCKET)) {
    if (!next[bucket]) next[bucket] = { mobile: 0, wifi: 0, roaming: 0 };
    const cols = (!only || only.includes(prefKey)) ? _ENUM_TO_COLUMNS[_mediaDlPrefs[prefKey]] : null;
    if (cols) {
      next[bucket].wifi = cols.wifi;
      next[bucket].mobile = cols.mobile;
    }
    // The roaming flag drives the roaming column across ALL buckets. We only
    // allow roaming where the bucket also permits mobile (roaming IS mobile,
    // just metered) — so a 'wifi'/'never' bucket stays off while roaming.
    next[bucket].roaming = (roamingOn && next[bucket].mobile) ? 1 : 0;
  }
  // Route through the single source of truth so the gate + persistence stay
  // consistent with direct setAutoDownloadPolicy() callers.
  // [2026-10-13 P1-2] Escolha explícita do usuário → nunca promover depois.
  _markAutoDlMigDone();
  setAutoDownloadPolicy(next);
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

// ── WhatsApp auto-download policy matrix (4 buckets × 3 network columns) ──
//
// Replaces the older per-bucket enum ('wifi'|'mobile'|'never') with a full
// matrix the user toggles per cell. The legacy `_mediaDlPrefs` is still
// honored as a fallback when the matrix is empty (first launch, or until
// chat_get_user_defaults hydrates).
//
// Shape (server side stores this exact JSONB):
//   { photos:    { mobile: 1|0, wifi: 1|0, roaming: 1|0 },
//     audio:     { mobile: 1|0, wifi: 1|0, roaming: 1|0 },
//     videos:    { mobile: 1|0, wifi: 1|0, roaming: 1|0 },
//     documents: { mobile: 1|0, wifi: 1|0, roaming: 1|0 } }
//
// Defaults match WhatsApp factory:
//   - roaming everywhere OFF (the column the user toggles when traveling)
//   - mobile: photos + audio ON, videos + documents OFF
//   - wifi: ALL ON
const AUTO_DL_POLICY_KEY = 'chatyy:auto_download_policy';
const _defaultPolicy = {
  photos:    { mobile: 1, wifi: 1, roaming: 0 },
  audio:     { mobile: 1, wifi: 1, roaming: 0 },
  // [2026-10-12 founder] vídeo baixa sozinho também nos dados móveis (como foto/
  // áudio/figurinha) p/ abrir offline. Ajustes > Armazenamento ainda permite desligar.
  videos:    { mobile: 1, wifi: 1, roaming: 0 },
  documents: { mobile: 0, wifi: 1, roaming: 0 },
};
// Matriz padrão ANTIGA (vídeo só Wi-Fi). [2026-10-13 P1-2] Promovida ao padrão
// novo UMA vez (flag persistida AUTO_DL_MIG_KEY) na primeira hidratação após a
// OTA (local ou, sem cache local, a 1ª matriz do servidor). Depois nunca mais:
// quem voltar vídeo p/ "só Wi-Fi" é respeitado.
const _OLD_DEFAULT_SIG = '1,1,0|1,1,0|0,1,0|0,1,0';
const AUTO_DL_MIG_KEY = 'autoDlPolicyMig.v2';
let _autoDlMigState = 'unknown'; // 'unknown' (lendo) | 'pending' | 'done'
let _autoDlSetBeforeHydrate = false;
function _policySig(p) {
  try { return ['photos', 'audio', 'videos', 'documents'].map(k => [p[k].mobile, p[k].wifi, p[k].roaming].join(',')).join('|'); } catch { return ''; }
}
function _markAutoDlMigDone() {
  if (_autoDlMigState === 'done') return;
  _autoDlMigState = 'done';
  if (Platform.OS === 'web') return;
  try {
    import('@react-native-async-storage/async-storage').then(m => {
      m.default.setItem(AUTO_DL_MIG_KEY, '1').catch(() => {});
    }).catch(() => {});
  } catch {}
}
// Aplica a promoção única (muta e devolve p) e grava a flag.
function _applyAutoDlMigration(p) {
  if (_autoDlMigState === 'done') return p;
  if (_policySig(p) === _OLD_DEFAULT_SIG) p.videos.mobile = 1;
  _markAutoDlMigDone();
  return p;
}
let _autoDlPolicy = JSON.parse(JSON.stringify(_defaultPolicy));
let _autoDlPolicyHydrated = false;
// 60s cache so the gate can be queried at message-pump rate without parsing
// the matrix from disk. Refreshed on every setAutoDownloadPolicy call.
let _autoDlPolicyCacheStamp = 0;

function _coerceCell(v) { return v === 1 || v === true || v === '1' || v === 'true' ? 1 : 0; }

function _normalizePolicy(raw) {
  const out = JSON.parse(JSON.stringify(_defaultPolicy));
  if (!raw || typeof raw !== 'object') return out;
  for (const bucket of ['photos', 'audio', 'videos', 'documents']) {
    const cell = raw[bucket];
    if (cell && typeof cell === 'object') {
      for (const col of ['mobile', 'wifi', 'roaming']) {
        if (col in cell) out[bucket][col] = _coerceCell(cell[col]);
      }
    }
  }
  return out;
}

function _hydrateAutoDlPolicy() {
  if (_autoDlPolicyHydrated) return;
  _autoDlPolicyHydrated = true;
  if (Platform.OS === 'web') return;
  try {
    import('@react-native-async-storage/async-storage').then(m => {
      Promise.all([
        m.default.getItem(AUTO_DL_POLICY_KEY).catch(() => null),
        m.default.getItem(AUTO_DL_MIG_KEY).catch(() => null),
      ]).then(([raw, mig]) => {
        if (mig === '1') _autoDlMigState = 'done';
        else if (_autoDlMigState === 'unknown') _autoDlMigState = 'pending';
        // Servidor/usuário já setou antes da leitura → vale o mais novo.
        if (_autoDlSetBeforeHydrate) {
          if (_autoDlMigState === 'pending') { _applyAutoDlMigration(_autoDlPolicy); _persistAutoDlPolicy(); }
          return;
        }
        if (!raw) return; // sem cache local: decide na 1ª matriz do servidor
        try {
          const parsed = JSON.parse(raw);
          const p = _normalizePolicy(parsed);
          const wasPending = _autoDlMigState === 'pending';
          _autoDlPolicy = _applyAutoDlMigration(p);
          _autoDlPolicyCacheStamp = Date.now();
          if (wasPending) _persistAutoDlPolicy();
        } catch {}
      }).catch(() => {});
    }).catch(() => {});
  } catch {}
}
_hydrateAutoDlPolicy();

function _persistAutoDlPolicy() {
  if (Platform.OS === 'web') return;
  try {
    import('@react-native-async-storage/async-storage').then(m => {
      m.default.setItem(AUTO_DL_POLICY_KEY, JSON.stringify(_autoDlPolicy)).catch(() => {});
    }).catch(() => {});
  } catch {}
}

/**
 * Replace the auto-download matrix. Called by ChatProfileTab after a
 * successful chat_set_auto_download_policy round-trip and also on startup
 * after chat_get_user_defaults returns. Accepts partial shapes — unspecified
 * cells fall through to defaults.
 */
export function setAutoDownloadPolicy(policy) {
  const p = _normalizePolicy(policy);
  if (_autoDlMigState === 'unknown') _autoDlSetBeforeHydrate = true;
  else if (_autoDlMigState === 'pending') _applyAutoDlMigration(p);
  _autoDlPolicy = p;
  _autoDlPolicyCacheStamp = Date.now();
  _persistAutoDlPolicy();
}

export function getAutoDownloadPolicy() {
  return JSON.parse(JSON.stringify(_autoDlPolicy));
}

// ── Data Saver master flag (settings.js `data_saver`) ─────────────────────
// When ON this is the most-restrictive override: auto-download behaves as if
// the network were Wi-Fi-only (mobile + roaming columns forced OFF) AND video
// pre-cache/preload is skipped entirely. ADDITIVE to the matrix policy — the
// strictest of (matrix cell, data_saver) wins. Persisted under the same plain
// `data_saver` key settings.js writes (localStorage on web, AsyncStorage on
// native), so flipping the toggle takes effect without a relaunch.
const DATA_SAVER_KEY = 'data_saver';
let _dataSaver = false;
let _dataSaverHydrated = false;

function _coerceDataSaver(v) {
  return v === true || v === 'true' || v === '1';
}

function _hydrateDataSaver() {
  if (_dataSaverHydrated) return;
  _dataSaverHydrated = true;
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') _dataSaver = _coerceDataSaver(localStorage.getItem(DATA_SAVER_KEY)); } catch {}
    return;
  }
  try {
    import('@react-native-async-storage/async-storage').then(m => {
      m.default.getItem(DATA_SAVER_KEY).then(raw => {
        if (raw != null) _dataSaver = _coerceDataSaver(raw);
      }).catch(() => {});
    }).catch(() => {});
  } catch {}
}
_hydrateDataSaver();

// Public read/refresh hooks. `refreshDataSaver` lets a screen re-read the KV
// on focus (settings.js writes it on toggle) so the gate stays fresh without
// a relaunch. Returns the resulting boolean.
export function isDataSaverOn() {
  _hydrateDataSaver();
  if (_dataSaver) return true;
  // [2026-10-09 system-integration] iOS Low Data Mode / Android Data Saver
  // behave like the in-app switch (no video pre-cache, other media Wi-Fi only).
  try { return !!require('./systemIntegration').isSystemDataSaverOn(); } catch { return false; }
}
export function setDataSaver(on) {
  _dataSaver = !!on;
  _dataSaverHydrated = true;
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(DATA_SAVER_KEY, String(_dataSaver)); } catch {}
  } else {
    try {
      import('@react-native-async-storage/async-storage').then(m => {
        m.default.setItem(DATA_SAVER_KEY, String(_dataSaver)).catch(() => {});
      }).catch(() => {});
    } catch {}
  }
  return _dataSaver;
}
export function refreshDataSaver() {
  // Force a re-read from storage (used on screen focus). Web is synchronous;
  // native is best-effort async (updates the cached flag when it lands).
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') _dataSaver = _coerceDataSaver(localStorage.getItem(DATA_SAVER_KEY)); } catch {}
    return _dataSaver;
  }
  try {
    import('@react-native-async-storage/async-storage').then(m => {
      m.default.getItem(DATA_SAVER_KEY).then(raw => {
        if (raw != null) _dataSaver = _coerceDataSaver(raw);
      }).catch(() => {});
    }).catch(() => {});
  } catch {}
  return _dataSaver;
}

// ── Auto-save received media to the phone gallery (WhatsApp "Media visibility") ──
//
// WhatsApp's "Save to camera roll" / "Media visibility" setting: every photo
// or video the user RECEIVES gets copied into the OS Photos app / camera roll
// automatically, so it's findable outside the chat. Default ON, like WhatsApp.
//
// Implementation notes:
//  - Setting persisted under AUTO_SAVE_GALLERY_KEY. Default true (ON). settings.js
//    flips it via setAutoSaveMediaToGallery(); the gate reads the cached flag
//    synchronously so the download success path doesn't await storage.
//  - Only IMAGE + VIDEO are saved (never audio / docs / stickers / gifs).
//  - De-dupe: a persisted Set of urlToKey() keys (MMKV) so the SAME photo is
//    never written to the gallery twice — critical, because cacheMedia can run
//    again on re-render / re-download / reconnect sweeps and would otherwise
//    spam the camera roll.
//  - RECEIVED-only: the caller (prefetchIncomingMessageMedia) sets opts.received
//    on the cacheMedia call. The ChatMedia render path (used for BOTH sent and
//    received bubbles) does NOT, so the user's own sent media — already in their
//    gallery — is never re-saved.
//  - Permission requested once via ML.requestPermissionsAsync(); if denied we
//    silently disable for the session (no alert spam, WhatsApp behavior).
//  - Grouped into a "Chatyy" album when straightforward (mirrors ChatMediaViewer).
const AUTO_SAVE_GALLERY_KEY = 'autoSaveMediaToGallery';
let _autoSaveGallery = true; // default ON (WhatsApp parity)
let _autoSaveGalleryHydrated = false;
// Session flag: flips false the moment we learn the OS denied photo-write
// permission, so we stop attempting saves (and stop re-prompting) until the
// app is relaunched / the user re-toggles.
let _autoSavePermDenied = false;

function _coerceAutoSaveGallery(v) {
  // Default ON: only an explicit 'false' / false turns it off.
  if (v === false || v === 'false' || v === '0') return false;
  return true;
}

function _hydrateAutoSaveGallery() {
  if (_autoSaveGalleryHydrated) return;
  _autoSaveGalleryHydrated = true;
  if (Platform.OS === 'web') return; // no gallery on web
  // Read from the same MMKV layer the dedupe Set uses so a single store covers
  // both. MMKV (services/mmkv) hydrates from AsyncStorage at splash; settings.js
  // also mirrors the flag into AsyncStorage directly, so we read both and let
  // an explicit stored value win over the default.
  try {
    const mmkv = require('./mmkv');
    const raw = mmkv.getBoolean?.(AUTO_SAVE_GALLERY_KEY);
    if (raw === true || raw === false) _autoSaveGallery = raw;
  } catch {}
  // AsyncStorage fallback (settings.js writes a plain 'true'/'false' string).
  try {
    import('@react-native-async-storage/async-storage').then(m => {
      m.default.getItem(AUTO_SAVE_GALLERY_KEY).then(raw => {
        if (raw != null) _autoSaveGallery = _coerceAutoSaveGallery(raw);
      }).catch(() => {});
    }).catch(() => {});
  } catch {}
}
_hydrateAutoSaveGallery();

export function isAutoSaveMediaToGalleryOn() {
  _hydrateAutoSaveGallery();
  return _autoSaveGallery;
}

// settings.js calls this on toggle. Persists to BOTH the MMKV layer (instant,
// survives restart) and AsyncStorage (so the hydrate fallback above + any other
// reader sees it). Re-enabling clears the session permission-denied latch so a
// user who fixed permissions in OS Settings gets saves again without relaunch.
export function setAutoSaveMediaToGallery(on) {
  const next = !!on;
  _autoSaveGallery = next;
  _autoSaveGalleryHydrated = true;
  if (next) _autoSavePermDenied = false;
  if (Platform.OS === 'web') return next;
  try { require('./mmkv').setBoolean?.(AUTO_SAVE_GALLERY_KEY, next); } catch {}
  try {
    import('@react-native-async-storage/async-storage').then(m => {
      m.default.setItem(AUTO_SAVE_GALLERY_KEY, String(next)).catch(() => {});
    }).catch(() => {});
  } catch {}
  return next;
}

// [2026-10-15 media-visibility] Mensagem enviada pela conta ativa?
function _isOwnMessage(m) {
  try {
    if (!m) return false;
    if (m.is_mine === true || m.isMine === true || m.from_me === true || m.fromMe === true) return true;
    const se = String(m.sender_email || m.sender || m.from_email || '').trim().toLowerCase();
    if (!se) return false;
    const me = _galleryAcct();
    return !!me && se === me;
  } catch { return false; }
}

// [2026-10-15 media-visibility] Religar (global/conversa) limpa o latch de
// "permissão negada" da sessão sem mexer na chave antiga do aparelho.
export function resetAutoSavePermLatch() { _autoSavePermDenied = false; }

// [2026-10-15 media-visibility] Decisão por CONTA + conversa (services/
// mediaVisibility: chat_settings.save_media_to_gallery[_convs]); sem valor na
// conta cai na chave antiga do aparelho (isAutoSaveMediaToGalleryOn).
function _galleryAllowed(cid, acct) {
  try { return !!require('./mediaVisibility').shouldSaveToGallery(cid, acct); } catch { return isAutoSaveMediaToGalleryOn(); }
}
function _galleryAcct() {
  try { return require('./mediaVisibility').activeAccount() || ''; } catch { return ''; }
}

// Persisted Set of already-saved media keys (urlToKey buckets). Lives in MMKV
// so it survives relaunch — without persistence, every cold start would re-save
// the entire visible history to the gallery.
const AUTO_SAVE_GALLERY_DONE_KEY = 'media_autosaved_gallery_v1';
const _autoSavedKeys = new Set();
let _autoSavedHydrated = false;
let _autoSavedPersistTimer = null;

function _hydrateAutoSavedKeys() {
  if (_autoSavedHydrated) return;
  _autoSavedHydrated = true;
  if (Platform.OS === 'web') return;
  try {
    const mmkv = require('./mmkv');
    const raw = mmkv.getString?.(AUTO_SAVE_GALLERY_DONE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) for (const k of arr) if (typeof k === 'string') _autoSavedKeys.add(k);
  } catch {}
}
_hydrateAutoSavedKeys();

function _scheduleAutoSavedPersist() {
  if (Platform.OS === 'web') return;
  if (_autoSavedPersistTimer) return;
  _autoSavedPersistTimer = setTimeout(() => {
    _autoSavedPersistTimer = null;
    try {
      // Cap the persisted set so it can't grow without bound on heavy accounts.
      // Keep the most-recent ~5000 keys (insertion order = Set iteration order).
      let arr = [...ceilingSet(_autoSavedKeys, 5000)];
      require('./mmkv').setString?.(AUTO_SAVE_GALLERY_DONE_KEY, JSON.stringify(arr));
    } catch {}
  }, 3000);
}

// Trim a Set to its last `max` insertion-ordered entries (mutating in place).
function ceilingSet(set, max) {
  if (set.size <= max) return set;
  const arr = [...set];
  const keep = arr.slice(arr.length - max);
  set.clear();
  for (const k of keep) set.add(k);
  return set;
}

/**
 * Fire-and-forget: copy a freshly-downloaded RECEIVED photo/video into the
 * phone's gallery / camera roll, exactly once. Safe to call from any download
 * success path — every guard short-circuits cheaply.
 *
 *   localUri  — file:// path of the on-disk copy (cacheMedia result).
 *   key       — urlToKey() bucket for this media (dedupe identity).
 *   mediaType — 'image' | 'video' | 'photo' | 'audio' | 'document' | ...
 *
 * No-ops on: web, setting OFF, non-image/video type, missing key/uri,
 * permission denied (latched for the session), already-saved key.
 */
export function maybeAutoSaveToGallery(localUri, key, mediaType, opts) {
  if (Platform.OS === 'web') return;
  // PRIVACY (view-once): defense-in-depth — even if a view-once download ever
  // reaches this path, never mirror it into the camera roll.
  if (opts && opts.viewOnce) return;
  // [2026-10-14 adv-privacy] Conversa com privacidade avançada: nunca vai p/ a galeria.
  if (_advPrivBlocksGallery(opts && opts.conversationId)) return;
  if (!localUri || typeof localUri !== 'string' || !localUri.startsWith('file://')) return;
  if (!key) return;
  // Histórico em massa (restauração / "baixar tudo") nunca vai p/ a galeria.
  if (opts && opts.noGallery) return;
  // Setting gate: conversa (Padrão/Sim/Não) → global da conta → aparelho (padrão LIGADO).
  if (!_galleryAllowed(opts && opts.conversationId)) return;
  if (_autoSavePermDenied) return;
  // Only photos + videos go to the gallery. Audio / docs / stickers / gifs
  // stay inside the app's media store. _bucketForType folds image/photo →
  // 'photos' and video → 'videos'; everything else is excluded here.
  // [2026-07-03] Explicitly reject gif/sticker BEFORE the bucket fold — they
  // were classifying as 'photos' and getting auto-saved to the camera roll,
  // contradicting the documented "only photos + videos" intent (users found
  // received GIFs/stickers spamming their gallery).
  if (mediaType === 'gif' || mediaType === 'sticker') return;
  const bucket = _bucketForType(mediaType);
  if (bucket !== 'photos' && bucket !== 'videos') return;
  // De-dupe — never write the same media to the gallery twice.
  _hydrateAutoSavedKeys();
  if (_autoSavedKeys.has(key)) return;
  // [2026-10-13 delete-for-all] Vídeo-recado (PTV) NUNCA vai p/ a galeria
  // (WhatsApp não salva). Detecta também 'video' que perdeu o tipo no upload.
  if (mediaType === 'video_note') return;
  try {
    if (/video_note_/i.test(localUri) || (opts && typeof opts.url === 'string' && /video_note_/i.test(opts.url))) return;
  } catch {}
  // [2026-10-13 delete-for-all] ADIADO: a galeria do aparelho não pode ser
  // limpa depois (apagar exige confirmação do usuário no iOS/Android 11+), então
  // só copiamos depois de GALLERY_DELAY_MS e se a mensagem NÃO foi apagada p/
  // todos nesse meio-tempo (lápide checada na hora de gravar). Fila persistida
  // (MMKV) → app morto no meio continua no próximo boot, com nova carência.
  _queueGallerySave({ f: localUri, k: key, m: opts && opts.messageId != null ? String(opts.messageId) : null, u: (opts && typeof opts.url === 'string') ? opts.url : null, c: (opts && opts.conversationId != null) ? String(opts.conversationId) : null, a: _galleryAcct() || null, d: Date.now() + GALLERY_DELAY_MS });
}

// [2026-10-14 adv-privacy] services/chatPrivacy (lazy: evita ciclo de import).
function _advPrivBlocksGallery(cid) {
  try { return !!require('./chatPrivacy').isGalleryAutoSaveBlocked(cid); } catch { return false; }
}

const GALLERY_DELAY_MS = 60 * 1000;
// Nome do álbum (iOS) / pasta (Android Pictures|Movies/Chatyy). O backup de
// fotos nativo exclui exatamente este nome — mudar aqui = mudar lá também.
export const GALLERY_ALBUM = 'Chatyy';
const GALLERY_PENDING_KEY = 'media_autosave_gallery_pending_v1';
const _galleryPending = new Map(); // key → { f, k, m, u, d }
const _galleryTimers = new Map();  // key → timeout
let _gallerySaveChain = Promise.resolve();
let _galleryPendingHydrated = false;
function _persistGalleryPending() {
  if (Platform.OS === 'web') return;
  try { require('./mmkv').setString?.(GALLERY_PENDING_KEY, JSON.stringify([..._galleryPending.values()].slice(-300))); } catch {}
}
function _armGalleryTimer(item) {
  const old = _galleryTimers.get(item.k);
  if (old) { try { clearTimeout(old); } catch {} }
  const wait = Math.max(1000, item.d - Date.now());
  _galleryTimers.set(item.k, setTimeout(() => {
    _galleryTimers.delete(item.k);
    _galleryPending.delete(item.k);
    _persistGalleryPending();
    // Um de cada vez: duas gravações simultâneas criariam 2 álbuns "Chatyy" no iOS.
    _gallerySaveChain = _gallerySaveChain.then(() => _runGallerySave(item)).catch(() => {});
  }, wait));
}
function _queueGallerySave(item) {
  if (!item || !item.k || !item.f) return;
  if (_galleryPending.has(item.k)) return;
  _galleryPending.set(item.k, item);
  _persistGalleryPending();
  _armGalleryTimer(item);
}
function _hydrateGalleryPending() {
  if (_galleryPendingHydrated || Platform.OS === 'web') return;
  _galleryPendingHydrated = true;
  try {
    const arr = JSON.parse(require('./mmkv').getString?.(GALLERY_PENDING_KEY) || '[]');
    if (!Array.isArray(arr)) return;
    // Boot: nova carência cheia — a lápide pode chegar só no sync pós-boot.
    const minD = Date.now() + GALLERY_DELAY_MS;
    for (const it of arr) {
      if (!it || typeof it.k !== 'string' || typeof it.f !== 'string') continue;
      const item = { ...it, d: Math.max(Number(it.d) || 0, minD) };
      _galleryPending.set(item.k, item);
      _armGalleryTimer(item);
    }
  } catch {}
}
try { setTimeout(_hydrateGalleryPending, 5000); } catch {}
function _cancelPendingGalleryFor(messageId, urls) {
  const mid = messageId != null ? String(messageId) : null;
  const keys = new Set();
  for (const u of (urls || [])) { try { const a = _absMediaUrl(u); if (a) keys.add(urlToKey(a)); } catch {} }
  let changed = false;
  for (const [k, it] of [..._galleryPending.entries()]) {
    // [2026-10-13 P1-1] Por id; por URL só itens sem id (a mesma URL pode ser
    // de outra mensagem viva — encaminhada / figurinha repetida).
    if ((mid && it.m === mid) || (!it.m && keys.has(k))) {
      const t = _galleryTimers.get(k);
      if (t) { try { clearTimeout(t); } catch {} _galleryTimers.delete(k); }
      _galleryPending.delete(k);
      changed = true;
    }
  }
  if (changed) _persistGalleryPending();
}
async function _runGallerySave(item) {
  const localUri = item.f;
  const key = item.k;
  if (_isDeletedBlocked(item.u, { messageId: item.m })) return;
  // [2026-10-15 media-visibility] Reavalia na hora (a pessoa pode ter desligado
  // durante a carência) com a conta DONA da mensagem (troca de conta no meio).
  if (!_galleryAllowed(item.c, item.a || undefined) || _autoSavePermDenied) return;
  // [2026-10-14 adv-privacy] ligaram a privacidade avançada durante a carência.
  if (item.c && _advPrivBlocksGallery(item.c)) return;
  _hydrateAutoSavedKeys();
  if (_autoSavedKeys.has(key)) return;
  // Arquivo sumiu (purgado na exclusão / limpeza) → não salva.
  try {
    const fs = getFS();
    const info = fs ? await fs.getInfoAsync(localUri) : null;
    if (!info || !info.exists || !(info.size > 0)) return;
  } catch { return; }
  if (_isDeletedBlocked(item.u, { messageId: item.m })) return;
  // Mark BEFORE the async save so a concurrent second call (re-render race)
  // doesn't double-fire. If the save fails we leave the mark in place.
  _autoSavedKeys.add(key);
  _scheduleAutoSavedPersist();
  await (async () => {
    let ML;
    try { ML = require('expo-media-library'); } catch { return; }
    if (!ML) return;
    try {
      // [2026-10-15 media-visibility] Sempre no álbum "Chatyy" (o backup de
      // fotos nativo — modules/expo-photos-backup — EXCLUI esse álbum, então
      // o que o Chatyy salva nunca é re-enviado ao Drive).
      //  • Android: createAlbumAsync(nome, sem asset, uri) grava DIRETO via
      //    MediaStore em Pictures/Chatyy (foto) ou Movies/Chatyy (vídeo) —
      //    sem o "Permitir que o app modifique?" do mover-para-álbum.
      //  • iOS com acesso total/limitado: cria o asset e põe no álbum.
      //  • iOS sem acesso de leitura: pede só "adicionar" (addOnly) e salva no
      //    Rolo (sem álbum — o iOS não deixa ver/criar álbum nesse modo; e sem
      //    leitura o backup de fotos também não roda).
      let full = null;
      try { full = await ML.getPermissionsAsync(false); } catch {}
      const fullOk = !!(full && (full.status === 'granted' || full.granted === true));
      const perm = fullOk ? full : await ML.requestPermissionsAsync(true);
      const granted = perm && (perm.status === 'granted' || perm.accessPrivileges === 'all' || perm.accessPrivileges === 'limited' || perm.granted === true);
      if (!granted) {
        // Silently disable for the session — no alert spam (WhatsApp behavior).
        _autoSavePermDenied = true;
        // Roll back the dedupe mark so that, if the user grants permission
        // later (re-toggle clears the latch), this media can still be saved.
        _autoSavedKeys.delete(key);
        _scheduleAutoSavedPersist();
        return;
      }
      let saved = false;
      if (Platform.OS === 'android') {
        try { await ML.createAlbumAsync(GALLERY_ALBUM, undefined, true, localUri); saved = true; } catch {}
        if (!saved) { try { await ML.createAssetAsync(localUri); saved = true; } catch {} }
        if (!saved) { try { await ML.saveToLibraryAsync(localUri); saved = true; } catch {} }
      } else if (fullOk) {
        let album = null;
        try { album = await ML.getAlbumAsync(GALLERY_ALBUM); } catch {}
        if (album) {
          try { await ML.createAssetAsync(localUri, album); saved = true; } catch {}
        } else {
          try { await ML.createAlbumAsync(GALLERY_ALBUM, undefined, undefined, localUri); saved = true; } catch {}
        }
        if (!saved) {
          try {
            const asset = await ML.createAssetAsync(localUri);
            saved = !!asset;
            if (asset && asset.id) { try { await ML.createAlbumAsync(GALLERY_ALBUM, asset, false); } catch {} }
          } catch {}
        }
      } else {
        try { await ML.saveToLibraryAsync(localUri); saved = true; } catch {}
      }
      if (!saved) { /* falhou: mantém a marca (sem re-tentar em loop) */ }
    } catch {
      // Unexpected ML error — keep the dedupe mark (don't retry-spam).
    }
  })();
}

// ── Cumulative network-usage counter (settings.js getNetStats()) ──────────
// settings.js calls mediaCache.getNetStats() to render "Network usage", but
// the function didn't exist (always showed "—"). We maintain a persisted
// running total of download (`down`) + upload (`up`) bytes. Downloads are
// counted here in the media download paths (cacheMedia / saveMediaPermanent);
// callers elsewhere (e.g. the upload pipeline) can feed the `up` side via
// addNetStats(up, down). Persisted under a stable AsyncStorage key, debounced.
const NET_STATS_KEY = 'media_dl_stats';
let _netStats = { up: 0, down: 0 };
let _netStatsHydrated = false;
let _netStatsPersistTimer = null;

function _hydrateNetStats() {
  if (_netStatsHydrated) return;
  _netStatsHydrated = true;
  const apply = (raw) => {
    if (!raw) return;
    try {
      const o = JSON.parse(raw);
      const up = Number(o && o.up);
      const down = Number(o && o.down);
      if (Number.isFinite(up) && up >= 0) _netStats.up = up;
      if (Number.isFinite(down) && down >= 0) _netStats.down = down;
    } catch {}
  };
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') apply(localStorage.getItem(NET_STATS_KEY)); } catch {}
    return;
  }
  try {
    import('@react-native-async-storage/async-storage').then(m => {
      m.default.getItem(NET_STATS_KEY).then(apply).catch(() => {});
    }).catch(() => {});
  } catch {}
}
_hydrateNetStats();

function _scheduleNetStatsPersist() {
  if (_netStatsPersistTimer) return;
  _netStatsPersistTimer = setTimeout(() => {
    _netStatsPersistTimer = null;
    const payload = JSON.stringify(_netStats);
    if (Platform.OS === 'web') {
      try { if (typeof localStorage !== 'undefined') localStorage.setItem(NET_STATS_KEY, payload); } catch {}
      return;
    }
    try {
      import('@react-native-async-storage/async-storage').then(m => {
        m.default.setItem(NET_STATS_KEY, payload).catch(() => {});
      }).catch(() => {});
    } catch {}
  }, 4000);
}

// Increment the running totals. Either arg may be 0. Negative/NaN ignored.
export function addNetStats(up = 0, down = 0) {
  _hydrateNetStats();
  const u = Number(up), d = Number(down);
  let changed = false;
  if (Number.isFinite(u) && u > 0) { _netStats.up += u; changed = true; }
  if (Number.isFinite(d) && d > 0) { _netStats.down += d; changed = true; }
  if (changed) _scheduleNetStatsPersist();
}

// settings.js consumer — returns cumulative { up, down } byte totals.
export function getNetStats() {
  _hydrateNetStats();
  return { up: _netStats.up, down: _netStats.down };
}

// Reset both counters (e.g. a "clear usage" button). Persists immediately.
export function resetNetStats() {
  _netStats = { up: 0, down: 0 };
  _netStatsHydrated = true;
  if (Platform.OS === 'web') {
    try { if (typeof localStorage !== 'undefined') localStorage.setItem(NET_STATS_KEY, JSON.stringify(_netStats)); } catch {}
  } else {
    try {
      import('@react-native-async-storage/async-storage').then(m => {
        m.default.setItem(NET_STATS_KEY, JSON.stringify(_netStats)).catch(() => {});
      }).catch(() => {});
    } catch {}
  }
}

// Best-effort: stat a just-downloaded file and add its size to the `down`
// total. Called fire-and-forget from the download paths so a failed stat
// never blocks the download return.
function _countDownloadedBytes(fs, localPath) {
  if (!fs || !localPath || Platform.OS === 'web') return;
  try {
    fs.getInfoAsync(localPath).then(info => {
      if (info && info.exists && typeof info.size === 'number' && info.size > 0) {
        addNetStats(0, info.size);
      }
    }).catch(() => {});
  } catch {}
}

// Truncation guard for the download paths. fs.downloadAsync resolves with
// status 200 even when the socket dies mid-body (server restart / migration
// cut the stream) — the partial JPEG then passes the size>0 check, is
// registered in syncIndex and renders forever as a half-decoded/white photo
// with no retry chip (partial JPEG "decodes" fine, so onError never fires).
// When the server declared a Content-Length and the body isn't compressed,
// the on-disk size must match it exactly; otherwise treat as corrupt.
// Returns 0 ("don't enforce") when the header is absent or the response is
// content-encoded (decoded bytes legitimately differ from the header).
function _expectedBytesFromHeaders(headers) {
  if (!headers) return 0;
  let len = 0, enc = '';
  try {
    for (const k of Object.keys(headers)) {
      const lk = String(k).toLowerCase();
      if (lk === 'content-length') len = parseInt(headers[k], 10) || 0;
      else if (lk === 'content-encoding') enc = String(headers[k] || '').toLowerCase();
    }
  } catch { return 0; }
  return (enc && enc !== 'identity') ? 0 : len;
}

// Map external media-type names → matrix bucket. Accepts both the external
// 'photo' / 'video' / 'document' singulars (per task spec) and the internal
// plurals used by _bucketForUrl.
function _bucketForType(mediaType) {
  switch (mediaType) {
    case 'photo': case 'photos': case 'image': case 'gif': case 'sticker':
      return 'photos';
    case 'audio': case 'voice':
      return 'audio';
    case 'video': case 'videos':
      return 'videos';
    case 'document': case 'documents': case 'docs': case 'doc': case 'file':
      return 'documents';
    default:
      return 'photos';
  }
}

/**
 * Central WhatsApp-parity auto-download gate. Returns true iff the current
 * network column for `mediaType` is ON in the user's policy matrix.
 *
 *   mediaType: 'photo' | 'audio' | 'video' | 'document' (plurals also OK).
 *
 * Tap-to-open paths MUST NOT call this — they always proceed regardless.
 * Background pre-fetch paths (cacheMedia auto-flow, audioCache voice
 * prefetch) gate on this.
 *
 * 60s cache: the matrix lives in memory and is updated synchronously on
 * setAutoDownloadPolicy, so reads are O(1). The 60s stamp is only used to
 * decide when a refetch from chat_get_user_defaults would be worthwhile —
 * the gate itself is always evaluated against the current in-memory copy.
 */
export function shouldAutoDownload(mediaType) {
  const bucket = _bucketForType(mediaType);
  let column = 'unknown';
  try {
    const ni = require('./networkInfo');
    if (typeof ni.getNetworkType === 'function') column = ni.getNetworkType();
  } catch {}

  // Disconnected — nothing to download.
  if (column === 'none') return false;

  // Data Saver master override (ADDITIVE, most-restrictive wins):
  //  - videos never auto-download (skip pre-cache/preload entirely)
  //  - everything else is Wi-Fi only (mobile + roaming behave as 'never')
  // Evaluated BEFORE the matrix so a permissive matrix cell can't re-enable
  // cellular downloads while the user has Data Saver on.
  if (isDataSaverOn()) {
    if (bucket === 'videos') return false;
    if (column !== 'wifi') return false;
    // On Wi-Fi: still respect the user's matrix (they may have a bucket OFF
    // even on Wi-Fi). Fall through to the matrix check below.
  }

  // Network unknown (NetInfo still probing) — be conservative: only allow
  // the lightweight buckets that are ON for BOTH mobile and wifi columns.
  // This is the same fail-safe the legacy gate used. With Data Saver on the
  // block above already returned false for non-wifi, so 'unknown' here means
  // Data Saver is off.
  if (column === 'unknown') {
    const cell = _autoDlPolicy[bucket] || _defaultPolicy[bucket];
    return !!(cell.mobile && cell.wifi);
  }

  const cell = _autoDlPolicy[bucket] || _defaultPolicy[bucket];
  return !!cell[column];
}

/** Test-only freshness hint — settings UI uses this to decide whether to
 *  trigger a chat_get_user_defaults refetch. */
export function autoDownloadPolicyAgeMs() {
  return _autoDlPolicyCacheStamp ? (Date.now() - _autoDlPolicyCacheStamp) : Infinity;
}

// Returns true if the URL should auto-download given the current network +
// user policy. Used by cacheMedia()'s gate. Callers can bypass via
// { force: true } (explicit tap-to-download UI).
//
// Delegates to the new 4×3 matrix (shouldAutoDownload(type)). The matrix
// supersedes the legacy `_mediaDlPrefs` ('wifi'|'mobile'|'never') buckets —
// shouldAutoDownload normalizes both shapes internally.
function _shouldAutoDownload(url) {
  // Map docs bucket from URL to the matrix's 'document' singular.
  const bucket = _bucketForUrl(url);
  const matrixType = bucket === 'docs' ? 'document' : bucket;
  return shouldAutoDownload(matrixType);
}

// ── [2026-10-08 media-local-store] helpers do store permanente ─────────
// Decide se este download vai pro store permanente e onde. null = legado
// (cacheDirectory transitório: status/feed/GIF externo sem conversa).
function _planStore(url, key, opts) {
  if (Platform.OS === 'web') return null;
  if (opts && opts.viewOnce) return null;
  const st = _store();
  if (!st) return null;
  try {
    let conv = (opts && opts.conversationId != null && opts.conversationId !== '') ? opts.conversationId : null;
    if (conv == null) {
      try { _hydrateUrlConvOwner(); const o = _urlConvOwner.get(key); if (o != null) conv = o; } catch {}
    }
    const mid = (opts && opts.messageId != null && opts.messageId !== '') ? opts.messageId : null;
    if (conv == null && mid == null && !_isChatMediaUrl(url) && !st.lookupByUrlKey(key)) return null;
    // [2026-10-14 offline-media] chave .bin (URL sem extensão) → extensão do nome do arquivo da mensagem.
    const extHint = key.endsWith('.bin') ? (_extFromFileName(opts && opts.fileName) || null) : null;
    return st.planPath({ urlKey: key, conversationId: conv, messageId: mid, ext: extHint });
  } catch { return null; }
}

// Move (ou copia) um arquivo já baixado p/ o destino do store e registra.
async function _promoteToStore(fs, fromPath, plan, url, key, opts) {
  const st = _store();
  if (!st || !plan || !fromPath || fromPath === plan.abs) return null;
  try {
    const src = await fs.getInfoAsync(fromPath);
    if (!src.exists || !(src.size > 0)) return null;
    try { await fs.makeDirectoryAsync(plan.dir, { intermediates: true }); } catch {}
    try { await fs.moveAsync({ from: fromPath, to: plan.abs }); }
    catch { await fs.copyAsync({ from: fromPath, to: plan.abs }); }
    st.record(plan, { urlKey: key, messageId: opts && opts.messageId, size: src.size, own: !!(opts && opts.own) });
    registerSyncKey(url, plan.abs);
    return plan.abs;
  } catch { return null; }
}

// Hosts alternativos p/ a MESMA mídia (ordem: origem US → CDN R2). Vazio p/
// URLs de terceiros. Delegado ao api.getMediaFallbackUrls (fonte única).
function _fallbackUrls(url) {
  try {
    const api = require('./api');
    const list = api.getMediaFallbackUrls ? api.getMediaFallbackUrls(url) : [];
    return Array.isArray(list) ? list.filter(u => u && u !== url) : [];
  } catch { return []; }
}

function _headerCI(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === want) return String(headers[k] || '');
  }
  return '';
}
// Resposta HTML p/ uma URL de mídia = SPA/página de erro, não o arquivo.
function _isHtmlForMedia(headers, url) {
  const ct = _headerCI(headers, 'content-type').toLowerCase();
  if (!ct.includes('text/html')) return false;
  const base = String(url || '').split('?')[0].split('#')[0].toLowerCase();
  return !/\.(html?|xhtml)$/.test(base);
}

// Promove (em lotes, fire-and-forget) arquivos de conversa que ficaram no
// cacheDirectory purgável (versões antigas do app) p/ o store permanente.
// Só arquivos com dono conhecido (_urlConvOwner) — sem dono não dá p/ saber a
// conversa nem a conta. Limite por execução p/ não pesar no boot.
let _legacyMigrateDone = false;
async function _migrateLegacyCacheToStore() {
  if (_legacyMigrateDone || Platform.OS === 'web') return;
  _legacyMigrateDone = true;
  const fs = getFS(); const st = _store(); const dir = getCacheDir();
  if (!fs || !st || !dir || !st.isEnabled()) return;
  try {
    _hydrateUrlConvOwner();
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) return;
    const names = await fs.readDirectoryAsync(dir);
    let moved = 0;
    for (const name of names) {
      if (moved >= 300) break;
      const conv = _urlConvOwner.get(name);
      if (conv == null) continue;
      if (st.lookupByUrlKey(name)) continue;
      const plan = st.planPath({ urlKey: name, conversationId: conv, messageId: null });
      if (!plan) continue;
      try {
        const src = await fs.getInfoAsync(dir + name);
        if (!src.exists || !(src.size > 0)) continue;
        try { await fs.makeDirectoryAsync(plan.dir, { intermediates: true }); } catch {}
        await fs.moveAsync({ from: dir + name, to: plan.abs });
        st.record(plan, { urlKey: name, size: src.size });
        syncIndex.set(name, plan.abs);
        moved++;
      } catch {}
    }
    if (moved) _schedulePersistIndex();
  } catch {}
}

// Download and cache a URL, return local URI.
// `opts.force` (default false): bypass the cellular gate. Use this for the
// user's explicit "tap to download" gesture on a media bubble — the
// background prefetch path leaves opts.force unset so cellular saves data.
// ── [2026-10-12 P0 view-once] Registro de mídia de visualização única ──
// cacheMedia/saveMediaPermanent/preCacheUrls recebem só a URL; qualquer
// caminho que veja a MENSAGEM (render do bubble, sweep da conversa, WS
// prefetch) registra aqui url+id, e as funções de gravação recusam. Assim
// nenhum caminho (auto-sync, histórico, pre-cache) grava view-once em disco.
const _viewOnceKeys = new Set();
const _viewOnceMsgIds = new Set();
export function isViewOnceMessage(m) {
  if (!m || typeof m !== 'object') return false;
  const v = m.is_view_once ?? m.isViewOnce ?? m.view_once;
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}
function _absMediaUrl(u) {
  if (!u || typeof u !== 'string') return null;
  return u.startsWith('http') ? u : `https://chatyy.com.br${u}`;
}
export function markViewOnceMedia(url, messageId) {
  try {
    if (messageId != null && messageId !== '') _viewOnceMsgIds.add(String(messageId));
    const abs = _absMediaUrl(url);
    if (abs) _viewOnceKeys.add(urlToKey(abs));
    if (url && typeof url === 'string' && url !== abs) _viewOnceKeys.add(urlToKey(url));
  } catch {}
}
export function markViewOnceFromMessages(messages) {
  if (!Array.isArray(messages)) return;
  for (const m of messages) {
    if (isViewOnceMessage(m)) markViewOnceMedia(m.file_url, m.id);
  }
}
function _isViewOnceBlocked(url, opts) {
  if (opts && (opts.viewOnce || opts.isViewOnce)) return true;
  // [2026-10-13 delete-for-all] Mensagem apagada (lápide) → nunca grava.
  if (_isDeletedBlocked(url, opts)) return true;
  try {
    if (opts && opts.messageId != null && _viewOnceMsgIds.has(String(opts.messageId))) return true;
    if (url && _viewOnceKeys.size && _viewOnceKeys.has(urlToKey(url))) return true;
  } catch {}
  return false;
}
// Apaga do aparelho qualquer cópia (cache plano, saved, store permanente)
// de uma mídia view-once. Idempotente.
export async function purgeViewOnceMedia(url, messageId) {
  if (Platform.OS === 'web') return;
  markViewOnceMedia(url, messageId);
  const fs = getFS();
  const abs = _absMediaUrl(url);
  if (abs) { try { await deleteCachedUrl(abs); } catch {} }
  if (messageId != null && fs) {
    try {
      const st = _store();
      const p = st ? st.lookupByMessage(messageId) : null;
      if (p) {
        try { await fs.deleteAsync(p, { idempotent: true }); } catch {}
        for (const [k, v] of syncIndex) { if (v === p) { syncIndex.delete(k); try { st.forgetUrlKey(k); } catch {} } }
        _schedulePersistIndex();
      }
    } catch {}
  }
}

// ── [2026-10-13 delete-for-all] Lápides de mensagens apagadas ─────────────
// Bug real: vídeo-recado apagado p/ todos 4 s depois de chegar continuava no
// aparelho — o auto-download já tinha gravado (store permanente + local_path)
// e o auto-salvar-na-galeria tinha copiado p/ o Fotos. Agora:
//  - markMessageDeleted() registra id + chave(s) da URL (persistido em MMKV,
//    sobrevive a kill) → cacheMedia/saveMediaPermanent/HLS recusam gravar e um
//    download em voo que termina DEPOIS da lápide é apagado ao concluir;
//  - purgeDeletedMessageMedia() apaga TODAS as cópias locais (store por
//    mensagem, cache plano/saved, local_path no SQLite, HLS offline, LQIP,
//    disco do expo-image por URL) e cancela a galeria pendente;
//  - runDeletedMediaSweep() no boot varre linhas apagadas que ainda têm mídia.
const DELETED_TOMB_KEY = 'media_deleted_tombstones_v1';
const DELETED_TOMB_MAX = 5000;
const _deletedMsgIds = new Set();
// Chave da URL → expira (memória só, 15 min): cobre downloads em voo sem
// bloquear p/ sempre a MESMA URL reaproveitada por um encaminhamento.
const _deletedKeys = new Map();
const DELETED_KEY_TTL_MS = 15 * 60 * 1000;
let _deletedHydrated = false;
let _deletedPersistT = null;
function _hydrateDeleted() {
  if (_deletedHydrated) return;
  _deletedHydrated = true;
  if (Platform.OS === 'web') return;
  try {
    const raw = require('./mmkv').getString?.(DELETED_TOMB_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && Array.isArray(o.i)) for (const v of o.i) if (v != null) _deletedMsgIds.add(String(v));
  } catch {}
}
function _persistDeletedSoon() {
  if (Platform.OS === 'web' || _deletedPersistT) return;
  _deletedPersistT = setTimeout(() => {
    _deletedPersistT = null;
    try {
      ceilingSet(_deletedMsgIds, DELETED_TOMB_MAX);
      require('./mmkv').setString?.(DELETED_TOMB_KEY, JSON.stringify({ i: [..._deletedMsgIds] }));
    } catch {}
  }, 1500);
}
function _isDeletedBlocked(url, opts) {
  _hydrateDeleted();
  if (!_deletedMsgIds.size && !_deletedKeys.size) return false;
  try {
    if (opts && opts.messageId != null && opts.messageId !== '' && !String(opts.messageId).startsWith('temp')) {
      // [2026-10-13 P1-1] Download de uma mensagem identificada: só a lápide
      // DELA bloqueia (a mesma URL pode pertencer a outra mensagem viva).
      return _deletedMsgIds.has(String(opts.messageId));
    }
    if (url && typeof url === 'string' && _deletedKeys.size && !/^(file|content|ph|asset|assets-library|data):/i.test(url)) {
      const k = urlToKey(_absMediaUrl(url) || url);
      const exp = _deletedKeys.get(k);
      if (exp) { if (exp > Date.now()) return true; _deletedKeys.delete(k); }
    }
  } catch {}
  return false;
}
export function isDeletedMessage(m) {
  if (!m || typeof m !== 'object') return false;
  if (m.deleted_at) return true;
  const v = m.is_deleted;
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}
export function isMessageDeletedLocally(messageId) {
  if (messageId == null || messageId === '') return false;
  _hydrateDeleted();
  return _deletedMsgIds.has(String(messageId));
}
function _mediaUrlsOf(info) {
  const out = [];
  if (!info || typeof info !== 'object') return out;
  for (const k of ['url', 'file_url', 'thumbUrl', 'thumbnail_url', 'thumb_url', 'poster_url', 'hlsUrl', 'hls_url']) {
    const v = info[k];
    if (typeof v === 'string' && v && !/^(file|content|ph|data):/i.test(v)) out.push(v);
  }
  return out;
}
export function markMessageDeleted(messageId, urls) {
  if (Platform.OS === 'web') return;
  _hydrateDeleted();
  if (messageId != null && messageId !== '' && !String(messageId).startsWith('temp')) _deletedMsgIds.add(String(messageId));
  for (const u of (Array.isArray(urls) ? urls : [])) {
    try { const abs = _absMediaUrl(u); if (abs) _deletedKeys.set(urlToKey(abs), Date.now() + DELETED_KEY_TTL_MS); } catch {}
  }
  _persistDeletedSoon();
}

async function _deleteExpoImageCacheFor(urls) {
  if (!urls.length) return;
  let EI = null;
  try { EI = require('expo-image').Image; } catch {}
  if (!EI || typeof EI.getCachePathAsync !== 'function') return;
  const fs = getFS();
  for (const u of urls) {
    const abs = _absMediaUrl(u);
    for (const k of new Set([u, abs].filter(Boolean))) {
      try {
        const p = await EI.getCachePathAsync(k);
        if (p && fs) await fs.deleteAsync(p.startsWith('file://') ? p : 'file://' + p, { idempotent: true });
      } catch {}
    }
  }
}

const _purgingMsgs = new Map(); // id → Promise (dedupe WS + persistence + sync)
// [2026-10-13 P1-3] urlKey → status HTTP da última falha DEFINITIVA (404/410/403
// em todos os hosts). Lido pelo mediaAutoSync p/ backoff por id.
const _dlFailStatus = new Map();
export function getDownloadFailStatus(url) {
  try {
    const abs = _absMediaUrl(url);
    return abs ? (_dlFailStatus.get(urlToKey(abs)) || _dlFailStatus.get(urlToKey(url)) || 0) : 0;
  } catch { return 0; }
}
/**
 * Apaga do aparelho TODAS as cópias da mídia de uma mensagem apagada p/ todos.
 *   info: { conversationId, url|file_url, thumbnail_url, hls_url, local_path }
 * Idempotente, nunca lança. NÃO mexe na galeria do aparelho (não dá sem
 * permissão de apagar) — por isso o auto-salvar é adiado (ver galeria acima).
 */
export function purgeDeletedMessageMedia(messageId, info = {}) {
  if (Platform.OS === 'web' || messageId == null || messageId === '') return Promise.resolve();
  const mid = String(messageId);
  const urls = _mediaUrlsOf(info);
  // [2026-10-13 P1-1] Lápide só por ID na hora; a chave da URL só entra se
  // nenhuma outra mensagem usa a mesma URL (ver abaixo).
  markMessageDeleted(mid, []);
  _cancelPendingGalleryFor(mid, urls);
  const prev = _purgingMsgs.get(mid);
  const run = (async () => {
    if (prev) { try { await prev; } catch {} }
    const fs = getFS();
    const st = _store();
    const paths = new Set();
    if (typeof info.local_path === 'string' && info.local_path.startsWith('file://')) paths.add(info.local_path);
    if (typeof info.localPath === 'string' && info.localPath.startsWith('file://')) paths.add(info.localPath);
    let convId = info.conversationId ?? info.conversation_id ?? null;
    // Linha do SQLite (local_path + file_url ainda não raspados).
    try {
      const r = await require('./db').dbGetMessageMediaRefs?.(mid);
      if (r) {
        if (typeof r.local_path === 'string' && r.local_path.startsWith('file://')) paths.add(r.local_path);
        if (r.file_url) urls.push(r.file_url);
        if (convId == null && r.conversation_id != null) convId = r.conversation_id;
      }
    } catch {}
    // [2026-10-13 P1-1] Por URL: só apaga (arquivo/chave/expo-image) se
    // NENHUMA outra linha viva do SQLite referencia a mesma URL. Foto
    // encaminhada A→B / figurinha repetida compartilham file_url e o store
    // indexa por URL (1 arquivo p/ as duas) — apagar em A não pode levar B.
    const ownUrls = []; // URLs exclusivas desta mensagem
    const keepKeys = new Set(); // chaves de URL compartilhadas
    const keepPaths = new Set();
    for (const u of [...new Set(urls)]) {
      const abs = _absMediaUrl(u);
      if (!abs) continue;
      const variants = [abs, ..._fallbackUrls(abs)];
      const keys = variants.map(v => urlToKey(v));
      // Nada local p/ esta URL e é varredura de boot → pula a consulta.
      let hasLocal = false;
      try {
        for (const k of keys) {
          if (syncIndex.has(k) || (st && st.lookupByUrlKey(k))) { hasLocal = true; break; }
        }
      } catch {}
      if (!hasLocal && info._sweep && !paths.size) continue;
      const cands = new Set([u, ...variants]);
      for (const v of variants) {
        const rel = v.replace(/^https?:\/\/[^/]+/i, '');
        if (rel && rel !== v && rel.startsWith('/')) { cands.add(rel); cands.add(rel.slice(1)); }
      }
      let shared = null;
      try { shared = await require('./db').dbIsMediaUrlReferencedElsewhere?.(mid, [...cands]); } catch { shared = null; }
      if (shared === false) {
        ownUrls.push(abs);
        markMessageDeleted(mid, [abs]);
      } else {
        // true ou desconhecido → preserva (nunca apaga mídia de outra mensagem por dúvida).
        for (const k of keys) {
          keepKeys.add(k);
          const sp = syncIndex.get(k);
          if (sp) keepPaths.add(sp);
          try { keepPaths.add(getCacheDir() + k); keepPaths.add(getSavedDir() + k); } catch {}
          try { const p = st && st.lookupByUrlKey(k); if (p) keepPaths.add(p); } catch {}
        }
      }
    }
    // Store permanente: entradas da mensagem (original + variantes), menos as
    // de URL compartilhada (essas só perdem o vínculo com este id).
    try {
      const ents = st && st.forgetMessage ? st.forgetMessage(mid, keepKeys) : [];
      for (const e of ents) {
        if (e.abs && !keepPaths.has(e.abs)) paths.add(e.abs);
        if (e.urlKey) { syncIndex.delete(e.urlKey); try { _cancelBgDownload(e.urlKey); } catch {} }
      }
    } catch {}
    // Cache plano / saved / store por URL + download nativo em voo.
    for (const abs of ownUrls) {
      try { _cancelBgDownload(urlToKey(abs)); } catch {}
      try { await deleteCachedUrl(abs); } catch {}
      for (const fb of _fallbackUrls(abs)) { try { await deleteCachedUrl(fb); } catch {} }
    }
    if (fs) {
      for (const p of paths) {
        if (keepPaths.has(p)) continue;
        try { await fs.deleteAsync(p, { idempotent: true }); } catch {}
        for (const [k, v] of syncIndex) { if (v === p) syncIndex.delete(k); }
      }
    }
    _schedulePersistIndex();
    try { await require('./hlsOffline').deleteHls?.(mid); } catch {}
    try { if (_thumbB64Cache.delete(mid)) _scheduleThumbB64Persist(); } catch {}
    try { await _deleteExpoImageCacheFor(ownUrls); } catch {}
    if (convId != null) {
      try { await require('./db').dbUpdateMessageFields?.(convId, mid, { local_path: null }); } catch {}
    }
  })().catch(() => {}).finally(() => { if (_purgingMsgs.get(mid) === run) _purgingMsgs.delete(mid); });
  _purgingMsgs.set(mid, run);
  return run;
}
function _cancelBgDownload(urlKey) {
  if (!urlKey) return;
  try {
    const bgT = require('./bgTransfer');
    if (bgT.isBgTransferAvailable?.()) bgT.cancelTransfer?.('dl-' + urlKey)?.catch?.(() => {});
  } catch {}
}
// Linhas já carregadas (abrir conversa / sync) que vieram apagadas do servidor:
// limpa o que tiver ficado no disco. Dedup por sessão.
const _purgedThisSession = new Set();
export function purgeDeletedFromMessages(messages) {
  if (Platform.OS === 'web' || !Array.isArray(messages)) return;
  for (const m of messages) {
    if (!m || m.id == null || !isDeletedMessage(m)) continue;
    const k = String(m.id);
    if (_purgedThisSession.has(k)) continue;
    _purgedThisSession.add(k);
    try { purgeDeletedMessageMedia(m.id, { ...m, conversationId: m.conversation_id ?? m.conversationId }); } catch {}
  }
}
// Boot: mensagens apagadas que ainda têm arquivo local + lápides persistidas.
let _delSweepRunning = null;
export function runDeletedMediaSweep() {
  if (Platform.OS === 'web') return Promise.resolve();
  if (_delSweepRunning) return _delSweepRunning;
  _delSweepRunning = (async () => {
    let rows = [];
    try { rows = (await require('./db').getDeletedMessagesWithMedia?.()) || []; } catch {}
    for (const r of rows) {
      try { await purgeDeletedMessageMedia(r.id, { conversationId: r.conversation_id, file_url: r.file_url, local_path: r.local_path, _sweep: true }); } catch {}
    }
    // Lápides cuja linha já saiu do SQLite (hard delete): o store ainda pode
    // ter o arquivo indexado pelo id.
    _hydrateDeleted();
    try {
      const st = _store();
      if (st && st.lookupByMessage) {
        for (const id of [..._deletedMsgIds]) {
          if (st.lookupByMessage(id)) { try { await purgeDeletedMessageMedia(id, {}); } catch {} }
        }
      }
    } catch {}
  })().catch(() => {}).finally(() => { _delSweepRunning = null; });
  return _delSweepRunning;
}

// Limpeza ÚNICA (flag em AsyncStorage): versões anteriores gravavam mídia
// view-once no store permanente / cache. Varre o SQLite pelas mensagens
// view-once, apaga arquivos (local_path + chave da URL), zera local_path e
// limpa o cache de disco do expo-image (o prefetch da conversa aquecia
// view-once lá). Re-executa até concluir sem erro.
const VO_CLEANUP_FLAG = 'chatyy.viewOnceCachePurge.v1';
let _voCleanupRunning = null;
export function runViewOnceCacheCleanupOnce() {
  if (Platform.OS === 'web') return Promise.resolve();
  if (_voCleanupRunning) return _voCleanupRunning;
  _voCleanupRunning = (async () => {
    let AS = null;
    try { AS = require('@react-native-async-storage/async-storage').default; } catch {}
    try { if (AS && (await AS.getItem(VO_CLEANUP_FLAG)) === '1') return; } catch {}
    let rows = [];
    try {
      const dbm = require('./db');
      rows = (await dbm.getViewOnceMediaMessages?.()) || [];
    } catch { return; }
    const fs = getFS();
    for (const r of rows) {
      try {
        markViewOnceMedia(r.file_url, r.id);
        if (fs && r.local_path && typeof r.local_path === 'string' && r.local_path.startsWith('file://')) {
          try { await fs.deleteAsync(r.local_path, { idempotent: true }); } catch {}
        }
        await purgeViewOnceMedia(r.file_url, r.id);
        if (r.local_path && r.conversation_id != null) {
          try { await require('./db').dbUpdateMessageFields(r.conversation_id, r.id, { local_path: null }); } catch {}
        }
      } catch {}
    }
    try {
      const EI = require('expo-image').Image;
      await EI?.clearDiskCache?.();
    } catch {}
    try { AS && (await AS.setItem(VO_CLEANUP_FLAG, '1')); } catch {}
  })().catch(() => {}).finally(() => { _voCleanupRunning = null; });
  return _voCleanupRunning;
}

export async function cacheMedia(url, opts = {}) {
  if (!url || Platform.OS === 'web') return url;
  // view-once media must never be written to the disk cache.
  if (_isViewOnceBlocked(url, opts)) return url;
  // [2026-05-26] Already-local URIs (file://, content://, ph://, etc.) are not
  // remote assets to download — the bytes are already on the device. Callers
  // can reach here when a chat image bubble's pre-resolved `file://` path is
  // handed to ChatMedia → useChatMediaUri → cacheMedia. Attempting
  // downloadAsync on a file:// source is wasteful and can error; just return
  // the local URI so the bubble renders it directly.
  if (/^(file|content|ph|asset|assets-library|data):/i.test(url)) return url;
  const fs = getFS();
  if (!fs) return url;

  // Auto-download gate (WhatsApp parity): read per-bucket user prefs
  // (photos/audio/videos/docs) + current network state. The tap-to-download
  // UI in the bubble passes { force: true } so the user's explicit intent
  // always proceeds regardless of pref. Web bypasses the gate (no cellular).
  if (!opts.force && Platform.OS !== 'web') {
    if (!_shouldAutoDownload(url)) {
      // [#1218 2026-05-20] If the gate failed because we're offline/unknown,
      // queue the URL for the reconnect sweep — WhatsApp pattern. Doesn't
      // affect URLs blocked by the cellular policy itself (those will retry
      // when bucket flips, not on network change).
      try {
        const ni = require('./networkInfo');
        const t = ni.getNetworkType?.();
        if (t === 'none' || t === 'unknown') {
          _enqueueDeferred(url, { messageId: opts.messageId, conversationId: opts.conversationId });
        }
      } catch {}
      return url; // Return remote URL — bubble shows "tap to download" UI.
    }
  }

  const key = urlToKey(url);
  // [2026-10-14 dl-progress] Cancelado pelo usuário → só um toque (force) religa.
  if (_dlUserCancelled.has(key)) {
    if (!opts.force) return url;
    _dlUserCancelled.delete(key);
  }

  // [HOT PATH 2026-05-26] In-flight dedup BEFORE any filesystem stat. A
  // fast-scrolling list (or several bubbles bound to the same URL) can call
  // cacheMedia for the same key many times within a frame; collapsing them to
  // the single existing promise here avoids N× getInfoAsync round-trips on the
  // render path. Correctness is unchanged — the shared promise already resolves
  // to the same local path the stat path would have produced. (Hoisted above
  // the stat fallback; the original check at the end of the lookup is now
  // redundant but harmless if reached.)
  if (_inflightDownloads.has(key)) return _inflightDownloads.get(key);

  // Best-effort owner tag so the LRU sweep can protect favorites. Persisted
  // (debounced) so the tag survives cold start — see _urlConvOwner notes.
  if (opts && opts.conversationId != null) {
    _hydrateUrlConvOwner();
    try {
      _urlConvOwner.set(key, String(opts.conversationId));
      _scheduleUrlConvOwnerPersist();
    } catch {}
  }
  // [2026-10-08 media-local-store] Store permanente da conta ativa primeiro.
  const _st = _store();
  const _plan = _planStore(url, key, opts);
  try {
    const storeHit = _st ? _st.lookupByUrlKey(key) : null;
    if (storeHit) {
      try {
        const info = await fs.getInfoAsync(storeHit);
        if (info.exists && info.size > 0) { registerSyncKey(url, storeHit); try { _st.touch?.(key); } catch {} return storeHit; }
      } catch {}
      try { _st.forgetUrlKey(key); } catch {}
    }
  } catch {}
  let indexed = syncIndex.get(key);
  if (indexed && _st) { try { if (_st.isForeignPath(indexed)) indexed = null; } catch {} }
  if (indexed && _plan && getCacheDir() && indexed.startsWith(getCacheDir())) {
    // Mídia de conversa ainda no cacheDirectory purgável → promove ao store.
    const promoted = await _promoteToStore(fs, indexed, _plan, url, key, opts);
    if (promoted) return promoted;
  }
  if (indexed) {
    // [HOT PATH 2026-05-26] If the index points at the PERMANENT dir
    // (getSavedDir), the file cannot have been auto-evicted — the LRU sweep
    // walks ONLY the OS-purgeable cache dir (see the P0 guard in
    // evictIfNeeded), and the permanent dir is otherwise cleared only by
    // explicit user action, which scrubs the index in the same call. So we can
    // return the local path WITHOUT the fs.getInfoAsync re-validation, serving
    // the on-disk file with zero I/O on the common case (every WS/permanent
    // download lands in getSavedDir). Cache-dir paths can be purged by iOS
    // under the app, so those keep the validating stat below.
    const savedDir = getSavedDir();
    if (savedDir && indexed.startsWith(savedDir)) return indexed;
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
      if (info.exists) {
        if (_plan && d === getCacheDir()) {
          const promoted = await _promoteToStore(fs, p, _plan, url, key, opts);
          if (promoted) return promoted;
        }
        registerSyncKey(url, p); return p;
      }
    } catch {}
  }

  if (_inflightDownloads.has(key)) return _inflightDownloads.get(key);

  // [STORAGE CAP FIX] Route the download by Keep-Always status.
  //
  // The previous behavior wrote EVERY download to documentDirectory
  // (getSavedDir) — the permanent dir the LRU sweep deliberately never
  // touches (see the P0 guard in evictIfNeeded). That meant the configured
  // cache cap + LRU eviction NEVER applied to ordinary chat media, so the
  // sandbox grew without bound (multi-GB after a few weeks).
  //
  // Now only media owned by a "Manter sempre" (Keep-Always) conversation
  // lands in the permanent dir; everything else (the transient majority)
  // goes to the OS-purgeable cache dir so the cap + LRU can actually bound
  // disk growth. Files already on disk in EITHER dir were resolved by the
  // lookup loop above, so this only picks the destination for a fresh
  // download — no existing file is moved or orphaned.
  const _keepAlways = !!(opts && opts.conversationId != null && isConversationKeepAlways(opts.conversationId));
  // [2026-10-08 media-local-store] Mídia de CONVERSA → store permanente
  // (documentDirectory/media/<conta>/<conv>/<msgId>.<ext>): nem o iOS nem o LRU
  // apagam. Só status/feed/GIF externo (sem conversa) segue no cache purgável.
  const dir = _plan ? _plan.dir : (_keepAlways ? getSavedDir() : getCacheDir());
  const localPath = _plan ? _plan.abs : dir + key;
  const _candidates = [url, ..._fallbackUrls(url)];
  // [PRIORITY LANES 2026-05-26] Pick the download lane. Background prefetch —
  // WS auto-download (opts.received), or any caller that explicitly opts into
  // 'low' — yields to foreground/on-demand requests. An explicit user tap
  // (opts.force) and the visible-viewport render path (ChatMedia calls
  // cacheMedia(url) with no flags) take the high lane so the photo the user is
  // actually looking at never sits behind a backlog of auto-prefetches.
  const _dlPriority = (opts.priority === 'low' || (opts.received && !opts.force))
    ? 'low'
    : 'high';
  // [2026-10-14 dl-progress] Só mídia grande (vídeo/doc) publica progresso.
  const _bigForProgress = (() => { const b = _bucketForUrl(url); return b === 'videos' || b === 'docs'; })();
  const _total0 = Number(opts.fileSize || opts.size) || 0;
  const _dlCtl = { cancelled: false, abort: null, resumable: null };
  const _progEv = (state, extra) => {
    if (!_bigForProgress) return;
    _emitDlProgress(key, { url, messageId: opts.messageId != null ? opts.messageId : null, state, ...extra });
  };
  if (_bigForProgress) {
    _dlCancelFns.set(key, () => {
      _dlCtl.cancelled = true;
      try { _dlCtl.abort && _dlCtl.abort(); } catch {}
      try { _dlCtl.resumable && _dlCtl.resumable.cancelAsync && _dlCtl.resumable.cancelAsync(); } catch {}
    });
    _progEv('queued', { pct: 0, loaded: 0, total: _total0 });
  }
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
    await _acquireDownloadSlot(_dlPriority);
    try {
      if (_dlCtl.cancelled) throw new Error('dl_cancelled');
      _progEv('progress', { pct: 0, loaded: 0, total: _total0 });
      // Retry com exponential backoff em 5xx / network failures. 4xx
      // (404, 410, 403) são bug nosso ou link expirado — retry só queima
      // bateria. Backoff: 0ms → 500ms → 1500ms (3 tentativas no total).
      const BACKOFFS_MS = [0, 500, 1500];
      let lastStatus = 0;
      // [#1240 2026-05-26] Big-media buckets (video/doc) use a resumable
      // download so a flaky link doesn't restart from byte 0 on every retry —
      // expo-fs persists the partial file and resumeData, so a 200MB video
      // that drops at 80% picks up where it left off instead of re-burning the
      // whole transfer (and the user's data). Photos/audio stay on the simple
      // whole-file path (small enough that resume overhead isn't worth it).
      const bucket = _bucketForUrl(url);
      const isBig = bucket === 'videos' || bucket === 'docs';
      // Size-scaled timeout: photos/audio keep the snappy 20s ceiling; big
      // media gets a much larger window (a 200MB video over slow 3G can take
      // minutes legitimately). createDownloadResumable can support cancel(),
      // so a stuck transfer is torn down rather than orphaning the promise.
      const BIG_TIMEOUT_MS = 120000;
      const SMALL_TIMEOUT_MS = 20000;
      const timeoutMs = isBig ? BIG_TIMEOUT_MS : SMALL_TIMEOUT_MS;
      let resumable = null; // persisted across retries so resume works
      // [2026-10-08 media-local-store] Hosts alternativos: se o 1º devolve
      // 404/HTML (ex.: edge sem proxy de /data/*), tenta o próximo (origem US,
      // depois CDN R2) antes de desistir. Falha de rede NÃO troca de host.
      for (let ci = 0; ci < _candidates.length; ci++) {
      const srcUrl = _candidates[ci];
      resumable = null;
      lastStatus = 0;
      for (let attempt = 0; attempt < BACKOFFS_MS.length; attempt++) {
        if (BACKOFFS_MS[attempt] > 0) {
          await new Promise(r => setTimeout(r, BACKOFFS_MS[attempt]));
        }
        if (_dlCtl.cancelled) throw new Error('dl_cancelled');
        try {
          let download;
          // [2026-10-09 media-native] Big media, first attempt → OS-owned
          // background download (iOS background URLSession / Android
          // WorkManager): keeps going with the app suspended or closed and is
          // re-attached by id on the next request. Network failure/stall →
          // falls through to the JS resumable path on the next attempt.
          if (isBig && attempt === 0 && !resumable && Platform.OS !== 'web') {
            try {
              const bgT = require('./bgTransfer');
              if (bgT.isBgTransferAvailable()) {
                let _ac = null;
                try { if (typeof AbortController !== 'undefined') _ac = new AbortController(); } catch {}
                if (_ac) _dlCtl.abort = () => { try { _ac.abort(); } catch {} };
                const r = await bgT.downloadInBackground({
                  id: 'dl-' + key, url: srcUrl, dest: localPath, title: opts.title || null,
                  signal: _ac ? _ac.signal : undefined,
                  onProgress: (f) => {
                    const pct = Math.max(0, Math.min(99, (Number(f) || 0) * 100));
                    _progEv('progress', { pct, loaded: _total0 ? Math.round(_total0 * pct / 100) : 0, total: _total0 });
                  },
                });
                _dlCtl.abort = null;
                if (_dlCtl.cancelled) throw new Error('dl_cancelled');
                if (r && r.handled) {
                  if (!r.ok && !r.status) throw new Error('bg_download_network');
                  download = { status: r.ok ? (r.status || 200) : r.status, headers: r.contentType ? { 'content-type': r.contentType } : {} };
                }
              }
            } catch (e) {
              if (e && (e.message === 'bg_download_network' || e.message === 'dl_cancelled')) throw e;
            }
          }
          if (download) {
            // handled natively above
          } else if (isBig && typeof fs.createDownloadResumable === 'function') {
            // Reuse the same resumable instance across attempts: the first
            // attempt calls downloadAsync(); subsequent attempts call
            // resumeAsync() to continue from the partial file on disk.
            if (!resumable) {
              resumable = fs.createDownloadResumable(srcUrl, localPath, {}, (dp) => {
                try {
                  const w = Number(dp?.totalBytesWritten) || 0;
                  const tt = Number(dp?.totalBytesExpectedToWrite) || _total0 || 0;
                  if (tt > 0) _progEv('progress', { pct: Math.min(99, (w / tt) * 100), loaded: w, total: tt });
                } catch {}
              });
            }
            _dlCtl.resumable = resumable;
            let timer = null;
            const timeout = new Promise((_, rej) => {
              timer = setTimeout(() => {
                try { resumable.cancelAsync?.(); } catch {}
                rej(new Error('download_timeout'));
              }, timeoutMs);
            });
            try {
              const op = attempt === 0
                ? resumable.downloadAsync()
                : resumable.resumeAsync();
              download = await Promise.race([op, timeout]);
            } finally {
              if (timer) clearTimeout(timer);
            }
          } else {
            // 20s timeout so a stuck CDN (slow 3G, dead edge node) doesn't hold
            // the promise forever and freeze downstream awaits.
            download = await Promise.race([
              fs.downloadAsync(srcUrl, localPath),
              new Promise((_, rej) => setTimeout(() => rej(new Error('download_timeout')), timeoutMs)),
            ]);
          }
          if (download?.status === 200 && _isHtmlForMedia(download.headers, url)) {
            // 200 com o index.html do SPA (edge/origem sem o arquivo) — nunca
            // gravar isso como "foto". Trata como ausente → próximo host.
            try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
            resumable = null;
            lastStatus = 404;
            break;
          }
          if (download?.status === 200) {
            // Integrity guard: a 200 with an empty/truncated body would
            // otherwise be cached as a "valid" file and served forever as a
            // blank bubble. Verify the on-disk file is non-zero before
            // accepting it; a zero-byte (or unstattable) result is dropped and
            // the retry loop tries again.
            let okSize = true;
            let _gotSize = 0;
            try {
              const st = await fs.getInfoAsync(localPath);
              okSize = !!(st && st.exists && st.size > 0);
              _gotSize = (st && st.size) || 0;
              // Truncated 200 (stream cut mid-body): size>0 but short of the
              // declared Content-Length → reject so the retry loop re-fetches
              // instead of poisoning the cache with a half-white photo.
              const _expected = _expectedBytesFromHeaders(download.headers);
              if (okSize && _expected > 0 && st.size !== _expected) okSize = false;
            } catch { okSize = false; }
            if (okSize) {
              // [2026-10-14 offline-media] URL sem extensão (wa_import_file) → o
              // arquivo do store ganha a extensão do Content-Type (iOS AVPlayer /
              // QuickLook não abrem ".bin"). A chave de lookup não muda.
              let _finalPath = localPath;
              let _finalPlan = _plan;
              if (_plan && _st && /\.bin$/i.test(localPath) && typeof _st.withExt === 'function') {
                const _ext = _extFromContentType(_headerCI(download.headers, 'content-type'));
                if (_ext) {
                  const _p2 = _st.withExt(_plan, _ext);
                  if (_p2 && _p2.abs !== localPath) {
                    try { await fs.moveAsync({ from: localPath, to: _p2.abs }); _finalPath = _p2.abs; _finalPlan = _p2; } catch {}
                  }
                }
              }
              registerSyncKey(url, _finalPath);
              _dlFailStatus.delete(key);
              if (_finalPlan && _st) { try { _st.record(_finalPlan, { urlKey: key, messageId: opts.messageId, size: _gotSize, own: !!opts.own }); } catch {} }
              // Count the downloaded bytes toward the network-usage total
              // (settings.js getNetStats). Fire-and-forget stat.
              _countDownloadedBytes(fs, _finalPath);
              return _finalPath;
            }
            // Corrupt/empty download — remove the partial and retry.
            try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
            resumable = null;
            lastStatus = 0;
            continue;
          }
          lastStatus = download?.status || 0;
          try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
          resumable = null; // bad response — don't try to resume a dead file
          // Abort em 4xx — não vai mudar com retry. Recursos ausentes /
          // tokens inválidos são bug, não flaky network.
          if (lastStatus >= 400 && lastStatus < 500) break;
        } catch (_e) {
          if (_dlCtl.cancelled) throw new Error('dl_cancelled');
          // Network/timeout — vale tentar de novo. For big media we KEEP the
          // partial file + resumable so the next attempt resumes; for small
          // media we delete so it restarts clean.
          if (!isBig) {
            try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
          }
        }
      }
      // Só 4xx/HTML justificam outro host; rede/5xx esgotados → para.
      if (!(lastStatus >= 400 && lastStatus < 500)) break;
      if (isBig) { try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {} }
      }
      // [2026-10-13 P1-3] Ausente em TODOS os hosts (404/410/403) → marca
      // falha definitiva p/ a varredura de fundo não re-tentar p/ sempre.
      if (lastStatus === 404 || lastStatus === 410 || lastStatus === 403) {
        _dlFailStatus.set(key, lastStatus);
        if (_dlFailStatus.size > 2000) { const k0 = _dlFailStatus.keys().next().value; _dlFailStatus.delete(k0); }
      }
      // Exhausted retries on a big-media transfer — clean up the partial so a
      // half-written video isn't mistaken for a complete cached file later.
      if (isBig) {
        try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
      }
    } catch {
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    } finally {
      _releaseDownloadSlot();
    }
    return url;
  })();
  _inflightDownloads.set(key, dlPromise);
  if (_bigForProgress) {
    dlPromise.then((res) => {
      _dlCancelFns.delete(key);
      const ok = typeof res === 'string' && res.startsWith('file://');
      _progEv(ok ? 'done' : (_dlCtl.cancelled ? 'cancelled' : 'failed'), { pct: ok ? 100 : 0, loaded: 0, total: _total0, local: ok ? res : null });
    }, () => {
      _dlCancelFns.delete(key);
      _progEv(_dlCtl.cancelled ? 'cancelled' : 'failed', { pct: 0, loaded: 0, total: _total0 });
    });
  }
  try {
    const result = await dlPromise;
    // [2026-10-13 delete-for-all] Apagada p/ todos enquanto baixava → descarta
    // o arquivo recém-gravado (sem galeria, sem local_path).
    // [2026-10-13 P1-1] Só a lápide do PRÓPRIO id descarta; quem baixou a
    // mesma URL p/ outra mensagem nunca vira lápide.
    if (result && typeof result === 'string' && result.startsWith('file://') && _isDeletedBlocked(url, opts)) {
      if (opts.messageId != null && opts.messageId !== '' && isMessageDeletedLocally(opts.messageId)) {
        try { purgeDeletedMessageMedia(opts.messageId, { url, conversationId: opts.conversationId }); } catch {}
      } else {
        // Sem id (bloqueio pela chave da URL, que só existe se a URL era
        // exclusiva da mensagem apagada).
        try { await deleteCachedUrl(url); } catch {}
        try { await fs.deleteAsync(result, { idempotent: true }); } catch {}
      }
      return url;
    }
    // [WhatsApp "Media visibility" 2026-05-26] Auto-save RECEIVED photos/videos
    // into the phone gallery. Only when the caller marked this download as
    // inbound (opts.received) — the ChatMedia render path (sent + received
    // bubbles) leaves it unset, so the user's own sent media is never re-saved.
    // De-duped + permission-gated + type-filtered inside the helper, so it's
    // safe to call unconditionally on every successful inbound download.
    if (opts.received && result && typeof result === 'string' && result.startsWith('file://') && Platform.OS !== 'web') {
      try { maybeAutoSaveToGallery(result, key, opts.mediaType || _bucketForUrl(url), { viewOnce: !!opts.viewOnce, messageId: opts.messageId, url, conversationId: opts.conversationId, noGallery: !!opts.noGallery }); } catch {}
    }
    // [#1215 2026-05-19] PHONE-FIRST MEDIA WRITE-BACK
    // When a foto/áudio/vídeo/gif/sticker/file download lands, mirror the
    // file:// path into the messages row's local_path column. This is what
    // lets a cold-open phone paint the media instantly from disk — without
    // it, the chatMediaCache index alone could desync and the bubble would
    // show "Mídia removida do cache" even though the file is sitting in
    // documentDirectory. The lookup goes via the message id we pass through
    // opts.messageId from prefetchIncomingMessageMedia.
    if (result && opts.messageId != null && opts.conversationId != null &&
        Platform.OS !== 'web' && typeof result === 'string' && result.startsWith('file://')) {
      // [P1 race fix 2026-05-26] AWAIT the local_path write-back instead of
      // fire-and-forget. getLocalUriIfCached itself reads the in-memory
      // syncIndex (already populated by registerSyncKey above, so the UI path
      // stays instant + non-blocking), but the DB row is the source of truth a
      // cold restart reads. Awaiting here guarantees the path is durably
      // persisted before cacheMedia resolves — a crash right after return can
      // no longer leave the file on disk with local_path still NULL. The whole
      // block stays inside try/catch so a DB failure never breaks the happy
      // path (we still return the file:// result).
      try {
        const nativeDb = require('./db');
        if (typeof nativeDb.dbUpdateMessageFields === 'function') {
          await nativeDb.dbUpdateMessageFields(opts.conversationId, opts.messageId, {
            local_path: result,
          });
        }
      } catch {}
    }
    return result;
  } finally {
    _inflightDownloads.delete(key);
    // Fire-and-forget LRU sweep (debounced inside) — keeps saved dir
    // bounded after each new download lands.
    try { evictIfNeeded(); } catch {}
  }
}

// Pre-cache an array of URLs (for batch caching when entering a conversation)
// [2026-10-21 tg3] Filtro do pré-download ESPECULATIVO (abrir conversa):
// tira (a) o que o "Limpar cache"/LRU apagou e (b) o ORIGINAL de foto que tem
// versão de tela (image_variants.display) — a bolha pinta a de tela (cache do
// expo-image) e o original só baixa em tela cheia/salvar.
// msgs[i] ↔ urls[i]. Kill: __chatyy_bubble_display_only=false (só tira (a)).
export function filterSpeculativeMediaUrls(msgs, urls) {
  if (!Array.isArray(msgs) || !Array.isArray(urls)) return urls;
  let dispOnly = true;
  try { dispOnly = globalThis.__chatyy_bubble_display_only !== false; } catch {}
  const out = [];
  for (let i = 0; i < urls.length; i++) {
    const m = msgs[i];
    const u = urls[i];
    if (!m) { out.push(u); continue; }
    try { if (wasMediaClearedForAutoSync(m, u)) continue; } catch {}
    if (dispOnly && m.type === 'image') {
      let iv = m.image_variants;
      if (typeof iv === 'string') { try { iv = JSON.parse(iv); } catch { iv = null; } }
      if (iv && typeof iv.display === 'string' && iv.display) continue;
    }
    out.push(u);
  }
  return out;
}

export async function preCacheUrls(urls) {
  if (Platform.OS === 'web' || !urls?.length) return;
  // Cache em batches de 20 — antes só processava os 20 primeiros e
  // ignorava o resto, deixando mídias antigas sem cache.
  for (let i = 0; i < urls.length; i += 20) {
    // Batch pre-cache is a background warm-up — yield the download lane to any
    // visible-viewport/on-demand request so opening a conversation doesn't make
    // the photo on screen wait behind the bulk warm of the whole thread.
    await Promise.allSettled(urls.slice(i, i + 20).map(url => cacheMedia(url, { priority: 'low' })));
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
// `opts.priority` ('low' | 'high', default 'high') selects the shared
// download lane. Background prefetch (voice-note auto-prefetch) passes 'low'
// so it yields to on-demand/foreground downloads under contention.
export async function saveMediaPermanent(url, opts = {}) {
  const r = await _saveMediaPermanentInner(url, opts);
  // [2026-10-13 delete-for-all] Lápide chegou durante o download → descarta.
  // [2026-10-13 P1-1] Só a lápide do PRÓPRIO id descarta (nunca cria lápide
  // p/ quem baixou a mesma URL p/ outra mensagem).
  if (r && r !== url && typeof r === 'string' && r.startsWith('file://') && _isDeletedBlocked(url, opts)) {
    if (opts && opts.messageId != null && opts.messageId !== '' && isMessageDeletedLocally(opts.messageId)) {
      try { purgeDeletedMessageMedia(opts.messageId, { url, conversationId: opts.conversationId }); } catch {}
    } else {
      try { await deleteCachedUrl(url); } catch {}
      try { await getFS()?.deleteAsync(r, { idempotent: true }); } catch {}
    }
    return url;
  }
  // [2026-10-21 tg3] limpeza automática também depois do download permanente.
  if (r && r !== url && typeof r === 'string') { try { evictIfNeeded(); } catch {} }
  return r;
}
async function _saveMediaPermanentInner(url, opts = {}) {
  if (!url || Platform.OS === 'web') return url;
  const fs = getFS();
  if (!fs) return url;

  if (_isViewOnceBlocked(url, opts)) return url;
  const key = urlToKey(url);
  // [2026-10-08 media-local-store] Mídia de conversa → store permanente por
  // conta/conversa; o dir plano "saved" fica só p/ o que não tem conversa.
  const _st = _store();
  const _plan = _planStore(url, key, opts);
  const flatDir = getSavedDir();
  const dir = _plan ? _plan.dir : flatDir;
  const localPath = _plan ? _plan.abs : flatDir + key;

  try {
    const sp = _st ? _st.lookupByUrlKey(key) : null;
    if (sp) {
      try {
        const info = await fs.getInfoAsync(sp);
        if (info.exists && info.size > 0) { registerSyncKey(url, sp); return sp; }
      } catch {}
      try { _st.forgetUrlKey(key); } catch {}
    }
  } catch {}

  // [HOT PATH 2026-05-26] In-memory index hit → file is in the permanent dir
  // (this function only ever writes there) which the LRU sweep never touches,
  // so it can't have been auto-evicted. Return it without the getInfoAsync
  // round-trip. Keeps the prefetch/adopt callers' fast cache-hit path zero-I/O.
  const indexedSave = syncIndex.get(key);
  if (indexedSave && flatDir && indexedSave.startsWith(flatDir)) return indexedSave;

  try {
    const info = await fs.getInfoAsync(flatDir + key);
    if (info.exists && info.size > 0) { registerSyncKey(url, flatDir + key); return flatDir + key; }
  } catch {}

  try {
    const dirInfo = await fs.getInfoAsync(dir);
    if (!dirInfo.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });

    // Check if already in cache — move instead of re-downloading
    const cachedPath = getCacheDir() + key;
    try {
      const cachedInfo = await fs.getInfoAsync(cachedPath);
      if (cachedInfo.exists) {
        if (_plan) {
          const promoted = await _promoteToStore(fs, cachedPath, _plan, url, key, opts);
          if (promoted) return promoted;
        }
        await fs.copyAsync({ from: cachedPath, to: localPath });
        registerSyncKey(url, localPath);
        return localPath;
      }
    } catch {}

    // Download fresh — go through the global concurrency throttle so a
    // burst of audio prefetches (e.g. 10 voice notes arriving over WS
    // after a reconnect) can't saturate the radio behind cacheMedia's
    // back. _MAX_CONCURRENT_DOWNLOADS is shared across both code paths.
    await _acquireDownloadSlot(opts.priority === 'low' ? 'low' : 'high');
    try {
      // [2026-10-08 media-local-store] host original → alternativos em 404/HTML.
      const cands = [url, ..._fallbackUrls(url)];
      let download = null;
      for (const src of cands) {
        try { download = await fs.downloadAsync(src, localPath); } catch { download = null; break; }
        if (download && download.status === 200 && _isHtmlForMedia(download.headers, url)) {
          try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
          download = { status: 404 };
          continue;
        }
        if (download && download.status >= 400 && download.status < 500) {
          try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
          continue;
        }
        break;
      }
      if (download && download.status === 200) {
        // Integrity guard (mirror cacheMedia ~1413): a 200 with an empty/
        // truncated body would otherwise be registered as a "valid" file and
        // served forever as a blank photo / silent audio. Only accept a
        // non-zero on-disk file; drop a zero-byte (or unstattable) result and
        // fall through to returning the remote URL.
        let okSize = true;
        let _gotSize = 0;
        try {
          const st = await fs.getInfoAsync(localPath);
          okSize = !!(st && st.exists && st.size > 0);
          _gotSize = (st && st.size) || 0;
          // Same truncation guard as cacheMedia above — a 200 whose body was
          // cut mid-stream must not be registered as a valid permanent copy.
          const _expected = _expectedBytesFromHeaders(download.headers);
          if (okSize && _expected > 0 && st.size !== _expected) okSize = false;
        } catch { okSize = false; }
        if (okSize) {
          registerSyncKey(url, localPath);
          if (_plan && _st) { try { _st.record(_plan, { urlKey: key, messageId: opts.messageId, size: _gotSize, own: !!opts.own }); } catch {} }
          _countDownloadedBytes(fs, localPath); // network-usage counter (getNetStats)
          return localPath;
        }
      }
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
export async function adoptLocalFileAsCache(remoteUrl, localUri, opts = {}) {
  if (Platform.OS === 'web' || !remoteUrl || !localUri) return null;
  if (typeof localUri !== 'string' || !localUri.startsWith('file://')) return null;
  const fs = getFS();
  if (!fs) return null;
  const key = urlToKey(remoteUrl);
  // [2026-10-08 media-local-store] Mídia ENVIADA: o original local vai pro
  // store permanente da conversa (media/<conta>/<conv>/<msgId>.<ext>), marcado
  // como "minha" — nunca re-baixa nem some se o servidor falhar.
  const _st = _store();
  const _plan = _planStore(remoteUrl, key, { ...(opts || {}), viewOnce: false });
  if (_plan && _st) {
    if (_plan.existing) {
      try {
        const ex = await fs.getInfoAsync(_plan.abs);
        if (ex.exists && ex.size > 0) { registerSyncKey(remoteUrl, _plan.abs); return _plan.abs; }
      } catch {}
    }
    if (localUri === _plan.abs) { registerSyncKey(remoteUrl, _plan.abs); return _plan.abs; }
    try {
      const src = await fs.getInfoAsync(localUri);
      if (src.exists && src.size > 0) {
        try { await fs.makeDirectoryAsync(_plan.dir, { intermediates: true }); } catch {}
        await fs.copyAsync({ from: localUri, to: _plan.abs });
        _st.record(_plan, { urlKey: key, messageId: opts && opts.messageId, size: src.size, own: true });
        registerSyncKey(remoteUrl, _plan.abs);
        return _plan.abs;
      }
    } catch {
      try { await fs.deleteAsync(_plan.abs, { idempotent: true }); } catch {}
    }
  }
  const dir = getSavedDir();
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
export function prefetchIncomingMessageMedia(message, ctx) {
  if (!message || Platform.OS === 'web') return;
  // [2026-10-15 media-visibility] Só mídia RECEBIDA vai p/ a galeria: a própria
  // (eco do envio / enviada de outro aparelho meu) nunca é duplicada (WhatsApp).
  // ctx.noGallery = histórico em massa (restauração / "baixar tudo").
  const _fromMe = _isOwnMessage(message);
  const _noGallery = !!(ctx && ctx.noGallery);
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

  // [2026-10-13 delete-for-all] Já apagada (sync/histórico/lápide local) → nada
  // de baixar; limpa o que tiver sobrado.
  if (isDeletedMessage(message)) { purgeDeletedFromMessages([message]); return; }
  if (message.id != null && isMessageDeletedLocally(message.id)) return;

  // PRIVACY (view-once): NEVER background-prefetch view-once media. Doing so
  // downloads it permanently AND — because the download is flagged received —
  // auto-saves it to the camera roll BEFORE the recipient ever opens it,
  // defeating the whole point of view-once. Bail out entirely; the bubble's
  // explicit tap-to-view path handles fetching a view-once item on demand.
  if (message && (message.is_view_once || message.view_once || message.isViewOnce)) {
    if (isViewOnceMessage(message)) markViewOnceMedia(message.file_url, message.id);
    return;
  }

  // GIFs / stickers ship their URL in `content` (Tenor / sticker server),
  // not file_url. Other types use file_url. Support both shapes.
  let rawUrl = message.file_url;
  if (!rawUrl && isGifLike && typeof message.content === 'string' && message.content.startsWith('http')) {
    rawUrl = message.content;
  }
  if (!rawUrl || typeof rawUrl !== 'string') return;
  const url = rawUrl.startsWith('http') ? rawUrl : `https://chatyy.com.br${rawUrl}`;

  // HLS branch: if the message is a video AND the URL is an .m3u8 playlist,
  // route through cacheHlsVideo() which downloads the manifest + .ts segments
  // for true offline playback. The progressive mp4 path (cacheMedia) can't
  // serve HLS because the player needs the whole manifest tree, not a single
  // file. Honors the same 'videos' bucket gate as the mp4 path.
  // Also: when the message has BOTH a file_url (mp4) and a hlsUrl, the
  // hlsUrl is the preferred player source — try that first so the offline
  // copy matches what ChatMediaViewer will mount.
  // Data Saver: skip ALL video pre-cache/preload (both HLS + progressive mp4).
  // The user can still tap-to-download in the bubble (force:true bypasses).
  if ((isVideo) && isDataSaverOn()) return;
  const hlsCandidate = (isVideo && typeof message.hlsUrl === 'string' && message.hlsUrl)
    ? (message.hlsUrl.startsWith('http') ? message.hlsUrl : `https://chatyy.com.br${message.hlsUrl}`)
    : (isVideo && isHlsUrl(url) ? url : null);
  if (hlsCandidate) {
    const convId2 = message.conversation_id ?? message.conversationId;
    const _hopts = {
      messageId: message.id,
      conversationId: convId2,
    };
    try { cacheHlsVideo(hlsCandidate, _hopts).catch(() => {}); } catch {}
    if (convId2 != null) tagUrlConversation(hlsCandidate, convId2);
    return;
  }

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
      // [#1218 2026-05-20 BUG#6 fix] Pass messageId/conversationId so the
      // resolved file:// path lands in messages.local_path via dbUpdate —
      // image+video already do this, audio was the one type that wasn't.
      prefetchAudioMessage(url, { messageId: message.id, conversationId: convId });
      if (convId != null) tagUrlConversation(url, convId);
    } else {
      // Image / video / file / gif / sticker — honor the per-bucket cellular
      // gate via cacheMedia. Photos default to wifi, video/docs default to
      // never; tap-to-download in the bubble bypasses with { force: true }.
      // Fire-and-forget; failures don't bubble up to the WS handler.
      // [#1215 2026-05-19] Pass messageId so cacheMedia can write the
      // resulting file:// path back into the messages row's local_path
      // column on success — phone-first storage parity.
      // Mark this as a RECEIVED download + tag the media type so cacheMedia's
      // success path can auto-save photos/videos into the phone gallery
      // (WhatsApp "Media visibility"). Only image/video reach the gallery;
      // file/gif/sticker are excluded inside maybeAutoSaveToGallery.
      // [2026-10-13] video_note segue identificado → nunca vai p/ a galeria (WhatsApp).
      const _isNote = t === 'video_note' || /video_note_/i.test(String(message.file_name || '')) || /video_note_/i.test(url);
      const _mediaType = isImage ? 'image' : isVideo ? (_isNote ? 'video_note' : 'video') : (t || null);
      const _opts = convId != null
        ? { conversationId: convId, messageId: message.id, received: true, mediaType: _mediaType }
        : (message.id != null
            ? { messageId: message.id, received: true, mediaType: _mediaType }
            : { received: true, mediaType: _mediaType });
      if (_fromMe || _noGallery) _opts.noGallery = true;
      cacheMedia(url, _opts).catch(() => {});
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
export function prefetchAudioMessage(remoteUrl, opts = {}) {
  if (!remoteUrl || Platform.OS === 'web') return Promise.resolve(remoteUrl);
  remoteUrl = playableAudioUrl(remoteUrl); // [2026-10-14 wa-audio-m4a] mesma chave do player
  try { console.log('[audio_offline] prefetch', String(remoteUrl).slice(0, 80)); } catch {}
  // saveMediaPermanent writes to documentDirectory (the "saved" dir) — same
  // location getCachedAudioUri checks via the mediaCache consolidation hook,
  // so a single download serves both the bubble's player AND the chat list
  // preview. No cellular gate inside saveMediaPermanent → safe for audio.
  // Background prefetch → low lane so a burst of inbound voice notes never
  // out-competes the image/video the user is actively viewing.
  return saveMediaPermanent(remoteUrl, {
    priority: 'low',
    conversationId: opts && opts.conversationId != null ? opts.conversationId : undefined,
    messageId: opts && opts.messageId != null ? opts.messageId : undefined,
  }).then(async (local) => {
    // [#1218 2026-05-20 BUG#6 fix] Write the file:// path back into
    // messages.local_path so a cold-open of the bubble doesn't re-resolve
    // from the syncIndex (which can be stale after an account swap or
    // app reinstall). Image+video already had this hook; audio now matches.
    //
    // [P1 race fix 2026-05-26] AWAIT the write-back (was fire-and-forget with
    // no .catch — an async reject would surface as an unhandled rejection) so
    // the path is durably persisted before this resolves. The gate requires
    // BOTH ids because dbUpdateMessageFields keys its UPDATE on
    // (conversationId, messageId); callers that only pass a URL (bubble render
    // / chat-list prefetch) have no ids to write and rely on the syncIndex
    // entry registerSyncKey already wrote inside saveMediaPermanent.
    try {
      if (typeof local === 'string' && local.startsWith('file://')
          && opts && opts.messageId != null && opts.conversationId != null) {
        const nativeDb = require('./db');
        if (typeof nativeDb.dbUpdateMessageFields === 'function') {
          await nativeDb.dbUpdateMessageFields(opts.conversationId, opts.messageId, { local_path: local });
        }
      }
    } catch {}
    return local;
  }).catch(() => remoteUrl);
}

// True iff the URL looks like an HLS playlist. The CDN serves these from
// `/data/chat-files/<id>/index.m3u8` (and master variants under similar
// suffixes), so a path-segment match is reliable. Query strings are stripped
// before matching because signed URLs append `?token=…`.
export function isHlsUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  const base = url.split('?')[0].split('#')[0].toLowerCase();
  return base.endsWith('.m3u8');
}

/**
 * HLS counterpart of cacheMedia(): downloads the manifest + all .ts segments
 * for offline playback, using the message id as the stable folder key. Goes
 * through hlsOffline.downloadHls() so segment dedup / resume / concurrency
 * cap are inherited. On success, writes the rewritten local manifest path
 * back into messages.local_path so a cold-open of the bubble can read from
 * disk without first probing the offline cache.
 *
 * Honors the same per-bucket cellular gate as cacheMedia for the 'videos'
 * bucket (default: wifi-only). force:true (tap-to-download) bypasses.
 *
 * Returns the local manifest path on success or the original remote URL on
 * failure / web / gate-rejection. Idempotent: if the manifest already exists
 * on disk we short-circuit without re-downloading.
 */
export async function cacheHlsVideo(hlsUrl, opts = {}) {
  if (!hlsUrl || Platform.OS === 'web') return hlsUrl;
  const videoId = opts.messageId != null ? String(opts.messageId)
    : (opts.videoId != null ? String(opts.videoId) : null);
  if (!videoId) return hlsUrl;
  if (_isDeletedBlocked(hlsUrl, { messageId: videoId })) return hlsUrl; // [2026-10-13 delete-for-all]

  // Gate. videos bucket default: wifi ON, cellular OFF, roaming OFF.
  if (!opts.force) {
    if (!shouldAutoDownload('video')) return hlsUrl;
  }

  let hlsMod;
  try { hlsMod = require('./hlsOffline'); } catch { return hlsUrl; }

  // Short-circuit if a completed manifest is already on disk.
  try {
    const existing = await hlsMod.getLocalManifest?.(videoId);
    if (existing) return existing;
  } catch {}

  let localPath = null;
  try {
    localPath = await hlsMod.downloadHls(videoId, hlsUrl);
  } catch { localPath = null; }

  if (!localPath) return hlsUrl;
  if (_isDeletedBlocked(hlsUrl, { messageId: videoId })) { try { await hlsMod.deleteHls?.(videoId); } catch {} return hlsUrl; }

  // Write the local manifest back into messages.local_path so cold-open
  // paints from disk instantly — same pattern as cacheMedia for mp4/audio.
  if (opts.messageId != null && opts.conversationId != null) {
    try {
      const nativeDb = require('./db');
      if (typeof nativeDb.dbUpdateMessageFields === 'function') {
        nativeDb.dbUpdateMessageFields(opts.conversationId, opts.messageId, {
          local_path: localPath.startsWith('file://') ? localPath : ('file://' + localPath),
        }).catch(() => {});
      }
    } catch {}
  }

  // Best-effort LRU sweep — keeps documentDirectory/video-offline bounded.
  try { hlsMod.evictHlsCache?.().catch(() => {}); } catch {}

  return localPath.startsWith('file://') ? localPath : ('file://' + localPath);
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
//
// [WAVE 36 2026-05-20] Optional second arg `convIdHint`. Callers from
// chat-conversation pass the active conversationId so the local_path
// write-back works even when individual rows have no conversation_id
// property (some chat_sync payload shapes carry it only on the envelope,
// not on each message). QA hit msg 8413: video 62KB, file on disk in
// /chat-media-saved/, but local_path NULL because the writeback bailed at
// `msg.conversation_id != null` (both convId fields were absent).
export async function saveConversationMedia(messages, convIdHint) {
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
  // [#1221 2026-05-20] WhatsApp-parity sweep — skip messages that already
  // have a local_path (file already on disk). Without this filter, every
  // chat reopen would re-issue saveMediaPermanent for hundreds of msgs,
  // burning CPU + battery on no-op filesystem stats.
  try { markViewOnceFromMessages(messages); } catch {}
  try { purgeDeletedFromMessages(messages); } catch {}
  const mediaMessages = messages.filter(m => {
    if (!types.includes(m.type)) return false;
    if (isDeletedMessage(m) || isMessageDeletedLocally(m.id)) return false;
    if (isViewOnceMessage(m)) return false;
    if (!pickUrl(m)) return false;
    // Skip if SQLite already says we have it. The bubble's getCachedUri will
    // still re-validate file existence at render time, so this is safe.
    if (m.local_path && typeof m.local_path === 'string' && m.local_path.startsWith('file://')) return false;
    // [2026-10-20 tg2] varredura ao abrir a conversa é ESPECULATIVA → respeita o
    // "baixar automaticamente" por tipo/rede (antes baixava tudo no 4G, inclusive
    // vídeo/documento). O toque na bolha continua forçando. Kill: __chatyy_conv_sweep_gate=false.
    try { if (globalThis.__chatyy_conv_sweep_gate !== false && !shouldAutoDownload(m.type)) return false; } catch {}
    // [2026-10-21 tg3] apagada pelo "Limpar cache"/LRU → não re-baixa sozinha.
    if (wasMediaClearedForAutoSync(m, pickUrl(m))) return false;
    // [2026-10-21 tg3] foto com versão de tela: a bolha pinta a de tela; o original
    // só baixa em tela cheia/salvar (kill __chatyy_bubble_display_only=false).
    if (m.type === 'image' && filterSpeculativeMediaUrls([m], ['x']).length === 0) return false;
    return true;
  });
  const BATCH_SIZE = 20;
  for (let i = 0; i < mediaMessages.length; i += BATCH_SIZE) {
    const batch = mediaMessages.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(msg => {
      const raw = pickUrl(msg);
      const url = raw?.startsWith('http') ? raw : `https://chatyy.com.br${raw}`;
      // [#1221 2026-05-20] Write-back local_path so the bubble can read from
      // disk on cold-open. Same hook image/video already had on the WS path;
      // it was missing on the conversation-load sweep, leaving files on disk
      // but msg.local_path NULL — bubble showed "mídia não foi baixada".
      const _cid = msg.conversation_id || msg.conversationId || convIdHint;
      if (msg.is_view_once || msg.view_once || msg.isViewOnce) return Promise.resolve(url);
      return saveMediaPermanent(url, {
        priority: 'low',
        conversationId: _cid != null ? _cid : undefined,
        messageId: msg.id != null ? msg.id : undefined,
      }).then((local) => {
        try {
          // [WAVE 36 2026-05-20] Coerce file path → file:// URI form before
          // checking. saveMediaPermanent returns whatever path expo-fs gave
          // it; on Android documentDirectory often comes back without the
          // file:// prefix from the underlying SAF call, which made this
          // check silently no-op. Now we accept both.
          const localFileUri = (typeof local === 'string' && local && (local.startsWith('file://') ? local : (local.startsWith('/') ? `file://${local}` : null))) || null;
          if (localFileUri && msg.id != null) {
            const convId = msg.conversation_id || msg.conversationId || convIdHint;
            if (convId != null) {
              const nativeDb = require('./db');
              nativeDb.dbUpdateMessageFields?.(convId, msg.id, { local_path: localFileUri });
            }
          }
        } catch {}
        return local;
      }).catch(() => {});
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
// ── [2026-10-21 tg3] "Limpo em X" — a varredura automática não re-baixa ──────
// o que o "Limpar cache"/limpeza de uma conversa/LRU apagou. Telegram: limpar
// o cache libera espaço DE VERDADE; a mídia volta só quando a pessoa toca na
// bolha (ou chega mensagem NOVA). Duas marcas (MMKV, por aparelho):
//   - media_cleared_at_v1: ms do último "Limpar cache" geral → mensagens
//     criadas até ali ficam fora da varredura automática;
//   - media_evicted_keys_v1: chaves (urlToKey) apagadas pelo LRU/limpar
//     conversa (máx. 4000, as mais antigas saem primeiro).
// Toque/visualizador/"Baixar mídias faltantes" (force) continuam baixando.
// Kill: globalThis.__chatyy_respect_cleared = false.
const CLEARED_AT_KEY = 'media_cleared_at_v1';
const EVICTED_KEYS_KEY = 'media_evicted_keys_v1';
const EVICTED_KEYS_MAX = 4000;
let _clearedAtMs = null;
let _evictedKeys = null; // Set (ordem de inserção = antiguidade)
let _evictedPersistT = null;
function _hydrateClearMarks() {
  if (_clearedAtMs !== null && _evictedKeys) return;
  let mm = null;
  try { mm = require('./mmkv'); } catch {}
  if (_clearedAtMs === null) {
    _clearedAtMs = 0;
    try { const v = Number(mm?.getString?.(CLEARED_AT_KEY)); if (Number.isFinite(v) && v > 0) _clearedAtMs = v; } catch {}
  }
  if (!_evictedKeys) {
    _evictedKeys = new Set();
    try {
      const raw = mm?.getString?.(EVICTED_KEYS_KEY);
      const arr = raw ? JSON.parse(raw) : null;
      if (Array.isArray(arr)) for (const k of arr) if (typeof k === 'string' && k) _evictedKeys.add(k);
    } catch {}
  }
}
function _persistEvictedSoon() {
  if (_evictedPersistT) return;
  _evictedPersistT = setTimeout(() => {
    _evictedPersistT = null;
    try { require('./mmkv').setString?.(EVICTED_KEYS_KEY, JSON.stringify(Array.from(_evictedKeys || []))); } catch {}
  }, 1500);
}
function _noteEvictedKeys(keys) {
  if (!keys || !keys.length) return;
  _hydrateClearMarks();
  for (const k0 of keys) {
    const k = typeof k0 === 'string' ? k0.split('/').pop() : null;
    if (!k) continue;
    _evictedKeys.delete(k);
    _evictedKeys.add(k);
  }
  if (_evictedKeys.size > EVICTED_KEYS_MAX) {
    let drop = _evictedKeys.size - EVICTED_KEYS_MAX;
    for (const k of _evictedKeys) { if (drop-- <= 0) break; _evictedKeys.delete(k); }
  }
  _persistEvictedSoon();
}
function _markClearedNow() {
  _hydrateClearMarks();
  _clearedAtMs = Date.now();
  try { require('./mmkv').setString?.(CLEARED_AT_KEY, String(_clearedAtMs)); } catch {}
  // a marca geral cobre tudo o que existia → a lista por chave recomeça
  _evictedKeys = new Set();
  _persistEvictedSoon();
}
function _msgTimeMs(m) {
  const v = m && (m.created_at != null ? m.created_at : m.createdAt);
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(String(v).replace(' ', 'T'));
  return Number.isFinite(t) ? t : 0;
}
/** Ms do último "Limpar cache" geral (0 = nunca). */
export function getMediaClearedAt() { _hydrateClearMarks(); return _clearedAtMs || 0; }
/**
 * true = a mídia desta mensagem foi apagada de propósito (limpar cache / LRU)
 * → a sincronização AUTOMÁTICA não deve baixá-la de novo.
 * m: { file_url | url, created_at } (linha do SQLite/servidor).
 */
export function wasMediaClearedForAutoSync(m, urlHint) {
  try {
    if (globalThis.__chatyy_respect_cleared === false) return false;
  } catch {}
  if (Platform.OS === 'web' || !m) return false;
  _hydrateClearMarks();
  if (_clearedAtMs > 0) {
    const t = _msgTimeMs(m);
    if (t > 0 && t <= _clearedAtMs) return true;
  }
  if (_evictedKeys && _evictedKeys.size) {
    const raw = urlHint || m.file_url || m.url || ((m.type === 'gif' || m.type === 'sticker') ? m.content : null);
    if (typeof raw === 'string' && raw) {
      try {
        const u = raw.startsWith('http') ? raw : `https://chatyy.com.br${raw}`;
        if (_evictedKeys.has(urlToKey(u))) return true;
      } catch {}
    }
  }
  return false;
}

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
      // [2026-10-14 offline-media] Store permanente (mídia de conversa já
      // aberta/baixada): evicção SÓ acima do limite — mín. 2 GB (o limite do
      // usuário vale se maior; "Ilimitado" = nunca) — LRU por última abertura,
      // nunca o que foi aberto nos últimos 14 dias nem conversa "Manter sempre".
      try {
        const st = _store();
        if (st && typeof st.evictLRU === 'function') {
          const storeLimit = Math.max(limitBytes, STORE_MIN_CAP_MB * 1024 * 1024);
          const r = await st.evictLRU({
            limitBytes: storeLimit,
            protectConvs: { has: (c) => { try { return isConversationKeepAlways(c); } catch { return false; } } },
          });
          if (r && r.removed && r.removed.length) {
            const names = [];
            for (const x of r.removed) {
              if (x.urlKey) syncIndex.delete(x.urlKey);
              if (x.abs) names.push(x.abs.split('/').slice(-2).join('/'));
            }
            _noteEvictedKeys(r.removed.map((x) => x && x.urlKey).filter(Boolean)); // [tg3]
            try { const nativeDb = require('./db'); nativeDb.dbClearLocalPathByFilenames?.(names)?.catch?.(() => {}); } catch {}
          }
        }
      } catch {}
      const entries = [];
      // [P0 DATA LOSS 2026-05-26] PRIMARY GUARD: the LRU sweep walks ONLY the
      // OS-purgeable cache dir, never getSavedDir(). The saved/permanent dir
      // holds Keep-Always media (and the default download target — see
      // cacheMedia); evicting it on a cold start (when the _urlConvOwner
      // protection map was still empty) was silently destroying user data.
      // The permanent dir is now off-limits to automatic eviction entirely;
      // it is only cleared by explicit user action (clearAllCache /
      // clearSavedMedia / deleteCachedUrl / per-conversation delete).
      for (const dir of [getCacheDir()]) {
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
      // [#1222 2026-05-20 Wave 5] Track evicted filenames so we can also
      // NULL the messages.local_path column for rows that pointed to those
      // files. Without this, the bubble reads local_path = "file://..." but
      // the file is gone — falls through to "Mídia removida do cache" even
      // when no internet. Bulk update at the end is one round trip per
      // batch (cheap; up to ~50 entries per evict).
      const evictedNames = [];
      for (const e of entries) {
        if (freed >= need) break;
        if (_isFileProtected(e.name)) { skipped.push(e); continue; }
        try {
          await fs.deleteAsync(e.path, { idempotent: true });
          syncIndex.delete(e.name);
          _urlConvOwner.delete(e.name);
          evictedNames.push(e.name);
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
            evictedNames.push(e.name);
            freed += e.size;
          } catch {}
        }
      }
      // [#1222 2026-05-20 Wave 5] NULL local_path in DB for evicted files
      // so the bubble's stale `local_path` doesn't lie about the file's
      // presence. Fire-and-forget — failure is non-fatal (next render
      // falls back to file existence check in resolvePlayUri).
      if (evictedNames.length > 0) {
        _noteEvictedKeys(evictedNames); // [2026-10-21 tg3] varredura não re-baixa
        try {
          const nativeDb = require('./db');
          if (typeof nativeDb.dbClearLocalPathByFilenames === 'function') {
            nativeDb.dbClearLocalPathByFilenames(evictedNames).catch(() => {});
          }
        } catch {}
        _scheduleUrlConvOwnerPersist();
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
  // [#1239 2026-05-26] Snapshot filenames before delete so we can NULL the
  // matching messages.local_path rows (same rationale as clearAllCache).
  const wipedNames = [];
  try {
    const info = await fs.getInfoAsync(dir);
    if (info.exists) {
      const names = await fs.readDirectoryAsync(dir);
      for (const n of names) if (typeof n === 'string') wipedNames.push(n);
    }
  } catch {}
  try {
    await fs.deleteAsync(dir, { idempotent: true });
  } catch {}
  _noteEvictedKeys(wipedNames); // [2026-10-21 tg3]
  // HLS offline tree is OS-purgeable-style cache too — clear it here so the
  // "clear cache" path doesn't leave orphaned video-offline segments behind.
  try { require('./hlsOffline').clearAllHls?.(); } catch {}
  if (wipedNames.length > 0) {
    try {
      const nativeDb = require('./db');
      if (typeof nativeDb.dbClearLocalPathByFilenames === 'function') {
        nativeDb.dbClearLocalPathByFilenames(wipedNames).catch(() => {});
      }
    } catch {}
  }
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
  try {
    const st = _store();
    const sp = st ? st.lookupByUrlKey(key) : null;
    if (sp) { try { await fs.deleteAsync(sp, { idempotent: true }); } catch {} st.forgetUrlKey(key); }
  } catch {}
  syncIndex.delete(urlToKey(url));
}

// Bulk delete local media for a conversation. Pass the list of messages
// (from the SmartCache / server) before the DB rows are wiped.
export async function deleteConversationMedia(messages) {
  if (Platform.OS === 'web' || !Array.isArray(messages) || messages.length === 0) return;
  // [2026-10-08 media-local-store] apaga também a pasta da conversa no store.
  try {
    const cid = messages.find(m => m && (m.conversation_id != null || m.conversationId != null));
    const conv = cid ? (cid.conversation_id != null ? cid.conversation_id : cid.conversationId) : null;
    if (conv != null) await clearConversationLocalMedia(conv);
  } catch {}
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

  // [2026-10-08 media-local-store] Store permanente (media/<conta>/<conv>/…)
  // — SÓ a pasta da conta ativa (outra conta no mesmo aparelho não aparece).
  let storeBytes = 0;
  let conversations = [];
  try {
    const st = _store();
    if (st) {
      const scan = await st.scanAccountDisk(_bucketForFilename);
      for (const f of scan.files) {
        const b = f.bucket || 'document';
        byType[b] += f.size; counts[b] += 1;
      }
      storeBytes = scan.bytes;
      savedBytes += scan.bytes;
      conversations = st.listConversations();
    }
  } catch {}

  // [#1239 2026-05-26] Fold the HLS offline tree
  // (documentDirectory/video-offline/<videoId>/*.ts) into the stats so the
  // Storage UI reflects ALL on-disk media. Previously this multi-GB tree was
  // invisible — users saw "0 used" while their disk filled with offline
  // status/chat HLS. Counts toward the video bucket and savedBytes (permanent).
  try {
    const hlsRoot = fs.documentDirectory + 'video-offline/';
    const rootInfo = await fs.getInfoAsync(hlsRoot);
    if (rootInfo.exists) {
      const videoIds = await fs.readDirectoryAsync(hlsRoot);
      for (const vid of videoIds) {
        const vidDir = hlsRoot + vid + '/';
        try {
          const segNames = await fs.readDirectoryAsync(vidDir);
          for (const seg of segNames) {
            try {
              const st = await fs.getInfoAsync(vidDir + seg);
              if (!st.exists || st.isDirectory) continue;
              const size = st.size || 0;
              byType.video += size;
              counts.video += 1;
              savedBytes += size;
            } catch {}
          }
        } catch {}
      }
    }
  } catch {}

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
    storeBytes,
    conversations,
    byType,
    counts,
    capBytes,
    capMb: Number.isFinite(capMb) ? capMb : 0,
  };
}

// [2026-10-21 tg3] Limpa os caches de mídia que vivem FORA de getCacheDir/store e
// têm API exposta ao JS. Cada um é opcional (binário antigo/web = no-op). Nunca lança.
export async function clearNativeImageCaches() {
  if (Platform.OS === 'web') return;
  try {
    const ExpoImage = require('expo-image').Image;
    if (ExpoImage?.clearMemoryCache) { try { await ExpoImage.clearMemoryCache(); } catch {} }
    if (ExpoImage?.clearDiskCache) { try { await ExpoImage.clearDiskCache(); } catch {} }
  } catch {}
  // expo-video (cache LRU de vídeos) + ExpoShorts (ExoPlayer, Android).
  try { await require('./videoCacheSource').clearVideoDiskCache?.(); } catch {}
  // Cache nativo de mídia do chat (media_uris) — só quando o módulo está liberado.
  try {
    const nc = require('./nativeChatCacheGate').getNativeChatCache?.();
    if (nc && typeof nc.clearMediaCache === 'function') await nc.clearMediaCache();
  } catch {}
  // Miniaturas base64 (LQIP) ficam: são do payload (KBs), pintam o borrado sem rede.
}

// Nuke both cache + saved media in one call. Used by the "Clear cache" button
// in settings. Also clears the in-memory syncIndex so subsequent lookups
// re-scan disk (finding nothing) and the bubbles re-download on demand.
export async function clearAllCache() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  // [#1239 2026-05-26] Collect the filenames we're about to wipe BEFORE
  // deleting so we can NULL the matching messages.local_path rows. Otherwise
  // the bubbles keep a stale "file://…" path that no longer exists and render
  // "Mídia removida do cache" with no way to re-download until a relaunch.
  const wipedNames = [];
  for (const dir of [getCacheDir(), getSavedDir()]) {
    if (!dir) continue;
    try {
      const info = await fs.getInfoAsync(dir);
      if (info.exists) {
        const names = await fs.readDirectoryAsync(dir);
        for (const n of names) if (typeof n === 'string') wipedNames.push(n);
      }
    } catch {}
  }
  for (const dir of [getCacheDir(), getSavedDir()]) {
    if (!dir) continue;
    try { await fs.deleteAsync(dir, { idempotent: true }); } catch {}
  }
  // Also wipe the HLS offline dir (documentDirectory/video-offline/) — it is a
  // separate tree the LRU/clear paths never touched, so offline status/chat
  // videos used to survive a full "clear cache" and orphan gigabytes.
  try { require('./hlsOffline').clearAllHls?.(); } catch {}
  // Clear the gallery auto-save dedup set so a fresh re-download is allowed to
  // re-save media to the camera roll (the set otherwise pins keys forever).
  try {
    _hydrateAutoSavedKeys();
    _autoSavedKeys.clear();
    const mmkv = require('./mmkv');
    mmkv.setString?.(AUTO_SAVE_GALLERY_DONE_KEY, JSON.stringify([]));
  } catch {}
  // NULL local_path for every wiped file so bubbles fall back to re-download.
  if (wipedNames.length > 0) {
    try {
      const nativeDb = require('./db');
      if (typeof nativeDb.dbClearLocalPathByFilenames === 'function') {
        nativeDb.dbClearLocalPathByFilenames(wipedNames).catch(() => {});
      }
    } catch {}
  }
  // [2026-10-08 media-local-store] store permanente — SÓ da conta ativa.
  try {
    const st = _store();
    if (st) {
      const r = await st.clearAccount();
      if (r && r.relNames && r.relNames.length) {
        try { require('./db').dbClearLocalPathByFilenames?.(r.relNames)?.catch?.(() => {}); } catch {}
      }
    }
  } catch {}
  syncIndex.clear();
  // [2026-10-21 tg3] "limpo em X": a varredura automática não re-baixa o que existia.
  _markClearedNow();
  // [2026-10-21 tg3] caches de imagem/vídeo fora da nossa pasta: expo-image (disco +
  // memória), expo-video/ExpoShorts, cache nativo de mídia do chat (expo-chat-cache).
  await clearNativeImageCaches();
  // Re-semeia entradas de OUTRAS contas? Não: o syncIndex é só um atalho; o
  // store de cada conta re-semeia ao ser ativado (subscribe abaixo).
  _schedulePersistIndex();
}

// ── [2026-10-08 media-local-store] Limpar mídia de UMA conversa ────────────
// Apaga a pasta da conversa no store permanente (conta ativa) + arquivos
// legados (cache/saved) marcados como dessa conversa. Retorna bytes liberados.
export async function clearConversationLocalMedia(conversationId) {
  if (Platform.OS === 'web' || conversationId == null) return 0;
  const fs = getFS();
  if (!fs) return 0;
  let freed = 0;
  const relNames = [];
  try {
    const st = _store();
    if (st) {
      const r = await st.clearConversation(conversationId);
      freed += r.freedBytes || 0;
      for (const k of r.urlKeys || []) syncIndex.delete(k);
      _noteEvictedKeys(r.urlKeys || []); // [2026-10-21 tg3]
      relNames.push(...(r.relNames || []));
    }
  } catch {}
  try {
    _hydrateUrlConvOwner();
    const want = String(conversationId);
    for (const [k, c] of Array.from(_urlConvOwner.entries())) {
      if (String(c) !== want) continue;
      for (const d of [getCacheDir(), getSavedDir()]) {
        if (!d) continue;
        try {
          const st2 = await fs.getInfoAsync(d + k);
          if (st2.exists) { freed += st2.size || 0; await fs.deleteAsync(d + k, { idempotent: true }); relNames.push(k); _noteEvictedKeys([k]); }
        } catch {}
      }
      syncIndex.delete(k);
      _urlConvOwner.delete(k);
    }
    _scheduleUrlConvOwnerPersist();
  } catch {}
  if (relNames.length) {
    try { require('./db').dbClearLocalPathByFilenames?.(relNames)?.catch?.(() => {}); } catch {}
  }
  _schedulePersistIndex();
  return freed;
}

// Lista p/ Ajustes → Armazenamento: [{ conversationId, bytes, count }].
export function listLocalMediaByConversation() {
  if (Platform.OS === 'web') return [];
  try { return _store()?.listConversations() || []; } catch { return []; }
}

// Ao ativar/trocar de conta (ou o MMKV terminar de hidratar), semeia o
// syncIndex com o store DESSA conta. Entradas de outras contas ficam no
// syncIndex mas são ignoradas na leitura (isForeignPath).
try {
  if (Platform.OS !== 'web') {
    _store()?.subscribe?.(() => {
      try {
        const st = _store();
        let changed = false;
        for (const [k, p] of st.entriesForSyncIndex()) {
          if (syncIndex.get(k) !== p) { syncIndex.set(k, p); changed = true; }
        }
        if (changed) _schedulePersistIndex();
      } catch {}
    });
  }
} catch {}

// ── Keep-Always set (per-conversation favorites) ─────────────────────────
// Conversations flagged "Manter sempre" never have their media evicted by
// the LRU sweep. Persisted in MMKV under KEEP_ALWAYS_KEY as a string[] of
// conversation IDs. The evict path consults `_isUrlProtected` which walks
// the syncIndex tagging and skips any file whose owner conv is in the set.
const KEEP_ALWAYS_KEY = 'media_keep_always_convs_v1';
// [P0 DATA LOSS 2026-05-26] _urlConvOwner is the file→conversation tag the LRU
// sweep consults via _isFileProtected to skip Keep-Always media. It used to be
// an in-memory Map only — on a cold start it was EMPTY, so the very first
// evict sweep after reopening the app saw every Keep-Always file as orphan and
// could delete it. Now persisted to MMKV (capped) and hydrated at module load,
// mirroring _keepAlwaysConvs, so protection survives kill-and-reopen.
const URL_CONV_OWNER_KEY = 'media_url_conv_owner_v1';
const URL_CONV_OWNER_MAX = 5000; // cap MMKV blob; FIFO trim on persist
const _keepAlwaysConvs = new Set();
const _urlConvOwner = new Map(); // key → conversationId (best-effort tag)
let _keepAlwaysHydrated = false;
let _urlConvOwnerHydrated = false;
let _urlConvOwnerPersistTimer = null;

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

function _hydrateUrlConvOwner() {
  if (_urlConvOwnerHydrated) return;
  _urlConvOwnerHydrated = true;
  if (Platform.OS === 'web') return;
  try {
    const mmkv = require('./mmkv');
    const raw = mmkv.getString?.(URL_CONV_OWNER_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (k && v != null) _urlConvOwner.set(k, String(v));
      }
    }
  } catch {}
}
_hydrateUrlConvOwner();

function _scheduleUrlConvOwnerPersist() {
  if (Platform.OS === 'web') return;
  if (_urlConvOwnerPersistTimer) return;
  _urlConvOwnerPersistTimer = setTimeout(() => {
    _urlConvOwnerPersistTimer = null;
    try {
      const mmkv = require('./mmkv');
      const all = [..._urlConvOwner.entries()];
      const start = Math.max(0, all.length - URL_CONV_OWNER_MAX);
      const obj = {};
      for (let i = start; i < all.length; i++) {
        const [k, v] = all[i];
        obj[k] = v;
      }
      mmkv.setString?.(URL_CONV_OWNER_KEY, JSON.stringify(obj));
    } catch {}
  }, 3000);
}

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
  _hydrateUrlConvOwner();
  try {
    _urlConvOwner.set(urlToKey(url), String(conversationId));
    _scheduleUrlConvOwnerPersist();
  } catch {}
}

function _isFileProtected(filename) {
  _hydrateUrlConvOwner();
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
    // [2026-10-08 media-local-store] O arquivo do picker/compressor costuma
    // viver no cacheDirectory (purgável) → copia p/ o store permanente. Adiado
    // p/ o onCommitted (que sabe conversa+messageId) ganhar a corrida; se ele já
    // gravou, o adopt aqui é no-op (planPath reaproveita a entrada existente).
    if (typeof localUri === 'string' && localUri.startsWith('file://') && !(_store()?.isStorePath?.(localUri))) {
      setTimeout(() => { adoptLocalFileAsCache(remoteUrl, localUri, { own: true }).catch(() => {}); }, 4000);
    }
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
export async function requestRedownload(messageId, fileUrl = '', opts = {}) {
  const mid = Number(messageId) || 0;
  if (!mid) return { ok: false, error: 'invalid_message_id' };

  if (_inflightRedl.has(mid)) return _inflightRedl.get(mid);
  const _ids = { messageId: mid };
  if (opts && opts.conversationId != null) _ids.conversationId = opts.conversationId;

  const work = (async () => {
    // ── Step -1 [2026-10-08 media-local-store]: cópia LOCAL da mensagem no
    // store permanente (mesmo que a URL tenha mudado) — sem rede.
    if (Platform.OS !== 'web') {
      try {
        const lp = getLocalUriForMessage(mid);
        const fs = getFS();
        if (lp && fs) {
          const info = await fs.getInfoAsync(lp);
          if (info.exists && info.size > 0) {
            const payloadL = { ok: true, messageId: mid, url: lp, localUri: lp, kind: 'local', type: '', fileName: '', fileSize: info.size || 0, createdAt: null, originalUrl: fileUrl };
            _emitRedownload(payloadL);
            return payloadL;
          }
        }
      } catch {}
    }
    // ── Step 0: try the ORIGINAL file_url directly (WhatsApp-first) ────────
    // The overwhelmingly common reason a bubble shows "baixar de novo" is
    // that the LOCAL copy was evicted (iOS purged cacheDirectory, or our LRU
    // sweep ran) while the CDN object is still very much alive. In that case
    // we don't need the server round-trip at all — just re-fetch the same URL
    // and write it back into the PERMANENT dir. This is what makes the button
    // feel instant and is why "clico em baixar e não acontece nada" happened:
    // the old in-bubble handlers called bare cacheMedia (which silently no-ops
    // on the remote URL when it 404s) and never escalated; here we try the
    // cheap path first, then fall through to the server for a fresh URL.
    if (Platform.OS !== 'web' && fileUrl) {
      try {
        // Resolve through getMediaUrl so the cache key matches the bubble's
        // (CDN host rewrite). force:true = explicit user intent, bypass gate.
        let absolute = fileUrl;
        try {
          const api0 = require('./api');
          if (api0?.getMediaUrl) absolute = api0.getMediaUrl(fileUrl);
        } catch {}
        if (!/^https?:/i.test(absolute) && !absolute.startsWith('file://')) {
          absolute = absolute.startsWith('/') ? `https://chatyy.com.br${absolute}` : absolute;
        }
        if (/^https?:/i.test(absolute)) {
          const local = await cacheMedia(absolute, { force: true, ..._ids });
          if (typeof local === 'string' && local.startsWith('file://')) {
            // Got it straight from the origin — bind the original URL too so
            // every bubble in the thread resolves to the same local file.
            try { if (absolute !== fileUrl) bindLocalUriToRemoteUrl(local, fileUrl); } catch {}
            const payload0 = {
              ok: true,
              messageId: mid,
              url: absolute,
              localUri: local,
              kind: 'origin',
              type: '',
              fileName: '',
              fileSize: 0,
              createdAt: null,
              originalUrl: fileUrl,
            };
            _emitRedownload(payload0);
            return payload0;
          }
        }
      } catch {}
    }

    // ── Step 1: ask the server for a fresh URL (R2 CDN > origin > presigned)
    let resp;
    try {
      const api = require('./api');
      resp = await api.chatRedownloadMedia(mid);
    } catch (e) {
      return { ok: false, error: 'network', messageId: mid };
    }
    if (!resp || !resp.success) {
      // Pass through the server-side reason so UI can show "deleted" vs
      // "unavailable" copy. NOTE: apiCall() returns only the JSON body
      // ({success,data,message}) and STRIPS the HTTP status, so resp.status
      // is undefined here. We can't read 410 off the code — rely on the
      // server's `message` text ("message deleted") to detect the hard-delete
      // case. Everything else is a transient/unavailable error the UI should
      // let the user retry.
      const msg = resp?.message || resp?.error || 'unknown';
      return {
        ok: false,
        error: msg,
        status: 0,
        messageId: mid,
        deleted: /deleted|apagad/i.test(String(msg)),
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
        localUri = await cacheMedia(freshUrl, { force: true, ..._ids });
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
