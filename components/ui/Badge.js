// Badge — contador / ponto / rótulo. P&B por padrão (tinta invertida no
// escuro); cor só p/ estado.
//   <Badge count={3} />                 // pílula numérica (99+)
//   <Badge dot />                       // ponto 8px (não lido sem número)
//   <Badge label="Novo" tone="neutral"/>// rótulo pequeno
//   tone: 'ink' (default) | 'neutral' (cinza) | 'danger' | 'success' | 'muted'
//   ring: cor do anel (p/ cortar ícone/avatar por baixo), ex. a cor da barra.
import React, { useEffect, useRef } from 'react';
import { Animated, Platform, Text, View } from 'react-native';
import RollingNumber from '../RollingNumber';
import { isReduceMotionEnabled } from '../reducedMotion';

// [2026-10-16 motion-telegram] Contador vivo (Telegram): quando o número SOBE
// com o badge já na tela, a pílula dá um "pop" (mola nativa 1.18→1) e os
// dígitos rolam (RollingNumber). 1º render / Reduzir Movimento / web = seco.
// Kill switch OTA: globalThis.__chatyy_badge_motion = false.
const NATIVE = Platform.OS !== 'web';
function motionOn() {
  if (!NATIVE || isReduceMotionEnabled()) return false;
  try { if (globalThis.__chatyy_badge_motion === false) return false; } catch {}
  return true;
}
import { Radius } from '../../constants/theme';
import useSurface from './useSurface';

function tones(s, tone) {
  switch (tone) {
    case 'neutral': return { bg: s.fill, fg: s.text };
    case 'muted': return { bg: s.fill, fg: s.textSecondary };
    case 'danger': return { bg: s.danger, fg: '#FFFFFF' };
    case 'success': return { bg: s.success, fg: '#FFFFFF' };
    default: return { bg: s.ink, fg: s.onInk };
  }
}

export default function Badge({ count, dot = false, label, tone = 'ink', ring, max = 99, style, textStyle, accessibilityLabel }) {
  const s = useSurface();
  const t = tones(s, tone);
  const ringStyle = ring ? { borderWidth: 2, borderColor: ring } : null;
  if (dot) {
    return <View accessibilityLabel={accessibilityLabel} style={[{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.bg }, ringStyle, style]} />;
  }
  let text = label;
  if (text == null) {
    const n = Number(count) || 0;
    if (n <= 0) return null;
    text = n > max ? `${max}+` : String(n);
  }
  const isLabel = label != null;
  const live = !isLabel && motionOn();
  const txtStyle = [{ fontSize: isLabel ? 11 : 12, lineHeight: 14, fontWeight: isLabel ? '600' : '700', color: t.fg, fontVariant: ['tabular-nums'] }, textStyle];
  return (
    <BadgePop
      count={isLabel ? null : Number(count) || 0}
      live={live}
      accessibilityLabel={accessibilityLabel}
      style={[{
        minWidth: 20, height: 20, paddingHorizontal: isLabel ? 8 : 6,
        borderRadius: Radius.pill, backgroundColor: t.bg,
        alignItems: 'center', justifyContent: 'center',
      }, ringStyle, style]}
    >
      {live ? (
        <RollingNumber value={text} style={txtStyle} maxFontSizeMultiplier={1.2} accessibilityLabel={accessibilityLabel || text} />
      ) : (
        <Text numberOfLines={1} maxFontSizeMultiplier={1.2} style={txtStyle}>
          {text}
        </Text>
      )}
    </BadgePop>
  );
}

function BadgePop({ count, live, style, accessibilityLabel, children }) {
  const scale = useRef(new Animated.Value(1)).current;
  const prev = useRef(count);
  useEffect(() => {
    const was = prev.current;
    prev.current = count;
    if (!live || count == null || was == null || !(count > was)) return;
    scale.stopAnimation();
    scale.setValue(1.18);
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, tension: 340, friction: 11 }).start();
  }, [count, live, scale]);
  if (!live) return <View accessibilityLabel={accessibilityLabel} style={style}>{children}</View>;
  return <Animated.View accessibilityLabel={accessibilityLabel} style={[style, { transform: [{ scale }] }]}>{children}</Animated.View>;
}
