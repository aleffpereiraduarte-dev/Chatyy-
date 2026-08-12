/**
 * Outbox Drainer — global persistent send queue retry.
 *
 * Existing `chat-conversation.js` already replays pending messages when the
 * user OPENS a conversation. This service adds the missing pieces so the
 * queue drains automatically WITHOUT the user having to navigate:
 *
 *   1. On app boot — drain everything stuck across all conversations
 *   2. On network reconnect (NetInfo: offline → online) — drain
 *   3. On WS reconnect (websocket re-authed) — drain
 *
 * Idempotent + mutex-guarded so overlapping triggers (boot fires while
 * NetInfo also fires) don't double-send. Server-side dedup by
 * `client_message_id` is the final safety net.
 */
import { Platform } from 'react-native';
import { getAllPendingMessages, removePendingMessage, savePendingMessage } from './chatCache';
import * as api from './api';
import { OUTBOX_V2_ONLY } from './messageOutbox';

let _draining = false;
let _initialized = false;
let _lastDrainAt = 0;
const MIN_DRAIN_GAP_MS = 2000; // don't re-drain more often than every 2s

// 7d hard TTL — rows older than this are presumed dead (server schema change,
// account deleted, etc.). UI already flipped them to ❗ at attempt 5; the user
// has had a week to tap-to-retry. Avoids the outbox growing forever when the
// server is permanently rejecting one specific message.
const PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Exponential backoff per row — 0s, 30s, 2m, 10m, 30m, 1h cap. Mirrors the
// offlineCache replay schedule so the two retry paths don't fight each other.
const BACKOFF_LADDER_MS = [0, 30000, 120000, 600000, 1800000, 3600000];

function isHardError(r) {
  // Server returned a structured failure (not network) that won't get better
  // by retrying — e.g. blocked content, banned, parental gate denied. We drop
  // these from the outbox rather than burning attempts forever. 401/auth
  // errors handled separately by the chat-conversation send path.
  if (!r || typeof r !== 'object') return false;
  const code = r.code || r.error_code || '';
  if (typeof code === 'string' && /^(blocked|banned|forbidden|invalid_content|parental)/.test(code)) return true;
  // Backend message strings that signal "no point retrying" — chat.php uses
  // these literal phrases for permanent-rejection paths. Keep this list short
  // and conservative; unknown messages stay in retry mode.
  const msg = String(r.message || r.error || '').toLowerCase();
  if (/parental|blocked|forbidden|conversation not found|not a member|content not allowed/.test(msg)) return true;
  // HTTP 4xx that's NOT 408/429 (which ARE retriable). Preserve unknown
  // shapes — better to keep retrying a transient issue than discard real msgs.
  const status = Number(r.status || r.http_status || 0);
  if (status >= 400 && status < 500 && status !== 408 && status !== 429) return true;
  return false;
}

async function drainOnce(reason = 'manual') {
  // V2 consolidation: messageOutbox + sendWorker own the send queue now.
  // The MMKV-backed legacy path here would compete with the SQLite state
  // machine — same client_message_id getting double-fired, with the
  // server dedup'ing but UI state ("Enviando..." vs "✓") flickering.
  // No-op the entire drain when V2 is on; sendWorker.poke() takes over.
  if (OUTBOX_V2_ONLY) return { skipped: 'v2-only', reason };
  if (_draining) return { skipped: 'already-draining' };
  if (Date.now() - _lastDrainAt < MIN_DRAIN_GAP_MS) return { skipped: 'cooldown' };
  _draining = true;
  _lastDrainAt = Date.now();
  let sent = 0, failed = 0, dropped = 0;
  try {
    const pending = await getAllPendingMessages();
    if (!pending || pending.length === 0) return { sent: 0, failed: 0, reason };
    // Order preservation: send in the same order the user typed them. Without
    // sorting, MMKV key iteration order can flip msg #2 ahead of msg #1 across
    // restarts, and the recipient sees them in wrong order on first delivery.
    const sorted = [...pending].sort((a, b) => {
      const ta = Date.parse(a?.created_at || '') || 0;
      const tb = Date.parse(b?.created_at || '') || 0;
      return ta - tb;
    });
    // Track convs that hit a network error this drain so later messages in
    // the SAME conversation don't overtake the failed one.
    const blockedConvIds = new Set();
    const now = Date.now();
    for (const p of sorted) {
      if (!p?.temp_id || !p?.conversation_id) continue;
      // Per-row TTL: drop messages stuck >7d. The optimistic bubble already
      // shows ❗; user can tap-to-retry which re-queues a fresh row.
      const createdAt = Date.parse(p.created_at || '') || 0;
      if (createdAt && now - createdAt > PENDING_TTL_MS) {
        try { await removePendingMessage(p.conversation_id, p.temp_id); } catch {}
        dropped++;
        continue;
      }
      // Skip rows still being held by the open conversation; that screen has
      // its own retry that already runs. We only want to cover *closed*
      // conversations + cold boots.
      const ageMs = now - createdAt;
      if (ageMs < 5000) continue; // give in-screen retry the first 5s
      // Per-row backoff: respect next_retry_at written on previous failure so
      // a permanently-rejecting send doesn't hammer the server every periodic
      // tick (was: every 60s forever).
      if (p.next_retry_at && p.next_retry_at > now) continue;
      // Order: don't overtake an earlier message that just failed in this drain.
      if (blockedConvIds.has(p.conversation_id)) continue;
      // Media rows: replaying without the uploaded file_url inserts a fileless
      // message under the SAME client_message_id — the real chat_upload then
      // hits the 23505 dedup, unlinks the blob it just uploaded and returns the
      // broken row (irreversible media loss). Only replay media when we hold a
      // server-side URL; local-only rows wait for the upload path (TTL reaps).
      const fu = String(p.file_url || '');
      const fuRemote = /^https?:\/\//i.test(fu) || fu.indexOf('/data/') === 0;
      if (['image', 'video', 'audio', 'voice', 'video_note', 'file'].includes(p.type) && !fuRemote) continue;
      try {
        const clientId = p.client_message_id || p.temp_id;
        const r = await api.chatSend(
          p.conversation_id,
          p.content,
          p.type || 'text',
          p.reply_to_id || null,
          p.mentions || null,
          fuRemote ? fu : null,
          p.temp_id,
          clientId,
        );
        if (r?.success && r?.data?.id) {
          removePendingMessage(p.conversation_id, p.temp_id).catch(() => {});
          // Cancel any duplicate offline-queue retry for the SAME message —
          // chat-conversation's send-catch path queues into offlineCache when
          // the HTTP fails, but if outboxDrainer succeeds first we must purge
          // that twin entry or replayOfflineQueue will fire it later (server
          // dedups via UNIQUE client_message_id but UI flickers).
          try {
            const { removeChatSendFromQueueByClientMsgId } = require('./offlineCache');
            removeChatSendFromQueueByClientMsgId(clientId).catch(() => {});
          } catch {}
          sent++;
          // Relay over WS so the open conversation (if any) sees the
          // confirmed message instantly instead of waiting for the next
          // chat_summary fan-out.
          try {
            const mailWs = require('./websocket').default;
            if (mailWs?.isConnected && mailWs?.authenticated) {
              mailWs.relayChatMessage(
                p.conversation_id,
                r.data,
                p.temp_id,
                Array.isArray(p.member_emails) ? p.member_emails : [],
              );
            }
          } catch {}
        } else if (isHardError(r)) {
          // Server says no — drop instead of looping forever.
          try { await removePendingMessage(p.conversation_id, p.temp_id); } catch {}
          dropped++;
          // Surface to the open conversation so its bubble flips to ❗ if visible.
          try {
            const evt = require('./sendFailEvents');
            evt.emitSendFail?.(p.conversation_id, p.temp_id, clientId);
          } catch {}
        } else {
          // Soft failure — bump attempt counter + schedule next try via backoff.
          // Persist the bumped row so reboots don't reset the ladder.
          failed++;
          const attempts = (p.attempts || 0) + 1;
          const delay = BACKOFF_LADDER_MS[Math.min(attempts, BACKOFF_LADDER_MS.length - 1)];
          try {
            await savePendingMessage(p.conversation_id, {
              ...p, attempts, next_retry_at: now + delay,
            });
          } catch {}
          blockedConvIds.add(p.conversation_id);
          if (attempts >= 5) {
            try {
              const evt = require('./sendFailEvents');
              evt.emitSendFail?.(p.conversation_id, p.temp_id, clientId);
            } catch {}
          }
        }
      } catch {
        failed++;
        // Network-level error → bump backoff for THIS row and block this
        // conversation, but keep going for OTHER conversations (was: hard
        // break, which left messages in unrelated convs stuck on the same
        // tick even though one of them might have succeeded).
        const attempts = (p.attempts || 0) + 1;
        const delay = BACKOFF_LADDER_MS[Math.min(attempts, BACKOFF_LADDER_MS.length - 1)];
        try {
          await savePendingMessage(p.conversation_id, {
            ...p, attempts, next_retry_at: now + delay,
          });
        } catch {}
        blockedConvIds.add(p.conversation_id);
      }
    }
    return { sent, failed, dropped, reason };
  } finally {
    _draining = false;
  }
}

/** Call once at app boot (after auth resolves). Wires reconnect listeners. */
export function initOutboxDrainer() {
  if (_initialized) return;
  _initialized = true;
  // V2: skip wiring boot/NetInfo/WS/periodic triggers. sendWorker.start()
  // covers all of these on the messageOutbox SQLite path. Keeping the
  // legacy timers alive would just spin no-ops every 60s.
  if (OUTBOX_V2_ONLY) {
    try { console.log('[outboxDrainer] v2-only mode — legacy MMKV drain disabled'); } catch {}
    return;
  }

  // Initial drain ~3s after boot so chat screens have a chance to mount and
  // the app's primary work isn't competing for CPU.
  setTimeout(() => { drainOnce('boot').catch(() => {}); }, 3000);

  // Network reconnect → drain
  try {
    const { onNetworkChange } = require('./networkInfo');
    onNetworkChange?.((state) => {
      if (state?.isConnected && state?.isInternetReachable !== false) {
        drainOnce('network-reconnect').catch(() => {});
      }
    });
  } catch {}

  // WS reconnect → drain (covers cases where TCP/HTTP had connectivity but
  // the WS specifically dropped + re-authed)
  try {
    const mailWs = require('./websocket').default;
    mailWs?.on?.('authenticated', () => { drainOnce('ws-authed').catch(() => {}); });
    mailWs?.on?.('reconnected', () => { drainOnce('ws-reconnected').catch(() => {}); });
  } catch {}

  // Periodic safety net every 60s. Cheap when queue is empty.
  setInterval(() => { drainOnce('periodic').catch(() => {}); }, 60000);

  // Web only: receive SW background sync trigger. SW dispatches "sw_drain_outbox"
  // postMessage when browser says "ok, you can sync now" (right after coming
  // back online). Cobre o caso onde a página estava em background e o NetInfo
  // listener não disparou.
  if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.serviceWorker) {
    try {
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e?.data?.type === 'sw_drain_outbox') {
          drainOnce('sw-sync').catch(() => {});
        }
      });
      // Try to register a one-shot sync (browsers ignore if not supported).
      navigator.serviceWorker.ready.then(reg => {
        try { reg.sync?.register?.('chat-outbox'); } catch {}
      }).catch(() => {});
    } catch {}
  }
}

export { drainOnce };
