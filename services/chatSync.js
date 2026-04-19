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

/**
 * Pull every event missed since our last-known pts for each conversation.
 * Retries on network error with exponential backoff (3 attempts).
 *
 * @param {Array<number|string>} convIds
 * @returns {Promise<Array<{id, events, messages, latest_pts, has_more, denied?, needsFullReload?}>>}
 */
export async function syncConversations(convIds) {
  if (!Array.isArray(convIds) || convIds.length === 0) return [];
  if (convIds.length > MAX_CONVS_PER_REQ) convIds = convIds.slice(0, MAX_CONVS_PER_REQ);

  const body = {
    conversations: convIds.map(id => ({
      id: Number(id),
      since_pts: getLastPts(id),
      limit: 500,
    })),
  };

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
  const hydratedMap = new Map(hydratedMessages.map(m => [m.id, m]));
  setMessages(prev => {
    const next = [...prev];
    const indexById = new Map(next.map((m, i) => [m.id, i]));
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
      const mid = ev?.payload?.message_id;
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
            next[i] = { ...hydrated, _animateIn: false };
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
