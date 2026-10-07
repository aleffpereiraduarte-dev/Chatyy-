// [2026-10-08 email-outbox] Durable e-mail outbox ("Caixa de saída").
//
// When the device is offline, an attachment is still uploading, or `send`
// fails with a network/5xx error, the composer hands the message here instead
// of losing it. Entries persist in AsyncStorage NAMESPACED PER ACCOUNT
// (email_outbox_v1_<fnv(account)>) — the 2026-10-05 cross-account cache leak
// came from a global key; every entry also carries `account` and is only ever
// sent while that account is the active one (its bearer is the one in use).
//
// Idempotency: each entry keeps ONE client_send_id (csid) for its whole life;
// the server dedupes `send` on it (Redis, 7d), so a retry after a lost
// response returns the original result instead of sending twice.
//
// Drain triggers: enqueue, app foreground, network reconnect, account switch,
// boot (initEmailOutbox), manual "Tentar agora", and a backoff timer.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, AppState } from 'react-native';
import { accountKeyHash, normAccount } from './chatStore/schema';

const KEY_PREFIX = 'email_outbox_v1_';
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const UNDO_WINDOW_MS = 2 * 60 * 1000;   // outbox sends keep the Undo window only if still "fresh"

const _lists = new Map();      // account -> entries[] (loaded)
const _loading = new Map();    // account -> Promise
const _subs = new Set();
const _memFiles = new Map();   // csid -> { [index]: File }   (web: File objects can't be persisted)
let _draining = null;
let _timer = null;
let _inited = false;

function _api() { return require('./api'); }

function _activeAccount() {
  try { return normAccount(_api().getActiveAccountEmail?.() || ''); } catch { return ''; }
}

function _storageKey(acct) { return KEY_PREFIX + accountKeyHash(acct); }

function _emit() {
  const acct = _activeAccount();
  const list = (acct && _lists.get(acct)) || [];
  _subs.forEach((fn) => { try { fn(list); } catch {} });
}

export function subscribeEmailOutbox(fn) {
  _subs.add(fn);
  // push current snapshot (loads lazily for the active account)
  _load(_activeAccount()).then(() => { try { fn(getEmailOutbox()); } catch {} }).catch(() => {});
  return () => { _subs.delete(fn); };
}

export function getEmailOutbox() {
  const acct = _activeAccount();
  return (acct && _lists.get(acct)) || [];
}

async function _load(acct) {
  if (!acct) return [];
  if (_lists.has(acct)) return _lists.get(acct);
  if (_loading.has(acct)) return _loading.get(acct);
  const p = (async () => {
    let arr = [];
    try {
      const raw = await AsyncStorage.getItem(_storageKey(acct));
      const parsed = raw ? JSON.parse(raw) : [];
      // Defense in depth: drop anything not owned by this account.
      arr = Array.isArray(parsed) ? parsed.filter((e) => e && e.csid && normAccount(e.account) === acct) : [];
    } catch {}
    // 'sending' rows were orphaned by an app kill — safe to requeue (csid dedupe).
    arr.forEach((e) => { if (e.status === 'sending') e.status = 'queued'; });
    if (!_lists.has(acct)) _lists.set(acct, arr);
    _loading.delete(acct);
    return _lists.get(acct);
  })();
  _loading.set(acct, p);
  return p;
}

async function _persist(acct) {
  if (!acct) return;
  const list = _lists.get(acct) || [];
  const clean = list.map((e) => ({
    ...e,
    attachments: (e.attachments || []).map(({ _raw, _akey, ...rest }) => rest),
  }));
  try {
    if (clean.length) await AsyncStorage.setItem(_storageKey(acct), JSON.stringify(clean));
    else await AsyncStorage.removeItem(_storageKey(acct));
  } catch {}
}

function _newCsid() {
  const rnd = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return 'em' + Date.now().toString(36) + rnd;
}
export function newClientSendId() { return _newCsid(); }

function _FS() { try { return Platform.OS === 'web' ? null : require('expo-file-system/legacy'); } catch { return null; } }

// Native: copy local attachment files into documentDirectory so they survive
// cache eviction / app restarts until the message is sent.
async function _makeDurable(csid, atts) {
  const FS = _FS();
  const out = [];
  for (let i = 0; i < atts.length; i++) {
    const a = { ...atts[i] };
    if (Platform.OS === 'web') {
      if (a._raw && !a.server_id) {
        const m = _memFiles.get(csid) || {};
        m[i] = a._raw;
        _memFiles.set(csid, m);
      }
    } else if (FS && a.uri && !a.is_drive_ref && /^file:/.test(a.uri)) {
      try {
        const dir = FS.documentDirectory + 'email-outbox/' + csid + '/';
        await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
        const safe = String(a.name || 'file').replace(/[^\w.\-]+/g, '_').slice(0, 80);
        const dest = dir + i + '_' + safe;
        await FS.copyAsync({ from: a.uri, to: dest });
        a.uri = dest;
        a.durable = true;
      } catch {}
    }
    out.push(a);
  }
  return out;
}

async function _dropFiles(csid) {
  _memFiles.delete(csid);
  const FS = _FS();
  if (!FS) return;
  try { await FS.deleteAsync(FS.documentDirectory + 'email-outbox/' + csid + '/', { idempotent: true }); } catch {}
}

/**
 * Enqueue a message. `msg` = { csid?, to, cc, bcc, subject, body, replyUid,
 * folder, trackOpens, fromAlias, undoDelay, attachments, restore, reason }.
 * Returns the entry. Kicks a drain right away.
 */
export async function enqueueEmail(msg) {
  const acct = _activeAccount();
  if (!acct) throw new Error('no active account');
  await _load(acct);
  const csid = msg.csid || _newCsid();
  const attachments = await _makeDurable(csid, (msg.attachments || []).map((a) => ({
    name: a.name, size: a.size || 0, type: a.type || 'application/octet-stream',
    uri: a.uri || '', _raw: a._raw, _akey: a._akey,
    server_id: a.server_id || undefined,
    is_drive_ref: !!a.is_drive_ref, drive_id: a.drive_id, drive_url: a.drive_url,
  })));
  const now = Date.now();
  const entry = {
    csid, account: acct, createdAt: now, updatedAt: now,
    status: 'queued', attempts: 0, nextAt: 0, lastError: '', reason: msg.reason || '',
    to: msg.to || '', cc: msg.cc || '', bcc: msg.bcc || '',
    subject: msg.subject || '', body: msg.body || '',
    replyUid: msg.replyUid || null, folder: msg.folder || 'INBOX',
    trackOpens: !!msg.trackOpens, fromAlias: msg.fromAlias || '',
    undoDelay: Math.max(0, parseInt(msg.undoDelay, 10) || 0),
    attachments,
    restore: msg.restore ? _plainRestore(msg.restore) : null,
  };
  const list = _lists.get(acct) || [];
  const existing = list.findIndex((e) => e.csid === csid);
  if (existing >= 0) list[existing] = entry; else list.push(entry);
  _lists.set(acct, list);
  await _persist(acct);
  _emit();
  setTimeout(() => { drainEmailOutbox().catch(() => {}); }, 0);
  return entry;
}

function _plainRestore(r) {
  const pick = (arr) => (Array.isArray(arr) ? arr.map((c) => ({ email: c?.email || '', name: c?.name || '' })).filter((c) => c.email) : []);
  return { to: pick(r.to), cc: pick(r.cc), bcc: pick(r.bcc), subject: r.subject || '', body: r.body || '' };
}

async function _update(acct, csid, patch) {
  const list = _lists.get(acct);
  if (!list) return null;
  const e = list.find((x) => x.csid === csid);
  if (!e) return null;
  Object.assign(e, patch, { updatedAt: Date.now() });
  await _persist(acct);
  _emit();
  return e;
}

async function _remove(acct, csid) {
  const list = _lists.get(acct);
  if (!list) return;
  const i = list.findIndex((x) => x.csid === csid);
  if (i >= 0) list.splice(i, 1);
  await _persist(acct);
  _emit();
  _dropFiles(csid);
}

export async function deleteOutboxEmail(csid) {
  const acct = _activeAccount();
  await _load(acct);
  const e = (_lists.get(acct) || []).find((x) => x.csid === csid);
  if (!e || e.status === 'sending') return false;
  await _remove(acct, csid);
  return true;
}

export async function retryOutboxEmail(csid) {
  const acct = _activeAccount();
  await _load(acct);
  const e = (_lists.get(acct) || []).find((x) => x.csid === csid);
  if (!e || e.status === 'sending') return;
  await _update(acct, csid, { status: 'queued', nextAt: 0, lastError: '' });
  drainEmailOutbox().catch(() => {});
}

// Takes the entry OUT of the outbox and returns a composer restore payload
// (same shape as the Undo restore) so the user can edit it.
export async function takeOutboxEmailForEdit(csid) {
  const acct = _activeAccount();
  await _load(acct);
  const e = (_lists.get(acct) || []).find((x) => x.csid === csid);
  if (!e || e.status === 'sending') return null;
  const mem = _memFiles.get(csid) || {};
  const r = e.restore || { to: _splitAddrs(e.to), cc: _splitAddrs(e.cc), bcc: _splitAddrs(e.bcc), subject: e.subject, body: e.body };
  const attachments = (e.attachments || []).map((a, i) => {
    const out = { name: a.name, size: a.size, type: a.type, uri: a.uri };
    if (mem[i]) out._raw = mem[i];
    if (a.server_id) out.server_id = a.server_id;
    if (a.is_drive_ref) Object.assign(out, { is_drive_ref: true, drive_id: a.drive_id, drive_url: a.drive_url });
    return out;
  });
  // Keep native durable copies on disk: the composer re-uploads from them.
  const list = _lists.get(acct) || [];
  const i = list.findIndex((x) => x.csid === csid);
  if (i >= 0) list.splice(i, 1);
  await _persist(acct);
  _emit();
  _memFiles.delete(csid);
  return { ...r, attachments };
}

function _splitAddrs(s) {
  return String(s || '').split(/[,;]/).map((x) => x.trim()).filter(Boolean).map((x) => {
    const m = x.match(/^(.*)<([^>]+)>$/);
    return m ? { name: m[1].trim().replace(/^"|"$/g, ''), email: m[2].trim() } : { name: '', email: x };
  });
}

function _isOffline() {
  try {
    if (Platform.OS === 'web') return typeof navigator !== 'undefined' && navigator.onLine === false;
    const st = require('./networkInfo').getNetworkState?.();
    return !!st && st.isConnected === false;
  } catch { return false; }
}

export function isEmailDeviceOffline() { return _isOffline(); }

// 'ok' | 'offline' | 'transient' | 'att_expired' | 'hard'
export function classifyEmailSend(r, err) {
  if (err) return (err.offline || /offline/i.test(String(err.message || ''))) ? 'offline' : 'transient';
  if (!r || typeof r !== 'object') return 'transient';
  if (r.success) return 'ok';
  const status = Number(r.__httpStatus || 0);
  const code = r.data && r.data.code;
  if (code === 'att_expired' || status === 410) return 'att_expired';
  if (code === 'send_in_progress' || status === 409) return 'transient';
  const msg = String(r.message || '');
  if (status === 0) return /connection error|offline/i.test(msg) ? 'offline' : 'transient';
  if (status >= 500 || status === 408 || status === 425 || status === 429 || status === 401) return 'transient';
  if (status >= 400) return 'hard';
  if (/^(Connection error|Tempo limite excedido|Servidor indisponivel|Service temporarily unavailable)$/i.test(msg)) return 'transient';
  return 'hard';
}

function _schedule() {
  if (_timer) { clearTimeout(_timer); _timer = null; }
  const list = getEmailOutbox();
  const next = list.filter((e) => e.status === 'queued' && e.nextAt > Date.now()).reduce((m, e) => Math.min(m, e.nextAt), Infinity);
  if (next !== Infinity) {
    _timer = setTimeout(() => { _timer = null; drainEmailOutbox().catch(() => {}); }, Math.max(500, next - Date.now()));
  }
}

function _backoff(attempts) {
  return Math.min(MAX_BACKOFF_MS, 4000 * Math.pow(2, Math.max(0, attempts - 1)));
}

export function drainEmailOutbox() {
  if (_draining) return _draining;
  _draining = (async () => {
    try {
      for (let guard = 0; guard < 50; guard++) {
        const acct = _activeAccount();
        if (!acct) return;
        let hasToken = false;
        try { hasToken = !!_api().getAuthToken?.(); } catch {}
        if (!hasToken) return;
        await _load(acct);
        if (_isOffline()) return;
        const now = Date.now();
        const next = (_lists.get(acct) || [])
          .filter((e) => e.status === 'queued' && (e.nextAt || 0) <= now)
          .sort((a, b) => a.createdAt - b.createdAt)[0];
        if (!next) return;
        const res = await _sendOne(acct, next);
        if (res === 'stop') return;
      }
    } finally {
      _draining = null;
      _schedule();
    }
  })();
  return _draining;
}

// Ensures every attachment has a server_id (or is a Drive ref).
// Returns 'ok' | 'offline' | 'transient' | 'hard:<msg>'
async function _prepareAttachments(acct, e) {
  const up = require('./emailAttachUploads');
  const mem = _memFiles.get(e.csid) || {};
  let changed = false;
  for (let i = 0; i < (e.attachments || []).length; i++) {
    const a = e.attachments[i];
    if (a.is_drive_ref || a.server_id) continue;
    // Upload started by the composer still running in this session → wait.
    if (a._akey && up.getAttachUpload(a._akey)) {
      const st = await up.awaitAttachUpload(a._akey);
      if (st && st.state === 'done' && st.serverId) { a.server_id = st.serverId; changed = true; continue; }
      if (st && st.state === 'waiting') return 'offline';
      // error → fall through to a direct upload from the durable copy
    }
    const file = { name: a.name, size: a.size, type: a.type };
    if (mem[i]) file._raw = mem[i];
    else if (a.uri && !/^blob:/.test(a.uri)) file.uri = a.uri;
    else return 'hard:' + (a.name || 'anexo');
    if (_activeAccount() !== acct) return 'offline';
    const r = await _api().uploadEmailAttachment(file);
    if (r && r.success && r.data && r.data.att_id) { a.server_id = String(r.data.att_id); changed = true; continue; }
    const k = classifyEmailSend(r);
    if (k === 'offline' || k === 'transient') { if (changed) await _persist(acct); return k; }
    return 'hard:' + ((r && r.message) || a.name || 'anexo');
  }
  if (changed) await _persist(acct);
  return 'ok';
}

async function _sendOne(acct, e) {
  await _update(acct, e.csid, { status: 'sending' });
  const prep = await _prepareAttachments(acct, e);
  if (prep !== 'ok') {
    if (prep === 'offline') { await _update(acct, e.csid, { status: 'queued', nextAt: 0 }); return 'stop'; }
    if (prep === 'transient') {
      const attempts = (e.attempts || 0) + 1;
      await _update(acct, e.csid, { status: 'queued', attempts, nextAt: Date.now() + _backoff(attempts), lastError: 'upload' });
      return 'next';
    }
    await _update(acct, e.csid, { status: 'failed', lastError: 'attachment_lost', lastErrorDetail: prep.slice(5) });
    _noticeFailed();
    return 'next';
  }
  // Account switched while preparing → put it back, never send with another bearer.
  if (_activeAccount() !== acct) { await _update(acct, e.csid, { status: 'queued' }); return 'stop'; }
  const fresh = Date.now() - e.createdAt < UNDO_WINDOW_MS;
  const undoDelay = fresh ? (e.undoDelay || 0) : 0;
  let r = null; let err = null;
  try {
    r = await _api().sendEmail(e.to, e.subject, e.body, e.cc, e.bcc, e.replyUid || null, e.folder || 'INBOX',
      (e.attachments || []).map((a) => ({ ...a })), { trackOpens: e.trackOpens, fromAlias: e.fromAlias, undoDelay, clientSendId: e.csid });
  } catch (x) { err = x; }
  const k = classifyEmailSend(r, err);
  if (k === 'ok') {
    await _remove(acct, e.csid);
    const sid = r?.data?.send_id || null;
    const queued = r?.data?.status === 'queued' && !r?.data?.duplicate;
    try {
      const undo = require('./emailUndo');
      if (queued && undoDelay > 0 && sid) {
        undo.startEmailUndo({ sid, seconds: undoDelay, restore: e.restore ? { ...e.restore, attachments: (e.attachments || []).filter((a) => a.server_id || a.is_drive_ref) } : null });
      } else {
        undo.showEmailNotice?.('sent');
      }
    } catch {}
    try { _api().invalidateCache?.('emails'); } catch {}
    return 'next';
  }
  if (k === 'att_expired') {
    const bad = r?.data?.att_id;
    const attachments = (e.attachments || []).map((a) => (bad ? a.server_id === bad : !!a.server_id) ? { ...a, server_id: undefined } : a);
    const attempts = (e.attempts || 0) + 1;
    if (attempts > 6) {
      await _update(acct, e.csid, { status: 'failed', attachments, attempts, lastError: 'attachment_lost' });
      return 'next';
    }
    await _update(acct, e.csid, { status: 'queued', attachments, attempts, nextAt: 0 });
    return 'next';
  }
  if (k === 'offline') {
    await _update(acct, e.csid, { status: 'queued', nextAt: 0, lastError: 'offline' });
    return 'stop';
  }
  if (k === 'transient') {
    const attempts = (e.attempts || 0) + 1;
    await _update(acct, e.csid, { status: 'queued', attempts, nextAt: Date.now() + _backoff(attempts), lastError: String(r?.message || err?.message || 'network') });
    return 'next';
  }
  await _update(acct, e.csid, { status: 'failed', lastError: String(r?.message || 'send_failed') });
  _noticeFailed();
  return 'next';
}

// Swap a lingering "Enviando…" notice for the Outbox one (has a "Ver" button).
function _noticeFailed() {
  try { require('./emailUndo').showEmailNotice('outbox'); } catch {}
}

// Wire triggers once (called from the globally mounted EmailUndoBar).
export function initEmailOutbox() {
  if (_inited) return;
  _inited = true;
  try {
    AppState.addEventListener('change', (s) => { if (s === 'active') drainEmailOutbox().catch(() => {}); });
  } catch {}
  try {
    require('./networkInfo').onNetworkChange?.((st) => {
      if (st && st.isConnected) {
        // Network back: retry everything that was waiting, now.
        const acct = _activeAccount();
        (_lists.get(acct) || []).forEach((e) => { if (e.status === 'queued') e.nextAt = 0; });
        setTimeout(() => drainEmailOutbox().catch(() => {}), 800);
      }
    });
  } catch {}
  // Account switch / late token: poll cheaply for a changed active account.
  let lastAcct = _activeAccount();
  setInterval(() => {
    const a = _activeAccount();
    if (a !== lastAcct) {
      lastAcct = a;
      _load(a).then(() => { _emit(); drainEmailOutbox().catch(() => {}); }).catch(() => {});
    }
  }, 5000);
  setTimeout(() => { _load(_activeAccount()).then(() => { _emit(); drainEmailOutbox().catch(() => {}); }).catch(() => {}); }, 2500);
}
