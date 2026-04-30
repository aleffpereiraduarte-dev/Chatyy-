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
import { getAllPendingMessages, removePendingMessage } from './chatCache';
import * as api from './api';

let _draining = false;
let _initialized = false;
let _lastDrainAt = 0;
const MIN_DRAIN_GAP_MS = 2000; // don't re-drain more often than every 2s

async function drainOnce(reason = 'manual') {
  if (_draining) return { skipped: 'already-draining' };
  if (Date.now() - _lastDrainAt < MIN_DRAIN_GAP_MS) return { skipped: 'cooldown' };
  _draining = true;
  _lastDrainAt = Date.now();
  let sent = 0, failed = 0;
  try {
    const pending = await getAllPendingMessages();
    if (!pending || pending.length === 0) return { sent: 0, failed: 0, reason };
    for (const p of pending) {
      if (!p?.temp_id || !p?.conversation_id) continue;
      // Skip rows still being held by the open conversation; that screen has
      // its own retry that already runs. We only want to cover *closed*
      // conversations + cold boots.
      const ageMs = Date.now() - new Date(p.created_at || 0).getTime();
      if (ageMs < 5000) continue; // give in-screen retry the first 5s
      try {
        const clientId = p.client_message_id || p.temp_id;
        const r = await api.chatSend(
          p.conversation_id,
          p.content,
          p.type || 'text',
          p.reply_to_id || null,
          p.mentions || null,
          null,
          p.temp_id,
          clientId,
        );
        if (r?.success && r?.data?.id) {
          removePendingMessage(p.conversation_id, p.temp_id).catch(() => {});
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
        } else {
          failed++;
        }
      } catch {
        failed++;
        // Network-level error → stop draining; we'll get retriggered when
        // the network or WS reconnects. Avoids burning the rest of the
        // queue against the same offline failure.
        break;
      }
    }
    return { sent, failed, reason };
  } finally {
    _draining = false;
  }
}

/** Call once at app boot (after auth resolves). Wires reconnect listeners. */
export function initOutboxDrainer() {
  if (_initialized) return;
  _initialized = true;

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
