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
import { ScreenEffectPreview } from './MessageScreenEffect';
import { BubbleEffectPreview } from './MessageBubbleEffect';

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

export default function MessageEffectPicker({ visible, onClose, onPick, t, isDark, messageText }) {
  const [tab, setTab] = React.useState('bubble');
  // When a SCREEN effect is selected we open a full-screen live preview
  // (iMessage-style) that plays the real effect behind a message bubble.
  // `previewEffect` holds the screen-effect id currently being previewed;
  // null means we're back on the picker grid.
  const [previewEffect, setPreviewEffect] = React.useState(null);
  // Bubble effects get a full-screen preview too (parity with the screen tab):
  // tapping a bubble tile opens a live looping BubbleEffectPreview on a sample
  // bubble + a clear "Enviar com efeito" CTA. `previewBubble` holds that id.
  const [previewBubble, setPreviewBubble] = React.useState(null);
  const slideY = useRef(new Animated.Value(400)).current;
  const backdrop = useRef(new Animated.Value(0)).current;

  // Reset the full-screen preview whenever the sheet closes so it never
  // re-opens stuck on a stale effect (and the Animated loops tear down).
  useEffect(() => {
    if (!visible) { setPreviewEffect(null); setPreviewBubble(null); }
  }, [visible]);

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

  const previewBubbleText = (typeof messageText === 'string' && messageText.trim())
    ? messageText.trim()
    : tx('effects.previewSample', 'Olá');

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      // Android back: leave the full-screen preview first, then close the sheet.
      onRequestClose={() => {
        if (previewEffect) setPreviewEffect(null);
        else if (previewBubble) setPreviewBubble(null);
        else onClose();
      }}
      statusBarTranslucent
    >
    <View style={StyleSheet.absoluteFillObject} pointerEvents="box-none">
      <Animated.View
        style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.5)', opacity: backdrop }]}
      >
        <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} />
      </Animated.View>

      {/* Full-screen live preview — plays the REAL screen-effect renderer
          behind a message bubble (iMessage parity). Switching effects from
          here re-triggers instantly via ScreenEffectPreview's keyed remount. */}
      {previewEffect ? (
        <View style={[StyleSheet.absoluteFillObject, { backgroundColor: isDark ? '#000' : '#0b1020' }]}>
          {/* The actual animating effect, looping behind the bubble */}
          <ScreenEffectPreview effect={previewEffect} active={visible} />

          {/* Top bar: back to grid + effect name */}
          <View style={{
            position: 'absolute', top: Platform.OS === 'ios' ? 54 : 28, left: 0, right: 0,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 18,
          }}>
            <TouchableOpacity
              onPress={() => setPreviewEffect(null)}
              hitSlop={{ top: 12, left: 12, right: 12, bottom: 12 }}
              accessibilityLabel={tx('common.back', 'Voltar')}
            >
              <Svg width={26} height={26} viewBox="0 0 24 24">
                <Path d="M15 19l-7-7 7-7" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </Svg>
            </TouchableOpacity>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
              {tx(
                (SCREEN_EFFECTS.find((e) => e.id === previewEffect) || {}).labelKey || '',
                (SCREEN_EFFECTS.find((e) => e.id === previewEffect) || {}).label || ''
              )}
            </Text>
            <View style={{ width: 26 }} />
          </View>

          {/* Message bubble preview, on top of the animation */}
          <View style={{ flex: 1, justifyContent: 'flex-end', paddingHorizontal: 18, paddingBottom: 120 }}>
            <View style={{
              alignSelf: 'flex-end', maxWidth: '82%',
              backgroundColor: '#7C3AED',
              paddingHorizontal: 14, paddingVertical: 10,
              borderRadius: 20, borderBottomRightRadius: 6,
            }}>
              <Text style={{ color: '#fff', fontSize: 16, lineHeight: 21 }}>
                {previewBubbleText}
              </Text>
            </View>
          </View>

          {/* Confirm bar: replay + send-with-effect */}
          <View style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: 18, paddingTop: 12,
            paddingBottom: Platform.OS === 'ios' ? 40 : 24,
            flexDirection: 'row', alignItems: 'center', gap: 12,
          }}>
            <TouchableOpacity
              onPress={() => { onPick(previewEffect); setPreviewEffect(null); }}
              activeOpacity={0.9}
              style={{
                flex: 1, backgroundColor: '#7C3AED',
                paddingVertical: 14, borderRadius: 14, alignItems: 'center',
                flexDirection: 'row', justifyContent: 'center', gap: 8,
              }}
              accessibilityLabel={tx('effects.sendWithEffect', 'Enviar com efeito')}
            >
              <Svg width={18} height={18} viewBox="0 0 24 24">
                <Path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </Svg>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                {tx('effects.sendWithEffect', 'Enviar com efeito')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* Full-screen BUBBLE preview — runs the REAL MessageBubbleEffect
          choreography (BubbleEffectPreview) on a sample bubble, looping, so
          the sender sees exactly the slam/loud/gentle/invisible-ink the
          recipient will get. Same renderer as recipient playback. */}
      {previewBubble ? (
        <View style={[StyleSheet.absoluteFillObject, { backgroundColor: isDark ? '#0b0b0d' : '#0b1020' }]}>
          {/* Top bar: back to grid + effect name */}
          <View style={{
            position: 'absolute', top: Platform.OS === 'ios' ? 54 : 28, left: 0, right: 0,
            flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
            paddingHorizontal: 18,
          }}>
            <TouchableOpacity
              onPress={() => setPreviewBubble(null)}
              hitSlop={{ top: 12, left: 12, right: 12, bottom: 12 }}
              accessibilityLabel={tx('common.back', 'Voltar')}
            >
              <Svg width={26} height={26} viewBox="0 0 24 24">
                <Path d="M15 19l-7-7 7-7" stroke="#fff" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </Svg>
            </TouchableOpacity>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
              {tx(
                (BUBBLE_EFFECTS.find((e) => e.id === previewBubble) || {}).labelKey || '',
                (BUBBLE_EFFECTS.find((e) => e.id === previewBubble) || {}).label || ''
              )}
            </Text>
            <View style={{ width: 26 }} />
          </View>

          {/* The looping bubble effect on a sample bubble, centered. */}
          <View style={{ flex: 1, justifyContent: 'center', paddingHorizontal: 28 }}>
            <View style={{ alignItems: 'flex-end' }}>
              <BubbleEffectPreview
                effect={previewBubble}
                active={visible}
                color="#7C3AED"
                label={previewBubbleText}
              />
            </View>
            {previewBubble === 'invisible-ink' ? (
              <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 13, textAlign: 'center', marginTop: 28 }}>
                {tx('effects.invisibleInkHint', 'O conteúdo fica oculto até o toque')}
              </Text>
            ) : null}
          </View>

          {/* Confirm bar: send-with-effect */}
          <View style={{
            position: 'absolute', left: 0, right: 0, bottom: 0,
            paddingHorizontal: 18, paddingTop: 12,
            paddingBottom: Platform.OS === 'ios' ? 40 : 24,
            flexDirection: 'row', alignItems: 'center', gap: 12,
          }}>
            <TouchableOpacity
              onPress={() => { onPick(previewBubble); setPreviewBubble(null); }}
              activeOpacity={0.9}
              style={{
                flex: 1, backgroundColor: '#7C3AED',
                paddingVertical: 14, borderRadius: 14, alignItems: 'center',
                flexDirection: 'row', justifyContent: 'center', gap: 8,
              }}
              accessibilityLabel={tx('effects.sendWithEffect', 'Enviar com efeito')}
            >
              <Svg width={18} height={18} viewBox="0 0 24 24">
                <Path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" fill="none" />
              </Svg>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                {tx('effects.sendWithEffect', 'Enviar com efeito')}
              </Text>
            </TouchableOpacity>
          </View>
        </View>
      ) : null}

      {/* Picker grid — hidden while either full-screen preview is up */}
      {!previewEffect && !previewBubble ? (
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
                // Open a full-screen live preview (parity with screen tab),
                // confirm "Enviar com efeito" from there. The inline mini-tile
                // already loops the REAL bubble choreography via BubbleEffectPreview.
                onPress={() => setPreviewBubble(e.id)}
                activeOpacity={0.85}
                style={{
                  width: 150, height: 110, borderRadius: 14,
                  backgroundColor: tileBg, borderWidth: 1, borderColor: tileBorder,
                  padding: 10, justifyContent: 'space-between', overflow: 'hidden',
                }}
              >
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'flex-end' }} pointerEvents="none">
                  <BubbleEffectPreview
                    effect={e.id}
                    active={visible && tab === 'bubble' && !previewBubble && !previewEffect}
                    color={bubbleColor}
                    label="Olá"
                  />
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
                // Screen effects open a full-screen live preview first (so the
                // sender sees exactly what the recipient will see) and confirm
                // from there. Bubble effects still commit on tap.
                onPress={() => setPreviewEffect(e.id)}
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
      ) : null}
    </View>
    </Modal>
  );
}
