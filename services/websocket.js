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
const RECONNECT_MAX = 10000;    // [2026-10-06 rock-solid] 3s→10s cap. Foreground/network-up/user actions
                                // bypass the backoff entirely (ensureConnected urgent), so the cap only
                                // governs SUSTAINED outages — 3s meant ~175 handshakes per 5-min outage
                                // per device (harness), burning battery and hammering the hub on recovery.
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
// [2026-10-06 rock-solid heartbeat] Cadência por contexto (ver _heartbeatProfile):
//   • idle (lista/fg sem thread): ping 20s. O hub já manda ping de protocolo a
//     cada 25s (writer PingPeriod) e o cliente auto-responde → o NAT da operadora
//     nunca fica >25s ocioso; o ping de app a 5s mantinha o rádio LTE/5G
//     permanentemente em estado "connected" (tail ~10s) = bateria, sem ganho de NAT.
//   • thread aberta: ping 5s (detecção rápida onde o usuário percebe).
//   • chamada: ping 8s.
// Detecção half-open: cada ping arma um deadline; se NENHUM frame chegar (pong
// ou qualquer outro) até o deadline → socket morto → reconecta. Pior caso idle
// = 20s+10s, thread = 5s+6s.
const PING_IDLE_MS = 20000;
const PING_CHAT_MS = 5000;
const PING_CALL_MS = 8000;
const PONG_DEADLINE_IDLE_MS = 10000;
const PONG_DEADLINE_CHAT_MS = 6000;
const PONG_DEADLINE_CALL_MS = 10000;
// Probe ao voltar do background / troca de rede: 1 ping, reconecta só se nada
// chegar nesse prazo (não reconecta às cegas).
const FG_PROBE_MS = 2500;
// Socket preso em CONNECTING (handshake TCP/TLS que nunca completa — ex.: aberto
// durante a queda de rede) não pode bloquear a recuperação até o timeout do SO
// (~60s no iOS). Passou disso → descarta e reabre.
const CONNECT_TIMEOUT_MS = 10000;
// Identidade desta INSTÂNCIA de JS (processo do app / aba do browser). Vai no
// frame de auth; o hub fecha sockets mais antigos com o MESMO instance_id
// (fantasmas cujo close nunca chegou porque o rádio já tinha morrido) assim que
// o novo autentica, em vez de esperar 90s de PongWait. Por instância, não por
// aparelho: duas abas / app + native CallSignalWs NÃO se derrubam.
const WS_INSTANCE_ID = (() => {
  try {
    const r = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return 'js-' + r.slice(0, 20);
  } catch { return 'js-' + String(Date.now()); }
})();
// [2026-10-05 conectando-preso] Client-side auth watchdog. A socket can reach
// OPEN and keep answering pings (so the zombie detector never trips, since
// the server pongs pre-auth too) yet never receive auth_success — e.g. the
// auth frame or its reply was lost on a flaky link. Without a client guard the
// socket sits connected-but-unauthenticated until the server's 30s AuthTimeout
// closes it, which the user sees as a ~30s "Conectando". If we don't get
// auth_success within this window, tear down and reconnect fast. Comfortably
// above a worst-case handshake RTT (auth lands in ~167ms in prod) so a healthy
// slow link never false-positives.
const AUTH_WATCHDOG_MS = 6000;
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
// [2026-10-05 typing-flicker] Auto-stop backstop MUST be strictly greater than
// TYPING_DEBOUNCE. When the two were equal (both 3000), the per-conversation
// auto-stop timer fired at the exact 3s boundary where the next throttled
// `typing` frame is due — so a continuously-typing user emitted a spurious
// `stopped_typing` right before each re-send, flickering the peer's
// "digitando…" off-then-on. At 2x the debounce the periodic re-send always
// re-arms this timer before it can fire, so it only ever triggers after the
// user has genuinely paused (and acts purely as a safety net — the primary
// stop is the explicit sendStoppedTyping the UI fires 3s after the last
// keystroke / on send / on background).
const TYPING_STOP_DELAY = 6000; // Auto-stop backstop: 2x debounce (was 3000 — raced the re-send)
// [2026-10-06 rt-client] Typing agora é SÓ via WS (o POST chat_typing a cada 3 s
// foi removido do cliente). O gate de privacidade que vivia no PHP (chat_typing:
// read_receipts=off / last_seen='nobody' / online='nobody' → não fan-out) passa a
// ser aplicado AQUI, antes de emitir o frame — o hub Go só gateia presença no
// fan-out per-user e NÃO gateia o canal da thread nem read_receipts. Espelho
// persistido POR CONTA (sem vazar entre contas) pra valer desde a 1ª tecla.
const WS_TYPING_PRIVACY_KEY = 'ws_typing_privacy_v1:';
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
    this._authWatchdog = null;    // [2026-10-05] timer: force reconnect if auth_success never arrives
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
    // [2026-10-06 rt-client] { email, read_receipts, last_seen, online } | null
    // (null = ainda não hidratado → permite, igual ao comportamento WS anterior).
    this._typingPrivacy = null;

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
          // [2026-10-06 rock-solid] Single entry point. Aba voltando: socket
          // autenticado → só PROBE (1 ping, reconecta só se nada chegar em 3s;
          // Chrome congela abas ocultas e o readyState mente OPEN). Morto →
          // reconecta já (urgente = pula o backoff). Em voo → não mexe.
          try { this.ensureConnected('visible', { probe: true, urgent: true, probeMs: 3000 }); } catch {}
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
        if (!state) return;
        // [2026-10-06 rock-solid] Rede caiu: só anota. Não queima tentativas
        // de reconexão contra uma interface morta (_scheduleReconnect passa a
        // usar o teto enquanto offline) e marca o instante pra saber, na volta,
        // que qualquer socket CONNECTING foi aberto às cegas.
        if (state.isConnected === false) {
          if (!this._netOffline) { this._netOffline = true; this._netOfflineAt = Date.now(); }
          this._lastNetType = state.type;
          return;
        }
        const cameBack = !!this._netOffline;
        this._netOffline = false;
        const typeChanged = !!(this._lastNetType && state.type && state.type !== this._lastNetType);
        this._lastNetType = state.type;
        if (this.destroyed || !this.token) return;
        if (cameBack) {
          // Rede voltou → reconexão RÁPIDA com jitter curto (0-400ms) pra frota
          // não bater no hub em lockstep depois de uma queda compartilhada.
          // Socket que estava "em voo" foi aberto durante a queda → descarta.
          try { this.ensureConnected('net_up', { urgent: true, probe: true, probeMs: 2000, jitterMs: 400, staleBefore: this._netOfflineAt || 0 }); } catch {}
        } else if (typeChanged) {
          // [2026-10-05 handoff] wifi↔celular: o socket costuma ficar HALF-OPEN
          // (readyState OPEN, pacotes no vácuo). PROBE (não reconexão cega):
          // flap do NetInfo num socket saudável custa 1 ping.
          try { this.ensureConnected('net_change', { urgent: true, probe: true, probeMs: 2000 }); } catch {}
        } else {
          // Evento sem mudança real (iOS dispara bastante): só garante que há
          // um socket — sem probe, sem matar nada em voo.
          try { this.ensureConnected('net_event'); } catch {}
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
          if (this._loggedOut) return; // deslogado: nada a reconectar
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
          // [2026-10-06 rock-solid] Foreground: socket vivo-segundo-o-readyState
          // → PING IMEDIATO e só reconecta se nada chegar em ~2.5s (iOS devolve
          // OPEN pra socket que o rádio já matou). Morto → reconecta na hora,
          // pulando o backoff. Em voo → deixa terminar. Nunca reconexão cega.
          try { this.ensureConnected('foreground', { probe: true, urgent: true, probeMs: FG_PROBE_MS }); } catch {}
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
          this._cancelProbe();
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

  // [2026-10-01 instant-open] Eager bootstrap connect — WhatsApp-tier cold
  // open. The WS singleton is created at module import, but the legacy flow
  // only calls connect() from MailContext's effect, which fires AFTER the JS
  // bundle evals → React mounts → AuthContext finishes its async
  // SecureStore/AsyncStorage hydrate → user.email is set. That chain serialized
  // the very first socket open BEHIND React hydration, so the user stared at
  // "Conectando…" for the whole handshake + hydrate window.
  //
  // api.js hydrates the bearer into memory at ITS import (web: synchronous;
  // native: a short async SecureStore read) — independently of React. So the
  // token is usually signable within a few hundred ms of process start, well
  // before AuthContext/MailContext mount. We poll api.getAuthToken() on a tight
  // bounded loop and kick connect() the instant a token exists, opening the
  // socket IN PARALLEL with hydration instead of after it. By the time the UI
  // (SyncBar) mounts, the socket is typically already authenticated, so the
  // "Conectando…" bar never paints.
  //
  // Safety:
  //   • No token (logged out / fresh install) → never connects. Pure no-op.
  //   • The later MailContext connect() with the same token is absorbed by the
  //     idempotency guard in connect() (keeps this eager socket).
  //   • A stale/expired stored token just takes the normal auth_error → refresh
  //     path; multi-account + orphan-bearer self-heal are untouched (we read the
  //     active account's token from api, exactly like MailContext does).
  //   • Runs at most once per process (_eagerBootstrapStarted).
  _eagerBootstrapConnect() {
    if (this._eagerBootstrapStarted) return;
    this._eagerBootstrapStarted = true;
    const MAX_TRIES = 40;      // ~2.4s ceiling (native hydrate lands long before)
    const STEP_MS = 60;
    const tryConnect = (triesLeft) => {
      if (this.destroyed) return;
      // Someone (MailContext) already drove a connect, or a socket is live —
      // nothing to bootstrap.
      if (this.ws || this.connected) return;
      if (this._authReloginStopped) return;
      let token = '';
      try { token = require('./api').getAuthToken?.() || ''; } catch {}
      if (token && typeof token === 'string') {
        try { this.connect(token); } catch {}
        return;
      }
      if (triesLeft > 0) {
        setTimeout(() => tryConnect(triesLeft - 1), STEP_MS);
      }
    };
    // Defer one tick so the singleton + listeners settle, then poll.
    try { setTimeout(() => tryConnect(MAX_TRIES), 0); } catch {}
  }

  // ─── [2026-10-06 rock-solid] Single owner / idempotent entry point ───────
  //
  // TODO caminho que quer "um socket funcionando" passa por aqui: MailContext
  // (login/troca de conta), AppState foreground, visibilidade (web), NetInfo,
  // resurrect() (watchdogs de tela), ensureHealthy() (chamadas, lista, thread).
  // Ninguém fora deste arquivo chama _cleanup()/connect() direto.
  //
  // Regras (a ordem importa):
  //   1. Autenticado → saudável. Com `probe`, manda 1 ping e só reconecta se
  //      NENHUM frame chegar em probeMs (half-open). Nunca reconexão cega.
  //   2. Em voo (CONNECTING < CONNECT_TIMEOUT_MS, ou OPEN aguardando
  //      auth_success < AUTH_WATCHDOG_MS+2s) → NÃO mexe. Matar handshake em
  //      curso era a causa do churn "abre→fecha em <1s" (hub: 735 sockets/dia
  //      fechados antes do auth; harness: link lento + watchdog 1.5s da lista
  //      = 21 sockets em 30s e NUNCA autentica). Exceção: `staleBefore`
  //      (socket aberto enquanto a rede estava fora) ou `force`.
  //   3. Reconexão já agendada (backoff) → `urgent` antecipa pra agora
  //      (+jitter); não-urgente respeita o backoff (watchdogs de 1.5s/2.5s não
  //      podem transformar o backoff em loop de 1.5s).
  //   4. Senão → connect().
  // Retorna: 'healthy' | 'probing' | 'in_flight' | 'scheduled' | 'connecting' | 'no_token' | 'stopped'
  ensureConnected(reason = 'unknown', opts = {}) {
    const { probe = false, urgent = false, force = false, probeMs = FG_PROBE_MS, jitterMs = 0, staleBefore = 0 } = opts || {};
    let token = null;
    try { token = require('./api').getAuthToken?.() || null; } catch {}
    // Depois de logout (disconnect) só um token VIVO no api.js reabre — nunca
    // o bearer antigo que ficou em this.token.
    if (!token && !this._loggedOut) token = this.token;
    if (!token) return 'no_token';
    this._loggedOut = false;
    if (this._authReloginStopped) {
      // Só um token NOVO (re-login real) levanta o circuit-breaker.
      if (token !== this.token) {
        this._authReloginStopped = false;
        this._authRejectStreak = 0;
        this._authRejectBackoff = 0;
      } else {
        return 'stopped';
      }
    }
    if (this.destroyed) {
      // destroyed = tombstone (session_replaced / auth streak) ou disconnect()
      // de logout. Com token vivo no api.js estamos logados → revive.
      this.destroyed = false;
      this._authFailStreak = 0;
      this._authErrorBackoff = 0;
    }
    this._logGhost?.('ensure', { reason, probe, urgent, force });
    const OPEN = (typeof WebSocket !== 'undefined' && WebSocket.OPEN) || 1;
    const CONNECTING = (typeof WebSocket !== 'undefined' ? WebSocket.CONNECTING : 0) || 0;
    const ws = this.ws;
    const age = this._lastConnectAt ? (Date.now() - this._lastConnectAt) : Infinity;

    if (!force && ws && ws.readyState === OPEN && this.authenticated) {
      if (token !== this.token) this.token = token; // slide: próximo reconnect usa o fresco
      if (!this.pingTimer && !this._hidden) this._startPing();
      if (probe) { this._probe(reason, probeMs); return 'probing'; }
      return 'healthy';
    }
    const openedBeforeOutage = !!(staleBefore && this._lastConnectAt && this._lastConnectAt <= staleBefore);
    if (!force && !openedBeforeOutage && ws) {
      if (ws.readyState === CONNECTING && age < CONNECT_TIMEOUT_MS) return 'in_flight';
      if (ws.readyState === OPEN && !this.authenticated && age < (AUTH_WATCHDOG_MS + 2000)) return 'in_flight';
    }
    if (!force && !ws && this.reconnectTimer) {
      if (!urgent) return 'scheduled';
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Vai abrir um socket novo.
    this.reconnectAttempt = 0;
    this._lastConnectAt = 0; // libera o coalesce do connect()
    if (ws) { try { this._cleanup(); } catch {} }
    this.token = token;
    const go = () => {
      this.reconnectTimer = null;
      if (this.destroyed || this._authReloginStopped) return;
      // Alguém abriu nesse meio tempo (jitter) → não duplica.
      if (this.ws && (this.ws.readyState === OPEN || this.ws.readyState === CONNECTING)) return;
      this.connect(this.token || token);
    };
    if (jitterMs > 0) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(go, Math.floor(Math.random() * jitterMs));
    } else {
      go();
    }
    return 'connecting';
  }

  // Probe de liveness: 1 ping; se NENHUM frame chegar em `ms`, o socket é
  // half-open → descarta e reconecta. Coalesce: um probe por vez.
  _probe(reason, ms = FG_PROBE_MS) {
    if (this._probeTimer) return;
    const ws = this.ws;
    if (!ws) return;
    const sentAt = Date.now();
    this._pingTs = sentAt;
    try { this._send({ type: 'ping', ts: sentAt }); } catch {}
    this._probeTimer = setTimeout(() => {
      this._probeTimer = null;
      if (this.destroyed || this._hidden) return;
      if (this.ws !== ws) return; // já trocou de socket
      // Timer estrangulado (JS suspenso / aba congelada): veredito inválido.
      if (Date.now() - sentAt > ms * 3 + 2000) return;
      if ((this.lastInboundAt || 0) >= sentAt || (this.lastPongTime || 0) >= sentAt) return;
      try { console.warn('[WS] probe (' + reason + ') sem resposta em ' + ms + 'ms — socket half-open, reconectando'); } catch {}
      this._logGhost?.('probe_dead', { reason });
      this._droppedCount++;
      this.ensureConnected('probe_dead_' + reason, { force: true });
    }, ms);
  }

  _cancelProbe() {
    if (this._probeTimer) { clearTimeout(this._probeTimer); this._probeTimer = null; }
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

    // [2026-10-01 instant-open] Idempotent connect. A socket may already be
    // in flight for THIS exact token — most importantly the eager bootstrap
    // socket we open at module load (see _eagerBootstrapConnect), which races
    // ahead of React/AuthContext hydration. The legacy path unconditionally
    // `_cleanup()`+reopened here, which would throw that eager socket away
    // (and its in-progress auth) and re-pay the full connect RTT — exactly the
    // "Conectando…" flash on open we're killing. If we already have a
    // CONNECTING/OPEN socket on the same token, keep it and just make sure the
    // heartbeat is running. Only reconnect when the token changed (slide /
    // account switch) or the socket is actually dead. `this.token` still holds
    // the previous (eager) token at this point since we assign liveToken below;
    // both come from api.getAuthToken(), so they match on a clean cold start.
    try {
      if (this.ws && !this.destroyed && this.token === liveToken &&
          typeof WebSocket !== 'undefined' &&
          (this.ws.readyState === WebSocket.CONNECTING || this.ws.readyState === WebSocket.OPEN)) {
        if (this.connected && this.authenticated && !this.pingTimer) this._startPing();
        return;
      }
      // [2026-10-06 rock-solid] Socket JÁ autenticado + token diferente = slide
      // do bearer (mesma conta). NÃO derruba um socket saudável por isso — o
      // token novo vale no próximo reconnect. Troca de CONTA passa por
      // ensureConnected(..., { force: true }) (MailContext), que limpa antes.
      // Era o "socket fechado 100-900ms após o auth a cada reload" (eager
      // bootstrap abre com T1, hidratação desliza pra T2, MailContext chama
      // connect(T2) → _cleanup no socket recém-autenticado).
      if (this.ws && !this.destroyed && typeof WebSocket !== 'undefined' &&
          this.ws.readyState === WebSocket.OPEN && this.authenticated) {
        this.token = liveToken;
        if (!this.pingTimer && !this._hidden) this._startPing();
        return;
      }
      // Idem pro OPEN aguardando auth_success: o auth já foi com o token
      // anterior (ainda válido); o auth watchdog cobre se ele falhar.
      if (this.ws && typeof WebSocket !== 'undefined' &&
          this.ws.readyState === WebSocket.OPEN && !this.authenticated &&
          this._lastConnectAt && (Date.now() - this._lastConnectAt) < (AUTH_WATCHDOG_MS + 2000)) {
        return;
      }
      // [2026-10-05 churn 1005] Handshake em curso (<3s) NÃO é morto nem por
      // token diferente — o auth usa o token já enviado; se for rejeitado, o
      // path de auth_error faz refresh+reconnect. Evita o "abre→mata→abre"
      // visto no hub (3 sockets do mesmo aparelho fechando 1005 no segundo
      // em que abriram, depois 2 duplicados sobrevivendo).
      if (this.ws && typeof WebSocket !== 'undefined' &&
          this.ws.readyState === WebSocket.CONNECTING &&
          this._lastConnectAt && (Date.now() - this._lastConnectAt) < CONNECT_TIMEOUT_MS) {
        return;
      }
      // [2026-10-02 churn fix] Burst coalesce. Multiple reconnect triggers
      // (AppState 'active' + NetInfo 'online' + resurrect + scheduleReconnect +
      // MailContext effect) fire within the same ~second, and because each one
      // _cleanup()s the previous socket (nulling this.ws) BEFORE this guard can
      // see it, the readyState check above misses them — so every trigger
      // opened a FRESH socket. Prod WS log: the same device opened 4 sockets in
      // one second and 44% of ALL sockets died in <15s (open → immediately
      // superseded/closed). If a connect for this SAME token was initiated
      // <1.2s ago, coalesce this redundant call. onclose/onerror reset
      // _lastConnectAt=0, so a REAL failure still reconnects immediately (no
      // stall), and a token change (account switch / slide) skips the coalesce.
      if (this._lastConnectAt && this.token === liveToken &&
          (Date.now() - this._lastConnectAt) < 1200) {
        return;
      }
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
      // [2026-10-02 churn fix] Stamp the moment we open a socket so the burst-
      // coalesce guard above can absorb the other reconnect triggers that fire
      // in the same ~second. Reset to 0 in onclose/onerror so a genuine failure
      // reconnects immediately.
      this._lastConnectAt = Date.now();
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

    // [2026-10-06 rock-solid] Connect timeout: handshake que não completa em
    // CONNECT_TIMEOUT_MS (TCP/TLS no vácuo — típico de socket aberto durante a
    // queda de rede ou troca de antena) é descartado e reaberto com backoff, em
    // vez de prender a recuperação até o timeout do SO (~60s no iOS).
    {
      const _thisWs = this.ws;
      clearTimeout(this._connectTimer);
      this._connectTimer = setTimeout(() => {
        this._connectTimer = null;
        if (this.ws !== _thisWs || this.destroyed) return;
        if (typeof WebSocket !== 'undefined' && _thisWs.readyState === WebSocket.CONNECTING) {
          try { console.warn('[WS] connect timeout (' + CONNECT_TIMEOUT_MS + 'ms) — reabrindo'); } catch {}
          this._logGhost?.('connect_timeout', {});
          this._cleanup();
          this._lastConnectAt = 0;
          this._scheduleReconnect();
        }
      }, CONNECT_TIMEOUT_MS);
    }

    this.ws.onopen = () => {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
      this.connected = true;
      this.reconnectAttempt = 0;
      this.lastInboundAt = Date.now();
      // Detect which subprotocol the server selected. `ws.protocol` is the
      // selected one from the list we advertised (or '' / 'json.legacy'
      // for JSON-only servers). CWP-negotiated sockets serialize the auth
      // frame as binary; everything else stays on JSON text.
      try {
        const proto = (this.ws && this.ws.protocol) ? String(this.ws.protocol) : '';
        this.cwpNegotiated = (proto === 'cwp.1');
      } catch { this.cwpNegotiated = false; }
      this._emit('connection', { status: 'connected', protocol: this.cwpNegotiated ? 'cwp.1' : 'json' });

      // Authenticate with bearer token.
      // [2026-10-06 rock-solid] instance_id (por instância de JS) deixa o hub
      // derrubar FANTASMAS desta mesma instância (socket velho cujo close nunca
      // chegou porque o rádio morreu) assim que este autentica. device_id/
      // client/platform são só diagnóstico (forense por aparelho no log do hub).
      // Hub antigo ignora campos extras.
      let _devId = '';
      try { _devId = require('./crashReporter').getAnonIdSync?.() || ''; } catch {}
      this._send({
        type: 'auth',
        token: this.token,
        instance_id: WS_INSTANCE_ID,
        device_id: _devId,
        client: 'js',
        platform: Platform.OS,
      });

      // Start heartbeat
      this._startPing();

      // [2026-10-05 conectando-preso] Arm the auth watchdog. If auth_success
      // doesn't land within AUTH_WATCHDOG_MS, this socket is wedged
      // connected-but-unauthenticated (lost auth frame / reply). Tear it down
      // and reconnect fast instead of waiting out the server's 30s AuthTimeout.
      // Cleared on auth_success (and by _cleanup on any teardown).
      this._clearAuthWatchdog();
      this._authWatchdog = setTimeout(() => {
        this._authWatchdog = null;
        if (this.destroyed || this._authReloginStopped) return;
        if (this.authenticated) return;
        try { console.warn('[WS] auth watchdog: no auth_success in ' + AUTH_WATCHDOG_MS + 'ms — forcing reconnect'); } catch {}
        try { this._logGhost?.('auth_watchdog_timeout', {}); } catch {}
        this._cleanup();
        if (!this.destroyed) {
          // [2026-10-05] Só trata como "handshake perdido" (retry rápido) se
          // NÃO recebemos auth_error neste socket. Se o servidor REJEITOU o
          // token, zerar o backoff aqui criava loop infinito a cada ~7s:
          // connect → auth_error → (segura) → watchdog 6s → attempt=0 →
          // reconnect 2s → … (visto no hub: 1 IP, 290 reconexões/dia).
          const rejectedRecently = !!(this._lastAuthErrorAt && (Date.now() - this._lastAuthErrorAt) < (AUTH_WATCHDOG_MS + 2000));
          this.reconnectAttempt = rejectedRecently ? Math.max(this.reconnectAttempt, 4) : 0;
          this._scheduleReconnect();
        }
      }, AUTH_WATCHDOG_MS);

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
      // [2026-10-02 churn fix] The LIVE socket closed (orphaned burst sockets
      // have their handlers detached in _cleanup, so this only fires for the
      // real one). Clear the coalesce stamp so the scheduled reconnect is NOT
      // suppressed — a genuine drop must reconnect immediately.
      this._lastConnectAt = 0;

      // Diagnostic beacon so we can figure out WHY the socket keeps dropping
      // (iOS backgrounding, carrier flap, server-initiated close, etc.) without
      // having to reproduce under a debugger. Fire-and-forget, never blocks.
      // [2026-10-06] Was POSTing {kind,code,reason} to crash_report, whose
      // server handler only reads message/stack/component → 142 EMPTY lines
      // in crashes/*.log over 7 days (the single biggest "signature"). Route
      // through the per-device diag channel instead: it lands under the
      // device's anon id (correlates with boot/crash beacons), is rate-limited
      // client+server side, and keeps crashes/*.log for real crashes.
      if (wasAuthenticated) {
        try {
          const { getAuthToken } = require('./api');
          if (getAuthToken?.()) {
            require('./crashReporter').reportStep?.(
              'ws_close',
              `code=${closeCode} reason=${String(closeReason || '').slice(0, 60)} reconnects=${this._reconnectCount}`,
            );
          }
        } catch {}
      }

      if (closeCode === 4002) {
        this._emit('connection', { status: 'session_replaced', message: closeReason });
        return;
      }
      // [2026-10-06 rock-solid] 4009 = hub fechou este socket porque a MESMA
      // instância autenticou um mais novo. Socket órfão já tem handlers
      // soltos (_cleanup) e nem chega aqui; se chegar (corrida), reconecta com
      // backoff (nunca em loop apertado).
      if (closeCode === 4009) {
        this.reconnectAttempt = Math.max(this.reconnectAttempt, 3);
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
    // [2026-10-06 rock-solid] AppState/NetInfo listeners NÃO são mais removidos
    // aqui. O MailWebSocket é singleton (globalThis) — não existe "instância
    // órfã" pra vazar — e removê-los no logout fazia o próximo login da MESMA
    // sessão ficar sem reconexão no foreground e sem reação a troca de rede
    // (nada os re-registrava). Os handlers checam _loggedOut/destroyed/token.
    this._loggedOut = true;
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
      this._logGhost('resurrect_kick', { reason, attempt: this._resurrectAttempt });
      // [2026-10-06 rock-solid] Delegado ao dono único. ensureConnected NÃO
      // mata socket em voo (CONNECTING / aguardando auth) e respeita o backoff
      // salvo em caminhos urgentes (re-login/refresh de bearer/foreground) —
      // o watchdog de 2.5s da thread e o de 10s do MailContext podem chamar à
      // vontade sem gerar churn.
      const urgent = /^(authcontext|hydrate|appstate)/.test(String(reason || ''));
      const r = this.ensureConnected('resurrect_' + reason, { urgent });
      if (r === 'healthy' || r === 'probing') return false;
      if (r === 'stopped' || r === 'no_token') return false;
      if ((r === 'in_flight' || r === 'scheduled') && this._resurrectRetryTimer) return false;
      // Arm a backoff retry in case this never reaches authenticated.
      // _onAuthenticated clears it; otherwise next backoff tick re-tries.
      this._scheduleResurrectRetry(reason);
      return r === 'connecting';
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
    // [2026-10-06] Usa o último frame QUALQUER (não só pong) e o perfil atual
    // de heartbeat (idle pinga a cada 20s agora).
    const { interval, deadline } = this._heartbeatProfile();
    const last = Math.max(this.lastPongTime || 0, this.lastInboundAt || 0);
    if (last && (Date.now() - last) > (interval * 2 + deadline)) return true;
    return false;
  }

  _cleanup() {
    clearTimeout(this.reconnectTimer);
    this._stopPing();
    // [2026-07-03] Reset the resume gate on every teardown. It's set true when a
    // {type:'resume'} is sent and cleared only by a resume_* RESPONSE — so a
    // disconnect that races the ack (drop after send, before response) left it
    // stuck true, and every later _onAuthenticated skipped resume (`if
    // (!this._resumeInFlight)`), silently disabling WS catch-up replay for the
    // rest of the session. Resume is idempotent (server dedups by event_id).
    this._resumeInFlight = false;
    // Cancel the foreground zombie-check watchdog if it was armed —
    // _cleanup is also called when the watchdog itself decides to
    // force-reconnect, in which case we're inside the timer callback
    // and the handle is already null. Either way, drop the reference.
    if (this._fgWatchdog) {
      clearTimeout(this._fgWatchdog);
      this._fgWatchdog = null;
    }
    // [2026-10-05] Drop the auth watchdog on any teardown so it can't fire a
    // phantom reconnect against an already-reconnecting flow.
    this._clearAuthWatchdog();
    // [2026-10-06 rock-solid] idem connect-timeout + probe pendentes.
    if (this._connectTimer) { clearTimeout(this._connectTimer); this._connectTimer = null; }
    this._cancelProbe();
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
    // ─── Phoenix parallel transport (flag-gated, ADDITIVE) ───
    // When USE_PHOENIX_HUB is ON and the adapter claims this frame (chat/call/
    // presence/typing/receipt signaling), it is pushed over the Phoenix hub
    // INSTEAD of the Go WS and we return early. Go-WS protocol frames
    // (ping/auth/ack/resume/subscribe/…) are never claimed, so the Go WS stays
    // fully functional for email real-time + liveness. When the flag is OFF,
    // isPhoenixHubEnabled() short-circuits and this block is a no-op — the path
    // below is byte-for-byte unchanged.
    try {
      const { isPhoenixHubEnabled } = require('./flags');
      if (isPhoenixHubEnabled()) {
        const pa = require('./phoenixAdapter');
        if (pa && typeof pa.phoenixOutbound === 'function' && pa.phoenixOutbound(data)) {
          return;
        }
      }
    } catch {}
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

  // [2026-10-06 rock-solid] Perfil de heartbeat por contexto (ver constantes).
  _heartbeatProfile() {
    if (this._callActive) return { interval: PING_CALL_MS, deadline: PONG_DEADLINE_CALL_MS };
    if (this._chatActive) return { interval: PING_CHAT_MS, deadline: PONG_DEADLINE_CHAT_MS };
    return { interval: PING_IDLE_MS, deadline: PONG_DEADLINE_IDLE_MS };
  }

  _startPing() {
    this._stopPing();
    // [2026-10-06 rock-solid] Heartbeat + detecção half-open.
    //   • ping a cada `interval` (idle 20s / thread 5s / chamada 8s);
    //   • cada ping arma UM deadline; se nenhum frame (pong OU qualquer
    //     outro — tráfego real também prova vida) chegar até lá → socket
    //     half-open → força reconexão. Antes: ping fixo a 5s em idle (rádio
    //     nunca dormia) e veredito só no tick seguinte.
    //   • timer estrangulado (aba oculta 1x/min, JS congelado no iOS): o
    //     veredito é inválido → re-baseline e julga no próximo ciclo
    //     (fix "falso-zumbi 60s" de 2026-10-05 preservado).
    const { interval, deadline } = this._heartbeatProfile();
    const tick = () => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        // Socket morreu sem onclose (ou onclose já agendou reconexão).
        if (!this.reconnectTimer && !this.destroyed) {
          this._droppedCount++;
          this.ensureConnected('ping_tick_dead');
        }
        return;
      }
      const prev = this._lastTickAt || 0;
      const t = Date.now();
      this._lastTickAt = t;
      if (prev && (t - prev) > (interval * 2 + 1000)) {
        // Timer atrasado = JS esteve suspenso; não condena o socket por isso.
        this.lastPongTime = t;
        this.lastInboundAt = Math.max(this.lastInboundAt || 0, t);
      }
      const sentAt = t;
      this._pingTs = sentAt;
      try { this._send({ type: 'ping', ts: sentAt }); } catch {}
      // Um deadline POR ping (thread: interval 5s < deadline 6s → até 2
      // simultâneos), senão a morte logo após um pong só seria julgada um
      // ciclo depois.
      const ws = this.ws;
      if (!this._pongDeadlines) this._pongDeadlines = new Set();
      const dl = setTimeout(() => {
        try { this._pongDeadlines && this._pongDeadlines.delete(dl); } catch {}
        if (this.ws !== ws || this.destroyed || this._hidden) return;
        const late = Date.now() - sentAt;
        if (late > deadline + interval * 2 + 1000) return; // timer estrangulado
        if ((this.lastInboundAt || 0) >= sentAt || (this.lastPongTime || 0) >= sentAt) return;
        try { console.warn('[WS] sem frame ' + deadline + 'ms após ping — half-open, reconectando'); } catch {}
        this._logGhost?.('pong_deadline', { interval, deadline });
        this._droppedCount++;
        this.ensureConnected('pong_deadline', { force: true });
      }, deadline);
      this._pongDeadlines.add(dl);
    };
    this._lastTickAt = Date.now();
    this.pingTimer = setInterval(tick, interval);
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
      // [2026-10-06 rock-solid] Caminho de chamada (IncomingCallListener):
      // urgente, mas NUNCA mata um socket saudável ou em voo.
      if (this.isConnected && this.authenticated) return false;
      const r = this.ensureConnected('ensureHealthy_token', { urgent: true });
      return r === 'connecting';
    }
    // Original async health-check path (timeoutMs, defaults to 1500).
    return this._ensureHealthyPing(typeof arg === 'number' ? arg : 1500);
  }

  async _ensureHealthyPing(timeoutMs = 1500) {
    // [2026-10-06 rock-solid] Antes: socket não-autenticado → _cleanup()+connect()
    // INCONDICIONAL. Chamado a cada 1.5s pelo heal-watchdog da lista e a cada 3s
    // pela thread enquanto !isConnected, isso matava o handshake em curso: em
    // link lento (handshake >1.5s, ex. Europa→US) o socket NUNCA autenticava
    // (hub: sockets "()" fechando normal ~0.75s após abrir, 1/s; harness: 21
    // sockets em 30s, 0 auth). Agora passa pelo dono único (não-urgente: não
    // mata voo nem fura o backoff) e só espera.
    if (this.destroyed && !this.token) return false;
    const waitAuthed = (ms) => new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (this.isConnected) return resolve(true);
        if (Date.now() - start >= ms) return resolve(false);
        setTimeout(check, 100);
      };
      check();
    });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated) {
      this.ensureConnected('ensureHealthy');
      return waitAuthed(timeoutMs);
    }
    // Socket diz que está vivo — confirma com ping (iOS mente OPEN). Qualquer
    // frame que chegar depois do ping conta como vida, não só o pong.
    const probeMs = Math.max(1500, Math.min(timeoutMs, 2500));
    return await new Promise((resolve) => {
      const sentAt = Date.now();
      this._pingTs = sentAt;
      try { this._send({ type: 'ping', ts: sentAt }); } catch {}
      let sub = null;
      const watchdog = setTimeout(() => {
        try { sub && sub(); } catch {}
        if ((this.lastPongTime || 0) >= sentAt || (this.lastInboundAt || 0) >= sentAt) return resolve(true);
        this.ensureConnected('ensureHealthy_probe_dead', { force: true });
        waitAuthed(timeoutMs).then(resolve);
      }, probeMs);
      sub = this.on('pong', () => {
        clearTimeout(watchdog);
        try { sub(); } catch {}
        resolve(true);
      });
    });
  }

  _stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this._pongDeadlines && this._pongDeadlines.size) {
      for (const t of this._pongDeadlines) { try { clearTimeout(t); } catch {} }
      this._pongDeadlines.clear();
    }
  }

  // [2026-10-05] Cancel the connected-but-unauthenticated watchdog armed in
  // onopen. Safe to call unconditionally.
  _clearAuthWatchdog() {
    if (this._authWatchdog) {
      clearTimeout(this._authWatchdog);
      this._authWatchdog = null;
    }
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
    // [2026-10-05 WhatsApp-tier start] The FIRST retry is near-instant so a
    // transient drop (carrier handoff, AP roam, brief server reload — the
    // overwhelming majority of drops) heals before the user perceives
    // anything. The old ladder forced a flat RECONNECT_BASE (500ms) floor on
    // EVERY attempt including the first, adding ~500ms of dead air to the
    // common case. We now fire attempt 0 immediately and only space out once a
    // retry has actually failed: 0 → ~250ms → ~500ms → ~1s → exponential to
    // RECONNECT_MAX (3s). Safe because (a) onclose/ping-timeout already reset
    // reconnectAttempt=0 for genuine drops, (b) the 9s banner grace in
    // chat-conversation means these fast retries never paint "Reconectando",
    // and (c) the hub absorbs the load (memgate on HeapInuse, not per-connect).
    // [2026-10-06 rock-solid] 0 → ~300ms → ~1s → ~2s, depois exponencial com
    // jitter (equal-jitter: metade fixa + metade aleatória) até RECONNECT_MAX
    // (10s). Foreground / rede voltando / ação do usuário furam o backoff via
    // ensureConnected({urgent}). Rede sabidamente offline (NetInfo) → direto
    // no teto: não adianta martelar uma interface morta; a volta da rede
    // reconecta na hora.
    const EARLY_DELAYS = [0, 300, 1000, 2000];
    let delay;
    if (this._netOffline) {
      delay = RECONNECT_MAX + Math.floor(Math.random() * 2000);
    } else if (this.reconnectAttempt < EARLY_DELAYS.length) {
      delay = EARLY_DELAYS[this.reconnectAttempt] + Math.floor(Math.random() * 200);
    } else {
      const cap = Math.min(1000 * Math.pow(2, Math.min(this.reconnectAttempt - 2, 6)), RECONNECT_MAX);
      delay = Math.floor(cap / 2 + Math.random() * (cap / 2));
    }
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
        // [2026-10-05] Handshake completed — disarm the auth watchdog.
        this._clearAuthWatchdog();
        this._authFailStreak = 0;
        // [P0 2026-05-25] Any successful auth clears the storm guard: the
        // session is alive, so reset the refreshed-but-still-rejected streak,
        // its backoff, and lift the "needs re-login" hard-stop.
        this._authRejectStreak = 0;
        this._authRejectBackoff = 0;
        this._authReloginStopped = false;
        this._orphanHealTried = false;
        this.userId = msg.user_id || msg.account_id;
        this.email = msg.email;
        // [2026-10-06 rt-client] Hidrata o espelho de privacidade de typing da conta.
        try { this._hydrateTypingPrivacy(msg.email); } catch {}
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
        this._lastAuthErrorAt = Date.now();
        // [2026-10-05] Rejeição FATAL (servidor: token revogado / logged_out via
        // PG auth_tokens.revoked_at). Não adianta refresh nem reconectar com
        // este bearer — ele está morto em TODAS as regiões. Para o loop aqui,
        // entra no estado needs-relogin (circuit-breaker já existente) e avisa
        // o app pra mostrar o re-login. Antes o hub mandava só "Invalid or
        // expired token" genérico e o cliente ficava em loop ~7s pra sempre.
        if (msg.fatal === true || msg.reason === 'logged_out') {
          try { console.warn('[WS] auth_error FATAL (logged_out) — parando reconexão, pedindo re-login'); } catch {}
          this._cleanup();
          this._authReloginStopped = true;
          this._authRejectStreak = 0;
          this._authRejectBackoff = 0;
          this._emit('connection', { status: 'needs_relogin', reason: 'logged_out' });
          try {
            if (typeof globalThis !== 'undefined' && globalThis.dispatchEvent) globalThis.dispatchEvent(new Event('chatyy:authFailure'));
          } catch {}
          break;
        }
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
                  // [orphan-bearer auto-heal] check_auth disse que o bearer está
                  // morto (401): token purgado no servidor (token GC/órfão)
                  // enquanto um refresh_token válido ainda vive no storage.
                  // refreshAuthToken() só desliza um token VIVO — não ressuscita
                  // um purgado. Antes de cair no backoff de 300s (que faz loop
                  // eterno no mesmo bearer morto e prende o user em 'Conectando…'),
                  // faz UMA troca real que MINTA um bearer novo via /auth_refresh.
                  // Se vier um token diferente do que o servidor acabou de
                  // rejeitar, reconecta com ele na hora — app se auto-cura sem
                  // re-login.
                  if (typeof apiMod.forceBearerRefresh === 'function' && !this._orphanHealTried) {
                    this._orphanHealTried = true;
                    apiMod.forceBearerRefresh().then((minted) => {
                      if (this.destroyed) return;
                      const newTok = apiMod.getAuthToken?.();
                      if (minted && newTok && newTok !== this.token) {
                        try { console.warn('[WS] orphan bearer healed via /auth_refresh — reconnecting with fresh token'); } catch {}
                        this._orphanHealTried = false;
                        this._authRejectStreak = 0;
                        this._authRejectBackoff = 0;
                        this._authFailStreak = 0;
                        this._authErrorBackoff = 0;
                        this.token = newTok;
                        this.connect(newTok);
                        return;
                      }
                      // Mint falhou / refresh_token revogado → mantém o backoff lento.
                      this._authErrorBackoff = Math.min((this._authErrorBackoff || 30000) * 1.5, 300000);
                      setTimeout(() => { if (!this.destroyed) this.connect(this.token); }, this._authErrorBackoff);
                    }).catch(() => {
                      if (this.destroyed) return;
                      this._authErrorBackoff = Math.min((this._authErrorBackoff || 30000) * 1.5, 300000);
                      setTimeout(() => { if (!this.destroyed) this.connect(this.token); }, this._authErrorBackoff);
                    });
                    return;
                  }
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
                  // [orphan-bearer auto-heal] Antes de acionar o circuit-breaker
                  // e forçar re-login, tenta UMA troca real de refresh_token que
                  // minta um bearer NOVO via /auth_refresh (o check_auth do
                  // refreshAuthToken não cura bearer purgado). Se vier um token
                  // diferente do que o servidor insiste em rejeitar, reseta o
                  // storm e reconecta com ele.
                  if (typeof apiMod.forceBearerRefresh === 'function' && !this._orphanHealTried) {
                    this._orphanHealTried = true;
                    apiMod.forceBearerRefresh().then((minted) => {
                      if (this.destroyed) return;
                      const newTok = apiMod.getAuthToken?.();
                      if (minted && newTok && newTok !== this.token) {
                        try { console.warn('[WS] orphan bearer healed at storm-stop — reconnecting with fresh token'); } catch {}
                        this._orphanHealTried = false;
                        this._authRejectStreak = 0;
                        this._authRejectBackoff = 0;
                        this._authFailStreak = 0;
                        this.token = newTok;
                        this.connect(newTok);
                        return;
                      }
                      this._enterReloginStopped('ws_auth_reject_storm');
                    }).catch(() => { if (!this.destroyed) this._enterReloginStopped('ws_auth_reject_storm'); });
                    return;
                  }
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

      // [2026-10-06 rock-solid] Hub avisa que esta conexão foi substituída por
      // uma mais nova da MESMA instância (instance_id) e vai fechá-la (4009).
      // Nada a fazer: o socket atual já é o novo.
      case 'superseded':
        this._logGhost?.('superseded', {});
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
          // [FIX media-enrichment re-broadcast 2026-10-02] The server
          // re-broadcasts the SAME chat_message id a second time once it has
          // generated the media thumbnail / dimensions (thumb_b64 /
          // thumbnail_url / poster / width / height). Plain id-dedup dropped
          // that second frame, so the recipient kept a blank photo / black
          // video forever. Let a re-broadcast through ONLY when it carries one
          // of those enrichment fields (true duplicates are still dropped).
          const _enr = chatMsg?.message || chatMsg || {};
          const _hasEnrichment =
            _enr.thumb_b64 != null || _enr.thumbnail_url != null ||
            _enr.poster != null || _enr.width != null || _enr.height != null;
          if (!_hasEnrichment) {
            return; // Duplicate, skip
          }
          // fall through — delivered to listeners as a merge-update
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

      // Presence updates (online/offline). The C++ hub emits 'presence_update'
      // frames, but consumers (ChatListTab, chat-conversation) listen on the
      // 'presence' event — without this alias a live online/last_seen change
      // only surfaced via the slow presence poll, never in real time.
      case 'presence_update':
      case 'presence':
        this._emit('presence', msg);
        break;

      case 'presence_result':
        this._emit('presence_result', msg.presences || {});
        break;

      // [2026-10-06 rt-client] typing / stopped_typing chegam em DUAS formas:
      //   • frame do hub Go (fan-out direto, thread + per-user):
      //       { type, email, name, conversation_id: "123", recording, typing: bool }
      //   • evento PHP via /broadcast (legado chat_typing, ainda emitido por
      //     clientes antigos / web sem OTA):
      //       { type, data: { conversation_id: 123, email, name, typing, recording? } }
      // Normaliza pra UM shape plano e emite o evento interno certo pelo campo
      // `typing` (um frame `typing` com typing:false vira `stopped_typing`), pra a
      // LISTA (ChatListTab) e a THREAD verem exatamente o mesmo evento.
      case 'typing':
      case 'stopped_typing': {
        const d = (msg.data && typeof msg.data === 'object') ? msg.data : msg;
        const isTyping = msg.type === 'typing' && d.typing !== false;
        const flat = {
          conversation_id: d.conversation_id ?? msg.conversation_id,
          email: String(d.email || msg.email || '').toLowerCase(),
          name: d.name || msg.name || '',
          recording: isTyping && !!d.recording,
          typing: isTyping,
        };
        if (!flat.conversation_id) break;
        this._emit(isTyping ? 'typing' : 'stopped_typing', flat);
        break;
      }

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
          // [2026-10-05] Adota o high-water do servidor. Sem isto _lastEventId
          // ficava preso no valor velho e TODA reconexão repetia gap>cap →
          // full_sync (hub: gap=887 em cada auth do mesmo usuário) — sync
          // pesado a cada volta do 2º plano. O chat_sync HTTP que este evento
          // dispara (via 'foreground') já cobre os eventos pulados.
          if (typeof msg.current_event_id === 'number' && msg.current_event_id > this._lastEventId) {
            this._lastEventId = msg.current_event_id;
            this._persistLastEventId();
          }
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
    // ─── Phoenix parallel transport (flag-gated, ADDITIVE) ───
    // When USE_PHOENIX_HUB is ON, route the optimistic real-time relay over the
    // Phoenix hub instead of the Go WS. Durable delivery is unchanged (HTTP
    // chat_send). We still track our own message id so a Phoenix `new_message`
    // echo of it is de-duplicated. Resolves benignly for any awaiting caller.
    // Flag OFF → this block is skipped and the legacy relay below is unchanged.
    try {
      const { isPhoenixHubEnabled } = require('./flags');
      if (isPhoenixHubEnabled()) {
        const pa = require('./phoenixAdapter');
        if (pa && typeof pa.phoenixRelayChat === 'function' && pa.isPhoenixActive && pa.isPhoenixActive()) {
          // Only short-circuit the Go relay if the Phoenix push actually went
          // out (socket open). If not, fall through to the legacy relay below.
          const okViaPhoenix = pa.phoenixRelayChat(conversationId, message, tempId, memberEmails);
          if (okViaPhoenix) {
            try { if (message && message.id) this._trackMsgId(message.id); } catch {}
            return Promise.resolve({ viaPhoenix: true, msg_id: message && message.id });
          }
        }
      }
    } catch {}
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

  // [2026-10-06 rt-client] Privacidade de typing (paridade com o gate do PHP
  // chat_typing que o cliente deixou de chamar): não emite typing se a conta
  // desligou confirmações de leitura OU está invisível (last_seen/online='nobody').
  // Alimentado por chat_get_settings (thread/lista) e chat_privacy_get/_set
  // (tela de privacidade); persistido por e-mail em AsyncStorage.
  setTypingPrivacy(patch, email) {
    const em = String(email || this.email || '').toLowerCase();
    if (!em || !patch || typeof patch !== 'object') return;
    const cur = (this._typingPrivacy && this._typingPrivacy.email === em) ? this._typingPrivacy : { email: em };
    const next = { ...cur };
    if (Object.prototype.hasOwnProperty.call(patch, 'read_receipts') && patch.read_receipts !== undefined && patch.read_receipts !== null) {
      next.read_receipts = !!patch.read_receipts;
    }
    if (typeof patch.last_seen === 'string' && patch.last_seen) next.last_seen = patch.last_seen;
    if (typeof patch.online === 'string' && patch.online) next.online = patch.online;
    this._typingPrivacy = next;
    try { AsyncStorage.setItem(WS_TYPING_PRIVACY_KEY + em, JSON.stringify(next)).catch(() => {}); } catch {}
    // Privacidade acabou de fechar enquanto digitava → corta o indicador nos peers.
    if (!this.typingAllowed()) {
      try {
        for (const [convId, t] of this._typingStopTimers.entries()) {
          clearTimeout(t);
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this._send({ type: 'stopped_typing', conversation_id: convId });
          }
        }
      } catch {}
      this._typingStopTimers.clear();
      this._lastTypingSent.clear();
    }
  }

  typingAllowed() {
    const p = this._typingPrivacy;
    if (!p) return true; // não hidratado ainda — mesmo comportamento WS anterior
    if (this.email && p.email && p.email !== String(this.email).toLowerCase()) return true; // espelho de outra conta: ignora
    if (p.read_receipts === false) return false;
    if (p.last_seen === 'nobody' || p.online === 'nobody') return false;
    return true;
  }

  _hydrateTypingPrivacy(email) {
    const em = String(email || '').toLowerCase();
    if (!em) return;
    if (this._typingPrivacy && this._typingPrivacy.email === em) return;
    // Troca de conta: nunca herda o espelho da conta anterior.
    this._typingPrivacy = null;
    AsyncStorage.getItem(WS_TYPING_PRIVACY_KEY + em).then((raw) => {
      if (!raw) return;
      if (this._typingPrivacy && this._typingPrivacy.email === em) return; // já chegou do servidor
      if (String(this.email || '').toLowerCase() !== em) return;
      const v = JSON.parse(raw);
      if (v && typeof v === 'object') this._typingPrivacy = { ...v, email: em };
    }).catch(() => {});
  }

  // Send typing indicator (debounced: max once per 3s per conversation)
  sendTyping(conversationId, recording = false) {
    if (!this.isConnected) return;
    // [2026-10-06 rt-client] gate de privacidade (ver setTypingPrivacy).
    if (!this.typingAllowed()) return;
    const now = Date.now();

    // [2026-10-05 typing-flicker] (Re)arm the auto-stop backstop on EVERY
    // call, BEFORE the throttle early-return below. Previously this lived
    // AFTER the throttle guard, so a caller invoking sendTyping faster than
    // TYPING_DEBOUNCE kept the indicator's `typing` frame throttled (correct)
    // but never pushed the stop timer out — it kept firing TYPING_STOP_DELAY
    // after the FIRST frame and dropped the peer's "digitando…" mid-typing.
    // Arming it here keeps the indicator alive until the user actually pauses.
    // Cheap: one timer swap per call. Does NOT change the on-the-wire `typing`
    // cadence (still throttled below).
    const existing = this._typingStopTimers.get(conversationId);
    if (existing) clearTimeout(existing);
    this._typingStopTimers.set(conversationId, setTimeout(() => {
      this._send({ type: 'stopped_typing', conversation_id: conversationId });
      this._typingStopTimers.delete(conversationId);
      this._lastTypingSent.delete(conversationId);
    }, TYPING_STOP_DELAY));

    // Throttle ONLY the outbound `typing` frame — max once per TYPING_DEBOUNCE
    // per conversation — so continuous typing never floods the hub.
    const lastSent = this._lastTypingSent.get(conversationId) || 0;
    if (now - lastSent < TYPING_DEBOUNCE) return;
    this._lastTypingSent.set(conversationId, now);
    this._send({ type: 'typing', conversation_id: conversationId, recording });
  }

  // Explicitly stop typing (e.g., when message is sent)
  sendStoppedTyping(conversationId) {
    const timer = this._typingStopTimers.get(conversationId);
    if (timer) clearTimeout(timer);
    this._typingStopTimers.delete(conversationId);
    const hadTyping = this._lastTypingSent.delete(conversationId);
    // [2026-10-06 rt-client] Só emite stop se algum `typing` saiu pra essa
    // conversa nesta sessão — um stop órfão é fan-out inútil (e, com a
    // privacidade fechada, seria o único frame de atividade a vazar).
    if (this.isConnected && (hadTyping || timer)) {
      this._send({ type: 'stopped_typing', conversation_id: conversationId });
    }
  }

  // [2026-10-06 rt-client] Recibo de ENTREGA pelo socket. O hub persiste
  // ponta-a-ponta (handleDeliveryAck → PHP chat_delivery_ack com X-WS-Internal)
  // e NÃO responde com ack → sucesso do send em socket OPEN+autenticado+saudável
  // (pong fresco) é tratado como entregue; qualquer outro estado devolve false e
  // o chamador (api.js _ackWithRetry) cai no POST HTTP + outbox persistente.
  // NÃO passa por _send() porque este dropa frames fora da lista de enfileiráveis
  // quando o socket está fechado — aqui precisamos de um sim/não confiável.
  sendDeliveryAck(conversationId, messageIds) {
    if (!conversationId || !Array.isArray(messageIds) || messageIds.length === 0) return false;
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.authenticated || !this.isHealthy) return false;
    try {
      this.ws.send(this._encodeOutbound({
        type: 'delivery_ack',
        conversation_id: conversationId,
        message_ids: messageIds.slice(0, 100),
      }));
      return true;
    } catch {
      return false;
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
  sendMessageRead(conversationId, lastReadId, senderEmail) {
    if (!this.isConnected || !conversationId) return;
    const frame = {
      type: 'message_read',
      conversation_id: conversationId,
      message_ids: lastReadId ? [lastReadId] : [],
      last_read_id: lastReadId || 0,
    };
    // [2026-10-03] For 1:1 direct chats, name the message sender so the hub
    // can push the read receipt straight to the sender's per-user channel —
    // flips their ✓✓ blue instantly even when they're on the chat LIST (not
    // inside the thread). Omitted for groups (thread-channel fan-out covers
    // open viewers; PHP chat_read still fans to each member's user channel).
    if (senderEmail) frame.sender_email = senderEmail;
    this._send(frame);
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

// Singleton — pinned on globalThis so that if web code-splitting emits this
// module into two chunks (each with its own module registry), BOTH copies
// share ONE MailWebSocket instance. Without this, two instances each connect
// with the same bearer; the server enforces one session per bearer (close
// code 4002 = session_replaced), so they kill each other's socket in an
// endless "3 consecutive ACK fails → forcing resurrect" tug-of-war. Same
// idiom already used for globalThis.__chatyy_cwp_ws above.
const mailWs = globalThis.__chatyy_mailWs || (globalThis.__chatyy_mailWs = new MailWebSocket());

// [2026-10-01 instant-open] Kick the eager bootstrap connect the moment this
// module loads — in parallel with React/AuthContext hydration — so a cold open
// finds the socket already connected/authenticated instead of waiting on the
// MailContext effect. No-op when there's no stored token (logged out). Guarded
// so a double module-eval (web code-splitting) can't start it twice (the flag
// lives on the shared globalThis-pinned singleton).
try { mailWs._eagerBootstrapConnect(); } catch {}

export default mailWs;
