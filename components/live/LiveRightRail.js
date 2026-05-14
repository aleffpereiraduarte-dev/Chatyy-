/**
 * LiveRightRail — vertical floating column of circular blur backdrop buttons
 * on the right edge of the live stage. TikTok-style.
 *
 * Slots (top→bottom):
 *   • Like (heart) — single tap = 1 heart + WS reaction, long-press = 8 burst.
 *     Shows running like count below the icon (humanized, 10px font).
 *   • Chat toggle — fades when chatHidden.
 *   • Snapshot (camera).
 *   • Share.
 *   • More.
 *
 * Buttons: 48×48 circular, glass blur backdrop bg rgba(0,0,0,0.45),
 * border rgba(255,255,255,0.15). Active state = brand purple tint.
 *
 * Animations:
 *   • Heart: scale spring on press (1→1.18→1).
 *   • Like count bumps 1→1.15→1 spring on every increment.
 */

import { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated,
} from 'react-native';
import {
  IconHeart, IconShare, IconMoreVert, IconCamera, IconMessageCircle,
} from '../Icons';

const LIVE_RED = '#dc2626';
const ACCENT = '#7C3AED';

function humanizeCount(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  const sep = (() => {
    try { return (1.1).toLocaleString().includes(',') ? ',' : '.'; } catch { return '.'; }
  })();
  if (v < 10000) return (Math.floor(v / 100) / 10).toString().replace('.', sep) + 'K';
  if (v < 1_000_000) return Math.floor(v / 1000) + 'K';
  return (Math.floor(v / 100_000) / 10).toString().replace('.', sep) + 'M';
}

export default function LiveRightRail({
  bottom,
  likeCount = 0,
  chatHidden = false,
  onHeartPress,
  onHeartLongPress,
  onToggleChat,
  onSnapshot,
  onShare,
  onMore,
  i18n = {},
}) {
  const heartScale = useRef(new Animated.Value(1)).current;
  const likeCountScale = useRef(new Animated.Value(1)).current;
  const prevLikesRef = useRef(0);

  const pop = () => {
    Animated.sequence([
      Animated.timing(heartScale, { toValue: 0.85, duration: 80, useNativeDriver: true }),
      Animated.spring(heartScale, { toValue: 1, friction: 3.5, tension: 200, useNativeDriver: true }),
    ]).start();
  };

  useEffect(() => {
    const prev = prevLikesRef.current;
    prevLikesRef.current = likeCount;
    if (likeCount > prev && prev !== 0) {
      Animated.sequence([
        Animated.timing(likeCountScale, { toValue: 1.18, duration: 110, useNativeDriver: true }),
        Animated.spring(likeCountScale, { toValue: 1, friction: 4, tension: 200, useNativeDriver: true }),
      ]).start();
    }
  }, [likeCount, likeCountScale]);

  const handleHeart = () => {
    pop();
    onHeartPress?.();
  };

  return (
    <View
      style={[styles.rail, { bottom }]}
      pointerEvents="box-none"
    >
      {/* Like (heart) with count below */}
      <View style={styles.slot}>
        <Animated.View style={{ transform: [{ scale: heartScale }] }}>
          <TouchableOpacity
            style={styles.btn}
            onPress={handleHeart}
            onLongPress={onHeartLongPress}
            delayLongPress={200}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel={i18n.like || 'Curtir'}
          >
            <IconHeart size={26} color={LIVE_RED} />
          </TouchableOpacity>
        </Animated.View>
        {likeCount > 0 ? (
          <Animated.Text
            style={[styles.countText, { transform: [{ scale: likeCountScale }] }]}
            numberOfLines={1}
          >
            {humanizeCount(likeCount)}
          </Animated.Text>
        ) : null}
      </View>

      {/* Chat toggle */}
      <TouchableOpacity
        style={[styles.btn, chatHidden && styles.btnDim]}
        onPress={onToggleChat}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={chatHidden ? (i18n.showChat || 'Mostrar chat') : (i18n.hideChat || 'Ocultar chat')}
      >
        <IconMessageCircle size={22} color={chatHidden ? 'rgba(255,255,255,0.5)' : '#fff'} />
      </TouchableOpacity>

      {/* Snapshot */}
      <TouchableOpacity
        style={styles.btn}
        onPress={onSnapshot}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={i18n.snapshot || 'Snap'}
      >
        <IconCamera size={22} color="#fff" />
      </TouchableOpacity>

      {/* Share */}
      <TouchableOpacity
        style={styles.btn}
        onPress={onShare}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={i18n.share || 'Compartilhar'}
      >
        <IconShare size={22} color="#fff" />
      </TouchableOpacity>

      {/* More */}
      <TouchableOpacity
        style={styles.btn}
        onPress={onMore}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel="More"
      >
        <IconMoreVert size={22} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  rail: {
    position: 'absolute',
    right: 12,
    zIndex: 15,
    gap: 14,
    alignItems: 'center',
  },
  slot: {
    alignItems: 'center',
    gap: 3,
  },
  btn: {
    width: 48,
    height: 48,
    borderRadius: 24,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(10px)',
      WebkitBackdropFilter: 'blur(10px)',
    } : {}),
  },
  btnActive: {
    backgroundColor: 'rgba(124,58,237,0.55)',
    borderColor: 'rgba(255,255,255,0.4)',
  },
  btnDim: {
    opacity: 0.72,
  },
  countText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '800',
    letterSpacing: 0.2,
    minWidth: 24,
    textAlign: 'center',
    ...(Platform.OS === 'web' ? { textShadow: '0 1px 3px rgba(0,0,0,0.7)' } : {}),
  },
});
