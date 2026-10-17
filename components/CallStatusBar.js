/**
 * CallStatusBar — "Ligação em andamento" (WhatsApp-style ongoing call bar).
 *
 * [2026-10-11 ongoing-call] Rewritten. While a call (1:1 or group, voice or
 * video) is MINIMIZED the user uses the app normally (chat list, open any
 * chat, send text/photos) and this bar sits on top of every screen:
 *
 *   ● Toque para voltar à ligação            [mic] [end]
 *     Fulano · 02:31
 *
 * - Tap → returns to the SAME live call screen (no reconnection): native
 *   CallViewController / GroupCallViewController (iOS) or CallActivity /
 *   GroupCallActivity (Android) via ExpoCallKit.restoreOngoingCall; web →
 *   /call (restores the parked LiveKit Room from services/callState).
 * - Mute / end quick actions go through the native call screen's own paths
 *   (setOngoingCallMuted / hangupOngoingCall) so its UI stays in sync.
 * - The bar PUSHES the navigation stack down (CallBarInsetProvider below +
 *   app/_layout.js) instead of covering screen headers.
 * - P&B premium: the strip uses the theme background (status-bar icons keep
 *   their contrast) with an inverted pill (black on light / white on dark)
 *   and a breathing dot. 44pt targets, no emoji.
 *
 * State source on mobile: the native snapshot (services/call-state-reader.js)
 * — `minimized` says the call screen is not the visible one. Web (and the
 * legacy SIP path) keeps the JS CallContext fallback.
 */
import React, { useEffect, useState, useRef, useCallback, useMemo, useSyncExternalStore, useLayoutEffect } from 'react';
import { View, Text, Pressable, StyleSheet, Animated, Platform } from 'react-native';
import { useRouter, usePathname } from 'expo-router';
import { useSafeAreaInsets, SafeAreaInsetsContext } from 'react-native-safe-area-context';
import { IconPhone, IconPhoneOff, IconVideo, IconMic, IconMicOff } from './Icons';
import { useCurrentCall } from '../services/call-state-reader';
import { useLanguage } from '../context/LanguageContext';
import { useVoiceBarInset, voiceBarShift, runVoiceBarShift } from '../services/voiceBarInset';

// Lazy resolved at module load (outside the component) — does NOT call hooks itself
let _useCall = null;
try { _useCall = require('../context/CallContext').useCall; } catch {}
let _useTheme = null;
try { _useTheme = require('../context/ThemeContext').useTheme; } catch {}

const IS_NATIVE = Platform.OS === 'ios' || Platform.OS === 'android';

// Height of the bar BELOW the top safe-area inset (pill 44 + 6 breathing room).
export const CALL_BAR_CONTENT_H = 50;

// ── Tiny external store: is the bar visible? (drives the layout shift) ──
let _barVisible = false;
const _barListeners = new Set();
function _setBarVisible(v) {
  const nv = !!v;
  if (nv === _barVisible) return;
  _barVisible = nv;
  _barListeners.forEach((fn) => { try { fn(); } catch {} });
}
function _subscribeBar(fn) { _barListeners.add(fn); return () => _barListeners.delete(fn); }
function _getBar() { return _barVisible; }

/** Extra top space the ongoing-call bar takes below the safe-area inset (0 when hidden). */
export function useCallBarHeight() {
  const v = useSyncExternalStore(_subscribeBar, _getBar, _getBar);
  return v ? CALL_BAR_CONTENT_H : 0;
}

// Real (un-shifted) insets, for screens the OS presents OVER the whole window.
const RealInsetsContext = React.createContext(null);

/**
 * Wraps the root navigator. While the bar is visible the whole stack is pushed
 * below it and screens see top inset 0 (the bar already covers the status-bar
 * area), so headers / back buttons are never hidden under the bar.
 * ALWAYS rendered (never toggled) so the navigator is never remounted.
 */
export function CallBarInsetProvider({ children }) {
  const insets = useSafeAreaInsets();
  const callH = useCallBarHeight();
  // [2026-10-15 voice-bar] The voice-note strip (push mode) stacks right under
  // the call bar and pushes the navigator the same way — never covers headers
  // or large titles. Its height change glides via a native-driver translateY.
  const voiceH = useVoiceBarInset();
  const barH = callH + voiceH;
  const prevVoiceH = useRef(voiceH);
  useLayoutEffect(() => {
    const d = voiceH - prevVoiceH.current;
    prevVoiceH.current = voiceH;
    if (d) runVoiceBarShift(d);
  }, [voiceH]);
  const shifted = useMemo(
    () => (barH ? { top: 0, bottom: insets.bottom, left: insets.left, right: insets.right } : insets),
    [barH, insets]
  );
  return (
    <RealInsetsContext.Provider value={insets}>
      <View style={{ flex: 1, paddingTop: barH ? insets.top + barH : 0 }}>
        {/* Web: no transform (it would re-root position:fixed descendants). */}
        <Animated.View style={IS_NATIVE ? { flex: 1, transform: [{ translateY: voiceBarShift }] } : { flex: 1 }}>
          <SafeAreaInsetsContext.Provider value={shifted}>{children}</SafeAreaInsetsContext.Provider>
        </Animated.View>
      </View>
    </RealInsetsContext.Provider>
  );
}

// iOS presents these as real UIKit modals over the WHOLE window (not inside
// the shifted container) → they need the real status-bar inset back.
const IOS_WINDOW_MODALS = new Set(['modal', 'fullScreenModal', 'transparentModal', 'formSheet', 'pageSheet']);

// [2026-10-17 drag-dismiss] pageSheet ('modal'/'pageSheet') no iPhone desce do
// topo SEM cobrir a status bar → inset de cima = 0 dentro da folha (antes a tela
// recebia o inset da RAIZ = faixa vazia no topo, por isso tudo era fullScreenModal
// e não descia arrastando). Lados/baixo seguem os reais.
const IOS_SHEET_MODALS = new Set(['modal', 'pageSheet']);
function ModalInsetRestore({ presentation, children }) {
  const real = React.useContext(RealInsetsContext);
  const ctx = React.useContext(SafeAreaInsetsContext);
  const barH = useCallBarHeight() + useVoiceBarInset();
  const sheet = IOS_SHEET_MODALS.has(presentation);
  const base = (barH && real) ? real : ctx;
  const sheetInsets = React.useMemo(
    () => (sheet && base ? { top: 0, bottom: base.bottom, left: base.left, right: base.right } : null),
    [sheet, base]
  );
  if (sheetInsets) return <SafeAreaInsetsContext.Provider value={sheetInsets}>{children}</SafeAreaInsetsContext.Provider>;
  if (!barH || !real || !IOS_WINDOW_MODALS.has(presentation)) return children;
  return <SafeAreaInsetsContext.Provider value={real}>{children}</SafeAreaInsetsContext.Provider>;
}

/** Stack `screenLayout` — restores real insets inside iOS window modals. */
export function callBarScreenLayout({ children, options }) {
  if (Platform.OS !== 'ios') return children;
  return <ModalInsetRestore presentation={options?.presentation}>{children}</ModalInsetRestore>;
}

// Breathing dot that signals a live call (0.45 → 1 over 1.6s).
function PulseDot({ color }) {
  const op = useRef(new Animated.Value(0.45)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(op, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(op, { toValue: 0.45, duration: 800, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  return <Animated.View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color, opacity: op }} />;
}

function _fmt(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(r).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

let _ExpoCallKit;
function _ck() {
  if (_ExpoCallKit !== undefined) return _ExpoCallKit;
  try { _ExpoCallKit = IS_NATIVE ? require('../modules/expo-callkit') : null; } catch { _ExpoCallKit = null; }
  return _ExpoCallKit;
}

export default function CallStatusBar() {
  const nativeSnapshot = useCurrentCall();
  const ctxState = _useCall
    ? _useCall()
    : { isInCall: false, callData: null, callStartTime: null, endCall: () => {}, getCallDuration: () => 0 };
  const theme = _useTheme ? _useTheme() : { isDark: false };
  const isDark = !!theme?.isDark;
  const { t } = useLanguage();
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();

  // iOS: tell native the JS bar owns the surface (its fallback overlay stays off).
  useEffect(() => {
    if (!IS_NATIVE) return undefined;
    try { _ck()?.setInAppCallBarActive?.(true); } catch {}
    return () => { try { _ck()?.setInAppCallBarActive?.(false); } catch {} };
  }, []);

  // ── Resolve the source ──
  const fromNative = !!nativeSnapshot && !!nativeSnapshot.canRestore;
  const callData = fromNative ? {
    callId: nativeSnapshot.callId,
    contactName: nativeSnapshot.contactName,
    contactEmail: nativeSnapshot.contactEmail,
    isVideo: nativeSnapshot.isVideo,
    isGroup: nativeSnapshot.isGroup,
    conversationId: nativeSnapshot.conversationId,
    callType: 'native',
  } : ctxState.callData;

  const shouldShow = fromNative
    ? !!nativeSnapshot.minimized
    : (!nativeSnapshot && !!ctxState.isInCall && pathname !== '/call');

  // Mute state: native snapshot is authoritative; web reads the parked Room.
  const [webMuted, setWebMuted] = useState(false);
  const muted = fromNative ? !nativeSnapshot.mic : webMuted;

  // ── Duration ──
  const [duration, setDuration] = useState(0);
  useEffect(() => {
    if (!shouldShow) return undefined;
    if (fromNative) { setDuration(nativeSnapshot.durationSec || 0); return undefined; }
    const tick = () => {
      // Web: the parked call carries its own clock (services/callState GC).
      try {
        const gc = require('../services/callState').getGlobalCall?.();
        if (gc && gc.callId === callData?.callId && typeof gc.duration === 'number') {
          const extra = gc.minimizedAt ? Math.floor((Date.now() - gc.minimizedAt) / 1000) : 0;
          setDuration(gc.duration + extra);
          try {
            const mic = gc.room?.localParticipant?.isMicrophoneEnabled;
            if (typeof mic === 'boolean') setWebMuted(!mic);
          } catch {}
          return;
        }
      } catch {}
      setDuration(ctxState.getCallDuration ? ctxState.getCallDuration() : 0);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [shouldShow, fromNative, nativeSnapshot?.durationSec, callData?.callId, ctxState.callStartTime]);

  // Publish visibility for the layout shift.
  useEffect(() => { _setBarVisible(shouldShow); }, [shouldShow]);
  useEffect(() => () => _setBarVisible(false), []);

  // ── Actions ──
  const handlePress = useCallback(() => {
    if (!callData) return;
    if (fromNative) {
      try { if (_ck()?.restoreOngoingCall?.()) return; } catch {}
    }
    // SIP call (PSTN dial via Telnyx) lives inside the ChatCallsTab modal.
    if (callData.callType === 'sip') {
      try {
        const { getOngoingCall } = require('./OngoingCallBar');
        const og = getOngoingCall?.();
        if (typeof og?.onResume === 'function') { og.onResume(); return; }
      } catch {}
      try { router.push('/chat?tab=calls'); return; } catch {}
    }
    // Web (and JS-owned mobile fallback): back to /call, which re-adopts the
    // parked Room from services/callState (no reconnection).
    try {
      router.push({ pathname: '/call', params: {
        callId: callData.callId || '', contactName: callData.contactName || '',
        contactEmail: callData.contactEmail || '', isVideo: callData.isVideo ? '1' : '0',
        conversationId: callData.conversationId ? String(callData.conversationId) : '', isCaller: callData.isCaller ? '1' : '0',
      } });
    } catch { try { router.push('/call'); } catch {} }
  }, [callData, fromNative, router]);

  const handleToggleMute = useCallback(() => {
    if (fromNative) {
      try { _ck()?.setOngoingCallMuted?.(!muted); } catch {}
      return;
    }
    try {
      const gc = require('../services/callState').getGlobalCall?.();
      const lp = gc?.room?.localParticipant;
      if (lp?.setMicrophoneEnabled) {
        const next = !!muted; // muted → enable
        lp.setMicrophoneEnabled(next).catch?.(() => {});
        setWebMuted(!next);
      }
    } catch {}
  }, [fromNative, muted]);

  const handleHangUp = useCallback(() => {
    if (fromNative) {
      try { if (_ck()?.hangupOngoingCall?.()) return; } catch {}
    }
    // Web / JS fallback: close the parked Room, signal the peer, clear state.
    try { require('../services/callState').hangupGlobalCall(); } catch {}
    try {
      const mailWs = require('../services/websocket').default;
      if (callData?.callId) {
        const payload = { call_id: callData.callId, target_email: callData.contactEmail || '', reason: 'hangup' };
        if (mailWs?.isConnected && mailWs._send) mailWs._send({ type: 'call_end', ...payload });
        else if (mailWs?.sendSignaling) mailWs.sendSignaling('call_end', payload);
      }
    } catch {}
    try { require('../services/ringtone').stopRingtone(); } catch {}
    try {
      const { endCall: callKeepEnd } = require('../services/callkeep');
      if (callData?.callId && callKeepEnd) callKeepEnd(callData.callId);
    } catch {}
    try {
      const ExpoAudioSession = require('../modules/expo-audio-session').default;
      ExpoAudioSession?.enableProximitySensor?.(false);
      ExpoAudioSession?.deactivate?.().catch?.(() => {});
    } catch {}
    try { require('./ActiveCallBar').clearActiveCall(); } catch {}
    try { ctxState.endCall?.(); } catch {}
  }, [callData, fromNative, ctxState.endCall]);

  // Slide-in once per appearance.
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!shouldShow) return;
    slide.setValue(0);
    Animated.timing(slide, { toValue: 1, duration: 220, useNativeDriver: true }).start();
  }, [shouldShow]);

  if (!shouldShow || !callData) return null;

  const name = callData.contactName
    || (callData.contactEmail ? String(callData.contactEmail).split('@')[0] : '')
    || (callData.isGroup ? (t('call.ongoing.groupCall') || 'Ligação em grupo') : '');
  const ringState = fromNative ? nativeSnapshot.ringState : 'active';
  const connected = fromNative ? (nativeSnapshot.lkConnected || ringState === 'active') : true;
  let sub;
  if (ringState === 'held') sub = t('call.ongoing.onHold') || 'Em espera';
  else if (ringState === 'ringing') sub = t('call.ongoing.calling') || 'Chamando…';
  else if (!connected || ringState === 'connecting') sub = t('call.ongoing.connecting') || 'Conectando…';
  else sub = _fmt(duration);

  // P&B: strip = theme background; pill = inverted.
  const stripBg = isDark ? '#000000' : '#FFFFFF';
  const pillBg = isDark ? '#F2F2F2' : '#111111';
  const fg = isDark ? '#111111' : '#FFFFFF';
  const fgDim = isDark ? 'rgba(17,17,17,0.62)' : 'rgba(255,255,255,0.66)';
  const btnBg = isDark ? 'rgba(17,17,17,0.08)' : 'rgba(255,255,255,0.14)';
  const tapLabel = t('call.ongoing.tapToReturn') || 'Toque para voltar à ligação';

  return (
    <Animated.View
      style={[
        styles.container,
        {
          paddingTop: insets.top,
          height: insets.top + CALL_BAR_CONTENT_H,
          backgroundColor: stripBg,
          opacity: slide,
          transform: [{ translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [-12, 0] }) }],
        },
      ]}
    >
      <Pressable
        onPress={handlePress}
        style={({ pressed }) => [styles.pill, { backgroundColor: pillBg, opacity: pressed ? 0.85 : 1 }]}
        accessibilityRole="button"
        accessibilityLabel={`${tapLabel}. ${name} ${sub}`}
      >
        <PulseDot color={fg} />
        {callData.isVideo ? <IconVideo size={15} color={fg} /> : <IconPhone size={15} color={fg} />}
        <View style={styles.texts}>
          <Text style={[styles.title, { color: fg }]} numberOfLines={1}>{tapLabel}</Text>
          <Text style={[styles.sub, { color: fgDim }]} numberOfLines={1}>
            {name ? `${name} · ${sub}` : sub}
          </Text>
        </View>
        <Pressable
          onPress={handleToggleMute}
          style={({ pressed }) => [styles.action, { opacity: pressed ? 0.6 : 1 }]}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={muted ? (t('call.ongoing.unmute') || 'Ativar som') : (t('call.ongoing.mute') || 'Silenciar')}
          accessibilityState={{ selected: muted }}
        >
          <View style={[styles.actionCircle, { backgroundColor: muted ? fg : btnBg }]}>
            {muted ? <IconMicOff size={16} color={pillBg} /> : <IconMic size={16} color={fg} />}
          </View>
        </Pressable>
        <Pressable
          onPress={handleHangUp}
          style={({ pressed }) => [styles.action, { opacity: pressed ? 0.6 : 1 }]}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityLabel={t('call.ongoing.end') || 'Encerrar ligação'}
        >
          <View style={[styles.actionCircle, { backgroundColor: '#E53935' }]}>
            <IconPhoneOff size={16} color="#FFFFFF" />
          </View>
        </Pressable>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute', top: 0, left: 0, right: 0,
    zIndex: 99999, elevation: 30,
    paddingHorizontal: 8, justifyContent: 'flex-start',
  },
  pill: {
    height: 44, borderRadius: 22,
    flexDirection: 'row', alignItems: 'center',
    paddingLeft: 14, paddingRight: 0, gap: 8,
    shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 10, shadowOffset: { width: 0, height: 3 },
  },
  texts: { flex: 1, minWidth: 0 },
  title: { fontSize: 13, fontWeight: '700', letterSpacing: 0.1 },
  sub: { fontSize: 11.5, fontWeight: '500', fontVariant: ['tabular-nums'], marginTop: 1 },
  action: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  actionCircle: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});
