/**
 * LiveHostControls — chrome da tela do HOST enquanto está AO VIVO
 * ([2026-10-17 live-host-redesign], ticket 20261017-123242-8ff182).
 *
 * Antes: top bar em uma linha só (avatar + AO VIVO + "0 assisti…" + sinal +
 * timer + stop) com o título desenhado POR CIMA da pílula de espectadores;
 * trilho direito recolhido atrás de um chevron escondido sob as pílulas
 * "Convidados"/"Batalha" (absolutas) + ~10 ícones sem rótulo; o "virar
 * câmera" era um glifo feio que o founder não achava.
 *
 * Agora (layout em flex, nada de posições chutadas):
 *   • LiveHostTopBar — linha 1: cápsula de vidro (avatar + nome + título
 *     empilhados) · espaço · botão encerrar. Linha 2: selo AO VIVO + tempo ·
 *     cápsula de números (olho, coração, sinal) · top fãs / Q&A à direita.
 *     Linhas extras (ex.: multistream) entram como children, no fluxo.
 *   • LiveHostRail — no máx. 5 ações com rótulo: Virar câmera (1º), Efeitos,
 *     Convidados, Batalha, Mais.
 *   • LiveHostMoreSheet — grade de blocos rotulados p/ o resto (filtro,
 *     beleza, replay, fixar, enquete, lanterna, estatísticas, config…).
 *     É uma View sobreposta (NÃO Modal) → nunca Modal sobre Modal no iOS.
 *   • LiveGlassCircle — círculo de vidro 44pt usado no compositor de baixo.
 *
 * Vidro: iOS = UIVisualEffectView via getNativeBlurView (com guarda de
 * binário); Android/sem módulo = fumê sólido; web = backdrop-filter.
 * Ícones: SVG (components/Icons), traço único 1.9. Sem emoji.
 * Movimento: respeita Reduzir Movimento (constants/motion).
 */
import { memo, useEffect, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, Animated, ScrollView,
} from 'react-native';
import AvatarCircle from '../AvatarCircle';
import { getNativeBlurView } from '../NativeBlur';
import { IconEye, IconHeart, IconX } from '../Icons';
import { timingTo, useReducedMotion } from '../../constants/motion';
import { useEngageSelector, selLikesTotal } from './liveEngageStore';
import { LiveTopFansStack } from './LiveTopFans';
import { LiveQAButton } from './LiveEngageLayer';

const IS_WEB = Platform.OS === 'web';
export const LIVE_HOST_STROKE = 1.9;
const LIVE_DOT_RED = '#ef4444';

// t() devolve a CHAVE crua quando falta tradução → `t(k) || fb` nunca cai
// no fallback. Este helper cai.
export function trLive(t, key, fb, params) {
  try {
    const s = t ? t(key, params) : null;
    if (typeof s === 'string' && s && s !== key) return s;
  } catch {}
  return fb;
}

export function formatCompact(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(num % 1_000_000 === 0 ? 0 : 1)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(num % 1000 === 0 ? 0 : 1)}K`;
  return String(num);
}

// ── Vidro ──────────────────────────────────────────────────────────────────
export function LiveGlass({ style, children, intensity = 40, tintOpacity = 0.26, solid = 'rgba(20,20,20,0.62)', active = false, pointerEvents }) {
  const BlurView = active ? null : getNativeBlurView();
  return (
    <View
      pointerEvents={pointerEvents}
      style={[
        styles.glassBase,
        active ? styles.glassActive : (!BlurView && !IS_WEB ? { backgroundColor: solid } : null),
        style,
      ]}
    >
      {BlurView ? (
        <BlurView intensity={intensity} tint="systemUltraThinMaterialDark" style={StyleSheet.absoluteFillObject} pointerEvents="none">
          <View style={[StyleSheet.absoluteFillObject, { backgroundColor: `rgba(0,0,0,${tintOpacity})` }]} />
        </BlurView>
      ) : null}
      {children}
    </View>
  );
}

// Círculo de vidro 44pt (compositor de baixo). `active` = fundo branco,
// ícone deve vir preto (o chamador decide a cor).
export const LiveGlassCircle = memo(function LiveGlassCircle({ onPress, onLongPress, label, children, active = false, size = 44, selected, disabled }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      onLongPress={onLongPress}
      delayLongPress={onLongPress ? 220 : undefined}
      activeOpacity={0.75}
      disabled={disabled}
      hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={selected != null ? { selected: !!selected } : undefined}
    >
      <LiveGlass active={active} style={{ width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </LiveGlass>
    </TouchableOpacity>
  );
});

// ── Sinal (3 barras) ───────────────────────────────────────────────────────
function SignalBars({ quality }) {
  const active = quality === 'good' ? 3 : quality === 'medium' ? 2 : 1;
  const on = quality === 'poor' ? LIVE_DOT_RED : '#fff';
  return (
    <View style={styles.bars}>
      {[0, 1, 2].map((i) => (
        <View key={i} style={[styles.bar, { height: 5 + i * 3, backgroundColor: i < active ? on : 'rgba(255,255,255,0.28)' }]} />
      ))}
    </View>
  );
}

// ── Top bar ────────────────────────────────────────────────────────────────
export const LiveHostTopBar = memo(function LiveHostTopBar({
  t,
  paddingTop = 0,
  hostName,
  hostEmail,
  title,
  durationText,
  viewerCount = 0,
  totalLikes = 0,
  quality = 'good',
  livePulse,          // Animated.Value 1→1.5 (opcional) p/ o ponto do selo
  engage = null,
  onPressStats,
  onEnd,
  children,
}) {
  const reduce = useReducedMotion();
  const hubLikes = useEngageSelector(engage, selLikesTotal);
  const likes = Math.max(Number(totalLikes) || 0, Number(hubLikes) || 0);
  const name = hostName || '';
  const liveLabel = trLive(t, 'liveHost.live', 'AO VIVO');
  const qualityLabel = quality === 'good' ? trLive(t, 'liveHost.signalGood', 'Conexão boa')
    : quality === 'medium' ? trLive(t, 'liveHost.signalMedium', 'Conexão média')
    : trLive(t, 'liveHost.signalPoor', 'Conexão ruim');
  const dotStyle = livePulse && !reduce ? {
    opacity: livePulse.interpolate({ inputRange: [1, 1.5], outputRange: [1, 0.35] }),
  } : null;

  return (
    <View style={[styles.topWrap, { paddingTop: paddingTop + 6 }]} pointerEvents="box-none">
      {/* Linha 1 — identidade · encerrar */}
      <View style={styles.row1} pointerEvents="box-none">
        <LiveGlass style={styles.hostCapsule}>
          <View style={styles.avatarRing}>
            <AvatarCircle name={name || hostEmail} email={hostEmail} size={34} />
          </View>
          <View style={styles.hostText}>
            <Text style={styles.hostName} numberOfLines={1}>{name || '…'}</Text>
            {title ? <Text style={styles.hostTitle} numberOfLines={1}>{title}</Text> : null}
          </View>
        </LiveGlass>
        <View style={styles.flex} pointerEvents="none" />
        <TouchableOpacity
          onPress={onEnd}
          activeOpacity={0.8}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
          accessibilityRole="button"
          accessibilityLabel={trLive(t, 'liveHost.end', 'Encerrar live')}
          style={styles.endBtn}
        >
          <IconX size={20} color="#000" strokeWidth={2.2} />
        </TouchableOpacity>
      </View>

      {/* Linha 2 — AO VIVO + tempo · números · top fãs / Q&A */}
      <View style={styles.row2} pointerEvents="box-none">
        <View style={styles.livePill} accessibilityLabel={`${liveLabel} ${durationText || ''}`}>
          <Animated.View style={[styles.liveDot, dotStyle]} />
          <Text style={styles.livePillText} numberOfLines={1}>{liveLabel}</Text>
          {durationText ? <Text style={styles.livePillTime} numberOfLines={1}>{durationText}</Text> : null}
        </View>
        <TouchableOpacity
          onPress={onPressStats}
          activeOpacity={0.75}
          accessibilityRole="button"
          accessibilityLabel={`${trLive(t, 'liveHost.viewers', 'Espectadores')} ${viewerCount}, ${trLive(t, 'liveHost.likes', 'Curtidas')} ${likes}, ${qualityLabel}`}
        >
          <LiveGlass style={styles.statsCapsule}>
            <IconEye size={13} color="#fff" strokeWidth={LIVE_HOST_STROKE} />
            <Text style={styles.statText}>{formatCompact(viewerCount)}</Text>
            <View style={styles.statSep} />
            <IconHeart size={12} color="#fff" />
            <Text style={styles.statText}>{formatCompact(likes)}</Text>
            <View style={styles.statSep} />
            <SignalBars quality={quality} />
          </LiveGlass>
        </TouchableOpacity>
        <View style={styles.flex} pointerEvents="none" />
        {engage ? <LiveTopFansStack engage={engage} size={24} /> : null}
        {engage ? <LiveQAButton engage={engage} size={32} iconSize={16} /> : null}
      </View>

      {children}
    </View>
  );
});

// ── Trilho direito ─────────────────────────────────────────────────────────
export const LiveRailButton = memo(function LiveRailButton({ icon, label, onPress, active = false, disabled = false, badge = null, a11yLabel }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.75}
      style={[styles.railItem, disabled && { opacity: 0.5 }]}
      hitSlop={{ top: 2, bottom: 2, left: 8, right: 8 }}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel || label}
      accessibilityState={{ selected: !!active, disabled: !!disabled }}
    >
      <View>
        <LiveGlass active={active} style={styles.railCircle}>
          {typeof icon === 'function' ? icon(active ? '#000' : '#fff') : icon}
        </LiveGlass>
        {badge != null && badge !== false ? (
          <View style={styles.badge}>
            {badge === true ? null : <Text style={styles.badgeText}>{badge}</Text>}
          </View>
        ) : null}
      </View>
      <Text style={styles.railLabel} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
});

export function LiveHostRail({ top, children }) {
  return (
    <View style={[styles.rail, { top }]} pointerEvents="box-none">
      {children}
    </View>
  );
}

// ── "Mais" — grade de blocos rotulados ─────────────────────────────────────
// items: [{ key, label, icon: (color) => node, onPress, active, keepOpen, hidden }]
export function LiveHostMoreSheet({ visible, onClose, title, items = [], bottomInset = 0, closeLabel }) {
  const reduce = useReducedMotion();
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) { anim.setValue(0); return; }
    if (reduce) { anim.setValue(1); return; }
    timingTo(anim, 1, 'base').start();
  }, [visible, reduce, anim]);
  if (!visible) return null;
  const list = items.filter((it) => it && !it.hidden);
  return (
    <View style={styles.sheetRoot}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.sheetBackdrop, { opacity: anim }]}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} accessibilityRole="button" accessibilityLabel={closeLabel} />
      </Animated.View>
      <Animated.View
        style={{
          opacity: anim,
          transform: [{ translateY: anim.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }],
        }}
      >
        <LiveGlass intensity={60} tintOpacity={0.45} solid="rgba(16,16,16,0.94)" style={[styles.sheet, { paddingBottom: bottomInset + 16 }]}>
          <View style={styles.grabber} />
          <View style={styles.sheetHead}>
            <Text style={styles.sheetTitle}>{title}</Text>
            <TouchableOpacity onPress={onClose} style={styles.sheetClose} hitSlop={8} accessibilityRole="button" accessibilityLabel={closeLabel}>
              <IconX size={18} color="#fff" strokeWidth={LIVE_HOST_STROKE} />
            </TouchableOpacity>
          </View>
          <ScrollView bounces={false} contentContainerStyle={styles.grid} showsVerticalScrollIndicator={false}>
            {list.map((it) => (
              <TouchableOpacity
                key={it.key}
                style={styles.tile}
                activeOpacity={0.75}
                onPress={() => {
                  if (!it.keepOpen) onClose?.();
                  try { it.onPress?.(); } catch {}
                }}
                accessibilityRole="button"
                accessibilityLabel={it.label}
                accessibilityState={it.active != null ? { selected: !!it.active } : undefined}
              >
                <View style={[styles.tileIcon, it.active && styles.tileIconActive]}>
                  {it.icon ? it.icon(it.active ? '#000' : '#fff') : null}
                </View>
                <Text style={styles.tileLabel} numberOfLines={2}>{it.label}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        </LiveGlass>
      </Animated.View>
    </View>
  );
}

const textShadow = IS_WEB
  ? { textShadow: '0 1px 3px rgba(0,0,0,0.65)' }
  : { textShadowColor: 'rgba(0,0,0,0.65)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 };

const styles = StyleSheet.create({
  flex: { flex: 1 },
  glassBase: {
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.2)',
    ...(IS_WEB ? {
      backgroundColor: 'rgba(20,20,20,0.42)',
      backdropFilter: 'blur(20px) saturate(140%)', WebkitBackdropFilter: 'blur(20px) saturate(140%)',
    } : {}),
  },
  glassActive: { backgroundColor: '#fff', borderColor: '#fff' },

  // Top bar
  topWrap: {
    position: 'absolute', top: 0, left: 0, right: 0,
    paddingHorizontal: 12,
    zIndex: 20,
  },
  row1: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hostCapsule: {
    flexDirection: 'row', alignItems: 'center',
    height: 46, borderRadius: 23,
    paddingLeft: 5, paddingRight: 14,
    gap: 9,
    flexShrink: 1,
    maxWidth: '78%',
  },
  avatarRing: {
    width: 38, height: 38, borderRadius: 19,
    borderWidth: 2, borderColor: LIVE_DOT_RED,
    alignItems: 'center', justifyContent: 'center',
  },
  hostText: { flexShrink: 1, justifyContent: 'center' },
  hostName: { color: '#fff', fontSize: 14, fontWeight: '700', letterSpacing: 0.1 },
  hostTitle: { color: 'rgba(255,255,255,0.78)', fontSize: 12, fontWeight: '500', marginTop: 1 },
  endBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    ...(IS_WEB ? { boxShadow: '0 2px 10px rgba(0,0,0,0.35)' } : {
      shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 4,
    }),
  },
  row2: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 8, minHeight: 32 },
  livePill: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    height: 26, paddingHorizontal: 9, borderRadius: 13,
    backgroundColor: LIVE_DOT_RED,
  },
  liveDot: { width: 6, height: 6, borderRadius: 3, backgroundColor: '#fff' },
  livePillText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.6 },
  livePillTime: {
    color: '#fff', fontSize: 11, fontWeight: '600', marginLeft: 2,
    fontVariant: ['tabular-nums'],
  },
  statsCapsule: {
    flexDirection: 'row', alignItems: 'center', gap: 5,
    height: 26, paddingHorizontal: 10, borderRadius: 13,
  },
  statText: { color: '#fff', fontSize: 12, fontWeight: '700', fontVariant: ['tabular-nums'] },
  statSep: { width: StyleSheet.hairlineWidth, height: 12, backgroundColor: 'rgba(255,255,255,0.35)', marginHorizontal: 3 },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 2, height: 11 },
  bar: { width: 3, borderRadius: 1.5 },

  // Rail
  rail: {
    position: 'absolute', right: 8,
    alignItems: 'center', gap: 10,
    zIndex: 15,
  },
  railItem: { alignItems: 'center', width: 64 },
  railCircle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  railLabel: {
    color: '#fff', fontSize: 11, fontWeight: '600', marginTop: 4,
    textAlign: 'center', maxWidth: 64,
    ...textShadow,
  },
  badge: {
    position: 'absolute', top: -3, right: -3,
    minWidth: 16, height: 16, borderRadius: 8, paddingHorizontal: 4,
    backgroundColor: LIVE_DOT_RED,
    borderWidth: 1.5, borderColor: '#000',
    alignItems: 'center', justifyContent: 'center',
  },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '800', fontVariant: ['tabular-nums'] },

  // Sheet
  sheetRoot: { ...StyleSheet.absoluteFillObject, zIndex: 60, justifyContent: 'flex-end' },
  sheetBackdrop: { backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: {
    borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
    paddingHorizontal: 12, paddingTop: 8,
    maxHeight: 520,
  },
  grabber: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.32)', marginBottom: 6 },
  sheetHead: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 6, paddingBottom: 8 },
  sheetTitle: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '700' },
  sheetClose: {
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.12)',
    alignItems: 'center', justifyContent: 'center',
  },
  grid: { flexDirection: 'row', flexWrap: 'wrap', paddingBottom: 4 },
  tile: { width: '25%', alignItems: 'center', paddingVertical: 10, paddingHorizontal: 2 },
  tileIcon: {
    width: 52, height: 52, borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center', justifyContent: 'center',
  },
  tileIconActive: { backgroundColor: '#fff', borderColor: '#fff' },
  tileLabel: { color: 'rgba(255,255,255,0.9)', fontSize: 11.5, fontWeight: '500', marginTop: 6, textAlign: 'center', lineHeight: 14 },
});
