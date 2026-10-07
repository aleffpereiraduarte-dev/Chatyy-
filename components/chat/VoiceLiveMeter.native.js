// [2026-10-07 voice-native] Live recording level meter on the UI THREAD.
//
// The recorder level (ExpoNativeAudio.currentLevelSync — 30 Hz native meter —
// or expo-audio metering on old binaries) is sampled at `hz` on JS (a sync
// JSI read, no bridge hop) and pushed into ONE shared value; each bar derives
// its scaleY on the UI thread and glides with a short withTiming, so the
// waveform "breathes" with the voice at 60 fps without a single React render.
// Gated like SwipeReplyRow: Reanimated only when utils/threadKeyboard loaded it
// on this binary; otherwise the RN-Animated meter (same props) is used.
import React, { memo, useEffect, useRef } from 'react';
import { View, StyleSheet } from 'react-native';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';
import VoiceLiveMeterLegacy, { METER_BAR_H } from './VoiceLiveMeterLegacy';

let Rea = null;
if (KEYBOARD_CONTROLLER_ACTIVE) {
  try {
    // eslint-disable-next-line global-require
    Rea = require('react-native-reanimated');
  } catch {
    Rea = null;
  }
}
const withTiming = Rea ? Rea.withTiming : null;
const UI_THREAD_OK = !!(Rea && Rea.default && Rea.useSharedValue && Rea.useAnimatedStyle && withTiming);

const MeterBar = memo(function MeterBar({ levels, index, color }) {
  const style = Rea.useAnimatedStyle(() => {
    'worklet';
    const arr = levels.get();
    const v = arr && arr[index] != null ? arr[index] : 0.12;
    return { transform: [{ scaleY: withTiming(v, { duration: 70 }) }] };
  });
  const AView = Rea.default.View;
  return <AView style={[st.bar, { backgroundColor: color }, style]} />;
});

function ReaMeter({ getLevel, active = true, color = '#111111', bars = 28, hz = 20 }) {
  const levels = Rea.useSharedValue(Array.from({ length: bars }, () => 0.12));
  const ring = useRef(Array.from({ length: bars }, () => 0.12));
  const getRef = useRef(getLevel);
  getRef.current = getLevel;

  useEffect(() => {
    if (!active) return undefined;
    const id = setInterval(() => {
      let lv = 0;
      try { lv = Number(getRef.current?.()) || 0; } catch { lv = 0; }
      lv = Math.max(0.12, Math.min(1, lv));
      const r = ring.current;
      r.shift();
      r.push(lv);
      levels.value = r.slice();
    }, Math.max(16, Math.round(1000 / hz)));
    return () => clearInterval(id);
  }, [active, hz, levels]);

  const idx = Array.from({ length: bars }, (_, i) => i);
  return (
    <View style={st.row} pointerEvents="none">
      {idx.map((i) => <MeterBar key={i} levels={levels} index={i} color={color} />)}
    </View>
  );
}

export default UI_THREAD_OK ? ReaMeter : VoiceLiveMeterLegacy;

const st = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 36, overflow: 'hidden' },
  bar: { width: 3, height: METER_BAR_H, borderRadius: 1.5 },
});
