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

// ─── Unified cursor facade (Builder 1 owns ./chatStore) ───────────────
// The cursor lives in ONE place — chatStore.getCursor/setCursor — so the
// sync path (this file) and the conversation-open path (Builder 3) share a
// single watermark of `{last_pts, last_msg_id}` per scope ('conv:'+id or
// 'list'). The facade may not exist yet mid-migration, so every access is
// defensive: require it lazily, tolerate a default OR named export, and fall
// back to the legacy MMKV pts below when it's absent. isLocked() gates every
// write so we never persist another account's data (multi-account isolation).
function chatStore() {
  try {
    const m = require('./chatStore');
    return (m && (m.default || m)) || null;
  } catch { return null; }
}
function storeLocked(cs) {
  try { return !!(cs && typeof cs.isLocked === 'function' && cs.isLocked()); }
  catch { return false; }
}

// ─── Last-seen pts persistence ────────────────────────────────────────
export function getLastPts(convId) {
  // Prefer the unified cursor when the facade is present so the sync path and
  // the conversation-open path read the SAME watermark. Fall back to the
  // legacy MMKV read so nothing breaks before/while chatStore lands.
  try {
    const cs = chatStore();
    if (cs && typeof cs.getCursor === 'function') {
      const cur = cs.getCursor('conv:' + convId);
      const p = cur && Number(cur.last_pts);
      if (Number.isFinite(p) && p > 0) return p;
    }
  } catch {}
  try {
    const v = getString(LAST_PTS_KEY(convId));
    const n = v ? parseInt(v, 10) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch { return 0; }
}
export function setLastPts(convId, pts, msgId) {
  if (!convId || !Number.isFinite(pts) || pts <= 0) return;
  // (1) Legacy MMKV write — kept working (additive) so the fallback path in
  // getLastPts stays valid even if the facade is cleared. Guard against
  // regression using the MMKV value DIRECTLY (not getLastPts, which may now
  // read a facade cursor that's ahead) so MMKV never starves.
  try {
    const raw = getString(LAST_PTS_KEY(convId));
    const mmkvCur = raw ? parseInt(raw, 10) : 0;
    if (!(Number.isFinite(mmkvCur) && mmkvCur >= pts)) setString(LAST_PTS_KEY(convId), String(pts));
  } catch {}
  // (2) Unified cursor write — pts AND last_msg_id in one place. Monotonic
  // per field; preserves an existing last_msg_id when this caller has none.
  try {
    const cs = chatStore();
    if (cs && typeof cs.setCursor === 'function' && !storeLocked(cs)) {
      const prev = (typeof cs.getCursor === 'function') ? cs.getCursor('conv:' + convId) : null;
      const prevPts = (prev && Number(prev.last_pts)) || 0;
      const prevMsg = (prev && Number(prev.last_msg_id)) || 0;
      const nextPts = Math.max(prevPts, pts);
      const nextMsg = Math.max(prevMsg, Number(msgId) || 0);
      if (nextPts > prevPts || nextMsg > prevMsg) {
        cs.setCursor('conv:' + convId, { last_pts: nextPts, last_msg_id: nextMsg });
      }
    }
  } catch {}
}
// Called whenever the client processes any message/event for a conv —
// tracks the highest observed pts so future syncs know the watermark.
export function observePts(convId, pts, msgId) {
  if (Number.isFinite(pts) && pts > 0) setLastPts(convId, pts, msgId);
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
      if (!r?.success) {
        // [2026-07-02] A returned body (even success:false) is a DEFINITIVE
        // server answer — bad conv id, PG error, etc. Retrying it 3× with
        // 500ms + 1500ms backoff just stalls the foreground ~2s for a result
        // that will not change. Only NETWORK/transport errors (which throw
        // below into the catch) deserve a retry. So break out immediately here.
        lastErr = r?.error || 'no_success';
        break;
      }
      const out = Array.isArray(r.data?.conversations) ? r.data.conversations : [];
      for (const c of out) {
        if (c?.denied) { gapStreak.delete(c.id); continue; }
        const latest = Number(c.latest_pts || 0);
        // Watermark fix (2026-06-28): when has_more, the server only returned a
        // PAGE of events up to some pts < latest_pts. Advancing the watermark to
        // latest_pts here would skip every event between the last returned event
        // and latest_pts on the next pull. Advance only to the max pts we
        // actually received; needsFullReload below stays as the safety net.
        const evMax = Array.isArray(c.events)
          ? c.events.reduce((m, e) => Math.max(m, Number(e.pts) || 0), 0)
          : 0;
        // [2026-07-03] Hydration-gap guard. If the server returned a
        // `new_message` event whose row is NOT in c.messages (under-hydration,
        // or a message deleted between event-log write and hydration),
        // advancing the watermark past it would drop that message FOREVER — the
        // next delta asks since_pts > its pts, so it's never requested again.
        // Detect the miss, hold the watermark one BELOW the lowest un-hydrated
        // new_message pts (so it's re-requested), and flag a full reload as the
        // belt-and-suspenders recovery. No-op when hydration is complete.
        let hydCapPts = Infinity;
        if (Array.isArray(c.events) && Array.isArray(c.messages)) {
          const hydIds = new Set(c.messages.map(m => Number(m.id)));
          for (const e of c.events) {
            if (e?.type === 'new_message') {
              const emid = Number(e?.payload?.message_id) || 0;
              if (emid && !hydIds.has(emid)) {
                const eps = Number(e.pts) || Infinity;
                if (eps < hydCapPts) hydCapPts = eps;
                c.needsFullReload = true;
              }
            }
          }
        }
        let wm = c.has_more ? evMax : latest;
        if (hydCapPts !== Infinity) wm = Math.min(wm, hydCapPts - 1);
        // last_msg_id companion for the unified cursor: the highest message id
        // we actually hydrated for this conv. When a hydration gap held the pts
        // watermark back (hydCapPts), DON'T advance the msg cursor either —
        // pass 0 so setLastPts keeps the previous value and the full-reload
        // safety net (needsFullReload) re-fetches the hole.
        const msgMax = Array.isArray(c.messages)
          ? c.messages.reduce((m, r) => Math.max(m, Number(r.id) || 0), 0)
          : 0;
        const wmMsg = hydCapPts !== Infinity ? 0 : msgMax;
        if (wm > 0) setLastPts(c.id, wm, wmMsg);
        if (c.has_more) {
          const n = (gapStreak.get(c.id) || 0) + 1;
          gapStreak.set(c.id, n);
          if (n >= 2) c.needsFullReload = true;
        } else {
          gapStreak.delete(c.id);
        }
      }
      // ─── List cursor (additive) ───────────────────────────────────────
      // A single global watermark across every conv we just reconciled, so
      // the conversation list can do a cheap delta on cold start instead of a
      // full re-pull. Highest latest_pts + highest hydrated message id.
      // Written through the facade only; monotonic; gated by isLocked().
      try {
        const cs = chatStore();
        if (cs && typeof cs.setCursor === 'function' && !storeLocked(cs)) {
          let gPts = 0, gMsg = 0;
          for (const c of out) {
            if (c?.denied) continue;
            gPts = Math.max(gPts, Number(c.latest_pts) || 0);
            if (Array.isArray(c.messages)) {
              for (const r of c.messages) gMsg = Math.max(gMsg, Number(r.id) || 0);
            }
          }
          const prev = (typeof cs.getCursor === 'function') ? cs.getCursor('list') : null;
          const pPts = (prev && Number(prev.last_pts)) || 0;
          const pMsg = (prev && Number(prev.last_msg_id)) || 0;
          if (gPts > pPts || gMsg > pMsg) {
            cs.setCursor('list', { last_pts: Math.max(gPts, pPts), last_msg_id: Math.max(gMsg, pMsg) });
          }
        }
      } catch {}
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
      // [2026-10-01] Captura a conta ativa no momento em que o sync dispara.
      let _syncAcct = '';
      try { _syncAcct = require('./sqliteStore').getActiveAccount(); } catch {}
      _inFlight = _runSync(ids).finally(() => { _inFlight = null; });
      try {
        let out = await _inFlight;
        // [2026-10-01] GUARDA MULTI-CONTA (privacidade): se o usuário trocou de
        // conta enquanto este sync estava em voo, DESCARTA o resultado. A trava
        // de escopo de 800ms pode expirar no meio de um sync lento; aplicar os
        // eventos da conta A depois da troca pra B espelharia as mensagens de A
        // no SQLite/tela de B (carimbadas com a conta ativa). applyEvents faz
        // no-op em array vazio (chatSync.js:301), então [] é um descarte seguro.
        try {
          const _nowAcct = require('./sqliteStore').getActiveAccount();
          if (_syncAcct && _nowAcct && _syncAcct !== _nowAcct) out = [];
        } catch {}
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
 *   - member_join /
 *     member_leave      → append the hydrated "X joined/left" system message
 *                         (same path as new_message)
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
    // Route disk writes through the facade when it's present; it owns the
    // SQLite mirror AND the durable web (IndexedDB) store. When the store is
    // LOCKED (account switch / another account active) we skip every disk
    // write — the React state patch below is in-memory only and harmless.
    const cs = chatStore();
    const diskLocked = cs && storeLocked(cs);
    for (const ev of events) {
      if (diskLocked) break;
      const mid = Number(ev?.payload?.message_id) || 0;
      if (!mid) continue;
      if (ev.type === 'new_message' || ev.type === 'member_join' || ev.type === 'member_leave') {
        // member_join/member_leave carry the "X joined/left" sysmsg id and the
        // server hydrates the row (pulse-20260802) — persist it like any
        // message so the sysmsg survives a cold reopen.
        const hyd = hydratedMap.get(mid);
        if (hyd && hyd.conversation_id) {
          // Prefer the facade (single write path); fall back to chatCache
          // directly only when the facade isn't there yet. NEVER both — the
          // facade wraps chatCache internally, so calling both double-writes.
          if (cs && typeof cs.upsertMessages === 'function') {
            try { const p = cs.upsertMessages(hyd.conversation_id, [hyd]); p?.catch?.(() => {}); } catch {}
          } else {
            chatCache.cacheSingleMessage?.(hyd.conversation_id, hyd).catch?.(() => {});
          }
        }
      } else if (ev.type === 'edit') {
        const newContent = ev?.payload?.content;
        const convId = ev?.payload?.conversation_id;
        if (convId && typeof newContent === 'string') {
          chatCache.updateCachedMessage?.(convId, mid, { content: newContent, edited_at: ev.created_at }).catch?.(() => {});
        }
      } else if (ev.type === 'delete') {
        const convId = ev?.payload?.conversation_id;
        // Soft-delete → facade tombstone (keyed by id) when present; else the
        // legacy chatCache soft-delete (which needs convId). One path only.
        if (cs && typeof cs.tombstoneMessage === 'function') {
          try { const p = cs.tombstoneMessage(mid); p?.catch?.(() => {}); } catch {}
        } else if (convId) {
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
        //
        // senderNot guard: the watermark id can be the reader's OWN last
        // message (chat_read falls back to MAX(id) of the conv), and our own
        // read event echoes back to us via chat_sync — without the guard the
        // mirror stamped read_at on our own bubble (false purple on cold
        // open). Actor missing → skip rather than stamp unguarded.
        const convId = ev?.payload?.conversation_id;
        if (ev?.actor) {
          chatCache.updateCachedMessage?.(convId, mid, { read_at: ev.created_at, _readStatus: 2 }, { senderNot: ev.actor }).catch?.(() => {});
        }
      } else if (ev.type === 'delivered') {
        // Mirror the grey ✓✓ to disk so a delivery learned ONLY via a delta
        // sync (reconnect catch-up — never via a full chat_messages refetch)
        // doesn't regress back to a single ✓ on the next cold reopen. The live
        // WS `chat_delivered` handler already flips the in-memory bubble; this
        // is the persistence twin of the `read` mirror above.
        //
        // The 'delivered' event coalesces a burst into payload.message_ids[]
        // (no singular message_id — so `mid` above is 0 here). Stamp ONLY
        // `delivered_at`: the cold-load enrichment (chat-conversation ~18720)
        // checks read state BEFORE delivered, so an already-read bubble can
        // never be downgraded by this — read_at/_read/maxReadId always win.
        // We never touch `status`/`_read`/`read_at`, so there is no way to
        // regress a blue ✓✓. convId may be absent — the SQLite path keys by
        // message id regardless; convId only feeds the MMKV mirror key.
        const convId = ev?.payload?.conversation_id;
        const dids = Array.isArray(ev?.payload?.message_ids)
          ? ev.payload.message_ids.map(Number).filter(n => n > 0)
          : [];
        for (const did of dids) {
          chatCache.updateCachedMessage?.(convId, did, { delivered_at: ev.created_at, _delivered: true }).catch?.(() => {});
        }
      }
    }
  } catch (e) {
    if (__DEV__) console.warn('[chatSync] applyEvents SQLite mirror failed (non-fatal):', e?.message || e);
  }

  // [2026-10-05] DELIVERED-ON-RECONNECT. A message that arrived while THIS device
  // was offline is pulled in here by syncConversations' catch-up — but until now
  // nothing acked it as delivered, so the SENDER's bubble stayed at ✓ (sent)
  // until the recipient actually OPENED the thread. The live WS handler
  // (websocket.js) and the foreground push handler (pushNotifications.js) ack on
  // receipt, but the delta-sync path (reconnect / app-foreground catch-up) was a
  // blind spot. WhatsApp flips ✓✓ the moment the device ingests the message, by
  // any route. Mirror that: collect every incoming (sender ≠ me) new_message we
  // just learned and fire a coalesced delivery ack. chatDeliveryAckBatched dedups
  // + retries; the server is idempotent (COALESCE), so re-acking what the live
  // path already handled is a cheap no-op. Non-members get a silent server no-op.
  try {
    let _me = '';
    try { _me = String(require('./sqliteStore').getActiveAccount() || '').toLowerCase(); } catch {}
    const _ackByConv = new Map(); // convId -> Set<messageId>
    for (const ev of events) {
      if (ev?.type !== 'new_message') continue;
      const mid = Number(ev?.payload?.message_id) || 0;
      if (!mid) continue;
      const hyd = hydratedMap.get(mid);
      if (!hyd || !hyd.conversation_id) continue;
      const snd = String(hyd.sender_email || '').toLowerCase();
      if (!snd || (_me && snd === _me)) continue; // never ack our OWN messages
      let s = _ackByConv.get(hyd.conversation_id);
      if (!s) { s = new Set(); _ackByConv.set(hyd.conversation_id, s); }
      s.add(mid);
    }
    if (_ackByConv.size) {
      const _api = require('./api');
      for (const [cid, set] of _ackByConv.entries()) {
        try { _api.chatDeliveryAckBatched?.(cid, Array.from(set)); } catch {}
      }
    }
  } catch (e) {
    if (__DEV__) console.warn('[chatSync] applyEvents delivered-ack failed (non-fatal):', e?.message || e);
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
      // [2026-07-04 phantom-outbox fix] Also index by client_action_id so a
      // server row echoing the native uploader's action id folds onto its
      // optimistic/pending bubble instead of appending a duplicate.
      const aid = next[i]?._action_id || next[i]?.client_action_id;
      if (aid) indexByClientId.set(String(aid), i);
    }
    for (const ev of events) {
      const mid = Number(ev?.payload?.message_id) || 0;
      switch (ev.type) {
        // member_join / member_leave reference the "X joined/left" system
        // message; before this they fell into the default no-op while the
        // watermark advanced past them, so a device offline at join/leave
        // time NEVER showed the sysmsg (permanent hole in fullHistorySync
        // convs). The server hydrates their rows since pulse-20260802; an
        // un-hydrated event (old server) still skips harmlessly below.
        case 'member_join':
        case 'member_leave':
        case 'new_message': {
          if (!mid) continue;
          const hydrated = hydratedMap.get(mid);
          if (!hydrated) continue;
          if (indexById.has(mid)) continue;         // already in state
          // Replace optimistic bubble if this event is for a message the
          // sender's own client already queued locally.
          const cid = hydrated.client_message_id;
          const aid = hydrated.client_action_id;
          if ((cid && indexByClientId.has(cid)) || (aid && indexByClientId.has(String(aid)))) {
            const i = (cid && indexByClientId.has(cid)) ? indexByClientId.get(cid) : indexByClientId.get(String(aid));
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
            if (cid) indexByClientId.delete(cid);
            if (aid) indexByClientId.delete(String(aid));
            break;
          }
          // [2026-07-03] Sorted insert (was a plain append). This path
          // backfills MISSED messages on reconnect / gap-fill — a raw push
          // lands a recovered older id (505) AFTER a newer already-shown one
          // (510), leaving the thread mis-ordered until a reload. Find the
          // position that keeps ascending id order (mirrors the live WS
          // handler's sorted insert).
          const row = { ...hydrated, _animateIn: false };
          let ins = next.length;
          for (let k = next.length - 1; k >= 0; k--) {
            const kid = Number(next[k]?.id) || 0;
            if (kid && kid < mid) { ins = k + 1; break; }
            if (k === 0) ins = 0;
          }
          next.splice(ins, 0, row);
          if (ins >= next.length - 1) {
            // Appended at the tail (the common live case) — no index shift.
            indexById.set(mid, next.length - 1);
          } else {
            // Mid-array backfill shifted every index after `ins`; rebuild both
            // lookup maps so subsequent edit/delete/reaction events in this same
            // batch still resolve to the correct row.
            indexById.clear();
            indexByClientId.clear();
            for (let k = 0; k < next.length; k++) {
              const kk = Number(next[k]?.id) || 0;
              if (kk) indexById.set(kk, k);
              const kc = next[k]?._client_id || next[k]?.client_message_id;
              if (kc) indexByClientId.set(kc, k);
              const ka = next[k]?._action_id || next[k]?.client_action_id;
              if (ka) indexByClientId.set(String(ka), k);
            }
          }
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
            // Keep the GROUPED {emoji, count, users:[]} shape the renderer
            // expects (it groups by emoji and strips chips whose users list is
            // empty). Flattening to [{emoji,email}] rendered EMPTY chips. This
            // mirrors the disk-cache path above (updateCachedMessage(..., {reactions: rx})).
            next[i] = { ...next[i], reactions: rx, _reactionsStale: false };
          } else {
            next[i] = { ...next[i], _reactionsStale: true };
          }
          break;
        }
        case 'read': {
          // Watermark fold, mirror of the server's chat_read UPDATE: every
          // message with id <= mid NOT sent by the reader is now read. The
          // old form set only `_readStatus` on the single watermark row — a
          // field the enrichment memo in chat-conversation recomputes and
          // overwrites, so a read that arrived via delta sync never painted
          // the blue tick until a full refetch (same class as the fixed
          // 'delivered' case below).
          //
          // The actor guard is load-bearing: mid can be the reader's OWN
          // last message (chat_read falls back to MAX(id) of the conv) and
          // our own read event echoes back to us — without the guard we'd
          // stamp read_at on our own bubbles and fake a blue tick the peer
          // never produced. Actor missing → do nothing (the old write was
          // inert anyway). read_at only feeds the tick in non-group convs
          // (renderer rule), so group semantics stay server-driven.
          if (!mid || !ev?.actor) break;
          const actor = String(ev.actor).toLowerCase();
          for (let k = 0; k < next.length; k++) {
            const kid = Number(next[k]?.id) || 0;
            if (!kid || kid > mid) continue;
            if (String(next[k]?.sender_email || '').toLowerCase() === actor) continue;
            if (next[k].read_at) continue;
            // [2026-10-04] Lido implica ENTREGUE — marca _delivered/delivered_at
            // junto do read. O renderer agora exige entrega p/ pintar azul (mata
            // azul falso em msg não-entregue), então leitura REAL do peer precisa
            // carregar a entrega também, senão ficaria cinza.
            next[k] = {
              ...next[k],
              read_at: ev.created_at,
              _delivered: true,
              delivered_at: next[k].delivered_at || ev.created_at,
              _readStatus: 2,
            };
          }
          break;
        }
        case 'delivered': {
          // Server coalesces a delivery-ack burst into ONE 'delivered' event
          // carrying payload.message_ids[] (NO singular message_id — so the
          // old `default: break` dropped it and ✓ → ✓✓ never flipped via a
          // delta sync, only via the live WS `chat_delivered` handler). Mirror
          // that batch handler (chat-conversation.js ~12042): flip every bubble
          // in the set to delivered, but never downgrade one already read.
          const dids = Array.isArray(ev?.payload?.message_ids)
            ? ev.payload.message_ids.map(Number).filter(n => n > 0)
            : [];
          if (!dids.length) break;
          const dset = new Set(dids);
          for (let k = 0; k < next.length; k++) {
            const kid = Number(next[k]?.id) || 0;
            if (!kid || !dset.has(kid)) continue;
            if (next[k].status === 'read' || next[k]._readStatus === 2) continue;
            next[k] = {
              ...next[k],
              status: 'delivered',
              _delivered: true,
              delivered_at: next[k].delivered_at || ev.created_at,
            };
          }
          break;
        }
        // pin / unpin etc. — no-op for now; the visual effect happens
        // via other API fetches (chat_list, group_info).
        default: break;
      }
    }
    return next;
  });
}
