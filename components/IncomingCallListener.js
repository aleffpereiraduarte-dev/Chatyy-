import { useEffect, useState, useRef } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Modal, Platform, Animated, Easing, Dimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { IconPhone, IconVideo, IconX, IconPhoneOff } from './Icons';
import AvatarCircle from './AvatarCircle';
import { startRingtone, stopRingtone } from '../services/ringtone';
import { displayIncomingCall, endCall as callKeepEnd, addCallKeepListeners } from '../services/callkeep';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Global callback so push notifications can trigger the incoming call UI
let _triggerIncomingCall = null;
export function triggerIncomingCall(data) {
  if (_triggerIncomingCall) _triggerIncomingCall(data);
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

// Global store for ICE candidates that arrive before call.js mounts
let _pendingIceCandidates = [];
export function getPendingIceCandidates() {
  const candidates = _pendingIceCandidates;
  _pendingIceCandidates = [];
  return candidates;
}

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
    startRingtone();

    // Fade in
    Animated.timing(fadeAnim, { toValue: 1, duration: 400, useNativeDriver: Platform.OS !== 'web' }).start();

    // Pulsing rings (staggered)
    const createPulse = (anim, delay) => {
      return Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.parallel([
            Animated.timing(anim, { toValue: 1, duration: 2000, easing: Easing.out(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
          ]),
          Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: Platform.OS !== 'web' }),
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
        Animated.timing(acceptScale, { toValue: 1.1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(acceptScale, { toValue: 1, duration: 800, easing: Easing.inOut(Easing.ease), useNativeDriver: Platform.OS !== 'web' }),
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
    if (!data?.call_id && !data?.room_id) return;

    // On native: try CallKit (iOS) / ConnectionService (Android) for real phone call UI
    if (Platform.OS !== 'web') {
      const callId = data.call_id || data.room_id;
      const callerName = data.caller_name || data.caller_email?.split('@')[0] || 'Unknown';
      displayIncomingCall(callId, callerName, data.caller_email || '', data.video !== false);
    }

    callStateRef.current = data;
    setCall(data);
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      callStateRef.current = null;
      setCall(null);
      // Also end on CallKeep
      if (Platform.OS !== 'web' && data?.call_id) {
        callKeepEnd(data.call_id);
      }
    }, 45000);
  };

  // Register global trigger for push notifications
  useEffect(() => {
    _triggerIncomingCall = (data) => {
      if (data?.caller_email === user?.email) return;
      showCall(data);
    };
    return () => { _triggerIncomingCall = null; };
  }, [user?.email]);

  // Listen for call invitations via WebSocket
  useEffect(() => {
    // Debug: report listener setup status
    try {
      const debugWs = require('../services/websocket').default;
      if (debugWs && debugWs._send) {
        debugWs._send({ type: 'call_debug', msg: 'ICL useEffect running: user_email=' + (user?.email || 'NULL') + ' ws_connected=' + debugWs.isConnected });
      }
    } catch {}

    if (!user?.email) return;
    let unsubs = [];
    try {
      const mailWs = require('../services/websocket').default;

      const callRef = { current: null }; // track current call for closure

      // Debug: log all incoming messages to verify listeners work
      unsubs.push(mailWs.on('call_invite', (data) => {
        try { mailWs._send({ type: 'call_debug', msg: 'LISTENER got call_invite: call_id=' + (data?.call_id || 'none') + ' caller=' + (data?.caller_email || 'none') + ' myemail=' + user.email }); } catch {}
      }));
      unsubs.push(mailWs.on('call_offer', (data) => {
        try { mailWs._send({ type: 'call_debug', msg: 'LISTENER got call_offer: call_id=' + (data?.call_id || 'none') + ' has_sdp=' + (!!data?.sdp) }); } catch {}
      }));

      // Legacy call_invite (from chat-conversation.js startCall) — NO SDP yet
      unsubs.push(mailWs.on('call_invite', (data) => {
        if ((!data?.room_id && !data?.call_id) || data.caller_email === user.email) return;
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
        // Store SDP in global store (avoids URL param size limits)
        _pendingOfferSdp = data.sdp;
        _pendingOfferType = sdpType;

        // If we already have a call_invite showing, update it with SDP
        if (callRef.current && callRef.current.call_id === data.call_id) {
          callRef.current.offer_sdp = data.sdp;
          callRef.current.offer_type = sdpType;
          callStateRef.current = { ...callRef.current }; // sync ref for CallKit
          setCall({ ...callRef.current }); // force re-render
        } else {
          // No call_invite yet, show the call with SDP
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
      unsubs.push(mailWs.on('call_ice', (data) => {
        if (callRef.current && data?.call_id === callRef.current.call_id && data?.candidate) {
          _pendingIceCandidates.push(data.candidate);
        }
      }));

      // If the caller ends before we answer
      unsubs.push(mailWs.on('call_end', (data) => {
        if (callRef.current?.call_id === data?.call_id) {
          callRef.current = null;
          callStateRef.current = null;
          _pendingIceCandidates = [];
          setCall(null);
        }
      }));
    } catch {}

    // CallKeep native listeners (iOS CallKit answer/end, Android ConnectionService)
    let cleanupCallKeep = () => {};
    if (Platform.OS !== 'web') {
      cleanupCallKeep = addCallKeepListeners({
        onAnswer: (callUUID) => {
          // User answered from native call screen
          handleAccept();
        },
        onEnd: (callUUID) => {
          // User declined from native call screen
          handleDecline();
        },
      });
    }

    return () => {
      unsubs.forEach(u => u());
      cleanupCallKeep();
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [user?.email]);

  const handleAccept = () => {
    // Use ref to avoid stale closure (CallKit callbacks capture old `call` state)
    const currentCall = callStateRef.current || call;
    if (!currentCall) return;

    const callId = currentCall.call_id || currentCall.room_id;
    const callerName = currentCall.caller_name || currentCall.caller_email?.split('@')[0] || '';
    const callerEmail = currentCall.caller_email || '';
    const isVideo = currentCall.video !== false ? '1' : '0';
    const conversationId = currentCall.conversation_id || '';

    // Debug: log what we have
    try {
      const mailWs = require('../services/websocket').default;
      if (mailWs.isConnected) {
        mailWs._send({
          type: 'call_debug',
          call_id: callId,
          msg: 'handleAccept: has_sdp=' + (!!currentCall.offer_sdp) + ' sdp_len=' + (currentCall.offer_sdp?.length || 0) + ' caller=' + callerEmail,
        });

        // Notify caller that call was accepted via WebSocket
        mailWs._send({
          type: 'call_accepted',
          conversation_id: conversationId,
          call_id: callId,
          target_email: callerEmail,
        });
      }
    } catch {}

    stopRingtone();

    // End CallKit incoming call UI (so it doesn't persist)
    if (Platform.OS !== 'web') {
      try { callKeepEnd(callId); } catch {}
    }

    // Store SDP in global store BEFORE clearing call state
    if (currentCall.offer_sdp) {
      _pendingOfferSdp = currentCall.offer_sdp;
      _pendingOfferType = currentCall.offer_type || 'offer';
    }

    callStateRef.current = null;
    setCall(null);

    // Navigate to call screen as callee — small delay to let Modal unmount first
    setTimeout(() => {
      try {
        const url = `/call?callId=${encodeURIComponent(callId)}&contactName=${encodeURIComponent(callerName)}&contactEmail=${encodeURIComponent(callerEmail)}&isVideo=${isVideo}&conversationId=${encodeURIComponent(conversationId)}&isCaller=0`;
        router.push(url);
      } catch (navErr) {
        try {
          const mailWs = require('../services/websocket').default;
          mailWs._send({ type: 'call_debug', msg: 'navigation error: ' + (navErr?.message || String(navErr)) });
        } catch {}
      }
    }, 300);
  };

  const handleDecline = () => {
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
            reason: 'declined',
          });
        }
      } catch {}
    }
    stopRingtone();
    callStateRef.current = null;
    setCall(null);
  };

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
