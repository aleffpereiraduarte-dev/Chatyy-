/**
 * ongoingCall.js — [2026-10-11 ongoing-call] "Is there a live call right now?"
 *
 * Used by the chat composer to block recording voice / video notes while a
 * call (minimized or not) owns the microphone — the recorder would fight the
 * call's audio session (iOS .voiceChat / Android MODE_IN_COMMUNICATION) and
 * either mute the call or record silence. WhatsApp shows a short notice too.
 *
 * Sources (any → true):
 *   - native call snapshot (iOS CallViewController / GroupCallViewController,
 *     Android CallActivity / GroupCallActivity) via call-state-reader;
 *   - the JS call (web /call.js, SIP) registered in components/ActiveCallBar.
 */
import { Platform } from 'react-native';
import { getCurrentCallSnapshotSync } from './call-state-reader';

export function isCallOngoing() {
  try {
    const snap = getCurrentCallSnapshotSync();
    if (snap && snap.callId && snap.ringState !== 'ended') return true;
  } catch {}
  try {
    const { getActiveCall } = require('../components/ActiveCallBar');
    // Mobile: a JS-registered call is only trusted while the call-active
    // marker is up (a minimized /call.js that never cleared must not block
    // voice notes forever).
    if (getActiveCall && getActiveCall()
      && (Platform.OS === 'web' || (typeof globalThis !== 'undefined' && globalThis.__chatyyCallActive))) return true;
  } catch {}
  return false;
}

export default { isCallOngoing };
