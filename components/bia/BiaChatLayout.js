// [2026-10-21 bia-conversa] Bia como CONVERSA (founder: "igual WhatsApp, como se
// estivesse conversando com uma pessoa, mesmo layout do chat" — ref. Meta AI no WA).
//
// Peças da tela /one quando o layout de conversa está ligado:
//   BiaChatHeader     cabeçalho de conversa: voltar · orb pequeno (avatar) · "Bia" + selo IA ·
//                     subtítulo "assistente pessoal" / "digitando..." / passo da ferramenta ·
//                     voz (abre o modo voz existente) · menu
//   BiaChatWallpaper  papel de parede PADRÃO da conversa (Grafite: fundo + SubtlePattern)
//   BiaDatePill       pílula de data (mesma geometria do separador da conversa)
//   BiaSystemNotice   aviso de sistema "As mensagens são geradas por IA... Saiba mais"
//   BiaChatRow        bolha própria (gradiente Grafite) / recebida (branca) com hora + ✓✓;
//                     resposta da Bia = markdown simples + cartões das ferramentas
//   BiaTypingBubble   indicador digitando (3 pontos) numa bolha recebida
//   BiaChatComposer   compositor da conversa: anexar · campo · câmera · microfone/enviar/parar
//   BiaChipsStrip     chips horizontais acima do compositor (sugestões / próximas perguntas)
//
// Lógica (histórico, stream, voz, anexos, ferramentas) continua TODA em app/one.js;
// aqui só a apresentação. Geometria copiada de app/chat-conversation.js (header 56 pt,
// bolha raio 18 c/ canto 5, pílula de data 12/600, barra do compositor c/ fio, botão 44).
// Kill switch (OTA): globalThis.__chatyy_bia_chat_layout = false → tela antiga da Bia.
import React, { memo, useEffect, useRef, useState } from 'react';
import {
  View, Text, TextInput, Pressable, Animated, Easing, Platform, StyleSheet, Image, ScrollView, Linking, Dimensions,
} from 'react-native';
import Svg, { Path } from 'react-native-svg';
import {
  IconChevronLeft, IconMoreVert, IconPlus, IconCamera, IconMic, IconX, IconSend,
} from '../Icons';
import { HeaderIconButton } from '../nativeHeader';
import { grafite, bubbleOwnStyle, bubbleRecvStyle, THEME_V2 } from '../../constants/theme';
import SubtlePattern, { subtlePatternOn } from '../wallpaper/SubtlePattern';
import { isReduceMotionEnabled } from '../reducedMotion';
import { BiaMarkdown, BiaToolCards } from '../BiaRich';
import BiaOrb from './BiaOrb';
import { BiaFadeIn, BiaMessageActions, GlyphWave } from './BiaUI';

const ND = Platform.OS !== 'web';

// [2026-10-21 bia-texto-cortado] largura MÁXIMA da bolha em pontos (como a conversa: BUBBLE_MAX_W),
// não em %. Com % num pai que se ajusta ao conteúdo o iOS media o texto com uma largura e
// desenhava com outra → a última palavra da linha saía cortada ("O mais recente é dc") e a
// linha seguinte sumia. Em pontos o texto é medido já na largura certa e sempre quebra.
const _WIN_W = (() => { try { return Dimensions.get('window').width || 390; } catch { return 390; } })();
const _WIDE = Platform.OS === 'web' && _WIN_W >= 900;
const OWN_MAX_W = _WIDE ? 520 : Math.round(Math.min(_WIN_W, 620) * 0.8);
const AI_MAX_W = _WIDE ? 600 : Math.round(Math.min(_WIN_W, 620) * 0.88);

export function biaChatLayoutOn() {
  try { return globalThis.__chatyy_bia_chat_layout !== false; } catch { return true; }
}

// Cores da conversa (Grafite). Sem o tema v2 o grafite() ainda devolve a paleta
// (só a sombra/gradiente da bolha somem — bubbleOwnStyle devolve {}).
export function biaChatColors(isDark) {
  const g = grafite(isDark);
  return {
    g,
    wall: g.wall,
    bar: isDark ? '#121214' : '#F7F7F5',
    fg: g.text,
    sub: g.muted,
    line: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(24,24,27,0.08)',
    own: g.ownMid,
    ownText: g.ownText,
    ownMeta: g.ownMeta,
    recv: g.recv,
    recvText: g.recvText,
    recvMeta: isDark ? 'rgba(242,242,239,0.45)' : 'rgba(24,24,27,0.42)',
    field: isDark ? '#1C1C1F' : '#FFFFFF',
    fieldBorder: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(24,24,27,0.10)',
    ink: g.ink,
    onInk: g.onInk,
    pillBg: isDark ? 'rgba(44,44,46,0.86)' : 'rgba(255,255,255,0.92)',
    pillText: isDark ? 'rgba(235,235,245,0.72)' : 'rgba(60,60,67,0.82)',
    chip: isDark ? '#1C1C1F' : '#FFFFFF',
  };
}

// ─── tempo ───────────────────────────────────────────────────────────────────
// id numérico = Date.now() do envio (one.js); histórico = created_at ISO (UTC).
export function biaMsgTs(item) {
  if (!item) return NaN;
  if (item.ts != null) {
    const raw = String(item.ts).trim();
    if (/^\d{10,}$/.test(raw)) return Number(raw);
    let s = raw.replace(' ', 'T');
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) s += 'Z';
    const ms = Date.parse(s);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof item.id === 'number' && item.id > 1e12) return item.id;
  return NaN;
}
function pad2(n) { return String(n).padStart(2, '0'); }
export function biaTimeLabel(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
export function biaDayKey(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
export function biaDayLabel(ms, t, locale) {
  const now = new Date();
  const d = Number.isFinite(ms) ? new Date(ms) : now;
  if (biaDayKey(d.getTime()) === biaDayKey(now.getTime())) return t('common.today');
  const y = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (biaDayKey(d.getTime()) === biaDayKey(y.getTime())) return t('common.yesterday');
  try {
    const sameYear = d.getFullYear() === now.getFullYear();
    return d.toLocaleDateString(locale || undefined, sameYear ? { day: 'numeric', month: 'long' } : { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`;
  }
}

// ─── ✓✓ (lida) ───────────────────────────────────────────────────────────────
function DoubleCheck({ color, size = 15 }) {
  return (
    <Svg width={size + 3} height={size * 0.7} viewBox="0 0 18 11" fill="none">
      <Path d="M1 5.8 4.4 9.2 11 1.8" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
      <Path d="M7.6 8.6 8.2 9.2 14.8 1.8" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  );
}

// ─── papel de parede ─────────────────────────────────────────────────────────
export const BiaChatWallpaper = memo(function BiaChatWallpaper({ isDark }) {
  const c = biaChatColors(isDark);
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: c.wall }]} pointerEvents="none">
      {subtlePatternOn() ? <SubtlePattern isDark={isDark} /> : null}
    </View>
  );
});

// ─── cabeçalho ───────────────────────────────────────────────────────────────
export function BiaChatHeader({ isDark, t, topInset = 0, subtitle, busy, onBack, onVoice, onMenu, onInfo }) {
  const c = biaChatColors(isDark);
  return (
    <View style={[hs.bar, { paddingTop: topInset + 6, backgroundColor: c.bar, borderBottomColor: c.line }]}>
      <HeaderIconButton onPress={onBack} style={hs.btn} accessibilityLabel={t('common.back')}>
        <IconChevronLeft size={26} color={c.fg} />
      </HeaderIconButton>
      <Pressable
        onPress={onInfo}
        style={({ pressed }) => [hs.info, pressed && Platform.OS === 'ios' ? { opacity: 0.6 } : null]}
        accessibilityRole="button"
        accessibilityLabel={`Bia, ${t('chat.aiBadge')}, ${subtitle || ''}`}
      >
        <View style={hs.avatar}>
          <BiaOrb size={38} lite isDark={isDark} mode={busy ? 'thinking' : 'idle'} animated={!!busy} />
        </View>
        <View style={hs.texts}>
          <View style={hs.nameRow}>
            <Text style={[hs.title, { color: c.fg }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>Bia</Text>
            <View style={[hs.badge, { backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(24,24,27,0.08)' }]}>
              <Text style={[hs.badgeText, { color: c.fg }]} maxFontSizeMultiplier={1.2}>{t('chat.aiBadge')}</Text>
            </View>
          </View>
          {subtitle ? (
            <Text style={[hs.sub, { color: c.sub }]} numberOfLines={1} maxFontSizeMultiplier={1.3} accessibilityLiveRegion="polite">{subtitle}</Text>
          ) : null}
        </View>
      </Pressable>
      <HeaderIconButton onPress={onVoice} style={hs.btn} accessibilityLabel={t('one.voiceConversation')}>
        <GlyphWave size={20} color={c.fg} />
      </HeaderIconButton>
      <HeaderIconButton onPress={onMenu} style={hs.btn} accessibilityLabel={t('biaChat.menu')}>
        <IconMoreVert size={22} color={c.fg} />
      </HeaderIconButton>
    </View>
  );
}
const hs = StyleSheet.create({
  bar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 6, paddingBottom: 6, minHeight: 56,
    borderBottomWidth: StyleSheet.hairlineWidth, zIndex: 10,
  },
  btn: { width: 40, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  info: { flex: 1, flexDirection: 'row', alignItems: 'center', marginHorizontal: 2, minHeight: 44 },
  avatar: { width: 38, height: 38, alignItems: 'center', justifyContent: 'center' },
  texts: { flex: 1, minWidth: 0, marginLeft: 10 },
  nameRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  title: { fontSize: 17, fontWeight: '600', letterSpacing: -0.35, flexShrink: 1 },
  badge: { paddingHorizontal: 6, paddingVertical: 1.5, borderRadius: 6 },
  badgeText: { fontSize: 10.5, fontWeight: '700', letterSpacing: 0.4 },
  sub: { fontSize: 13, marginTop: 1, fontWeight: '400', letterSpacing: -0.05 },
});

// ─── pílula de data / aviso de sistema ───────────────────────────────────────
export function BiaDatePill({ label, isDark }) {
  if (!label) return null;
  const c = biaChatColors(isDark);
  return (
    <View style={ms.dateWrap} accessibilityRole="header">
      <Text style={[ms.dateText, { color: c.pillText, backgroundColor: c.pillBg }]} maxFontSizeMultiplier={1.4}>{label}</Text>
    </View>
  );
}

export function BiaSystemNotice({ isDark, t, onLearnMore }) {
  const c = biaChatColors(isDark);
  return (
    <View style={ms.noticeWrap}>
      <View style={[ms.notice, { backgroundColor: c.pillBg }]}>
        <Text style={[ms.noticeText, { color: c.pillText }]} maxFontSizeMultiplier={1.6}>
          {t('biaChat.aiNotice')}{' '}
          <Text
            style={[ms.noticeLink, { color: c.fg }]}
            onPress={onLearnMore}
            accessibilityRole="link"
            suppressHighlighting
          >
            {t('biaChat.learnMore')}
          </Text>
        </Text>
      </View>
    </View>
  );
}

// ─── digitando (3 pontos) ────────────────────────────────────────────────────
function TypingDots({ color }) {
  const v = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (isReduceMotionEnabled()) { v.setValue(0.5); return undefined; }
    const loop = Animated.loop(Animated.timing(v, { toValue: 1, duration: 1200, easing: Easing.linear, useNativeDriver: ND }));
    loop.start();
    return () => { try { loop.stop(); } catch {} };
  }, [v]);
  const dot = (i) => {
    const a = i / 3;
    const op = v.interpolate({
      inputRange: [0, Math.max(0.001, a), Math.min(0.999, a + 0.2), Math.min(1, a + 0.4), 1],
      outputRange: [0.3, 0.3, 1, 0.3, 0.3],
      extrapolate: 'clamp',
    });
    const ty = v.interpolate({
      inputRange: [0, Math.max(0.001, a), Math.min(0.999, a + 0.2), Math.min(1, a + 0.4), 1],
      outputRange: [0, 0, -2.5, 0, 0],
      extrapolate: 'clamp',
    });
    return <Animated.View key={i} style={[ms.dot, { backgroundColor: color, opacity: op, transform: [{ translateY: ty }] }]} />;
  };
  return <View style={ms.dots}>{[0, 1, 2].map(dot)}</View>;
}

export function BiaTypingBubble({ isDark, t }) {
  const c = biaChatColors(isDark);
  return (
    <BiaFadeIn dy={6} duration={240} style={[ms.row, ms.rowOther]}>
      <View
        style={[ms.bubble, ms.bubbleOther, { backgroundColor: c.recv, minWidth: 0, paddingVertical: 12 }, bubbleRecvStyle(isDark)]}
        accessible
        accessibilityLabel={t('chat.typing')}
      >
        <TypingDots color={c.sub} />
      </View>
    </BiaFadeIn>
  );
}

// ─── linha (bolha) ───────────────────────────────────────────────────────────
const WA_OPTIN_URL = 'https://wa.me/12093093434?text=Oi!%20Quero%20receber%20lembretes%20do%20Chatyy.';

function PlainEnter({ style, children }) { return <View style={style}>{children}</View>; }

export const BiaChatRow = memo(function BiaChatRow({
  item, text, dayLabel, isDark, t, locale, isLastAI, speaking,
  onCopy, onSpeak, onRegenerate, onShare, onFeedback, onLongPressAI, onOpenCard,
}) {
  const c = biaChatColors(isDark);
  const isUser = item.role === 'user';
  const time = biaTimeLabel(biaMsgTs(item));
  const [revealed, setRevealed] = useState(false);
  // [2026-10-21 bia-rolagem] só mensagem NOVA entra deslizando; ao rolar p/ cima a lista remonta
  // linhas antigas (virtualização) e a animação fazia o texto "pular".
  const [fresh] = useState(() => { const ts = biaMsgTs(item); return !Number.isFinite(ts) || Date.now() - ts < 6000; });
  const Enter = fresh ? BiaFadeIn : PlainEnter;
  const pill = dayLabel ? <BiaDatePill label={dayLabel} isDark={isDark} /> : null;

  if (isUser) {
    return (
      <View>
        {pill}
        <Enter dy={8} duration={260} style={[ms.row, ms.rowOwn]}>
          <View style={[ms.bubble, ms.bubbleOwn, { backgroundColor: c.own }, bubbleOwnStyle(isDark), item.imageUri ? ms.bubbleMedia : null]}>
            {item.imageUri ? (
              <Image source={{ uri: item.imageUri }} style={ms.media} resizeMode="cover" accessibilityIgnoresInvertColors />
            ) : null}
            {item.content ? (
              <Text style={[ms.text, { color: c.ownText }, item.imageUri ? ms.caption : null]} selectable>
                {item.content}
                <Text style={ms.ghost}>{time ? `    ${time}   ` : ''}</Text>
              </Text>
            ) : null}
            {time ? (
              <View style={ms.meta} accessible accessibilityLabel={`${time}, ${t('biaChat.read')}`}>
                <Text style={[ms.metaText, { color: c.ownMeta }]}>{time}</Text>
                <DoubleCheck color={c.ownMeta} />
              </View>
            ) : null}
          </View>
        </Enter>
      </View>
    );
  }

  const streaming = !!item._streaming;
  const toolPending = !!item._toolPending;
  const shown = text || '';
  if ((streaming || toolPending) && !shown) {
    return (
      <View>
        {pill}
        <BiaTypingBubble isDark={isDark} t={t} />
      </View>
    );
  }
  const content = String(item.content || '');
  const showWa = !!content && (content.includes('wa.me') || (content.includes('WhatsApp') && /conecte|conectar|opt|connect/.test(content)));
  const hasCards = !streaming && Array.isArray(item.actions) && item.actions.length > 0;
  return (
    <View>
      {pill}
      <Enter dy={6} duration={260} style={[ms.row, ms.rowOther, ms.rowAi]}>
        <Pressable
          delayLongPress={320}
          onPress={() => { if (content && !streaming && onCopy) setRevealed(r => !r); }}
          onLongPress={() => { if (content && !streaming) onLongPressAI?.(item); }}
          style={[ms.bubble, ms.bubbleOther, !streaming && time ? ms.bubbleAi : null, { backgroundColor: c.recv }, bubbleRecvStyle(isDark), Platform.OS === 'web' ? { cursor: 'default' } : null]}
          accessibilityHint={onCopy ? t('biaChat.tapForActions') : undefined}
        >
          <View style={ms.aiText}>
            <BiaMarkdown text={shown} color={c.recvText} isDark={isDark} streaming={streaming && !toolPending} t={t} dense />
          </View>
          {toolPending ? <View style={{ paddingTop: 6 }}><TypingDots color={c.sub} /></View> : null}
          {!streaming && time ? (
            <View style={ms.metaAi}>
              <Text style={[ms.metaText, { color: c.recvMeta }]}>{time}</Text>
            </View>
          ) : null}
        </Pressable>
        {hasCards ? (
          <View style={ms.cards}>
            <BiaToolCards actions={item.actions} isDark={isDark} t={t} locale={locale} onOpen={onOpenCard} />
          </View>
        ) : null}
        {showWa ? (
          <Pressable
            style={[ms.waBtn, { backgroundColor: c.ink }]}
            onPress={() => {
              if (Platform.OS === 'web') { try { window.open(WA_OPTIN_URL, '_blank'); } catch {} }
              else Linking.openURL(WA_OPTIN_URL).catch(() => {});
            }}
            accessibilityRole="button"
          >
            <Text style={[ms.waBtnText, { color: c.onInk }]}>{t('one.whatsappConnectBtn')}</Text>
          </Pressable>
        ) : null}
        {content && !streaming && revealed ? (
          <View style={ms.actions}>
            <BiaMessageActions
              item={item} isDark={isDark} t={t}
              onCopy={onCopy}
              onSpeak={onSpeak} speaking={speaking}
              onRegenerate={isLastAI ? onRegenerate : null}
              onShare={onShare}
              onFeedback={onFeedback}
            />
          </View>
        ) : null}
      </Enter>
    </View>
  );
});

const ms = StyleSheet.create({
  dateWrap: { alignItems: 'center', marginVertical: 12 },
  dateText: {
    fontSize: 12, fontWeight: '600', letterSpacing: 0.2,
    paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12, overflow: 'hidden',
  },
  noticeWrap: { alignItems: 'center', marginBottom: 10, paddingHorizontal: 18 },
  notice: { maxWidth: 420, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 8 },
  noticeText: { fontSize: 12.5, lineHeight: 17, textAlign: 'center', fontWeight: '500' },
  noticeLink: { fontWeight: '700' },
  row: { marginBottom: 6, maxWidth: OWN_MAX_W },
  rowOwn: { alignSelf: 'flex-end', marginRight: 8 },
  rowOther: { alignSelf: 'flex-start', marginLeft: 8 },
  rowAi: { maxWidth: AI_MAX_W },
  bubble: { borderRadius: 18, paddingHorizontal: 12, paddingTop: 7, paddingBottom: 7, minWidth: 74, flexShrink: 1, alignSelf: 'flex-start' },
  bubbleOwn: { alignSelf: 'flex-end', borderBottomRightRadius: 5, maxWidth: OWN_MAX_W },
  bubbleOther: { borderBottomLeftRadius: 5, maxWidth: AI_MAX_W },
  bubbleAi: { paddingBottom: 20 },
  aiText: { alignSelf: 'stretch', flexShrink: 1, paddingRight: 3 }, // folga do último glifo (iOS mede um tico estreito)
  bubbleMedia: { paddingHorizontal: 4, paddingTop: 4 },
  media: { width: 232, height: 232, borderRadius: 14 },
  text: { fontSize: 16, lineHeight: 21.5, letterSpacing: -0.15, paddingRight: 3 },
  caption: { marginTop: 6, paddingHorizontal: 8, paddingBottom: 2 },
  ghost: { fontSize: 11, color: 'transparent' },
  meta: { position: 'absolute', right: 10, bottom: 5, flexDirection: 'row', alignItems: 'center', gap: 3 },
  metaAi: { position: 'absolute', right: 10, bottom: 5 },
  metaText: { fontSize: 11, fontWeight: '500', fontVariant: ['tabular-nums'] },
  dots: { flexDirection: 'row', alignItems: 'center', gap: 4, height: 10, paddingHorizontal: 2 },
  dot: { width: 7, height: 7, borderRadius: 3.5 },
  cards: { marginTop: -6, alignSelf: 'stretch', minWidth: 260 },
  waBtn: { alignSelf: 'flex-start', marginTop: 8, paddingHorizontal: 16, paddingVertical: 10, borderRadius: 999 },
  waBtnText: { fontSize: 14, fontWeight: '600' },
  actions: { marginLeft: 6 },
});

// ─── chips horizontais acima do compositor ───────────────────────────────────
export function BiaChipsStrip({ items, isDark, onPick, onLongPick }) {
  const c = biaChatColors(isDark);
  if (!items || !items.length) return null;
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={cs.chipsRow}
      style={cs.chips}
    >
      {items.map((it, i) => {
        const Icon = it.icon;
        return (
          <BiaFadeIn key={it.key || String(i)} delay={40 + i * 40} dy={6} duration={260}>
            <Pressable
              onPress={() => onPick?.(it)}
              onLongPress={onLongPick ? () => onLongPick(it) : undefined}
              accessibilityRole="button"
              accessibilityLabel={it.label}
              style={({ pressed }) => [cs.chip, { backgroundColor: c.chip, borderColor: c.fieldBorder, opacity: pressed ? 0.6 : 1 }]}
            >
              {Icon ? <Icon size={15} color={c.fg} /> : null}
              <Text style={[cs.chipText, { color: c.fg }]} numberOfLines={1} maxFontSizeMultiplier={1.4}>{it.label}</Text>
            </Pressable>
          </BiaFadeIn>
        );
      })}
    </ScrollView>
  );
}

// ─── compositor ──────────────────────────────────────────────────────────────
export function BiaChatComposer({
  isDark, t, value, onChangeText, onSend, onStop, onMic, onAttach, onCamera, listening, loading,
  attachedImage, onRemoveAttachment, onFocus, onBlur, bottomInset = 0, onHeight, maxWidth, accessory,
}) {
  const c = biaChatColors(isDark);
  const has = !!(value && value.trim()) || !!attachedImage;
  const mode = loading ? 'stop' : has ? 'send' : listening ? 'listening' : 'mic';
  const press = () => {
    if (mode === 'stop') onStop?.();
    else if (mode === 'send') onSend?.();
    else onMic?.();
  };
  const actionLbl = mode === 'stop' ? t('biaChat.stop') : mode === 'send' ? t('common.send') : mode === 'listening' ? t('biaChat.stopDictate') : t('biaChat.dictate');
  return (
    <View
      pointerEvents="box-none"
      style={cs.wrap}
      onLayout={(e) => onHeight && onHeight(Math.round(e.nativeEvent.layout.height))}
    >
      {accessory}
      <View style={[cs.bar, { backgroundColor: c.bar, borderTopColor: c.line, paddingBottom: Math.max(bottomInset, 8) }]}>
        <View style={[cs.inner, maxWidth ? { maxWidth, alignSelf: 'center', width: '100%' } : null]}>
          <Pressable onPress={onAttach} hitSlop={6} style={({ pressed }) => [cs.sideBtn, pressed ? { opacity: 0.5 } : null]} accessibilityRole="button" accessibilityLabel={t('biaChat.attach')}>
            <IconPlus size={24} color={c.fg} />
          </Pressable>
          <View style={[cs.field, { backgroundColor: c.field, borderColor: c.fieldBorder }]}>
            {attachedImage ? (
              <View style={cs.attachRow}>
                <View>
                  <Image source={{ uri: attachedImage.uri }} style={cs.attachImg} />
                  <Pressable onPress={onRemoveAttachment} style={cs.attachX} hitSlop={8} accessibilityRole="button" accessibilityLabel={t('common.remove') || t('common.delete')}>
                    <IconX size={11} color="#fff" />
                  </Pressable>
                </View>
                {attachedImage.extra && attachedImage.extra.length ? (
                  <Text style={[cs.attachMore, { color: c.sub }]}>+{attachedImage.extra.length}</Text>
                ) : null}
              </View>
            ) : null}
            <View style={cs.fieldRow}>
              <TextInput
                style={[cs.input, { color: c.fg }, Platform.OS === 'web' ? { outlineStyle: 'none' } : null]}
                placeholder={listening ? t('one.voiceListening') : t('biaChat.placeholder')}
                placeholderTextColor={c.sub}
                value={value}
                onChangeText={onChangeText}
                onKeyPress={(e) => {
                  if (Platform.OS === 'web' && e.nativeEvent.key === 'Enter' && !e.nativeEvent.shiftKey) { e.preventDefault(); onSend?.(); }
                }}
                onFocus={onFocus}
                onBlur={onBlur}
                multiline
                {...(Platform.OS === 'web' ? { rows: 1 } : null)}
                maxLength={2000}
                editable={!loading}
                accessibilityLabel={t('biaChat.placeholder')}
              />
              {!has && onCamera ? (
                <Pressable onPress={onCamera} hitSlop={6} style={({ pressed }) => [cs.inBtn, pressed ? { opacity: 0.5 } : null]} accessibilityRole="button" accessibilityLabel={t('biaChat.camera')}>
                  <IconCamera size={22} color={c.fg} />
                </Pressable>
              ) : null}
            </View>
          </View>
          <Pressable
            key={mode === 'mic' ? 'mic' : 'ink'} // fundo muda de forma (sem fundo ↔ círculo): elemento novo, sem estilo velho no web
            onPress={press}
            accessibilityRole="button"
            accessibilityLabel={actionLbl}
            style={({ pressed }) => [cs.action, mode === 'mic' ? null : { backgroundColor: c.ink }, { transform: [{ scale: pressed ? 0.92 : 1 }] }]}
          >
            {mode === 'stop' || mode === 'listening' ? (
              <View style={[cs.stopSq, { backgroundColor: c.onInk }]} />
            ) : mode === 'send' ? (
              <IconSend size={19} color={c.onInk} />
            ) : (
              <IconMic size={23} color={c.fg} />
            )}
          </Pressable>
        </View>
      </View>
    </View>
  );
}
const cs = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  bar: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 6 },
  inner: { flexDirection: 'row', alignItems: 'flex-end', paddingLeft: 4, paddingRight: 8, gap: 4 },
  sideBtn: { width: 40, height: 44, alignItems: 'center', justifyContent: 'center' },
  field: { flex: 1, minHeight: 44, borderRadius: 22, borderWidth: StyleSheet.hairlineWidth, justifyContent: 'center' },
  fieldRow: { flexDirection: 'row', alignItems: 'flex-end' },
  input: {
    flex: 1, fontSize: 16.5, lineHeight: 21, minHeight: 42, maxHeight: 140,
    paddingLeft: 14, paddingRight: 6, paddingTop: Platform.OS === 'ios' ? 11 : 9, paddingBottom: Platform.OS === 'ios' ? 11 : 9,
    textAlignVertical: 'center',
  },
  inBtn: { width: 42, height: 42, alignItems: 'center', justifyContent: 'center' },
  action: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  stopSq: { width: 13, height: 13, borderRadius: 3 },
  attachRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 8, paddingTop: 8 },
  attachImg: { width: 64, height: 64, borderRadius: 12 },
  attachX: { position: 'absolute', top: -6, right: -6, width: 20, height: 20, borderRadius: 10, backgroundColor: '#18181B', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#fff' },
  attachMore: { fontSize: 13, fontWeight: '600' },
  chips: { flexGrow: 0 },
  chipsRow: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 7, height: 36, borderRadius: 18,
    paddingHorizontal: 14, borderWidth: StyleSheet.hairlineWidth,
    ...(THEME_V2 ? Platform.select({ web: { boxShadow: '0 1px 2px rgba(0,0,0,0.05)' }, default: {} }) : {}),
  },
  chipText: { fontSize: 14.5, fontWeight: '500', letterSpacing: -0.15, maxWidth: 260 },
});
