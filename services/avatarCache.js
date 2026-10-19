// avatarCache.js — disk persistence for OTHER users' avatars.
//
// Why this exists (separate from mediaCache):
//   `expo-image` cachePolicy: 'memory-disk' uses NSURLCache / OkHttp's HTTP
//   cache, which lives in cacheDirectory — iOS can evict it at any time and
//   some Android OEMs nuke it on low-mem. Once evicted, opening a contact's
//   profile while offline shows only the initials bubble even though the
//   avatar URL is sitting in SQLite (conversations.avatar_url + contacts.
//   avatar_url). WhatsApp/Telegram solve this by writing avatars into the
//   sandbox's documentDirectory, where the OS can't reclaim the bytes.
//
// Why NOT piggyback on mediaCache:
//   1. mediaCache's LRU sweep tags entries by `conversationId`; avatars
//      don't belong to a conversation (one avatar serves N conversations).
//      Mixing them would force evictIfNeeded() to special-case avatar
//      entries or risk evicting a popular avatar that 50 chat rows reference.
//   2. mediaCache uses a content-bucket policy (photos/audio/videos/docs)
//      with cellular gates. Avatars are tiny (~5-30KB) and need to land
//      regardless of bucket pref — they're chrome, not content.
//   3. Separate dirs mean a "Clear chat media" UI button in storage settings
//      can wipe one without affecting the other.
//
// Shape:
//   - On-disk: documentDirectory/avatar-saved/<urlKey>.jpg
//   - In-memory index: urlKey → absolute file:// path (MMKV-persisted)
//   - 150MB cap, 1000 entry cap (whichever hits first triggers LRU sweep).
//   - Concurrency: shared 3-slot semaphore (matches mediaCache parity).
//
// Web: no-op. Browsers' built-in HTTP cache (Cache-Control headers from
// the backend) already covers avatars, and there's no `documentDirectory`
// equivalent in `expo-file-system` web. Every export returns the input URL.

import { Platform } from 'react-native';

const AVATAR_DIR = 'avatar-saved';
const MAX_AVATAR_BYTES = 150 * 1024 * 1024; // 150MB cap [2026-10-19 info-cache]
const MAX_AVATAR_ENTRIES = 1000;            // hard entry-count cap
const INDEX_MMKV_KEY = 'avatar_sync_index_v1';

let FileSystem = null;
function getFS() {
  if (Platform.OS === 'web') return null;
  if (!FileSystem) {
    try { FileSystem = require('expo-file-system/legacy'); } catch { try { FileSystem = require('expo-file-system'); } catch { return null; } }
  }
  return FileSystem;
}

function getAvatarDir() {
  const fs = getFS();
  if (!fs) return null;
  return fs.documentDirectory + AVATAR_DIR + '/';
}

// ── URL → safe filename ───────────────────────────────────────────────
//
// Avatar URLs almost always carry a cache-buster (?v=<ts>&d=YYYYMMDD)
// that rotates daily. We INCLUDE the `v=` param in the hash so a new
// upload (bumped version) gets its own filename — old version stays on
// disk until LRU evicts it, but the freshly-bumped URL writes to a new
// path. The `d=YYYYMMDD` daily bust is stripped before hashing, otherwise
// every midnight would invalidate every avatar.
function urlToKey(url) {
  const s = String(url);
  // Keep `v=` (real version), drop `d=` (daily bust).
  // Strip the daily bust param wherever it sits in the query string.
  const cleaned = s
    .replace(/([?&])d=\d{8}(?=&|$)/, '$1')
    .replace(/[?&]$/, '')
    .replace(/&&+/g, '&')
    .replace(/\?&/, '?');
  let hash = 0;
  for (let i = 0; i < cleaned.length; i++) {
    hash = ((hash << 5) - hash) + cleaned.charCodeAt(i);
    hash |= 0;
  }
  // Avatars are PNG or JPG from the backend — extension is informational
  // (expo-image sniffs the bytes), but a stable `.jpg` keeps the file tree
  // grep-friendly.
  return Math.abs(hash).toString(36) + '.jpg';
}

// ── Sync in-memory index ──────────────────────────────────────────────
//
// urlKey → absolute file:// path. Populated from MMKV at module load,
// scanned against disk on first access via `_ensureIndex()`. Components
// consult this BEFORE rendering so the file:// URI is available on the
// very first commit (no flicker).

const syncIndex = new Map();
let _indexHydrated = false;
let _persistTimer = null;

function _loadIndex() {
  if (Platform.OS === 'web') return;
  try {
    const mmkv = require('./mmkv');
    const raw = mmkv.getString?.(INDEX_MMKV_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === 'string') syncIndex.set(k, v);
      }
    }
  } catch {}
}

function _schedulePersist() {
  if (Platform.OS === 'web') return;
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
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

// Lazy hydrate — first call rebuilds the in-memory map from MMKV. Cheap;
// no disk I/O. The disk scan in `_scanDir()` runs on first cache hit.
function _ensureIndex() {
  if (_indexHydrated) return;
  _indexHydrated = true;
  _loadIndex();
}

// One-shot disk reconciliation. iOS sometimes changes the sandbox UUID
// after an app update — paths stored in MMKV become stale absolute paths
// that point at the OLD sandbox. We refresh against the live dir on first
// access so stale entries get rewritten with current paths (same pattern
// mediaCache uses in waitForSyncIndexReady).
let _scanPromise = null;
function _scanDir() {
  if (Platform.OS === 'web') return Promise.resolve();
  if (_scanPromise) return _scanPromise;
  _scanPromise = (async () => {
    const fs = getFS();
    if (!fs) return;
    const dir = getAvatarDir();
    try {
      const info = await fs.getInfoAsync(dir);
      if (!info.exists) {
        // Nothing on disk → drop any stale MMKV entries.
        if (syncIndex.size > 0) {
          syncIndex.clear();
          _schedulePersist();
        }
        return;
      }
      const entries = await fs.readDirectoryAsync(dir);
      const live = new Set(entries);
      let changed = false;
      // Re-key against the current dir absolute path.
      for (const name of entries) {
        const path = dir + name;
        if (syncIndex.get(name) !== path) {
          syncIndex.set(name, path);
          changed = true;
        }
      }
      // Scrub: drop any index entry whose file no longer exists.
      for (const k of [...syncIndex.keys()]) {
        if (!live.has(k)) { syncIndex.delete(k); changed = true; }
      }
      if (changed) _schedulePersist();
    } catch {}
  })();
  return _scanPromise;
}

// ── Concurrency throttle (3-slot semaphore) ───────────────────────────
//
// Bulk prefetch for a 100-row chat list would otherwise enqueue 100
// downloads at once and saturate the radio. 3 is mediaCache's value too
// — keeps headroom for foreground requests (avatar of the row the user
// just tapped, chat send, etc).

const _MAX_CONCURRENT = 3;
let _activeDownloads = 0;
const _waitQueue = [];
// Abort flag — flipped true by `clearAvatarCache()` so any in-flight
// download bails before writing to a dir that's about to be wiped, and
// any queued download that hadn't started yet short-circuits to the
// remote URL instead of materializing a file inside the deleted dir.
let _aborted = false;

// [2026-10-19 info-cache] Prefetch em 2º plano (lista/boot) usa no máximo 2 das
// 3 vagas e entra no fim da fila → a foto da linha/conversa que a pessoa acabou
// de abrir (1º plano) nunca espera atrás de 100 prefetches.
const _MAX_BG = 2;
let _activeBg = 0;
const _bgQueue = [];

function _acquireSlot(bg) {
  if (bg) {
    if (_activeDownloads < _MAX_CONCURRENT && _activeBg < _MAX_BG && _waitQueue.length === 0) {
      _activeDownloads++; _activeBg++;
      return Promise.resolve();
    }
    return new Promise(resolve => _bgQueue.push(resolve));
  }
  if (_activeDownloads < _MAX_CONCURRENT) {
    _activeDownloads++;
    return Promise.resolve();
  }
  return new Promise(resolve => _waitQueue.push(resolve));
}

function _releaseSlot(bg) {
  if (bg) { _activeBg--; if (_activeBg < 0) _activeBg = 0; }
  const next = _waitQueue.shift();
  if (next) {
    try { next(); } catch { _activeDownloads--; }
    return;
  }
  if (_bgQueue.length && _activeBg < _MAX_BG) {
    const nb = _bgQueue.shift();
    _activeBg++;
    try { nb(); } catch { _activeDownloads--; _activeBg--; }
    return;
  }
  _activeDownloads--;
  if (_activeDownloads < 0) _activeDownloads = 0;
}

// ── In-flight dedup ───────────────────────────────────────────────────
//
// Same URL requested twice before the first download completes → share
// the Promise. Without this, two simultaneous cacheAvatar() calls race
// on the same destination path and one fails with EEXIST.

const _inflight = new Map(); // urlKey → Promise<localPath | url>

// ── Última foto boa por PESSOA (chave estável = e-mail) ───────────────
//
// [2026-10-19 tabbar-offline] A URL muda com o `v=` (e o store de versões pode
// ainda não ter hidratado no boot) → o índice por URL erra e, offline, a foto
// da aba "Você" caía nas iniciais/ícone. Aqui fica e-mail → NOME do arquivo do
// último download bom (só o nome: o caminho absoluto muda de UUID no iOS a cada
// build instalado — remontado com o documentDirectory atual na leitura).
const LAST_GOOD_MMKV_KEY = 'avatar_last_good_v1'; // legado (só e-mail) — migrado p/ v2
// [2026-10-19 info-cache] v2: chave `<quem vê>|<e-mail>` → [arquivos], mais novo
// primeiro (até 4). Por CONTA que vê: a foto "só meus contatos" que a conta A vê
// nunca aparece como "última boa" para a conta B no mesmo aparelho; e a lista de
// arquivos deixa a privacidade (foto oculta / bloqueio) apagar TODAS as cópias.
const LAST_GOOD_V2_KEY = 'avatar_last_good_v2';
const MAX_LAST_GOOD = 600;
const MAX_FILES_PER_PERSON = 4;
const _lastGood = new Map(); // `${viewer}|${email}` → string[] (nomes em avatar-saved/)
let _lastGoodLoaded = false;
let _lastGoodTimer = null;
let _legacyLastGood = null; // objeto v1 esperando o e-mail de quem vê p/ migrar

function _mmkvMod() { try { return require('./mmkv'); } catch { return null; } }

function _ensureLastGood() {
  if (_lastGoodLoaded || Platform.OS === 'web') return;
  _lastGoodLoaded = true;
  const mm = _mmkvMod();
  try {
    const raw = mm?.getString?.(LAST_GOOD_V2_KEY);
    const obj = raw ? JSON.parse(raw) : null;
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        const arr = Array.isArray(v) ? v.filter(x => typeof x === 'string' && x) : (typeof v === 'string' && v ? [v] : []);
        if (arr.length && k.indexOf('|') >= 0) _lastGood.set(k, arr.slice(0, MAX_FILES_PER_PERSON));
      }
    }
  } catch {}
  try {
    const raw1 = mm?.getString?.(LAST_GOOD_MMKV_KEY);
    const o1 = raw1 ? JSON.parse(raw1) : null;
    if (o1 && typeof o1 === 'object' && Object.keys(o1).length) _legacyLastGood = o1;
  } catch {}
}

/** E-mail (minúsculo) da conta que VÊ — mesmo valor do `viewer=` das URLs. */
function _viewerTag() {
  try {
    const api = require('./api');
    const v = (typeof api.getAvatarViewerEmail === 'function' && api.getAvatarViewerEmail())
      || (typeof api.getActiveAccountEmail === 'function' && api.getActiveAccountEmail()) || '';
    return String(v || '').trim().toLowerCase();
  } catch { return ''; }
}
function _viewerFromUrl(url) {
  const m = String(url || '').match(/[?&]viewer=([^&#]*)/);
  if (!m) return '';
  try { return decodeURIComponent(m[1]).trim().toLowerCase(); } catch { return ''; }
}
function _lgKey(viewer, email) { return `${viewer || ''}|${String(email || '').trim().toLowerCase()}`; }

function _migrateLegacy(viewer) {
  if (!_legacyLastGood || !viewer) return;
  const o1 = _legacyLastGood;
  _legacyLastGood = null;
  for (const [em, name] of Object.entries(o1)) {
    if (typeof name !== 'string' || !name || !em) continue;
    const k = _lgKey(viewer, em);
    if (!_lastGood.has(k)) _lastGood.set(k, [name]);
  }
  _persistLastGood();
  try { _mmkvMod()?.remove?.(LAST_GOOD_MMKV_KEY); } catch {}
}

function _persistLastGood(now) {
  if (Platform.OS === 'web') return;
  const write = () => {
    try {
      const obj = {};
      for (const [k, v] of _lastGood.entries()) obj[k] = v;
      _mmkvMod()?.setString?.(LAST_GOOD_V2_KEY, JSON.stringify(obj));
    } catch {}
  };
  if (now) { if (_lastGoodTimer) { clearTimeout(_lastGoodTimer); _lastGoodTimer = null; } write(); return; }
  if (_lastGoodTimer) return;
  _lastGoodTimer = setTimeout(() => { _lastGoodTimer = null; write(); }, 1500);
}

function _emailFromUrl(url) {
  try {
    const e = require('./avatarVersions').emailFromAvatarUrl(url);
    return typeof e === 'string' && e.indexOf('@') > 0 ? e.trim().toLowerCase() : '';
  } catch { return ''; }
}

function _noteLastGood(url, localPath) {
  if (Platform.OS === 'web' || !url || !localPath) return;
  // Só a foto de perfil "normal" (a 1024 do visualizador é outro arquivo, mesma pessoa — tanto faz,
  // mas a pequena é a que a aba/AvatarCircle mostram).
  if (/[?&]size=/.test(String(url))) return;
  // [2026-10-19 info-cache] Iniciais geradas (sem `v=`) não são "foto boa".
  if (!/[?&]v=/.test(String(url))) return;
  const email = _emailFromUrl(url);
  if (!email) return;
  const name = String(localPath).split('/').pop();
  if (!name) return;
  _ensureLastGood();
  const viewer = _viewerFromUrl(url) || _viewerTag();
  _migrateLegacy(viewer);
  const k = _lgKey(viewer, email);
  const prev = _lastGood.get(k) || [];
  if (prev[0] === name) return;
  const next = [name, ...prev.filter(n => n !== name)].slice(0, MAX_FILES_PER_PERSON);
  _lastGood.delete(k); // reinsere no fim (mais novo)
  _lastGood.set(k, next);
  while (_lastGood.size > MAX_LAST_GOOD) _lastGood.delete(_lastGood.keys().next().value);
  _persistLastGood();
}

/**
 * [2026-10-19 tabbar-offline] SÍNCRONO, zero I/O: file:// do último download bom
 * da foto desta pessoa (qualquer versão), no container ATUAL; null se nunca baixou
 * ou o arquivo saiu do índice (LRU). Quem usa: aba "Você" (nativa api 6 e barra
 * JS) — mostra a foto offline/conectando e revalida pela rede depois.
 * [2026-10-19 info-cache] Escopo = conta que vê (`viewer`, padrão: a ativa).
 */
export function getLastGoodAvatarUri(email, viewer) {
  if (!email || Platform.OS === 'web') return null;
  _ensureIndex();
  _ensureLastGood();
  const vw = (viewer && String(viewer).trim().toLowerCase()) || _viewerTag();
  _migrateLegacy(vw);
  const names = _lastGood.get(_lgKey(vw, email));
  if (!names || !names.length) return null;
  const dir = getAvatarDir();
  if (!dir) return null;
  for (const name of names) if (syncIndex.has(name)) return dir + name;
  return null;
}

// ── Kill switch + SWR por PESSOA ──────────────────────────────────────
// [2026-10-19 info-cache] globalThis.__chatyy_info_cache === false → volta ao
// comportamento antigo (só o arquivo da URL exata; sem prefetch de boot/
// revalidação).
export function infoCacheEnabled() {
  try { if (globalThis.__chatyy_info_cache === false) return false; } catch {}
  return true;
}

function _cacheReadyNow() {
  try { const mm = _mmkvMod(); return mm && typeof mm.isCacheReady === 'function' ? !!mm.isCacheReady() : true; } catch { return true; }
}

// Assinantes "chegou foto nova no disco / cópia apagada" (lista nativa refaz as linhas).
const _cachedSubs = new Set();
let _cachedEmitTimer = null;
function _emitCached() {
  if (!_cachedSubs.size || _cachedEmitTimer) return;
  _cachedEmitTimer = setTimeout(() => {
    _cachedEmitTimer = null;
    for (const fn of Array.from(_cachedSubs)) { try { fn(); } catch {} }
  }, 450);
}
/** Avisa (com debounce) quando um avatar novo foi gravado ou apagado. Retorna unsubscribe. */
export function subscribeAvatarCached(fn) {
  if (typeof fn !== 'function') return () => {};
  _cachedSubs.add(fn);
  return () => { _cachedSubs.delete(fn); };
}

// URL já pedida nesta sessão (evita getInfoAsync a cada rebuild da lista).
const _kicked = new Set();
function _kickOnce(url, bg) {
  if (_aborted || !url) return;
  const key = urlToKey(url);
  if (_kicked.has(key)) return;
  _kicked.add(key);
  if (_kicked.size > 3000) _kicked.delete(_kicked.values().next().value);
  try { cacheAvatar(url, { bg: !!bg }).catch(() => {}); } catch {}
}

/**
 * [2026-10-19 info-cache] Stale-while-revalidate SÍNCRONO p/ listas nativas e
 * qualquer tela: file:// da URL exata se já está no disco; senão a ÚLTIMA foto
 * boa da mesma pessoa (versão anterior) — e o download da versão nova sai em
 * 2º plano (subscribeAvatarCached avisa quando gravar). null = não há cópia.
 *   - só para URL COM `v=` (foto real): sem versão = iniciais/sem foto → nunca
 *     mostra foto velha (exceto no boot, antes do store de versões hidratar);
 *   - nunca para a versão grande (size=1024: o visualizador tem fluxo próprio).
 * opts.kick=false → não dispara download; opts.bg=false → download em 1º plano.
 */
export function getAvatarUriSWR(url, opts) {
  if (!url || Platform.OS === 'web' || !/^https?:/i.test(String(url))) return null;
  const exact = getCachedAvatarUriOrNull(url);
  if (exact) return exact;
  const on = infoCacheEnabled();
  if (on && !(opts && opts.kick === false)) _kickOnce(url, !(opts && opts.bg === false));
  if (!on) return null;
  const s = String(url);
  if (/[?&]size=/.test(s)) return null;
  if (!/[?&]v=/.test(s) && _cacheReadyNow()) return null;
  const email = _emailFromUrl(s);
  if (!email) return null;
  return getLastGoodAvatarUri(email, _viewerFromUrl(s));
}

/**
 * [2026-10-19 info-cache] Privacidade: a pessoa ocultou a foto p/ quem vê, bloqueou
 * ou foi bloqueada → apaga TODAS as cópias conhecidas dela (arquivos + "última
 * boa") desta conta (ou de todas as contas com allViewers).
 */
export function purgeAvatarForEmail(email, opts) {
  if (!email || Platform.OS === 'web') return;
  const em = String(email).trim().toLowerCase();
  _ensureIndex();
  _ensureLastGood();
  const viewer = (opts && opts.viewer) ? String(opts.viewer).trim().toLowerCase() : _viewerTag();
  const allViewers = !!(opts && opts.allViewers);
  const names = new Set();
  for (const [k, arr] of Array.from(_lastGood.entries())) {
    const bar = k.indexOf('|');
    if (k.slice(bar + 1) !== em) continue;
    if (!allViewers && k.slice(0, bar) !== viewer) continue;
    for (const n of arr) names.add(n);
    _lastGood.delete(k);
  }
  if (!names.size) return;
  const fs = getFS();
  const dir = getAvatarDir();
  for (const n of names) {
    syncIndex.delete(n);
    if (fs && dir) { try { fs.deleteAsync(dir + n, { idempotent: true }).catch(() => {}); } catch {} }
  }
  _schedulePersist();
  _persistLastGood(true);
  try {
    const EI = require('expo-image').Image;
    if (EI && typeof EI.clearMemoryCache === 'function') EI.clearMemoryCache();
  } catch {}
  _emitCached();
}

// ── Revalidação (privacidade mudou sem mudar a versão) ────────────────
// A URL não muda quando a pessoa passa a foto para "ninguém" → o arquivo no disco
// seria servido p/ sempre. Ao abrir conversa/dados/perfil revalida em 2º plano
// (no máx. 1×/6 h por URL): resposta restrita → apaga as cópias; 200 → regrava.
const REVALIDATE_MS = 6 * 3600 * 1000;
const _revalAt = new Map();
export async function revalidateAvatar(url) {
  if (!url || Platform.OS === 'web' || _aborted || !infoCacheEnabled()) return;
  const s = String(url);
  if (!/^https?:/i.test(s) || /[?&]size=/.test(s)) return;
  const fs = getFS();
  if (!fs) return;
  _ensureIndex();
  const key = urlToKey(s);
  const now = Date.now();
  if ((_revalAt.get(key) || 0) > now - REVALIDATE_MS) return;
  _revalAt.set(key, now);
  if (_revalAt.size > 1000) _revalAt.delete(_revalAt.keys().next().value);
  const indexed = syncIndex.get(key);
  if (!indexed) { _kickOnce(s, false); return; }
  try {
    const st = await fs.getInfoAsync(indexed);
    if (!st.exists) { syncIndex.delete(key); _kicked.delete(key); _kickOnce(s, false); return; }
    const mt = Number(st.modificationTime || 0) * 1000;
    if (mt && now - mt < REVALIDATE_MS) return;
  } catch { return; }
  const tmp = indexed + '.rv';
  await _acquireSlot(true);
  try {
    if (_aborted) return;
    let hdrs = null;
    try { hdrs = require('./avatar').avatarAuthHeaders(s); } catch { hdrs = null; }
    const dl = await Promise.race([
      hdrs ? fs.downloadAsync(s, tmp, { headers: hdrs }) : fs.downloadAsync(s, tmp),
      new Promise((_, rej) => setTimeout(() => rej(new Error('avatar_rv_timeout')), 15000)),
    ]);
    if (dl?.status === 200 && _isRestrictedAvatarResp(dl.headers)) {
      try { await fs.deleteAsync(tmp, { idempotent: true }); } catch {}
      purgeAvatarForEmail(_emailFromUrl(s), { viewer: _viewerFromUrl(s) || undefined });
      try { await fs.deleteAsync(indexed, { idempotent: true }); } catch {}
      syncIndex.delete(key);
      _schedulePersist();
      _emitCached();
      return;
    }
    if (dl?.status === 200 && !_aborted) {
      try { await fs.deleteAsync(indexed, { idempotent: true }); } catch {}
      try { await fs.moveAsync({ from: tmp, to: indexed }); } catch { syncIndex.delete(key); _schedulePersist(); }
      return;
    }
    try { await fs.deleteAsync(tmp, { idempotent: true }); } catch {}
  } catch {
    try { await fs.deleteAsync(tmp, { idempotent: true }); } catch {}
  } finally {
    _releaseSlot(true);
  }
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Synchronous lookup. Returns a file:// path if the URL is already on
 * disk per the in-memory index, otherwise returns the input URL. Safe
 * to call in render closures — zero I/O.
 *
 * This is what AvatarCircle consults BEFORE rendering. On the second
 * launch (after `cacheAvatar` has stored the bytes once), the file://
 * lookup hits the cache instantly and the avatar paints on first commit
 * — no flicker, no network wait, works offline.
 */
export function getCachedAvatarUri(url) {
  if (!url || Platform.OS === 'web') return url;
  _ensureIndex();
  const key = urlToKey(url);
  const indexed = syncIndex.get(key);
  return indexed || url;
}

/**
 * Returns the file:// path if cached, otherwise `null`. Used when the
 * caller wants to know whether to render the initials fallback (cache
 * miss + offline) instead of triggering an image fetch that will
 * silently fail.
 */
export function getCachedAvatarUriOrNull(url) {
  if (!url || Platform.OS === 'web') return null;
  _ensureIndex();
  const key = urlToKey(url);
  return syncIndex.get(key) || null;
}

/**
 * Download an avatar URL into documentDirectory/avatar-saved. Idempotent
 * — if the file already exists (or another caller's download is in
 * flight), returns the cached path without re-downloading. Resolves to
 * the file:// path on success or the input URL on failure.
 *
 * Fire-and-forget contract: callers should NOT await this in render
 * paths. The component's syncIndex consult on the NEXT commit will pick
 * up the freshly-cached path automatically (via a setState the caller
 * triggers from the resolved promise).
 */
// [avatar-privacy-auth 2026-10-14] urlKey → epoch até quando NÃO baixar de novo
// (resposta de iniciais restritas). Só memória: some no próximo boot.
const _restrictedUntil = new Map();
function _isRestrictedAvatarResp(headers) {
  if (!headers || typeof headers !== 'object') return false;
  for (const k of Object.keys(headers)) {
    if (String(k).toLowerCase() === 'x-avatar-restricted') return String(headers[k]).trim() === '1';
  }
  return false;
}

export async function cacheAvatar(url, opts) {
  const _bg = !!(opts && opts.bg);
  if (!url || Platform.OS === 'web') return url;
  // Logout in progress — don't materialize new files into a dir that's
  // about to be deleted (would race fs.deleteAsync, and the file would
  // outlive the clear, leaking the prev user's contacts).
  if (_aborted) return url;
  const fs = getFS();
  if (!fs) return url;

  _ensureIndex();
  const key = urlToKey(url);

  // Fast path: index hit + file actually exists.
  const indexed = syncIndex.get(key);
  if (indexed) {
    try {
      const info = await fs.getInfoAsync(indexed);
      if (info.exists) { _noteLastGood(url, indexed); return indexed; }
    } catch {}
    // Stale entry — fall through to re-download.
    syncIndex.delete(key);
  }

  // Direct disk probe (covers entries the dir-scan would've found but
  // hasn't run yet on this cold start).
  const dir = getAvatarDir();
  const localPath = dir + key;
  try {
    const info = await fs.getInfoAsync(localPath);
    if (info.exists && info.size > 0) {
      syncIndex.set(key, localPath);
      _schedulePersist();
      _noteLastGood(url, localPath);
      return localPath;
    }
  } catch {}

  // Dedup in-flight.
  if (_inflight.has(key)) return _inflight.get(key);
  // [avatar-privacy-auth 2026-10-14] dono com foto restrita que respondeu iniciais
  // p/ este aparelho há pouco → não martela o servidor (remoto direto, 10 min).
  const _ru = _restrictedUntil.get(key);
  if (_ru && _ru > Date.now()) return url;

  const dlPromise = (async () => {
    if (_aborted) return url;
    try {
      const dirInfo = await fs.getInfoAsync(dir);
      if (!dirInfo.exists) {
        await fs.makeDirectoryAsync(dir, { intermediates: true });
      }
    } catch {}

    await _acquireSlot(_bg);
    // Re-check after waiting for a semaphore slot — a logout might have
    // landed while we were queued behind 3 other downloads.
    if (_aborted) {
      _releaseSlot(_bg);
      return url;
    }
    try {
      // 15s timeout — avatars are tiny so a stuck CDN means dead edge.
      // Cheaper to bail and let the next mount retry than hold the
      // semaphore slot blocking other prefetches.
      // [avatar-privacy-auth 2026-10-14] Bearer: a foto RESTRITA ("meus contatos"/
      // "ninguém") é decidida pela identidade autenticada (o `viewer=` da URL não vale mais).
      let _hdrs = null;
      try { _hdrs = require('./avatar').avatarAuthHeaders(url); } catch { _hdrs = null; }
      const download = await Promise.race([
        _hdrs ? fs.downloadAsync(url, localPath, { headers: _hdrs }) : fs.downloadAsync(url, localPath),
        new Promise((_, rej) => setTimeout(() => rej(new Error('avatar_dl_timeout')), 15000)),
      ]);
      if (download?.status === 200 && _isRestrictedAvatarResp(download.headers)) {
        // Iniciais de dono RESTRITO (X-Avatar-Restricted: 1): não vão pro disco — se
        // ficassem, a pessoa continuaria em iniciais mesmo depois de virar contato.
        try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
        _restrictedUntil.set(key, Date.now() + 10 * 60 * 1000);
        if (_restrictedUntil.size > 500) { const k0 = _restrictedUntil.keys().next().value; _restrictedUntil.delete(k0); }
        // [2026-10-19 info-cache] foto oculta p/ esta conta (privacidade/bloqueio) →
        // some também a "última boa" e as versões antigas (o SWR não pode mostrá-las).
        try { purgeAvatarForEmail(_emailFromUrl(url), { viewer: _viewerFromUrl(url) || undefined }); } catch {}
        return url;
      }
      if (download?.status === 200) {
        syncIndex.set(key, localPath);
        _schedulePersist();
        _noteLastGood(url, localPath);
        _emitCached(); // [2026-10-19 info-cache] listas nativas trocam p/ a versão nova
        // Fire LRU sweep — debounced inside.
        try { evictIfNeeded(); } catch {}
        return localPath;
      }
      // Non-200 (404 expired link, 403 token expired) — purge any
      // partial file so we don't serve a 0-byte image.
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    } catch {
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    } finally {
      _releaseSlot(_bg);
    }
    return url; // Fall back to remote URL on failure.
  })();
  _inflight.set(key, dlPromise);
  try {
    return await dlPromise;
  } finally {
    _inflight.delete(key);
  }
}

/**
 * Bulk prefetch — fire `cacheAvatar()` for an array of emails. Uses
 * `getAvatarUrlForEmail` to resolve each email to its current URL.
 *
 * Called by ChatListTab when conversations land so by the time the user
 * scrolls / taps into a profile, the bytes are on disk. The shared
 * 3-slot semaphore caps in-flight downloads so a 200-conv list doesn't
 * thunder the radio.
 *
 * Fire-and-forget. Returns a Promise so tests can await but production
 * callers ignore it.
 */
export function prefetchAvatarsForList(emails, opts) {
  if (Platform.OS === 'web') return Promise.resolve();
  if (!Array.isArray(emails) || emails.length === 0) return Promise.resolve();
  // [2026-10-19 info-cache] 2º plano (vagas de prefetch) e ciente da rede:
  // offline = nada; dados móveis = teto menor (as primeiras = mais recentes).
  const _limit = _prefetchBudget(opts && opts.limit);
  if (_limit <= 0) return Promise.resolve();

  let api = null;
  try { api = require('./api'); } catch { return Promise.resolve(); }
  if (!api || typeof api.getAvatarUrlForEmail !== 'function') return Promise.resolve();

  // Dedup emails (a 100-row list with the same peer 3× shouldn't fire
  // 3 downloads). Lowercase normalization matches AvatarCircle's lookup.
  const seen = new Set();
  const unique = [];
  for (const raw of emails) {
    if (typeof raw !== 'string') continue;
    const e = raw.trim().toLowerCase();
    if (!e || !e.includes('@') || seen.has(e)) continue;
    seen.add(e);
    unique.push(e);
  }
  if (unique.length === 0) return Promise.resolve();
  if (unique.length > _limit) unique.length = _limit;

  // Fire all — the semaphore inside `cacheAvatar` caps concurrency at
  // 3, so this loop is effectively a producer; the downloads themselves
  // serialize through the slots.
  return Promise.allSettled(unique.map(email => {
    let url = null;
    try { url = api.getAvatarUrlForEmail(email); } catch {}
    if (!url) return Promise.resolve();
    return cacheAvatar(url, { bg: true }).catch(() => {});
  }));
}

// Quantos avatares pré-baixar agora: Wi-Fi 200 · dados móveis 40 · offline 0.
function _prefetchBudget(limit) {
  let n = 200;
  try {
    const ni = require('./networkInfo');
    if (ni.isConnected && ni.isConnected() === false) return 0;
    const ty = ni.getNetworkType ? ni.getNetworkType() : 'unknown';
    if (ty === 'none') return 0;
    if (ty !== 'wifi') n = 40;
  } catch {}
  const l = Number(limit);
  return l > 0 ? Math.min(n, l) : n;
}

/**
 * [2026-10-19 info-cache] Boot: pré-baixa (baixa prioridade) as fotos das N
 * conversas do topo da lista salva — 1× por sessão, depois que o app assentou.
 * Wi-Fi 60 conversas, dados móveis 20, offline nada.
 */
let _bootPrefetchDone = false;
export function prefetchTopConversationAvatars(opts) {
  if (Platform.OS === 'web' || _bootPrefetchDone || !infoCacheEnabled()) return;
  _bootPrefetchDone = true;
  const delay = (opts && opts.delayMs) != null ? opts.delayMs : 4000;
  setTimeout(async () => {
    try {
      if (_aborted) return;
      let top = 60;
      try { const ty = require('./networkInfo').getNetworkType(); if (ty === 'none') { _bootPrefetchDone = false; return; } if (ty !== 'wifi') top = 20; } catch {}
      const list = await Promise.resolve(require('./chatCache').getCachedConversations?.());
      if (!Array.isArray(list) || !list.length) { _bootPrefetchDone = false; return; }
      const emails = [];
      for (const c of list.slice(0, top)) {
        if (!c) continue;
        for (const e of [c.other_email, c.peer, c.peer_email]) if (typeof e === 'string' && e.includes('@')) emails.push(e);
        if (c.type === 'group' && Array.isArray(c.members) && !c.avatar_url) {
          for (const m of c.members.slice(0, 4)) if (m && typeof m.email === 'string') emails.push(m.email);
        }
      }
      await prefetchAvatarsForList(emails, { limit: top * 2 });
    } catch {}
  }, delay);
}

// ── LRU eviction ──────────────────────────────────────────────────────
//
// Walks the avatar dir, sums total bytes + counts entries, and if either
// limit is breached deletes the oldest (by mtime) until both fit. Same
// debounce pattern as mediaCache (1 sweep / 10 min) — avatars rarely
// land hot enough to need a tighter cadence.

let _lastEvictAt = 0;
let _evictInflight = null;

export async function evictIfNeeded(opts) {
  if (Platform.OS === 'web') return;
  const force = !!(opts && opts.force);
  const now = Date.now();
  if (!force && now - _lastEvictAt < 10 * 60 * 1000) return;
  if (_evictInflight) return _evictInflight;
  const fs = getFS();
  if (!fs) return;
  _evictInflight = (async () => {
    try {
      const dir = getAvatarDir();
      const info = await fs.getInfoAsync(dir);
      if (!info.exists) return;
      const names = await fs.readDirectoryAsync(dir);
      const entries = [];
      let total = 0;
      for (const name of names) {
        const path = dir + name;
        try {
          const st = await fs.getInfoAsync(path);
          if (st.exists && !st.isDirectory) {
            entries.push({ path, name, size: st.size || 0, mtime: st.modificationTime || 0 });
            total += st.size || 0;
          }
        } catch {}
      }
      // Both caps — bytes AND entry count.
      const overBytes = total > MAX_AVATAR_BYTES;
      const overCount = entries.length > MAX_AVATAR_ENTRIES;
      if (!overBytes && !overCount) return;

      entries.sort((a, b) => a.mtime - b.mtime); // oldest first

      const targetBytes = MAX_AVATAR_BYTES * 0.9; // sweep to 90% so the
                                                  // next download doesn't
                                                  // immediately re-trigger.
      const targetCount = Math.floor(MAX_AVATAR_ENTRIES * 0.9);

      let liveBytes = total;
      let liveCount = entries.length;
      for (const e of entries) {
        if (liveBytes <= targetBytes && liveCount <= targetCount) break;
        try {
          await fs.deleteAsync(e.path, { idempotent: true });
          syncIndex.delete(e.name);
          liveBytes -= e.size;
          liveCount -= 1;
        } catch {}
      }
      _schedulePersist();
    } finally {
      _lastEvictAt = Date.now();
      _evictInflight = null;
    }
  })();
  return _evictInflight;
}

// ── Logout cleanup ────────────────────────────────────────────────────
//
// Avatars are user-visible identifiers — leaving them on disk after
// logout means a stranger picking up the device could see who the
// previous user was chatting with. Called from AuthContext.
// clearAllPerAccountCaches.

export async function clearAvatarCache() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  // Flip the abort flag so any in-flight cacheAvatar() bails before
  // writing into the dir we're about to delete. Then drain — wait for
  // already-started downloads to finish (or hit the 5s cap, after which
  // we proceed; deleteAsync is `idempotent` so a stragger writing
  // mid-delete just throws and gets garbage-collected on next launch).
  _aborted = true;
  const start = Date.now();
  while (_activeDownloads > 0 && Date.now() - start < 5000) {
    await new Promise(r => setTimeout(r, 50));
  }
  const dir = getAvatarDir();
  try {
    await fs.deleteAsync(dir, { idempotent: true });
  } catch {}
  syncIndex.clear();
  // Persist the empty index immediately (don't wait for the 2s debounce
  // — the user just logged out, the device might be killed in 100ms).
  try {
    const mmkv = require('./mmkv');
    mmkv.setString?.(INDEX_MMKV_KEY, '{}');
  } catch {}
  _lastEvictAt = 0;
  _scanPromise = null;
  _lastGood.clear();
  _lastGoodLoaded = true;
  _legacyLastGood = null;
  try { require('./mmkv').setString?.(LAST_GOOD_MMKV_KEY, '{}'); } catch {}
  try { require('./mmkv').setString?.(LAST_GOOD_V2_KEY, '{}'); } catch {}
  _kicked.clear();
  _revalAt.clear();
  _bootPrefetchDone = false;
  // Reset the abort gate so a subsequent login can resume caching.
  _aborted = false;
}

// Kick the dir scan after the splash so subsequent renders hit the
// reconciled index. Cheap (one readdir + N stat calls). Safe at module
// load — gated on Platform.OS internally.
if (Platform.OS !== 'web') {
  _ensureIndex();
  // Defer the disk scan a tick so module-load doesn't block JS startup.
  setTimeout(() => { _scanDir().catch(() => {}); }, 0);
}
