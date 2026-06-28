// Chatyy message sync — Telegram-style `pts`-based gap recovery.
//
// Protocol (backend: chat.php `chat_sync`):
//   - Every mutation (new_message, edit, delete, reaction, read, pin) appends
//     a row to `conversation_events` with a monotonic per-conversation `pts`.
//   - Client tracks the highest pts it has observed per conversation.
//   - On WS reconnect / app foreground, client calls `syncConversations()`
//     which batches the known `{id, since_pts}` pairs and receives every
//     missed event in order, plus hydrated message rows for new_message
//     events so the UI can render without a follow-up fetch.
//
// This module is the single place where lastPts is persisted, read, and
// bumped. Keeping it in one file avoids the same-state-different-place
// drift that caused the "1 message duplicated" bugs in the pre-pts world.

import { Platform } from 'react-native';
import { getString, setString } from './mmkv';
import * as api from './api';

const LAST_PTS_KEY = (convId) => `chat_last_pts_${convId}`;

// ─── Last-seen pts persistence ────────────────────────────────────────
export function getLastPts(convId) {
  try {
    const v = getString(LAST_PTS_KEY(convId));
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}
export function setLastPts(convId, pts) {
  if (!convId || !Number.isFinite(pts) || pts <= 0) return;
  try {
    const current = getLastPts(convId);
    if (pts > current) setString(LAST_PTS_KEY(convId), String(pts));
  } catch {}
}
// Called whenever the client processes any message/event for a conv —
// tracks the highest observed pts so future syncs know the watermark.
export function observePts(convId, pts) {
  if (Number.isFinite(pts) && pts > 0) setLastPts(convId, pts);
}

// ─── Sync call ────────────────────────────────────────────────────────
// Server caps conversations at 200/request (chat.php chat_sync). Mirror it
// so a buggy caller can't silently fan out huge requests.
const MAX_CONVS_PER_REQ = 200;
// `has_more=true` means server truncated to `limit` events — two in a row
// for the same conv means the client was offline long enough that delta
// sync is thrashing, and a full reload is the correct fallback.
const gapStreak = new Map();

// WhatsApp-invisible-sync (2026-05-18): syncConversations is called from
// many places (focus, WS reconnect, online recovery, manual refresh) and
// previously they'd all fire in parallel — same request 3-5× on a single
// foreground transition. Now we serialize with a single-flight gate +
// 500ms debounce so bursts coalesce into ONE backend hit.
let _inFlight = null;                     // Promise of the in-flight call
let _pending = null;                      // {convIds, resolvers[]}
let _debounceTimer = null;
const DEBOUNCE_MS = 500;

async function _runSync(convIds) {
  if (convIds.length > MAX_CONVS_PER_REQ) convIds = convIds.slice(0, MAX_CONVS_PER_REQ);
  const body = {
    conversations: convIds
      .map(n => Number(n))
      .filter(Number.isFinite)
      .map(id => ({ id, since_pts: getLastPts(id), limit: 500 })),
  };
  if (body.conversations.length === 0) return [];

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await new Promise(res => setTimeout(res, 500 * Math.pow(3, attempt - 1)));
    }
    try {
      const r = await api.apiCall('chat_sync', body, 'POST');
      if (!r?.success) { lastErr = r?.error || 'no_success'; continue; }
      const out = Array.isArray(r.data?.conversations) ? r.data.conversations : [];
      for (const c of out) {
        if (c?.denied) { gapStreak.delete(c.id); continue; }
        const latest = Number(c.latest_pts || 0);
        if (latest > 0) setLastPts(c.id, latest);
        if (c.has_more) {
          const n = (gapStreak.get(c.id) || 0) + 1;
          gapStreak.set(c.id, n);
          if (n >= 2) c.needsFullReload = true;
        } else {
          gapStreak.delete(c.id);
        }
      }
      return out;
    } catch (e) {
      lastErr = e;
    }
  }
  if (__DEV__) console.warn('[chatSync] giving up after retries:', lastErr);
  return [];
}

/**
 * Pull every event missed since our last-known pts for each conversation.
 * Retries on network error with exponential backoff (3 attempts).
 *
 * Coalesces concurrent / near-simultaneous callers (focus + WS reconnect +
 * recovery) into a single backend call via 500ms debounce + single-flight
 * gate. Multiple callers with overlapping conv lists all get the merged
 * result for free.
 *
 * @param {Array<number|string>} convIds
 * @returns {Promise<Array<{id, events, messages, latest_pts, has_more, denied?, needsFullReload?}>>}
 */
export function syncConversations(convIds) {
  if (!Array.isArray(convIds) || convIds.length === 0) return Promise.resolve([]);

  return new Promise((resolve, reject) => {
    // Build / extend the pending batch.
    if (!_pending) _pending = { ids: new Set(), resolvers: [] };
    for (const id of convIds) _pending.ids.add(id);
    _pending.resolvers.push(resolve);

    const fire = async () => {
      _debounceTimer = null;
      const batch = _pending;
      _pending = null;
      if (!batch) return;

      // Serialize: if a previous run is in flight, wait for it. This is
      // the WhatsApp pattern — the next sync starts only after the
      // current one finishes, so the badge has one clear lifecycle.
      while (_inFlight) {
        try { await _inFlight; } catch {}
      }

      const ids = Array.from(batch.ids);
      _inFlight = _runSync(ids).finally(() => { _inFlight = null; });
      try {
        const out = await _inFlight;
        // Filter the per-caller result to only convs they asked about.
        // For now we just hand everyone the same merged result — callers
        // already filter by id downstream.
        for (const r of batch.resolvers) { try { r(out); } catch {} }
      } catch (e) {
        for (const r of batch.resolvers) { try { r([]); } catch {} }
      }
    };

    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(fire, DEBOUNCE_MS);
  });
}

// ─── Event applier ────────────────────────────────────────────────────
/**
 * Apply a batch of sync events to the local React `messages` state.
 *
 * Contract: `setMessages` is the conversation's state setter. We mutate
 * a copy and return — React reconciles as usual. Event shapes:
 *
 *   { pts, type, actor, payload, created_at }
 *
 * Types we handle:
 *   - new_message       → append/merge message by id (dedup tolerant)
 *   - edit              → update message content + set edited_at
 *   - delete            → mark message deleted_at (stays visible as
 *                         "Esta mensagem foi apagada")
 *   - reaction          → mark for refetch (reactions live in a side table;
 *                         worth a small refetch when one triggers)
 *   - read              → update _readStatus on the referenced message
 *
 * Unknown types are ignored — forward compatibility with server additions.
 */
export function applyEvents(events, messagesById, setMessages, hydratedMessages = []) {
  if (!Array.isArray(events) || events.length === 0) return;
  // Normaliza ids pra Number — antes ids vinham como string em alguns
  // events e number em outros, e o get() do Map falhava silenciosamente.
  const hydratedMap = new Map(hydratedMessages.map(m => [Number(m.id), m]));

  // [#1211 2026-05-19] PHONE-FIRST STORAGE: write every catch-up event to
  // SQLite/chatCache so the disk DB stays in sync even when this delta
  // arrives while the user is on a different screen. Before this, applyEvents
  // only patched React state — if the user wasn't on the conv at reconnect
  // time, the hydrated rows landed in `next` but the local SQLite never got
  // them, so the messages disappeared on next cold-open (user report
  // "ainda não está salvando tudo no celular"). Fire-and-forget, swallow
  // errors — best-effort mirror.
  try {
    const chatCache = require('./chatCache');
    for (const ev of events) {
      const mid = Number(ev?.payload?.message_id) || 0;
      if (!mid) continue;
      if (ev.type === 'new_message') {
        const hyd = hydratedMap.get(mid);
        if (hyd && hyd.conversation_id) {
          chatCache.cacheSingleMessage?.(hyd.conversation_id, hyd).catch?.(() => {});
        }
      } else if (ev.type === 'edit') {
        const newContent = ev?.payload?.content;
        const convId = ev?.payload?.conversation_id;
        if (convId && typeof newContent === 'string') {
          chatCache.updateCachedMessage?.(convId, mid, { content: newContent, edited_at: ev.created_at }).catch?.(() => {});
        }
      } else if (ev.type === 'delete') {
        const convId = ev?.payload?.conversation_id;
        if (convId) {
          chatCache.updateCachedMessage?.(convId, mid, { deleted_at: ev.created_at, content: '', file_url: '', file_name: '' }).catch?.(() => {});
        }
      } else if (ev.type === 'reaction') {
        const convId = ev?.payload?.conversation_id;
        const rx = ev?.payload?.reactions;
        if (convId && Array.isArray(rx)) {
          chatCache.updateCachedMessage?.(convId, mid, { reactions: rx }).catch?.(() => {});
        }
      } else if (ev.type === 'read') {
        // Mirror the blue ✓✓ to disk so a cold reopen doesn't regress it back to
        // grey ✓✓. `read_at` is the persisted SQLite column (see updateMessage's
        // allowed list); `_readStatus: 2` keeps the MMKV hot-cache row in sync for
        // the synchronous cold-load renderer. convId may be absent on a read
        // event — the SQLite path keys by message id regardless, so this still
        // persists; convId only feeds the MMKV mirror key when present.
        const convId = ev?.payload?.conversation_id;
        chatCache.updateCachedMessage?.(convId, mid, { read_at: ev.created_at, _readStatus: 2 }).catch?.(() => {});
      }
    }
  } catch (e) {
    if (__DEV__) console.warn('[chatSync] applyEvents SQLite mirror failed (non-fatal):', e?.message || e);
  }

  setMessages(prev => {
    const next = [...prev];
    const indexById = new Map(next.map((m, i) => [Number(m.id), i]));
    // Secondary index by client_message_id so we can fold the server row
    // onto an in-flight optimistic bubble (id = "tmp_...") instead of
    // appending a second copy. Without this, the temp bubble stayed in
    // state until the HTTP response came back — if chat_sync arrived first
    // (e.g. on reopen mid-send), the thread briefly showed both bubbles.
    const indexByClientId = new Map();
    for (let i = 0; i < next.length; i++) {
      const cid = next[i]?._client_id || next[i]?.client_message_id;
      if (cid) indexByClientId.set(cid, i);
    }
    for (const ev of events) {
      const mid = Number(ev?.payload?.message_id) || 0;
      switch (ev.type) {
        case 'new_message': {
          if (!mid) continue;
          const hydrated = hydratedMap.get(mid);
          if (!hydrated) continue;
          if (indexById.has(mid)) continue;         // already in state
          // Replace optimistic bubble if this event is for a message the
          // sender's own client already queued locally.
          const cid = hydrated.client_message_id;
          if (cid && indexByClientId.has(cid)) {
            const i = indexByClientId.get(cid);
            // Preserve local-only fields the optimistic bubble carries that
            // the hydrated server row CAN'T know about: file:// blob/local
            // URI for instant media preview, and locally-decrypted plaintext
            // (`_e2e` rows) so we don't briefly re-render the encrypted
            // ciphertext after the swap. Without this, a fresh sync replay
            // would flash "🔒 …" or re-fetch the media URL from R2.
            const optimistic = next[i] || {};
            const preserved = {};
            if (optimistic._localUri && !hydrated._localUri) preserved._localUri = optimistic._localUri;
            if (optimistic._e2e && typeof optimistic.content === 'string'
                && !optimistic.content.startsWith('🔒')) {
              preserved.content = optimistic.content;
              preserved._e2e = true;
            }
            next[i] = { ...hydrated, ...preserved, _animateIn: false };
            indexById.set(mid, i);
            indexByClientId.delete(cid);
            break;
          }
          next.push({ ...hydrated, _animateIn: false });
          indexById.set(mid, next.length - 1);
          break;
        }
        case 'edit': {
          if (!mid || !indexById.has(mid)) continue;
          const i = indexById.get(mid);
          // Server now carries the new content in the event payload so the
          // client can apply edits offline without a follow-up fetch. Falls
          // back to the old behavior (needs refetch) if content is missing.
          const newContent = ev?.payload?.content;
          if (typeof newContent === 'string') {
            next[i] = { ...next[i], content: newContent, edited_at: ev.created_at, _needsReloadContent: false };
            // Keep reply-preview bubbles in sync: any later message whose
            // reply_to points at this edited row needs its cached preview
            // updated. Without this the quote showed the old text forever.
            for (let j = 0; j < next.length; j++) {
              const r = next[j]?.reply_to;
              if (r && Number(r.id) === Number(mid)) {
                next[j] = { ...next[j], reply_to: { ...r, content: newContent.slice(0, 200) } };
              }
            }
          } else {
            next[i] = { ...next[i], edited_at: ev.created_at, _needsReloadContent: true };
          }
          break;
        }
        case 'delete': {
          if (!mid || !indexById.has(mid)) continue;
          const i = indexById.get(mid);
          next[i] = { ...next[i], deleted_at: ev.created_at };
          // Reply previews pointing at this message should flip to the
          // "Esta mensagem foi apagada" tombstone too. We just null the
          // content — the renderer checks for deleted_at on the preview.
          for (let j = 0; j < next.length; j++) {
            const r = next[j]?.reply_to;
            if (r && Number(r.id) === Number(mid)) {
              next[j] = { ...next[j], reply_to: { ...r, content: '', deleted_at: ev.created_at } };
            }
          }
          break;
        }
        case 'reaction': {
          if (!mid || !indexById.has(mid)) continue;
          const i = indexById.get(mid);
          // Server now includes the full reactions array in the payload so
          // we can apply without a follow-up fetch. Fallback to stale-flag
          // behaviour if the server is old and omits it.
          const rx = ev?.payload?.reactions;
          if (Array.isArray(rx)) {
            // Expand grouped {emoji, count, users:[]} rows into the flat
            // [{emoji, email}, ...] shape the UI already renders.
            const flat = [];
            for (const g of rx) {
              const emoji = g?.emoji;
              if (!emoji) continue;
              const users = Array.isArray(g?.users) ? g.users : [];
              for (const u of users) flat.push({ emoji, email: u });
            }
            next[i] = { ...next[i], reactions: flat, _reactionsStale: false };
          } else {
            next[i] = { ...next[i], _reactionsStale: true };
          }
          break;
        }
        case 'read': {
          if (!mid || !indexById.has(mid)) continue;
          const i = indexById.get(mid);
          next[i] = { ...next[i], _readStatus: 2 };
          break;
        }
        // pin / unpin / member_join etc. — no-op for now; the visual
        // effect happens via other API fetches (chat_list, group_info).
        default: break;
      }
    }
    return next;
  });
}
