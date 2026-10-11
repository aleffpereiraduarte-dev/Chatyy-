// [2026-10-11 boot-split] Call-history cache/store, extracted from
// components/ChatCallsTab.js so that IncomingCallListener / nativeOutgoingCall /
// nativeGroupCall / initialSync / app/call.js / app/chat.js can record & read
// call history WITHOUT statically pulling the whole Calls tab (and, through it,
// pstnCall -> livekit-client) into the web boot bundle (__common).
// ChatCallsTab re-exports everything here, so old imports keep working.
import { callHistoryList, callHistoryAdd, callHistoryDelete } from './api';
import { setCache } from './cache';

export function callDirection(item) {
  if (!item) return 'outgoing';
  const dir = String(item.direction || '').toLowerCase();
  const status = String(item.status || '').toLowerCase();
  if (dir === 'outgoing') return 'outgoing';
  if (dir === 'missed' || status === 'missed') return 'missed';
  if (dir === 'incoming') return 'incoming';
  const legacy = String(item.type || '').toLowerCase();
  if (legacy === 'outgoing' || legacy === 'incoming' || legacy === 'missed') return legacy;
  if (typeof item.is_outgoing === 'boolean') return item.is_outgoing ? 'outgoing' : 'incoming';
  const caller = String(item.caller_email || '').toLowerCase();
  const contact = String(item.contact_email || item.contactEmail || '').toLowerCase();
  if (caller && contact) return caller === contact ? 'incoming' : 'outgoing';
  return 'outgoing';
}

export const CALL_HISTORY_CACHE_KEY = 'omc_call_history';

export function _readCallHistoryCache() {
  try {
    const { getJSON } = require('./mmkv');
    const c = getJSON(CALL_HISTORY_CACHE_KEY);
    if (c?.data && Array.isArray(c.data)) return c.data;
  } catch {}
  return null;
}
export function _writeCallHistoryCache(arr) {
  const trimmed = arr.slice(0, 200);
  try {
    const { setJSON, setString } = require('./mmkv');
    setJSON(CALL_HISTORY_CACHE_KEY, { data: trimmed, ts: Date.now() });
    // Mirror to the legacy `chat_calls` string key — that's the one the list
    // preloads from on cold start (line 2802 _gs('chat_calls')). Without this
    // mirror, optimistic adds disappear after app restart.
    setString('chat_calls', JSON.stringify(trimmed));
  } catch {}
  // ALSO mirror into the ACCOUNT-SCOPED cache (services/cache → MMKV key hashed
  // by the logged-in email). This is the PRIMARY source the first-paint seed
  // reads, so it must stay fresh on EVERY write — including optimistic adds
  // (addCallToHistory) and deletes — not only on the mount-effect setCache.
  // Writing it here means: (1) the cold-start seed is instant AND can never
  // surface another account's log (P0 privacy — the key is per-account), and
  // (2) a call made this session is already on-device for the next cold start.
  // Fire-and-forget; setCache writes MMKV synchronously under the hood.
  try {
    const { setCache } = require('./cache');
    setCache('call_history', trimmed, 2592000000).catch(() => {});
  } catch {}
}

export async function getCallHistory() {
  // Cache-first: return cached rows immediately if present, then refresh in
  // the background. Caller renders the cached list while the network catches up.
  try {
    const r = await callHistoryList(200, 0);
    if (r?.success && Array.isArray(r?.data?.calls)) {
      _writeCallHistoryCache(r.data.calls);
      return r.data.calls;
    }
  } catch {}
  const cached = _readCallHistoryCache();
  return cached || [];
}

// Synchronous accessor — read cache without hitting the network.
// UI uses this on first paint to avoid the empty-list flash.
export function getCallHistoryCached() {
  return _readCallHistoryCache() || [];
}

// Startup prefetch (fire-and-forget) — called from services/initialSync.js.
//
// ROOT FIX for "parece que os dados não tá no celular": nothing EVER warmed the
// call-history cache except the user OPENING the Calls tab. So the first open of
// each app session was always a cold BR→NY network fetch (and a skeleton
// spinner whenever the cache wasn't warm). This runs the SAME endpoint the tab
// uses (callHistoryList via getCallHistory) and writes the SAME cache keys the
// tab reads so the data is already on-device before the user taps Calls:
//   • chat_calls        (MMKV string) — the module-level synchronous preload
//   • omc_call_history  (MMKV JSON)   — getCallHistoryCached() / useState seed
//     ↑ both written by getCallHistory()'s _writeCallHistoryCache()
//   • call_history      (scoped cache) — the async slow-path fallback (getCached)
// Account scoping: setCache uses the active user's hash (asserted by AuthContext
// / initialSync before this runs). MUST NOT be awaited anywhere that gates the
// "Sincronizando…" banner.
export async function prefetchCallHistory() {
  try {
    const h = await getCallHistory(); // writes chat_calls + omc_call_history
    if (Array.isArray(h)) {
      try { setCache('call_history', h, 2592000000).catch(() => {}); } catch {}
    }
    return h;
  } catch {}
  return null;
}

// Flip every cached missed-call row to `read: true`. Tab badge derives its
// count from the cache, so without this the number reappears the moment the
// user navigates away from the Calls tab — the React state was zeroed but
// the cache still said "unread", and the next recompute brought it back.
export function markMissedCallsRead() {
  try {
    const cur = _readCallHistoryCache();
    if (!Array.isArray(cur) || cur.length === 0) return;
    let touched = false;
    const next = cur.map(c => {
      if (callDirection(c) === 'missed' && !(c?.read === true || c?.read === 1)) { // [2026-10-06 UX2]
        touched = true;
        return { ...c, read: true };
      }
      return c;
    });
    if (touched) _writeCallHistoryCache(next);
  } catch {}
}

export async function addCallToHistory(callData) {
  // Build the row first so we can write it to cache even if the server fails.
  const row = {
    id: null,
    contactEmail: callData.contactEmail || '',
    contactName: callData.contactName || callData.contactEmail || '',
    callId: callData.callId || '',
    type: callData.type || 'outgoing',
    video: !!callData.video,
    timestamp: callData.timestamp || Date.now(),
    duration: callData.duration || 0,
    isGroup: !!callData.isGroup,
    participants: callData.participants || [],
  };
  // Optimistic: prepend to cache immediately so the calls tab shows the new
  // entry without waiting for a network round-trip. Was the bug — calls
  // ended but the list stayed empty because nothing wrote to cache.
  try {
    const cur = _readCallHistoryCache() || [];
    _writeCallHistoryCache([{ ...row, id: 'tmp_' + Date.now() }, ...cur]);
  } catch {}
  try {
    const r = await callHistoryAdd(callData);
    if (r?.success) {
      const finalRow = { ...row, id: r.data?.id };
      // Replace the temp row with the server-assigned id.
      try {
        const cur = _readCallHistoryCache() || [];
        const replaced = cur.filter(x => !String(x.id || '').startsWith('tmp_'));
        _writeCallHistoryCache([finalRow, ...replaced]);
      } catch {}
      return finalRow;
    }
    return null;
  } catch { return null; }
}

export async function removeCallFromHistory(callId) {
  try { await callHistoryDelete(callId); } catch {}
  // Drop from cache too — otherwise the row reappears on next mount.
  try {
    const cur = _readCallHistoryCache() || [];
    _writeCallHistoryCache(cur.filter(x => String(x.id) !== String(callId)));
  } catch {}
  return true;
}
