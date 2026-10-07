// [2026-10-07 voice-native] Voice-note waveform — RN Animated implementation.
// Used on WEB and as the native fallback when Reanimated/Worklets are not
// available on the binary (see VoiceWaveform.native.js).
//
// Same contract as the Reanimated version:
//   ref.animateTo(ratio, ms)  → linear glide to `ratio` (between engine ticks)
//   ref.set(ratio)            → jump (seek / reset)
//   ref.isScrubbing()
// The bars are drawn once (VoiceBars, memoised); progress = a clip window
// sliding over a second copy of the bars (transform-only → native driver on
// iOS/Android, no layout per frame, no React render per tick).
import React, { forwardRef, useImperativeHandle, useRef, useState, useCallback } from 'react';
import { View, Animated, Easing, Platform, StyleSheet } from 'react-native';
import { VoiceBars, VOICE_WAVE_HEIGHT } from './VoiceBars';

const NATIVE_DRIVER = Platform.OS !== 'web';

const VoiceWaveformLegacy = forwardRef(function VoiceWaveformLegacy(
  { bars, playedColor, dimColor, thumbColor, durationMs = 0, onSeek, onScrubTime, initialRatio = 0 },
  ref,
) {
  const p = useRef(new Animated.Value(initialRatio)).current;
  const [w, setW] = useState(0);
  const wRef = useRef(0);
  const scrubbing = useRef(false);
  const anim = useRef(null);
  const lastSec = useRef(-1);
  const cbRef = useRef({ onSeek, onScrubTime, durationMs });
  cbRef.current = { onSeek, onScrubTime, durationMs };

  useImperativeHandle(ref, () => ({
    animateTo(target, ms) {
      if (scrubbing.current) return;
      try { anim.current?.stop(); } catch {}
      anim.current = Animated.timing(p, {
        toValue: Math.max(0, Math.min(1, target)),
        duration: Math.max(16, ms || 0),
        easing: Easing.linear,
        useNativeDriver: NATIVE_DRIVER,
      });
      anim.current.start();
    },
    set(v) {
      if (scrubbing.current) return;
      try { anim.current?.stop(); } catch {}
      p.setValue(Math.max(0, Math.min(1, v || 0)));
    },
    isScrubbing: () => scrubbing.current,
  }), [p]);

  const ratioOf = (e) => {
    const W = wRef.current;
    if (!W) return null;
    const x = e?.nativeEvent?.locationX ?? 0;
    return Math.max(0, Math.min(1, x / W));
  };
  const scrubTo = (r) => {
    p.setValue(r);
    const { onScrubTime: cb, durationMs: d } = cbRef.current;
    const s = Math.floor((r * (d || 0)) / 1000);
    if (cb && s !== lastSec.current) { lastSec.current = s; try { cb(r); } catch {} }
  };
  const onGrant = (e) => {
    scrubbing.current = true;
    try { anim.current?.stop(); } catch {}
    const r = ratioOf(e);
    if (r != null) scrubTo(r);
  };
  const onMove = (e) => { const r = ratioOf(e); if (r != null) scrubTo(r); };
  const onRelease = (e) => {
    const r = ratioOf(e);
    scrubbing.current = false;
    lastSec.current = -1;
    if (r != null) { try { cbRef.current.onSeek?.(r); } catch {} }
  };
  const onTerminate = () => { scrubbing.current = false; lastSec.current = -1; };

  const onLayout = useCallback((e) => {
    const W = e.nativeEvent.layout.width;
    if (Math.abs(W - wRef.current) > 0.5) { wRef.current = W; setW(W); }
  }, []);

  const clipX = p.interpolate({ inputRange: [0, 1], outputRange: [-w, 0] });
  const innerX = p.interpolate({ inputRange: [0, 1], outputRange: [w, 0] });
  const thumbX = p.interpolate({ inputRange: [0, 1], outputRange: [-4, w - 4] });

  return (
    <View
      style={st.row}
      onLayout={onLayout}
      onStartShouldSetResponder={() => true}
      onMoveShouldSetResponder={() => true}
      onResponderGrant={onGrant}
      onResponderMove={onMove}
      onResponderRelease={onRelease}
      onResponderTerminate={onTerminate}
    >
      <VoiceBars bars={bars} color={dimColor} opacity={0.5} />
      {w > 0 ? (
        <Animated.View pointerEvents="none" style={[st.clip, { width: w, transform: [{ translateX: clipX }] }]}>
          <Animated.View style={{ width: w, transform: [{ translateX: innerX }] }}>
            <VoiceBars bars={bars} color={playedColor} />
          </Animated.View>
        </Animated.View>
      ) : null}
      {w > 0 ? (
        <Animated.View pointerEvents="none" style={[st.thumb, { backgroundColor: thumbColor, transform: [{ translateX: thumbX }] }]} />
      ) : null}
    </View>
  );
});

export default VoiceWaveformLegacy;

const st = StyleSheet.create({
  row: { height: VOICE_WAVE_HEIGHT, flex: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', justifyContent: 'center' },
  clip: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
  thumb: {
    position: 'absolute', left: 0, top: VOICE_WAVE_HEIGHT / 2 - 4,
    width: 8, height: 8, borderRadius: 4,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.25, shadowRadius: 2 },
      web: { boxShadow: '0 1px 3px rgba(0,0,0,0.25)' },
      default: { elevation: 2 },
    }),
  },
});
