/**
 * bgTransfer — [2026-10-09 media-native] background chat media transfers.
 *
 * Thin JS side of the native `ChatyyTransfer` module
 * (modules/expo-background-upload: iOS background URLSession —
 * ChatTransferManager.swift; Android WorkManager + dataSync foreground
 * notification — ChatTransferWorker.kt). Large uploads/downloads keep going
 * while the app is suspended or swiped away and are picked up again by id:
 *
 *   • upload   id = 'up-<rust upload_id>'  (services/api.js
 *              rustChunkedUploadNative hands the Rust chunked session over after
 *              init/status; the native side sends the missing chunks +
 *              /upload/complete and keeps the JSON result);
 *   • download id = 'dl-<cache key>'      (services/mediaCache.js big media).
 *
 * Everything here is optional: on binaries without the module (or on web)
 * `isBgTransferAvailable()` is false and callers keep their JS path.
 * Loaded with requireOptionalNativeModule (never requireNativeModule —
 * android_logout_crash_native_module_fatal_2026_10_06).
 */
import { Platform, AppState } from 'react-native';

let _mod; // undefined = not probed, null = unavailable
function _native() {
  if (_mod !== undefined) return _mod;
  _mod = null;
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__chatyy_bg_transfer === false) return null;
  } catch {}
  try {
    const expo = require('expo');
    const m = typeof expo.requireOptionalNativeModule === 'function'
      ? expo.requireOptionalNativeModule('ChatyyTransfer')
      : null;
    if (m && typeof m.enqueueUpload === 'function' && typeof m.getTransfer === 'function' && typeof m.addListener === 'function') {
      _mod = m;
    }
  } catch { _mod = null; }
  return _mod;
}

/** Kill switch (OTA / console): globalThis.__chatyy_bg_transfer = false. */
export function isBgTransferAvailable() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__chatyy_bg_transfer === false) return false;
  } catch {}
  return !!_native();
}

// ─── Waiters / events ────────────────────────────────────────────────────────
const _waiters = new Map(); // id -> Set<{ onDone, onProgress, touch }>
let _subs = null;
let _appSub = null;

function _dispatchDone(rec) {
  if (!rec || !rec.id) return;
  const set = _waiters.get(String(rec.id));
  if (!set) return;
  for (const w of Array.from(set)) { try { w.onDone(rec); } catch {} }
}

function _ensureSubs(m) {
  if (_subs) return;
  try {
    _subs = [
      m.addListener('onTransferProgress', (e) => {
        if (!e || !e.id) return;
        const set = _waiters.get(String(e.id));
        if (!set) return;
        for (const w of Array.from(set)) {
          try { w.touch(); } catch {}
          try { w.onProgress?.(Number(e.progress) || 0); } catch {}
        }
      }),
      m.addListener('onTransferDone', (e) => { _dispatchDone(e); }),
    ];
  } catch { _subs = null; }
  if (!_appSub) {
    try {
      _appSub = AppState.addEventListener('change', (s) => {
        if (s !== 'active') return;
        // Events may have been dropped while JS was suspended → poll the
        // records of everything we are waiting on; restart grace windows.
        const mm = _native();
        if (!mm) return;
        try { mm.kick?.().catch?.(() => {}); } catch {}
        for (const [id, set] of _waiters.entries()) {
          for (const w of Array.from(set)) { try { w.touch(); } catch {} }
          mm.getTransfer(id).then((rec) => {
            if (rec && rec.state && rec.state !== 'running' && rec.state !== 'queued') _dispatchDone(rec);
          }).catch(() => {});
        }
      });
    } catch {}
  }
}

/**
 * Wait for transfer `id` to leave running/queued.
 * Resolves the native record, or { state: 'stalled' } / { state: 'aborted' }.
 * Stall = no progress for `stallMs` while the app is in the foreground (the
 * native transfer is cancelled then so the caller's JS path can take over
 * without two writers).
 */
function _wait(m, id, { onProgress, signal, stallMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let lastAt = Date.now();
    let timer = null;
    const w = {
      onProgress,
      touch: () => { lastAt = Date.now(); },
      onDone: (rec) => finish(rec),
    };
    const onAbort = () => {
      try { m.cancel(id).catch(() => {}); } catch {}
      finish({ id, state: 'aborted' });
    };
    function finish(rec) {
      if (settled) return;
      settled = true;
      if (timer) clearInterval(timer);
      const set = _waiters.get(id);
      if (set) { set.delete(w); if (!set.size) _waiters.delete(id); }
      try { signal?.removeEventListener?.('abort', onAbort); } catch {}
      resolve(rec || { id, state: 'failed', error: 'unknown' });
    }
    if (!_waiters.has(id)) _waiters.set(id, new Set());
    _waiters.get(id).add(w);
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      try { signal.addEventListener?.('abort', onAbort, { once: true }); } catch {}
    }
    timer = setInterval(() => {
      if (settled) return;
      if (AppState.currentState !== 'active') { lastAt = Date.now(); return; }
      m.getTransfer(id).then((rec) => {
        if (!rec) { finish({ id, state: 'failed', error: 'record_missing' }); return; }
        if (rec.state !== 'running' && rec.state !== 'queued') { finish(rec); return; }
        if (stallMs > 0 && Date.now() - lastAt > stallMs) {
          try { m.cancel(id).catch(() => {}); } catch {}
          finish({ id, state: 'stalled' });
        }
      }).catch(() => {});
    }, 15000);
    // Already finished before we subscribed (or a previous app run did it).
    m.getTransfer(id).then((rec) => {
      if (rec && rec.state && rec.state !== 'running' && rec.state !== 'queued') finish(rec);
    }).catch(() => {});
  });
}

/** Native record for `id` (or null). */
export async function getTransfer(id) {
  const m = _native();
  if (!m) return null;
  try { return await m.getTransfer(String(id)); } catch { return null; }
}

export async function cancelTransfer(id) {
  const m = _native();
  if (!m) return;
  try { await m.cancel(String(id)); } catch {}
}

export async function forgetTransfer(id) {
  const m = _native();
  if (!m) return;
  try { await m.forget(String(id)); } catch {}
}

/** New bearer after a token refresh → running uploads use it from now on. */
export function updateTransferBearer(bearer) {
  const m = _native();
  if (!m || !bearer) return;
  try { m.updateBearer(String(bearer)).catch(() => {}); } catch {}
}

export function kickTransfers() {
  const m = _native();
  if (!m) return;
  try { m.kick?.().catch?.(() => {}); } catch {}
}

/**
 * Hand a Rust chunked upload session to the OS.
 * Returns { handled:false } when the native side refused (caller keeps its JS
 * loop), else { handled:true, result } where result has the same shape as
 * rustChunkedUploadNative's: { success, cdn_url, … } | { success:false, error, status?, aborted? }.
 */
export async function uploadInBackground(spec) {
  const m = _native();
  if (!m || !spec || !spec.uploadId) return { handled: false };
  _ensureSubs(m);
  const id = 'up-' + String(spec.uploadId);
  let ok = false;
  // [2026-10-09 live-activity] App language for the native upload Live
  // Activity labels (iOS; ignored by older binaries / Android). Lazy require:
  // api.js imports this file.
  let lang = '';
  try { lang = String(require('./api').getUserLanguage?.() || ''); } catch { lang = ''; }
  try {
    ok = await m.enqueueUpload({
      lang,
      id,
      fileUri: String(spec.fileUri),
      base: String(spec.base),
      bearer: String(spec.bearer || ''),
      uploadId: String(spec.uploadId),
      chunkSize: Number(spec.chunkSize),
      totalSize: Number(spec.totalSize),
      skipChunks: Array.isArray(spec.skipChunks) ? spec.skipChunks.map(Number) : [],
      filename: String(spec.filename || 'upload'),
      contentType: String(spec.contentType || 'application/octet-stream'),
      userEmail: String(spec.userEmail || ''),
      context: String(spec.context || 'chat'),
      title: String(spec.title || ''),
    });
  } catch { ok = false; }
  if (!ok) return { handled: false };
  return { handled: true, result: await awaitUpload(spec.uploadId, spec) };
}

/** Wait for an upload already handed off (e.g. by a previous app run). */
export async function awaitUpload(uploadId, { onProgress, signal, stallMs } = {}) {
  const m = _native();
  if (!m) return { success: false, error: 'bg_unavailable' };
  _ensureSubs(m);
  const id = 'up-' + String(uploadId);
  const rec = await _wait(m, id, { onProgress, signal, stallMs: stallMs != null ? stallMs : 5 * 60 * 1000 });
  if (rec.state === 'done' && rec.result && rec.result.cdn_url) {
    forgetTransfer(id);
    return rec.result;
  }
  if (rec.state === 'aborted' || rec.state === 'cancelled') {
    if (signal && signal.aborted) return { success: false, error: 'aborted', aborted: true };
    return { success: false, error: 'bg_cancelled' };
  }
  if (rec.state === 'stalled') return { success: false, error: 'bg_stalled_network' };
  const err = String(rec.error || 'bg_failed');
  forgetTransfer(id);
  const st = Number(rec.httpStatus) || 0;
  if (err === 'file_too_large' || st === 413) return { success: false, error: 'file_too_large', status: 413, code: 'file_too_large' };
  // Keep the caller's transient/hard classification: chunk_* / complete_*
  // stay retryable (RUST_RETRYABLE_RE in mediaSendQueue).
  return { success: false, error: err, status: st || undefined };
}

/**
 * Background download into `dest` (file:// or absolute path).
 * { handled:false } → caller downloads in JS.
 * { handled:true, ok, status, contentType? } otherwise (ok=false, status=0 →
 * network failure / stalled → caller may retry its own way).
 */
export async function downloadInBackground({ id, url, dest, headers, title, onProgress, signal, stallMs } = {}) {
  const m = _native();
  if (!m || !id || !url || !dest) return { handled: false };
  if (typeof m.enqueueDownload !== 'function') return { handled: false };
  _ensureSubs(m);
  const tid = String(id);
  let ok = false;
  try {
    const spec = { id: tid, url: String(url), dest: String(dest), title: String(title || '') };
    if (headers && typeof headers === 'object') spec.headers = headers;
    ok = await m.enqueueDownload(spec);
  } catch { ok = false; }
  if (!ok) return { handled: false };
  const rec = await _wait(m, tid, { onProgress, signal, stallMs: stallMs != null ? stallMs : 2 * 60 * 1000 });
  const status = Number(rec.httpStatus) || Number(rec.result?.status) || 0;
  if (rec.state === 'done') {
    forgetTransfer(tid);
    return { handled: true, ok: true, status: status || 200, contentType: rec.result?.contentType || null };
  }
  if (rec.state !== 'stalled' && rec.state !== 'aborted') forgetTransfer(tid);
  return { handled: true, ok: false, status: rec.state === 'failed' ? status : 0, error: rec.error || rec.state };
}

export default {
  isBgTransferAvailable,
  uploadInBackground,
  awaitUpload,
  downloadInBackground,
  getTransfer,
  cancelTransfer,
  forgetTransfer,
  updateTransferBearer,
  kickTransfers,
};
