// components/chatlist/listVivo.js — [2026-10-21 lista-viva]
//
// Peças visuais da "lista viva" (mockup aprovado preview-2026/lista.html) para a
// linha JS da lista de conversas (web / reserva do nativo), o carrossel do topo
// e os anéis de status:
//   VivoOnlineDot   ponto verde #2FB36B com halo pulsando (2 s)
//   VivoTyping      "digitando" + 3 pontinhos / "gravando áudio" + ondinha
//   PopBadge        contador que dá "pop" (0,3 → 1, mola 0,5 s) quando SOBE
//   MentionSeal     selo @ (círculo cinza-claro)
//   RowThumb        miniatura 40×40 raio 10 da última foto/vídeo
//   VivoSpinRing    anel prateado cônico girando devagar (6 s/volta)
//   VivoEnter       entrada leve das linhas ao abrir a lista (sobe 10 px + fade)
//
// Nativo: Reanimated na UI thread (zero re-render). Web: laços infinitos em CSS
// (o Reanimated no web roda no JS a cada quadro). Reduzir Movimento → tudo
// parado. Kill switch: globalThis.__chatyy_list_vivo = false (listVivoOn()).
import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Platform, StyleSheet } from 'react-native';
import Animated, {
  useSharedValue, useAnimatedStyle, withRepeat, withTiming, withDelay, cancelAnimation, Easing,
} from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useReducedMotion, isReduceMotionEnabled } from '../reducedMotion';
import { Grafite, detailRing } from '../../constants/theme';
import { VIVO_ONLINE, listVivoOn } from './listVivoData';

export { listVivoOn, VIVO_ONLINE } from './listVivoData';

const WEB = Platform.OS === 'web';

/** Laço 0→1 infinito na UI thread; para (0) com Reduzir Movimento / inativo. */
function useLoop(duration, active, easing) {
  const p = useSharedValue(0);
  useEffect(() => {
    if (!active || WEB) { cancelAnimation(p); p.value = 0; return undefined; }
    p.value = 0;
    p.value = withRepeat(withTiming(1, { duration, easing: easing || Easing.linear }), -1, false);
    return () => cancelAnimation(p);
  }, [active, duration, easing, p]);
  return p;
}

// ── ponto online ─────────────────────────────────────────────────────────────
// 15 pt, borda 2,5 na cor do fundo da linha; halo = aro verde 2 pt que cresce
// 0,8 → 1,7 e some (ease-out 2 s), igual ao CSS do mockup.
const _ONLINE_HALO_KF = [{ '0%': { transform: 'scale(0.8)', opacity: 0.7 }, '100%': { transform: 'scale(1.7)', opacity: 0 } }];
const _EASE_OUT = Easing.out(Easing.quad);
export const VivoOnlineDot = memo(function VivoOnlineDot({ borderColor, size = 15, style }) {
  const reduce = useReducedMotion();
  const p = useLoop(2000, !reduce, _EASE_OUT);
  const halo = useAnimatedStyle(() => ({ opacity: 0.7 * (1 - p.value), transform: [{ scale: 0.8 + 0.9 * p.value }] }));
  const hs = size + 6;
  const haloBase = { position: 'absolute', left: -3, top: -3, width: hs, height: hs, borderRadius: hs / 2, borderWidth: 2, borderColor: VIVO_ONLINE };
  return (
    <View pointerEvents="none" style={[vs.dotWrap, { width: size, height: size }, style]}>
      {reduce ? null : WEB ? (
        <View style={[haloBase, { opacity: 0, animationKeyframes: _ONLINE_HALO_KF, animationDuration: '2000ms', animationIterationCount: 'infinite', animationTimingFunction: 'ease-out' }]} />
      ) : (
        <Animated.View style={[haloBase, halo]} />
      )}
      <View style={{ width: size, height: size, borderRadius: size / 2, backgroundColor: VIVO_ONLINE, borderWidth: 2.5, borderColor: borderColor || '#F2F2EF' }} />
    </View>
  );
});

// ── digitando: 3 pontinhos ───────────────────────────────────────────────────
// 1,2 s; cada ponto sobe 2 pt e acende entre 0 e 30% (atrasos 0 / 150 / 300 ms).
const _DOT_KF = [{ '0%': { opacity: 0.25, transform: 'translateY(0px)' }, '30%': { opacity: 1, transform: 'translateY(-2px)' }, '60%': { opacity: 0.25, transform: 'translateY(0px)' }, '100%': { opacity: 0.25, transform: 'translateY(0px)' } }];
function _Dot({ p, delay, color }) {
  const st = useAnimatedStyle(() => {
    let x = p.value - delay;
    if (x < 0) x += 1;
    let k = 0;
    if (x < 0.3) k = x / 0.3; else if (x < 0.6) k = 1 - (x - 0.3) / 0.3;
    return { opacity: 0.25 + 0.75 * k, transform: [{ translateY: -2 * k }] };
  });
  return <Animated.View style={[vs.dot, { backgroundColor: color }, st]} />;
}
const TypingDots = memo(function TypingDots({ color }) {
  const reduce = useReducedMotion();
  const p = useLoop(1200, !reduce);
  if (reduce) return <View style={vs.dots}>{[0, 1, 2].map(i => <View key={i} style={[vs.dot, { backgroundColor: color, opacity: 0.6 }]} />)}</View>;
  if (WEB) {
    return (
      <View style={vs.dots}>
        {[0, 150, 300].map(d => (
          <View key={d} style={[vs.dot, { backgroundColor: color, opacity: 0.25, animationKeyframes: _DOT_KF, animationDuration: '1200ms', animationDelay: `${d}ms`, animationIterationCount: 'infinite' }]} />
        ))}
      </View>
    );
  }
  return <View style={vs.dots}>{[0, 0.125, 0.25].map(d => <_Dot key={d} p={p} delay={d} color={color} />)}</View>;
});

// ── gravando áudio: ondinha de 5 barras ──────────────────────────────────────
const _BARS = [6, 12, 8, 13, 5];
const _WAVE_KF = [{ '0%': { transform: 'scaleY(1)' }, '50%': { transform: 'scaleY(0.4)' }, '100%': { transform: 'scaleY(1)' } }];
function _Bar({ p, delay, h, color }) {
  const st = useAnimatedStyle(() => {
    let x = p.value - delay;
    if (x < 0) x += 1;
    const k = 0.5 - 0.5 * Math.cos(2 * Math.PI * x); // ease-in-out 1 → 0,4 → 1
    return { transform: [{ scaleY: 1 - 0.6 * k }] };
  });
  return <Animated.View style={[vs.bar, { height: h, backgroundColor: color }, st]} />;
}
const RecordingWave = memo(function RecordingWave({ color }) {
  const reduce = useReducedMotion();
  const p = useLoop(1000, !reduce);
  if (reduce) return <View style={vs.wave}>{_BARS.map((h, i) => <View key={i} style={[vs.bar, { height: h, backgroundColor: color }]} />)}</View>;
  if (WEB) {
    return (
      <View style={vs.wave}>
        {_BARS.map((h, i) => (
          <View key={i} style={[vs.bar, { height: h, backgroundColor: color, animationKeyframes: _WAVE_KF, animationDuration: '1000ms', animationDelay: `${i * 100}ms`, animationIterationCount: 'infinite', animationTimingFunction: 'ease-in-out' }]} />
        ))}
      </View>
    );
  }
  return <View style={vs.wave}>{_BARS.map((h, i) => <_Bar key={i} p={p} delay={i * 0.1} h={h} color={color} />)}</View>;
});

/** Prévia ao vivo: "digitando" + pontinhos ou "gravando áudio" + ondinha (cor do texto). */
export const VivoTyping = memo(function VivoTyping({ label, recording, color, textStyle }) {
  const clean = String(label || '').replace(/[\s.…]+$/, '');
  return (
    <View style={vs.typingRow}>
      <Text style={[textStyle, { color, flex: 0, flexShrink: 1, marginRight: 0 }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{clean}</Text>
      {recording ? <RecordingWave color={color} /> : <TypingDots color={color} />}
    </View>
  );
});

// ── contador com "pop" ───────────────────────────────────────────────────────
// Só quando o número SOBE na MESMA conversa (rowKey igual) — linha reciclada
// pela FlashList ou leitura (descer) não animam.
const _POP_EASE = Easing.bezier(0.3, 1.6, 0.5, 1);
export function PopBadge({ value, rowKey, style, children }) {
  const sc = useSharedValue(1);
  const prev = useRef({ v: Number(value) || 0, k: rowKey });
  useEffect(() => {
    const v = Number(value) || 0;
    const was = prev.current;
    prev.current = { v, k: rowKey };
    if (was.k !== rowKey || !(v > was.v) || isReduceMotionEnabled()) return;
    sc.value = 0.3;
    sc.value = withTiming(1, { duration: 500, easing: _POP_EASE });
  }, [value, rowKey, sc]);
  const st = useAnimatedStyle(() => ({ transform: [{ scale: sc.value }] }));
  return <Animated.View style={[style, st]}>{children}</Animated.View>;
}

// ── selo @ ───────────────────────────────────────────────────────────────────
// [2026-10-21 pitada-azul] bg/fg opcionais = cor dos detalhes (null = selo cinza de antes).
export const MentionSeal = memo(function MentionSeal({ isDark, bg = null, fg = null }) {
  const g = isDark ? Grafite.dark : Grafite.light;
  return (
    <View style={[vs.mention, { backgroundColor: bg || g.surface2 }]} accessibilityElementsHidden importantForAccessibility="no">
      <Text maxFontSizeMultiplier={1.15} style={[vs.mentionText, { color: bg ? (fg || '#FFFFFF') : g.text }]}>@</Text>
    </View>
  );
});

// ── miniatura da última foto/vídeo ───────────────────────────────────────────
let _FastImage = null;
function _img() {
  if (_FastImage === null) { try { _FastImage = require('../FastImage').default || false; } catch { _FastImage = false; } }
  return _FastImage || null;
}
function _PlayGlyph() {
  return (
    <View pointerEvents="none" style={vs.play}>
      <Svg width={10} height={10} viewBox="0 0 24 24"><Path d="M8 5.5v13l10.5-6.5z" fill="#FFFFFF" /></Svg>
    </View>
  );
}
export const RowThumb = memo(function RowThumb({ uri, kind, isDark, rowKey }) {
  const [failed, setFailed] = useState(false);
  const lastUri = useRef(uri);
  if (lastUri.current !== uri) { lastUri.current = uri; if (failed) setFailed(false); }
  const Img = _img();
  const bg = isDark ? Grafite.dark.surface2 : Grafite.light.surface2;
  return (
    <View style={[vs.thumb, { backgroundColor: bg }]} accessibilityElementsHidden importantForAccessibility="no">
      {uri && !failed && Img ? (
        <Img source={{ uri }} style={vs.thumbImg} resizeMode="cover" recyclingKey={String(rowKey || uri)} onError={() => setFailed(true)} />
      ) : null}
      {kind === 'video' ? <_PlayGlyph /> : null}
    </View>
  );
});

// ── anel prateado cônico girando ─────────────────────────────────────────────
// Paradas do mockup (#d9d9d6 #6b6b70 #f4f4f2 #3a3a3f #d9d9d6) em 36 arcos SVG
// (= conic-gradient); a camada do anel gira 6 s/volta, o avatar fica parado.
const _SILVER = ['#D9D9D6', '#6B6B70', '#F4F4F2', '#3A3A3F', '#D9D9D6'];
function _hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function _mix(a, b, k) {
  const A = _hex(a); const B = _hex(b);
  const c = A.map((x, i) => Math.round(x + (B[i] - x) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
const _arcCache = new Map();
// [2026-10-21 pitada-azul] stops opcionais (anel NÃO visto azul claro → azul
// mais escuro → volta, p/ o giro não ter "emenda"); sem stops = prateado de antes.
function _arcs(size, stroke, n = 36, stops = null) {
  const ST = stops && stops.length >= 2 ? stops : _SILVER;
  const key = `${size}|${stroke}|${stops ? ST.join(',') : ''}`;
  const hit = _arcCache.get(key);
  if (hit) return hit;
  const r = size / 2 - stroke / 2; const cx = size / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = (i + 0.5) / n;
    const seg = k * (ST.length - 1);
    const j = Math.min(ST.length - 2, Math.floor(seg));
    const color = _mix(ST[j], ST[j + 1], seg - j);
    const a0 = ((i / n) * 360 - 90) * Math.PI / 180;
    const a1 = (((i + 1) / n) * 360 + 0.6 - 90) * Math.PI / 180;
    out.push({
      d: `M${(cx + r * Math.cos(a0)).toFixed(2)} ${(cx + r * Math.sin(a0)).toFixed(2)} A${r} ${r} 0 0 1 ${(cx + r * Math.cos(a1)).toFixed(2)} ${(cx + r * Math.sin(a1)).toFixed(2)}`,
      color,
    });
  }
  _arcCache.set(key, out);
  return out;
}
const _SPIN_KF = [{ '0%': { transform: 'rotate(0deg)' }, '100%': { transform: 'rotate(360deg)' } }];
export const VivoSpinRing = memo(function VivoSpinRing({ size, stroke = 2.5, style, isDark }) {
  const reduce = useReducedMotion();
  const p = useLoop(6000, !reduce);
  const st = useAnimatedStyle(() => ({ transform: [{ rotate: `${p.value * 360}deg` }] }));
  const _dr = detailRing(!!isDark);
  const _dk = _dr ? _dr.join(',') : '';
  const arcs = useMemo(() => _arcs(size, stroke, 36, _dr ? [_dr[0], _dr[1], _dr[0]] : null), [size, stroke, _dk]); // eslint-disable-line react-hooks/exhaustive-deps
  const svg = (
    <Svg width={size} height={size}>
      {arcs.map((a, i) => <Path key={i} d={a.d} stroke={a.color} strokeWidth={stroke} fill="none" />)}
    </Svg>
  );
  const base = [{ position: 'absolute', top: 0, left: 0, width: size, height: size }, style];
  if (reduce) return <View pointerEvents="none" style={base}>{svg}</View>;
  if (WEB) return <View pointerEvents="none" style={[base, { animationKeyframes: _SPIN_KF, animationDuration: '6000ms', animationIterationCount: 'infinite', animationTimingFunction: 'linear' }]}>{svg}</View>;
  return <Animated.View pointerEvents="none" style={[base, st]}>{svg}</Animated.View>;
});
/** Cor do anel de status já visto (cinza claro). */
export function vivoSeenRing(isDark) { return isDark ? 'rgba(255,255,255,0.14)' : 'rgba(24,24,27,0.12)'; }

// ── entrada leve das linhas ──────────────────────────────────────────────────
// Só na abertura: as primeiras ~14 linhas pintadas na janela de 900 ms depois
// da 1ª linha entram (sobe 10 px + fade, 0,5 s, cubic(.2,.8,.2,1), 40 ms em
// cascata). Linhas montadas depois (rolagem, reciclagem) aparecem paradas.
let _enterT0 = 0;
/** Chamado na montagem da lista: a próxima pintura volta a animar a entrada. */
export function resetVivoEnter() { _enterT0 = 0; }
const _ENTER_EASE = Easing.bezier(0.2, 0.8, 0.2, 1);
export function VivoEnter({ index = 0, children }) {
  const go = useRef(null);
  if (go.current === null) {
    let on = false;
    if (listVivoOn() && index < 14 && !isReduceMotionEnabled()) {
      const now = Date.now();
      if (!_enterT0) _enterT0 = now;
      on = now - _enterT0 < 900;
    }
    go.current = on;
  }
  const v = useSharedValue(go.current ? 0 : 1);
  useEffect(() => {
    if (!go.current) return;
    v.value = withDelay(Math.min(index, 13) * 40, withTiming(1, { duration: 500, easing: _ENTER_EASE }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ opacity: v.value, transform: [{ translateY: (1 - v.value) * 10 }] }));
  return <Animated.View style={st}>{children}</Animated.View>;
}

// ── botão redondo do topo (círculo branco com sombra) ────────────────────────
const _hdrBtn = { l: null, d: null };
export function vivoHeaderBtn(isDark) {
  const k = isDark ? 'd' : 'l';
  if (!_hdrBtn[k]) {
    const g = isDark ? Grafite.dark : Grafite.light;
    _hdrBtn[k] = {
      width: 40, height: 40, borderRadius: 20, backgroundColor: g.surface,
      boxShadow: isDark ? 'inset 0px 1px 0px rgba(255,255,255,0.04)' : '0px 1px 2px rgba(0,0,0,0.035), 0px 8px 24px rgba(0,0,0,0.045)',
    };
  }
  return _hdrBtn[k];
}

const vs = StyleSheet.create({
  dotWrap: { position: 'absolute', right: 1, bottom: 1, zIndex: 5, overflow: 'visible' },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 3, marginLeft: 6 },
  dot: { width: 5, height: 5, borderRadius: 2.5 },
  wave: { flexDirection: 'row', alignItems: 'center', gap: 2, height: 14, marginLeft: 6 },
  bar: { width: 2.5, borderRadius: 2 },
  typingRow: { flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 10, minWidth: 0 },
  mention: { width: 22, height: 22, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  mentionText: { fontSize: 12, fontWeight: '800', includeFontPadding: false, textAlign: 'center' },
  thumb: { width: 40, height: 40, borderRadius: 10, overflow: 'hidden', marginVertical: -9, alignItems: 'center', justifyContent: 'center' },
  thumbImg: { position: 'absolute', left: 0, top: 0, width: 40, height: 40 },
  play: { width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', paddingLeft: 1 },
});
