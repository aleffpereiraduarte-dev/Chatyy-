/**
 * Chatyy TCP Client
 * Connects to Signal Server (port 5222) via WebSocket/TCP
 * Binary protocol with automatic reconnect, message queueing, and deduplication
 *
 * API: Compatible with mqtt.js (EventEmitter interface)
 * - connect(email, token)
 * - subscribe(conversationId)
 * - send(type, payload)
 * - on(event, callback)
 * - disconnect()
 */

import { Platform, AppState } from 'react-native';
import { EventEmitter } from 'eventemitter3';

// Message types (must match Go server constants)
const MSG_TYPES = {
  AUTH: 0x01,
  AUTH_OK: 0x02,
  AUTH_FAIL: 0x03,
  PING: 0x10,
  PONG: 0x11,
  CHAT_SEND: 0x20,
  CHAT_MESSAGE: 0x21,
  CHAT_ACK: 0x22,
  CHAT_READ: 0x23,
  CHAT_READ_BROADCAST: 0x24,
  CHAT_REACT: 0x25,
  CHAT_REACT_BROADCAST: 0x26,
  CHAT_DELETE: 0x27,
  CHAT_DELETE_BROADCAST: 0x28,
  CHAT_EDIT: 0x29,
  CHAT_EDIT_BROADCAST: 0x2A,
  SUBSCRIBE: 0x30,
  UNSUBSCRIBE: 0x31,
  SUBSCRIBE_ACK: 0x32,
  STARTED_TYPING: 0x40,
  STOPPED_TYPING: 0x41,
  USER_TYPING: 0x42,
  USER_ONLINE: 0x43,
  USER_OFFLINE: 0x44,
  ERROR: 0xF0,
  DISCONNECT: 0xF1,
};

// Reverse lookup (type byte → string)
const TYPE_NAMES = Object.fromEntries(
  Object.entries(MSG_TYPES).map(([k, v]) => [v, k])
);

const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 60000;
const PING_TIMEOUT = 10000;
const AUTH_TIMEOUT = 10000;

/**
 * TCPClient - TCP Socket for Signal Server (port 5222)
 */
export class TCPClient extends EventEmitter {
  constructor() {
    super();
    this.ws = null;
    this.email = null;
    this.token = null;
    this.connected = false;
    this.authenticated = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.authTimer = null;
    this.subscriptions = new Set();
    this.pendingAcks = new Map(); // temp_id → resolve/reject
    this.offlineQueue = [];
    this.isOnline = Platform.OS === 'web'
      ? (typeof navigator !== 'undefined' && navigator.onLine)
      : true;
    this.decoder = new MessageDecoder();
    this._appStateHandler = null;
    this._lastPingTime = 0;
  }

  /**
   * Connect to Signal Server
   */
  async connect(email, token) {
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }

    this.email = email;
    this.token = token;

    // Determine server URL
    const port = 5222;
    const host = Platform.OS === 'web'
      ? (typeof window !== 'undefined' ? window.location.hostname : 'localhost')
      : 'chatyy.com.br';

    const wsURL = `wss://${host}:${port}`;

    log(`[tcp] Connecting to ${wsURL}...`);

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(wsURL);
        this.ws.binaryType = 'arraybuffer';

        const onOpenTimeout = setTimeout(() => {
          log('[tcp] Connection timeout');
          reject(new Error('Connection timeout'));
        }, 10000);

        this.ws.onopen = () => {
          clearTimeout(onOpenTimeout);
          log('[tcp] WebSocket connected');
          this.connected = true;
          this.emit('connection', { status: 'connected' });

          // Send AUTH
          this.sendFrame(MSG_TYPES.AUTH, {
            token,
            email,
            device_id: this._getDeviceId(),
            device_name: this._getDeviceName(),
          });

          // Wait for AUTH_OK or AUTH_FAIL
          const authTimeout = setTimeout(() => {
            log('[tcp] AUTH timeout');
            reject(new Error('AUTH timeout'));
          }, AUTH_TIMEOUT);

          const onAuth = (msg) => {
            clearTimeout(authTimeout);
            this.removeListener('auth_ok', onAuth);
            this.removeListener('auth_fail', onAuth);

            if (msg.type === 'auth_ok') {
              this.authenticated = true;
              this.reconnectAttempt = 0;
              this.startPing();
              log(`[tcp] Authenticated as ${email}`);
              resolve();
            } else {
              reject(new Error(msg.message || 'Auth failed'));
            }
          };

          this.once('auth_ok', onAuth);
          this.once('auth_fail', (msg) => onAuth({ type: 'auth_fail', message: msg.message }));
        };

        this.ws.onerror = (err) => {
          log(`[tcp] WebSocket error: ${err}`);
          this.emit('connection', { status: 'error', error: err });
          reject(err);
        };

        this.ws.onmessage = (event) => {
          try {
            const frame = new Uint8Array(event.data);
            const msg = this.decoder.decode(frame);
            if (msg) {
              this.handleMessage(msg);
            }
          } catch (err) {
            log(`[tcp] Decode error: ${err.message}`);
          }
        };

        this.ws.onclose = () => {
          log('[tcp] WebSocket closed');
          this.connected = false;
          this.authenticated = false;
          this.stopPing();
          this.emit('connection', { status: 'disconnected' });

          if (!this.destroyed) {
            this.reconnect();
          }
        };

        // Handle online/offline status
        if (Platform.OS === 'web') {
          window.addEventListener('online', () => {
            this.isOnline = true;
            if (!this.connected) this.reconnect();
          });
          window.addEventListener('offline', () => {
            this.isOnline = false;
          });
        }

        // Handle app state changes
        if (Platform.OS !== 'web') {
          if (this._appStateHandler) this._appStateHandler.remove();
          this._appStateHandler = AppState.addEventListener('change', (state) => {
            if (state === 'active' && !this.connected && this.isOnline) {
              this.reconnect();
            }
          });
        }
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Send a frame over TCP (binary protocol)
   */
  sendFrame(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log(`[tcp] Not connected, queueing message type ${TYPE_NAMES[type]}`);
      this.offlineQueue.push({ type, payload });
      return;
    }

    try {
      const frame = this.encoder.encode(type, payload);
      this.ws.send(frame);
    } catch (err) {
      log(`[tcp] Send error: ${err.message}`);
    }
  }

  /**
   * Subscribe to a conversation
   */
  subscribe(conversationId) {
    this.subscriptions.add(conversationId);
    if (this.authenticated) {
      this.sendFrame(MSG_TYPES.SUBSCRIBE, {
        conversation_ids: Array.from(this.subscriptions),
      });
    }
  }

  /**
   * Unsubscribe from a conversation
   */
  unsubscribe(conversationId) {
    this.subscriptions.delete(conversationId);
    if (this.authenticated) {
      this.sendFrame(MSG_TYPES.UNSUBSCRIBE, {
        conversation_ids: [conversationId],
      });
    }
  }

  /**
   * Send a message
   */
  async sendMessage(conversationId, content, type = 'text', options = {}) {
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const clientMsgId = this._genClientMsgId();

    return new Promise((resolve, reject) => {
      // Wait for ACK
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(tempId);
        reject(new Error('ACK timeout'));
      }, 5000);

      this.pendingAcks.set(tempId, { resolve, reject, timeout });

      this.sendFrame(MSG_TYPES.CHAT_SEND, {
        conversation_id: conversationId,
        content,
        type,
        temp_id: tempId,
        client_message_id: clientMsgId,
        reply_to_id: options.replyToId || null,
        mentions: options.mentions || [],
      });
    });
  }

  /**
   * Send read receipt
   */
  markAsRead(conversationId, messageId) {
    this.sendFrame(MSG_TYPES.CHAT_READ, {
      conversation_id: conversationId,
      message_id: messageId,
      ts: Date.now(),
    });
  }

  /**
   * Send reaction
   */
  react(messageId, emoji, action = 'add') {
    this.sendFrame(MSG_TYPES.CHAT_REACT, {
      message_id: messageId,
      emoji,
      action,
    });
  }

  /**
   * Send typing indicator
   */
  sendStartedTyping(conversationId) {
    this.sendFrame(MSG_TYPES.STARTED_TYPING, {
      conversation_id: conversationId,
    });
  }

  sendStoppedTyping(conversationId) {
    this.sendFrame(MSG_TYPES.STOPPED_TYPING, {
      conversation_id: conversationId,
    });
  }

  /**
   * Handle incoming message
   */
  handleMessage(msg) {
    const typeName = TYPE_NAMES[msg.type] || `UNKNOWN(0x${msg.type.toString(16)})`;
    log(`[tcp] Received ${typeName}`);

    switch (msg.type) {
      case MSG_TYPES.AUTH_OK:
        this.emit('auth_ok', msg.payload);
        break;

      case MSG_TYPES.AUTH_FAIL:
        this.emit('auth_fail', msg.payload);
        break;

      case MSG_TYPES.PING:
        // Respond with PONG
        this.sendFrame(MSG_TYPES.PONG, msg.payload);
        break;

      case MSG_TYPES.CHAT_MESSAGE:
        this.emit('chat_message', msg.payload);
        break;

      case MSG_TYPES.CHAT_ACK:
        // Resolve pending ACK
        const ack = this.pendingAcks.get(msg.payload.temp_id);
        if (ack) {
          clearTimeout(ack.timeout);
          this.pendingAcks.delete(msg.payload.temp_id);
          ack.resolve({
            id: msg.payload.server_message_id,
            tempId: msg.payload.temp_id,
          });
        }
        break;

      case MSG_TYPES.CHAT_READ_BROADCAST:
        this.emit('chat_read', msg.payload);
        break;

      case MSG_TYPES.CHAT_REACT_BROADCAST:
        this.emit('chat_react', msg.payload);
        break;

      case MSG_TYPES.CHAT_DELETE_BROADCAST:
        this.emit('chat_delete', msg.payload);
        break;

      case MSG_TYPES.CHAT_EDIT_BROADCAST:
        this.emit('chat_edit', msg.payload);
        break;

      case MSG_TYPES.USER_TYPING:
        this.emit('user_typing', msg.payload);
        break;

      case MSG_TYPES.USER_ONLINE:
        this.emit('user_online', msg.payload);
        break;

      case MSG_TYPES.USER_OFFLINE:
        this.emit('user_offline', msg.payload);
        break;

      case MSG_TYPES.SUBSCRIBE_ACK:
        log('[tcp] Subscriptions acknowledged');
        break;

      case MSG_TYPES.DISCONNECT:
        log(`[tcp] Server disconnect: ${msg.payload.reason}`);
        this.ws.close();
        break;

      case MSG_TYPES.ERROR:
        log(`[tcp] Server error: ${msg.payload.message}`);
        this.emit('error', msg.payload);
        break;
    }
  }

  /**
   * Start PING/PONG keepalive
   */
  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (!this.connected || !this.authenticated) {
        this.stopPing();
        return;
      }
      this._lastPingTime = Date.now();
      this.sendFrame(MSG_TYPES.PING, { ts: this._lastPingTime });
    }, 25000);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /**
   * Reconnect with exponential backoff
   */
  reconnect() {
    if (this.reconnectTimer) return;
    if (!this.isOnline) {
      log('[tcp] Offline, skipping reconnect');
      return;
    }

    this.reconnectAttempt++;
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, this.reconnectAttempt - 1), RECONNECT_MAX);
    log(`[tcp] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect(this.email, this.token);
        log('[tcp] Reconnected successfully');

        // Replay offline queue
        this.replayOfflineQueue();

        // Re-subscribe to conversations
        if (this.subscriptions.size > 0) {
          this.sendFrame(MSG_TYPES.SUBSCRIBE, {
            conversation_ids: Array.from(this.subscriptions),
          });
        }

        this.emit('reconnect');
      } catch (err) {
        log(`[tcp] Reconnect failed: ${err.message}`);
        this.reconnect();
      }
    }, delay);
  }

  /**
   * Replay messages that were queued while offline
   */
  replayOfflineQueue() {
    while (this.offlineQueue.length > 0) {
      const { type, payload } = this.offlineQueue.shift();
      this.sendFrame(type, payload);
    }
  }

  /**
   * Disconnect
   */
  disconnect() {
    this.destroyed = true;
    this.stopPing();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.authTimer) clearTimeout(this.authTimer);
    if (this._appStateHandler) this._appStateHandler.remove();
    if (this.ws) {
      this.ws.close();
    }
  }

  /**
   * Utilities
   */
  _getDeviceId() {
    // TODO: Implement per-device UUID
    return `device_${Date.now()}`;
  }

  _getDeviceName() {
    if (Platform.OS === 'ios') return 'iPhone';
    if (Platform.OS === 'android') return 'Android Phone';
    return 'Web';
  }

  _genClientMsgId() {
    return `c_${Date.now().toString(36)}_${(++this._msgIdCounter).toString(36)}`;
  }
}

/**
 * Binary protocol encoder
 */
class MessageEncoder {
  encode(type, payload) {
    const json = JSON.stringify(payload);
    const jsonBytes = new TextEncoder().encode(json);

    // Frame: [type (1)][length (2)][payload]
    const frame = new ArrayBuffer(1 + 2 + jsonBytes.length);
    const view = new Uint8Array(frame);

    view[0] = type;
    view[1] = (jsonBytes.length >> 8) & 0xFF;
    view[2] = jsonBytes.length & 0xFF;
    view.set(jsonBytes, 3);

    return frame;
  }
}

/**
 * Binary protocol decoder (handles partial reads)
 */
class MessageDecoder {
  constructor() {
    this.buffer = new Uint8Array();
  }

  decode(data) {
    // Append new data to buffer
    const newBuffer = new Uint8Array(this.buffer.length + data.length);
    newBuffer.set(this.buffer);
    newBuffer.set(data, this.buffer.length);
    this.buffer = newBuffer;

    // Try to parse one frame
    if (this.buffer.length < 3) return null; // Not enough for type + length

    const type = this.buffer[0];
    const length = (this.buffer[1] << 8) | this.buffer[2];

    if (this.buffer.length < 3 + length) return null; // Not enough for payload

    // Extract frame
    const payload = new TextDecoder().decode(this.buffer.slice(3, 3 + length));
    const msg = {
      type,
      payload: JSON.parse(payload),
    };

    // Keep remaining data in buffer
    this.buffer = this.buffer.slice(3 + length);

    return msg;
  }
}

// Singleton instance
let _tcpClient = null;

/**
 * Get global TCP client instance (replaces mqtt + websocket)
 */
export function getTCPClient() {
  if (!_tcpClient) {
    _tcpClient = new TCPClient();
  }
  return _tcpClient;
}

/**
 * Logger helper
 */
function log(msg) {
  if (__DEV__) {
    console.log(msg);
  }
}

export default {
  TCPClient,
  getTCPClient,
  MSG_TYPES,
};
