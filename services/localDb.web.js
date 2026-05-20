// Web implementation of localDb — mirrors the web branches in localDb.js so
// chatCache's `require('./localDb').webSaveMessages(...)` actually persists to
// IndexedDB. The old stub here no-op'd everything, which silently broke the
// chat cache on desktop: messages vanished on reload because only the 5 MB
// localStorage fallback kept them and silently dropped old entries.

const IDB_NAME = 'chatyy_v2';
// v4 (2026-05-16): mirror native localDb.js — add local_seq + client_temp_id
// indexes to the `messages` store. See localDb.js for full context.
const IDB_VERSION = 4;
let _idb = null;

function getIDB() {
  if (_idb) return Promise.resolve(_idb);
  if (typeof indexedDB === 'undefined') return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(IDB_NAME, IDB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        const tx = e.target.transaction;
        if (!d.objectStoreNames.contains('cache')) d.createObjectStore('cache', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('emails')) {
          const s = d.createObjectStore('emails', { keyPath: '_cid' });
          s.createIndex('folder', 'folder', { unique: false });
        }
        if (!d.objectStoreNames.contains('conversations')) d.createObjectStore('conversations', { keyPath: 'id' });
        let msgStore;
        if (!d.objectStoreNames.contains('messages')) {
          msgStore = d.createObjectStore('messages', { keyPath: 'id' });
          msgStore.createIndex('cid', 'conversation_id', { unique: false });
        } else if (tx) {
          msgStore = tx.objectStore('messages');
        }
        if (msgStore && !msgStore.indexNames.contains('local_seq')) {
          try { msgStore.createIndex('local_seq', ['conversation_id', 'local_seq'], { unique: false }); } catch {}
        }
        if (msgStore && !msgStore.indexNames.contains('client_temp_id')) {
          try { msgStore.createIndex('client_temp_id', 'client_temp_id', { unique: false }); } catch {}
        }
        if (!d.objectStoreNames.contains('contacts')) d.createObjectStore('contacts', { keyPath: 'email' });
      };
      req.onsuccess = (e) => { _idb = e.target.result; resolve(_idb); };
      req.onerror = () => resolve(null);
    } catch { resolve(null); }
  });
}

// ── Generic TTL cache ──
export async function webCacheSet(key, data, ttlSec = 300) {
  try {
    const d = await getIDB(); if (!d) return;
    const tx = d.transaction('cache', 'readwrite');
    tx.objectStore('cache').put({ key, data, exp: Date.now() + ttlSec * 1000 });
  } catch {}
}
export async function webCacheGet(key) {
  try {
    const d = await getIDB(); if (!d) return null;
    return new Promise((r) => {
      const req = d.transaction('cache', 'readonly').objectStore('cache').get(key);
      req.onsuccess = () => { const e = req.result; r(e && e.exp > Date.now() ? e.data : null); };
      req.onerror = () => r(null);
    });
  } catch { return null; }
}

// ── Emails ──
export async function webSaveEmails(folder, emails) {
  try {
    const d = await getIDB(); if (!d) return;
    const tx = d.transaction('emails', 'readwrite');
    const s = tx.objectStore('emails');
    emails.forEach(e => s.put({ ...e, folder, _cid: folder + ':' + (e.uid || e.id), _ts: Date.now() }));
  } catch {}
}
export async function webGetEmails(folder) {
  try {
    const d = await getIDB(); if (!d) return null;
    return new Promise((r) => {
      const req = d.transaction('emails', 'readonly').objectStore('emails').index('folder').getAll(folder);
      req.onsuccess = () => { const emails = req.result; r(emails?.length > 0 ? emails : null); };
      req.onerror = () => r(null);
    });
  } catch { return null; }
}

// ── Conversations ──
export async function webSaveConversations(convs) {
  try {
    const d = await getIDB(); if (!d) return;
    const tx = d.transaction('conversations', 'readwrite');
    convs.forEach(c => tx.objectStore('conversations').put({ ...c, _ts: Date.now() }));
  } catch {}
}
export async function webGetConversations() {
  try {
    const d = await getIDB(); if (!d) return null;
    return new Promise((r) => {
      const req = d.transaction('conversations', 'readonly').objectStore('conversations').getAll();
      req.onsuccess = () => {
        const c = req.result;
        if (c?.length > 0) {
          r(c.sort((a, b) => new Date(b.last_message_at || b.updated_at) - new Date(a.last_message_at || a.updated_at)));
        } else r(null);
      };
      req.onerror = () => r(null);
    });
  } catch { return null; }
}

// ── Messages ──
export async function webSaveMessages(convId, msgs) {
  try {
    const d = await getIDB(); if (!d) return;
    const tx = d.transaction('messages', 'readwrite');
    msgs.forEach(m => tx.objectStore('messages').put({ ...m, conversation_id: convId, _ts: Date.now() }));
  } catch {}
}
export async function webGetMessages(convId) {
  try {
    const d = await getIDB(); if (!d) return null;
    return new Promise((r) => {
      const req = d.transaction('messages', 'readonly').objectStore('messages').index('cid').getAll(convId);
      req.onsuccess = () => {
        const m = req.result;
        if (m?.length > 0) {
          r(m.sort((a, b) => {
            const ta = Date.parse(a.created_at || 0) || 0;
            const tb = Date.parse(b.created_at || 0) || 0;
            if (ta !== tb) return ta - tb;
            const na = Number(a.id), nb = Number(b.id);
            if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
            return String(a.id).localeCompare(String(b.id));
          }));
        } else r(null);
      };
      req.onerror = () => r(null);
    });
  } catch { return null; }
}

export async function webClearAll() {
  try { indexedDB.deleteDatabase(IDB_NAME); _idb = null; } catch {}
}

// ── Diagnostic: IDB row counts + browser quota estimate ──
// Mirror of localDb.js getCacheSize — see that file for rationale.
// Surfacing the number lets settings/debug show how much persisted data
// the web user has cached, so they can see they're not "always re-syncing"
// after the WhatsApp-pattern stale-while-revalidate switch.
export async function getCacheSize() {
  const out = { conversations: 0, messages: 0, emails: 0, sizeBytes: 0, quotaBytes: 0, web: true };
  try {
    const d = await getIDB();
    if (!d) return out;
    out.conversations = await new Promise((r) => {
      try {
        const req = d.transaction('conversations', 'readonly').objectStore('conversations').count();
        req.onsuccess = () => r(req.result || 0);
        req.onerror = () => r(0);
      } catch { r(0); }
    });
    out.messages = await new Promise((r) => {
      try {
        const req = d.transaction('messages', 'readonly').objectStore('messages').count();
        req.onsuccess = () => r(req.result || 0);
        req.onerror = () => r(0);
      } catch { r(0); }
    });
    out.emails = await new Promise((r) => {
      try {
        const req = d.transaction('emails', 'readonly').objectStore('emails').count();
        req.onsuccess = () => r(req.result || 0);
        req.onerror = () => r(0);
      } catch { r(0); }
    });
  } catch {}
  try {
    if (typeof navigator !== 'undefined' && navigator.storage?.estimate) {
      const est = await navigator.storage.estimate();
      out.sizeBytes = est?.usage || 0;
      out.quotaBytes = est?.quota || 0;
    }
  } catch {}
  return out;
}

function _isPinnedConv(c) {
  if (!c) return false;
  return Boolean(c.is_pinned || c.pinned || c.pinned_at);
}

// LRU evict oldest non-pinned conversations until size <= targetBytes.
// Triggered manually (e.g. from settings) or before a large bulk write.
// 100 MB cap is safely below the smallest browser quota we hit in the
// wild (Safari private mode ~200 MB), so we evict before the browser
// surprises us with its own eviction. See localDb.js for full rationale.
export async function evictOldestConversations(maxBytes = 100 * 1024 * 1024, targetBytes = 80 * 1024 * 1024) {
  try {
    const sz = await getCacheSize();
    if (!sz.sizeBytes || sz.sizeBytes <= maxBytes) return 0;
    const d = await getIDB();
    if (!d) return 0;
    const convs = await new Promise((r) => {
      try {
        const req = d.transaction('conversations', 'readonly').objectStore('conversations').getAll();
        req.onsuccess = () => r(req.result || []);
        req.onerror = () => r([]);
      } catch { r([]); }
    });
    convs.sort((a, b) => {
      const ta = Date.parse(a.last_message_at || a.updated_at || 0) || 0;
      const tb = Date.parse(b.last_message_at || b.updated_at || 0) || 0;
      return ta - tb;
    });
    let evicted = 0;
    for (const c of convs) {
      if (_isPinnedConv(c)) continue;
      try {
        const tx = d.transaction(['conversations', 'messages'], 'readwrite');
        tx.objectStore('conversations').delete(c.id);
        const msgStore = tx.objectStore('messages');
        const cursorReq = msgStore.index('cid').openCursor(IDBKeyRange.only(c.id));
        await new Promise((r) => {
          cursorReq.onsuccess = (e) => {
            const cur = e.target.result;
            if (cur) { try { cur.delete(); } catch {} cur.continue(); }
            else r();
          };
          cursorReq.onerror = () => r();
        });
      } catch {}
      evicted++;
      if (evicted % 10 === 0) {
        try {
          const newSz = await getCacheSize();
          if (newSz.sizeBytes && newSz.sizeBytes <= targetBytes) break;
        } catch {}
      }
    }
    return evicted;
  } catch {
    return 0;
  }
}

// ── SQLite API surface — stubbed on web since chatCache.js guards with Platform.OS === 'web'
// before calling any of these. They exist only so the module contract matches native. ──
export async function initLocalDb() {}
export function isInitialized() { return false; }
export async function clearLocalDb() {}
export async function getConversations() { return null; }
export async function saveConversations() {}
export async function deleteConversation() {}
export async function getMessages() { return null; }
export async function saveMessages() {}
export async function saveSingleMessage() {}
export async function getContacts() { return null; }
export async function saveContacts() {}
export async function getSyncState() { return null; }
export async function saveSyncState() {}
export async function getEmails() { return null; }
export async function saveEmails() {}
// [2026-05-19] Web stub for fullDeltaSync — deltaSync.js calls this on
// every WS event + cold start; missing export was causing
// "c.fullDeltaSync is not a function" loop in browser console + breaking
// real-time sync entirely on web. On web we don't have SQLite, so this
// is a no-op that returns a benign result so deltaSync doesn't surface
// as an error.
export async function fullDeltaSync() { return { sync_seq: 0, surfaces: [] }; }
export async function getLastSyncSeq() { return 0; }
export async function setLastSyncSeq() {}
export async function applyDeltaSync() {}
