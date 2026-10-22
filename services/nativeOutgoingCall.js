// [2026-10-06 native-only outgoing] Headless controller for iOS OUTGOING calls.
//
// Founder: "vamos deixar só nativo" — when the caller taps "Ligar" on iOS, two
// call screens used to stack: the native CallViewController (presented by
// ExpoCallKit.startOutgoingCall) AND the JS /call.js route pushed by
// chat-conversation.js. The native screen already does the signaling
// (CallSignalWs call_invite / call_end), owns the LiveKit Room, publishes
// the mic/camera on answer and wires Mudo / Vídeo / Alto-falante / Encerrar.
// What /call.js still contributed for the CALLER was bookkeeping, not media:
//   - setCallActive(true) so IncomingCallListener doesn't ring over the call
//   - mailWs.setCallActive(true) + the 30s __chatyyCallActive auth-storm guard
//   - call history row (addCallToHistory) + server terminal status
//     (api.callStatus: ended / cancelled) with the duration
// This module keeps exactly that behaviour WITHOUT mounting any UI. Lifecycle
// is driven by the native events the module already emits:
//   onCallAnsweredRemote / onLkTrackSubscribed  → connected (timer start)
//   onCallEnded / onLkDisconnected / WS call_end → ended (history + cleanup)
//
// Rollback switch: flip NATIVE_ONLY_OUTGOING_IOS to false (OTA) and
// chat-conversation.js goes back to pushing /call.js. The flag is ALSO gated
// on the installed native build answering supportsNativeOnlyOutgoing() ===
// true, so an OTA with the flag on cannot strand users on an older binary
// whose native outgoing screen still relied on JS for audio.
//
// [2026-10-06 android-outgoing] Android joins. CallActivity has owned the
// Android caller since #1217 (chat-conversation.js never pushed /call.js on
// Android), so for Android this module only ADDS the bookkeeping above and
// turns any stray /call?isCaller=1 push (app/one.js, deep links) into the
// headless NativeOnlyOutgoingBridge instead of mounting CallScreenInner in
// MainActivity behind the native CallActivity (a second, invisible call UI
// that polled adoptNativeRoom and could re-enter the call). Gated on the
// native build advertising supportsNativeOnlyOutgoing (vc > 580); older
// Android binaries keep today's behaviour (native screen, no JS route, no
// tracker) — never the legacy /call.js push.
import { Platform } from 'react-native';

export const NATIVE_ONLY_OUTGOING_IOS = true;
export const NATIVE_ONLY_OUTGOING_ANDROID = true;

let _ExpoCallKit = null;
function _ck() {
  if (_ExpoCallKit) return _ExpoCallKit;
  try { _ExpoCallKit = require('../modules/expo-callkit'); } catch { _ExpoCallKit = null; }
  return _ExpoCallKit;
}

/** True when THIS device should run outgoing calls native-only:
 *  (iOS or Android) + platform flag on + the installed native build
 *  advertises the capability. */
export function isNativeOnlyOutgoingActive() {
  if (Platform.OS === 'ios') {
    if (!NATIVE_ONLY_OUTGOING_IOS) return false;
  } else if (Platform.OS === 'android') {
    if (!NATIVE_ONLY_OUTGOING_ANDROID) return false;
  } else {
    return false;
  }
  try {
    const ck = _ck();
    return !!(ck && typeof ck.supportsNativeOnlyOutgoing === 'function' && ck.supportsNativeOnlyOutgoing() === true);
  } catch {
    return false;
  }
}

/** True when the native side already published a LiveKit Room for `callId`
 *  (i.e. startOutgoingCall ran and CallViewController is up). Sync, no
 *  side effects — used by call.js to decide "go headless" vs "start native". */
export function nativeOwnsCall(callId) {
  try {
    const ck = _ck();
    const d = ck && typeof ck.getDiagnostics === 'function' ? ck.getDiagnostics() : null;
    // iOS reports `nativeRoomCallId`; Android getDiagnostics() reports the
    // NativeCallRoom id as `lkNativeCallId` (ExpoCallKitModule.kt ~842).
    const owned = d && (d.nativeRoomCallId || d.lkNativeCallId)
      ? String(d.nativeRoomCallId || d.lkNativeCallId) : '';
    return !!callId && owned === String(callId);
  } catch {
    return false;
  }
}

/** callId of the Room the native singleton currently owns ('' if none/unknown). */
function _nativeRoomCallId() {
  try {
    const ck = _ck();
    const d = ck && typeof ck.getDiagnostics === 'function' ? ck.getDiagnostics() : null;
    return d && (d.nativeRoomCallId || d.lkNativeCallId) ? String(d.nativeRoomCallId || d.lkNativeCallId) : '';
  } catch {
    return '';
  }
}

// ─── Tracker ────────────────────────────────────────────────────────────────

const _sessions = new Map(); // callId → session

function _diag(evt, callId, detail) {
  try {
    const { voipDiag } = require('./voipDiag');
    if (typeof voipDiag === 'function') voipDiag('js_native_only_' + evt, callId, detail);
  } catch {}
}

function _setCallActiveFlags(active, callId) {
  try {
    const icl = require('../components/IncomingCallListener');
    if (typeof icl.setCallActive === 'function') icl.setCallActive(active, callId);
  } catch {}
  try {
    const mailWs = require('./websocket').default;
    mailWs?.setCallActive?.(active);
  } catch {}
  try {
    if (typeof globalThis !== 'undefined') {
      if (active) {
        globalThis.__chatyyCallActive = true;
        if (globalThis.__chatyyCallActiveClearTimer) {
          clearTimeout(globalThis.__chatyyCallActiveClearTimer);
          globalThis.__chatyyCallActiveClearTimer = null;
        }
      } else {
        // Same 30s grace /call.js used (#1165): the post-call WS settle must
        // not tip the auth-failure streak into a logout.
        if (globalThis.__chatyyCallActiveClearTimer) clearTimeout(globalThis.__chatyyCallActiveClearTimer);
        globalThis.__chatyyCallActiveClearTimer = setTimeout(() => {
          try {
            globalThis.__chatyyCallActive = false;
            globalThis.__chatyyCallActiveClearTimer = null;
          } catch {}
        }, 30000);
      }
    }
  } catch {}
}

/**
 * Start tracking a native-only outgoing call. Idempotent per callId.
 * @param {{callId:string, calleeEmail:string, calleeName?:string, isVideo?:boolean, conversationId?:string}} p
 */
export function track(p) {
  const callId = String(p?.callId || '');
  if (!callId || _sessions.has(callId)) return;
  const ck = _ck();
  const s = {
    callId,
    calleeEmail: String(p.calleeEmail || ''),
    calleeName: String(p.calleeName || p.calleeEmail || ''),
    isVideo: !!p.isVideo,
    conversationId: p.conversationId ? String(p.conversationId) : '',
    startedAt: Date.now(),
    connectedAt: 0,
    // [2026-10-10 call-states] first remote media (LK track subscribed). The
    // history duration counts from here (WhatsApp: from media, not accept);
    // connectedAt (= answered) is the fallback when media came via P2P.
    mediaAt: 0,
    ended: false,
    unsubs: [],
    safetyTimer: null,
  };
  _sessions.set(callId, s);
  _setCallActiveFlags(true, callId);
  _diag('track', callId, { video: s.isVideo });

  const matches = (data) => {
    const id = data?.callId || data?.call_id || data?.room_id || '';
    return !id || String(id) === callId; // onLk* events carry no callId
  };
  const onConnected = (why) => {
    if (s.ended || s.connectedAt) return;
    s.connectedAt = Date.now();
    _diag('connected', callId, { why });
  };
  const onEnded = (why, reason) => {
    if (s.ended) return;
    s.ended = true;
    _diag('ended', callId, { why, reason: reason || '', connected: !!s.connectedAt });
    try { require('./callStaleGuard').noteCallEnded(callId, 'out_' + why); } catch {}
    // [2026-10-22 stalecall] call_1792672771124_ah9s2jvah: o caller (Android, rede ruim)
    // desligou e o call_end do CallSignalWs NATIVO nunca chegou ao hub (socket meio-morto);
    // o call_status=cancelled HTTP só chegou 24 s depois → o callee tocou esse tempo todo.
    // O socket JS estava vivo (presença 1 s depois). Gêmeo do fim pelo WS JS, NA HORA (o hub
    // já tem o estado pelo convite nativo; fim repetido = DUP-DROP lá). Só quando o fim é
    // nosso (não ecoa um fim que veio do outro lado). Kill: __chatyy_out_end_twin_off.
    if ((why === 'native_call_ended' || why === 'safety_90s') && !globalThis.__chatyy_out_end_twin_off) {
      try {
        const mailWs = require('./websocket').default;
        const r = String(reason || '').toLowerCase();
        if (mailWs?.send && !/declin|reject|busy|remote/.test(r)) {
          mailWs.send({
            type: 'call_end',
            call_id: callId,
            ...(s.conversationId ? { conversation_id: s.conversationId } : {}),
            ...(s.calleeEmail ? { target_email: s.calleeEmail.toLowerCase() } : {}),
            reason: reason || (s.connectedAt ? 'hangup' : 'cancelled'),
          });
          _diag('end_twin_ws', callId, { connected: !!s.connectedAt });
        }
      } catch {}
    }
    _finish(s, reason);
  };

  try {
    if (ck?.onLkEvent) {
      s.unsubs.push(ck.onLkEvent('onCallAnsweredRemote', (d) => { if (matches(d)) onConnected('ws_accepted'); }));
      s.unsubs.push(ck.onLkEvent('onLkTrackSubscribed', (d) => {
        if (!matches(d)) return;
        if (!s.mediaAt && !s.ended) s.mediaAt = Date.now(); // [2026-10-10 call-states]
        onConnected('remote_track');
      }));
      s.unsubs.push(ck.onLkEvent('onLkDisconnected', (d) => {
        if (!matches(d)) return;
        // [2026-10-12 call-review] onLk* events carry no callId and the native
        // Room is a singleton: when ANOTHER call's room (glare / 2nd incoming
        // presented over this one) disconnected, this tracker ended a live
        // call and wrote it as 1 s (call_1791817906844_jx79nhhuc: 'ended
        // lk_disconnected remote_ended' while its own room stayed up).
        const owner = _nativeRoomCallId();
        if (owner && owner !== callId) { _diag('lk_disc_other_room', callId, { owner }); return; }
        onEnded('lk_disconnected', d?.reason);
      }));
      s.unsubs.push(ck.onLkEvent('onCallDeclinedRemote', (d) => { if (matches(d)) onEnded('declined_remote', 'declined'); }));
    }
    if (ck?.onCallEnded) {
      // [2026-10-09 system-hold] older binaries emit onCallEnded {held:true}
      // on a CallKit hold — a held call is still live.
      s.unsubs.push(ck.onCallEnded((d) => { if (d && d.held) return; if (matches(d)) onEnded('native_call_ended', d?.reason); }));
    }
  } catch {}
  try {
    const mailWs = require('./websocket').default;
    if (mailWs?.on) {
      s.unsubs.push(mailWs.on('call_accepted', (d) => { if (d?.call_id === callId) onConnected('mailws_accepted'); }));
      s.unsubs.push(mailWs.on('call_end', (d) => { if (d?.call_id === callId) onEnded('mailws_call_end', d?.reason); }));
    }
  } catch {}
  // Safety: never leak a tracker. Native hard-caps the ring at 45s; an
  // answered call can run for hours, so only reap when nothing confirmed a
  // connection in 90s (ring timeout + margin).
  s.safetyTimer = setTimeout(() => {
    if (!s.ended && !s.connectedAt) onEnded('safety_90s', 'timeout');
  }, 90000);
}

export function isTracking(callId) {
  return _sessions.has(String(callId || ''));
}

function _finish(s, reason) {
  try { if (s.safetyTimer) clearTimeout(s.safetyTimer); } catch {}
  s.safetyTimer = null;
  for (const u of s.unsubs) { try { typeof u === 'function' && u(); } catch {} }
  s.unsubs = [];
  _sessions.delete(s.callId);
  _setCallActiveFlags(false, s.callId);
  // [conectando 2026-10-20] fim da ligação → WS sondado/reaberto + filas acordadas
  try { require('./sendWorker').onCallEnded?.('call_end_native'); } catch {}

  // [2026-10-10 call-states] duration from first media (fallback: answer).
  const _t0 = s.mediaAt || s.connectedAt;
  const dur = _t0 ? Math.max(0, Math.round((Date.now() - _t0) / 1000)) : 0;
  // History row — same shape /call.js wrote (ChatCallsTab.addCallToHistory).
  try {
    const chatCallsTab = require('./callHistoryStore');
    if (typeof chatCallsTab.addCallToHistory === 'function') {
      chatCallsTab.addCallToHistory({
        contactEmail: s.calleeEmail,
        contactName: s.calleeName,
        callId: s.callId,
        type: 'outgoing',
        video: s.isVideo,
        timestamp: Date.now(),
        duration: dur,
      }).catch(() => {});
    }
  } catch {}
  // Server terminal status — closes ended_at so the row never stays 'active'.
  try {
    const api = require('./api');
    // [2026-10-10 call-states] answered but the 25s no-media watchdog ended it.
    // [2026-10-11 call-parity] Never answered: a REMOTE refusal (call_end
    // reason declined/busy/rejected — via WS, or native "remote_declined")
    // is 'declined', not 'cancelled'. Writing 'cancelled' here overwrote the
    // hub's 'declined' (call_1791738657050_lmfydnfdt: caller=cancelled,
    // callee=missed after a CallKit decline).
    const _r = String(reason || '').toLowerCase();
    const _refused = /declin|reject|busy/.test(_r);
    const terminal = s.connectedAt
      ? ((_r === 'failed' && !s.mediaAt) ? 'failed' : 'ended')
      : (_refused ? 'declined' : 'cancelled');
    // [2026-10-15 call-open-fast] The screen now opens before chat_call_invite_v2
    // returns. A hangup inside that window must reach the server AFTER the
    // invite (the 'cancelled' relay to the callee — WS call_end + VoIP/FCM
    // cancel — needs the invite's history rows), and a failed late invite must
    // not fall back to call_notify for a call that is already over.
    let vn = null;
    try { vn = require('./voipNative'); } catch {}
    try { vn?.noteOutgoingEnded?.(s.callId); } catch {}
    const send = () => { api.callStatus?.(s.callId, terminal, dur).catch(() => {}); };
    const wait = vn?.whenInviteSettled ? vn.whenInviteSettled(s.callId) : null;
    if (wait && typeof wait.then === 'function') wait.then(send, send); else send();
  } catch {}
  try { if (globalThis.__chatyyLastCallInviteId === s.callId) delete globalThis.__chatyyLastCallInviteId; } catch {}
  // [2026-10-12 call-review] "Como foi a ligação?" (sampled, ≥ 20 s of media).
  if (s.mediaAt || s.connectedAt) {
    try { require('./callQualityPrompt').noteCallEnded({ callId: s.callId, durationSec: dur, video: s.isVideo, role: 'caller' }); } catch {}
  }
  void reason;
}
