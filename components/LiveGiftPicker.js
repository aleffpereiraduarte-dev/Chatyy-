/**
 * LiveGiftPicker — bottom-sheet gift picker for live broadcasts.
 *
 * 6 free virtual gifts (no real payment — diamonds are virtual, ungated).
 * Layout: 3×2 grid. Each cell shows the gift SVG, its label, and the diamond
 * cost. Tap → onSelect(giftType) → parent posts to `chat_live_send_gift`
 * which writes to `chat_live_gifts` and broadcasts the `live_gift` WS event.
 *
 * No emoji — every gift glyph is an inline SVG so it scales crisp on retina
 * and matches the rest of the app's icon system (per project rule).
 */

import { useEffect, useRef } from 'react';
import {
  Modal, View, Text, TouchableOpacity, StyleSheet, Pressable, Animated,
} from 'react-native';
import Svg, { Path, Circle, Polygon, Rect, G, Ellipse } from 'react-native-svg';
import { IconX } from './Icons';

// Gift catalog. Order = display order in the picker. Each `glyph` is a render
// function so we keep all gift SVGs colocated and tied to their metadata.
// `diamonds` matches the backend's expected cost — server clamps to this
// table so client tampering won't fake-credit a sender.
export const GIFT_CATALOG = [
  { type: 'rose',   diamonds: 1,   color: '#ef4444', label: 'Rose' },
  { type: 'heart',  diamonds: 5,   color: '#ec4899', label: 'Heart' },
  { type: 'star',   diamonds: 10,  color: '#facc15', label: 'Star' },
  { type: 'crown',  diamonds: 25,  color: '#fbbf24', label: 'Crown' },
  { type: 'fire',   diamonds: 50,  color: '#f97316', label: 'Fire' },
  { type: 'rocket', diamonds: 100, color: '#a855f7', label: 'Rocket' },
];

export function GiftGlyph({ type, size = 36, color }) {
  const stroke = color || '#fff';
  const fill = color || '#fff';
  switch (type) {
    case 'rose':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path d="M12 2C9 2 7 4 7 7c0 2 1 3.5 2.5 4.5C8 12.5 7 14 7 16c0 3 2 5 5 5s5-2 5-5c0-2-1-3.5-2.5-4.5C16 10.5 17 9 17 7c0-3-2-5-5-5Z" fill={fill} />
          <Path d="M12 13c1.5 0 2.5-1 2.5-2.5S13.5 8 12 8s-2.5 1-2.5 2.5S10.5 13 12 13Z" fill="#7f1d1d" />
          <Path d="M12 21v-3" stroke="#16a34a" strokeWidth={2} strokeLinecap="round" />
          <Path d="M10 20c-1 0-2-1-2-2" stroke="#16a34a" strokeWidth={1.8} fill="none" strokeLinecap="round" />
        </Svg>
      );
    case 'heart':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
          <Path d="M12 21s-7-4.5-9.5-9C1 9 2.5 5 6 5c2 0 3.5 1 4 2 .5 1 .5 1.5 2 1.5s1.5-.5 2-1.5c.5-1 2-2 4-2 3.5 0 5 4 3.5 7-2.5 4.5-9.5 9-9.5 9Z" />
        </Svg>
      );
    case 'star':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="#a16207" strokeWidth={1}>
          <Polygon points="12 2 15 9 22 9.5 17 14.5 18.5 22 12 18 5.5 22 7 14.5 2 9.5 9 9 12 2" />
        </Svg>
      );
    case 'crown':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke="#92400e" strokeWidth={1}>
          <Path d="M3 8l4 4 5-7 5 7 4-4-2 11H5L3 8Z" />
          <Circle cx="3" cy="8" r="1.5" fill="#dc2626" />
          <Circle cx="21" cy="8" r="1.5" fill="#dc2626" />
          <Circle cx="12" cy="5" r="1.5" fill="#dc2626" />
        </Svg>
      );
    case 'fire':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill}>
          <Path d="M12 2c1 4 5 5 5 10 0 4-3 8-7 8-3.5 0-6-2.5-6-6 0-2 1-3 2-4 0 2 1 3 2 3 0-3 1-6 4-11Z" />
          <Path d="M11 13c1 2 3 2 3 5 0 2-1 3-2.5 3-2 0-3-1-3-3 0-1 .5-2 1-2.5 0 1 .5 1.5 1.5 1.5 0-1.5-.5-2.5 0-4Z" fill="#fef3c7" />
        </Svg>
      );
    case 'rocket':
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
          <Path d="M12 2c4 2 6 6 6 10v3l-2 2h-8l-2-2v-3c0-4 2-8 6-10Z" fill={fill} />
          <Circle cx="12" cy="9" r="2" fill="#fef3c7" stroke="#7e22ce" strokeWidth={1} />
          <Path d="M7 17l-3 4 3-1 1 2 1-3" fill="#f97316" />
          <Path d="M17 17l3 4-3-1-1 2-1-3" fill="#f97316" />
          <Path d="M10 21h4l-2 2-2-2Z" fill="#fbbf24" />
        </Svg>
      );
    default:
      return (
        <Svg width={size} height={size} viewBox="0 0 24 24" stroke={stroke} fill="none" strokeWidth={1.8}>
          <Rect x="3" y="8" width="18" height="13" rx="2" />
          <Path d="M3 12h18M12 8v13M8 8c-1.5 0-3-1-3-2.5S6.5 3 8 3s4 2 4 5c0-3 2.5-5 4-5s3 1 3 2.5S17.5 8 16 8" />
        </Svg>
      );
  }
}

// Compact gift icon for the composer button (closed state).
export function IconGiftBox({ size = 22, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" stroke={color} fill="none" strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="8" width="18" height="13" rx="2" />
      <Path d="M3 12h18M12 8v13" />
      <Path d="M8 8c-1.5 0-3-1-3-2.5S6.5 3 8 3s4 2 4 5" />
      <Path d="M16 8c1.5 0 3-1 3-2.5S17.5 3 16 3s-4 2-4 5" />
    </Svg>
  );
}

export default function LiveGiftPicker({
  visible,
  onClose,
  onSelect,
  i18n = {},
}) {
  const slide = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(slide, {
      toValue: visible ? 1 : 0,
      duration: 220,
      useNativeDriver: true,
    }).start();
  }, [visible, slide]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Animated.View
          style={[
            styles.sheet,
            {
              transform: [{
                translateY: slide.interpolate({ inputRange: [0, 1], outputRange: [300, 0] }),
              }],
              opacity: slide,
            },
          ]}
        >
          <Pressable onPress={(e) => e.stopPropagation?.()}>
            <View style={styles.handle} />
            <View style={styles.headerRow}>
              <Text style={styles.title}>{i18n.sendGift || 'Enviar presente'}</Text>
              <TouchableOpacity onPress={onClose} style={styles.closeBtn} accessibilityRole="button">
                <IconX size={18} color="#fff" />
              </TouchableOpacity>
            </View>
            <Text style={styles.subtitle}>
              {i18n.giftSubtitle || 'Toque para enviar e aparecer para todos'}
            </Text>
            <View style={styles.grid}>
              {GIFT_CATALOG.map((g) => (
                <TouchableOpacity
                  key={g.type}
                  onPress={() => onSelect(g)}
                  activeOpacity={0.7}
                  style={styles.cell}
                  accessibilityRole="button"
                  accessibilityLabel={g.label + ' ' + g.diamonds}
                >
                  <View style={styles.glyphWrap}>
                    <GiftGlyph type={g.type} size={42} color={g.color} />
                  </View>
                  <Text style={styles.cellLabel} numberOfLines={1}>
                    {(i18n['gift_' + g.type]) || g.label}
                  </Text>
                  <View style={styles.diamondPill}>
                    <DiamondSpark size={10} />
                    <Text style={styles.diamondText}>{g.diamonds}</Text>
                  </View>
                </TouchableOpacity>
              ))}
            </View>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

function DiamondSpark({ size = 10 }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="#60a5fa" stroke="#1d4ed8" strokeWidth={1}>
      <Path d="M6 3h12l4 6-10 12L2 9l4-6Z" />
    </Svg>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
  },
  sheet: {
    backgroundColor: '#15151a',
    borderTopLeftRadius: 22,
    borderTopRightRadius: 22,
    paddingHorizontal: 18,
    paddingTop: 10,
    paddingBottom: 28,
  },
  handle: {
    alignSelf: 'center',
    width: 40, height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    marginBottom: 12,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },
  closeBtn: {
    width: 30, height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  subtitle: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    marginTop: 4,
    marginBottom: 16,
  },
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
  },
  cell: {
    width: '31%',
    aspectRatio: 0.95,
    backgroundColor: 'rgba(255,255,255,0.05)',
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.08)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 10,
    paddingVertical: 10,
    gap: 6,
  },
  glyphWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellLabel: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 2,
  },
  diamondPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 2,
    backgroundColor: 'rgba(96,165,250,0.15)',
    borderRadius: 10,
    borderWidth: 1,
    borderColor: 'rgba(96,165,250,0.3)',
  },
  diamondText: {
    color: '#bfdbfe',
    fontSize: 11,
    fontWeight: '800',
  },
});
