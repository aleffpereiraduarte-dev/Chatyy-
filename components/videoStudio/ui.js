// [2026-10-13 video-studio] Peças de UI do estúdio (P&B premium, sem emoji).
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, Modal, Pressable, StyleSheet, PanResponder, Platform, TouchableOpacity } from 'react-native';
import KeyboardSafeView from '../ui/KeyboardSafeView'; // [2026-10-22 kb-uniforme]
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Path } from 'react-native-svg';

export const C = {
  bg: '#000000',
  panel: '#0E0E0E',
  card: '#1A1A1A',
  line: 'rgba(255,255,255,0.12)',
  fg: '#FFFFFF',
  fg2: 'rgba(255,255,255,0.68)',
  fg3: 'rgba(255,255,255,0.42)',
};

export function IconClose({ size = 20, color = '#fff' }) {
  return <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round"><Path d="M6 6l12 12M18 6L6 18" /></Svg>;
}

/** Folha inferior escura. `full` = ocupa ~90% da altura. */
export function StudioSheet({ visible, onClose, title, right, children, full = false, avoidKeyboard = false }) {
  const insets = useSafeAreaInsets();
  const Body = avoidKeyboard ? KeyboardSafeView : View; // [2026-10-22 kb-uniforme] Android: KAV sem behavior não fazia nada
  return (
    <Modal visible={!!visible} transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <Body style={styles.backdrop} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" />
        <View style={[styles.sheet, full && { height: '90%' }, { paddingBottom: Math.max(12, insets.bottom) }]}>
          <View style={styles.grabber} />
          {(title || right) ? (
            <View style={styles.head}>
              <TouchableOpacity onPress={onClose} hitSlop={10} style={styles.headBtn} accessibilityRole="button"><IconClose /></TouchableOpacity>
              <Text style={styles.title} numberOfLines={1}>{title}</Text>
              <View style={[styles.headBtn, { alignItems: 'flex-end' }]}>{right}</View>
            </View>
          ) : null}
          {children}
        </View>
      </Body>
    </Modal>
  );
}

/** Slider horizontal 0..1 (PanResponder; leve). */
export function Slider({ value = 0, onChange, onEnd, min = 0, max = 1, style, disabled }) {
  const wRef = useRef(1);
  const xRef = useRef(0);
  const [drag, setDrag] = useState(null);
  const v = drag != null ? drag : value;
  const frac = (Math.max(min, Math.min(max, v)) - min) / (max - min || 1);
  const pr = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !disabled,
    onMoveShouldSetPanResponder: () => !disabled,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { const x = e.nativeEvent.locationX; xRef.current = x; const nv = min + (Math.max(0, Math.min(wRef.current, x)) / wRef.current) * (max - min); setDrag(nv); onChange?.(nv); },
    onPanResponderMove: (_e, g) => { const x = xRef.current + g.dx; const nv = min + (Math.max(0, Math.min(wRef.current, x)) / wRef.current) * (max - min); setDrag(nv); onChange?.(nv); },
    onPanResponderRelease: (_e, g) => { const x = xRef.current + g.dx; const nv = min + (Math.max(0, Math.min(wRef.current, x)) / wRef.current) * (max - min); setDrag(null); onEnd?.(nv); },
    onPanResponderTerminate: () => setDrag(null),
  }), [min, max, onChange, onEnd, disabled]);
  return (
    <View style={[styles.slider, style, disabled && { opacity: 0.4 }]} onLayout={(e) => { wRef.current = Math.max(1, e.nativeEvent.layout.width); }} {...pr.panHandlers}>
      <View style={styles.track} pointerEvents="none">
        <View style={[styles.fill, { width: `${frac * 100}%` }]} />
      </View>
      <View pointerEvents="none" style={[styles.knob, { left: `${frac * 100}%` }]} />
    </View>
  );
}

export function Chip({ label, on, onPress, style, children }) {
  return (
    <TouchableOpacity onPress={onPress} style={[styles.chip, on && styles.chipOn, style]} accessibilityRole="button" accessibilityState={{ selected: !!on }}>
      {children}
      {label != null ? <Text style={[styles.chipTxt, on && { color: '#000' }]} numberOfLines={1}>{label}</Text> : null}
    </TouchableOpacity>
  );
}

export function PrimaryButton({ label, onPress, disabled, style, dark }) {
  return (
    <TouchableOpacity onPress={onPress} disabled={disabled} style={[styles.primary, dark && styles.primaryDark, disabled && { opacity: 0.4 }, style]} accessibilityRole="button">
      <Text style={[styles.primaryTxt, dark && { color: '#fff' }]}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: { backgroundColor: C.panel, borderTopLeftRadius: 18, borderTopRightRadius: 18, borderTopWidth: 1, borderColor: C.line, paddingTop: 8, maxHeight: '92%' },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', marginBottom: 6 },
  head: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, height: 44 },
  headBtn: { width: 72 },
  title: { flex: 1, textAlign: 'center', color: C.fg, fontSize: 16, fontWeight: '800' },
  slider: { height: 32, justifyContent: 'center' },
  track: { height: 3, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' },
  fill: { height: 3, backgroundColor: '#fff' },
  knob: { position: 'absolute', width: 18, height: 18, borderRadius: 9, marginLeft: -9, backgroundColor: '#fff', top: 7 },
  chip: { height: 32, paddingHorizontal: 12, borderRadius: 16, borderWidth: 1, borderColor: C.line, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 6 },
  chipOn: { backgroundColor: '#fff', borderColor: '#fff' },
  chipTxt: { color: C.fg, fontSize: 13, fontWeight: '700' },
  primary: { height: 46, borderRadius: 23, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  primaryDark: { backgroundColor: C.card, borderWidth: 1, borderColor: C.line },
  primaryTxt: { color: '#000', fontSize: 15, fontWeight: '800' },
});
