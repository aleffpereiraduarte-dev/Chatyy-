// Chatyy Delta Sync Service — WhatsApp-level offline-first sync
// Keeps local SQLite in sync with server using sequence numbers.
// Pattern: open app → show cached → delta sync in background → update UI
//
// Sync flow:
// 1. App opens → show cached data from SQLite (instant)
// 2. Call fullDeltaSync() → fetch changes since last_sync_seq
// 3. WebSocket pushes real-time events → apply to SQLite immediately
// 4. Background sync every 15 min (even when app is backgrounded)
// 5. Offline queue: actions done offline are queued and replayed when online

import { Platform, AppState } from 'react-native';
import * as localDb from './localDb';

let _apiCall = null;
let _onSyncComplete = null;
let _appStateSubscription = null;
let _wsUnsub = null;
let _isSyncing = false;
let _lastSyncTime = 0;

const MIN_SYNC_GAP_MS = 10 * 1000;        // Don't sync more often than 10s
const FIRST_SYNC_DELAY_MS = 1000;          // 1s after init

// ---------------------------------------------------------------------------
// 1. Initialize
// ---------------------------------------------------------------------------

/**
 * Start the delta sync engine.
 *
 * WhatsApp-invisible-sync: NO setInterval. We only sync on event-driven
 * triggers:
 *   1. Initial kick 1s after init (first paint already showed cache).
 *   2. WS connection authenticated → catch up anything missed while offline.
 *   3. AppState transitions to 'active' → user opened the app, sync once.
 * Push-pushed updates flow through applyRealtimeEvent() so there's nothing
 * to poll for in the steady state.
 *
 * @param {Function} apiCall - The API call function from api.js
 * @param {Function} onSyncComplete - Callback when sync finishes (to refresh UI)
 */
export function initDeltaSync(apiCall, onSyncComplete) {
  _apiCall = apiCall;
  _onSyncComplete = onSyncComplete;

  // Idempotent — chamadas repetidas (login multi-conta, hot reload) não
  // devem acumular listeners.
  if (_appStateSubscription) { try { _appStateSubscription.remove(); } catch {} _appStateSubscription = null; }
  if (_wsUnsub) { try { _wsUnsub(); } catch {} _wsUnsub = null; }

  // First sync shortly after init (cold open path).
  setTimeout(() => syncNow(), FIRST_SYNC_DELAY_MS);

  // Sync when app comes to foreground (replaces the periodic poll).
  _appStateSubscription = AppState.addEventListener('change', (state) => {
    if (state === 'active') {
      syncNow();
    }
  });

  // Sync once after every WS reconnect → re-auth. While the WS is healthy
  // it pushes events live, so there's nothing else to poll.
  try {
    const mailWs = require('./websocket').default;
    if (mailWs && typeof mailWs.on === 'function') {
      _wsUnsub = mailWs.on('connection', (evt) => {
        if (evt?.status === 'authenticated') {
          syncNow();
        }
      });
    }
  } catch {}

  console.log('[deltaSync] initialized (event-driven, no polling)');
}

/**
 * Stop the sync engine (call on logout).
 */
export function stopDeltaSync() {
  if (_appStateSubscription) {
    _appStateSubscription.remove();
    _appStateSubscription = null;
  }
  if (_wsUnsub) {
    try { _wsUnsub(); } catch {}
    _wsUnsub = null;
  }
  _apiCall = null;
  _onSyncComplete = null;
  _isSyncing = false;
  console.log('[deltaSync] stopped');
}

// ---------------------------------------------------------------------------
// 2. Sync Now
// ---------------------------------------------------------------------------

/**
 * Trigger a sync immediately (debounced).
 */
export async function syncNow() {
  if (_isSyncing) return;
  if (Date.now() - _lastSyncTime < MIN_SYNC_GAP_MS) return;
  if (!_apiCall) return;

  _isSyncing = true;
  _lastSyncTime = Date.now();

  try {
    await localDb.fullDeltaSync(_apiCall);
    if (_onSyncComplete) _onSyncComplete();
  } catch (e) {
    console.warn('[deltaSync] sync error:', e?.message);
  } finally {
    _isSyncing = false;
  }
}

// ---------------------------------------------------------------------------
// 3. Real-time Event Handler (called from WebSocket)
// ---------------------------------------------------------------------------

/**
 * Apply a real-time event from WebSocket to local SQLite.
 * Call this from the WebSocket message handler.
 * @param {Object} event - {type, data}
 */
export async function applyRealtimeEvent(event) {
  if (Platform.OS === 'web') return;
  if (!event?.type) return;

  try {
    switch (event.type) {
      // Chat
      case 'new_message':
        if (event.data) {
          // Stage 1 dedup: a row with this client_temp_id may already exist
          // in SQLite (the sender's own optimistic insert). saveMessage()
          // upserts by server msg_id but ALSO collapses the optimistic row
          // whose `client_temp_id` matches, preserving its local_seq so
          // ordering doesn't jump when the server id replaces the temp one.
          // Server msg_id wins as the durable primary key.
          await localDb.saveMessage(event.data);
        }
        break;
      case 'message_edited':
        if (event.data?.id) await localDb.updateMessage(event.data.id, event.data);
        break;
      case 'message_deleted':
        // Soft-delete only (deleteMessage sets deleted_at). The row stays in
        // SQLite so disappearing-timer + history search keep working until
        // user explicitly purges.
        if (event.data?.id) await localDb.deleteMessage(event.data.id);
        break;
      case 'conversation_updated':
        if (event.data) await localDb.saveConversations([event.data]);
        break;

      // Presence
      case 'presence_update':
        if (event.data?.email) {
          await localDb.saveUserProfiles([{
            email: event.data.email,
            status: event.data.status,
            last_seen: event.data.last_seen
          }]);
        }
        break;

      // Notifications
      case 'notification':
        if (event.data) await localDb.saveNotifications([event.data]);
        break;

      // Calendar
      case 'calendar_event_created':
      case 'calendar_event_updated':
        if (event.data) await localDb.saveCalendarEvents([event.data]);
        break;

      // Drive
      case 'drive_file_updated':
        if (event.data) await localDb.saveDriveFiles([event.data]);
        break;

      // Feed
      case 'feed_post_created':
        if (event.data) await localDb.saveFeedPosts([event.data]);
        break;

      default:
        // Unknown event type — trigger a full sync to catch up
        break;
    }
  } catch (e) {
    console.warn('[deltaSync] applyRealtimeEvent error:', e?.message);
  }
}

// ---------------------------------------------------------------------------
// 4. Offline Action Queue
// ---------------------------------------------------------------------------

/**
 * Queue an action for later execution (when offline).
 * @param {string} action - API action name
 * @param {Object} payload - Action parameters
 */
export async function queueAction(action, payload) {
  await localDb.queueOfflineAction(action, payload);
}

/**
 * Replay queued actions (call when back online).
 */
export async function replayQueue() {
  if (!_apiCall) return;
  await localDb.replayOfflineQueue(_apiCall);
}

// ---------------------------------------------------------------------------
// 5. Warm Cache (preload key data on login)
// ---------------------------------------------------------------------------

/**
 * Preload essential data into SQLite on first login.
 * Shows loading indicator while this runs.
 */
export async function warmCache(apiCall) {
  if (Platform.OS === 'web') return;
  console.log('[deltaSync] warming cache...');

  const hasData = await localDb.hasLocalData();
  if (hasData) {
    // Already has data — just do incremental sync
    await localDb.fullDeltaSync(apiCall);
    return;
  }

  // First time — full sync
  await localDb.fullSync(apiCall);
  console.log('[deltaSync] cache warmed');
}
