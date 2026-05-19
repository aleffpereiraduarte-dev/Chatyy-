/**
 * VoiceMicButton — WhatsApp-style mic trigger.
 *
 * Drop-in replacement for the inline `<TouchableOpacity><IconMic/></TouchableOpacity>`
 * that lived in chat-conversation.js. The chat screen still owns the actual
 * recorder state (the `AudioRecorder` slot renders when isRecording=true) so
 * this component only needs to fire the same `onActivate` callback the old
 * onPress did.
 *
 * Visual upgrade vs. the old button:
 *  - 58dp circle (was 48dp) so it matches WhatsApp's chat composer footprint
 *  - Gentle idle pulse ring — pulses every 2.4s when the input is empty so the
 *    button visibly "invites" the user to record (subtle, brand purple, low
 *    opacity — never distracting)
 *  - Press-in: scale dip + heavy haptic (haptic only on native; web is a no-op)
 *  - SVG-only — IconMic is pulled from the central Icons module. NO emoji.
 *
 * Intentionally *not* responsible for hold-to-record gesture logic. The full
 * slide-to-cancel / slide-up-to-lock PanResponder lives in chat-conversation
 * and only engages once `setIsRecording(true)` is called (via `onActivate`).
 * Keeping the gesture/state in the chat screen avoids prop-drilling refs and
 * the recorder lifecycle, which would force us to refactor the AudioRecorder
 * sibling at the same time.
 */
import React, { useEffect, useRef } from 'react';
import { View, TouchableOpacity, Animated, Platform, Easing } from 'react-native';
import { IconMic } from '../Icons';

let _Haptics = null;
try { _Haptics = require('expo-haptics'); } catch {}

const haptic = (kind = 'medium') => {
  if (!_Haptics || Platform.OS === 'web') return;
  try {
    const style = _Haptics.ImpactFeedbackStyle?.[kind === 'heavy' ? 'Heavy' : 'Medium'];
    _Haptics.impactAsync?.(style);
  } catch {}
};

const BRAND = '#7C3AED';

/**
 * @param {object} props
 * @param {() => void} props.onActivate  Fires on press (drops user into recording state).
 * @param {string} [props.accessibilityLabel]
 * @param {boolean} [props.disabled]
 * @param {boolean} [props.idle=true]    When true, runs the ambient pulse ring.
 * @param {number} [props.size=58]       Outer diameter; pulse ring grows to size+18.
 */
export default function VoiceMicButton({
  onActivate,
  accessibilityLabel,
  disabled = false,
  idle = true,
  size = 58,
}) {
  // Press scale — dips to 0.92 on press-in, springs back on press-out.
  const pressScale = useRef(new Animated.Value(1)).current;
  // Ambient pulse ring — opacity + scale outward, looping.
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!idle) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }
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
  }, [idle, pulse]);

  const onPressIn = () => {
    Animated.spring(pressScale, {
      toValue: 0.92,
      tension: 380,
      friction: 10,
      useNativeDriver: true,
    }).start();
  };
  const onPressOut = () => {
    Animated.spring(pressScale, {
      toValue: 1,
      tension: 280,
      friction: 8,
      useNativeDriver: true,
    }).start();
  };

  const ringSize = size + 18;
  const ringOffset = (ringSize - size) / 2;
  const pulseStyle = {
    position: 'absolute',
    top: -ringOffset,
    left: -ringOffset,
    width: ringSize,
    height: ringSize,
    borderRadius: ringSize / 2,
    backgroundColor: BRAND,
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

  return (
    <View style={{ width: size, height: size, marginLeft: 6, alignSelf: 'flex-end' }}>
      {idle && <Animated.View pointerEvents="none" style={pulseStyle} />}
      <Animated.View style={{ transform: [{ scale: pressScale }] }}>
        <TouchableOpacity
          onPress={() => { if (disabled) return; haptic('medium'); onActivate?.(); }}
          onPressIn={onPressIn}
          onPressOut={onPressOut}
          disabled={disabled}
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            backgroundColor: BRAND,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: disabled ? 0.5 : 1,
            ...(Platform.OS === 'web' ? {
              cursor: disabled ? 'not-allowed' : 'pointer',
              boxShadow: `0 6px 16px ${BRAND}55`,
              transition: 'transform 180ms cubic-bezier(0.34, 1.56, 0.64, 1)',
            } : {}),
            ...Platform.select({
              ios: {
                shadowColor: BRAND,
                shadowOffset: { width: 0, height: 4 },
                shadowOpacity: 0.4,
                shadowRadius: 10,
              },
              android: { elevation: 6 },
              default: {},
            }),
          }}
          accessibilityLabel={accessibilityLabel || 'Record voice message'}
          accessibilityRole="button"
          hitSlop={6}
        >
          <IconMic size={Math.round(size * 0.42)} color="#fff" />
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}
