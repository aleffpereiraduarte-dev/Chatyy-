// services/videoFirstFrame.js — [2026-10-18 vthumb] poster LOCAL p/ vídeo recebido sem thumbnail.
//
// Quando a linha do chat chega sem thumbnail_url/thumb_b64 (poster do servidor
// falhou — ex.: host sem ffmpeg), a bolha ficava cinza com o play. Aqui o
// aparelho extrai o 1º frame da URL remota (ExpoNativeVideo.generateThumbnail:
// iOS AVAssetImageGenerator lê só o necessário por range; Android precisa do
// binário com o fix de setDataSource remoto), guarda o JPEG em
// cacheDirectory/video-first-frame/ e indexa url → file:// no MMKV (sobrevive a
// reabrir o app). 1 extração por vez, falha cacheada por 30 min.
//
// API:
//   getVideoFirstFrameSync(url) → 'file://…' | null
//   requestVideoFirstFrame(url) → Promise<'file://…' | null>
//   subscribeVideoFirstFrame(fn) → unsubscribe   (fn(url, fileUri) quando fica pronto)
//   isVideoFirstFrameOn()      → kill switch OTA (globalThis.__chatyy_video_first_frame === false desliga)

import { Platform } from 'react-native';

const MMKV_KEY = 'video_first_frame_v1';
const MAX_ENTRIES = 400;
const FAIL_TTL_MS = 30 * 60 * 1000;
const TIMEOUT_MS = 15000;

const _map = new Map(); // url → file uri
const _fail = new Map(); // url → ts
const _inflight = new Map(); // url → Promise
const _queue = [];
const _subs = new Set();
let _active = 0;
let _hydrated = false;
let _persistTimer = null;

export function isVideoFirstFrameOn() {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return false;
  try { return globalThis.__chatyy_video_first_frame !== false; } catch { return true; }
}

function _mmkv() { try { return require('./mmkv'); } catch { return null; } }
function _fs() {
  try { return require('expo-file-system/legacy'); } catch { try { return require('expo-file-system'); } catch { return null; } }
}
function _nativeVideo() {
  try {
    const m = require('../modules/expo-native-video').default;
    return m && typeof m.isAvailable === 'function' && m.isAvailable() ? m : null;
  } catch { return null; }
}

function _hydrate() {
  if (_hydrated) return;
  _hydrated = true;
  const s = _mmkv();
  if (!s || typeof s.getJSON !== 'function') return;
  try {
    const obj = s.getJSON(MMKV_KEY);
    if (obj && typeof obj === 'object') {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof k === 'string' && typeof v === 'string' && v.startsWith('file:')) _map.set(k, v);
      }
    }
  } catch {}
}

function _schedulePersist() {
  if (_persistTimer) return;
  _persistTimer = setTimeout(() => {
    _persistTimer = null;
    const s = _mmkv();
    if (!s || typeof s.setJSON !== 'function') return;
    try {
      const all = [..._map.entries()];
      const obj = {};
      for (let i = Math.max(0, all.length - MAX_ENTRIES); i < all.length; i++) obj[all[i][0]] = all[i][1];
      s.setJSON(MMKV_KEY, obj);
    } catch {}
  }, 2000);
}

function _hash(str) {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
    h2 = Math.imul(h2 + c, 2246822519) >>> 0;
  }
  return h1.toString(16) + h2.toString(16);
}

export function getVideoFirstFrameSync(url) {
  if (!url || typeof url !== 'string') return null;
  _hydrate();
  return _map.get(url) || null;
}

export function subscribeVideoFirstFrame(fn) {
  if (typeof fn !== 'function') return () => {};
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

function _emit(url, file) {
  for (const fn of Array.from(_subs)) { try { fn(url, file); } catch {} }
}

function _pump() {
  while (_active < 1 && _queue.length) {
    const job = _queue.shift();
    _active++;
    _extract(job.url).then((r) => { job.resolve(r); }, () => { job.resolve(null); }).finally(() => {
      _active = Math.max(0, _active - 1);
      _pump();
    });
  }
}

async function _extract(url) {
  const NV = _nativeVideo();
  const FS = _fs();
  if (!NV || typeof NV.generateThumbnail !== 'function' || !FS) return null;
  const grab = async (atMs) => {
    const r = await Promise.race([
      NV.generateThumbnail(url, atMs, 640),
      new Promise((_, rej) => setTimeout(() => rej(new Error('vff_timeout')), TIMEOUT_MS)),
    ]);
    return r && typeof r.uri === 'string' ? r.uri : null;
  };
  let tmp = null;
  try { tmp = await grab(500); } catch {}
  if (!tmp) { try { tmp = await grab(0); } catch {} }
  if (!tmp) return null;
  try {
    const base = FS.cacheDirectory;
    if (!base) return tmp;
    const dir = base + 'video-first-frame/';
    try { await FS.makeDirectoryAsync(dir, { intermediates: true }); } catch {}
    const dest = dir + _hash(url) + '.jpg';
    try { await FS.deleteAsync(dest, { idempotent: true }); } catch {}
    await FS.moveAsync({ from: tmp, to: dest });
    return dest.startsWith('file:') ? dest : 'file://' + dest;
  } catch {
    return tmp && tmp.startsWith('file:') ? tmp : null;
  }
}

export function requestVideoFirstFrame(url) {
  if (!url || typeof url !== 'string' || !/^(https?:\/\/|file:)/i.test(url) || !isVideoFirstFrameOn()) return Promise.resolve(null);
  _hydrate();
  const have = _map.get(url);
  if (have) return Promise.resolve(have);
  const f = _fail.get(url);
  if (f && Date.now() - f < FAIL_TTL_MS) return Promise.resolve(null);
  if (_inflight.has(url)) return _inflight.get(url);
  const p = new Promise((resolve) => { _queue.push({ url, resolve }); _pump(); }).then((file) => {
    _inflight.delete(url);
    if (file) {
      _map.delete(url);
      _map.set(url, file);
      if (_map.size > MAX_ENTRIES + 50) {
        const drop = _map.size - MAX_ENTRIES;
        let i = 0;
        for (const k of _map.keys()) { if (i++ >= drop) break; _map.delete(k); }
      }
      _schedulePersist();
      _emit(url, file);
    } else {
      _fail.set(url, Date.now());
      if (_fail.size > 500) { try { _fail.delete(_fail.keys().next().value); } catch {} }
    }
    return file || null;
  });
  _inflight.set(url, p);
  return p;
}
