/**
 * CallStatusBar — Ongoing call indicator.
 *
 * [Wave Bridge-Surface, 2026-05-21 / Agent 9] Refactored: state now comes
 * from `useCurrentCall()` (services/call-state-reader.js) which reads the
 * native call snapshot via the single sanctioned ExpoModule entry point.
 *
 * On mobile (iOS/Android): native is the source of truth. JS never touches
 * the LiveKit Room handle, SDP, or ICE candidates — see
 * docs/whatsapp-migration/IMPL-bridge-surface-policy.md.
 *
 * On web: native module returns null, so we fall back to the legacy
 * CallContext path (web has no PJSIP / CallKit and stays on the JS-driven
 * LiveKit Room).
 */
import { useEffect, useState, useRef, useCallback } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Animated, Platform, StatusBar } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { IconPhone, IconPhoneOff, IconVideo } from './Icons';
import { useCurrentCall } from '../services/call-state-reader';
import { useLanguage } from '../context/LanguageContext';
import AvatarCircle from './AvatarCircle';

// Safe area top padding (no hook import to avoid circular dep). On Android,
// devices with punch-hole/notch report 36-48px via StatusBar.currentHeight —
// the prior hardcoded 24px pushed the bar under the clock and made the
// Desligar button overlap the gesture/notification area (reported 2026-05-12).
const SAFE_TOP = Platform.OS === 'ios'
  ? 50
  : Math.max(24, (StatusBar.currentHeight || 24)) + 4;

// Lazy resolved at module load (outside the component) — does NOT call hooks itself
let _useCall = null;
try { _useCall = require('../context/CallContext').useCall; } catch {}

// White breathing dot that signals a live call. Tiny: 8×8 px, opacity
// 0.55 → 1 → 0.55 over 1.6s. Cheap, non-distracting.
function PulseDot() {
  const op = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 1,    duration: 800, useNativeDriver: true }),
        Animated.timing(op, { toValue: 0.55, duration: 800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  return (
    <Animated.View
      style={{
        width: 8, height: 8, borderRadius: 4,
        backgroundColor: '#fff',
        opacity: op,
      }}
    />
  );
}

export default function CallStatusBar() {
  // [Wave Bridge-Surface, 2026-05-21] Primary state: native snapshot via
  // the single sanctioned reader. CallContext stays as a web fallback +
  // SIP/PSTN fallback (Telnyx voice calls go through ChatCallsTab modal,
  // not the native CallKit/Telecom path, so they keep using CallContext).
  const nativeSnapshot = useCurrentCall();
  const ctxState = _useCall
    ? _useCall()
    : { isInCall: false, callData: null, callStartTime: null, endCall: () => {}, getCallDuration: () => 0 };

  // Prefer the native snapshot. Fall back to JS context for web + SIP.
  // Build a unified `callData` shape so the rest of the component below
  // doesn't have to branch on the source.
  const fromNative = !!nativeSnapshot;
  const callData = fromNative ? {
    callId: nativeSnapshot.callId,
    contactName: nativeSnapshot.contactName,
    contactEmail: nativeSnapshot.contactEmail,
    isVideo: nativeSnapshot.isVideo,
    conversationId: '', // not present in the minimal snapshot — read from
                        // CallContext if absolutely needed (deep-link only)
    isCaller: false,    // ditto — not surfaced by native, JS treats as N/A
    callType: 'native',
  } : ctxState.callData;
  const isInCall = fromNative ? true : ctxState.isInCall;
  const endCall = ctxState.endCall; // JS-side cleanup still goes through CallContext

  const { t } = useLanguage();
  const [duration, setDuration] = useState(0);
  const router = useRouter();
  const pathname = usePathname();
  const timerRef = useRef(null);
  const slideAnim = useRef(new Animated.Value(-100)).current;

  // Timer
  // When state comes from native, durationSec is already authoritative —
  // we skip the local clock so JS Hermes time can't drift away from CFAbs.
  useEffect(() => {
    if (fromNative) {
      setDuration(nativeSnapshot.durationSec);
      // Cleanup any leftover JS timer from a previous fallback render.
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      return;
    }
    if (!isInCall || !ctxState.callStartTime) {
      if (timerRef.current) clearInterval(timerRef.current);
      setDuration(0);
      return;
    }
    setDuration(ctxState.getCallDuration());
    timerRef.current = setInterval(() => setDuration(ctxState.getCallDuration()), 1000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [fromNative, nativeSnapshot?.durationSec, isInCall, ctxState.callStartTime]);

  // Show/hide animation
  const shouldShow = isInCall && pathname !== '/call';
  useEffect(() => {
    Animated.spring(slideAnim, {
      toValue: shouldShow ? 0 : -100,
      friction: 10, tension: 60,
      useNativeDriver: true,
    }).start();
  }, [shouldShow]);

  // GUARANTEED hang up — closes WebRTC, signals peer, clears state.
  const handleHangUp = useCallback(() => {
    // 1. Close WebRTC via shared global state (works across module chunks)
    try {
      const { hangupGlobalCall } = require('../services/callState');
      hangupGlobalCall();
    } catch {}
    // 2. Send call_end via WS so the OTHER side hangs up too
    try {
      const mailWs = require('../services/websocket').default;
      if (callData?.callId) {
        // Send via _send if connected; also try sendSignaling fallback
        if (mailWs?.isConnected && mailWs._send) {
          mailWs._send({ type: 'call_end', call_id: callData.callId, target_email: callData.contactEmail || '', reason: 'hangup' });
        }
        if (mailWs?.sendSignaling) {
          mailWs.sendSignaling('call_end', { call_id: callData.callId, target_email: callData.contactEmail || '', reason: 'hangup' });
        }
      }
    } catch {}
    // 3. Stop ringtone
    try { require('../services/ringtone').stopRingtone(); } catch {}
    // 4. Tell CallKit/CallKeep the call ended (iOS native call UI)
    try {
      const { endCall: callKeepEnd } = require('../services/callkeep');
      if (callData?.callId && callKeepEnd) callKeepEnd(callData.callId);
    } catch {}
    // 5. Disable proximity sensor + deactivate audio session so iOS
    // routes audio back to normal and the screen doesn't stay blank
    // after a minimized call is hung up via this banner.
    try {
      const ExpoAudioSession = require('../modules/expo-audio-session').default;
      ExpoAudioSession?.enableProximitySensor?.(false);
      ExpoAudioSession?.deactivate?.().catch?.(() => {});
    } catch {}
    // 6. Clear app-level state
    try { require('./ActiveCallBar').clearActiveCall(); } catch {}
    try { endCall(); } catch {}
  }, [callData, endCall]);

  // Return to call
  const handlePress = useCallback(() => {
    if (!callData) return;
    // SIP call (PSTN dial via Telnyx) lives inside ChatCallsTab modal — try to resume via the
    // OngoingCallBar shared state which has an onResume callback set by ChatCallsTab.
    if (callData.callType === 'sip') {
      try {
        const { getOngoingCall } = require('./OngoingCallBar');
        const og = getOngoingCall?.();
        if (typeof og?.onResume === 'function') { og.onResume(); return; }
      } catch {}
      // Fallback: open the calls tab inside chat
      try { router.push('/chat?tab=calls'); return; } catch {}
    }
    // [WAVE 117A] Mobile = 100% native. Tap-to-return re-opens native call
    // screen via ExpoCallKit.openNativeCall. Web resumes via /call.js.
    if (Platform.OS === 'ios' || Platform.OS === 'android') {
      try {
        const ExpoCallKit = require('../modules/expo-callkit');
        ExpoCallKit.openNativeCall({
          callId: callData.callId || '',
          callerName: callData.contactName || '',
          callerEmail: callData.contactEmail || '',
          hasVideo: !!callData.isVideo,
          lkUrl: null,
          lkToken: null,
        }).catch((e) => console.warn('[CallStatusBar] openNativeCall failed:', e));
      } catch (e) { console.warn('[CallStatusBar] openNativeCall import failed:', e); }
      return;
    }
    // Web: navigate back to /call.js
    try {
      router.push({ pathname: '/call', params: {
        callId: callData.callId || '', contactName: callData.contactName || '',
        contactEmail: callData.contactEmail || '', isVideo: callData.isVideo ? '1' : '0',
        conversationId: callData.conversationId || '', isCaller: callData.isCaller ? '1' : '0',
      }});
    } catch { try { router.push('/call'); } catch {} }
  }, [callData, router]);

  // Skip render entirely when on /call screen — without this, the bar
  // (positioned absolute, full width, with green+red children) animates
  // its translateY from 0→-100 and the bottom 8-10px of the bar bleeds
  // visible above the call screen as a green+red strip (bug print 2026-05-12).
  if (!shouldShow) return null;

  const m = Math.floor(duration / 60);
  const s = duration % 60;
  const timeStr = `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  const contactName = callData?.contactName || callData?.contactEmail?.split('@')[0] || '';

  return (
    <Animated.View style={[styles.container, { paddingTop: SAFE_TOP, transform: [{ translateY: slideAnim }] }]}>
      <TouchableOpacity style={styles.bar} onPress={handlePress} activeOpacity={0.8}>
        <View style={styles.left}>
          {/* Pulsing dot = "live call now". Plain solid dot before;
              now breathes between 0.55 and 1 opacity so the bar
              actively signals the call is ongoing instead of looking
              like a static banner. */}
          <PulseDot />
          {callData?.isVideo ? <IconVideo size={14} color="#fff" /> : <IconPhone size={14} color="#fff" />}
          <AvatarCircle email={callData?.contactEmail} name={contactName} size={24} />
          <Text style={styles.name} numberOfLines={1}>{contactName}</Text>
          <Text style={styles.timer}>{timeStr}</Text>
        </View>
        <TouchableOpacity
          style={styles.hangUpBtn}
          onPress={(e) => { e.stopPropagation?.(); handleHangUp(); }}
          activeOpacity={0.6}
          hitSlop={{ top: 15, bottom: 15, left: 15, right: 15 }}
        >
          <IconPhoneOff size={14} color="#fff" />
          <Text style={styles.hangUpText}>{t('call.hangUp') || 'Desligar'}</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // WhatsApp-green minimized call bar — matches the native Phone app UX.
  container: { position: 'absolute', top: 0, left: 0, right: 0, zIndex: 99999, backgroundColor: '#25D366' },
  bar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', height: 40, paddingHorizontal: 16 },
  left: { flexDirection: 'row', alignItems: 'center', gap: 8, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  name: { color: '#fff', fontSize: 14, fontWeight: '600', flex: 1 },
  timer: { color: 'rgba(255,255,255,0.95)', fontSize: 13, fontWeight: '700', fontVariant: ['tabular-nums'], marginRight: 12 },
  hangUpBtn: { flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#C62828', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 20 },
  hangUpText: { color: '#fff', fontSize: 12, fontWeight: '600' },
});
