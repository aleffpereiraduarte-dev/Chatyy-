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

const RECONNECT_BASE = 1000;     // Start with 1s delay for faster recovery
const RECONNECT_MAX = 30000;     // Max 30s between retries (was 60s)
const PING_INTERVAL = 25000;
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
        } else if (nextState === 'background') {
          this._hidden = true;
          this._stopPing();
          clearTimeout(this.reconnectTimer);
        }
      });
    }
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
      this.connected = false;
      this.authenticated = false;
      this._stopPing();

      // Code 4002 = session replaced by newer login (WhatsApp behavior).
      // Do NOT reconnect — it would evict the new session in an infinite loop.
      if (event.code === 4002) {
        this._emit('connection', { status: 'session_replaced', message: event.reason });
        return; // Stop here. User must manually re-open or the other session takes over.
      }

      this._emit('connection', { status: 'disconnected' });
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

  // Reset destroyed flag so connect() works again after logout/login cycle
  reset() {
    this.destroyed = false;
    this.reconnectAttempt = 0;
    this._reconnectCount = 0;
    this._droppedCount = 0;
    this._seenMsgIds.clear();
    this._seenMsgIdQueue = [];
    // Do NOT clear listeners here -- other components register listeners
    // independently and their useEffect may run before or after this reset
  }

  _cleanup() {
    clearTimeout(this.reconnectTimer);
    this._stopPing();
    // Clear typing stop timers
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
      // No pong in 2 ping intervals = dead socket
      if (this.lastPongTime && (Date.now() - this.lastPongTime) > PING_INTERVAL * 2) {
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
    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s max
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, Math.min(this.reconnectAttempt, 5)), RECONNECT_MAX);
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

  // Track a message ID for deduplication (ring buffer of 500)
  _trackMsgId(id) {
    if (!id || this._seenMsgIds.has(id)) return false; // duplicate
    this._seenMsgIds.add(id);
    this._seenMsgIdQueue.push(id);
    // Evict oldest if over limit
    if (this._seenMsgIdQueue.length > 500) {
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
        this.userId = msg.user_id || msg.account_id;
        this.email = msg.email;
        // Calculate server time offset for clock sync
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
          try {
            const { getAuthToken } = require('./api');
            const freshToken = getAuthToken();
            if (freshToken && freshToken !== this.token) {
              this.token = freshToken;
            }
          } catch {}
          this._scheduleReconnect();
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

      case 'session_replaced':
        // Another device/tab opened — this session is being kicked.
        // Mark destroyed to prevent any reconnect attempts.
        this.destroyed = true;
        this._emit('connection', { status: 'session_replaced', message: msg.message });
        break;

      // Chat message deduplication
      case 'chat_message': {
        const chatMsg = msg.data || msg;
        const msgId = chatMsg?.message?.id || chatMsg?.id;
        if (msgId && !this._trackMsgId(msgId)) {
          return; // Duplicate, skip
        }
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
