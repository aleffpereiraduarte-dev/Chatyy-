/**
 * OneMundo Mail WebSocket Client
 * Real-time email notifications with auto-reconnect and polling fallback
 */
import { Platform } from 'react-native';

const WS_URL = Platform.OS === 'web'
  ? 'wss://mail.onemundo.com.br/ws'
  : 'wss://mail.onemundo.com.br/ws';

const RECONNECT_BASE = 1000;
const RECONNECT_MAX = 30000;
const PING_INTERVAL = 25000;

class MailWebSocket {
  constructor() {
    this.ws = null;
    this.token = null;
    this.userId = null;
    this.connected = false;
    this.authenticated = false;
    this.listeners = new Map();
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.destroyed = false;
    this._hidden = false;
    this.lastPongTime = 0;

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
            // Reconnect immediately when tab becomes visible
            this.reconnectAttempt = 0;
            this.connect(this.token);
          }
          this._emit('visibility', { visible: true });
        }
      };
      document.addEventListener('visibilitychange', this._visibilityHandler);
    }
  }

  connect(token) {
    if (this.destroyed) return;
    this.token = token;

    // Clean up existing connection
    this._cleanup();

    try {
      this.ws = new WebSocket(WS_URL);
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
        this._handleMessage(msg);
      } catch {}
    };

    this.ws.onclose = () => {
      this.connected = false;
      this.authenticated = false;
      this._stopPing();
      this._emit('connection', { status: 'disconnected' });
      if (!this.destroyed) this._scheduleReconnect();
    };

    this.ws.onerror = () => {
      // onclose will fire after this
    };
  }

  disconnect() {
    this.destroyed = true;
    this._cleanup();
    if (this._visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._visibilityHandler);
    }
    this._emit('connection', { status: 'disconnected' });
  }

  // Reset destroyed flag so connect() works again after logout/login cycle
  reset() {
    this.destroyed = false;
    this.reconnectAttempt = 0;
    this.listeners.clear();
  }

  _cleanup() {
    clearTimeout(this.reconnectTimer);
    this._stopPing();
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
    }
  }

  _startPing() {
    this._stopPing();
    this.pingTimer = setInterval(() => {
      this._send({ type: 'ping' });
    }, PING_INTERVAL);
  }

  _stopPing() {
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  _scheduleReconnect() {
    if (this.destroyed || this._hidden) return;
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, this.reconnectAttempt), RECONNECT_MAX);
    this.reconnectAttempt++;
    this.reconnectTimer = setTimeout(() => {
      if (this.token && !this.destroyed && !this._hidden) {
        this.connect(this.token);
      }
    }, delay);
  }

  _handleMessage(msg) {
    switch (msg.type) {
      case 'auth_success':
        this.authenticated = true;
        this.userId = msg.user_id || msg.account_id;
        this._emit('connection', { status: 'authenticated', userId: this.userId });
        break;

      case 'auth_error':
        this.authenticated = false;
        this._emit('connection', { status: 'auth_error', message: msg.message });
        // Disconnect on auth error — token may be expired
        this._cleanup();
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
        break;

      case 'welcome':
        break;

      default:
        this._emit(msg.type, msg.data || msg);
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

  get healthStatus() {
    if (this.authenticated) return this.isHealthy ? 'good' : 'warn';
    if (this.connected) return 'warn';
    return 'bad';
  }
}

// Singleton
const mailWs = new MailWebSocket();
export default mailWs;
