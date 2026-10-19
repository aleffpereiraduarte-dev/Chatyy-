// components/games/boards/CartasBoard.js — [jogos 2026-10-18] "Cartas Coloridas" (descarte por cor ou número).
// Arte e nome ORIGINAIS. Mão em leque embaixo (jogáveis sobem), monte para comprar, mesa com a cor atual.
// O servidor manda só a MINHA mão (`hand`), as jogáveis (`playable`) e a contagem dos outros (`counts`).
// Polish 2: carta VOA da mão (ou da cadeira do adversário) até o descarte e do monte até quem comprou;
// carta que não serve treme; adversários com versos em leque + número; seta de sentido girando em volta
// da mesa (meia-volta no Inverter); seletor de cor em pétalas; selo "Última carta!".
// Voo = 1 shared value por carta (UI thread); o JS só mede (measureInWindow) no início e desmonta no fim.
import React, { memo, useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, StyleSheet, Platform, useWindowDimensions } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withSpring, withTiming, withSequence, withDelay, withRepeat, cancelAnimation, runOnJS, Easing } from 'react-native-reanimated';
import Svg, { Path, Circle, Rect, G, Defs, LinearGradient, Stop, ClipPath } from 'react-native-svg';
import AvatarCircle from '../../AvatarCircle';
import NativeSheetDialog from '../../NativeSheetDialog';
import { CARD_COLORS, hTap, hCard, hDraw, hNope, hLast } from '../fx';
import { tr, nameOf } from '../../../services/games';
import { PressScale, shake, pop, useRM } from '../motion';

const COLOR_NAME_FB = { r: 'Vermelho', y: 'Amarelo', g: 'Verde', b: 'Azul' };
export function colorName(t, c) { return tr(t, 'games.cartas.color.' + c, COLOR_NAME_FB[c] || c); }
export function cardLabel(t, code) {
  if (!code) return '';
  if (code === 'WW') return tr(t, 'games.cartas.wild', 'Coringa');
  if (code === 'W4') return tr(t, 'games.cartas.wild4', 'Coringa +4');
  const v = code.slice(1);
  const vl = v === 'S' ? tr(t, 'games.cartas.skip', 'Pular') : v === 'R' ? tr(t, 'games.cartas.reverse', 'Inverter') : v === 'D' ? '+2' : v;
  return `${vl} ${colorName(t, code[0]).toLowerCase()}`;
}

// ─── arte das cartas (round 3) ──────────────────────────────────────────────
// Desenho ORIGINAL do Chatyy: face com degradê suave da cor, moldura fina interna, numeral serifado
// elegante no centro e índices nos cantos. Símbolos próprios: Pular = seta em arco saltando um ponto;
// Inverter = duas meias-setas opostas formando um laço; +2 = duas cartinhas empilhadas; Coringa = roseta
// de 4 pétalas nas 4 cores sobre fundo quase preto. Ids de degradê iguais por cor (defs idênticas →
// colisão de id no web é inofensiva).
const SERIF = Platform.select({ ios: 'Georgia', android: 'serif', default: 'Georgia, "Times New Roman", serif' });
const WILD_BG = '#121214';
function lighten(hex, k) {
  const h = String(hex || '#777777').replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  const ch = (sh) => { const v = (n >> sh) & 255; return Math.round(v + (255 - v) * k); };
  return '#' + [ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function darken(hex, k) {
  const h = String(hex || '#777777').replace('#', '');
  const n = parseInt(h, 16);
  const ch = (sh) => Math.round(((n >> sh) & 255) * (1 - k));
  return '#' + [ch(16), ch(8), ch(0)].map((v) => v.toString(16).padStart(2, '0')).join('');
}
const PETAL = 'M12 12 C 9.2 9.4, 9 5.2, 12 2.6 C 15 5.2, 14.8 9.4, 12 12 Z';
const ROSETTE_ORDER = ['r', 'y', 'g', 'b'];
function Rosette({ size, outline, color = '#FFFFFF' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {ROSETTE_ORDER.map((c, i) => (
        <Path key={c} d={PETAL} transform={`rotate(${i * 90 + 45} 12 12)`}
          fill={outline ? 'none' : CARD_COLORS[c]} stroke={outline ? color : 'rgba(255,255,255,0.55)'} strokeWidth={outline ? 0.9 : 0.5} />
      ))}
      <Circle cx="12" cy="12" r={outline ? 1.6 : 1.9} fill={outline ? 'none' : '#FFFFFF'} stroke={outline ? color : 'none'} strokeWidth={0.9} />
    </Svg>
  );
}
function Glyph({ v, size, color = '#FFFFFF' }) {
  if (v === 'S') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M4 16.5 C 5.5 7.5, 16.5 6.2, 19.4 14" />
        <Path d="M16.4 13.4 L19.6 14.4 L20.6 11.2" />
        <Circle cx="11.8" cy="17.4" r="2.1" fill={color} stroke="none" />
      </Svg>
    );
  }
  if (v === 'R') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.1} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M5.2 11 A 6.8 6.8 0 0 1 16.6 6" />
        <Path d="M17.4 2.8 V 6.6 H 13.6" />
        <Path d="M18.8 13 A 6.8 6.8 0 0 1 7.4 18" />
        <Path d="M6.6 21.2 V 17.4 H 10.4" />
      </Svg>
    );
  }
  if (v === 'D') {
    return (
      <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round">
        <Rect x="4.2" y="3.4" width="10" height="14" rx="2.2" transform="rotate(-10 9.2 10.4)" opacity={0.6} />
        <Rect x="9.4" y="6.6" width="10" height="14" rx="2.2" transform="rotate(8 14.4 13.6)" fill="rgba(255,255,255,0.16)" />
      </Svg>
    );
  }
  if (v === 'W' || v === '4') return <Rosette size={size} />;
  return null;
}

function CardFaceImpl({ code, w = 62, h = 92, dim }) {
  const c0 = code ? code[0] : '';
  const wild = c0 === 'W';
  const v = code ? code.slice(1) : '';
  const base = wild ? WILD_BG : (CARD_COLORS[c0] || '#777777');
  const top = wild ? '#2A2A2E' : lighten(base, 0.18);
  const bot = wild ? '#060607' : darken(base, 0.12);
  const gid = 'ctg_' + (wild ? 'w' : (c0 || 'x'));
  const R = w * 0.16;
  const digit = /^\d$/.test(v);
  const cornerTx = digit ? v : v === 'D' ? '+2' : v === '4' ? '+4' : '';
  const cornerGlyph = !cornerTx && (v === 'S' || v === 'R' || v === 'W') ? v : null;
  const shadowTx = { textShadowColor: 'rgba(0,0,0,0.28)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2 };
  let center;
  if (digit) {
    center = <Text style={[{ color: '#FFFFFF', fontFamily: SERIF, fontWeight: '700', fontSize: w * 0.58, letterSpacing: 0.5, includeFontPadding: false }, shadowTx]}>{v}</Text>;
  } else if (v === 'D') {
    center = (
      <View style={{ width: w * 0.62, height: w * 0.62, alignItems: 'center', justifyContent: 'center' }}>
        <View style={{ position: 'absolute' }}><Glyph v="D" size={w * 0.62} /></View>
        <Text style={[{ color: '#FFFFFF', fontFamily: SERIF, fontWeight: '700', fontSize: w * 0.24, marginLeft: w * 0.1, marginTop: w * 0.06 }, shadowTx]}>+2</Text>
      </View>
    );
  } else if (v === '4') {
    center = (
      <View style={{ alignItems: 'center' }}>
        <Rosette size={w * 0.48} />
        <Text style={[{ color: '#FFFFFF', fontFamily: SERIF, fontWeight: '700', fontSize: w * 0.22, marginTop: 1, letterSpacing: 0.5 }, shadowTx]}>+4</Text>
      </View>
    );
  } else {
    center = <Glyph v={v} size={w * (v === 'W' ? 0.6 : 0.5)} />;
  }
  const cs = w * 0.17;
  const corner = (flip) => (
    <View style={{ position: 'absolute', alignItems: 'center', ...(flip ? { bottom: h * 0.045, right: w * 0.08, transform: [{ rotate: '180deg' }] } : { top: h * 0.045, left: w * 0.08 }) }}>
      {cornerTx ? <Text style={{ color: '#FFFFFF', fontFamily: SERIF, fontWeight: '700', fontSize: cs, includeFontPadding: false }}>{cornerTx}</Text>
        : cornerGlyph ? <Glyph v={cornerGlyph} size={cs * 1.15} /> : null}
    </View>
  );
  return (
    <View style={{ width: w, height: h, borderRadius: R, backgroundColor: base, opacity: dim ? 0.5 : 1,
      shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 6, shadowOffset: { width: 0, height: 3 }, elevation: 5 }}>
      <View style={{ flex: 1, borderRadius: R, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.22)' }}>
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width={w} height={h}>
          <Defs>
            <LinearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={top} />
              <Stop offset="1" stopColor={bot} />
            </LinearGradient>
          </Defs>
          <Rect x="0" y="0" width={w} height={h} fill={`url(#${gid})`} />
          <Rect x="0" y="0" width={w} height={h * 0.42} fill="#FFFFFF" opacity={0.06} />
        </Svg>
        <View pointerEvents="none" style={{ position: 'absolute', left: w * 0.07, right: w * 0.07, top: w * 0.07, bottom: w * 0.07, borderRadius: R * 0.7, borderWidth: 1, borderColor: 'rgba(255,255,255,0.4)' }} />
        {center}
        {corner(false)}
        {corner(true)}
      </View>
    </View>
  );
}
export const CardFace = memo(CardFaceImpl);

// verso: grafite quase preto com treliça fina de losangos + roseta em contorno no centro
const BACK_LINES = (() => {
  let d = '';
  for (let k = -56; k <= 40; k += 4.5) { d += `M${k} 0 L${k + 56} 56 `; d += `M${k + 56} 0 L${k} 56 `; }
  return d;
})();
function CardBackImpl({ w = 62, h = 92 }) {
  const R = w * 0.16;
  return (
    <View style={{ width: w, height: h, borderRadius: R, backgroundColor: '#0E0E10',
      shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 5, shadowOffset: { width: 0, height: 2 }, elevation: 4 }}>
      <View style={{ flex: 1, borderRadius: R, overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
        borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.2)' }}>
        <Svg pointerEvents="none" style={StyleSheet.absoluteFill} width={w} height={h} viewBox="0 0 40 56" preserveAspectRatio="none">
          <Defs>
            <LinearGradient id="ctb_bg" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor="#222226" />
              <Stop offset="1" stopColor="#09090A" />
            </LinearGradient>
            <ClipPath id="ctb_clip"><Rect x="3.2" y="3.2" width="33.6" height="49.6" rx="4.2" /></ClipPath>
          </Defs>
          <Rect x="0" y="0" width="40" height="56" fill="url(#ctb_bg)" />
          <G clipPath="url(#ctb_clip)">
            <Path d={BACK_LINES} stroke="#FFFFFF" strokeWidth={0.28} opacity={0.22} />
          </G>
          <Rect x="3.2" y="3.2" width="33.6" height="49.6" rx="4.2" fill="none" stroke="#FFFFFF" strokeWidth={0.6} opacity={0.5} />
          <Circle cx="20" cy="28" r="8.6" fill="#0E0E10" stroke="#FFFFFF" strokeWidth={0.6} opacity={0.95} />
        </Svg>
        <Rosette size={w * 0.36} outline color="rgba(255,255,255,0.85)" />
      </View>
    </View>
  );
}
export const CardBack = memo(CardBackImpl);

function hashAng(s, k) { let h = 7; const x = String(s) + k; for (let i = 0; i < x.length; i++) h = (h * 31 + x.charCodeAt(i)) | 0; return ((Math.abs(h) % 25) - 12); }
function measure(ref) {
  return new Promise((res) => {
    try { if (!ref || !ref.current || !ref.current.measureInWindow) { res(null); return; } ref.current.measureInWindow((x, y, w, h) => res(Number.isFinite(x) && w ? { x, y, w, h } : null)); } catch { res(null); }
  });
}

// Carta voando (jogar/comprar). Um progresso 0→1 no UI thread; o JS só monta e desmonta.
function Flight({ f, onDone, rm }) {
  const p = useSharedValue(0);
  useEffect(() => {
    const dur = rm ? 1 : (f.dur || 340);
    p.value = withDelay(f.delay || 0, withTiming(1, { duration: dur, easing: Easing.out(Easing.cubic) }, (fin) => { if (fin) runOnJS(onDone)(f.id); }));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const { from, to } = f;
  const st = useAnimatedStyle(() => {
    const k = p.value;
    const cx = from.cx + (to.cx - from.cx) * k;
    const cy = from.cy + (to.cy - from.cy) * k - Math.sin(Math.PI * k) * (f.arc || 46);
    const s = (from.w / to.w) + (1 - from.w / to.w) * k;
    return {
      opacity: k <= 0 && (f.delay || 0) > 0 ? 0 : 1,
      transform: [{ translateX: cx - to.w / 2 }, { translateY: cy - to.h / 2 }, { rotate: `${from.rot + (to.rot - from.rot) * k}deg` }, { scale: s }],
    };
  });
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', left: 0, top: 0, width: to.w, height: to.h, zIndex: 50 }, st]}>
      {f.code ? <CardFace code={f.code} w={to.w} h={to.h} /> : <CardBack w={to.w} h={to.h} />}
    </Animated.View>
  );
}

function HandCard({ code, x, y, rot, playable, myTurn, onTap, w, h, drawn, delay, hidden, rm, pal }) {
  const lift = useSharedValue(0);
  const enter = useSharedValue(rm ? 1 : 0);
  const sx = useSharedValue(0);
  useEffect(() => { enter.value = rm ? 1 : withDelay(delay || 0, withSpring(1, { damping: 16, stiffness: 140 })); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { lift.value = withSpring(playable ? -18 : 0, { damping: 15, stiffness: 180 }); }, [playable]); // eslint-disable-line react-hooks/exhaustive-deps
  // entra "voando" do monte (distribuição / compra) e sobe quando é jogável
  const st = useAnimatedStyle(() => ({ opacity: hidden ? 0 : enter.value, transform: [{ translateX: sx.value }, { translateY: lift.value - (1 - enter.value) * 220 }, { scale: 0.7 + 0.3 * enter.value }] }));
  const press = () => {
    if (playable) { onTap(); return; }
    hNope(); shake(sx, 7, rm);
  };
  return (
    <View style={{ position: 'absolute', left: x, bottom: 8 - y, transform: [{ rotate: `${rot}deg` }] }}>
      <Animated.View style={st}>
        <Pressable onPress={press} disabled={hidden} accessibilityRole="button" accessibilityState={{ disabled: !playable }}>
          <CardFace code={code} w={w} h={h} dim={myTurn && !playable} />
          {drawn ? <View style={{ position: 'absolute', left: -3, right: -3, top: -3, bottom: -3, borderRadius: w * 0.16, borderWidth: 2.5, borderColor: pal.accent }} /> : null}
        </Pressable>
      </Animated.View>
    </View>
  );
}

function Pile({ top, color, k, pal, othersPlayed, under, pileRef, rm }) {
  const sc = useSharedValue(1);
  const rot = useSharedValue(0);
  const halo = useSharedValue(1);
  const first = useRef(true);
  const prevColor = useRef(color);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (othersPlayed) { try { require('../sound').playSfx('card'); } catch {} }
    if (rm) return;
    rot.value = withSequence(withTiming((Math.random() - 0.5) * 16, { duration: 1 }), withSpring(0, { damping: 11 }));
    sc.value = withSequence(withTiming(1.12, { duration: 100 }), withSpring(1, { damping: 12 }));
  }, [k]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (color !== prevColor.current) { prevColor.current = color; pop(halo, 1.14, rm); } }, [color]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ scale: sc.value }, { rotate: `${rot.value}deg` }] }));
  const haloSt = useAnimatedStyle(() => ({ transform: [{ scale: halo.value }] }));
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center', width: 96, height: 132 }}>
      <Animated.View style={[{ position: 'absolute', width: 92, height: 128, borderRadius: 18, borderWidth: 3, borderColor: CARD_COLORS[color] || pal.line }, haloSt]} />
      {under.map((c, i) => (
        <View key={c + i} style={{ position: 'absolute', transform: [{ rotate: `${hashAng(c, i)}deg` }, { translateX: (i - under.length) * 2 }] }}>
          <CardFace code={c} w={74} h={110} dim />
        </View>
      ))}
      <View ref={pileRef} collapsable={false}><Animated.View style={st}><CardFace code={top} w={74} h={110} /></Animated.View></View>
    </View>
  );
}

// Seta circular em volta da mesa: gira devagar no sentido do jogo; no "Inverter" dá meia-volta.
function DirRing({ dir, pal, rm, size }) {
  const r = useSharedValue(0);
  const flip = useSharedValue(dir === -1 ? -1 : 1);
  const first = useRef(true);
  useEffect(() => {
    const d = dir === -1 ? -1 : 1;
    if (!first.current && !rm) flip.value = withSequence(withTiming(0, { duration: 140 }), withTiming(d, { duration: 180 }));
    else flip.value = d;
    first.current = false;
    if (rm) { cancelAnimation(r); return; }
    cancelAnimation(r);
    const base = r.value % 360;
    r.value = base;
    r.value = withRepeat(withTiming(base + 360 * d, { duration: 16000, easing: Easing.linear }), -1, false);
  }, [dir, rm]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ transform: [{ rotate: `${r.value}deg` }, { scaleX: flip.value }] }));
  const R = size / 2 - 3;
  const c = size / 2;
  const arc = (a0, a1) => {
    const p0 = [c + R * Math.cos(a0), c + R * Math.sin(a0)]; const p1 = [c + R * Math.cos(a1), c + R * Math.sin(a1)];
    return `M${p0[0].toFixed(1)} ${p0[1].toFixed(1)} A${R} ${R} 0 0 1 ${p1[0].toFixed(1)} ${p1[1].toFixed(1)}`;
  };
  const head = (a) => {
    const p = [c + R * Math.cos(a), c + R * Math.sin(a)];
    const tx = -Math.sin(a); const ty = Math.cos(a); // tangente (sentido horário)
    const nx = Math.cos(a); const ny = Math.sin(a);
    const L = 7;
    return `M${(p[0] - tx * L + nx * L * 0.7).toFixed(1)} ${(p[1] - ty * L + ny * L * 0.7).toFixed(1)} L${p[0].toFixed(1)} ${p[1].toFixed(1)} L${(p[0] - tx * L - nx * L * 0.7).toFixed(1)} ${(p[1] - ty * L - ny * L * 0.7).toFixed(1)}`;
  };
  return (
    <Animated.View pointerEvents="none" style={[{ position: 'absolute', width: size, height: size }, st]}>
      <Svg width={size} height={size}>
        {[0, 1].map((k) => {
          const a0 = k * Math.PI + 0.35; const a1 = k * Math.PI + Math.PI - 0.35;
          return (
            <React.Fragment key={k}>
              <Path d={arc(a0, a1)} stroke={pal.sub} strokeWidth={2} fill="none" strokeLinecap="round" opacity={0.45} strokeDasharray={[2, 6]} />
              <Path d={head(a1)} stroke={pal.sub} strokeWidth={2.2} fill="none" strokeLinecap="round" strokeLinejoin="round" opacity={0.7} />
            </React.Fragment>
          );
        })}
      </Svg>
    </Animated.View>
  );
}

// Verso pequeno em leque para cada adversário (até 7 visíveis + número).
function FanBack({ k, m, rm }) {
  const e = useSharedValue(rm ? 1 : 0);
  const ang = (k - (m - 1) / 2) * Math.min(12, 46 / Math.max(1, m));
  const a = useSharedValue(ang);
  useEffect(() => { e.value = rm ? 1 : withSpring(1, { damping: 14, stiffness: 180 }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { a.value = rm ? ang : withSpring(ang, { damping: 15, stiffness: 170 }); }, [ang]); // eslint-disable-line react-hooks/exhaustive-deps
  const st = useAnimatedStyle(() => ({ opacity: e.value, transform: [{ translateY: 14 }, { rotate: `${a.value * e.value}deg` }, { translateY: -14 }, { scale: 0.6 + 0.4 * e.value }] }));
  return <Animated.View style={[{ position: 'absolute', left: 0, top: 0 }, st]}><CardBack w={20} h={30} /></Animated.View>;
}
function OppFan({ n, rm }) {
  const m = Math.min(n, 7);
  return (
    <View style={{ width: 20, height: 34, marginBottom: 2 }}>
      {Array.from({ length: m }).map((_, k) => <FanBack key={k} k={k} m={m} rm={rm} />)}
    </View>
  );
}
function Opp({ name, email, n, turn, out, pal, rm, oppRef, one }) {
  const s = useSharedValue(1);
  useEffect(() => { if (one) pop(s, 1.18, rm); }, [one]); // eslint-disable-line react-hooks/exhaustive-deps
  const badgeSt = useAnimatedStyle(() => ({ transform: [{ scale: s.value }] }));
  return (
    <View ref={oppRef} collapsable={false} style={[st.opp, { borderColor: turn ? pal.strong : pal.line, backgroundColor: pal.card, opacity: out ? 0.4 : 1 }]}>
      <View style={{ borderWidth: 2, borderColor: turn ? pal.strong : 'transparent', borderRadius: 22, padding: 1.5, marginBottom: 4 }}>
        <AvatarCircle email={email} name={name} size={34} />
      </View>
      <OppFan n={n} rm={rm} />
      <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 12.5, maxWidth: 90 }} numberOfLines={1}>{name}</Text>
      <Animated.View style={[st.badge, { backgroundColor: one ? pal.accent : pal.card2 }, badgeSt]}>
        <Text style={{ color: one ? '#111' : pal.sub, fontSize: 11.5, fontWeight: '800' }}>{n}</Text>
      </Animated.View>
    </View>
  );
}

// "Última carta!" — selo que pula no meio da mesa e some sozinho.
function Callout({ text, sub, pal, rm }) {
  const e = useSharedValue(rm ? 1 : 0);
  useEffect(() => { if (!rm) e.value = withSequence(withSpring(1, { damping: 9, stiffness: 220 }), withDelay(1300, withTiming(0, { duration: 220 }))); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const s = useAnimatedStyle(() => ({ opacity: Math.min(1, e.value * 1.5), transform: [{ scale: 0.6 + 0.4 * e.value }, { rotate: `${(1 - e.value) * -8}deg` }] }));
  return (
    <Animated.View pointerEvents="none" style={[st.callout, { backgroundColor: pal.accent }, s]}>
      <Text style={{ color: '#111', fontWeight: '900', fontSize: 17, letterSpacing: 0.3 }}>{text}</Text>
      {sub ? <Text style={{ color: '#111', fontWeight: '700', fontSize: 12.5, opacity: 0.8 }} numberOfLines={1}>{sub}</Text> : null}
    </Animated.View>
  );
}

// Seletor de cor do coringa: 4 pétalas saem do centro em cascata; a escolhida cresce, as outras somem.
function Petal({ c, i, picked, onPick, t, rm }) {
  const e = useSharedValue(rm ? 1 : 0);
  const sel = useSharedValue(0);
  useEffect(() => { if (!rm) e.value = withDelay(60 + i * 55, withSpring(1, { damping: 12, stiffness: 190 })); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (picked) sel.value = withTiming(picked === c ? 1 : -1, { duration: 160 }); }, [picked]); // eslint-disable-line react-hooks/exhaustive-deps
  const dx = i % 2 === 0 ? -1 : 1; const dy = i < 2 ? -1 : 1;
  const stl = useAnimatedStyle(() => ({
    opacity: e.value * (sel.value < 0 ? 1 + sel.value * 0.8 : 1),
    transform: [{ translateX: -dx * 40 * (1 - e.value) }, { translateY: -dy * 40 * (1 - e.value) }, { scale: (0.3 + 0.7 * e.value) * (1 + Math.max(0, sel.value) * 0.1) }],
  }));
  const R = 64;
  const radius = { borderTopLeftRadius: dx < 0 && dy < 0 ? R : 10, borderTopRightRadius: dx > 0 && dy < 0 ? R : 10, borderBottomLeftRadius: dx < 0 && dy > 0 ? R : 10, borderBottomRightRadius: dx > 0 && dy > 0 ? R : 10 };
  return (
    <Animated.View style={stl}>
      <PressScale onPress={() => onPick(c)} disabled={!!picked} rm={rm} scaleTo={0.92} accessibilityRole="button" accessibilityLabel={colorName(t, c)}
        style={[{ width: 92, height: 92, backgroundColor: CARD_COLORS[c], alignItems: 'center', justifyContent: 'center' }, radius]}>
        <Text style={{ color: '#FFFFFF', fontWeight: '800', fontSize: 13 }}>{colorName(t, c)}</Text>
      </PressScale>
    </Animated.View>
  );
}
function ColorPicker({ visible, onPick, onClose, pal, t, rm }) {
  const [picked, setPicked] = useState(null);
  useEffect(() => { if (visible) setPicked(null); }, [visible]);
  const pick = (c) => { if (picked) return; setPicked(c); hTap(); setTimeout(() => onPick(c), rm ? 0 : 200); };
  return (
    <NativeSheetDialog visible={!!visible} onClose={onClose} detents="fitToContents"
      panelStyle={[st.colorBox, { backgroundColor: pal.bg, borderColor: pal.line }]}>
      <Text style={{ color: pal.ink, fontWeight: '800', fontSize: 16, marginBottom: 16, textAlign: 'center' }}>{tr(t, 'games.cartas.pickColor', 'Escolha a cor')}</Text>
      {visible ? (
        <View style={{ width: 196, flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignSelf: 'center' }}>
          {['r', 'y', 'g', 'b'].map((c, i) => <Petal key={c} c={c} i={i} picked={picked} onPick={pick} t={t} rm={rm} />)}
        </View>
      ) : null}
    </NativeSheetDialog>
  );
}

export default function CartasBoard({ view, onMove, pal, busy, t, me, maxW }) {
  const win = useWindowDimensions();
  const width = maxW || win.width;
  const rm = useRM();
  const S = view.state || {};
  const seats = Array.isArray(view.seats) ? view.seats : [];
  const hand = Array.isArray(S.hand) ? S.hand : [];
  const handSig = hand.join(',');
  const playable = new Set(Array.isArray(S.playable) ? S.playable : []);
  const myTurn = view.status === 'active' && view.me !== null && view.me !== undefined && S.turn === view.me;
  const [wildFor, setWildFor] = useState(null);
  const [hidden, setHidden] = useState(null); // {key, sig}: carta que já saiu voando (espera o servidor)
  const [flights, setFlights] = useState([]);
  // o que o descarte MOSTRA por cima do servidor: {top, color} antigo enquanto a carta voa e, ao pousar
  // antes da resposta, a carta jogada (otimista) até o servidor confirmar — nunca some/pisca.
  const [hold, setHold] = useState(null);
  const [landKey, setLandKey] = useState('0');
  const [callout, setCallout] = useState(null);
  const dealtRef = useRef(false);
  const rootRef = useRef(null); const pileRef = useRef(null); const deckRef = useRef(null); const handRef = useRef(null);
  const oppRefs = useRef({});
  const prevTop = useRef({ top: S.top, color: S.color });
  const latest = useRef(S);
  latest.current = S;
  const holdRef = useRef(null);
  holdRef.current = hold;
  const seenMoves = useRef(S.moves);
  const prevCounts = useRef(Array.isArray(S.counts) ? S.counts.slice() : []);
  const prevDir = useRef(S.dir);
  const calloutT = useRef(null);
  useEffect(() => { const tm = setTimeout(() => { dealtRef.current = true; }, 900); return () => { clearTimeout(tm); if (calloutT.current) clearTimeout(calloutT.current); }; }, []);
  const counts = Array.isArray(S.counts) ? S.counts : [];

  // leque
  const W = Math.min(width - 16, maxW ? 720 : 520);
  const cw = 62; const ch = 92; const handH = ch + 44;
  const n = hand.length;
  const step = n > 1 ? Math.min(44, (W - cw) / (n - 1)) : 0;
  const total = cw + step * Math.max(0, n - 1);
  const x0 = (W - total) / 2;
  const angle = Math.min(5, 36 / Math.max(1, n));

  const flightsRef = useRef([]);
  const doneFlight = useCallback((id) => {
    const f = flightsRef.current.find((z) => z.id === id);
    flightsRef.current = flightsRef.current.filter((z) => z.id !== id);
    setFlights(flightsRef.current);
    if (f && f.toPile) {
      setLandKey(id);
      if (!flightsRef.current.some((z) => z.toPile)) {
        const cur = latest.current;
        setHold(cur.top === f.code ? null : { top: f.code, color: f.color || cur.color, optimistic: true });
      }
    }
  }, []);
  // servidor confirmou a carta otimista → solta sem "pular" de novo
  useEffect(() => { const h = holdRef.current; if (h && h.optimistic && h.top === S.top) setHold(null); }, [S.top, S.moves]);
  // rede de segurança: o topo "segurado" nunca fica preso
  useEffect(() => { if (!hold) return undefined; const tm = setTimeout(() => setHold(null), 1500); return () => clearTimeout(tm); }, [hold]);
  const fly = useCallback(async (fromRef, toRef, opts) => {
    const [root, a, b] = await Promise.all([measure(rootRef), measure(fromRef), measure(toRef)]);
    if (!root || !a || !b) { if (opts.toPile) { setHold(null); setLandKey('x' + Date.now()); } return; }
    const from = opts.from ? { ...opts.from, cx: a.x - root.x + opts.from.cx, cy: a.y - root.y + opts.from.cy } : { cx: a.x - root.x + a.w / 2, cy: a.y - root.y + a.h / 2, w: opts.fromW || 22, rot: 0 };
    const to = { cx: b.x - root.x + b.w / 2, cy: b.y - root.y + b.h / 2, w: opts.toW || 74, h: (opts.toW || 74) * 1.486, rot: opts.toRot || 0 };
    const id = Math.random().toString(36).slice(2);
    flightsRef.current = flightsRef.current.concat([{ id, from, to, code: opts.code || null, color: opts.color || null, delay: opts.delay || 0, dur: opts.dur, toPile: !!opts.toPile, arc: opts.arc }]);
    setFlights(flightsRef.current);
  }, []);

  const playFrom = (code, key, i, color) => {
    const off = i - (n - 1) / 2;
    const y = Math.abs(off) * Math.abs(off) * 0.9;
    const from = { cx: x0 + i * step + cw / 2, cy: handH - 8 + y - ch / 2 - 18, w: cw, rot: off * angle };
    setHidden({ key, sig: handSig });
    if (!rm && S.top) { setHold({ top: S.top, color: S.color }); fly(handRef, pileRef, { from, code, color: color || code[0], toPile: true, toRot: (Math.random() - 0.5) * 10, dur: 320, arc: 60 }); }
    hCard();
    onMove(color ? { a: 'play', card: code, color } : { a: 'play', card: code }).then((ok) => { if (!ok) { setHidden(null); setHold(null); } });
  };
  const play = (code, key, i) => {
    if (busy) return;
    if (code === 'WW' || code === 'W4') { hTap(); setWildFor({ code, key, i }); return; }
    playFrom(code, key, i);
  };
  const chooseColor = (c) => { const w = wildFor; setWildFor(null); if (w) playFrom(w.code, w.key, w.i, c); };

  // lances dos OUTROS: carta voa da cadeira até o descarte; compras voam do monte até a cadeira
  const L = S.last;
  useEffect(() => {
    if (S.moves === seenMoves.current) return;
    seenMoves.current = S.moves;
    const old = prevTop.current;
    prevTop.current = { top: S.top, color: S.color };
    const mine = !!L && L.by === view.me;
    const flying = flightsRef.current.some((z) => z.toPile) || !!holdRef.current;
    if (!L || L.by === undefined || rm) { if (L && L.a === 'play' && !flying) setLandKey('m' + S.moves); return; }
    if (L.a === 'play' && mine && !flying) setLandKey('m' + S.moves);
    if (L.a === 'play' && !mine && !oppRefs.current[L.by]) setLandKey('m' + S.moves);
    if (L.a === 'play' && !mine && oppRefs.current[L.by]) {
      if (old.top) setHold({ top: old.top, color: old.color });
      fly({ current: oppRefs.current[L.by] }, pileRef, { code: L.card, toPile: true, toRot: (Math.random() - 0.5) * 10, fromW: 22, dur: 360 });
    }
    if (L.a === 'draw' && !mine && oppRefs.current[L.by]) fly(deckRef, { current: oppRefs.current[L.by] }, { toW: 22, fromW: 74, dur: 320, arc: 30 });
    if (L.victim !== undefined && L.drew && L.victim !== view.me && oppRefs.current[L.victim]) {
      for (let k = 0; k < Math.min(4, L.drew); k++) fly(deckRef, { current: oppRefs.current[L.victim] }, { toW: 22, fromW: 74, dur: 300, delay: 360 + k * 110, arc: 30 });
    }
  }, [S.moves]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Última carta!" quando alguém fica com 1 · "Sentido invertido" no Inverter
  useEffect(() => {
    const prev = prevCounts.current;
    let who = -1;
    counts.forEach((c, i) => { if (c === 1 && (prev[i] === undefined || prev[i] > 1) && view.status === 'active') who = i; });
    prevCounts.current = counts.slice();
    if (who >= 0) {
      hLast();
      const nm = who === view.me ? tr(t, 'games.you', 'Você') : nameOf(view, seats[who], me, t);
      setCallout({ id: Date.now(), text: tr(t, 'games.cartas.lastCard', 'Última carta!'), sub: nm });
    }
  }, [counts.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (prevDir.current !== undefined && S.dir !== prevDir.current && seats.length > 2) {
      setCallout({ id: Date.now(), text: tr(t, 'games.cartas.reversed', 'Sentido invertido'), sub: '' });
    }
    prevDir.current = S.dir;
  }, [S.dir]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!callout) return undefined;
    if (calloutT.current) clearTimeout(calloutT.current);
    calloutT.current = setTimeout(() => setCallout(null), rm ? 1600 : 1900);
    return undefined;
  }, [callout && callout.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // último lance em texto
  let lastTx = '';
  if (L && L.by !== undefined && seats[L.by]) {
    const who = nameOf(view, seats[L.by], me, t);
    if (L.a === 'play') lastTx = tr(t, 'games.cartas.lastPlay', '{name} jogou {card}', { name: who, card: cardLabel(t, L.card) });
    else if (L.a === 'draw') lastTx = tr(t, 'games.cartas.lastDraw', '{name} comprou', { name: who });
    else if (L.a === 'pass') lastTx = tr(t, 'games.cartas.lastPass', '{name} passou', { name: who });
    else if (L.a === 'resign') lastTx = tr(t, 'games.lastResign', '{name} saiu da partida', { name: who });
    else if (L.a === 'afk') lastTx = tr(t, 'games.lastAfk', '{name} demorou e a vez passou', { name: who });
    else if (L.a === 'afk_out') lastTx = tr(t, 'games.lastAfkOut', '{name} saiu por ausência', { name: who });
    if (L.victim !== undefined && seats[L.victim] && L.drew) lastTx += ' · ' + tr(t, 'games.cartas.victim', '{name} comprou {n}', { name: nameOf(view, seats[L.victim], me, t), n: L.drew });
    if ((L.card === 'WW' || L.card === 'W4') && L.color) lastTx += ' · ' + colorName(t, L.color);
  }

  const shownTop = hold ? hold.top : S.top;
  const shownColor = hold ? hold.color : S.color;
  const pileK = landKey;
  const tail = Array.isArray(S.discard_tail) ? S.discard_tail : [];
  const ti = tail.lastIndexOf(shownTop);
  const under = ti > 0 ? tail.slice(Math.max(0, ti - 2), ti) : [];
  const hideKey = hidden && hidden.sig === handSig ? hidden.key : null;
  const one = view.me !== null && view.me !== undefined && hand.length === 1 && view.status === 'active';

  return (
    <View ref={rootRef} collapsable={false} style={{ flex: 1 }}>
      {/* adversários */}
      <View style={st.opps}>
        {seats.map((e, i) => {
          if (i === view.me) return null;
          return (
            <Opp key={e} email={e} name={nameOf(view, e, me, t)} n={counts[i] || 0} turn={view.status === 'active' && S.turn === i} out={Array.isArray(S.out) && S.out[i]}
              pal={pal} rm={rm} one={counts[i] === 1 && view.status === 'active'} oppRef={(r) => { oppRefs.current[i] = r; }} />
          );
        })}
      </View>

      {/* mesa */}
      <View style={st.table}>
        <PressScale disabled={!S.can_draw || busy} onPress={() => { hDraw(); onMove({ a: 'draw' }); }} rm={rm} scaleTo={0.95} accessibilityRole="button"
          accessibilityLabel={tr(t, 'games.cartas.draw', 'Comprar')} style={{ alignItems: 'center' }}>
          <View ref={deckRef} collapsable={false}>
            <View style={{ position: 'absolute', left: 4, top: 4 }}><CardBack w={74} h={110} /></View>
            <View style={{ position: 'absolute', left: 2, top: 2 }}><CardBack w={74} h={110} /></View>
            <CardBack w={74} h={110} />
            {S.can_draw ? <View pointerEvents="none" style={{ position: 'absolute', left: -4, top: -4, right: -4, bottom: -4, borderRadius: 14, borderWidth: 2, borderColor: pal.accent }} /> : null}
          </View>
          <Text style={{ color: S.can_draw ? pal.ink : pal.sub, fontWeight: '800', marginTop: 8, fontSize: 13 }}>
            {S.can_draw ? tr(t, 'games.cartas.draw', 'Comprar') : tr(t, 'games.cartas.deck', 'Monte ({n})', { n: S.deck || 0 })}
          </Text>
        </PressScale>
        <View style={{ alignItems: 'center' }}>
          <View style={{ alignItems: 'center', justifyContent: 'center', width: 160, height: 160 }}>
            {seats.length > 2 ? <DirRing dir={S.dir} pal={pal} rm={rm} size={160} /> : null}
            {shownTop ? <Pile top={shownTop} color={shownColor} k={pileK} pal={pal} under={under} pileRef={pileRef} rm={rm}
              othersPlayed={!!(S.last && S.last.a === 'play' && S.last.by !== view.me)} /> : null}
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 }}>
            <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: CARD_COLORS[S.color] || pal.sub }} />
            <Text style={{ color: pal.ink, fontWeight: '700', fontSize: 13 }}>{colorName(t, S.color)}</Text>
            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke={pal.sub} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" style={{ transform: [{ scaleX: S.dir === -1 ? -1 : 1 }] }}>
              <Path d="M20 12a8 8 0 1 1-2.3-5.7" /><Path d="M20 4v4h-4" />
            </Svg>
          </View>
        </View>
      </View>
      {lastTx ? <Text style={[st.last, { color: pal.sub }]} numberOfLines={2}>{lastTx}</Text> : null}
      {S.can_pass ? (
        <PressScale onPress={() => { hTap(); onMove({ a: 'pass' }); }} disabled={busy} rm={rm} style={[st.passBtn, { borderColor: pal.strong }]} accessibilityRole="button">
          <Text style={{ color: pal.ink, fontWeight: '800' }}>{tr(t, 'games.cartas.pass', 'Passar a vez')}</Text>
        </PressScale>
      ) : null}

      {/* mão */}
      {view.me !== null && view.me !== undefined ? (
        <View ref={handRef} collapsable={false} style={{ height: handH, width: W, alignSelf: 'center', marginTop: 'auto' }}>
          {one ? <View pointerEvents="none" style={[st.oneTag, { backgroundColor: pal.accent }]}><Text style={{ color: '#111', fontWeight: '900', fontSize: 12 }}>{tr(t, 'games.cartas.lastCard', 'Última carta!')}</Text></View> : null}
          {hand.map((code, i) => {
            const off = i - (n - 1) / 2;
            const occ = hand.slice(0, i).filter((c) => c === code).length; // chave estável por exemplar
            const key = code + '#' + occ;
            return (
              <HandCard key={key} code={code} w={cw} h={ch} delay={dealtRef.current ? 0 : i * 70} rm={rm} pal={pal}
                x={x0 + i * step} y={Math.abs(off) * Math.abs(off) * 0.9} rot={off * angle} hidden={hideKey === key}
                playable={myTurn && playable.has(code) && !busy} myTurn={myTurn} drawn={S.drawn === code && i === hand.lastIndexOf(code)}
                onTap={() => play(code, key, i)} />
            );
          })}
        </View>
      ) : (
        <Text style={[st.last, { color: pal.sub, marginTop: 'auto', marginBottom: 20 }]}>{tr(t, 'games.spectating', 'Você está assistindo')}</Text>
      )}

      {flights.map((f) => <Flight key={f.id} f={f} onDone={doneFlight} rm={rm} />)}
      {callout ? <View pointerEvents="none" style={st.calloutWrap}><Callout key={callout.id} text={callout.text} sub={callout.sub} pal={pal} rm={rm} /></View> : null}

      <ColorPicker visible={!!wildFor} onPick={chooseColor} onClose={() => setWildFor(null)} pal={pal} t={t} rm={rm} />
    </View>
  );
}

const st = StyleSheet.create({
  opps: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8, marginTop: 6 },
  opp: { alignItems: 'center', borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 10, paddingTop: 7, paddingBottom: 6, minWidth: 86 },
  badge: { minWidth: 22, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, marginTop: 3 },
  table: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 22, marginTop: 10 },
  last: { textAlign: 'center', marginTop: 8, fontSize: 13, paddingHorizontal: 20 },
  passBtn: { alignSelf: 'center', marginTop: 10, borderWidth: 1.5, borderRadius: 12, paddingHorizontal: 18, paddingVertical: 8 },
  colorBox: { width: 300, borderRadius: 24, padding: 22, alignItems: 'center', borderWidth: StyleSheet.hairlineWidth },
  calloutWrap: { position: 'absolute', left: 0, right: 0, top: 96, alignItems: 'center', zIndex: 60 },
  callout: { borderRadius: 18, paddingHorizontal: 18, paddingVertical: 9, alignItems: 'center', shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 3 }, elevation: 6 },
  oneTag: { position: 'absolute', top: -6, alignSelf: 'center', borderRadius: 10, paddingHorizontal: 10, paddingVertical: 3, zIndex: 5 },
});
