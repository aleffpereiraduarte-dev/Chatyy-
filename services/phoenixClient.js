/**
 * services/phoenixClient.js — lightweight Phoenix Channels client (v2.0.0).
 *
 * Strangler-fig migration step 3 (PREP ONLY). This is an ADDITIVE connector
 * that lets the app talk to the new Phoenix real-time hub. It is gated behind
 * the USE_PHOENIX_HUB flag (services/flags.js, default OFF) and is NOT wired
 * into the live chat screens or the legacy WebSocket client
 * (services/websocket.js) yet. Nothing imports this file while the flag is
 * off. The goal is a drop-in transport we can shadow-test, then cut chat over.
 *
 * WHY NOT the `phoenix` npm package: we must stay 100% OTA-able (JS/assets
 * only, no new native/binary deps). The Phoenix Socket/Channel wire protocol
 * is tiny, so we implement it directly over the platform `WebSocket` (RN +
 * web both provide the global). This keeps the bundle small and avoids adding
 * a dependency that could drag in incompatible transitive code.
 *
 * ─── Wire protocol (Phoenix v2.0.0) ───
 *   URL:      wss://<hub>/websocket?token=<bearer>&vsn=2.0.0
 *   Frame:    JSON array [join_ref, ref, topic, event, payload]
 *   Join:     [jref, ref, topic, "phx_join", payload]
 *   Reply:    [jref, ref, topic, "phx_reply", { status, response }]
 *   Heartbeat:[null, ref, "phoenix", "heartbeat", {}]  (every 30s)
 *   Server →  [null, null, topic, "<event>", payload]  (new_message/typing/read)
 *   Presence: "presence_state" (full snapshot) + "presence_diff" (joins/leaves)
 *
 * Patterns intentionally mirror services/websocket.js so this is a drop-in
 * later: full-jitter reconnect backoff, rejoin-on-reconnect, on()/off() that
 * return an unsubscribe fn, and a globalThis-pinned singleton so web
 * code-splitting can't produce two sockets on one bearer.
 *
 * Public API (see bottom of file for the exact wiring that would flip it on):
 *   connect(bearer, hubUrl)   → open the socket (idempotent-ish; re-auths)
 *   joinChannel(topic, handlers) → join a topic; returns a channel handle
 *   on(event, cb)             → global listener across all channels; unsub fn
 *   disconnect()              → close + stop all timers, no auto-reconnect
 */

import { Platform, AppState } from 'react-native';
import { PHOENIX_HUB_URL } from './flags';

// Heartbeat cadence. Phoenix's server default idle timeout is 60s; 30s keeps
// the socket + any NAT mapping alive with margin. (The legacy WS pings far
// more aggressively at 5s because it also doubles as an iOS zombie-socket
// detector; Phoenix has its own server-side liveness, so 30s is enough for
// the prep phase — tighten later if shadow-testing shows mobile NAT drops.)
const HEARTBEAT_INTERVAL = 30000;

// Full-jitter reconnect backoff, same shape as websocket.js: fast lane for the
// first few flaps (transient carrier handoff / server reload heals invisibly),
// then exponential up to a 3s ceiling so the user never waits long.
const RECONNECT_BASE = 500;
const RECONNECT_MAX = 3000;
const FAST_ATTEMPTS = 4;

// Phoenix reply statuses.
const CHANNEL_JOINING = 'joining';
const CHANNEL_JOINED = 'joined';
const CHANNEL_ERRORED = 'errored';
const CHANNEL_CLOSED = 'closed';

class PhoenixChannel {
  constructor(socket, topic, params) {
    this.socket = socket;
    this.topic = topic;
    this.params = params || {};
    this.joinRef = null;      // stable across the channel's lifetime once joined
    this.state = CHANNEL_CLOSED;
    // event -> Set<cb>. Per-channel handlers registered via joinChannel(...).
    this._bindings = new Map();
    // Presence tracking: key -> { metas: [...] }. Built from presence_state,
    // mutated by presence_diff. Read via getPresences().
    this._presence = {};
  }

  _bind(event, cb) {
    if (typeof cb !== 'function') return;
    if (!this._bindings.has(event)) this._bindings.set(event, new Set());
    this._bindings.get(event).add(cb);
  }

  _dispatch(event, payload, ref) {
    // Presence bookkeeping first so handlers see up-to-date state.
    if (event === 'presence_state') {
      this._presence = { ...(payload || {}) };
    } else if (event === 'presence_diff') {
      this._applyPresenceDiff(payload || {});
    }
    const cbs = this._bindings.get(event);
    if (cbs) cbs.forEach((cb) => { try { cb(payload, ref, this); } catch {} });
    // Fan out to the socket-level global listeners too (on()).
    try { this.socket._emit(event, payload, this.topic); } catch {}
  }

  // Merge a Phoenix presence_diff ({ joins: {}, leaves: {} }) into the map.
  _applyPresenceDiff(diff) {
    const joins = diff.joins || {};
    const leaves = diff.leaves || {};
    for (const key of Object.keys(leaves)) {
      const leftMetas = (leaves[key] && leaves[key].metas) || [];
      const cur = this._presence[key];
      if (!cur) continue;
      const leftRefs = new Set(leftMetas.map((m) => m && m.phx_ref));
      const remaining = (cur.metas || []).filter((m) => !leftRefs.has(m && m.phx_ref));
      if (remaining.length > 0) this._presence[key] = { ...cur, metas: remaining };
      else delete this._presence[key];
    }
    for (const key of Object.keys(joins)) {
      const joinMetas = (joins[key] && joins[key].metas) || [];
      const cur = this._presence[key];
      if (!cur) this._presence[key] = { metas: joinMetas.slice() };
      else {
        const seen = new Set((cur.metas || []).map((m) => m && m.phx_ref));
        const merged = (cur.metas || []).concat(joinMetas.filter((m) => !seen.has(m && m.phx_ref)));
        this._presence[key] = { ...cur, metas: merged };
      }
    }
  }

  /** Snapshot of the presence map for this channel. */
  getPresences() { return this._presence; }

  /** List of present keys (e.g. user ids / emails). */
  presenceList() { return Object.keys(this._presence); }

  // Send a phx_join for this channel. Called on first join AND on every
  // socket reconnect (rejoin). Uses a fresh outer ref but keeps a stable
  // joinRef for the channel's lifetime (Phoenix keys pushes by join_ref).
  _sendJoin() {
    if (!this.socket._isOpen()) return;
    this.state = CHANNEL_JOINING;
    if (this.joinRef == null) this.joinRef = this.socket._makeRef();
    const ref = this.socket._makeRef();
    // Track this ref so the phx_reply flips us to joined/errored.
    this.socket._trackReply(ref, (status) => {
      this.state = status === 'ok' ? CHANNEL_JOINED : CHANNEL_ERRORED;
    });
    this.socket._pushRaw(this.joinRef, ref, this.topic, 'phx_join', this.params);
  }

  /** Push an event to this channel's server-side process. */
  push(event, payload) {
    const ref = this.socket._makeRef();
    this.socket._pushRaw(this.joinRef, ref, this.topic, event, payload || {});
    return ref;
  }

  /** Leave the channel (phx_leave) and drop local state. */
  leave() {
    if (this.socket._isOpen() && this.state === CHANNEL_JOINED) {
      const ref = this.socket._makeRef();
      this.socket._pushRaw(this.joinRef, ref, this.topic, 'phx_leave', {});
    }
    this.state = CHANNEL_CLOSED;
    this.socket._channels.delete(this.topic);
  }
}

class PhoenixSocket {
  constructor() {
    this.ws = null;
    this.bearer = null;
    this.hubUrl = null;
    this.connected = false;
    // `authenticated` mirrors websocket.js so consumers that read the mailWs
    // contract (SyncBar's `mailWs?.authenticated`, the 'authenticated'
    // connection status) behave identically if phoenixClient ever stands in for
    // the WS directly. Phoenix validates the bearer at the socket HANDSHAKE
    // (UserSocket.connect) — an invalid token is refused before onopen fires —
    // so a socket that successfully OPENS is, by definition, authenticated.
    this.authenticated = false;
    this.destroyed = false;
    this._hidden = false;             // backgrounded tab / app (pauses heartbeat + reconnect)
    this._refCounter = 0;
    this._heartbeatTimer = null;
    this._pendingHeartbeatRef = null; // set when a heartbeat is outstanding
    this._reconnectTimer = null;
    this._reconnectAttempt = 0;
    this._fgWatchdog = null;          // foreground zombie-probe watchdog timer
    this._channels = new Map();        // topic -> PhoenixChannel
    this._replyHandlers = new Map();   // ref -> cb(status, response)
    this._listeners = new Map();       // event -> Set<cb> (global, cross-channel)
    this._appStateHandler = null;
    this._visibilityHandler = null;

    // Native: foreground/background lifecycle. Mirrors websocket.js —
    //   • 'inactive'  (shade pull / control-center / system dialog) → IGNORE,
    //     treating it as background tore the socket down every few seconds.
    //   • 'background' → pause heartbeat + reconnect (iOS suspends the socket).
    //   • 'active'     → zombie-probe (iOS keeps readyState OPEN for a socket
    //     the radio already killed) and reconnect if dead.
    if (Platform.OS !== 'web') {
      try {
        this._appStateHandler = AppState.addEventListener('change', (next) => {
          if (next === 'inactive') return;
          if (next === 'background') {
            this._hidden = true;
            this._stopHeartbeat();
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
            if (this._fgWatchdog) { clearTimeout(this._fgWatchdog); this._fgWatchdog = null; }
            return;
          }
          if (next === 'active' && this.bearer && !this.destroyed) {
            this._hidden = false;
            this._foregroundProbe();
          }
        });
      } catch {}
    } else if (typeof document !== 'undefined') {
      // Web: a backgrounded tab can be frozen by the browser with the socket
      // silently dead but readyState still OPEN. Pause heartbeat while hidden
      // and probe on return to visible (same reasoning as websocket.js).
      try {
        this._visibilityHandler = () => {
          if (document.hidden) {
            this._hidden = true;
            this._stopHeartbeat();
            clearTimeout(this._reconnectTimer);
            this._reconnectTimer = null;
          } else {
            this._hidden = false;
            if (this.bearer && !this.destroyed) this._foregroundProbe();
          }
        };
        document.addEventListener('visibilitychange', this._visibilityHandler);
      } catch {}
    }
  }

  // Foreground/visibility zombie-socket probe. On return to foreground we send
  // a heartbeat immediately and, if its reply never lands within the watchdog
  // window, force a clean reconnect. Without this an iOS zombie socket (or a
  // frozen browser tab) leaves a new chat event invisible until the 30s
  // heartbeat catches it — the "só aparece quando saio e volto" symptom.
  _foregroundProbe() {
    if (this.destroyed || !this.bearer) return;
    if (!this._isOpen()) {
      // Socket already dead → reconnect now (fast lane).
      this._reconnectAttempt = 0;
      this.connect(this.bearer, this.hubUrl);
      return;
    }
    // Socket claims OPEN — probe it with a heartbeat and watch for the reply.
    const ref = this._makeRef();
    this._pendingHeartbeatRef = ref;
    this._pushRaw(null, ref, 'phoenix', 'heartbeat', {});
    if (this._fgWatchdog) clearTimeout(this._fgWatchdog);
    this._fgWatchdog = setTimeout(() => {
      this._fgWatchdog = null;
      if (this.destroyed || this._hidden) return;
      // _handleFrame clears _pendingHeartbeatRef on the reply. Still pending →
      // the socket is a zombie; close it so onclose drives _scheduleReconnect.
      if (this._pendingHeartbeatRef === ref) {
        this._reconnectAttempt = 0;
        try { if (this.ws) this.ws.close(); } catch {}
        // Belt-and-suspenders: if the socket was already detached, reconnect.
        if (!this._isOpen() && !this.destroyed) this.connect(this.bearer, this.hubUrl);
      }
    }, 5000);
  }

  _makeRef() { this._refCounter += 1; return String(this._refCounter); }

  _isOpen() {
    return !!this.ws && typeof WebSocket !== 'undefined' && this.ws.readyState === WebSocket.OPEN;
  }

  _trackReply(ref, cb) { if (ref != null) this._replyHandlers.set(String(ref), cb); }

  /**
   * Open (or re-open) the socket. `bearer` is the user's auth token, passed as
   * the `token` query param (the hub validates it server-side). `hubUrl`
   * defaults to PHOENIX_HUB_URL from flags.js. Safe to call again to re-auth
   * with a fresh bearer — it tears down the old socket first.
   */
  connect(bearer, hubUrl) {
    if (this.destroyed) this.destroyed = false; // an explicit connect lifts a prior disconnect()
    const prevBearer = this.bearer;
    if (bearer) this.bearer = bearer;
    this.hubUrl = hubUrl || this.hubUrl || PHOENIX_HUB_URL;
    if (!this.bearer) { try { console.warn('[Phoenix] connect() without bearer — ignored'); } catch {} return; }

    // Idempotent: a socket already OPEN/CONNECTING on the SAME bearer is kept
    // (mirrors websocket.js connect()). The adapter calls connect() again on
    // every sliding-token refresh for the same account; without this guard each
    // call would needlessly drop + reopen the socket — a visible real-time beat
    // and a redundant auth RTT. A changed bearer (slide/account switch) falls
    // through to the teardown + re-auth below.
    try {
      if (this.ws && typeof WebSocket !== 'undefined' &&
          (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN) &&
          this.bearer === prevBearer) {
        if (this.connected && !this._heartbeatTimer) this._startHeartbeat();
        return;
      }
    } catch {}

    this._cleanupSocket();

    // Phoenix endpoint: <hubUrl>/websocket?token=<bearer>&vsn=2.0.0
    const base = this.hubUrl.replace(/\/+$/, '');
    const url = base + '/websocket?token=' + encodeURIComponent(this.bearer) + '&vsn=2.0.0';

    try {
      this.ws = new WebSocket(url);
    } catch (err) {
      this._scheduleReconnect();
      return;
    }

    this.ws.onopen = () => {
      this.connected = true;
      // Socket opened ⇒ the hub accepted the bearer (see `authenticated` note
      // in the constructor). Emit BOTH 'connected' and 'authenticated' so the
      // status contract is byte-identical to websocket.js, whose SyncBar
      // consumer hides the bar on either and reads `.authenticated`.
      this.authenticated = true;
      this._hidden = false;
      this._reconnectAttempt = 0;
      this._emit('connection', { status: 'connected' });
      this._emit('connection', { status: 'authenticated' });
      this._startHeartbeat();
      // Rejoin every channel we had (join is what authorizes topic access).
      for (const ch of this._channels.values()) {
        try { ch._sendJoin(); } catch {}
      }
    };

    this.ws.onmessage = (event) => {
      let frame;
      try { frame = JSON.parse(event.data); } catch { return; }
      if (!Array.isArray(frame)) return;
      this._handleFrame(frame);
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.authenticated = false;
      this._stopHeartbeat();
      this._emit('connection', { status: 'disconnected' });
      if (!this.destroyed) this._scheduleReconnect();
    };

    this.ws.onerror = () => { /* onclose fires next; reconnect handled there */ };
  }

  // [join_ref, ref, topic, event, payload]
  _handleFrame(frame) {
    const [joinRef, ref, topic, event, payload] = frame;

    // Heartbeat reply on the "phoenix" topic — clear the outstanding marker.
    if (topic === 'phoenix' && event === 'phx_reply') {
      if (ref != null && String(ref) === String(this._pendingHeartbeatRef)) {
        this._pendingHeartbeatRef = null;
      }
      return;
    }

    // Generic reply → resolve any tracked ref handler (e.g. join ok/error).
    if (event === 'phx_reply') {
      const handler = ref != null ? this._replyHandlers.get(String(ref)) : null;
      const status = payload && payload.status;
      if (handler) {
        try { handler(status, payload && payload.response); } catch {}
        this._replyHandlers.delete(String(ref));
      }
      // Still surface join replies to the channel so its state updates even if
      // no explicit handler ran.
      const ch = this._channels.get(topic);
      if (ch) ch._dispatch(event, payload, ref);
      return;
    }

    // Server-initiated channel event (new_message / typing / read /
    // presence_state / presence_diff / phx_close / phx_error).
    const ch = this._channels.get(topic);
    if (ch) {
      if (event === 'phx_error' || event === 'phx_close') {
        ch.state = CHANNEL_ERRORED;
        // Rejoin errored channels while the socket is still open (server may
        // have restarted the channel process).
        if (event === 'phx_error' && this._isOpen()) {
          try { ch._sendJoin(); } catch {}
        }
      }
      ch._dispatch(event, payload, ref);
    } else {
      // No channel bound (e.g. a broadcast on a topic we left) — still fan out
      // to global listeners.
      this._emit(event, payload, topic);
    }
  }

  _pushRaw(joinRef, ref, topic, event, payload) {
    if (!this._isOpen()) return false;
    try {
      this.ws.send(JSON.stringify([joinRef, ref, topic, event, payload]));
      return true;
    } catch { return false; }
  }

  /**
   * Join a topic. `handlers` is an optional map of event name → callback, e.g.
   *   joinChannel('room:42', {
   *     new_message: (m) => {...},
   *     typing: (t) => {...},
   *     presence_state: (s) => {...},
   *   })
   * Returns the PhoenixChannel handle (push/leave/getPresences). Idempotent
   * per topic — re-joining an existing topic just adds the new handlers.
   */
  joinChannel(topic, handlers, params) {
    let ch = this._channels.get(topic);
    if (!ch) {
      ch = new PhoenixChannel(this, topic, params);
      this._channels.set(topic, ch);
    }
    if (handlers && typeof handlers === 'object') {
      for (const ev of Object.keys(handlers)) ch._bind(ev, handlers[ev]);
    }
    // Send join now if the socket is up; otherwise onopen will rejoin it.
    if (this._isOpen()) ch._sendJoin();
    return ch;
  }

  /**
   * Register a GLOBAL listener fired for any channel event of `event` name
   * across all joined topics (payload, topic) — mirrors websocket.js on().
   * Returns an unsubscribe function.
   */
  on(event, cb) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(cb);
    return () => this.off(event, cb);
  }

  off(event, cb) {
    const set = this._listeners.get(event);
    if (set) set.delete(cb);
  }

  _emit(event, data, topic) {
    const set = this._listeners.get(event);
    if (set) set.forEach((cb) => { try { cb(data, topic); } catch {} });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this._heartbeatTimer = setInterval(() => {
      if (!this._isOpen()) return;
      // If the previous heartbeat never got a reply, the socket is dead —
      // force a reconnect instead of piling on more heartbeats.
      if (this._pendingHeartbeatRef != null) {
        try { this.ws.close(); } catch {}
        return; // onclose → _scheduleReconnect
      }
      const ref = this._makeRef();
      this._pendingHeartbeatRef = ref;
      this._pushRaw(null, ref, 'phoenix', 'heartbeat', {});
    }, HEARTBEAT_INTERVAL);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); this._heartbeatTimer = null; }
    this._pendingHeartbeatRef = null;
  }

  // Full-jitter backoff, fast lane for the first few attempts — copied shape
  // from websocket.js so reconnect feel is identical.
  _scheduleReconnect() {
    // Don't reconnect while backgrounded/hidden — the AppState/visibility
    // 'active' handler probes + reconnects on return (mirrors websocket.js,
    // which also bails here on this._hidden).
    if (this.destroyed || this._hidden) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      // Wait for connectivity; don't burn retries offline. Surface the same
      // 'offline' connection status websocket.js emits so a consumer can show
      // "Sem internet" instead of a spinning "Reconectando…".
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
      this._emit('connection', { status: 'offline', attempt: this._reconnectAttempt });
      if (typeof window !== 'undefined' && !this._onlineListenerAdded) {
        this._onlineListenerAdded = true;
        const onOnline = () => {
          this._onlineListenerAdded = false;
          this._reconnectAttempt = 0;
          if (this.bearer && !this.destroyed) this.connect(this.bearer, this.hubUrl);
        };
        try { window.addEventListener('online', onOnline, { once: true }); } catch {}
      }
      return;
    }
    let cap;
    if (this._reconnectAttempt < FAST_ATTEMPTS) {
      cap = Math.min(RECONNECT_BASE * (this._reconnectAttempt + 1), 2400);
    } else {
      cap = Math.min(RECONNECT_BASE * Math.pow(2, Math.min(this._reconnectAttempt, 5)), RECONNECT_MAX);
    }
    const delay = Math.max(RECONNECT_BASE, Math.floor(Math.random() * cap));
    this._reconnectAttempt += 1;
    this._emit('connection', { status: 'reconnecting', attempt: this._reconnectAttempt, nextRetryMs: delay });
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = setTimeout(() => {
      if (this.bearer && !this.destroyed) this.connect(this.bearer, this.hubUrl);
    }, delay);
  }

  _cleanupSocket() {
    clearTimeout(this._reconnectTimer);
    this._reconnectTimer = null;
    if (this._fgWatchdog) { clearTimeout(this._fgWatchdog); this._fgWatchdog = null; }
    this._stopHeartbeat();
    if (this.ws) {
      try { this.ws.onopen = null; } catch {}
      try { this.ws.onmessage = null; } catch {}
      try { this.ws.onclose = null; } catch {}
      try { this.ws.onerror = null; } catch {}
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
  }

  /** Close everything and stop auto-reconnect. connect() revives it. */
  disconnect() {
    this.destroyed = true;
    // Best-effort leave of joined channels so the server frees them promptly.
    for (const ch of this._channels.values()) {
      try { ch.leave(); } catch {}
    }
    this._channels.clear();
    this._replyHandlers.clear();
    this._cleanupSocket();
    if (this._appStateHandler) { try { this._appStateHandler.remove(); } catch {} this._appStateHandler = null; }
    if (this._visibilityHandler && typeof document !== 'undefined') {
      try { document.removeEventListener('visibilitychange', this._visibilityHandler); } catch {}
    }
    this._emit('connection', { status: 'disconnected' });
  }

  /**
   * API-parity with websocket.js reset(): lift a prior disconnect() tombstone so
   * connect() works again (logout→login, account switch). `fullWipe` also clears
   * global listeners + channel handles so a previous account's handlers can't
   * fire on the next account. The phoenixAdapter does NOT call this — it drives
   * the transport with disconnect()/connect() and owns its own listener unsubs.
   * It exists only so phoenixClient can stand in for the mailWs API directly if
   * a future full cutover points call sites here instead of at the adapter.
   */
  reset(fullWipe = false) {
    this.destroyed = false;
    this._reconnectAttempt = 0;
    if (fullWipe) {
      try { this._listeners.forEach((set) => set.clear()); } catch {}
      try { this._channels.clear(); } catch {}
      this.bearer = null;
    }
  }

  /**
   * API-parity with websocket.js isZombie(): true when the socket SHOULD be live
   * but isn't. MailContext's 10s watchdog calls mailWs.isZombie()+resurrect();
   * provided so a direct cutover keeps that self-heal working. resurrect() maps
   * to a fast reconnect here (Phoenix has no separate auth frame to replay).
   */
  isZombie() {
    if (this.destroyed) return true;
    if (!this._isOpen()) return true;
    if (!this.authenticated) return true;
    return false;
  }

  resurrect(/* reason */) {
    if (this.isConnected && this.authenticated && !this.destroyed) return false;
    if (!this.bearer) return false;
    this.destroyed = false;
    this._reconnectAttempt = 0;
    this.connect(this.bearer, this.hubUrl);
    return true;
  }

  get isConnected() { return this.connected && this._isOpen(); }
}

// Singleton pinned on globalThis — same reasoning as websocket.js: web
// code-splitting can emit this module into two chunks, and two sockets on one
// bearer would fight. One instance, shared.
const phoenixClient =
  globalThis.__chatyy_phoenixClient || (globalThis.__chatyy_phoenixClient = new PhoenixSocket());

export default phoenixClient;
export { PhoenixSocket, PhoenixChannel };

/*
 * ─── SELF-TEST / how this gets wired in later (DO NOT enable yet) ───
 *
 * While USE_PHOENIX_HUB is false, nothing below runs. When we're ready to
 * shadow-test (or cut over), the wiring is ~3 lines next to where the legacy
 * WS is started (e.g. context/MailContext.js's WS effect, using the same
 * bearer it already passes to mailWs.connect):
 *
 *     import { isPhoenixHubEnabled } from '../services/flags';
 *     import phoenixClient from '../services/phoenixClient';
 *
 *     if (isPhoenixHubEnabled()) {
 *       phoenixClient.connect(getAuthToken());            // bearer via ?token=
 *       phoenixClient.joinChannel('user:' + userId, {     // per-user topic
 *         new_message: (m) => wsBus.emit('chat_message', m),
 *         typing:      (t) => wsBus.emit('typing', t),
 *         read:        (r) => wsBus.emit('message_read', r),
 *         presence_state: (s) => {}, presence_diff: (d) => {},
 *       });
 *     }
 *
 * To flip it on at runtime without a rebuild:  setPhoenixHubEnabled(true)
 * (from services/flags.js), then call phoenixClient.connect(bearer).
 *
 * Teardown on logout/account-switch:  phoenixClient.disconnect();
 */
