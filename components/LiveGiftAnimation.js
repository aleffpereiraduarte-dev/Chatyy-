/**
 * LiveGiftAnimation — center-screen overlay shown when someone sends a gift.
 *
 * Renders for ~2.6s when a `live_gift` WS event arrives:
 *   • Sender avatar (top-left of card) with name + "enviou X"
 *   • Giant gift glyph (90px, center)
 *   • Animated diamond count chip
 *   • Scale 0 → 1.2 → 1 (spring) + fade-out at the end
 *
 * Pure Animated (no Reanimated dep — project doesn't have it installed).
 * Multiple gifts can queue: the parent passes a `gift` object; component
 * resets + replays when the `gift` ref changes (use a unique `key` per
 * event so React mounts a fresh instance for each animation cycle).
 */

import { useEffect, useRef } from 'react';
import { View, Text, StyleSheet, Animated, Easing } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import AvatarCircle from './AvatarCircle';
import { GiftGlyph, GIFT_CATALOG } from './LiveGiftPicker';

function findCatalog(type) {
  return GIFT_CATALOG.find((g) => g.type === type) || { type, color: '#fff', diamonds: 1, label: type };
}

function DiamondSpark({ size = 16 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="#60a5fa" stroke="#1d4ed8" strokeWidth={1}>
      <Path d="M6 3h12l4 6-10 12L2 9l4-6Z" />
    </Svg>
  );
}

export default function LiveGiftAnimation({
  gift,         // { sender_name, sender_email, sender_avatar, gift_type, diamonds }
  onComplete,
  i18n = {},
  duration = 2600,
}) {
  const scale = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const diamondAnim = useRef(new Animated.Value(0)).current;
  const completeRef = useRef(onComplete);
  completeRef.current = onComplete;

  useEffect(() => {
    if (!gift) return;
    scale.setValue(0);
    opacity.setValue(0);
    diamondAnim.setValue(0);

    // Phase 1 — pop in (0 → 1.2 spring overshoot)
    // Phase 2 — settle to 1 (spring back)
    // Phase 3 — hold for ~1.8s (driven by sequence timing)
    // Phase 4 — fade out
    const anim = Animated.sequence([
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.sequence([
          Animated.timing(scale, {
            toValue: 1.2,
            duration: 280,
            easing: Easing.out(Easing.back(1.6)),
            useNativeDriver: true,
          }),
          Animated.spring(scale, {
            toValue: 1,
            friction: 5,
            tension: 140,
            useNativeDriver: true,
          }),
        ]),
        Animated.timing(diamondAnim, {
          toValue: 1,
          duration: 700,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: false,
        }),
      ]),
      Animated.delay(Math.max(0, duration - 1100)),
      Animated.parallel([
        Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0.9, duration: 300, useNativeDriver: true }),
      ]),
    ]);
    anim.start(({ finished }) => {
      if (finished) completeRef.current?.();
    });
    return () => anim.stop();
  }, [gift, scale, opacity, diamondAnim, duration]);

  if (!gift) return null;
  const cat = findCatalog(gift.gift_type);
  const diamonds = Number(gift.diamonds || cat.diamonds) || cat.diamonds;
  const senderName = gift.sender_name || (gift.sender_email || '').split('@')[0] || '—';

  // Animated diamond integer — interpolates from 0 → diamonds for the count-up.
  const animatedDiamondText = diamondAnim.interpolate({
    inputRange: [0, 1],
    outputRange: [0, diamonds],
  });

  return (
    <View pointerEvents="none" style={styles.wrap}>
      <Animated.View
        style={[
          styles.card,
          { borderColor: cat.color, opacity, transform: [{ scale }] },
        ]}
      >
        <View style={styles.header}>
          <AvatarCircle name={senderName} email={gift.sender_email} size={36} />
          <View style={styles.headerMid}>
            <Text style={styles.senderName} numberOfLines={1}>{senderName}</Text>
            <Text style={styles.sentLabel} numberOfLines={1}>
              {(i18n.sentGift || 'enviou') + ' ' + (i18n['gift_' + cat.type] || cat.label)}
            </Text>
          </View>
        </View>
        <View style={styles.glyphBig}>
          <GiftGlyph type={cat.type} size={90} color={cat.color} />
        </View>
        <View style={[styles.diamondChip, { borderColor: cat.color + '88' }]}>
          <DiamondSpark size={18} />
          <CountText anim={animatedDiamondText} />
        </View>
      </Animated.View>
    </View>
  );
}

// Renders an animated integer (rounded each frame) from an Animated.Value.
function CountText({ anim }) {
  const ref = useRef(null);
  const lastRef = useRef(0);
  useEffect(() => {
    const id = anim.addListener(({ value }) => {
      const next = Math.round(value);
      if (next !== lastRef.current) {
        lastRef.current = next;
        ref.current?.setNativeProps({ text: '+' + next });
      }
    });
    return () => anim.removeListener(id);
  }, [anim]);
  return (
    <Text ref={ref} style={styles.diamondCount}>+0</Text>
  );
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 70,
  },
  card: {
    backgroundColor: 'rgba(20,20,28,0.88)',
    borderWidth: 2,
    borderRadius: 22,
    paddingHorizontal: 22,
    paddingTop: 14,
    paddingBottom: 18,
    alignItems: 'center',
    minWidth: 220,
    maxWidth: 320,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    alignSelf: 'stretch',
  },
  headerMid: {
    flex: 1,
    minWidth: 0,
  },
  senderName: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '800',
  },
  sentLabel: {
    color: 'rgba(255,255,255,0.65)',
    fontSize: 11,
    marginTop: 1,
  },
  glyphBig: {
    marginVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  diamondChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 12,
    paddingVertical: 5,
    backgroundColor: 'rgba(96,165,250,0.18)',
    borderRadius: 14,
    borderWidth: 1.5,
  },
  diamondCount: {
    color: '#bfdbfe',
    fontSize: 16,
    fontWeight: '900',
    letterSpacing: 0.5,
  },
});
