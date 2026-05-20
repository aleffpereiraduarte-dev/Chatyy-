/**
 * Audio Cache Service
 *
 * Caches audio messages locally so they load instantly after first play.
 * - Native: uses expo-file-system to download and store in cacheDirectory
 * - Web: uses Cache API (or falls back to browser default caching)
 *
 * Cache limits: max 200 files or ~100MB, evicts oldest first.
 *
 * Voice-message specific extensions live below — `audio-saved/` is a
 * PERMANENT mirror (no auto-eviction) for received voice notes so a chat
 * stays playable even after weeks offline. Waveform peaks travel alongside
 * (small JSON sidecar) so the bubble renders the real envelope immediately
 * without refetching the audio.
 */

import { Platform } from 'react-native';
import { getJSON, setJSON, getString, setString, remove as mmkvRemove } from './mmkv';

const CACHE_DIR_NAME = 'audio-cache/';
const SAVED_DIR_NAME = 'audio-saved/';
const OUTBOX_DIR_NAME = 'outbox/voice/';
const MAX_FILES = 200;
const MAX_BYTES = 100 * 1024 * 1024; // 100MB

// In-memory waveform cache backed by MMKV. Keyed by remote URL (or
// messageId when available) — values are small int8 arrays of normalized
// peaks (0-1 multiplied by 100). Persisted lazily so a cold app start
// can paint the bars before the audio file even resolves.
const WAVE_KEY_PREFIX = 'voicewave_';
const WAVE_INDEX_KEY = 'voicewave_index';
const MAX_WAVEFORM_ENTRIES = 1000;
const _waveCache = new Map(); // urlKey -> number[]

let FileSystem = null;

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
  // documentDirectory (persistent) instead of cacheDirectory — iOS may clear
  // NSCachesDirectory at any time, which caused audio messages to redownload
  // on every app launch. documentDirectory survives until uninstall.
  return fs.documentDirectory + CACHE_DIR_NAME;
}

// Simple hash of a string to create a safe filename
function hashKey(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36);
}

// Extract audio extension from URL
function audioExt(url) {
  const m = url.match(/\.(m4a|mp3|ogg|webm|wav|aac|opus|mp4)(\?|#|$)/i);
  return m ? m[1].toLowerCase() : 'bin';
}

// Build cache filename from url + messageId
function cacheFileName(url, messageId) {
  const key = messageId ? String(messageId) : hashKey(url);
  const ext = audioExt(url);
  return key + '_' + hashKey(url) + '.' + ext;
}

// ============================================================
// WEB: Cache API helpers
// ============================================================

const WEB_CACHE_NAME = 'chatyy-audio-v1';

// Track blob URLs per remote URL so we can revoke old ones and reuse existing ones
const _blobUrlMap = new Map(); // remoteUrl -> blobUrl

function _createTrackedBlobUrl(remoteUrl, blob) {
  // Revoke previous blob URL for this remote URL if it exists
  const prev = _blobUrlMap.get(remoteUrl);
  if (prev) {
    try { URL.revokeObjectURL(prev); } catch {}
  }
  const blobUrl = URL.createObjectURL(blob);
  _blobUrlMap.set(remoteUrl, blobUrl);
  return blobUrl;
}

async function webGetCachedUri(url) {
  if (typeof caches === 'undefined') return url;
  // Return existing blob URL if we already have one
  const existing = _blobUrlMap.get(url);
  if (existing) return existing;
  try {
    const cache = await caches.open(WEB_CACHE_NAME);
    const resp = await cache.match(url);
    if (resp) {
      const blob = await resp.blob();
      return _createTrackedBlobUrl(url, blob);
    }
  } catch {}
  return null;
}

async function webCacheAudio(url) {
  if (typeof caches === 'undefined') return url;
  // Return existing blob URL if we already have one
  const existing = _blobUrlMap.get(url);
  if (existing) return existing;
  try {
    const cache = await caches.open(WEB_CACHE_NAME);
    // Check if already cached
    const cachedResp = await cache.match(url);
    if (cachedResp) {
      const blob = await cachedResp.blob();
      return _createTrackedBlobUrl(url, blob);
    }
    // Fetch and store
    const resp = await fetch(url);
    if (resp.ok) {
      await cache.put(url, resp.clone());
      const blob = await resp.blob();
      return _createTrackedBlobUrl(url, blob);
    }
  } catch {}
  return url;
}

async function webClearCache() {
  // Revoke all tracked blob URLs to free memory
  for (const blobUrl of _blobUrlMap.values()) {
    try { URL.revokeObjectURL(blobUrl); } catch {}
  }
  _blobUrlMap.clear();
  if (typeof caches === 'undefined') return;
  try { await caches.delete(WEB_CACHE_NAME); } catch {}
}

async function webGetCacheSize() {
  // Cache API doesn't expose size easily; return 0
  return 0;
}

// ============================================================
// NATIVE: expo-file-system helpers
// ============================================================

// In-memory index of cached files (rebuilt on first access)
let _index = null; // { files: [{ name, size, atime }], totalSize }

async function ensureDir() {
  const fs = getFS();
  if (!fs) return false;
  const dir = getCacheDir();
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) {
      await fs.makeDirectoryAsync(dir, { intermediates: true });
    }
    return true;
  } catch { return false; }
}

async function buildIndex() {
  const fs = getFS();
  if (!fs) { _index = { files: [], totalSize: 0 }; return; }
  const dir = getCacheDir();
  try {
    const dirInfo = await fs.getInfoAsync(dir);
    if (!dirInfo.exists) { _index = { files: [], totalSize: 0 }; return; }
    const entries = await fs.readDirectoryAsync(dir);
    const files = [];
    let totalSize = 0;
    // Get info for each file (batch of 20 at a time to avoid overwhelming)
    for (let i = 0; i < entries.length; i += 20) {
      const batch = entries.slice(i, i + 20);
      const infos = await Promise.allSettled(
        batch.map(name => fs.getInfoAsync(dir + name))
      );
      infos.forEach((r, idx) => {
        if (r.status === 'fulfilled' && r.value.exists) {
          const size = r.value.size || 0;
          files.push({
            name: batch[idx],
            size,
            // modificationTime as proxy for access time
            atime: r.value.modificationTime || 0,
          });
          totalSize += size;
        }
      });
    }
    // Sort by access time ascending (oldest first) for eviction
    files.sort((a, b) => a.atime - b.atime);
    _index = { files, totalSize };
  } catch {
    _index = { files: [], totalSize: 0 };
  }
}

async function evictIfNeeded() {
  const fs = getFS();
  if (!fs || !_index) return;
  const dir = getCacheDir();

  while (_index.files.length > MAX_FILES || _index.totalSize > MAX_BYTES) {
    const oldest = _index.files.shift();
    if (!oldest) break;
    try {
      await fs.deleteAsync(dir + oldest.name, { idempotent: true });
      _index.totalSize -= oldest.size;
    } catch {}
  }
}

// ============================================================
// PUBLIC API
// ============================================================

/**
 * Get a cached audio URI. If the file is cached locally, returns the local path.
 * If not cached, downloads it first (on native), or caches via Cache API (on web).
 *
 * @param {string} remoteUrl - The remote audio URL
 * @param {string|number} messageId - Message ID (used as part of cache key)
 * @param {function} onProgress - Optional callback: (progress: 0-1) => void
 * @returns {Promise<string>} Local or blob URI for playback
 */
export async function getCachedAudioUri(remoteUrl, messageId, onProgress) {
  if (!remoteUrl) return remoteUrl;

  // Se já é um path local (file:// ou content:// no Android), retorna direto
  // — antes content:// era tratado como remoto e o downloadAsync falhava.
  if (typeof remoteUrl === 'string' && (remoteUrl.startsWith('file://') || remoteUrl.startsWith('content://'))) {
    if (onProgress) onProgress(1);
    return remoteUrl;
  }

  // Consolidação com mediaCache: se o arquivo já foi baixado por alguma
  // outra rota (preCacheUrls em chat-conversation mount, por exemplo), o
  // mediaCache já tem — reutiliza em vez de baixar de novo num dir separado.
  // Antes isso gerava 2 caches paralelos com o mesmo áudio (audio-cache/ e
  // chat-media-saved/) e o audio re-baixava toda vez que o player montava.
  try {
    const { getCachedUri } = require('./mediaCache');
    if (typeof getCachedUri === 'function') {
      const mediaLocal = await getCachedUri(remoteUrl);
      if (mediaLocal && mediaLocal !== remoteUrl && typeof mediaLocal === 'string' && mediaLocal.startsWith('file://')) {
        if (onProgress) onProgress(1);
        return mediaLocal;
      }
    }
  } catch {}

  // Web: use Cache API
  if (Platform.OS === 'web') {
    if (onProgress) onProgress(0.5);
    const uri = await webCacheAudio(remoteUrl);
    if (onProgress) onProgress(1);
    return uri;
  }

  // Native: use expo-file-system
  const fs = getFS();
  if (!fs) return remoteUrl;

  if (!_index) await buildIndex();
  await ensureDir();

  const fileName = cacheFileName(remoteUrl, messageId);
  const localPath = getCacheDir() + fileName;

  // Check if already cached
  try {
    const info = await fs.getInfoAsync(localPath);
    if (info.exists && info.size > 0) {
      return localPath;
    }
  } catch {}

  // Download with progress
  try {
    const downloadResumable = fs.createDownloadResumable(
      remoteUrl,
      localPath,
      {},
      onProgress
        ? (downloadProgress) => {
            if (downloadProgress.totalBytesExpectedToWrite > 0) {
              onProgress(
                downloadProgress.totalBytesWritten /
                downloadProgress.totalBytesExpectedToWrite
              );
            }
          }
        : undefined
    );

    const result = await downloadResumable.downloadAsync();
    if (result && result.status === 200) {
      // Update index
      const size = result.headers?.['content-length']
        ? parseInt(result.headers['content-length'], 10)
        : 0;
      let fileSize = size;
      try {
        const finfo = await fs.getInfoAsync(localPath);
        if (finfo.exists) fileSize = finfo.size || size;
      } catch {}

      _index.files.push({ name: fileName, size: fileSize, atime: Date.now() / 1000 });
      _index.totalSize += fileSize;

      // Evict old files if over limits
      await evictIfNeeded();

      return localPath;
    }

    // Failed download - clean up
    try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
  } catch {}

  return remoteUrl; // Fallback to remote
}

/**
 * Clear the entire audio cache.
 */
export async function clearAudioCache() {
  if (Platform.OS === 'web') {
    await webClearCache();
    return;
  }
  const fs = getFS();
  if (!fs) return;
  const dir = getCacheDir();
  try {
    await fs.deleteAsync(dir, { idempotent: true });
  } catch {}
  _index = null;
}

/**
 * Get the current audio cache size in bytes.
 */
export async function getAudioCacheSize() {
  if (Platform.OS === 'web') return webGetCacheSize();
  if (!_index) await buildIndex();
  return _index ? _index.totalSize : 0;
}

/**
 * Get the number of cached audio files.
 */
export async function getAudioCacheCount() {
  if (Platform.OS === 'web') return 0; // Not easily accessible from Cache API
  if (!_index) await buildIndex();
  return _index ? _index.files.length : 0;
}

// ============================================================
// VOICE-MESSAGE PERMANENT CACHE (audio-saved/)
// ============================================================
//
// Voice notes are tiny (30-200KB on average) but the user emotional cost
// of "I can't play that voice mom sent me last week because I'm in the
// subway" is huge. So they get a SEPARATE permanent dir (never evicted by
// the LRU above) and we auto-download regardless of cellular gate — same
// policy as mediaCache.prefetchAudioMessage.

function getSavedDir() {
  const fs = getFS();
  if (!fs) return null;
  return fs.documentDirectory + SAVED_DIR_NAME;
}

function getOutboxDir() {
  const fs = getFS();
  if (!fs) return null;
  return fs.documentDirectory + OUTBOX_DIR_NAME;
}

async function ensureSavedDir() {
  const fs = getFS();
  if (!fs) return false;
  const dir = getSavedDir();
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });
    return true;
  } catch { return false; }
}

async function ensureOutboxDir() {
  const fs = getFS();
  if (!fs) return false;
  const dir = getOutboxDir();
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });
    return true;
  } catch { return false; }
}

function voiceFileName(remoteUrl, messageId) {
  const key = messageId ? String(messageId) : hashKey(remoteUrl);
  const ext = audioExt(remoteUrl);
  return 'voice_' + key + '_' + hashKey(remoteUrl) + '.' + ext;
}

/**
 * Permanent download of a voice message.
 *
 * Called from the WS chat_message / chat_summary handlers (via
 * voicePrefetch.onIncomingVoiceMessage) the moment ANY message with
 * type==='voice' (or 'audio' from a chat bubble) lands. Returns the local
 * file URI on success or the remote URL on failure. Idempotent: re-runs
 * cheap once cached.
 *
 * Honors the WhatsApp auto-download matrix via mediaCache.shouldAutoDownload
 * ('audio' bucket). The user can still opt into cellular voice prefetch by
 * flipping the Audio → Mobile cell ON (default in factory settings). On
 * Wi-Fi the matrix factory ON for audio means voice messages prefetch
 * silently as before. `opts.force` (e.g. user taps the play button) bypasses
 * the gate the same way mediaCache.cacheMedia does.
 *
 * Mirrors the mediaCache.saveMediaPermanent destination so a single download
 * serves both the chat list preview AND the bubble's audio player.
 */
export async function cacheVoiceMessage(remoteUrl, messageId, wavePeaks, opts = {}) {
  if (!remoteUrl) return remoteUrl;
  // Persist waveform first so the UI can paint bars before bytes arrive.
  if (Array.isArray(wavePeaks) && wavePeaks.length > 0) {
    setVoiceWaveform(remoteUrl, wavePeaks, messageId);
  }
  // [#1218 2026-05-20] WhatsApp-parity voice-note pre-fetch.
  // WhatsApp ALWAYS pre-fetches voice notes (they're tiny, typically <200KB)
  // regardless of the auto-download matrix — this is what makes "in the
  // subway, mom sent voice" work. We override the gate for voice notes too,
  // unless `opts.respectGate` is explicitly set (e.g. roaming with audio
  // toggled off). Anything else falls back to the matrix.
  const isVoice = opts.isVoice !== false; // assume voice unless caller says otherwise
  if (!opts.force && !isVoice && Platform.OS !== 'web') {
    try {
      const mc = require('./mediaCache');
      if (mc && typeof mc.shouldAutoDownload === 'function') {
        if (!mc.shouldAutoDownload('audio')) {
          // Surface the remote URL so the player can still stream on demand;
          // we just don't burn bytes pre-fetching it to disk.
          return remoteUrl;
        }
      }
    } catch {}
  }
  // Voice-note network sanity: only skip if absolutely no network at all.
  if (!opts.force && isVoice && Platform.OS !== 'web') {
    try {
      const ni = require('./networkInfo');
      if (typeof ni.getNetworkType === 'function' && ni.getNetworkType() === 'none') {
        return remoteUrl;
      }
    } catch {}
  }
  if (Platform.OS === 'web') {
    // Web reuses the same Cache API; we just record the URL for offline
    // service-worker hits. Returns the original URL — the audio element
    // pulls from cache transparently on the next play.
    try {
      const cache = await caches.open(WEB_CACHE_NAME);
      const existing = await cache.match(remoteUrl);
      if (!existing) {
        const resp = await fetch(remoteUrl);
        if (resp.ok) await cache.put(remoteUrl, resp.clone());
      }
    } catch {}
    return remoteUrl;
  }
  const fs = getFS();
  if (!fs) return remoteUrl;
  await ensureSavedDir();
  const dir = getSavedDir();
  const fileName = voiceFileName(remoteUrl, messageId);
  const localPath = dir + fileName;
  try {
    const info = await fs.getInfoAsync(localPath);
    if (info.exists && info.size > 0) return localPath;
  } catch {}
  // Delegate to mediaCache.saveMediaPermanent so the syncIndex (used by
  // the AudioPlayer's URL resolver) is updated. mediaCache writes to
  // documentDirectory/chat-media-saved/ — getCachedAudioUri already
  // consults it before falling back to our own audio-saved/, so this
  // single download serves every consumer. Pure additive integration.
  try {
    const mc = require('./mediaCache');
    if (mc && typeof mc.saveMediaPermanent === 'function') {
      const result = await mc.saveMediaPermanent(remoteUrl);
      if (typeof result === 'string' && result.startsWith('file://')) {
        // [#1218 2026-05-20 BUG#1 fix] Write-back the local file:// path into
        // SQLite so the bubble can show it offline. Without this, audioCache
        // wrote to disk but msg.local_path stayed NULL — cold-open shows
        // "mídia ainda não foi baixada" even though the file exists on disk.
        // Tolerate opts.conversationId being missing (some callers don't pass
        // it); dbUpdateMessageFields no-ops on null conv.
        try {
          if (messageId != null && opts.conversationId != null) {
            const nativeDb = require('./db');
            nativeDb.dbUpdateMessageFields?.(opts.conversationId, messageId, { local_path: result });
          }
        } catch {}
        return result;
      }
    }
  } catch {}
  // Fallback: download directly into audio-saved/.
  try {
    const dl = fs.createDownloadResumable(remoteUrl, localPath, {});
    const r = await dl.downloadAsync();
    if (r && r.status === 200) {
      // [#1218 2026-05-20 Wave 2] Integrity guard. A mid-flight disconnect
      // can leave a 0-byte file on disk; without this check, getInfoAsync
      // later sees `exists=true` and returns localPath, but the player
      // then silently emits status.error and the bubble shows "sem
      // internet". Verify size before declaring success.
      try {
        const info = await fs.getInfoAsync(localPath);
        if (!info?.exists || (info.size != null && info.size <= 0)) {
          try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
          return remoteUrl;
        }
      } catch {}
      // [#1218 2026-05-20 BUG#1 fix] Same write-back for the fallback path.
      try {
        if (messageId != null && opts.conversationId != null) {
          const nativeDb = require('./db');
          nativeDb.dbUpdateMessageFields?.(opts.conversationId, messageId, { local_path: localPath });
        }
      } catch {}
      return localPath;
    }
    try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
  } catch {}
  return remoteUrl;
}

// ============================================================
// WAVEFORM CACHE
// ============================================================

function _waveKey(remoteUrl, messageId) {
  return String(messageId || hashKey(String(remoteUrl)));
}

/**
 * Pre-decode hint: persist the server-side waveform peaks (an array of
 * 0..1 floats) so the next mount of the AudioPlayer paints the envelope
 * before the audio file even resolves locally. Stored as int8 (×100) to
 * keep MMKV writes tiny (~80 bytes per voice note).
 */
export function setVoiceWaveform(remoteUrl, peaks, messageId) {
  if (!Array.isArray(peaks) || peaks.length === 0) return;
  try {
    const key = _waveKey(remoteUrl, messageId);
    // Clamp to int8 0..100 — original floats sit in [0,1]; multiply×100
    // gives us 2 sig figs which is below render perception threshold.
    const packed = peaks.map(v => {
      const n = Number(v) || 0;
      if (n > 1) return Math.min(100, Math.round(n));
      return Math.max(0, Math.min(100, Math.round(n * 100)));
    });
    _waveCache.set(key, packed);
    setJSON(WAVE_KEY_PREFIX + key, packed);
    // Maintain LRU index so the cache can be capped.
    let index = getJSON(WAVE_INDEX_KEY) || [];
    index = [key, ...index.filter(k => k !== key)];
    if (index.length > MAX_WAVEFORM_ENTRIES) {
      const dropped = index.splice(MAX_WAVEFORM_ENTRIES);
      for (const k of dropped) {
        _waveCache.delete(k);
        try { mmkvRemove(WAVE_KEY_PREFIX + k); } catch {}
      }
    }
    setJSON(WAVE_INDEX_KEY, index);
  } catch {}
}

/**
 * Sync getter — returns the cached peaks (0..1 floats) or null if we
 * never saw a waveform for this voice note. Safe to call inline in a
 * render closure (memory hit or instant MMKV read).
 */
export function getVoiceWaveform(remoteUrl, messageId) {
  try {
    const key = _waveKey(remoteUrl, messageId);
    let packed = _waveCache.get(key);
    if (!packed) {
      packed = getJSON(WAVE_KEY_PREFIX + key);
      if (Array.isArray(packed)) _waveCache.set(key, packed);
    }
    if (!Array.isArray(packed) || packed.length === 0) return null;
    return packed.map(v => Math.max(0, Math.min(1, (Number(v) || 0) / 100)));
  } catch { return null; }
}

// ============================================================
// VOICE OUTBOX (offline send)
// ============================================================
//
// When the user records a voice note while offline (or while the WS is
// reconnecting), we persist the file in outbox/voice/ + push a queue
// entry into offlineCache so replayOfflineQueue can re-fire when net
// returns. This file survives an app kill because it lives in
// documentDirectory, not memory.

/**
 * Adopt a just-recorded voice file into the outbox dir so the queue
 * replay can resend it later. Returns the new permanent URI (or the
 * original if we couldn't copy — e.g. web).
 */
export async function adoptOutboxVoice(localUri, tempId) {
  if (!localUri || Platform.OS === 'web') return localUri;
  const fs = getFS();
  if (!fs) return localUri;
  await ensureOutboxDir();
  const ext = audioExt(localUri);
  const dest = getOutboxDir() + 'voice_' + String(tempId || Date.now()) + '.' + ext;
  try {
    const src = await fs.getInfoAsync(localUri);
    if (!src.exists || !src.size) return localUri;
    // Skip if destination already exists (same temp_id replay).
    try {
      const existing = await fs.getInfoAsync(dest);
      if (existing.exists && existing.size > 0) return dest;
    } catch {}
    await fs.copyAsync({ from: localUri, to: dest });
    return dest;
  } catch {
    return localUri;
  }
}

/**
 * Delete an outbox voice file once the server confirmed receipt.
 */
export async function removeOutboxVoice(outboxUri) {
  if (!outboxUri || Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  try { await fs.deleteAsync(outboxUri, { idempotent: true }); } catch {}
}

/**
 * List all outbox voice files (used by a startup sweep to re-queue files
 * orphaned by a crash mid-send).
 */
export async function listOutboxVoices() {
  if (Platform.OS === 'web') return [];
  const fs = getFS();
  if (!fs) return [];
  const dir = getOutboxDir();
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) return [];
    const entries = await fs.readDirectoryAsync(dir);
    return entries.map(n => dir + n);
  } catch { return []; }
}

// ============================================================
// CHUNK-RESUME STATE (WS reconnect parity)
// ============================================================
//
// During a streaming voice-session upload (chatVoiceSessionStart/Chunk)
// we may lose the WS or hit a 5xx mid-stream. The recorder keeps writing
// to disk locally so we persist the (sessionId, lastChunkIdx) pair —
// when the WS reconnects the recorder can resume from lastChunkIdx+1
// instead of re-uploading every chunk from 0.

const RESUME_KEY = 'voice_session_resume';

export function saveVoiceSessionResume(sessionId, lastChunkIdx, meta = {}) {
  if (!sessionId) return;
  try {
    const map = getJSON(RESUME_KEY) || {};
    map[String(sessionId)] = {
      last_chunk: lastChunkIdx,
      ts: Date.now(),
      ...meta,
    };
    setJSON(RESUME_KEY, map);
  } catch {}
}

export function getVoiceSessionResume(sessionId) {
  if (!sessionId) return null;
  try {
    const map = getJSON(RESUME_KEY) || {};
    return map[String(sessionId)] || null;
  } catch { return null; }
}

export function clearVoiceSessionResume(sessionId) {
  if (!sessionId) return;
  try {
    const map = getJSON(RESUME_KEY) || {};
    if (!(String(sessionId) in map)) return;
    delete map[String(sessionId)];
    setJSON(RESUME_KEY, map);
  } catch {}
}

// ============================================================
// SPEED PERSISTENCE
// ============================================================
//
// `voice_speed_default` (set in settings) is the user's global default
// (e.g. 1.5×). The per-conversation last-tap speed overrides it for the
// current bubble. Both persist via MMKV so a relaunch restores the speed
// the user last chose. The chat-conversation AudioPlayer calls these
// directly so this module owns the contract.

const VOICE_SPEED_KEY = 'voice_playback_rate';
const VOICE_SPEED_DEFAULT_KEY = 'voice_speed_default';
const VOICE_SPEED_ALLOWED = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3];

function _readNumericMMKV(key) {
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(key);
      return raw == null ? null : Number(raw);
    }
    const raw = getString(key);
    return raw == null ? null : Number(raw);
  } catch { return null; }
}

/**
 * Reads the active voice playback rate. Inline persistence takes priority
 * (most-recent inline choice) and falls back to the global default set in
 * settings (voice_speed_default), which itself defaults to 1.
 */
export function getActiveVoiceSpeed() {
  const inline = _readNumericMMKV(VOICE_SPEED_KEY);
  if (Number.isFinite(inline) && VOICE_SPEED_ALLOWED.includes(inline)) return inline;
  const def = _readNumericMMKV(VOICE_SPEED_DEFAULT_KEY);
  if (Number.isFinite(def) && VOICE_SPEED_ALLOWED.includes(def)) return def;
  return 1;
}

export function setActiveVoiceSpeed(rate) {
  if (!VOICE_SPEED_ALLOWED.includes(rate)) return;
  try {
    if (Platform.OS === 'web') {
      if (typeof localStorage !== 'undefined') localStorage.setItem(VOICE_SPEED_KEY, String(rate));
    } else {
      setString(VOICE_SPEED_KEY, String(rate));
    }
  } catch {}
}

// ============================================================
// GLOBAL MINI-PLAYER STATE BUS
// ============================================================
//
// When the user navigates away from a chat while a voice note is still
// playing, the AudioPlayer instance unmounts and the audio dies. To
// match WhatsApp's "keep listening while I scroll my email" behavior we
// expose a singleton bus that any host (e.g. _layout root) can mount a
// MiniPlayer against. The active AudioPlayer publishes its state on every
// playbackStatusUpdate so the mini bar shows the right title/avatar/
// progress; the bar's pause button delegates back through the same bus.

const _miniListeners = new Set();
let _miniState = null; // { messageId, conversationId, sender, avatar, progress, duration, playing, speed, returnRoute }

export function publishMiniPlayer(state) {
  if (!state) {
    _miniState = null;
  } else {
    _miniState = { ..._miniState, ...state };
  }
  for (const fn of _miniListeners) { try { fn(_miniState); } catch {} }
}

export function getMiniPlayerState() {
  return _miniState;
}

export function onMiniPlayerChange(fn) {
  _miniListeners.add(fn);
  try { fn(_miniState); } catch {}
  return () => _miniListeners.delete(fn);
}

// User-action funnels — these emit synthetic events the active
// AudioPlayer subscribes to via onMiniAction. Keeps the mini bar
// component free of expo-audio coupling.
const _miniActionListeners = new Set();
export function onMiniAction(fn) {
  _miniActionListeners.add(fn);
  return () => _miniActionListeners.delete(fn);
}
function _emitMiniAction(action) {
  for (const fn of _miniActionListeners) { try { fn(action); } catch {} }
}
export function miniPlayerPause() { _emitMiniAction({ type: 'pause' }); }
export function miniPlayerResume() { _emitMiniAction({ type: 'resume' }); }
export function miniPlayerDismiss() {
  _emitMiniAction({ type: 'dismiss' });
  publishMiniPlayer(null);
}

// ============================================================
// PLAYED ACK
// ============================================================
//
// Auto-fires when an AudioPlayer's playbackStatusUpdate sees
// didJustFinish === true. Server-side `chat_voice_played` action marks
// the message read (single-blue-check for voice). Idempotent — repeats
// for the same message id no-op.

const _ackedVoiceIds = new Set();

export async function ackVoicePlayed(messageId, conversationId) {
  if (messageId == null) return;
  const key = String(messageId);
  if (_ackedVoiceIds.has(key)) return;
  _ackedVoiceIds.add(key);
  try {
    const api = require('./api');
    if (typeof api.chatVoicePlayed === 'function') {
      await api.chatVoicePlayed(messageId, conversationId).catch(() => {});
    } else if (typeof api.apiCall === 'function') {
      // Fallback for older builds — directly POST chat_voice_played.
      await api.apiCall('chat_voice_played', {
        message_id: messageId,
        conversation_id: conversationId,
      }, 'POST').catch(() => {});
    }
  } catch {}
}
