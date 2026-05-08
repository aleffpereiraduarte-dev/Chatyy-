// MessageEffectPicker — iMessage-style "Send with Effect" sheet.
//
// Two tabs: Bubble (4 effects applied to the message bubble itself) and
// Screen (8 full-screen overlays that play once on receive). Tapping a card
// returns the effect name to the parent via onPick(name); the parent stages
// it for the next send. Live mini-previews keep parity with iMessage —
// users can taste each effect before committing.
//
// We intentionally keep the picker stateless about message content: the
// parent owns inputText and re-invokes handleSend with the effect already
// staged. This way "Send with Effect" is a one-shot decoration that doesn't
// touch the regular send path's correctness guarantees.

import React, { useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, ScrollView, Animated, Easing,
  StyleSheet, Platform, Pressable, Modal, Keyboard,
} from 'react-native';
import Svg, { Circle, Path, G } from 'react-native-svg';

const BUBBLE_EFFECTS = [
  { id: 'slam',          labelKey: 'effects.slam',         label: 'Slam' },
  { id: 'loud',          labelKey: 'effects.loud',         label: 'Loud' },
  { id: 'gentle',        labelKey: 'effects.gentle',       label: 'Gentle' },
  { id: 'invisible-ink', labelKey: 'effects.invisibleInk', label: 'Invisible Ink' },
];

const SCREEN_EFFECTS = [
  { id: 'echo',          labelKey: 'effects.echo',         label: 'Echo',          color: '#7C3AED' },
  { id: 'spotlight',     labelKey: 'effects.spotlight',    label: 'Spotlight',     color: '#F59E0B' },
  { id: 'balloons',      labelKey: 'effects.balloons',     label: 'Balloons',      color: '#EF4444' },
  { id: 'confetti',      labelKey: 'effects.confetti',     label: 'Confetti',      color: '#10B981' },
  { id: 'love',          labelKey: 'effects.love',         label: 'Love',          color: '#EC4899' },
  { id: 'lasers',        labelKey: 'effects.lasers',       label: 'Lasers',        color: '#06B6D4' },
  { id: 'fireworks',     labelKey: 'effects.fireworks',    label: 'Fireworks',     color: '#F97316' },
  { id: 'shooting-star', labelKey: 'effects.shootingStar', label: 'Shooting Star', color: '#FFD700' },
  { id: 'celebration',   labelKey: 'effects.celebration',  label: 'Celebration',   color: '#FACC15' },
];

function BubblePreview({ effect, color }) {
  const scale = useRef(new Animated.Value(1)).current;
  const tx = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    let loop;
    if (effect === 'slam') {
      loop = Animated.loop(Animated.sequence([
        Animated.timing(scale, { toValue: 1.3, duration: 220, useNativeDriver: true, easing: Easing.out(Easing.back(2)) }),
        Animated.spring(scale, { toValue: 1, tension: 180, friction: 6, useNativeDriver: true }),
        Animated.delay(900),
      ]));
    } else if (effect === 'loud') {
      loop = Animated.loop(Animated.sequence([
        Animated.timing(scale, { toValue: 1.18, duration: 140, useNativeDriver: true }),
        Animated.timing(tx, { toValue: -3, duration: 60, useNativeDriver: true }),
        Animated.timing(tx, { toValue: 3, duration: 60, useNativeDriver: true }),
        Animated.timing(tx, { toValue: -2, duration: 60, useNativeDriver: true }),
        Animated.timing(tx, { toValue: 0, duration: 60, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, tension: 200, friction: 7, useNativeDriver: true }),
        Animated.delay(800),
      ]));
    } else if (effect === 'gentle') {
      loop = Animated.loop(Animated.sequence([
        Animated.timing(scale, { toValue: 0.85, duration: 220, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 1, duration: 800, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: true }),
        Animated.delay(800),
      ]));
    } else if (effect === 'invisible-ink') {
      loop = Animated.loop(Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 600, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 600, useNativeDriver: true }),
      ]));
    }
    loop?.start();
    return () => loop?.stop?.();
  }, [effect, scale, tx, opacity]);

  return (
    <Animated.View style={{
      transform: [{ scale }, { translateX: tx }],
      opacity,
      backgroundColor: color,
      paddingHorizontal: 14, paddingVertical: 9, borderRadius: 18,
      alignSelf: 'flex-end',
    }}>
      <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>Hello</Text>
    </Animated.View>
  );
}

function ScreenPreview({ effect, color }) {
  const dot = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(Animated.timing(dot, {
      toValue: 1, duration: 1400, useNativeDriver: true, easing: Easing.linear,
    }));
    loop.start();
    return () => loop.stop?.();
  }, [dot]);

  // Lightweight preview: a few colored dots arcing across the tile.
  const dots = effect === 'echo' ? Array.from({ length: 3 }) : Array.from({ length: 6 });
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, overflow: 'hidden' }}>
      {dots.map((_, i) => {
        const ty = dot.interpolate({
          inputRange: [0, 1],
          outputRange: [80, -40],
        });
        const tx = dot.interpolate({
          inputRange: [0, 1],
          outputRange: [(i - dots.length / 2) * 14, (i - dots.length / 2) * 18],
        });
        const op = dot.interpolate({
          inputRange: [0, 0.2, 0.8, 1],
          outputRange: [0, 1, 1, 0],
        });
        return (
          <Animated.View
            key={i}
            style={{
              position: 'absolute',
              left: '50%',
              top: '50%',
              width: 8, height: 8, borderRadius: 4,
              backgroundColor: color,
              opacity: op,
              transform: [{ translateX: tx }, { translateY: ty }],
            }}
          />
        );
      })}
    </View>
  );
}

export default function MessageEffectPicker({ visible, onClose, onPick, t, isDark }) {
  const [tab, setTab] = React.useState('bubble');
  const slideY = useRef(new Animated.Value(400)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) {
      // Keyboard would otherwise overlap the bottom sheet, hiding the lower
      // half of the effect tiles and (on Android) blocking taps. Dismiss it
      // BEFORE animating so the sheet lands on a stable layout.
      try { Keyboard.dismiss(); } catch {}
      Animated.parallel([
        Animated.spring(slideY, { toValue: 0, tension: 80, friction: 11, useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 1, duration: 180, useNativeDriver: true }),
      ]).start();
    } else {
      Animated.parallel([
        Animated.timing(slideY, { toValue: 400, duration: 200, useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 0, duration: 160, useNativeDriver: true }),
      ]).start();
    }
  }, [visible, slideY, backdrop]);

  // Wrapping in a native Modal lets the sheet float above the keyboard +
  // status bar overlays; without it, position:absolute would clip behind
  // both on iOS and Android.

  const sheetBg = isDark ? '#1c1c1e' : '#fff';
  const text = isDark ? '#fff' : '#0f172a';
  const subText = isDark ? '#9ca3af' : '#64748b';
  const tileBg = isDark ? '#2c2c2e' : '#f3f4f6';
  const tileBorder = isDark ? '#3a3a3c' : '#e5e7eb';
  const bubbleColor = '#7C3AED';

  const tx = (k, fb) => (typeof t === 'function' ? (t(k) || fb) : fb);

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <Animated.View
        style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.5)', opacity: backdrop }]}
      >
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} />
      </Animated.View>

      <Animated.View
        style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          backgroundColor: sheetBg,
          borderTopLeftRadius: 18, borderTopRightRadius: 18,
          paddingTop: 8, paddingBottom: Platform.OS === 'ios' ? 32 : 20,
          maxHeight: '80%',
          transform: [{ translateY: slideY }],
        }}
      >
        {/* Drag handle */}
        <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: tileBorder, marginBottom: 6 }} />

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingVertical: 8 }}>
          <Text style={{ fontSize: 17, fontWeight: '700', color: text }}>
            {tx('effects.title', 'Enviar com efeito')}
          </Text>
          <TouchableOpacity onPress={onClose} hitSlop={{ top: 10, left: 10, right: 10, bottom: 10 }}>
            <Svg width={22} height={22} viewBox="0 0 24 24"><Path d="M6 6l12 12M18 6L6 18" stroke={subText} strokeWidth={2} strokeLinecap="round" /></Svg>
          </TouchableOpacity>
        </View>

        {/* Segmented tabs */}
        <View style={{ flexDirection: 'row', marginHorizontal: 18, marginBottom: 12, backgroundColor: tileBg, borderRadius: 10, padding: 3 }}>
          {[['bubble', tx('effects.tabBubble', 'Balão')], ['screen', tx('effects.tabScreen', 'Tela')]].map(([k, label]) => (
            <TouchableOpacity
              key={k}
              onPress={() => setTab(k)}
              style={{
                flex: 1, paddingVertical: 8, alignItems: 'center', borderRadius: 8,
                backgroundColor: tab === k ? sheetBg : 'transparent',
                ...(tab === k && Platform.OS === 'ios' ? { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 2 } : {}),
              }}
            >
              <Text style={{ color: tab === k ? text : subText, fontWeight: '600', fontSize: 13 }}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <ScrollView
          horizontal={tab === 'bubble'}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={
            tab === 'bubble'
              ? { paddingHorizontal: 18, gap: 12, paddingBottom: 8 }
              : { paddingHorizontal: 14, paddingBottom: 8, flexDirection: 'row', flexWrap: 'wrap' }
          }
        >
          {tab === 'bubble' ? (
            BUBBLE_EFFECTS.map((e) => (
              <TouchableOpacity
                key={e.id}
                onPress={() => onPick(e.id)}
                activeOpacity={0.85}
                style={{
                  width: 150, height: 110, borderRadius: 14,
                  backgroundColor: tileBg, borderWidth: 1, borderColor: tileBorder,
                  padding: 10, justifyContent: 'space-between',
                }}
              >
                <View style={{ flex: 1, justifyContent: 'center' }}>
                  <BubblePreview effect={e.id} color={bubbleColor} />
                </View>
                <Text style={{ color: text, fontSize: 13, fontWeight: '600', textAlign: 'center' }}>
                  {tx(e.labelKey, e.label)}
                </Text>
              </TouchableOpacity>
            ))
          ) : (
            SCREEN_EFFECTS.map((e) => (
              <TouchableOpacity
                key={e.id}
                onPress={() => onPick(e.id)}
                activeOpacity={0.85}
                style={{
                  width: '46%', aspectRatio: 1.1, marginHorizontal: '2%', marginBottom: 12,
                  borderRadius: 14, backgroundColor: tileBg, borderWidth: 1, borderColor: tileBorder,
                  overflow: 'hidden', justifyContent: 'flex-end', padding: 10,
                }}
              >
                <ScreenPreview effect={e.id} color={e.color} />
                <Text style={{ color: text, fontSize: 13, fontWeight: '600', alignSelf: 'flex-start' }}>
                  {tx(e.labelKey, e.label)}
                </Text>
              </TouchableOpacity>
            ))
          )}
        </ScrollView>
      </Animated.View>
    </View>
    </Modal>
  );
}
