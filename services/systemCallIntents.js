// services/systemCallIntents.js — [2026-10-09 recents-redial]
//
// iOS: tapping a Chatyy entry in the Phone app's Recents (CallKit
// includesCallsInRecents), a CarPlay redial or a Siri "call" lands in the
// app as an INStartCallIntent. Native (CallIntentAppDelegateSubscriber +
// CallRecentsIntentStore) maps the CallKit handle back to the Chatyy account
// and exposes it two ways:
//   - live event   ExpoCallKit.onStartCallIntent (app already running)
//   - one-shot     ExpoCallKit.consumePendingStartCallIntent() (cold start)
// Only INCOMING-call entries (display-name / phone handles) come through here;
// email handles (our outgoing calls) are routed by expo-native-toolkit's
// AppShortcutsAppDelegateSubscriber → onemundomail://assistant-action/call.
// We start the call through the same path as the Calls tab redial
// (voipNative.startOutgoingCall → native call UI).
//
// Safe on every binary: older builds have neither the event nor the
// function, so both resolve to no-ops.

import { Platform, AppState } from 'react-native';

let _installed = false;
let _lastKey = '';
let _unsubEvent = null;
let _appStateSub = null;

let _diag = () => {};
try { _diag = require('./voipDiag').default || (() => {}); } catch {}

function _ck() {
  try { return require('../modules/expo-callkit'); } catch { return null; }
}

async function _handleIntent(intent) {
  if (!intent || typeof intent !== 'object') return;
  const email = String(intent.email || '').trim().toLowerCase();
  const key = `${email}|${intent.handle || ''}|${intent.ts || ''}`;
  if (key === _lastKey) return; // live event + pending read of the same intent
  _lastKey = key;
  if (!email || !email.includes('@')) {
    try { _diag('recents_intent_unresolved', '', { handle: String(intent.handle || '').slice(0, 40) }); } catch {}
    return;
  }
  const name = String(intent.name || '').trim() || email.split('@')[0];
  try { _diag('recents_intent_call', '', { video: !!intent.video }); } catch {}
  try {
    const voipNative = require('./voipNative');
    await voipNative.startOutgoingCall({
      calleeEmail: email,
      calleeName: name,
      isVideo: !!intent.video,
      conversationId: String(intent.conversationId || ''),
    });
  } catch (e) {
    console.warn('[systemCallIntents] startOutgoingCall failed:', e?.message || e);
  }
}

function _drainPending() {
  const ck = _ck();
  if (!ck || typeof ck.consumePendingStartCallIntent !== 'function') return;
  try {
    const pending = ck.consumePendingStartCallIntent();
    if (pending) _handleIntent(pending);
  } catch {}
}

export function installSystemCallIntents() {
  if (_installed || Platform.OS !== 'ios') return;
  const ck = _ck();
  if (!ck || typeof ck.consumePendingStartCallIntent !== 'function') return;
  _installed = true;
  try {
    if (typeof ck.onStartCallIntent === 'function') {
      _unsubEvent = ck.onStartCallIntent((data) => {
        // Clear the persisted copy so the foreground drain doesn't replay it.
        try { ck.consumePendingStartCallIntent(); } catch {}
        _handleIntent(data);
      });
    }
  } catch {}
  // Cold start: give auth/WS a moment, then pick up an intent that arrived
  // before JS was listening.
  setTimeout(_drainPending, 1500);
  try {
    _appStateSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') setTimeout(_drainPending, 400);
    });
  } catch {}
}

export function uninstallSystemCallIntents() {
  try { if (typeof _unsubEvent === 'function') _unsubEvent(); } catch {}
  try { _appStateSub?.remove?.(); } catch {}
  _unsubEvent = null;
  _appStateSub = null;
  _installed = false;
}
