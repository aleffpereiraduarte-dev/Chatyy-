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

// Message types (must match Go server constants in message/codec.go)
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
  CHAT_DELIVERED: 0x2B,       // Server → sender: recipient got the message (✓✓)
  SUBSCRIBE: 0x30,
  UNSUBSCRIBE: 0x31,
  SUBSCRIBE_ACK: 0x32,
  STARTED_TYPING: 0x40,
  STOPPED_TYPING: 0x41,
  USER_TYPING: 0x42,
  USER_ONLINE: 0x43,
  USER_OFFLINE: 0x44,
  STARTED_RECORDING: 0x45,    // Client → server: started recording voice
  STOPPED_RECORDING: 0x46,    // Client → server: stopped recording voice
  USER_RECORDING: 0x47,       // Server → subscribers: user is recording
  ERROR: 0xF0,
  DISCONNECT: 0xF1,
};

// Reverse lookup (type byte → string)
const TYPE_NAMES = Object.fromEntries(
  Object.entries(MSG_TYPES).map(([k, v]) => [v, k])
);

const RECONNECT_BASE = 2000;
const RECONNECT_MAX = 60000;
const AUTH_TIMEOUT = 10000;
const PING_INTERVAL = 25000;
const PONG_TIMEOUT = 10000;

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
    this.destroyed = false;
    this.reconnectAttempt = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.authTimer = null;
    this.subscriptions = new Set();
    this.pendingAcks = new Map(); // temp_id → { resolve, reject, timeout }
    this.offlineQueue = [];
    this.isOnline = Platform.OS === 'web'
      ? (typeof navigator !== 'undefined' && navigator.onLine)
      : true;
    // FIX: inicializar encoder e decoder
    this.encoder = new MessageEncoder();
    this.decoder = new MessageDecoder();
    this._appStateHandler = null;
    this._lastPingTime = 0;
    this._lastPongTime = 0;
    // FIX: inicializar contador de IDs
    this._msgIdCounter = 0;
    // FIX: guardar referências dos listeners online/offline para remover depois
    this._onlineHandler = null;
    this._offlineHandler = null;
    // FIX: flag para evitar auth fail de reconectar
    this._authFailed = false;
  }

  /**
   * Connect to Signal Server
   */
  async connect(email, token) {
    // Fechar ws anterior sem disparar reconexão
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }

    this.email = email;
    this.token = token;
    this._authFailed = false;

    // Determinar URL do servidor
    const port = 5222;
    const host = Platform.OS === 'web'
      ? (typeof window !== 'undefined' ? window.location.hostname : 'localhost')
      : 'chatyy.com.br';

    const wsURL = `wss://${host}:${port}`;

    log(`[tcp] Connecting to ${wsURL}...`);

    return new Promise((innerResolve, innerReject) => {
      // FIX: garantir que resolve/reject só sejam chamados uma vez
      let settled = false;
      const resolve = (val) => { if (!settled) { settled = true; innerResolve(val); } };
      const reject = (err) => { if (!settled) { settled = true; innerReject(err); } };

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

          // Enviar AUTH
          this.sendFrame(MSG_TYPES.AUTH, {
            token,
            email,
            device_id: this._getDeviceId(),
            device_name: this._getDeviceName(),
          });

          // Aguardar AUTH_OK ou AUTH_FAIL
          const authTimeout = setTimeout(() => {
            log('[tcp] AUTH timeout');
            reject(new Error('AUTH timeout'));
          }, AUTH_TIMEOUT);

          const onAuthOk = () => {
            clearTimeout(authTimeout);
            this.removeListener('auth_fail', onAuthFail);
            this.authenticated = true;
            this.reconnectAttempt = 0;
            this.startPing();
            log(`[tcp] Authenticated as ${email}`);
            resolve();
          };

          const onAuthFail = (msg) => {
            clearTimeout(authTimeout);
            this.removeListener('auth_ok', onAuthOk);
            this._authFailed = true;
            reject(new Error((msg && msg.message) || 'Auth failed'));
          };

          this.once('auth_ok', onAuthOk);
          this.once('auth_fail', onAuthFail);
        };

        this.ws.onerror = (err) => {
          log(`[tcp] WebSocket error: ${err}`);
          this.emit('connection', { status: 'error', error: err });
          reject(err instanceof Error ? err : new Error(String(err)));
        };

        this.ws.onmessage = (event) => {
          try {
            const frame = new Uint8Array(event.data);
            // FIX: processar TODOS os frames no chunk, não só o primeiro
            const msgs = this.decoder.decodeAll(frame);
            for (const msg of msgs) {
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

          // FIX: não reconectar se foi auth fail ou destruído
          if (!this.destroyed && !this._authFailed) {
            this.reconnect();
          }
        };

        // FIX: Registrar listeners online/offline apenas uma vez
        if (Platform.OS === 'web' && !this._onlineHandler) {
          this._onlineHandler = () => {
            this.isOnline = true;
            if (!this.connected && !this.destroyed) this.reconnect();
          };
          this._offlineHandler = () => {
            this.isOnline = false;
          };
          window.addEventListener('online', this._onlineHandler);
          window.addEventListener('offline', this._offlineHandler);
        }

        // Handle app state changes (nativo)
        if (Platform.OS !== 'web') {
          if (this._appStateHandler) this._appStateHandler.remove();
          this._appStateHandler = AppState.addEventListener('change', (state) => {
            if (state === 'active' && !this.connected && this.isOnline && !this.destroyed) {
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
   * Persist offline queue to storage so it survives app restarts
   */
  _saveOfflineQueue() {
    try {
      const data = JSON.stringify(this.offlineQueue.slice(-100)); // cap at 100
      if (Platform.OS === 'web') {
        if (typeof localStorage !== 'undefined') localStorage.setItem('chatyy_offline_queue', data);
      } else {
        import('@react-native-async-storage/async-storage')
          .then(m => (m.default || m).setItem('chatyy_offline_queue', data))
          .catch(() => {});
      }
    } catch {}
  }

  async _loadOfflineQueue() {
    try {
      let stored = null;
      if (Platform.OS === 'web') {
        if (typeof localStorage !== 'undefined') stored = localStorage.getItem('chatyy_offline_queue');
      } else {
        const m = await import('@react-native-async-storage/async-storage');
        stored = await (m.default || m).getItem('chatyy_offline_queue');
      }
      if (stored) {
        const parsed = JSON.parse(stored);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Prepend persisted queue (older than current in-memory queue)
          this.offlineQueue = [...parsed, ...this.offlineQueue];
          log(`[tcp] Loaded ${parsed.length} queued messages from storage`);
        }
      }
    } catch {}
  }

  _clearPersistedQueue() {
    try {
      if (Platform.OS === 'web') {
        if (typeof localStorage !== 'undefined') localStorage.removeItem('chatyy_offline_queue');
      } else {
        import('@react-native-async-storage/async-storage')
          .then(m => (m.default || m).removeItem('chatyy_offline_queue'))
          .catch(() => {});
      }
    } catch {}
  }

  /**
   * Send a frame over TCP (binary protocol)
   */
  sendFrame(type, payload) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      log(`[tcp] Not connected, queueing message type ${TYPE_NAMES[type]}`);
      if (this.offlineQueue.length < 500) {
        this.offlineQueue.push({ type, payload });
        this._saveOfflineQueue();
      }
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
      // FIX: só criar timeout de ACK se estiver conectado/online
      const timeoutMs = this.authenticated ? 5000 : 30000;
      const timeout = setTimeout(() => {
        this.pendingAcks.delete(tempId);
        reject(new Error('ACK timeout'));
      }, timeoutMs);

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
   * Send read receipt.
   *
   * [#1213 2026-05-20] Persist `read_at` locally in SQLite BEFORE firing the
   * TCP frame so a cold-restart (or a TCP send failure that we don't see)
   * keeps the unread badge in sync with what the user already saw. Before
   * this change, markAsRead only sent the wire frame — if delivery failed
   * silently the local cache stayed unread and the badge counter showed a
   * fake "1 new" on next open even though the user already scrolled past
   * the message. Mirror is fire-and-forget so we don't block the TCP send.
   */
  markAsRead(conversationId, messageId) {
    try {
      const nativeDb = require('./db');
      if (typeof nativeDb.dbUpdateMessageFields === 'function' && conversationId != null && messageId != null) {
        nativeDb.dbUpdateMessageFields(conversationId, messageId, {
          read_at: new Date().toISOString(),
        }).catch(() => {});
      }
    } catch {}
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
   * Send voice recording indicator
   */
  sendStartedRecording(conversationId) {
    this.sendFrame(MSG_TYPES.STARTED_RECORDING, {
      conversation_id: conversationId,
    });
  }

  sendStoppedRecording(conversationId) {
    this.sendFrame(MSG_TYPES.STOPPED_RECORDING, {
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
        // Responder com PONG
        this.sendFrame(MSG_TYPES.PONG, msg.payload);
        break;

      case MSG_TYPES.PONG:
        // FIX: registrar último pong recebido
        this._lastPongTime = Date.now();
        if (this.pongTimer) {
          clearTimeout(this.pongTimer);
          this.pongTimer = null;
        }
        break;

      case MSG_TYPES.CHAT_MESSAGE: {
        // Dedup LRU por message_id pra evitar duplicata quando o web recebe
        // a mesma mensagem por dois caminhos (TCP signal-server + WS Node hub).
        // Sem isso, o segundo evento dispara setMessages que entra em race
        // com o primeiro e às vezes a bolha era descartada (Foto: mobile→web
        // parou após o fix do exclude_email no chat.php).
        const id = msg.payload?.id ?? msg.payload?.message?.id;
        if (id != null) {
          if (!this._seenMsgIds) { this._seenMsgIds = new Set(); this._seenMsgIdQueue = []; }
          if (this._seenMsgIds.has(id)) break;
          this._seenMsgIds.add(id);
          this._seenMsgIdQueue.push(id);
          if (this._seenMsgIdQueue.length > 500) {
            const old = this._seenMsgIdQueue.shift();
            this._seenMsgIds.delete(old);
          }
        }
        this.emit('chat_message', msg.payload);
        break;
      }

      case MSG_TYPES.CHAT_ACK: {
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
      }

      case MSG_TYPES.CHAT_DELIVERED:
        // Server confirmed recipient got the message → update UI to ✓✓
        this.emit('chat_delivered', msg.payload);
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

      case MSG_TYPES.USER_RECORDING:
        this.emit('user_recording', msg.payload);
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
        log(`[tcp] Server disconnect: ${msg.payload && msg.payload.reason}`);
        // FIX: verificar se ws existe antes de fechar
        if (this.ws) {
          this.ws.onclose = null;
          try { this.ws.close(); } catch {}
          this.ws = null;
        }
        this.connected = false;
        this.authenticated = false;
        this.emit('connection', { status: 'disconnected' });
        if (!this.destroyed) this.reconnect();
        break;

      case MSG_TYPES.ERROR:
        log(`[tcp] Server error: ${msg.payload && msg.payload.message}`);
        this.emit('error', msg.payload);
        break;
    }
  }

  /**
   * Start PING/PONG keepalive com detecção de pong ausente
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

      // FIX: detectar se pong não chegou (conexão morta)
      this.pongTimer = setTimeout(() => {
        log('[tcp] PONG timeout — conexão morta, reconectando');
        if (this.ws) {
          this.ws.onclose = null;
          try { this.ws.close(); } catch {}
          this.ws = null;
        }
        this.connected = false;
        this.authenticated = false;
        this.stopPing();
        this.emit('connection', { status: 'disconnected' });
        if (!this.destroyed) this.reconnect();
      }, PONG_TIMEOUT);
    }, PING_INTERVAL);
  }

  stopPing() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  /**
   * Reconnect with exponential backoff
   */
  reconnect() {
    if (this.reconnectTimer) return;
    if (this.destroyed) return;
    if (!this.isOnline) {
      log('[tcp] Offline, skipping reconnect');
      return;
    }

    this.reconnectAttempt++;
    const delay = Math.min(RECONNECT_BASE * Math.pow(2, this.reconnectAttempt - 1), RECONNECT_MAX);
    log(`[tcp] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempt})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      if (this.destroyed) return;
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
        if (!this.destroyed && !this._authFailed) {
          this.reconnect();
        }
      }
    }, delay);
  }

  /**
   * Replay messages que ficaram na fila offline
   */
  async replayOfflineQueue() {
    // Load any persisted queue from storage first
    await this._loadOfflineQueue();
    while (this.offlineQueue.length > 0) {
      const { type, payload } = this.offlineQueue.shift();
      this.sendFrame(type, payload);
    }
    this._clearPersistedQueue();
  }

  /**
   * Disconnect permanentemente
   */
  disconnect() {
    this.destroyed = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.authTimer) {
      clearTimeout(this.authTimer);
      this.authTimer = null;
    }
    if (this._appStateHandler) {
      this._appStateHandler.remove();
      this._appStateHandler = null;
    }
    // FIX: remover listeners online/offline
    if (Platform.OS === 'web' && this._onlineHandler) {
      window.removeEventListener('online', this._onlineHandler);
      window.removeEventListener('offline', this._offlineHandler);
      this._onlineHandler = null;
      this._offlineHandler = null;
    }
    // Cancelar todos os ACKs pendentes
    for (const [, ack] of this.pendingAcks) {
      clearTimeout(ack.timeout);
      ack.reject(new Error('Disconnected'));
    }
    this.pendingAcks.clear();
    if (this.ws) {
      this.ws.onclose = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
    this.connected = false;
    this.authenticated = false;
  }

  /**
   * Utilities
   */
  _getDeviceId() {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      let id = localStorage.getItem('chatyy_device_id');
      if (!id) {
        id = `web_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
        localStorage.setItem('chatyy_device_id', id);
      }
      return id;
    }
    return `device_${Date.now()}`;
  }

  _getDeviceName() {
    if (Platform.OS === 'ios') return 'iPhone';
    if (Platform.OS === 'android') return 'Android Phone';
    return 'Web';
  }

  _genClientMsgId() {
    // FIX: _msgIdCounter já inicializado no constructor
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
 * Binary protocol decoder — suporta múltiplos frames no mesmo chunk
 */
class MessageDecoder {
  constructor() {
    this.buffer = new Uint8Array(0);
  }

  // FIX: retorna ARRAY de mensagens (todos os frames no chunk)
  decodeAll(data) {
    // Append novo chunk ao buffer
    const newBuffer = new Uint8Array(this.buffer.length + data.length);
    newBuffer.set(this.buffer);
    newBuffer.set(data, this.buffer.length);
    this.buffer = newBuffer;

    const messages = [];

    // Processar TODOS os frames completos disponíveis
    while (this.buffer.length >= 3) {
      const type = this.buffer[0];
      const length = (this.buffer[1] << 8) | this.buffer[2];

      // Verificar payload máximo (65535 bytes)
      if (length > 65535) {
        log('[tcp] Frame inválido — length > 65535, descartando buffer');
        this.buffer = new Uint8Array(0);
        break;
      }

      if (this.buffer.length < 3 + length) break; // Frame incompleto, aguardar mais dados

      try {
        const payloadBytes = this.buffer.slice(3, 3 + length);
        const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
        messages.push({ type, payload });
      } catch (err) {
        log(`[tcp] JSON parse error no frame: ${err.message}`);
      }

      // Avançar buffer para o próximo frame
      this.buffer = this.buffer.slice(3 + length);
    }

    return messages;
  }

  // Mantém compatibilidade (retorna o primeiro frame ou null)
  decode(data) {
    const msgs = this.decodeAll(data);
    return msgs.length > 0 ? msgs[0] : null;
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
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(msg);
  }
}

export default {
  TCPClient,
  getTCPClient,
  MSG_TYPES,
};
