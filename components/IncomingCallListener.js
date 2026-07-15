import { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Platform, Animated, Easing, Dimensions, AppState } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { IconPhone, IconVideo, IconX, IconPhoneOff, IconVerifiedBadge } from './Icons';
import AvatarCircle from './AvatarCircle';
import { startRingtone, stopRingtone } from '../services/ringtone';
import { stopAllAudio } from '../services/audioManager';
import { ensureContactIndex, lookupName as lookupDeviceContactName } from '../services/deviceContactLookup';

// [WAVE 104F] Call telemetry — best-effort, never throws.
let _callDiagAppend = () => {};
try { _callDiagAppend = require('../services/callDiag').callDiagAppend; } catch {}

// Lazy-load to break circular dependency with ChatCallsTab
let addCallToHistory = () => {};
const initAddCallToHistory = (() => {
  let loaded = false;
  return () => {
    if (!loaded) {
      const chatCallsTab = require('./ChatCallsTab');
      addCallToHistory = chatCallsTab.addCallToHistory;
      loaded = true;
    }
  };
})();

// Lazy-load callkeep only on native platforms. Use a single object ref so
// Hermes minifier doesn't TDZ on individual `let` bindings (incident:
// "Property 'callKeepEnd' doesn't exist" silently swallowed entire module load
// on Android, blocking native incoming call screen).
const callKeep = {
  endCall: () => {},
  dismissIncomingCall: () => {},
  addCallKeepListeners: () => () => {},
  addIncomingCallListener: () => () => {},
  consumePendingCall: () => null,
  displayIncomingCall: () => false,
};

// Cold-start diagnostic — fire-and-forget POST to backend at each step
// so we can trace the call accept flow on iPhone without needing Mac/Console.
let voipDiag = () => {};
try { voipDiag = require('../services/voipDiag').default; } catch {}

if (Platform.OS !== 'web') {
  try {
    const ck = require('../services/callkeep');
    if (ck.endCall) callKeep.endCall = ck.endCall;
    if (ck.dismissIncomingCall) callKeep.dismissIncomingCall = ck.dismissIncomingCall;
    if (ck.addCallKeepListeners) callKeep.addCallKeepListeners = ck.addCallKeepListeners;
    if (ck.addIncomingCallListener) callKeep.addIncomingCallListener = ck.addIncomingCallListener;
    if (ck.consumePendingCall) callKeep.consumePendingCall = ck.consumePendingCall;
    if (ck.displayIncomingCall) callKeep.displayIncomingCall = ck.displayIncomingCall;
  } catch (e) {
    console.warn('[IncomingCallListener] Failed to load callkeep:', e.message);
  }
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Global callback so push notifications can trigger the incoming call UI
let _triggerIncomingCall = null;
// Buffer for incoming call data when component isn't mounted yet (cold start from push)
let _pendingCallTrigger = null;

// [WAVE 161B 2026-05-24 group-answer gap; #1359 routing fix 2026-05-25]
// Detect a group call from the incoming payload so the answer routes to the
// LiveKit multi-cam grid at /group-call (grid + active-speaker + add-member)
// instead of /call, which only renders a single full-screen remote video.
// Backend stamps is_group='1' + type='incoming_group_call' + group_name.
// Without this the answerer of a group call only saw the first peer.
function _payloadIsGroupCall(d) {
  if (!d) return false;
  return d.is_group === '1' || d.is_group === true || d.is_group === 1
    || d.type === 'incoming_group_call'
    || (typeof d.group_name === 'string' && d.group_name.length > 0);
}

export function triggerIncomingCall(data) {
  // Don't force-reset _callActive: a real call already in progress must
  // suppress further triggers (was a primary contributor to the double-UI
  // bug — Codex GPT-5.5-pro #842).
  if (_callActive) {
    console.log('[IncomingCall] trigger ignored: call already active');
    return;
  }
  // [WAVE 104F] Telemetry tap — incoming push/WS trigger received.
  try { _callDiagAppend('info', 'incoming call trigger received', { call_id: data?.call_id || data?.room_id, caller: data?.caller_email, platform: Platform.OS }); } catch {}
  if (_triggerIncomingCall) {
    _triggerIncomingCall(data);
  } else {
    // Component not mounted yet (app cold-starting from push notification)
    // Buffer the data — component will pick it up when it mounts
    _pendingCallTrigger = { data, timestamp: Date.now() };
  }
}

// Global callback to dismiss the incoming call UI (used when push notification accepts/declines)
let _dismissIncomingCall = null;
export function dismissIncomingCall() {
  _pendingCallTrigger = null; // Clear any buffered call
  if (_dismissIncomingCall) _dismissIncomingCall();
}

// Global store for pending SDP offer (avoids URL param size limits).
// Keyed by call_id so a stale offer from a previous call can't be applied
// to a new PeerConnection — same fix that ICE candidates already had.
let _pendingOfferSdp = null;
let _pendingOfferType = null;
let _pendingOfferCallId = null;
export function getPendingOffer(expectedCallId) {
  if (!_pendingOfferSdp) return null;
  if (expectedCallId && _pendingOfferCallId && expectedCallId !== _pendingOfferCallId) {
    return null;
  }
  const offer = { sdp: _pendingOfferSdp, type: _pendingOfferType || 'offer' };
  _pendingOfferSdp = null;
  _pendingOfferType = null;
  _pendingOfferCallId = null;
  return offer;
}

// Clear pending offer (used by call_end handler so a stale SDP from a
// rejected/missed call can't leak into the next incoming call).
export function clearPendingOffer() {
  _pendingOfferSdp = null;
  _pendingOfferType = null;
  _pendingOfferCallId = null;
}

// Global store for TURN credentials from call_offer (used by callee in call.js)
let _pendingTurnCredentials = null;
export function getPendingTurnCredentials() {
  const creds = _pendingTurnCredentials;
  _pendingTurnCredentials = null;
  return creds;
}

// Global store for ICE candidates that arrive before call.js mounts.
// Keyed by call_id so candidates from a previous call don't bleed into a
// new call's PeerConnection (codex finding: candidates were stored as a
// flat array, so a stale candidate from call A could be applied to call B
// and break ICE).
const _pendingIceByCallId = new Map();
export function getPendingIceCandidates(callId) {
  if (callId == null) {
    // Backwards compat: drain everything if caller didn't provide an id.
    const all = [];
    for (const list of _pendingIceByCallId.values()) all.push(...list);
    _pendingIceByCallId.clear();
    return all;
  }
  const list = _pendingIceByCallId.get(String(callId)) || [];
  _pendingIceByCallId.delete(String(callId));
  return list;
}
function _bufferPendingIce(callId, candidate) {
  if (callId == null) return;
  const k = String(callId);
  let list = _pendingIceByCallId.get(k);
  if (!list) { list = []; _pendingIceByCallId.set(k, list); }
  if (list.length < 100) list.push(candidate);
}

// Flag to suppress IncomingCallListener when a call is active in call.js.
// No time-based auto-reset: a long call (1h+) used to silently re-enable
// the listener and double-show incoming UI mid-call. Lifecycle is the only
// thing that may flip this back to false.
let _callActive = false;
let _activeCallId = null;
// Callback set by the mounted component so external code (call.js teardown)
// can reset the internal `acceptedRef` / `handlingRef`. Without this, after a
// call ends the refs stayed `true` forever and the next incoming `call_invite`
// hit the "already handling" early-return and never rendered the in-app
// overlay — symptom: iOS user with app open hears nothing, sees no UI.
let _resetCallHandlingState = null;
export function setCallActive(active, callId = null) {
  const prev = _callActive;
  _callActive = !!active;
  // Scope active flag to a specific callId so subsequent invites for the
  // SAME call don't get rejected, but invites for a DIFFERENT call also
  // don't slip through while the first is live. Codex GPT-5.5-pro #842.
  if (_callActive && callId) _activeCallId = String(callId);
  if (!_callActive && (!callId || !_activeCallId || String(callId) === _activeCallId)) {
    _activeCallId = null;
  }
  // When transitioning from active → inactive (call ended), clear handling
  // refs so the next incoming call can render its Modal/overlay.
  if (prev && !_callActive && typeof _resetCallHandlingState === 'function') {
    try { _resetCallHandlingState(); } catch {}
  }
  // [#1165 2026-05-18] Mirror the call-active state to a globalThis flag
  // so services/websocket.js auth_error handler can suppress streak
  // escalation during the call. Stays true while we're ringing or in-call;
  // /call.js owns the 30s post-call decay timer via its own useEffect.
  try {
    if (typeof globalThis !== 'undefined') {
      if (_callActive) {
        globalThis.__chatyyCallActive = true;
        if (globalThis.__chatyyCallActiveClearTimer) {
          clearTimeout(globalThis.__chatyyCallActiveClearTimer);
          globalThis.__chatyyCallActiveClearTimer = null;
        }
      }
      // Note: don't clear on (active=false) here — call.js arms a 30s
      // decay timer that owns the off-transition. This avoids a race where
      // /call.js's setCallActive(false) on unmount races against the
      // listener's setCallActive(false) on accept-handled and clobbers
      // the post-call protection window.
    }
  } catch {}
}
export function isCallActive(callId = null) {
  if (!_callActive) return false;
  if (!callId || !_activeCallId) return true;
  return String(callId) === _activeCallId;
}

// Dismiss any native Android incoming-call UI (CallRingingService foreground
// notification, IncomingCallActivity full-screen overlay, CallNotificationService
// tagged notif). JS owns the UI when AppState=active; this kills races where
// FCM data-message landed before the foreground guard had AppState=active.
// Codex GPT-5.5-pro #842 — primary cause of double UI.
function dismissNativeIncomingUi(callId) {
  if (Platform.OS !== 'android' || !callId) return;
  try { callKeep.dismissIncomingCall?.(String(callId)); } catch {}
  // Legacy native builds do not have dismissIncomingCall; fall back to
  // endCall which also cancels notification + stops CallRingingService.
  try { callKeep.endCall?.(String(callId)); } catch {}
  try {
    const Notifications = require('expo-notifications');
    Notifications.dismissAllNotificationsAsync?.();
  } catch {}
}

// [bug 2026-05-15 native-call-disconnect-before-answer]
// AppState.currentState lags 50–500ms behind reality when IncomingCallActivity
// launches via fullScreenIntent over the keyguard — RN's app-state listener
// still reports `active` while MainActivity is actually background and the
// native ring screen is the canonical UI. The retry-dismiss loop below was
// then nuking IncomingCallActivity BEFORE the user could tap Atender (call
// vanished right after appearing). Gate on the native CallRingingService
// flag instead: if it's running, JS must NOT dismiss — that's the canonical
// UI. ExpoCallKit.getDiagnostics is sync (Function, not AsyncFunction).
function isNativeRingingActive() {
  if (Platform.OS !== 'android') return false;
  try {
    const ExpoCallKit = require('../modules/expo-callkit');
    const diag = ExpoCallKit.getDiagnostics?.();
    return !!(diag && diag.ringingServiceActive);
  } catch {
    return false;
  }
}

// [WAVE 141] Mobile = native ONLY (CallKit on iOS / IncomingCallActivity on
// Android). Web/desktop still needs the JS path since browsers have no native
// call surface. The wrapper bails BEFORE any hook executes so the React
// rules-of-hooks invariant holds — the inner component (the one with hooks +
// modal + ringtone wiring) only ever mounts on web.
export default function IncomingCallListener() {
  if (Platform.OS !== 'web') {
    // [WAVE 141] WhatsApp arch: native owns call UI, no JS modal on mobile.
    return null;
  }
  return <IncomingCallListenerWeb />;
}

function IncomingCallListenerWeb() {
  // [#992 Stage 4 — retire JS incoming-call modal on mobile]
  // The native CallKit UI (iOS via PushKit + CXProvider) and the
  // IncomingCallActivity full-screen overlay (Android via the priority=10
  // FCM CallFirebaseMessagingService + CallRingingService) now own the
  // entire incoming-call ringing UX on mobile. The JS-side Modal was
  // overlapping the native screen and causing the "double UI" bug
  // (Codex #842 + user reports of black modal flashing over CallKit).
  //
  // Web stays on the JS path because Service Workers can't show a
  // full-screen call UI on the desktop browser.
  //
  // Native already wires WS call_answered → AppDelegate / ExpoCallKitModule
  // emitCallAnswered, so no extra JS plumbing is needed for mobile —
  // bailing out before any hooks/listeners run is safe.
  //
  // Note on hooks: Platform.OS is stable for the lifetime of the JS VM,
  // so this early-return never reorders hook calls across renders of the
  // same mounted instance — React's rules-of-hooks invariant holds.
  // [WhatsApp-parity hybrid restore, 2026-05-22]
  // User mandate: "quando a ligacao e feita e o app ta aberto nos n
  // prescisamos de nativo, so se o app tiver minimizado ou fechado ai
  // o nativo atende a chamada abre o app e vc ver a ligacao la iqual
  // whatsapp".
  //
  // Routing matrix:
  //   - Web: always JS (no native CallKit available).
  //   - Mobile + AppState=active: JS in-app modal owns the ringing UI.
  //     Native CallKit/IncomingCallActivity is still reported (iOS REQUIRES
  //     reportNewIncomingCall within ~2s of PKPushRegistry payload — see
  //     Phase 2 Swift change which auto-fulfills CXAnswerCallAction +
  //     dismisses the UI in this case). Android: IncomingCallActivity's
  //     onCreate self-finishes when foreground (Phase 2 Kotlin change).
  //   - Mobile + AppState=background/inactive: native owns the UI.
  //     When user taps Accept on the native screen, AppDelegate / IncomingCall-
  //     Activity bring the app to foreground and emit onCallAnswered → the
  //     existing onAnswer handler below navigates to /call.js.
  //
  // History:
  //   - WAVE 113 tried foreground=JS hybrid → reverted (WAVE 117) due to
  //     dual-mount bugs (both JS modal AND native screen visible).
  //   - The double-UI fix is now belt-and-suspenders: native side suppresses
  //     itself when foreground (Phase 2) + JS side calls
  //     dismissNativeIncomingUi on call_invite (existing) + isNativeRinging-
  //     Active guard prevents JS from killing real ringing native UI.
  //
  // Implementation: we DON'T early-return; we let all the WS / CallKit
  // listeners wire up (so background→foreground transition picks up active
  // ringing). The render block at the bottom gates the modal on
  // AppState.currentState — when background, render null (native owns UI).
  // The AppState change listener forces a re-render so the modal pops up
  // the moment the app comes to foreground while a call is still ringing.
  const [appState, setAppState] = useState(AppState.currentState);
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppState(s));
    return () => { try { sub.remove(); } catch {} };
  }, []);

  const { colors } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [call, setCall] = useState(null);
  const callStateRef = useRef(null); // Ref to avoid stale closure in CallKit callbacks
  const timeoutRef = useRef(null);

  // Animations
  const fadeAnim = useRef(new Animated.Value(0)).current;
  const ring1 = useRef(new Animated.Value(0)).current;
  const ring2 = useRef(new Animated.Value(0)).current;
  const ring3 = useRef(new Animated.Value(0)).current;
  const acceptScale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!call) return;
    // [WAVE 140 WhatsApp arch]: mobile NUNCA toca ringtone JS — native owns
    // audio (CallKit on iOS / IncomingCallActivity on Android always plays
    // the system ringtone, regardless of AppState). The JS modal is a pure
    // visual mirror on mobile; only render audio when the platform has no
    // native call surface (web) or native explicitly ceded UI ownership.
    const jsOwns = Platform.OS === 'web' || call?.uiOwner === 'js';
    if (!jsOwns) {
      stopRingtone();
      // Still proceed with fade-in / pulse animations below — mobile JS
      // modal may render as a passive UI mirror (depending on Fix 2 render
      // gate further down), but it must NEVER produce audio.
    } else {
      stopAllAudio();
      startRingtone();
    }

    // Fade in
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: false }).start();

    // Pulsing rings (staggered)
    const createPulse = (anim, delay) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.timing(anim, { toValue: 1, duration: 2000, easing: Easing.out(Easing.ease), useNativeDriver: false }),
          ]),
          Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: false }),
        ])
      );
    };

    const p1 = createPulse(ring1, 0);
    const p2 = createPulse(ring2, 600);
    const p3 = createPulse(ring3, 1200);
    p1.start();
    p2.start();
    p3.start();

    // Accept button gentle pulse
    const acceptPulse = Animated.loop(
      Animated.sequence([
        Animated.timing(acceptScale, { toValue: 1.1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
        Animated.timing(acceptScale, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: false }),
      ])
    );
    acceptPulse.start();

    return () => {
      p1.stop();
      p2.stop();
      p3.stop();
      acceptPulse.stop();
      // [WAVE 138] BUG-2: cleanup runs on call=null AND on appState change
      // (since appState is now a dep). When app goes background mid-ring,
      // cleanup → stopRingtone() kills the JS ringtone; the next effect run
      // skips startRingtone() because shouldPlayJsRingtone is false. When
      // app comes back to foreground while still ringing, the effect runs
      // again and starts JS ringtone (native has already stopped its own
      // because the JS modal is now responsible for the foreground UI).
      stopRingtone();
      fadeAnim.setValue(0);
      ring1.setValue(0);
      ring2.setValue(0);
      ring3.setValue(0);
    };
  }, [call?.call_id /* appState removed — native gate, WAVE 140 */]);

  const showCall = (data) => {
    // Accept both old format (room_id) and new format (call_id)
    if (!data?.call_id && !data?.room_id) {
      console.log('[IncomingCall] showCall: no call_id/room_id, ignoring');
      return;
    }
    const normalizedCallId = String(data.call_id || data.room_id);
    if (_callActive && (!_activeCallId || _activeCallId !== normalizedCallId)) {
      console.log('[IncomingCall] showCall ignored: active call in progress (other callId)');
      return;
    }
    console.log('[IncomingCall] showCall: caller=' + (data.caller_email || '?') + ' call_id=' + normalizedCallId);
    // [gap H3 2026-05-20] Silence unknown callers. Async gate that runs
    // BEFORE we touch the ringer / show any UI:
    //   1. read AsyncStorage `silence_unknown_callers` flag (default OFF)
    //   2. if ON: check whether the caller is in device contacts OR in
    //      chat_phone_registry friends (via check_contacts).
    //   3. if NEITHER: fire `chat_call_status` decline silently and log
    //      to history with auto_declined=true so the user sees "Silenciado
    //      automaticamente" badge.
    // We deliberately swallow all errors → fall through to the normal
    // ring path. The gate is opt-in; a misbehaving lookup must never
    // block legitimate calls.
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const flag = await AsyncStorage.getItem('silence_unknown_callers');
        if (flag !== 'true' && flag !== '1') return;
        const callerEmail = String(data.caller_email || '').toLowerCase();
        const callerPhone = String(data.caller_phone || '');
        if (!callerEmail && !callerPhone) return;
        // 2a. Device contacts (warmed index — lookupName returns null when
        // not in contacts, a string when matched).
        let known = false;
        try {
          if (callerPhone) {
            const localName = lookupDeviceContactName(callerPhone);
            if (localName) known = true;
          }
        } catch {}
        // 2b. chat_phone_registry friend check via backend (also returns
        // 'has_chatyy' style metadata we ignore here — we only care if
        // backend says this contact is a saved friend of mine).
        if (!known) {
          try {
            const api = require('../services/api');
            if (typeof api.checkContacts === 'function') {
              const r = await api.checkContacts(
                callerEmail ? [callerEmail] : [],
                callerPhone ? [callerPhone] : [],
              );
              const list = r?.data?.contacts || r?.data?.results || r?.data || [];
              if (Array.isArray(list)) {
                for (const c of list) {
                  // Backend marks saved friends with is_friend / saved /
                  // has_chatyy + matches. Treat any positive flag as known.
                  if (c?.is_friend || c?.saved || c?.is_contact) { known = true; break; }
                }
              }
            }
          } catch {}
        }
        if (known) return;
        // [WAVE 138] BUG-3 FIX: race window. The async contact lookup
        // above can take 200-1500ms (device contact index warm-up +
        // backend check_contacts round-trip). During that gap the user
        // may have already tapped Accept on the JS Modal OR on the
        // native CallKit/IncomingCallActivity. If we proceed blindly,
        // we send chat_call_status=declined, killing a call that the
        // user just answered. Re-check both flags AFTER the await
        // chain and abort if either has flipped:
        //   - acceptedRef.current → JS-side accept already fired
        //   - callStateRef.current?.callId !== normalizedCallId → a new
        //     incoming call replaced this one, or the call was cleared.
        const _curCallId = callStateRef.current?.call_id || callStateRef.current?.room_id;
        if (acceptedRef.current || (_curCallId && String(_curCallId) !== normalizedCallId)) {
          try {
            console.log('[IncomingCall][WAVE 138] silence-unknown: aborted post-await', {
              accepted: acceptedRef.current,
              expected: normalizedCallId,
              current: _curCallId,
            });
          } catch {}
          return;
        }
        // 3. Unknown caller — auto-decline silently.
        try {
          const api = require('../services/api');
          if (typeof api.callStatus === 'function') {
            api.callStatus(normalizedCallId, 'declined', 0).catch(() => {});
          }
        } catch {}
        // Mark history with auto_declined so the UI surfaces a chip.
        try {
          initAddCallToHistory();
          addCallToHistory({
            contactEmail: callerEmail,
            contactName: data.caller_name || callerEmail?.split('@')[0] || '',
            callId: normalizedCallId,
            type: 'missed',
            video: !!data.video,
            timestamp: new Date().toISOString(),
            duration: 0,
            auto_declined: true,
          }).catch(() => {});
        } catch {}
        // Clear all in-flight ringing state and dismiss native UI.
        try { stopRingtone(); } catch {}
        try { callRef.current = null; } catch {}
        callStateRef.current = null;
        if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
        setCall(null);
        acceptedRef.current = false;
        handlingRef.current = false;
        try {
          const { endCall } = require('../services/callkeep');
          endCall(normalizedCallId, 'declinedElsewhere');
        } catch {}
        console.log('[IncomingCall] silence-unknown: auto-declined', callerEmail || callerPhone);
      } catch (e) {
        // Never let the gate break legitimate calls.
        if (__DEV__) console.warn('[IncomingCall] silence-unknown gate err:', e?.message);
      }
    })();
    // Reset flags for new ringing call
    acceptedRef.current = false;
    handlingRef.current = false;

    // Android: trigger native full-screen IncomingCallActivity over keyguard
    // ONLY when app is not foreground. JS Modal is canonical when foreground;
    // starting the native UI here while also rendering the Modal is the
    // primary cause of double UI (Codex #842).
    if (Platform.OS === 'android' && AppState.currentState !== 'active') {
      try {
        callKeep.displayIncomingCall(
          normalizedCallId,
          data.caller_name || data.caller_email || 'Chatyy',
          data.caller_email || '',
          !!data.video,
          data.conversation_id || '',
        );
      } catch (e) {
        console.warn('[IncomingCall] Android displayIncomingCall failed:', e?.message);
      }
    } else if (Platform.OS === 'android') {
      // Foreground: JS modal is canonical. Kill any native FCM UI that raced
      // in — BUT only if CallRingingService isn't actually running. If it is,
      // the native screen is the canonical UI (AppState reports stale during
      // fullScreenIntent transitions) and dismissing it would kill the call
      // before the user can answer. See isNativeRingingActive helper above.
      if (!isNativeRingingActive()) dismissNativeIncomingUi(normalizedCallId);
    }
    /* legacy _callActiveTimer removed in favor of explicit lifecycle */

    callStateRef.current = data;
    setCall(data);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      // Timed out without answering - log as missed
      const c = callStateRef.current;
      if (c && !acceptedRef.current) {
        initAddCallToHistory();
        addCallToHistory({
          contactEmail: c.caller_email || '',
          contactName: c.caller_name || c.caller_email?.split('@')[0] || '',
          callId: c.call_id || c.room_id || '',
          type: 'missed',
          video: !!c.video,
          timestamp: new Date().toISOString(),
          duration: 0,
        }).catch(() => {});
      }
      stopRingtone();
      callStateRef.current = null;
      setCall(null);
    }, 45000);
  };

  // Register global trigger for push notifications
  // Wire user email into voipDiag so backend log lines are attributable
  useEffect(() => {
    try {
      const setUser = require('../services/voipDiag').setVoipDiagUser;
      if (typeof setUser === 'function') setUser(user?.email || '');
      voipDiag('listener_mounted', '', { hasUser: !!user?.email });
    } catch {}
  }, [user?.email]);

  // Expose a reset callback so call.js's setCallActive(false) can clear the
  // sticky handling refs when a call ends. Without this, accepting one call
  // permanently blocked the in-app incoming overlay for every subsequent call
  // (iOS foreground bug: nothing rendered when someone called).
  useEffect(() => {
    _resetCallHandlingState = () => {
      acceptedRef.current = false;
      handlingRef.current = false;
    };
    return () => { _resetCallHandlingState = null; };
  }, []);

  // Warm the phone→name suffix index on mount so when a call comes in we can
  // synchronously swap a raw number for the saved contact name during the
  // first render (no flicker). Cheap: cached + no network. Fires once per
  // listener lifecycle.
  useEffect(() => { ensureContactIndex().catch(() => {}); }, []);

  // [P0 2026-05-18 #1132] Eagerly open the native CallSignalWs so the OS-
  // level ring (CallKit on iOS, CallRingingService on Android) fires for
  // inbound `call_invite` frames even if the JS WS handler chain is broken/
  // paused/lazy. Belt-and-suspenders against the regression where the
  // callee's app received the WS frame but never rendered the modal.
  // Idempotent; safe to call on every mount + foreground transition.
  useEffect(() => {
    if (Platform.OS === 'web' || !user?.email) return;
    const warm = () => {
      try {
        const ck = require('../modules/expo-callkit');
        if (typeof ck.warmCallSignalWs === 'function') ck.warmCallSignalWs();
      } catch {}
    };
    warm();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') warm();
    });
    return () => { try { sub.remove(); } catch {} };
  }, [user?.email]);

  useEffect(() => {
    _triggerIncomingCall = (data) => {
      if (data?.caller_email === user?.email) return;
      showCall(data);
    };
    // Allow push notification handler to dismiss the call UI
    _dismissIncomingCall = () => {
      stopRingtone();
      if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
      callStateRef.current = null;
      handlingRef.current = true; // Block any late accept/decline
      acceptedRef.current = true;
      setCall(null);
      // Clear the global "pause everything" flag so resumed views can play
      // again. Components polling the flag will see false on next render.
      try {
        if (typeof globalThis !== 'undefined') globalThis.__chatyy_pauseAllPlayback = false;
      } catch {}
    };

    // Check for buffered call from push notification (app was cold-starting)
    if (_pendingCallTrigger && (Date.now() - _pendingCallTrigger.timestamp < 30000)) {
      const pendingData = _pendingCallTrigger.data;
      _pendingCallTrigger = null;
      if (pendingData?.caller_email !== user?.email) {
        console.log('[IncomingCall] Processing buffered call from push:', pendingData?.caller_email);
        setTimeout(() => showCall(pendingData), 500); // Small delay for app to finish loading
      }
    } else {
      _pendingCallTrigger = null;
    }

    return () => { _triggerIncomingCall = null; _dismissIncomingCall = null; };
  }, [user?.email]);

  const handlingRef = useRef(false);
  const acceptedRef = useRef(false); // Prevents handleDecline from running after accept
  // Timestamp of last CXAnswerCallAction fulfill on iOS. Used by onEnd handler
  // to ignore CXEndCallAction races that iOS fires <3s after answer (typically
  // an audio-session activation race that triggers CallKit's auto-end-on-fail
  // path). Without this guard, the user taps Accept → call instantly shows
  // "Ligação encerrada" because the spurious onEnd tears down the WebRTC PC
  // and sends WS call_end to the caller, who then hangs up.
  const lastAnswerAtRef = useRef(0);
  // call_id → timestamp of last WS call_end we sent. Used to dedup the
  // call_end spam (8x in 3s observed in WS server logs after CallKit's
  // spurious onEnd cascade).
  const callEndSentRef = useRef({});
  // Use refs for handlers so CallKit callbacks always get latest version
  const handleAcceptRef = useRef(null);
  const handleDeclineRef = useRef(null);

  // Listen for call invitations via WebSocket
  useEffect(() => {
    if (!user?.email) return;
    let unsubs = [];
    try {
      const mailWs = require('../services/websocket').default;

      const callRef = { current: null }; // track current call for closure

      // call_invite — NO SDP yet
      unsubs.push(mailWs.on('call_invite', (data) => {
        voipDiag('ws_call_invite_received', data?.call_id || data?.room_id || '', {
          caller_email: data?.caller_email || '',
          accepted: acceptedRef.current,
          handling: handlingRef.current,
          callActive: _callActive,
          alreadyHaveSameCall: !!(callRef.current && callRef.current.call_id === (data?.call_id || data?.room_id)),
        });
        // Telegram/WhatsApp parity: the moment a call invite hits the wire,
        // any voice/music/video in the app should pause so the ringtone
        // isn't competing with media. Doing it here (instead of in the
        // useEffect[call]) lets components listening on the global flag
        // mute *before* the modal mounts, which avoids a 100-300ms gap
        // where audio + ringtone overlap on slow devices.
        try {
          if (typeof globalThis !== 'undefined') globalThis.__chatyy_pauseAllPlayback = true;
        } catch {}
        try { stopAllAudio(); } catch {}

        // If already accepted/handling (e.g. CallKit), still capture caller data but don't show UI
        // CRITICAL: acceptedRef/handlingRef can leak across calls — they're set to true
        // when CallKit answer / handleAccept runs, but never reset when /call ends
        // (call.js only flips _callActive). On the NEXT incoming call (foreground or
        // not), this branch early-returned and the Modal never rendered. Fix: if the
        // refs say "handling" but _callActive is false (no real call in progress) AND
        // we have no different live call in callRef, treat the refs as stale and reset
        // so this new call_invite falls through to showCall.
        const sameCallId = callRef.current && callRef.current.call_id === (data?.call_id || data?.room_id);
        if ((acceptedRef.current || handlingRef.current) && !_callActive && !sameCallId) {
          console.log('[IncomingCall] call_invite: refs stale (no active call), resetting and falling through');
          voipDiag('ws_call_invite_reset_stale_refs', data?.call_id || '', {
            accepted: acceptedRef.current, handling: handlingRef.current,
          });
          acceptedRef.current = false;
          handlingRef.current = false;
          callRef.current = null;
        } else if (acceptedRef.current || handlingRef.current) {
          console.log('[IncomingCall] call_invite: accepted/handling, updating callStateRef only');
          if (data?.caller_email && data?.call_id) {
            // Update callStateRef with richer WS data (has caller_email, conversation_id, caller_phone)
            callStateRef.current = {
              ...(callStateRef.current || {}),
              caller_email: data.caller_email,
              caller_name: data.caller_name || callStateRef.current?.caller_name || '',
              caller_phone: data.caller_phone || callStateRef.current?.caller_phone || '',
              conversation_id: data.conversation_id || callStateRef.current?.conversation_id || '',
              call_id: data.call_id || data.room_id,
              room_id: data.room_id || data.call_id,
              video: data.video,
            };
          }
          return;
        }
        // If a different call is genuinely active, suppress this invite —
        // the previous force-reset was a primary contributor to double-UI
        // and stale-state bugs (Codex GPT-5.5-pro #842). The stale-refs
        // branch above already handles refs left over from teardown.
        if (_callActive && !sameCallId) {
          // [call-waiting busy-signal, OTA-only 2026-06-28] A 2nd call_invite
          // arrived while a *different* call is already live. Previously we just
          // returned, leaving the 2nd caller ringing until their ~45s timeout.
          // We can't do native hold/accept over OTA (that's a separate build),
          // but we CAN immediately tell the 2nd caller we're busy by reusing the
          // exact decline transport already used by handleDecline / auto-decline:
          //   1. a WS call_end aimed at that caller (stops their ring NOW), and
          //   2. a backend call_status=declined safety net.
          // reason='declined' is the proven value the WS server already accepts
          // on the normal decline path (busy is just a flavor of decline here).
          const busyCallId = data?.call_id || data?.room_id || '';
          const busyTarget = data?.caller_email || '';
          voipDiag('ws_call_invite_skipped', busyCallId, {
            reason: 'active_call',
            busy_signal: !!(busyCallId && busyTarget && busyTarget !== user.email),
          });
          if (busyCallId && busyTarget && busyTarget !== user.email) {
            try {
              if (mailWs.isConnected) {
                mailWs._send({
                  type: 'call_end',
                  call_id: busyCallId,
                  target_email: busyTarget,
                  reason: 'declined',
                });
              }
            } catch {}
            try {
              const api = require('../services/api');
              if (typeof api.callStatus === 'function') {
                api.callStatus(busyCallId, 'declined', 0).catch(() => {});
              }
            } catch {}
            // Optional local heads-up so the user knows someone tried to call.
            try {
              if (Platform.OS === 'android') {
                const ToastAndroid = require('react-native').ToastAndroid;
                if (ToastAndroid) {
                  ToastAndroid.show('Ligação recebida durante chamada', ToastAndroid.SHORT);
                }
              }
            } catch {}
          }
          return;
        }
        if ((!data?.room_id && !data?.call_id) || data.caller_email === user.email) {
          voipDiag('ws_call_invite_skipped', data?.call_id || '', { reason: 'self_or_no_id' });
          return;
        }
        // Deduplicate: ignore if we already have this call
        if (callRef.current && callRef.current.call_id === (data.call_id || data.room_id)) {
          voipDiag('ws_call_invite_skipped', data?.call_id || '', { reason: 'duplicate' });
          return;
        }
        const callData = {
          ...data,
          call_id: data.call_id || data.room_id,
          room_id: data.room_id || data.call_id,
        };
        callRef.current = callData;
        voipDiag('ws_call_invite_show_modal', callData.call_id);
        // [#1175 follow-up 2026-05-19] Fast-path: pre-fetch LiveKit JWT in
        // background AND seed the native LkTokenFetcher cache so when the user
        // accepts (native IncomingCallActivity → CallActivity), the cache hit
        // skips the HTTP round-trip entirely. Without this seed, the native
        // path falls into LkTokenFetcher.doFetch — and if resolveAuth can't
        // find the bearer across SharedPreferences/Intent/AsyncStorage (e.g.
        // expo_callkit_prefs was never written by an older login, or the
        // accept fires before AuthContext hydration's persistAuthForNativeCall
        // landed), the user sees the "Sessao expirada — abra o app" banner
        // even though their session is perfectly valid.
        //
        // Two critical alignments vs the previous code:
        //   1. Room name must match what native uses on its own fetch path.
        //      services/voipNative.js (outgoing) and LkTokenFetcher (incoming)
        //      both pass the raw `call_id` as the room. Previously this
        //      prefetch used `call_${call_id}` which only fed the dead
        //      globalThis path consumed by /call.js — that left the native
        //      cache empty and produced two LK rooms (caller vs callee).
        //   2. Persist into the NATIVE cache via ExpoCallKit.persistPendingLkToken
        //      so LkTokenFetcher.getCached(callId) hits on accept. The legacy
        //      globalThis stash is kept as a no-op safety net for any web
        //      fallback paths.
        try {
          const api = require('../services/api');
          const convId = Number(callData.conversation_id) || 0;
          const room = callData.call_id; // raw call_id — matches native room name
          api.chatLivekitToken?.(convId, room).then(res => {
            const d = res?.data || res;
            if (d?.token) {
              const tok = d.token;
              const url = d.url || d.livekitUrl || 'wss://livekit.chatyy.com.br';
              // Seed native cache (Android LkTokenFetcher / iOS NativeCallTokenFetcher)
              if (Platform.OS !== 'web') {
                try {
                  const ck = require('../modules/expo-callkit');
                  if (typeof ck?.persistPendingLkToken === 'function') {
                    ck.persistPendingLkToken(callData.call_id, tok, url).catch(() => {});
                  }
                } catch {}
              }
              // Legacy JS-side stash (kept for web fallback paths).
              try { globalThis.__chatyy_prefetched_lk_token = {
                call_id: callData.call_id,
                token: tok,
                url,
                room,
                iceServers: Array.isArray(d.iceServers) ? d.iceServers : [],
                ts: Date.now(),
              }; } catch {}
              voipDiag('lk_token_prefetched', callData.call_id);
            }
          }).catch(() => {});
        } catch {}
        // [bug #842 regression 2026-05-14] FCM data message can race the WS
        // call_invite: FCM may have already fired CallRingingService showing
        // the native IncomingCallActivity full-screen overlay BEFORE our
        // CallFirebaseMessagingService foreground guard had AppState=active.
        // When WS call_invite arrives and app is foreground, JS owns the UI —
        // force-dismiss any native ring service / notification that may have
        // slipped through so the user only sees ONE incoming-call screen.
        // FCM data-message can race the WS call_invite: native ring service
        // may have shown IncomingCallActivity full-screen BEFORE the foreground
        // guard had AppState=active. When app is foreground, JS owns the UI —
        // dismiss the native UI on a retry ladder (defeats FCM-after-WS races).
        // [bug 2026-05-15] Skip dismiss entirely if CallRingingService is
        // running — that means the native screen IS the canonical UI (user
        // about to tap Atender). The 50-500ms AppState lag was making this
        // branch fire while IncomingCallActivity was on top, killing the
        // ring screen before the user could answer.
        if (Platform.OS === 'android' && AppState.currentState === 'active' && !isNativeRingingActive()) {
          dismissNativeIncomingUi(callData.call_id);
          setTimeout(() => { if (!isNativeRingingActive()) dismissNativeIncomingUi(callData.call_id); }, 250);
          setTimeout(() => { if (!isNativeRingingActive()) dismissNativeIncomingUi(callData.call_id); }, 800);
          setTimeout(() => { if (!isNativeRingingActive()) dismissNativeIncomingUi(callData.call_id); }, 1800);
        }
        showCall(callData);
      }));

      // WebRTC call_offer — has the actual SDP
      unsubs.push(mailWs.on('call_offer', (data) => {
        if (!data?.call_id || data.caller_email === user.email) return;
        // Mirror call_invite handling: pause active media even if call_offer
        // arrived first (some signaling paths skip call_invite entirely).
        try {
          if (typeof globalThis !== 'undefined') globalThis.__chatyy_pauseAllPlayback = true;
        } catch {}
        try { stopAllAudio(); } catch {}
        const sdpType = data.sdp_type || data.type || 'offer';
        // Always store SDP even if _callActive (CallKit accepted, call.js needs it)
        if (data.sdp) {
          _pendingOfferSdp = data.sdp;
          _pendingOfferType = sdpType;
          _pendingOfferCallId = data.call_id;
          if (data.turn_credentials) _pendingTurnCredentials = data.turn_credentials;
        }
        if (_callActive) return; // Don't show UI if already in a call

        // If we already have a call_invite showing, update it with SDP
        if (callRef.current && callRef.current.call_id === data.call_id) {
          callRef.current.offer_sdp = data.sdp;
          callRef.current.offer_type = sdpType;
          // Preserve caller_phone if missing on this update
          if (!callRef.current.caller_phone && data.caller_phone) {
            callRef.current.caller_phone = data.caller_phone;
          }
          callStateRef.current = { ...callRef.current };
          setCall({ ...callRef.current });
        } else {
          const callData = {
            call_id: data.call_id,
            caller_email: data.caller_email,
            caller_name: data.caller_name,
            caller_phone: data.caller_phone || '',
            conversation_id: data.conversation_id,
            video: data.video,
            offer_sdp: data.sdp,
            offer_type: sdpType,
          };
          callRef.current = callData;
          showCall(callData);
        }
      }));

      // Buffer ICE candidates that arrive before call.js mounts.
      // Indexed per call_id so candidates from one call can never bleed
      // into another's PeerConnection.
      unsubs.push(mailWs.on('call_ice', (data) => {
        if (!data?.candidate || !data?.call_id) return;
        _bufferPendingIce(data.call_id, data.candidate);
      }));

      // Backend refused the offer because parental controls block the call
      // (caller or callee is a kid in bedtime / calls disabled / contact
      // not whitelisted). Dismiss any ringing UI on the callee side and
      // bail out cleanly on the caller side.
      unsubs.push(mailWs.on('call_blocked', (data) => {
        if (callRef.current?.call_id === data?.call_id) {
          if (data?.call_id) _pendingIceByCallId.delete(String(data.call_id));
          callRef.current = null;
          callStateRef.current = null;
          stopRingtone();
          // Clear the 45s auto-missed timer so the timeout closure can't fire
          // afterwards and log a *second* missed entry (or a missed entry for
          // a call that was actually blocked, not missed).
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          setCall(null);
          acceptedRef.current = false;
          handlingRef.current = false;
        }
        // The caller's own call.js can listen on mailWs for the same event
        // (we just leave the broadcast pass-through; webrtc.js also emits a
        // 'blocked' event from its handler).
      }));

      // Dismiss incoming call on other sessions (user accepted on another device/tab)
      // [multi-device dismiss, 2026-05-19] WS-GO handleCallAnswered +
      // handleCallAccepted both fan this event out with
      // reason='answered_elsewhere' to every OTHER session of the answerer.
      // Without the endCall() below, the OS-level incoming UI (CallKit on
      // iOS, IncomingCallActivity full-screen on Android) keeps showing
      // even though the JS-side modal/ringtone is cleared — user reported
      // "se eu atender em um dispositivo, o outro continua tocando".
      unsubs.push(mailWs.on('call_dismissed', (data) => {
        // [multi-device answered_elsewhere] The backend now fans call_dismissed
        // to BOTH devices of the callee — including the one that just answered.
        // If THIS device already accepted this exact call, ignore its own
        // dismiss so it doesn't tear down the freshly-answered call.
        if (acceptedRef.current && callRef.current?.call_id === data?.call_id) { return; }
        if (callRef.current?.call_id === data?.call_id) {
          console.log('[IncomingCall] call_dismissed received:', data.call_id, 'reason=' + (data?.reason || 'n/a'));
          if (data?.call_id) _pendingIceByCallId.delete(String(data.call_id));
          callRef.current = null;
          callStateRef.current = null;
          stopRingtone();
          // Cancel the auto-missed timer — call was handled elsewhere, so we
          // mustn't insert a phantom "missed" row 45s later.
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          setCall(null);
          acceptedRef.current = false; // Reset for next call
          handlingRef.current = false;
          // Force-dismiss the native incoming UI. endCall fires
          // CXEndCallAction on iOS (ProviderDelegate also calls
          // reportCall(...endedReason:.answeredElsewhere) internally via
          // CXEndCallAction's CXCallEndedReason resolution) and broadcasts
          // expo.modules.callkit.CLOSE_CALL_ACTIVITY on Android which
          // IncomingCallActivity.kt listens for via its IntentFilter →
          // finish().
          if (data?.reason === 'answered_elsewhere' && data?.call_id) {
            // Mark so the resulting onEnd echo doesn't send WS call_end
            // back to the caller (would tear down the call that the SIBLING
            // device just answered).
            callEndSentRef.current[String(data.call_id)] = Date.now();
          }
          try {
            const { endCall } = require('../services/callkeep');
            endCall(data?.call_id || '');
          } catch (_) {}
        }
      }));

      // Multi-device dedupe: server fires call_picked_up_elsewhere to every
      // other session of the user that just answered. Treat it like
      // call_dismissed but also force-dismiss the native incoming UI
      // (Android IncomingCallActivity + iOS CallKit) so a backgrounded
      // device doesn't keep ringing/showing the full-screen accept overlay.
      unsubs.push(mailWs.on('call_picked_up_elsewhere', (data) => {
        if (callRef.current?.call_id === data?.call_id) {
          console.log('[IncomingCall] call_picked_up_elsewhere:', data.call_id);
          if (data?.call_id) _pendingIceByCallId.delete(String(data.call_id));
          callRef.current = null;
          callStateRef.current = null;
          stopRingtone();
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          setCall(null);
          acceptedRef.current = false;
          handlingRef.current = false;
          // [bug 2026-05-14 caller-drops-on-answer]
          // The endCall below triggers iOS CXEndCallAction on the call this
          // device already answered, which fires our onEnd handler — which
          // would then send WS call_end {reason:'hangup'} to the CALLER,
          // tearing the call down right after answer. Mark this callId as
          // "we just sent end" so the dedup window at line ~974 suppresses
          // that spurious onEnd echo before it can hit the wire.
          if (data?.call_id) {
            callEndSentRef.current[String(data.call_id)] = Date.now();
          }
          // Best-effort native dismiss. The Expo modules-API names are
          // `ExpoCallKit.endCall` (both platforms — Android also broadcasts
          // CLOSE_CALL_ACTIVITY to drop the full-screen overlay, iOS calls
          // CXProvider.reportCall(.endedReason: .answeredElsewhere)).
          // The legacy NativeModules.IncomingCallModule / CallKitModule paths
          // never existed in this project; calling them was a silent no-op.
          try {
            const { endCall } = require('../services/callkeep');
            // [gap H5 2026-05-20] dispatch reason — answeredElsewhere ⇒
            // 'declinedElsewhere' (CallKit also maps to the same enum
            // via the native side).
            endCall(data?.call_id || '', 'declinedElsewhere');
          } catch (_) {}
        }
      }));

      // [Wave D, 2026-05-18] Caller hit "Cancel" before we picked up.
      // Backend chat_call_cancel fans out a `call_cancel` event to every
      // active WS session of the callee (and a silent VoIP+FCM push to the
      // offline ones). Treat it exactly like call_dismissed so the ringer
      // stops and the modal goes away on every device the callee owns.
      // Idempotent: if the server is on an older build that doesn't emit
      // this event, the existing call_end handler still covers the hangup
      // path via WS — this is purely additive for multi-device parity.
      unsubs.push(mailWs.on('call_cancel', (data) => {
        // [multi-device answered_elsewhere] Same guard as call_dismissed: the
        // device that already accepted this call must ignore its own cancel/
        // dismiss fan-out so the just-answered call isn't torn down.
        if (acceptedRef.current && callRef.current?.call_id === data?.call_id) { return; }
        if (callRef.current?.call_id === data?.call_id) {
          console.log('[IncomingCall] call_cancel (caller-aborted ring):', data.call_id);
          if (data?.call_id) _pendingIceByCallId.delete(String(data.call_id));
          callRef.current = null;
          callStateRef.current = null;
          stopRingtone();
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          setCall(null);
          acceptedRef.current = false;
          handlingRef.current = false;
          // Dismiss native CallKit (iOS) / IncomingCallActivity (Android)
          // — without this the OS keeps the lock-screen UI even after the
          // JS state clears (build 503-505 race).
          try {
            const { endCall } = require('../services/callkeep');
            // [gap H5 2026-05-20] reason — caller cancelled before answer.
            endCall(data?.call_id || '', 'remoteEnded');
          } catch (_) {}
        }
      }));

      // [Wave D, 2026-05-18] Server-issued missed-call (30s ring timeout).
      // The Go WS state machine fires `call_missed` when a RINGING call
      // never reached ACCEPTED within CallRingTimeout. The CALLER's
      // sessions see this so the "Calling..." overlay teardown happens
      // even if the callee never replied with WS call_end (e.g. offline
      // the whole time). The CALLEE side just clears its rung state.
      unsubs.push(mailWs.on('call_missed', (data) => {
        if (callRef.current?.call_id === data?.call_id) {
          console.log('[IncomingCall] call_missed from server:', data.call_id);
          const c = callRef.current;
          if (c && !acceptedRef.current) {
            initAddCallToHistory();
            addCallToHistory({
              contactEmail: c.caller_email || '',
              contactName: c.caller_name || c.caller_email?.split('@')[0] || '',
              callId: c.call_id || c.room_id || '',
              type: 'missed',
              video: !!c.video,
              timestamp: new Date().toISOString(),
              duration: 0,
            }).catch(() => {});
          }
          if (data?.call_id) _pendingIceByCallId.delete(String(data.call_id));
          callRef.current = null;
          callStateRef.current = null;
          stopRingtone();
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          setCall(null);
          acceptedRef.current = false;
          handlingRef.current = false;
          try {
            const { endCall } = require('../services/callkeep');
            // [gap H5 2026-05-20] reason — server-issued ring timeout.
            endCall(data?.call_id || '', 'unanswered');
          } catch (_) {}
        }
      }));

      // Safety timeout: auto-dismiss call after user accepts on another device (network might be slow)
      // If we receive call_accepted from ANOTHER device on our email, dismiss automatically
      unsubs.push(mailWs.on('call_accepted', (data) => {
        // This is for when ANOTHER device accepts a call we were receiving
        // Only process if it's NOT our device (i.e., someone else accepted)
        if (callRef.current?.call_id === data?.call_id && data.email && data.email === user?.email && !acceptedRef.current) {
          console.log('[IncomingCall] Another device accepted:', data.email);
          if (data?.call_id) _pendingIceByCallId.delete(String(data.call_id));
          callRef.current = null;
          callStateRef.current = null;
          stopRingtone();
          // Cancel auto-missed timer — answered on another device.
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          setCall(null);
          acceptedRef.current = false;
          handlingRef.current = false;
        }
      }));

      // If the caller ends before we answer
      unsubs.push(mailWs.on('call_end', (data) => {
        if (callRef.current?.call_id === data?.call_id && !acceptedRef.current) {
          // Caller ended before we answered - log as missed
          const c = callRef.current;
          if (c) {
            initAddCallToHistory();
            addCallToHistory({
              contactEmail: c.caller_email || '',
              contactName: c.caller_name || c.caller_email?.split('@')[0] || '',
              callId: c.call_id || c.room_id || '',
              type: 'missed',
              video: !!c.video,
              timestamp: new Date().toISOString(),
              duration: 0,
            }).catch(() => {});
          }
          if (data?.call_id) _pendingIceByCallId.delete(String(data.call_id));
          // Clear stashed SDP so a stale offer can't be replayed onto the
          // next call's PeerConnection.
          if (_pendingOfferCallId === data?.call_id) {
            _pendingOfferSdp = null;
            _pendingOfferType = null;
            _pendingOfferCallId = null;
          }
          callRef.current = null;
          callStateRef.current = null;
          stopRingtone();
          // CRITICAL: cancel the 45s auto-missed timer. Without this, both
          // call_end and the timer fire addCallToHistory(type:'missed'), so the
          // user saw the same missed call twice in the Calls tab whenever the
          // caller hung up while the ringer was still active.
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }
          setCall(null);
        }
      }));
    } catch {}

    // CallKit native listeners — iOS via VoIP/CallKit, Android via
    // IncomingCallActivity over keyguard. Both platforms emit onAnswer/onEnd
    // through the same ExpoCallKit event channel.
    let cleanupCallKeep = () => {};
    let cleanupIncomingCall = () => {};
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      // Listen for VoIP push incoming call event
      // ALWAYS populate callStateRef (needed for accept handler)
      // [bug 2026-05-15 #5] Removed the foreground endCall path. Apple's
      // PushKit contract is "always report to CallKit, always honor the
      // user's CallKit answer/decline action" — auto-ending CallKit when
      // app is foreground caused two well-known regressions:
      //   1) On the FIRST call after install / cold-start, the JS Modal
      //      may not be mounted yet (cleanupIncomingCall runs before the
      //      Modal listener); the call dies on both paths and the user
      //      sees "missed call".
      //   2) On Android the app sometimes reports `appState === 'active'`
      //      while IncomingCallActivity is on top (50-500ms race), which
      //      ended the call before the user could even tap Accept.
      // Strategy now: leave CallKit alive, let the JS Modal sit ABOVE the
      // native CallKit screen when foreground (CallKit shows once the JS
      // Modal is dismissed via user action), and rely on CallKit as the
      // single source of truth for accept/decline.
      cleanupIncomingCall = callKeep.addIncomingCallListener((data) => {
        console.log('[IncomingCall] CallKit onIncomingCall, callId=' + data.callId);
        // Only populate callStateRef if WS hasn't already set it with richer data
        // (WS call_invite has caller_email, conversation_id etc — VoIP push may not)
        if (!callStateRef.current || !callStateRef.current.caller_email) {
          const callData = {
            call_id: data.callId,
            room_id: data.callId,
            caller_email: data.callerEmail || '',
            caller_name: data.callerName || '',
            conversation_id: data.conversationId || '',
            video: data.hasVideo,
          };
          callStateRef.current = callData;
          console.log('[IncomingCall] onIncomingCall: populated callStateRef (no WS data yet)');
        } else {
          console.log('[IncomingCall] onIncomingCall: WS already populated callStateRef, keeping it');
        }
      });

      cleanupCallKeep = callKeep.addCallKeepListeners({
        onAnswer: async (data) => {
          console.log('[IncomingCall] CallKit onAnswer, callId=' + data.callId);
          voipDiag('answer_fired', data.callId, {
            data_callerEmail: data?.callerEmail || '',
            data_callerName: data?.callerName || '',
            data_conversationId: data?.conversationId || '',
            data_hasVideo: data?.hasVideo || false,
            ref_caller_email: callStateRef.current?.caller_email || '',
            ref_call_id: callStateRef.current?.call_id || '',
          });
          // Mark as accepted immediately to block decline and WS call_invite
          acceptedRef.current = true;
          handlingRef.current = true;
          lastAnswerAtRef.current = Date.now();
          setCallActive(true, data?.callId || callStateRef.current?.call_id || null);
          stopRingtone();

          // [bug 2026-05-15 #6] Removed JS-side audio pre-arming on iOS.
          // The previous block called ExpoAudioSession.activateForVideoCall
          // / activateForCall (which do setCategory + setActive) plus the
          // react-native-webrtc RTCAudioSession.audioSessionDidActivate
          // path — both racing CallKit's own provider:didActivate that
          // fires after action.fulfill(). Three competing audio-session
          // owners in a 200-800ms window produced the "answered but no
          // audio" / "call drops immediately" bugs.
          //
          // The native CallKit path now owns the AVAudioSession lifecycle:
          //   - AppDelegate.swift   pre-arms useManualAudio=true
          //   - ExpoCallKitModule's provider:didActivate forwards to
          //     RTCAudioSession (audioSessionDidActivate + setIsActive +
          //     setIsAudioEnabled=true) so WebRTC engine sees the active
          //     session before addTrack runs.
          //   - LiveKit-side: app/_layout.js calls registerGlobals with
          //     autoConfigureAudioSession=false; /call gates Room.connect
          //     on the onCallKitAudioActivated event for callee path.

          // Android: dismiss IncomingCallActivity now that user accepted from
          // the native screen. Without this, the full-screen Activity lingers
          // over /call. iOS CallKit auto-dismisses, so skip there.
          if (Platform.OS === 'android') {
            try { callKeep.endCall(data.callId); } catch {}
          }

          // Use callStateRef if available (populated by onIncomingCall), otherwise use event data
          const currentCall = callStateRef.current;
          const callId = currentCall?.call_id || data.callId || '';
          const callerName = currentCall?.caller_name || data.callerName || '';
          const callerEmail = currentCall?.caller_email || data.callerEmail || '';
          const isVideo = (currentCall?.video || data.hasVideo) ? '1' : '0';
          const conversationId = currentCall?.conversation_id || data.conversationId || '';

          console.log('[IncomingCall] CallKit accept: callId=' + callId + ' caller=' + callerEmail);

          // Dismiss system notifications
          try {
            const Notifications = require('expo-notifications');
            Notifications.dismissAllNotificationsAsync();
          } catch {}

          // Clear UI state but DON'T clear callStateRef yet (WS call_invite may update it)
          setCall(null);
          if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }

          // ALWAYS force a clean WS reconnect — the socket may be dead even if
          // isConnected says true (iOS kills sockets in background, JS doesn't know).
          // On cold-start from a VoIP push, mailWs.token is null because the
          // app never got to log in + init WS. Fall back to the persisted
          // auth token so we can connect anyway — without this the WS stays
          // off, call_accepted never fires, and the offer SDP never arrives,
          // so the call dies at the 10s timeout.
          const mailWs = require('../services/websocket').default;
          // Token retry with backoff: cold-start from VoIP push wakes the
          // app while AsyncStorage / SecureStore can still be locked. The
          // OS can take 1-3s to hydrate secure storage on iPhones with low
          // memory pressure or after a reboot — the previous 3-attempt
          // window (700ms total) was racing real-world cold-start latency
          // and the WS never connected, leaving the call screen with no
          // SDP and the user staring at a frozen screen until the 30s
          // timeout fired and the screen "disappeared". Bumped to 10
          // attempts with stepped delays totalling ~10s so even a slow
          // boot has time to surface the token.
          let wsToken = null;
          const _delays = [0, 250, 400, 600, 900, 1200, 1500, 1800, 2100, 2500];
          for (let attempt = 0; attempt < _delays.length && !wsToken; attempt++) {
            if (_delays[attempt] > 0) await new Promise(r => setTimeout(r, _delays[attempt]));
            try { wsToken = mailWs.token; } catch {}
            if (!wsToken) {
              try {
                const api = require('../services/api');
                wsToken = api.getToken?.() || api.getAuthToken?.() || null;
              } catch {}
            }
            if (!wsToken) {
              try {
                const SecureStore = require('expo-secure-store');
                wsToken = await SecureStore.getItemAsync('mail_token').catch(() => null);
              } catch {}
            }
            // AsyncStorage fallback — older sessions stored token there
            // before the SecureStore migration. Without this, returning
            // users on stale builds couldn't answer calls at all.
            if (!wsToken) {
              try {
                const AsyncStorage = require('@react-native-async-storage/async-storage').default;
                wsToken = await AsyncStorage.getItem('mail_token').catch(() => null);
              } catch {}
            }
            if (wsToken) console.log('[IncomingCall] Token found on attempt ' + (attempt + 1));
          }
          voipDiag('token_retry_done', callId, { hasToken: !!wsToken, alreadyConnected: !!mailWs.isConnected });
          // Only force a clean reconnect if the WS is actually dead. Killing a
          // healthy socket here was making us lose the call_invite that the
          // caller had just sent — Go WS's call state is keyed by client id,
          // and a brand-new client doesn't see the prior RINGING state. Result:
          // accept goes through but caller never sees `call_accepted` because
          // the iPhone briefly disappears between cleanup() and reconnect().
          if (mailWs.isConnected) {
            console.log('[IncomingCall] WS already connected, reusing existing socket');
            voipDiag('ws_reused_existing', callId);
          } else if (wsToken) {
            console.log('[IncomingCall] Forcing clean WS reconnect, hasToken=true');
            // ensureHealthy() short-circuits if socket is already healthy on this
            // token; otherwise it does the cleanup+destroyed=false+reconnectAttempt=0
            // +connect dance atomically without fighting MailContext's WS effect
            // or resetting backoff state. (Reconnect storm fix 2026-05-19.)
            voipDiag('ws_connect_called', callId);
            mailWs.ensureHealthy(wsToken);
          } else {
            voipDiag('no_token', callId);
            console.warn('[IncomingCall] No auth token available after 3 retries — call cannot connect WS');
            // Still navigate so the call screen can show "Sem conexao" instead
            // of the user sitting on a blank CallKit accept-then-nothing.
          }

          // [WAVE 109 2026-05-21] Decouple navigation from WS call_accepted.
          // ROOT CAUSE of "Não foi possível conectar": CallKit answer fires
          // here, WS is dead (cold-start / background socket killed by iOS).
          // Old code waited for mailWs.isConnected BEFORE navigating — if WS
          // reconnect took >25s, caller's hard-fail timer fired first and the
          // caller saw "A pessoa não atendeu". Callee never even got to /call.
          //
          // Fix: navigate to /call IMMEDIATELY (LK Room.connect() is what
          // matters — WS is optional for LK media). Send call_accepted async
          // in background. Caller detects callee join via LK ParticipantConnected
          // (WhatsApp pattern) so the UI transitions without needing WS ack.
          const doNavigate = () => {
            // Re-read callStateRef — WS call_invite may have updated it with callerEmail
            const updatedCall = callStateRef.current;
            const finalCallerEmail = updatedCall?.caller_email || callerEmail;
            const finalCallerName = updatedCall?.caller_name || callerName;
            const finalConversationId = updatedCall?.conversation_id || conversationId;
            callStateRef.current = null;
            console.log('[IncomingCall] Navigating to call (immediate): email=' + finalCallerEmail);
            // [hybrid 2026-05-16] Push /call.js on all platforms — the rich
            // JS UI is now the visible screen on mobile too. Native CallKit /
            // IncomingCallActivity stay for ringing/lock-screen, but the
            // in-call screen is /call.js with WhatsApp-grade features.
            voipDiag('push_js_call_hybrid', callId);
            // [2026-05-24 hybrid v2] iOS now uses JS /call.js for the rich UI.
            // ExpoCallKitModule.CXAnswer skips CallViewController.present on iOS,
            // and JS adopts the pre-connected NativeCallRoom via adoptNativeRoom.
            // Android keeps native CallActivity for now — only iOS + web push.
            const _routeGroup = _payloadIsGroupCall(updatedCall) || _payloadIsGroupCall(data);
            try { voipDiag('donavigate_reached', callId, { platform: Platform.OS, willPushJs: (Platform.OS === 'web' || Platform.OS === 'ios'), group: _routeGroup }); } catch {}
            if (Platform.OS === 'web' || Platform.OS === 'ios') {
              try { voipDiag('router_push_call', callId, { platform: Platform.OS, group: _routeGroup }); } catch {}
              if (_routeGroup) {
                // [#1359 group-answer routing] /call.js renders only a single
                // full-screen remote video — the answerer of a GROUP call saw
                // just the first peer. /group-call.js has the LiveKit grid +
                // active-speaker + add-member UI. The answerer is a joiner
                // (NOT isCaller), and the backend call_id IS the LK room
                // (`group_<conversationId>`), so pass it straight through as
                // `room`; group-call.js mints its own token for that room.
                router.push(`/group-call?conversation_id=${encodeURIComponent(finalConversationId)}&room=${encodeURIComponent(callId)}&video=${isVideo}`);
              } else {
                router.push(`/call?callId=${encodeURIComponent(callId)}&contactName=${encodeURIComponent(finalCallerName)}&contactEmail=${encodeURIComponent(finalCallerEmail)}&isVideo=${isVideo}&conversationId=${encodeURIComponent(finalConversationId)}&isCaller=0`);
              }
            }
            // Android: native CallActivity (Compose) still owns the UI.
          };

          // Navigate immediately — don't gate on WS connection.
          voipDiag('navigate_immediate_wave109', callId);
          doNavigate();

          // Send call_accepted async in background (best-effort, caller also
          // detects via LK ParticipantConnected as primary signal).
          let attempts = 0;
          let acceptSent = false;
          const poll = () => {
            attempts++;

            if (mailWs.isConnected && !acceptSent) {
              // WS connected — send call_accepted
              // Re-read callerEmail from callStateRef (WS call_invite may have arrived by now)
              const email = callStateRef.current?.caller_email || callerEmail;
              const convId = callStateRef.current?.conversation_id || conversationId;
              console.log('[IncomingCall] BG poll WS connected (attempt ' + attempts + '), sending call_accepted to ' + email);
              voipDiag('ws_connected_sending_accept', callId, { attempts, email, hasEmail: !!email });
              mailWs._send({
                type: 'call_accepted',
                conversation_id: convId,
                call_id: callId,
                target_email: email,
              });
              acceptSent = true;
              voipDiag('accept_sent', callId, { email });
            }

            // Keep polling to send call_accepted for up to 30s even after
            // navigation. Server is idempotent; sends are a no-op after state
            // flips. Caller primary signal is LK ParticipantConnected; WS
            // call_accepted is fallback for older clients + server state.
            if (acceptSent) return; // done
            if (attempts < 60) {
              if (attempts === 1 || attempts === 5 || attempts === 15 || attempts === 30) {
                voipDiag('poll_tick', callId, { attempts, wsConnected: !!mailWs.isConnected, acceptSent });
              }
              setTimeout(poll, 500);
            } else {
              voipDiag('poll_timeout_30s', callId, { acceptSent });
            }
          };
          poll();
        },
        onEnd: (callUUID, eventData) => {
          console.log('[IncomingCall] CallKit onEnd, acceptedRef=' + acceptedRef.current);
          voipDiag('callkit_native_end', eventData?.callId || '', { wasAccepted: acceptedRef.current });

          // [bug 2026-05-14 ios spurious-end-after-answer]
          // CallKit fires CXEndCallAction within 0-2s of CXAnswerCallAction.fulfill()
          // on some iOS audio-session activation races (especially cold-start
          // from VoIP push or after the phone was idle). Without this guard, the
          // user sees "Ligação encerrada" instantly after tapping Aceitar
          // because this handler tears down the WebRTC PC + sends WS call_end
          // to the caller. If the end arrives <3s after answer, drop it.
          if (Platform.OS === 'ios' && acceptedRef.current && lastAnswerAtRef.current > 0) {
            const sinceAnswer = Date.now() - lastAnswerAtRef.current;
            // Bumped 3s → 5s — iOS audio-session activation can race up to ~4s
            // on slower devices / cold-start. Real hangups always happen >5s
            // after answer (user has to look at screen, press End).
            if (sinceAnswer < 5000) {
              console.warn('[IncomingCall] iOS spurious onEnd ' + sinceAnswer + 'ms after answer — IGNORING');
              voipDiag('callkit_spurious_end_ignored', eventData?.callId || '', { sinceAnswer });
              return;
            }
          }
          // [2026-05-15 #977 cold-start phantom decline guard]
          // Android cold-start accept flow: IncomingCallActivity.onAccept fires
          // emitCallAnswered → JS may be in mid-mount, RN bridge not ready.
          // Native then tears down the foreground notification (cancelNotification
          // + stopRingingService), which CAN deliver a phantom deleteIntent →
          // ACTION_DECLINE_CALL → emitCallEnded. Native fixes A+B handle most
          // of this (removed setDeleteIntent + persisted SharedPreferences
          // accept flag), but if a stale legacy build still triggers it OR a
          // newly-cleared notification fires deleteIntent before the persisted
          // flag is observed, this JS guard catches it. We peek (not consume)
          // the pending call via isCallAcceptingPersisted — non-destructive,
          // so handleAndroidPendingCall at +1s still finds the data.
          if (Platform.OS === 'android' && eventData?.callId) {
            try {
              const ExpoCallKit = require('../modules/expo-callkit');
              const persistedAccept = ExpoCallKit.isAcceptingPersisted?.(eventData.callId);
              if (persistedAccept) {
                console.warn('[IncomingCall] Android: ignoring onCallEnded — persisted accept matches', eventData.callId);
                voipDiag('android_phantom_end_ignored', eventData.callId, { source: 'persisted_accept' });
                return;
              }
            } catch {}
          }

          // Dedup: WS-server log shows 8x call_end spam per call (4 from each
          // side fired within 3s). Don't send WS call_end if we just sent one
          // for the same call_id. Keeps caller from receiving N×Encerrada
          // notifications and prevents the "call_accepted REJECTED state=ACCEPTED"
          // server-side spam loop.
          const _lastEndKey = String(eventData?.callId || '');
          if (_lastEndKey) {
            const now = Date.now();
            const sentRecently = (callEndSentRef.current[_lastEndKey] || 0);
            if (sentRecently && (now - sentRecently) < 2000) {
              console.warn('[IncomingCall] dedup call_end <2s for', _lastEndKey);
              return;
            }
            callEndSentRef.current[_lastEndKey] = now;
          }

          // Decide reason based on whether the call was accepted before this
          // end action. CallKit fires onEnd both for "decline ringing call"
          // (red on incoming UI) AND for "hang up active call" (red on
          // in-call UI). Previously we returned early when accepted, which
          // meant pressing red on the active call did nothing — the caller
          // was stuck on "Calling..." and the WS server never got call_end.
          const wasAccepted = acceptedRef.current;
          const reason = wasAccepted ? 'hangup' : 'declined';

          const currentCall = callStateRef.current;
          const callId = (currentCall && (currentCall.call_id || currentCall.room_id)) || eventData?.callId || '';
          const targetEmail = currentCall?.caller_email || eventData?.callerEmail || '';

          // [decline-with-message iOS, 2026-05-17] CallKit doesn't allow
          // injecting custom buttons into the system call UI, so on iOS we
          // surface the quick-reply sheet immediately AFTER the user taps
          // the system decline button. The Activity-side equivalent on
          // Android lives directly in IncomingCallActivity.kt.
          if (Platform.OS === 'ios' && !wasAccepted && callId && targetEmail) {
            try {
              if (typeof globalThis !== 'undefined') {
                globalThis.__chatyyPendingDeclineWithMessage = {
                  callId,
                  toEmail: targetEmail,
                  conversationId: (currentCall && currentCall.conversation_id) || '',
                  ts: Date.now(),
                };
              }
            } catch {}
          }

          if (callId && targetEmail) {
            const sendEnd = () => {
              try {
                const mailWs = require('../services/websocket').default;
                if (mailWs.isConnected) {
                  mailWs._send({
                    type: 'call_end',
                    call_id: callId,
                    target_email: targetEmail,
                    reason,
                  });
                  voipDiag('callkit_native_end_sent', callId, { reason });
                  return true;
                }
              } catch {}
              return false;
            };
            if (!sendEnd()) {
              setTimeout(sendEnd, 1000);
              setTimeout(sendEnd, 3000);
            }
          }

          stopRingtone();
          // Dismiss system notifications
          try {
            const Notifications = require('expo-notifications');
            Notifications.dismissAllNotificationsAsync();
          } catch {}

          // Tear down peer connection so audio/video really stops. Without
          // this, the iPhone kept streaming after hanging up via CallKit
          // because only the CallKit UI dismissed — the WebRTC session was
          // still alive in the JS background.
          try {
            if (typeof globalThis !== 'undefined' && globalThis.__chatyyTeardownActiveCall) {
              globalThis.__chatyyTeardownActiveCall(callId, 'native_end');
            }
          } catch {}

          callStateRef.current = null;
          setCall(null);
          setCallActive(false);
          handlingRef.current = false;
          acceptedRef.current = false;
        },
      });
    }

    // Android: check if a call was accepted from native UI
    // Runs on cold start (mount) AND warm start (app comes to foreground)
    if (Platform.OS === 'android') {
      const handleAndroidPendingCall = () => {
        try {
          const pending = callKeep.consumePendingCall();
          if (pending && pending.callId) {
            console.log('[IncomingCall] Android: found pending accepted call:', pending.callId);
            acceptedRef.current = true;
            handlingRef.current = true;
            setCallActive(true, pending.callId);
            stopRingtone();

            const callId = pending.callId;
            const callerName = pending.callerName || '';
            const callerEmail = pending.callerEmail || '';
            const conversationId = pending.conversationId || '';
            const isVideo = pending.hasVideo ? '1' : '0';

            // Dismiss any visible incoming call UI
            setCall(null);
            if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }

            // [2026-05-15 black-screen fix] Navigate to /call IMMEDIATELY.
            // The previous flow waited for WS reconnect + token hydration
            // before pushing — that took 6–26s on cold start, during which
            // the user stared at a black screen ("Tela preta só quando
            // atendo no push da ligação"). It also caused "atende e
            // desliga": the caller's 30s ring timeout could fire before JS
            // mounted /call, and the phantom-call_end guard (5s window)
            // didn't cover the 10-15s WS-connect delay.
            //
            // New flow: push the route now so the user sees the call UI
            // immediately. WS auth + call_accepted relay happens in the
            // background; /call's connectToRoom will join LiveKit as soon
            // as WS is up.
            //
            // [2026-05-21 "2 sistemas" smoking-gun fix] The previous code
            // pushed /call on EVERY push-accepted incoming call regardless of
            // platform. On mobile, that meant the JS overlay /call screen ran
            // SIMULTANEOUSLY with native CallKit (iOS) / IncomingCallActivity
            // (Android), causing "atende e desliga" + double-audio + black
            // screen reports. Mobile must go ONLY through the native call UI.
            // Web still needs the JS push since there's no native CallKit there.
            if (Platform.OS === 'web') {
              const _routeGroup = _payloadIsGroupCall(pending) || _payloadIsGroupCall(callStateRef.current);
              if (_routeGroup) {
                // [#1359 group-answer routing] Route group answers to the
                // LiveKit grid screen, not the 1:1 single-video /call. Answerer
                // joins (no isCaller); backend call_id IS the LK room.
                router.push(`/group-call?conversation_id=${encodeURIComponent(conversationId)}&room=${encodeURIComponent(callId)}&video=${isVideo}`);
              } else {
                router.push(`/call?callId=${encodeURIComponent(callId)}&contactName=${encodeURIComponent(callerName)}&contactEmail=${encodeURIComponent(callerEmail)}&isVideo=${isVideo}&conversationId=${encodeURIComponent(conversationId)}&isCaller=0&autoAccepted=1`);
              }
            }
            // (mobile already gets full native CallKit / IncomingCallActivity)

            (async () => {
              const mailWs = require('../services/websocket').default;
              let wsToken = null;
              const _delays = [0, 250, 400, 600, 900, 1200, 1500, 1800, 2100, 2500];
              for (let attempt = 0; attempt < _delays.length && !wsToken; attempt++) {
                if (_delays[attempt] > 0) await new Promise(r => setTimeout(r, _delays[attempt]));
                try { wsToken = mailWs.token; } catch {}
                if (!wsToken) {
                  try {
                    const api = require('../services/api');
                    wsToken = api.getToken?.() || api.getAuthToken?.() || null;
                  } catch {}
                }
              }
              try {
                // Guard: skip the connect entirely if WS is already healthy on
                // the right account. handleAndroidPendingCall fires on every
                // AppState `active` transition (300ms after foreground), so an
                // unconditional reconnect here was creating a storm whenever
                // the user just opened the app without a real pending call.
                const currentEmail = (typeof user !== 'undefined' && user && user.email) || mailWs.email;
                const alreadyHealthy = mailWs.isConnected && mailWs.authenticated && currentEmail && mailWs.email === currentEmail;
                if (!alreadyHealthy && wsToken && typeof mailWs.ensureHealthy === 'function') {
                  mailWs.ensureHealthy(wsToken);
                }
              } catch {}
              let acceptSent = false;
              let attempts = 0;
              const trySend = () => {
                attempts++;
                if (acceptSent) return;
                if (mailWs.isConnected) {
                  console.log('[IncomingCall] Android pending: WS connected, sending call_accepted to ' + callerEmail);
                  mailWs._send({
                    type: 'call_accepted',
                    call_id: callId,
                    conversation_id: conversationId,
                    target_email: callerEmail,
                  });
                  acceptSent = true;
                  return;
                }
                if (attempts < 60) setTimeout(trySend, 500);
              };
              trySend();
            })();
            return true;
          }
        } catch (e) {
          console.warn('[IncomingCall] Android pending call check error:', e);
        }
        return false;
      };

      // Check on cold start (1s delay for app init)
      setTimeout(handleAndroidPendingCall, 1000);

      // Check when app returns to foreground (warm start — user tapped "Atender" while app was in background)
      const appStateListener = AppState.addEventListener('change', (nextState) => {
        if (nextState === 'active') {
          setTimeout(handleAndroidPendingCall, 300);
        }
      });

      // Cleanup
      const origCleanup = () => {
        unsubs.forEach(u => u());
        cleanupCallKeep();
        cleanupIncomingCall();
        appStateListener.remove();
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      };
      return origCleanup;
    }

    return () => {
      unsubs.forEach(u => u());
      cleanupCallKeep();
      cleanupIncomingCall();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [user?.email]);

  const handleAccept = () => {
    console.log('[IncomingCall] handleAccept called, handlingRef=' + handlingRef.current + ' acceptedRef=' + acceptedRef.current);
    if (handlingRef.current) {
      console.log('[IncomingCall] handleAccept BLOCKED by handlingRef');
      return;
    }
    // [WAVE 104F] Telemetry tap.
    try { const _c = callStateRef.current || call; _callDiagAppend('info', 'incoming call accepted by user', { call_id: _c?.call_id || _c?.room_id, caller: _c?.caller_email }); } catch {}
    try { if (Platform.OS !== 'web') { const H = require('expo-haptics'); H.impactAsync?.(H.ImpactFeedbackStyle.Medium); } } catch {}
    handlingRef.current = true;
    acceptedRef.current = true; // MUST be set before callKeep.endCall triggers onEnd

    const currentCall = callStateRef.current || call;
    if (!currentCall) { console.log('[IncomingCall] handleAccept: no currentCall'); handlingRef.current = false; return; }

    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }

    const callId = currentCall.call_id || currentCall.room_id;

    // Dismiss the native IncomingCallActivity (Android) / CallKit (iOS) when
    // the user accepts from the JS overlay — otherwise the native screen
    // lingers on top of /call.
    try { callKeep.endCall(callId); } catch {}
    // Resolve display name same way as the render block: device address
    // book wins so the active-call screen also reads "Mãe" instead of the
    // raw phone the caller dialed.
    const _callerPhone = currentCall.caller_phone || '';
    const _phoneMatchName = _callerPhone ? lookupDeviceContactName(_callerPhone) : null;
    const callerName = _phoneMatchName
      || currentCall.caller_name
      || currentCall.caller_email?.split('@')[0]
      || '';
    const callerEmail = currentCall.caller_email || '';
    const isVideo = !!currentCall.video ? '1' : '0';
    const conversationId = currentCall.conversation_id || '';
    const callerVerifiedParam = (currentCall.caller_verified === true
      || currentCall.caller_verified === 1
      || currentCall.caller_verified === '1') ? '1' : '0';

    stopRingtone();

    // Dismiss system push notifications (so the push notification stops too)
    if (Platform.OS !== 'web') {
      try {
        const Notifications = require('expo-notifications');
        Notifications.dismissAllNotificationsAsync();
      } catch {}
    }

    // Notify caller that call was accepted.
    // CRITICAL: mailWs._send silently DROPS non-chat messages when the socket
    // isn't OPEN. If the WS hiccups during accept (background→foreground
    // transition, reconnect mid-ring, slow network), the caller never gets
    // call_accepted and sits on "Calling..." forever with ringtone playing.
    // Fix: verify connection, queue+retry if dead, and resend a couple of
    // times to survive transient socket drops.
    try {
      const mailWs = require('../services/websocket').default;
      console.log('[IncomingCall] WS isConnected=' + mailWs.isConnected + ' isHealthy=' + mailWs.isHealthy);
      const acceptPayload = {
        type: 'call_accepted',
        conversation_id: conversationId,
        call_id: callId,
        target_email: callerEmail,
      };

      const sendAccept = () => {
        try {
          if (mailWs.isConnected) {
            mailWs._send(acceptPayload);
            return true;
          }
        } catch {}
        return false;
      };

      // 1st attempt — immediate (best case: WS is already open)
      const firstOk = sendAccept();
      if (!firstOk) {
        console.warn('[IncomingCall] WS not connected on accept, will retry');
        // Try to force a reconnect so the retry has a live socket.
        // ensureHealthy() handles the cleanup + destroyed reset + connect
        // atomically and short-circuits when the socket is already healthy
        // on this token (reconnect storm fix 2026-05-19).
        try {
          const token = mailWs.token;
          if (token && typeof mailWs.ensureHealthy === 'function') {
            mailWs.ensureHealthy(token);
          }
        } catch {}
      }

      // Retries to survive transient socket drops / server-side state races.
      // The server only accepts call_accepted while state===RINGING (~30s
      // window), so multiple sends within 3s are safe — duplicates are a
      // no-op once the state flips to ACCEPTED.
      let retryAttempts = 0;
      const retryHandle = setInterval(() => {
        retryAttempts++;
        const ok = sendAccept();
        if (ok && retryAttempts >= 2) {
          // Send twice over the wire then stop; server is idempotent.
          clearInterval(retryHandle);
        } else if (retryAttempts >= 8) {
          // Give up after ~4s — if call_accepted hasn't landed by now,
          // the caller will hit their own 30s ringing timeout anyway.
          clearInterval(retryHandle);
        }
      }, 500);
    } catch (e) {
      console.log('[IncomingCall] call_accepted send error:', e);
    }

    // Store SDP in global store BEFORE clearing call state
    if (currentCall.offer_sdp) {
      _pendingOfferSdp = currentCall.offer_sdp;
      _pendingOfferType = currentCall.offer_type || 'offer';
      _pendingOfferCallId = currentCall.call_id;
    }

    callStateRef.current = null;
    setCall(null);

    // Navigate to call screen as callee. Capture group flag from currentCall
    // before callStateRef is nulled above (group-answer grid routing).
    const _routeGroup = _payloadIsGroupCall(currentCall);
    setTimeout(() => {
      try {
        // [#1359 group-answer routing] Group answers → /group-call (LiveKit
        // grid). /call.js only renders one remote video so the answerer of a
        // group call saw a single peer. Answerer is a joiner (no isCaller);
        // the backend call_id IS the LK room (`group_<conversationId>`), so
        // pass it through as `room` — group-call.js mints its own token.
        const url = _routeGroup
          ? `/group-call?conversation_id=${encodeURIComponent(conversationId)}&room=${encodeURIComponent(callId)}&video=${isVideo}`
          : `/call?callId=${encodeURIComponent(callId)}&contactName=${encodeURIComponent(callerName)}&contactEmail=${encodeURIComponent(callerEmail)}&isVideo=${isVideo}&conversationId=${encodeURIComponent(conversationId)}&isCaller=0&callerVerified=${callerVerifiedParam}`;
        router.push(url);
      } catch {}
      // DON'T reset handlingRef here — keep it true to block any late decline
    }, 300);
  };
  handleAcceptRef.current = handleAccept;

  const handleDecline = () => {
    console.log('[IncomingCall] handleDecline called, handlingRef=' + handlingRef.current + ' acceptedRef=' + acceptedRef.current);
    // [WAVE 104F] Telemetry tap.
    try { const _c = callStateRef.current || call; _callDiagAppend('info', 'incoming call declined by user', { call_id: _c?.call_id || _c?.room_id, caller: _c?.caller_email }); } catch {}
    // If already accepted (active call), the red button means "end the call".
    // Previously we BLOCKED this path, leaving the caller stuck on "Calling..."
    // because no call_end was sent. Now we send a hangup so the peer's UI
    // closes too. Distinct from the "declined" reason — Go WS rejects
    // declined-after-accepted but accepts hangup at any state.
    if (acceptedRef.current) {
      console.log('[IncomingCall] handleDecline → routing to hangup (call already accepted)');
      const currentCall = callStateRef.current || call;
      if (currentCall) {
        const callId = currentCall.call_id || currentCall.room_id;
        try {
          const mailWs = require('../services/websocket').default;
          if (mailWs.isConnected) {
            mailWs._send({
              type: 'call_end',
              call_id: callId,
              target_email: currentCall.caller_email,
              reason: 'hangup',
            });
          }
        } catch {}
        try {
          const ck = require('../services/callkeep');
          if (typeof ck.endCall === 'function') ck.endCall(callId);
        } catch {}
      }
      stopRingtone();
      callStateRef.current = null;
      setCall(null);
      handlingRef.current = false;
      acceptedRef.current = false;
      return;
    }
    if (handlingRef.current) {
      console.log('[IncomingCall] handleDecline BLOCKED (handling in progress)');
      return;
    }
    handlingRef.current = true;

    // Clear incoming call timeout
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }

    const currentCall = callStateRef.current || call;
    if (currentCall) {
      const callId = currentCall.call_id || currentCall.room_id;
      // Dismiss native IncomingCallActivity/CallKit when user declines from JS overlay
      try { callKeep.endCall(callId); } catch {}
      // Log declined call as missed in history
      initAddCallToHistory();
      addCallToHistory({
        contactEmail: currentCall.caller_email || '',
        contactName: currentCall.caller_name || currentCall.caller_email?.split('@')[0] || '',
        callId: callId,
        type: 'missed',
        video: !!currentCall.video,
        timestamp: new Date().toISOString(),
        duration: 0,
      }).catch(() => {});
      try {
        const mailWs = require('../services/websocket').default;
        if (mailWs.isConnected) {
          mailWs._send({
            type: 'call_end',
            call_id: callId,
            target_email: currentCall.caller_email,
            reason: 'declined',
          });
        }
      } catch {}
    }
    stopRingtone();
    // Dismiss system push notifications
    if (Platform.OS !== 'web') {
      try {
        const Notifications = require('expo-notifications');
        Notifications.dismissAllNotificationsAsync();
      } catch {}
    }
    callStateRef.current = null;
    setCall(null);
    handlingRef.current = false;
  };
  handleDeclineRef.current = handleDecline;

  if (!call) return null;

  // [WAVE 140 WhatsApp arch revert, 2026-05-22] Mobile without explicit
  // `uiOwner === 'js'` ⇒ native owns the UI (CallKit / IncomingCallActivity).
  // JS modal does NOT render — it would otherwise create a dual-UI race where
  // both the native call surface and the JS Modal flash for the user. We keep
  // call state alive (callStateRef, WS listeners, CallKit observers) so the
  // existing onAnswer handler can navigate to /call.js (which adopts the
  // native LK Room via adoptNativeRoom(callId)) when the user accepts.
  const jsRenderAllowed = Platform.OS === 'web' || call?.uiOwner === 'js';
  if (Platform.OS !== 'web' && !jsRenderAllowed) return null;

  // Caller display name with device-book override.
  // Precedence: (1) name saved in this device's address book against the
  // caller's verified phone (WhatsApp behavior — phone is the source of
  // truth for "who this person is to me"), (2) the server-provided
  // display_name carried in caller_name, (3) the email local-part fallback.
  // The phone match is suffix-based via lookupDeviceContactName so it works
  // across +55/55/no-country-code variants. Returns null when the caller
  // either has no verified phone OR isn't in the contact book.
  const callerPhone = call.caller_phone || '';
  const phoneMatchName = callerPhone ? lookupDeviceContactName(callerPhone) : null;
  const callerName = phoneMatchName
    || call.caller_name
    || call.caller_email?.split('@')[0]
    || '?';
  const callerEmail = call.caller_email || '';
  const isVideo = !!call.video;
  // Trust the backend flag — set when the caller has completed Telnyx
  // caller-id verification (PIN-confirmed phone in profile/data.json).
  // Both '1' (string from FCM data payload) and true (JS bool) are valid.
  const callerVerified = call.caller_verified === true
    || call.caller_verified === 1
    || call.caller_verified === '1';

  const renderRing = (anim, baseSize) => (
    <Animated.View style={{
      position: 'absolute',
      width: baseSize, height: baseSize, borderRadius: baseSize / 2,
      borderWidth: 2,
      borderColor: isVideo ? 'rgba(34,197,94,0.5)' : 'rgba(59,130,246,0.5)',
      opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
      transform: [{
        scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] }),
      }],
    }} />
  );

  return (
    <Modal visible transparent animationType="none" onRequestClose={handleDecline}>
      <Animated.View style={[styles.fullScreen, { opacity: fadeAnim }]}>
        {/* Gradient background */}
        <View style={[styles.bgGradient, {
          backgroundColor: isVideo ? '#064e3b' : '#1e1b4b',
        }]} />
        <View style={styles.bgOverlay} />

        {/* Top section */}
        <View style={styles.topSection}>
          <Text style={styles.encryptedText}>
            {isVideo ? (t('call.incomingVideo') || 'Chamada de video') : (t('call.incomingAudio') || 'Chamada de voz')}
          </Text>
        </View>

        {/* Center - Avatar with pulse rings */}
        <View style={styles.centerSection}>
          <View style={styles.avatarArea}>
            {renderRing(ring1, 140)}
            {renderRing(ring2, 140)}
            {renderRing(ring3, 140)}
            <AvatarCircle name={callerName} email={callerEmail} size={110} />
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 }}>
            <Text style={styles.callerName} numberOfLines={1}>{callerName}</Text>
            {callerVerified && (
              <View
                accessibilityLabel={t('call.verifiedCaller') || 'Verificado'}
                accessibilityRole="image"
                style={{ marginTop: 4 }}
              >
                <IconVerifiedBadge size={20} color="#34B7F1" />
              </View>
            )}
          </View>
          {callerPhone ? <Text style={[styles.callerEmail, { fontSize: 16, marginBottom: 2 }]}>{callerPhone}</Text> : null}
          <Text style={styles.callerEmail}>{callerEmail}</Text>
        </View>

        {/* Bottom - Accept / Decline */}
        <View style={[styles.bottomSection, { paddingBottom: insets.bottom + 24 }]}>
          <View style={styles.actionRow}>
            <TouchableOpacity onPress={handleDecline} style={styles.actionItem} activeOpacity={0.7}>
              <View style={[styles.actionBtn, styles.declineBtn]}>
                <IconPhoneOff size={28} color="#fff" />
              </View>
              <Text style={styles.actionLabel}>{t('call.decline') || 'Recusar'}</Text>
            </TouchableOpacity>

            <TouchableOpacity onPress={handleAccept} style={styles.actionItem} activeOpacity={0.7}>
              <Animated.View style={[styles.actionBtn, styles.acceptBtn, { transform: [{ scale: acceptScale }] }]}>
                {isVideo ? <IconVideo size={28} color="#fff" /> : <IconPhone size={28} color="#fff" />}
              </Animated.View>
              <Text style={styles.actionLabel}>{t('call.accept') || 'Atender'}</Text>
            </TouchableOpacity>
          </View>

          {/* "Mensagem" button — opens DeclineWithMessageSheet via the
              shared global trigger that the sheet polls for. Lets the
              callee dismiss with a quick reply instead of just hanging up. */}
          <TouchableOpacity
            onPress={() => {
              try {
                const c = callStateRef.current || call;
                if (c && c.call_id) {
                  globalThis.__chatyyPendingDeclineWithMessage = {
                    callId: String(c.call_id),
                    toEmail: c.caller_email || '',
                    conversationId: c.conversation_id || '',
                    ts: Date.now(),
                  };
                }
              } catch {}
              handleDecline();
            }}
            style={styles.messageBtn}
            activeOpacity={0.7}
            accessibilityLabel={t('call.declineWithMessage') || 'Mensagem'}
            accessibilityRole="button"
          >
            <Text style={styles.messageBtnLabel}>{t('call.declineWithMessage') || 'Mensagem'}</Text>
          </TouchableOpacity>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  fullScreen: {
    flex: 1,
    position: 'relative',
  },
  bgGradient: {
    ...StyleSheet.absoluteFillObject,
  },
  bgOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: 'rgba(0,0,0,0.3)',
  },
  topSection: {
    paddingTop: 60,
    alignItems: 'center',
  },
  encryptedText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 14,
    fontWeight: '500',
    letterSpacing: 0.5,
  },
  centerSection: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingBottom: 40,
  },
  avatarArea: {
    width: 160,
    height: 160,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 24,
  },
  callerName: {
    color: '#fff',
    fontSize: 30,
    fontWeight: '700',
    marginBottom: 6,
    textAlign: 'center',
  },
  callerEmail: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 14,
    textAlign: 'center',
  },
  bottomSection: {
    paddingBottom: 60,
    alignItems: 'center',
  },
  actionRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 80,
  },
  actionItem: {
    alignItems: 'center',
  },
  actionBtn: {
    width: 70,
    height: 70,
    borderRadius: 35,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
  },
  declineBtn: {
    backgroundColor: '#ef4444',
  },
  acceptBtn: {
    backgroundColor: '#22c55e',
  },
  actionLabel: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 13,
    fontWeight: '600',
  },
});
