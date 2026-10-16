/**
 * AnimatedStatusText
 * ------------------
 * Renders a text-only story with an optional entry animation.
 *
 * Why a dedicated component: React Native's Animated API needs its driver
 * hooks (useRef + useEffect) anchored to a stable component. Inlining this
 * inside ChatStatusTab's viewer caused the animation to re-fire on every
 * unrelated re-render (progress ticks, timer updates) because the hook
 * order changed between paths. Extracting to a component also makes it
 * trivially reusable from the profile viewer and the feed.
 *
 * Supported `animation` values: 'bounce' | 'fade' | 'typewriter' | 'none'.
 * Falls back to plain text if value is unknown — never blocks render.
 */
import { useEffect, useRef, useState } from 'react';
import { Animated, Dimensions, Easing, StyleSheet, Text, View } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect as SvgRect } from 'react-native-svg';
// [2026-06-10 tela-branca fix] The composer persists gradient presets as a
// `gradient:<id>` token in bg_color. Passing that token straight into
// `backgroundColor` is an INVALID color → the card lost its background and
// every white-on-color element dissolved into a blank/white screen. Resolve
// the token to real stops via the shared preset map (single source of truth).
import { resolveTextGradient as _resolveGradient } from './textGradients';
// [status-texto 2026-10-14] fonte/auto-ajuste/links compartilhados com o compositor.
import { textStatusFontStyle, autoFitFontSize, splitLinks, openTextStatusLink } from './textStatus';

// Any other non-paintable string (unknown token, empty, etc.) must never
// reach backgroundColor raw — fall back to the brand purple.
function _safeSolid(bgColor) {
  if (typeof bgColor === 'string' && /^(#|rgb|hsl)/i.test(bgColor.trim())) return bgColor;
  return '#111111';
}

const TEXT_BASE = {
  color: '#fff',
  textAlign: 'center',
  paddingHorizontal: 24,
};

export default function AnimatedStatusText({
  text = '',
  bgColor = '#111111',
  animation = 'none',
  fontStyle = 'normal',
  // [status-texto 2026-10-16] meta.text_align ('left'|'center'|'right').
  textAlign = 'center',
  // Reset the animation whenever this key changes (e.g. status id).
  animKey = 0,
}) {
  // Bounce uses scale; fade uses opacity; typewriter uses substring length.
  const scale = useRef(new Animated.Value(animation === 'bounce' ? 0.4 : 1)).current;
  const opacity = useRef(new Animated.Value(animation === 'fade' ? 0 : 1)).current;
  const [typedLen, setTypedLen] = useState(
    animation === 'typewriter' ? 0 : text.length
  );

  useEffect(() => {
    // Reset values at the start of each run
    scale.setValue(animation === 'bounce' ? 0.4 : 1);
    opacity.setValue(animation === 'fade' ? 0 : 1);

    if (animation === 'bounce') {
      Animated.spring(scale, {
        toValue: 1,
        friction: 4,      // bounce-y
        tension: 90,
        useNativeDriver: true,
      }).start();
    } else if (animation === 'fade') {
      Animated.timing(opacity, {
        toValue: 1,
        duration: 900,
        easing: Easing.out(Easing.ease),
        useNativeDriver: true,
      }).start();
    } else if (animation === 'typewriter') {
      setTypedLen(0);
      // Type one char every ~45ms — feels like a natural typing cadence
      // without overstaying its welcome on longer statuses.
      const total = text.length;
      const step = Math.max(20, Math.min(60, Math.floor(2500 / Math.max(total, 1))));
      let i = 0;
      const iv = setInterval(() => {
        i += 1;
        setTypedLen(i);
        if (i >= total) clearInterval(iv);
      }, step);
      return () => clearInterval(iv);
    }
    return undefined;
  }, [animKey, animation, text]);

  // [status-texto 2026-10-14] auto-ajuste pelo tamanho REAL do card (mesma
  // conta do compositor) — texto curto grande, texto longo menor, sempre cabe.
  const [box, setBox] = useState(() => { const w = Dimensions.get('window'); return { w: w.width, h: w.height * 0.8 }; });
  const fs = autoFitFontSize(text, { width: box.w, height: box.h, max: 44, min: 14, font: fontStyle });
  const display = animation === 'typewriter' ? text.slice(0, typedLen) : text;
  const parts = splitLinks(display);
  const caret = animation === 'typewriter' && typedLen < text.length ? '▌' : '';

  const grad = _resolveGradient(bgColor);
  return (
    <View
      style={[styles.card, { backgroundColor: grad ? grad.colors[grad.colors.length - 1] : _safeSolid(bgColor) }]}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout || {};
        if (width > 0 && height > 0 && (Math.abs(width - box.w) > 2 || Math.abs(height - box.h) > 2)) setBox({ w: width, h: height });
      }}
    >
      {grad ? (
        <Svg
          pointerEvents="none"
          style={StyleSheet.absoluteFill}
          // [2026-10-10 qa-sweep] Web: <svg> absoluto SEM height explícito usa a
          // proporção do viewBox (1:1) → gradiente só num quadrado no topo e o
          // resto do status numa cor chapada. 100%/100% estica no card todo.
          width="100%"
          height="100%"
          preserveAspectRatio="none"
          viewBox="0 0 1 1"
        >
          <Defs>
            <SvgLinearGradient id={`astGrad_${grad.id}`} x1="0" y1="0" x2="1" y2="1">
              {grad.colors.map((c, i) => (
                <Stop key={i} offset={`${Math.round((i / (grad.colors.length - 1)) * 100)}%`} stopColor={c} stopOpacity="1" />
              ))}
            </SvgLinearGradient>
          </Defs>
          <SvgRect x="0" y="0" width="1" height="1" fill={`url(#astGrad_${grad.id})`} />
        </Svg>
      ) : null}
      <Animated.Text
        style={[
          TEXT_BASE,
          { fontSize: fs, lineHeight: Math.round(fs * 1.25) },
          textStatusFontStyle(fontStyle),
          textAlign === 'left' || textAlign === 'right' ? { textAlign, alignSelf: 'stretch' } : null,
          { transform: [{ scale }], opacity },
        ]}
      >
        {parts.map((p, i) => (p.url ? (
          <Text key={i} style={{ textDecorationLine: 'underline' }} onPress={() => openTextStatusLink(p.url)} accessibilityRole="link" suppressHighlighting>{p.text}</Text>
        ) : p.text))}
        {caret ? <Text style={{ opacity: 0.6 }}>{caret}</Text> : null}
      </Animated.Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flex: 1,
    width: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
