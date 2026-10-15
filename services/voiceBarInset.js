// [2026-10-15 voice-bar] Layout slot for the global voice-note bar.
//
// The bar (components/chat/VoiceMiniPlayer.js) is a full-width strip right
// under the status bar / Dynamic Island (and under the ongoing-call bar when
// both are up). While it is in "push" mode the root stack is pushed down by
// VOICE_BAR_H (CallBarInsetProvider in components/CallStatusBar.js), so it
// never covers a header or a large title (Conversas / Chamadas / Status).
//
// Smooth, tremor-free entry: the padding changes in ONE layout pass and the
// stack gets a compensating translateY (-delta → 0) on the native driver, so
// the content glides instead of jumping and nothing re-lays out per frame.
import { useSyncExternalStore } from 'react';
import { Animated, Platform } from 'react-native';
import { isReduceMotionEnabled } from '../components/reducedMotion';

export const VOICE_BAR_H = 46;
const NATIVE = Platform.OS !== 'web';

let _h = 0;
const _subs = new Set();
/** translateY applied to the pushed stack container. */
export const voiceBarShift = new Animated.Value(0);

function _sub(fn) { _subs.add(fn); return () => _subs.delete(fn); }
function _get() { return _h; }

/** Extra top space the voice bar takes in push mode (0 when not pushing). */
export function useVoiceBarInset() {
  return useSyncExternalStore(_sub, _get, _get);
}

export function setVoiceBarPushed(on) {
  const nh = on ? VOICE_BAR_H : 0;
  if (nh === _h) return;
  _h = nh;
  _subs.forEach((fn) => { try { fn(); } catch {} });
}

/** Called by the provider right after the padding change commits. */
export function runVoiceBarShift(delta) {
  if (!delta) return;
  try { voiceBarShift.stopAnimation(); } catch {}
  if (isReduceMotionEnabled()) { voiceBarShift.setValue(0); return; }
  voiceBarShift.setValue(-delta);
  Animated.spring(voiceBarShift, {
    toValue: 0, useNativeDriver: NATIVE, damping: 26, stiffness: 320, mass: 0.9,
    restDisplacementThreshold: 0.5, restSpeedThreshold: 0.5,
  }).start();
}
