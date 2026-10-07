// [2026-10-07 voice-native] Live recording level meter — RN Animated version
// (web + native fallback when Reanimated isn't on the binary). Polls
// `getLevel()` (0..1) at `hz`, shifts a ring of bar values and writes them
// with Animated.Value.setValue — no React render per sample.
import React, { useEffect, useRef } from 'react';
import { View, Animated, StyleSheet } from 'react-native';

export const METER_BAR_H = 30;

export default function VoiceLiveMeterLegacy({ getLevel, active = true, color = '#111111', bars = 28, hz = 20 }) {
  const valsRef = useRef(null);
  if (!valsRef.current || valsRef.current.length !== bars) {
    valsRef.current = Array.from({ length: bars }, () => new Animated.Value(0.12));
  }
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
      const vals = valsRef.current;
      for (let i = 0; i < vals.length; i++) vals[i].setValue(r[i] ?? 0.12);
    }, Math.max(16, Math.round(1000 / hz)));
    return () => clearInterval(id);
  }, [active, hz]);

  return (
    <View style={st.row} pointerEvents="none">
      {valsRef.current.map((v, i) => (
        <Animated.View key={i} style={[st.bar, { backgroundColor: color, transform: [{ scaleY: v }] }]} />
      ))}
    </View>
  );
}

const st = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 36, overflow: 'hidden' },
  bar: { width: 3, height: METER_BAR_H, borderRadius: 1.5 },
});
