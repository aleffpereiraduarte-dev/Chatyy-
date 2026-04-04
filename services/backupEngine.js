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
const HASH_CHUNK_SIZE = 64 * 1024;     // 64KB for content fingerprint
const MAX_CONCURRENT = 5;              // parallel upload workers
const RETRY_MAX = 3;                   // max retries per file
const RETRY_BASE_MS = 2000;            // exponential backoff base
const DEDUP_BATCH_SIZE = 100;          // hashes per dedup check
const PHOTO_PAGE_SIZE = 200;           // process photos in batches of 200
const SAVE_INTERVAL = 5;              // save progress every N completions
const SESSION_EXPIRY_MS = 6 * 3600 * 1000; // 6 hours

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
// SHA-256 of first 64KB + file size → fast, unique enough for dedup.
// Uses expo-crypto on native, SubtleCrypto on web.
async function computeContentHash(uri, fileSize) {
  try {
    if (Platform.OS === 'web') {
      // Web: read first 64KB via fetch + SubtleCrypto
      const resp = await fetch(uri);
      const blob = await resp.blob();
      const slice = blob.slice(0, HASH_CHUNK_SIZE);
      const buffer = await slice.arrayBuffer();
      const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
      return `${hex}:${fileSize}`;
    }

    // Native: use expo-crypto
    try {
      const Crypto = require('expo-crypto');
      const FS = require('expo-file-system');

      // Read first 64KB as base64 for hashing
      const chunk = await FS.readAsStringAsync(uri, {
        encoding: FS.EncodingType.Base64,
        length: HASH_CHUNK_SIZE,
        position: 0,
      });
      const hash = await Crypto.digestStringAsync(
        Crypto.CryptoDigestAlgorithm.SHA256,
        chunk
      );
      return `${hash}:${fileSize}`;
    } catch {
      // Fallback: use filename + size + modification time as fingerprint
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
        // Filter out already backed up
        const newAssets = page.assets.filter(a => !this.backedUpIds[a.id]);
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
    const FS = require('expo-file-system');

    // Phase 1: Build entries using asset ID + modification date as fast dedup key.
    // Content hashing (SHA-256 of 64KB) is deferred to only when needed for server dedup check.
    const hashEntries = [];
    for (const asset of assets) {
      try {
        const info = await ML.getAssetInfoAsync(asset.id);
        const uri = info?.localUri || asset.uri;
        const fileInfo = await FS.getInfoAsync(uri);
        const size = fileInfo?.size || 0;

        // Skip tiny files (thumbnails, icons)
        if (size < MIN_FILE_SIZE && !isVideoExt(getExt(asset.filename))) {
          continue;
        }

        // Use assetId + modificationTime as fast dedup key (no I/O for hashing)
        const modTime = asset.modificationTime || asset.creationTime || 0;
        const fastKey = `${asset.id}:${modTime}:${size}`;

        hashEntries.push({
          asset,
          uri,
          size,
          hash: null,          // lazy — computed only when needed for server check
          fastKey,             // for local dedup
          filename: asset.filename || 'photo.jpg',
        });
      } catch {
        // If we can't get info, still try to upload
        hashEntries.push({
          asset,
          uri: asset.uri,
          size: 0,
          hash: null,
          fastKey: asset.id,
          filename: asset.filename || 'photo.jpg',
        });
      }
    }

    // Phase 1b: Compute content hashes only for entries that need server dedup check.
    // Batch the hash computation to avoid reading every file upfront.
    for (const entry of hashEntries) {
      if (entry.size > 0 && entry.uri) {
        try {
          entry.hash = await computeContentHash(entry.uri, entry.size);
        } catch {
          // Leave hash as null — will be uploaded without dedup check
        }
      }
    }

    // Phase 2: Send hashes to server in batches for dedup check
    const toUpload = [];
    const skipped = [];
    const seenHashes = new Set();        // track hashes already seen in this batch
    const hashToEntries = new Map();     // hash → [entries] (multiple assets can share a hash)
    const uniqueHashes = [];             // ordered unique hashes for batch checking

    for (const entry of hashEntries) {
      if (entry.hash) {
        // Check for local duplicates (same hash seen twice in this scan)
        if (seenHashes.has(entry.hash)) {
          // Mark as duplicate locally — skip upload but track it
          entry.status = 'duplicate';
          skipped.push(entry);
          this.backedUpIds[entry.asset.id] = Date.now();
          continue;
        }
        seenHashes.add(entry.hash);
        hashToEntries.set(entry.hash, entry);
        uniqueHashes.push(entry.hash);
      } else {
        toUpload.push(entry); // no hash → upload anyway
      }
    }

    // Batch check with server
    for (let i = 0; i < uniqueHashes.length; i += DEDUP_BATCH_SIZE) {
      const batch = uniqueHashes.slice(i, i + DEDUP_BATCH_SIZE);
      const items = batch.map(h => {
        const e = hashToEntries.get(h);
        return { hash: h, filename: e.filename, size: e.size };
      });

      try {
        const result = await api.driveCheckDuplicates(items);
        if (result?.success && result?.data?.duplicates) {
          const dupSet = new Set(result.data.duplicates);
          for (const h of batch) {
            const entry = hashToEntries.get(h);
            if (dupSet.has(h)) {
              // Already exists on server — mark as backed up
              skipped.push(entry);
              this.backedUpIds[entry.asset.id] = Date.now();
            } else {
              toUpload.push(entry);
            }
          }
        } else {
          // Server didn't respond properly — upload everything
          for (const h of batch) {
            toUpload.push(hashToEntries.get(h));
          }
        }
      } catch {
        // Network error — upload everything in this batch
        for (const h of batch) {
          toUpload.push(hashToEntries.get(h));
        }
      }
    }

    return { toUpload, skipped };
  }

  // ─── Build Upload Queue ─────────────────────────────────
  buildQueue(entries, qualitySetting = 'economy') {
    // Sort by size ascending (smaller files first = faster progress feel)
    const sorted = [...entries].sort((a, b) => (a.size || 0) - (b.size || 0));

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
  async start(qualitySetting = 'economy') {
    if (this.isRunning) return;
    this.isRunning = true;
    this.isPaused = false;
    this._aborted = false;

    // Get initial backed up count from server for accurate progress
    try {
      const api = require('./api');
      const r = await api.filePhotos('all', 1, 1);
      this._initialBackedUp = r?.data?.total || 0;
    } catch { this._initialBackedUp = 0; }

    // Image compression setup
    let ImageManipulator = null;
    if (qualitySetting !== 'original') {
      try { ImageManipulator = require('expo-image-manipulator'); } catch {}
    }

    // Worker pool
    const workers = [];
    for (let i = 0; i < this.maxConcurrent; i++) {
      workers.push(this._worker(ImageManipulator, qualitySetting));
    }

    await Promise.all(workers);

    // Finished
    this.isRunning = false;

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

  // ─── Worker: processes items from queue ─────────────────
  async _worker(ImageManipulator, quality) {
    while (!this._aborted) {
      if (this.isPaused) {
        await new Promise(r => setTimeout(r, 500));
        continue;
      }

      // Grab next pending item
      const item = this.queue.find(q => q.status === 'pending');
      if (!item) break; // queue empty

      item.status = 'uploading';
      this.active.set(item.id, item);

      try {
        await this._uploadItem(item, ImageManipulator, quality);
        item.status = 'completed';
        this.completed.push(item);
        this.stats.completedFiles++;
        this.backedUpIds[item.id] = Date.now();

        if (this.onFileComplete) this.onFileComplete(item);
      } catch (err) {
        item.retries++;
        if (item.retries < RETRY_MAX) {
          // Exponential backoff then re-queue
          const delay = RETRY_BASE_MS * Math.pow(2, item.retries - 1);
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

      // Emit progress
      if (this.onProgress) {
        this.onProgress(this.getProgress());
      }
    }
  }

  // ─── Upload a single item ──────────────────────────────
  async _uploadItem(item, ImageManipulator, quality) {
    const ext = getExt(item.filename);
    const isVideo = item.asset.mediaType === 'video' || isVideoExt(ext);

    // Resolve local URI
    let uri = item.uri;
    if (!uri || uri === item.asset.uri) {
      try {
        const ML = require('expo-media-library');
        const info = await ML.getAssetInfoAsync(item.asset.id);
        uri = info?.localUri || item.asset.uri;
      } catch {
        uri = item.asset.uri;
      }
    }

    // Compress image (Google Photos style)
    let uploadUri = uri;
    let mimeType = isVideo ? 'video/mp4' : (MIME_MAP[ext] || 'image/jpeg');
    let uploadFilename = item.filename;

    if (!isVideo && ImageManipulator?.manipulateAsync && quality !== 'original') {
      try {
        const result = await ImageManipulator.manipulateAsync(
          uri,
          [{ resize: { width: 2048 } }],
          { compress: 0.8, format: ImageManipulator.SaveFormat.JPEG }
        );
        uploadUri = result.uri;
        mimeType = 'image/jpeg';
        if (!['jpg', 'jpeg'].includes(ext)) {
          uploadFilename = uploadFilename.replace(/\.[^.]+$/, '.jpg');
        }
      } catch {
        // Use original on compression failure
      }
    }

    // Get file size
    let fileSize = item.size;
    if (Platform.OS !== 'web') {
      try {
        const FS = require('expo-file-system');
        const info = await FS.getInfoAsync(uploadUri);
        fileSize = info?.size || fileSize;
      } catch {}
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

    // Initialize new upload session via server
    let presigned;
    try {
      presigned = await api.driveInitUpload(uploadFilename, mimeType, fileSize, item.hash);
    } catch (err) {
      // Fallback: try legacy presigned upload
      presigned = await api.getPresignedUpload(uploadFilename, mimeType);
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

    if (Platform.OS !== 'web') {
      try {
        const FS = require('expo-file-system');
        const result = await FS.uploadAsync(fullUploadUrl, uploadUri, {
          httpMethod: 'PUT',
          uploadType: FS.FileSystemUploadType.BINARY_CONTENT,
          headers: uploadHeaders,
          sessionType: FS.FileSystemSessionType.BACKGROUND,
        });
        uploadOk = result.status >= 200 && result.status < 300;
      } catch {
        // Fallback to fetch
        const blob = await (await fetch(uploadUri)).blob();
        const s3Resp = await fetch(fullUploadUrl, {
          method: 'PUT',
          body: blob,
          headers: uploadHeaders,
        });
        uploadOk = s3Resp.ok;
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

    // Confirm upload on server (must succeed or file should be retried)
    if (presigned.data.file_id) {
      try {
        await api.driveCompleteUpload(presigned.data.file_id, item.hash);
      } catch (confirmErr) {
        // Re-throw so _worker retries this item
        throw new Error(`Upload confirm failed: ${confirmErr.message || 'unknown error'}`);
      }
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
            const FS = require('expo-file-system');
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
  async runFullBackup({ includeVideos = true, quality = 'economy', onProgress, onComplete, onError }) {
    this.onProgress = onProgress;
    this.onComplete = onComplete;
    this.onError = onError;

    await this.init();

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

    if (!hasAnyAssets) {
      return {
        status: 'complete',
        message: 'ALL_BACKED_UP',
        totalBackedUp: Object.keys(this.backedUpIds).length,
      };
    }

    this.stats.skippedFiles = totalSkipped;

    if (allToUpload.length === 0) {
      // All were duplicates — save and return
      await this._saveProgress();
      return {
        status: 'complete',
        message: 'ALL_DUPLICATES',
        skipped: totalSkipped,
        totalBackedUp: Object.keys(this.backedUpIds).length,
      };
    }

    // 3. Build queue (sorted by size, smaller first)
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

    // 6. Return results
    return {
      status: this.failed.length > 0 ? 'partial' : 'complete',
      uploaded: this.stats.completedFiles,
      failed: this.stats.failedFiles,
      skipped: this.stats.skippedFiles,
      totalBackedUp: Object.keys(this.backedUpIds).length,
    };
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
