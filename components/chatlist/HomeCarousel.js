// components/chatlist/HomeCarousel.js — [2026-10-19 home-carousel] variante B "Mais limpo"
//
// Founder: o topo de "Conversas" tinha 3 blocos empilhados (linha da Bia, linha
// "Seu status" e a fileira de fixadas) = muito espaço vertical. Agora é UMA
// fileira horizontal estilo Instagram (mock: preview-2026/carrossel.html):
//   1. Eu ("Seu status": "+" posta, anel = ver o meu)                      64 pt
//   2. Bia (orb no anel cônico P&B + selo "IA" + balão de pensamento com a
//      frase do dia — ÚNICO item com balão)                                 64 pt
//   3. Contatos com status (não vistos = anel tinta; vistos = cinza claro)  64 pt
//   │  divisória fina vertical
//   4. Conversas fixadas (menores, sem anel, selo branco de alfinete)       52 pt
// Mora no header da lista (ListHeaderComponent / slot `header` da lista nativa),
// então vale p/ iOS, Android e web sem build.
//
// Kill switch: globalThis.__chatyy_home_carousel = false → layout antigo
// (linha da Bia + "Seu status" + fileira de fixadas).
import React, { memo, useEffect, useMemo, useRef } from 'react';
import { View, Text, Pressable, Platform, StyleSheet, Animated, Easing } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import BiaOrb from '../bia/BiaOrb';
import { useLanguageOptional } from '../../context/LanguageContext';
import { useBiaDaily, biaGreetingKey } from '../../services/biaDaily';
import { useReducedMotion, isReduceMotionEnabled } from '../reducedMotion';

export function homeCarouselOn() {
  try { return globalThis.__chatyy_home_carousel !== false; } catch { return true; }
}

/** t() com fallback pt (chave ausente volta a própria chave em alguns idiomas). */
export function tc(t, key, fb) {
  let v = null;
  try { v = t ? t(key) : null; } catch {}
  return v && v !== key ? v : fb;
}

const ND = Platform.OS !== 'web';

// ── medidas (pt) ────────────────────────────────────────────────────────────
export const HC = Object.freeze({
  avatar: 64,        // eu, Bia, status
  ring: 74,          // avatar + anel com respiro (footprint do StoryRingAvatar)
  itemW: 74,
  pinAvatar: 52,     // fixadas: menores, sem anel
  pinW: 60,
  gap: 14,
  bubbleOverlap: 4,  // quanto o corpo do balão entra no anel (a cauda desce mais)
  padTop: 38,        // reserva fixa p/ o balão (sem pulo quando a frase chega)
  padBottom: 10,
  labelGap: 5,
  labelH: 16,
  side: 16,
});

/** Corta em ~40 caracteres (palavra inteira quando dá) com reticências. */
export function shortNote(s, max = 40) {
  const str = String(s || '').replace(/\s+/g, ' ').trim();
  if (str.length <= max) return str;
  const cut = str.slice(0, max);
  const sp = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s.,;:!?·-]+$/, '') + '…';
}

function _haptic(kind = 'light') {
  try { require('../../constants/theme').haptic?.[kind]?.(); } catch {}
}

/** Balão de pensamento (Instagram Notes): pílula + 2 bolinhas de cauda. Entra com fade. */
export const ThoughtBubble = memo(function ThoughtBubble({ text, isDark }) {
  const rm = useReducedMotion();
  const op = useRef(new Animated.Value(rm ? 1 : 0)).current;
  const ty = useRef(new Animated.Value(rm ? 0 : 4)).current;
  useEffect(() => {
    if (rm || isReduceMotionEnabled()) { op.setValue(1); ty.setValue(0); return undefined; }
    op.setValue(0); ty.setValue(4);
    const a = Animated.parallel([
      Animated.timing(op, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: ND }),
      Animated.timing(ty, { toValue: 0, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: ND }),
    ]);
    a.start();
    return () => { try { a.stop(); } catch {} };
  }, [text, rm, op, ty]);
  const bg = isDark ? '#2C2C2E' : '#FFFFFF';
  const ink = isDark ? '#F5F5F7' : '#111111';
  const edge = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const shadow = Platform.select({
    ios: { shadowColor: '#000', shadowOpacity: isDark ? 0.35 : 0.12, shadowRadius: 6, shadowOffset: { width: 0, height: 2 } },
    android: { elevation: 3 },
    web: { boxShadow: isDark ? '0 2px 10px rgba(0,0,0,0.45)' : '0 2px 10px rgba(0,0,0,0.12)' },
    default: {},
  });
  return (
    <Animated.View pointerEvents="none" style={{ alignItems: 'center', opacity: op, transform: [{ translateY: ty }] }}>
      <View style={[hs.bubble, { backgroundColor: bg, borderColor: edge }, shadow]}>
        <Text maxFontSizeMultiplier={1.15} numberOfLines={2} ellipsizeMode="tail" style={[hs.bubbleText, { color: ink }]}>
          {shortNote(text)}
        </Text>
      </View>
      <View style={[hs.tail1, { backgroundColor: bg }]} />
      <View style={[hs.tail2, { backgroundColor: bg }]} />
    </Animated.View>
  );
});

/**
 * Casca de um item: área do anel (74, mesmo eixo p/ todos) + rótulo (+ balão).
 * Toque com mola 0,94 (sem mola com Reduzir movimento) + háptico leve.
 */
export function CarouselSlot({ bubble, children, label, labelColor, labelWeight = '500', labelSize = 12, width = HC.itemW, onPress, onPressIn, onLongPress, accessibilityLabel, accessibilityHint, accessibilityActions, onAccessibilityAction, testID }) {
  const sc = useRef(new Animated.Value(1)).current;
  const go = (to) => {
    if (isReduceMotionEnabled()) return;
    Animated.spring(sc, { toValue: to, tension: 340, friction: 18, useNativeDriver: ND }).start();
  };
  return (
    <View style={{ width, alignItems: 'center' }}>
      <Pressable
        onPress={() => { _haptic('light'); onPress?.(); }}
        onPressIn={() => { go(0.94); onPressIn?.(); }}
        onPressOut={() => go(1)}
        onLongPress={onLongPress}
        delayLongPress={380}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        accessibilityHint={accessibilityHint}
        accessibilityActions={accessibilityActions}
        onAccessibilityAction={onAccessibilityAction}
        testID={testID}
        style={Platform.OS === 'web' ? { cursor: 'pointer' } : null}
      >
        <Animated.View style={{ alignItems: 'center', width, transform: [{ scale: sc }] }}>
          <View style={hs.ringArea}>{children}</View>
          <Text maxFontSizeMultiplier={1.2} numberOfLines={1} ellipsizeMode="tail" style={[hs.label, { color: labelColor, fontWeight: labelWeight, fontSize: labelSize, maxWidth: width }]}>
            {label}
          </Text>
        </Animated.View>
      </Pressable>
      {bubble ? <View pointerEvents="none" style={hs.bubbleAnchor}>{bubble}</View> : null}
    </View>
  );
}

/** Divisória vertical fina entre os status e as fixadas (centrada no eixo dos anéis). */
export function CarouselDivider({ color }) {
  return <View accessibilityElementsHidden importantForAccessibility="no" style={[hs.divider, { backgroundColor: color }]} />;
}

/** Selo branco de alfinete (fixadas) — ancorado no avatar de 52. */
export function PinBadge({ isDark }) {
  return (
    <View pointerEvents="none" style={[hs.pin, {
      backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF',
      borderColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
    }, Platform.select({
      ios: { shadowColor: '#000', shadowOpacity: isDark ? 0 : 0.12, shadowRadius: 3, shadowOffset: { width: 0, height: 1 } },
      android: { elevation: 2 },
      web: { boxShadow: isDark ? 'none' : '0 1px 3px rgba(0,0,0,0.12)' },
      default: {},
    })]}>
      <Svg width={10} height={10} viewBox="0 0 24 24">
        <Path d="M15 3l6 6-3 1-3 4 1 4-2 2-4-4-5 5-1-1 5-5-4-4 2-2 4 1 4-3z" fill={isDark ? '#F5F5F7' : '#111111'} />
      </Svg>
    </View>
  );
}

/** Círculo de esqueleto com brilho (respeita Reduzir movimento). */
export function SkeletonSlot({ isDark }) {
  const rm = useReducedMotion();
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (rm) return undefined;
    const a = Animated.loop(Animated.sequence([
      Animated.timing(v, { toValue: 1, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: ND }),
      Animated.timing(v, { toValue: 0, duration: 700, easing: Easing.inOut(Easing.quad), useNativeDriver: ND }),
    ]));
    a.start();
    return () => { try { a.stop(); } catch {} };
  }, [rm, v]);
  const bg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  const opacity = rm ? 1 : v.interpolate({ inputRange: [0, 1], outputRange: [0.5, 1] });
  return (
    <View style={{ width: HC.itemW, alignItems: 'center' }} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Animated.View style={{ alignItems: 'center', opacity }}>
        <View style={hs.ringArea}><View style={{ width: HC.avatar, height: HC.avatar, borderRadius: HC.avatar / 2, backgroundColor: bg }} /></View>
        <View style={{ width: 40, height: 9, borderRadius: 4.5, backgroundColor: bg, marginTop: HC.labelGap + 3 }} />
      </Animated.View>
    </View>
  );
}

// ── Bia ─────────────────────────────────────────────────────────────────────
function _suggestion(t) {
  const h = new Date().getHours();
  if (h < 12) return { hello: t('one.goodMorning'), tip: t('one.todaySummary') };
  if (h < 18) return { hello: t('one.goodAfternoon'), tip: t('one.unreadEmails') };
  return { hello: t('one.goodEvening'), tip: t('one.tomorrowAgenda') };
}

function _hex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function _mix(a, b, k) {
  const A = _hex(a); const B = _hex(b);
  const c = A.map((x, i) => Math.round(x + (B[i] - x) * k));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
/** Arcos do anel cônico (preto → cinza → branco → cinza → preto) a partir de 210°. */
function _conicArcs(isDark, n = 36) {
  const stops = isDark
    ? ['#FFFFFF', '#6A6A70', '#1C1C1E', '#6A6A70', '#FFFFFF']
    : ['#000000', '#9A9AA0', '#FFFFFF', '#9A9AA0', '#000000'];
  const rs = HC.ring; const r = rs / 2 - 1.5; const cx = rs / 2;
  const out = [];
  for (let i = 0; i < n; i++) {
    const k = (i + 0.5) / n;
    const seg = k * (stops.length - 1);
    const j = Math.min(stops.length - 2, Math.floor(seg));
    const color = _mix(stops[j], stops[j + 1], seg - j);
    // 0° = topo (como o conic-gradient do CSS), sentido horário; +0,6° evita frestas
    const a0 = ((210 + (i / n) * 360) - 90) * Math.PI / 180;
    const a1 = ((210 + ((i + 1) / n) * 360 + 0.6) - 90) * Math.PI / 180;
    const x0 = cx + r * Math.cos(a0); const y0 = cx + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1); const y1 = cx + r * Math.sin(a1);
    out.push({ d: `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`, color });
  }
  return out;
}
const _ARCS = { l: null, d: null };

/** Anel especial da Bia: gradiente cônico P&B (invertido no escuro). */
const BiaRing = memo(function BiaRing({ isDark }) {
  const key = isDark ? 'd' : 'l';
  if (!_ARCS[key]) _ARCS[key] = _conicArcs(isDark);
  const rs = HC.ring;
  return (
    <Svg width={rs} height={rs} style={StyleSheet.absoluteFill} pointerEvents="none">
      {_ARCS[key].map((a, i) => (
        <Path key={i} d={a.d} stroke={a.color} strokeWidth={2.5} fill="none" />
      ))}
    </Svg>
  );
});

/**
 * Bia no carrossel. Toque = conversa com a Bia (/one, tela de chat como com uma
 * pessoa). Toque longo = modo voz (/one?voice=1); a voz também segue no chat.
 */
export const BiaCarouselItem = memo(function BiaCarouselItem({ isDark, t, router, labelColor }) {
  const sug = useMemo(() => _suggestion(t), [t]);
  const _lc = useLanguageOptional();
  const daily = useBiaDaily(_lc?.language || 'pt-BR');
  let hello = sug.hello;
  let line = '';
  if (daily && daily.line) {
    const word = t(biaGreetingKey());
    hello = daily.name ? `${word}, ${daily.name}` : word;
    line = daily.line;
  }
  // Sem frase ainda (1ª abertura sem cache): o balão só aparece quando ela chega (fade).
  const open = (q) => { try { router.push(q ? `/one?${q}` : '/one'); } catch {} };
  const voiceLabel = tc(t, 'one.voiceConversation', 'Conversa por voz');
  const name = tc(t, 'one.title', 'Bia');
  const ia = tc(t, 'chat.aiBadge', 'IA');
  const card = isDark ? '#000000' : '#FFFFFF';
  const ink = isDark ? '#F5F5F7' : '#0A0A0A';
  return (
    <CarouselSlot
      bubble={line ? <ThoughtBubble text={line} isDark={isDark} /> : null}
      label={name}
      labelColor={labelColor}
      onPress={() => open()}
      onLongPress={() => { _haptic('medium'); open('voice=1'); }}
      accessibilityLabel={`${name}, ${ia}. ${hello}. ${line || sug.tip || ''}`}
      accessibilityHint={tc(t, 'homeCarousel.biaHint', 'Toque para conversar. Toque e segure para falar por voz.')}
      accessibilityActions={[{ name: 'activate' }, { name: 'longpress', label: voiceLabel }]}
      onAccessibilityAction={(e) => {
        const n = e?.nativeEvent?.actionName;
        if (n === 'longpress') open('voice=1');
        else open();
      }}
      testID="home-carousel-bia"
    >
      <BiaRing isDark={isDark} />
      <BiaOrb size={HC.avatar - 4} lite isDark={isDark} />
      <View pointerEvents="none" style={[hs.ia, { backgroundColor: ink, borderColor: card }]}>
        <Text maxFontSizeMultiplier={1} style={[hs.iaText, { color: card }]}>{ia}</Text>
      </View>
    </CarouselSlot>
  );
});

const hs = StyleSheet.create({
  ringArea: { width: HC.ring, height: HC.ring, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 12, marginTop: HC.labelGap, letterSpacing: -0.1, textAlign: 'center' },
  // O balão cresce p/ cima a partir de (topo do anel + overlap); a cauda desce sobre o anel.
  bubbleAnchor: {
    position: 'absolute', left: -22, right: -22,
    bottom: HC.ring + HC.labelGap + HC.labelH - HC.bubbleOverlap,
    alignItems: 'center',
    zIndex: 5, elevation: 5,
  },
  bubble: {
    maxWidth: 110, minWidth: 44,
    paddingHorizontal: 9, paddingVertical: 6,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
  },
  bubbleText: { fontSize: 11.5, lineHeight: 14, textAlign: 'center', fontWeight: '500', letterSpacing: -0.1 },
  tail1: { position: 'absolute', bottom: -5, left: '50%', marginLeft: -7, width: 8, height: 8, borderRadius: 4 },
  tail2: { position: 'absolute', bottom: -10, left: '50%', marginLeft: -10, width: 4, height: 4, borderRadius: 2 },
  ia: {
    position: 'absolute', right: 0, bottom: 2,
    paddingHorizontal: 5, paddingVertical: 1.5,
    borderRadius: 8, borderWidth: 2,
  },
  iaText: { fontSize: 9, fontWeight: '800', letterSpacing: 0.3 },
  pin: {
    position: 'absolute', right: -3, bottom: -3,
    width: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  // 1 × 36 pt, centrada no eixo dos anéis (74/2 − 18 = 19); margens ~6 pt (gap 14 − 8)
  divider: { width: 1, height: 36, marginTop: (HC.ring - 36) / 2, marginHorizontal: -8 },
});
