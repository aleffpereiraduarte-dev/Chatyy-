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
/**
 * Pull every event missed since our last-known pts for each conversation.
 * @param {Array<number|string>} convIds — list of conversation ids to sync.
 * @returns {Promise<Array<{id, events, messages, latest_pts, has_more}>>}
 */
export async function syncConversations(convIds) {
  if (!Array.isArray(convIds) || convIds.length === 0) return [];
  const body = {
    conversations: convIds.map(id => ({
      id: Number(id),
      since_pts: getLastPts(id),
      limit: 500,
    })),
  };
  try {
    const r = await api.apiCall('chat_sync', body, 'POST');
    if (!r?.success) return [];
    const out = r.data?.conversations || [];
    // Advance the watermark for each conversation we got data for. Even if
    // events is empty, `latest_pts` tells us everything up to that point is
    // accounted for (so next sync starts from latest, not stale).
    for (const c of out) {
      const latest = Number(c.latest_pts || 0);
      if (latest > 0) setLastPts(c.id, latest);
    }
    return out;
  } catch (e) {
    return [];
  }
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
    for (const ev of events) {
      const mid = ev?.payload?.message_id;
      switch (ev.type) {
        case 'new_message': {
          if (!mid) continue;
          const hydrated = hydratedMap.get(mid);
          if (!hydrated) continue;
          if (indexById.has(mid)) continue;         // already in state
          // Keep pts on the row so client-side dedup / sorting can use it
          next.push({ ...hydrated, _animateIn: false });
          indexById.set(mid, next.length - 1);
          break;
        }
        case 'edit': {
          if (!mid || !indexById.has(mid)) continue;
          const i = indexById.get(mid);
          next[i] = { ...next[i], edited_at: ev.created_at, _needsReloadContent: true };
          break;
        }
        case 'delete': {
          if (!mid || !indexById.has(mid)) continue;
          const i = indexById.get(mid);
          next[i] = { ...next[i], deleted_at: ev.created_at };
          break;
        }
        case 'reaction': {
          // Reactions aren't self-contained in the event payload (we only
          // store message_id). Flag the row so the view can refetch.
          if (!mid || !indexById.has(mid)) continue;
          const i = indexById.get(mid);
          next[i] = { ...next[i], _reactionsStale: true };
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
