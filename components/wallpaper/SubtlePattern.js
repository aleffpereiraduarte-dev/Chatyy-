// components/wallpaper/SubtlePattern.js — [2026-10-18 tg-look]
//
// Fundo PADRÃO da conversa (valor 'none'): o fundo liso de sempre + o padrão
// de rabiscos monocromático (mesmos glifos do wallpaperSpec 'doodles') em
// opacidade muito baixa — o "papel" do Telegram, em P&B. Só traço, sem cor:
// preto a ~3% no claro, branco a ~4% no escuro. SVG estático (desenha 1×,
// não anima, pointerEvents none) — serve web, iOS e Android (OTA, sem nativo).
// Desligar (OTA): globalThis.__chatyy_wp_subtle = false → volta ao liso.
import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import Svg, { Defs, Pattern, G, Path, Rect, Circle } from 'react-native-svg';
import { patternById } from './wallpaperSpec';
import { THEME_V2, grafite } from '../../constants/theme';

export function subtlePatternOn() {
  try { return globalThis.__chatyy_wp_subtle !== false; } catch { return true; }
}

let _uid = 0;
const SCALE = 0.82; // azulejo 300 → ~246 pt: glifos ~20 pt, discretos

function SubtlePattern({ isDark, style }) {
  const id = useMemo(() => `cwsp${++_uid}`, []);
  const pat = patternById('doodles');
  const items = useMemo(() => {
    if (!pat) return [];
    const out = [];
    pat.items.forEach((it, i) => {
      // cópias vizinhas só quando o glifo cruza a borda do azulejo (emenda)
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cx = it.x + ox * pat.tile; const cy = it.y + oy * pat.tile;
          const reach = 18 * it.s;
          if (cx < -reach || cy < -reach || cx > pat.tile + reach || cy > pat.tile + reach) continue;
          out.push({
            k: `${i}_${ox}_${oy}`, d: it.d,
            tf: `translate(${(cx * SCALE).toFixed(1)} ${(cy * SCALE).toFixed(1)}) rotate(${it.r}) scale(${(it.s * SCALE).toFixed(3)}) translate(-12 -12)`,
            sw: +(1.35 / it.s).toFixed(3),
          });
        }
      }
    });
    return out;
  }, [pat]);
  // [2026-10-20 grafite] tema v2: papel de parede PADRÃO = pontos de 18 px
  // (rgba(24,24,27,.07) no claro / branco 5% no escuro) sobre #EDEDEA/#0E0E10.
  // Só o padrão ('none'); papéis escolhidos pelo usuário não passam por aqui.
  if (THEME_V2) {
    const g = grafite(isDark);
    const S = g.wallDotSpacing;
    return (
      <View style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs>
            <Pattern id={id} patternUnits="userSpaceOnUse" x="0" y="0" width={S} height={S}>
              <Circle cx={S / 2} cy={S / 2} r={1.05} fill={g.wallDot} />
            </Pattern>
          </Defs>
          <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
        </Svg>
      </View>
    );
  }
  if (!pat || !items.length) return null;
  const T = pat.tile * SCALE;
  const stroke = isDark ? '#FFFFFF' : '#000000';
  const op = isDark ? 0.038 : 0.032;
  return (
    <View style={[StyleSheet.absoluteFill, style]} pointerEvents="none">
      <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
        <Defs>
          <Pattern id={id} patternUnits="userSpaceOnUse" x="0" y="0" width={T} height={T}>
            <G fill="none" stroke={stroke} strokeOpacity={op} strokeLinecap="round" strokeLinejoin="round">
              {items.map((t) => <Path key={t.k} d={t.d} transform={t.tf} strokeWidth={t.sw} />)}
            </G>
          </Pattern>
        </Defs>
        <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
      </Svg>
    </View>
  );
}

export default React.memo(SubtlePattern);
