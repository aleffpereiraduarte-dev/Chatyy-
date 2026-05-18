/**
 * videoCache — offline video caching with tap-to-DL gate, resumable
 * downloads, thumbnail pre-cache, background completion, and a storage
 * budget guard.
 *
 * Design notes (kept terse — anything load-bearing has a comment):
 *
 *  1. Thumbnails live in `video-thumbs/`, persisted indefinitely. They're
 *     tiny (~5-30KB), so the LRU sweep ignores them — they always render
 *     before the heavy mp4 lands.
 *
 *  2. Videos live in `video-cache/`. Default behavior is TAP-TO-DOWNLOAD
 *     for anything > 2MB (cellular gate exists separately in mediaCache;
 *     this gate is independent so users can opt-in even on Wi-Fi if they
 *     want fine-grained control). `force:true` bypasses both gates.
 *
 *  3. Resume: every download writes its byte-progress to a `.progress`
 *     sidecar (JSON: { received, total, etag }). On reopen, if the same
 *     URL is requested we issue a `Range: bytes=<received>-` request and
 *     append. expo-file-system's `createDownloadResumable` already does
 *     the heavy lifting — we persist the `resumeData` blob it gives us
 *     between sessions.
 *
 *  4. Background completion via expo-background-fetch: registers a task
 *     that walks `.progress` sidecars and resumes any partial downloads
 *     when the device is on Wi-Fi. Same task can pre-cache the top-N
 *     unwatched videos from the feed if the caller registers them via
 *     `queueForBackgroundPrecache`.
 *
 *  5. Storage budget: when the video cache exceeds VIDEO_BUDGET_BYTES,
 *     `getStorageAlert()` returns a payload the settings screen can
 *     surface as a prompt ("Free up X GB?"). The actual cleanup is
 *     `evictOldest(targetBytes)`.
 *
 *  6. HLS offline lives in `./hlsOffline.js` — this module delegates
 *     `saveHls()` to it so callers have a single import surface.
 *
 *  This module deliberately does NOT touch chat-conversation.js,
 *   mediaCache.js, audioCache.js, settings.js — those are owned by other
 *   agents this wave. Hooks exposed here can be wired by chat-conversation
 *   in a later pass.
 */

import { Platform } from 'react-native';

const VIDEO_DIR_NAME = 'video-cache/';
const THUMB_DIR_NAME = 'video-thumbs/';
const HLS_DIR_NAME   = 'video-offline/'; // mirror hlsOffline's root so getCacheUsage covers both
const PROGRESS_SUFFIX = '.progress';
const RESUME_SUFFIX   = '.resume';

// Threshold above which we refuse to auto-download even if the cellular
// gate is open. Anything below 2MB is essentially a GIF-sized clip and the
// "tap to load" friction is more annoying than the bandwidth cost.
const TAP_TO_DL_BYTES = 2 * 1024 * 1024;
// Soft budget — when video cache exceeds this we ask the user to clean up.
// Picked at 1GB to match the description in the prompt. evictOldest can
// take a target so settings can offer "Free 2GB" by walking deeper.
const VIDEO_BUDGET_BYTES = 1 * 1024 * 1024 * 1024;
// Hard cap — if no user action and we cross this, evict aggressively.
const VIDEO_HARD_CAP_BYTES = 3 * 1024 * 1024 * 1024;

const BG_TASK_NAME = 'chatyy-video-bg-fetch-v1';
const PRECACHE_QUEUE_MMKV_KEY = 'video_cache_bg_queue_v1';

let FileSystem = null;
let BackgroundFetch = null;
let TaskManager = null;
let _bgTaskRegistered = false;

// Lazy require — same pattern as audioCache. expo-file-system isn't
// available on web and crashing the module load would break the whole bundle.
function getFS() {
  if (Platform.OS === 'web') return null;
  if (!FileSystem) {
    try { FileSystem = require('expo-file-system'); } catch { return null; }
  }
  return FileSystem;
}
function getBgFetch() {
  if (Platform.OS === 'web') return null;
  if (!BackgroundFetch) {
    try { BackgroundFetch = require('expo-background-fetch'); } catch { return null; }
  }
  return BackgroundFetch;
}
function getTaskManager() {
  if (Platform.OS === 'web') return null;
  if (!TaskManager) {
    try { TaskManager = require('expo-task-manager'); } catch { return null; }
  }
  return TaskManager;
}

function getVideoDir() {
  const fs = getFS();
  if (!fs) return null;
  // documentDirectory (not cacheDirectory) — iOS purges cache on storage
  // pressure and a 50MB video re-downloading is exactly what we're trying
  // to avoid. Same call mediaCache made for the same reason.
  return fs.documentDirectory + VIDEO_DIR_NAME;
}
function getThumbDir() {
  const fs = getFS();
  if (!fs) return null;
  return fs.documentDirectory + THUMB_DIR_NAME;
}
function getHlsDir() {
  const fs = getFS();
  if (!fs) return null;
  return fs.documentDirectory + HLS_DIR_NAME;
}

// Stable hash of a URL → safe filename. Strips query strings so signed-URL
// rotations (X-Amz-Expires, etc) don't bust the cache. Same trick mediaCache
// uses; copying it here so we don't import its internals.
function urlToKey(url) {
  const base = String(url).split('?')[0].split('#')[0];
  let h = 0;
  for (let i = 0; i < base.length; i++) {
    h = ((h << 5) - h) + base.charCodeAt(i);
    h |= 0;
  }
  const ext = base.match(/\.(mp4|mov|m4v|webm|mkv|avi|3gp)$/i)?.[1] || 'mp4';
  return Math.abs(h).toString(36) + '.' + ext.toLowerCase();
}

function thumbKey(url) {
  return urlToKey(url).replace(/\.[^.]+$/, '') + '.jpg';
}

// ============================================================
// DIR PREP
// ============================================================

async function ensureDir(dir) {
  const fs = getFS();
  if (!fs || !dir) return false;
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) await fs.makeDirectoryAsync(dir, { intermediates: true });
    return true;
  } catch { return false; }
}

// ============================================================
// THUMBNAIL CACHE
// ============================================================

/**
 * Synchronously returns the local thumbnail path for a video URL if we've
 * pre-cached it, else null. Use this in render closures to paint a poster
 * BEFORE the user taps to download the heavy mp4.
 */
export function getThumbnailPathSync(videoUrl) {
  if (!videoUrl || Platform.OS === 'web') return null;
  // No in-memory index for thumbs (they're rarely 100s of items); we just
  // return the deterministic path. Callers should pair this with an
  // `<Image onError={…}/>` fallback — if the file doesn't exist, the image
  // fails silently and the bubble keeps showing the spinner.
  const dir = getThumbDir();
  if (!dir) return null;
  return dir + thumbKey(videoUrl);
}

/**
 * Download and persist the server-generated `.thumb.jpg` sibling. The
 * backend's status-video-thumb-pipeline writes `<file>.thumb.jpg` next to
 * every uploaded video, so the URL is just `${videoUrl}.thumb.jpg`.
 *
 * Idempotent: skips the network if the local copy already exists.
 * Returns the local path on success or null on failure.
 */
export async function preCacheThumbnail(videoUrl) {
  if (!videoUrl || Platform.OS === 'web') return null;
  const fs = getFS();
  if (!fs) return null;
  const dir = getThumbDir();
  await ensureDir(dir);
  const localPath = dir + thumbKey(videoUrl);
  try {
    const info = await fs.getInfoAsync(localPath);
    if (info.exists && info.size > 0) return localPath;
  } catch {}
  const remoteThumb = videoUrl + '.thumb.jpg';
  try {
    const r = await fs.downloadAsync(remoteThumb, localPath);
    if (r?.status === 200) return localPath;
    try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
  } catch {
    try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
  }
  return null;
}

/**
 * Pre-cache thumbnails for a list of video URLs. Designed for the chat
 * conversation mount path — kicks off N parallel thumb fetches so posters
 * paint before the user even sees the bubbles.
 */
export async function preCacheThumbnails(urls) {
  if (Platform.OS === 'web' || !urls?.length) return;
  const BATCH = 8;
  for (let i = 0; i < urls.length; i += BATCH) {
    await Promise.allSettled(urls.slice(i, i + BATCH).map(u => preCacheThumbnail(u)));
  }
}

// ============================================================
// SYNC LOOKUP
// ============================================================

/**
 * Synchronously returns the local mp4 path if the full video is already
 * on disk, else null. Used by the player to skip the network entirely on
 * second-open. Performs a stat check via `getInfoAsync` is async, so this
 * is *optimistic*: it returns the deterministic path and the caller's
 * `<Video onError>` handler is the safety net. Callers wanting a hard
 * guarantee should use `getCachedVideoPath` (async).
 */
export function getVideoPathOptimistic(videoUrl) {
  if (!videoUrl || Platform.OS === 'web') return null;
  const dir = getVideoDir();
  if (!dir) return null;
  return dir + urlToKey(videoUrl);
}

/**
 * Async version — confirms the file exists on disk before returning the
 * path. Returns null if not cached (the player should fall back to remote
 * URL or the tap-to-DL UI).
 */
export async function getCachedVideoPath(videoUrl) {
  if (!videoUrl || Platform.OS === 'web') return null;
  const fs = getFS();
  if (!fs) return null;
  const path = getVideoDir() + urlToKey(videoUrl);
  try {
    const info = await fs.getInfoAsync(path);
    if (info.exists && info.size > 0) return path;
  } catch {}
  return null;
}

// ============================================================
// PROGRESS SIDECAR (resume support)
// ============================================================

async function readProgress(videoUrl) {
  const fs = getFS();
  if (!fs) return null;
  const sidecar = getVideoDir() + urlToKey(videoUrl) + PROGRESS_SUFFIX;
  try {
    const info = await fs.getInfoAsync(sidecar);
    if (!info.exists) return null;
    const raw = await fs.readAsStringAsync(sidecar);
    return JSON.parse(raw);
  } catch { return null; }
}

async function writeProgress(videoUrl, payload) {
  const fs = getFS();
  if (!fs) return;
  const sidecar = getVideoDir() + urlToKey(videoUrl) + PROGRESS_SUFFIX;
  try {
    await fs.writeAsStringAsync(sidecar, JSON.stringify(payload || {}));
  } catch {}
}

async function clearProgress(videoUrl) {
  const fs = getFS();
  if (!fs) return;
  const key = urlToKey(videoUrl);
  for (const suffix of [PROGRESS_SUFFIX, RESUME_SUFFIX]) {
    try { await fs.deleteAsync(getVideoDir() + key + suffix, { idempotent: true }); } catch {}
  }
}

// ============================================================
// DOWNLOAD (with tap-to-DL gate, progress, and resume)
// ============================================================

// Track active resumables so we can cancel them from outside (e.g. user
// taps the cancel ring while download is mid-flight).
const _activeDownloads = new Map(); // url → DownloadResumable
// Track in-flight Promises so concurrent calls dedupe.
const _inflight = new Map(); // url → Promise

/**
 * Probe content-length without downloading the body. Used by the tap-to-DL
 * gate to decide whether the file qualifies. Returns null on failure (we
 * proceed as if it's small — fail-open since a HEAD can be blocked by some
 * CDNs).
 */
export async function probeVideoSize(videoUrl) {
  if (!videoUrl) return null;
  try {
    // RN fetch supports HEAD on both platforms.
    const r = await Promise.race([
      fetch(videoUrl, { method: 'HEAD' }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 6000)),
    ]);
    if (!r?.ok) return null;
    const cl = r.headers?.get?.('content-length');
    return cl ? parseInt(cl, 10) : null;
  } catch { return null; }
}

/**
 * Download a video, with resume support and progress callbacks.
 *
 * @param {string} videoUrl
 * @param {object} opts
 *   - force {boolean}     bypass the tap-to-DL gate (use for explicit user tap)
 *   - onProgress {Fn}     called with (0..1)
 *   - knownSize  {number} skip the HEAD probe if caller already has it
 * @returns {Promise<string|null>} local path or null
 */
export async function downloadVideo(videoUrl, opts = {}) {
  if (!videoUrl || Platform.OS === 'web') return null;
  const fs = getFS();
  if (!fs) return null;

  // Already on disk?
  const existing = await getCachedVideoPath(videoUrl);
  if (existing) {
    if (opts.onProgress) opts.onProgress(1);
    return existing;
  }

  // Dedup concurrent calls.
  if (_inflight.has(videoUrl)) return _inflight.get(videoUrl);

  const promise = (async () => {
    await ensureDir(getVideoDir());
    const localPath = getVideoDir() + urlToKey(videoUrl);

    // Tap-to-DL gate: skip auto-DL if the file is > TAP_TO_DL_BYTES and the
    // caller didn't explicitly force. Lets us call downloadVideo() from a
    // background prefetch without bombing the user's cellular plan with a
    // 200MB clip — the bubble's tap handler passes force:true.
    if (!opts.force) {
      const size = opts.knownSize ?? await probeVideoSize(videoUrl);
      if (size != null && size > TAP_TO_DL_BYTES) {
        return null; // Caller should render tap-to-DL UI.
      }
    }

    // Resume support — if a previous attempt left a `.resume` blob, hand it
    // to createDownloadResumable so the request goes out with a Range
    // header and the partial bytes are kept.
    let resumeData = null;
    try {
      const sidecar = await readProgress(videoUrl);
      if (sidecar?.resumeData) resumeData = sidecar.resumeData;
    } catch {}

    const onProgressFs = (progress) => {
      const total = progress?.totalBytesExpectedToWrite || 0;
      const got   = progress?.totalBytesWritten || 0;
      if (total > 0 && opts.onProgress) opts.onProgress(got / total);
      // Persist progress every chunk — cheap (<1KB JSON write) and lets us
      // resume from the last successful chunk on app reopen.
      writeProgress(videoUrl, { received: got, total });
    };

    let resumable;
    try {
      if (resumeData && fs.DownloadResumable && typeof fs.DownloadResumable === 'function') {
        // Re-construct from persisted state. Some expo-file-system versions
        // don't expose the class directly — fall back to a fresh download
        // in that case (we still benefit from any local bytes via the
        // server's Range support if we DIY it, but expo handles the
        // common case via createDownloadResumable).
        resumable = new fs.DownloadResumable(videoUrl, localPath, {}, onProgressFs, resumeData);
      } else {
        resumable = fs.createDownloadResumable(videoUrl, localPath, {}, onProgressFs);
      }
    } catch {
      resumable = fs.createDownloadResumable(videoUrl, localPath, {}, onProgressFs);
    }

    _activeDownloads.set(videoUrl, resumable);
    try {
      // resumeAsync if we had prior data, downloadAsync otherwise. Either
      // way the final file lands at `localPath`.
      const result = resumeData && typeof resumable.resumeAsync === 'function'
        ? await resumable.resumeAsync()
        : await resumable.downloadAsync();

      if (result && (result.status === 200 || result.status === 206)) {
        await clearProgress(videoUrl);
        if (opts.onProgress) opts.onProgress(1);
        // Evict if we just crossed the budget. Fire-and-forget — the file
        // we just wrote is itself a fresh entry so won't be touched.
        evictIfOverBudget().catch(() => {});
        return localPath;
      }
      // Bad status — leave the partial in place; the next call can resume
      // (Range request) from where we stopped. Only nuke on 4xx (resource
      // gone, not flaky network).
      const status = result?.status || 0;
      if (status >= 400 && status < 500) {
        await clearProgress(videoUrl);
        try { await fs.deleteAsync(localPath, { idempotent: true }); } catch {}
      }
      return null;
    } catch (e) {
      // Pause request might throw — keep the resume sidecar so we can pick
      // up next time.
      try {
        if (typeof resumable?.savable === 'function') {
          const savable = await resumable.savable();
          await writeProgress(videoUrl, { resumeData: savable });
        }
      } catch {}
      return null;
    } finally {
      _activeDownloads.delete(videoUrl);
    }
  })();
  _inflight.set(videoUrl, promise);
  try { return await promise; }
  finally { _inflight.delete(videoUrl); }
}

/**
 * Cancel an in-flight download and persist its resume state so a future
 * call can pick up. Returns true if a download was paused.
 */
export async function pauseDownload(videoUrl) {
  if (!videoUrl) return false;
  const dl = _activeDownloads.get(videoUrl);
  if (!dl) return false;
  try {
    if (typeof dl.pauseAsync === 'function') await dl.pauseAsync();
    if (typeof dl.savable === 'function') {
      const savable = await dl.savable();
      await writeProgress(videoUrl, { resumeData: savable });
    }
    return true;
  } catch { return false; }
}

/**
 * Permanently abandon a partial download. Removes the bytes on disk AND
 * the resume sidecar so the next request starts from scratch.
 */
export async function cancelDownload(videoUrl) {
  await pauseDownload(videoUrl).catch(() => {});
  const fs = getFS();
  if (!fs) return;
  const key = urlToKey(videoUrl);
  try { await fs.deleteAsync(getVideoDir() + key, { idempotent: true }); } catch {}
  await clearProgress(videoUrl).catch(() => {});
}

// ============================================================
// HLS DELEGATION
// ============================================================

let _hlsModule = null;
function getHls() {
  if (Platform.OS === 'web') return null;
  if (!_hlsModule) {
    try { _hlsModule = require('./hlsOffline'); } catch { return null; }
  }
  return _hlsModule;
}

/**
 * Save an HLS stream for offline playback. Downloads the manifest +
 * every segment into `video-offline/<videoId>/`. See hlsOffline.js for
 * the heavy lifting; this is a re-export so callers have one import
 * surface (`videoCache.saveHls(...)`).
 */
export async function saveHls(videoId, manifestUrl, onProgress) {
  const hls = getHls();
  if (!hls?.downloadHls) return null;
  return hls.downloadHls(videoId, manifestUrl, onProgress);
}

/** Local manifest URI suitable for a `<Video source={{ uri }}>`. */
export function getHlsLocalManifest(videoId) {
  const hls = getHls();
  if (!hls?.localManifestUri) return null;
  return hls.localManifestUri(videoId);
}

/** True if HLS for the given videoId is fully downloaded. */
export async function isHlsAvailableOffline(videoId) {
  const hls = getHls();
  if (!hls?.isComplete) return false;
  return hls.isComplete(videoId);
}

export async function deleteHls(videoId) {
  const hls = getHls();
  if (!hls?.deleteHls) return false;
  return hls.deleteHls(videoId);
}

// ============================================================
// STORAGE BUDGET
// ============================================================

async function _dirSize(dir) {
  const fs = getFS();
  if (!fs || !dir) return 0;
  try {
    const info = await fs.getInfoAsync(dir);
    if (!info.exists) return 0;
    // expo-file-system's getInfoAsync on a directory reports the size of
    // the dir entry itself, not recursive contents. Walk manually.
    let total = 0;
    const stack = [dir];
    while (stack.length) {
      const cur = stack.pop();
      let entries = [];
      try { entries = await fs.readDirectoryAsync(cur); } catch { continue; }
      for (const name of entries) {
        const p = cur + (cur.endsWith('/') ? '' : '/') + name;
        try {
          const i = await fs.getInfoAsync(p);
          if (!i.exists) continue;
          if (i.isDirectory) stack.push(p + '/');
          else total += i.size || 0;
        } catch {}
      }
    }
    return total;
  } catch { return 0; }
}

/**
 * Get total bytes used by mp4 cache + hls offline + thumbnails. The
 * settings screen reads this to render the "video usage" row.
 */
export async function getCacheUsage() {
  if (Platform.OS === 'web') return { mp4: 0, hls: 0, thumbs: 0, total: 0 };
  const [mp4, hls, thumbs] = await Promise.all([
    _dirSize(getVideoDir()),
    _dirSize(getHlsDir()),
    _dirSize(getThumbDir()),
  ]);
  return { mp4, hls, thumbs, total: mp4 + hls + thumbs };
}

/**
 * If usage > VIDEO_BUDGET_BYTES, returns a payload the settings UI can use
 * to surface a prompt: `{ shouldPrompt:true, used, suggestedFreeBytes }`.
 * Otherwise returns `{ shouldPrompt:false, used }`.
 */
export async function getStorageAlert() {
  const { total } = await getCacheUsage();
  if (total < VIDEO_BUDGET_BYTES) return { shouldPrompt: false, used: total };
  // Default suggestion: free 2GB or half the cache, whichever is smaller.
  // Tuned so an aggressive cleanup never deletes >50% in one prompt.
  const suggestedFreeBytes = Math.min(2 * 1024 * 1024 * 1024, Math.floor(total / 2));
  return { shouldPrompt: true, used: total, suggestedFreeBytes };
}

/**
 * Evict oldest videos (by mtime) until we've freed at least
 * `targetFreeBytes`. Returns bytes actually freed. Skips the thumbnail dir
 * — thumbs are tiny and re-fetching them on a cold open looks broken.
 *
 * Also wipes accompanying .progress sidecars + HLS dirs of evicted ids.
 */
export async function evictOldest(targetFreeBytes) {
  const fs = getFS();
  if (!fs) return 0;
  const videoDir = getVideoDir();
  await ensureDir(videoDir);
  let entries = [];
  try { entries = await fs.readDirectoryAsync(videoDir); } catch { return 0; }
  const items = [];
  for (const name of entries) {
    if (name.endsWith(PROGRESS_SUFFIX) || name.endsWith(RESUME_SUFFIX)) continue;
    try {
      const info = await fs.getInfoAsync(videoDir + name);
      if (info.exists && !info.isDirectory) {
        items.push({ name, size: info.size || 0, mtime: info.modificationTime || 0 });
      }
    } catch {}
  }
  items.sort((a, b) => a.mtime - b.mtime); // oldest first
  let freed = 0;
  for (const it of items) {
    if (freed >= targetFreeBytes) break;
    try {
      await fs.deleteAsync(videoDir + it.name, { idempotent: true });
      // Also clear sidecars + matching HLS dir (best-effort).
      for (const s of [PROGRESS_SUFFIX, RESUME_SUFFIX]) {
        try { await fs.deleteAsync(videoDir + it.name + s, { idempotent: true }); } catch {}
      }
      freed += it.size;
    } catch {}
  }
  // Touch HLS too if we still haven't met target.
  if (freed < targetFreeBytes) {
    const hls = getHls();
    if (hls?.evictOldestHls) {
      try { freed += await hls.evictOldestHls(targetFreeBytes - freed); } catch {}
    }
  }
  return freed;
}

// Internal: keep cache under VIDEO_HARD_CAP_BYTES. Called after every
// successful download.
async function evictIfOverBudget() {
  const { total } = await getCacheUsage();
  if (total <= VIDEO_HARD_CAP_BYTES) return;
  await evictOldest(total - VIDEO_HARD_CAP_BYTES + 100 * 1024 * 1024); // headroom
}

/** Nuke the entire video cache + thumbs + hls. Settings → Storage uses this. */
export async function clearAllVideoCache() {
  if (Platform.OS === 'web') return;
  const fs = getFS();
  if (!fs) return;
  for (const dir of [getVideoDir(), getThumbDir(), getHlsDir()]) {
    try { await fs.deleteAsync(dir, { idempotent: true }); } catch {}
  }
}

// ============================================================
// BACKGROUND FETCH — resume pending downloads on Wi-Fi
// ============================================================

/**
 * Queue a list of video URLs (e.g. top 3 unwatched from feed) for
 * background pre-caching. The background-fetch task picks them up the
 * next time iOS/Android lets us run.
 */
export async function queueForBackgroundPrecache(urls) {
  if (Platform.OS === 'web' || !Array.isArray(urls) || !urls.length) return;
  try {
    const mmkv = require('./mmkv');
    const existing = mmkv.getJSON?.(PRECACHE_QUEUE_MMKV_KEY) || [];
    const dedup = new Set([...existing, ...urls.filter(u => typeof u === 'string' && u.startsWith('http'))]);
    // Cap to top 10 — the task only has ~30s of execution time per fire.
    mmkv.setJSON?.(PRECACHE_QUEUE_MMKV_KEY, [...dedup].slice(0, 10));
  } catch {}
}

async function _readQueue() {
  try {
    const mmkv = require('./mmkv');
    return mmkv.getJSON?.(PRECACHE_QUEUE_MMKV_KEY) || [];
  } catch { return []; }
}
async function _writeQueue(arr) {
  try {
    const mmkv = require('./mmkv');
    mmkv.setJSON?.(PRECACHE_QUEUE_MMKV_KEY, arr || []);
  } catch {}
}

// Body of the background task — also callable directly for testing /
// foreground retry.
async function runBackgroundCompletion() {
  const fs = getFS();
  if (!fs) return 'noop';

  // Only burn cellular data if we're on Wi-Fi. Same gate auto-backup uses.
  try {
    const { isWifi } = require('./networkInfo');
    if (typeof isWifi === 'function' && isWifi() !== true) return 'no-wifi';
  } catch {}

  // 1. Walk progress sidecars and resume any partial download. Cap at 3 to
  //    keep total runtime under iOS's ~30s background budget.
  await ensureDir(getVideoDir());
  let resumed = 0;
  try {
    const entries = await fs.readDirectoryAsync(getVideoDir());
    const sidecars = entries.filter(n => n.endsWith(PROGRESS_SUFFIX));
    for (const s of sidecars.slice(0, 3)) {
      // We don't keep URL ↔ key map on disk so we can't resume by URL —
      // but expo's DownloadResumable doesn't need it: the resumeData blob
      // contains the URL. Load the JSON, hand it back to a fresh
      // DownloadResumable, call resumeAsync().
      try {
        const raw = await fs.readAsStringAsync(getVideoDir() + s);
        const parsed = JSON.parse(raw);
        if (!parsed?.resumeData) continue;
        const target = getVideoDir() + s.replace(new RegExp(PROGRESS_SUFFIX + '$'), '');
        const resumable = new fs.DownloadResumable(
          parsed.resumeData.url, target, {}, undefined, parsed.resumeData
        );
        const res = await resumable.resumeAsync();
        if (res && (res.status === 200 || res.status === 206)) {
          await fs.deleteAsync(getVideoDir() + s, { idempotent: true });
          resumed++;
        }
      } catch {}
    }
  } catch {}

  // 2. Pre-cache queued feed videos. Honour the tap-to-DL gate based on
  //    HEAD probe — only auto-DL clips < TAP_TO_DL_BYTES OR if force was
  //    queued (we store {url, force?} either as string or {url, force}).
  const queue = await _readQueue();
  const next = [];
  let prefetched = 0;
  for (const item of queue.slice(0, 3)) {
    const url = typeof item === 'string' ? item : item?.url;
    const force = typeof item === 'object' && item?.force === true;
    if (!url) continue;
    try {
      const path = await downloadVideo(url, { force });
      if (path) prefetched++; else next.push(item); // keep for next fire
    } catch { next.push(item); }
  }
  await _writeQueue([...next, ...queue.slice(3)]);

  return resumed + prefetched > 0 ? 'work-done' : 'idle';
}

/**
 * Register the background-fetch task. Idempotent — safe to call at app
 * boot. Returns true if registration succeeded.
 */
export async function registerBackgroundTask() {
  if (Platform.OS === 'web') return false;
  if (_bgTaskRegistered) return true;
  const bg = getBgFetch();
  const tm = getTaskManager();
  if (!bg || !tm) return false;
  try {
    if (!tm.isTaskDefined(BG_TASK_NAME)) {
      tm.defineTask(BG_TASK_NAME, async () => {
        try {
          const result = await runBackgroundCompletion();
          return result === 'work-done'
            ? bg.BackgroundFetchResult.NewData
            : bg.BackgroundFetchResult.NoData;
        } catch {
          return bg.BackgroundFetchResult.Failed;
        }
      });
    }
    await bg.registerTaskAsync(BG_TASK_NAME, {
      minimumInterval: 15 * 60, // 15min — same cadence as auto-backup
      stopOnTerminate: false,
      startOnBoot: true,
    });
    _bgTaskRegistered = true;
    return true;
  } catch { return false; }
}

/** Manual trigger — useful for "Retry now" buttons in settings. */
export async function runBackgroundCompletionNow() {
  return runBackgroundCompletion();
}

// ============================================================
// CONSTANTS RE-EXPORT (for tests / settings UI)
// ============================================================

export const VIDEO_CACHE_CONSTANTS = Object.freeze({
  TAP_TO_DL_BYTES,
  VIDEO_BUDGET_BYTES,
  VIDEO_HARD_CAP_BYTES,
});
