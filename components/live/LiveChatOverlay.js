/**
 * LiveChatOverlay — bottom-area floating comment stream over the video.
 *
 * Renders the last N (default 5) chat messages bottom-up, mimicking
 * TikTok/Instagram Live: transparent backgrounds with text-shadow, soft
 * mask gradient (web) and stack-alpha (native) to melt the top of the
 * column into the frame.
 *
 * Each row supports:
 *   • single tap → @reply seed (parent handler)
 *   • double tap → heart chip animation (parent handler)
 *   • system rows ("@maria entrou") render as glass pills (no avatar)
 *
 * Tap anywhere outside a row → opens the full chat sheet (onOpenSheet).
 */

import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated,
} from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { IconHeart } from '../Icons';

const LIVE_RED = '#dc2626';

export default function LiveChatOverlay({
  messages = [],
  commentHearts = {},
  onPressMessage,
  onOpenSheet,
  hasMore = false,
  seeAllLabel = 'Ver todos os comentários',
}) {
  const visible = messages.slice(-5);

  return (
    <TouchableOpacity
      onPress={onOpenSheet}
      activeOpacity={0.85}
      style={styles.overlay}
      accessibilityLabel="Chat ao vivo"
      accessibilityRole="button"
    >
      {hasMore ? (
        <View style={styles.seeAllChip} pointerEvents="none">
          <Text style={styles.seeAllText}>{seeAllLabel}</Text>
        </View>
      ) : null}

      {visible.map((m, idx) => {
        // Older comments fade softer; stack alpha 0.4 → 1 from top.
        const stackAlpha = 0.4 + (idx / Math.max(visible.length - 1, 1)) * 0.6;
        const entry = m.entry;
        const opacity = entry
          ? entry.interpolate({ inputRange: [0, 1], outputRange: [0, stackAlpha] })
          : stackAlpha;
        const translateY = entry
          ? entry.interpolate({ inputRange: [0, 1], outputRange: [8, 0] })
          : 0;

        if (m.isSystem) {
          return (
            <Animated.View
              key={m.id}
              style={[styles.systemRow, { opacity, transform: [{ translateY }] }]}
              pointerEvents="none"
            >
              <View style={styles.systemPill}>
                <Text style={styles.systemText} numberOfLines={1}>
                  <Text style={styles.systemName}>{m.name}</Text>
                  <Text>{` ${m.text}`}</Text>
                </Text>
              </View>
            </Animated.View>
          );
        }

        const heartAnim = commentHearts[m.id];
        return (
          <Animated.View
            key={m.id}
            style={{ opacity, transform: [{ translateY }] }}
          >
            <TouchableOpacity
              onPress={(e) => { e.stopPropagation?.(); onPressMessage?.(m); }}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Reply to ${m.name}`}
              style={styles.row}
            >
              <AvatarCircle name={m.name} email={m.email} size={26} />
              <View style={styles.body}>
                <Text style={styles.name} numberOfLines={1}>{m.name}</Text>
                <Text style={styles.text} numberOfLines={3}>{m.content}</Text>
              </View>
              {heartAnim ? (
                <Animated.View
                  pointerEvents="none"
                  style={[
                    styles.heartChip,
                    {
                      opacity: heartAnim,
                      transform: [
                        { scale: heartAnim.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] }) },
                        { translateY: heartAnim.interpolate({ inputRange: [0, 1], outputRange: [4, -2] }) },
                      ],
                    },
                  ]}
                >
                  <IconHeart size={14} color="#fff" />
                </Animated.View>
              ) : null}
            </TouchableOpacity>
          </Animated.View>
        );
      })}
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  overlay: {
    paddingRight: 70, // leave room for the right rail
    marginBottom: 8,
    gap: 5,
    ...(Platform.OS === 'web' ? {
      WebkitMaskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 12%, #000 38%)',
      maskImage: 'linear-gradient(to bottom, transparent 0%, rgba(0,0,0,0.2) 12%, #000 38%)',
    } : {}),
  },
  seeAllChip: {
    alignSelf: 'flex-start',
    marginBottom: 6,
    paddingHorizontal: 9,
    paddingVertical: 3,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 11,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
  },
  seeAllText: {
    color: 'rgba(255,255,255,0.9)',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
    maxWidth: '92%',
    paddingVertical: 3,
  },
  body: {
    flexShrink: 1,
    paddingTop: 1,
  },
  name: {
    color: 'rgba(229,231,235,0.95)',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
    marginBottom: 1,
    ...(Platform.OS === 'web' ? { textShadow: '0 1px 3px rgba(0,0,0,0.85)' } : {}),
  },
  text: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '500',
    ...(Platform.OS === 'web' ? { textShadow: '0 1px 2px rgba(0,0,0,0.85)' } : {}),
  },

  // System row (e.g. "@maria entrou")
  systemRow: {
    alignSelf: 'flex-start',
    maxWidth: '85%',
  },
  systemPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    backgroundColor: 'rgba(124,58,237,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(196,181,253,0.4)',
    borderRadius: 12,
  },
  systemText: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 11.5,
    fontWeight: '500',
  },
  systemName: {
    fontWeight: '800',
    color: '#fff',
  },

  // Inline heart chip on a row (double-tap reaction)
  heartChip: {
    marginLeft: 6,
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: LIVE_RED,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1.5, borderColor: '#fff',
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 8px rgba(220,38,38,0.55)' } : {}),
  },
});
