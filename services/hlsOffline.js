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
    try { FileSystem = require('expo-file-system'); } catch { return null; }
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

/** Wipe every HLS download. Used by Settings → Clear video cache. */
export async function clearAllHls() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  try { await fs.deleteAsync(getRoot(), { idempotent: true }); } catch {}
}
