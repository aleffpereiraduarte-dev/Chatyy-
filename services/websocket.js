/**
 * OneMundo Mail WebSocket Client v3.0
 * Real-time email/chat notifications with auto-reconnect, message queue, and connection tracking
 *
 * v3.0: exponential backoff, connection quality tracking, message relay,
 *       typing debounce, presence via WS, offline queue with retry,
 *       deduplication, latency tracking
 */
import { Platform, AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// MessagePack codec — lazy-required so a missing/broken module never breaks
// startup. Gated by globalThis.__chatyy_msgpack_ws feature flag (off by
// default); while off, every code path stays JSON-only. Phase 1 of the WS
// transport upgrade (see docs/transport_upgrade_plan.md).
let _msgpack = null;
function _getMsgpack() {
  if (_msgpack) return _msgpack;
  try {
    // eslint-disable-next-line global-require
    _msgpack = require('@msgpack/msgpack');
  } catch (e) {
    _msgpack = { encode: null, decode: null, __unavailable: true };
    if (typeof console !== 'undefined') {
      console.warn('[WS] @msgpack/msgpack not available, msgpack disabled:', e?.message);
    }
  }
  return _msgpack;
}
function _msgpackEnabled() {
  try {
    return globalThis.__chatyy_msgpack_ws === true && !_getMsgpack().__unavailable;
  } catch { return false; }
}

// ─── CWP/1 binary signaling (Agent 3, 2026-05-21) ──────────────────────
// Negotiates `cwp.1` subprotocol when `globalThis.__chatyy_cwp_ws === true`,
// advertising `json.legacy` as fallback so the server can pick either side.
// Default OFF for gradual rollout — server stays JSON-compatible forever.
// See /root/webmail-app/docs/whatsapp-migration/03-signaling-protocol.md
let _cwp = null;
function _getCwp() {
  if (_cwp) return _cwp;
  try {
    // eslint-disable-next-line global-require
    _cwp = require('../modules/chatyy-cwp');
  } catch (e) {
    _cwp = { __unavailable: true };
    if (typeof console !== 'undefined') {
      console.warn('[WS] chatyy-cwp not available, CWP disabled:', e?.message);
    }
  }
  return _cwp;
}
function _cwpEnabled() {
  try {
    return globalThis.__chatyy_cwp_ws === true && !_getCwp().__unavailable;
  } catch { return false; }
}
// Public toggle helper: callers (settings screen, AB-test flag, etc.) can
// flip via `setCwpEnabled(true)` without hunting through code.
export function setCwpEnabled(on) {
  try { globalThis.__chatyy_cwp_ws = !!on; } catch {}
}

// Resume token persistence key. Per-account scoping isn't needed: the value
// is just a high-water id from a single server-side sequence (ws_event_log)
// and is also gated by the WS auth (server only replays events for the
// authed email). On account switch the next auth_success starts emitting
// new event_ids from wherever that user's tail is — drift, not corruption.
const WS_LAST_EVENT_ID_KEY = '@chatyy:ws:last_event_id';
// Persist every N events (10 — matches spec). Cheap: AsyncStorage writes
// are async and we don't await them.
const EVENT_ID_PERSIST_EVERY = 10;

// Direct WS connection (bypasses Cloudflare — no 100s idle timeout)
const WS_URL = null; // Dynamic — resolved at connect time from best edge server

// 800ms first retry — WhatsApp-tier silent recovery. Was 500ms, but real-world
// flaps (carrier handoff, brief AP loss) lasted 600-1500ms; the 500ms retry
// always fired BEFORE the network re-stabilized, surfacing a noisy
// "Reconectando…" flash. 800ms lets the OS settle first so the very first
// connect attempt usually succeeds — invisible recovery.
const RECONNECT_BASE = 500;
// [2026-05-19 "não deveria cair nunca"] Cap aggressive reconnect at 3s
// instead of 30s. After 4 fast retries (within ~2s) we used to fall back
// to exponential backoff that climbed to 30s — user saw "Reconectando..."
// for minutes and had to force-quit + reopen to reset. WhatsApp-style:
// never let the user wait more than a few seconds for the socket to come
// back. 3s ceiling means worst-case 1-3 reconnect attempts per second
// during a sustained outage, which the server can absorb (eviction loop
// fixed separately).
const RECONNECT_MAX = 3000;     // Max 3s between retries (was 30s)
// WhatsApp-tier liveness — detect a silently-dead socket in ~18s instead of
// the TCP keepalive default (~60-120s). Cost is negligible (~3 B/s of ping
// frames). During an active call we drop to 8s/15s via _callActive (see
// _startPing) so ICE candidate loss is detected even faster.
// [2026-05-19 NAT keepalive] Pinging every 5s (was 12s) keeps mobile
// carrier NAT mappings fresh. Mobile NAT idle timeouts are typically
// 60-120s; at 12s we'd send 5-10 keepalive packets per minute which is
// fine, but carriers in some regions (BR Tim/Vivo seen) idle out
// connections that have NO bidirectional traffic in any 30s window.
// 5s pings = 12 packets/min, no impact on battery, kills the NAT idle
// kill 100% of the time. WhatsApp uses ~5s keepalive.
const PING_INTERVAL = 5000;
// [2026-07-03 iOS realtime] Foreground zombie-socket detection. iOS keeps
// ws.readyState === OPEN for a socket the radio already killed, so onmessage
// never fires and a new chat message sits invisible until the 15s HTTP
// safety-poll. 18s was far too slow — a message could hang ~18s before the
// watchdog force-reconnected + HTTP-caught-up. 12s idle is safe against 4G
// RTT spikes (would need a 12s round-trip to false-positive) and open-thread
// drops to 10s via _chatActive (see _startPing).
const PING_TIMEOUT = 12000;
// [P0 2026-05-25 auth-reject storm] After this many consecutive
// refreshed-but-still-rejected auth attempts, stop auto-reconnecting and
// force a real re-login instead of storming the server. A single transient
// 401 (token just expired, refresh succeeds, server accepts) never reaches
// this threshold — only a token the server keeps rejecting does.
const AUTH_REJECT_STOP = 3;
// Exponential backoff (with cap) BETWEEN auth-driven reconnects so even
// before we hard-stop we're not hammering: 2s → 4s → 8s … capped at 60s.
const AUTH_REJECT_BACKOFF_BASE = 2000;
const AUTH_REJECT_BACKOFF_MAX = 60000;
// Outbound relay/retry frames are tiny (<300 B), so a generous cap costs
// almost nothing (~150 KB at 500) but covers a long reconnect window where
// >100 messages queue up — at 100 the #101+ frames were silently dropped
// (server delivery still durable via messageOutbox, but the optimistic
// real-time relay to online peers was lost). 500 ≈ a very chatty offline burst.
const MAX_QUEUE_SIZE = 500;
const TYPING_DEBOUNCE = 3000;   // Send typing every 3s max
const TYPING_STOP_DELAY = 3000; // Send stopped_typing after 3s idle
const CLIENT_MSG_RETRY_MS = 3000; // Retry outgoing messages after 3s
const CLIENT_MSG_MAX_RETRIES = 3;
// Hard cap on the in-flight ACK-tracking map. If an app sits for hours with
// the socket flapping + retries piling up (e.g. user on poor mobile network
// composing dozens of messages), the map could grow unbounded and leak
// memory. 200 is well above the realistic burst (WhatsApp shows users
// queue at most ~30 messages before noticing send failures). When we hit
// the cap, evict the oldest entry (Map preserves insertion order) — that
// retry is abandoned but its promise still resolves via the offline-queue
// fallback path so the message isn't lost.
const PENDING_OUTGOING_CAP = 200;

class MailWebSocket {
  constructor() {
    this.ws = null;
    this.token = null;
    this.userId = null;
    this.email = null;
    this.connected = false;
    this.authenticated = false;
    // MsgPack negotiation state (off until server acks upgrade_msgpack).
    // Flipped true on receipt of `msgpack_upgraded`; reset to false on
    // every new socket so a reconnect re-negotiates cleanly.
    this.binaryUpgraded = false;
    this.listeners = new Map();
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.destroyed = false;
    this._hidden = false;
    this.lastPongTime = 0;
    this.lastInboundAt = 0;         // [2026-07-03] ts of last inbound frame — zombie-socket detector for the open chat thread's adaptive poll
    this._messageQueue = [];        // Offline message queue
    this._subscribedChannels = new Set(); // Track subscribed channels for re-subscribe on reconnect

    // Connection quality tracking
    this._latency = 0;            // Last measured RTT in ms
    this._pingTs = 0;             // Timestamp of last ping sent
    this._droppedCount = 0;       // Number of dropped pings
    this._reconnectCount = 0;     // Total reconnections since startup

    // Typing debounce state
    this._lastTypingSent = new Map();  // conversation_id -> timestamp
    this._typingStopTimers = new Map(); // conversation_id -> timer

    // Server time offset for clock sync
    this._serverTimeOffset = 0;

    // Deduplication: Set of recently seen message IDs (max 500)
    this._seenMsgIds = new Set();
    this._seenMsgIdQueue = []; // FIFO for eviction

    // ACK tracking for outgoing messages
    this._pendingOutgoing = new Map(); // msg_id → { data, retries, timer, resolve }
    this._msgIdCounter = 0;

    // [WAVE 66 2026-05-21] Ghost-login defense-in-depth v2.
    //   - _resurrectRetryTimer: exponential retry when resurrect() fails to
    //     actually bring the socket back (pullToken null, server reject, etc).
    //   - _resurrectAttempt: counter for the backoff sequence.
    //   - _ghostDiagRing: in-memory ring buffer of WS state transitions for
    //     /diagnose tap-5-on-logo support flow.
    this._resurrectRetryTimer = null;
    this._resurrectAttempt = 0;
    this._ghostDiagRing = [];
    this._ghostDiagMax = 200;

    // ─── Resume Token Tracking (WhatsApp catch-up) ───
    // Server stamps each per-user event with a monotonic `event_id`. We
    // track the highest one we've successfully delivered to listeners,
    // persist it every N events, and replay from there on reconnect.
    // Persisted via AsyncStorage under WS_LAST_EVENT_ID_KEY.
    this._lastEventId = 0;
    this._lastEventIdPersistedAt = 0;
    this._eventIdSinceFlush = 0;
    this._resumeInFlight = false;
    this._loadLastEventId(); // Fire-and-forget — populates this._lastEventId

    // ─── Auth-reject storm guard (P0 2026-05-25) ───
    // Distinct from `_authFailStreak`, which counts ALL auth_errors (including
    // transient edge-hub hiccups, in-call races, etc). This counter ONLY
    // increments when we did a token refresh, the refresh SUCCEEDED (handed us
    // a token, possibly a brand-new one), and the server STILL rejected it on
    // the very next connect. That is the signature of a genuinely dead session
    // (revoked/rotated server-side) and is what produced the ~38 failed-auth/min
    // reconnect storm: refresh kept "succeeding" so the old code reset backoff
    // to 0 and reconnected instantly, forever, never holding the
    // chat_user_<email> subscription long enough to receive messages.
    //
    // After AUTH_REJECT_STOP consecutive refreshed-but-still-rejected attempts
    // we enter `_authReloginStopped`: clear the reconnect timer, STOP all
    // auto-reconnect (connect() becomes a no-op), and surface the same
    // chatyy:authFailure signal the app already listens to so it forces a real
    // re-login. The stop is only cleared by an explicit re-auth path
    // (reset(), resurrect(), or manualReconnect()).
    this._authRejectStreak = 0;       // refreshed-but-still-rejected count
    this._authReloginStopped = false; // hard-stop: no auto-reconnect until re-auth
    this._authRejectBackoff = 0;      // exponential backoff between auth retries (ms)


    // Pause/resume on visibility change (web only)
    this._visibilityHandler = null;
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      this._visibilityHandler = () => {
        if (document.hidden) {
          this._hidden = true;
          this._stopPing();
          clearTimeout(this.reconnectTimer);
        } else {
          this._hidden = false;
          if (this.connected && this.authenticated) {
            this._startPing();
            // [audit fix] Returning from a hidden tab: the socket may have
            // been silently killed by the browser (Chrome aggressively
            // freezes tabs) but readyState still reads OPEN. Send a probe
            // ping and if no pong in 3s, force-reconnect instead of waiting
            // for the next scheduled ping (5s) + ping watchdog (18s) — at
            // worst the user used to wait 23s for the socket to recover
            // after switching back to the tab. Now: 3s max.
            try {
              const probeSentAt = Date.now();
              this._pingTs = probeSentAt;
              try { this._send({ type: 'ping', ts: probeSentAt }); } catch {}
              const probeTimer = setTimeout(() => {
                if (this.destroyed || this._hidden) return;
                if (this.lastPongTime < probeSentAt) {
                  // No pong within 3s — assume the socket is a zombie.
                  try { console.warn('[WS] visibility probe failed, forcing reconnect'); } catch {}
                  try { this._cleanup(); } catch {}
                  if (this.token && !this.destroyed) {
                    this.reconnectAttempt = 0;
                    this.connect(this.token);
                  }
                }
              }, 3000);
              // If a pong comes back, cancel the watchdog early.
              const probeUnsub = this.on('pong', () => {
                clearTimeout(probeTimer);
                try { probeUnsub(); } catch {}
              });
            } catch {}
          } else if (this.token && !this.destroyed) {
            this.reconnectAttempt = 0;
            this.connect(this.token);
          }
          this._emit('visibility', { visible: true });
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }

    // Network change handler. Previously we preemptively cleanup+reconnect
    // on ANY wifi↔cellular flip, but on iOS NetInfo flaps frequently even
    // when the existing socket is still healthy — causing the WS to thrash
    // every few seconds, which is exactly the user-visible "mensagens com
    // delay" symptom. New policy: only reconnect if the socket is actually
    // broken. A healthy socket survives a type flip; the pong watchdog
    // catches it if it died silently.
    try {
      const { onNetworkChange } = require('./networkInfo');
      this._netUnsub = onNetworkChange?.((state) => {
        if (!state?.isConnected) return;
        const socketDead = !this.ws || this.ws.readyState !== WebSocket.OPEN;
        if (socketDead && this.token && !this.destroyed) {
          this.reconnectAttempt = 0;
          this.connect(this.token);
        }
        this._lastNetType = state.type;
      });
    } catch {}

    // Native: reconnect when app comes back from background
    // iOS kills WebSocket after ~30s in background
    if (Platform.OS !== 'web') {
      // Android quirk: AppState fires 'inactive' on transient events
      // (notification shade pull-down, control-center, system dialog).
      // Treating those as 'background' tore down ping + reconnect timers
      // every few seconds, surfacing as a permanent "Reconectando..."
      // loop. The 'active' handler reconnected, then the next 'inactive'
      // killed it again. Now we IGNORE 'inactive' entirely and only act
      // on 'active' ↔ 'background' transitions, matching what WhatsApp's
      // network layer does. iOS doesn't fire spurious 'inactive', so
      // it's a no-op there.
      this._appStateHandler = AppState.addEventListener('change', (nextState) => {
        if (nextState === 'inactive') return;
        if (nextState === 'active') {
          this._hidden = false;
          // [WAVE 43G 2026-05-21] Foreground = good moment to revive a
          // tombstoned socket. If destroyed=true (8+ auth_error outside
          // grace), the legacy AppState handler below would skip both
          // branches (readyState!==OPEN AND token-but-destroyed) and the
          // user would stay disconnected. resurrect() is a no-op when
          // the socket is healthy so we can call it unconditionally
          // before the legacy checks.
          if (this.destroyed) {
            try { this.resurrect('appstate_active'); } catch {}
            return;
          }
          // [STAGE-E 2026-05-20 GAP#1] Re-publish presence=online when
          // returning to foreground. Pairs with the offline publish
          // on background transition.
          try { this._send && this._send({ type: 'presence', status: 'online' }); } catch {}
          // Check if WS is still alive
          if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) {
            // Socket SAYS alive, but on iOS the OS often returns
            // readyState===OPEN for a socket that's been killed by the radio
            // sleep. Send an immediate ping AND schedule a short pong-watchdog
            // — if no pong in 8s, force-reconnect. Without this, an incoming
            // call accept (cold-start path) sat behind a dead socket for the
            // full 30s timeout before reconnecting.
            //
            // 2026-05-18 (invisible-sync): bumped 4s → 8s. The old 4s ceiling
            // triggered false-positive zombie reconnects on slow cellular
            // (cross-Atlantic RTT can spike past 4s on 4G under load) which
            // flashed the "Connecting…/Sincronizando…" badge for users whose
            // socket was actually fine. 8s is still well under the 30s OS
            // timeout but tolerates a single RTT hiccup.
            this._pingTs = Date.now();
            this._send({ type: 'ping', ts: this._pingTs });
            this._startPing();
            const pingedAt = this._pingTs;
            // Track watchdog so a fast back-to-background doesn't leave
            // a stale timer that fires a spurious reconnect mid-sleep.
            if (this._fgWatchdog) clearTimeout(this._fgWatchdog);
            this._fgWatchdog = setTimeout(() => {
              this._fgWatchdog = null;
              if (this._hidden || this.destroyed) return;
              if (this.lastPongTime < pingedAt) {
                console.warn('[WS] foreground ping had no pong in 8s — socket is zombie, force reconnect');
                try { this._cleanup(); } catch {}
                if (this.token) {
                  this.reconnectAttempt = 0;
                  this.connect(this.token);
                }
              }
            }, 8000);
          } else if (this.token && !this.destroyed) {
            // Socket is dead, reconnect immediately
            this.reconnectAttempt = 0;
            this.connect(this.token);
          }
          // Either path: fire a chat_sync delta catch-up so any
          // messages that arrived during the background window are
          // pulled even if the WS never delivered them (push-wake path
          // or FCM→app but app never got the broadcast while asleep).
          this._emitForeground();
        } else if (nextState === 'background') {
          this._hidden = true;
          this._stopPing();
          clearTimeout(this.reconnectTimer);
          // Cancel any in-flight foreground zombie-check — if we just
          // bounced to background it'd otherwise force-reconnect a
          // perfectly fine socket that the OS is about to suspend.
          if (this._fgWatchdog) {
            clearTimeout(this._fgWatchdog);
            this._fgWatchdog = null;
          }
          // Clear any typing timers we have scheduled — if the peer
          // last saw us typing and we go background mid-type, fire
          // stopped_typing NOW instead of letting their UI show a
          // stuck indicator until our next foreground.
          this._clearAllTypingState();
          // [STAGE-E 2026-05-20 GAP#1] Explicit presence_publish=offline
          // when backgrounding. Without this, peers see "online" for up
          // to 60s after we leave the app (server staleness). WhatsApp
          // flips to "visto agora" within ~3s — we now match.
          try { this._send && this._send({ type: 'presence', status: 'offline' }); } catch {}
        }
      });
    }
  }

  // Notify listeners that we just became foreground so the chat screen
  // can trigger its own chat_sync for the currently-open conversation
  // (and MailContext can refresh the list).
  _emitForeground() {
    try { this._emit('foreground', { ts: Date.now() }); } catch {}
  }

  // Fire stopped_typing locally + emit synthetic disconnect to any
  // peers watching us so their "… is typing" clears even when our
  // socket died mid-stream.
  _clearAllTypingState() {
    try {
      if (this._typingStopTimers) {
        for (const [convId, timer] of this._typingStopTimers.entries()) {
          clearTimeout(timer);
          try { this._send({ type: 'stopped_typing', conversation_id: convId }); } catch {}
        }
        this._typingStopTimers.clear();
      }
      // [perf] Also drop the per-conversation last-typing-sent timestamps.
      // The normal stop-typing timer deletes these, but _clearAllTypingState
      // cancels those timers before they fire — without this the
      // _lastTypingSent Map kept one entry per conversation ever typed in,
      // forever (grew unbounded across background/foreground cycles).
      try { this._lastTypingSent?.clear(); } catch {}
    } catch {}
  }

  connect(token) {
    if (this.destroyed) return;
    // [P0 2026-05-25] In the auth-reject "needs re-login" stopped state, do NOT
    // reconnect — that's the whole point of the circuit-breaker. The flag is
    // cleared only by an explicit re-auth (reset/resurrect/manualReconnect),
    // each of which sets it false BEFORE calling connect(), so those paths
    // still work. Any stray timer/watchdog firing connect() here is a no-op.
    if (this._authReloginStopped) {
      try { console.warn('[WS] connect() ignored — in needs-relogin stop state'); } catch {}
      return;
    }
    // WhatsApp-grade token refresh: always prefer the freshest token from
    // the API layer over whatever caller passed in. After a sliding
    // renewal, the in-memory bearer can be newer than the one we hold,
    // and reconnecting with a stale token wastes a roundtrip + may trip
    // the WS auth_error streak. Falls back to the argument if api isn't
    // ready yet (very cold start).
    let liveToken = token;
    try {
      const apiMod = require('./api');
      const fresh = apiMod.getAuthToken?.();
      if (fresh && typeof fresh === 'string' && fresh.length > 0) liveToken = fresh;
    } catch {}
    this.token = liveToken;

    // Re-add visibility listener if it was removed by disconnect()
    if (this._visibilityHandlerRemoved && this._visibilityHandler && Platform.OS === 'web' && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandlerRemoved = false;
    }

    // Clean up existing connection
    this._cleanup();

    // Reset codec negotiation on every new socket — re-negotiated after auth.
    this.binaryUpgraded = false;

    try {
      // Use dedicated WS domain (bypasses Cloudflare proxy which breaks WS)
      const wsUrl = 'wss://ws.chatyy.com.br/ws';
      // CWP/1 subprotocol negotiation — feature-flagged (default OFF).
      // Server picks 'cwp.1' if it supports CWP, else 'json.legacy'.
      // Falls back transparently because the server's onMessage handler
      // accepts JSON TEXT frames forever (no deprecation deadline).
      this.cwpNegotiated = false;
      if (_cwpEnabled()) {
        // RN's WebSocket constructor accepts protocols as second arg
        // (string or string[]).
        this.ws = new WebSocket(wsUrl, ['cwp.1', 'json.legacy']);
      } else {
        this.ws = new WebSocket(wsUrl);
      }
      // We need ArrayBuffer (not Blob) so we can sync-decode in onmessage.
      // Harmless when msgpack is disabled — we only ever get text frames in
      // JSON-only mode anyway.
      try { this.ws.binaryType = 'arraybuffer'; } catch {}
    } catch (err) {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      // Detect which subprotocol the server selected. `ws.protocol` is the
      // selected one from the list we advertised (or '' / 'json.legacy'
      // for JSON-only servers). CWP-negotiated sockets serialize the auth
      // frame as binary; everything else stays on JSON text.
      try {
        const proto = (this.ws && this.ws.protocol) ? String(this.ws.protocol) : '';
        this.cwpNegotiated = (proto === 'cwp.1');
      } catch { this.cwpNegotiated = false; }
      this._emit('connection', { status: 'connected', protocol: this.cwpNegotiated ? 'cwp.1' : 'json' });

      // Authenticate with bearer token
      this._send({ type: 'auth', token: this.token });

      // Start heartbeat
      this._startPing();

      // Wake voice session resume + offline-queue replay sweep. Any
      // streaming voice upload that stalled mid-recording when the WS
      // dropped will now flush its remaining chunks from lastChunkIdx+1
      // instead of restarting at 0. Fire-and-forget; the prefetch module
      // dedupes internally.
      try {
        const { notifyWsReconnected } = require('./voicePrefetch');
        notifyWsReconnected?.();
      } catch {}
    };

    this.ws.onmessage = (event) => {
      // [2026-07-03 sempre-tempo-real] ANY inbound frame proves the socket is
      // actually alive (not just readyState===OPEN). The open chat thread reads
      // this to decide whether to poll aggressively — if no frame has arrived in
      // a while the socket is likely an iOS "zombie" and the thread falls back to
      // fast HTTP delta-sync so a new message never sits invisible.
      this.lastInboundAt = Date.now();
      try {
        let msg;
        // Binary frame → server is speaking msgpack to this connection.
        // Decode with @msgpack/msgpack; if module unavailable we have to
        // drop the frame (should never happen with flag off, since we never
        // send upgrade_msgpack and the server defaults to JSON text frames).
        if (event.data instanceof ArrayBuffer) {
          // Binary frame — could be CWP/1 (magic 0xC7) or msgpack. We sniff
          // the first byte: CWP frames always start with 0xC7, while
          // msgpack maps/arrays start with 0x80–0x9F / 0xDC–0xDF. The
          // server only emits one or the other based on the negotiated
          // subprotocol, but sniffing keeps us correct during transitions.
          const u8 = new Uint8Array(event.data);
          let handled = false;
          if (this.cwpNegotiated || (u8.length > 0 && u8[0] === 0xc7)) {
            try {
              const cwp = _getCwp();
              if (!cwp.__unavailable && typeof cwp.cwpToJson === 'function') {
                const decoded = cwp.cwpToJson(u8);
                if (decoded) {
                  msg = decoded;
                  handled = true;
                }
              }
            } catch (e) {
              console.warn('[WS] CWP decode failed, trying msgpack:', e?.message);
            }
          }
          if (!handled) {
            const mp = _getMsgpack();
            if (mp.__unavailable || typeof mp.decode !== 'function') {
              console.warn('[WS] Received binary frame but neither CWP nor msgpack available; ignoring');
              return;
            }
            msg = mp.decode(u8);
          }
        } else {
          msg = JSON.parse(event.data);
        }
        // Track call_end_ack at the top level so the call screen's
        // BYE retry loop can short-circuit when the server confirms
        // it received our hangup. Without this we keep retrying for 3
        // seconds even when the first BYE went through fine.
        if (msg && msg.type === 'call_end_ack' && msg.call_id) {
          try { (typeof window !== 'undefined' ? window : globalThis).__lastCallEndAckId = msg.call_id; } catch {}
        }
        // Latch local upgrade flag on server ack so subsequent _send calls
        // start emitting msgpack-encoded frames upstream too.
        if (msg && msg.type === 'msgpack_upgraded' && msg.ok) {
          this.binaryUpgraded = true;
        }
        this._handleMessage(msg);
      } catch (e) { console.warn('[WS] Message parse error:', e?.message); }
    };

    this.ws.onclose = (event) => {
      const wasAuthenticated = this.authenticated;
      const closeCode = event?.code || 0;
      const closeReason = String(event?.reason || '').substring(0, 200);
      this.connected = false;
      this.authenticated = false;
      this._stopPing();

      // Diagnostic beacon so we can figure out WHY the socket keeps dropping
      // (iOS backgrounding, carrier flap, server-initiated close, etc.) without
      // having to reproduce under a debugger. Fire-and-forget, never blocks.
      if (wasAuthenticated) {
        try {
          const { getAuthToken, apiCall } = require('./api');
          if (getAuthToken?.()) {
            apiCall('crash_report', {
              kind: 'ws_close',
              code: closeCode,
              reason: closeReason,
              was_auth: true,
              reconnect_count: this._reconnectCount,
              ts: Date.now(),
            }, 'POST').catch(() => {});
          }
        } catch {}
      }

      if (closeCode === 4002) {
        this._emit('connection', { status: 'session_replaced', message: closeReason });
        return;
      }

      this._emit('connection', { status: 'disconnected', code: closeCode, reason: closeReason });
      if (wasAuthenticated) this._reconnectCount++;
      if (!this.destroyed) this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  disconnect() {
    this.destroyed = true;
    // Clear all pending outgoing message timers
    for (const [, entry] of this._pendingOutgoing) {
      clearTimeout(entry.timer);
    }
    this._pendingOutgoing.clear();
    this._cleanup();
    if (this._visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
      this._visibilityHandlerRemoved = true;
    }
    if (this._appStateHandler) {
      try { this._appStateHandler.remove(); } catch {}
      this._appStateHandler = null;
    }
    // Tear down NetInfo subscription — without this, every disconnect/reset
    // cycle (account switch, logout) leaked a listener that kept calling
    // connect() on the orphaned instance.
    if (typeof this._netUnsub === 'function') {
      try { this._netUnsub(); } catch {}
      this._netUnsub = null;
    }
    // Drop any window 'online' listener we attached during offline backoff.
    if (this._onOnlineHandler && typeof window !== 'undefined') {
      try { window.removeEventListener('online', this._onOnlineHandler); } catch {}
      this._onOnlineHandler = null;
      this._onlineListenerAdded = false;
    }
    this._emit('connection', { status: 'disconnected' });
  }

  // Reset destroyed flag so connect() works again after logout/login cycle.
  // Optional `fullWipe` also clears event listeners and subscribed channels
  // — use on account-switch to prevent the old account's handlers from
  // firing on the new account's events. On normal reconnect, leave
  // listeners intact since components register them independently.
  reset(fullWipe = false) {
    this.destroyed = false;
    this.reconnectAttempt = 0;
    this._reconnectCount = 0;
    this._droppedCount = 0;
    this._authFailStreak = 0;
    this._authErrorBackoff = 0;
    // [P0 2026-05-25] reset() is a re-auth boundary (logout→login, account
    // switch). Lift the auth-reject hard-stop so the fresh session can connect.
    this._authRejectStreak = 0;
    this._authRejectBackoff = 0;
    this._authReloginStopped = false;
    this._seenMsgIds.clear();
    this._seenMsgIdQueue = [];
    if (fullWipe) {
      try { this.listeners.forEach(set => set.clear()); } catch {}
      try { this._subscribedChannels.clear(); } catch {}
      try { this._watchedPresence?.clear(); } catch {}
      this.email = null;
      this.userId = null;
      this.token = null;
    }
  }

  // [WAVE 43G 2026-05-21] Self-heal entry point for the "silent logout"
  // bug. When the WS hits destroyed=true (8+ auth_error strikes outside
  // grace, or any other tombstone path) BUT the chatyy:authFailure was
  // refused by the grace/in-call/HTTP-confirm guards in AuthContext, the
  // socket would sit dead forever — UI stayed "logged in" but messages
  // stopped arriving until the user manually did logout+login. The
  // MailContext WS effect only fires on user.email change, so a
  // tombstoned-then-refused state has no automatic recovery.
  //
  // resurrect() is idempotent and safe to call from anywhere:
  //   - AppState 'active' watchdog (foreground transition)
  //   - AuthContext after HTTP check_auth=200 refuses an auth-failure
  //   - Periodic self-heal interval (every 60s while user is logged in)
  //
  // It pulls the freshest token from api.js, clears the tombstone, and
  // reconnects. Returns true if a reconnect was kicked off, false if
  // the socket was already healthy or no token is available.
  resurrect(reason = 'unknown') {
    try {
      const apiMod = require('./api');
      const token = apiMod.getAuthToken?.();
      // [P0 2026-05-25] If we hard-stopped on the auth-reject storm, the
      // periodic self-heal / foreground watchdog must NOT just reconnect with
      // the same token the server keeps rejecting — that re-arms the storm.
      // Only lift the stop when the in-memory token has ACTUALLY changed
      // (the app did a real re-login). Otherwise stay stopped and signal the
      // app again so it surfaces the re-login prompt.
      if (this._authReloginStopped) {
        if (token && token !== this.token) {
          this._authReloginStopped = false;
          this._authRejectStreak = 0;
          this._authRejectBackoff = 0;
        } else {
          this._logGhost?.('resurrect_blocked_relogin_stop', { reason });
          try {
            if (typeof globalThis !== 'undefined' && globalThis.dispatchEvent) {
              globalThis.dispatchEvent(new Event('chatyy:authFailure'));
            }
          } catch {}
          return false;
        }
      }
      if (!token) {
        // [WAVE 66] No token in memory yet (hydrate race). Schedule a retry
        // so we don't sit dead until the next watchdog tick (10s).
        this._logGhost('resurrect_no_token', { reason });
        this._scheduleResurrectRetry(reason);
        return false;
      }
      // Socket is alive and authenticated → nothing to do.
      if (this.connected && this.authenticated && !this.destroyed) {
        // Clear any retry timer — we're healthy.
        if (this._resurrectRetryTimer) {
          clearTimeout(this._resurrectRetryTimer);
          this._resurrectRetryTimer = null;
          this._resurrectAttempt = 0;
        }
        return false;
      }
      try { console.warn('[WS] resurrect() — reason=' + reason + ' destroyed=' + this.destroyed + ' connected=' + this.connected + ' authed=' + this.authenticated + ' attempt=' + this._resurrectAttempt); } catch {}
      this._logGhost('resurrect_kick', { reason, attempt: this._resurrectAttempt });
      try { this._cleanup(); } catch {}
      this.destroyed = false;
      this.reconnectAttempt = 0;
      this._authFailStreak = 0;
      this._authErrorBackoff = 0;
      this.token = token;
      this.connect(token);
      // Arm a backoff retry in case this connect() never reaches authenticated.
      // _onAuthenticated clears it; otherwise next backoff tick re-tries.
      this._scheduleResurrectRetry(reason);
      return true;
    } catch (e) {
      try { console.warn('[WS] resurrect() failed:', e?.message); } catch {}
      this._logGhost('resurrect_exception', { reason, err: e?.message });
      this._scheduleResurrectRetry(reason);
      return false;
    }
  }

  // [WAVE 66 2026-05-21] Resurrect retry with exponential backoff.
  // Steps: 5s, 15s, 30s, 60s, 120s (capped). Cancelled on _onAuthenticated.
  // Without this, a single failed resurrect (no token / server reject) sits
  // dead for 10s (next watchdog tick) — slower than what the user reports
  // as "deslogou silenciosamente, msgs não chegam".
  _scheduleResurrectRetry(reason) {
    if (this._resurrectRetryTimer) {
      clearTimeout(this._resurrectRetryTimer);
      this._resurrectRetryTimer = null;
    }
    const delays = [5000, 15000, 30000, 60000, 120000];
    const idx = Math.min(this._resurrectAttempt, delays.length - 1);
    const delay = delays[idx];
    this._resurrectAttempt++;
    this._resurrectRetryTimer = setTimeout(() => {
      this._resurrectRetryTimer = null;
      // If we got authenticated meanwhile, stop.
      if (this.connected && this.authenticated && !this.destroyed) {
        this._resurrectAttempt = 0;
        return;
      }
      // Surface user-visible banner after 2nd retry (~20s of pain) so user
      // knows they should pull-to-refresh or check network — silent reconnect
      // attempts up to 2 are fine. ChatListTab subscribes to 'disconnected'
      // status, fires a 12s suppress timer, then paints the gray banner.
      if (this._resurrectAttempt >= 2) {
        try {
          this._emit('connection', {
            status: 'disconnected',
            attempt: this._resurrectAttempt,
            reason: 'resurrect_retry',
          });
        } catch {}
      }
      // Try again — recurse into resurrect() which will re-schedule.
      this.resurrect(reason + '_retry' + this._resurrectAttempt);
    }, delay);
  }

  // [WAVE 66 2026-05-21] Ghost diagnostic ring buffer. 200 events covers
  // ~10min of activity at typical rate. Read via getGhostDiag() from the
  // /diagnose screen (5-tap on logo). Includes WS state transitions,
  // AppState changes, resurrect attempts, auth events.
  _logGhost(event, data) {
    try {
      const e = {
        ts: Date.now(),
        ev: event,
        connected: this.connected,
        authed: this.authenticated,
        destroyed: this.destroyed,
        readyState: this.ws?.readyState,
        ...(data || {}),
      };
      this._ghostDiagRing.push(e);
      if (this._ghostDiagRing.length > this._ghostDiagMax) {
        this._ghostDiagRing.shift();
      }
    } catch {}
  }

  getGhostDiag() {
    return this._ghostDiagRing.slice();
  }

  // Cheap state inspector for the resurrect watchdog. Returns true if the
  // socket is in a recoverable-by-resurrect state (dead but should be live).
  // [WAVE 66 2026-05-21] Tightened ping-silence threshold from 3× to 2×
  // PING_TIMEOUT (was 54s, now 36s) — shaves ~18s off worst-case ghost
  // detection. Watchdog cadence also tightened to 10s in MailContext so
  // total ghost detection bounded at ~46s (was up to 84s).
  isZombie() {
    if (this.destroyed) return true;
    if (!this.ws) return true;
    if (this.ws.readyState !== WebSocket.OPEN) return true;
    if (!this.authenticated) return true;
    // Long ping silence — the ping watchdog should have caught this, but if
    // it didn't (timer cleared by a botched AppState cycle, etc.) treat the
    // socket as zombie.
    if (this.lastPongTime && (Date.now() - this.lastPongTime) > (PING_TIMEOUT * 2)) return true;
    return false;
  }

  _cleanup() {
    clearTimeout(this.reconnectTimer);
    this._stopPing();
    // Cancel the foreground zombie-check watchdog if it was armed —
    // _cleanup is also called when the watchdog itself decides to
    // force-reconnect, in which case we're inside the timer callback
    // and the handle is already null. Either way, drop the reference.
    if (this._fgWatchdog) {
      clearTimeout(this._fgWatchdog);
      this._fgWatchdog = null;
    }
    for (const timer of this._typingStopTimers.values()) {
      clearTimeout(timer);
    }
    this._typingStopTimers.clear();
    // [perf] Clear last-typing-sent timestamps too — their scheduled
    // deletes live on _typingStopTimers, which we just cancelled, so
    // otherwise this Map leaks one entry per conversation across reconnects.
    try { this._lastTypingSent?.clear(); } catch {}
    // Detach the dying socket's handlers so a late-firing onclose from
    // the previous socket doesn't drive a phantom reconnect on top of
    // an already-reconnecting flow (the "double reconnect storm" that
    // doubles the auth_error rate after a brief outage).
    if (this.ws) {
      try { this.ws.onopen = null; } catch {}
      try { this.ws.onmessage = null; } catch {}
      try { this.ws.onclose = null; } catch {}
      try { this.ws.onerror = null; } catch {}
      // Avoid the "WebSocket is closed before the connection is established"
      // console.warn that browsers emit when close() is called while the
      // socket is still in CONNECTING. Defer the close until open, then
      // immediately tear it down. If the connection never opens it'll
      // close on its own. We still null out the handlers so any later
      // onopen/onclose can't drive a phantom reconnect.
      try {
        if (typeof WebSocket !== 'undefined' && this.ws.readyState === WebSocket.CONNECTING) {
          const _dying = this.ws;
          _dying.onopen = () => { try { _dying.close(); } catch {} };
        } else {
          this.ws.close();
        }
      } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
    // Reset pong tracker — without this, a stale lastPongTime from the dead
    // session fires a false-positive "ping timeout" on the first ping of the
    // new session, cascading into rapid reconnects (the main reason we saw
    // sessions dying every 5-10s in the WS log).
    this.lastPongTime = 0;
  }

  // Encode payload with the codec negotiated for this socket. When the
  // server has acked upgrade_msgpack we send binary msgpack; otherwise JSON.
  // Falls back to JSON if msgpack encode throws for any reason.
  //
  // CWP/1 (binary signaling) takes precedence over msgpack when the
  // `cwp.1` subprotocol was negotiated AT CONNECT TIME. CWP only knows
  // how to encode a known opcode catalog (auth, call_*, presence, ping…);
  // anything outside that set silently falls through to JSON/msgpack so
  // chat_message and other legacy types keep working unchanged.
  _encodeOutbound(data) {
    if (this.cwpNegotiated) {
      try {
        const cwp = _getCwp();
        if (!cwp.__unavailable && typeof cwp.jsonToCwp === 'function') {
          const bin = cwp.jsonToCwp(data);
          if (bin) return bin;  // Uint8Array, sent as a BINARY frame
        }
      } catch (e) {
        console.warn('[WS] CWP encode failed, falling back:', e?.message);
      }
    }
    if (this.binaryUpgraded) {
      try {
        const mp = _getMsgpack();
        if (!mp.__unavailable && typeof mp.encode === 'function') {
          return mp.encode(data);
        }
      } catch (e) {
        console.warn('[WS] msgpack encode failed, falling back to JSON:', e?.message);
      }
    }
    return JSON.stringify(data);
  }

  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(this._encodeOutbound(data));
    } else if (data && (
      data.type === 'chat_message' ||
      data.type === 'chat_message_relay' ||
      // [#1222 2026-05-20 Wave 5] Queue read receipts + reactions when WS is
      // down. Previously these were silently dropped — peer never saw blue
      // ticks / emoji until next manual poll. Now they replay on reconnect
      // alongside chat_message frames, matching WhatsApp's read receipt
      // durability (WhatsApp queues read in their persistent outbox).
      data.type === 'message_read' ||
      data.type === 'reaction' ||
      // [#1233 2026-05-20] Queue call signaling frames when WS is down.
      // Previously `sendSignaling('call_invite')` silently dropped if the
      // socket was mid-reconnect → callee never rang. `call_end` had a
      // 3-attempt retry (call.js ~1809) but if all 3 hit a dead socket the
      // peer saw a phantom call. Queueing call_invite/call_end/call_answer/
      // call_reject lets the reconnect drain (_onAuthenticated flush, line
      // ~1463) replay them within the ~3s reconnect ceiling. Call signaling
      // frames are tiny (<300 B) so the MAX_QUEUE_SIZE=100 cap is fine.
      data.type === 'call_invite' ||
      data.type === 'call_end' ||
      data.type === 'call_answer' ||
      data.type === 'call_reject'
    )) {
      // Queue chat messages + read receipts + reactions + call signaling
      // when WS is not open.
      if (this._messageQueue.length < MAX_QUEUE_SIZE) {
        this._messageQueue.push(data);
        if (data.type === 'call_invite' || data.type === 'call_end' ||
            data.type === 'call_answer' || data.type === 'call_reject') {
          try {
            console.log('[WS] ' + data.type + ' queued (WS offline) call_id=' + (data.call_id || '?'));
          } catch {}
        }
      }
    }
  }

  // Send with guaranteed delivery -- queues if offline, replays on reconnect
  send(data) {
    this._send(data);
  }

  _startPing() {
    this._stopPing();
    // Aggressive ping cadence so an iOS "zombie" socket (radio killed it but
    // readyState still reads OPEN → onmessage never fires) is caught fast
    // instead of leaving a new message stuck until the 15s HTTP safety-poll.
    //   • call active → 8s ping / 15s timeout (ICE + hangup can't stall)
    //   • chat open   → 8s ping / 10s timeout (message in the OPEN thread
    //                   lands within ~10s worst-case even on iOS; this is
    //                   exactly where the user notices "só aparece quando
    //                   saio e volto")
    //   • idle/bg     → 5s ping / 12s timeout (NAT keepalive + list self-heal)
    const interval = (this._callActive || this._chatActive) ? 8000 : PING_INTERVAL;
    const timeout = this._callActive ? 15000 : (this._chatActive ? 10000 : PING_TIMEOUT);
    this.pingTimer = setInterval(() => {
      // Check socket health first
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        this._droppedCount++;
        this._cleanup();
        if (!this.destroyed) this._scheduleReconnect();
        return;
      }
      this._pingTs = Date.now();
      this._send({ type: 'ping', ts: this._pingTs });
      // No pong in timeout = dead socket (Telegram-style aggressive).
      if (this.lastPongTime && (Date.now() - this.lastPongTime) > timeout) {
        this._droppedCount++;
        this._cleanup();
        if (!this.destroyed) {
          this.reconnectAttempt = 0; // Reset backoff for fast reconnect
          this._scheduleReconnect();
        }
      }
    }, interval);
  }

  // Toggle aggressive ping cadence while a call is in progress. Webrtc.js
  // calls this on startCall/answerCall and on cleanup so non-call traffic
  // doesn't pay the higher ping cost outside calls.
  setCallActive(active) {
    const wasActive = this._callActive;
    this._callActive = !!active;
    if (wasActive !== this._callActive && this.pingTimer) {
      this._startPing();
    }
  }

  // [2026-07-03 iOS realtime] Toggle aggressive ping cadence while a chat
  // thread is OPEN (chat-conversation mount/unmount). This is exactly where
  // an iOS zombie socket is most visible — a new message sitting invisible
  // until the 15s poll. Aggressive mode (8s/10s, see _startPing) catches the
  // dead socket + reconnects + HTTP-syncs within ~10s instead of ~18s.
  // Reference-counted so overlapping mounts (list peek + open thread) don't
  // clobber each other, and a stale unmount can't flip it off early.
  setChatActive(active) {
    if (typeof this._chatActiveRefs !== 'number') this._chatActiveRefs = 0;
    this._chatActiveRefs = Math.max(0, this._chatActiveRefs + (active ? 1 : -1));
    const wasActive = this._chatActive;
    this._chatActive = this._chatActiveRefs > 0;
    if (wasActive !== this._chatActive && this.pingTimer) {
      this._startPing();
    }
  }

  // Force a fresh health check + reconnect when the caller knows they're
  // about to need a working socket (e.g. user just tapped "call" or
  // "answer").
  //
  // Two call patterns (overloaded by arg type to avoid breaking older callers):
  //   • ensureHealthy(token: string)  → token-aware sync path. Returns
  //       `true` if a reconnect was kicked off, `false` if the socket was
  //       already connected+authenticated on the given token. Use this
  //       instead of the manual triplet `_cleanup(); destroyed=false;
  //       reconnectAttempt=0; connect(token)` — it short-circuits when the
  //       socket is already healthy and avoids fighting MailContext's WS
  //       effect or resetting backoff state needlessly.
  //   • ensureHealthy(timeoutMs?: number)  → async ping-watchdog path.
  //       Sends a ping with a pong watchdog; if no pong, forces a clean
  //       cleanup + reconnect. Returns a promise resolving to `true` if
  //       the socket is healthy after the check, `false` otherwise.
  ensureHealthy(arg) {
    // Token path — caller passed a JWT string.
    if (typeof arg === 'string') {
      const token = arg;
      if (this.isConnected && this.authenticated && this.token === token) return false;
      if (!this.destroyed) {
        try { this._cleanup(); } catch {}
      }
      this.destroyed = false;
      if (this.token !== token) this.token = token;
      this.connect(token);
      return true;
    }
    // Original async health-check path (timeoutMs, defaults to 1500).
    return this._ensureHealthyPing(typeof arg === 'number' ? arg : 1500);
  }

  async _ensureHealthyPing(timeoutMs = 1500) {
    if (this.destroyed) return false;
    // Socket fully dead — force reconnect.
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      try { this._cleanup(); } catch {}
      this.destroyed = false;
      this.reconnectAttempt = 0;
      if (this.token) this.connect(this.token);
      const start = Date.now();
      while (!this.isConnected && Date.now() - start < timeoutMs) {
        await new Promise(r => setTimeout(r, 100));
      }
      return this.isConnected;
    }
    // Socket says alive — verify with a ping. iOS often returns OPEN for
    // a socket the radio sleep already killed.
    return await new Promise((resolve) => {
      const sentAt = Date.now();
      this._pingTs = sentAt;
      try { this._send({ type: 'ping', ts: sentAt }); } catch {}
      const watchdog = setTimeout(() => {
        if (this.lastPongTime < sentAt) {
          // Zombie — force reconnect.
          try { this._cleanup(); } catch {}
          this.destroyed = false;
          this.reconnectAttempt = 0;
          if (this.token) this.connect(this.token);
          // Wait briefly for handshake.
          const checkStart = Date.now();
          const check = () => {
            if (this.isConnected) return resolve(true);
            if (Date.now() - checkStart > timeoutMs) return resolve(false);
            setTimeout(check, 100);
          };
          check();
        } else {
          resolve(true);
        }
      }, Math.min(timeoutMs, 1500));
      // Pong arrived before watchdog → clear early.
      const sub = this.on('pong', () => {
        clearTimeout(watchdog);
        try { sub(); } catch {}
        resolve(true);
      });
    });
  }

  _stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  // [P0 2026-05-25] Enter the "needs re-login" hard-stop. Called when the
  // server keeps rejecting a freshly-refreshed token (auth-reject storm).
  // Stops all auto-reconnect: clears the reconnect timer, sets the stop flag
  // (which gates connect() and every scheduled reconnect callback), and
  // surfaces the SAME chatyy:authFailure signal the app already listens to
  // (AuthContext / MailContext) so the app forces a real re-login instead of
  // storming. The stop is only cleared by an explicit re-auth path:
  // reset(), resurrect(), or manualReconnect() — i.e. on the next foreground
  // with a fresh login or a manual reconnect call.
  _enterReloginStopped(reason) {
    this._authReloginStopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this._stopPing();
    try { console.warn('[WS] auth-reject storm stop — needs re-login (' + reason + ', strike ' + this._authRejectStreak + ')'); } catch {}
    try { this._logGhost?.('auth_relogin_stop', { reason, streak: this._authRejectStreak }); } catch {}
    // Tell the app to force a real re-login (same signal as the 8-strike
    // tombstone path so existing listeners pick it up with no new wiring).
    try {
      const apiMod = require('./api');
      apiMod.recordLogoutAttempt?.(reason, { source: 'websocket', streak: this._authRejectStreak });
    } catch {}
    try {
      if (typeof globalThis !== 'undefined') {
        globalThis.__chatyy_authFailure = Date.now();
        if (globalThis.dispatchEvent) globalThis.dispatchEvent(new Event('chatyy:authFailure'));
      }
    } catch {}
    this._emit('connection', { status: 'needs_relogin', reason });
  }

  // [P0 2026-05-25] Explicit manual reconnect / re-auth entry point. Lifts the
  // auth-reject hard-stop and re-arms the socket with the freshest token. Use
  // from a login-success handler or a user-initiated "reconnect" action. Safe
  // to call when not stopped (acts like a normal ensureHealthy). Returns true
  // if a reconnect was kicked off.
  manualReconnect() {
    this._authReloginStopped = false;
    this._authRejectStreak = 0;
    this._authRejectBackoff = 0;
    this._authFailStreak = 0;
    this.destroyed = false;
    this.reconnectAttempt = 0;
    let token = this.token;
    try {
      const apiMod = require('./api');
      const fresh = apiMod.getAuthToken?.();
      if (fresh && fresh.length > 0) token = fresh;
    } catch {}
    if (!token) return false;
    this.token = token;
    try { this._cleanup(); } catch {}
    this.connect(token);
    return true;
  }

  _scheduleReconnect() {
    if (this.destroyed || this._hidden || this._authReloginStopped) return;
    // Don't burn retries while the device is offline — the OS will fire a
    // 'resume' event when connectivity returns, at which point we blow the
    // attempt counter away and reconnect immediately.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
      this._emit('connection', { status: 'offline', attempt: this.reconnectAttempt });
      if (!this._onlineListenerAdded && typeof window !== 'undefined') {
        this._onlineListenerAdded = true;
        // Stash on instance so disconnect() can remove it — `{ once: true }`
        // covers the happy path, but if the user logs out while still
        // offline we want to detach without waiting for a stray online event.
        this._onOnlineHandler = () => {
          this._onlineListenerAdded = false;
          this._onOnlineHandler = null;
          this.reconnectAttempt = 0;
          if (this.token && !this.destroyed) this.connect(this.token);
        };
        window.addEventListener('online', this._onOnlineHandler, { once: true });
      }
      return;
    }
    // Exponential backoff with full jitter: pick a delay uniformly at random
    // from [0, base*2^attempt] up to RECONNECT_MAX. Full-jitter beats
    // base+jitter for a thundering-herd scenario (AWS Architecture Blog —
    // "Exponential Backoff And Jitter") because it spreads retries across
    // the whole window instead of clustering them at the end. Floor at
    // RECONNECT_BASE so we don't burn through retries faster than the
    // network can possibly recover (~800ms minimum settle).
    //
    // WhatsApp parity (2026-05-17): keep the first 4 attempts capped at 2.4s
    // so a transient flap (carrier handoff, AP roam, server reload) heals
    // before the "Reconectando..." banner even paints. Previously attempts
    // 4-5 climbed to 7-13s — banner appeared and lingered for what felt like
    // an outage. Only attempt 5+ allows the full 30s backoff for sustained
    // failures (e.g. real network outage), giving the device time to recover.
    const fastAttempts = 4;
    let cap;
    if (this.reconnectAttempt < fastAttempts) {
      // Fast lane: 800ms → 1.6s → 2.4s → 2.4s (capped)
      cap = Math.min(RECONNECT_BASE * (this.reconnectAttempt + 1), 2400);
    } else {
      cap = Math.min(RECONNECT_BASE * Math.pow(2, Math.min(this.reconnectAttempt, 5)), RECONNECT_MAX);
    }
    const delay = Math.max(RECONNECT_BASE, Math.floor(Math.random() * cap));
    this.reconnectAttempt++;
    this._emit('connection', {
      status: 'reconnecting',
      attempt: this.reconnectAttempt,
      nextRetryMs: delay,
    });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.token && !this.destroyed && !this._hidden) {
        this.connect(this.token);
      }
    }, delay);
  }

  // Track a message ID for deduplication. Ring buffer sized for a busy
  // multi-group user: 500 was too small — after ~2 hours of active group
  // chats old IDs were evicted and could re-enter via chat_sync on the
  // next reconnect, causing duplicate bubbles. 5000 covers ~24h of normal
  // traffic and stays well under any RN memory pressure.
  _trackMsgId(id) {
    if (!id || this._seenMsgIds.has(id)) return false; // duplicate
    this._seenMsgIds.add(id);
    this._seenMsgIdQueue.push(id);
    if (this._seenMsgIdQueue.length > 5000) {
      const old = this._seenMsgIdQueue.shift();
      this._seenMsgIds.delete(old);
    }
    return true; // new
  }

  _handleMessage(msg) {
    // ACK: If server sent an ack_id, immediately acknowledge receipt
    if (msg.ack_id) {
      this._send({ type: 'ack', ack_id: msg.ack_id });
    }

    // Resume-token high-water tracking. The server stamps every per-user
    // event with a monotonic `event_id` (BIGSERIAL from ws_event_log).
    // We keep the max we've ever observed so reconnects can ask the
    // server "replay anything > N" without losing messages. Persisted
    // every EVENT_ID_PERSIST_EVERY events to keep AsyncStorage churn low.
    if (msg && typeof msg.event_id === 'number' && msg.event_id > this._lastEventId) {
      this._lastEventId = msg.event_id;
      this._eventIdSinceFlush = (this._eventIdSinceFlush || 0) + 1;
      if (this._eventIdSinceFlush >= EVENT_ID_PERSIST_EVERY) {
        this._eventIdSinceFlush = 0;
        this._persistLastEventId();
      }
    }

    switch (msg.type) {
      case 'auth_success':
        this.authenticated = true;
        this._authFailStreak = 0;
        // [P0 2026-05-25] Any successful auth clears the storm guard: the
        // session is alive, so reset the refreshed-but-still-rejected streak,
        // its backoff, and lift the "needs re-login" hard-stop.
        this._authRejectStreak = 0;
        this._authRejectBackoff = 0;
        this._authReloginStopped = false;
        this.userId = msg.user_id || msg.account_id;
        this.email = msg.email;
        // Seed lastPongTime so the ping-timeout watchdog has a valid baseline.
        // Without this seed, the first-ping check could compare Date.now()
        // against a stale value from the previous connection.
        this.lastPongTime = Date.now();
        if (msg.server_ts) {
          this._serverTimeOffset = msg.server_ts - Date.now();
        }
        // Phase 1 transport upgrade: if the runtime flag is on and the
        // msgpack module is available, ask the server to switch this socket
        // to MessagePack. Server replies with {type:'msgpack_upgraded',ok:true}
        // as a final JSON frame and then all outbound frames become binary.
        // While the flag is off (default), this branch never fires and the
        // socket stays JSON end-to-end — zero behavior change.
        if (_msgpackEnabled() && !this.binaryUpgraded) {
          try { this._send({ type: 'upgrade_msgpack' }); } catch {}
        }
        this._emit('connection', { status: 'authenticated', userId: this.userId, email: msg.email });
        this._onAuthenticated();
        break;

      case 'auth_error':
        this.authenticated = false;
        this._emit('connection', { status: 'auth_error', message: msg.message });
        // Refresh token from storage before reconnecting (may have been updated by API layer)
        this._cleanup();
        if (!this.destroyed) {
          this.reconnectAttempt = Math.max(this.reconnectAttempt, 3); // Start with longer delay
          let hasToken = false;
          let inGrace = false;
          // [#1165 2026-05-18] Suppress auth-streak escalation while a call
          // is in progress. During Chatyy↔Chatyy calls the native
          // CallSignalWs opens a parallel WS session with the same bearer,
          // and Android pauses the JS thread when CallActivity covers the
          // RN view. The JS WS often reconnects mid-call and a transient
          // edge-hub state mismatch can return auth_error 1-2 times before
          // settling. Without this gate the streak counter races toward 8
          // strikes during a 30-second call → forces logout → user has to
          // log out + log in again before chat can resume. Bug report
          // verbatim: "na hora que liga parece que perde token, ai não
          // envia mais mensagem, ai tenho que deslogar e logar denovo".
          let callActive = false;
          try {
            if (typeof globalThis !== 'undefined' && globalThis.__chatyyCallActive) {
              callActive = true;
            } else if (this._callActive) {
              // Fallback to our own intra-class flag set via setCallActive()
              // by webrtc.js / call.js — same signal, different code path.
              callActive = true;
            }
          } catch {}
          // [#1189 2026-05-19] AWAIT the refresh BEFORE reconnecting.
          // Previously fire-and-forget meant reconnect fired in 3s with the
          // SAME expired JWT → auth_error → loop forever (97% fail rate
          // observed). _handleMessage isn't async, so we kick off the
          // refresh, hold off the reconnect, and re-enter via the .then().
          // If refresh returns false (server said dead), schedule a long
          // backoff (60s+) instead of storming 3s reconnects.
          const apiMod = require('./api');
          if (typeof apiMod.refreshAuthToken === 'function' && !this._authRefreshInFlight) {
            this._authRefreshInFlight = true;
            // [audit fix] Cap the refresh on a 5s timeout. Without this, a
            // network hang (TLS handshake stuck, server stuck mid-request)
            // would leave _authRefreshInFlight=true forever — every
            // subsequent auth_error would skip the refresh branch and the
            // WS would loop on the same expired bearer indefinitely. The
            // timeout sentinel resolves with `__timeout` so the .then can
            // distinguish it from a server `false` (revoked); on timeout
            // we treat it as a soft failure (apply auth-error backoff but
            // don't tombstone the socket — the bearer may still be alive).
            const TIMEOUT_SENTINEL = { __timeout: true };
            const refreshPromise = apiMod.refreshAuthToken().catch(() => true);
            const timeoutPromise = new Promise((resolveT) => {
              setTimeout(() => resolveT(TIMEOUT_SENTINEL), 5000);
            });
            Promise.race([refreshPromise, timeoutPromise])
              .then((refreshOk) => {
                this._authRefreshInFlight = false;
                if (this.destroyed) return;
                if (refreshOk === TIMEOUT_SENTINEL) {
                  try { console.warn('[WS] refreshAuthToken timed out after 5s — applying backoff'); } catch {}
                  // Treat hang as transient: schedule a long-ish reconnect
                  // (don't logout — token may still be valid, network was
                  // just stuck). On the next auth_error a new refresh will
                  // run since _authRefreshInFlight is cleared.
                  this._authErrorBackoff = Math.min((this._authErrorBackoff || 30000) * 1.5, 300000);
                  setTimeout(() => { if (!this.destroyed) this.connect(this.token); }, this._authErrorBackoff);
                  return;
                }
                if (refreshOk === false && !callActive) {
                  try { console.warn('[WS] refreshAuthToken returned false — bearer revoked, slowing reconnect'); } catch {}
                  this._authErrorBackoff = Math.min((this._authErrorBackoff || 30000) * 1.5, 300000);
                  setTimeout(() => { if (!this.destroyed) this.connect(this.token); }, this._authErrorBackoff);
                  return;
                }
                // Refresh "succeeded" (handed us a token). But landing in this
                // branch on a REPEAT auth_error — with no intervening
                // auth_success to reset the counter — means the server keeps
                // rejecting the refreshed token. That is the auth-reject storm.
                // [P0 2026-05-25] Count it, back off exponentially, and after
                // AUTH_REJECT_STOP strikes hard-stop instead of storming.
                this._authErrorBackoff = 0;
                const freshToken = apiMod.getAuthToken?.();
                if (freshToken && freshToken.length > 0 && freshToken !== this.token) {
                  this.token = freshToken;
                }
                // In-call grace (#1165): don't escalate the storm guard while a
                // call is active — the parallel CallSignalWs session + paused JS
                // thread legitimately race a couple of auth_errors. The reconnect
                // still fires; a truly dead session escalates once the call ends.
                if (callActive) {
                  try { console.warn('[WS] auth refreshed during active call — reconnecting without storm escalation'); } catch {}
                  this._scheduleReconnect();
                  return;
                }
                this._authRejectStreak = (this._authRejectStreak || 0) + 1;
                if (this._authRejectStreak >= AUTH_REJECT_STOP) {
                  // Refreshed token rejected AUTH_REJECT_STOP times in a row →
                  // the session is genuinely dead. Stop auto-reconnecting and
                  // force a real re-login. This is the storm circuit-breaker.
                  this._enterReloginStopped('ws_auth_reject_storm');
                  return;
                }
                // Below the hard-stop threshold: a genuinely transient single
                // 401 recovers here (streak 1, server accepts on reconnect →
                // auth_success resets to 0). Only the repeated case climbs.
                // Apply exponential backoff (2s,4s,8s…60s) BETWEEN these
                // auth-driven reconnects so we never storm even pre-stop.
                const prev = this._authRejectBackoff || 0;
                this._authRejectBackoff = prev
                  ? Math.min(prev * 2, AUTH_REJECT_BACKOFF_MAX)
                  : AUTH_REJECT_BACKOFF_BASE;
                try { console.warn('[WS] auth refreshed but server may reject — reconnect in ' + this._authRejectBackoff + 'ms (strike ' + this._authRejectStreak + '/' + AUTH_REJECT_STOP + ')'); } catch {}
                clearTimeout(this.reconnectTimer);
                this.reconnectTimer = setTimeout(() => {
                  if (this.token && !this.destroyed && !this._authReloginStopped) this.connect(this.token);
                }, this._authRejectBackoff);
              });
            // Don't fall through to the legacy reconnect path while refresh
            // is in-flight — we'll reconnect from inside the .then().
            break;
          }
          try {
            const freshToken = apiMod.getAuthToken?.();
            if (freshToken && freshToken.length > 0) {
              hasToken = true;
              if (freshToken !== this.token) this.token = freshToken;
            }
            // WhatsApp-grade refusal: if the token has been confirmed alive
            // via HTTP in the last 90 days, the WS auth_error is almost
            // certainly an edge hub state mismatch — keep reconnecting
            // forever instead of giving up after 8 strikes. The HTTP path
            // shares the same grace gate, so a truly revoked token still
            // logs out eventually via api.js.
            try { inGrace = !!apiMod.isTokenWithinGracePeriod?.(); } catch {}
          } catch {}
          if (hasToken) {
            // Don't increment streak during an active call — see #1165
            // comment above. The reconnect still fires, so a truly revoked
            // token will fail again after the call ends and ratchet the
            // streak from a clean baseline.
            if (!callActive) {
              this._authFailStreak = (this._authFailStreak || 0) + 1;
            } else {
              try { console.warn('[WS] auth_error during active call — not counting toward streak'); } catch {}
            }
            // 8 auth_errors in a row matches the HTTP 401 streak threshold.
            // Was 2, which logged users out the moment the WS edge server
            // hiccuped twice during a call cold-start — token was fine, the
            // edge just needed a moment. Same logic as services/api.js
            // _consecutive401: only sustained streaks indicate revoked tokens;
            // pairs are almost always transient.
            //
            // 2026-05-15: within the 90-day grace, NEVER give up — just
            // keep reconnecting with exponential backoff. WhatsApp parity:
            // a live token never gets the user kicked, no matter what
            // the WS hub says.
            if (this._authFailStreak >= 8 && !inGrace) {
              try {
                const apiMod = require('./api');
                apiMod.recordLogoutAttempt?.('ws_auth_streak', {
                  source: 'websocket',
                  streak: this._authFailStreak,
                });
              } catch {}
              try {
                if (typeof globalThis !== 'undefined') {
                  globalThis.__chatyy_authFailure = Date.now();
                  if (globalThis.dispatchEvent) globalThis.dispatchEvent(new Event('chatyy:authFailure'));
                }
              } catch {}
              this.destroyed = true;
              break;
            }
            this._scheduleReconnect();
          } else if (callActive) {
            // #1165: in-memory token went missing mid-call (cold-start race
            // or AuthContext remount). Don't tombstone the socket — try a
            // refresh-from-storage and retry. If still nothing after the
            // scheduled reconnect lands, the next auth_error will hit this
            // branch again, harmless. Killing the socket here would make
            // chat unsendable for the rest of the session.
            try {
              const apiMod = require('./api');
              if (typeof apiMod.refreshAuthToken === 'function') {
                apiMod.refreshAuthToken().then((ok) => {
                  if (ok) {
                    const tk = apiMod.getAuthToken?.();
                    if (tk) this.token = tk;
                  }
                }).catch(() => {});
              }
            } catch {}
            this._scheduleReconnect();
          } else {
            this.destroyed = true;
          }
        }
        break;

      case 'new_email':
        this._emit('new_email', msg.data);
        break;

      case 'email_deleted':
        this._emit('email_deleted', msg.data);
        break;

      case 'email_moved':
        this._emit('email_moved', msg.data);
        break;

      case 'email_read':
        this._emit('email_read', msg.data);
        break;

      case 'folder_updated':
        this._emit('folder_updated', msg.data);
        break;

      case 'pong':
        this.lastPongTime = Date.now();
        // Measure latency
        if (this._pingTs) {
          this._latency = Date.now() - this._pingTs;
        }
        // Surface pong to listeners so ensureHealthy() can resolve early
        // instead of waiting the full watchdog timeout.
        this._emit('pong', { latency: this._latency });
        break;

      case 'welcome':
        break;

      // Avatar changed on another device — bust local cache so every
      // <AvatarCircle> binds to the new URL (?v=<version>). The new URL
      // is a different cache key, so expo-image naturally fetches it.
      //
      // ⚠️ NÃO chamar ExpoImage.clearDiskCache() aqui. Esse método apaga
      // TODA a cache de disco (chat, feed, status, profile, todos os
      // avatares), e o WS dispara `avatar_updated` toda vez que QUALQUER
      // user da rede troca a foto. Em um app com vários contatos, isso
      // virava um wipe global a cada poucos segundos — "as fotos do
      // pessoal do app sumiu" (regression mega wave 2026-05-18 / OTA
      // 406a396). bustAvatarCache muda a URL via `?v=`, expo-image
      // miss → fetch → cache só DAQUELE avatar.
      case 'avatar_updated': {
        try {
          const data = msg.data || msg;
          const email = (data?.email || '').toLowerCase();
          const version = Number(data?.avatar_version || 0);
          if (!email) break;
          try {
            const api = require('./api');
            api.bustAvatarCache?.(email, version || undefined);
          } catch {}
          this._emit('avatar_updated', { email, version });
        } catch {}
        break;
      }

      case 'session_replaced':
        // Another device/tab opened — this session is being kicked.
        // Mark destroyed to prevent any reconnect attempts.
        this.destroyed = true;
        this._emit('connection', { status: 'session_replaced', message: msg.message });
        break;

      // Chat message deduplication + media prefetch
      case 'chat_message': {
        const chatMsg = msg.data || msg;
        const msgId = chatMsg?.message?.id || chatMsg?.id;
        if (msgId && !this._trackMsgId(msgId)) {
          return; // Duplicate, skip
        }
        // Kick off a background download for image + audio attachments the
        // moment they arrive — by the time the user navigates into the conv
        // the file is already on disk and ExpoImage / AudioPlayer renders
        // it instantly instead of streaming from R2 at open time. Crucially,
        // this makes media available OFFLINE later: without this hook the
        // download only happens when the user opens the bubble, so if they
        // never visited the chat the media never lands on the device.
        //
        // Scope: image + audio/voice only. Video / file / docs are skipped
        // here (too heavy for opportunistic prefetch); user taps to DL.
        // Throttled to 3 concurrent + cellular-gated inside mediaCache.
        try {
          const inner = chatMsg?.message || chatMsg;
          const { prefetchIncomingMessageMedia } = require('./mediaCache');
          prefetchIncomingMessageMedia?.(inner);
        } catch {}
        // Voice-specific prefetch — persists server-side wave_peaks into
        // MMKV (so the bubble paints the real envelope on next mount,
        // even before audio bytes arrive) and triggers a permanent
        // download into audio-saved/ (immune to LRU eviction). Bypasses
        // cellular gate — voice notes are 30-200KB. WhatsApp parity:
        // the recipient should be able to play offline a voice received
        // weeks ago. Idempotent — dup events for the same msg.id no-op.
        try {
          const inner = chatMsg?.message || chatMsg;
          const { onIncomingVoiceMessage } = require('./voicePrefetch');
          onIncomingVoiceMessage?.(inner);
        } catch {}
        // GLOBAL delivery ack — fire the moment ANY chat message lands on
        // this device, regardless of which screen is open. The per-conv
        // handler in chat-conversation.js only ran when that exact thread
        // was mounted, so messages arriving on the list/home screen stuck
        // at ✓ (sent) instead of flipping to ✓✓ (delivered). WhatsApp-tier:
        // delivered = "on device", not "on open thread".
        try {
          const inner = chatMsg?.message || chatMsg;
          const convId = inner?.conversation_id || chatMsg?.conversation_id;
          const sender = (inner?.sender_email || chatMsg?.sender_email || '').toLowerCase();
          const self = (this.email || '').toLowerCase();
          const id = inner?.id;
          if (convId && sender && self && sender !== self && typeof id === 'number') {
            const api = require('./api');
            // Coalesce per-msg acks into a single POST per 250ms window.
            // In an active conv a burst of 20 inbound messages would
            // otherwise fire 20 HTTP POSTs back-to-back, burning radio +
            // server CPU. Batched path is fire-and-forget and dedups ids
            // internally, so calling for the same id is cheap.
            if (typeof api.chatDeliveryAckBatched === 'function') {
              api.chatDeliveryAckBatched(convId, [id]);
            } else if (typeof api.chatDeliveryAck === 'function') {
              api.chatDeliveryAck(convId, [id]).catch(() => {});
            }
          }
        } catch {}
        this._emit('chat_message', chatMsg);
        break;
      }

      // Message delivery acknowledgment from server
      case 'message_ack': {
        // Resolve pending outgoing message by msg_id or temp_id
        const resolveId = msg.msg_id || msg.temp_id || '';
        if (resolveId && this._pendingOutgoing.has(resolveId)) {
          const entry = this._pendingOutgoing.get(resolveId);
          clearTimeout(entry.timer);
          this._pendingOutgoing.delete(resolveId);
          if (entry.resolve) entry.resolve(msg);
        }
        // [WAVE 66 2026-05-21] Reset zombie ack-fail counter on any ack.
        this._consecutiveAckFails = 0;
        this._emit('message_ack', msg);
        break;
      }

      // Presence updates (online/offline)
      case 'presence':
        this._emit('presence', msg);
        break;

      case 'presence_result':
        this._emit('presence_result', msg.presences || {});
        break;

      // Stopped typing
      case 'stopped_typing':
        this._emit('stopped_typing', msg.data || msg);
        break;

      // Stage 6 — web↔phone history relay RESPONSE (web requester side).
      // The phone read SQLite and is sending the rows back, OR the server is
      // returning a sentinel error (phone_offline / relay_timeout /
      // no_paired_device). We MUST emit the full frame (not msg.data) so the
      // listener in services/relayClient.js can dispatch by requestId. The
      // default `_emit(msg.type, msg.data || msg)` would strip the top-level
      // requestId/error fields when msg.data is set, breaking the request
      // map lookup.
      case 'relay_response':
        this._emit('relay_response', msg);
        break;

      // Cross-device settings sync (theme, language, etc.). Fanned out by
      // the WS server on the same-email channel (chat_user_<email>). The
      // origin field carries the sender device id so the receiving context
      // can ignore its own echo and avoid re-emit loops. Emitting the full
      // frame so listeners see `key`, `value`, `origin` at the top level.
      case 'user_setting_update':
        this._emit('user_setting_update', msg);
        break;

      // Resume-token protocol: server signals end of a replay batch.
      // count = events replayed; has_more = true if more events exist
      // beyond the cap; last_event_id = highest id in this batch (useful
      // for follow-up resume requests if has_more). Replayed messages
      // were already dispatched into the normal handlers above with
      // `resumed: true` and their event_id stamped, so listeners get
      // them naturally — this is just the bookkeeping ack.
      case 'resume_result':
        this._resumeInFlight = false;
        try {
          if (typeof msg.last_event_id === 'number' && msg.last_event_id > this._lastEventId) {
            this._lastEventId = msg.last_event_id;
            this._persistLastEventId();
          }
        } catch {}
        this._emit('resume_result', {
          count: msg.count || 0,
          has_more: !!msg.has_more,
          last_event_id: msg.last_event_id || this._lastEventId,
        });
        // If the server says there's more beyond the cap, immediately
        // ask for the next page. Bounded by the same MaxResumeReplay on
        // the server, so worst case we walk forward in 200-event chunks
        // until caught up. Cheap and won't loop forever: each iteration
        // advances last_event_id strictly.
        if (msg.has_more && !this.destroyed) {
          try {
            this._resumeInFlight = true;
            this._send({ type: 'resume', last_event_id: this._lastEventId });
          } catch { this._resumeInFlight = false; }
        }
        break;

      // [2026-06-23] The LIVE C++ hub (main.cpp:530 on_resume_message)
      // signals end of a replay batch with {type:'resume_complete', count}
      // — NOT 'resume_result'. The client only knew 'resume_result', so
      // 'resume_complete' fell through to default and `_resumeInFlight`
      // NEVER reset to false → after the FIRST reconnect of a session the
      // resume request was gated out (see the `if (!this._resumeInFlight)`
      // guard before `_send({type:'resume'})`) and catch-up of missed
      // events silently died until cold start. The replayed events were
      // already dispatched through the normal handlers (each carries its
      // event_id, advancing _lastEventId), so here we just clear the flag.
      case 'resume_complete':
        this._resumeInFlight = false;
        try {
          const _rcCount = (typeof msg.count === 'number') ? msg.count : 0;
          this._emit('resume_result', {
            count: _rcCount,
            has_more: false,
            last_event_id: this._lastEventId,
          });
          // Belt-and-suspenders: if we were actually behind (replayed > 0),
          // the hub may have capped the replay batch. Nudge the existing
          // idempotent HTTP catch-up (chat screens wire `foreground` →
          // chat_sync, last_seq-filtered so a duplicate is a no-op) so no
          // gap survives a large backlog. Cheap; skipped when count===0.
          if (_rcCount > 0 && !this.destroyed) {
            this._emit('foreground', { ts: Date.now(), source: 'resume_complete' });
          }
        } catch {}
        break;

      // Server says "you're too far behind — drop your local state and
      // do a full sync via HTTP." We emit `resume_full_sync` so chat
      // screens can trigger their existing catch-up paths (chat list +
      // recent-message fetch). _lastEventId is NOT reset to 0 — if the
      // cause was a transient probe_failed we still want the next
      // reconnect to attempt a normal resume.
      case 'resume_full_sync':
        this._resumeInFlight = false;
        try {
          this._emit('resume_full_sync', {
            reason: msg.reason || 'unknown',
            gap: msg.gap || 0,
          });
          // Also nudge any existing foreground listener — chat screens
          // already wire `foreground` to trigger a chat_sync, so this is
          // the cheapest way to plug the catch-up endpoint fallback
          // without rewiring every screen. The chat_sync HTTP call is
          // idempotent (last_seq filter) so a duplicate trigger is safe.
          this._emit('foreground', { ts: Date.now(), source: 'resume_full_sync' });
        } catch {}
        break;

      default:
        // Prefetch media for chat_summary too (list-screen bump with
        // full payload when user is on the list, not in-thread). Without
        // this, opening a conv after receiving a new image triggers a
        // fresh R2 download at render time — noticeable flash on slow
        // networks.
        if (msg.type === 'chat_summary') {
          // Auto-prefetch image + audio so the chat is fully offline-ready
          // even when the recipient never opens the conv (chat_summary is
          // the per-user fan-out, so this is the only path some messages
          // take). Same scope/throttle/gate as the chat_message branch.
          try {
            const inner = (msg.data && (msg.data.message || msg.data)) || msg;
            const { prefetchIncomingMessageMedia } = require('./mediaCache');
            prefetchIncomingMessageMedia?.(inner);
          } catch {}
          // Voice-specific prefetch (waveform peaks + permanent audio
          // cache + played-ack tracking). Same scope as the chat_message
          // branch above — chat_summary is the recipient's per-user
          // fan-out so without this hook the voice never gets cached
          // unless the user manually opens the conv.
          try {
            const inner = (msg.data && (msg.data.message || msg.data)) || msg;
            const { onIncomingVoiceMessage } = require('./voicePrefetch');
            onIncomingVoiceMessage?.(inner);
          } catch {}
          // Delivery ack for chat_summary too — the recipient's per-user
          // channel delivers via this type, not chat_message, so without
          // this branch the ✓✓ tick only flipped when they opened the
          // thread (triggering the in-thread handler). Match the
          // chat_message behavior above.
          try {
            const inner = (msg.data && (msg.data.message || msg.data)) || msg;
            const convId = inner?.conversation_id || msg?.conversation_id;
            const sender = (inner?.sender_email || msg?.sender_email || '').toLowerCase();
            const self = (this.email || '').toLowerCase();
            const id = inner?.id;
            if (convId && sender && self && sender !== self && typeof id === 'number') {
              const api = require('./api');
              // Batched coalescer (see chat_message branch above for why).
              if (typeof api.chatDeliveryAckBatched === 'function') {
                api.chatDeliveryAckBatched(convId, [id]);
              } else if (typeof api.chatDeliveryAck === 'function') {
                api.chatDeliveryAck(convId, [id]).catch(() => {});
              }
            }
          } catch {}
        }
        this._emit(msg.type, msg.data || msg);
    }
  }

  // Subscribe to a channel (tracked for re-subscribe on reconnect)
  subscribe(channel) {
    this._subscribedChannels.add(channel);
    this._send({ type: 'subscribe', channel });
  }

  // Unsubscribe from a channel
  unsubscribe(channel) {
    this._subscribedChannels.delete(channel);
    this._send({ type: 'unsubscribe', channel });
  }

  // Generate a unique client-side message ID
  _genMsgId() {
    return `c_${Date.now().toString(36)}_${(++this._msgIdCounter).toString(36)}`;
  }

  // Relay a chat message with delivery guarantee
  // Returns a promise that resolves when server ACKs, or rejects after max retries
  relayChatMessage(conversationId, message, tempId, memberEmails) {
    const msgId = this._genMsgId();
    const data = {
      type: 'chat_message_relay',
      conversation_id: conversationId,
      message,
      temp_id: tempId || '',
      msg_id: msgId,
      member_emails: memberEmails || [],
    };

    // Track our own message ID to prevent echo
    if (message?.id) this._trackMsgId(message.id);

    return this._sendWithRetry(msgId, data);
  }

  // Send a message with retry logic; resolves when server ACKs
  _sendWithRetry(msgId, data) {
    return new Promise((resolve) => {
      const attempt = () => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(this._encodeOutbound(data));
        } else {
          // Queue for when we reconnect
          if (this._messageQueue.length < MAX_QUEUE_SIZE) {
            // Avoid duplicate queue entries
            if (!this._messageQueue.some(q => q.msg_id === msgId)) {
              this._messageQueue.push(data);
            }
          } else {
            // Queue overflow — was silently dropping #101+ messages on a
            // long WS reconnect window. Now surface to the app so it can
            // either show a banner or fall back to plain HTTP send.
            this._emit('queue_overflow', { droppedMsgId: msgId, queueSize: this._messageQueue.length });
          }
        }
      };

      const entry = {
        data,
        retries: 0,
        resolve,
        timer: null,
      };

      const scheduleRetry = () => {
        // Race guard: server-ack handler (`message_ack`) deletes the entry
        // synchronously and resolves the promise. If the retry timer fired
        // in the same tick, we'd RE-SEND an already-acked message → server
        // gets the same payload twice. Bail when our entry is gone.
        if (!this._pendingOutgoing.has(msgId)) return;
        entry.retries++;
        if (entry.retries > CLIENT_MSG_MAX_RETRIES) {
          this._pendingOutgoing.delete(msgId);
          resolve({ failed: true, msg_id: msgId }); // Resolve instead of reject to avoid unhandled
          // [WAVE 66 2026-05-21] Server-side ack tracking: 3 consecutive
          // missed ACKs means the socket is a zombie even if readyState
          // reads OPEN. Force a resurrect so user doesn't keep losing
          // messages silently. Counter rolls when ANY ack lands.
          this._consecutiveAckFails = (this._consecutiveAckFails || 0) + 1;
          if (this._consecutiveAckFails >= 3) {
            this._consecutiveAckFails = 0;
            this._logGhost('ack_fail_resurrect', { msgId });
            try { console.warn('[WS] 3 consecutive ACK fails → forcing resurrect'); } catch {}
            try { this.resurrect('ack_fail_streak'); } catch {}
          }
          return;
        }
        attempt();
        entry.timer = setTimeout(scheduleRetry, CLIENT_MSG_RETRY_MS);
      };

      // Bound the map: evict the oldest entry if we'd exceed the cap.
      // Map.keys() yields insertion order, so the first key is the oldest.
      // We clear its timer and resolve its promise with failed=true so any
      // caller awaiting it unblocks (instead of hanging forever on a
      // silently-dropped entry).
      if (this._pendingOutgoing.size >= PENDING_OUTGOING_CAP) {
        const oldestKey = this._pendingOutgoing.keys().next().value;
        if (oldestKey !== undefined) {
          const oldEntry = this._pendingOutgoing.get(oldestKey);
          if (oldEntry?.timer) clearTimeout(oldEntry.timer);
          if (typeof oldEntry?.resolve === 'function') {
            try { oldEntry.resolve({ failed: true, msg_id: oldestKey, evicted: true }); } catch {}
          }
          this._pendingOutgoing.delete(oldestKey);
        }
      }
      this._pendingOutgoing.set(msgId, entry);
      attempt();
      entry.timer = setTimeout(scheduleRetry, CLIENT_MSG_RETRY_MS);
    });
  }

  // Send typing indicator (debounced: max once per 3s per conversation)
  sendTyping(conversationId, recording = false) {
    if (!this.isConnected) return;
    const now = Date.now();
    const lastSent = this._lastTypingSent.get(conversationId) || 0;
    if (now - lastSent < TYPING_DEBOUNCE) return;
    this._lastTypingSent.set(conversationId, now);
    this._send({ type: 'typing', conversation_id: conversationId, recording });

    // Reset the stopped_typing timer
    const existing = this._typingStopTimers.get(conversationId);
    if (existing) clearTimeout(existing);
    this._typingStopTimers.set(conversationId, setTimeout(() => {
      this._send({ type: 'stopped_typing', conversation_id: conversationId });
      this._typingStopTimers.delete(conversationId);
      this._lastTypingSent.delete(conversationId);
    }, TYPING_STOP_DELAY));
  }

  // Explicitly stop typing (e.g., when message is sent)
  sendStoppedTyping(conversationId) {
    const timer = this._typingStopTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    this._typingStopTimers.delete(conversationId);
    this._lastTypingSent.delete(conversationId);
    if (this.isConnected) {
      this._send({ type: 'stopped_typing', conversation_id: conversationId });
    }
  }

  // Query presence of specific emails
  queryPresence(emails) {
    if (this.isConnected && Array.isArray(emails) && emails.length > 0) {
      this._send({ type: 'presence_query', emails });
    }
  }

  // WhatsApp-grade push suppression: tell the server which conversation the
  // user is actively viewing so it can skip the OS-level FCM/APNs push for
  // that conversation (the WS chat_message event already drives the in-app
  // update). Server writes chat_user_presence.active_conversation_id;
  // PHP push path reads it and gates on status=online + last_seen<30s.
  // Fail-open design: if WS is disconnected the column stays null → push fires.
  sendConvFocus(conversationId) {
    if (!this.isConnected || !conversationId) return;
    this._send({ type: 'conv_focus', conversation_id: conversationId });
  }

  // Clear the active conversation focus so pushes resume (e.g. when user
  // navigates away or the app goes to background).
  sendConvBlur(conversationId) {
    if (!this.isConnected || !conversationId) return;
    this._send({ type: 'conv_blur', conversation_id: conversationId });
  }

  // Send read receipt over WS so peer flips ✓✓ blue ticks in <50ms instead
  // of waiting on HTTP chat_mark_read round-trip (~300ms+). Server case
  // `message_read` broadcasts back on `chat_{convId}` channel so the peer's
  // open thread + other listeners flip in real-time. HTTP chatRead still
  // fires for persistence — this is the in-band signaling fast-path.
  sendMessageRead(conversationId, lastReadId) {
    if (!this.isConnected || !conversationId) return;
    this._send({
      type: 'message_read',
      conversation_id: conversationId,
      message_ids: lastReadId ? [lastReadId] : [],
      last_read_id: lastReadId || 0,
    });
  }

  // Subscribe to presence changes for specific emails
  watchPresence(emails) {
    if (Array.isArray(emails) && emails.length > 0) {
      // Track watched emails for re-subscription on reconnect
      if (!this._watchedPresence) this._watchedPresence = new Set();
      emails.forEach(e => this._watchedPresence.add(e));
      if (this.isConnected) {
        this._send({ type: 'presence_subscribe', emails });
      }
    }
  }

  // Replay queued messages and re-subscribe to tracked channels after reconnect
  _onAuthenticated() {
    // [WAVE 66 2026-05-21] Auth landed → cancel any pending resurrect retry
    // and clear sticky banner so UI snaps back to clean.
    if (this._resurrectRetryTimer) {
      clearTimeout(this._resurrectRetryTimer);
      this._resurrectRetryTimer = null;
    }
    if (this._resurrectAttempt > 0) {
      this._logGhost('resurrect_landed', { attempts: this._resurrectAttempt });
    }
    this._resurrectAttempt = 0;
    this._consecutiveAckFails = 0;

    // Re-subscribe to all tracked channels
    for (const channel of this._subscribedChannels) {
      this._send({ type: 'subscribe', channel });
    }

    // Re-subscribe to watched presence emails
    if (this._watchedPresence && this._watchedPresence.size > 0) {
      this._send({ type: 'presence_subscribe', emails: [...this._watchedPresence] });
    }

    // ─── Resume catch-up (WhatsApp pattern) ───
    // Ask the server to replay any per-user events with id > our high
    // water mark. This MUST run on every reconnect, even on a clean
    // first-auth where _lastEventId is 0 — the server interprets 0 as
    // "give me everything, capped at MaxResumeReplay" which still
    // protects fresh installs (gap > cap → full_sync). We don't await
    // anything; resume_result / resume_full_sync arrive asynchronously
    // and are handled in _handleMessage.
    if (!this._resumeInFlight) {
      try {
        this._resumeInFlight = true;
        this._send({ type: 'resume', last_event_id: this._lastEventId || 0 });
      } catch { this._resumeInFlight = false; }
    }

    // Replay order matters: pending (already-sent-but-unacked) goes FIRST
    // so the server's idempotency layer can dedupe them before we flush new
    // offline-queued messages. Otherwise a reconnect right after a send
    // could deliver the new message before the retry of the older one,
    // surfacing as out-of-order bubbles in the recipient's thread.
    const pendingMsgIds = new Set();
    for (const [msgId, entry] of this._pendingOutgoing) {
      pendingMsgIds.add(msgId);
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try { this.ws.send(this._encodeOutbound(entry.data)); } catch {}
        // Reset the retry timer — we just re-sent here, so the next retry
        // shouldn't fire 3s after the original send (which is now in the
        // past). Leaving the original timer caused a double-send: this
        // reconnect-replay PLUS the retry tick fired at ~T+3s. The newly
        // scheduled timer also self-aborts via the `_pendingOutgoing.has`
        // guard if the ack arrives before the retry deadline.
        if (entry.timer) {
          try { clearTimeout(entry.timer); } catch {}
          // We can't reach the closure-bound scheduleRetry from here, but
          // the ack handler already clears the timer on success and the
          // reconnect-loop above is the only other re-send path. Leaving
          // entry.timer null is safe: the entry stays in the map until ack
          // (clears it) or until the next reconnect (re-sends + clears).
          entry.timer = null;
        }
      }
    }
    // Flush offline queue, skipping anything already in _pendingOutgoing
    // (e.g. _send queued the same message that retry-tracking was also
    // holding) so we don't double-send.
    const queued = this._messageQueue.splice(0);
    const totalCount = queued.length + pendingMsgIds.size;
    if (totalCount > 0) {
      this._emit('queue_flush', { count: totalCount });
    }
    for (const msg of queued) {
      if (msg && msg.msg_id && pendingMsgIds.has(msg.msg_id)) continue;
      this._send(msg);
    }

    // Emit a "reconnected / fully-authenticated" signal so chat screens can
    // trigger a catch-up chat_sync (identical to foreground). Without this
    // the conversation list + open thread stay stale after a reconnect that
    // happened while the app was already in the foreground (carrier flap).
    try { this._emit('foreground', { ts: Date.now(), source: 'reconnect' }); } catch {}

    // [Wave D, 2026-05-18] Mid-call WS reconnect — WhatsApp parity. The
    // LiveKit Room peer connection uses UDP independently of the WS, so
    // audio keeps flowing while the WS is dead. When the WS comes back
    // we emit `ws_resync` with a `inCall` flag so:
    //   - The call screen can short-circuit any "connection lost"
    //     banner it painted on the WS drop.
    //   - IncomingCallListener can validate its callRef.current is
    //     still rung (cancel-during-disconnect race).
    // We rely on globalThis.__chatyy_inCall (set by /call screen) instead
    // of importing the call store here to keep this module free of
    // circular deps.
    try {
      const inCall = !!(typeof globalThis !== 'undefined' && globalThis.__chatyy_inCall);
      if (inCall || this._reconnectCount > 0) {
        this._emit('ws_resync', {
          ts: Date.now(),
          inCall,
          reconnect_count: this._reconnectCount,
        });
      }
    } catch {}

    // Drain the persistent outbox (chat_sends queued while offline) the
    // moment the WS authenticates — WhatsApp-style. Previously this only
    // replayed when the OS fired an `online` event, which never happens
    // during a brief WiFi/cellular flap where navigator.onLine stayed true
    // but the WS got dropped. Now any successful auth triggers the drain
    // so the user's queued messages land within ~1s of reconnect.
    try {
      // Lazy require to avoid circular dependency at module load.
      const { replayOfflineQueue } = require('./offlineCache');
      const api = require('./api');
      // Throttle: don't drain twice within 3s (e.g. auth_success + foreground
      // both fire on a fast reconnect).
      if (!this._lastOutboxDrainAt || (Date.now() - this._lastOutboxDrainAt) > 3000) {
        this._lastOutboxDrainAt = Date.now();
        Promise.resolve(replayOfflineQueue(api)).then((r) => {
          if (r?.replayed > 0) {
            this._emit('outbox_drained', { count: r.replayed });
          }
        }).catch(() => {});
      }
    } catch {}
  }

  // Event system
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const cbs = this.listeners.get(event);
    if (cbs) cbs.delete(callback);
  }

  _emit(event, data) {
    const cbs = this.listeners.get(event);
    if (cbs) cbs.forEach(cb => { try { cb(data); } catch {} });
  }

  // ─── Resume token persistence ───
  // Load the high-water event_id from disk so a cold start can resume
  // from wherever the previous session left off. Called once from the
  // constructor — fire-and-forget. If storage is empty (fresh install)
  // we leave _lastEventId at 0, which the server treats as "give me
  // everything up to MaxResumeReplay" (and then full_sync if more).
  async _loadLastEventId() {
    try {
      const raw = await AsyncStorage.getItem(WS_LAST_EVENT_ID_KEY);
      if (!raw) return;
      const n = parseInt(raw, 10);
      if (Number.isFinite(n) && n > this._lastEventId) {
        this._lastEventId = n;
      }
    } catch {}
  }

  // Save the current high-water. Throttled by the caller (every N events
  // in _handleMessage, or on key transitions like resume_result). We
  // don't await — AsyncStorage is fast enough and a failed write just
  // means a tiny replay overlap on next launch, which the server
  // dedupes via event_id ordering.
  _persistLastEventId() {
    try {
      const v = String(this._lastEventId || 0);
      AsyncStorage.setItem(WS_LAST_EVENT_ID_KEY, v).catch(() => {});
      this._lastEventIdPersistedAt = Date.now();
    } catch {}
  }

  /**
   * Public emit — used by offline-queue replay to inject a synthetic
   * chat_message event so an open chat screen can replace its optimistic
   * temp message with the real server-side row when the queue actually
   * fires the send. Without this, replayed messages keep their temp_id
   * forever in the open screen and the same row reappears (in a new
   * position) the next time the screen reloads.
   */
  emit(event, data) {
    this._emit(event, data);
  }

  get isConnected() {
    return this.connected && this.authenticated;
  }

  get isHealthy() {
    if (!this.connected || !this.authenticated) return false;
    if (!this.lastPongTime) return this.connected;
    return (Date.now() - this.lastPongTime) < PING_INTERVAL * 3;
  }

  // Connection quality: 'good' | 'warn' | 'bad'
  get healthStatus() {
    if (this.authenticated) return this.isHealthy ? 'good' : 'warn';
    if (this.connected) return 'warn';
    return 'bad';
  }

  // Connection quality metrics for UI
  get connectionQuality() {
    return {
      status: this.healthStatus,
      latency: this._latency,
      reconnects: this._reconnectCount,
      droppedPings: this._droppedCount,
      isConnected: this.isConnected,
      queueSize: this._messageQueue.length,
      pendingOutgoing: this._pendingOutgoing.size,
    };
  }
}

// Singleton
const mailWs = new MailWebSocket();
export default mailWs;
