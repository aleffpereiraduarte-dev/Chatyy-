// [2026-10-07 bgsync] Background message journal → local store merge.
//
// WhatsApp / Signal model: when a message arrives while the app is backgrounded
// or killed, the OS-woken native code stores it on the device so opening the
// app shows it instantly, with no loading:
//   - Android: CallFirebaseMessagingService (high-priority FCM data push) and
//     ChatBgSyncWorker (WorkManager, ~15 min) append to a JSONL journal
//     (modules/expo-callkit/android/.../ChatBgJournal.kt).
//   - iOS: the Notification Service Extension and the chat BGAppRefreshTask
//     append to the same format in the App Group container
//     (modules/expo-callkit/ios/ChatBgJournal.swift, plugins/notification-service).
//
// This module merges that journal into the expo-sqlite store SYNCHRONOUSLY
// (sqliteStore's sync handle) right before the chat list's first read
// (chatStore.getConversationsSync → mergeSync) and again on every foreground,
// then the normal WS resume + delta sync (chatSync.js) reconciles. Idempotent:
// messages are INSERT OR IGNORE by server id (a later delta-sync INSERT OR
// REPLACE upgrades them), a conversation is only touched when the journal
// carries a NEWER message than the local last_message. Cursors (pts) are never
// advanced from here — the server stays the source of truth.
//
// Pure planning (parseJournal / planMerge) is separated from IO so it is
// unit-testable in Node (scratchpad harness).
//
// Never throws; every native call is feature-detected (old binaries = no-op).

import { Platform } from 'react-native';
import { normAccount } from './chatStore/schema';

const isWeb = Platform.OS === 'web';
export const MERGED_EVENT = 'chatyy:bgJournalMerged';
const MAX_AGE_MS = 7 * 24 * 3600 * 1000; // stale lines (unknown/old accounts) are dropped
const MAX_LINES = 2000;                   // hard bound for the pre-paint merge

// Server/push e-mails may still use the legacy domain (mirror of
// ChatNotifStore.normEmail on Android).
export function canonAcct(e) {
  return normAccount(e).replace(/@onemundo\.com\.br$/, '@chatyy.com.br');
}

const _num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const _str = (v) => (v == null ? '' : String(v));

// ─── Pure: parse ─────────────────────────────────────────────────────────────
/** @returns {{raw:string, e:object}[]} valid journal lines, in file order. */
export function parseJournal(text) {
  const out = [];
  if (!text || typeof text !== 'string') return out;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < MAX_LINES; i++) {
    const raw = lines[i];
    if (!raw || raw.charCodeAt(0) !== 123 /* { */) continue;
    try {
      const e = JSON.parse(raw);
      if (e && typeof e === 'object' && _num(e.cid) > 0 && _num(e.mid) > 0) out.push({ raw, e });
    } catch {}
  }
  return out;
}

function _createdAt(e) {
  const ts = _str(e.ts);
  if (ts) return ts;
  const at = _num(e.at);
  try { return new Date(at > 0 ? at : Date.now()).toISOString(); } catch { return ''; }
}

/** Server-shaped message row (same keys as chat_sync hydration). */
export function rowFromEntry(e) {
  const created = _createdAt(e);
  return {
    id: _num(e.mid),
    conversation_id: _num(e.cid),
    sender_email: _str(e.sender),
    sender_name: _str(e.sname),
    content: _str(e.text),
    type: _str(e.type) || 'text',
    reply_to_id: _num(e.reply) || null,
    reply_quote_text: e.rquote ? _str(e.rquote) : null,
    file_url: e.furl ? _str(e.furl) : null,
    file_name: e.fname ? _str(e.fname) : null,
    file_size: _num(e.fsize) || null,
    image_width: _num(e.w) || null,
    image_height: _num(e.h) || null,
    duration: e.dur != null && e.dur !== '' ? _num(e.dur) : null,
    thumbnail_url: e.thumb ? _str(e.thumb) : null,
    client_message_id: e.cmid ? _str(e.cmid) : null,
    created_at: created,
    edited_at: null,
    deleted_at: null,
    _bg: _str(e.src) || 'bg',
  };
}

// ─── Pure: plan ──────────────────────────────────────────────────────────────
/**
 * Decide what to write. No IO.
 * @param {{raw:string,e:object}[]} parsed  output of parseJournal
 * @param {object} ctx
 *   acct            active account (required)
 *   now             ms
 *   deviceAccounts  Set<string> of canon e-mails signed in on the device, or null (unknown)
 *   hasMessage(id)  → boolean (row already stored locally, any account)
 *   getConv(id)     → { conv:object|null, visible:boolean } (row exists / belongs to acct)
 *   activeConvId    conversation currently open on screen (no unread bump)
 * @returns {{ messages: object[], convs: {id:number, conv:object, isNew:boolean}[], keep: string[], applied: number, dropped: number }}
 */
export function planMerge(parsed, ctx) {
  const acct = canonAcct(ctx.acct);
  const now = _num(ctx.now) || Date.now();
  const devAccts = ctx.deviceAccounts instanceof Set ? ctx.deviceAccounts : null;
  const keep = [];
  let dropped = 0;
  const mine = new Map(); // mid → e

  for (const { raw, e } of parsed) {
    const at = _num(e.at);
    if (at > 0 && now - at > MAX_AGE_MS) { dropped++; continue; }
    const owner = canonAcct(e.acct);
    if (owner && owner !== acct) {
      // Another signed-in account's message: keep it for when that account is
      // active; drop lines of accounts no longer on the device.
      if (!devAccts || devAccts.has(owner)) keep.push(raw); else dropped++;
      continue;
    }
    if (!owner && devAccts && devAccts.size > 1) { dropped++; continue; } // ambiguous → never guess
    const mid = _num(e.mid);
    const prev = mine.get(mid);
    if (!prev) { mine.set(mid, e); continue; }
    // Duplicate (push + bg sync, or redelivery): the FULL line wins, then the
    // newest; missing fields are filled from the other copy (the push carries
    // unread/preview/names, the bg-sync row carries the complete server row).
    const pf = prev.full === '1' || prev.full === 1;
    const ef = e.full === '1' || e.full === 1;
    const eWins = (ef && !pf) || (ef === pf && _num(e.at) >= _num(prev.at));
    const [win, lose] = eWins ? [e, prev] : [prev, e];
    const merged = { ...lose };
    for (const k of Object.keys(win)) if (win[k] !== '' && win[k] != null) merged[k] = win[k];
    if (!(win.full === '1' || win.full === 1)) merged.full = win.full; // never upgrade a redacted line
    if (win.locked === '1' || lose.locked === '1') { merged.locked = '1'; merged.full = '0'; }
    mine.set(mid, merged);
  }

  const entries = [...mine.values()].sort((a, b) => _num(a.mid) - _num(b.mid));
  const byConv = new Map();
  for (const e of entries) {
    const cid = _num(e.cid);
    if (!byConv.has(cid)) byConv.set(cid, []);
    byConv.get(cid).push(e);
  }

  const messages = [];
  const convs = [];
  let applied = 0;
  for (const [cid, list] of byConv) {
    const fresh = list.filter((e) => !ctx.hasMessage(_num(e.mid)));
    for (const e of fresh) {
      if ((e.full === '1' || e.full === 1) && e.locked !== '1') messages.push(rowFromEntry(e));
    }
    applied += fresh.length;

    const latest = list[list.length - 1];
    const { conv, visible } = ctx.getConv(cid) || { conv: null, visible: false };
    if (conv && !visible) continue; // row owned by another account (or ambiguous legacy) → never touch
    const curLast = conv ? _num(conv.last_message?.id ?? conv.last_message_id) : 0;
    if (conv && curLast >= _num(latest.mid)) continue; // local list already newer
    if (!conv && (latest.locked === '1' || canonAcct(latest.sender) === acct)) continue; // no placeholder for locked / own

    const newer = fresh.filter((e) => _num(e.mid) > curLast);
    const incoming = newer.filter((e) => canonAcct(e.sender) !== acct).length;
    const latestFromOther = canonAcct(latest.sender) !== acct;
    let unread;
    const isOpen = ctx.activeConvId != null && String(ctx.activeConvId) === String(cid);
    if (isOpen || !latestFromOther) unread = conv ? _num(conv.unread_count) : 0;
    else if (latest.unread !== undefined && latest.unread !== '' && Number.isFinite(Number(latest.unread))) {
      // Server's per-recipient count at push time — authoritative.
      unread = Math.max(_num(latest.unread), incoming > 0 ? 1 : 0);
    } else unread = (conv ? _num(conv.unread_count) : 0) + incoming;

    const full = (latest.full === '1' || latest.full === 1) && latest.locked !== '1';
    const created = _createdAt(latest);
    const lastMessage = {
      ...((conv && conv.last_message && typeof conv.last_message === 'object') ? conv.last_message : {}),
      id: _num(latest.mid),
      read_at: null,
      delivered_at: null,
      content: full ? (_str(latest.text) || _str(latest.preview)) : _str(latest.preview),
      type: _str(latest.type) || 'text',
      sender_email: _str(latest.sender),
      sender_name: _str(latest.sname) || _str(latest.sender),
      created_at: created,
    };
    const isGroup = latest.grp === '1' || latest.grp === 1;
    const base = conv || {
      id: cid,
      conversation_id: cid,
      type: isGroup ? 'group' : 'direct',
      name: _str(latest.cname) || _str(latest.sname) || _str(latest.sender),
      display_name: _str(latest.cname) || _str(latest.sname),
      other_email: isGroup ? null : _str(latest.sender),
      muted: 0,
      pinned: 0,
      archived: 0,
      _bg_placeholder: 1,
    };
    convs.push({
      id: cid,
      isNew: !conv,
      conv: {
        ...base,
        last_message: lastMessage,
        last_message_id: _num(latest.mid),
        last_message_type: lastMessage.type,
        last_message_sender: lastMessage.sender_email,
        last_message_at: created,
        unread_count: unread,
      },
    });
  }
  return { messages, convs, keep, applied, dropped };
}

// ─── Native IO helpers ───────────────────────────────────────────────────────
function _native() {
  if (isWeb) return null;
  try { return require('../modules/expo-callkit'); } catch { return null; }
}

function _deviceAccounts() {
  try {
    const api = require('./api');
    const list = api.getStoredAccounts?.();
    if (!Array.isArray(list) || list.length === 0) return null; // not hydrated yet → unknown
    const s = new Set();
    for (const a of list) { const e = canonAcct(a && a.email); if (e) s.add(e); }
    return s.size ? s : null;
  } catch { return null; }
}

function _activeConvId() {
  try { return require('./pushNotifications').getActiveConversation?.() ?? null; } catch { return null; }
}

function _chunk(arr, n) { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; }

let _merging = false;
let _lastStats = null;
export function getLastMergeStats() { return _lastStats; }

/**
 * Merge the native journal into SQLite (+ the in-memory accelerator). Sync.
 * @returns {{applied?:number, retry?:boolean, skipped?:string, ms?:number}}
 */
export function mergeSync(reason = '') {
  if (isWeb) return { skipped: 'web' };
  if (_merging) return { skipped: 'busy' };
  const nat = _native();
  if (!nat || typeof nat.bgJournalRead !== 'function') return { skipped: 'no_native' };
  _merging = true;
  const t0 = Date.now();
  try {
    const r = nat.bgJournalRead();
    if (!r || !r.text) return { applied: 0 };
    const cs = require('./chatStore');
    const acct = cs.getActiveAccount?.() || '';
    if (!acct) return { retry: true, skipped: 'no_account' };
    if (cs.isLocked?.()) return { retry: true, skipped: 'locked' };
    const sq = require('./sqliteStore');
    const db = sq.getSyncDb?.();
    if (!db) return { retry: true, skipped: 'no_db' };
    const cols = sq.hasAccountColumnsSync?.() || { messages: false, conversations: false };
    const legacyOwner = sq.getLegacyOwner?.() || '';
    const acctN = normAccount(acct);

    const parsed = parseJournal(r.text);
    const mids = [];
    const cids = new Set();
    for (const { e } of parsed) { mids.push(_num(e.mid)); cids.add(_num(e.cid)); }

    // Existence lookups (batched, PK lookups — sub-ms each).
    const have = new Set();
    for (const part of _chunk([...new Set(mids)], 400)) {
      if (!part.length) continue;
      try {
        const rows = db.getAllSync(`SELECT id FROM messages WHERE id IN (${part.map(() => '?').join(',')})`, part);
        for (const row of rows) have.add(_num(row.id));
      } catch {}
    }
    const convRows = new Map();
    const hasConvTable = (() => {
      try { return !!db.getFirstSync("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'"); } catch { return false; }
    })();
    if (hasConvTable) {
      for (const part of _chunk([...cids], 400)) {
        if (!part.length) continue;
        try {
          const sel = cols.conversations ? 'id, raw_json, account_email' : 'id, raw_json';
          const rows = db.getAllSync(`SELECT ${sel} FROM conversations WHERE id IN (${part.map(() => '?').join(',')})`, part);
          for (const row of rows) {
            let conv = null;
            try { conv = JSON.parse(row.raw_json); } catch {}
            const owner = cols.conversations ? normAccount(row.account_email || '') : '';
            const visible = !cols.conversations || owner === acctN || (!owner && legacyOwner === acctN);
            convRows.set(_num(row.id), { conv, visible });
          }
        } catch {}
      }
    }

    const plan = planMerge(parsed, {
      acct,
      now: Date.now(),
      deviceAccounts: _deviceAccounts(),
      hasMessage: (id) => have.has(id),
      getConv: (id) => convRows.get(id) || { conv: null, visible: false },
      activeConvId: _activeConvId(),
    });

    // Write — short busy timeout: never block the JS thread behind db.js's
    // async writer at boot. On SQLITE_BUSY we keep the journal and retry later.
    if (plan.messages.length || plan.convs.length) {
      try { db.execSync('PRAGMA busy_timeout = 150;'); } catch {}
      try {
        db.execSync('BEGIN');
        if (plan.messages.length) {
          const stmt = db.prepareSync(
            `INSERT OR IGNORE INTO messages
               (id, conversation_id, sender_email, sender_name, content, type,
                file_url, file_name, file_size, reply_to_id, created_at,
                client_temp_id, pending_state, raw_json${cols.messages ? ', account_email' : ''})
             VALUES ($id, $cid, $sender, $sname, $content, $type,
                $furl, $fname, $fsize, $reply, $created,
                $cmid, 'sent', $raw${cols.messages ? ', $acct' : ''})`
          );
          try {
            for (const m of plan.messages) {
              stmt.executeSync({
                $id: m.id, $cid: m.conversation_id, $sender: m.sender_email, $sname: m.sender_name,
                $content: m.content, $type: m.type, $furl: m.file_url || '', $fname: m.file_name || '',
                $fsize: m.file_size || 0, $reply: m.reply_to_id, $created: m.created_at,
                $cmid: m.client_message_id, $raw: JSON.stringify(m),
                ...(cols.messages ? { $acct: acctN } : {}),
              });
            }
          } finally { stmt.finalizeSync(); }
        }
        if (hasConvTable) {
          for (const { id, conv, isNew } of plan.convs) {
            const lm = conv.last_message || {};
            if (isNew) {
              db.runSync(
                `INSERT OR IGNORE INTO conversations
                   (id, name, type, last_message, last_message_time, last_message_sender, unread_count,
                    avatar_url, pinned, muted, archived, is_group, member_count, description, updated_at, raw_json${cols.conversations ? ', account_email' : ''})
                 VALUES (?, ?, ?, ?, ?, ?, ?, '', 0, 0, 0, ?, 0, '', ?, ?${cols.conversations ? ', ?' : ''})`,
                [id, conv.name || '', conv.type || 'direct', _str(lm.content), conv.last_message_at || '',
                  _str(lm.sender_email), _num(conv.unread_count), conv.type === 'group' ? 1 : 0,
                  conv.last_message_at || '', JSON.stringify(conv), ...(cols.conversations ? [acctN] : [])]
              );
            } else {
              db.runSync(
                `UPDATE conversations SET last_message = ?, last_message_time = ?, last_message_sender = ?,
                   unread_count = ?, raw_json = ?${cols.conversations ? ', account_email = COALESCE(account_email, ?)' : ''}
                 WHERE id = ?`,
                [_str(lm.content), conv.last_message_at || '', _str(lm.sender_email), _num(conv.unread_count),
                  JSON.stringify(conv), ...(cols.conversations ? [acctN] : []), id]
              );
            }
          }
        }
        db.execSync('COMMIT');
      } catch (e) {
        try { db.execSync('ROLLBACK'); } catch {}
        try { db.execSync('PRAGMA busy_timeout = 5000;'); } catch {}
        if (__DEV__) console.warn('[bgJournal] merge write failed:', e?.message);
        _lastStats = { reason, error: String(e?.message || e).slice(0, 120), ms: Date.now() - t0 };
        return { retry: true, skipped: 'write_failed' };
      }
      try { db.execSync('PRAGMA busy_timeout = 5000;'); } catch {}
    }

    // Consume what we read (anything appended meanwhile survives natively).
    try { nat.bgJournalCommit?.(r.bytes, plan.keep.join('\n')); } catch {}

    // In-memory accelerator (same process paints from it too).
    _updateAccelerator(plan);

    const ms = Date.now() - t0;
    _lastStats = { reason, lines: parsed.length, applied: plan.applied, msgs: plan.messages.length, convs: plan.convs.length, keep: plan.keep.length, dropped: plan.dropped, ms };
    try { require('./bootTrace').mark('bgjournal_merged'); } catch {}
    if (plan.convs.length || plan.messages.length) _emit(plan);
    return { applied: plan.applied, ms };
  } catch (e) {
    if (__DEV__) console.warn('[bgJournal] mergeSync failed:', e?.message);
    return { retry: true, skipped: 'error' };
  } finally {
    _merging = false;
  }
}

function _updateAccelerator(plan) {
  try {
    const sc = require('./smartChatCache');
    // Messages: only into conversations whose blob is already warm/loadable —
    // cacheMessages on a cold blob would persist a 1-message array over the
    // stored history.
    const byConv = new Map();
    for (const m of plan.messages) {
      if (!byConv.has(m.conversation_id)) byConv.set(m.conversation_id, []);
      byConv.get(m.conversation_id).push(m);
    }
    for (const [cid, rows] of byConv) {
      try {
        const cur = sc.getCachedMessagesSync?.(cid, 1);
        if (Array.isArray(cur) && cur.length) sc.cacheMessages?.(cid, rows);
      } catch {}
    }
    if (plan.convs.length) {
      const list = sc.getCachedConversationsSync?.();
      if (Array.isArray(list) && list.length) {
        const next = applyConvUpdates(list, plan.convs.map((c) => c.conv));
        sc.cacheConversations?.(next);
      }
    }
  } catch {}
}

/**
 * Apply updated conversation objects to a list (WhatsApp order: pinned first,
 * then the freshly-updated conversations newest-first, then the rest). Pure —
 * exported for ChatListTab's foreground listener + the Node harness.
 */
export function applyConvUpdates(list, updated) {
  if (!Array.isArray(list) || !Array.isArray(updated) || !updated.length) return list;
  let next = list.slice();
  const sorted = updated.slice().sort((a, b) => String(a.last_message_at || '').localeCompare(String(b.last_message_at || '')));
  for (const u of sorted) {
    const idx = next.findIndex((c) => String(c.id) === String(u.id) || String(c.conversation_id) === String(u.id));
    let row;
    if (idx >= 0) {
      const old = next[idx];
      // Never regress: a live update may already be newer than the journal.
      if (_num(old.last_message?.id ?? old.last_message_id) >= _num(u.last_message?.id)) continue;
      row = { ...old, ...u };
      next.splice(idx, 1);
    } else {
      row = u;
    }
    if (row.archived) { next.splice(idx >= 0 ? idx : next.length, 0, row); continue; }
    const pinned = next.filter((c) => !!c.pinned);
    const rest = next.filter((c) => !c.pinned);
    next = row.pinned ? [row, ...pinned, ...rest] : [...pinned, row, ...rest];
  }
  return next;
}

function _emit(plan) {
  try {
    const { DeviceEventEmitter } = require('react-native');
    DeviceEventEmitter.emit(MERGED_EVENT, {
      convs: plan.convs.map((c) => c.conv),
      messages: plan.messages,
    });
  } catch {}
}

// ─── Background sync config / schedule ───────────────────────────────────────
/**
 * Export the most recent conversations' delta cursors to the native periodic
 * sync (Android WorkManager / iOS BGAppRefreshTask). Called on background
 * transitions and after the first paint. Cheap (one sync SELECT, ≤60 rows).
 */
export function exportSyncConfig() {
  if (isWeb) return;
  try {
    const nat = _native();
    if (!nat || typeof nat.bgSyncConfigure !== 'function') return;
    const cs = require('./chatStore');
    const acct = cs.getActiveAccount?.() || '';
    if (!acct) return;
    const convs = (cs.getConversationsSync?.() || []).filter((c) => c && c.id != null && !c.archived);
    convs.sort((a, b) => String(b.last_message_at || '').localeCompare(String(a.last_message_at || '')));
    let getLastPts = null;
    try { getLastPts = require('./chatSync').getLastPts; } catch {}
    const out = [];
    for (const c of convs.slice(0, 60)) {
      const id = String(c.id);
      let pts = 0;
      try { pts = getLastPts ? _num(getLastPts(c.id)) : 0; } catch {}
      // pts 0 = never synced → the worker would pull a 50-event window of an
      // old conversation for nothing; only conversations with a watermark.
      if (pts > 0) out.push({ id, pts });
    }
    nat.bgSyncConfigure(JSON.stringify({ acct: canonAcct(acct), convs: out })).catch?.(() => {});
  } catch {}
}

let _scheduled = false;
export function scheduleBackgroundSync(enabled = true) {
  if (isWeb) return;
  try {
    const nat = _native();
    if (!nat || typeof nat.bgSyncSchedule !== 'function') return;
    if (enabled && _scheduled) return;
    _scheduled = !!enabled;
    nat.bgSyncSchedule(!!enabled).catch?.(() => {});
  } catch {}
}

/** Logout: drop the outgoing account's lines; full wipe when nobody is left. */
export function onLogout(email) {
  if (isWeb) return;
  try {
    const nat = _native();
    if (!nat) return;
    const remaining = (() => {
      try {
        const list = require('./api').getStoredAccounts?.() || [];
        return list.map((a) => canonAcct(a && a.email)).filter((e) => e && e !== canonAcct(email));
      } catch { return []; }
    })();
    if (!remaining.length) {
      nat.bgJournalClear?.();
      _scheduled = false;
      nat.bgSyncSchedule?.(false)?.catch?.(() => {});
      return;
    }
    const r = nat.bgJournalRead?.();
    if (!r || !r.text) return;
    const out = canonAcct(email);
    const keep = parseJournal(r.text).filter(({ e }) => canonAcct(e.acct) !== out).map(({ raw }) => raw);
    nat.bgJournalCommit?.(r.bytes, keep.join('\n'));
  } catch {}
}

// ─── Foreground hook ─────────────────────────────────────────────────────────
// AppState 'active' → merge again (Android/iOS stored new messages while we
// were in the background) and tell the list. 'background' → export cursors so
// the native periodic sync knows where to resume.
let _appStateSub = null;
export function init() {
  if (isWeb || _appStateSub) return;
  try {
    const { AppState } = require('react-native');
    let last = AppState.currentState;
    _appStateSub = AppState.addEventListener('change', (s) => {
      try {
        if (s === 'active' && last !== 'active') {
          try { require('./chatStore').markJournalPending?.(); } catch {}
          const r = mergeSync('foreground');
          if (r && r.retry) setTimeout(() => { try { mergeSync('foreground_retry'); } catch {} }, 1200);
        } else if (s === 'background') {
          exportSyncConfig();
        }
      } catch {}
      last = s;
    });
  } catch {}
}

export default {
  parseJournal, planMerge, rowFromEntry, applyConvUpdates, canonAcct,
  mergeSync, exportSyncConfig, scheduleBackgroundSync, onLogout, init,
  getLastMergeStats, MERGED_EVENT,
};
