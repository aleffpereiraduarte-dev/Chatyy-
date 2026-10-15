// [2026-10-15 bia-design] Peças de interface da Bia (nível ChatGPT/Gemini, P&B).
//
//   BiaFadeIn          entrada fade+subida com atraso (cascata); Reduzir Movimento → sem animação
//   BiaShimmerText     texto do passo atual com brilho passando (shimmer)
//   BiaPressScale      toque com leve encolhimento (spring, native driver)
//   BiaSuggestionGrid  grade 2 colunas de cartões de sugestão com ícone
//   BiaComposer        barra de entrada flutuante de vidro: anexar, ditado (vira onda), enviar/voz (morph)
//   BiaMessageActions  copiar · ouvir · regenerar · compartilhar · curtir/descurtir (aparecem suaves)
//   BiaHistoryDrawer   gaveta lateral com busca + agrupamento por data
//   BiaVoiceScreen     modo voz em tela cheia: orb grande reagindo ao volume + legenda ao vivo
//
// Tudo com ícones SVG (components/Icons) — sem emoji. Animações em native driver.
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Pressable, Animated, Easing, Platform, StyleSheet,
  Modal, SectionList, Image, ScrollView, Dimensions,
} from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import {
  IconPlus, IconMic, IconStop, IconX, IconCopy, IconCheck, IconVolume2, IconVolumeX, IconRepeat,
  IconShare, IconSearch, IconTrash, IconEdit, IconMessageSquare,
} from '../Icons';
import { useReducedMotion, isReduceMotionEnabled } from '../reducedMotion';
import { getNativeBlurView } from '../NativeBlur';
import BiaOrb from './BiaOrb';

const ND = Platform.OS !== 'web';

export function biaPalette(isDark) {
  return isDark ? {
    bg: '#000000', fg: '#F2F2F4', sub: '#A1A1A6', faint: '#6C6C70', hair: 'rgba(255,255,255,0.10)',
    card: '#111113', cardHi: '#18181B', chip: 'rgba(255,255,255,0.07)', bubble: '#1C1C1E',
    glass: 'rgba(28,28,30,0.72)', glassSolid: 'rgba(22,22,24,0.97)', ink: '#FFFFFF', onInk: '#000000',
  } : {
    bg: '#FFFFFF', fg: '#0D0D0D', sub: '#6B7280', faint: '#A3A3AA', hair: 'rgba(0,0,0,0.08)',
    card: '#F6F6F8', cardHi: '#EEEEF1', chip: 'rgba(0,0,0,0.045)', bubble: '#F2F2F4',
    glass: 'rgba(255,255,255,0.74)', glassSolid: 'rgba(255,255,255,0.97)', ink: '#0D0D0D', onInk: '#FFFFFF',
  };
}

export function softShadow(isDark, level = 1) {
  if (Platform.OS === 'web') {
    return { boxShadow: isDark ? `0 ${2 * level}px ${14 * level}px rgba(0,0,0,0.5)` : `0 ${2 * level}px ${16 * level}px rgba(16,16,24,${0.06 * level + 0.02})` };
  }
  return { shadowColor: '#000', shadowOpacity: isDark ? 0.4 : 0.07 + 0.02 * level, shadowRadius: 10 * level, shadowOffset: { width: 0, height: 3 * level }, elevation: level * 2 };
}

// ─── entrada em cascata ──────────────────────────────────────────────────────
export function BiaFadeIn({ delay = 0, dy = 10, duration = 420, style, children }) {
  const rm = isReduceMotionEnabled();
  const v = useRef(new Animated.Value(rm ? 1 : 0)).current;
  useEffect(() => {
    if (rm) return undefined;
    const a = Animated.timing(v, { toValue: 1, duration, delay, easing: Easing.bezier(0.2, 0.8, 0.2, 1), useNativeDriver: ND });
    a.start();
    return () => a.stop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const ty = v.interpolate({ inputRange: [0, 1], outputRange: [dy, 0] });
  return <Animated.View style={[style, { opacity: v, transform: [{ translateY: ty }] }]}>{children}</Animated.View>;
}

// ─── toque com escala ────────────────────────────────────────────────────────
export function BiaPressScale({ onPress, onLongPress, style, children, scaleTo = 0.965, disabled, accessibilityLabel, accessibilityRole = 'button', accessibilityHint, hitSlop }) {
  const s = useRef(new Animated.Value(1)).current;
  const go = (to) => { if (isReduceMotionEnabled()) return; Animated.spring(s, { toValue: to, tension: 320, friction: 18, useNativeDriver: ND }).start(); };
  return (
    <Pressable
      onPress={onPress} onLongPress={onLongPress} disabled={disabled} hitSlop={hitSlop}
      onPressIn={() => go(scaleTo)} onPressOut={() => go(1)}
      accessibilityRole={accessibilityRole} accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint}
      style={Platform.OS === 'web' ? { cursor: disabled ? 'default' : 'pointer' } : undefined}
    >
      <Animated.View style={[style, { transform: [{ scale: s }] }]}>{children}</Animated.View>
    </Pressable>
  );
}

// ─── shimmer ─────────────────────────────────────────────────────────────────
const SHIMMER_CSS = `
.bia-shimmer{background-image:linear-gradient(100deg,var(--c1) 0%,var(--c1) 38%,var(--c2) 50%,var(--c1) 62%,var(--c1) 100%);background-size:250% 100%;-webkit-background-clip:text;background-clip:text;color:transparent!important;-webkit-text-fill-color:transparent;animation:bia-shimmer 1.7s linear infinite}
@keyframes bia-shimmer{from{background-position:100% 0}to{background-position:-150% 0}}
@media (prefers-reduced-motion: reduce){.bia-shimmer{animation:none;color:var(--c1)!important;-webkit-text-fill-color:var(--c1)}}
`;
let _shimInjected = false;
function injectShimmer() {
  if (_shimInjected || typeof document === 'undefined') return;
  _shimInjected = true;
  try { const el = document.createElement('style'); el.textContent = SHIMMER_CSS; document.head.appendChild(el); } catch {}
}

export const BiaShimmerText = memo(function BiaShimmerText({ text, isDark, style }) {
  const rm = useReducedMotion();
  const base = isDark ? '#7C7C82' : '#8E8E95';
  const hi = isDark ? '#FFFFFF' : '#0D0D0D';
  const [w, setW] = useState(0);
  const x = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (Platform.OS === 'web' || rm || !w) return undefined;
    x.setValue(0);
    const a = Animated.loop(Animated.timing(x, { toValue: 1, duration: 1700, easing: Easing.inOut(Easing.quad), useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [w, rm, x]);
  if (Platform.OS === 'web') {
    injectShimmer();
    return (
      <Text style={style} accessibilityLiveRegion="polite">
        {React.createElement('span', { className: 'bia-shimmer', style: { '--c1': base, '--c2': hi } }, text)}
      </Text>
    );
  }
  const band = Math.max(26, w * 0.32);
  const tx = x.interpolate({ inputRange: [0, 1], outputRange: [-band, w] });
  const ntx = x.interpolate({ inputRange: [0, 1], outputRange: [band, -w] });
  return (
    <View style={{ alignSelf: 'flex-start' }} accessibilityLiveRegion="polite" accessible accessibilityLabel={text}>
      <Text style={[style, { color: base }]} numberOfLines={1} onLayout={(e) => setW(Math.ceil(e.nativeEvent.layout.width))}>{text}</Text>
      {w > 0 && !rm ? (
        <Animated.View pointerEvents="none" style={{ position: 'absolute', top: 0, bottom: 0, left: 0, width: band, overflow: 'hidden', transform: [{ translateX: tx }] }}>
          <Animated.View style={{ width: w, transform: [{ translateX: ntx }] }}>
            <Text style={[style, { color: hi }]} numberOfLines={1}>{text}</Text>
          </Animated.View>
        </Animated.View>
      ) : null}
    </View>
  );
});

// ─── ícones desenhados (seta enviar / onda de voz) ──────────────────────────
export function GlyphArrowUp({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" stroke={color} strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}
// polegar (contorno; preenchido quando ativo) — o IconThumbsUp do app é cheio (reação)
const THUMB_UP = 'M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3m7-2V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3H14z';
const THUMB_DOWN = 'M17 2h3a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-3m-7 2v3a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7L2.34 12.7a2 2 0 0 0 2 2.3H10z';
export function GlyphThumb({ down = false, filled = false, size = 16, color = '#000' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d={down ? THUMB_DOWN : THUMB_UP} stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill={filled ? color : 'none'} fillOpacity={filled ? 0.18 : 0} />
    </Svg>
  );
}
export function GlyphWave({ size = 18, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Rect x="3" y="9.5" width="2.4" height="5" rx="1.2" fill={color} />
      <Rect x="7.4" y="6" width="2.4" height="12" rx="1.2" fill={color} />
      <Rect x="11.8" y="3" width="2.4" height="18" rx="1.2" fill={color} />
      <Rect x="16.2" y="7" width="2.4" height="10" rx="1.2" fill={color} />
      <Rect x="20.6" y="10" width="2.4" height="4" rx="1.2" fill={color} />
    </Svg>
  );
}

// barras animadas (ditado ativo)
function MicWave({ color }) {
  const bars = useRef([0, 1, 2, 3].map(() => new Animated.Value(0.3))).current;
  useEffect(() => {
    if (isReduceMotionEnabled()) return undefined;
    const loops = bars.map((b, i) => Animated.loop(Animated.sequence([
      Animated.timing(b, { toValue: 1, duration: 260 + i * 70, easing: Easing.inOut(Easing.quad), useNativeDriver: ND }),
      Animated.timing(b, { toValue: 0.3, duration: 260 + i * 70, easing: Easing.inOut(Easing.quad), useNativeDriver: ND }),
    ])));
    loops.forEach((l, i) => setTimeout(() => l.start(), i * 90));
    return () => loops.forEach(l => l.stop());
  }, [bars]);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 2.5, height: 18 }}>
      {bars.map((b, i) => <Animated.View key={i} style={{ width: 3, height: 16, borderRadius: 1.5, backgroundColor: color, transform: [{ scaleY: b }] }} />)}
    </View>
  );
}

// ─── grade de sugestões ──────────────────────────────────────────────────────
export function BiaSuggestionGrid({ items, isDark, onPick, baseDelay = 220 }) {
  const P = biaPalette(isDark);
  return (
    <View style={gs.grid}>
      {items.map((it, i) => {
        const Icon = it.icon;
        return (
          <BiaFadeIn key={it.key} delay={baseDelay + i * 55} style={gs.cell}>
            <BiaPressScale onPress={() => onPick(it)} accessibilityLabel={it.label} accessibilityHint={it.sub}
              style={[gs.card, { backgroundColor: P.card, borderColor: P.hair }]}>
              <View style={[gs.icon, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#FFFFFF' }, !isDark && softShadow(false, 0.5)]}>
                {Icon ? <Icon size={17} color={P.fg} /> : null}
              </View>
              <Text style={[gs.title, { color: P.fg }]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{it.label}</Text>
              {it.sub ? <Text style={[gs.sub, { color: P.sub }]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{it.sub}</Text> : null}
            </BiaPressScale>
          </BiaFadeIn>
        );
      })}
    </View>
  );
}
const gs = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5, alignSelf: 'stretch' },
  cell: { width: '50%', padding: 5 },
  card: { borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingTop: 14, paddingBottom: 13, minHeight: 112 },
  icon: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  title: { fontSize: 14.5, lineHeight: 19, fontWeight: '600', letterSpacing: -0.2 },
  sub: { fontSize: 12.5, lineHeight: 17, marginTop: 2 },
});

// ─── barra de entrada flutuante ──────────────────────────────────────────────
export function BiaComposer({
  isDark, t, value, onChangeText, onSend, onStop, onVoice, onMic, onAttach, listening, loading,
  attachedImage, onRemoveAttachment, onFocus, onBlur, bottomInset = 0, onHeight, maxWidth,
}) {
  const P = biaPalette(isDark);
  const has = !!(value && value.trim()) || !!attachedImage;
  const mode = loading ? 'stop' : has ? 'send' : 'voice';
  const morph = useRef(new Animated.Value(mode === 'send' ? 1 : 0)).current;
  useEffect(() => {
    if (mode === 'stop') return;
    const to = mode === 'send' ? 1 : 0;
    if (isReduceMotionEnabled()) { morph.setValue(to); return; }
    Animated.spring(morph, { toValue: to, tension: 260, friction: 20, useNativeDriver: ND }).start();
  }, [mode, morph]);
  const BlurView = getNativeBlurView();
  const webGlass = Platform.OS === 'web' ? { backdropFilter: 'saturate(180%) blur(22px)', WebkitBackdropFilter: 'saturate(180%) blur(22px)' } : null;
  const sendOp = morph;
  const voiceOp = morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0] });
  const sendSc = morph.interpolate({ inputRange: [0, 1], outputRange: [0.4, 1] });
  const voiceSc = morph.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] });
  const sendRot = morph.interpolate({ inputRange: [0, 1], outputRange: ['-90deg', '0deg'] });
  const press = () => {
    if (mode === 'stop') onStop?.();
    else if (mode === 'send') onSend?.();
    else onVoice?.();
  };
  const actionLbl = mode === 'stop' ? (t('common.cancel') || 'Cancelar') : mode === 'send' ? (t('common.send') || 'Enviar') : (t('one.voiceConversation') || 'Conversa por voz');
  return (
    <View
      pointerEvents="box-none"
      style={[cs.wrap, { paddingBottom: Math.max(bottomInset, 10) }]}
      onLayout={(e) => onHeight && onHeight(Math.round(e.nativeEvent.layout.height))}
    >
      <View style={[cs.outer, maxWidth ? { maxWidth, alignSelf: 'center', width: '100%' } : null]}>
        <View style={[cs.pill, { borderColor: P.hair }, softShadow(isDark, 1.4)]}>
          <View style={[StyleSheet.absoluteFill, { borderRadius: 28, overflow: 'hidden' }]} pointerEvents="none">
            {BlurView ? (
              <>
                <BlurView intensity={60} tint={isDark ? 'systemChromeMaterialDark' : 'systemChromeMaterialLight'} style={StyleSheet.absoluteFill} />
                <View style={[StyleSheet.absoluteFill, { backgroundColor: isDark ? 'rgba(28,28,30,0.35)' : 'rgba(255,255,255,0.35)' }]} />
              </>
            ) : Platform.OS === 'web' ? (
              // RN-web descarta backdropFilter do style → div crua com o vidro de verdade
              React.createElement('div', { style: { position: 'absolute', inset: 0, background: P.glass, ...webGlass } })
            ) : (
              <View style={[StyleSheet.absoluteFill, { backgroundColor: P.glassSolid }]} />
            )}
          </View>
          {attachedImage ? (
            <View style={cs.attachRow}>
              <View>
                <Image source={{ uri: attachedImage.uri }} style={cs.attachImg} />
                <TouchableOpacity onPress={onRemoveAttachment} style={cs.attachX} hitSlop={8} accessibilityLabel={t('common.remove') || t('common.delete') || 'Remover'}>
                  <IconX size={11} color="#fff" />
                </TouchableOpacity>
              </View>
            </View>
          ) : null}
          <View style={cs.row}>
            <TouchableOpacity onPress={onAttach} style={[cs.roundBtn, { backgroundColor: P.chip }]} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={t('one.attachPhoto') || 'Anexar'}>
              <IconPlus size={19} color={P.fg} />
            </TouchableOpacity>
            <TextInput
              style={[cs.input, { color: P.fg }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
              placeholder={listening ? (t('one.voiceListening') || 'Ouvindo...') : (t('one.placeholder') || 'Fale com a Bia...')}
              placeholderTextColor={P.faint}
              value={value}
              onChangeText={onChangeText}
              onSubmitEditing={() => onSend?.()}
              onKeyPress={(e) => {
                if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) { e.preventDefault(); onSend?.(); }
              }}
              onFocus={onFocus}
              onBlur={onBlur}
              returnKeyType="send"
              multiline
              maxLength={2000}
              editable={!loading}
              accessibilityLabel={t('one.placeholder') || 'Mensagem'}
            />
            <TouchableOpacity onPress={onMic} style={cs.micBtn} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={listening ? (t('one.speakStop') || 'Parar') : (t('one.dictate'))}>
              {listening ? <MicWave color={P.fg} /> : <IconMic size={20} color={P.sub} />}
            </TouchableOpacity>
            <BiaPressScale onPress={press} accessibilityLabel={actionLbl} scaleTo={0.9} style={[cs.action, { backgroundColor: P.ink }]}>
              {mode === 'stop' ? (
                <View style={[cs.stopSq, { backgroundColor: P.onInk }]} />
              ) : (
                <>
                  <Animated.View style={[cs.layer, { opacity: voiceOp, transform: [{ scale: voiceSc }] }]}><GlyphWave size={18} color={P.onInk} /></Animated.View>
                  <Animated.View style={[cs.layer, { opacity: sendOp, transform: [{ scale: sendSc }, { rotate: sendRot }] }]}><GlyphArrowUp size={19} color={P.onInk} /></Animated.View>
                </>
              )}
            </BiaPressScale>
          </View>
        </View>
      </View>
    </View>
  );
}
const cs = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 12, paddingTop: 8 },
  outer: {},
  pill: { borderRadius: 28, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 7, paddingVertical: 7 },
  row: { flexDirection: 'row', alignItems: 'flex-end', gap: 4 },
  roundBtn: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  input: { flex: 1, fontSize: 16.5, lineHeight: 22, minHeight: 38, maxHeight: 148, paddingHorizontal: 8, paddingTop: Platform.OS === 'ios' ? 9 : 8, paddingBottom: Platform.OS === 'ios' ? 9 : 8, textAlignVertical: 'center' },
  micBtn: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  action: { width: 38, height: 38, borderRadius: 19, alignItems: 'center', justifyContent: 'center' },
  layer: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  stopSq: { width: 12, height: 12, borderRadius: 3 },
  attachRow: { flexDirection: 'row', paddingHorizontal: 6, paddingTop: 4, paddingBottom: 8 },
  attachImg: { width: 64, height: 64, borderRadius: 14 },
  attachX: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: '#0D0D0D', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#fff' },
});

// ─── ações da resposta ───────────────────────────────────────────────────────
export const BiaMessageActions = memo(function BiaMessageActions({ item, isDark, t, onCopy, onSpeak, speaking, onRegenerate, onShare, onFeedback }) {
  const P = biaPalette(isDark);
  const [copied, setCopied] = useState(false);
  const [vote, setVote] = useState(item?._vote || 0);
  const tmr = useRef(null);
  useEffect(() => () => { if (tmr.current) clearTimeout(tmr.current); }, []);
  const doCopy = async () => {
    const ok = await onCopy?.(item);
    if (ok !== false) { setCopied(true); if (tmr.current) clearTimeout(tmr.current); tmr.current = setTimeout(() => setCopied(false), 1600); }
  };
  const doVote = (v) => { const nv = vote === v ? 0 : v; setVote(nv); if (nv) onFeedback?.(item, nv); };
  const btn = (key, label, icon, onPress, active) => (
    <TouchableOpacity key={key} onPress={onPress} hitSlop={4} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={label}
      style={[as.btn, active && { backgroundColor: P.chip }]}>
      {icon}
    </TouchableOpacity>
  );
  const c = P.sub;
  return (
    <BiaFadeIn delay={120} dy={4} duration={320} style={as.row}>
      {onCopy ? btn('copy', copied ? (t('common.copied') || 'Copiado') : (t('common.copy') || 'Copiar'), copied ? <IconCheck size={16} color={P.fg} /> : <IconCopy size={16} color={c} />, doCopy) : null}
      {onSpeak ? btn('speak', speaking ? (t('one.speakStop') || 'Parar') : (t('oneScreen.readAloud') || 'Ouvir'), speaking ? <IconVolumeX size={16} color={P.fg} /> : <IconVolume2 size={16} color={c} />, () => onSpeak(item), speaking) : null}
      {onRegenerate ? btn('regen', t('one.regenerate') || 'Regenerar', <IconRepeat size={16} color={c} />, () => onRegenerate(item)) : null}
      {onShare ? btn('share', t('common.share') || 'Compartilhar', <IconShare size={16} color={c} />, () => onShare(item)) : null}
      {onFeedback ? btn('up', t('one.goodResponse'), <GlyphThumb filled={vote === 1} color={vote === 1 ? P.fg : c} />, () => doVote(1), vote === 1) : null}
      {onFeedback ? btn('down', t('one.badResponse'), <GlyphThumb down filled={vote === -1} color={vote === -1 ? P.fg : c} />, () => doVote(-1), vote === -1) : null}
    </BiaFadeIn>
  );
});
const as = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 2, marginTop: 8, marginLeft: -6 },
  btn: { width: 34, height: 34, borderRadius: 17, alignItems: 'center', justifyContent: 'center' },
});

// ─── gaveta de histórico ─────────────────────────────────────────────────────
function convTime(c) {
  const raw = c?.updated_at || c?.created_at;
  if (!raw) return NaN;
  let s = String(raw).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z';
  s = s.replace(/([+-]\d{2})$/, '$1:00');
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

export function groupConversations(conversations, t, query) {
  const q = (query || '').trim().toLowerCase();
  const list = (conversations || []).filter(c => !q || String(c.title || '').toLowerCase().includes(q));
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  const buckets = [
    { key: 'today', title: t('common.today') || 'Hoje', min: startToday, data: [] },
    { key: 'yest', title: t('common.yesterday') || 'Ontem', min: startToday - DAY, data: [] },
    { key: 'w', title: t('one.histLast7') || 'Últimos 7 dias', min: startToday - 7 * DAY, data: [] },
    { key: 'm', title: t('one.histLast30') || 'Últimos 30 dias', min: startToday - 30 * DAY, data: [] },
    { key: 'old', title: t('one.histOlder') || 'Mais antigas', min: -Infinity, data: [] },
  ];
  for (const c of list) {
    const ms = convTime(c);
    const b = Number.isFinite(ms) ? buckets.find(x => ms >= x.min) : buckets[buckets.length - 1];
    (b || buckets[buckets.length - 1]).data.push(c);
  }
  return buckets.filter(b => b.data.length);
}

export function BiaHistoryDrawer({ visible, onClose, conversations, onSelect, currentId, isDark, t, insets, onDelete, onClearAll, onNewChat }) {
  const P = biaPalette(isDark);
  const [mounted, setMounted] = useState(visible);
  const [query, setQuery] = useState('');
  const v = useRef(new Animated.Value(0)).current;
  const W = Math.min(360, Math.round(Dimensions.get('window').width * 0.86));
  useEffect(() => {
    if (visible) {
      setMounted(true);
      if (isReduceMotionEnabled()) v.setValue(1);
      else Animated.spring(v, { toValue: 1, tension: 180, friction: 26, useNativeDriver: ND }).start();
    } else if (mounted) {
      const done = () => { setMounted(false); setQuery(''); };
      if (isReduceMotionEnabled()) { v.setValue(0); done(); } else Animated.timing(v, { toValue: 0, duration: 200, easing: Easing.in(Easing.cubic), useNativeDriver: ND }).start(done);
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const sections = useMemo(() => groupConversations(conversations, t, query), [conversations, t, query]);
  if (!mounted) return null;
  const tx = v.interpolate({ inputRange: [0, 1], outputRange: [-W, 0] });
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.38)', opacity: v }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'} />
        </Animated.View>
        <Animated.View style={[hs.panel, { width: W, backgroundColor: P.bg, paddingTop: (insets?.top || 0) + 10, paddingBottom: (insets?.bottom || 0) + 8, transform: [{ translateX: tx }] }, softShadow(isDark, 2)]}>
          <View style={hs.head}>
            <Text style={[hs.title, { color: P.fg }]} accessibilityRole="header">{t('one.history') || 'Histórico'}</Text>
            <TouchableOpacity onPress={onClose} hitSlop={10} style={[hs.iconBtn, { backgroundColor: P.chip }]} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'}>
              <IconX size={16} color={P.fg} />
            </TouchableOpacity>
          </View>
          <View style={[hs.search, { backgroundColor: P.card, borderColor: P.hair }]}>
            <IconSearch size={16} color={P.sub} />
            <TextInput
              value={query} onChangeText={setQuery} placeholder={t('common.search') || 'Buscar'} placeholderTextColor={P.faint}
              style={[hs.searchInput, { color: P.fg }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
              returnKeyType="search" accessibilityLabel={t('common.search') || 'Buscar'}
            />
            {query ? <TouchableOpacity onPress={() => setQuery('')} hitSlop={8} accessibilityLabel={t('common.clear') || 'Limpar'}><IconX size={14} color={P.sub} /></TouchableOpacity> : null}
          </View>
          {onNewChat ? (
            <TouchableOpacity onPress={() => { onNewChat(); onClose(); }} activeOpacity={0.7} style={[hs.newBtn, { backgroundColor: P.ink }]} accessibilityRole="button" accessibilityLabel={t('one.newChat') || 'Nova conversa'}>
              <IconEdit size={16} color={P.onInk} />
              <Text style={[hs.newText, { color: P.onInk }]}>{t('one.newChat') || 'Nova conversa'}</Text>
            </TouchableOpacity>
          ) : null}
          <SectionList
            style={{ flex: 1 }}
            sections={sections}
            keyExtractor={(c) => String(c.id)}
            stickySectionHeadersEnabled={false}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            initialNumToRender={20}
            ListEmptyComponent={
              <View style={hs.empty}>
                <IconMessageSquare size={22} color={P.faint} />
                <Text style={[hs.emptyText, { color: P.sub }]}>{t('one.noConversations') || 'Nenhuma conversa ainda'}</Text>
              </View>
            }
            renderSectionHeader={({ section }) => <Text style={[hs.section, { color: P.sub }]}>{section.title}</Text>}
            renderItem={({ item: c }) => {
              const active = c.id === currentId;
              return (
                <View style={[hs.item, active && { backgroundColor: P.chip }]}>
                  <TouchableOpacity style={{ flex: 1, paddingVertical: 11, paddingLeft: 12 }} activeOpacity={0.6} onPress={() => { onSelect(c); onClose(); }} accessibilityRole="button" accessibilityState={{ selected: active }}>
                    <Text style={[hs.itemText, { color: P.fg }, active && { fontWeight: '600' }]} numberOfLines={1}>{c.title || `#${c.id}`}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => onDelete?.(c)} hitSlop={6} style={hs.trash} accessibilityRole="button" accessibilityLabel={t('common.delete') || 'Apagar'}>
                    <IconTrash size={15} color={P.faint} />
                  </TouchableOpacity>
                </View>
              );
            }}
            ListFooterComponent={conversations?.length ? (
              <TouchableOpacity onPress={onClearAll} style={hs.clearAll} accessibilityRole="button" accessibilityLabel={t('one.clearAll') || 'Limpar tudo'}>
                <IconTrash size={14} color="#E5484D" />
                <Text style={hs.clearText}>{t('one.clearAll') || 'Limpar tudo'}</Text>
              </TouchableOpacity>
            ) : null}
          />
        </Animated.View>
      </View>
    </Modal>
  );
}
const hs = StyleSheet.create({
  panel: { position: 'absolute', top: 0, bottom: 0, left: 0, borderTopRightRadius: 24, borderBottomRightRadius: 24, paddingHorizontal: 12, overflow: 'hidden' },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 6, paddingBottom: 12 },
  title: { fontSize: 24, fontWeight: '700', letterSpacing: -0.5 },
  iconBtn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 12, height: 42 },
  searchInput: { flex: 1, fontSize: 15.5, paddingVertical: 0 },
  newBtn: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, height: 44, borderRadius: 14, marginTop: 10, marginBottom: 4 },
  newText: { fontSize: 15, fontWeight: '600' },
  section: { fontSize: 12.5, fontWeight: '600', letterSpacing: 0.2, paddingHorizontal: 12, paddingTop: 18, paddingBottom: 6 },
  item: { flexDirection: 'row', alignItems: 'center', borderRadius: 12 },
  itemText: { fontSize: 15, letterSpacing: -0.1 },
  trash: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', gap: 10, paddingTop: 48 },
  emptyText: { fontSize: 14 },
  clearAll: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingVertical: 18 },
  clearText: { fontSize: 14, color: '#E5484D', fontWeight: '600' },
});

// ─── modo voz em tela cheia ──────────────────────────────────────────────────
export function BiaVoiceScreen({ isDark, t, voiceState, transcript, onStop, onKeyboard, getLevel, insets }) {
  const P = biaPalette(isDark);
  const fade = useRef(new Animated.Value(0)).current;
  const [elapsed, setElapsed] = useState('0:00');
  const t0 = useRef(Date.now());
  useEffect(() => {
    if (isReduceMotionEnabled()) fade.setValue(1);
    else Animated.timing(fade, { toValue: 1, duration: 380, easing: Easing.out(Easing.cubic), useNativeDriver: ND }).start();
    const iv = setInterval(() => {
      const s = Math.floor((Date.now() - t0.current) / 1000);
      setElapsed(`${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`);
    }, 1000);
    return () => clearInterval(iv);
  }, [fade]);
  const stop = useCallback(() => {
    if (isReduceMotionEnabled()) { onStop?.(); return; }
    Animated.timing(fade, { toValue: 0, duration: 220, easing: Easing.in(Easing.cubic), useNativeDriver: ND }).start(() => onStop?.());
  }, [fade, onStop]);
  const label = voiceState === 'thinking' ? (t('one.thinking') || 'Pensando...') : voiceState === 'speaking' ? (t('one.voiceSpeaking') || 'Falando...') : (t('one.voiceListening') || 'Ouvindo...');
  const orbMode = voiceState === 'thinking' ? 'thinking' : voiceState === 'speaking' ? 'speaking' : 'listening';
  const size = Math.min(260, Math.round(Dimensions.get('window').width * 0.62));
  const sc = fade.interpolate({ inputRange: [0, 1], outputRange: [0.86, 1] });
  return (
    <Animated.View style={[vs.root, { backgroundColor: P.bg, opacity: fade, paddingTop: (insets?.top || 0) + 8, paddingBottom: (insets?.bottom || 0) + 18 }]} accessibilityViewIsModal>
      <View style={vs.top}>
        <View style={[vs.livePill, { backgroundColor: P.chip }]}>
          <View style={[vs.liveDot, { backgroundColor: P.fg }]} />
          <Text style={[vs.liveText, { color: P.sub }]}>{elapsed}</Text>
        </View>
        <Text style={[vs.brand, { color: P.fg }]}>Bia</Text>
        <View style={{ width: 64 }} />
      </View>
      <View style={vs.center}>
        <Animated.View style={{ transform: [{ scale: sc }] }}>
          <BiaOrb size={size} mode={orbMode} getLevel={getLevel} isDark={isDark} />
        </Animated.View>
        <View style={{ height: 36 }} />
        <BiaShimmerText text={label} isDark={isDark} style={vs.state} />
        <View style={vs.captionWrap}>
          {transcript ? (
            <BiaFadeIn key={transcript.slice(0, 24)} dy={6} duration={260}>
              <Text style={[vs.caption, { color: P.fg }]} numberOfLines={4} accessibilityLiveRegion="polite">{transcript}</Text>
            </BiaFadeIn>
          ) : null}
        </View>
      </View>
      <View style={vs.bottom}>
        {onKeyboard ? (
          <TouchableOpacity onPress={onKeyboard} style={[vs.side, { backgroundColor: P.chip }]} activeOpacity={0.7} accessibilityRole="button" accessibilityLabel={t('one.switchToText') || 'Digitar'}>
            <IconEdit size={20} color={P.fg} />
          </TouchableOpacity>
        ) : <View style={vs.side} />}
        <BiaPressScale onPress={stop} scaleTo={0.92} accessibilityLabel={t('one.voiceEnd') || 'Encerrar'} style={[vs.end, { backgroundColor: P.ink }]}>
          <IconX size={28} color={P.onInk} />
        </BiaPressScale>
        <View style={vs.side} />
      </View>
    </Animated.View>
  );
}
const vs = StyleSheet.create({
  root: { ...StyleSheet.absoluteFillObject, zIndex: 100, elevation: 100 },
  top: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, height: 44 },
  livePill: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 10, height: 28, borderRadius: 14, minWidth: 64 },
  liveDot: { width: 6, height: 6, borderRadius: 3 },
  liveText: { fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
  brand: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  state: { fontSize: 17, fontWeight: '600', letterSpacing: -0.2, textAlign: 'center' },
  captionWrap: { minHeight: 110, marginTop: 18, alignItems: 'center', justifyContent: 'flex-start', alignSelf: 'stretch' },
  caption: { fontSize: 22, lineHeight: 30, fontWeight: '500', textAlign: 'center', letterSpacing: -0.3 },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 40 },
  side: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  end: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
});
