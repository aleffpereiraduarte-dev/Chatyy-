/**
 * Chatyy Sync Engine v1.0 — Offline-First Chat Sync
 *
 * WhatsApp/Telegram-style offline-first data layer for chat:
 *  1. Offline message queue  — messages saved locally as _pending, auto-sent in order
 *  2. Delta sync             — on reconnect, fetch only messages since lastSyncId
 *  3. Conflict resolution    — server timestamp wins for edits; local-first for new msgs
 *  4. Background sync        — incremental sync when app comes to foreground
 *  5. Optimistic UI          — send/react/delete apply instantly; reconcile with server async
 *  6. Network status         — NetInfo + WS connection → single source of truth
 *  7. Exponential backoff    — failed API calls retry 3× at 1s / 2s / 4s
 *  8. Cold-start batch       — one request for all conversations + last 20 msgs each
 *
 * Integration (call from _layout.js after auth):
 *   import syncEngine from './services/syncEngine';
 *   syncEngine.init(api, ws);              // start
 *   syncEngine.onNetworkChange(cb);        // subscribe UI
 *   syncEngine.destroy();                  // call on logout
 *
 * Used by chat screens:
 *   syncEngine.sendMessage(convId, payload)   → optimistic + queue
 *   syncEngine.reactToMessage(convId, msgId, emoji)
 *   syncEngine.deleteMessage(convId, msgId)
 *   syncEngine.syncConversation(convId)       → delta pull for one conversation
 *   syncEngine.batchSync()                    → cold-start full batch
 */

import { Platform, AppState } from 'react-native';
import {
  cacheMessages,
  cacheSingleMessage,
  getCachedMessages,
  getLastSyncId,
  cacheConversations,
  getCachedConversations,
  updateCachedMessage,
  deleteCachedMessage,
  savePendingMessage,
  getPendingMessages,
  removePendingMessage,
  getAllPendingMessages,
} from './chatCache';
import { getNetworkState, onNetworkChange as _onNetworkChange } from './networkInfo';
import { getJSON, setJSON, getString, setString } from './mmkv';

// ─── Constants ──────────────────────────────────────────────────────────────

const SYNC_KEY_PREFIX = 'sync_conv_';         // MMKV key prefix for per-conv sync state
const BATCH_SYNC_KEY = 'sync_batch_state';    // MMKV key for batch sync state
const PENDING_QUEUE_KEY = 'sync_pending_q';   // MMKV key for outgoing message queue

// Retry delays: 1s → 2s → 4s
const RETRY_DELAYS = [1000, 2000, 4000];
const MAX_RETRIES = 3;

// Background sync: incremental on foreground, full every 5 min
const FOREGROUND_SYNC_COOLDOWN_MS = 10 * 1000;   // min gap between foreground syncs
const PERIODIC_SYNC_INTERVAL_MS = 5 * 60 * 1000; // periodic full batch sync
const BATCH_MSGS_PER_CONV = 20;                   // messages per conv on cold start

// ─── State ──────────────────────────────────────────────────────────────────

let _api = null;                    // api.js module reference
let _ws = null;                     // websocket.js singleton reference
let _networkListeners = new Set();  // UI callbacks for network status changes
let _syncListeners = new Set();     // UI callbacks for sync state changes
let _networkOnline = true;          // current network state
let _wsConnected = false;           // current WS auth state
let _isBatchSyncing = false;        // guard against concurrent batch syncs
let _lastForegroundSync = 0;        // timestamp of last foreground sync
let _periodicTimer = null;          // setInterval handle
let _appStateSubscription = null;   // AppState event subscription
let _netUnsubscribe = null;         // NetworkInfo unsubscribe
let _wsUnsubscribe = null;          // WS connection listener unsubscribe
let _flushTimer = null;             // pending queue flush debounce
let _destroyed = false;

// Per-conversation sync locks (prevent concurrent delta syncs for same conv)
const _syncingConvs = new Set();

// ─── Internal Helpers ────────────────────────────────────────────────────────

function _isOnline() {
  return _networkOnline && _wsConnected;
}

/** Emit network/connectivity status to UI listeners */
function _emitNetwork(online) {
  _networkListeners.forEach(cb => { try { cb(online); } catch {} });
}

/** Emit sync progress to UI listeners */
function _emitSync(event) {
  _syncListeners.forEach(cb => { try { cb(event); } catch {} });
}

/**
 * Retry wrapper with exponential backoff.
 * @param {Function} fn - async function to retry
 * @param {number} maxRetries
 * @returns {Promise<*>}
 */
async function _withRetry(fn, maxRetries = MAX_RETRIES) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < maxRetries) {
        const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

/**
 * Get the last synced message ID for a conversation from MMKV.
 * Falls back to chatCache.getLastSyncId() (SQLite on native).
 */
async function _getLastSyncId(conversationId) {
  // Try MMKV first (instant, no async wait)
  const key = SYNC_KEY_PREFIX + conversationId;
  const stored = getJSON(key);
  if (stored?.lastId > 0) return stored.lastId;

  // Fall back to SQLite/MMKV chatCache
  return getLastSyncId(conversationId);
}

/** Persist the last synced message ID for a conversation */
function _setLastSyncId(conversationId, id) {
  if (!id || id <= 0) return;
  const key = SYNC_KEY_PREFIX + conversationId;
  const existing = getJSON(key) || {};
  setJSON(key, { ...existing, lastId: id, ts: Date.now() });
}

/** Generate a temporary message ID for optimistic sends */
function _tempId() {
  return `tmp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

// ─── 1. Offline Message Queue ────────────────────────────────────────────────

/**
 * Internal pending-message queue (persisted to MMKV).
 * Each entry: { id, conversationId, payload, retries, createdAt, status }
 */
function _getQueue() {
  return getJSON(PENDING_QUEUE_KEY) || [];
}

function _saveQueue(queue) {
  setJSON(PENDING_QUEUE_KEY, queue);
}

function _addToQueue(entry) {
  const queue = _getQueue();
  // Prevent duplicates by temp_id
  const exists = queue.some(q => q.id === entry.id);
  if (!exists) queue.push(entry);
  _saveQueue(queue);
}

function _removeFromQueue(tempId) {
  const queue = _getQueue();
  _saveQueue(queue.filter(q => q.id !== tempId));
}

function _markQueueEntry(tempId, updates) {
  const queue = _getQueue();
  const idx = queue.findIndex(q => q.id === tempId);
  if (idx !== -1) {
    queue[idx] = { ...queue[idx], ...updates };
    _saveQueue(queue);
  }
}

// ─── 2. Delta Sync (per-conversation) ────────────────────────────────────────

/**
 * Fetch messages for a conversation since lastSyncId (delta pull).
 * Called on: reconnect, foreground return, explicit refresh.
 *
 * @param {number} conversationId
 * @param {object} [opts]
 * @param {boolean} [opts.force] - ignore cooldown / sync-in-progress guard
 * @returns {Promise<{added: number, updated: number}>}
 */
async function syncConversation(conversationId, opts = {}) {
  if (!_api || _destroyed) return { added: 0, updated: 0 };
  if (_syncingConvs.has(conversationId) && !opts.force) return { added: 0, updated: 0 };

  _syncingConvs.add(conversationId);
  try {
    const sinceId = await _getLastSyncId(conversationId);
    const result = await _withRetry(() =>
      _api.chatMessages(conversationId, 50, null, sinceId)
    );

    if (!result?.success || !Array.isArray(result.data?.messages)) {
      return { added: 0, updated: 0 };
    }

    const incoming = result.data.messages;
    if (!incoming.length) return { added: 0, updated: 0 };

    // ── Conflict resolution ──
    // Server timestamp wins for edits (server's edited_at > local's edited_at).
    // For new messages we always accept server data.
    const cached = await getCachedMessages(conversationId, 1000);
    const cachedMap = new Map(cached.map(m => [m.id, m]));

    let added = 0;
    let updated = 0;
    const toSave = [];

    for (const msg of incoming) {
      if (!msg.id || String(msg.id).startsWith('tmp_')) continue;

      const local = cachedMap.get(msg.id);
      if (!local) {
        // New message — accept server data
        toSave.push(msg);
        added++;
      } else {
        // Existing message — server timestamp wins for edits
        const serverEdited = msg.edited_at ? new Date(msg.edited_at).getTime() : 0;
        const localEdited = local.edited_at ? new Date(local.edited_at).getTime() : 0;
        if (serverEdited > localEdited || msg.deleted !== local.deleted) {
          toSave.push(msg);
          updated++;
        }
      }
    }

    if (toSave.length > 0) {
      await cacheMessages(conversationId, toSave);
      // Update lastSyncId to the max ID seen
      const maxId = Math.max(...incoming.filter(m => typeof m.id === 'number').map(m => m.id));
      if (maxId > 0) _setLastSyncId(conversationId, maxId);

      // Notify UI via WS emit (reuses existing chat_message handler path)
      if (_ws?.emit) {
        for (const msg of toSave) {
          _ws.emit('chat_message', { conversation_id: conversationId, message: msg });
        }
      }
    }

    return { added, updated };
  } catch (err) {
    if (__DEV__) console.warn('[syncEngine] syncConversation error:', err?.message);
    return { added: 0, updated: 0 };
  } finally {
    _syncingConvs.delete(conversationId);
  }
}

// ─── 3. Batch Sync (cold start) ──────────────────────────────────────────────

/**
 * Cold-start batch sync: fetch all conversations + last 20 messages each
 * in as few requests as possible.
 *
 * Strategy:
 *   1. Fetch conversation list
 *   2. For each conversation, check if we have recent messages (sinceId > 0)
 *   3. Fire delta-syncs for all conversations in parallel (max 5 at a time)
 *
 * @param {object} [opts]
 * @param {boolean} [opts.force] - skip "already synced recently" guard
 */
async function batchSync(opts = {}) {
  if (!_api || _destroyed) return;
  if (_isBatchSyncing && !opts.force) return;

  // Throttle: don't batch sync more often than the cooldown unless forced
  const batchState = getJSON(BATCH_SYNC_KEY) || {};
  if (!opts.force && batchState.ts && (Date.now() - batchState.ts) < FOREGROUND_SYNC_COOLDOWN_MS) {
    return;
  }

  _isBatchSyncing = true;
  _emitSync({ type: 'batch_start' });

  try {
    // Step 1: fetch conversation list
    const convsResult = await _withRetry(() => _api.apiCall?.('chat_conversations', {}, 'GET') || _api.chatConversations?.());
    const conversations = convsResult?.data?.conversations || convsResult?.data || [];

    if (Array.isArray(conversations) && conversations.length > 0) {
      await cacheConversations(conversations);
      _emitSync({ type: 'conversations_synced', count: conversations.length });
    }

    // Step 2: delta sync each conversation (5 concurrent)
    const convIds = conversations.map(c => c.id).filter(Boolean);
    const CONCURRENCY = 5;
    let totalAdded = 0;

    for (let i = 0; i < convIds.length; i += CONCURRENCY) {
      const batch = convIds.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(convId => syncConversationBatch(convId))
      );
      for (const r of results) {
        if (r.status === 'fulfilled') totalAdded += r.value?.added || 0;
      }
    }

    setJSON(BATCH_SYNC_KEY, { ts: Date.now(), convCount: convIds.length });
    _emitSync({ type: 'batch_done', convCount: convIds.length, added: totalAdded });

  } catch (err) {
    if (__DEV__) console.warn('[syncEngine] batchSync error:', err?.message);
    _emitSync({ type: 'batch_error', error: err?.message });
  } finally {
    _isBatchSyncing = false;
  }
}

/**
 * Fetch last N messages for a single conversation during batch sync.
 * Uses sinceId for delta; falls back to fresh fetch if no local data.
 */
async function syncConversationBatch(conversationId) {
  if (!_api) return { added: 0 };
  try {
    const sinceId = await _getLastSyncId(conversationId);
    const result = await _withRetry(() =>
      _api.chatMessages(conversationId, BATCH_MSGS_PER_CONV, null, sinceId)
    );
    const messages = result?.data?.messages;
    if (!Array.isArray(messages) || !messages.length) return { added: 0 };

    await cacheMessages(conversationId, messages);
    const maxId = Math.max(...messages.filter(m => typeof m.id === 'number').map(m => m.id));
    if (maxId > 0) _setLastSyncId(conversationId, maxId);

    return { added: messages.length };
  } catch {
    return { added: 0 };
  }
}

// ─── 4. Send Message (Optimistic + Queue) ─────────────────────────────────────

/**
 * Send a chat message with optimistic UI.
 *
 * Returns the temporary message object immediately so the UI can show it
 * right away. The message is queued if offline and sent when back online.
 *
 * @param {number} conversationId
 * @param {object} payload - { content, type, replyToId, mentions, fileUrl, topicId }
 * @param {object} [opts]
 * @param {Function} [opts.onOptimistic] - called immediately with { tempMsg }
 * @param {Function} [opts.onConfirmed]  - called when server confirms with { serverMsg }
 * @param {Function} [opts.onFailed]     - called if all retries fail
 * @returns {{ tempId: string, tempMsg: object }}
 */
function sendMessage(conversationId, payload, opts = {}) {
  const tempId = _tempId();
  const clientMsgId = tempId; // reuse as client_message_id for dedup

  // Build the optimistic message (local-first)
  const tempMsg = {
    id: tempId,
    conversation_id: conversationId,
    content: payload.content || '',
    type: payload.type || 'text',
    file_url: payload.fileUrl || null,
    file_name: payload.fileName || null,
    reply_to_id: payload.replyToId || null,
    mentions: payload.mentions || null,
    created_at: new Date().toISOString(),
    sender_email: _api?.getSavedEmail?.() || '',
    _pending: true,
    _tempId: tempId,
  };

  // 1. Save to pending queue (persisted — survives app kill)
  const queueEntry = {
    id: tempId,
    conversationId,
    payload: { ...payload, replyToId: payload.replyToId || null },
    clientMsgId,
    retries: 0,
    createdAt: Date.now(),
    status: 'pending',
  };
  _addToQueue(queueEntry);

  // 2. Save to chatCache as pending so it shows on screen
  savePendingMessage(conversationId, { ...tempMsg, temp_id: tempId, client_message_id: clientMsgId }).catch(() => {});

  // 3. Notify caller immediately (optimistic UI)
  if (opts.onOptimistic) {
    try { opts.onOptimistic({ tempMsg }); } catch {}
  }

  // 4. Attempt immediate send if online
  _sendQueueEntry(queueEntry, opts).catch(() => {});

  return { tempId, tempMsg };
}

/**
 * Attempt to send a queued message entry.
 * Reconciles optimistic msg with server response.
 */
async function _sendQueueEntry(entry, opts = {}) {
  if (!_api || _destroyed) return;

  // Retry loop with exponential backoff
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // Wait if offline — don't retry until reconnect
    if (!_networkOnline) {
      // Leave in queue; _flushPendingQueue will pick it up on reconnect
      return;
    }

    try {
      const p = entry.payload;
      const result = await _api.chatSend(
        entry.conversationId,
        p.content || '',
        p.type || 'text',
        p.replyToId || null,
        p.mentions || null,
        p.fileUrl || null,
        entry.id,           // temp_id
        entry.clientMsgId,  // client_message_id
        p.topicId || null,
      );

      if (!result?.success) throw new Error(result?.error || 'send failed');

      const serverMsg = result.data;

      // ── Confirm: remove from queue, update cache ──
      _removeFromQueue(entry.id);
      await removePendingMessage(entry.conversationId, entry.id);
      if (serverMsg?.id) {
        await cacheSingleMessage(entry.conversationId, { ...serverMsg, _pending: false });
        _setLastSyncId(entry.conversationId, serverMsg.id);
      }

      // Swap optimistic msg in open screens via WS emit
      if (_ws?.emit) {
        _ws.emit('chat_message', {
          conversation_id: entry.conversationId,
          message: serverMsg,
          _replaceTempId: entry.id,
        });
      }

      if (opts.onConfirmed) {
        try { opts.onConfirmed({ serverMsg }); } catch {}
      }
      return; // success

    } catch (err) {
      if (attempt < MAX_RETRIES) {
        _markQueueEntry(entry.id, { retries: attempt + 1, lastError: err?.message });
        const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
        await new Promise(r => setTimeout(r, delay));
      } else {
        // Max retries hit — mark as failed but keep in cache as _failed
        _markQueueEntry(entry.id, { status: 'failed', retries: MAX_RETRIES });
        await updateCachedMessage(entry.conversationId, entry.id, { _pending: false, _failed: true }).catch(() => {});
        if (opts.onFailed) {
          try { opts.onFailed({ error: err?.message }); } catch {}
        }
      }
    }
  }
}

/**
 * Flush all pending messages in order when back online.
 * Called on reconnect and on foreground.
 */
async function _flushPendingQueue() {
  if (!_api || !_networkOnline || _destroyed) return;

  const queue = _getQueue().filter(e => e.status !== 'failed');
  if (!queue.length) return;

  // Sort by createdAt to maintain message order
  queue.sort((a, b) => a.createdAt - b.createdAt);

  _emitSync({ type: 'queue_flush', count: queue.length });

  // Process sequentially (order matters within same conversation)
  // Group by conversation and send per-conversation in order
  const byConv = {};
  for (const entry of queue) {
    (byConv[entry.conversationId] = byConv[entry.conversationId] || []).push(entry);
  }

  await Promise.allSettled(
    Object.values(byConv).map(async (entries) => {
      for (const entry of entries) {
        if (entry.status === 'failed') continue; // skip permanently failed
        await _sendQueueEntry(entry);
      }
    })
  );
}

// ─── 5. Optimistic Actions ───────────────────────────────────────────────────

/**
 * React to a message optimistically.
 * Applies to local cache immediately, syncs with server async.
 */
async function reactToMessage(conversationId, messageId, emoji) {
  if (!_api) return;

  // Optimistic: update local cache right away
  const cached = await getCachedMessages(conversationId, 500);
  const msg = cached.find(m => m.id === messageId);
  if (msg) {
    const reactions = { ...(msg.reactions || {}) };
    const userEmail = _api.getSavedEmail?.() || '';
    if (!reactions[emoji]) reactions[emoji] = [];
    if (!reactions[emoji].includes(userEmail)) {
      reactions[emoji] = [...reactions[emoji], userEmail];
    } else {
      // Toggle off
      reactions[emoji] = reactions[emoji].filter(e => e !== userEmail);
      if (!reactions[emoji].length) delete reactions[emoji];
    }
    await updateCachedMessage(conversationId, messageId, { reactions }).catch(() => {});
    if (_ws?.emit) {
      _ws.emit('chat_message', {
        conversation_id: conversationId,
        message: { ...msg, reactions },
      });
    }
  }

  // Async server sync with retry
  _withRetry(() => _api.apiCall('chat_react', { message_id: messageId, emoji }, 'POST'))
    .catch(err => {
      if (__DEV__) console.warn('[syncEngine] reactToMessage failed:', err?.message);
    });
}

/**
 * Delete a message optimistically.
 * Marks as deleted in local cache immediately, syncs with server async.
 */
async function deleteMessage(conversationId, messageId) {
  if (!_api) return;

  // Optimistic local delete
  await updateCachedMessage(conversationId, messageId, { deleted: 1 }).catch(() => {});
  if (_ws?.emit) {
    _ws.emit('chat_message', {
      conversation_id: conversationId,
      message: { id: messageId, conversation_id: conversationId, deleted: 1 },
    });
  }

  // Async server sync with retry
  _withRetry(() => _api.apiCall('chat_delete_message', { message_id: messageId }, 'POST'))
    .catch(err => {
      if (__DEV__) console.warn('[syncEngine] deleteMessage failed:', err?.message);
      // Rollback optimistic delete on failure
      updateCachedMessage(conversationId, messageId, { deleted: 0 }).catch(() => {});
    });
}

// ─── 6. Network Status Tracking ─────────────────────────────────────────────

/** Register a UI callback for network changes: cb(isOnline: boolean) */
function onNetworkChange(callback) {
  _networkListeners.add(callback);
  return () => _networkListeners.delete(callback);
}

/** Register a UI callback for sync events: cb({ type, ... }) */
function onSyncEvent(callback) {
  _syncListeners.add(callback);
  return () => _syncListeners.delete(callback);
}

/** Current composite online state (network AND WS authenticated) */
function isOnline() {
  return _isOnline();
}

/** Current raw network state (may be online even if WS is down) */
function isNetworkOnline() {
  return _networkOnline;
}

// ─── 7. Foreground / Background Sync ─────────────────────────────────────────

async function _onForeground() {
  if (_destroyed) return;

  const now = Date.now();
  if (now - _lastForegroundSync < FOREGROUND_SYNC_COOLDOWN_MS) return;
  _lastForegroundSync = now;

  // Flush pending queue first
  await _flushPendingQueue();

  // Then do incremental batch sync
  await batchSync();
}

// ─── 8. Init / Destroy ───────────────────────────────────────────────────────

/**
 * Initialize the sync engine. Call once after login.
 *
 * @param {object} api    - api.js module (or object with chatMessages, chatSend, apiCall, etc.)
 * @param {object} ws     - websocket.js singleton
 */
function init(api, ws) {
  if (_destroyed) {
    // Allow re-init after destroy (logout → re-login)
    _destroyed = false;
  }

  _api = api;
  _ws = ws;

  // ── Network state ──
  _networkOnline = getNetworkState()?.isConnected !== false;

  _netUnsubscribe = _onNetworkChange((state) => {
    const wasOnline = _networkOnline;
    _networkOnline = state.isConnected !== false;
    const compositeNow = _isOnline();

    if (!wasOnline && _networkOnline) {
      // Network came back — flush queue and delta sync
      _flushPendingQueue().catch(() => {});
      batchSync().catch(() => {});
    }

    _emitNetwork(compositeNow);
  });

  // ── WebSocket connection state ──
  if (ws) {
    _wsUnsubscribe = ws.on('connection', (event) => {
      const wasConnected = _wsConnected;
      _wsConnected = event.status === 'authenticated';

      if (!wasConnected && _wsConnected) {
        // WS reconnected — flush and delta sync
        _flushPendingQueue().catch(() => {});
        batchSync().catch(() => {});
      }

      _emitNetwork(_isOnline());
    });
  }

  // ── AppState (foreground) ──
  if (Platform.OS !== 'web') {
    _appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        _onForeground().catch(() => {});
      }
    });
  } else if (typeof document !== 'undefined') {
    // Web: visibilitychange
    const handler = () => {
      if (!document.hidden) _onForeground().catch(() => {});
    };
    document.addEventListener('visibilitychange', handler);
    // Store for cleanup
    _webVisibilityHandler = handler;
  }

  // ── Periodic background sync ──
  _periodicTimer = setInterval(() => {
    if (!_destroyed) batchSync({ force: false }).catch(() => {});
  }, PERIODIC_SYNC_INTERVAL_MS);

  // ── Flush any pre-existing pending queue (from previous session) ──
  const existingQueue = _getQueue();
  if (existingQueue.length > 0) {
    // Debounce slightly to let WS authenticate first
    _flushTimer = setTimeout(() => {
      _flushPendingQueue().catch(() => {});
    }, 3000);
  }

  // ── Cold-start batch sync ──
  // Small delay so WS auth completes first
  setTimeout(() => {
    if (!_destroyed) batchSync().catch(() => {});
  }, 1500);

  if (__DEV__) console.log('[syncEngine] initialized');
}

let _webVisibilityHandler = null;

/** Stop the sync engine (call on logout). */
function destroy() {
  _destroyed = true;

  if (_netUnsubscribe) { _netUnsubscribe(); _netUnsubscribe = null; }
  if (_wsUnsubscribe) { _wsUnsubscribe(); _wsUnsubscribe = null; }
  if (_appStateSubscription) { _appStateSubscription.remove(); _appStateSubscription = null; }
  if (_periodicTimer) { clearInterval(_periodicTimer); _periodicTimer = null; }
  if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
  if (_webVisibilityHandler && typeof document !== 'undefined') {
    document.removeEventListener('visibilitychange', _webVisibilityHandler);
    _webVisibilityHandler = null;
  }

  _networkListeners.clear();
  _syncListeners.clear();
  _syncingConvs.clear();
  _isBatchSyncing = false;
  _api = null;
  _ws = null;

  if (__DEV__) console.log('[syncEngine] destroyed');
}

// ─── Convenience: retry a single failed message ──────────────────────────────

/**
 * Retry a message that previously failed (status === 'failed').
 * Resets its retry count and attempts send.
 */
async function retryFailedMessage(tempId) {
  const queue = _getQueue();
  const entry = queue.find(q => q.id === tempId);
  if (!entry) return;

  _markQueueEntry(tempId, { status: 'pending', retries: 0, lastError: null });
  // Update chatCache flag
  try {
    const convId = entry.conversationId;
    await updateCachedMessage(convId, tempId, { _failed: false, _pending: true });
  } catch {}

  await _sendQueueEntry({ ...entry, status: 'pending', retries: 0 });
}

/**
 * Get the current sync stats (for debug overlays / settings screens).
 */
function getSyncStats() {
  const queue = _getQueue();
  const batchState = getJSON(BATCH_SYNC_KEY) || {};
  return {
    isOnline: _isOnline(),
    networkOnline: _networkOnline,
    wsConnected: _wsConnected,
    pendingMessages: queue.filter(q => q.status === 'pending').length,
    failedMessages: queue.filter(q => q.status === 'failed').length,
    lastBatchSync: batchState.ts ? new Date(batchState.ts).toISOString() : null,
    lastBatchConvCount: batchState.convCount || 0,
  };
}

// ─── Export ──────────────────────────────────────────────────────────────────

const syncEngine = {
  // Lifecycle
  init,
  destroy,

  // Sync
  batchSync,
  syncConversation,

  // Messaging (optimistic)
  sendMessage,
  reactToMessage,
  deleteMessage,
  retryFailedMessage,

  // Network
  isOnline,
  isNetworkOnline,
  onNetworkChange,
  onSyncEvent,

  // Debug
  getSyncStats,

  // Internals exposed for testing
  _flushPendingQueue,
  _withRetry,
};

export default syncEngine;
