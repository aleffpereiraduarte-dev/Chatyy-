/**
 * LiveCommentInput — bottom pill input bar for live comments.
 *
 * Instagram/TikTok parity:
 *   • Pill: rounded 24, glass blur backdrop, brand border on focus.
 *   • Left inside: IconSmile (decorative, opacity 0.65).
 *   • Right inside: dynamic. When user has typed text → purple gradient send
 *     pill (32×32, IconSend). When empty → red heart pill (32×32, IconHeart)
 *     that fires a single-tap heart float / WS reaction.
 *   • Whole pill lifts (translateY -4 + scale 1.02) on focus.
 *
 * Pure presentation — parent owns `value`, `setValue`, sendComment + heart.
 */

import { useRef, useEffect, forwardRef } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, Animated,
} from 'react-native';
import { IconSend, IconHeart, IconSmile, IconGiftBox } from '../Icons';

const LIVE_RED = '#dc2626';
const ACCENT = '#7C3AED';

const LiveCommentInput = forwardRef(function LiveCommentInput({
  value,
  onChangeText,
  onSubmit,
  onHeartTap,
  onHeartLongPress,
  onGiftPress,
  onFocus,
  onBlur,
  focused = false,
  placeholder = 'Adicionar comentário...',
  brandAccent = ACCENT,
  a11yLabels = {},
}, ref) {
  const lift = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.spring(lift, {
      toValue: focused ? 1 : 0,
      friction: 6,
      tension: 140,
      useNativeDriver: true,
    }).start();
  }, [focused, lift]);

  const hasText = !!String(value || '').trim();

  return (
    <Animated.View
      style={[
        styles.bar,
        {
          transform: [
            { translateY: lift.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) },
            { scale: lift.interpolate({ inputRange: [0, 1], outputRange: [1, 1.02] }) },
          ],
        },
      ]}
    >
      <View
        style={[
          styles.pill,
          focused && styles.pillFocused,
          focused && { borderColor: brandAccent },
        ]}
      >
        <View style={styles.leftIcon} pointerEvents="none">
          <IconSmile size={20} color="rgba(255,255,255,0.7)" />
        </View>
        <TextInput
          ref={ref}
          style={styles.input}
          value={value}
          onChangeText={onChangeText}
          placeholder={placeholder}
          placeholderTextColor="rgba(255,255,255,0.55)"
          returnKeyType="send"
          onSubmitEditing={onSubmit}
          onFocus={onFocus}
          onBlur={onBlur}
          blurOnSubmit={false}
          accessibilityLabel={a11yLabels.comment || placeholder}
        />
        {/* Right-side action: send when text, heart when empty. */}
        {hasText ? (
          <TouchableOpacity
            onPress={onSubmit}
            style={[styles.actionPill, { backgroundColor: brandAccent }]}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={a11yLabels.send || 'Send'}
          >
            <IconSend size={15} color="#fff" />
          </TouchableOpacity>
        ) : (
          <TouchableOpacity
            onPress={onHeartTap}
            onLongPress={onHeartLongPress}
            delayLongPress={220}
            style={[styles.actionPill, styles.heartPill]}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={a11yLabels.like || 'Like'}
          >
            <IconHeart size={16} color="#fff" />
          </TouchableOpacity>
        )}
      </View>
      {/* Gift button outside the pill, sits next to it on the right side
          of the bar. Only shown when onGiftPress is provided so the host
          (broadcast) doesn't accidentally get a "send gift to myself" UI. */}
      {onGiftPress ? (
        <TouchableOpacity
          onPress={onGiftPress}
          style={styles.giftBtn}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={a11yLabels.gift || 'Send gift'}
        >
          <IconGiftBox size={22} color="#fff" />
        </TouchableOpacity>
      ) : null}
    </Animated.View>
  );
});

export default LiveCommentInput;

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingTop: 8,
    paddingRight: 70, // leave room for the right rail
  },
  pill: {
    flex: 1,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.12)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.2)',
    overflow: 'hidden',
    justifyContent: 'center',
    paddingLeft: 44,  // room for left smile icon
    paddingRight: 44, // room for right action pill
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(14px) saturate(140%)',
      WebkitBackdropFilter: 'blur(14px) saturate(140%)',
    } : {}),
  },
  pillFocused: {
    borderColor: 'rgba(196,181,253,0.85)',
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  leftIcon: {
    position: 'absolute',
    left: 14,
    top: 0, bottom: 0,
    justifyContent: 'center',
  },
  input: {
    color: '#fff',
    fontSize: 14,
    height: 48,
    paddingHorizontal: 4,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  actionPill: {
    position: 'absolute',
    right: 6,
    top: 6,
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 10px rgba(124,58,237,0.55)' } : {}),
  },
  heartPill: {
    backgroundColor: LIVE_RED,
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 10px rgba(220,38,38,0.55)' } : {}),
  },
  giftBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    marginLeft: 8,
    backgroundColor: 'rgba(251,191,36,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(251,191,36,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
    } : {}),
  },
});
