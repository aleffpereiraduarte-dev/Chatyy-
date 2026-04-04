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
import { endCall as callKeepEnd, addCallKeepListeners, addIncomingCallListener, consumePendingCall } from '../services/callkeep';
import { addCallToHistory } from './ChatCallsTab';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Global callback so push notifications can trigger the incoming call UI
let _triggerIncomingCall = null;
// Buffer for incoming call data when component isn't mounted yet (cold start from push)
let _pendingCallTrigger = null;
export function triggerIncomingCall(data) {
  // Force-reset _callActive — if a push notification triggers this,
  // it means there's a real incoming call and any stale _callActive should be cleared
  _callActive = false;
  if (_callActiveTimer) { clearTimeout(_callActiveTimer); _callActiveTimer = null; }
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

// Global store for pending SDP offer (avoids URL param size limits)
let _pendingOfferSdp = null;
let _pendingOfferType = null;
export function getPendingOffer() {
  const offer = _pendingOfferSdp ? { sdp: _pendingOfferSdp, type: _pendingOfferType || 'offer' } : null;
  _pendingOfferSdp = null;
  _pendingOfferType = null;
  return offer;
}

// Global store for TURN credentials from call_offer (used by callee in call.js)
let _pendingTurnCredentials = null;
export function getPendingTurnCredentials() {
  const creds = _pendingTurnCredentials;
  _pendingTurnCredentials = null;
  return creds;
}

// Global store for ICE candidates that arrive before call.js mounts
let _pendingIceCandidates = [];
export function getPendingIceCandidates() {
  const candidates = _pendingIceCandidates;
  _pendingIceCandidates = [];
  return candidates;
}

// Flag to suppress IncomingCallListener when a call is active in call.js
let _callActive = false;
let _callActiveTimer = null;
let _callActiveTimeout = null;
export function setCallActive(active) {
  _callActive = active;
  if (_callActiveTimer) { clearTimeout(_callActiveTimer); _callActiveTimer = null; }
  if (active) {
    // Safety timeout: auto-clear _callActive after 5 minutes in case a call gets stuck
    // (was 60s, too short - calls on slow networks can take 45s+ to connect)
    if (_callActiveTimeout) clearTimeout(_callActiveTimeout);
    _callActiveTimeout = setTimeout(() => { _callActive = false; _callActiveTimeout = null; }, 300000);
  } else {
    if (_callActiveTimeout) { clearTimeout(_callActiveTimeout); _callActiveTimeout = null; }
  }
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
    if (_callActiveTimer) { clearTimeout(_callActiveTimer); _callActiveTimer = null; }

    callStateRef.current = data;
    setCall(data);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      // Timed out without answering - log as missed
      const c = callStateRef.current;
      if (c && !acceptedRef.current) {
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
        // If already accepted/handling (e.g. CallKit), still capture caller data but don't show UI
        if (acceptedRef.current || handlingRef.current) {
          console.log('[IncomingCall] call_invite: accepted/handling, updating callStateRef only');
          if (data?.caller_email && data?.call_id) {
            // Update callStateRef with richer WS data (has caller_email, conversation_id)
            callStateRef.current = {
              ...(callStateRef.current || {}),
              caller_email: data.caller_email,
              caller_name: data.caller_name || callStateRef.current?.caller_name || '',
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
          if (_callActiveTimer) { clearTimeout(_callActiveTimer); _callActiveTimer = null; }
        }
        if ((!data?.room_id && !data?.call_id) || data.caller_email === user.email) return;
        // Deduplicate: ignore if we already have this call
        if (callRef.current && callRef.current.call_id === (data.call_id || data.room_id)) return;
        const callData = {
          ...data,
          call_id: data.call_id || data.room_id,
          room_id: data.room_id || data.call_id,
        };
        callRef.current = callData;
        showCall(callData);
      }));

      // WebRTC call_offer — has the actual SDP
      unsubs.push(mailWs.on('call_offer', (data) => {
        if (!data?.call_id || data.caller_email === user.email) return;
        const sdpType = data.sdp_type || data.type || 'offer';
        // Always store SDP even if _callActive (CallKit accepted, call.js needs it)
        if (data.sdp) {
          _pendingOfferSdp = data.sdp;
          _pendingOfferType = sdpType;
          if (data.turn_credentials) _pendingTurnCredentials = data.turn_credentials;
        }
        if (_callActive) return; // Don't show UI if already in a call

        // If we already have a call_invite showing, update it with SDP
        if (callRef.current && callRef.current.call_id === data.call_id) {
          callRef.current.offer_sdp = data.sdp;
          callRef.current.offer_type = sdpType;
          callStateRef.current = { ...callRef.current };
          setCall({ ...callRef.current });
        } else {
          const callData = {
            call_id: data.call_id,
            caller_email: data.caller_email,
            caller_name: data.caller_name,
            conversation_id: data.conversation_id,
            video: data.video,
            offer_sdp: data.sdp,
            offer_type: sdpType,
          };
          callRef.current = callData;
          showCall(callData);
        }
      }));

      // Buffer ICE candidates that arrive before call.js mounts
      // Also buffer during _callActive transition (call.js may not have set up listeners yet)
      unsubs.push(mailWs.on('call_ice', (data) => {
        if (!data?.candidate || !data?.call_id) return;
        // Always buffer if we have a matching call (call.js will drain on mount)
        const matchesCurrentCall = callRef.current && data.call_id === callRef.current.call_id;
        const matchesActiveCall = _callActive && _pendingIceCandidates.length < 100;
        if (matchesCurrentCall || (matchesActiveCall && _pendingIceCandidates.length < 100)) {
          _pendingIceCandidates.push(data.candidate);
        }
      }));

      // Dismiss incoming call on other sessions (user accepted on another device/tab)
      unsubs.push(mailWs.on('call_dismissed', (data) => {
        if (callRef.current?.call_id === data?.call_id) {
          callRef.current = null;
          callStateRef.current = null;
          _pendingIceCandidates = [];
          stopRingtone();
          setCall(null);
        }
      }));

      // If the caller ends before we answer
      unsubs.push(mailWs.on('call_end', (data) => {
        if (callRef.current?.call_id === data?.call_id && !acceptedRef.current) {
          // Caller ended before we answered - log as missed
          const c = callRef.current;
          if (c) {
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
          callRef.current = null;
          callStateRef.current = null;
          _pendingIceCandidates = [];
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
        onAnswer: (data) => {
          console.log('[IncomingCall] CallKit onAnswer, callId=' + data.callId);
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
          // isConnected says true (iOS kills sockets in background, JS doesn't know)
          const mailWs = require('../services/websocket').default;
          const wsToken = mailWs.token;
          console.log('[IncomingCall] Forcing clean WS reconnect, hasToken=' + !!wsToken);
          mailWs._cleanup(); // Kill existing (possibly dead) socket
          mailWs.destroyed = false;
          mailWs.reconnectAttempt = 0;
          if (wsToken) {
            mailWs.connect(wsToken);
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
              mailWs._send({
                type: 'call_accepted',
                conversation_id: convId,
                call_id: callId,
                target_email: email,
              });
              acceptSent = true;
            }

            // Check if we have SDP (from WS reconnect delivering pending offer)
            if (acceptSent && _pendingOfferSdp) {
              console.log('[IncomingCall] Have SDP + accepted sent, navigating');
              doNavigate();
              return;
            }

            // Keep polling for up to 10s
            if (attempts < 20) {
              setTimeout(poll, 500);
            } else {
              console.log('[IncomingCall] Timeout after 10s, navigating anyway (hasSDP=' + !!_pendingOfferSdp + ' accepted=' + acceptSent + ')');
              doNavigate();
            }
          };
          poll();
        },
        onEnd: (callUUID) => {
          console.log('[IncomingCall] CallKit onEnd, acceptedRef=' + acceptedRef.current);
          // Only decline if we haven't already accepted
          if (acceptedRef.current) return;

          const currentCall = callStateRef.current;
          if (currentCall) {
            const callId = currentCall.call_id || currentCall.room_id;
            // Send decline via WS with retries
            const sendDecline = () => {
              try {
                const mailWs = require('../services/websocket').default;
                if (mailWs.isConnected) {
                  mailWs._send({
                    type: 'call_end',
                    call_id: callId,
                    target_email: currentCall.caller_email,
                    reason: 'declined',
                  });
                  return true;
                }
              } catch {}
              return false;
            };
            if (!sendDecline()) {
              setTimeout(sendDecline, 1000);
              setTimeout(sendDecline, 3000);
            }
          }
          stopRingtone();
          // Dismiss system notifications
          try {
            const Notifications = require('expo-notifications');
            Notifications.dismissAllNotificationsAsync();
          } catch {}
          callStateRef.current = null;
          setCall(null);
          handlingRef.current = false;
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

            // Connect WS and navigate to call
            const mailWs = require('../services/websocket').default;
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
    if (handlingRef.current || acceptedRef.current) {
      console.log('[IncomingCall] handleDecline BLOCKED');
      return;
    }
    handlingRef.current = true;

    // Clear incoming call timeout
    if (timeoutRef.current) { clearTimeout(timeoutRef.current); timeoutRef.current = null; }

    const currentCall = callStateRef.current || call;
    if (currentCall) {
      const callId = currentCall.call_id || currentCall.room_id;
      // Log declined call as missed in history
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
