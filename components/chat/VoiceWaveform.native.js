// [2026-10-07 voice-native] Voice-note waveform on the UI THREAD (iOS/Android).
//
//   • progress is a Reanimated shared value; the bubble feeds it the engine
//     position ~4×/s and it glides with withTiming(linear) in between, so the
//     playhead moves every frame with ZERO React renders / JS work per frame;
//   • the 40 bars are drawn once (VoiceBars, memoised) — progress is a clip
//     window sliding over a second copy (transform only, no layout);
//   • scrubbing is a RNGH Pan (+ Tap to jump) running on the UI thread: the
//     playhead follows the finger frame-by-frame, the time label is updated
//     once per second change, and the real seek happens ONCE on release.
//     activeOffsetX ±6 beats SwipeReplyRow's ±25, so dragging ON the
//     waveform scrubs (WhatsApp) while dragging elsewhere on the bubble still
//     swipes to reply; failOffsetY lets the list scroll vertically.
//
// OTA SAFETY: only when utils/threadKeyboard already loaded Reanimated /
// Worklets on this binary (runtime 2.6.0+); otherwise the RN-Animated
// implementation (VoiceWaveformLegacy) is used with the same ref contract.
import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import { KEYBOARD_CONTROLLER_ACTIVE } from '../../utils/threadKeyboard';
import VoiceWaveformLegacy from './VoiceWaveformLegacy';
import { VoiceBars, VOICE_WAVE_HEIGHT } from './VoiceBars';

let Rea = null;
let GH = null;
if (KEYBOARD_CONTROLLER_ACTIVE) {
  try {
    // eslint-disable-next-line global-require
    Rea = require('react-native-reanimated');
    // eslint-disable-next-line global-require
    GH = require('react-native-gesture-handler');
  } catch {
    Rea = null;
    GH = null;
  }
}

// Worklet helpers bound at module scope (never capture the module object).
const runOnJS = Rea ? Rea.runOnJS : null;
const withTiming = Rea ? Rea.withTiming : null;
const cancelAnimation = Rea ? Rea.cancelAnimation : null;
const linearEasing = Rea && Rea.Easing ? Rea.Easing.linear : undefined;

const UI_THREAD_OK = !!(
  Rea && Rea.default && Rea.useSharedValue && Rea.useAnimatedStyle && withTiming && runOnJS && cancelAnimation
  && GH && GH.Gesture && GH.Gesture.Pan && GH.Gesture.Tap && GH.Gesture.Exclusive && GH.GestureDetector
);

const ReaWaveform = forwardRef(function ReaWaveform(
  { bars, playedColor, dimColor, thumbColor, durationMs = 0, onSeek, onScrubTime, initialRatio = 0 },
  ref,
) {
  const AView = Rea.default.View;
  const p = Rea.useSharedValue(initialRatio);
  const w = Rea.useSharedValue(0);
  const lastSec = Rea.useSharedValue(-1);
  const scrubbing = useRef(false);
  const cbRef = useRef({ onSeek, onScrubTime });
  cbRef.current = { onSeek, onScrubTime };

  useImperativeHandle(ref, () => ({
    animateTo(target, ms) {
      if (scrubbing.current) return;
      const t = Math.max(0, Math.min(1, target));
      p.value = withTiming(t, { duration: Math.max(16, ms || 0), easing: linearEasing });
    },
    set(v) {
      if (scrubbing.current) return;
      cancelAnimation(p);
      p.value = Math.max(0, Math.min(1, v || 0));
    },
    isScrubbing: () => scrubbing.current,
  }), [p]);

  // JS-side callbacks invoked from the UI thread via runOnJS.
  const beginScrub = useCallback(() => { scrubbing.current = true; }, []);
  const cancelScrub = useCallback(() => { scrubbing.current = false; }, []);
  const scrubTime = useCallback((r) => { try { cbRef.current.onScrubTime?.(r); } catch {} }, []);
  const endScrub = useCallback((r) => {
    scrubbing.current = false;
    try { cbRef.current.onSeek?.(r); } catch {}
  }, []);

  const durSec = Math.max(0, (durationMs || 0) / 1000);
  const gesture = useMemo(() => {
    const pan = GH.Gesture.Pan()
      .activeOffsetX([-6, 6])
      .failOffsetY([-14, 14])
      .onStart(() => {
        'worklet';
        cancelAnimation(p);
        lastSec.set(-1);
        runOnJS(beginScrub)();
      })
      .onUpdate((e) => {
        'worklet';
        const W = w.get();
        if (W <= 0) return;
        let r = e.x / W;
        if (r < 0) r = 0; else if (r > 1) r = 1;
        p.set(r);
        const s = Math.floor(r * durSec);
        if (s !== lastSec.get()) {
          lastSec.set(s);
          runOnJS(scrubTime)(r);
        }
      })
      .onEnd((e) => {
        'worklet';
        const W = w.get();
        if (W <= 0) { runOnJS(cancelScrub)(); return; }
        let r = e.x / W;
        if (r < 0) r = 0; else if (r > 1) r = 1;
        p.set(r);
        runOnJS(endScrub)(r);
      })
      .onFinalize((_e, success) => {
        'worklet';
        if (!success) runOnJS(cancelScrub)();
      });
    const tap = GH.Gesture.Tap()
      .maxDuration(350)
      .onEnd((e, success) => {
        'worklet';
        if (!success) return;
        const W = w.get();
        if (W <= 0) return;
        let r = e.x / W;
        if (r < 0) r = 0; else if (r > 1) r = 1;
        p.set(withTiming(r, { duration: 120 }));
        runOnJS(endScrub)(r);
      });
    return GH.Gesture.Exclusive(pan, tap);
  }, [p, w, lastSec, durSec, beginScrub, cancelScrub, scrubTime, endScrub]);

  const clipStyle = Rea.useAnimatedStyle(() => {
    'worklet';
    const W = w.get();
    return { width: W, transform: [{ translateX: (p.get() - 1) * W }] };
  });
  const innerStyle = Rea.useAnimatedStyle(() => {
    'worklet';
    const W = w.get();
    return { width: W, transform: [{ translateX: (1 - p.get()) * W }] };
  });
  const thumbStyle = Rea.useAnimatedStyle(() => {
    'worklet';
    const W = w.get();
    return { opacity: W > 0 ? 1 : 0, transform: [{ translateX: p.get() * W - 4 }] };
  });

  const onLayout = useCallback((e) => {
    const W = e.nativeEvent.layout.width;
    if (Math.abs(W - w.value) > 0.5) w.value = W;
  }, [w]);

  return (
    <GH.GestureDetector gesture={gesture}>
      <View style={st.row} onLayout={onLayout} collapsable={false}>
        <VoiceBars bars={bars} color={dimColor} opacity={0.5} />
        <AView pointerEvents="none" style={[st.clip, clipStyle]}>
          <AView style={innerStyle}>
            <VoiceBars bars={bars} color={playedColor} />
          </AView>
        </AView>
        <AView pointerEvents="none" style={[st.thumb, { backgroundColor: thumbColor }, thumbStyle]} />
      </View>
    </GH.GestureDetector>
  );
});

const VoiceWaveform = UI_THREAD_OK ? ReaWaveform : VoiceWaveformLegacy;
export default VoiceWaveform;
export const VOICE_WAVEFORM_UI_THREAD = UI_THREAD_OK;

const st = StyleSheet.create({
  row: { height: VOICE_WAVE_HEIGHT, flex: 1, flexShrink: 1, minWidth: 0, overflow: 'hidden', justifyContent: 'center' },
  clip: { position: 'absolute', left: 0, top: 0, bottom: 0, overflow: 'hidden' },
  thumb: {
    position: 'absolute', left: 0, top: VOICE_WAVE_HEIGHT / 2 - 4,
    width: 8, height: 8, borderRadius: 4,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.25, shadowRadius: 2 },
      default: { elevation: 2 },
    }),
  },
});
