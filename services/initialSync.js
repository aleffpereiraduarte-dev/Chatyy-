/**
 * Full Sync — WhatsApp-level: download EVERYTHING to device
 *
 * Phase 1 (0-15%):   Conversations list
 * Phase 2 (15-55%):  Messages for ALL conversations (last 100 each)
 * Phase 3 (55-65%):  Contacts + address book
 * Phase 4 (65-75%):  Emails (last 100 per folder)
 * Phase 5 (75-85%):  Calendar events (next 3 months)
 * Phase 6 (85-92%):  Files/Cloud listing
 * Phase 7 (92-97%):  Profile + settings
 * Phase 8 (97-100%): Media thumbnails pre-cache
 */
import { Platform } from 'react-native';
import { getString, setString, setJSON } from './mmkv';
import { cacheMessages, cacheConversations, getLastSyncId } from './chatCache';
import {
  dbSaveContacts, dbSaveEmails, dbSaveEvents, dbSaveFiles,
  dbSet, dbSetSyncState, isDbReady,
} from './db';
// Real cache the SCREENS actually read (services/cache.js). The db.js tables
// warmed by the dbSave* calls below are never read by any screen, so a
// never-before-visited page (contacts / calendar / meetings / files) still hit
// the network on its FIRST open. Warming these exact keys+shapes during the
// initial sync makes that first open paint instantly from cache.
import { setCache, setCacheUser } from './cache';
let mailWs = null;
try { mailWs = require('./websocket').default; } catch {}

// Byte size → human string. Mirrors formatSize() in app/files.js so the
// `files_root` cache we warm here has the EXACT same item shape the Files
// screen stores (it reads the cache verbatim, without re-normalizing).
function _fmtSize(bytes) {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

const SYNC_KEY = 'initial_sync_done';
const SYNC_VERSION_KEY = 'sync_version';
const CURRENT_SYNC_VERSION = 3; // Bump to force re-sync

export function isSyncComplete() {
  const done = getString(SYNC_KEY);
  const version = getString(SYNC_VERSION_KEY);
  return done === 'true' && version === String(CURRENT_SYNC_VERSION);
}

function markSyncComplete() {
  setString(SYNC_KEY, 'true');
  setString(SYNC_VERSION_KEY, String(CURRENT_SYNC_VERSION));
  setString('last_full_sync', new Date().toISOString());
}

function emit(phase, progress = 0) {
  mailWs?._emit?.('sync_progress', { phase, progress });
}

// Call-history prefetch (fire-and-forget). ROOT FIX for the Calls tab "demora a
// abrir / os dados não tá no celular": the only thing that ever warmed the
// call-history cache was the user OPENING the Calls tab, so the first open of
// each app session was a cold BR→NY fetch + skeleton spinner. Prewarm it in the
// BACKGROUND on startup using the SAME endpoint + SAME cache keys the tab reads
// (chat_calls + omc_call_history + the account-scoped `call_history`), so the
// data is already on-device before the user taps Calls. ChatCallsTab is already
// eagerly loaded by the chat screen, so the lazy require() just hits the module
// cache (no extra cost). This MUST NEVER be awaited where it could prolong the
// "Sincronizando…" banner.
function _prefetchCallHistoryBg() {
  try {
    const mod = require('../components/ChatCallsTab');
    const fn = mod && (mod.prefetchCallHistory
      || (mod.default && mod.default.prefetchCallHistory));
    if (typeof fn === 'function') { try { fn().catch(() => {}); } catch {} }
  } catch {}
}

/**
 * Full initial sync — downloads EVERYTHING
 *
 * Web (WhatsApp-grade silent path, 2026-05-18):
 *   No persistent local store on web (no SQLite, no native DB). Heavy
 *   pre-pulls (chat list + contacts + 5 IMAP folders + calendar + files +
 *   profile + settings + notes) were running on EVERY cold start and were
 *   the root cause of the perpetual "Sincronizando..." banner that users
 *   complained about (#1131). The chat list and every other screen does
 *   its own fetch-on-mount with cache fallback. On web we now short-circuit:
 *   emit start→done in the same tick so the SyncBar never paints, mark the
 *   sync as complete in localStorage, and return immediately. Real-time WS
 *   delta + per-screen lazy fetch handle steady-state from here.
 */
export async function runInitialSync(api, options = {}) {
  // Fire-and-forget BEFORE the skip gate so the call-history cache is warmed on
  // EVERY invocation — including the `skipped` early-return below and the web
  // fast-path — not only on the first-ever heavy sync. Never awaited → cannot
  // prolong the sync banner.
  _prefetchCallHistoryBg();

  if (!options.force && isSyncComplete()) {
    return { skipped: true };
  }

  // WEB FAST PATH — see jsdoc above. WhatsApp Web mirrors this exact pattern:
  // first paint is empty/cached, then deltas trickle in. No upfront 8-phase
  // pull. NO visible banner.
  if (Platform.OS === 'web') {
    try { markSyncComplete(); } catch {}
    // WEB DURABLE-STORE HYDRATION (2026-09-30): the web path stays SILENT (no
    // SyncBar, no "Sincronizando…" banner — #1131), but web reads still need to
    // work offline. The durable web store is IndexedDB behind the chatStore
    // facade (Builder 1). Pull the conversation list once and upsert it into
    // the facade in the BACKGROUND — fire-and-forget so the function still
    // returns immediately and no banner ever paints. Per-screen lazy fetch +
    // WS delta handle steady-state from here. Facade absent (pre-migration) →
    // no-op, exactly the old behavior. isLocked() → skip (account isolation).
    (async () => {
      try {
        const mod = require('./chatStore');
        const cs = (mod && (mod.default || mod)) || null;
        if (!cs || typeof cs.upsertConversations !== 'function') return;
        if (typeof cs.isLocked === 'function' && cs.isLocked()) return;
        const convResult = await api.chatConversations('', true);
        const allConvs = convResult?.success
          ? (Array.isArray(convResult.data) ? convResult.data : (convResult.data?.conversations || []))
          : [];
        if (allConvs.length > 0) {
          await cs.upsertConversations(allConvs);
          // Seed the 'list' cursor so a later cold start can delta cheaply.
          // last_msg_id is best-effort from the conv row (0 = safe/full pull).
          if (typeof cs.setCursor === 'function') {
            let gMsg = 0;
            for (const c of allConvs) {
              const id = Number(c?.last_message?.id || c?.last_message_id || 0) || 0;
              if (id > gMsg) gMsg = id;
            }
            try {
              const prev = (typeof cs.getCursor === 'function') ? cs.getCursor('list') : null;
              const pMsg = (prev && Number(prev.last_msg_id)) || 0;
              const pPts = (prev && Number(prev.last_pts)) || 0;
              if (gMsg > pMsg) cs.setCursor('list', { last_pts: pPts, last_msg_id: gMsg });
            } catch {}
          }
        }
      } catch {}
    })();
    // Emit nothing — SyncBar would only show on a 'start' anyway. Return
    // synthetic skipped so the chat.js gate seals the per-email flag.
    return { skipped: true, web: true };
  }

  const isNative = Platform.OS !== 'web';
  const stats = { conversations: 0, messages: 0, contacts: 0, emails: 0, events: 0, files: 0 };

  // ACCOUNT SCOPING: services/cache.js scopes every key to the active user
  // (setCache → prefix built from _userHash). AuthContext already calls
  // setCacheUser() at login, but re-assert it defensively from the active
  // account email before we warm any user-scoped keys, so a warm write can
  // never land in the wrong (or empty) slot. Re-asserting the same email is a
  // no-op; we SKIP entirely when no email is known rather than clobber the
  // hash with '' (which would unscope + clear the mem cache).
  try {
    const activeEmail = (typeof api.getActiveAccountEmail === 'function')
      ? api.getActiveAccountEmail()
      : '';
    if (activeEmail) setCacheUser(activeEmail);
  } catch {}

  try {
    emit('start', 0);

    // ══════ Phase 1: Conversations (0-15%) ══════
    emit('progress', 2);
    const convResult = await api.chatConversations('', true);
    const allConvs = convResult.success
      ? (Array.isArray(convResult.data) ? convResult.data : (convResult.data?.conversations || []))
      : [];
    if (allConvs.length > 0) {
      await cacheConversations(allConvs);
      stats.conversations = allConvs.length;
    }
    emit('progress', 15);

    // ══════ Phase 2: Skip bulk message download (Telegram-style) ══════
    // Messages load on-demand when user opens a conversation.
    // This avoids downloading 100 msgs x N conversations on app start.
    emit('progress', 55);

    // ══════ Phase 3: Contacts (55-65%) ══════
    emit('progress', 56);
    try {
      const contactsResult = await api.getContacts();
      if (contactsResult.success) {
        const contacts = Array.isArray(contactsResult.data)
          ? contactsResult.data
          : (contactsResult.data?.contacts || []);
        setJSON('cached_contacts', contacts);
        if (isNative && isDbReady()) {
          await dbSaveContacts(contacts);
        }
        stats.contacts = contacts.length;
      }
    } catch {}
    // WARM REAL CACHE — contacts. app/contacts.js loadContacts() reads
    // getCached('contacts') and renders `cached.data`, and stores the raw
    // api.getContactsList() response ({ success, data: [...] }). Warm that
    // exact key/shape with the same endpoint the screen uses so a first-ever
    // visit to Contacts paints instantly from cache.
    // Fire-and-forget: warming these caches must NOT prolong the "Sincronizando…"
    // banner (emit start→done). Run the network write in the background.
    try { api.getContactsList().then(rc => { if (rc && rc.success) setCache('contacts', rc).catch(() => {}); }).catch(() => {}); } catch {}
    emit('progress', 65);

    // ══════ Phase 4: Emails — last 100 per main folder (65-75%) ══════
    emit('progress', 66);
    const folders = ['INBOX', 'Sent', 'Drafts', 'Spam', 'Trash'];
    let foldersDone = 0;
    for (const folder of folders) {
      try {
        const r = await api.getEmails(folder, 1, 200);
        if (r.success) {
          const emails = r.data?.emails || r.data || [];
          if (emails.length > 0 && isNative && isDbReady()) {
            await dbSaveEmails(folder, emails);
            stats.emails += emails.length;
          }
        }
      } catch {}
      foldersDone++;
      emit('progress', 66 + Math.round((foldersDone / folders.length) * 9));
    }
    emit('progress', 75);

    // ══════ Phase 5: Calendar events — next 3 months (75-85%) ══════
    emit('progress', 76);
    try {
      const now = new Date();
      const threeMonths = new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000);
      const r = await api.getEvents(now.toISOString().slice(0, 10), threeMonths.toISOString().slice(0, 10));
      if (r.success) {
        const events = r.data?.events || r.data || [];
        if (events.length > 0 && isNative && isDbReady()) {
          await dbSaveEvents(events);
          stats.events = events.length;
        }
      }
    } catch {}
    // WARM REAL CACHE — calendar. app/calendar.js loadEvents() reads
    // getCached('calendar_events') and renders `cached.data.events`, storing
    // the raw api.calEvents() response ({ success, data: { events: [...] } }).
    // Warm that exact key/shape (same endpoint) so the first-ever Calendar
    // visit paints instantly. Range = previous month through +2 months, i.e.
    // the same window loadEvents() fetches for the current month.
    try {
      const nowC = new Date();
      const cStart = new Date(nowC.getFullYear(), nowC.getMonth() - 1, 1);
      const cEnd = new Date(nowC.getFullYear(), nowC.getMonth() + 2, 0);
      api.calEvents(cStart.toISOString().slice(0, 10), cEnd.toISOString().slice(0, 10))
        .then(rcal => { if (rcal && rcal.success) setCache('calendar_events', rcal).catch(() => {}); }).catch(() => {});
    } catch {}
    // WARM REAL CACHE — meetings. app/meetings.js loadMeetings() reads
    // getCached('meetings_<tab>') (default tab 'upcoming') and uses the cached
    // value directly as the meetings ARRAY, storing `r.data?.meetings || []`.
    // No existing phase fetched meetings, so a first visit always hit the
    // network — warm the plain-array shape under 'meetings_upcoming'.
    try { api.meetList('upcoming', 50, 0).then(rm => { if (rm && rm.success) setCache('meetings_upcoming', rm.data?.meetings || []).catch(() => {}); }).catch(() => {}); } catch {}
    emit('progress', 85);

    // ══════ Phase 6: Files/Cloud listing (85-92%) ══════
    emit('progress', 86);
    try {
      const r = await api.driveList(0, 'date', 'desc', 200);
      if (r.success) {
        const files = r.data?.files || r.data || [];
        if (files.length > 0 && isNative && isDbReady()) {
          await dbSaveFiles(files);
          stats.files = files.length;
        }
      }
    } catch {}
    // WARM REAL CACHE — files (root folder). app/files.js loadAllFiles() reads
    // getCached('files_root') and renders `cached.folders` + `cached.files`,
    // storing a normalized { folders, files, breadcrumbs, storage } object.
    // Rebuild that exact shape from api.fileList(null) (same endpoint the
    // screen uses for root), applying the same normalize/split, so a first
    // visit to Files paints instantly.
    try {
      api.fileList(null).then(rf => {
        if (!rf || !rf.success) return;
        const raw = rf.data || {};
        const normalize = (f) => ({
          ...f,
          is_starred: f.is_starred ?? f.starred ?? 0,
          original_name: f.original_name || f.name || '',
          size_formatted: f.size_formatted || _fmtSize(f.size || 0),
        });
        const allItems = (raw.files || []).map(normalize);
        const data = {
          folders: (raw.folders || allItems.filter(f => f.is_folder)).map(normalize),
          files: (raw.files_only || allItems.filter(f => !f.is_folder)).map(normalize),
          breadcrumbs: raw.breadcrumbs,
          storage: raw.storage,
        };
        setCache('files_root', data).catch(() => {});
      }).catch(() => {});
    } catch {}
    emit('progress', 92);

    // ══════ Phase 7: Profile + settings (92-97%) ══════
    emit('progress', 93);
    try {
      const profileResult = await api.getProfile();
      if (profileResult.success) {
        setJSON('cached_profile', profileResult.data);
        if (isNative && isDbReady()) {
          await dbSet('user_profile', JSON.stringify(profileResult.data));
        }
      }
    } catch {}

    try {
      const settingsResult = await api.getSettings();
      if (settingsResult.success) {
        setJSON('cached_settings', settingsResult.data);
        if (isNative && isDbReady()) {
          await dbSet('user_settings', JSON.stringify(settingsResult.data));
        }
      }
    } catch {}
    emit('progress', 97);

    // ══════ Phase 7b: Notes (97%) ══════
    try {
      const notesResult = await api.apiCall('notes_list');
      if (notesResult.success) {
        const { saveNotesToCache } = require('./offlineCache');
        await saveNotesToCache(notesResult.data?.notes || notesResult.data || []);
      }
    } catch {}

    // Also save settings to new offline cache
    try {
      const { saveSettingsToCache } = require('./offlineCache');
      const s = await api.getSettings();
      if (s.success) await saveSettingsToCache(s.data);
    } catch {}

    // ══════ Phase 8: Pre-cache media thumbnails (97-100%) ══════
    emit('progress', 98);
    if (isNative) {
      try {
        // Pre-cache avatar URLs for recent conversations
        const { Image } = require('react-native');
        const avatarUrls = allConvs
          .filter(c => c.avatar_url)
          .map(c => c.avatar_url)
          .slice(0, 30);
        avatarUrls.forEach(url => {
          try { Image.prefetch(url); } catch {}
        });
      } catch {}
    }
    emit('progress', 100);

    // Mark sync complete
    markSyncComplete();
    if (isNative && isDbReady()) {
      await dbSetSyncState('full_sync', 0, CURRENT_SYNC_VERSION);
    }

    await new Promise(r => setTimeout(r, 400));
    emit('done', 100);

    console.log('[Sync] Complete:', stats);
    return { success: true, ...stats };

  } catch (err) {
    // emit 'error' so UI pode diferenciar sucesso/falha. Antes emitia
    // 'done' mesmo em erro, mascarando falhas no fluxo de splash/loader.
    //
    // 2026-05-18 (#1131): also emit 'done' so SyncBar's handleSync hides the
    // bar — otherwise a thrown error left the bar stuck on "Sincronizando..."
    // until the 8s stall timer fired (and users hit refresh way before that).
    // The error phase is still emitted FIRST so listeners that distinguish
    // success/failure (splash, retry banner) still get the signal.
    emit('error', 0);
    emit('done', 100);
    return { error: err.message };
  }
}

/**
 * Delta sync — only new data since last sync
 * Called on: app resume, reconnect, periodic (every 60s)
 */
export async function runDeltaSync(api) {
  const isNative = Platform.OS !== 'web';
  try {
    // 1. Conversations
    const convResult = await api.chatConversations('', false);
    if (convResult.success) {
      const convs = Array.isArray(convResult.data) ? convResult.data : (convResult.data?.conversations || []);
      await cacheConversations(convs);

      // 2. Messages for conversations with unread
      const unread = convs.filter(c => c.unread_count > 0);
      await Promise.all(
        unread.slice(0, 15).map(async (conv) => {
          try {
            const lastId = await getLastSyncId(conv.id);
            if (lastId > 0) {
              const r = await api.chatMessages(conv.id, 50, null, lastId);
              if (r.success) {
                const msgs = Array.isArray(r.data) ? r.data : (r.data?.messages || []);
                if (msgs.length > 0) await cacheMessages(conv.id, msgs);
              }
            }
          } catch {}
        })
      );
    }

    // 3. Contacts refresh (light)
    try {
      const r = await api.getContacts();
      if (r.success) {
        const contacts = Array.isArray(r.data) ? r.data : (r.data?.contacts || []);
        setJSON('cached_contacts', contacts);
        if (isNative && isDbReady()) await dbSaveContacts(contacts);
      }
    } catch {}

  } catch {}
}

/**
 * Reset sync — force re-download
 */
export function resetSync() {
  setString(SYNC_KEY, 'false');
  setString(SYNC_VERSION_KEY, '0');
}

// ── Every-session call-history warm (warm installs) ──────────────────────────
// runInitialSync() is gated to once-per-account by its caller (chat.js seals
// `initial_sync_done:<email>` and returns BEFORE calling us on warm starts), so
// the in-flow prefetch above only covers the FIRST launch. This module is
// imported by the chat screen on EVERY session, so kick a one-shot deferred
// prefetch at import time too — then even an existing install that passed its
// initial sync long ago (and never opened Calls) has the data on-device before
// the user taps the tab. Guards: native-only (web keeps its silent model and
// persists chat_calls in localStorage from the prior session anyway); require
// an active account so it never fires pre-auth; deferred so it never competes
// with first paint. Idempotent — writes the same keys regardless.
if (Platform.OS !== 'web') {
  try {
    setTimeout(() => {
      try {
        const api = require('./api');
        const email = (typeof api.getActiveAccountEmail === 'function')
          ? api.getActiveAccountEmail() : '';
        if (!email) return; // pre-auth → skip; first-login path covers it
        try { setCacheUser(email); } catch {} // re-assert scope (no-op if set)
        _prefetchCallHistoryBg();
      } catch {}
    }, 3000);
  } catch {}
}
