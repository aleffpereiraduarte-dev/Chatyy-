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
// [2026-10-19 media-quality] standard/hd/full come from mediaUploadQuality
// (Padrão 1600/0.8 · HD 2560/0.9 · Full HD original/0.92); `lite` is the
// automatic 2G/3G downgrade of an AUTO Padrão send.
export const IMAGE_PROFILES = {
  // [2026-10-23 midia-wa] preset WA: Padrão 1600 px q0.75 (era 0.8). Getter →
  // kill __chatyy_media_wa_preset === false volta a 0.8 sem recarregar.
  get standard() { return _waPreset() ? { maxDim: 1600, quality: 0.75 } : { maxDim: 1600, quality: 0.8 }; },
  lite:     { maxDim: 1280, quality: 0.65 }, // 2g/3g
  hd:       { maxDim: 2560, quality: 0.9 },  // HD
  full:     { maxDim: 8192, quality: 0.92 }, // Full HD / original pixels
};
/** Level saved on the queued row: `quality` (2026-10-19+) or legacy `hd` boolean. */
function _rowLevel(p) {
  try {
    const q = require('./mediaUploadQuality');
    return q.normalizeLevel(p.quality) || q.normalizeLevel(p.hd) || null;
  } catch {
    return p.quality === 'full' || p.quality === 'hd' || p.quality === 'standard' ? p.quality : (p.hd ? 'hd' : (p.hd === false ? 'standard' : null));
  }
}
// Videos under this size are sent as-is (already small / re-share).
const VIDEO_COMPRESS_MIN_BYTES = 2 * 1024 * 1024;
// Server cap (chat_upload + Rust MAX_CHUNKED_SIZE).
export const MAX_MEDIA_BYTES = 200 * 1024 * 1024;
// Rust chunked path above this size (resumable); below → single POST.
const CHUNKED_MIN_BYTES = 1 * 1024 * 1024;
const MAX_CONCURRENT = 2;
// [2026-10-23 midia-wa] pipeline v2: 3 uploads em paralelo (1 em enlace lento) e
// compressão FORA do slot de upload (até 2 preparando à frente). Kill:
// globalThis.__chatyy_media_pipeline_v2 === false → 2 slots, compressão no slot.
const MAX_CONCURRENT_V2 = 3;
const PREP_AHEAD_MAX = 2;
// Teto de memória: decodificações simultâneas (12 MP ≈ 48 MB RGBA cada; 48 MP ≈
// 190 MB) somando slot + preparo antecipado; vídeo (encoder nativo) 1 por vez.
const IMAGE_COMPRESS_MAX = 2;
const VIDEO_COMPRESS_MAX = 1;
// Foto JPEG já pequena: não reencoda (só tira EXIF/GPS ou gira, se precisar).
const SMALL_JPEG_MAX_BYTES = 350 * 1024;
function _pipeV2() { try { return globalThis.__chatyy_media_pipeline_v2 !== false; } catch { return true; } }
function _waPreset() { try { return globalThis.__chatyy_media_wa_preset !== false; } catch { return true; } }
function _maxConcurrent() { return _pipeV2() ? MAX_CONCURRENT_V2 : MAX_CONCURRENT; }
function _slowLink() { try { return require('./networkInfo').getLinkClass() !== 'fast'; } catch { return false; } }
const DURABLE_DIR = 'chat-outbox/';

export const MEDIA_UPLOAD_TYPES = new Set(['image', 'video', 'voice', 'audio', 'file', 'video_note']);

// ─── State ───────────────────────────────────────────────────────────────────
const _running = new Map(); // cmi -> { ctrl, conv }
// [2026-10-23 midia-wa] preparo antecipado (fora do slot de upload):
// cmi -> { ctrl, promise, done }. A entrada fica até o _process consumir (ou 2 min).
const _prepAhead = new Map();
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

// [2026-10-12 P2] Progresso ÚNICO por mensagem: compressão ocupa 0–30 e o
// upload 30–100 (sem compressão, upload = 0–100), e nunca diminui (retry,
// fallback Rust→PHP, retomada) — o anel não "volta".
const _maxPct = new Map();      // cmi -> maior pct já emitido (fases ativas)
const _hadCompress = new Set(); // cmi que passou pela fase de compressão
const COMPRESS_WEIGHT = 30;
function _overallPct(key, raw, phase) {
  if (phase === 'compress') { _hadCompress.add(key); return (raw * COMPRESS_WEIGHT) / 100; }
  if (phase === 'upload') return _hadCompress.has(key) ? COMPRESS_WEIGHT + (raw * (100 - COMPRESS_WEIGHT)) / 100 : raw;
  if (phase === 'commit' || phase === 'done') return 100;
  return raw;
}

/** [2026-10-15 fase 4] progresso vindo da fila nativa (upload/commit). */
export function emitProgressExternal(p, cmi, pct, phase) { _emit(p, cmi, pct, phase); }

function _emit(p, cmi, pct, phase) {
  const key = String(cmi);
  const now = Date.now();
  const prev = _lastProgress.get(key);
  const raw = Math.max(0, Math.min(100, Number(pct) || 0));
  let v = Math.max(0, Math.min(100, Math.round(_overallPct(key, raw, phase))));
  if (phase === 'compress' || phase === 'upload' || phase === 'commit') {
    const mx = _maxPct.get(key) || 0;
    if (v < mx) v = mx; else _maxPct.set(key, v);
  } else if (phase === 'done' || phase === 'cancelled' || phase === 'failed') {
    _maxPct.delete(key); _hadCompress.delete(key);
  }
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
  if (!p?.durable_name && !p?.src_durable) return;
  const FS = _FS();
  if (!FS?.documentDirectory) return;
  // [2026-10-18 durable-src] also the original copied at enqueue time.
  for (const n of new Set([p.durable_name, p.src_durable].filter(Boolean))) {
    try { await FS.deleteAsync(FS.documentDirectory + DURABLE_DIR + n, { idempotent: true }); } catch {}
  }
}

// ─── [2026-10-23 midia-wa] semáforo de compressão (teto de memória) ──────────
function _sem(max) {
  let n = 0; const q = [];
  const release = () => { n--; const nx = q.shift(); if (nx) { n++; nx(); } };
  return {
    async run(fn) {
      if (n >= max) await new Promise((r) => q.push(r)); else n++;
      try { return await fn(); } finally { release(); }
    },
  };
}
const _imgSem = _sem(IMAGE_COMPRESS_MAX);
const _vidSem = _sem(VIDEO_COMPRESS_MAX);
function _withSem(sem, fn) { return _pipeV2() ? sem.run(fn) : fn(); }

// ─── [2026-10-23 midia-wa] cabeçalho JPEG (EXIF/GPS/orientação/dimensões) ────
const _B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
let _B64R = null;
function _b64bytes(b64) {
  if (!_B64R) { _B64R = new Int16Array(128).fill(-1); for (let i = 0; i < 64; i++) _B64R[_B64.charCodeAt(i)] = i; }
  const s = String(b64 || '').replace(/[^A-Za-z0-9+/]/g, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0; let acc = 0; let bits = 0;
  for (let i = 0; i < s.length; i++) {
    acc = (acc << 6) | _B64R[s.charCodeAt(i)]; bits += 6;
    if (bits >= 8) { bits -= 8; out[o++] = (acc >> bits) & 0xff; }
  }
  return o === out.length ? out : out.subarray(0, o);
}
/**
 * Lê só o começo do arquivo (≤128 KB). → null (não é JPEG / falhou) |
 * { width, height, orientation, gps } — gps = IFD de GPS com coordenada.
 */
export function parseJpegHeader(b) {
  try {
    if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
    const r = { width: 0, height: 0, orientation: 1, gps: false, exif: false };
    let i = 2;
    while (i + 4 <= b.length) {
      if (b[i] !== 0xff) return r.width ? r : null;
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd9 || m === 0xda) break;
      if (m >= 0xd0 && m <= 0xd7) { i += 2; continue; }
      const len = (b[i + 2] << 8) | b[i + 3];
      if (len < 2) return null;
      if (m === 0xe1 && i + 10 <= b.length && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) {
        r.exif = true;
        const t = i + 10; const le = b[t] === 0x49;
        const u16 = (o) => (o + 2 > b.length ? -1 : (le ? (b[o] | (b[o + 1] << 8)) : ((b[o] << 8) | b[o + 1])));
        const u32 = (o) => (o + 4 > b.length ? -1 : (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0));
        const ifd = u32(t + 4); const n = ifd >= 0 ? u16(t + ifd) : -1;
        for (let k = 0; k < n && k < 64; k++) {
          const e = t + ifd + 2 + k * 12;
          const tag = u16(e); if (tag < 0) break;
          if (tag === 0x0112) r.orientation = u16(e + 8) || 1;
          else if (tag === 0x8825) {
            const go = u32(e + 8); const gn = go > 0 ? u16(t + go) : -1;
            // só GPSVersionID (1 entrada) não é localização; desconhecido (fora do trecho lido) = tem.
            r.gps = gn < 0 || gn > 1;
          }
        }
      } else if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        r.height = (b[i + 5] << 8) | b[i + 6];
        r.width = (b[i + 7] << 8) | b[i + 8];
        return r;
      }
      i += 2 + len;
    }
    return r.width ? r : (r.exif ? r : null);
  } catch { return null; }
}
async function _jpegHeader(uri) {
  const FS = _FS();
  if (!FS || !uri) return null;
  try {
    const b64 = await FS.readAsStringAsync(uri, { encoding: 'base64', position: 0, length: 131072 });
    return parseJpegHeader(_b64bytes(b64));
  } catch { return null; }
}

// ─── [2026-10-23 midia-wa] contratos A (R2 direto) e B (pré-upload) ──────────
function _r2() { try { const m = require('./r2DirectUpload'); return m?.default && !m.uploadDirect ? m.default : m; } catch { return null; } }
function _pre() { try { const m = require('./mediaPreupload'); return m?.default && !m.claim ? m.default : m; } catch { return null; } }
function _e2eConv(conv) {
  try { const e5 = require('./e2ee/e2ee5'); return !!(e5.isOn?.() && conv != null && e5.convModeSync?.(conv)); } catch { return false; }
}
function _levelFor(p) {
  const lv = _rowLevel(p);
  if (lv) return lv;
  try { return require('./mediaUploadQuality').defaultUploadLevel() || 'standard'; } catch { return 'standard'; }
}

// ─── [2026-10-23 midia-wa] telemetria por mensagem (beacon 'media_send') ─────
const _tries = new Map(); // cmi → tentativas neste processo
function _hostOf(u) { try { const m = /^https?:\/\/([^/:]+)/i.exec(String(u || '')); return m ? m[1].toLowerCase().slice(0, 40) : ''; } catch { return ''; } }
function _viaForBase(base) {
  const h = _hostOf(base);
  if (!h) return 'rust_us';
  return (h === 'chatyy.com.br' || h === 'www.chatyy.com.br') ? 'rust_us' : 'rust_edge';
}
function _reportMedia(p, serverMsg) {
  try {
    if (!p) return;
    const now = Date.now();
    const tap = Number(p.tap_at) || 0;
    const upEnd = Number(p.m_up_end) || 0;
    const row = {
      type: p.type || '',
      bytes_in: Number(p.m_src_size) || 0,
      bytes_out: Number(p.server_size) || Number(p.file_size) || 0,
      level: p.m_level || _rowLevel(p) || '',
      t_bubble: Number.isFinite(Number(p.bubble_ms)) && p.bubble_ms != null ? Math.round(Number(p.bubble_ms)) : -1,
      t_prep_ms: Number.isFinite(Number(p.m_prep_ms)) && p.m_prep_ms != null ? Math.round(Number(p.m_prep_ms)) : -1,
      t_up_ms: Number.isFinite(Number(p.m_up_ms)) && p.m_up_ms != null ? Math.round(Number(p.m_up_ms)) : -1,
      t_commit_ms: upEnd > 0 ? Math.max(0, now - upEnd) : -1,
      via: p.m_via || (p.upload_via === 'php' || p.type === 'audio' || p.type === 'voice' ? 'php' : ''),
      base: p.m_base || _hostOf(p.rust_upload_base) || '',
      attempts: Math.max(1, Number(p.m_tries) || _tries.get(String(p.client_message_id)) || 1),
      e2e: tap > 0 ? Math.max(0, now - tap) : -1,
      e2ee: _e2eConv(p.conversation_id) ? 1 : 0,
      mid: serverMsg?.id != null ? String(serverMsg.id).slice(0, 24) : '',
      cmi: String(p.client_message_id || '').slice(0, 40),
    };
    _tries.delete(String(p.client_message_id));
    require('./nativeTelemetry').reportMediaSend?.(row);
  } catch {}
}

// ─── Compression ─────────────────────────────────────────────────────────────
function _imageProfile(p) {
  const lv = _rowLevel(p);
  if (lv === 'hd' || lv === 'full') return IMAGE_PROFILES[lv];
  // Explicit Padrão keeps 1600 px even on a slow link; AUTO (null) may drop to lite.
  if (lv === 'standard' && p.quality_explicit) return IMAGE_PROFILES.standard;
  try {
    const ni = require('./networkInfo');
    const ns = ni.getNetworkState?.();
    const gen = ns?.details?.cellularGeneration || ns?.cellularGeneration;
    if (gen === '2g' || gen === '3g') return IMAGE_PROFILES.lite;
    // [2026-10-09 net-resilience] RTT medido alto (Ásia/satélite/4G ruim) também.
    if (ni.getLinkClass && ni.getLinkClass() !== 'fast') return IMAGE_PROFILES.lite;
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
    // [2026-10-11 video-fullhd] p.hd = chip choice captured at send time
    // (true/false); null/undefined (older rows / other callers) → saved
    // "Qualidade de envio de mídia" default, network-aware (1080p unless
    // Padrão / Data Saver / weak link).
    // [2026-10-19 media-quality] p.quality = level picked at send time
    // ('standard'|'hd'|'full'); legacy rows only carry p.hd.
    const lv = _rowLevel(p);
    const label = lv
      ? (lv === 'full' ? '1080p_full' : (lv === 'hd' ? '1080p' : '720p'))
      : (vsp.resolveVideoLabel?.(null) || '720p');
    const base = vsp.getQualityProfile?.(label);
    if (!base) return null;
    const aCap = label === '1080p_full' ? 160000 : (label === '1080p' ? 128000 : 96000);
    const profile = { ...base, audioBitrate: Math.min(base.audioBitrate || 128000, aCap), ...(label === '1080p_full' ? { passthroughFull: true } : null) };
    const r = await vsp.prepareCompressed(uri, profile, (f) => onPct(Math.round((Number(f) || 0) * 100)), signal);
    if (r && r.passthrough) return { uri: null, size: 0, width: r.width || 0, height: r.height || 0, durationMs: r.durationMs || 0 };
    if (!r || r.skipped || !r.uri || r.uri === uri) return null;
    return { uri: r.uri, size: r.size || 0, width: r.width || 0, height: r.height || 0, durationMs: r.durationMs || 0 };
  } catch { return null; }
}

/** Stage 1: compress (image/video) + move into the durable dir. Idempotent. */
async function _prepare(row, p, signal) {
  const cmi = row.client_message_id;
  const type = p.type || 'file';
  // [2026-10-18 durable-src] durable original copied at enqueue (rebuilt from
  // the stored name: the iOS container path can change across updates).
  let uri = (p.src_durable ? resolveLocalUri(p) : null) || p.local_uri || p.uri;
  const srcUri = uri;
  let name = p.file_name || 'file';
  let mime = p.mime_type || '';
  let size = Number(p.file_size) || 0;
  let ownTemp = false;
  const extra = {};
  const isGif = /\.gif$/i.test(name || uri || '') || /image\/gif/i.test(mime);
  // [2026-10-23 midia-wa] métricas p/ o beacon media_send (viajam no payload).
  const _t0 = Date.now();
  extra.m_src_size = Number(p.file_size) || 0;
  extra.m_level = (type === 'image' || type === 'video') ? _levelFor(p) : null;

  // [2026-10-23 midia-wa] contrato B: a prévia já comprimiu (e talvez subiu) este
  // item → usa o arquivo dela (pula a compressão) e, com cdn_url, nem sobe de novo.
  // Conversa E2EE nunca usa cdn_url em claro (o pré-upload já pula E2EE; guarda dupla).
  let _claimed = null;
  if ((type === 'image' || type === 'video') && !p.pre_tried && !isGif) {
    extra.pre_tried = true;
    const pre = _pre();
    if (pre && typeof pre.claim === 'function') {
      try {
        _claimed = await pre.claim(p.orig_uri || p.local_uri, extra.m_level || 'standard', { waitMs: type === 'video' ? 2500 : 1500 });
      } catch { _claimed = null; }
    }
    if (_claimed && signal?.aborted) {
      try { if (_claimed.prepared?.owned && _claimed.prepared.local_uri) await _FS()?.deleteAsync?.(_claimed.prepared.local_uri, { idempotent: true }); } catch {}
      return null;
    }
    const pr = _claimed?.prepared || null;
    if (pr && pr.local_uri && await _fileInfo(pr.local_uri)) {
      uri = pr.local_uri; ownTemp = !!pr.owned;
      name = pr.file_name || name; mime = pr.mime_type || mime; size = Number(pr.file_size) || size;
      if (pr.image_width > 0 && pr.image_height > 0) { extra.image_width = pr.image_width; extra.image_height = pr.image_height; }
      if (pr.duration_ms > 0) extra.duration_ms = Math.round(pr.duration_ms);
      if (_claimed.cdn_url && !_e2eConv(p.conversation_id)) {
        extra.cdn_url = _claimed.cdn_url;
        extra.server_size = Number(_claimed.server_size) || size;
        extra.server_file_name = name;
        extra.m_via = 'pre';
        extra.m_up_ms = 0;
        extra.m_up_end = Date.now();
      }
    } else {
      _claimed = null;
    }
  }

  if (_claimed) {
    // já preparado pela prévia
  } else if (type === 'image' && !isGif && !p.original_quality) {
    _emit(p, cmi, 0, 'compress');
    try {
      const prof = _imageProfile(p);
      const wa = _waPreset();
      // [2026-10-23 midia-wa] cabeçalho real (magic bytes): JPEG? GPS? orientação? dimensões.
      const hdr = wa ? await _jpegHeader(uri) : null;
      const isJpegSrc = hdr ? true : (/jpe?g/i.test(mime) || /\.jpe?g$/i.test(name));
      const isPngSrc = !hdr && (/png/i.test(mime) || /\.png$/i.test(name));
      const needsStrip = !!(hdr && (hdr.gps || (hdr.orientation && hdr.orientation !== 1)));
      const longest = hdr && hdr.width > 0 ? Math.max(hdr.width, hdr.height) : 0;
      const srcSize = size || (await _fileInfo(uri))?.size || 0;
      if (wa && hdr && longest > 0 && longest <= prof.maxDim && srcSize > 0 && srcSize <= SMALL_JPEG_MAX_BYTES && !needsStrip) {
        // JPEG já pequeno e limpo → vai como está (reencodar só perderia qualidade).
        size = srcSize;
        extra.image_width = hdr.width; extra.image_height = hdr.height;
        if (!/\.jpe?g$/i.test(name)) name = (String(name || 'photo').replace(/\.\w+$/, '') || 'photo') + '.jpg';
        mime = 'image/jpeg';
      } else {
        // pequeno mas com GPS/rotação → só tira o EXIF (sem reduzir, q alta).
        const smallStrip = wa && hdr && longest > 0 && longest <= prof.maxDim && srcSize > 0 && srcSize <= SMALL_JPEG_MAX_BYTES && needsStrip;
        const useProf = smallStrip ? { maxDim: prof.maxDim, quality: Math.max(prof.quality, 0.85) } : prof;
        const out = await _withSem(_imgSem, () => compressImage(uri, useProf, name));
        let keep = !!out?.uri;
        if (keep && isJpegSrc && srcSize > 0) {
          if (wa && hdr) {
            // nunca maior que o original — salvo quando precisa tirar GPS/girar.
            if (!needsStrip && out.size >= srcSize) keep = false;
          } else if (out.size > srcSize * 1.5) keep = false; // regra antiga (cabeçalho ilegível: GPS desconhecido)
        } else if (keep && wa && isPngSrc && srcSize > 0 && out.size >= srcSize) {
          keep = false; // PNG menor que o JPEG gerado (print/arte) → vai o PNG
        }
        if (keep) {
          uri = out.uri; name = out.name; mime = out.mime; size = out.size || size; ownTemp = true;
          if (out.width && out.height) { extra.image_width = out.width; extra.image_height = out.height; }
        } else {
          if (out?.uri) { try { await _FS()?.deleteAsync?.(out.uri, { idempotent: true }); } catch {} }
          if (hdr && hdr.width > 0) { extra.image_width = hdr.width; extra.image_height = hdr.height; }
        }
      }
    } catch {}
  } else if ((type === 'video') && !p.original_quality) {
    const info = size ? { size } : await _fileInfo(uri);
    if ((info?.size || 0) > VIDEO_COMPRESS_MIN_BYTES) {
      _emit(p, cmi, 0, 'compress');
      const out = await _withSem(_vidSem, () => _compressVideo(p, uri, signal, (pct) => _emit(p, cmi, pct, 'compress')));
      if (out?.uri && out.size > 0 && (!size || out.size < size)) {
        uri = out.uri; size = out.size; mime = 'video/mp4'; ownTemp = true;
        name = (String(name || 'video').replace(/\.\w+$/, '') || 'video') + '.mp4';
      }
      // [2026-10-12 P2] metadados do vídeo p/ o chat_send (duração/dimensões).
      if (out?.durationMs > 0) extra.duration_ms = Math.round(out.durationMs);
      if (out?.width > 0 && out?.height > 0) { extra.image_width = out.width; extra.image_height = out.height; }
    }
  }
  if (signal?.aborted) return null;

  // [2026-10-18 durable-src] Not re-encoded → the enqueue-time durable copy IS
  // the final file (no second copy). Re-encoded → move the output in and drop
  // the original copy once the new one is safe.
  const reuseSrc = !!(p.src_durable && uri === srcUri);
  const durable = reuseSrc ? p.src_durable : await _makeDurable(cmi, uri, name, mime, ownTemp);
  // [2026-10-12 P2] cancelado durante a cópia → não deixa órfão nem grava payload.
  if (signal?.aborted) { if (durable && !reuseSrc) await _deleteDurable({ durable_name: durable }); return null; }
  if (durable && p.src_durable && durable !== p.src_durable) {
    await _deleteDurable({ durable_name: p.src_durable });
  }
  const finalUri = durable ? (_FS().documentDirectory + DURABLE_DIR + durable) : uri;
  const info = await _fileInfo(finalUri);
  if (info?.size) size = info.size;
  const patch = {
    prepared: true,
    local_uri: finalUri,
    durable_name: durable || null,
    // kept when it IS the final file, or when the move failed (cleanup later).
    src_durable: (durable && durable !== p.src_durable) ? null : (p.src_durable || null),
    file_name: name,
    mime_type: mime,
    file_size: size,
    ...extra,
    m_prep_ms: Date.now() - _t0,
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
// [2026-10-18 resume-first] ~1 h of resumable retries (TRANSIENT_BACKOFF_MS).
const RUST_RESUME_MAX_ATTEMPTS = 20;
const RUST_RETRYABLE_RE = /chunk_\d|network|timeout|read_chunk|complete_|bg_/i; // bg_: [2026-10-09 media-native] OS transfer stalled/cancelled

function _kindFor(r, err) {
  const msg = String(err?.message || r?.message || r?.error || '');
  if (HARD_RE.test(msg)) return 'hard';
  const k = classifySendResult(err ? null : r, err || null);
  return k === 'ok' ? 'transient' : k;
}

/**
 * [2026-10-12 P2] Duração em SEGUNDOS inteiros de um payload da fila.
 * duration_ms (saída da compressão) tem prioridade; `duration` de voz já vem
 * em segundos; o de vídeo vem do picker (expo-image-picker = ms) → valores
 * ≥1000 são tratados como ms.
 */
export function mediaDurationSec(p) {
  if (!p) return 0;
  const ms = Number(p.duration_ms) || 0;
  if (ms > 0) return Math.max(1, Math.round(ms / 1000));
  const d = Number(p.duration) || 0;
  if (!(d > 0)) return 0;
  const isVoice = p.type === 'voice' || p.type === 'audio';
  if (!isVoice && d >= 1000) return Math.max(1, Math.round(d / 1000));
  return Math.max(1, Math.round(d));
}

/** PHP combined upload + message insert (audio always; Rust fallback). */
async function _phpCombined(api, p, cmi, file, signal) {
  const r = await api.chatUploadFile(
    p.conversation_id, file, p.caption || p.content || '', !!p.view_once,
    (f) => _emit(p, cmi, Math.round((Number(f) || 0) * 100), 'upload'),
    p.type === 'voice' ? 'audio' : (p.type || null), signal, false, cmi,
    p.reply_to_id || null, // [2026-10-12 reply-media]
    // [2026-10-12 rec-audit P0-3] duração (s) do áudio de voz no POST.
    (p.type === 'audio' || p.type === 'voice') ? (Number(p.duration) || null)
      : (p.type === 'video' ? (mediaDurationSec(p) || null) : null), // [2026-10-12 P2] vídeo também
    p.topic_id || null, // [2026-10-21 tg4] tópico
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
  // [2026-10-23 midia-wa] beacon media_send (toque→bolha→preparo→upload→✓).
  try {
    if (p && p.m_via === 'native' && Number(p.m_up_start) > 0 && p.m_up_ms == null) {
      _reportMedia({ ...p, m_up_ms: Date.now() - Number(p.m_up_start), m_up_end: 0 }, serverMsg);
    } else _reportMedia(p, serverMsg);
  } catch {}
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
  // [2026-10-12 P1 álbum] Toda falha DEFINITIVA libera os 'ready' de trás
  // (promoteReady + poke no finally) — senão o resto do álbum fica no relógio.
  let hardFailed = false;
  try {
    const api = _api();
    if (!api) { await markFailed(cmi, 'api_unavailable', { kind: 'transient' }); return; }
    if (p._blob_lost) { hardFailed = true; await markFailed(cmi, 'blob_lost', { kind: 'hard' }); _emit(p, cmi, 0, 'failed'); return; }
    if (_offline()) { await markFailed(cmi, 'offline', { kind: 'offline' }); _emit(p, cmi, 0, 'queued'); return; }

    _tries.set(String(cmi), (_tries.get(String(cmi)) || 0) + 1);
    // [2026-10-23 midia-wa] pipeline: o preparo pode já ter rodado (ou estar
    // rodando) à frente, fora do slot de upload → espera/usa o resultado dele.
    const _ahead = _prepAhead.get(cmi);
    if (_ahead) {
      let r = null;
      try { r = await _ahead.promise; } catch { r = null; }
      if (_prepAhead.get(cmi) === _ahead) _prepAhead.delete(cmi);
      if (ctrl.signal.aborted) return;
      if (r && r.prepared) p = { ...p, ...r };
    }
    // 1. Prepare (compress + durable copy) — once per message.
    if (!p.prepared) {
      const prepared = await _prepare(row, p, ctrl.signal);
      if (!prepared || ctrl.signal.aborted) return;
      p = prepared;
    }
    const localUri = resolveLocalUri(p);
    const info = await _fileInfo(localUri);
    if (ctrl.signal.aborted) return;
    if (!info) {
      // Source vanished (OS purge / user deleted the original). Nothing to
      // retry with — surface the red "!" so the user can re-attach.
      hardFailed = true;
      await markFailed(cmi, 'file_missing', { kind: 'hard' });
      _emit(p, cmi, 0, 'failed');
      return;
    }
    const size = info.size || Number(p.file_size) || 0;
    if (size > MAX_MEDIA_BYTES) {
      hardFailed = true;
      await markFailed(cmi, TOO_LARGE_REASON, { kind: 'hard' });
      _emit(p, cmi, 0, 'failed');
      return;
    }
    const file = { uri: localUri, name: p.file_name || 'file', type: p.mime_type || 'application/octet-stream', size };

    // [e2ee5 WP-11] conversa E2EE: variantes no aparelho + cada arquivo cifrado + blob opaco; a linha
    // fica pronta com o ENVELOPE (o sendWorker só faz o chat_send). Sessão de voz/fila nativa: nunca.
    try {
      const _m5 = require('./e2ee/e2ee5Media');
      if (await _m5.queueStep(row, p, file, {
        emit: (pct) => _emit(p, cmi, pct, 'upload'), signal: ctrl.signal,
        updatePayload, markUploadReady, markFailed, promoteReady,
        poke: () => { try { require('./sendWorker').poke?.(); } catch {} },
      })) return;
    } catch {}

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
          replyToId: p.reply_to_id || null, // [2026-10-12 reply-media]
        });
        if (fr?.success && fr.data) {
          const msg = fr.data.message || fr.data;
          await markSent(cmi, msg?.id ?? null);
          _publish(p, cmi, fr);
          await onCommitted({ ...p, client_message_id: cmi, m_via: 'php', m_up_end: Date.now() }, msg);
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
    // [2026-10-15 fase 4] Arquivo pequeno (POST único) → a FILA NATIVA sobe (iOS:
    // URLSession de 2º plano; Android: OkHttp/WorkManager) e faz o chat_send na
    // ordem — continua com o app fechado. O evento 'sent' conclui (nativeOutbox).
    if (!p.cdn_url && !(p.upload_via === 'php' || p.type === 'audio' || p.type === 'voice')) {
      try {
        const no = require('./nativeOutbox');
        // [2026-10-23 midia-wa] binário SEM PUT nativo: o multipart nativo vai a base/api/rust/upload
        // (6 de 11 edges encaminham os bytes ao US pelo WG; Rust síncrono). Com o presign ligado,
        // o JS sobe direto ao R2 (abaixo) e só o commit vai à fila nativa. Kill: __chatyy_r2_over_native=false.
        let _r2js = false;
        try {
          if (globalThis.__chatyy_r2_over_native !== false && !(no.nativePutSupported && no.nativePutSupported())
            && !p.rust_upload_id && (Number(p.r2_fail) || 0) < 2) {
            const r2 = _r2();
            _r2js = !!(r2 && typeof r2.uploadDirect === 'function' && r2.directEnabled?.());
          }
        } catch { _r2js = false; }
        if (!_r2js && no.nativeOutboxEnabled && no.nativeOutboxEnabled() && size <= no.NATIVE_MEDIA_MAX_BYTES && !_slowLink()) {
          let meta = null;
          // [2026-10-23 midia-wa] o nativo congela os metadados no handoff: espera (≤120 ms) o
          // LQIP/blurhash local gerado no enqueue (vídeo pela fila nativa ficava sem prévia).
          try { await require('./imageSendPipeline').waitClientMeta?.(p.temp_id || cmi, 120); } catch {}
          try { meta = require('./sendWorker').mediaMetaFields?.(p, p.type) || null; } catch {}
          if (await no.handoffUpload(row, p, file, size, meta)) {
            // [2026-10-23 midia-wa] telemetria: o nativo sobe + faz o chat_send.
            try { updatePayload(cmi, { m_via: 'native', m_up_start: Date.now(), m_tries: _tries.get(String(cmi)) || 1 }).catch(() => {}); } catch {}
            // [2026-10-18 outbox-progress] transport ≥ 3: começa em 0 e segue os
            // bytes REAIS ('progress' → emitProgressExternal). Binário antigo:
            // degrau fixo de 10% (o máximo monotônico seguraria o anel em 10).
            let _real = false;
            try { _real = !!(no.hasNativeProgress && no.hasNativeProgress()); } catch {}
            _emit(p, cmi, _real ? 0 : 10, 'upload');
            return;
          }
        }
      } catch {}
    }
    if (!p.cdn_url) {
      _emit(p, cmi, 0, 'upload');
      const usePhp = p.upload_via === 'php' || p.type === 'audio' || p.type === 'voice';
      let rr = null;
      let _sessionThisRun = false;
      const _upT0 = Date.now();
      let _via = null; let _base = '';
      if (!usePhp) {
        const onPct = (f) => _emit(p, cmi, Math.round((Number(f) || 0) * 100), 'upload');
        // [2026-10-23 midia-wa] contrato A: PUT direto no R2 (URL pré-assinada)
        // primeiro. Não com sessão chunked aberta (retomar é mais barato), nem
        // arquivo grande em enlace lento (PUT único não retoma), nem depois de 2
        // falhas desta linha. Falha não-hard → caminho atual (Rust/PHP).
        const r2 = _r2();
        let _r2on = false;
        try { _r2on = !!(r2 && typeof r2.uploadDirect === 'function' && r2.directEnabled?.()); } catch { _r2on = false; }
        if (_r2on && !p.rust_upload_id && (Number(p.r2_fail) || 0) < 2 && (!_slowLink() || size <= 2 * 1024 * 1024)) {
          let d = null;
          try { d = await r2.uploadDirect(file, { context: 'chat', signal: ctrl.signal, onPct, cmi }); }
          catch (e) { d = { success: false, error: e?.message || 'r2_exception' }; }
          if (ctrl.signal.aborted || d?.aborted) return;
          if (d?.success && d.cdn_url) {
            rr = { success: true, cdn_url: d.cdn_url, size: Number(d.size) || size, filename: p.file_name };
            _via = 'r2'; _base = _hostOf(d.cdn_url);
          } else if (d?.hard && TOO_LARGE_RE.test(String(d?.error || ''))) {
            hardFailed = true;
            await markFailed(cmi, TOO_LARGE_REASON, { kind: 'hard' });
            _emit(p, cmi, 0, 'failed');
            return;
          } else {
            p = { ...p, r2_fail: (Number(p.r2_fail) || 0) + 1 };
            updatePayload(cmi, { r2_fail: p.r2_fail }).catch(() => {});
          }
        }
        if (!rr) try {
          // [2026-10-09 net-resilience] enlace lento: >256 KB já vai em pedaços
          // retomáveis (POST único que cai recomeça do zero).
          if (size > (_slowLink() ? 256 * 1024 : CHUNKED_MIN_BYTES) && api.rustChunkedUpload) {
            const resume = {
              uploadId: (p.rust_upload_id && Number(p.rust_upload_size) === size) ? p.rust_upload_id : null,
              // [2026-10-08 upload-br] sessions are host-local (BR edge vs US): persist the base.
              base: p.rust_upload_base || null,
              // [2026-10-09 media-native] chunk size the session was opened with
              // (resume must keep it; rows without it start a fresh session).
              chunkSize: Number(p.rust_upload_chunk) || null,
              bgTitle: p.file_name || null,
              onUploadId: (id, base, chunk) => { _sessionThisRun = !!id; if (base) _base = String(base); updatePayload(cmi, { rust_upload_id: id, rust_upload_size: size, rust_upload_base: base || null, rust_upload_chunk: Number(chunk) || null }).catch(() => {}); },
            };
            if (!_base && p.rust_upload_base) _base = String(p.rust_upload_base);
            rr = await api.rustChunkedUpload(file, p.sender_email || null, 'chat', onPct, ctrl.signal, resume);
          } else if (api.rustUpload) {
            rr = await api.rustUpload(file, p.sender_email || null, 'chat', ctrl.signal, onPct);
          }
          if (!_via) { if (!_base) { try { _base = String(api.getRustUploadBase?.() || ''); } catch {} } _via = _viaForBase(_base); _base = _hostOf(_base); }
        } catch (e) { rr = { success: false, error: e?.message || 'rust_exception' }; }
        if (ctrl.signal.aborted || rr?.aborted) return;
        // [2026-10-08 upload-br] Over the server cap → permanent, never retried
        // (neither here nor via the PHP fallback, which would 413 the same bytes).
        if (!rr?.success && (rr?.code === 'file_too_large' || Number(rr?.status) === 413 || TOO_LARGE_RE.test(String(rr?.error || '')))) {
          hardFailed = true;
          await markFailed(cmi, TOO_LARGE_REASON, { kind: 'hard' });
          _emit(p, cmi, 0, 'failed');
          return;
        }
        // Network-ish Rust failure → keep the resumable session, retry later
        // (offline-aware backoff). After a few attempts give PHP a chance.
        // [2026-10-18 resume-first] …but only when there is no resumable
        // session: PHP re-sends the WHOLE file from byte 0, so with a session
        // open we keep resuming (backoff caps at 5 min) for up to
        // RUST_RESUME_MAX_ATTEMPTS before the from-scratch fallback.
        const _att = row.attempts | 0;
        const _hasSession = !!(p.rust_upload_id || _sessionThisRun);
        if (!rr?.success && (_att < 4 || (_hasSession && _att < RUST_RESUME_MAX_ATTEMPTS)) && RUST_RETRYABLE_RE.test(String(rr?.error || ''))) {
          await markFailed(cmi, 'rust:' + String(rr?.error || 'network'), { kind: 'transient' });
          _emit(p, cmi, 0, 'queued');
          return;
        }
        if (rr?.success && rr.cdn_url) {
          const _m = { m_via: _via || 'rust_us', m_base: _base || '', m_up_ms: Date.now() - _upT0, m_up_end: Date.now(), m_tries: _tries.get(String(cmi)) || 1 };
          p = { ...p, cdn_url: rr.cdn_url, server_size: rr.size || size, server_file_name: rr.filename || p.file_name, ..._m };
          await markUploadReady(cmi, { cdn_url: p.cdn_url, server_size: p.server_size, server_file_name: p.server_file_name, rust_upload_id: null, ..._m });
          if (ctrl.signal.aborted) return;
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
          if (k === 'hard') hardFailed = true;
          await markFailed(cmi, e, { kind: k });
          _emit(p, cmi, 0, k === 'hard' ? 'failed' : 'queued');
          return;
        }
        if (ctrl.signal.aborted || r?.aborted) return;
        if (r?.success && r.data) {
          const msg = r.data.message || r.data;
          await markSent(cmi, msg?.id ?? null);
          _publish(p, cmi, r);
          // [2026-10-23 midia-wa] PHP sobe + grava junto (t_commit incluso no t_up).
          await onCommitted({ ...p, client_message_id: cmi, m_via: 'php', m_up_ms: Date.now() - _upT0, m_up_end: Date.now(), m_tries: _tries.get(String(cmi)) || 1 }, msg);
          return;
        }
        const k = _kindFor(r, null);
        const _why = String(r?.message || r?.error || 'upload_failed');
        const _tooBig = r?.data?.code === 'file_too_large' || TOO_LARGE_RE.test(_why);
        if (k === 'hard' || _tooBig) hardFailed = true;
        await markFailed(cmi, _tooBig ? TOO_LARGE_REASON : _why, { kind: _tooBig ? 'hard' : k });
        _emit(p, cmi, 0, (k === 'hard' || _tooBig) ? 'failed' : 'queued');
        return;
      }
    } else {
      if (ctrl.signal.aborted) return;
      // [2026-10-23 midia-wa] cdn_url já veio (pré-upload da prévia / tentativa anterior).
      await markUploadReady(cmi, p.m_via === 'pre' ? { m_tries: _tries.get(String(cmi)) || 1 } : null);
    }
    // [2026-10-12 P2] cancelado durante o upload/markUploadReady → não promove.
    if (ctrl.signal.aborted) return;

    // 3. Bytes on the CDN → hand to the ordered chat_send FIFO.
    _emit(p, cmi, 100, 'commit');
    const promoted = await promoteReady(conv);
    if (promoted.length) {
      try { require('./sendWorker').poke?.(); } catch {}
    }
  } catch (e) {
    if (ctrl.signal.aborted) return;
    const k = _kindFor(null, e);
    if (k === 'hard') hardFailed = true;
    await markFailed(cmi, e, { kind: k });
    _emit(p, cmi, 0, k === 'hard' ? 'failed' : 'queued');
  } finally {
    clearInterval(hb);
    _running.delete(cmi);
    _endBg(bg);
    if (hardFailed && conv != null) {
      try {
        const pr = await promoteReady(conv);
        if (pr.length) { try { require('./sendWorker').poke?.(); } catch {} }
      } catch {}
    }
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

function _prepAheadActive() {
  let n = 0;
  for (const [, e] of _prepAhead) if (!e.done) n++;
  return n;
}

/** [2026-10-23 midia-wa] Comprime o próximo item enquanto outros sobem. A linha
 *  continua 'queued' no outbox (não é reivindicada); o _process dela espera/usa
 *  o resultado. Ordem do chat_send intocada (promoteReady ordena por seq). */
function _startPrepAhead(row) {
  const cmi = row.client_message_id;
  const ctrl = new AbortController();
  const e = { ctrl, promise: null, done: false };
  e.promise = _prepare(row, row.payload || {}, ctrl.signal).catch(() => null);
  _prepAhead.set(cmi, e);
  e.promise.finally(() => {
    e.done = true;
    setTimeout(() => { if (_prepAhead.get(cmi) === e) _prepAhead.delete(cmi); }, 120000);
    setTimeout(() => { drain(); }, 0);
  });
}

async function _drainOnce() {
  if (Platform.OS === 'web') return;
  // [2026-10-09 net-resilience] enlace lento: 1 upload por vez (2 disputando o
  // uplink de 2G/3G atrasam os dois e o texto/recibo junto).
  // [2026-10-23 midia-wa] rápido: 3 (pipeline v2) — kill → 2.
  const v2 = _pipeV2();
  const max = _slowLink() ? 1 : _maxConcurrent();
  const free = max - _running.size;
  const prepFree = v2 ? PREP_AHEAD_MAX - _prepAheadActive() : 0;
  if (free > 0 || prepFree > 0) {
    const rows = await dequeueUploads(v2 ? max * 2 + PREP_AHEAD_MAX + 2 : MAX_CONCURRENT * 2);
    let launched = 0;
    const left = [];
    for (const row of rows) {
      if (_running.has(row.client_message_id)) continue;
      if (launched >= free) { left.push(row); continue; }
      const claimed = await markSending(row.client_message_id);
      if (!claimed) continue;
      launched++;
      _process(row).finally(() => { setTimeout(() => { drain(); }, 0); });
    }
    if (v2) {
      let pf = PREP_AHEAD_MAX - _prepAheadActive();
      for (const row of left) {
        if (pf <= 0) break;
        const p = row.payload || {};
        const cmi = row.client_message_id;
        if (p.prepared || p._blob_lost || _running.has(cmi) || _prepAhead.has(cmi)) continue;
        if (p.type !== 'image' && p.type !== 'video') continue;
        pf--;
        _startPrepAhead(row);
      }
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
 * file_size, caption, view_once, hd, quality ('standard'|'hd'|'full'),
 * quality_explicit (picked in the preview), sender_email, created_at, duration.
 */
export async function enqueueMedia(payload) {
  if (Platform.OS === 'web' || !payload) return null;
  // [2026-10-08 upload-br] user is chatting → photo backup yields (governor).
  try { require('./backup/uploadGovernor').noteChatActivity?.(); } catch {}
  // [2026-10-18 durable-src] Copy the picker/recorder original into
  // chat-outbox/ NOW, before compression: the OS may purge its temp/cache file
  // if the app is killed mid-compress, which used to end in a permanent
  // 'file_missing' "!". _prepare compresses from this copy; onCommitted/cancel
  // delete it.
  let _srcCopy = null;
  try {
    const src = payload.local_uri || payload.uri;
    if (src && payload.client_message_id && !payload.durable_name && !payload.src_durable && !/^(https?|blob|data):/i.test(String(src))) {
      _srcCopy = await _makeDurable(String(payload.client_message_id) + '_src', src, payload.file_name, payload.mime_type, false);
      if (_srcCopy) {
        const FS = _FS();
        payload = { ...payload, src_durable: _srcCopy, durable_name: _srcCopy, orig_uri: src, local_uri: FS.documentDirectory + DURABLE_DIR + _srcCopy };
      }
    }
  } catch { _srcCopy = null; }
  // [e2ee5 WP-11] estado da conversa conhecido ANTES de gravar (a linha de conversa E2EE guarda a legenda
  // só no rascunho cifrável e nunca vai à fila nativa/upload em claro).
  try { const _e5 = require('./e2ee/e2ee5'); if (_e5.isOn() && payload.conversation_id != null && _e5.convModeSync(payload.conversation_id) == null) await _e5.convState(payload.conversation_id); } catch {}
  const r = await enqueue(payload, { lane: 'upload' });
  if (!r && _srcCopy) { try { await _deleteDurable({ durable_name: _srcCopy }); } catch {} }
  if (r) {
    _emit(payload, payload.client_message_id, 0, 'queued');
    // [2026-10-23 midia-wa] LQIP + blurhash locais em paralelo à compressão/upload (nunca em claro p/ E2EE: mediaMetaFields filtra).
    try { require('./sendWorker').kickClientMeta?.(payload); } catch {}
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
  // [2026-10-23 midia-wa] preparo antecipado em curso também para.
  try { const pa = _prepAhead.get(key); if (pa) { pa.ctrl.abort(); _prepAhead.delete(key); } } catch {}
  let p = null;
  try { p = (await getStatus(key))?.payload || null; } catch {}
  // [2026-10-23 midia-wa] contrato B: o pré-upload desse original não serve mais.
  try { if (p?.orig_uri && !p.pre_tried) _pre()?.discard?.(p.orig_uri); } catch {}
  // [2026-10-23 midia-wa] contrato A: aborta o upload em partes direto no R2 (não fica órfão).
  try { require('./r2DirectUpload').abortDirect?.(key)?.catch?.(() => {}); } catch {}
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
  for (const [, e] of _prepAhead) { try { e.ctrl.abort(); } catch {} }
  _prepAhead.clear();
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
