// StoryRingAvatar — shared ring+avatar+badge primitive used by every
// status surface. Was duplicated 3× across ChatListTab home, ChatStatusTab,
// and Profile.js, each with subtle drift in border width / radius / badge
// position. Lifting the visual into one component:
//
//   - locks the ChatListTab home look (which the user explicitly likes) as
//     the canonical solid ring (#7C3AED brand purple, 2.5px border, +badge)
//   - keeps ChatStatusTab's segmented ring (one arc per story item) as a
//     `ringStyle='segmented'` opt-in — visual unchanged, code shared
//   - lets Profile.js drop its inline ring-around-avatar in favor of this
//     primitive without losing the bigger 86px variant
//
// Three ring styles:
//   solid     → single border, brand purple. Dim grey when allViewed.
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
import React from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
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
}) {
  const _dim = dimmedColor || (isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)');
  const _badgeBorder = isDark ? '#0d0d0d' : '#fff';
  const _avatarText = colors?.text || (isDark ? '#fff' : '#0f172a');
  const _notePillBg = isDark ? '#2a2a3e' : '#fff';
  const _notePillBorder = isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';

  // Outer wrapper holds the ring (or no ring + padding placeholder so the
  // rendered footprint stays identical regardless of style — keeps row
  // alignment perfect when some entries have stories and others don't).
  let inner;
  if (ringStyle === 'solid') {
    inner = (
      <View style={{
        borderWidth: 2.5,
        borderColor: allViewed ? _dim : ringColor,
        borderRadius: (size / 2) + 5,
        padding: 2.5,
      }}>
        <AvatarCircle name={name} email={email} size={size} />
      </View>
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
    inner = (
      <View style={{ width: ringSize, height: ringSize, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute', top: 0, left: 0 }}>
          <Svg width={ringSize} height={ringSize}>
            <Defs>
              <LinearGradient id="storyRingGrad" x1="0" y1="0" x2="1" y2="1">
                <Stop offset="0" stopColor={ringColor} />
                <Stop offset="0.5" stopColor="#6D28D9" />
                <Stop offset="1" stopColor="#6D28D9" />
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
                  stroke={segViewed ? 'rgba(124,58,237,0.22)' : 'url(#storyRingGrad)'}
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
      </View>
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
              bottom: badge === 'reply' ? -2 : 0,
              right: badge === 'reply' ? -2 : 0,
              width: badge === 'reply' ? 22 : 20,
              height: badge === 'reply' ? 22 : 20,
              borderRadius: badge === 'reply' ? 11 : 10,
              backgroundColor: ringColor,
              alignItems: 'center', justifyContent: 'center',
              borderWidth: 2, borderColor: _badgeBorder,
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
            position: 'absolute', bottom: 0, right: 0,
            width: 20, height: 20, borderRadius: 10,
            backgroundColor: ringColor,
            alignItems: 'center', justifyContent: 'center',
            borderWidth: 2, borderColor: _badgeBorder,
          }}>
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', marginTop: -2 }}>+</Text>
          </View>
        )
      ) : null}
    </View>
  );
}
