// LiveBar — horizontal scrollable strip painted at the TOP of the chat list
// (above the status/notes story strip) whenever ANY contact is currently
// streaming. Visually distinct from the story strip: bigger red pulsing
// ring, "LIVE" pill anchored under the avatar, and a soft red gradient
// header so the strip reads as a separate, urgent surface.
//
// Driven by `livesByEmail` from ChatListTab which is itself fed by the
// `live_list` poll + `lives_global` WS events (`live_started`/`live_ended`).
// So the bar is real-time: a friend going live pops into the strip without
// the user pulling to refresh.
//
// Tap → routes to /live-viewer via the provided onOpen(email, sessionId, name)
// callback. ChatListTab passes its existing openLiveViewer to keep the
// transition + URL params consistent with every other live entry-point
// (Profile, Feed, Push toast).

import React, { useEffect, useRef, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Animated, Platform } from 'react-native';
import AvatarCircle from './AvatarCircle';

const LIVE_RED = '#dc2626';
const LIVE_RED_SOFT = '#ef4444';

export default function LiveBar({ lives, onOpen, t, isDark, colors }) {
  // Shared pulse animation — one Animated value drives every ring + dot so we
  // pay the JS cost once even if 12 hosts are live. Native driver keeps it
  // off the JS thread.
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  const ringScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.08] });
  const ringOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.85, 0.35] });
  const dotOpacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.45] });

  const sorted = useMemo(() => {
    // Highest viewer count first — surfaces "popular" lives, Instagram
    // parity. Fall back to insertion order if counts tie.
    return [...(lives || [])].sort((a, b) => (b?.viewer_count || 0) - (a?.viewer_count || 0));
  }, [lives]);

  if (!sorted.length) return null;

  const aoVivoLabel = ((t && t('live.aoVivo')) || 'AO VIVO').toUpperCase();

  return (
    <View style={[styles.wrap, {
      backgroundColor: isDark ? 'rgba(220,38,38,0.07)' : 'rgba(220,38,38,0.04)',
      borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
    }]}>
      <View style={styles.headerRow}>
        <Animated.View style={[styles.headerDot, { opacity: dotOpacity }]} />
        <Text style={[styles.headerLabel, { color: LIVE_RED }]}>
          {(t && t('live.liveNow')) || 'Ao vivo agora'}
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.scroll}
      >
        {sorted.map((l) => {
          const name = l.host_name || l.name || (l.host_email || l.email || '').split('@')[0] || '?';
          const email = l.host_email || l.email;
          const sessionId = l.id || l.session_id;
          return (
            <TouchableOpacity
              key={`livebar-${sessionId || email}`}
              onPress={() => onOpen && onOpen(email, sessionId, name)}
              activeOpacity={0.75}
              accessibilityRole="button"
              accessibilityLabel={`${aoVivoLabel}: ${name}`}
              style={styles.cell}
            >
              <View style={styles.avatarWrap}>
                {/* Outer pulsing ring — animates scale + opacity so it feels alive. */}
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.pulseRing,
                    {
                      opacity: ringOpacity,
                      transform: [{ scale: ringScale }],
                    },
                  ]}
                />
                {/* Static thinner outer rim for definition once the pulse fades. */}
                <View style={styles.staticRim} pointerEvents="none" />
                <AvatarCircle name={name} email={email} size={54} />
                {/* LIVE pill anchored on the bottom edge — Instagram parity. */}
                <View style={styles.liveBadge} pointerEvents="none">
                  <Text style={styles.liveBadgeText}>{aoVivoLabel}</Text>
                </View>
              </View>
              <Text
                style={[styles.name, { color: colors?.text }]}
                numberOfLines={1}
              >
                {name}
              </Text>
              {l.viewer_count != null && l.viewer_count > 0 && (
                <Text style={[styles.viewers, { color: colors?.textSecondary }]} numberOfLines={1}>
                  {l.viewer_count}
                </Text>
              )}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingTop: 8,
    paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingBottom: 6,
    gap: 6,
  },
  headerDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: LIVE_RED,
  },
  headerLabel: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.8,
    textTransform: 'uppercase',
  },
  scroll: {
    paddingHorizontal: 14,
    gap: 14,
  },
  cell: {
    alignItems: 'center',
    width: 72,
  },
  avatarWrap: {
    width: 66,
    height: 66,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    marginBottom: 18,
  },
  pulseRing: {
    position: 'absolute',
    width: 64,
    height: 64,
    borderRadius: 32,
    borderWidth: 2.5,
    borderColor: LIVE_RED,
    ...(Platform.OS === 'web' ? { boxShadow: '0 0 12px rgba(220,38,38,0.45)' } : {}),
  },
  staticRim: {
    position: 'absolute',
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 2,
    borderColor: LIVE_RED_SOFT,
  },
  liveBadge: {
    position: 'absolute',
    bottom: -8,
    backgroundColor: LIVE_RED,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    minWidth: 38,
    alignItems: 'center',
    ...(Platform.OS === 'web' ? { boxShadow: '0 1px 3px rgba(0,0,0,0.25)' } : {
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.25,
      shadowRadius: 2,
      elevation: 2,
    }),
  },
  liveBadgeText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.6,
  },
  name: {
    fontSize: 11,
    fontWeight: '600',
    marginTop: 2,
    maxWidth: 72,
  },
  viewers: {
    fontSize: 10,
    fontWeight: '500',
    marginTop: 1,
    opacity: 0.8,
  },
});
