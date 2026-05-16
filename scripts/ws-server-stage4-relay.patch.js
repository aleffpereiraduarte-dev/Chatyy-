/**
 * Stage 3 + Stage 4 patch for /opt/onemundo-mail-ws/server.js
 * ============================================================
 *
 * Stage 3: relay_request / relay_response WS pipe between the web companion
 *          device and the user's phone (which owns the SQLite chat history).
 *
 * Stage 4: silent push wake. When the phone has no live WS session at the
 *          moment a relay_request arrives, server fires a silent FCM data
 *          push via the new chat.php?action=chat_wake_phone endpoint. The
 *          phone's native handler briefly opens a raw WebSocket, satisfies
 *          the relay, and tears down — no React Native bundle required.
 *
 * Deployment
 * ----------
 * The production WS server lives at /opt/onemundo-mail-ws/server.js (outside
 * this repo, gitignored). To apply: copy the three blocks below into the
 * referenced anchors in server.js, then `systemctl restart onemundo-ws`.
 *
 * Anchors (use grep to find them):
 *   1. Top-of-file state map block      → just after `const presenceMap = new Map();`
 *   2. New message-handler case          → just after `case 'chat_message_relay': { ... }`
 *   3. Drain-on-auth + cleanup-on-close  → inside `case 'auth':` (after auth_success)
 *                                          AND inside the disconnect cleanup loop
 *
 * Configuration env vars (already in /etc/mail-api.env):
 *   - MAIL_WS_KEY      → same secret used by every other WS↔PHP call
 *                        (NO new secret introduced; the task allowed reusing
 *                         the existing inter-process token)
 *
 * Timeout choices (tunable):
 *   - RELAY_WAKE_WINDOW_MS = 15000   server waits 15s for phone reconnect
 *   - RELAY_REQUEST_TTL_MS = 25000   how long a relay request can sit pending
 *                                    even when phone IS online but slow to answer
 *   - PHONE_WS_HOLD_MS    = 10000    (native side) hold raw WS open 10s post-wake
 *
 * NOTE: This is documentation + a require()-able helper. The actual edits
 * to server.js must be made by ops. The block(s) below are paste-ready.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────
// BLOCK 1 — top-of-file state (paste just after `presenceMap` declaration)
// ─────────────────────────────────────────────────────────────────────────
/*
// ─── Stage 3/4 (web↔phone history relay) ───
// Web companion (laptop/tablet logged into the same account) holds NO chat
// history of its own; it asks the phone for messages on demand via the
// `relay_request` event. Server forwards to the phone's chat_user_<email>
// channel. If the phone is offline, server triggers a silent FCM push
// (Stage 4) and parks the request here for up to RELAY_WAKE_WINDOW_MS.
//
// Map keyed by lowercase email. Value = array of {
//   requesterClientId, requestId, action, params, expiresAt
// }
const wakePendingRelays = new Map();
const RELAY_WAKE_WINDOW_MS = 15000;
const RELAY_REQUEST_TTL_MS = 25000;

function queueRelayForWake(targetEmail, entry) {
  const key = String(targetEmail || '').toLowerCase();
  if (!key) return;
  if (!wakePendingRelays.has(key)) wakePendingRelays.set(key, []);
  const arr = wakePendingRelays.get(key);
  arr.push(entry);
  // Hard cap so a noisy web client can't OOM us.
  if (arr.length > 50) arr.splice(0, arr.length - 50);
}

function drainRelaysForEmail(targetEmail) {
  const key = String(targetEmail || '').toLowerCase();
  const arr = wakePendingRelays.get(key);
  if (!arr || arr.length === 0) return 0;
  wakePendingRelays.delete(key);
  let forwarded = 0;
  const userCh = `chat_user_${key}`;
  const subs = channels.get(userCh);
  if (!subs || subs.size === 0) {
    // Phone WS came up but isn't subscribed yet — re-queue, the auth path
    // will retry on the next subscribe call.
    wakePendingRelays.set(key, arr);
    return 0;
  }
  for (const entry of arr) {
    const payload = {
      type: 'relay_request',
      requestId: entry.requestId,
      action: entry.action,
      params: entry.params || {},
      requester: entry.requesterEmail || '',
      ts: Date.now(),
    };
    for (const id of subs) sendWithAck(id, payload);
    forwarded++;
  }
  return forwarded;
}

function expireRelay(targetEmail, requestId) {
  const key = String(targetEmail || '').toLowerCase();
  const arr = wakePendingRelays.get(key);
  if (!arr) return;
  const i = arr.findIndex(e => e.requestId === requestId);
  if (i < 0) return;
  const [entry] = arr.splice(i, 1);
  if (arr.length === 0) wakePendingRelays.delete(key);
  const req = clients.get(entry.requesterClientId);
  if (req && req.ws && req.ws.readyState === WebSocket.OPEN) {
    sendTo(entry.requesterClientId, {
      type: 'relay_response',
      requestId: entry.requestId,
      error: 'phone_offline',
      ts: Date.now(),
    });
  }
}

// Whitelist of relay actions the phone is allowed to satisfy. Anything else
// is rejected at the source so a compromised web client can't request, e.g.,
// "decrypt and dump every message". Mirrors the JS relayResponder.js list.
const RELAY_ACTION_WHITELIST = new Set([
  'get_messages',
  'get_conversations',
  'get_message',
  'search_messages',
  'get_contacts',
]);
*/

// ─────────────────────────────────────────────────────────────────────────
// BLOCK 2 — new message-handler cases (paste inside the big switch block,
// right after `case 'chat_message_relay': { ... }`)
// ─────────────────────────────────────────────────────────────────────────
/*
      case 'relay_request': {
        // Web (or another device) is asking the phone for chat history that
        // only the phone has in SQLite. Pipe to chat_user_<target>.
        if (!c.email) break;
        const target = String(msg.target_email || c.email).toLowerCase();
        const requestId = String(msg.requestId || msg.request_id || '');
        const action = String(msg.action || '');
        if (!requestId || !action || !RELAY_ACTION_WHITELIST.has(action)) {
          sendTo(clientId, {
            type: 'relay_response',
            requestId,
            error: 'invalid_action',
            ts: Date.now(),
          });
          break;
        }
        const params = (msg.params && typeof msg.params === 'object') ? msg.params : {};

        const userCh = `chat_user_${target}`;
        const subs = channels.get(userCh);
        const phoneOnline = subs && subs.size > 0
          // Only treat as online if at least one subscriber is a *different*
          // session than the requester — otherwise the web tab would be
          // asking itself for data.
          && Array.from(subs).some(id => id !== clientId);

        if (phoneOnline) {
          // Forward immediately.
          const fwd = {
            type: 'relay_request',
            requestId,
            action,
            params,
            requester: c.email,
            ts: Date.now(),
          };
          for (const id of subs) {
            if (id !== clientId) sendWithAck(id, fwd);
          }
          break;
        }

        // Phone WS offline. Park the request + fire silent wake push.
        const entry = {
          requesterClientId: clientId,
          requesterEmail: c.email,
          requestId,
          action,
          params,
          expiresAt: Date.now() + RELAY_REQUEST_TTL_MS,
        };
        queueRelayForWake(target, entry);

        // Fire-and-forget wake push via chat.php.
        try {
          fetch('http://127.0.0.1/api/chat.php?action=chat_wake_phone', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': API_KEY,
            },
            body: JSON.stringify({ email: target, requestId }),
            signal: AbortSignal.timeout(4000),
          }).then(r => r.json()).then(j => {
            console.log(`[relay-wake] sent silent push to ${target} requestId=${requestId} sent=${j?.data?.sent ?? '?'}`);
          }).catch(err => {
            console.warn(`[relay-wake] push failed for ${target}: ${err?.message || err}`);
          });
        } catch (e) {
          console.warn('[relay-wake] dispatch error:', e?.message);
        }

        // Schedule timeout — if phone never comes online we synthesize the
        // error response so the requester doesn't hang forever.
        setTimeout(() => expireRelay(target, requestId), RELAY_WAKE_WINDOW_MS);
        break;
      }

      case 'relay_ready': {
        // Phone says "I'm awake from silent push and subscribed; drain my
        // pending relays". We honor this even without it (auth path does
        // the same), but it lets the native code be explicit.
        if (!c.email) break;
        const n = drainRelaysForEmail(c.email);
        if (n > 0) console.log(`[relay-wake] relay_ready drained ${n} for ${c.email}`);
        break;
      }

      case 'relay_response': {
        // Phone delivered its answer. Look up the requester (whoever's
        // clientId we stashed when the request came in) and forward.
        if (!c.email) break;
        const requestId = String(msg.requestId || msg.request_id || '');
        if (!requestId) break;
        // We didn't keep a separate map of (requestId → requester) because
        // requests are short-lived; instead, find by scanning the wake queue
        // (drain path removes them) AND piggyback the requester email in the
        // response itself via `target_email` (web included it when sending).
        // Easier: when relay_request was forwarded, we set msg.requester →
        // here we route by msg.target_email.
        const targetEmail = String(msg.target_email || msg.requester || '').toLowerCase();
        if (!targetEmail) break;
        const targetSubs = emailClients.get(targetEmail);
        if (!targetSubs) break;
        const out = {
          type: 'relay_response',
          requestId,
          data: msg.data ?? null,
          error: msg.error || null,
          partial: !!msg.partial,
          ts: Date.now(),
        };
        for (const id of targetSubs) sendWithAck(id, out);
        break;
      }
*/

// ─────────────────────────────────────────────────────────────────────────
// BLOCK 3 — auth drain hook (paste at the END of `case 'auth':` after the
// `pendingCallOffers.delete(user.email);` line)
// ─────────────────────────────────────────────────────────────────────────
/*
          // Stage 4 — phone just (re)connected. If a web client had parked
          // any relay_request entries waiting for this email, drain them
          // now. We retry once after 500ms because the client typically
          // sends `subscribe chat_user_<email>` immediately after auth and
          // the channel may not be populated yet on this same tick.
          try {
            const drained = drainRelaysForEmail(c.email);
            if (drained === 0 && wakePendingRelays.has(c.email)) {
              setTimeout(() => drainRelaysForEmail(c.email), 500);
            } else if (drained > 0) {
              console.log(`[relay-wake] drained ${drained} pending relay(s) on auth for ${c.email}`);
            }
          } catch (e) {
            console.warn('[relay-wake] drain on auth failed:', e?.message);
          }
*/

// ─────────────────────────────────────────────────────────────────────────
// BLOCK 4 — periodic cleanup (paste inside the 30s setInterval already
// running at the bottom of server.js, alongside the presenceMap loop)
// ─────────────────────────────────────────────────────────────────────────
/*
  // Expire stale wake-pending relays so a never-reconnecting phone doesn't
  // wedge them in memory forever. The setTimeout above usually fires first;
  // this is a belt-and-suspenders sweep for ones missed (e.g. server restart
  // before the timer fired).
  const _now = Date.now();
  for (const [email, arr] of wakePendingRelays) {
    const survivors = arr.filter(e => e.expiresAt > _now);
    const expired = arr.length - survivors.length;
    if (expired > 0) {
      for (const e of arr) {
        if (e.expiresAt <= _now) {
          const req = clients.get(e.requesterClientId);
          if (req && req.ws && req.ws.readyState === WebSocket.OPEN) {
            sendTo(e.requesterClientId, {
              type: 'relay_response',
              requestId: e.requestId,
              error: 'phone_offline',
              ts: _now,
            });
          }
        }
      }
    }
    if (survivors.length === 0) wakePendingRelays.delete(email);
    else wakePendingRelays.set(email, survivors);
  }
*/

module.exports = {
  // For unit testing the queue logic outside server.js.
  RELAY_WAKE_WINDOW_MS: 15000,
  RELAY_REQUEST_TTL_MS: 25000,
  RELAY_ACTION_WHITELIST: new Set([
    'get_messages',
    'get_conversations',
    'get_message',
    'search_messages',
    'get_contacts',
  ]),
};
