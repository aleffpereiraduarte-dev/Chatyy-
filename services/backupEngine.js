/**
 * BackupEngine — Production-grade photo backup system
 *
 * Inspired by Google Photos (resumable uploads, smart queue) and
 * iCloud (content deduplication, incremental sync).
 *
 * Features:
 * - Resumable uploads: interrupted uploads resume from byte offset
 * - Content deduplication: SHA-256 of first 64KB + size → skip duplicates
 * - Smart queue: prioritize smaller files, parallel workers, exponential retry
 * - Incremental sync: only scan photos newer than last sync timestamp
 * - Bandwidth optimization: WiFi-only option, skip tiny files, compress images
 * - Persistent state: survives app restart via AsyncStorage
 */

import { Platform } from 'react-native';
import * as api from './api';

// ─── Native Android engine bridge (2026-05-16) ───────────────────────
// On Android we route the hot-path primitives (scan / hash / compress /
// upload) through the new Kotlin module in modules/expo-background-upload.
// This unblocks the JS thread (UI freeze on first backup) and avoids the
// base64-load-the-whole-file OOM crash on large videos.
//
// iOS keeps its existing Swift module path untouched — `USE_NATIVE_ANDROID`
// is the only branch gate. Web stays on the JS fallback.
let _nativeBgUpload = null;
try {
  // Lazy require so a broken module load doesn't kill the file import.
  _nativeBgUpload = require('../modules/expo-background-upload').default;
} catch (_) {
  _nativeBgUpload = null;
}
const USE_NATIVE_ANDROID =
  Platform.OS === 'android' &&
  !!_nativeBgUpload &&
  typeof _nativeBgUpload.scanMediaStore === 'function';
function _nativeMod() { return _nativeBgUpload; }
export function isNativeAndroidBackupEnabled() { return USE_NATIVE_ANDROID; }

// ─── Remote debug beacon (→ /var/log/chatyy-backup.log on the server) ───
// Use liberally to trace where the backup loop stalls without needing Xcode.
// Fire-and-forget POST; never throws. Cheap enough to call inside the hot
// upload loop.
let _dbgSession = null;
let _dbgEmail = '-';
let _dbgEnabled = true;
try {
  _dbgSession = Math.random().toString(36).slice(2, 10) + '-' + Date.now().toString(36);
} catch {}
export function setBackupDebugEmail(email) { if (email) _dbgEmail = String(email); }
export function setBackupDebugEnabled(v) { _dbgEnabled = !!v; }
function _bdbg(tag, data) {
  if (!_dbgEnabled) return;
  try {
    fetch('https://chatyy.com.br/api/email.php?action=backup_debug', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag: String(tag).slice(0, 80),
        data: data != null ? data : null,
        email: _dbgEmail,
        session: _dbgSession,
      }),
    }).catch(() => {});
  } catch {}
}
export { _bdbg as backupDebug };
import {
  getBackedUpMap, saveBackedUpMap, markAssetBackedUp,
  getLastSync, setLastSync,
  getUploadSessions, saveUploadSessions,
  KEYS,
} from './backup/backupStorage';

// ─── Constants ───────────────────────────────────────────────
// Legacy keys kept for reference only; actual storage goes through backupStorage.
const STORAGE_KEYS = {
  BACKED_UP: KEYS.BACKED_UP_MAP,
  LAST_SYNC: KEYS.LAST_SYNC,
  UPLOAD_SESSIONS: KEYS.UPLOAD_SESSIONS,
};

const MIN_FILE_SIZE = 10 * 1024;       // 10KB — skip thumbnails/icons
const HASH_CHUNK_SIZE = 256 * 1024;    // 256KB for content fingerprint
// Concurrency: start at 4 (safe), scale up to 12 on success, scale down to 2 on failure.
// Was 32, but mobile networks crumble under 32 × 5 MB parallel uploads — observed
// 14 simultaneous "Network request failed" errors at 10:11:07 killing the whole pool.
// Bumped 4→6 since most backups run on WiFi and 4 was leaving the uplink idle.
// The breaker still catches surges and dials back to FLOOR (2) on cellular.
const MAX_CONCURRENT_START = 6;
const MAX_CONCURRENT_CEILING = 12;
const MAX_CONCURRENT_FLOOR = 2;
const MAX_CONCURRENT = MAX_CONCURRENT_CEILING; // backwards-compat for constructor
const CIRCUIT_BREAKER_THRESHOLD = 5;   // after 5 consecutive failures, pause
const CIRCUIT_BREAKER_PAUSE_MS = 10000; // 10s pause when tripped
const MULTIPART_THRESHOLD = 30 * 1024 * 1024; // 30MB → use multipart streaming
const MULTIPART_CHUNK_SIZE = 24 * 1024 * 1024; // 24MB chunks — fewer round-trips
// iOS jetsam limit is ~200MB for most app categories. Each in-flight part holds:
//   • the base64 string (1.33× chunk size = ~32MB for a 24MB chunk)
//   • the Uint8Array view (24MB)
//   • the underlying ArrayBuffer the network stack copies for the PUT body (24MB)
// At 6× parallel that was hitting ~480MB peak before GC — way above jetsam.
// Drop to 2 on iOS so peak stays well under 160MB. Android keeps the higher
// concurrency because Android JVM heap is far more forgiving (~512MB-1GB).
const MULTIPART_PART_CONCURRENCY = Platform.OS === 'ios' ? 2 : 6;
const UPLOAD_TIMEOUT_MS = 60000;       // 60s per photo upload
const VIDEO_TIMEOUT_MS = 1800000;      // 30min per video upload
const RETRY_MAX = 4;                   // max retries per photo
const RETRY_MAX_VIDEO = 2;             // videos retry twice
const RETRY_BASE_MS = 800;             // exponential backoff base
const RETRY_CAP_MS = 8000;             // cap individual retry sleep at 8s
const DEDUP_BATCH_SIZE = 100;          // hashes per dedup check
const PHOTO_PAGE_SIZE = 200;           // process photos in batches of 200
const SAVE_INTERVAL = 10;              // save progress every N completions (was 5)
const SESSION_EXPIRY_MS = 6 * 3600 * 1000; // 6 hours
// Image compression — aggressively sized to fit single iOS NSURLSession upload
// window. 1600 px / 0.78 = files in the 0.5-1.5 MB range. At 3 Mbps wifi that's
// ~2-4 seconds per file, well under iOS's ~14s connection-kill timeout. We accept
// reduced quality in exchange for not getting murdered by NSURLSession.
const COMPRESS_MAX_WIDTH = 1600;
const COMPRESS_QUALITY = 0.78;
// Files larger than this go through chunked upload — but with the new compression
// almost no file will hit this threshold so chunked should rarely run.
const RUST_DIRECT_MAX_BYTES = 2 * 1024 * 1024; // 2 MB

// MIME map for extensions
const MIME_MAP = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  heic: 'image/heic', heif: 'image/heif', gif: 'image/gif',
  webp: 'image/webp', mp4: 'video/mp4', mov: 'video/quicktime',
  avi: 'video/x-msvideo', mkv: 'video/x-matroska', m4v: 'video/mp4',
  '3gp': 'video/3gpp',
};

const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'm4v', '3gp'];

// ─── Utility functions ───────────────────────────────────────
function getExt(filename) {
  if (!filename) return '';
  const parts = filename.split('.');
  return parts.length > 1 ? parts.pop().toLowerCase() : '';
}

function isVideoExt(ext) {
  return VIDEO_EXTS.includes(ext);
}

function formatSpeed(bytesPerSec) {
  if (bytesPerSec <= 0) return '0 B/s';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  const i = Math.floor(Math.log(bytesPerSec) / Math.log(1024));
  return (bytesPerSec / Math.pow(1024, i)).toFixed(1) + ' ' + units[i];
}

function formatETA(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--';
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}min`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}min`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// ─── Content Hash (deduplication fingerprint) ────────────────
// Strategy, in priority order:
//   1. Files ≤ 64 MB → full-file SHA-256. Strongest fingerprint, cost is
//      one-off per upload and negligible on native.
//   2. Large files  → SHA-256 of [first 1MB || last 1MB || size] so two
//      videos that share an intro but differ later don't collide. A naive
//      first-chunk hash lost the second video silently — that was the
//      original production bug.
//   3. Web > ~100MB → same double-slice approach via Blob.slice().
// All variants append `:${fileSize}` so size mismatches always split the
// hash space even on the rare chance two sampled windows align.
async function computeContentHash(uri, fileSize) {
  const CHUNK = 1024 * 1024;           // 1 MB windows for large files
  const FULL_HASH_LIMIT = 64 * 1024 * 1024; // hash the whole file below this

  // ── Android native fast path ──────────────────────────────
  // Streaming MessageDigest in Kotlin reads 64KB chunks straight from the
  // ContentResolver InputStream — no base64, no full-file load. A 100MB
  // video hashes in 6-8s vs 2-3min on the JS path.
  if (USE_NATIVE_ANDROID && typeof uri === 'string' && uri.startsWith('content://')) {
    try {
      const hex = await _nativeMod().hashFile(uri);
      if (hex) return `${hex}:${fileSize || 0}`;
    } catch (e) {
      // Fall through to the legacy expo-crypto path.
      console.warn('[Backup] native hashFile failed:', e?.message);
    }
  }

  try {
    if (Platform.OS === 'web') {
      const resp = await fetch(uri);
      const blob = await resp.blob();
      let parts;
      if (blob.size <= FULL_HASH_LIMIT) {
        parts = [await blob.arrayBuffer()];
      } else {
        const head = await blob.slice(0, CHUNK).arrayBuffer();
        const tail = await blob.slice(Math.max(0, blob.size - CHUNK)).arrayBuffer();
        parts = [head, tail];
      }
      const combined = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
      let off = 0; for (const p of parts) { combined.set(new Uint8Array(p), off); off += p.byteLength; }
      const hashBuffer = await crypto.subtle.digest('SHA-256', combined);
      const hex = Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
      return `${hex}:${fileSize}`;
    }

    try {
      const Crypto = require('expo-crypto');
      let FS; try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }

      if (fileSize && fileSize <= FULL_HASH_LIMIT) {
        const all = await FS.readAsStringAsync(uri, { encoding: FS.EncodingType.Base64 });
        const hash = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, all);
        return `${hash}:${fileSize}`;
      }

      const head = await FS.readAsStringAsync(uri, {
        encoding: FS.EncodingType.Base64, length: CHUNK, position: 0,
      });
      const tailPos = Math.max(0, (fileSize || 0) - CHUNK);
      const tail = await FS.readAsStringAsync(uri, {
        encoding: FS.EncodingType.Base64, length: CHUNK, position: tailPos,
      });
      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        head + tail
      );
      return `${hash}:${fileSize}`;
    } catch {
      return `fallback:${fileSize}:${uri.split('/').pop()}`;
    }
  } catch {
    return null;
  }
}

// ─── BackupEngine Class ──────────────────────────────────────
export class BackupEngine {
  constructor() {
    // Queue state
    this.queue = [];          // { asset, priority, retries, hash, size, status }
    this.active = new Map();  // assetId → upload promise
    this.failed = [];         // items that exhausted retries
    this.completed = [];      // completed items (current session)

    // Config
    this.maxConcurrent = MAX_CONCURRENT;
    this.isPaused = false;
    this.isRunning = false;

    // Stats
    this.stats = {
      totalFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      skippedFiles: 0,      // duplicates + too small
      totalBytes: 0,
      uploadedBytes: 0,
      startTime: 0,
      speed: 0,             // bytes/sec (rolling average)
    };

    // Backed up IDs (legacy compat)
    this.backedUpIds = {};

    // Upload sessions for resumable uploads
    this.uploadSessions = {};

    // Callbacks
    this.onProgress = null;     // (stats) => void
    this.onComplete = null;     // (stats) => void
    this.onError = null;        // (error, item) => void
    this.onFileComplete = null; // (item) => void

    // Speed tracking (rolling window)
    this._speedSamples = [];
    this._lastSpeedCalc = 0;

    // Internal
    this._aborted = false;
    this._completedSinceLastSave = 0;
  }

  // ─── Initialization ─────────────────────────────────────
  async init() {
    // Load backed-up IDs from unified storage
    try {
      this.backedUpIds = await getBackedUpMap();
    } catch {
      this.backedUpIds = {};
    }

    // ── ONE-TIME PURGE for OTA #50: the previous stem-based dedup polluted
    // backedUpIds with thousands of false positives. Wipe the cache once so the
    // new asset.id-only filter starts clean. Marker stored separately so we
    // only do it once.
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      const PURGE_KEY = 'backup_purge_v50';
      const purged = await AsyncStorage.getItem(PURGE_KEY);
      if (!purged) {
        const sizeBefore = Object.keys(this.backedUpIds).length;
        this.backedUpIds = {};
        await saveBackedUpMap({});
        await AsyncStorage.setItem(PURGE_KEY, String(Date.now()));
        api.apiCall('drive_backup_debug', {
          msg: 'one_time_purge_v50',
          data: `wiped ${sizeBefore} entries from backedUpIds (broken stem dedup)`
        }, 'POST').catch(() => {});
      }
    } catch (e) {
      console.warn('[Backup] one-time purge failed:', e?.message);
    }

    // ── AUTO-CORRECTION: detect and fix stale/corrupt backedUpIds ──
    try {
      const idCount = Object.keys(this.backedUpIds).length;
      if (idCount > 0) {
        // Get real server count — REQUIRE success before making any wipe decision.
        // A failed API call must NOT be interpreted as "server is empty" or we
        // wipe the cache on every flaky-network run. Observed: server=0 kept
        // triggering auto_fix_drift which erased progress every backup attempt.
        const serverRes = await api.filePhotos('all', 1, 1).catch(() => null);
        const serverOk = !!serverRes?.success;
        const serverCount = serverOk ? (serverRes.data?.total || 0) : -1;

        // Get device total
        let deviceTotal = 0;
        try {
          const ML = require('expo-media-library');
          const { status } = await ML.getPermissionsAsync();
          if (status === 'granted') {
            const r = await ML.getAssetsAsync({ mediaType: [ML.MediaType.photo, ML.MediaType.video], first: 1 });
            deviceTotal = r?.totalCount || 0;
          }
        } catch {}

        const pendingReal = (serverOk && deviceTotal > 0) ? Math.max(0, deviceTotal - serverCount) : 0;

        // FIX 1: backedUpIds has MORE than device total → stale, reset
        if (idCount > deviceTotal && deviceTotal > 0) {
          console.warn(`[Backup] AUTO-FIX: backedUpIds(${idCount}) > device(${deviceTotal}). Resetting.`);
          this.backedUpIds = {};
          await saveBackedUpMap({});
          api.apiCall('drive_backup_debug', { msg: 'auto_fix_reset', data: `ids=${idCount} device=${deviceTotal} server=${serverCount}` }, 'POST').catch(() => {});
        }
        // FIX 2: backedUpIds says "all done" but server has way fewer → stale, reset
        //        ONLY trigger if we actually got a valid server count (not a failed API call).
        else if (serverOk && idCount > serverCount + 1000 && pendingReal > 1000) {
          console.warn(`[Backup] AUTO-FIX: backedUpIds(${idCount}) >> server(${serverCount}), pending=${pendingReal}. Resetting.`);
          this.backedUpIds = {};
          await saveBackedUpMap({});
          api.apiCall('drive_backup_debug', { msg: 'auto_fix_drift', data: `ids=${idCount} server=${serverCount} pending=${pendingReal}` }, 'POST').catch(() => {});
        } else if (!serverOk) {
          // Log once per run so we can see why we skipped
          api.apiCall('drive_backup_debug', { msg: 'auto_fix_skipped_api_fail', data: `ids=${idCount}` }, 'POST').catch(() => {});
        }
        // FIX 3: backedUpIds close to server count → healthy, no action
      }
    } catch (e) {
      console.warn('[Backup] Auto-correction error:', e?.message);
    }

    // ── SERVER-SIDE BOOTSTRAP DEDUP (cross-platform) ──
    // The iOS native upload path warms backedUpIds via drive_precheck_asset_ids
    // before scanning (autoBackup.js:408). Android (and iOS-fallback) goes through
    // engine.runFullBackup which only consults the local map. When the local map
    // is empty (post-install, post-logout, post-v3-migration wipe, account
    // switch), the engine re-uploads every photo from scratch and the user sees
    // "30 de 45593 (0%)" even though their library is already in R2.
    // Fix: walk the device library once and ask the server which asset_ids are
    // already in drive_files, then merge those into backedUpIds before scan.
    try {
      if (Object.keys(this.backedUpIds).length < 100) {
        const ML = require('expo-media-library');
        const { status } = await ML.getPermissionsAsync();
        if (status === 'granted') {
          const deviceIds = [];
          let cursor;
          let pages = 0;
          while (pages < 12) {
            const page = await ML.getAssetsAsync({
              first: 5000,
              after: cursor,
              mediaType: [ML.MediaType.photo, ML.MediaType.video],
            });
            for (const a of page.assets) deviceIds.push(a.id);
            if (!page.hasNextPage) break;
            cursor = page.endCursor;
            pages++;
          }
          if (deviceIds.length > 0) {
            const now = Date.now();
            let seeded = 0;
            for (let i = 0; i < deviceIds.length; i += 1500) {
              const slice = deviceIds.slice(i, i + 1500);
              try {
                const r = await api.apiCall('drive_precheck_asset_ids', { asset_ids: slice }, 'POST');
                const list = r?.data?.backed_up || r?.backed_up || [];
                for (const id of list) {
                  if (!this.backedUpIds[id]) {
                    this.backedUpIds[id] = now;
                    seeded++;
                  }
                }
              } catch {}
            }
            if (seeded > 0) {
              await saveBackedUpMap(this.backedUpIds);
              api.apiCall('drive_backup_debug', { msg: 'server_bootstrap', data: `seeded=${seeded} device=${deviceIds.length}` }, 'POST').catch(() => {});
            }
          }
        }
      }
    } catch (e) {
      console.warn('[Backup] Server bootstrap failed:', e?.message);
    }

    // Load upload sessions from unified storage and clean up expired/completed ones
    try {
      const parsed = await getUploadSessions();
      const now = Date.now();
      let pruned = false;
      for (const [key, session] of Object.entries(parsed)) {
        if (now - session.createdAt > SESSION_EXPIRY_MS || session.completed) {
          delete parsed[key];
          pruned = true;
        }
      }
      this.uploadSessions = parsed;
      if (pruned) {
        await this._saveUploadSessions();
      }
    } catch {
      this.uploadSessions = {};
    }
  }

  // ─── Clean up completed/expired upload sessions ─────────
  async cleanupSessions() {
    const now = Date.now();
    let changed = false;
    for (const [key, session] of Object.entries(this.uploadSessions)) {
      if (session.completed || now - session.createdAt > SESSION_EXPIRY_MS) {
        delete this.uploadSessions[key];
        changed = true;
      }
    }
    if (changed) {
      await this._saveUploadSessions();
    }
  }

  // ─── Incremental Sync: get only new photos (paginated) ──
  // Returns an async generator that yields batches of PHOTO_PAGE_SIZE assets.
  // This avoids loading the entire photo library into memory at once.
  async *getNewPhotosIterator(includeVideos = true) {
    if (Platform.OS === 'web') return;

    // ── Android native fast path ────────────────────────────
    // The Kotlin MediaStoreHelper paginates internally in 500-row chunks
    // and returns the whole filtered set in one bridge crossing — ~1.2s
    // for 30k items vs ~7s when we were round-tripping page-by-page
    // through expo-media-library.
    if (USE_NATIVE_ANDROID) {
      try {
        const sinceMs = null; // full scan — dedup map handles already-backed-up
        const rows = await _nativeMod().scanMediaStore(sinceMs);
        const filtered = (rows || []).filter(r => {
          if (this.backedUpIds[r.id]) return false;
          if (!includeVideos && r.mediaType === 'video') return false;
          return true;
        });
        // Reshape into the same `asset` envelope the existing pipeline expects.
        const assets = filtered.map(r => ({
          id: r.id,
          uri: r.uri,
          filename: r.filename,
          mediaType: r.mediaType,
          fileSize: r.size,
          width: r.width,
          height: r.height,
          creationTime: r.dateAdded,
          modificationTime: r.dateModified,
          mimeType: r.mimeType,
        }));
        for (let i = 0; i < assets.length; i += PHOTO_PAGE_SIZE) {
          yield assets.slice(i, i + PHOTO_PAGE_SIZE);
        }
        return;
      } catch (e) {
        console.warn('[Backup] native scanMediaStore failed, falling back to ML:', e?.message);
        // Fall through to expo-media-library path below.
      }
    }

    const ML = require('expo-media-library');
    const { status } = await ML.requestPermissionsAsync();
    if (status !== 'granted') {
      throw new Error('PERMISSION_DENIED');
    }

    // Get last sync timestamp for incremental sync (unified storage)
    // DISABLED: lastSync filter was skipping old photos that were never backed up
    // Full scan is needed — deduplication handles already-backed-up photos
    let lastSync = null;
    // NOTE: We intentionally scan ALL photos and let deduplicateAssets() handle filtering.
    // Using createdAfter skips photos taken before last sync that were never uploaded.

    const mediaTypes = [ML.MediaType.photo];
    if (includeVideos) mediaTypes.push(ML.MediaType.video);

    let hasMore = true;
    let cursor = undefined;
    let batch = [];

    while (hasMore) {
      const query = {
        mediaType: mediaTypes,
        first: PHOTO_PAGE_SIZE,
        after: cursor,
        sortBy: [ML.SortBy.creationTime],
      };

      const page = await ML.getAssetsAsync(query);
      if (page?.assets?.length > 0) {
        // Dedup ONLY by asset.id (stable per-photo on iOS/Android).
        const totalInPage = page.assets.length;
        const newAssets = page.assets.filter(a => !this.backedUpIds[a.id]);
        // Log scan stats only every 20 pages to avoid flooding the debug endpoint
        // (was one POST per page = 218 posts per scan on a 43k library).
        this._scanPageCount = (this._scanPageCount || 0) + 1;
        if (this._scanPageCount % 20 === 1) {
          const filtered = totalInPage - newAssets.length;
          api.apiCall('drive_backup_debug', {
            msg: 'scan_page',
            data: `page=${this._scanPageCount} total=${totalInPage} new=${newAssets.length} filtered_known=${filtered} ` +
                  `total_count=${page.totalCount || 0} hasNext=${page.hasNextPage}`,
          }, 'POST').catch(() => {});
        }
        batch = batch.concat(newAssets);

        // Yield when batch reaches page size
        while (batch.length >= PHOTO_PAGE_SIZE) {
          yield batch.splice(0, PHOTO_PAGE_SIZE);
        }

        cursor = page.endCursor;
        hasMore = page.hasNextPage;
      } else {
        hasMore = false;
      }
    }

    // Yield any remaining assets
    if (batch.length > 0) {
      yield batch;
    }
  }

  // Convenience method: collect all new photos (for backward compat / small libraries)
  async getNewPhotos(includeVideos = true) {
    if (Platform.OS === 'web') return [];
    const allAssets = [];
    for await (const batch of this.getNewPhotosIterator(includeVideos)) {
      allAssets.push(...batch);
    }
    return allAssets;
  }

  // ─── Content Deduplication ──────────────────────────────
  async deduplicateAssets(assets) {
    if (assets.length === 0) return { toUpload: [], skipped: [] };

    const ML = require('expo-media-library');
    let FS; try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }

    // Phase 1: Build entries FAST (no getAssetInfoAsync — too slow for 30K+ photos)
    // Use asset.uri directly, resolve localUri only when uploading
    const hashEntries = [];
    for (const asset of assets) {
      const size = asset.fileSize || asset.width * asset.height * 3 || 100000; // estimate
      const modTime = asset.modificationTime || asset.creationTime || 0;
      hashEntries.push({
        asset,
        uri: asset.uri,
        size,
        hash: null,
        fastKey: `${asset.id}:${modTime}`,
        filename: asset.filename || 'photo.jpg',
      });
    }

    // No additional dedup here — getNewPhotosIterator already filtered by asset.id.
    // The previous stem-based filter killed thousands of legitimate uploads when
    // filenames collided (IMG_xxxx is reused constantly on iOS). The server's
    // ON CONFLICT (user_email, name) UPSERT plus the asset_id filename suffix
    // (drive_register_uploaded) handle the rare actual collision safely.
    return { toUpload: hashEntries, skipped: [] };
  }

  // ─── Build Upload Queue ─────────────────────────────────
  buildQueue(entries, qualitySetting = 'economy') {
    // Photos FIRST (Google Photos pattern), then videos. Within each class, smaller first.
    const isVid = (e) => e.asset?.mediaType === 'video' || isVideoExt(getExt(e.filename));
    const sorted = [...entries].sort((a, b) => {
      const av = isVid(a) ? 1 : 0;
      const bv = isVid(b) ? 1 : 0;
      if (av !== bv) return av - bv; // photos before videos
      return (a.size || 0) - (b.size || 0); // smaller first within class
    });

    // Capture the active user email at queue-build time. If a multi-account
    // user logs into a different account mid-backup, api.getSavedEmail()
    // returns the NEW account but the queued photos belong to the OLD one
    // — uploading them under the new account would mis-attribute thousands
    // of photos. Each item carries the email it was queued for; the upload
    // worker refuses to ship if api.getSavedEmail() no longer matches.
    const queueEmail = (this._userEmail || api.getSavedEmail?.() || '');
    this._queueEmail = queueEmail;

    this.queue = sorted.map((entry, idx) => ({
      id: entry.asset.id,
      asset: entry.asset,
      uri: entry.uri,
      filename: entry.filename,
      size: entry.size,
      hash: entry.hash,
      priority: idx,
      retries: 0,
      status: 'pending', // pending | uploading | completed | failed
      _queuedForEmail: queueEmail,
    }));

    this.stats.totalFiles = this.queue.length;
    this.stats.totalBytes = this.queue.reduce((sum, item) => sum + (item.size || 0), 0);
    this.stats.startTime = Date.now();
    this.stats.completedFiles = 0;
    this.stats.failedFiles = 0;
    this.stats.uploadedBytes = 0;
    this.stats.speed = 0;

    this._speedSamples = [];
    this._completedSinceLastSave = 0;
  }

  // ─── Start Processing Queue ─────────────────────────────
  // REWRITTEN: simple sequential loop in mini-batches of 3 via Promise.all.
  // The previous worker-pool had too many race conditions and coordination bugs:
  // workers getting stuck in fetch, circuit-breaker state drift, items consumed
  // from the queue before active.size was checked, etc. The mobile network can't
  // handle >3 parallel uploads anyway, so sequential mini-batch is actually faster
  // in practice AND is trivially correct.
  async start(qualitySetting = 'economy') {
    _bdbg('engine.start.enter', { quality: qualitySetting, isRunning: this.isRunning, queue: this.queue.length });
    if (this.isRunning) { _bdbg('engine.start.already_running'); return; }
    this.isRunning = true;
    this.isPaused = false;
    this._aborted = false;
    // Reset circuit breaker on every fresh start — otherwise a previous run
    // that tripped (Rust service hang) left _pausedUntil far in the future,
    // which made the new start() spin in the pause loop without uploading
    // anything. User-reported symptom: "to rodando e n acontece nada".
    this._pausedUntil = 0;
    this._consecutiveFails = 0;
    this._consecutiveOks = 0;
    // Also clear the cached Rust-upload probe so if the service was down
    // when we last checked, we re-probe immediately instead of riding on
    // stale "unavailable" for the rest of the session.
    try {
      const api = require('./api');
      if (typeof api._resetRustUploadProbe === 'function') api._resetRustUploadProbe();
    } catch {}

    // Watchdog — if completedFiles hasn't advanced in 3 minutes the worker
    // loop is almost certainly stuck on a half-open socket. Log it so we
    // can see it in the debug stream, then let the per-item deadline above
    // kick in to unblock. Without this we had user reports of counter
    // frozen at 26457 for hours.
    const wdStart = Date.now();
    let lastProgressAt = wdStart;
    let lastCount = 0;
    const wdTimer = setInterval(() => {
      const c = this.stats.completedFiles || 0;
      if (c > lastCount) { lastCount = c; lastProgressAt = Date.now(); return; }
      if (this.isPaused || this._pausedUntil > Date.now()) { lastProgressAt = Date.now(); return; }
      const stalledMs = Date.now() - lastProgressAt;
      if (stalledMs > 180000) {
        try {
          const api = require('./api');
          api.apiCall('drive_backup_debug', {
            msg: 'stall_detected',
            data: `stalled=${Math.round(stalledMs/1000)}s completed=${c} queue=${this.queue.length} active=${this.active.size}`,
          }, 'POST').catch(() => {});
        } catch {}
        // Nudge any active items toward timeout by aborting our controller.
        try { this._abortActive?.(); } catch {}
        lastProgressAt = Date.now();
      }
    }, 30000);
    this._watchdogTimer = wdTimer;

    try {
      const api = require('./api');
      const r = await api.filePhotos('all', 1, 1);
      this._initialBackedUp = r?.data?.total || 0;
    } catch { this._initialBackedUp = 0; }

    let ImageManipulator = null;
    if (qualitySetting !== 'original') {
      try { ImageManipulator = require('expo-image-manipulator'); } catch {}
    }

    // BATCH=2 — minimum parallelism that still saturates 1 TCP pipe per upload
    // without overwhelming the mobile NSURLSession connection pool. Was 6 but
    // 6 parallel × 5 MB body was triggering iOS to kill all 6 simultaneously.
    // With 2 parallel × 1.5 MB body, each finishes in ~3-4s reliably.
    const BATCH = 2;
    let idx = 0;
    let consecutiveBatchAllFail = 0;
    _bdbg('engine.loop.start', { queueLen: this.queue.length, initialBackedUp: this._initialBackedUp });
    while (idx < this.queue.length && !this._aborted) {
      if (this.isPaused) { await new Promise(r => setTimeout(r, 500)); continue; }
      const chunk = [];
      for (let b = 0; b < BATCH && idx < this.queue.length; b++, idx++) {
        const item = this.queue[idx];
        if (!item || item.status === 'completed' || item.status === 'failed') { b--; continue; }
        chunk.push(item);
      }
      if (chunk.length === 0) break;

      // Track per-batch results so we can detect total network outage
      let batchSuccesses = 0;
      let batchNetFails = 0;

      // Hard per-item timeout. Without this a single stuck PUT (dropped
      // connection where the socket is half-open) hangs the whole queue.
      // 3 min for photos, 15 min for videos — matches worst-case 4G uploads.
      const withDeadline = (p, ms, label) => Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error(label + '_timeout')), ms)),
      ]);
      await Promise.all(chunk.map(async (item) => {
        const isNetErr = (e) => /network|timeout|aborted|rust_net_fail|_timeout/i.test(e?.message || '');
        item.status = 'uploading';
        this.active.set(item.id || idx, item);
        const ext = getExt(item.filename);
        const isVid = item.asset?.mediaType === 'video' || isVideoExt(ext);
        const deadlineMs = isVid ? 900000 : 180000; // 15min / 3min
        try {
          await withDeadline(
            this._uploadItem(item, ImageManipulator, qualitySetting),
            deadlineMs,
            isVid ? 'video_upload' : 'image_upload',
          );
          item.status = 'completed';
          this.completed.push(item);
          this.stats.completedFiles++;
          batchSuccesses++;
          if (item.asset?.id) this.backedUpIds[item.asset.id] = Date.now();
          if (this.onFileComplete) this.onFileComplete(item);
        } catch (err) {
          _bdbg('upload.item.err', { id: item.asset?.id, file: item.filename, msg: String(err?.message || err).slice(0, 200), netErr: isNetErr(err) });
          if (isNetErr(err)) batchNetFails++;
          // 1 quick retry — but skip retry on network error (network is dead, don't waste time)
          if (!isNetErr(err)) {
            try {
              await new Promise(r => setTimeout(r, 800));
              await withDeadline(
                this._uploadItem(item, ImageManipulator, qualitySetting),
                deadlineMs,
                isVid ? 'video_upload' : 'image_upload',
              );
              item.status = 'completed';
              this.completed.push(item);
              this.stats.completedFiles++;
              batchSuccesses++;
              if (item.asset?.id) this.backedUpIds[item.asset.id] = Date.now();
              return;
            } catch (err2) {
              _bdbg('upload.item.retry_err', { file: item.filename, msg: String(err2?.message || err2).slice(0, 200) });
              if (isNetErr(err2)) batchNetFails++;
            }
          }
          item.status = 'failed';
          this.failed.push(item);
          this.stats.failedFiles++;
        } finally {
          this.active.delete(item.id || idx);
        }

        this._completedSinceLastSave++;
        if (this._completedSinceLastSave >= SAVE_INTERVAL) {
          this._completedSinceLastSave = 0;
          this._saveProgress().catch(() => {});
        }
        if (this.onProgress) this.onProgress(this.getProgress());
      }));

      // Adaptive pause: if the WHOLE batch failed with network errors, sleep
      // before the next batch instead of churning. Doubles each consecutive
      // dead batch up to 60s. Resets on any success.
      if (batchSuccesses === 0 && batchNetFails > 0) {
        consecutiveBatchAllFail++;
        const pauseMs = Math.min(60000, 5000 * Math.pow(2, consecutiveBatchAllFail - 1));
        api.apiCall('drive_backup_debug', {
          msg: 'batch_all_failed_pause',
          data: `consecutive=${consecutiveBatchAllFail} pause=${pauseMs}ms`,
        }, 'POST').catch(() => {});
        // Re-queue the failed items so they get retried after the pause
        for (const item of chunk) {
          if (item.status === 'failed' && item.retries === undefined) {
            item.status = 'pending';
            idx -= 1; // back up one slot per re-queued item
          }
        }
        await new Promise(r => setTimeout(r, pauseMs));
      } else {
        consecutiveBatchAllFail = 0;
      }
    }

    // Finished
    _bdbg('engine.loop.end', {
      completed: this.stats.completedFiles,
      failed: this.stats.failedFiles,
      uploadedBytes: this.stats.uploadedBytes,
      aborted: this._aborted,
      queueLen: this.queue.length,
    });
    this.isRunning = false;
    if (this._watchdogTimer) { try { clearInterval(this._watchdogTimer); } catch {} this._watchdogTimer = null; }

    // Final save
    await this._saveProgress();

    // Only update last sync timestamp if at least one file was successfully uploaded & confirmed
    if (this.stats.completedFiles > 0) {
      try {
        await setLastSync(new Date().toISOString());
      } catch {}
    }

    if (this.onComplete) {
      this.onComplete(this.getProgress());
    }
  }

  // ─── Background presign batcher ─────────────────────────
  // Walks the queue in chunks of 50 and asks the server for N presigned URLs
  // in a single round-trip. Each item gets `_presigned = { upload_url, object_key, file_id }`
  // attached so the worker can skip the per-photo init call entirely.
  async _runPresignBatcher() {
    const BATCH = 50;
    let cursor = 0;
    while (!this._aborted && this.isRunning) {
      // Find a window of items that don't have a presign yet AND aren't videos (>30MB
      // takes the multipart path which has its own init).
      const window = [];
      while (cursor < this.queue.length && window.length < BATCH) {
        const it = this.queue[cursor++];
        if (!it) break;
        const ext = getExt(it.filename);
        const isVid = it.asset?.mediaType === 'video' || isVideoExt(ext);
        // Skip videos and items already presigned/completed
        if (!isVid && !it._presigned && it.status !== 'completed' && it.status !== 'failed') {
          // Skip files that will use multipart (>30MB)
          const sz = it.size || 0;
          if (sz === 0 || sz <= MULTIPART_THRESHOLD) window.push(it);
        }
      }
      if (window.length === 0) {
        // Nothing to presign right now — either we're past the end or the queue is processing.
        // Sleep briefly and re-check; bail out if all items have presign or are done.
        const remaining = this.queue.some(q => !q._presigned && q.status !== 'completed' && q.status !== 'failed');
        if (!remaining) break;
        await new Promise(r => setTimeout(r, 200));
        // Reset cursor so we re-scan for retried items
        if (cursor >= this.queue.length) cursor = 0;
        continue;
      }
      try {
        const items = window.map(it => ({
          filename: it.filename,
          mime_type: MIME_MAP[getExt(it.filename)] || 'image/jpeg',
          size: it.size || 0,
        }));
        const r = await api.driveInitUploadBatch(items);
        const results = r?.data?.results || [];
        for (let i = 0; i < window.length && i < results.length; i++) {
          const res = results[i];
          if (res?.success) {
            window[i]._presigned = {
              upload_url: res.upload_url,
              object_key: res.object_key,
              file_id: res.file_id,
              s3_key: res.object_key,
            };
          }
        }
      } catch {
        // On failure leave items un-presigned — workers will fall back to per-photo init.
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // ─── Worker: processes items from queue ─────────────────
  // Adaptive concurrency — workers voluntarily sleep when `active.size >= _activeConcurrency`
  // so we can scale concurrency up/down based on network health. Circuit breaker pauses
  // ALL workers for 10s when we hit too many consecutive failures.
  async _worker(ImageManipulator, quality, workerIdx) {
    while (!this._aborted) {
      if (this.isPaused) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // CIRCUIT BREAKER: if tripped, wait until _pausedUntil
      if (this._pausedUntil > Date.now()) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // ADAPTIVE: if too many workers are already active, this worker sleeps
      // briefly so the "active concurrency" ceiling is respected without killing workers.
      if (this.active.size >= this._activeConcurrency) {
        await new Promise(r => setTimeout(r, 200));
        continue;
      }

      // Atomically grab the next pending item
      let item = null;
      while (this._nextIdx < this.queue.length) {
        const candidate = this.queue[this._nextIdx];
        this._nextIdx++;
        if (candidate.status === 'pending') { item = candidate; break; }
      }
      if (!item) {
        for (let i = 0; i < this.queue.length; i++) {
          if (this.queue[i].status === 'pending') { item = this.queue[i]; break; }
        }
      }
      if (!item) break; // queue truly empty

      item.status = 'uploading';
      this.active.set(item.id, item);

      try {
        await this._uploadItem(item, ImageManipulator, quality);
        item.status = 'completed';
        this.completed.push(item);
        this.stats.completedFiles++;
        this.backedUpIds[item.id] = Date.now();
        // SUCCESS: scale concurrency UP (slowly)
        this._consecutiveOks++;
        this._consecutiveFails = 0;
        if (this._consecutiveOks >= 5 && this._activeConcurrency < MAX_CONCURRENT_CEILING) {
          this._activeConcurrency = Math.min(MAX_CONCURRENT_CEILING, this._activeConcurrency + 1);
          this._consecutiveOks = 0;
          api.apiCall('drive_backup_debug', { msg: 'concurrency_up', data: `to=${this._activeConcurrency}` }, 'POST').catch(() => {});
        }
        if (this.onFileComplete) this.onFileComplete(item);
      } catch (err) {
        item.retries++;
        const ext = getExt(item.filename);
        const isVid = item.asset?.mediaType === 'video' || isVideoExt(ext);
        const maxRetries = isVid ? RETRY_MAX_VIDEO : RETRY_MAX;

        // FAILURE: scale concurrency DOWN, trip circuit breaker on streak
        this._consecutiveFails++;
        this._consecutiveOks = 0;
        if (this._activeConcurrency > MAX_CONCURRENT_FLOOR) {
          this._activeConcurrency = Math.max(MAX_CONCURRENT_FLOOR, Math.floor(this._activeConcurrency / 2));
          api.apiCall('drive_backup_debug', { msg: 'concurrency_down', data: `to=${this._activeConcurrency} fails=${this._consecutiveFails}` }, 'POST').catch(() => {});
        }
        if (this._consecutiveFails >= CIRCUIT_BREAKER_THRESHOLD && this._pausedUntil < Date.now()) {
          this._pausedUntil = Date.now() + CIRCUIT_BREAKER_PAUSE_MS;
          this._circuitTripCount++;
          this._consecutiveFails = 0;
          api.apiCall('drive_backup_debug', { msg: 'circuit_trip', data: `pause=${CIRCUIT_BREAKER_PAUSE_MS}ms trips=${this._circuitTripCount}` }, 'POST').catch(() => {});
        }

        if (item.retries < maxRetries) {
          const delay = Math.min(RETRY_CAP_MS, RETRY_BASE_MS * Math.pow(2, item.retries - 1));
          await new Promise(r => setTimeout(r, delay));
          item.status = 'pending';
        } else {
          item.status = 'failed';
          this.failed.push(item);
          this.stats.failedFiles++;
          if (this.onError) this.onError(err, item);
        }
      } finally {
        this.active.delete(item.id);
      }

      // Periodic progress save
      this._completedSinceLastSave++;
      if (this._completedSinceLastSave >= SAVE_INTERVAL) {
        this._completedSinceLastSave = 0;
        this._saveProgress().catch(() => {});
      }

      if (this.onProgress) {
        this.onProgress(this.getProgress());
      }
    }
  }

  // ─── Upload a single item ──────────────────────────────
  async _uploadItem(item, ImageManipulator, quality) {
    _bdbg('upload.item.enter', { id: item.asset?.id, file: item.filename, size: item.size });
    // Refuse to upload if the active account changed since the queue was
    // built. Without this, multi-account users who switched logins mid-
    // backup had thousands of photos uploaded under the wrong account
    // (auth token + email come from api.getSavedEmail() at upload time).
    // _queuedForEmail is set in buildQueue.
    if (item._queuedForEmail) {
      const currentEmail = (api.getSavedEmail && api.getSavedEmail()) || '';
      if (currentEmail && currentEmail !== item._queuedForEmail) {
        _bdbg('upload.account_mismatch_skip', {
          queued: item._queuedForEmail,
          current: currentEmail,
          file: item.filename,
        });
        // Throw so the worker counts it as failed (queued IDs from the
        // previous account stay un-marked, won't pollute the new account's
        // backed-up map). The user will need to re-trigger backup under the
        // correct account; the lock is released by start() either way.
        throw new Error('account_switched_during_backup');
      }
    }
    const _t0 = Date.now();
    const ext = getExt(item.filename);
    const isVideo = item.asset.mediaType === 'video' || isVideoExt(ext);

    // Resolve local URI — use asset.uri directly (getAssetInfoAsync is too slow/blocks)
    let uri = item.uri || item.asset.uri;

    // Compress image (Google Photos style)
    let uploadUri = uri;
    let mimeType = isVideo ? 'video/mp4' : (MIME_MAP[ext] || 'image/jpeg');
    let uploadFilename = item.filename;

    // Skip compression for already-small files (< 500 KB) — they're already compressed,
    // running ImageManipulator just wastes CPU and writes another temp file.
    const skipCompress = item.size && item.size < 500 * 1024;

    if (!isVideo && quality !== 'original' && !skipCompress) {
      // Android: BitmapFactory + inSampleSize in Kotlin — no main-thread JPEG
      // decode. iOS / web: keep expo-image-manipulator.
      // [P1 OOM 2026-05-26] Compression of very large images (48MP HEIC,
      // panoramas) can blow the native bitmap allocation and throw an
      // out-of-memory error. Defensive contract for BOTH compress paths:
      //   - On ANY failure we leave uploadUri/mimeType/uploadFilename at the
      //     ORIGINAL values (never a half-written temp). The original upload
      //     is bigger but correct — far better than a corrupt/partial JPEG or
      //     a hard crash. We explicitly do NOT mutate uploadUri unless the
      //     compressor returned a complete result.
      //   - OOM is detected and logged distinctly so we can spot devices that
      //     consistently can't compress and tune COMPRESS_MAX_WIDTH down.
      const isOomErr = (e) => /out of memory|outofmemory|oom|java\.lang\.OutOfMemoryError|memory|alloc/i.test(e?.message || e?.toString?.() || '');
      if (USE_NATIVE_ANDROID && typeof uri === 'string') {
        try {
          const r = await _nativeMod().compressImage(
            uri,
            COMPRESS_MAX_WIDTH,
            Math.round(COMPRESS_QUALITY * 100)
          );
          // Only adopt the compressed output if it's COMPLETE (has a uri/path).
          // A partial / falsy result keeps the original — no half-state.
          if (r && (r.uri || r.path)) {
            uploadUri = r.uri || ('file://' + r.path);
            mimeType = 'image/jpeg';
            if (!['jpg', 'jpeg'].includes(ext)) {
              uploadFilename = uploadFilename.replace(/\.[^.]+$/, '.jpg');
            }
          }
        } catch (e) {
          // Skip compression — upload the original. uploadUri is untouched.
          const oom = isOomErr(e);
          console.warn('[Backup] native compressImage failed' + (oom ? ' (OOM)' : '') + ':', e?.message);
          api.apiCall('drive_backup_debug', { msg: oom ? 'compress_oom_skip' : 'compress_fail_skip', data: `native|${uploadFilename}|${e?.message || ''}` }, 'POST').catch(() => {});
        }
      } else if (ImageManipulator?.manipulateAsync) {
        try {
          const result = await ImageManipulator.manipulateAsync(
            uri,
            [{ resize: { width: COMPRESS_MAX_WIDTH } }],
            { compress: COMPRESS_QUALITY, format: ImageManipulator.SaveFormat.JPEG }
          );
          // Only adopt if the manipulator returned a complete uri.
          if (result?.uri) {
            uploadUri = result.uri;
            mimeType = 'image/jpeg';
            if (!['jpg', 'jpeg'].includes(ext)) {
              uploadFilename = uploadFilename.replace(/\.[^.]+$/, '.jpg');
            }
          }
        } catch (e) {
          // Skip compression on failure — upload the ORIGINAL (uploadUri is
          // still the unmodified source). Never silently continue with a
          // half-compressed temp.
          const oom = isOomErr(e);
          console.warn('[Backup] ImageManipulator failed' + (oom ? ' (OOM)' : '') + ':', e?.message);
          api.apiCall('drive_backup_debug', { msg: oom ? 'compress_oom_skip' : 'compress_fail_skip', data: `manip|${uploadFilename}|${e?.message || ''}` }, 'POST').catch(() => {});
        }
      }
    }

    // iOS asset URIs (ph://, assets-library://) can NOT be streamed directly
    // by React Native's FormData / fetch. If we didn't already compress to a
    // file:// path, copy the original to a temp file here. Without this, small
    // files (which skip compression) were hitting the legacy path and timing
    // out on `fetch(ph://...)` after 30s — the `upload_throw` flood.
    if (Platform.OS !== 'web' && typeof uploadUri === 'string' &&
        (uploadUri.startsWith('ph://') || uploadUri.startsWith('assets-library://'))) {
      try {
        let FS; try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }
        const dest = FS.cacheDirectory + 'bk_' + item.id.replace(/[^a-zA-Z0-9]/g, '_') + '_' + Date.now() + '.' + (ext || 'jpg');
        await FS.copyAsync({ from: uploadUri, to: dest });
        uploadUri = dest;
      } catch (copyErr) {
        // Fall through: ImageManipulator as a last resort to get a file:// URL
        try {
          if (ImageManipulator?.manipulateAsync) {
            const r = await ImageManipulator.manipulateAsync(uri, [], {
              compress: 1.0,
              format: ImageManipulator.SaveFormat.JPEG,
            });
            uploadUri = r.uri;
          }
        } catch {}
      }
    }

    // Get file size
    let fileSize = item.size;
    if (Platform.OS !== 'web') {
      try {
        let FS; try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }
        const info = await FS.getInfoAsync(uploadUri);
        fileSize = info?.size || fileSize;
      } catch {}
    }

    // PRIMARY PATH: Rust media-upload service (port 9103, direct R2, ~1.5s/photo).
    // 1. POST file to /api/rust/upload — Rust streams it to R2 and returns cdn_url.
    // 2. POST drive_register_uploaded — PHP creates the drive_files row with the real size.
    //    (Rust doesn't touch the DB; this is the only way the photo appears in the Cloud screen.)
    // We use Rust for everything ≤ 30 MB AND for unknown-size files (iOS often returns
    // fileSize=0 for HEIC/GIF/WEBP — without this, those fell through to the legacy path).
    if (fileSize <= MULTIPART_THRESHOLD) {
      const tStart = Date.now();
      try {
        const userEmail = (item.asset?._userEmail || this._userEmail || api.getSavedEmail?.() || '');
        let fileForRust;
        if (Platform.OS === 'web') {
          const blob = await fetch(uploadUri).then(r => r.blob());
          fileForRust = { _raw: blob, name: uploadFilename, type: mimeType };
        } else {
          fileForRust = { uri: uploadUri, name: uploadFilename, type: mimeType, size: fileSize };
        }
        // Use chunked upload for files > 2 MB OR unknown size. iOS NSURLSession kills
        // single-shot uploads after ~14s (HTTP 499), so anything bigger than ~2 MB at
        // typical mobile WiFi (3 Mbps upload) needs to be split.
        // Also: if iOS reports fileSize=0 (common for HEIC/some asset types), assume
        // the file might be big and use chunked to be safe.
        const sizeKnown = fileSize > 0;
        const useChunked = Platform.OS !== 'web'
          && typeof api.rustChunkedUpload === 'function'
          && (sizeKnown ? fileSize > 2 * 1024 * 1024 : true);
        _bdbg('upload.rust.begin', { file: uploadFilename, size: fileSize, chunked: useChunked });
        const r = useChunked
          ? await api.rustChunkedUpload(fileForRust, userEmail, 'photo_backup')
          : await api.rustUpload(fileForRust, userEmail, 'photo_backup');
        const elapsed = Date.now() - tStart;
        _bdbg('upload.rust.done', { ok: !!r?.success, error: r?.error || '', elapsedMs: elapsed, cdn: !!r?.cdn_url });
        // Rust returns shape: { success, file_id, filename, size, mime_type, content_hash, cdn_url, ... }
        const cdn = r?.cdn_url || r?.data?.cdn_url;
        // Log failures + every 25th success so we get a steady pulse without flooding
        if (!r?.success || ((this.stats.uploaded || 0) % 25 === 0)) {
          api.apiCall('drive_backup_debug', {
            msg: r?.success ? 'rust_ok' : 'rust_fail',
            data: `${uploadFilename}|${fileSize}b|${elapsed}ms|err=${r?.error || ''}|done=${this.stats.completedFiles}`,
          }, 'POST').catch(() => {});
        }
        // Network failure → throw so worker's catch() counts it toward the
        // circuit-breaker / adaptive concurrency. Falling through to legacy
        // just wastes another 30s on the same bad network.
        if (r && !r.success && (r.error === 'timeout' || /network/i.test(r.error || ''))) {
          throw new Error(`rust_net_fail|${r.error}`);
        }
        if (r?.success && cdn) {
          // Register the row in drive_files so the photo shows up in the Cloud.
          // Pass asset_id so the server can disambiguate photos that share a filename
          // (iOS reuses IMG_xxxx names a lot — without asset_id they collide on UPSERT).
          // Wave 14: capture the returned file_id and kick off on-device face
          // embedding extraction in the background. The embedding pipeline is
          // a no-op when MediaPipe / ONNX deps are missing, so this is safe
          // to call unconditionally.
          // AWAIT the register call. Previously this was fire-and-forget
          // (.then().catch()) and we returned success immediately — if the
          // POST timed out on weak cellular the R2 object had no drive_files
          // row (orphan) AND the item was marked backed-up so it was never
          // retried. That produced the 67k-orphan cleanup (#524). Only mark
          // success AFTER the row is confirmed; on failure throw so the worker
          // counts the item as failed and leaves backedUpIds untouched.
          let regRes;
          try {
            regRes = await api.apiCall('drive_register_uploaded', {
              filename: uploadFilename,
              cdn_url: cdn,
              size: r.size || fileSize,
              mime_type: r.mime_type || mimeType,
              content_hash: r.content_hash || item.hash || '',
              asset_id: item.id || item.asset?.id || '',
            }, 'POST');
          } catch (regErr) {
            throw new Error(`register_failed|${regErr?.message || 'unknown'}`);
          }
          if (!regRes?.success) {
            throw new Error(`register_failed|${regRes?.error || 'no_success'}`);
          }
          try {
            const fileId = regRes?.data?.id || regRes?.data?.file_id;
            const isPhoto = String(mimeType || '').startsWith('image/');
            if (fileId && isPhoto && Platform.OS !== 'web') {
              // Defer to next idle frame so it doesn't compete with the
              // uploader's CPU budget. Fire-and-forget — the embedding
              // pipeline retries on its own next backup pass.
              setTimeout(() => {
                try {
                  const fe = require('./faceEmbeddings');
                  fe.extractAndUploadEmbeddings?.(fileId, uploadUri).catch(() => {});
                } catch {}
              }, 250);
            }
          } catch {}

          this.stats.uploadedBytes += fileSize;
          this._updateSpeed(fileSize);
          this.stats.uploaded = (this.stats.uploaded || 0) + 1;
          try {
            const mailWs = require('./websocket').default;
            mailWs._emit('backup_progress', {
              total: this.stats.uploaded + (this._initialBackedUp || 0),
              uploaded: this.stats.uploaded,
              speed: this.stats.speed || 0,
            });
          } catch {}
          return;
        }
        // Rust returned null/failure → fall through to legacy S3 presigned path
        api.apiCall('drive_backup_debug', { msg: 'rust_upload_null', data: `${uploadFilename}|${JSON.stringify(r).slice(0,200)}` }, 'POST').catch(() => {});
      } catch (err) {
        api.apiCall('drive_backup_debug', { msg: 'rust_upload_throw', data: `${err?.message || 'unknown'}|${uploadFilename}` }, 'POST').catch(() => {});
        // Network errors will fail at legacy too — re-throw so we skip the wasted ~30s
        // legacy attempt and let the worker mark this item failed quickly.
        const msg = err?.message || '';
        if (/network|timeout|aborted|rust_net_fail/i.test(msg)) {
          throw err;
        }
      }
    }

    // BIG FILES (>30MB, mostly videos) → S3 MULTIPART UPLOAD with parallel parts
    if (Platform.OS !== 'web' && fileSize > MULTIPART_THRESHOLD) {
      const ok = await this._uploadMultipart(item, uploadUri, uploadFilename, mimeType, fileSize);
      if (ok) {
        this.stats.uploadedBytes += fileSize;
        this._updateSpeed(fileSize);
        return;
      }
      throw new Error('Multipart upload failed');
    }

    // Check for existing upload session (resumable)
    const sessionKey = item.hash || `${item.filename}:${fileSize}`;
    const existingSession = this.uploadSessions[sessionKey];

    if (existingSession && Date.now() - existingSession.createdAt < SESSION_EXPIRY_MS) {
      // Try to resume
      try {
        const resumed = await this._resumeUpload(existingSession, uploadUri, mimeType, fileSize);
        if (resumed) {
          this.stats.uploadedBytes += fileSize;
          this._updateSpeed(fileSize);
          delete this.uploadSessions[sessionKey];
          return;
        }
      } catch {
        // Resume failed, start fresh
        delete this.uploadSessions[sessionKey];
      }
    }

    // Presigned URL: celular → R2 DIRETO (zero servidor, mais rápido possível)
    // PERF: prefer the presign batched ahead-of-time by _runPresignBatcher (1 round-trip per 50 items).
    let presigned;
    if (item._presigned) {
      presigned = { success: true, data: item._presigned };
    } else {
      try {
        presigned = await api.driveInitUpload(uploadFilename, mimeType, fileSize, item.hash);
      } catch (err) {
        // Fallback: try legacy presigned upload
        presigned = await api.getPresignedUpload(uploadFilename, mimeType);
      }
    }

    // Handle server-side duplicate detection
    if (presigned?.success && presigned?.data?.duplicate) {
      // Server says file already exists — mark as complete without uploading
      this.stats.uploadedBytes += fileSize;
      this._updateSpeed(fileSize);
      this.backedUpIds[item.id] = Date.now();
      return;
    }

    if (!presigned?.success || !presigned?.data?.upload_url) {
      // Final fallback: direct multipart upload
      const result = await api.fileUpload(
        { uri: uploadUri, name: uploadFilename, mimeType },
        null
      );
      if (result?.success || result?.data?.files) {
        this.stats.uploadedBytes += fileSize;
        this._updateSpeed(fileSize);
        return;
      }
      throw new Error('Upload failed: no presigned URL and direct upload failed');
    }

    // Save session for resumability
    this.uploadSessions[sessionKey] = {
      sessionId: presigned.data.session_id || presigned.data.file_id,
      uploadUrl: presigned.data.upload_url,
      s3Key: presigned.data.s3_key,
      fileId: presigned.data.file_id,
      totalSize: fileSize,
      bytesUploaded: 0,
      createdAt: Date.now(),
    };
    await this._saveUploadSessions();

    // Upload URL may be a presigned S3 URL (starts with https://...s3) or a server proxy path (/api/...)
    const baseUrl = api.BASE_URL || 'https://chatyy.com.br';
    const fullUploadUrl = presigned.data.upload_url.startsWith('http')
      ? presigned.data.upload_url
      : baseUrl + presigned.data.upload_url;

    // Presigned S3 URLs include auth in the URL itself — sending an Authorization header
    // causes SignatureDoesNotMatch errors. Only add auth headers for proxy URLs.
    const isPresignedS3 = presigned.data.upload_url.startsWith('http') && !presigned.data.upload_url.includes('/api/');
    const uploadHeaders = isPresignedS3
      ? { 'Content-Type': mimeType }
      : { 'Content-Type': mimeType, ...(api.getAuthHeaders ? api.getAuthHeaders() : {}) };

    let uploadOk = false;

    // ── Android native fast path ────────────────────────────
    // OkHttp streams from disk straight to R2 — no FormData, no fetch
    // (which loads the whole file into RN's bridge before sending). For a
    // 100MB video this drops peak RSS by ~120MB.
    if (USE_NATIVE_ANDROID && isPresignedS3 && typeof uploadUri === 'string') {
      try {
        const r = await _nativeMod().uploadToR2(uploadUri, fullUploadUrl, item.id, mimeType);
        uploadOk = !!(r && r.uploaded && r.status >= 200 && r.status < 300);
        if (!uploadOk) {
          api.apiCall('drive_backup_debug', { msg: 'upload_http_err', data: `${r?.status || 0}|native|${item.filename}` }, 'POST').catch(() => {});
        }
      } catch (err) {
        api.apiCall('drive_backup_debug', { msg: 'upload_throw', data: `${err?.message || 'unknown'}|native|${item.filename}` }, 'POST').catch(() => {});
      }
    } else if (Platform.OS !== 'web') {
      // Helper: race against timeout so stuck workers don't hang forever
      const withTimeout = (promise, ms, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout_${label}_${ms}ms`)), ms)),
      ]);
      // For VIDEOS and big files (>15MB) use FS legacy uploadAsync (streams from disk, no memory blob).
      // For small PHOTOS use fetch (smaller, fast).
      const useStream = isVideo || (fileSize && fileSize > 15 * 1024 * 1024);
      // [P1 resume 2026-05-26] S3 presigned PUT is all-or-nothing — there's no
      // true byte-offset resume for the 2-30MB single-PUT path (only the >30MB
      // multipart path resumes). On a weak network a single 60s timeout meant
      // a 12MB photo at ~2 Mbps (≈48s, but with packet loss often 90s+) NEVER
      // completed: every attempt timed out, the outer worker restarted from
      // byte 0 with the SAME short timeout, and the item ping-ponged forever.
      // Two-part mitigation here:
      //   1. Scale the timeout to the file size (~1 minute per 2MB, floor 60s,
      //      cap 8min) so a slow-but-progressing upload is given enough wall
      //      time to actually finish instead of being killed mid-stream.
      //   2. A bounded retry-FROM-START loop (3 tries) with backoff, so a
      //      transient drop is retried in-place instead of bubbling all the way
      //      out to the worker and competing with fresh items.
      const sizeScaledTimeout = (() => {
        if (isVideo) return VIDEO_TIMEOUT_MS;
        const perMb = 30 * 1000; // 30s per MB of headroom on weak links
        const mb = (fileSize || 0) / (1024 * 1024);
        const scaled = Math.round(mb * perMb);
        return Math.min(8 * 60 * 1000, Math.max(UPLOAD_TIMEOUT_MS, scaled));
      })();
      const streamTimeout = sizeScaledTimeout;
      const MEDIUM_PUT_MAX_TRIES = isVideo ? 1 : 3;
      try {
        if (useStream) {
          const FSLegacy = require('expo-file-system/legacy');
          if (!FSLegacy?.FileSystemUploadType?.BINARY_CONTENT) {
            throw new Error('FSLegacy_unavailable');
          }
          // BACKGROUND session — Android: WorkManager-backed task that survives
          // app being backgrounded/killed (vs FOREGROUND which dies the moment
          // the JS thread suspends). iOS: URLSession.background. Was previously
          // FOREGROUND which is why "o sistema de foto quando eu minimizo o app
          // ele para" — JS upload got cut every time user minimized.
          let lastErr = null;
          for (let putTry = 1; putTry <= MEDIUM_PUT_MAX_TRIES && !uploadOk; putTry++) {
            try {
              const result = await withTimeout(
                FSLegacy.uploadAsync(fullUploadUrl, uploadUri, {
                  httpMethod: 'PUT',
                  uploadType: FSLegacy.FileSystemUploadType.BINARY_CONTENT,
                  headers: uploadHeaders,
                  sessionType: FSLegacy.FileSystemSessionType.BACKGROUND,
                }),
                streamTimeout,
                'fs_stream'
              );
              uploadOk = result.status >= 200 && result.status < 300;
              if (!uploadOk) {
                api.apiCall('drive_backup_debug', { msg: 'upload_http_err', data: `${result.status}|try${putTry}|${item.filename}` }, 'POST').catch(() => {});
                // Non-2xx (e.g. expired presign, 4xx) won't fix on retry-from-
                // start with the same URL — stop early.
                break;
              }
            } catch (putErr) {
              lastErr = putErr;
              api.apiCall('drive_backup_debug', { msg: 'medium_put_retry', data: `try${putTry}/${MEDIUM_PUT_MAX_TRIES}|${putErr?.message || 'unknown'}|${item.filename}` }, 'POST').catch(() => {});
              if (putTry < MEDIUM_PUT_MAX_TRIES) {
                await new Promise(r => setTimeout(r, 1500 * putTry));
              }
            }
          }
          if (!uploadOk && lastErr) throw lastErr;
        } else {
          const blobResp = await withTimeout(fetch(uploadUri), 30000, 'fetch_blob');
          const blob = await withTimeout(blobResp.blob(), 30000, 'blob_read');
          const s3Resp = await withTimeout(
            fetch(fullUploadUrl, { method: 'PUT', body: blob, headers: uploadHeaders }),
            UPLOAD_TIMEOUT_MS,
            'fetch_put'
          );
          uploadOk = s3Resp.ok;
          if (!uploadOk) {
            api.apiCall('drive_backup_debug', { msg: 'upload_http_err', data: `${s3Resp.status}|${item.filename}` }, 'POST').catch(() => {});
          }
        }
      } catch (err) {
        api.apiCall('drive_backup_debug', { msg: 'upload_throw', data: `${err?.message || 'unknown'}|${item.filename}` }, 'POST').catch(() => {});
      }
    } else {
      const blob = await (await fetch(uploadUri)).blob();
      const s3Resp = await fetch(fullUploadUrl, {
        method: 'PUT',
        body: blob,
        headers: uploadHeaders,
      });
      uploadOk = s3Resp.ok;
    }

    if (!uploadOk) {
      throw new Error('S3 upload failed');
    }

    // Confirm upload on server — AWAIT it. Previously fire-and-forget, which
    // left the R2 object orphaned (no drive_files row) when the POST failed on
    // weak cellular, while the worker still marked the item completed + set
    // backedUpIds so it was never retried (#524). Throw on failure so the
    // worker re-queues it and we do NOT mark it backed-up or drop the resume
    // session below.
    let completeRes;
    try {
      completeRes = await api.apiCall('drive_complete_upload', {
        file_id: presigned.data.file_id || 0,
        s3_key: presigned.data.s3_key || '',
        content_hash: item.hash || '',
      }, 'POST');
    } catch (compErr) {
      throw new Error(`complete_failed|${compErr?.message || 'unknown'}`);
    }
    if (!completeRes?.success) {
      throw new Error(`complete_failed|${completeRes?.error || 'no_success'}`);
    }

    // Track bytes
    this.stats.uploadedBytes += fileSize;
    this._updateSpeed(fileSize);
    this.stats.uploaded = (this.stats.uploaded || 0) + 1;

    // Emit real-time count update via WS (instant UI update like WhatsApp)
    try {
      const mailWs = require('./websocket').default;
      mailWs._emit('backup_progress', {
        total: this.stats.uploaded + (this._initialBackedUp || 0),
        uploaded: this.stats.uploaded,
        speed: this.stats.speed || 0,
      });
    } catch {}

    // Remove completed session and persist cleanup
    delete this.uploadSessions[sessionKey];
    this._saveUploadSessions().catch(() => {});
  }

  // ─── Multipart Upload (parallel parts) ──────────────────
  // Used for files >MULTIPART_THRESHOLD. Splits file into 5MB chunks,
  // uploads MULTIPART_PART_CONCURRENCY chunks in parallel directly to R2.
  // Supports resume: if a previous attempt persisted state (uploadId + part
  // ETags) for this content hash, we skip the parts we've already shipped to
  // S3 instead of restarting from zero. Without this, iOS killing a
  // background task at 14s meant 100GB backups over 4G could never finish.
  async _uploadMultipart(item, uri, filename, mimeType, fileSize) {
    const FSLegacy = require('expo-file-system/legacy');
    const numParts = Math.ceil(fileSize / MULTIPART_CHUNK_SIZE);

    // Content hash is a reasonable identity key. We stored hash on the item
    // earlier during queue build; fall back to filename+size to avoid losing
    // resumability on older queued items.
    const resumeKey = `mpu:${item?.contentHash || `${filename}:${fileSize}`}`;
    let AS = null;
    try { AS = require('@react-native-async-storage/async-storage').default; } catch {}
    const loadResume = async () => {
      if (!AS) return null;
      try {
        const raw = await AS.getItem(resumeKey);
        if (!raw) return null;
        const r = JSON.parse(raw);
        // Stale after 72h — S3 abandons incomplete MPUs after 7 days on most
        // providers but we give up sooner so we don't hold onto dead state.
        if (!r || !r.upload_id || Date.now() - (r.ts || 0) > 72 * 3600 * 1000) return null;
        return r;
      } catch { return null; }
    };
    const saveResume = async (state) => {
      if (!AS) return;
      try { await AS.setItem(resumeKey, JSON.stringify({ ...state, ts: Date.now() })); } catch {}
    };
    const clearResume = async () => {
      if (!AS) return;
      try { await AS.removeItem(resumeKey); } catch {}
    };

    // 1. Initiate at server — or resume. If we have valid saved state we
    //    skip drive_multipart_init and ask for just the presigned URLs of
    //    the missing parts.
    let upload_id, object_key, file_id, partUrls, completedParts = [];
    const saved = await loadResume();
    if (saved && Array.isArray(saved.completedParts) && saved.completedParts.length > 0) {
      upload_id = saved.upload_id;
      object_key = saved.object_key;
      file_id = saved.file_id;
      completedParts = saved.completedParts;
      const missingPartNumbers = [];
      const doneSet = new Set(completedParts.map(p => p.part_number));
      for (let i = 1; i <= numParts; i++) if (!doneSet.has(i)) missingPartNumbers.push(i);
      try {
        const resume = await api.apiCall('drive_multipart_resume_urls', {
          upload_id, object_key, file_id, part_numbers: missingPartNumbers,
        }, 'POST');
        if (resume?.success && Array.isArray(resume.data?.parts)) {
          partUrls = resume.data.parts;
        } else {
          await clearResume();
        }
      } catch {
        await clearResume();
      }
    }

    if (!partUrls) {
      let init;
      try {
        init = await api.apiCall('drive_multipart_init', {
          filename, mime_type: mimeType, total_size: fileSize,
        }, 'POST');
      } catch (err) {
        api.apiCall('drive_backup_debug', { msg: 'multipart_init_throw', data: `${err?.message}|${filename}` }, 'POST').catch(() => {});
        return false;
      }
      if (!init?.success || !init?.data?.upload_id) {
        api.apiCall('drive_backup_debug', { msg: 'multipart_init_fail', data: `${init?.message || 'unknown'}|${filename}` }, 'POST').catch(() => {});
        return false;
      }
      ({ upload_id, object_key, file_id, parts: partUrls } = init.data);
      completedParts = [];
    }

    // 2. Stream chunks from disk (NEVER load whole file into memory).
    // expo-file-system legacy supports position+length+base64 reads — perfect for 1GB+ videos.
    // Each chunk is read on demand, max 5MB in JS heap at any time × 4 parallel = 20MB peak.

    // base64 → Uint8Array helper (no full-file allocation)
    const b64ToBytes = (b64) => {
      const bin = global.atob ? global.atob(b64) : Buffer.from(b64, 'base64').toString('binary');
      const len = bin.length;
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) out[i] = bin.charCodeAt(i);
      return out;
    };

    // 3. Upload parts in parallel (MULTIPART_PART_CONCURRENCY at a time).
    //    completedParts is already seeded from saved state when resuming.
    const queue = [...partUrls];
    let aborted = false;

    const uploadOnePart = async (p) => {
      if (aborted) return;
      const start = (p.part_number - 1) * MULTIPART_CHUNK_SIZE;
      const end = Math.min(start + MULTIPART_CHUNK_SIZE, fileSize);
      const chunkLen = end - start;

      // Read THIS chunk from disk on demand (5MB only — never the full file)
      let chunk;
      try {
        const b64 = await FSLegacy.readAsStringAsync(uri, {
          encoding: FSLegacy.EncodingType.Base64,
          position: start,
          length: chunkLen,
        });
        chunk = b64ToBytes(b64);
      } catch (err) {
        api.apiCall('drive_backup_debug', { msg: 'multipart_chunk_read', data: `${err?.message}|p${p.part_number}|${filename}` }, 'POST').catch(() => {});
        aborted = true;
        return;
      }

      // Upload with retry (3 attempts per part)
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (aborted) return;
        try {
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 120000); // 2min per chunk
          const resp = await fetch(p.upload_url, {
            method: 'PUT',
            body: chunk,
            signal: ctrl.signal,
          });
          clearTimeout(timer);
          if (resp.ok) {
            const etag = resp.headers.get('etag') || resp.headers.get('ETag') || '';
            if (!etag) {
              if (attempt === 3) { aborted = true; return; }
              continue;
            }
            completedParts.push({ part_number: p.part_number, etag });
            // Persist progress so an app kill / network drop doesn't lose it.
            saveResume({ upload_id, object_key, file_id, completedParts }).catch(() => {});
            // bytes progress
            this.stats.uploadedBytes += chunk.length;
            this._updateSpeed(chunk.length);
            return;
          }
          if (attempt === 3) {
            api.apiCall('drive_backup_debug', { msg: 'multipart_part_http', data: `${resp.status}|p${p.part_number}|${filename}` }, 'POST').catch(() => {});
            aborted = true;
            return;
          }
        } catch (err) {
          if (attempt === 3) {
            api.apiCall('drive_backup_debug', { msg: 'multipart_part_throw', data: `${err?.message}|p${p.part_number}|${filename}` }, 'POST').catch(() => {});
            aborted = true;
            return;
          }
          // backoff between attempts
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
    };

    // Worker pool of MULTIPART_PART_CONCURRENCY
    const partWorkers = [];
    for (let w = 0; w < MULTIPART_PART_CONCURRENCY; w++) {
      partWorkers.push((async () => {
        while (queue.length > 0 && !aborted) {
          const p = queue.shift();
          if (p) await uploadOnePart(p);
        }
      })());
    }
    await Promise.all(partWorkers);

    if (aborted || completedParts.length !== numParts) {
      // Incomplete but resumable — keep the resume state so the next run can
      // pick up where we left off instead of restarting from part 1.
      api.apiCall('drive_backup_debug', { msg: 'multipart_incomplete', data: `${completedParts.length}/${numParts}|${filename}` }, 'POST').catch(() => {});
      await saveResume({ upload_id, object_key, file_id, completedParts });
      return false;
    }

    // 4. Complete: send ETags to server, server posts CompleteMultipartUpload to R2
    try {
      const complete = await api.apiCall('drive_multipart_complete', {
        file_id, object_key, upload_id, parts: completedParts,
      }, 'POST');
      if (!complete?.success) {
        api.apiCall('drive_backup_debug', { msg: 'multipart_complete_fail', data: `${complete?.message}|${filename}` }, 'POST').catch(() => {});
        return false;
      }
    } catch (err) {
      api.apiCall('drive_backup_debug', { msg: 'multipart_complete_throw', data: `${err?.message}|${filename}` }, 'POST').catch(() => {});
      return false;
    }

    // Upload finished — clear resume state so future identical hashes don't
    // try to reuse an abandoned upload id.
    await clearResume();
    return true;
  }

  // ─── Resume Upload ──────────────────────────────────────
  async _resumeUpload(session, uri, mimeType, fileSize) {
    // Ask server how many bytes were received
    try {
      const result = await api.driveResumeUpload(session.sessionId || session.fileId);
      if (!result?.success) return false;

      const bytesReceived = result.data?.bytes_uploaded || 0;

      if (bytesReceived >= fileSize) {
        // Already fully uploaded — just confirm
        if (session.fileId) {
          await api.driveCompleteUpload(session.fileId);
        }
        return true;
      }

      // Need to re-upload (S3 doesn't support partial PUT well with presigned URLs)
      // In practice, we get a new presigned URL and re-upload the whole file.
      // The session tracking is mainly to avoid creating duplicate DB entries.
      if (result.data?.upload_url) {
        let uploadOk = false;
        if (Platform.OS !== 'web') {
          try {
            let FS; try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }
            const uploadResult = await FS.uploadAsync(result.data.upload_url, uri, {
              httpMethod: 'PUT',
              uploadType: FS.FileSystemUploadType.BINARY_CONTENT,
              headers: { 'Content-Type': mimeType },
              sessionType: FS.FileSystemSessionType.BACKGROUND,
            });
            uploadOk = uploadResult.status >= 200 && uploadResult.status < 300;
          } catch {
            const blob = await (await fetch(uri)).blob();
            const resp = await fetch(result.data.upload_url, {
              method: 'PUT', body: blob, headers: { 'Content-Type': mimeType },
            });
            uploadOk = resp.ok;
          }
        } else {
          const blob = await (await fetch(uri)).blob();
          const resp = await fetch(result.data.upload_url, {
            method: 'PUT', body: blob, headers: { 'Content-Type': mimeType },
          });
          uploadOk = resp.ok;
        }

        if (uploadOk && session.fileId) {
          await api.driveCompleteUpload(session.fileId);
        }
        return uploadOk;
      }

      return false;
    } catch {
      return false;
    }
  }

  // ─── Speed Tracking ─────────────────────────────────────
  _updateSpeed(bytes) {
    const now = Date.now();
    this._speedSamples.push({ bytes, time: now });

    // Keep only last 30 seconds of samples
    const cutoff = now - 30000;
    this._speedSamples = this._speedSamples.filter(s => s.time > cutoff);

    // Calculate rolling speed
    if (this._speedSamples.length > 1) {
      const windowBytes = this._speedSamples.reduce((sum, s) => sum + s.bytes, 0);
      const windowMs = now - this._speedSamples[0].time;
      if (windowMs > 0) {
        this.stats.speed = (windowBytes / windowMs) * 1000;
      }
    }
  }

  // ─── Progress ───────────────────────────────────────────
  getProgress() {
    const { totalFiles, completedFiles, failedFiles, skippedFiles,
            totalBytes, uploadedBytes, startTime, speed } = this.stats;

    const remaining = totalFiles - completedFiles - failedFiles;
    const elapsed = (Date.now() - startTime) / 1000;

    // ETA based on current speed
    let eta = 0;
    if (speed > 0) {
      const remainingBytes = totalBytes - uploadedBytes;
      eta = remainingBytes / speed;
    }

    return {
      totalFiles,
      completedFiles,
      failedFiles,
      skippedFiles,
      remaining,
      totalBytes,
      uploadedBytes,
      speed,
      speedFormatted: formatSpeed(speed),
      eta,
      etaFormatted: formatETA(eta),
      elapsed,
      percentage: totalFiles > 0 ? Math.round((completedFiles / totalFiles) * 100) : 0,
      bytesFormatted: formatBytes(uploadedBytes),
      totalBytesFormatted: formatBytes(totalBytes),
      isRunning: this.isRunning,
      isPaused: this.isPaused,
      queueLength: this.queue.filter(q => q.status === 'pending').length,
      activeCount: this.active.size,
    };
  }

  // ─── Controls ───────────────────────────────────────────
  pause() {
    this.isPaused = true;
    this._saveProgress().catch(() => {});
  }

  resume() {
    this.isPaused = false;
  }

  abort() {
    this._aborted = true;
    this.isPaused = false;
    this.isRunning = false;
    this._saveProgress().catch(() => {});
  }

  // ─── Persistence ────────────────────────────────────────
  async _saveProgress() {
    try {
      await saveBackedUpMap(this.backedUpIds);
    } catch {}
  }

  async _saveUploadSessions() {
    try {
      await saveUploadSessions(this.uploadSessions);
    } catch {}
  }

  // ─── Full Backup Flow ──────────────────────────────────
  // This is the main entry point. Call this from the UI.
  async runFullBackup({ includeVideos = true, quality = 'economy', userEmail = '', onProgress, onComplete, onError }) {
    // GUARD: only one runFullBackup can be active at a time. Without this,
    // the UI can fire it multiple times (mount effects, tap-taps, auto-backup
    // overlapping) — each new run rebuilds `this.queue` mid-flight, stomping
    // on the workers started by the previous run.
    if (this.isRunning || this._runFullBackupActive) {
      api.apiCall('drive_backup_debug', { msg: 'runFullBackup_skip_already_running', data: '' }, 'POST').catch(() => {});
      return { status: 'already_running', totalBackedUp: Object.keys(this.backedUpIds).length };
    }
    this._runFullBackupActive = true;
    try {

    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;
    this._userEmail = userEmail || this._userEmail || '';
    this._aborted = false;

    await this.init();

    // Supervisor loop: scan → upload → re-scan, until nothing new is found.
    // Without this, iOS suspending the JS runtime mid-upload leaves photos
    // stranded and the user has to manually re-tap the backup button.
    let totalUploaded = 0;
    let passNumber = 0;
    while (!this._aborted) {
      passNumber++;
      api.apiCall('drive_backup_debug', {
        msg: 'supervisor_pass',
        data: `pass=${passNumber} totalUploaded=${totalUploaded} backedUpIds=${Object.keys(this.backedUpIds).length}`,
      }, 'POST').catch(() => {});

    // Pre-load backed up filenames from server (ALWAYS — for reconciliation in scan loop)
    // Store as STEMS (filename without extension) so PNG/HEIC/WEBP→jpg compression matches.
    try {
      const serverPhotos = await api.filePhotos('all', 1, 50000);
      const stemOf = (n) => (n || '').toLowerCase().replace(/\.[^.]+$/, '');
      const serverStems = new Set((serverPhotos?.data?.files || []).map(f => stemOf(f.name)));
      this._serverBackedUpStems = serverStems;
      // Backwards compat: also keep names if anything else uses it
      this._serverBackedUpNames = serverStems;
      api.apiCall('drive_backup_debug', { msg: 'preloaded_server_names', data: String(serverStems.size) }, 'POST').catch(() => {});
    } catch {
      this._serverBackedUpStems = new Set();
      this._serverBackedUpNames = new Set();
    }

    // 1. Get new photos in batches (paginated to avoid OOM)
    let allToUpload = [];
    let totalSkipped = 0;
    let hasAnyAssets = false;

    if (onProgress) {
      onProgress({
        ...this.getProgress(),
        phase: 'scanning',
        phaseMessage: 'Scanning photos...',
      });
    }

    for await (const batch of this.getNewPhotosIterator(includeVideos)) {
      hasAnyAssets = true;

      // 2. Deduplicate each batch against server
      if (onProgress) {
        onProgress({
          ...this.getProgress(),
          phase: 'dedup',
          phaseMessage: 'Checking for duplicates...',
        });
      }

      const { toUpload, skipped } = await this.deduplicateAssets(batch);
      totalSkipped += skipped.length;
      allToUpload = allToUpload.concat(toUpload);
    }

    api.apiCall('drive_backup_debug', { msg: 'scan_done', data: JSON.stringify({ pass: passNumber, hasAnyAssets, toUpload: allToUpload.length, skipped: totalSkipped }) }, 'POST').catch(() => {});

    // Nothing at all — finish
    if (!hasAnyAssets || allToUpload.length === 0) {
      if (totalUploaded === 0) {
        // First pass found nothing — we're truly done
        break;
      }
      // Later pass: previous passes uploaded stuff, now scan is empty → done
      break;
    }

    this.stats.skippedFiles = totalSkipped;

    // 3. Build queue (sorted by size, smaller first)
    //    SAFE because the guard prevents overlapping runs.
    this.buildQueue(allToUpload, quality);

    // 4. Start processing
    if (onProgress) {
      onProgress({
        ...this.getProgress(),
        phase: 'uploading',
        phaseMessage: 'Uploading...',
      });
    }

    await this.start(quality);

    // 5. Clean up completed upload sessions
    await this.cleanupSessions();

    totalUploaded += this.stats.completedFiles || 0;

    // If the previous pass processed < 10 new items, treat it as "done enough"
    // so we don't burn cycles scanning forever.
    if ((this.stats.completedFiles || 0) < 10) {
      break;
    }

    // Reset per-pass counters so next scan reports accurate stats for the UI.
    // Keep backedUpIds — those are the photos we already uploaded.
    this.stats.completedFiles = 0;
    this.stats.failedFiles = 0;
    this.stats.skippedFiles = 0;
    this.queue = [];
    this.active.clear();
    this.failed = [];
    this.completed = [];
    this._scanPageCount = 0;

    // Small delay so network can settle + iOS doesn't think we're looping tight
    await new Promise(r => setTimeout(r, 1500));
    } // end supervisor while

    api.apiCall('drive_backup_debug', { msg: 'supervisor_done', data: `passes=${passNumber} totalUploaded=${totalUploaded}` }, 'POST').catch(() => {});

    // 6. Return results
    return {
      status: this.failed.length > 0 ? 'partial' : 'complete',
      uploaded: totalUploaded,
      failed: this.stats.failedFiles,
      skipped: this.stats.skippedFiles,
      totalBackedUp: Object.keys(this.backedUpIds).length,
    };
    } finally {
      // ALWAYS release the guard, even on early return or throw
      this._runFullBackupActive = false;
    }
  }

  // ─── Get backed up count (for UI) ──────────────────────
  getBackedUpCount() {
    return Object.keys(this.backedUpIds).length;
  }

  // ─── Reset all backup state ─────────────────────────────
  async reset() {
    this.backedUpIds = {};
    this.uploadSessions = {};
    this.queue = [];
    this.active.clear();
    this.failed = [];
    this.completed = [];
    // Use unified storage reset
    const { resetAllBackupState } = require('./backup/backupStorage');
    await resetAllBackupState();
  }
}

// ─── Singleton instance ──────────────────────────────────
let _engineInstance = null;

export function getBackupEngine() {
  if (!_engineInstance) {
    _engineInstance = new BackupEngine();
  }
  return _engineInstance;
}

export { formatSpeed, formatETA, formatBytes, computeContentHash };
export default BackupEngine;
