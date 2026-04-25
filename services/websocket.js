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

const RECONNECT_BASE = 500;      // 500ms first retry (Telegram-style fast recovery)
const RECONNECT_MAX = 30000;     // Max 30s between retries
// WhatsApp-tier liveness — was 25s/45s (Telegram production), but users
// complained messages "arrived late" because a silently-dead socket took up
// to 45s to be detected. Tighten to 12s ping / 18s timeout so a dead
// connection is replaced within ~18s. Battery cost is negligible (≤3 B/s).
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
      this._appStateHandler = AppState.addEventListener('change', (nextState) => {
        if (nextState === 'active') {
          this._hidden = false;
          // Check if WS is still alive
          if (this.ws && this.ws.readyState === WebSocket.OPEN && this.authenticated) {
            // Socket seems alive, send a ping to verify
            this._pingTs = Date.now();
            this._send({ type: 'ping', ts: this._pingTs });
            this._startPing();
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
    this.token = token;

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
      this._appStateHandler.remove();
      this._appStateHandler = null;
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
    for (const timer of this._typingStopTimers.values()) {
      clearTimeout(timer);
    }
    this._typingStopTimers.clear();
    if (this.ws) {
      try { this.ws.close(); } catch {}
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
      // No pong in PING_TIMEOUT = dead socket (Telegram-style aggressive).
      if (this.lastPongTime && (Date.now() - this.lastPongTime) > PING_TIMEOUT) {
        this._droppedCount++;
        this._cleanup();
        if (!this.destroyed) {
          this.reconnectAttempt = 0; // Reset backoff for fast reconnect
          this._scheduleReconnect();
        }
      }
    }, PING_INTERVAL);
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
        const onOnline = () => {
          this.reconnectAttempt = 0;
          if (this.token && !this.destroyed) this.connect(this.token);
        };
        window.addEventListener('online', onOnline, { once: true });
      }
      return;
    }
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max — plus 0-500ms
    // jitter so every client's retry lands at a different wall-clock time
    // and the server doesn't see a reconnect thundering-herd after a brief
    // outage.
    const base = Math.min(RECONNECT_BASE * Math.pow(2, Math.min(this.reconnectAttempt, 5)), RECONNECT_MAX);
    const delay = base + Math.floor(Math.random() * 500);
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
          try {
            const { getAuthToken } = require('./api');
            const freshToken = getAuthToken();
            if (freshToken && freshToken.length > 0) {
              hasToken = true;
              if (freshToken !== this.token) this.token = freshToken;
            }
          } catch {}
          if (hasToken) {
            this._authFailStreak = (this._authFailStreak || 0) + 1;
            // Two auth_errors in a row with the same token = token is dead.
            // Mirror the HTTP 401 path: dispatch chatyy:authFailure so
            // AuthContext logs the user out and redirects to /login instead
            // of letting WS spin forever.
            if (this._authFailStreak >= 2) {
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
        // Kick off a background download for any media attachment the
        // moment it arrives — by the time the user navigates into the
        // conv the file is already on disk and ExpoImage renders it
        // instantly instead of streaming from R2 at open time.
        try {
          const inner = chatMsg?.message || chatMsg;
          const url = inner?.file_url;
          const type = inner?.type;
          if (url && ['image', 'video', 'audio', 'voice', 'gif', 'sticker', 'file'].includes(type)) {
            const absolute = url.startsWith('http') ? url : `https://chatyy.com.br${url}`;
            const { cacheMedia } = require('./mediaCache');
            cacheMedia?.(absolute)?.catch?.(() => {});
          }
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
            if (typeof api.chatDeliveryAck === 'function') {
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

      default:
        // Prefetch media for chat_summary too (list-screen bump with
        // full payload when user is on the list, not in-thread). Without
        // this, opening a conv after receiving a new image triggers a
        // fresh R2 download at render time — noticeable flash on slow
        // networks.
        if (msg.type === 'chat_summary') {
          try {
            const inner = (msg.data && (msg.data.message || msg.data)) || msg;
            const url = inner?.file_url;
            const type = inner?.type;
            if (url && ['image', 'video', 'audio', 'voice', 'gif', 'sticker', 'file'].includes(type)) {
              const absolute = url.startsWith('http') ? url : `https://chatyy.com.br${url}`;
              const { cacheMedia } = require('./mediaCache');
              cacheMedia?.(absolute)?.catch?.(() => {});
            }
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
              if (typeof api.chatDeliveryAck === 'function') {
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

    // Replay queued messages (offline queue)
    const queued = this._messageQueue.splice(0);
    const pendingCount = queued.length + this._pendingOutgoing.size;
    if (pendingCount > 0) {
      this._emit('queue_flush', { count: pendingCount });
    }
    for (const msg of queued) {
      this._send(msg);
    }

    // Retry any pending outgoing messages that haven't been ACKed yet
    for (const [, entry] of this._pendingOutgoing) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(entry.data));
      }
    }

    // Emit a "reconnected / fully-authenticated" signal so chat screens can
    // trigger a catch-up chat_sync (identical to foreground). Without this
    // the conversation list + open thread stay stale after a reconnect that
    // happened while the app was already in the foreground (carrier flap).
    try { this._emit('foreground', { ts: Date.now(), source: 'reconnect' }); } catch {}
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
