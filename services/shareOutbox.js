/**
 * Share Outbox bridge (iOS-only)
 *
 * The native iOS ShareExtension (ios/ShareExtension/ShareViewController.swift)
 * appends successful sends to the App Group UserDefaults array
 * `chatyy.share_outbox` and posts a Darwin notification. The host AppDelegate
 * (ios/OneMundoMail/AppDelegate.swift) observes that notification and
 * re-broadcasts as the NSNotification `ShareDidSend`. ExpoCallKitModule
 * forwards to JS as the `onShareDidSend` event.
 *
 * Without this bridge, the user shares photos via the iOS Share Sheet, the
 * extension uploads them silently, but the app's chat list / open
 * conversation never knows it should refresh — the user has to pull-to-
 * refresh to see their newly sent share message. After the bridge, the chat
 * list updates automatically on the next foreground / immediately if the app
 * is already in memory.
 *
 * Usage:
 *   import { subscribeShareOutbox } from '../services/shareOutbox';
 *   const unsubscribe = subscribeShareOutbox(({ entries }) => {
 *     // entries is [{ msg_id, conv_id, sent_at, type }, ...]
 *     // (refresh chat list, refresh affected conv, etc.)
 *   });
 *
 * The default subscriber installed by app/_layout.js triggers a
 * `deltaSync.syncNow()` so the chat list + each affected conversation get
 * pulled from PG and persisted to SQLite. Per-conv refresh deduped via
 * an in-memory Set of conv_ids touched in the last 5s.
 */
import { Platform } from 'react-native';

let _expoCallKit = null;
function lazyCallKit() {
  if (_expoCallKit) return _expoCallKit;
  if (Platform.OS !== 'ios') return null;
  try {
    _expoCallKit = require('../modules/expo-callkit');
  } catch (e) {
    if (__DEV__) console.warn('[shareOutbox] expo-callkit unavailable:', e?.message);
    _expoCallKit = null;
  }
  return _expoCallKit;
}

/**
 * Read the App Group share_outbox queue (iOS) — same call as the
 * `onShareDidSend` event body, but pull-based so cold-start can drain
 * entries left over from a session before the listener was wired.
 */
export function getShareOutbox() {
  const m = lazyCallKit();
  if (!m || typeof m.getShareOutbox !== 'function') return [];
  try {
    return m.getShareOutbox() || [];
  } catch {
    return [];
  }
}

/** Drain the queue. Always call after processing entries — otherwise the
 *  next foreground will replay them. */
export function clearShareOutbox() {
  const m = lazyCallKit();
  if (!m || typeof m.clearShareOutbox !== 'function') return;
  try {
    m.clearShareOutbox();
  } catch {}
}

/**
 * Subscribe to share-extension completions.
 *
 * Returns an unsubscribe function. On non-iOS platforms returns a no-op so
 * call sites don't have to gate on Platform.OS.
 *
 * The callback receives `{ entries, count }`. The implementation also drains
 * any entries that were sitting in the queue when the listener attached —
 * this catches the cold-start case where the share happened while the host
 * app wasn't running, the Darwin notification fired into nothing, and the
 * entries are sitting in App Group UserDefaults waiting to be picked up on
 * next launch.
 */
export function subscribeShareOutbox(cb) {
  if (Platform.OS !== 'ios') return () => {};
  const m = lazyCallKit();
  if (!m || typeof m.onShareDidSend !== 'function') return () => {};

  // Drain any pre-existing entries (cold-start path). Schedule on next tick
  // so the subscriber is fully wired before the synthetic event fires.
  const pre = getShareOutbox();
  if (pre.length > 0) {
    setTimeout(() => {
      try { cb({ entries: pre, count: pre.length }); } catch {}
    }, 0);
  }

  return m.onShareDidSend((data) => {
    try { cb(data || { entries: [], count: 0 }); } catch {}
  });
}

/**
 * Default handler — refreshes the chat list + any affected conversation
 * via deltaSync.syncNow(). Wired by app/_layout.js so the rest of the app
 * doesn't need to know about the bridge.
 *
 * Per-conv dedup: we only call syncNow() at most once per 800ms even if
 * 5 photos to 3 contacts all complete in the same burst (= 15 entries).
 * The single syncNow() pulls the whole delta including all affected convs
 * so per-call dedup wouldn't help and would actually slow things down.
 */
let _lastSyncTs = 0;
const _SYNC_DEBOUNCE_MS = 800;

export async function defaultShareOutboxHandler({ entries }) {
  if (!entries || entries.length === 0) {
    clearShareOutbox();
    return;
  }
  const now = Date.now();
  if (now - _lastSyncTs < _SYNC_DEBOUNCE_MS) {
    // Still drain so the queue doesn't accumulate — the in-flight sync
    // will pick up the latest state.
    clearShareOutbox();
    return;
  }
  _lastSyncTs = now;

  // Drain BEFORE the async sync so concurrent shares don't double-process
  // the same entries.
  clearShareOutbox();

  try {
    const deltaSync = require('./deltaSync');
    if (typeof deltaSync.syncNow === 'function') {
      await deltaSync.syncNow();
    }
  } catch (e) {
    if (__DEV__) console.warn('[shareOutbox] syncNow failed:', e?.message);
  }
}
