// StoryRingAvatar — shared ring+avatar+badge primitive used by every
// status surface. Was duplicated 3× across ChatListTab home, ChatStatusTab,
// and Profile.js, each with subtle drift in border width / radius / badge
// position. Lifting the visual into one component:
//
//   - locks the ChatListTab home look (which the user explicitly likes) as
//     the canonical solid ring (gradient purple, 2.5px stroke, +badge)
//   - keeps ChatStatusTab's segmented ring (one arc per story item) as a
//     `ringStyle='segmented'` opt-in — visual unchanged, code shared
//   - lets Profile.js drop its inline ring-around-avatar in favor of this
//     primitive without losing the bigger 86px variant
//
// Wave 4 modernization (2026-05-06): solid ring now paints an Instagram-style
// linear gradient (#7C3AED → #C084FC) when there's an unviewed story, plus a
// gentle scale-pulse (1.0 → 1.025 → 1.0, native driver) for that "live" feel.
// Once allViewed flips true, both effects collapse to the dim grey static ring.
//
// Three ring styles:
//   solid     → gradient when unviewed, dim grey when allViewed.
//   segmented → SVG arcs, one per item, gap=6° between. Dim per-segment.
//   none      → no ring (used for own avatar when there's no active story
//                — Notes-only surface in ChatListTab home).
//
// Two badge variants:
//   plus  → bottom-right `+` (compose/add story)
//   reply → bottom-right `↩` (DM reply shortcut, ChatListTab home pattern)
//
// Optional `note` prop renders an Instagram-style soft pill overlay on top
// of the avatar with the user's text-only ephemeral.
import React, { useEffect, useRef } from 'react';
import { View, Text, TouchableOpacity, Animated, Easing } from 'react-native';
import Svg, { Defs, LinearGradient, Stop, Circle as SvgCircle } from 'react-native-svg';
import AvatarCircle from '../AvatarCircle';

export default function StoryRingAvatar({
  name,
  email,
  size = 54,
  ringStyle = 'solid',
  ringColor = '#7C3AED',
  dimmedColor,
  allViewed = false,
  itemsViewed = null,    // bool[] — drives per-segment dimming when ringStyle='segmented'
  segments = 1,
  badge = null,          // 'plus' | 'reply' | null
  onBadgePress,
  badgeAccessibilityLabel,
  note = null,           // text content or null
  isDark = false,
  colors = null,
  // Wave 4 (2026-05-06): allow callers to suppress the live-pulse if it
  // conflicts with another animation on the same row (e.g. Vidiante avatar
  // halo). Pulse is opt-out, defaults to on for unviewed rings.
  pulse = true,
  // Live broadcast mode — paints a red/pink gradient ring + AO VIVO chip
  // anchored to the bottom of the avatar (Instagram parity).
  isLive = false,
  liveLabel = 'AO VIVO',
  // closeFriends: when true, swap the brand purple gradient for an
  // Instagram-style green gradient. Mirrors IG's behavior for
  // close-friends stories — viewers instantly know it's a restricted
  // post without having to open it. Applies to both `solid` and
  // `segmented` ring styles. No effect when allViewed (dim grey wins).
  closeFriends = false,
}) {
  const _dim = dimmedColor || (isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)');
  const _badgeBorder = isDark ? '#0d0d0d' : '#fff';
  const _avatarText = colors?.text || (isDark ? '#fff' : '#0f172a');
  const _notePillBg = isDark ? '#2a2a3e' : '#fff';
  const _notePillBorder = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';

  // Scale-based "live" pulse for unviewed rings. Native-driven (transform
  // scale is one of the few props that runs off-thread), so it costs nothing
  // even when 50 rings are visible at once.
  const pulseAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!pulse || (allViewed && !isLive) || (ringStyle === 'none' && !isLive)) return undefined;
    // Live state pulses faster + harder to draw the eye (Instagram parity).
    const dur = isLive ? 700 : 1300;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(pulseAnim, { toValue: 1, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulseAnim, { toValue: 0, duration: dur, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    loop.start();
    return () => { try { loop.stop(); } catch {} };
  }, [pulse, allViewed, ringStyle, pulseAnim, isLive]);
  const pulseScale = pulseAnim.interpolate({ inputRange: [0, 1], outputRange: [1, isLive ? 1.05 : 1.025] });

  // Outer wrapper holds the ring (or no ring + padding placeholder so the
  // rendered footprint stays identical regardless of style — keeps row
  // alignment perfect when some entries have stories and others don't).
  let inner;
  if (isLive) {
    // Live broadcast ring — Instagram-style red→pink→orange gradient that
    // overrides whichever ringStyle the caller passed (live always wins).
    const ringSize = size + 10;
    const radius = (ringSize / 2) - 1.5;
    inner = (
      <Animated.View style={{
        width: ringSize, height: ringSize,
        alignItems: 'center', justifyContent: 'center',
        transform: [{ scale: pulseScale }],
      }}>
        <View style={{ position: 'absolute', top: 0, left: 0 }}>
          <Svg width={ringSize} height={ringSize}>
            <Defs>
              <LinearGradient id={`liveRing_${size}`} x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor="#FF3B30" />
                <Stop offset="0.5" stopColor="#FF2D55" />
                <Stop offset="1" stopColor="#FF9500" />
              </LinearGradient>
            </Defs>
            <SvgCircle
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={radius}
              stroke={`url(#liveRing_${size})`}
              strokeWidth={3}
              fill="none"
            />
          </Svg>
        </View>
        <AvatarCircle name={name} email={email} size={size} />
      </Animated.View>
    );
  } else if (ringStyle === 'solid') {
    // Modernized: gradient stroke (Instagram-style purple→violet) when
    // unviewed, flat dim grey when allViewed. SVG ring lives at the same
    // outer footprint as the previous border-based ring (size + 5 padding)
    // so existing layouts don't shift.
    const ringSize = size + 10;
    const radius = (ringSize / 2) - 1.5;
    inner = (
      <Animated.View style={{
        width: ringSize, height: ringSize,
        alignItems: 'center', justifyContent: 'center',
        transform: [{ scale: pulseScale }],
      }}>
        {!allViewed && (() => {
          // Suffix the gradient id with the palette + size so we never get
          // an id collision between a close-friends green ring and a brand
          // purple ring on the same screen at the same size (only the LAST
          // rendered Defs would win otherwise).
          const gid = `solidRing_${closeFriends ? 'cf' : 'br'}_${size}`;
          return (
          <View style={{ position: 'absolute', top: 0, left: 0 }}>
            <Svg width={ringSize} height={ringSize}>
              <Defs>
                {/* Close-friends ring (IG parity): bright green gradient,
                    swapped in whenever `closeFriends` is true so the viewer
                    knows at a glance the post is restricted. Default is the
                    brand purple gradient. */}
                <LinearGradient id={gid} x1="0" y1="0" x2="1" y2="1">
                  <Stop offset="0" stopColor={closeFriends ? '#34D399' : '#A855F7'} />
                  <Stop offset="0.5" stopColor={closeFriends ? '#10B981' : ringColor} />
                  <Stop offset="1" stopColor={closeFriends ? '#047857' : '#6D28D9'} />
                </LinearGradient>
              </Defs>
              <SvgCircle
                cx={ringSize / 2}
                cy={ringSize / 2}
                r={radius}
                stroke={`url(#${gid})`}
                strokeWidth={2.5}
                fill="none"
              />
            </Svg>
          </View>
          );
        })()}
        {allViewed && (
          <View style={{
            position: 'absolute',
            width: ringSize, height: ringSize, borderRadius: ringSize / 2,
            borderWidth: 2.5, borderColor: _dim,
          }} />
        )}
        <AvatarCircle name={name} email={email} size={size} />
      </Animated.View>
    );
  } else if (ringStyle === 'segmented') {
    // Lifted from ChatStatusTab.SegmentedRing — same math, same gradient.
    // Renders one arc per story item with a 6° gap between segments.
    const count = Math.max(1, segments);
    const ringSize = size + 10;
    const radius = (ringSize / 2) - 3;
    const circumference = 2 * Math.PI * radius;
    const gapDeg = count > 1 ? 6 : 0;
    const totalGapDeg = gapDeg * count;
    const segmentDeg = (360 - totalGapDeg) / count;
    const segmentLen = (segmentDeg / 360) * circumference;
    const gapLen = (gapDeg / 360) * circumference;
    // Suffix the gradient id with the palette + size so a green close-
    // friends ring rendered next to a purple ring at the same size
    // doesn't share its Defs (only the LAST rendered Defs would win).
    const segGid = `segRing_${closeFriends ? 'cf' : 'br'}_${size}`;
    inner = (
      <Animated.View style={{
        width: ringSize, height: ringSize,
        alignItems: 'center', justifyContent: 'center',
        transform: [{ scale: pulseScale }],
      }}>
        <View style={{ position: 'absolute', top: 0, left: 0 }}>
          <Svg width={ringSize} height={ringSize}>
            <Defs>
              {/* Close-friends ring (IG parity): swap to bright green
                  gradient when `closeFriends` is set so the restricted
                  audience scope is visible at a glance — same per-segment
                  dimming as the purple variant once that item is viewed. */}
              <LinearGradient id={segGid} x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={closeFriends ? '#34D399' : '#A855F7'} />
                <Stop offset="0.5" stopColor={closeFriends ? '#10B981' : ringColor} />
                <Stop offset="1" stopColor={closeFriends ? '#047857' : '#6D28D9'} />
              </LinearGradient>
            </Defs>
            {Array.from({ length: count }).map((_, i) => {
              const segViewed = allViewed || (itemsViewed && itemsViewed[i]);
              const offset = -((segmentLen + gapLen) * i) + (circumference * 0.25);
              return (
                <SvgCircle
                  key={i}
                  cx={ringSize / 2}
                  cy={ringSize / 2}
                  r={radius}
                  stroke={segViewed
                    ? (closeFriends ? 'rgba(16,185,129,0.22)' : 'rgba(124,58,237,0.22)')
                    : `url(#${segGid})`}
                  strokeWidth={3}
                  fill="none"
                  strokeDasharray={`${segmentLen} ${circumference - segmentLen}`}
                  strokeDashoffset={offset}
                  strokeLinecap="round"
                />
              );
            })}
          </Svg>
        </View>
        <AvatarCircle name={name} email={email} size={size} />
      </Animated.View>
    );
  } else {
    // No ring — just the avatar inside the same padding box so the layout
    // doesn't shift between has-story and no-story neighbors.
    inner = (
      <View style={{ padding: 2.5 }}>
        <AvatarCircle name={name} email={email} size={size} />
      </View>
    );
  }

  return (
    <View style={{ position: 'relative' }}>
      {inner}
      {/* Notes overlay (Instagram-style soft pill on top of the avatar).
          Only paints when `note` is truthy — the wrapper itself stays
          inert, so it doesn't intercept taps on the underlying avatar. */}
      {note ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute', top: -4, left: -6, right: -6,
            backgroundColor: _notePillBg,
            borderRadius: 14,
            paddingHorizontal: 7, paddingVertical: 3,
            borderWidth: 1, borderColor: _notePillBorder,
            zIndex: 2,
          }}
        >
          <Text style={{ fontSize: 10, color: _avatarText, textAlign: 'center' }} numberOfLines={2}>
            {note}
          </Text>
        </View>
      ) : null}
      {/* AO VIVO chip — bottom-center anchored when isLive. Sits over the
          ring so it visually anchors the live state to the avatar
          (Instagram parity). White border keeps it legible on any bg. */}
      {isLive ? (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            bottom: -2,
            left: 0, right: 0,
            alignItems: 'center',
            zIndex: 3,
          }}
        >
          <View style={{
            backgroundColor: '#FF2D55',
            paddingHorizontal: 6, paddingVertical: 1.5,
            borderRadius: 5,
            borderWidth: 1.5, borderColor: _badgeBorder,
            minWidth: 38,
            alignItems: 'center',
          }}>
            <Text style={{
              color: '#fff',
              fontSize: 9,
              fontWeight: '800',
              letterSpacing: 0.4,
              lineHeight: 11,
            }}>
              {liveLabel}
            </Text>
          </View>
        </View>
      ) : null}
      {/* Badge (+ or ↩). Bottom-right anchored, brand purple, white border
          ring so it stays legible against any background. Touchable when an
          onBadgePress is given (reply path); otherwise inert (decorative
          plus on own avatar — taps land on the parent TouchableOpacity). */}
      {badge ? (
        onBadgePress ? (
          <TouchableOpacity
            onPress={onBadgePress}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityLabel={badgeAccessibilityLabel || (badge === 'reply' ? 'Reply' : 'Add')}
            style={{
              position: 'absolute',
              bottom: badge === 'reply' ? -2 : -1,
              right: badge === 'reply' ? -2 : -1,
              width: badge === 'reply' ? 22 : 22,
              height: badge === 'reply' ? 22 : 22,
              borderRadius: 11,
              backgroundColor: ringColor,
              alignItems: 'center', justifyContent: 'center',
              borderWidth: badge === 'reply' ? 2 : 2.5, borderColor: _badgeBorder,
              // Soft brand glow on both badge variants — premium CTA feel.
              shadowColor: ringColor, shadowOpacity: 0.5, shadowRadius: 6,
              shadowOffset: { width: 0, height: 2 }, elevation: 4,
            }}
          >
            <Text style={{
              color: '#fff',
              fontSize: badge === 'reply' ? 11 : 14,
              fontWeight: badge === 'reply' ? '900' : '700',
              lineHeight: badge === 'reply' ? 13 : undefined,
              marginTop: badge === 'plus' ? -2 : 0,
            }}>
              {badge === 'reply' ? '↩' : '+'}
            </Text>
          </TouchableOpacity>
        ) : (
          <View style={{
            position: 'absolute', bottom: -1, right: -1,
            width: 22, height: 22, borderRadius: 11,
            backgroundColor: ringColor,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 2.5, borderColor: _badgeBorder,
            // Soft brand-purple glow so the add affordance reads as a premium
            // CTA (Instagram/WhatsApp parity) instead of a flat dot.
            shadowColor: ringColor, shadowOpacity: 0.5, shadowRadius: 6,
            shadowOffset: { width: 0, height: 2 }, elevation: 4,
          }}>
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800', marginTop: -1, lineHeight: 17 }}>+</Text>
          </View>
        )
      ) : null}
    </View>
  );
}
