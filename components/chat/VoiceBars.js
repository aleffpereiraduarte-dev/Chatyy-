// [2026-10-07 voice-native] Static voice-note waveform bars — rendered ONCE
// per (bars, color) and memoised. Progress is drawn by the parent with an
// animated clip/mask over a second copy of these bars (VoiceWaveform*), so a
// playing note never re-renders its 40 bars.
import React, { memo } from 'react';
import { View, StyleSheet } from 'react-native';

export const VOICE_WAVE_HEIGHT = 36;
export const VOICE_BAR_W = 3;
export const VOICE_BAR_GAP = 1.5;

// Deterministic fallback bars from a URL hash (older notes without peaks).
export function generateVoiceBars(url, count = 40) {
  let hash = 0;
  const str = url || 'audio';
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  const bars = [];
  for (let i = 0; i < count; i++) {
    const seed = Math.abs((hash * (i + 1) * 2654435761) | 0);
    const normalized = (seed % 1000) / 1000;
    const position = i / count;
    const envelope = Math.sin(position * Math.PI) * 0.5 + 0.5;
    bars.push(0.15 + normalized * 0.85 * envelope);
  }
  return bars;
}

// Resample any-length level series (e.g. 30 Hz recorder samples) into `count`
// bars using the per-bucket peak, normalised to 0..1.
export function resampleVoiceLevels(levels, count = 40) {
  if (!Array.isArray(levels) || levels.length === 0) return [];
  const src = levels.map((v) => { const n = Number(v); return isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; });
  if (src.length <= count) return src;
  const out = [];
  const step = src.length / count;
  for (let i = 0; i < count; i++) {
    const a = Math.floor(i * step);
    const b = Math.max(a + 1, Math.floor((i + 1) * step));
    let peak = 0;
    for (let j = a; j < b && j < src.length; j++) if (src[j] > peak) peak = src[j];
    out.push(Math.round(peak * 1000) / 1000);
  }
  return out;
}

function VoiceBarsImpl({ bars, color, opacity = 1 }) {
  return (
    <View style={st.row} pointerEvents="none">
      {bars.map((h, i) => (
        <View
          key={i}
          style={{
            width: VOICE_BAR_W,
            height: Math.max(3, Math.min(26, h * 26)),
            borderRadius: VOICE_BAR_W / 2,
            backgroundColor: color,
            opacity,
          }}
        />
      ))}
    </View>
  );
}

export const VoiceBars = memo(VoiceBarsImpl, (a, b) => a.bars === b.bars && a.color === b.color && a.opacity === b.opacity);

const st = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: VOICE_BAR_GAP,
    height: VOICE_WAVE_HEIGHT,
    overflow: 'hidden',
  },
});
