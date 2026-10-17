// [2026-10-15 nav-motion] RollingNumber — contador "odômetro" (Telegram):
// cada dígito é uma coluna 0…9 recortada que ROLA (spring nativo) até o novo
// valor quando o número muda. Usado em contadores pequenos (badges de filtro,
// totais). Valores não numéricos ("99+", "1,2 mil") rolam só os dígitos; os
// outros caracteres ficam estáticos.
//
//   <RollingNumber value={count > 99 ? '99+' : count} style={textStyle} />
//
// - 1º render: já nasce no valor (sem animação).
// - Reduce Motion: troca seca.
// - RN Animated puro (transform translateY, useNativeDriver no nativo) → OTA.
// - Colunas indexadas da DIREITA p/ a esquerda: 9 → 10 mantém a coluna das
//   unidades (rola 9→0) e a dezena nova entra rolando de 0.
import React, { useEffect, useRef } from 'react';
import { Animated, PixelRatio, Platform, StyleSheet, Text, View } from 'react-native';
import { isReduceMotionEnabled } from './reducedMotion';
import { Springs, motionEnabled } from '../constants/motion';

const DIGITS = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const NATIVE = Platform.OS !== 'web';

function DigitColumn({ digit, lineHeight, rowH, textStyle, maxFontSizeMultiplier }) {
  const anim = useRef(new Animated.Value(-digit * rowH)).current;
  const first = useRef(true);
  useEffect(() => {
    const to = -digit * rowH;
    if (first.current) { first.current = false; anim.setValue(to); return; }
    if (isReduceMotionEnabled() || !motionEnabled()) { anim.setValue(to); return; }
    Animated.spring(anim, { toValue: to, useNativeDriver: NATIVE, ...Springs.digit }).start();
  }, [digit, rowH, anim]);
  return (
    <View style={{ height: rowH, overflow: 'hidden' }}>
      <Animated.View style={{ transform: [{ translateY: anim }] }}>
        {DIGITS.map((d) => (
          <Text key={d} style={[textStyle, { height: rowH, lineHeight }]} maxFontSizeMultiplier={maxFontSizeMultiplier}>{d}</Text>
        ))}
      </Animated.View>
    </View>
  );
}

export default function RollingNumber({ value, style, maxFontSizeMultiplier, accessibilityLabel }) {
  const str = value == null ? '' : String(value);
  const flat = StyleSheet.flatten(style) || {};
  const fontSize = flat.fontSize || 14;
  const lineHeight = Math.ceil(flat.lineHeight || fontSize * 1.25);
  // O RN escala fontSize/lineHeight com o "tamanho do texto" do sistema (até
  // maxFontSizeMultiplier) — a janela de recorte acompanha (height NÃO escala).
  let fs = 1;
  try { fs = PixelRatio.getFontScale() || 1; } catch {}
  if (maxFontSizeMultiplier && maxFontSizeMultiplier >= 1) fs = Math.min(fs, maxFontSizeMultiplier);
  const rowH = Math.ceil(lineHeight * Math.max(1, fs));
  const textStyle = [style, { fontVariant: ['tabular-nums'] }];
  const chars = str.split('');
  const n = chars.length;
  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'flex-start' }}
      accessible
      accessibilityLabel={accessibilityLabel || str}
    >
      {chars.map((ch, i) => {
        const key = `p${n - i}`; // posição a partir da direita
        const d = DIGITS.indexOf(ch);
        if (d < 0) {
          return <Text key={key + ch} style={[textStyle, { height: rowH, lineHeight }]} maxFontSizeMultiplier={maxFontSizeMultiplier}>{ch}</Text>;
        }
        return <DigitColumn key={key} digit={d} lineHeight={lineHeight} rowH={rowH} textStyle={textStyle} maxFontSizeMultiplier={maxFontSizeMultiplier} />;
      })}
    </View>
  );
}
