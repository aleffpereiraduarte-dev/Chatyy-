// [2026-10-15 bia-design] Peças de interface da Bia (nível ChatGPT/Gemini, P&B).
//
//   BiaFadeIn          entrada fade+subida com atraso (cascata); Reduzir Movimento → sem animação
//   BiaShimmerText     texto do passo atual com brilho passando (shimmer)
//   BiaPressScale      toque com leve encolhimento (spring, native driver)
//   BiaSuggestionGrid  grade 2 colunas de cartões de sugestão com ícone
//   BiaComposer        barra de entrada flutuante de vidro: anexar, ditado (vira onda), enviar/voz (morph)
//   BiaMessageActions  copiar · ouvir · regenerar · compartilhar · curtir/descurtir (aparecem suaves)
//   BiaHistoryDrawer   gaveta: títulos limpos, sem duplicatas, Fixadas, busca, deslizar p/ apagar (+Desfazer), menu Renomear/Fixar/Apagar
//   BiaAttachSheet     folha do "+": câmera · fotos · voz · ajustes
//   BiaVoiceScreen     modo voz em tela cheia: orb grande reagindo ao volume + legenda ao vivo
//
// Tudo com ícones SVG (components/Icons) — sem emoji. Animações em native driver.
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, Pressable, Animated, Easing, Platform, StyleSheet,
  Modal, SectionList, Image, ScrollView, Dimensions, PanResponder,
} from 'react-native';
import Svg, { Path, Rect } from 'react-native-svg';
import {
  IconPlus, IconMic, IconStop, IconX, IconCopy, IconCheck, IconVolume2, IconVolumeX, IconRepeat,
  IconShare, IconSearch, IconTrash, IconEdit, IconMessageSquare,
} from '../Icons';
import { useReducedMotion, isReduceMotionEnabled } from '../reducedMotion';
import { getNativeBlurView } from '../NativeBlur';
import BiaOrb from './BiaOrb';
import useDragToDismiss, { DragSheetRoot, DragPanel } from '../ui/useDragToDismiss';

const ND = Platform.OS !== 'web';

export function biaPalette(isDark) {
  return isDark ? {
    bg: '#000000', fg: '#F2F2F4', sub: '#A1A1A6', faint: '#6C6C70', hair: 'rgba(255,255,255,0.10)',
    card: '#111113', cardHi: '#18181B', chip: 'rgba(255,255,255,0.07)', bubble: '#1C1C1E',
    glass: 'rgba(28,28,30,0.72)', glassSolid: 'rgba(22,22,24,0.97)', ink: '#FFFFFF', onInk: '#000000',
  } : {
    bg: '#FFFFFF', fg: '#0D0D0D', sub: '#6B6B70' /* [polish3] neutro (Tailwind gray-500 era azulado) */, faint: '#A3A3AA', hair: 'rgba(0,0,0,0.08)',
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
// [2026-10-16 polish3] fill: estica até a altura da célula (cartões da grade
// de sugestões ficavam com alturas diferentes na mesma linha).
const _fillStyle = { flex: 1 };
export function BiaPressScale({ onPress, onLongPress, style, children, scaleTo = 0.965, disabled, accessibilityLabel, accessibilityRole = 'button', accessibilityHint, hitSlop, fill }) {
  const s = useRef(new Animated.Value(1)).current;
  const go = (to) => { if (isReduceMotionEnabled()) return; Animated.spring(s, { toValue: to, tension: 320, friction: 18, useNativeDriver: ND }).start(); };
  return (
    <Pressable
      onPress={onPress} onLongPress={onLongPress} disabled={disabled} hitSlop={hitSlop}
      onPressIn={() => go(scaleTo)} onPressOut={() => go(1)}
      accessibilityRole={accessibilityRole} accessibilityLabel={accessibilityLabel} accessibilityHint={accessibilityHint}
      style={[fill ? _fillStyle : null, Platform.OS === 'web' ? { cursor: disabled ? 'default' : 'pointer' } : null]}
    >
      <Animated.View style={[style, fill ? _fillStyle : null, { transform: [{ scale: s }] }]}>{children}</Animated.View>
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

// [2026-10-18 bia-voz-centro] `align` (padrão 'flex-start' = comportamento antigo); a tela de voz passa 'center'.
export const BiaShimmerText = memo(function BiaShimmerText({ text, isDark, style, align = 'flex-start' }) {
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
    <View style={{ alignSelf: align }} accessibilityLiveRegion="polite" accessible accessibilityLabel={text}>
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
            <BiaPressScale fill onPress={() => onPick(it)} accessibilityLabel={it.label} accessibilityHint={it.sub}
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
              placeholder={listening ? (t('one.voiceListening') || 'Ouvindo...') : (t('one.askAnything') || t('one.placeholder') || 'Pergunte qualquer coisa')}
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
              {...(Platform.OS === 'web' ? { rows: 1 } : null)}
              maxLength={2000}
              editable={!loading}
              accessibilityLabel={t('one.askAnything') || t('one.placeholder') || 'Mensagem'}
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
  const doVote = (v) => { const nv = vote === v ? 0 : v; setVote(nv); onFeedback?.(item, nv); }; // [bia-fase0 2026-10-18] 0 = desfaz o voto no servidor
  const btn = (key, label, icon, onPress, active) => (
    <TouchableOpacity key={key} onPress={onPress} hitSlop={4} activeOpacity={0.6} accessibilityRole="button" accessibilityLabel={label}
      style={[as.btn, active && { backgroundColor: P.chip }]}>
      {icon}
    </TouchableOpacity>
  );
  const c = isDark ? '#8E8E93' : '#86868D';
  return (
    <BiaFadeIn delay={120} dy={4} duration={320} style={as.row}>
      {onCopy ? btn('copy', copied ? (t('common.copied') || 'Copiado') : (t('common.copy') || 'Copiar'), copied ? <IconCheck size={15} color={P.fg} /> : <IconCopy size={15} color={c} />, doCopy) : null}
      {onSpeak ? btn('speak', speaking ? (t('one.speakStop') || 'Parar') : (t('oneScreen.readAloud') || 'Ouvir'), speaking ? <IconVolumeX size={15} color={P.fg} /> : <IconVolume2 size={15} color={c} />, () => onSpeak(item), speaking) : null}
      {onRegenerate ? btn('regen', t('one.regenerate') || 'Regenerar', <IconRepeat size={15} color={c} />, () => onRegenerate(item)) : null}
      {onShare ? btn('share', t('common.share') || 'Compartilhar', <IconShare size={15} color={c} />, () => onShare(item)) : null}
      {onFeedback ? btn('up', t('one.goodResponse'), <GlyphThumb size={15} filled={vote === 1} color={vote === 1 ? P.fg : c} />, () => doVote(1), vote === 1) : null}
      {onFeedback ? btn('down', t('one.badResponse'), <GlyphThumb size={15} down filled={vote === -1} color={vote === -1 ? P.fg : c} />, () => doVote(-1), vote === -1) : null}
    </BiaFadeIn>
  );
});
const as = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 0, marginTop: 6, marginLeft: -7 },
  btn: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
});

// ─── gaveta de histórico ─────────────────────────────────────────────────────
// [2026-10-16 bia-repagina] Gaveta nível ChatGPT/Claude: títulos limpos (sem
// "Oi Bia," / "." vira "Conversa sem título"), duplicatas escondidas (o app
// antigo criava 2 conversas por envio quando o stream caía no fallback),
// Fixadas no topo, busca, deslizar p/ apagar (com Desfazer), toque longo /
// clique direito → Renomear · Fixar · Apagar. Sem lixeira em cada linha.
function convTime(c, field) {
  const raw = field ? c?.[field] : (c?.updated_at || c?.created_at);
  if (!raw) return NaN;
  let s = String(raw).trim().replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z';
  s = s.replace(/([+-]\d{2})$/, '$1:00');
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

const GREET_RE = /^(?:(?:oi+e*|ol[aá]+|opa+|oie+|ouee*|eai|e a[ií]|hey+|hi+|hello|hola|salve|fala|bom dia|boa tarde|boa noite|good (?:morning|afternoon|evening))(?![A-Za-z0-9À-ɏͰ-ϿЀ-ӿ԰-ۿऀ-෿฀-໿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]))[\s,!.?;:~-]*(?:(?:bia|one)(?![A-Za-z0-9À-ɏͰ-ϿЀ-ӿ԰-ۿऀ-෿฀-໿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯])[\s,!.?;:~-]*)?/i;
const BIA_WORD_RE = /[A-Za-z0-9À-ɏͰ-ϿЀ-ӿ԰-ۿऀ-෿฀-໿ᄀ-ᇿ぀-ヿ㐀-鿿가-힯]/;
const BIA_PREFIX_RE = /^(?:bia|one)[\s,!.:;-]+/i;
const DANGLING_RE = /\s+(?:para|pra|pro|de|do|da|dos|das|e|com|a|o|as|os|em|no|na|nos|nas|por|um|uma|que|se|ao|à|the|of|to|and|for|with|in|on|a|an)$/i;

// título "humano" a partir do título cru (1ª frase cortada em 50 chars pelo servidor)
export function prettyBiaTitle(raw, t) {
  let s = String(raw == null ? '' : raw).replace(/\s+/g, ' ').trim();
  if (!BIA_WORD_RE.test(s)) return (t && t('one.histUntitled')) || 'Conversa sem título';
  const wasCut = s.length >= 50;
  const noGreet = s.replace(GREET_RE, '').replace(BIA_PREFIX_RE, '').trim();
  if (!BIA_WORD_RE.test(noGreet)) return (t && t('one.histGreeting')) || 'Conversa rápida';
  s = noGreet;
  if (wasCut) {
    const sp = s.lastIndexOf(' ');
    if (sp > 18) s = s.slice(0, sp);
    for (let i = 0; i < 3 && DANGLING_RE.test(s); i++) s = s.replace(DANGLING_RE, '');
  }
  s = s.replace(/[\s,;:.!-]+$/, '');
  if (s.length > 64) s = s.slice(0, 62).replace(/\s+\S*$/, '');
  return s.charAt(0).toLocaleUpperCase() + s.slice(1);
}

// esconde duplicatas (mesmo título criado < 3 min) e conversas vazias
export function cleanBiaConversations(list, currentId) {
  const arr = Array.isArray(list) ? list.slice() : [];
  const key = (c) => String(c.title || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const created = (c) => { const a = convTime(c, 'created_at'); return Number.isFinite(a) ? a : convTime(c); };
  const n = (c) => (c && c.n != null ? Number(c.n) : null);
  const hidden = new Set();
  for (let i = 0; i < arr.length; i++) {
    const a = arr[i];
    if (a.id !== currentId && n(a) === 0) { hidden.add(a.id); continue; }
    for (let j = i + 1; j < arr.length; j++) {
      const b = arr[j];
      if (hidden.has(b.id) || key(a) !== key(b)) continue;
      const ta = created(a); const tb = created(b);
      if (!Number.isFinite(ta) || !Number.isFinite(tb) || Math.abs(ta - tb) > 180000) continue;
      // fica a que tem mais mensagens; empate → a mais recente (a lista vem do mais novo)
      const na = n(a); const nb = n(b);
      const dropA = (na != null && nb != null && nb > na) && a.id !== currentId;
      if (dropA) { hidden.add(a.id); break; }
      if (b.id !== currentId) hidden.add(b.id);
    }
  }
  return arr.filter(c => !hidden.has(c.id));
}

export function groupConversations(conversations, t, query, pinned) {
  const q = (query || '').trim().toLowerCase();
  const pin = pinned instanceof Set ? pinned : new Set(pinned || []);
  const list = (conversations || []).filter(c => !q || String(c._title || c.title || '').toLowerCase().includes(q) || String(c.title || '').toLowerCase().includes(q));
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const DAY = 86400000;
  const pinnedB = { key: 'pin', title: t('one.histPinned') || 'Fixadas', data: [] };
  const buckets = [
    { key: 'today', title: t('common.today') || 'Hoje', min: startToday, data: [] },
    { key: 'yest', title: t('common.yesterday') || 'Ontem', min: startToday - DAY, data: [] },
    { key: 'w', title: t('one.histLast7') || 'Últimos 7 dias', min: startToday - 7 * DAY, data: [] },
    { key: 'm', title: t('one.histLast30') || 'Últimos 30 dias', min: startToday - 30 * DAY, data: [] },
    { key: 'old', title: t('one.histOlder') || 'Mais antigas', min: -Infinity, data: [] },
  ];
  for (const c of list) {
    if (pin.has(c.id)) { pinnedB.data.push(c); continue; }
    const ms = convTime(c);
    const b = Number.isFinite(ms) ? buckets.find(x => ms >= x.min) : buckets[buckets.length - 1];
    (b || buckets[buckets.length - 1]).data.push(c);
  }
  return [pinnedB, ...buckets].filter(b => b.data.length);
}

export function GlyphPin({ size = 15, color = '#000', filled = false }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      <Path d="M12 17v5" stroke={color} strokeWidth={1.9} strokeLinecap="round" />
      <Path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"
        stroke={color} strokeWidth={1.9} strokeLinecap="round" strokeLinejoin="round" fill={filled ? color : 'none'} />
    </Svg>
  );
}
function GlyphMore({ size = 16, color = '#000' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={color}>
      <Rect x="3.5" y="10.5" width="3.2" height="3.2" rx="1.6" />
      <Rect x="10.4" y="10.5" width="3.2" height="3.2" rx="1.6" />
      <Rect x="17.3" y="10.5" width="3.2" height="3.2" rx="1.6" />
    </Svg>
  );
}

// linha com deslizar-p/-apagar (PanResponder: funciona em iOS/Android/web, sem lib nativa)
const DEL_W = 88;
const SwipeRow = memo(function SwipeRow({ onDelete, deleteLabel, children, onOpenChange, closeSignal }) {
  const x = useRef(new Animated.Value(0)).current;
  const base = useRef(0);
  const widthRef = useRef(320);
  const snap = useCallback((to, cb) => {
    base.current = to;
    onOpenChange?.(to !== 0);
    if (isReduceMotionEnabled()) { x.setValue(to); cb?.(); return; }
    Animated.spring(x, { toValue: to, tension: 210, friction: 24, useNativeDriver: ND }).start(cb ? () => cb() : undefined);
  }, [x, onOpenChange]);
  useEffect(() => { if (base.current !== 0) snap(0); }, [closeSignal]); // eslint-disable-line react-hooks/exhaustive-deps
  const doDelete = useCallback(() => {
    const W = widthRef.current;
    if (isReduceMotionEnabled()) { onDelete?.(); return; }
    Animated.timing(x, { toValue: -W, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: ND }).start(() => onDelete?.());
  }, [x, onDelete]);
  const pr = useMemo(() => PanResponder.create({
    onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 10 && Math.abs(g.dx) > Math.abs(g.dy) * 1.6,
    onMoveShouldSetPanResponderCapture: (_, g) => Math.abs(g.dx) > 14 && Math.abs(g.dx) > Math.abs(g.dy) * 2,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => { x.stopAnimation(); },
    onPanResponderMove: (_, g) => {
      const W = widthRef.current;
      let v = base.current + g.dx;
      if (v > 0) v = v * 0.15;
      if (v < -W) v = -W;
      x.setValue(v);
    },
    onPanResponderRelease: (_, g) => {
      const W = widthRef.current;
      const v = base.current + g.dx;
      if (v < -W * 0.58 || (g.vx < -1.6 && v < -DEL_W)) { base.current = 0; doDelete(); return; }
      if (v < -DEL_W * 0.5 || g.vx < -0.5) snap(-DEL_W); else snap(0);
    },
    onPanResponderTerminate: () => snap(base.current < -DEL_W * 0.5 ? -DEL_W : 0),
  }), [x, snap, doDelete]);
  const reveal = x.interpolate({ inputRange: [-DEL_W, -10, 0], outputRange: [1, 0.2, 0], extrapolate: 'clamp' });
  return (
    <View style={hs.swipeWrap} onLayout={(e) => { widthRef.current = Math.max(200, e.nativeEvent.layout.width); }}>
      <Animated.View style={[hs.delUnder, { opacity: reveal }]}>
        <TouchableOpacity onPress={doDelete} style={hs.delBtn} activeOpacity={0.8} accessibilityRole="button" accessibilityLabel={deleteLabel}>
          <IconTrash size={17} color="#FFFFFF" />
          <Text style={hs.delText} numberOfLines={1}>{deleteLabel}</Text>
        </TouchableOpacity>
      </Animated.View>
      <Animated.View {...pr.panHandlers} style={{ transform: [{ translateX: x }] }}>
        {children}
      </Animated.View>
    </View>
  );
});

const HistRow = memo(function HistRow({ c, active, pinned, P, t, onSelect, onMenu, onDelete, closeSignal }) {
  const [hover, setHover] = useState(false);
  const title = c._title;
  const webCtx = Platform.OS === 'web' ? {
    onContextMenu: (e) => { try { e.preventDefault(); } catch {} onMenu(c); },
  } : null;
  return (
    <SwipeRow onDelete={() => onDelete(c)} deleteLabel={t('common.delete') || 'Apagar'} closeSignal={closeSignal}>
      <Pressable
        testID="bia-hist-row"
        onPress={() => onSelect(c)}
        onLongPress={() => onMenu(c)}
        delayLongPress={360}
        onHoverIn={() => setHover(true)}
        onHoverOut={() => setHover(false)}
        accessibilityRole="button"
        accessibilityState={{ selected: active }}
        accessibilityLabel={title}
        accessibilityHint={t('one.histRowHint') || undefined}
        style={({ pressed }) => [
          hs.item,
          { backgroundColor: active ? P.cardHi : (pressed || hover) ? P.chip : P.bg },
          Platform.OS === 'web' ? { cursor: 'pointer' } : null,
        ]}
        {...webCtx}
      >
        {active ? <View style={[hs.activeBar, { backgroundColor: P.fg }]} /> : null}
        {pinned ? <View style={{ marginRight: 8 }}><GlyphPin size={13} color={P.sub} filled /></View> : null}
        <Text style={[hs.itemText, { color: P.fg }, active && { fontWeight: '600' }]} numberOfLines={1}>{title}</Text>
        {Platform.OS === 'web' && (hover || active) ? (
          <TouchableOpacity onPress={() => onMenu(c)} hitSlop={6} style={hs.moreBtn} accessibilityRole="button" accessibilityLabel={t('common.more') || 'Mais'}>
            <GlyphMore size={16} color={P.sub} />
          </TouchableOpacity>
        ) : null}
      </Pressable>
    </SwipeRow>
  );
});

export function BiaHistoryDrawer({
  visible, onClose, conversations, onSelect, currentId, isDark, t, insets,
  onDelete, onClearAll, onNewChat, pinnedIds, onTogglePin, onRename,
}) {
  const P = biaPalette(isDark);
  const [mounted, setMounted] = useState(visible);
  const [query, setQuery] = useState('');
  const [menu, setMenu] = useState(null);         // conversa com o menu aberto
  const [renaming, setRenaming] = useState(null); // { c, text }
  const [undo, setUndo] = useState(null);         // { c } — apagada há pouco
  const [closeSignal, setCloseSignal] = useState(0);
  const undoTimer = useRef(null);
  const pendingRef = useRef(null);
  const v = useRef(new Animated.Value(0)).current;
  const menuV = useRef(new Animated.Value(0)).current;
  const W = Math.min(380, Math.round(Dimensions.get('window').width * 0.86));

  const commitPending = useCallback(() => {
    if (undoTimer.current) { clearTimeout(undoTimer.current); undoTimer.current = null; }
    const p = pendingRef.current;
    pendingRef.current = null;
    setUndo(null);
    if (p) onDelete?.(p, { confirmed: true });
  }, [onDelete]);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      if (isReduceMotionEnabled()) v.setValue(1);
      else Animated.spring(v, { toValue: 1, tension: 170, friction: 22, useNativeDriver: ND }).start();
    } else if (mounted) {
      commitPending();
      const done = () => { setMounted(false); setQuery(''); setMenu(null); setRenaming(null); };
      if (isReduceMotionEnabled()) { v.setValue(0); done(); } else Animated.timing(v, { toValue: 0, duration: 210, easing: Easing.in(Easing.cubic), useNativeDriver: ND }).start(done);
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { if (undoTimer.current) clearTimeout(undoTimer.current); }, []);

  useEffect(() => {
    if (!menu) return;
    menuV.setValue(0);
    if (isReduceMotionEnabled()) menuV.setValue(1);
    else Animated.spring(menuV, { toValue: 1, tension: 260, friction: 22, useNativeDriver: ND }).start();
  }, [menu, menuV]);

  const pinSet = useMemo(() => new Set(pinnedIds || []), [pinnedIds]);
  const cleaned = useMemo(() => {
    const hiddenId = undo?.c?.id;
    return cleanBiaConversations(conversations, currentId)
      .filter(c => c.id !== hiddenId)
      .map(c => ({ ...c, _title: prettyBiaTitle(c.title, t) }));
  }, [conversations, currentId, t, undo]);
  const sections = useMemo(() => groupConversations(cleaned, t, query, pinSet), [cleaned, t, query, pinSet]);

  const select = useCallback((c) => { onSelect(c); onClose(); }, [onSelect, onClose]);
  const openMenu = useCallback((c) => {
    try { const H = require('../../services/haptics').HapticsCompat; H.impactAsync(H.ImpactFeedbackStyle.Medium); } catch {}
    setMenu(c);
  }, []);
  const softDelete = useCallback((c) => {
    if (pendingRef.current) commitPending();
    pendingRef.current = c;
    setUndo({ c });
    if (undoTimer.current) clearTimeout(undoTimer.current);
    undoTimer.current = setTimeout(commitPending, 4500);
  }, [commitPending]);
  const undoDelete = () => {
    if (undoTimer.current) { clearTimeout(undoTimer.current); undoTimer.current = null; }
    pendingRef.current = null;
    setUndo(null);
    setCloseSignal(s => s + 1);
  };

  if (!mounted) return null;
  const tx = v.interpolate({ inputRange: [0, 1], outputRange: [-W - 24, 0] });
  const menuSc = menuV.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] });
  const menuItem = (key, label, icon, onPress, danger) => (
    <TouchableOpacity key={key} onPress={onPress} activeOpacity={0.6} style={hs.menuItem} accessibilityRole="button" accessibilityLabel={label}>
      <Text style={[hs.menuText, { color: danger ? '#E5484D' : P.fg }]}>{label}</Text>
      {icon}
    </TouchableOpacity>
  );
  const menuPinned = menu ? pinSet.has(menu.id) : false;

  return (
    <Modal transparent visible animationType="none" onRequestClose={() => { if (renaming) setRenaming(null); else if (menu) setMenu(null); else onClose(); }} statusBarTranslucent>
      <View style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(10,10,14,0.32)', opacity: v }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'} />
        </Animated.View>
        {/* sombra fica no invólucro (overflow:hidden no painel cortava a sombra no iOS) */}
        <Animated.View style={[hs.panelShadow, { width: W, transform: [{ translateX: tx }] }, softShadow(isDark, 3)]}>
          <View style={[hs.panel, { backgroundColor: P.bg, borderColor: P.hair, paddingTop: (insets?.top || 0) + 10, paddingBottom: (insets?.bottom || 0) + 6 }]}>
            <View style={hs.head}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
                <BiaOrb size={26} lite isDark={isDark} mode="idle" animated={false} />
                <Text style={[hs.title, { color: P.fg }]} accessibilityRole="header">{t('one.history') || 'Histórico'}</Text>
              </View>
              {onNewChat ? (
                <BiaPressScale onPress={() => { onNewChat(); onClose(); }} scaleTo={0.9} style={[hs.iconBtn, { backgroundColor: P.ink }]} accessibilityLabel={t('one.newChat') || 'Nova conversa'}>
                  <IconEdit size={16} color={P.onInk} />
                </BiaPressScale>
              ) : null}
            </View>
            <View style={[hs.search, { backgroundColor: P.chip }]}>
              <IconSearch size={16} color={P.sub} />
              <TextInput
                value={query} onChangeText={setQuery} placeholder={t('common.search') || 'Buscar'} placeholderTextColor={P.faint}
                style={[hs.searchInput, { color: P.fg }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
                returnKeyType="search" accessibilityLabel={t('common.search') || 'Buscar'}
                autoCorrect={false}
              />
              {query ? <TouchableOpacity onPress={() => setQuery('')} hitSlop={8} accessibilityLabel={t('common.clear') || 'Limpar'}><IconX size={14} color={P.sub} /></TouchableOpacity> : null}
            </View>
            <SectionList
              style={{ flex: 1, marginTop: 6 }}
              sections={sections}
              keyExtractor={(c) => String(c.id)}
              stickySectionHeadersEnabled={false}
              keyboardShouldPersistTaps="handled"
              keyboardDismissMode="on-drag"
              showsVerticalScrollIndicator={false}
              initialNumToRender={24}
              ListEmptyComponent={
                <View style={hs.empty}>
                  <View style={[hs.emptyIcon, { backgroundColor: P.chip }]}>
                    {query ? <IconSearch size={20} color={P.sub} /> : <IconMessageSquare size={20} color={P.sub} />}
                  </View>
                  <Text style={[hs.emptyText, { color: P.sub }]}>
                    {query ? (t('one.histNoResults') || 'Nada encontrado') : (t('one.noConversations') || 'Nenhuma conversa ainda')}
                  </Text>
                </View>
              }
              renderSectionHeader={({ section }) => (
                <Text style={[hs.section, { color: P.faint }]} accessibilityRole="header">{section.title}</Text>
              )}
              renderItem={({ item: c }) => (
                <HistRow
                  c={c} P={P} t={t}
                  active={c.id === currentId}
                  pinned={pinSet.has(c.id)}
                  onSelect={select}
                  onMenu={openMenu}
                  onDelete={softDelete}
                  closeSignal={closeSignal}
                />
              )}
              ListFooterComponent={cleaned.length && !query ? (
                <TouchableOpacity onPress={onClearAll} style={hs.clearAll} accessibilityRole="button" accessibilityLabel={t('one.clearAll') || 'Limpar tudo'}>
                  <Text style={[hs.clearText, { color: P.faint }]}>{t('one.clearAll') || 'Limpar tudo'}</Text>
                </TouchableOpacity>
              ) : <View style={{ height: 16 }} />}
            />

            {undo ? (
              <BiaFadeIn dy={10} duration={220} style={[hs.toast, { backgroundColor: P.ink }]}>
                <Text style={[hs.toastText, { color: P.onInk }]} numberOfLines={1}>{t('one.histDeleted') || 'Conversa apagada'}</Text>
                <TouchableOpacity onPress={undoDelete} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.undo') || 'Desfazer'}>
                  <Text style={[hs.toastBtn, { color: P.onInk }]}>{t('common.undo') || 'Desfazer'}</Text>
                </TouchableOpacity>
              </BiaFadeIn>
            ) : null}

            {menu ? (
              <View style={[StyleSheet.absoluteFill, hs.menuLayer]}>
                <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)' }]} onPress={() => setMenu(null)} accessibilityLabel={t('common.close') || 'Fechar'} />
                <Animated.View style={[hs.menuCard, { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF', borderColor: P.hair, opacity: menuV, transform: [{ scale: menuSc }] }, softShadow(isDark, 2.4)]}>
                  <Text style={[hs.menuTitle, { color: P.sub }]} numberOfLines={2}>{menu._title}</Text>
                  <View style={[hs.menuSep, { backgroundColor: P.hair }]} />
                  {onRename ? menuItem('ren', t('one.histRename') || 'Renomear', <IconEdit size={17} color={P.fg} />, () => { setRenaming({ c: menu, text: menu._title }); setMenu(null); }) : null}
                  {onTogglePin ? (
                    <>
                      <View style={[hs.menuSep, { backgroundColor: P.hair }]} />
                      {menuItem('pin', menuPinned ? (t('one.histUnpin') || 'Desafixar') : (t('one.histPin') || 'Fixar'), <GlyphPin size={17} color={P.fg} filled={menuPinned} />, () => { onTogglePin(menu); setMenu(null); })}
                    </>
                  ) : null}
                  <View style={[hs.menuSep, { backgroundColor: P.hair }]} />
                  {menuItem('del', t('common.delete') || 'Apagar', <IconTrash size={17} color="#E5484D" />, () => { const c = menu; setMenu(null); softDelete(c); }, true)}
                </Animated.View>
              </View>
            ) : null}

            {renaming ? (
              <View style={[StyleSheet.absoluteFill, hs.menuLayer]}>
                <Pressable style={[StyleSheet.absoluteFill, { backgroundColor: isDark ? 'rgba(0,0,0,0.55)' : 'rgba(255,255,255,0.55)' }]} onPress={() => setRenaming(null)} />
                <BiaFadeIn dy={8} duration={220} style={[hs.menuCard, { backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF', borderColor: P.hair, padding: 16 }, softShadow(isDark, 2.4)]}>
                  <Text style={[hs.renameTitle, { color: P.fg }]}>{t('one.histRenameTitle') || 'Renomear conversa'}</Text>
                  <TextInput
                    value={renaming.text}
                    onChangeText={(text) => setRenaming(r => ({ ...r, text }))}
                    autoFocus
                    selectTextOnFocus
                    maxLength={80}
                    onSubmitEditing={() => { const s = (renaming.text || '').trim(); if (s) onRename?.(renaming.c, s); setRenaming(null); }}
                    returnKeyType="done"
                    style={[hs.renameInput, { color: P.fg, backgroundColor: P.chip }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
                    accessibilityLabel={t('one.histRenameTitle') || 'Renomear conversa'}
                  />
                  <View style={hs.renameRow}>
                    <TouchableOpacity onPress={() => setRenaming(null)} style={[hs.renameBtn, { backgroundColor: P.chip }]} accessibilityRole="button">
                      <Text style={[hs.renameBtnText, { color: P.fg }]}>{t('common.cancel') || 'Cancelar'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => { const s = (renaming.text || '').trim(); if (s) onRename?.(renaming.c, s); setRenaming(null); }}
                      style={[hs.renameBtn, { backgroundColor: P.ink }]} accessibilityRole="button"
                    >
                      <Text style={[hs.renameBtnText, { color: P.onInk }]}>{t('common.save') || 'Salvar'}</Text>
                    </TouchableOpacity>
                  </View>
                </BiaFadeIn>
              </View>
            ) : null}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}
const hs = StyleSheet.create({
  panelShadow: { position: 'absolute', top: 0, bottom: 0, left: 0, borderTopRightRadius: 28, borderBottomRightRadius: 28 },
  panel: { flex: 1, borderTopRightRadius: 28, borderBottomRightRadius: 28, paddingHorizontal: 10, overflow: 'hidden', borderRightWidth: StyleSheet.hairlineWidth },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8, paddingBottom: 14, paddingTop: 2 },
  title: { fontSize: 22, fontWeight: '700', letterSpacing: -0.5 },
  iconBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  search: { flexDirection: 'row', alignItems: 'center', gap: 8, borderRadius: 12, paddingHorizontal: 12, height: 40, marginHorizontal: 2 },
  searchInput: { flex: 1, fontSize: 15.5, paddingVertical: 0 },
  section: { fontSize: 12, fontWeight: '600', letterSpacing: 0.3, textTransform: 'uppercase', paddingHorizontal: 12, paddingTop: 20, paddingBottom: 6 },
  swipeWrap: { position: 'relative', borderRadius: 12, overflow: 'hidden', marginVertical: 1 },
  delUnder: { ...StyleSheet.absoluteFillObject, backgroundColor: '#E5484D', borderRadius: 12, alignItems: 'flex-end', justifyContent: 'center' },
  delBtn: { width: DEL_W, height: '100%', alignItems: 'center', justifyContent: 'center', gap: 2 },
  delText: { color: '#FFFFFF', fontSize: 11.5, fontWeight: '600' },
  item: { flexDirection: 'row', alignItems: 'center', borderRadius: 12, minHeight: 44, paddingLeft: 12, paddingRight: 8 },
  activeBar: { position: 'absolute', left: 0, top: 12, bottom: 12, width: 3, borderRadius: 2 },
  itemText: { flex: 1, fontSize: 15, letterSpacing: -0.15, paddingVertical: 11 },
  moreBtn: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  empty: { alignItems: 'center', gap: 12, paddingTop: 56 },
  emptyIcon: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  emptyText: { fontSize: 14.5 },
  clearAll: { alignSelf: 'flex-start', paddingHorizontal: 12, paddingTop: 22, paddingBottom: 18 },
  clearText: { fontSize: 13.5, fontWeight: '500' },
  toast: { position: 'absolute', left: 12, right: 12, bottom: 16, borderRadius: 14, minHeight: 46, paddingHorizontal: 16, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  toastText: { flex: 1, fontSize: 14.5, fontWeight: '500' },
  toastBtn: { fontSize: 14.5, fontWeight: '700' },
  menuLayer: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 22 },
  menuCard: { alignSelf: 'stretch', borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  menuTitle: { fontSize: 13, fontWeight: '500', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 12, textAlign: 'center' },
  menuSep: { height: StyleSheet.hairlineWidth },
  menuItem: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, minHeight: 50 },
  menuText: { fontSize: 16, letterSpacing: -0.2 },
  renameTitle: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3, marginBottom: 12 },
  renameInput: { fontSize: 16, borderRadius: 12, paddingHorizontal: 12, height: 44 },
  renameRow: { flexDirection: 'row', gap: 10, marginTop: 14 },
  renameBtn: { flex: 1, height: 44, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  renameBtnText: { fontSize: 15.5, fontWeight: '600' },
});

// ─── folha do "+" (anexar · voz · ajustes) ───────────────────────────────────
export function BiaAttachSheet({ visible, onClose, isDark, t, insets, items }) {
  const P = biaPalette(isDark);
  const [mounted, setMounted] = useState(visible);
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (visible) {
      setMounted(true);
      if (isReduceMotionEnabled()) v.setValue(1);
      else Animated.spring(v, { toValue: 1, tension: 200, friction: 24, useNativeDriver: ND }).start();
    } else if (mounted) {
      if (isReduceMotionEnabled()) { v.setValue(0); setMounted(false); } else Animated.timing(v, { toValue: 0, duration: 180, easing: Easing.in(Easing.cubic), useNativeDriver: ND }).start(() => setMounted(false));
    }
  }, [visible]); // eslint-disable-line react-hooks/exhaustive-deps
  const drag = useDragToDismiss({ visible: !!visible, onDismiss: onClose }); // [2026-10-17 drag-dismiss]
  if (!mounted) return null;
  const ty = v.interpolate({ inputRange: [0, 1], outputRange: [360, 0] });
  const pick = (it) => { onClose(); setTimeout(() => it.onPress?.(), Platform.OS === 'ios' ? 280 : 60); };
  return (
    <Modal transparent visible animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <DragSheetRoot style={StyleSheet.absoluteFill}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(10,10,14,0.3)', opacity: drag.enabled ? Animated.multiply(v, drag.backdropOpacity) : v }]}>
          <Pressable style={StyleSheet.absoluteFill} onPress={onClose} accessibilityRole="button" accessibilityLabel={t('common.close') || 'Fechar'} />
        </Animated.View>
        <DragPanel drag={drag} style={[ss.sheet, { backgroundColor: isDark ? '#111113' : '#FFFFFF', borderColor: P.hair, paddingBottom: (insets?.bottom || 0) + 14, transform: [{ translateY: ty }] }, softShadow(isDark, 3)]}>
          <View style={[ss.grabber, { backgroundColor: P.hair }]} />
          <View style={ss.grid}>
            {items.filter(Boolean).map((it, i) => {
              const Icon = it.icon;
              return (
                <BiaFadeIn key={it.key} delay={40 + i * 35} dy={8} duration={260} style={ss.cell}>
                  <BiaPressScale onPress={() => pick(it)} accessibilityLabel={it.label} style={[ss.tile, { backgroundColor: P.card, borderColor: P.hair }]}>
                    <View style={[ss.tileIcon, { backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : '#FFFFFF' }, !isDark && softShadow(false, 0.5)]}>
                      {Icon ? <Icon size={19} color={P.fg} /> : null}
                    </View>
                    <Text style={[ss.tileText, { color: P.fg }]} numberOfLines={2} maxFontSizeMultiplier={1.3}>{it.label}</Text>
                  </BiaPressScale>
                </BiaFadeIn>
              );
            })}
          </View>
        </DragPanel>
      </DragSheetRoot>
    </Modal>
  );
}
const ss = StyleSheet.create({
  sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 14, paddingTop: 8 },
  grabber: { alignSelf: 'center', width: 38, height: 5, borderRadius: 3, marginBottom: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5 },
  cell: { width: '50%', padding: 5 },
  tile: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, padding: 14, minHeight: 92, justifyContent: 'space-between' },
  tileIcon: { width: 36, height: 36, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  tileText: { fontSize: 15, fontWeight: '600', letterSpacing: -0.2 },
});

// ─── modo voz em tela cheia ──────────────────────────────────────────────────
export function BiaVoiceScreen({ isDark, t, voiceState, transcript, transcriptKey, onStop, onKeyboard, onInterrupt, getLevel, insets }) {
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
        {/* [2026-10-18 bia-voz-centro] título centrado de verdade (absoluto), independe da largura do cronômetro */}
        <View pointerEvents="none" style={vs.brandWrap}><Text style={[vs.brand, { color: P.fg }]}>Bia</Text></View>
        <View style={{ width: 64 }} />
      </View>
      <View style={vs.center}>
        {/* [bia-escuta 2026-10-19] tocar no orb enquanto a Bia fala/pensa = interromper e ouvir */}
        <Pressable
          disabled={!onInterrupt || orbMode === 'listening'}
          onPress={() => onInterrupt?.()}
          accessibilityRole="button"
          accessibilityLabel={t('one.interrupt') || 'Interromper e falar'}
        >
          <Animated.View style={{ transform: [{ scale: sc }] }}>
            <BiaOrb size={size} mode={orbMode} getLevel={getLevel} isDark={isDark} />
          </Animated.View>
        </Pressable>
        {/* [2026-10-18 bia-voz-centro] status CENTRADO logo abaixo do orb (antes: alignSelf flex-start → "Ouvindo..." à esquerda
            e a legenda centrada). Linha de altura fixa: trocar Ouvindo/Pensando/Falando não pula o layout. */}
        <View style={vs.stateRow}>
          <BiaShimmerText text={label} isDark={isDark} style={vs.state} align="center" />
        </View>
        <View style={vs.captionWrap}>
          {transcript ? (
            <BiaFadeIn key={transcriptKey || transcript.slice(0, 24)} dy={6} duration={260}>
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
  brandWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  brand: { fontSize: 17, fontWeight: '700', letterSpacing: -0.3 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 28 },
  stateRow: { alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center', height: 24, marginTop: 36 },
  state: { fontSize: 16, fontWeight: '600', letterSpacing: -0.2, textAlign: 'center' },
  captionWrap: { minHeight: 120, marginTop: 14, alignItems: 'center', justifyContent: 'flex-start', alignSelf: 'stretch' },
  caption: { fontSize: 22, lineHeight: 30, fontWeight: '500', textAlign: 'center', letterSpacing: -0.3 },
  bottom: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 40 },
  side: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  end: { width: 76, height: 76, borderRadius: 38, alignItems: 'center', justifyContent: 'center' },
});
