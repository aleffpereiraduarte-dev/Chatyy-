// components/wallpaper/ChatWallpaper.js — [2026-10-15 native-wallpaper]
//
// Renderizador ÚNICO do fundo da conversa (conversa, miniaturas do seletor e
// prévia em tela cheia):
//   • valores antigos ('#cor' / 'grad:' / foto pura) → WallpaperBackground JS,
//     EXATAMENTE como antes (mesma opacidade, mesmo componente);
//   • valores 'wp2:' (temas animados, foto c/ desfoque/paralaxe) → view NATIVA
//     ChatyyWallpaper (modules/expo-chat-wallpaper) quando disponível;
//     senão (web, binário antigo, kill switch __chatyy_native_wallpaper=false)
//     → fallback SVG/expo-image estático aqui embaixo.
//
// Animação do gradiente: `pulseKey` mudou (mensagem nova/enviada) → 1 passo;
// rolagem → notifyWallpaperScroll(y) (acumula ~420 pt → 1 passo).
import React, { useEffect, useMemo, useRef } from 'react';
import { View, StyleSheet, Platform } from 'react-native';
import Svg, { Defs, RadialGradient, Stop, Rect, Pattern, G, Path } from 'react-native-svg';
import { resolve, averageColor, GRADIENT_POSITIONS } from './wallpaperSpec';
import { getWallpaperView } from '../../modules/expo-chat-wallpaper';

let _WpExpoImage = null;
try { _WpExpoImage = require('expo-image').Image; } catch {}

export function nativeWallpaperOn() {
  try { if (globalThis.__chatyy_native_wallpaper === false) return false; } catch {}
  return !!getWallpaperView();
}

// ── rolagem → passos do gradiente (todas as instâncias montadas na conversa) ──
const _live = new Set();
let _lastY = null;
let _acc = 0;
export function notifyWallpaperScroll(y) {
  if (!_live.size || typeof y !== 'number' || !isFinite(y)) return;
  if (_lastY != null) _acc += Math.abs(y - _lastY);
  _lastY = y;
  if (_acc < 420) return;
  _acc = 0;
  _live.forEach((ref) => { try { ref.current && ref.current.step && ref.current.step(); } catch {} });
}

let _uid = 0;

// ── fallback JS (SVG) p/ valores v2 sem a view nativa ─────────────────────────
function FallbackWallpaper({ r, patternScale = 1, style }) {
  const id = useMemo(() => `cwp${++_uid}`, []);
  const isMask = r.patternMode === 'mask';
  const cols = r.colors || [];
  const pat = r.pattern;
  const sc = patternScale || 1;
  const T = pat ? pat.tile * sc : 0;
  const strokeCol = isMask ? averageColor(cols) : r.patternColor;
  const strokeOp = r.patternIntensity || 0;
  const tileItems = useMemo(() => {
    if (!pat) return [];
    const out = [];
    pat.items.forEach((it, i) => {
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const cx = it.x + ox * pat.tile; const cy = it.y + oy * pat.tile;
          const reach = 18 * it.s;
          if (cx < -reach || cy < -reach || cx > pat.tile + reach || cy > pat.tile + reach) continue;
          out.push({ k: `${i}_${ox}_${oy}`, d: it.d, tf: `translate(${cx * sc} ${cy * sc}) rotate(${it.r}) scale(${it.s * sc}) translate(-12 -12)`, sw: pat.stroke / it.s });
        }
      }
    });
    return out;
  }, [pat, sc]);
  const img = r.imageUri ? r.imageUri : '';
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: r.baseColor || 'transparent', overflow: 'hidden' }, style]} pointerEvents="none">
      {!!img && _WpExpoImage ? (
        <_WpExpoImage source={{ uri: img }} style={StyleSheet.absoluteFill} contentFit="cover" cachePolicy="memory-disk" transition={0} blurRadius={r.blur ? Math.round(r.blur / 2) : 0} />
      ) : null}
      {(cols.length > 0 && !isMask) || pat ? (
        <Svg style={StyleSheet.absoluteFill} width="100%" height="100%">
          <Defs>
            {!isMask && cols.length > 1 ? cols.map((c, i) => {
              const p = GRADIENT_POSITIONS[(i * 2) % 8];
              return (
                <RadialGradient key={i} id={`${id}g${i}`} cx={String(p[0])} cy={String(p[1])} r="0.75" fx={String(p[0])} fy={String(p[1])}>
                  <Stop offset="0" stopColor={c} stopOpacity="1" />
                  <Stop offset="1" stopColor={c} stopOpacity="0" />
                </RadialGradient>
              );
            }) : null}
            {pat && T > 0 ? (
              <Pattern id={`${id}p`} patternUnits="userSpaceOnUse" x="0" y="0" width={T} height={T}>
                <G fill="none" stroke={strokeCol} strokeOpacity={strokeOp} strokeLinecap="round" strokeLinejoin="round">
                  {tileItems.map((t) => <Path key={t.k} d={t.d} transform={t.tf} strokeWidth={t.sw} />)}
                </G>
              </Pattern>
            ) : null}
          </Defs>
          {!isMask && cols.length > 0 ? <Rect x="0" y="0" width="100%" height="100%" fill={cols.length > 1 ? averageColor(cols) : cols[0]} /> : null}
          {!isMask && cols.length > 1 ? cols.map((c, i) => <Rect key={i} x="0" y="0" width="100%" height="100%" fill={`url(#${id}g${i})`} />) : null}
          {pat && T > 0 ? <Rect x="0" y="0" width="100%" height="100%" fill={`url(#${id}p)`} /> : null}
        </Svg>
      ) : null}
      {r.dim > 0 ? <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000', opacity: r.dim }]} /> : null}
    </View>
  );
}

/**
 * value     valor sincronizado (antigo ou 'wp2:')
 * isDark    modo atual
 * preview   miniatura/prévia: valores antigos em força total (igual ao seletor antigo)
 * pulseKey  muda quando chega/sai mensagem → 1 passo do gradiente
 * autoplay  ms entre passos (miniaturas animadas do seletor); 0 = parado
 * patternScale escala do padrão (miniaturas usam ~0,5)
 * motion    força paralaxe off (false) nas miniaturas
 */
function ChatWallpaper({ value, isDark, preview = false, style, pulseKey, autoplay = 0, patternScale = 1, motion, animate = true }) {
  const r = useMemo(() => resolve(value, isDark), [value, isDark]);
  const ref = useRef(null);
  const NativeView = r.kind === 'native' && Platform.OS !== 'web' && nativeWallpaperOn() ? getWallpaperView() : null;
  // prop do padrão com identidade estável (o pai re-renderiza muito; não reenviar 25 paths)
  const patternProp = useMemo(() => (r.pattern ? { key: r.pattern.key || '', tile: r.pattern.tile, stroke: r.pattern.stroke, items: r.pattern.items } : null), [r]);

  // registra p/ os passos de rolagem (só o fundo da conversa, não as miniaturas)
  useEffect(() => {
    if (!NativeView || preview) return undefined;
    _live.add(ref);
    return () => { _live.delete(ref); if (!_live.size) { _lastY = null; _acc = 0; } };
  }, [NativeView, preview]);

  // mensagem chegou/saiu → 1 passo (ignora a 1ª chave e os primeiros 1,2 s da abertura)
  const pulseRef = useRef({ key: undefined, at: Date.now() });
  useEffect(() => {
    const p = pulseRef.current;
    const prev = p.key;
    p.key = pulseKey;
    if (prev === undefined || pulseKey === prev || !pulseKey) return;
    if (Date.now() - p.at < 1200) return;
    try { ref.current && ref.current.step && ref.current.step(); } catch {}
  }, [pulseKey]);

  if (r.kind === 'none') {
    if (!preview) return null;
    // eslint-disable-next-line global-require
    const { WallpaperBackground } = require('../WallpaperPicker');
    return <WallpaperBackground value="none" isDark={isDark} preview style={style} />;
  }
  if (r.kind === 'legacy') {
    // eslint-disable-next-line global-require
    const { WallpaperBackground } = require('../WallpaperPicker');
    return <WallpaperBackground value={r.value} isDark={isDark} preview={preview} style={style} />;
  }
  if (NativeView) {
    return (
      <NativeView
        ref={ref}
        pointerEvents="none"
        style={[preview ? { flex: 1 } : StyleSheet.absoluteFill, style]}
        colors={r.colors}
        baseColor={r.baseColor}
        pattern={patternProp}
        patternIntensity={r.patternIntensity}
        patternMode={r.patternMode}
        patternColor={r.patternColor}
        patternScale={patternScale}
        imageUri={r.imageUri || ''}
        blur={r.blur || 0}
        dim={r.dim || 0}
        motion={motion === false ? false : !!r.motion}
        animate={animate && r.animate !== false}
        autoplay={autoplay || 0}
      />
    );
  }
  return <FallbackWallpaper r={r} patternScale={patternScale} style={preview ? { position: 'relative', flex: 1 } : null} />;
}

export default React.memo(ChatWallpaper);
