/**
 * OneMundo Mail WebSocket Client v3.0
 * Real-time email/chat notifications with auto-reconnect, message queue, and connection tracking
 *
 * v3.0: exponential backoff, connection quality tracking, message relay,
 *       typing debounce, presence via WS, offline queue with retry,
 *       deduplication, latency tracking
 */
import { Platform, AppState } from 'react-native';

// Direct WS connection (bypasses Cloudflare — no 100s idle timeout)
const WS_URL = null; // Dynamic — resolved at connect time from best edge server

// 800ms first retry — WhatsApp-tier silent recovery. Was 500ms, but real-world
// flaps (carrier handoff, brief AP loss) lasted 600-1500ms; the 500ms retry
// always fired BEFORE the network re-stabilized, surfacing a noisy
// "Reconectando…" flash. 800ms lets the OS settle first so the very first
// connect attempt usually succeeds — invisible recovery.
const RECONNECT_BASE = 800;
const RECONNECT_MAX = 30000;     // Max 30s between retries
// WhatsApp-tier liveness — detect a silently-dead socket in ~18s instead of
// the TCP keepalive default (~60-120s). Cost is negligible (~3 B/s of ping
// frames). During an active call we drop to 8s/15s via _callActive (see
// _startPing) so ICE candidate loss is detected even faster.
const PING_INTERVAL = 12000;
const PING_TIMEOUT = 18000;
const MAX_QUEUE_SIZE = 100;
const TYPING_DEBOUNCE = 3000;   // Send typing every 3s max
const TYPING_STOP_DELAY = 3000; // Send stopped_typing after 3s idle
const CLIENT_MSG_RETRY_MS = 3000; // Retry outgoing messages after 3s
const CLIENT_MSG_MAX_RETRIES = 3;

class MailWebSocket {
  constructor() {
    this.ws = null;
    this.token = null;
    this.userId = null;
    this.email = null;
    this.connected = false;
    this.authenticated = false;
    this.listeners = new Map();
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.destroyed = false;
    this._hidden = false;
    this.lastPongTime = 0;
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
    } catch {}
  }

  connect(token) {
    if (this.destroyed) return;
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

    try {
      // Use dedicated WS domain (bypasses Cloudflare proxy which breaks WS)
      const wsUrl = 'wss://ws.chatyy.com.br/ws';
      this.ws = new WebSocket(wsUrl);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      this.reconnectAttempt = 0;
      this._emit('connection', { status: 'connected' });

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
      try {
        const msg = JSON.parse(event.data);
        // Track call_end_ack at the top level so the call screen's
        // BYE retry loop can short-circuit when the server confirms
        // it received our hangup. Without this we keep retrying for 3
        // seconds even when the first BYE went through fine.
        if (msg && msg.type === 'call_end_ack' && msg.call_id) {
          try { (typeof window !== 'undefined' ? window : globalThis).__lastCallEndAckId = msg.call_id; } catch {}
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

  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else if (data && (data.type === 'chat_message' || data.type === 'chat_message_relay')) {
      // Queue chat messages when WS is not open (max queue size)
      if (this._messageQueue.length < MAX_QUEUE_SIZE) {
        this._messageQueue.push(data);
      }
    }
  }

  // Send with guaranteed delivery -- queues if offline, replays on reconnect
  send(data) {
    this._send(data);
  }

  _startPing() {
    this._stopPing();
    // Aggressive 8s/15s ping during active calls so a zombie socket is
    // detected in ~15s instead of 60s — critical so ICE candidates and
    // hangup messages don't disappear into a dead socket while audio dies.
    const interval = this._callActive ? 8000 : PING_INTERVAL;
    const timeout = this._callActive ? 15000 : PING_TIMEOUT;
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

  // Force a fresh health check + reconnect when the caller knows they're
  // about to need a working socket (e.g. user just tapped "call" or
  // "answer"). Sends a ping with a 1.5s pong watchdog; if no pong, forces
  // a clean cleanup + reconnect. Returns a promise that resolves to
  // `true` if the socket is healthy after the check, `false` otherwise.
  async ensureHealthy(timeoutMs = 1500) {
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

  _scheduleReconnect() {
    if (this.destroyed || this._hidden) return;
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

    switch (msg.type) {
      case 'auth_success':
        this.authenticated = true;
        this._authFailStreak = 0;
        this.userId = msg.user_id || msg.account_id;
        this.email = msg.email;
        // Seed lastPongTime so the ping-timeout watchdog has a valid baseline.
        // Without this seed, the first-ping check could compare Date.now()
        // against a stale value from the previous connection.
        this.lastPongTime = Date.now();
        if (msg.server_ts) {
          this._serverTimeOffset = msg.server_ts - Date.now();
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
          try {
            const apiMod = require('./api');
            // Active refresh path: if the API layer exposes a refreshToken()
            // (HTTP layer's silent renew), kick it off so the next reconnect
            // picks up a fresh bearer instead of retrying with the same
            // already-rejected one. Fire-and-forget — _scheduleReconnect's
            // backoff gives it time to land.
            if (typeof apiMod.refreshAuthToken === 'function') {
              try { apiMod.refreshAuthToken().catch(() => {}); } catch {}
            }
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
            this._authFailStreak = (this._authFailStreak || 0) + 1;
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

      // Avatar changed on another device — bust local cache + clear ExpoImage's
      // memory/disk cache so every <AvatarCircle> re-fetches the new photo.
      // Without this the iOS NSURLCache (cachePolicy="memory-disk") keeps
      // serving the stale image for up to 24h.
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
          // Drop BOTH memory and disk cache — clearMemoryCache alone leaves
          // expo-image's NSURLCache holding the stale image, and the next
          // render hands it the new URL but the resolver hits the disk
          // entry first. clearDiskCache forces a re-fetch from server.
          try {
            const ExpoImage = require('expo-image').Image;
            ExpoImage?.clearMemoryCache?.();
            ExpoImage?.clearDiskCache?.();
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
          this.ws.send(JSON.stringify(data));
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
          return;
        }
        attempt();
        entry.timer = setTimeout(scheduleRetry, CLIENT_MSG_RETRY_MS);
      };

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
    // Re-subscribe to all tracked channels
    for (const channel of this._subscribedChannels) {
      this._send({ type: 'subscribe', channel });
    }

    // Re-subscribe to watched presence emails
    if (this._watchedPresence && this._watchedPresence.size > 0) {
      this._send({ type: 'presence_subscribe', emails: [...this._watchedPresence] });
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
        try { this.ws.send(JSON.stringify(entry.data)); } catch {}
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
