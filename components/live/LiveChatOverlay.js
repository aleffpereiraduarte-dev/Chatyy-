/**
 * LiveChatOverlay — TikTok-grade floating comment stream over the video.
 *
 * Renders the last N (default 6) chat messages bottom-up.
 *
 * Features (#921 round):
 *   • Each row slides up from bottom with spring entrance (entry anim).
 *   • Stack alpha — older msgs fade as new ones come.
 *   • Username CHIP COLORED by tier: gold (gifter), purple (host), default.
 *   • Tap on row → @reply pre-fills input (onPressMessage).
 *   • Long-press → host can pin (onLongPressHost) or remove (onRequestRemove).
 *   • System "X entrou" chips inline w/ mini avatar (purple glass pill).
 *   • Gift chip — golden chip with sparkle + amount badge.
 *   • Heart float chip on side when msg has reactions (double-tap).
 *
 * Pure presentation. All animation values come from parent message objects;
 * parent owns timeline + WS plumbing.
 */

import { memo, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated,
} from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect } from 'react-native-svg';
import AvatarCircle from '../AvatarCircle';
import { IconHeart, IconStar, IconUserPlus } from '../Icons';

// Tier accent — matches the rest of the live UI brand palette.
const LIVE_RED = '#dc2626';
const TIER_HOST = '#7C3AED';     // purple chip behind host name
const TIER_GIFT = '#fbbf24';     // gold chip for paying viewers
const TIER_GUEST = '#22d3ee';    // cyan for co-host (post-approval)
const TIER_DEFAULT = 'rgba(255,255,255,0.16)';

function chipForTier(tier) {
  if (tier === 'host') return TIER_HOST;
  if (tier === 'gift' || tier === 'gifter') return TIER_GIFT;
  if (tier === 'guest' || tier === 'cohost') return TIER_GUEST;
  return TIER_DEFAULT;
}

// SVG-backed top fade so messages "exit" softly at the top of the column
// instead of getting hard-cropped by the parent's mask. We use SVG because
// expo-linear-gradient isn't in the dep tree; react-native-svg is already
// imported across the app and renders identically on iOS + Android + web.
// The fade is positioned absolutely and pointerEvents='none' so it never
// eats taps on the rows underneath.
const TopFadeGradient = memo(function TopFadeGradient({ width = 280, height = 56 }) {
  return (
    <View
      pointerEvents="none"
      style={{
        position: 'absolute', top: -4, left: 0, right: 0, height,
      }}
    >
      <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <Defs>
          <SvgLinearGradient id="liveChatTopFade" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor="#000" stopOpacity="0.85" />
            <Stop offset="0.55" stopColor="#000" stopOpacity="0.35" />
            <Stop offset="1" stopColor="#000" stopOpacity="0" />
          </SvgLinearGradient>
        </Defs>
        <Rect x="0" y="0" width={width} height={height} fill="url(#liveChatTopFade)" />
      </Svg>
    </View>
  );
});

// CommentRow — memoized so the row only re-reconciles when its own props
// change (entry anim value, content, tier). Without this every parent
// render (countdown tick, viewer count, heart anim) rebuilt all rows.
const CommentRow = memo(function CommentRow({
  m, stackAlpha, isHostView, onPressMessage, onLongPressHost,
  hostEmail, commentHearts,
}) {
  const entry = m.entry;
  const opacity = entry
    ? entry.interpolate({ inputRange: [0, 1], outputRange: [0, stackAlpha] })
    : stackAlpha;
  const translateY = entry
    ? entry.interpolate({ inputRange: [0, 1], outputRange: [14, 0] })
    : 0;
  const scale = entry
    ? entry.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] })
    : 1;

  const tier = m.tier || (hostEmail && (m.email || '').toLowerCase() === hostEmail.toLowerCase() ? 'host' : 'default');
  const chipBg = chipForTier(tier);
  const heartAnim = commentHearts[m.id];

  return (
    <Animated.View style={{ opacity, transform: [{ translateY }, { scale }] }}>
      <TouchableOpacity
        onPress={(e) => { e.stopPropagation?.(); onPressMessage?.(m); }}
        onLongPress={isHostView ? () => onLongPressHost?.(m) : undefined}
        delayLongPress={350}
        activeOpacity={0.7}
        accessibilityRole="button"
        accessibilityLabel={`Reply to ${m.name}`}
        style={styles.row}
      >
        <AvatarCircle name={m.name} email={m.email} size={26} />
        <View style={styles.body}>
          <View style={[styles.nameChip, { backgroundColor: chipBg }]}>
            <Text style={styles.name} numberOfLines={1}>{m.name}</Text>
            {tier === 'host' ? <Text style={styles.tierBadge}>HOST</Text> : null}
            {tier === 'gift' ? <Text style={styles.tierBadge}>★</Text> : null}
            {(tier === 'guest' || tier === 'cohost') ? <Text style={styles.tierBadge}>COLAB</Text> : null}
          </View>
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
                  { translateY: heartAnim.interpolate({ inputRange: [0, 1], outputRange: [10, -4] }) },
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
});

const SystemRow = memo(function SystemRow({ m, stackAlpha }) {
  const entry = m.entry;
  const opacity = entry
    ? entry.interpolate({ inputRange: [0, 1], outputRange: [0, stackAlpha] })
    : stackAlpha;
  const translateY = entry
    ? entry.interpolate({ inputRange: [0, 1], outputRange: [14, 0] })
    : 0;
  const scale = entry
    ? entry.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] })
    : 1;
  return (
    <Animated.View
      style={[styles.systemRow, { opacity, transform: [{ translateY }, { scale }] }]}
      pointerEvents="none"
    >
      <View style={styles.systemPill}>
        {m.email ? (
          <View style={styles.systemAvatarWrap}>
            <AvatarCircle name={m.name} email={m.email} size={16} />
          </View>
        ) : (
          <IconUserPlus size={11} color="#fff" />
        )}
        <Text style={styles.systemText} numberOfLines={1}>
          <Text style={styles.systemName}>{m.name}</Text>
          <Text>{` ${m.text || m.content || ''}`}</Text>
        </Text>
      </View>
    </Animated.View>
  );
});

const GiftRow = memo(function GiftRow({ m, stackAlpha }) {
  const entry = m.entry;
  const opacity = entry
    ? entry.interpolate({ inputRange: [0, 1], outputRange: [0, stackAlpha] })
    : stackAlpha;
  const translateY = entry
    ? entry.interpolate({ inputRange: [0, 1], outputRange: [14, 0] })
    : 0;
  const scale = entry
    ? entry.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] })
    : 1;
  return (
    <Animated.View
      style={[styles.giftRow, { opacity, transform: [{ translateY }, { scale }] }]}
      pointerEvents="none"
    >
      <View style={styles.giftPill}>
        <View style={styles.giftAvatar}>
          <AvatarCircle name={m.name} email={m.email} size={20} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.giftName} numberOfLines={1}>{m.name}</Text>
          <Text style={styles.giftText} numberOfLines={1}>
            {m.giftLabel || (m.gift ? `enviou ${m.gift}` : 'enviou um presente')}
          </Text>
        </View>
        <View style={styles.giftAmount}>
          <IconStar size={12} color="#fff" />
          <Text style={styles.giftAmountText}>{m.amount || 1}</Text>
        </View>
      </View>
    </Animated.View>
  );
});

function LiveChatOverlay({
  messages = [],
  commentHearts = {},
  onPressMessage,
  onOpenSheet,
  onLongPressHost,
  isHostView = false,
  hasMore = false,
  seeAllLabel = 'Ver todos os comentários',
  hostEmail = null,
}) {
  // Codex root cause #9 — memoize the visible slice so the overlay doesn't
  // recompute the array on every parent render (chat tick / animation
  // frame / viewer count). Combined with the parent's bounded array (max
  // 50) this drops the overlay's RN bridge traffic significantly.
  const visible = useMemo(() => messages.slice(-6), [messages]);

  return (
    <TouchableOpacity
      onPress={onOpenSheet}
      activeOpacity={0.85}
      style={styles.overlay}
      accessibilityLabel="Chat ao vivo"
      accessibilityRole="button"
    >
      {/* Native top-fade gradient — softens the column's upper edge so old
          messages "exit" instead of clipping. Web already has a mask
          (WebkitMaskImage in styles.overlay); this SVG overlays it for
          parity on iOS/Android (no expo-linear-gradient dep needed). */}
      {Platform.OS !== 'web' ? <TopFadeGradient /> : null}

      {hasMore ? (
        <View style={styles.seeAllChip} pointerEvents="none">
          <Text style={styles.seeAllText}>{seeAllLabel}</Text>
        </View>
      ) : null}

      {visible.map((m, idx) => {
        // Older comments fade softer; stack alpha 0.45 → 1 from top.
        const stackAlpha = 0.45 + (idx / Math.max(visible.length - 1, 1)) * 0.55;

        if (m.isSystem || m.type === 'system') {
          return <SystemRow key={m.id} m={m} stackAlpha={stackAlpha} />;
        }
        if (m.type === 'gift' || m.gift) {
          return <GiftRow key={m.id} m={m} stackAlpha={stackAlpha} />;
        }
        return (
          <CommentRow
            key={m.id}
            m={m}
            stackAlpha={stackAlpha}
            isHostView={isHostView}
            onPressMessage={onPressMessage}
            onLongPressHost={onLongPressHost}
            hostEmail={hostEmail}
            commentHearts={commentHearts}
          />
        );
      })}
    </TouchableOpacity>
  );
}

// Codex root cause #9 — memo wrap prevents re-render when parent (Live
// host/viewer screen) re-renders for unrelated reasons (countdown tick,
// heart anim, viewer count). With memoization, the overlay only reconciles
// when `messages` actually changes.
export default memo(LiveChatOverlay);

const styles = StyleSheet.create({
  overlay: {
    paddingRight: 70, // leave room for the right rail
    marginBottom: 8,
    gap: 6,
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
    maxWidth: '94%',
    paddingVertical: 3,
  },
  body: {
    flexShrink: 1,
    paddingTop: 0,
  },
  // Colored name chip (per-tier background)
  nameChip: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 9,
    marginBottom: 2,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
  },
  name: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
    ...(Platform.OS === 'web' ? { textShadow: '0 1px 2px rgba(0,0,0,0.6)' } : {}),
  },
  tierBadge: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '900',
    letterSpacing: 0.4,
    opacity: 0.92,
  },
  text: {
    color: '#fff',
    fontSize: 13,
    lineHeight: 17,
    fontWeight: '500',
    ...(Platform.OS === 'web' ? { textShadow: '0 1px 2px rgba(0,0,0,0.85)' } : {}),
  },

  // System chip ("@maria entrou")
  systemRow: {
    alignSelf: 'flex-start',
    maxWidth: '88%',
  },
  systemPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingLeft: 4,
    paddingRight: 11,
    paddingVertical: 3,
    backgroundColor: 'rgba(124,58,237,0.35)',
    borderWidth: 1,
    borderColor: 'rgba(196,181,253,0.45)',
    borderRadius: 14,
  },
  systemAvatarWrap: {
    borderRadius: 10,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.55)',
  },
  systemText: {
    color: 'rgba(255,255,255,0.96)',
    fontSize: 11.5,
    fontWeight: '500',
  },
  systemName: {
    fontWeight: '800',
    color: '#fff',
  },

  // Gift chip (golden, with sparkle + amount)
  giftRow: {
    alignSelf: 'flex-start',
    maxWidth: '94%',
  },
  giftPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingLeft: 5,
    paddingRight: 8,
    paddingVertical: 5,
    backgroundColor: 'rgba(251,191,36,0.22)',
    borderWidth: 1.5,
    borderColor: 'rgba(251,191,36,0.85)',
    borderRadius: 16,
    ...(Platform.OS === 'web' ? {
      boxShadow: '0 4px 14px rgba(251,191,36,0.35)',
    } : {}),
  },
  giftAvatar: {
    borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 1.5,
    borderColor: 'rgba(251,191,36,0.95)',
  },
  giftName: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '800',
    ...(Platform.OS === 'web' ? { textShadow: '0 1px 2px rgba(0,0,0,0.7)' } : {}),
  },
  giftText: {
    color: 'rgba(255,255,255,0.95)',
    fontSize: 11,
    fontWeight: '500',
  },
  giftAmount: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    borderRadius: 10,
    backgroundColor: '#fbbf24',
  },
  giftAmountText: {
    color: '#111',
    fontWeight: '900',
    fontSize: 11,
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
