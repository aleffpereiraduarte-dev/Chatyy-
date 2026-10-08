/**
 * Media Send Queue — [2026-10-07 send-media] WhatsApp-grade media sending.
 *
 * Every outgoing photo / video / voice note / document on native goes through
 * here instead of the old foreground-only `uploadAndSendFile` loop + MMKV
 * pending row + offlineCache replay. The row lives in the SQLite outbox
 * (services/messageOutbox.js) in the `upload` lane, so it:
 *
 *   • survives app kill / JS reload — the prepared (compressed) file is moved
 *     into documentDirectory/chat-outbox/ and every stage is persisted in the
 *     row's payload (prepared → rust_upload_id → cdn_url);
 *   • resumes instead of restarting — the Rust chunked session id is
 *     persisted, so a retry asks /upload/status which chunks the server has and
 *     only sends the rest;
 *   • is idempotent — the same client_message_id rides on every attempt
 *     (chat_send and chat_upload dedup on (sender_email, client_message_id));
 *   • never blocks text — uploads run in their own lane (2 concurrent,
 *     global); when the bytes are on the CDN the row is promoted into the
 *     ordered chat_send FIFO (album order kept: a photo whose upload finished
 *     early waits for the older ones of the same conversation);
 *   • retries transient failures forever with backoff (offline doesn't count),
 *     hard rejections (413/415/403/blocked type) go to 'failed' (tap to retry);
 *   • keeps uploading for a while after the app is backgrounded (iOS
 *     beginBackgroundTask via expo-background-upload when the binary has it);
 *   • reports progress (compress + upload) and supports cancel.
 *
 * Web keeps the legacy path (OUTBOX_V2_ONLY is false on web — blob: URLs die
 * with the tab, so there is nothing durable to persist).
 */
import { Platform } from 'react-native';
import messageOutbox, {
  enqueue,
  getPending,
  getStatus,
  markSending,
  markSent,
  markFailed,
  markUploadReady,
  promoteReady,
  dequeueUploads,
  nextUploadDueAt,
  updatePayload,
  requeue,
  remove,
  classifySendResult,
  touchOwned,
} from './messageOutbox';

// ─── Tunables ────────────────────────────────────────────────────────────────
// WhatsApp-like defaults (see report for sources). Longest edge, JPEG quality.
export const IMAGE_PROFILES = {
  standard: { maxDim: 1600, quality: 0.8 },   // [2026-10-08 upload-br] WhatsApp-like ~0.8
  lite:     { maxDim: 1280, quality: 0.65 }, // 2g/3g
  hd:       { maxDim: 4096, quality: 0.85 }, // HD toggle
};
// Videos under this size are sent as-is (already small / re-share).
const VIDEO_COMPRESS_MIN_BYTES = 2 * 1024 * 1024;
// Server cap (chat_upload + Rust MAX_CHUNKED_SIZE).
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
// Rust chunked path above this size (resumable); below → single POST.
const CHUNKED_MIN_BYTES = 1 * 1024 * 1024;
const MAX_CONCURRENT = 2;
const DURABLE_DIR = 'chat-outbox/';

export const MEDIA_UPLOAD_TYPES = new Set(['image', 'video', 'voice', 'audio', 'file', 'video_note']);

// ─── State ───────────────────────────────────────────────────────────────────
const _running = new Map(); // cmi -> { ctrl, conv }
const _progressSubs = new Set();
const _lastProgress = new Map(); // cmi -> { pct, phase, at }
let _drainPromise = null;
let _wakeTimer = null;
let _wakeAt = 0;
let _stopped = false;

function _offline() {
  try { const ni = require('./networkInfo'); return typeof ni?.isConnected === 'function' && ni.isConnected() === false; } catch { return false; }
}
function _api() { try { return require('./api'); } catch { return null; } }
function _ws() { try { return require('./websocket').default; } catch { return null; } }
function _FS() { try { return require('expo-file-system/legacy'); } catch { return null; } }
function _bgMod() {
  try { const m = require('../modules/expo-background-upload'); return m?.default || m; } catch { return null; }
}

// ─── Progress bus ────────────────────────────────────────────────────────────
/**
 * fn({ client_message_id, temp_id, conversation_id, pct (0-100), phase })
 * phase: 'compress' | 'upload' | 'commit' | 'done' | 'queued' | 'failed' | 'cancelled'
 */
export function subscribeProgress(fn) {
  if (typeof fn !== 'function') return () => {};
  _progressSubs.add(fn);
  return () => _progressSubs.delete(fn);
}
export function getProgress(cmi) { return _lastProgress.get(String(cmi)) || null; }

function _emit(p, cmi, pct, phase) {
  const key = String(cmi);
  const now = Date.now();
  const prev = _lastProgress.get(key);
  const v = Math.max(0, Math.min(100, Math.round(Number(pct) || 0)));
  // Throttle same-phase ticks to ~8/s (bridge + React re-render cost).
  if (prev && prev.phase === phase && phase !== 'done' && (now - prev.at) < 120 && Math.abs(v - prev.pct) < 10) return;
  const ev = { client_message_id: key, temp_id: p?.temp_id || null, conversation_id: p?.conversation_id, pct: v, phase };
  if (phase === 'done' || phase === 'cancelled') _lastProgress.delete(key);
  else _lastProgress.set(key, { pct: v, phase, at: now });
  for (const fn of _progressSubs) { try { fn(ev); } catch {} }
}

// ─── Background execution (iOS beginBackgroundTask) ─────────────────────────
function _beginBg() {
  if (Platform.OS !== 'ios') return null;
  try {
    const m = _bgMod();
    if (m && typeof m.beginBackgroundTask === 'function') {
      const id = m.beginBackgroundTask('chatyy-media-send');
      return (typeof id === 'number' && id >= 0) ? id : null;
    }
  } catch {}
  return null;
}
function _endBg(id) {
  if (id == null) return;
  try { const m = _bgMod(); m?.endBackgroundTask?.(id); } catch {}
}

// ─── Local file helpers ──────────────────────────────────────────────────────
function _extFrom(name, mime, fallback) {
  const m = /\.([a-z0-9]{1,5})$/i.exec(String(name || ''));
  if (m) return m[1].toLowerCase();
  const t = String(mime || '').toLowerCase();
  if (t.includes('jpeg')) return 'jpg';
  if (t.includes('png')) return 'png';
  if (t.includes('gif')) return 'gif';
  if (t.includes('mp4')) return 'mp4';
  if (t.includes('quicktime')) return 'mov';
  if (t.includes('m4a') || t.includes('audio/mp4') || t.includes('aac')) return 'm4a';
  if (t.includes('ogg') || t.includes('opus')) return 'ogg';
  if (t.includes('pdf')) return 'pdf';
  return fallback || 'bin';
}

/** Absolute file:// for a payload — durable copy first (container path can
 *  change across iOS app updates, so it is rebuilt from the stored name). */
export function resolveLocalUri(p) {
  if (!p) return null;
  if (p.durable_name) {
    const FS = _FS();
    if (FS?.documentDirectory) return FS.documentDirectory + DURABLE_DIR + p.durable_name;
  }
  return p.local_uri || p.uri || null;
}

async function _fileInfo(uri) {
  const FS = _FS();
  if (!FS || !uri) return null;
  try { const i = await FS.getInfoAsync(uri, { size: true }); return i && i.exists ? i : null; } catch { return null; }
}

async function _makeDurable(cmi, uri, name, mime, ownTemp) {
  const FS = _FS();
  if (!FS?.documentDirectory || !uri) return null;
  const dir = FS.documentDirectory + DURABLE_DIR;
  try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
  const safe = String(cmi).replace(/[^a-zA-Z0-9_-]/g, '_');
  const durable = `${safe}.${_extFrom(name, mime, 'bin')}`;
  const dest = dir + durable;
  try { await FS.deleteAsync(dest, { idempotent: true }); } catch {}
  try {
    // Our own compressor output → move (free). Picker/recorder file → copy
    // (the OS may purge Caches/tmp; the user's original must stay untouched).
    if (ownTemp && /^file:/.test(uri)) await FS.moveAsync({ from: uri, to: dest });
    else await FS.copyAsync({ from: uri, to: dest });
    return durable;
  } catch {
    return null;
  }
}

async function _deleteDurable(p) {
  if (!p?.durable_name) return;
  const FS = _FS();
  if (!FS?.documentDirectory) return;
  try { await FS.deleteAsync(FS.documentDirectory + DURABLE_DIR + p.durable_name, { idempotent: true }); } catch {}
}

// ─── Compression ─────────────────────────────────────────────────────────────
function _imageProfile(p) {
  if (p.hd) return IMAGE_PROFILES.hd;
  try {
    const ns = require('./networkInfo').getNetworkState?.();
    const gen = ns?.details?.cellularGeneration || ns?.cellularGeneration;
    if (gen === '2g' || gen === '3g') return IMAGE_PROFILES.lite;
  } catch {}
  return IMAGE_PROFILES.standard;
}

function _getImageSize(uri) {
  return new Promise((resolve) => {
    try {
      const { Image } = require('react-native');
      Image.getSize(uri, (w, h) => resolve({ w, h }), () => resolve(null));
    } catch { resolve(null); }
  });
}

/**
 * Fit-in-box JPEG re-encode (never upscales). Always re-encodes non-GIF images:
 * strips EXIF/GPS and converts HEIC (Android/Chrome can't decode it).
 * Returns { uri, size, width, height, mime, name } or null (keep original).
 */
export async function compressImage(uri, profile, name) {
  if (Platform.OS === 'web' || !uri) return null;
  let IM;
  try { IM = require('expo-image-manipulator'); } catch { return null; }
  const dims = await _getImageSize(uri);
  const actions = [];
  if (dims && dims.w > 0 && dims.h > 0) {
    const longest = Math.max(dims.w, dims.h);
    if (longest > profile.maxDim) {
      if (dims.w >= dims.h) actions.push({ resize: { width: profile.maxDim } });
      else actions.push({ resize: { height: profile.maxDim } });
    }
  } else {
    // Unknown dims: width-only resize could UPSCALE a narrow image — skip resize,
    // still re-encode (EXIF strip / HEIC→JPEG).
  }
  const r = await IM.manipulateAsync(uri, actions, { compress: profile.quality, format: IM.SaveFormat.JPEG });
  if (!r?.uri) return null;
  const info = await _fileInfo(r.uri);
  return {
    uri: r.uri,
    size: info?.size || 0,
    width: r.width || 0,
    height: r.height || 0,
    mime: 'image/jpeg',
    name: (String(name || 'photo').replace(/\.\w+$/, '') || 'photo') + '.jpg',
  };
}

async function _compressVideo(p, uri, signal, onPct) {
  try {
    const vsp = require('./videoSendPipeline');
    const base = vsp.getQualityProfile?.(p.hd ? '1080p' : '720p');
    if (!base) return null;
    const profile = { ...base, audioBitrate: Math.min(base.audioBitrate || 128000, p.hd ? 128000 : 96000) };
    const r = await vsp.prepareCompressed(uri, profile, (f) => onPct(Math.round((Number(f) || 0) * 100)), signal);
    if (!r || r.skipped || !r.uri || r.uri === uri) return null;
    return { uri: r.uri, size: r.size || 0, width: r.width || 0, height: r.height || 0, durationMs: r.durationMs || 0 };
  } catch { return null; }
}

/** Stage 1: compress (image/video) + move into the durable dir. Idempotent. */
async function _prepare(row, p, signal) {
  const cmi = row.client_message_id;
  const type = p.type || 'file';
  let uri = p.local_uri || p.uri;
  let name = p.file_name || 'file';
  let mime = p.mime_type || '';
  let size = Number(p.file_size) || 0;
  let ownTemp = false;
  const extra = {};
  const isGif = /\.gif$/i.test(name || uri || '') || /image\/gif/i.test(mime);

  if (type === 'image' && !isGif && !p.original_quality) {
    _emit(p, cmi, 0, 'compress');
    try {
      const prof = _imageProfile(p);
      const out = await compressImage(uri, prof, name);
      // Keep the re-encode unless it is pathologically bigger than a JPEG
      // source that already fit (EXIF strip is worth a few %, not 2×).
      const isJpegSrc = /jpe?g/i.test(mime) || /\.jpe?g$/i.test(name);
      if (out?.uri && !(isJpegSrc && size > 0 && out.size > size * 1.5)) {
        uri = out.uri; name = out.name; mime = out.mime; size = out.size || size; ownTemp = true;
        if (out.width && out.height) { extra.image_width = out.width; extra.image_height = out.height; }
      }
    } catch {}
  } else if ((type === 'video') && !p.original_quality) {
    const info = size ? { size } : await _fileInfo(uri);
    if ((info?.size || 0) > VIDEO_COMPRESS_MIN_BYTES) {
      _emit(p, cmi, 0, 'compress');
      const out = await _compressVideo(p, uri, signal, (pct) => _emit(p, cmi, pct, 'compress'));
      if (out?.uri && out.size > 0 && (!size || out.size < size)) {
        uri = out.uri; size = out.size; mime = 'video/mp4'; ownTemp = true;
        name = (String(name || 'video').replace(/\.\w+$/, '') || 'video') + '.mp4';
      }
    }
  }
  if (signal?.aborted) return null;

  const durable = await _makeDurable(cmi, uri, name, mime, ownTemp);
  const finalUri = durable ? (_FS().documentDirectory + DURABLE_DIR + durable) : uri;
  const info = await _fileInfo(finalUri);
  if (info?.size) size = info.size;
  const patch = {
    prepared: true,
    local_uri: finalUri,
    durable_name: durable || null,
    file_name: name,
    mime_type: mime,
    file_size: size,
    ...extra,
  };
  await updatePayload(cmi, patch);
  return { ...p, ...patch };
}

// ─── Upload ──────────────────────────────────────────────────────────────────
// [2026-10-08 upload-br] 413 / file_too_large never heal by retrying ("muito
// grande") — `_413` covers the Rust error strings (http_413 / chunk_http_413).
// Reason text: Portuguese label for the bubble + 'too large'/413 so errorMap,
// sendWorker and offlineCache classifiers keep treating it as hard.
export const TOO_LARGE_REASON = 'muito grande (413 too large)';
const TOO_LARGE_RE = /file_too_large|\b413\b|_413\b|too large|muito grande|exceeds/i;
const HARD_RE = /\b41[35]\b|_41[35]\b|\b403\b|too large|exceeds|mime|unsupported|not allowed|blocked|forbidden|rejected|parental|admins? only|only admins|not.?a.?member|permission|conversation.?deleted/i;
// Rust failures that mean "network blipped" — keep the resumable session and
// retry later instead of re-sending the whole file through PHP right now.
const RUST_RETRYABLE_RE = /chunk_\d|network|timeout|read_chunk|complete_/i;

function _kindFor(r, err) {
  const msg = String(err?.message || r?.message || r?.error || '');
  if (HARD_RE.test(msg)) return 'hard';
  const k = classifySendResult(err ? null : r, err || null);
  return k === 'ok' ? 'transient' : k;
}

/** PHP combined upload + message insert (audio always; Rust fallback). */
async function _phpCombined(api, p, cmi, file, signal) {
  const r = await api.chatUploadFile(
    p.conversation_id, file, p.caption || p.content || '', !!p.view_once,
    (f) => _emit(p, cmi, Math.round((Number(f) || 0) * 100), 'upload'),
    p.type === 'voice' ? 'audio' : (p.type || null), signal, false, cmi,
  );
  return r;
}

function _publish(p, cmi, r) {
  try {
    const serverMsg = r?.data?.message || r?.data || null;
    if (!serverMsg || serverMsg.id == null) return;
    const msg = { ...serverMsg, client_message_id: serverMsg.client_message_id || cmi };
    const ws = _ws();
    ws?.emit?.('chat_message', { conversation_id: p.conversation_id, message: msg });
    try { ws?.relayChatMessage?.(p.conversation_id, msg, p.temp_id || null, []); } catch {}
    try { require('./chatCache').cacheSingleMessage?.(p.conversation_id, msg)?.catch?.(() => {}); } catch {}
  } catch {}
}

/**
 * Called after the server owns the message (here or from sendWorker's commit):
 * adopt the local file as the cached copy of the CDN URL (no re-download of our
 * own media, plays offline) and delete the durable outbox copy.
 */
export async function onCommitted(p, serverMsg) {
  try {
    const fileUrl = serverMsg?.file_url;
    const local = resolveLocalUri(p);
    if (fileUrl && local && !p.view_once && Platform.OS !== 'web') {
      const api = _api();
      const remote = api?.getMediaUrl ? api.getMediaUrl(fileUrl) : fileUrl;
      // [2026-10-08 media-local-store] original enviado → media/<conta>/<conv>/<msgId>.<ext>
      try { await require('./mediaCache').adoptLocalFileAsCache?.(remote, local, { conversationId: p.conversation_id, messageId: serverMsg?.id, own: true }); } catch {}
    }
  } catch {}
  await _deleteDurable(p);
  _emit(p, p?.client_message_id, 100, 'done');
}

async function _process(row) {
  const cmi = row.client_message_id;
  const conv = row.conversation_id;
  const ctrl = new AbortController();
  _running.set(cmi, { ctrl, conv });
  const bg = _beginBg();
  // Keep the outbox's in-process ownership fresh: recoverStuck() treats a
  // 'sending' row claimed >90s ago as orphaned, and a big upload legitimately
  // runs longer than that.
  const hb = setInterval(() => { try { touchOwned(cmi); } catch {} }, 20000);
  let p = row.payload || {};
  try {
    const api = _api();
    if (!api) { await markFailed(cmi, 'api_unavailable', { kind: 'transient' }); return; }
    if (p._blob_lost) { await markFailed(cmi, 'blob_lost', { kind: 'hard' }); return; }
    if (_offline()) { await markFailed(cmi, 'offline', { kind: 'offline' }); _emit(p, cmi, 0, 'queued'); return; }

    // 1. Prepare (compress + durable copy) — once per message.
    if (!p.prepared) {
      const prepared = await _prepare(row, p, ctrl.signal);
      if (!prepared || ctrl.signal.aborted) return;
      p = prepared;
    }
    const localUri = resolveLocalUri(p);
    const info = await _fileInfo(localUri);
    if (!info) {
      // Source vanished (OS purge / user deleted the original). Nothing to
      // retry with — surface the red "!" so the user can re-attach.
      await markFailed(cmi, 'file_missing', { kind: 'hard' });
      _emit(p, cmi, 0, 'failed');
      return;
    }
    const size = info.size || Number(p.file_size) || 0;
    if (size > MAX_MEDIA_BYTES) {
      await markFailed(cmi, TOO_LARGE_REASON, { kind: 'hard' });
      _emit(p, cmi, 0, 'failed');
      return;
    }
    const file = { uri: localUri, name: p.file_name || 'file', type: p.mime_type || 'application/octet-stream', size };

    // 1b. Voice note pre-uploaded while recording → cheap finalize (server
    // already has the bytes). Any failure falls through to the full upload,
    // same cmi → the server dedups if the finalize actually landed.
    if (!p.cdn_url && p.voice_session_id && !p.view_once && api.chatVoiceSessionFinalize && !p.voice_session_tried) {
      try {
        _emit(p, cmi, 95, 'upload');
        const fr = await api.chatVoiceSessionFinalize(p.voice_session_id, {
          duration: p.duration || 0,
          mime: p.voice_session_mime || p.mime_type || 'audio/mp4',
          waveform: Array.isArray(p.waveform) ? p.waveform : null,
          clientMessageId: cmi,
        });
        if (fr?.success && fr.data) {
          const msg = fr.data.message || fr.data;
          await markSent(cmi, msg?.id ?? null);
          _publish(p, cmi, fr);
          await onCommitted({ ...p, client_message_id: cmi }, msg);
          return;
        }
      } catch {}
      // Sessions are short-lived server-side: don't burn a round trip on
      // every retry once it failed.
      p = { ...p, voice_session_tried: true };
      try { await updatePayload(cmi, { voice_session_tried: true }); } catch {}
      if (ctrl.signal.aborted) return;
    }

    // 2. Upload — skipped when a previous attempt already put it on the CDN.
    if (!p.cdn_url) {
      _emit(p, cmi, 0, 'upload');
      const usePhp = p.upload_via === 'php' || p.type === 'audio' || p.type === 'voice';
      let rr = null;
      if (!usePhp) {
        const onPct = (f) => _emit(p, cmi, Math.round((Number(f) || 0) * 100), 'upload');
        try {
          if (size > CHUNKED_MIN_BYTES && api.rustChunkedUpload) {
            const resume = {
              uploadId: (p.rust_upload_id && Number(p.rust_upload_size) === size) ? p.rust_upload_id : null,
              // [2026-10-08 upload-br] sessions are host-local (BR edge vs US): persist the base.
              base: p.rust_upload_base || null,
              onUploadId: (id, base) => { updatePayload(cmi, { rust_upload_id: id, rust_upload_size: size, rust_upload_base: base || null }).catch(() => {}); },
            };
            rr = await api.rustChunkedUpload(file, p.sender_email || null, 'chat', onPct, ctrl.signal, resume);
          } else if (api.rustUpload) {
            rr = await api.rustUpload(file, p.sender_email || null, 'chat', ctrl.signal, onPct);
          }
        } catch (e) { rr = { success: false, error: e?.message || 'rust_exception' }; }
        if (ctrl.signal.aborted || rr?.aborted) return;
        // [2026-10-08 upload-br] Over the server cap → permanent, never retried
        // (neither here nor via the PHP fallback, which would 413 the same bytes).
        if (!rr?.success && (rr?.code === 'file_too_large' || Number(rr?.status) === 413 || TOO_LARGE_RE.test(String(rr?.error || '')))) {
          await markFailed(cmi, TOO_LARGE_REASON, { kind: 'hard' });
          _emit(p, cmi, 0, 'failed');
          try { await promoteReady(conv); } catch {}
          return;
        }
        // Network-ish Rust failure → keep the resumable session, retry later
        // (offline-aware backoff). After a few attempts give PHP a chance.
        if (!rr?.success && (row.attempts | 0) < 4 && RUST_RETRYABLE_RE.test(String(rr?.error || ''))) {
          await markFailed(cmi, 'rust:' + String(rr?.error || 'network'), { kind: 'transient' });
          _emit(p, cmi, 0, 'queued');
          return;
        }
        if (rr?.success && rr.cdn_url) {
          p = { ...p, cdn_url: rr.cdn_url, server_size: rr.size || size, server_file_name: rr.filename || p.file_name };
          await markUploadReady(cmi, { cdn_url: p.cdn_url, server_size: p.server_size, server_file_name: p.server_file_name, rust_upload_id: null });
        }
      }
      if (!p.cdn_url) {
        // Audio (server transcodes/peaks) or Rust down → PHP combined upload +
        // insert, idempotent on client_message_id.
        _emit(p, cmi, 0, 'upload');
        let r = null;
        try { r = await _phpCombined(api, p, cmi, file, ctrl.signal); }
        catch (e) {
          if (ctrl.signal.aborted) return;
          const k = _kindFor(null, e);
          await markFailed(cmi, e, { kind: k });
          _emit(p, cmi, 0, k === 'hard' ? 'failed' : 'queued');
          if (k === 'hard') { try { await promoteReady(conv); } catch {} }
          return;
        }
        if (ctrl.signal.aborted || r?.aborted) return;
        if (r?.success && r.data) {
          const msg = r.data.message || r.data;
          await markSent(cmi, msg?.id ?? null);
          _publish(p, cmi, r);
          await onCommitted({ ...p, client_message_id: cmi }, msg);
          return;
        }
        const k = _kindFor(r, null);
        const _why = String(r?.message || r?.error || 'upload_failed');
        const _tooBig = r?.data?.code === 'file_too_large' || TOO_LARGE_RE.test(_why);
        await markFailed(cmi, _tooBig ? TOO_LARGE_REASON : _why, { kind: _tooBig ? 'hard' : k });
        _emit(p, cmi, 0, (k === 'hard' || _tooBig) ? 'failed' : 'queued');
        if (k === 'hard' || _tooBig) { try { await promoteReady(conv); } catch {} }
        return;
      }
    } else {
      await markUploadReady(cmi, null);
    }

    // 3. Bytes on the CDN → hand to the ordered chat_send FIFO.
    _emit(p, cmi, 100, 'commit');
    const promoted = await promoteReady(conv);
    if (promoted.length) {
      try { require('./sendWorker').poke?.(); } catch {}
    }
  } catch (e) {
    if (ctrl.signal.aborted) return;
    const k = _kindFor(null, e);
    await markFailed(cmi, e, { kind: k });
    _emit(p, cmi, 0, k === 'hard' ? 'failed' : 'queued');
  } finally {
    clearInterval(hb);
    _running.delete(cmi);
    _endBg(bg);
  }
}

// ─── Drain loop ──────────────────────────────────────────────────────────────
function _scheduleWake(at) {
  if (_stopped || at == null || !Number.isFinite(Number(at))) return;
  const now = Date.now();
  const due = Math.max(Number(at), now + 250);
  if (_wakeTimer && _wakeAt && _wakeAt <= due) return;
  if (_wakeTimer) { try { clearTimeout(_wakeTimer); } catch {} }
  _wakeAt = due;
  _wakeTimer = setTimeout(() => { _wakeTimer = null; _wakeAt = 0; drain(); }, due - now);
}

async function _drainOnce() {
  if (Platform.OS === 'web') return;
  const free = MAX_CONCURRENT - _running.size;
  if (free > 0) {
    const rows = await dequeueUploads(MAX_CONCURRENT * 2);
    let launched = 0;
    for (const row of rows) {
      if (launched >= free) break;
      if (_running.has(row.client_message_id)) continue;
      const claimed = await markSending(row.client_message_id);
      if (!claimed) continue;
      launched++;
      _process(row).finally(() => { setTimeout(() => { drain(); }, 0); });
    }
  }
  try {
    const at = await nextUploadDueAt();
    if (at != null) _scheduleWake(at);
  } catch {}
}

/** Start as many due uploads as the concurrency budget allows. Coalesced. */
export function drain() {
  if (_stopped || Platform.OS === 'web') return Promise.resolve();
  if (_drainPromise) return _drainPromise;
  _drainPromise = _drainOnce().catch(() => {}).finally(() => { _drainPromise = null; });
  return _drainPromise;
}

/** Connectivity / foreground / boot: promote parked 'ready' rows, drain now. */
export async function kick() {
  if (_stopped || Platform.OS === 'web') return;
  try {
    const rows = await getPending(null, { lane: 'upload' });
    const convs = new Set();
    for (const r of rows || []) if (r.state === 'ready') convs.add(r.conversation_id);
    let any = false;
    for (const c of convs) { const pr = await promoteReady(c); if (pr.length) any = true; }
    if (any) { try { require('./sendWorker').poke?.(); } catch {} }
  } catch {}
  return drain();
}

// ─── Public API used by chat-conversation ────────────────────────────────────
/**
 * Enqueue an outgoing media message. `payload` must carry client_message_id,
 * conversation_id, type, local_uri; optional temp_id, mime_type, file_name,
 * file_size, caption, view_once, hd, sender_email, created_at, duration.
 */
export async function enqueueMedia(payload) {
  if (Platform.OS === 'web' || !payload) return null;
  // [2026-10-08 upload-br] user is chatting → photo backup yields (governor).
  try { require('./backup/uploadGovernor').noteChatActivity?.(); } catch {}
  const r = await enqueue(payload, { lane: 'upload' });
  if (r) {
    _emit(payload, payload.client_message_id, 0, 'queued');
    drain();
  }
  return r;
}

/** User tapped X: abort the in-flight work, drop the row and the durable copy. */
export async function cancel(cmi) {
  if (!cmi) return false;
  const key = String(cmi);
  const run = _running.get(key);
  try { run?.ctrl?.abort?.(); } catch {}
  let p = null;
  try { p = (await getStatus(key))?.payload || null; } catch {}
  // Never cancel something the server already owns.
  try {
    const st = (await getStatus(key))?.state;
    if (st === 'sent' || st === 'delivered' || st === 'read') return false;
  } catch {}
  try { await remove(key); } catch {}
  if (p) await _deleteDurable(p);
  _emit(p || {}, key, 0, 'cancelled');
  if (run?.conv != null || p?.conversation_id != null) {
    try {
      const pr = await promoteReady(run?.conv ?? p.conversation_id);
      if (pr.length) require('./sendWorker').poke?.();
    } catch {}
  }
  return true;
}

export async function cancelByTempId(tempId) {
  if (!tempId) return false;
  try {
    const rows = await getPending(null);
    const hit = (rows || []).find(r => r?.payload?.temp_id === tempId);
    if (hit) return cancel(hit.client_message_id);
  } catch {}
  return false;
}

/** Tap-to-retry on a failed media bubble. */
export async function retry(cmi) {
  if (!cmi) return false;
  const st = await getStatus(String(cmi));
  if (!st) return false;
  await requeue(String(cmi));
  if (st.lane === 'upload') drain();
  else { try { require('./sendWorker').poke?.(); } catch {} }
  return true;
}

export function isUploading(cmi) { return _running.has(String(cmi)); }
/** [2026-10-08 upload-br] In-flight chat media uploads (backup governor signal). */
export function activeUploadCount() { return _running.size; }

export function start() {
  _stopped = false;
  setTimeout(() => { kick(); }, 1800);
}
export function stop() {
  _stopped = true;
  if (_wakeTimer) { try { clearTimeout(_wakeTimer); } catch {} _wakeTimer = null; _wakeAt = 0; }
  for (const [, r] of _running) { try { r.ctrl.abort(); } catch {} }
}

export default {
  enqueueMedia,
  cancel,
  cancelByTempId,
  retry,
  drain,
  kick,
  start,
  stop,
  subscribeProgress,
  getProgress,
  isUploading,
  activeUploadCount,
  onCommitted,
  resolveLocalUri,
  compressImage,
  IMAGE_PROFILES,
  MAX_MEDIA_BYTES,
  MEDIA_UPLOAD_TYPES,
};
