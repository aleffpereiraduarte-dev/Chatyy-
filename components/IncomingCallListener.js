import { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Platform, Animated, Easing, Dimensions, AppState } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { IconPhone, IconVideo, IconX, IconPhoneOff } from './Icons';
import AvatarCircle from './AvatarCircle';
import { startRingtone, stopRingtone } from '../services/ringtone';
import { stopAllAudio } from '../services/audioManager';

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

// Lazy-load callkeep only on native platforms to avoid TDZ on web
let callKeepEnd = () => {};
let addCallKeepListeners = () => {};
let addIncomingCallListener = () => {};
let consumePendingCall = () => {};

// Cold-start diagnostic — fire-and-forget POST to backend at each step
// so we can trace the call accept flow on iPhone without needing Mac/Console.
let voipDiag = () => {};
try { voipDiag = require('../services/voipDiag').default; } catch {}

if (Platform.OS !== 'web') {
  try {
    const ck = require('../services/callkeep');
    callKeepEnd = ck.endCall;
    addCallKeepListeners = ck.addCallKeepListeners;
    addIncomingCallListener = ck.addIncomingCallListener;
    consumePendingCall = ck.consumePendingCall;
  } catch (e) {
    console.warn('[IncomingCallListener] Failed to load callkeep:', e.message);
  }
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Global callback so push notifications can trigger the incoming call UI
let _triggerIncomingCall = null;
// Buffer for incoming call data when component isn't mounted yet (cold start from push)
let _pendingCallTrigger = null;
export function triggerIncomingCall(data) {
  // Force-reset _callActive — if a push notification triggers this,
  // it means there's a real incoming call and any stale _callActive should be cleared
  _callActive = false;
  /* legacy _callActiveTimer removed in favor of explicit lifecycle */
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
export function setCallActive(active) {
  _callActive = !!active;
}
export function isCallActive() { return _callActive; }

export default function IncomingCallListener() {
  const { colors } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
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
    stopAllAudio();
    startRingtone();

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
      stopRingtone();
      fadeAnim.setValue(0);
      ring1.setValue(0);
      ring2.setValue(0);
      ring3.setValue(0);
    };
  }, [call]);

  const showCall = (data) => {
    // Accept both old format (room_id) and new format (call_id)
    if (!data?.call_id && !data?.room_id) {
      console.log('[IncomingCall] showCall: no call_id/room_id, ignoring');
      return;
    }
    console.log('[IncomingCall] showCall: caller=' + (data.caller_email || '?') + ' call_id=' + (data.call_id || data.room_id));
    // Reset flags for new call
    acceptedRef.current = false;
    handlingRef.current = false;
    // Force reset _callActive so the Modal is not blocked
    _callActive = false;
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
          video: c.video !== false,
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
        if (acceptedRef.current || handlingRef.current) {
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
        // Force reset _callActive — it may be stuck from a previous call that didn't clean up
        if (_callActive) {
          console.log('[IncomingCall] call_invite: resetting stale _callActive');
          _callActive = false;
          /* legacy _callActiveTimer removed in favor of explicit lifecycle */
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
          setCall(null);
          acceptedRef.current = false;
          handlingRef.current = false;
        }
        // The caller's own call.js can listen on mailWs for the same event
        // (we just leave the broadcast pass-through; webrtc.js also emits a
        // 'blocked' event from its handler).
      }));

      // Dismiss incoming call on other sessions (user accepted on another device/tab)
      unsubs.push(mailWs.on('call_dismissed', (data) => {
        if (callRef.current?.call_id === data?.call_id) {
          console.log('[IncomingCall] call_dismissed received:', data.call_id);
          if (data?.call_id) _pendingIceByCallId.delete(String(data.call_id));
          callRef.current = null;
          callStateRef.current = null;
          stopRingtone();
          setCall(null);
          acceptedRef.current = false; // Reset for next call
          handlingRef.current = false;
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
              video: c.video !== false,
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
          setCall(null);
        }
      }));
    } catch {}

    // CallKit native listeners (iOS) — used when VoIP push shows native call screen
    let cleanupCallKeep = () => {};
    let cleanupIncomingCall = () => {};
    if (Platform.OS === 'ios') {
      // Listen for VoIP push incoming call event
      // ALWAYS populate callStateRef (needed for accept handler)
      // In FOREGROUND: also dismiss CallKit, let WS Modal handle
      cleanupIncomingCall = addIncomingCallListener((data) => {
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
        // If app is truly in foreground (active), dismiss CallKit — WS Modal handles it
        const appState = AppState.currentState;
        console.log('[IncomingCall] onIncomingCall appState=' + appState);
        if (appState === 'active') {
          console.log('[IncomingCall] App in foreground — dismissing CallKit, Modal will handle');
          callKeepEnd(data.callId);
        }
      });

      cleanupCallKeep = addCallKeepListeners({
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
          setCallActive(true);
          stopRingtone();

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
          } else {
            console.log('[IncomingCall] Forcing clean WS reconnect, hasToken=' + !!wsToken);
            mailWs._cleanup(); // Kill existing (possibly dead) socket
            mailWs.destroyed = false;
            mailWs.reconnectAttempt = 0;
            if (wsToken) {
              voipDiag('ws_connect_called', callId);
              mailWs.connect(wsToken);
            } else {
              voipDiag('no_token', callId);
              console.warn('[IncomingCall] No auth token available after 3 retries — call cannot connect WS');
              // Still navigate so the call screen can show "Sem conexao" instead
              // of the user sitting on a blank CallKit accept-then-nothing.
            }
          }

          // Wait for WS to connect + authenticate, then:
          // 1. Send call_accepted (with callerEmail from callStateRef, which WS call_invite will update)
          // 2. Wait for pending SDP offer from server
          // 3. Navigate to call screen
          let navigated = false;
          const doNavigate = () => {
            if (navigated) return;
            navigated = true;
            // Re-read callStateRef — WS call_invite may have updated it with callerEmail
            const updatedCall = callStateRef.current;
            const finalCallerEmail = updatedCall?.caller_email || callerEmail;
            const finalCallerName = updatedCall?.caller_name || callerName;
            const finalConversationId = updatedCall?.conversation_id || conversationId;
            callStateRef.current = null;
            console.log('[IncomingCall] Navigating to call: email=' + finalCallerEmail + ' hasSDP=' + !!_pendingOfferSdp);
            router.push(`/call?callId=${encodeURIComponent(callId)}&contactName=${encodeURIComponent(finalCallerName)}&contactEmail=${encodeURIComponent(finalCallerEmail)}&isVideo=${isVideo}&conversationId=${encodeURIComponent(finalConversationId)}&isCaller=0`);
          };

          let attempts = 0;
          let acceptSent = false;
          const poll = () => {
            attempts++;
            if (navigated) return;

            if (mailWs.isConnected && !acceptSent) {
              // WS connected — send call_accepted
              // Re-read callerEmail from callStateRef (WS call_invite may have arrived by now)
              const email = callStateRef.current?.caller_email || callerEmail;
              const convId = callStateRef.current?.conversation_id || conversationId;
              console.log('[IncomingCall] WS connected (attempt ' + attempts + '), sending call_accepted to ' + email);
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

            // Check if we have SDP (from WS reconnect delivering pending offer)
            if (acceptSent && _pendingOfferSdp) {
              console.log('[IncomingCall] Have SDP + accepted sent, navigating');
              voipDiag('have_sdp_navigating', callId, { attempts });
              doNavigate();
              return;
            }

            // Keep polling for up to 30s — 10s was racing real network
            // delays on cellular cold-start (token decrypt + WS handshake +
            // server round-trip). The screen now navigates with whatever
            // we've got and the call screen handles late SDP via its own
            // event listener, so a long wait here is purely about giving
            // the WS more chances to reconnect before we declare timeout.
            if (attempts < 60) {
              if (attempts === 1 || attempts === 5 || attempts === 15 || attempts === 30) {
                voipDiag('poll_tick', callId, { attempts, wsConnected: !!mailWs.isConnected, acceptSent, hasSDP: !!_pendingOfferSdp });
              }
              setTimeout(poll, 500);
            } else {
              console.log('[IncomingCall] Timeout after 30s, navigating anyway (hasSDP=' + !!_pendingOfferSdp + ' accepted=' + acceptSent + ')');
              voipDiag('timeout_30s', callId, { hasSDP: !!_pendingOfferSdp, acceptSent });
              doNavigate();
            }
          };
          poll();
        },
        onEnd: (callUUID, eventData) => {
          console.log('[IncomingCall] CallKit onEnd, acceptedRef=' + acceptedRef.current);
          voipDiag('callkit_native_end', eventData?.callId || '', { wasAccepted: acceptedRef.current });

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
          const pending = consumePendingCall();
          if (pending && pending.callId) {
            console.log('[IncomingCall] Android: found pending accepted call:', pending.callId);
            acceptedRef.current = true;
            handlingRef.current = true;
            setCallActive(true);
            stopRingtone();

            const callId = pending.callId;
            const callerName = pending.callerName || '';
            const callerEmail = pending.callerEmail || '';
            const conversationId = pending.conversationId || '';
            const isVideo = pending.hasVideo ? '1' : '0';

            // Dismiss any visible incoming call UI
            setCall(null);
            if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }

            // Force a clean WS reconnect — same as the iOS path. Without
            // this, an accept that lands while the socket is dead (Android
            // background killed it) sits forever waiting for `isConnected`
            // and the user gets a "missed call" even though they tapped
            // Atender. Killing + reconnecting forces auth + re-delivery of
            // the pending offer.
            const mailWs = require('../services/websocket').default;
            try {
              const wsToken = mailWs.token;
              if (typeof mailWs._cleanup === 'function') mailWs._cleanup();
              mailWs.destroyed = false;
              mailWs.reconnectAttempt = 0;
              if (wsToken && typeof mailWs.connect === 'function') mailWs.connect(wsToken);
            } catch {}
            let navigated = false;
            let acceptSent = false;
            let attempts = 0;

            const poll = () => {
              attempts++;
              if (navigated) return;
              if (mailWs.isConnected && !acceptSent) {
                console.log('[IncomingCall] Android pending: WS connected, sending call_accepted to ' + callerEmail);
                mailWs._send({
                  type: 'call_accepted',
                  call_id: callId,
                  conversation_id: conversationId,
                  target_email: callerEmail,
                });
                acceptSent = true;
              }
              if (acceptSent && !navigated) {
                navigated = true;
                router.push(`/call?callId=${encodeURIComponent(callId)}&contactName=${encodeURIComponent(callerName)}&contactEmail=${encodeURIComponent(callerEmail)}&isVideo=${isVideo}&conversationId=${encodeURIComponent(conversationId)}&isCaller=0`);
                return;
              }
              if (attempts < 20) {
                setTimeout(poll, 500);
              } else if (!navigated) {
                navigated = true;
                console.log('[IncomingCall] Android pending: timeout, navigating anyway');
                router.push(`/call?callId=${encodeURIComponent(callId)}&contactName=${encodeURIComponent(callerName)}&contactEmail=${encodeURIComponent(callerEmail)}&isVideo=${isVideo}&conversationId=${encodeURIComponent(conversationId)}&isCaller=0`);
              }
            };
            poll();
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
    try { if (Platform.OS !== 'web') { const H = require('expo-haptics'); H.impactAsync?.(H.ImpactFeedbackStyle.Medium); } } catch {}
    handlingRef.current = true;
    acceptedRef.current = true; // MUST be set before callKeepEnd triggers onEnd

    const currentCall = callStateRef.current || call;
    if (!currentCall) { console.log('[IncomingCall] handleAccept: no currentCall'); handlingRef.current = false; return; }

    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }

    const callId = currentCall.call_id || currentCall.room_id;
    const callerName = currentCall.caller_name || currentCall.caller_email?.split('@')[0] || '';
    const callerEmail = currentCall.caller_email || '';
    const isVideo = currentCall.video !== false ? '1' : '0';
    const conversationId = currentCall.conversation_id || '';

    stopRingtone();

    // Dismiss system push notifications (so the push notification stops too)
    if (Platform.OS !== 'web') {
      try {
        const Notifications = require('expo-notifications');
        Notifications.dismissAllNotificationsAsync();
      } catch {}
    }

    // Notify caller that call was accepted
    try {
      const mailWs = require('../services/websocket').default;
      console.log('[IncomingCall] WS isConnected=' + mailWs.isConnected + ' isHealthy=' + mailWs.isHealthy);
      mailWs._send({
        type: 'call_debug',
        call_id: callId,
        msg: 'handleAccept: sending call_accepted to ' + callerEmail,
      });
      mailWs._send({
        type: 'call_accepted',
        conversation_id: conversationId,
        call_id: callId,
        target_email: callerEmail,
      });
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

    // Navigate to call screen as callee
    setTimeout(() => {
      try {
        const url = `/call?callId=${encodeURIComponent(callId)}&contactName=${encodeURIComponent(callerName)}&contactEmail=${encodeURIComponent(callerEmail)}&isVideo=${isVideo}&conversationId=${encodeURIComponent(conversationId)}&isCaller=0`;
        router.push(url);
      } catch {}
      // DON'T reset handlingRef here — keep it true to block any late decline
    }, 300);
  };
  handleAcceptRef.current = handleAccept;

  const handleDecline = () => {
    console.log('[IncomingCall] handleDecline called, handlingRef=' + handlingRef.current + ' acceptedRef=' + acceptedRef.current);
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
      // Log declined call as missed in history
      initAddCallToHistory();
      addCallToHistory({
        contactEmail: currentCall.caller_email || '',
        contactName: currentCall.caller_name || currentCall.caller_email?.split('@')[0] || '',
        callId: callId,
        type: 'missed',
        video: currentCall.video !== false,
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

  const callerName = call.caller_name || call.caller_email?.split('@')[0] || '?';
  const callerEmail = call.caller_email || '';
  const isVideo = call.video !== false;

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
          <Text style={styles.callerName}>{callerName}</Text>
          {call?.caller_phone ? <Text style={[styles.callerEmail, { fontSize: 16, marginBottom: 2 }]}>{call.caller_phone}</Text> : null}
          <Text style={styles.callerEmail}>{callerEmail}</Text>
        </View>

        {/* Bottom - Accept / Decline */}
        <View style={styles.bottomSection}>
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
