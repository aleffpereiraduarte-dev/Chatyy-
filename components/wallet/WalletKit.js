// components/wallet/WalletKit.js — peças compartilhadas da Carteira, Loja de
// Diamantes e Meus Ganhos (repaginação "fintech P&B", 2026-10-14).
//
//   HeroCard        cartão-herói SEMPRE escuro (Apple Card / Revolut): degradê
//                   grafite + brilho azul sutil atrás do diamante. Igual nos 2 temas.
//   HeroButton      ação do herói: primary (branco preenchido) | outline.
//   AnimatedNumber  número tabular com contagem animada ao mudar (respeita Reduce Motion).
//   DiamondMark     diamante com halo azul (a ÚNICA cor da carteira).
//   ProgressBar     barra fina até o mínimo de saque (acessível).
//   TxGlyph         ícone SVG traço fino por tipo de transação.
//   FilterChips     pílulas de filtro (selecionada = tinta).
//   PackCard        cartão de pacote (carrossel "Mais vendidos" e grade da loja).
//
// Cor só para estado: crédito = verde sutil, saldo negativo = vermelho.
import React, { useEffect, useRef, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, ActivityIndicator, Platform } from 'react-native';
import Svg, { Defs, LinearGradient, RadialGradient, Stop, Rect, Path, Circle } from 'react-native-svg';
import { IconDiamond } from '../Icons';
import PressableScale from '../PressableScale';
import { isReduceMotionEnabled } from '../reducedMotion';
import { Type, Space, Radius } from '../../constants/theme';
import { formatMoney } from '../../services/currencyService';
import { formatInt } from '../../utils/dateFormat';

export function tr(t, k, fb) { const v = t ? t(k) : ''; return v && v !== k ? v : fb; }
// Ganhos/saques são SEMPRE em reais (servidor paga via Pix em BRL).
export function moneyBRL(cents) { return formatMoney(Number(cents) || 0, 'BRL', 'pt-BR'); }
// [2026-10-16 carteira-clara] Diretriz do founder: NADA de "≈" na carteira —
// só valores exatos. Mantido (vazio) p/ não quebrar import antigo.
export function approxActive() { return ''; }
export const TABULAR = { fontVariant: ['tabular-nums'] };
// FadeSlideIn traz flex:1 — numa coluna de conteúdo isso estica/encolhe o bloco.
export const NOFLEX = { flexGrow: 0, flexShrink: 0, flexBasis: 'auto' };

// Paleta do herói (independe do tema — o cartão é sempre grafite).
export const HERO = {
  text: '#FFFFFF',
  sub: 'rgba(255,255,255,0.62)',
  faint: 'rgba(255,255,255,0.38)',
  line: 'rgba(255,255,255,0.12)',
  outline: 'rgba(255,255,255,0.30)',
  fill: 'rgba(255,255,255,0.10)',
  danger: '#FF6B63',
  success: '#5BE38B',
};

let _gid = 0;
function useGradId(prefix) { const r = useRef(null); if (r.current == null) r.current = `${prefix}${++_gid}`; return r.current; }

// [2026-10-14 v3.1] O degradê é medido (onLayout) e desenhado com tamanho
// NUMÉRICO: no iOS o <Svg width="100%"> ficava com o tamanho da 1ª medição
// (antes do saldo/botões crescerem) e sobrava uma faixa escura à direita e
// embaixo. Fundo sólido = cor final do degradê, então nunca aparece "buraco".
export function HeroCard({ children, style, isDark, glow = true }) {
  const lg = useGradId('wlg');
  const rg = useGradId('wrg');
  const [box, setBox] = useState(null);
  const onLayout = (e) => {
    const { width, height } = e.nativeEvent.layout;
    const w = Math.ceil(width), h = Math.ceil(height);
    if (w > 0 && h > 0 && (!box || box.w !== w || box.h !== h)) setBox({ w, h });
  };
  const end = isDark ? '#0E0E10' : '#09090A';
  return (
    <View onLayout={onLayout} style={[styles.hero, { backgroundColor: end }, isDark ? styles.heroDark : styles.heroLight, style]}>
      {box ? (
        <View style={[StyleSheet.absoluteFill, styles.heroBg]} pointerEvents="none">
          <Svg width={box.w} height={box.h} viewBox={`0 0 ${box.w} ${box.h}`}>
            <Defs>
              <LinearGradient id={lg} x1="0" y1="0" x2={box.w} y2={box.h} gradientUnits="userSpaceOnUse">
                <Stop offset="0" stopColor={isDark ? '#1E1E21' : '#232326'} />
                <Stop offset="1" stopColor={end} />
              </LinearGradient>
              <RadialGradient id={rg} cx={box.w * 0.12} cy={0} rx={box.w * 0.7} ry={box.h * 0.8} fx={box.w * 0.12} fy={0} gradientUnits="userSpaceOnUse">
                <Stop offset="0" stopColor="#60A5FA" stopOpacity={glow ? 0.22 : 0} />
                <Stop offset="0.55" stopColor="#3B82F6" stopOpacity={glow ? 0.06 : 0} />
                <Stop offset="1" stopColor="#3B82F6" stopOpacity={0} />
              </RadialGradient>
            </Defs>
            <Rect x="0" y="0" width={box.w} height={box.h} fill={`url(#${lg})`} />
            {glow ? <Rect x="0" y="0" width={box.w} height={box.h} fill={`url(#${rg})`} /> : null}
          </Svg>
        </View>
      ) : null}
      {children}
    </View>
  );
}

export function HeroButton({ label, onPress, primary = false, icon, disabled, accessibilityLabel, haptic = 'light', testID, weight }) {
  // flex:1 fica no wrapper: PressableScale aplica `style` no Animated.View
  // interno (no web, flex:1 ali zera a altura — flex-basis 0 numa coluna).
  return (
    <View style={[styles.heroBtnWrap, weight ? { flex: weight } : primary && { flex: 1.45 }]}>
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic={haptic}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel || label}
      accessibilityState={{ disabled: !!disabled }}
      style={[
        styles.heroBtn,
        // Desabilitado = contorno sutil + texto apagado (nada de branco translúcido).
        disabled ? { borderWidth: 1, borderColor: HERO.line, backgroundColor: 'rgba(255,255,255,0.04)' }
          : primary ? { backgroundColor: '#FFFFFF' } : { borderWidth: 1, borderColor: HERO.outline },
      ]}
    >
      {icon || null}
      <Text style={[styles.heroBtnText, { color: disabled ? HERO.faint : (primary ? '#000000' : HERO.text) }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>{label}</Text>
    </PressableScale>
    </View>
  );
}

// Número com contagem animada. `format(n)` devolve a string exibida.
export function AnimatedNumber({ value, format, style, duration = 650, numberOfLines = 1, ...rest }) {
  const fmt = format || ((n) => String(Math.round(n)));
  const [shown, setShown] = useState(typeof value === 'number' ? 0 : value);
  const fromRef = useRef(0);
  const rafRef = useRef(0);
  useEffect(() => {
    if (typeof value !== 'number' || !isFinite(value)) { setShown(value); return undefined; }
    const from = typeof fromRef.current === 'number' ? fromRef.current : 0;
    fromRef.current = value;
    if (from === value || isReduceMotionEnabled() || typeof requestAnimationFrame !== 'function') { setShown(value); return undefined; }
    const t0 = Date.now();
    const step = () => {
      const p = Math.min(1, (Date.now() - t0) / duration);
      const e = 1 - Math.pow(1 - p, 3);
      setShown(from + (value - from) * e);
      if (p < 1) rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => { try { cancelAnimationFrame(rafRef.current); } catch {} };
  }, [value, duration]);
  const txt = typeof shown === 'number' ? fmt(Math.round(shown)) : (shown == null ? '—' : String(shown));
  return <Text style={[TABULAR, style]} numberOfLines={numberOfLines} {...rest}>{txt}</Text>;
}

export function DiamondMark({ size = 28, halo = true }) {
  const id = useGradId('wdm');
  const box = Math.round(size * 1.7);
  return (
    <View style={{ width: box, height: box, alignItems: 'center', justifyContent: 'center' }} accessible={false} importantForAccessibility="no-hide-descendants">
      {halo ? (
        <Svg style={StyleSheet.absoluteFill} width={box} height={box} pointerEvents="none">
          <Defs>
            <RadialGradient id={id} cx="50%" cy="50%" r="50%">
              <Stop offset="0" stopColor="#60A5FA" stopOpacity={0.38} />
              <Stop offset="1" stopColor="#60A5FA" stopOpacity={0} />
            </RadialGradient>
          </Defs>
          <Circle cx={box / 2} cy={box / 2} r={box / 2} fill={`url(#${id})`} />
        </Svg>
      ) : null}
      <IconDiamond size={size} />
    </View>
  );
}

export function ProgressBar({ progress = 0, color, track, height = 6, label }) {
  const p = Math.max(0, Math.min(1, Number(progress) || 0));
  return (
    <View
      style={{ height, borderRadius: height / 2, overflow: 'hidden', backgroundColor: track }}
      accessibilityRole="progressbar"
      accessibilityLabel={label}
      accessibilityValue={{ min: 0, max: 100, now: Math.round(p * 100) }}
    >
      <View style={{ height, borderRadius: height / 2, width: `${p > 0 ? Math.max(p * 100, 3) : 0}%`, backgroundColor: color }} />
    </View>
  );
}

// ── Ícones de transação (traço 1.6, 24×24) ────────────────────────────────
const G = {
  // compra: sacola
  purchase: 'M6 8h12l-1 12H7L6 8Z M9 8V6.5a3 3 0 0 1 6 0V8',
  // presente
  gift: 'M4 10h16v3.5H4z M5.5 13.5V20h13v-6.5 M12 10v10 M12 10c-1.6-3.2-5.5-3.6-5.5-1.3C6.5 10 9.2 10 12 10Zm0 0c1.6-3.2 5.5-3.6 5.5-1.3C17.5 10 14.8 10 12 10Z',
  // saque: banco
  cashout: 'M4 10 12 5l8 5 M5.5 10v7 M10 10v7 M14 10v7 M18.5 10v7 M4 19.5h16',
  // conversão: setas trocando
  convert: 'M7 7h11l-3-3 M17 17H6l3 3',
  // estorno: seta de volta
  refund: 'M9 7 5 11l4 4 M5 11h9a5 5 0 0 1 0 10h-2',
  // promoção / bônus: brilho
  promo: 'M12 4l1.6 4.4L18 10l-4.4 1.6L12 16l-1.6-4.4L6 10l4.4-1.6L12 4Z M18.5 16.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6.6-1.4Z',
  // genérico: setas
  transfer: 'M7 17 17 7 M9 7h8v8',
  // vazio: recibo
  receipt: 'M6 3.5h12v17l-2-1.3-2 1.3-2-1.3-2 1.3-2-1.3-2 1.3v-17Z M9 8h6 M9 11.5h6 M9 15h3.5',
};
export function txCategory(kind) {
  const k = String(kind || '');
  if (k === 'topup' || k === 'purchase') return 'purchase';
  if (/refund|reversal/.test(k)) return 'refund';
  if (k === 'cashout') return 'cashout';
  if (k === 'legacy_convert') return 'convert';
  if (k === 'promote' || k === 'bonus' || k === 'promo') return 'promo';
  if (/gift|tip|react/.test(k)) return 'gift';
  return 'transfer';
}
export function TxGlyph({ kind, name, size = 20, color, strokeWidth = 1.6 }) {
  const d = G[name || txCategory(kind)] || G.transfer;
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
      <Path d={d} />
    </Svg>
  );
}

// `inset` = recuo lateral dentro do ScrollView (o pai sangra até a borda da
// tela); `fadeColor` = cor do fundo p/ o esmaecido da borda direita, que some
// quando a lista chega ao fim (nada de pílula "cortada" seca na borda).
export function FilterChips({ options, value, onChange, s, inset = 0, fadeColor }) {
  const [atEnd, setAtEnd] = useState(false);
  const [overflow, setOverflow] = useState(false);
  const wRef = useRef(0);
  const cRef = useRef(0);
  const fid = useGradId('wcf');
  const sync = (x) => {
    const over = cRef.current > wRef.current + 1;
    setOverflow(over);
    setAtEnd(!over || x + wRef.current >= cRef.current - 4);
  };
  const xRef = useRef(0);
  const bg = fadeColor || s.bgGrouped || s.bg;
  return (
    <View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={[styles.chips, { paddingLeft: inset, paddingRight: inset }]}
        accessibilityRole="tablist"
        onLayout={(e) => { wRef.current = e.nativeEvent.layout.width; sync(xRef.current); }}
        onContentSizeChange={(w) => { cRef.current = w; sync(xRef.current); }}
        onScroll={(e) => { xRef.current = e.nativeEvent.contentOffset.x; sync(xRef.current); }}
        scrollEventThrottle={32}
      >
        {options.map((o) => {
          const sel = o.value === value;
          return (
            <PressableScale
              key={o.value}
              haptic="select"
              onPress={() => onChange(o.value)}
              accessibilityRole="tab"
              accessibilityState={{ selected: sel }}
              style={[styles.chip, sel ? { backgroundColor: s.ink, borderColor: s.ink } : { backgroundColor: 'transparent', borderColor: s.separator }]}
            >
              <Text style={[styles.chipText, { color: sel ? s.onInk : s.text }]} numberOfLines={1}>{o.label}</Text>
            </PressableScale>
          );
        })}
      </ScrollView>
      {overflow && !atEnd && bg ? (
        <View pointerEvents="none" style={styles.chipFade}>
          <Svg width="100%" height="100%" preserveAspectRatio="none" viewBox="0 0 40 10">
            <Defs>
              <LinearGradient id={fid} x1="0" y1="0" x2="1" y2="0">
                <Stop offset="0" stopColor={bg} stopOpacity={0} />
                <Stop offset="1" stopColor={bg} stopOpacity={1} />
              </LinearGradient>
            </Defs>
            <Rect x="0" y="0" width="40" height="10" fill={`url(#${fid})`} />
          </Svg>
        </View>
      ) : null}
    </View>
  );
}

// Cartão de pacote. `width` fixo no carrossel; flex na grade.
export function PackCard({ pack, s, t, language, price, soon, disabled, loading, onPress, width, highlight, badge }) {
  const unit = tr(t, 'wallet.diamondsLabel', 'diamantes');
  const label = `${formatInt(pack.diamonds, language)} ${unit}${pack.bonusPct > 0 ? ', ' + tr(t, 'wallet.topupBonus', 'Bônus +{p}%').replace('{p}', String(pack.bonusPct)) : ''}, ${soon ? tr(t, 'common.comingSoon', 'Em breve') : price}`;
  return (
    <PressableScale
      onPress={onPress}
      disabled={disabled}
      haptic="medium"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      style={[
        styles.pack,
        width ? { width } : null,
        { backgroundColor: s.surface, borderColor: highlight ? s.ink : s.border, borderWidth: highlight ? 1.5 : (s.isDark ? 1 : StyleSheet.hairlineWidth) },
        !s.isDark && Platform.OS !== 'android' ? { shadowColor: '#000', shadowOpacity: 0.05, shadowRadius: 10, shadowOffset: { width: 0, height: 3 } } : null,
        disabled && !loading ? { opacity: soon ? 0.6 : 0.5 } : null,
      ]}
    >
      <View style={styles.packTop}>
        <DiamondMark size={26} />
        {pack.bonusPct > 0 ? (
          <View style={[styles.badge, { backgroundColor: s.fill }]}>
            <Text style={[styles.badgeText, { color: s.text }]}>{`+${pack.bonusPct}%`}</Text>
          </View>
        ) : null}
      </View>
      <Text style={[styles.packN, TABULAR, { color: s.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>{formatInt(pack.diamonds, language)}</Text>
      <Text style={[Type.caption, { color: s.textSecondary }]} numberOfLines={1}>{badge || unit}</Text>
      <View style={[styles.priceBtn, soon || disabled ? { backgroundColor: s.fill } : { backgroundColor: s.ink }]}>
        {loading ? <ActivityIndicator size="small" color={s.onInk} /> : (
          <Text style={[styles.priceText, TABULAR, { color: soon || disabled ? s.textSecondary : s.onInk }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
            {soon ? tr(t, 'common.comingSoon', 'Em breve') : (price || '—')}
          </Text>
        )}
      </View>
    </PressableScale>
  );
}

const styles = StyleSheet.create({
  hero: { borderRadius: 22, overflow: 'hidden', padding: Space.xl, paddingTop: Space.lg },
  heroLight: Platform.select({
    web: { boxShadow: '0 10px 30px rgba(0,0,0,0.18)' },
    ios: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 18, shadowOffset: { width: 0, height: 8 } },
    default: { elevation: 6 },
  }),
  heroDark: { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.14)' },
  heroBg: { borderRadius: 22, overflow: 'hidden' },
  heroBtnWrap: { flex: 1, minWidth: 0 },
  heroBtn: { height: 48, borderRadius: 24, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, paddingHorizontal: Space.sm },
  heroBtnText: { fontSize: 15, fontWeight: '700', letterSpacing: -0.1 },
  chips: { gap: Space.sm, paddingVertical: 2 },
  chipFade: { position: 'absolute', right: 0, top: 0, bottom: 0, width: 40 },
  chip: { height: 34, paddingHorizontal: 14, borderRadius: 17, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  chipText: { fontSize: 14, fontWeight: '600' },
  pack: { borderRadius: Radius.card + 4, padding: Space.md, paddingTop: Space.sm, minHeight: 170 },
  packTop: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', marginLeft: -6 },
  badge: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3, marginTop: 8 },
  badgeText: { fontSize: 11, fontWeight: '800', letterSpacing: 0.2 },
  packN: { fontSize: 24, lineHeight: 28, fontWeight: '800', letterSpacing: -0.6, marginTop: 2 },
  priceBtn: { marginTop: Space.md, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', paddingHorizontal: Space.sm },
  priceText: { fontSize: 14, fontWeight: '700' },
});
