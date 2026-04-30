/**
 * Chatyy MQTT Client
 * Handles chat message delivery via MQTT (QoS 1 guaranteed delivery)
 * WebSocket stays for: presence, typing, calls, live, email notifications
 */
import { Platform, AppState } from 'react-native';
import mqtt from 'mqtt';
import { getString, setString } from './mmkv';

// Stable per-install device id pra MQTT clientId — antes Date.now() criava
// novo clientId por conexão, derrubando session persistence (clean:false).
function _getStableDeviceId() {
  let id = '';
  try { id = getString('mqtt_device_id') || ''; } catch {}
  if (!id) {
    id = 'd' + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
    try { setString('mqtt_device_id', id); } catch {}
  }
  return id;
}

// MQTT broker URLs
const MQTT_URL = Platform.OS === 'web'
  ? 'wss://chatyy.com.br/mqtt'
  : 'wss://mqtt.chatyy.com.br:8883/mqtt';

const MAX_RECONNECT_DELAY = 30000;
const DEDUP_BUFFER_SIZE = 2000;

class ChatMQTT {
  constructor() {
    this.client = null;
    this.email = null;
    this.token = null;
    this.connected = false;
    this.listeners = new Map();
    this.subscribedConversations = new Set();
    this._seenIds = new Set();
    this._seenIdQueue = [];
    this._appStateHandler = null;
  }

  connect(email, token) {
    if (this.client) {
      try { this.client.end(true); } catch {}
    }

    this.email = email;
    this.token = token;

    const clientId = `chatyy_${email.replace(/[@.]/g, '_')}_${_getStableDeviceId()}`;

    try {
      this.client = mqtt.connect(MQTT_URL, {
        clientId,
        username: email,
        password: token,
        clean: false,                    // Persistent session — broker queues messages
        keepalive: 25,                   // 25s keepalive (matches WS ping)
        reconnectPeriod: 1000,           // Start at 1s, mqtt.js handles backoff
        connectTimeout: 10000,
        resubscribe: true,               // Auto-resubscribe on reconnect
        protocolVersion: 4,              // MQTT 3.1.1 (widest compatibility)
      });
    } catch (err) {
      if (__DEV__) console.warn('[MQTT] Connect error:', err.message);
      return;
    }

    this.client.on('connect', () => {
      this.connected = true;
      this._emit('connection', { status: 'connected' });

      // Subscribe to user inbox (conversation list updates)
      this.client.subscribe(`chatyy/user/${email}/inbox`, { qos: 0 });

      // Re-subscribe to all tracked conversations
      for (const convId of this.subscribedConversations) {
        this._subscribeConvTopics(convId);
      }
    });

    this.client.on('message', (topic, payload) => {
      try {
        const data = JSON.parse(payload.toString());
        this._handleMessage(topic, data);
      } catch {}
    });

    this.client.on('close', () => {
      this.connected = false;
      this._emit('connection', { status: 'disconnected' });
    });

    this.client.on('error', (err) => {
      if (__DEV__) console.warn('[MQTT] Error:', err.message);
    });

    this.client.on('reconnect', () => {
      this._emit('connection', { status: 'reconnecting' });
    });

    // Handle app state changes (background/foreground)
    // Remove previous listener before adding a new one to prevent duplicates
    if (this._appStateHandler) {
      this._appStateHandler.remove();
      this._appStateHandler = null;
    }
    if (Platform.OS !== 'web') {
      this._appStateHandler = AppState.addEventListener('change', (state) => {
        if (state === 'active' && this.client && !this.connected) {
          this.client.reconnect();
        }
      });
    }
  }

  disconnect() {
    if (this.client) {
      try { this.client.end(true); } catch {}
      this.client = null;
    }
    this.connected = false;
    this.subscribedConversations.clear();
    if (this._appStateHandler) {
      this._appStateHandler.remove();
      this._appStateHandler = null;
    }
  }

  subscribeConversation(conversationId) {
    const cid = String(conversationId);
    if (this.subscribedConversations.has(cid)) return;
    this.subscribedConversations.add(cid);
    if (this.connected) {
      this._subscribeConvTopics(cid);
    }
  }

  unsubscribeConversation(conversationId) {
    const cid = String(conversationId);
    this.subscribedConversations.delete(cid);
    if (this.connected && this.client) {
      const subtopics = ['msg', 'read', 'reaction', 'edit', 'delete', 'status'];
      subtopics.forEach(s => {
        this.client.unsubscribe(`chatyy/conv/${cid}/${s}`);
      });
    }
  }

  _subscribeConvTopics(conversationId) {
    if (!this.client) return;
    const subtopics = ['msg', 'read', 'reaction', 'edit', 'delete', 'status'];
    subtopics.forEach(s => {
      const qos = (s === 'read' || s === 'status') ? 0 : 1;
      this.client.subscribe(`chatyy/conv/${conversationId}/${s}`, { qos });
    });
  }

  // Publish delivery acknowledgment
  publishDeliveryAck(conversationId, messageId) {
    if (!this.client || !this.connected) return;
    this.client.publish(
      `chatyy/conv/${conversationId}/status`,
      JSON.stringify({
        type: 'delivered',
        message_id: messageId,
        email: this.email,
        ts: Date.now(),
      }),
      // QoS 1 — antes era 0 e o ack se perdia silenciosamente, contradizendo
      // "QoS 1 guaranteed delivery" do header do arquivo.
      { qos: 1 }
    );
  }

  // ─── Event System (same API as websocket.js) ───

  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  off(event, callback) {
    const set = this.listeners.get(event);
    if (set) set.delete(callback);
  }

  _emit(event, data) {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) {
        try { cb(data); } catch {}
      }
    }
  }

  // ─── Message Routing ───

  _handleMessage(topic, data) {
    const parts = topic.split('/');

    // chatyy/user/{email}/inbox
    if (parts[1] === 'user' && parts[3] === 'inbox') {
      this._emit('chat_message', data); // Same event as WS for ChatListTab
      return;
    }

    // chatyy/conv/{id}/{subtopic}
    if (parts[1] === 'conv' && parts.length === 4) {
      const subtopic = parts[3];

      switch (subtopic) {
        case 'msg': {
          // Deduplicate
          const msgId = data?.message?.id || data?.message_id;
          if (msgId && !this._dedup(msgId)) return;
          this._emit('chat_message', data);
          // Send delivery ack
          if (msgId && data?.sender_email !== this.email) {
            this.publishDeliveryAck(parts[2], msgId);
          }
          break;
        }
        case 'read':
          this._emit('chat_read', data);
          break;
        case 'reaction':
          this._emit('chat_reaction', data);
          break;
        case 'edit':
          this._emit('chat_edit', data);
          break;
        case 'delete':
          this._emit('chat_delete', data);
          break;
        case 'status':
          this._emit('message_status', data);
          break;
      }
    }
  }

  _dedup(id) {
    const key = String(id);
    if (this._seenIds.has(key)) return false;
    this._seenIds.add(key);
    this._seenIdQueue.push(key);
    if (this._seenIdQueue.length > DEDUP_BUFFER_SIZE) {
      const old = this._seenIdQueue.shift();
      this._seenIds.delete(old);
    }
    return true;
  }
}

const chatMqtt = new ChatMQTT();
export default chatMqtt;
