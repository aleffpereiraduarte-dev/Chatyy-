// [2026-10-08 email-outbox] Gmail-style attachment pre-upload manager.
//
// Module-level (NOT tied to the composer component) so an upload keeps going
// after the composer closes — the e-mail outbox awaits it before sending.
// Each picked attachment gets a key (`_akey`); state lives here:
//   { state: 'uploading'|'done'|'error'|'waiting', progress: 0..1,
//     serverId, error, attempts }
// 'waiting' = device offline; resumes automatically on reconnect.
// Transient failures auto-retry (3x backoff); definitive ones (413/429/4xx)
// stop at 'error' and the picker offers a manual retry.
import { Platform } from 'react-native';

const MAX_CONCURRENT = 2;
const MAX_AUTO_ATTEMPTS = 3;

const _items = new Map();      // key -> { file, state, progress, serverId, error, attempts, ctrl, waiters }
const _subs = new Set();
let _running = 0;
const _queue = [];             // keys waiting for a slot
let _seq = 0;
let _netHooked = false;

function _api() { return require('./api'); }

function _emit(key) {
  _subs.forEach((fn) => { try { fn(key); } catch {} });
}

export function subscribeAttachUploads(fn) {
  _subs.add(fn);
  return () => { _subs.delete(fn); };
}

export function getAttachUpload(key) {
  const it = key ? _items.get(key) : null;
  if (!it) return null;
  return { state: it.state, progress: it.progress, serverId: it.serverId || null, error: it.error || '' };
}

function _isOffline() {
  try {
    if (Platform.OS === 'web') return typeof navigator !== 'undefined' && navigator.onLine === false;
    const ni = require('./networkInfo');
    const st = ni?.getNetworkState?.();
    return !!st && st.isConnected === false;
  } catch { return false; }
}

function _hookNetwork() {
  if (_netHooked) return;
  _netHooked = true;
  try {
    require('./networkInfo').onNetworkChange?.((st) => {
      if (st && st.isConnected) resumeWaitingUploads();
    });
  } catch {}
}

export function resumeWaitingUploads() {
  for (const [key, it] of _items) {
    if (it.state === 'waiting') { it.state = 'uploading'; it.progress = 0; _enqueue(key); _emit(key); }
  }
}

function _settle(it) {
  const ws = it.waiters.splice(0);
  ws.forEach((w) => { try { w(getAttachUploadFromItem(it)); } catch {} });
}
function getAttachUploadFromItem(it) {
  return { state: it.state, progress: it.progress, serverId: it.serverId || null, error: it.error || '' };
}

function _enqueue(key) {
  if (!_queue.includes(key)) _queue.push(key);
  _pump();
}

function _pump() {
  while (_running < MAX_CONCURRENT && _queue.length) {
    const key = _queue.shift();
    const it = _items.get(key);
    if (!it || it.state !== 'uploading') continue;
    _running++;
    _run(key, it).finally(() => { _running--; _pump(); });
  }
}

async function _run(key, it) {
  if (_isOffline()) {
    it.state = 'waiting';
    _emit(key);
    _settle(it);
    return;
  }
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  it.ctrl = ctrl;
  it.attempts += 1;
  let r = null;
  try {
    r = await _api().uploadEmailAttachment(it.file, {
      signal: ctrl ? ctrl.signal : undefined,
      onProgress: (p) => {
        if (_items.get(key) !== it || it.state !== 'uploading') return;
        // throttle re-renders to ~2% steps
        if (p - it.progress >= 0.02 || p >= 0.99) { it.progress = p; _emit(key); }
      },
    });
  } catch (e) {
    r = { success: false, message: 'Connection error' };
  }
  it.ctrl = null;
  if (_items.get(key) !== it) return;          // removed meanwhile
  if (it.state === 'cancelled') return;
  if (r && r.success && r.data && r.data.att_id) {
    it.state = 'done';
    it.progress = 1;
    it.serverId = String(r.data.att_id);
    it.error = '';
    _emit(key);
    _settle(it);
    return;
  }
  if (r && r.aborted) return;
  const status = Number((r && r.__httpStatus) || 0);
  const transient = status === 0 || status >= 500 || status === 408 || status === 401;
  if (transient && _isOffline()) {
    it.state = 'waiting';
    it.progress = 0;
    _emit(key);
    _settle(it);
    return;
  }
  if (transient && it.attempts < MAX_AUTO_ATTEMPTS) {
    it.progress = 0;
    _emit(key);
    const wait = 1200 * Math.pow(2, it.attempts - 1);
    setTimeout(() => { if (_items.get(key) === it && it.state === 'uploading') _enqueue(key); }, wait);
    return;
  }
  it.state = 'error';
  it.error = (r && r.message) || 'Falha no envio do anexo';
  it.transient = transient;
  _emit(key);
  _settle(it);
}

// Registers an attachment and starts uploading it. Returns its key.
// Drive refs are not pre-uploaded (the send path materializes them).
export function startAttachUpload(file) {
  _hookNetwork();
  const key = `att_${Date.now().toString(36)}_${(++_seq).toString(36)}`;
  const it = {
    file, state: 'uploading', progress: 0, serverId: null, error: '', attempts: 0, ctrl: null, waiters: [],
  };
  if (file && typeof file.server_id === 'string' && file.server_id) {
    it.state = 'done'; it.progress = 1; it.serverId = file.server_id;
    _items.set(key, it);
    return key;
  }
  if (!file || file.is_drive_ref || (!file.uri && !file._raw)) {
    it.state = 'done'; it.progress = 1;
    _items.set(key, it);
    return key;
  }
  _items.set(key, it);
  _enqueue(key);
  _emit(key);
  return key;
}

export function retryAttachUpload(key) {
  const it = _items.get(key);
  if (!it || it.state === 'done' || it.state === 'uploading') return;
  it.state = 'uploading';
  it.progress = 0;
  it.error = '';
  it.attempts = 0;
  _enqueue(key);
  _emit(key);
}

// Cancel + forget. Best-effort deletes the server copy when already uploaded.
export function cancelAttachUpload(key, { deleteRemote = true } = {}) {
  const it = _items.get(key);
  if (!it) return;
  it.state = 'cancelled';
  try { it.ctrl?.abort(); } catch {}
  _items.delete(key);
  const qi = _queue.indexOf(key);
  if (qi >= 0) _queue.splice(qi, 1);
  _settle(it);
  if (deleteRemote && it.serverId) { _api().deleteEmailAttachment(it.serverId).catch?.(() => {}); }
  _emit(key);
}

// Resolves once the upload is settled ('done' | 'error'). 'waiting' (offline)
// resolves immediately with that state so callers can park the send.
export function awaitAttachUpload(key, { timeoutMs = 0 } = {}) {
  const it = _items.get(key);
  if (!it) return Promise.resolve(null);
  if (it.state === 'done' || it.state === 'error' || it.state === 'waiting') return Promise.resolve(getAttachUploadFromItem(it));
  return new Promise((resolve) => {
    let t = null;
    const w = (v) => { if (t) clearTimeout(t); resolve(v); };
    it.waiters.push(w);
    if (timeoutMs > 0) {
      t = setTimeout(() => {
        const i = it.waiters.indexOf(w);
        if (i >= 0) it.waiters.splice(i, 1);
        resolve(getAttachUploadFromItem(it));
      }, timeoutMs);
    }
  });
}

// Snapshot of a composer attachment with its server id applied (if any).
export function withServerId(att) {
  if (!att) return att;
  const st = att._akey ? getAttachUpload(att._akey) : null;
  if (st && st.serverId) return { ...att, server_id: st.serverId };
  return att;
}
