/**
 * hlsOffline — download HLS manifests + every .ts segment locally so the
 * user can play a stream with no network.
 *
 * Why this module exists separately from videoCache.js:
 *   - HLS is a tree (master m3u8 → variant m3u8 → N×.ts segments). The
 *     download/serve logic is non-trivial and would dwarf the mp4 path if
 *     inlined into videoCache.
 *   - videoCache.js re-exports `saveHls / getHlsLocalManifest / isHlsAvailableOffline`
 *     so most callers only need that one import.
 *
 * Wire format on disk:
 *   documentDirectory + video-offline/<videoId>/
 *     ├── index.m3u8         ← REWRITTEN manifest pointing at local .ts files
 *     ├── original.m3u8      ← raw server manifest, kept for debugging
 *     └── seg_0001.ts, seg_0002.ts, ...
 *
 * The rewrite step is what makes offline playback work: expo-video /
 * react-native-video parse the m3u8 and follow each segment URI relative
 * to the manifest. If we don't rewrite, the player follows the original
 * https URLs and the offline guarantee evaporates.
 *
 * Limitations:
 *   - Only handles MEDIA playlists (the leaf m3u8 with EXTINF + .ts URIs).
 *     If the caller hands us a MASTER playlist, we pick the first variant.
 *     Adaptive bitrate selection is out of scope for offline (the user is
 *     downloading; they get one rendition).
 *   - No EXT-X-KEY / DRM. Plaintext HLS only. Encrypted streams require a
 *     key-fetch pass that we don't do here.
 *   - No fMP4 (#EXT-X-MAP). Plain .ts segments. Most server-side ffmpeg
 *     HLS output emits .ts, so we're fine for the chat/status pipeline.
 */

import { Platform } from 'react-native';

const HLS_DIR_NAME = 'video-offline/';

let FileSystem = null;
function getFS() {
  if (Platform.OS === 'web') return null;
  if (!FileSystem) {
    try { FileSystem = require('expo-file-system/legacy'); } catch { try { FileSystem = require('expo-file-system'); } catch { return null; } }
  }
  return FileSystem;
}

function getRoot() {
  const fs = getFS();
  if (!fs) return null;
  return fs.documentDirectory + HLS_DIR_NAME;
}

function safeId(videoId) {
  // Lock down to ASCII to keep paths sane on every platform.
  return String(videoId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
}

function dirFor(videoId) {
  const root = getRoot();
  if (!root) return null;
  return root + safeId(videoId) + '/';
}

async function ensureDir(dir) {
  const fs = getFS();
  if (!fs || !dir) return false;
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });
    return true;
  } catch { return false; }
}

// Resolve a possibly-relative URL against a base manifest URL. Same
// algorithm as the browser: absolute (scheme://) → as-is; root-relative
// (/foo) → host + path; bare (foo) → strip last segment of base + path.
function resolveRelative(baseUrl, ref) {
  if (!ref) return null;
  if (/^https?:\/\//i.test(ref)) return ref;
  try {
    // Use URL() when available (RN >= 0.59 with polyfill in expo).
    return new URL(ref, baseUrl).toString();
  } catch {
    // Hand-rolled fallback for older RN runtimes where URL throws.
    if (ref.startsWith('/')) {
      const m = baseUrl.match(/^(https?:\/\/[^/]+)/i);
      return m ? m[1] + ref : ref;
    }
    const baseNoQ = baseUrl.split('?')[0];
    const lastSlash = baseNoQ.lastIndexOf('/');
    return baseNoQ.slice(0, lastSlash + 1) + ref;
  }
}

// Parse an m3u8 text. Returns { isMaster, variants?, segments? }.
//  - master:  { isMaster:true, variants: [{ uri }] }
//  - media :  { isMaster:false, segments: [{ uri }] }
function parseManifest(text) {
  const lines = text.split(/\r?\n/);
  const variants = [];
  const segments = [];
  let isMaster = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) {
      if (line.startsWith('#EXT-X-STREAM-INF')) {
        isMaster = true;
        const next = (lines[i + 1] || '').trim();
        if (next && !next.startsWith('#')) variants.push({ uri: next });
      }
      continue;
    }
    // Plain URI line (segment, since we already captured variants above).
    if (!isMaster) segments.push({ uri: line });
  }
  return isMaster ? { isMaster, variants } : { isMaster, segments };
}

// Rewrite a media manifest so each segment URI points at the local
// `seg_XXXX.ts`. Preserves all other lines (EXTINF, EXT-X-TARGETDURATION,
// etc) so the player honours timings and bitrate hints.
function rewriteManifestForLocal(text, segmentLocalNames) {
  const lines = text.split(/\r?\n/);
  let segIdx = 0;
  const out = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) { out.push(raw); continue; }
    const localName = segmentLocalNames[segIdx++];
    out.push(localName ? localName : raw);
  }
  return out.join('\n');
}

/**
 * Download an HLS stream for offline playback.
 *
 * @param {string} videoId  stable id used as the local folder name
 * @param {string} manifestUrl  URL of either a master or media m3u8
 * @param {function} onProgress  called with (0..1) as segments land
 * @returns {Promise<string|null>} local manifest path on success
 */
export async function downloadHls(videoId, manifestUrl, onProgress) {
  if (Platform.OS === 'web' || !videoId || !manifestUrl) return null;
  const fs = getFS();
  if (!fs) return null;

  const dir = dirFor(videoId);
  if (!dir) return null;
  await ensureDir(dir);

  // 1. Fetch the manifest text.
  let manifestText;
  let mediaManifestUrl = manifestUrl;
  try {
    const r = await fetch(manifestUrl);
    if (!r.ok) return null;
    manifestText = await r.text();
  } catch { return null; }

  // 2. If master, drop down to the first variant. (Adaptive bitrate
  //    selection is out of scope offline.)
  const parsed = parseManifest(manifestText);
  if (parsed.isMaster) {
    const first = parsed.variants?.[0];
    if (!first?.uri) return null;
    mediaManifestUrl = resolveRelative(manifestUrl, first.uri);
    try {
      const r = await fetch(mediaManifestUrl);
      if (!r.ok) return null;
      manifestText = await r.text();
    } catch { return null; }
  }
  const media = parseManifest(manifestText);
  if (media.isMaster) return null; // double-master? bail.
  const segments = media.segments || [];
  if (!segments.length) return null;

  // [P2 2026-05-26] Stale-partial cleanup. The per-segment skip below resumes
  // an interrupted download by reusing .ts files already on disk — great when
  // the SAME run is retried. But a download that died long ago (source rotated,
  // app updated, videoId reused) can leave a large set of orphaned .ts files
  // with NO final index.m3u8 forever: each retry resumes against possibly
  // mismatched segments and never converges. Detect that here — if the
  // rewritten manifest is missing yet >50% of the expected segments are
  // already present, treat the dir as a stale partial, wipe it, and force a
  // clean re-download. (A healthy in-progress resume normally has the manifest
  // absent too, but we only nuke when the partial is substantial AND we just
  // (re)fetched a fresh manifest — so the worst case is re-downloading a
  // genuinely-resumable set once.)
  try {
    const manifestInfo = await fs.getInfoAsync(dir + 'index.m3u8');
    const manifestMissing = !(manifestInfo?.exists && manifestInfo?.size > 0);
    if (manifestMissing) {
      let tsCount = 0;
      try {
        const entries = await fs.readDirectoryAsync(dir);
        for (const f of entries) if (f.endsWith('.ts')) tsCount++;
      } catch {}
      if (tsCount > 0 && tsCount > segments.length * 0.5) {
        await fs.deleteAsync(dir, { idempotent: true });
        await ensureDir(dir);
      }
    }
  } catch {}

  // Persist the raw server manifest for debugging.
  try { await fs.writeAsStringAsync(dir + 'original.m3u8', manifestText); } catch {}

  // 3. Download segments. Cap concurrency at 4 — TS segments are usually
  //    1-6 seconds (200-800KB) so this gets reasonable throughput without
  //    hammering the CDN.
  const localNames = new Array(segments.length);
  const total = segments.length;
  let done = 0;
  const CONC = 4;

  const tasks = segments.map((seg, idx) => async () => {
    const segUrl = resolveRelative(mediaManifestUrl, seg.uri);
    if (!segUrl) return false;
    const localName = 'seg_' + String(idx + 1).padStart(4, '0') + '.ts';
    const localPath = dir + localName;
    try {
      // Skip if already on disk (resume from prior interrupted save).
      const info = await fs.getInfoAsync(localPath);
      if (info.exists && info.size > 0) {
        localNames[idx] = localName;
        done++;
        if (onProgress) onProgress(done / total);
        return true;
      }
    } catch {}
    try {
      const r = await fs.downloadAsync(segUrl, localPath);
      if (r?.status === 200) {
        localNames[idx] = localName;
        done++;
        if (onProgress) onProgress(done / total);
        return true;
      }
      try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
    } catch {}
    return false;
  });

  // Pool runner.
  let cursor = 0;
  async function worker() {
    while (cursor < tasks.length) {
      const my = cursor++;
      await tasks[my]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONC, tasks.length) }, worker));

  // Bail if any segment failed — partial HLS plays jagged-and-stops.
  if (localNames.some(n => !n)) {
    // Cleanup so we don't leave a half-set on disk pretending to be valid.
    // The caller can retry; resume support kicks in on next call.
    try {
      const entries = await fs.readDirectoryAsync(dir);
      for (const f of entries) {
        if (f.endsWith('.ts')) {
          // Keep the .ts files so the retry resumes — only nuke the
          // (non-existent) local manifest so isComplete() returns false.
        }
      }
    } catch {}
    return null;
  }

  // 4. Write the rewritten manifest pointing at local seg names.
  const rewritten = rewriteManifestForLocal(manifestText, localNames);
  const localManifestPath = dir + 'index.m3u8';
  try {
    await fs.writeAsStringAsync(localManifestPath, rewritten);
  } catch { return null; }

  if (onProgress) onProgress(1);
  return localManifestPath;
}

/** Local manifest URI suitable for `<Video source={{ uri }}>`. */
export function localManifestUri(videoId) {
  const dir = dirFor(videoId);
  if (!dir) return null;
  return dir + 'index.m3u8';
}

/** True if the rewritten manifest exists (download completed). */
export async function isComplete(videoId) {
  if (Platform.OS === 'web') return false;
  const fs = getFS();
  if (!fs) return false;
  try {
    const info = await fs.getInfoAsync(localManifestUri(videoId));
    return !!(info?.exists && info?.size > 0);
  } catch { return false; }
}

/**
 * Synchronous-style local manifest fetcher for the player mount path. Returns
 * the file:// URI when the rewritten manifest exists on disk, otherwise null.
 * The function is async because expo-file-system only exposes getInfoAsync,
 * but it does a single stat — fast enough for the pre-mount check in
 * ChatMediaViewer (we await ONCE before deciding source).
 *
 * Callers should pass the same `videoId` they used at downloadHls(). For chat
 * messages we use the message id (stable, conversation-scoped).
 */
export async function getLocalManifest(videoId) {
  if (Platform.OS === 'web' || !videoId) return null;
  const fs = getFS();
  if (!fs) return null;
  const uri = localManifestUri(videoId);
  if (!uri) return null;
  try {
    const info = await fs.getInfoAsync(uri);
    if (info?.exists && info?.size > 0) return uri;
  } catch {}
  return null;
}

/** Remove a single HLS download. */
export async function deleteHls(videoId) {
  if (Platform.OS === 'web') return false;
  const fs = getFS();
  if (!fs) return false;
  try {
    await fs.deleteAsync(dirFor(videoId), { idempotent: true });
    return true;
  } catch { return false; }
}

/**
 * Best-effort byte size of a single HLS download. Walks the folder.
 */
export async function getHlsSize(videoId) {
  if (Platform.OS === 'web') return 0;
  const fs = getFS();
  if (!fs) return 0;
  const dir = dirFor(videoId);
  let total = 0;
  try {
    const entries = await fs.readDirectoryAsync(dir);
    for (const name of entries) {
      try {
        const info = await fs.getInfoAsync(dir + name);
        if (info.exists && !info.isDirectory) total += info.size || 0;
      } catch {}
    }
  } catch {}
  return total;
}

/**
 * Evict oldest HLS downloads until we've freed at least `targetFreeBytes`.
 * Returns bytes actually freed. Called by videoCache.evictOldest when the
 * mp4 cache alone can't satisfy the budget request.
 */
export async function evictOldestHls(targetFreeBytes) {
  if (Platform.OS === 'web') return 0;
  const fs = getFS();
  if (!fs) return 0;
  const root = getRoot();
  await ensureDir(root);
  let entries = [];
  try { entries = await fs.readDirectoryAsync(root); } catch { return 0; }
  const items = [];
  for (const name of entries) {
    try {
      const info = await fs.getInfoAsync(root + name);
      if (!info.exists || !info.isDirectory) continue;
      const size = await getHlsSize(name);
      items.push({ name, size, mtime: info.modificationTime || 0 });
    } catch {}
  }
  items.sort((a, b) => a.mtime - b.mtime); // oldest first
  let freed = 0;
  for (const it of items) {
    if (freed >= targetFreeBytes) break;
    try {
      await fs.deleteAsync(root + it.name, { idempotent: true });
      freed += it.size;
    } catch {}
  }
  return freed;
}

// 1GB ceiling for the HLS dir. Higher than the mp4 cache because a 60s HLS
// stream at 720p is ~5-15MB — twenty 60s videos eats a quarter of the budget
// and the user wouldn't notice. Tightened from "no cap" so the offline dir
// doesn't grow unbounded for power users.
const HLS_CACHE_CAP_BYTES = 1024 * 1024 * 1024;
let _lastHlsEvictAt = 0;
let _hlsEvictInflight = null;

/**
 * LRU sweep across `documentDirectory/video-offline/<videoId>/`. Walks every
 * subdir, sums the bytes, and if total > 1GB deletes oldest-mtime dirs until
 * the remaining set fits the cap.
 *
 * Debounced (5min) like evictIfNeeded in mediaCache so we don't re-scan after
 * every segment write. Safe to call fire-and-forget from downloadHls()'s
 * caller — failures are non-fatal.
 *
 * Returns { freed, remaining } byte counts on success, null on noop (web,
 * debounce hit, fs missing).
 */
export async function evictHlsCache() {
  if (Platform.OS === 'web') return null;
  const now = Date.now();
  if (now - _lastHlsEvictAt < 5 * 60 * 1000 && _hlsEvictInflight) return _hlsEvictInflight;
  if (_hlsEvictInflight) return _hlsEvictInflight;
  const fs = getFS();
  if (!fs) return null;
  const root = getRoot();
  if (!root) return null;

  _hlsEvictInflight = (async () => {
    try {
      await ensureDir(root);
      let entries = [];
      try { entries = await fs.readDirectoryAsync(root); } catch { return null; }
      const items = [];
      for (const name of entries) {
        try {
          const info = await fs.getInfoAsync(root + name);
          if (!info.exists || !info.isDirectory) continue;
          const size = await getHlsSize(name);
          items.push({ name, size, mtime: info.modificationTime || 0 });
        } catch {}
      }
      const total = items.reduce((a, e) => a + e.size, 0);
      if (total <= HLS_CACHE_CAP_BYTES) {
        return { freed: 0, remaining: total };
      }
      // Oldest first, evict until under cap.
      items.sort((a, b) => a.mtime - b.mtime);
      let freed = 0;
      const need = total - HLS_CACHE_CAP_BYTES;
      for (const it of items) {
        if (freed >= need) break;
        try {
          await fs.deleteAsync(root + it.name, { idempotent: true });
          freed += it.size;
        } catch {}
      }
      return { freed, remaining: total - freed };
    } finally {
      _lastHlsEvictAt = Date.now();
      _hlsEvictInflight = null;
    }
  })();
  return _hlsEvictInflight;
}

/** Wipe every HLS download. Used by Settings → Clear video cache. */
export async function clearAllHls() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  try { await fs.deleteAsync(getRoot(), { idempotent: true }); } catch {}
}
