// MediaSendOverlay + MediaPopIn — WhatsApp-level motion for outgoing photo/video bubbles.
//
// Reuses the app's existing RN-Animated pattern (no Reanimated, JS-only => OTA-safe).
//
//   <MediaPopIn enabled style>        optimistic bubble: 150ms scale .96->1 + fade-in on mount
//   <MediaSendOverlay                 sits absolute-fill over the media:
//       active={uploading}              - uploading: smooth animated ring (track + arc), X cancel in the center,
//       progress={0..100|undefined}       % and "x / y MB" under the ring (indeterminate spinner if undefined)
//       compressing sizeBytes          - active -> false (no failure): ring snaps to 100%, check pops in,
//       failed onRetry onCancel          then the whole overlay fades out (never a dry pop)
//   />                                 - failed: elegant scrim + retry icon, tap to resend
//
// Always rendered by the parent (so the "done" fade-out can run); it returns null when idle.

import React, { useRef, useEffect, useState, useMemo } from 'react';
import { View, Text, Animated, Easing, TouchableOpacity, Platform } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { IconX, IconCheck, IconRefresh } from './Icons';
import { isReduceMotionEnabled } from './reducedMotion';

const AnimatedCircle = Animated.createAnimatedComponent(Circle);

const RING = 64;
const STROKE = 3.5;
const R = (RING - STROKE) / 2;
const CIRC = 2 * Math.PI * R;

export function MediaPopIn({ style, children }) {
  // [2026-10-08 send-motion] A entrada do balão agora é da ROW inteira
  // (RowEnterMotion em app/chat-conversation.js: sobe 12px + .96→1 + fade,
  // decidida 1x por mensagem). Animar aqui de novo somava duas escalas
  // (.96×.96) e um 2º fade na foto/vídeo. Mantido como View simples p/ não
  // mexer nos call sites (`enabled` ignorado).
  return <View style={style}>{children}</View>;
}

const fmtMB = (b) => (b / 1048576).toFixed(1);

export default function MediaSendOverlay({
  active = false,
  progress,
  compressing = false,
  sizeBytes = 0,
  failed = false,
  onCancel,
  onRetry,
  cancelLabel = 'Cancelar',
  retryLabel = 'Toque para reenviar',
  failedLabel = 'Falha no envio',
  compressingLabel = 'Comprimindo...',
}) {
  // phase: 'idle' | 'uploading' | 'done' | 'failed'
  const [phase, setPhase] = useState(active ? 'uploading' : (failed ? 'failed' : 'idle'));
  const prevActive = useRef(active);

  const fade = useRef(new Animated.Value(active || failed ? 0 : 0)).current;
  const scale = useRef(new Animated.Value(0.9)).current;
  const prog = useRef(new Animated.Value(0)).current;
  const spin = useRef(new Animated.Value(0)).current;
  const checkV = useRef(new Animated.Value(0)).current;
  // [2026-10-08 send-motion] tremidinha suave do botão de reenviar quando o
  // envio FALHA com o balão na tela (não na montagem de um balão já falho).
  const shake = useRef(new Animated.Value(0)).current;
  const mountedOnceRef = useRef(false);
  const [pctText, setPctText] = useState(0);

  const indeterminate = active && progress === undefined && !compressing;

  // Phase transitions
  useEffect(() => {
    let timer;
    if (active) {
      setPhase('uploading');
      checkV.setValue(0);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 150, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, speed: 22, bounciness: 6, useNativeDriver: true }),
      ]).start();
    } else if (prevActive.current && !failed) {
      // upload finished OK: ring fills, check pops, overlay fades away
      setPhase('done');
      Animated.timing(prog, { toValue: 100, duration: 160, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
      Animated.sequence([
        Animated.spring(checkV, { toValue: 1, speed: 24, bounciness: 10, useNativeDriver: true }),
        Animated.delay(260),
        Animated.parallel([
          Animated.timing(fade, { toValue: 0, duration: 260, easing: Easing.in(Easing.quad), useNativeDriver: true }),
          Animated.timing(scale, { toValue: 1.06, duration: 260, useNativeDriver: true }),
        ]),
      ]).start(({ finished }) => {
        if (finished) {
          setPhase('idle');
          prog.setValue(0);
          scale.setValue(0.9);
        }
      });
    } else if (failed) {
      setPhase('failed');
      const _rm = isReduceMotionEnabled();
      const _shake = mountedOnceRef.current && !_rm;
      shake.setValue(0);
      Animated.parallel([
        Animated.timing(fade, { toValue: 1, duration: 200, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, speed: 20, bounciness: 6, useNativeDriver: true }),
        ...(_shake ? [Animated.sequence([-6, 6, -4, 3, -1.5, 0].map((to, i) => Animated.timing(shake, {
          toValue: to, duration: i === 0 ? 50 : 65, delay: i === 0 ? 120 : 0, easing: Easing.inOut(Easing.quad), useNativeDriver: true,
        })))] : []),
      ]).start();
    } else if (phase === 'failed') {
      // retry tapped -> failed cleared
      Animated.timing(fade, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => setPhase('idle'));
    }
    prevActive.current = active;
    mountedOnceRef.current = true;
    return () => { if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, failed]);

  // Smooth progress (the raw % arrives in coarse steps)
  useEffect(() => {
    if (!active || progress === undefined) return;
    const p = Math.max(0, Math.min(100, Number(progress) || 0));
    // never let the ring look empty once started
    Animated.timing(prog, { toValue: Math.max(p, 4), duration: 280, easing: Easing.out(Easing.quad), useNativeDriver: false }).start();
    setPctText(Math.round(p));
  }, [progress, active, prog]);

  // Indeterminate / compressing spinner
  useEffect(() => {
    if (!(indeterminate || (active && compressing))) return undefined;
    spin.setValue(0);
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1000, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [indeterminate, compressing, active, spin]);

  const dashOffset = useMemo(
    () => prog.interpolate({ inputRange: [0, 100], outputRange: [CIRC, 0], extrapolate: 'clamp' }),
    [prog]
  );

  if (phase === 'idle') return null;

  const spinning = phase === 'uploading' && (indeterminate || compressing);
  const arcOffset = spinning ? CIRC * 0.7 : dashOffset;

  if (phase === 'failed') {
    return (
      <Animated.View
        pointerEvents="box-none"
        style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 6,
          alignItems: 'center', justifyContent: 'center',
          backgroundColor: 'rgba(0,0,0,0.5)', opacity: fade,
        }}
      >
        <TouchableOpacity
          activeOpacity={0.75}
          onPress={(e) => { e?.stopPropagation?.(); onRetry && onRetry(); }}
          accessibilityRole="button"
          accessibilityLabel={retryLabel}
          style={{ alignItems: 'center', justifyContent: 'center', padding: 12 }}
        >
          <Animated.View
            style={{
              width: RING, height: RING, borderRadius: RING / 2,
              backgroundColor: 'rgba(255,255,255,0.16)',
              borderWidth: 1.5, borderColor: 'rgba(255,255,255,0.55)',
              alignItems: 'center', justifyContent: 'center',
              transform: [{ translateX: shake }, { scale }],
            }}
          >
            <IconRefresh size={28} color="#fff" />
          </Animated.View>
          <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700', marginTop: 10 }}>{failedLabel}</Text>
          <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 11.5, fontWeight: '500', marginTop: 2 }}>{retryLabel}</Text>
        </TouchableOpacity>
      </Animated.View>
    );
  }

  const done = phase === 'done';
  const spinStyle = spinning
    ? { transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }] }
    : null;

  return (
    <Animated.View
      pointerEvents={done ? 'none' : 'box-none'}
      style={{
        position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 6,
        alignItems: 'center', justifyContent: 'center',
        backgroundColor: 'rgba(0,0,0,0.38)', opacity: fade,
      }}
    >
      <Animated.View style={{ width: RING, height: RING, alignItems: 'center', justifyContent: 'center', transform: [{ scale }] }}>
        <View
          style={{
            position: 'absolute', width: RING, height: RING, borderRadius: RING / 2,
            backgroundColor: 'rgba(0,0,0,0.42)',
          }}
        />
        {/* ring: -90deg so the arc starts at 12 o'clock */}
        <Animated.View style={[{ position: 'absolute', width: RING, height: RING }, spinStyle]}>
          <Svg width={RING} height={RING} style={{ transform: [{ rotate: '-90deg' }] }}>
            <Circle cx={RING / 2} cy={RING / 2} r={R} stroke="rgba(255,255,255,0.28)" strokeWidth={STROKE} fill="none" />
            <AnimatedCircle
              cx={RING / 2}
              cy={RING / 2}
              r={R}
              stroke="#fff"
              strokeWidth={STROKE}
              fill="none"
              strokeLinecap="round"
              strokeDasharray={`${CIRC} ${CIRC}`}
              strokeDashoffset={arcOffset}
            />
          </Svg>
        </Animated.View>
        {done ? (
          <Animated.View
            style={{
              opacity: checkV,
              transform: [{ scale: checkV.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) }],
            }}
          >
            <IconCheck size={28} color="#fff" strokeWidth={3} />
          </Animated.View>
        ) : (
          <TouchableOpacity
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            onPress={(e) => { e?.stopPropagation?.(); onCancel && onCancel(); }}
            accessibilityRole="button"
            accessibilityLabel={cancelLabel}
            style={{ width: RING - 12, height: RING - 12, borderRadius: (RING - 12) / 2, alignItems: 'center', justifyContent: 'center' }}
          >
            <IconX size={22} color="#fff" />
          </TouchableOpacity>
        )}
      </Animated.View>
      {!done && (
        <View style={{ marginTop: 8, minHeight: 16, alignItems: 'center' }} pointerEvents="none">
          {compressing ? (
            <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 11.5, fontWeight: '600' }}>{compressingLabel}</Text>
          ) : indeterminate ? null : (
            <Text style={{ color: 'rgba(255,255,255,0.92)', fontSize: 11.5, fontWeight: '600', fontVariant: ['tabular-nums'] }}>
              {sizeBytes > 0
                ? `${fmtMB(sizeBytes * pctText / 100)} / ${fmtMB(sizeBytes)} MB`
                : `${pctText}%`}
            </Text>
          )}
        </View>
      )}
    </Animated.View>
  );
}
