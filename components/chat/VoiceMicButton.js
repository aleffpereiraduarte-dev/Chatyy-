/**
 * VoiceMicButton — WhatsApp-style mic trigger.
 *
 * Drop-in replacement for the inline `<TouchableOpacity><IconMic/></TouchableOpacity>`
 * that lived in chat-conversation.js. The chat screen still owns the actual
 * recorder state (the `AudioRecorder` slot renders when isRecording=true).
 *
 * [2026-10-06 UX2] Hold-to-record gesture (native only):
 *  - press-and-hold (≥ HOLD_MS) → `onHoldStart()`; the chat screen mounts the
 *    AudioRecorder *as an overlay* so this button stays mounted and keeps the
 *    touch responder for the whole gesture (an unmounted responder would
 *    swallow the release event and leave the recorder stuck).
 *  - slide LEFT past CANCEL_DX → `onHoldCancel()` (trash animation lives in
 *    the recorder; this button only shrinks back).
 *  - slide UP past LOCK_DY → `onHoldLock()` — recorder switches to hands-free
 *    controls (stop / send / delete) and this button fades out (locked=true).
 *  - release → `onHoldRelease()` → recorder sends (or cancels when < 1 s).
 *  - a quick tap (release before HOLD_MS, no drag) keeps the legacy
 *    tap-to-record flow via `onActivate()` — fallback when the gesture isn't
 *    recognized (and for accessibility double-tap).
 *  Every drag update is forwarded through `onHoldMove({dx, dy})` so the
 *  recorder can drive its "‹ Deslize para cancelar" translation without a
 *  single React re-render (Animated.Value.setValue only).
 *  Web keeps the plain tap button (mouse drag + recorder are a bad mix).
 *
 * Visual:
 *  - 58dp circle; gentle idle pulse ring when the input is empty
 *  - press-in scale dip + haptic; hold → grows to HOLD_SCALE (WhatsApp's
 *    big mic) unless OS Reduce Motion is on
 *  - floating lock chip (IconLock + chevron) above the mic while holding;
 *    it rides up with the finger and brightens as it nears the threshold
 *  - SVG-only — icons come from the central Icons module. NO emoji.
 */
import React, { useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity, Animated, Platform, Easing, PanResponder } from 'react-native';
import { IconMic, IconLock, IconChevronUp } from '../Icons';
import { isReduceMotionEnabled } from '../reducedMotion';

let _Haptics = null;
try { _Haptics = require('expo-haptics'); } catch {}

const haptic = (kind = 'medium') => {
  if (!_Haptics || Platform.OS === 'web') return;
  try {
    const map = { heavy: 'Heavy', medium: 'Medium', light: 'Light', rigid: 'Rigid' };
    const style = _Haptics.ImpactFeedbackStyle?.[map[kind] || 'Medium'];
    _Haptics.impactAsync?.(style);
  } catch {}
};
const hapticNotify = (kind = 'success') => {
  if (!_Haptics || Platform.OS === 'web') return;
  try {
    const type = _Haptics.NotificationFeedbackType?.[kind === 'warning' ? 'Warning' : 'Success'];
    _Haptics.notificationAsync?.(type);
  } catch {}
};

const BRAND = '#111111';

// Gesture tuning — mirrors WhatsApp's feel on a 58dp button.
const HOLD_MS = 180;        // press longer than this = hold-to-record (shorter = tap)
const TAP_SLOP = 14;        // finger wander allowed before a tap turns into "not a tap"
const CANCEL_DX = -110;     // slide left past this → cancel
const LOCK_DY = -85;        // slide up past this → lock (hands-free)
const HOLD_SCALE = 1.65;    // big-mic growth while holding

/**
 * @param {object} props
 * @param {() => void} props.onActivate     Tap fallback (legacy tap-to-record).
 * @param {() => void} [props.onHoldStart]  Hold recognized — mount the recorder overlay.
 * @param {(g: {dx:number, dy:number}) => void} [props.onHoldMove]
 * @param {() => void} [props.onHoldCancel] Slide-left past threshold.
 * @param {() => void} [props.onHoldLock]   Slide-up past threshold.
 * @param {() => void} [props.onHoldRelease] Finger lifted while holding → send.
 * @param {boolean} [props.locked]          Recorder is locked/hands-free → hide the mic.
 * @param {boolean} [props.holdEnabled]     Default: native only.
 * @param {string} [props.accessibilityLabel]
 * @param {string} [props.lockHintLabel]    a11y label for the lock chip.
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.idle=true]       When true, runs the ambient pulse ring.
 * @param {number} [props.size=58]          Outer diameter; pulse ring grows to size+18.
 */
export default function VoiceMicButton({
  onActivate,
  onHoldStart,
  onHoldMove,
  onHoldCancel,
  onHoldLock,
  onHoldRelease,
  locked = false,
  holdEnabled = Platform.OS !== 'web',
  accessibilityLabel,
  lockHintLabel,
  disabled = false,
  idle = true,
  size = 58,
  // [2026-10-08 chat-beauty-chrome] visual-only: circle + glyph colors so the
  // composer can invert the button in dark mode (white circle, black mic).
  color = BRAND,
  iconColor = '#fff',
}) {
  // Press scale — dips to 0.92 on press-in, springs back on press-out.
  const pressScale = useRef(new Animated.Value(1)).current;
  // Ambient pulse ring — opacity + scale outward, looping.
  const pulse = useRef(new Animated.Value(0)).current;
  // Hold visuals — big-mic growth + lock chip (position follows the finger).
  const holdScale = useRef(new Animated.Value(1)).current;
  const lockChipY = useRef(new Animated.Value(0)).current;
  const lockChipOpacity = useRef(new Animated.Value(0)).current;
  const [holding, setHolding] = useState(false);

  // Latest callbacks/props for the (stable) PanResponder.
  const propsRef = useRef({});
  propsRef.current = { onActivate, onHoldStart, onHoldMove, onHoldCancel, onHoldLock, onHoldRelease, disabled, locked };

  useEffect(() => {
    if (!idle || holding) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
    if (isReduceMotionEnabled()) { pulse.setValue(0); return; }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1400,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
        Animated.delay(900),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [idle, holding, pulse]);

  const onPressIn = () => {
    if (isReduceMotionEnabled()) return;
    Animated.spring(pressScale, {
      toValue: 0.92,
      tension: 380,
      friction: 10,
      useNativeDriver: true,
    }).start();
  };
  const onPressOut = () => {
    if (isReduceMotionEnabled()) { pressScale.setValue(1); return; }
    Animated.spring(pressScale, {
      toValue: 1,
      tension: 280,
      friction: 8,
      useNativeDriver: true,
    }).start();
  };

  // ── Hold gesture state (refs — never re-render per move) ──
  const holdTimerRef = useRef(null);
  const holdActiveRef = useRef(false);   // finger down AND hold recognized
  const holdDoneRef = useRef(false);     // cancel/lock already fired for this touch
  const tapCancelledRef = useRef(false); // finger wandered → not a tap
  const cancelTickRef = useRef(false);
  const lockTickRef = useRef(false);

  const clearHoldTimer = () => {
    if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
  };
  const growMic = (on) => {
    if (isReduceMotionEnabled()) { holdScale.setValue(on ? 1.15 : 1); return; }
    Animated.spring(holdScale, { toValue: on ? HOLD_SCALE : 1, tension: 180, friction: 9, useNativeDriver: true }).start();
  };
  const showLockChip = (on) => {
    if (isReduceMotionEnabled()) { lockChipOpacity.setValue(on ? 1 : 0); if (!on) lockChipY.setValue(0); return; }
    Animated.timing(lockChipOpacity, { toValue: on ? 1 : 0, duration: on ? 220 : 120, useNativeDriver: true }).start(() => {
      if (!on) lockChipY.setValue(0);
    });
  };
  const endHoldVisuals = () => {
    growMic(false);
    showLockChip(false);
    setHolding(false);
  };

  // Cleanup: never leave a pending hold timer or a half-open gesture behind
  // when the composer unmounts (navigation mid-press).
  useEffect(() => () => {
    clearHoldTimer();
    if (holdActiveRef.current) {
      holdActiveRef.current = false;
      try { propsRef.current.onHoldCancel?.(); } catch {}
    }
  }, []);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => !propsRef.current.disabled && !propsRef.current.locked,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponderCapture: () => false,
      // Don't let a parent (list scroll, keyboard dismiss) steal the touch while
      // a recording is being held — losing the release would strand the recorder.
      onPanResponderTerminationRequest: () => !holdActiveRef.current,
      onPanResponderGrant: () => {
        holdActiveRef.current = false;
        holdDoneRef.current = false;
        tapCancelledRef.current = false;
        cancelTickRef.current = false;
        lockTickRef.current = false;
        onPressIn();
        clearHoldTimer();
        holdTimerRef.current = setTimeout(() => {
          holdTimerRef.current = null;
          if (tapCancelledRef.current) return;
          holdActiveRef.current = true;
          haptic('heavy');
          setHolding(true);
          growMic(true);
          showLockChip(true);
          try { propsRef.current.onHoldStart?.(); } catch {}
        }, HOLD_MS);
      },
      onPanResponderMove: (_, g) => {
        if (!holdActiveRef.current) {
          // Still deciding tap vs hold: a real drag before HOLD_MS is neither.
          if (holdTimerRef.current && (Math.abs(g.dx) > TAP_SLOP || Math.abs(g.dy) > TAP_SLOP)) {
            tapCancelledRef.current = true;
            clearHoldTimer();
            onPressOut();
          }
          return;
        }
        if (holdDoneRef.current) return;
        const dx = Math.min(0, g.dx);
        const dy = Math.min(0, g.dy);
        try { propsRef.current.onHoldMove?.({ dx, dy }); } catch {}
        // Lock chip rides up with the finger (clamped to the threshold).
        lockChipY.setValue(Math.max(dy, LOCK_DY));
        // Threshold "pre-tick" haptics so the user feels the point of no return.
        const nearCancel = dx < CANCEL_DX * 0.6;
        if (nearCancel !== cancelTickRef.current) { cancelTickRef.current = nearCancel; haptic(nearCancel ? 'medium' : 'light'); }
        const nearLock = dy < LOCK_DY * 0.6;
        if (nearLock !== lockTickRef.current) { lockTickRef.current = nearLock; haptic(nearLock ? 'medium' : 'light'); }

        if (dx <= CANCEL_DX && dy > LOCK_DY * 0.5) {
          holdDoneRef.current = true;
          holdActiveRef.current = false;
          hapticNotify('warning');
          endHoldVisuals();
          onPressOut();
          try { propsRef.current.onHoldCancel?.(); } catch {}
        } else if (dy <= LOCK_DY && dx > CANCEL_DX * 0.5) {
          holdDoneRef.current = true;
          holdActiveRef.current = false;
          hapticNotify('success');
          endHoldVisuals();
          onPressOut();
          try { propsRef.current.onHoldLock?.(); } catch {}
        }
      },
      onPanResponderRelease: () => finishTouch(),
      onPanResponderTerminate: () => finishTouch(),
    })
  ).current;

  function finishTouch() {
    const hadTimer = !!holdTimerRef.current;
    clearHoldTimer();
    onPressOut();
    if (holdActiveRef.current) {
      // Finger lifted while recording → send (recorder enforces the min length).
      holdActiveRef.current = false;
      endHoldVisuals();
      haptic('light');
      try { propsRef.current.onHoldRelease?.(); } catch {}
      return;
    }
    if (holdDoneRef.current) return; // cancel/lock already handled this touch
    if (hadTimer && !tapCancelledRef.current) {
      // Quick tap → legacy tap-to-record (hands-free) fallback.
      if (propsRef.current.disabled) return;
      haptic('medium');
      try { propsRef.current.onActivate?.(); } catch {}
    }
  }

  const ringSize = size + 18;
  const ringOffset = (ringSize - size) / 2;
  const pulseStyle = {
    position: 'absolute',
    top: -ringOffset,
    left: -ringOffset,
    width: ringSize,
    height: ringSize,
    borderRadius: ringSize / 2,
    backgroundColor: color,
    opacity: pulse.interpolate({
      inputRange: [0, 1],
      outputRange: [0.32, 0],
    }),
    transform: [{
      scale: pulse.interpolate({
        inputRange: [0, 1],
        outputRange: [0.85, 1.0],
      }),
    }],
  };

  const circleStyle = {
    width: size,
    height: size,
    borderRadius: size / 2,
    backgroundColor: color,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: disabled ? 0.5 : 1,
    ...(Platform.OS === 'web' ? {
      cursor: disabled ? 'not-allowed' : 'pointer',
      boxShadow: size >= 52 ? `0 6px 16px ${BRAND}55` : '0 1px 3px rgba(0,0,0,0.12)',
      transition: 'transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1)',
    } : {}),
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: size >= 52 ? 4 : 1 },
        shadowOpacity: size >= 52 ? 0.4 : 0.10,
        shadowRadius: size >= 52 ? 10 : 3,
      },
      android: { elevation: size >= 52 ? 6 : 1 },
      default: {},
    }),
  };

  // Lock chip — floats above the mic while holding; brightens near threshold.
  const chipW = 34;
  const lockChipStyle = {
    position: 'absolute',
    left: (size - chipW) / 2,
    top: -(size + 24),
    width: chipW,
    paddingVertical: 8,
    borderRadius: chipW / 2,
    backgroundColor: BRAND,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    opacity: lockChipOpacity,
    transform: [{ translateY: lockChipY }],
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.25, shadowRadius: 6 },
      android: { elevation: 5 },
      default: {},
    }),
  };

  const useHold = holdEnabled && Platform.OS !== 'web' && !disabled;

  return (
    <View
      style={{ width: size, height: size, marginLeft: size >= 52 ? 6 : 2, alignSelf: 'flex-end', opacity: locked ? 0 : 1 }}
      pointerEvents={locked ? 'none' : 'auto'}
    >
      {idle && !holding && <Animated.View pointerEvents="none" style={pulseStyle} />}
      {useHold && (
        <Animated.View
          pointerEvents="none"
          style={lockChipStyle}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          accessibilityLabel={lockHintLabel || 'Slide up to lock'}
        >
          <IconChevronUp size={12} color="#fff" />
          <IconLock size={14} color="#fff" />
        </Animated.View>
      )}
      <Animated.View style={{ transform: [{ scale: Animated.multiply(pressScale, holdScale) }] }}>
        {useHold ? (
          <View
            {...panResponder.panHandlers}
            style={circleStyle}
            accessible
            accessibilityLabel={accessibilityLabel || 'Record voice message'}
            accessibilityRole="button"
            accessibilityHint={lockHintLabel || undefined}
            hitSlop={6}
          >
            <IconMic size={Math.round(size * (size >= 52 ? 0.42 : 0.48))} color={iconColor} />
          </View>
        ) : (
          <TouchableOpacity
            onPress={() => { if (disabled) return; haptic('medium'); onActivate?.(); }}
            onPressIn={onPressIn}
            onPressOut={onPressOut}
            disabled={disabled}
            style={circleStyle}
            accessibilityLabel={accessibilityLabel || 'Record voice message'}
            accessibilityRole="button"
            hitSlop={6}
          >
            <IconMic size={Math.round(size * (size >= 52 ? 0.42 : 0.48))} color={iconColor} />
          </TouchableOpacity>
        )}
      </Animated.View>
    </View>
  );
}
