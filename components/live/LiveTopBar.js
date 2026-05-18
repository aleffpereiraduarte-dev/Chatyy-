/**
 * LiveTopBar — TikTok/Instagram-style top header for live-viewer.
 *
 * Layout (left → right):
 *   • Host avatar (32) with red gradient ring + LIVE pill underneath
 *   • Host name (bold, 13) + LIVE label + viewer count (humanized) inline
 *   • Right cluster: more / share / close — circular blur backdrop buttons
 *
 * Visual goals:
 *   • Clean & minimal — no duplicate LIVE badges, no follower count clutter
 *   • Glass blur backdrop with soft black→transparent gradient fade
 *   • LIVE pill pulses (opacity 0.6→1) every 1.2s
 *   • Viewer chip bumps + emits "+1" badge on count increase
 *
 * Pure presentation — all state + handlers are passed in via props so the
 * underlying WS/HLS/WebRTC logic in live-viewer.js stays untouched.
 */

import { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated,
} from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconX, IconShare, IconMoreVert, IconEye } from '../Icons';
import AnimatedViewerCount from '../AnimatedViewerCount';

const LIVE_RED = '#dc2626';

// Humanize big counts the way Instagram/TikTok do: 999 → 999, 1.2K, 1.2M.
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

export default function LiveTopBar({
  hostName,
  hostEmail,
  viewerCount,
  paddingTop,
  liveLabel = 'AO VIVO',
  viewersListLabel = 'Ver espectadores',
  onLongPressAvatar,
  onPressViewers,
  onPressMore,
  onPressShare,
  onClose,
}) {
  // Pulsing dot for LIVE pill — Animated.loop, runs while mounted.
  const dotPulse = useRef(new Animated.Value(1)).current;
  // Avatar breath — subtle 1→1.05 loop so the host "feels alive" (IG-style).
  const avatarBreath = useRef(new Animated.Value(1)).current;
  // Viewer-count bump animation when count changes.
  const viewerScale = useRef(new Animated.Value(1)).current;
  const plusOneAnim = useRef(new Animated.Value(0)).current;
  const prevCountRef = useRef(0);

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(dotPulse, { toValue: 0.55, duration: 700, useNativeDriver: true }),
        Animated.timing(dotPulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    const breath = Animated.loop(
      Animated.sequence([
        Animated.timing(avatarBreath, { toValue: 1.06, duration: 900, useNativeDriver: true }),
        Animated.timing(avatarBreath, { toValue: 1, duration: 900, useNativeDriver: true }),
      ])
    );
    breath.start();
    return () => { loop.stop(); breath.stop(); };
  }, [dotPulse, avatarBreath]);

  useEffect(() => {
    const prev = prevCountRef.current;
    prevCountRef.current = viewerCount;
    if (viewerCount > prev && prev !== 0) {
      Animated.sequence([
        Animated.timing(viewerScale, { toValue: 1.18, duration: 120, useNativeDriver: true }),
        Animated.spring(viewerScale, { toValue: 1, friction: 4, tension: 180, useNativeDriver: true }),
      ]).start();
      plusOneAnim.setValue(0);
      Animated.timing(plusOneAnim, { toValue: 1, duration: 800, useNativeDriver: true }).start();
    }
  }, [viewerCount, viewerScale, plusOneAnim]);

  return (
    <View style={[styles.topBar, { paddingTop: paddingTop + 6 }]} pointerEvents="box-none">
      {/* Soft gradient sheen — black-50% fading to transparent. Faked via
          stacked layers on native (no LinearGradient dep). */}
      <View style={styles.scrim} pointerEvents="none" />
      {Platform.OS !== 'web' ? (
        <>
          <View style={styles.scrimStep1} pointerEvents="none" />
          <View style={styles.scrimStep2} pointerEvents="none" />
        </>
      ) : null}

      {/* LEFT cluster — avatar + name + LIVE pill + viewer chip */}
      <TouchableOpacity
        activeOpacity={0.85}
        onLongPress={onLongPressAvatar}
        delayLongPress={280}
        style={styles.hostBlock}
        accessibilityRole="button"
      >
        <Animated.View style={[styles.avatarWrap, { transform: [{ scale: avatarBreath }] }]}>
          <View style={styles.avatarRing} pointerEvents="none" />
          <AvatarCircle name={hostName} email={hostEmail} size={32} />
        </Animated.View>
      </TouchableOpacity>

      <View style={styles.midBlock} pointerEvents="box-none">
        <Text style={styles.hostName} numberOfLines={1}>{hostName || '…'}</Text>
        <View style={styles.metaRow}>
          <View style={styles.livePill}>
            <Animated.View style={[styles.livePillDot, { opacity: dotPulse }]} />
            <Text style={styles.livePillText}>{liveLabel}</Text>
          </View>
          <Animated.View style={{ transform: [{ scale: viewerScale }] }}>
            <TouchableOpacity
              onPress={onPressViewers}
              activeOpacity={0.7}
              style={styles.viewerChip}
              accessibilityRole="button"
              accessibilityLabel={viewersListLabel}
            >
              <IconEye size={11} color="rgba(255,255,255,0.9)" />
              {/* AnimatedViewerCount = smooth tween + "k"/"M" formatter +
                  pulse on increase. Replaces the static humanizeCount text. */}
              <AnimatedViewerCount count={viewerCount} style={styles.viewerChipText} />
            </TouchableOpacity>
            <Animated.View
              pointerEvents="none"
              style={[
                styles.plusOne,
                {
                  opacity: plusOneAnim.interpolate({ inputRange: [0, 0.2, 0.9, 1], outputRange: [0, 1, 1, 0] }),
                  transform: [{
                    translateY: plusOneAnim.interpolate({ inputRange: [0, 1], outputRange: [0, -16] }),
                  }],
                },
              ]}
            >
              <Text style={styles.plusOneText}>+1</Text>
            </Animated.View>
          </Animated.View>
        </View>
      </View>

      {/* RIGHT cluster — circular blur backdrop buttons */}
      <View style={styles.rightCluster}>
        <TouchableOpacity onPress={onPressMore} style={styles.iconBtn} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="More">
          <IconMoreVert size={18} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity onPress={onPressShare} style={styles.iconBtn} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Share">
          <IconShare size={17} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity onPress={onClose} style={styles.iconBtn} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel="Close">
          <IconX size={19} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingBottom: 10,
    gap: 8,
    zIndex: 10,
  },
  scrim: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    zIndex: -1,
    ...(Platform.OS === 'web' ? {
      background: 'linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0.05))',
      backdropFilter: 'blur(14px)',
      WebkitBackdropFilter: 'blur(14px)',
    } : {}),
  },
  // Round 64 polish (2026-05-18) — softened the native top scrim. Previous
  // 0.42 / 0.18 stack painted a visible black band over the status bar area
  // on iOS/Android even when there was nothing under it (status bar is
  // translucent). Halved the opacity so the host video bleeds through the
  // header subtly instead of being capped by a hard dark strip.
  scrimStep1: {
    position: 'absolute', top: 0, left: 0, right: 0, height: 50,
    backgroundColor: 'rgba(0,0,0,0.22)', zIndex: -1,
  },
  scrimStep2: {
    position: 'absolute', top: 50, left: 0, right: 0, height: 30,
    backgroundColor: 'rgba(0,0,0,0.08)', zIndex: -1,
  },

  hostBlock: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
    position: 'relative',
  },
  avatarWrap: {
    width: 36, height: 36,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarRing: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 18,
    borderWidth: 2,
    borderColor: LIVE_RED,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 0 12px rgba(220,38,38,0.55), inset 0 0 0 1px rgba(255,255,255,0.16)',
    } : {}),
  },

  midBlock: {
    flex: 1,
    marginLeft: 4,
    justifyContent: 'center',
  },
  hostName: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    letterSpacing: 0.1,
    ...(Platform.OS === 'web' ? { textShadow: '0 1px 3px rgba(0,0,0,0.6)' } : {}),
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  livePill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    backgroundColor: LIVE_RED,
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 6px rgba(220,38,38,0.45)' } : {}),
  },
  livePillDot: {
    width: 5, height: 5, borderRadius: 3,
    backgroundColor: '#fff',
  },
  livePillText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.9,
  },
  viewerChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
  },
  viewerChipText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
  },
  plusOne: {
    position: 'absolute',
    top: -4, right: -8,
    paddingHorizontal: 5,
    paddingVertical: 1,
    backgroundColor: '#22c55e',
    borderRadius: 8,
    borderWidth: 1, borderColor: '#fff',
  },
  plusOneText: {
    color: '#fff',
    fontSize: 8,
    fontWeight: '900',
    letterSpacing: 0.3,
  },

  rightCluster: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  iconBtn: {
    width: 36, height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? {
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
    } : {}),
  },
});
