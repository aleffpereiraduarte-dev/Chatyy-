// components/settings/AppearanceExtras.js — [2026-10-18 appearance-telegram]
//
// Peças da tela "Aparência" (nível Telegram), todas JS puro (OTA-safe):
//   • ChatPreviewCard  — conversa de mentira AO VIVO no topo: mesmas cores/
//     tokens da bolha real (app/chat-conversation.js: própria #111/#333336,
//     recebida #EEEEF0/#1C1C1E, fundo #FFF/#000, ✓✓ lido #53BDEB), o papel de
//     parede real (ChatWallpaper), tinta derivada do tema (bubbleFor), formato
//     dos balões e tamanho do texto.
//   • TextSizeSlider   — tamanho do texto das mensagens 13–20 (arrastar/tocar,
//     acessível como "ajustável").
//   • ChatThemeCards   — temas de cor da conversa (padrão + monocromáticos),
//     gravados no MESMO papel de parede da conta (chat_update_settings.wallpaper)
//     que a conversa já desenha.
// Preferências locais lidas pela conversa (JS e lista nativa recebem o mesmo
// fontSize/lineHeight por prop — sem build):
//   chat_font_px  '13'..'20' (ausente = enum do servidor small/medium/large)
//   jumbo_emoji   'false' desliga os emojis grandes (padrão ligado)
// Evento APPEARANCE_EVENT faz uma conversa já montada reler na hora.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, PanResponder, StyleSheet, Platform, DeviceEventEmitter, Animated, AccessibilityInfo } from 'react-native';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect, Path } from 'react-native-svg';
import ChatWallpaper from '../wallpaper/ChatWallpaper';
import { buildValue, bubbleFor, resolve as resolveWallpaper, specFor } from '../wallpaper/wallpaperSpec';
import { IconCheck, IconSend, IconPencil } from '../Icons';
import { useGroupedColors } from './SettingsKit';
import { THEME_V2, grafite, bubbleOwnStyle, bubbleRecvStyle } from '../../constants/theme';
import SubtlePattern from '../wallpaper/SubtlePattern';
import { feedback, isReduceMotionEnabled } from '../../constants/motion';
import { ACCENT_PALETTE, resolveAccent, onAccentFor, normalizeAccent, luminance } from '../../context/ThemeContext';

export const CHAT_FONT_KEY = 'chat_font_px';
export const JUMBO_KEY = 'jumbo_emoji';
export const APPEARANCE_EVENT = 'chatyy:appearancePrefs';
export const FONT_MIN = 13;
export const FONT_MAX = 20;
export const FONT_DEFAULT = 16;
// Enum antigo do servidor (Acessibilidade / outros aparelhos) ⇄ px.
export const ENUM_PX = { small: 14, medium: 16, large: 18 };
export function pxToEnum(px) { return px <= 14 ? 'small' : (px >= 18 ? 'large' : 'medium'); }
export function normFontPx(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= FONT_MIN && n <= FONT_MAX ? n : 0;
}
// Mesma conta da conversa (16→21, 14→18, 18→24, 20→26).
export function lineHeightFor(px) { return Math.round(px * 1.31); }
export function emitAppearanceChanged() {
  try { DeviceEventEmitter.emit(APPEARANCE_EVENT); } catch {}
}

// Tokens reais da bolha (app/chat-conversation.js [2026-10-08 chat-beauty-bubbles]).
function bubbleTokens(isDark, wallpaper, accentHex, accentBubbles) {
  const tint = bubbleFor(wallpaper, isDark);
  // [2026-10-20 grafite] tema v2: mesmos tokens da conversa (grafite / branca / #EDEDEA).
  const G2 = THEME_V2 ? grafite(isDark) : null;
  if (G2) {
    const accOwn = !tint && accentHex && accentBubbles;
    const on = accOwn ? onAccentFor(accentHex) : null;
    return {
      ownBg: tint ? tint.bg : (accOwn ? accentHex : G2.ownMid),
      ownText: tint ? tint.text : (accOwn ? on : G2.ownText),
      ownMeta: tint ? tint.meta : (accOwn ? (on === '#111111' ? 'rgba(17,17,17,0.62)' : 'rgba(255,255,255,0.72)') : G2.ownMeta),
      ownGrad: !tint && !accOwn,
      otherBg: G2.recv, otherText: G2.recvText,
      otherMeta: isDark ? 'rgba(235,235,245,0.50)' : 'rgba(60,60,67,0.64)',
      wall: G2.wall, read: accOwn ? on : (accentHex || '#53BDEB'),
      link: accentHex && !accOwn ? accentHex : G2.recvText, v2: true, isDark: !!isDark,
    };
  }
  // [2026-10-19 accent-real] mesmas regras da conversa: ✓✓ lido no destaque;
  // "Balões na cor do destaque" pinta só a bolha enviada (tema colorido vence).
  if (!tint && accentHex && accentBubbles) {
    const on = onAccentFor(accentHex);
    return {
      ownBg: accentHex, ownText: on, ownMeta: on === '#111111' ? 'rgba(17,17,17,0.62)' : 'rgba(255,255,255,0.72)',
      otherBg: isDark ? '#1C1C1E' : '#EEEEF0', otherText: isDark ? '#F5F5F7' : '#111111',
      otherMeta: isDark ? 'rgba(235,235,245,0.55)' : 'rgba(60,60,67,0.74)',
      wall: isDark ? '#000000' : '#FFFFFF', read: on, link: isDark ? '#F5F5F7' : '#111111',
    };
  }
  return {
    ownBg: tint ? tint.bg : (isDark ? '#333336' : '#111111'),
    ownText: tint ? tint.text : (isDark ? '#F5F5F7' : '#FFFFFF'),
    ownMeta: tint ? tint.meta : (isDark ? 'rgba(245,245,247,0.62)' : 'rgba(255,255,255,0.62)'),
    otherBg: isDark ? '#1C1C1E' : '#EEEEF0',
    otherText: isDark ? '#F5F5F7' : '#111111',
    otherMeta: isDark ? 'rgba(235,235,245,0.55)' : 'rgba(60,60,67,0.74)',
    wall: isDark ? '#000000' : '#FFFFFF',
    read: accentHex || '#53BDEB',
    link: accentHex || (isDark ? '#F5F5F7' : '#111111'),
  };
}
// bubble_shape → raio/rabicho (mesmos números da conversa).
function shapeRadius(shape) {
  if (shape === 'square') return { r: 4, tail: 2 };
  if (shape === 'classic') return { r: 10, tail: 4 };
  return THEME_V2 ? { r: 20, tail: 6 } : { r: 18, tail: 5 };
}

function WallpaperLayer({ value, isDark, patternScale = 0.62 }) {
  const kind = useMemo(() => { try { return resolveWallpaper(value, isDark).kind; } catch { return 'none'; } }, [value, isDark]);
  if (!value || value === 'none' || kind === 'none') return null;
  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="none">
      {/* legacy (cor/gradiente/foto antigos) = mesma opacidade da conversa; v2 = miniatura parada */}
      <ChatWallpaper value={value} isDark={isDark} preview={kind !== 'legacy'} patternScale={patternScale} motion={false} autoplay={0} />
    </View>
  );
}

function PreviewBubble({ own, text, link, time, tk, fontPx, shape, last }) {
  const { r, tail } = shapeRadius(shape);
  const fs = fontPx;
  const lh = lineHeightFor(fontPx);
  const corner = last ? tail : r;
  return (
    <View style={{ alignSelf: own ? 'flex-end' : 'flex-start', maxWidth: '82%', marginTop: last ? 2 : 6 }}>
      <View style={[{
        backgroundColor: own ? tk.ownBg : tk.otherBg,
        borderRadius: r,
        ...(own ? { borderBottomRightRadius: corner } : { borderBottomLeftRadius: corner }),
        paddingLeft: 11, paddingRight: 8, paddingTop: 6, paddingBottom: 5,
        flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'flex-end',
      }, tk.v2 ? (own ? (tk.ownGrad ? bubbleOwnStyle(tk.isDark) : null) : (tk.isDark ? null : bubbleRecvStyle(false))) : null]}>
        <Text style={{ color: own ? tk.ownText : tk.otherText, fontSize: fs, lineHeight: lh, flexShrink: 1 }}>
          {text}
          {link ? <Text style={{ color: tk.link, textDecorationLine: 'underline' }}>{' ' + link}</Text> : null}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 8, marginBottom: Math.max(0, (lh - 14) / 4) }}>
          <Text style={{ color: own ? tk.ownMeta : tk.otherMeta, fontSize: 11, fontVariant: ['tabular-nums'] }}>{time}</Text>
          {own ? (
            <View style={{ flexDirection: 'row', marginLeft: 3 }}>
              <IconCheck size={12} strokeWidth={2.6} color={tk.read} style={{ marginRight: -6 }} />
              <IconCheck size={12} strokeWidth={2.6} color={tk.read} />
            </View>
          ) : null}
        </View>
      </View>
    </View>
  );
}

/** Conversa de exemplo, atualizada ao vivo. */
export function ChatPreviewCard({ isDark, wallpaper, bubbleShape, fontPx, tx, accentHex = null, accentBubbles = false }) {
  const tk = bubbleTokens(isDark, wallpaper, accentHex, accentBubbles);
  const px = normFontPx(fontPx) || FONT_DEFAULT;
  const sendBg = accentHex || (THEME_V2 ? grafite(isDark).ink : (isDark ? '#FFFFFF' : '#111111'));
  const sendFg = accentHex ? onAccentFor(accentHex) : (THEME_V2 ? grafite(isDark).onInk : (isDark ? '#111111' : '#FFFFFF'));
  return (
    <View
      style={{ backgroundColor: tk.wall, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12, overflow: 'hidden' }}
      accessible
      accessibilityLabel={tx('settings.appear.previewA11y', 'Prévia da conversa')}
    >
      {THEME_V2 && (!wallpaper || wallpaper === 'none') ? <SubtlePattern isDark={isDark} /> : null}
      <WallpaperLayer value={wallpaper} isDark={isDark} />
      <View style={{ alignSelf: 'center', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, backgroundColor: isDark ? 'rgba(44,44,46,0.92)' : 'rgba(255,255,255,0.92)', borderWidth: StyleSheet.hairlineWidth, borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', marginBottom: 4 }}>
        <Text style={{ fontSize: 12, fontWeight: '600', color: isDark ? '#EBEBF5' : '#3C3C43' }}>{tx('settings.appear.previewToday', 'Hoje')}</Text>
      </View>
      <PreviewBubble own={false} tk={tk} fontPx={px} shape={bubbleShape} time="10:41" text={tx('settings.appear.previewMsg1', 'Bom dia! Viu como ficou o novo visual?')} />
      <PreviewBubble own={false} last tk={tk} fontPx={px} shape={bubbleShape} time="10:41" text={tx('settings.appear.previewMsg2', 'Muda o tema e olha aqui.')} link="chatyy.com.br" />
      <PreviewBubble own last tk={tk} fontPx={px} shape={bubbleShape} time="10:42" text={tx('settings.appear.previewMsg3', 'Ficou elegante. Vou deixar assim.')} />
      {/* compositor de mentira: botão enviar na cor de destaque */}
      <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 10 }} pointerEvents="none">
        <View style={{ flex: 1, height: 34, borderRadius: 17, paddingHorizontal: 14, justifyContent: 'center', backgroundColor: isDark ? '#1C1C1E' : '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.14)' }}>
          <Text style={{ fontSize: 14, color: isDark ? '#8E8E93' : '#8A8A8E' }} numberOfLines={1}>{tx('settings.appear.previewComposer', 'Mensagem')}</Text>
        </View>
        <View style={{ width: 34, height: 34, borderRadius: 17, marginLeft: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: sendBg }}>
          <IconSend size={17} color={sendFg} style={{ marginLeft: -1 }} />
        </View>
      </View>
    </View>
  );
}

/** Tamanho do texto: trilho com 8 marcas (13–20), arrastar ou tocar. */
export function TextSizeSlider({ value, onChange, onCommit, tx }) {
  const g = useGroupedColors();
  const n = FONT_MAX - FONT_MIN + 1;
  const cur = normFontPx(value) || FONT_DEFAULT;
  const idx = cur - FONT_MIN;
  const [w, setW] = useState(0);
  const st = useRef({ w: 0, x0: 0, last: cur, cb: onChange, commit: onCommit });
  st.current.w = w;
  st.current.cb = onChange;
  st.current.commit = onCommit;
  const THUMB = 26;
  const pick = (x) => {
    const s = st.current;
    const usable = Math.max(1, s.w - THUMB);
    const i = Math.max(0, Math.min(n - 1, Math.round(((x - THUMB / 2) / usable) * (n - 1))));
    const px = FONT_MIN + i;
    if (px !== s.last) {
      s.last = px;
      try { feedback.selection(); } catch {}
      s.cb && s.cb(px);
    }
  };
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, gs) => Math.abs(gs.dx) > Math.abs(gs.dy),
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => {
      st.current.x0 = e.nativeEvent.locationX;
      pick(st.current.x0);
    },
    onPanResponderMove: (_e, gs) => pick(st.current.x0 + gs.dx),
    onPanResponderRelease: () => { const s = st.current; s.commit && s.commit(s.last); },
    onPanResponderTerminate: () => { const s = st.current; s.commit && s.commit(s.last); },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [n]);
  st.current.last = cur;
  const usable = Math.max(0, w - THUMB);
  const thumbX = (idx / (n - 1)) * usable;
  const step = (d) => {
    const px = Math.max(FONT_MIN, Math.min(FONT_MAX, cur + d));
    if (px === cur) return;
    try { feedback.selection(); } catch {}
    onChange && onChange(px);
    onCommit && onCommit(px);
  };
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10 }}>
      <Pressable onPress={() => step(-1)} hitSlop={10} accessibilityRole="button" accessibilityLabel={tx('settings.appear.smaller', 'Diminuir')}>
        <Text style={{ fontSize: 13, fontWeight: '500', color: g.secondary, width: 18, textAlign: 'center' }}>A</Text>
      </Pressable>
      <View
        style={{ flex: 1, height: 40, marginHorizontal: 10, justifyContent: 'center' }}
        onLayout={(e) => setW(e.nativeEvent.layout.width)}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={tx('settings.appear.textSize', 'Tamanho do texto')}
        accessibilityValue={{ min: FONT_MIN, max: FONT_MAX, now: cur, text: `${cur} pt` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 1 : -1)}
        {...pan.panHandlers}
      >
        <View pointerEvents="none" style={{ position: 'absolute', left: THUMB / 2, right: THUMB / 2, height: 3, borderRadius: 2, backgroundColor: g.fill }} />
        <View pointerEvents="none" style={{ position: 'absolute', left: THUMB / 2, width: thumbX, height: 3, borderRadius: 2, backgroundColor: g.ink }} />
        {w > 0 && Array.from({ length: n }).map((_, i) => (
          <View key={i} pointerEvents="none" style={{
            position: 'absolute', left: THUMB / 2 + (i / (n - 1)) * usable - 2, width: 4, height: 9, borderRadius: 2,
            backgroundColor: i <= idx ? g.ink : g.tertiary,
          }} />
        ))}
        {w > 0 && (
          <View pointerEvents="none" style={{
            position: 'absolute', left: thumbX, width: THUMB, height: THUMB, borderRadius: THUMB / 2,
            backgroundColor: '#FFFFFF', borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.12)',
            ...Platform.select({
              web: { boxShadow: '0 2px 6px rgba(0,0,0,0.22)' },
              default: { shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 4, shadowOffset: { width: 0, height: 2 }, elevation: 3 },
            }),
          }} />
        )}
      </View>
      <Pressable onPress={() => step(1)} hitSlop={10} accessibilityRole="button" accessibilityLabel={tx('settings.appear.larger', 'Aumentar')}>
        <Text style={{ fontSize: 21, fontWeight: '500', color: g.text, width: 22, textAlign: 'center' }}>A</Text>
      </Pressable>
      <Text style={{ marginLeft: 12, minWidth: 30, textAlign: 'right', fontSize: 15, color: g.secondary, fontVariant: ['tabular-nums'] }}>{cur}</Text>
    </View>
  );
}

// Temas de cor da conversa: padrão Chatyy (sem fundo) + os monocromáticos do
// wallpaperSpec (mono/noir/paper — bolhas P&B, sem tinta). Valor = o mesmo do
// seletor de papel de parede (wp2:{"t":"<id>"}), padrão do tema incluso.
export const CHAT_THEME_CARDS = [
  { id: 'default', value: 'none', key: 'settings.appear.themeDefault', fb: 'Clássico' },
  { id: 'mono', value: buildValue({ t: 'mono' }), key: 'settings.appear.themeMono', fb: 'Grafite' },
  { id: 'noir', value: buildValue({ t: 'noir' }), key: 'settings.appear.themeNoir', fb: 'Noir' },
  { id: 'paper', value: buildValue({ t: 'paper' }), key: 'settings.appear.themePaper', fb: 'Papel' },
];
export function chatThemeIdOf(wallpaper) {
  if (!wallpaper || wallpaper === 'none' || wallpaper === '__global__') return 'default';
  const hit = CHAT_THEME_CARDS.find((c) => c.value === wallpaper);
  if (hit) return hit.id;
  // tema mono aplicado pelo seletor com padrão/movimento próprios → ainda é o mesmo tema
  try {
    const sL = specFor(wallpaper, false); const sD = specFor(wallpaper, true);
    if (sL && sD && sL.t && sL.t === sD.t && CHAT_THEME_CARDS.some((c) => c.id === sL.t)) return sL.t;
  } catch {}
  return null; // cor/foto/outro tema → nenhum cartão marcado (linha "Papel de parede")
}

export function ChatThemeCards({ isDark, wallpaper, bubbleShape, onSelect, tx }) {
  const g = useGroupedColors();
  const selId = chatThemeIdOf(wallpaper);
  const { r } = shapeRadius(bubbleShape);
  const mini = Math.min(r, 8);
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 14, gap: 10 }}>
      {CHAT_THEME_CARDS.map((c) => {
        const on = selId === c.id;
        const tk = bubbleTokens(isDark, c.value);
        const label = tx(c.key, c.fb);
        return (
          <Pressable
            key={c.id}
            onPress={() => { if (!on) { try { feedback.selection(); } catch {} onSelect && onSelect(c.value); } }}
            accessibilityRole="radio"
            accessibilityState={{ selected: on }}
            accessibilityLabel={label}
            style={({ pressed }) => ({ alignItems: 'center', opacity: pressed ? 0.8 : 1 })}
          >
            <View style={{
              width: 86, height: 112, borderRadius: 14, overflow: 'hidden', backgroundColor: tk.wall,
              borderWidth: on ? 2 : StyleSheet.hairlineWidth, borderColor: on ? g.ink : g.separator,
              padding: 9, justifyContent: 'flex-end',
            }}>
              <WallpaperLayer value={c.value} isDark={isDark} patternScale={0.4} />
              <View style={{ alignSelf: 'flex-start', width: 46, height: 16, borderRadius: mini, borderBottomLeftRadius: Math.min(mini, 4), backgroundColor: tk.otherBg, marginBottom: 5 }} />
              <View style={{ alignSelf: 'flex-end', width: 52, height: 16, borderRadius: mini, borderBottomRightRadius: Math.min(mini, 4), backgroundColor: tk.ownBg }} />
              {on ? (
                <View style={{ position: 'absolute', top: 7, right: 7, width: 20, height: 20, borderRadius: 10, backgroundColor: g.ink, alignItems: 'center', justifyContent: 'center' }}>
                  <IconCheck size={12} color={g.onInk} strokeWidth={3} />
                </View>
              ) : null}
            </View>
            <Text numberOfLines={1} style={{ marginTop: 6, fontSize: 13, fontWeight: on ? '600' : '400', color: on ? g.text : g.secondary, maxWidth: 86 }}>{label}</Text>
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

// ─── [2026-10-19 accent-real] Seletor de COR DO DESTAQUE ─────────────────────
// Paleta curada (ThemeContext.ACCENT_PALETTE) em bolinhas grandes com nome,
// check, mola na seleção e háptico; "Personalizada" abre matiz + brilho (SVG,
// sem dependência nativa nova). A prévia no topo da Aparência acompanha AO VIVO
// (inclusive enquanto arrasta a matiz); a cor só é gravada ao soltar/tocar.
const SWATCH = 46;

// HSL → #RRGGBB
export function hslHex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const c = (x) => Math.round(x * 255).toString(16).padStart(2, '0');
  return ('#' + c(f(0)) + c(f(8)) + c(f(4))).toUpperCase();
}
// #RRGGBB → { h, l } (s fixo do editor)
function hexHL(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return { h: 210, l: 0.45 };
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  let h = 0;
  const d = mx - mn;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h), l: Math.max(0.22, Math.min(0.68, l)) };
}
const CUSTOM_SAT = 0.72;

function SwatchItem({ label, color, selected, onPress, custom, isDark, g }) {
  const scale = useRef(new Animated.Value(selected ? 1 : 0)).current;
  useEffect(() => {
    if (isReduceMotionEnabled()) { scale.setValue(selected ? 1 : 0); return; }
    Animated.spring(scale, { toValue: selected ? 1 : 0, stiffness: 420, damping: 24, mass: 1, useNativeDriver: Platform.OS !== 'web' }).start();
  }, [selected, scale]);
  const ringScale = scale.interpolate({ inputRange: [0, 1], outputRange: [0.82, 1] });
  const dotScale = scale.interpolate({ inputRange: [0, 1], outputRange: [1, 0.84] });
  const checkInk = color ? onAccentFor(color) : '#FFFFFF';
  const lowContrast = color ? (isDark ? luminance(color) < 0.04 : luminance(color) > 0.8) : false;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={label}
      style={({ pressed }) => ({ width: '16.66%', minWidth: 56, alignItems: 'center', paddingVertical: 6, opacity: pressed ? 0.75 : 1 })}
    >
      <View style={{ width: SWATCH + 10, height: SWATCH + 10, alignItems: 'center', justifyContent: 'center' }}>
        <Animated.View pointerEvents="none" style={{
          position: 'absolute', width: SWATCH + 10, height: SWATCH + 10, borderRadius: (SWATCH + 10) / 2,
          borderWidth: 2.5, borderColor: color || g.ink, opacity: scale, transform: [{ scale: ringScale }],
        }} />
        <Animated.View style={{ width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', transform: [{ scale: dotScale }],
          ...(lowContrast ? { borderWidth: StyleSheet.hairlineWidth, borderColor: g.separator } : null) }}>
          {custom && !color ? (
            <Svg width={SWATCH} height={SWATCH} viewBox="0 0 46 46">
              {[0, 45, 90, 135, 180, 225, 270, 315].map((deg) => {
                const a0 = (deg - 90) * Math.PI / 180;
                const a1 = (deg + 45 - 90) * Math.PI / 180;
                const x0 = 23 + 23 * Math.cos(a0), y0 = 23 + 23 * Math.sin(a0);
                const x1 = 23 + 23 * Math.cos(a1), y1 = 23 + 23 * Math.sin(a1);
                return <Path key={deg} d={`M23 23 L${x0.toFixed(2)} ${y0.toFixed(2)} A23 23 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`} fill={hslHex(deg + 22, 0.7, 0.55)} />;
              })}
            </Svg>
          ) : (
            <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: color }} />
          )}
          {selected ? <IconCheck size={20} strokeWidth={3} color={custom && !color ? '#FFFFFF' : checkInk} /> : null}
          {custom && color && !selected ? <IconPencil size={16} color={checkInk} /> : null}
        </Animated.View>
      </View>
      <Text numberOfLines={1} style={{ marginTop: 3, fontSize: 11.5, fontWeight: selected ? '600' : '400', color: selected ? g.text : g.secondary, maxWidth: 64 }}>{label}</Text>
    </Pressable>
  );
}

function GradientTrack({ id, stops, height = 28 }) {
  return (
    <Svg width="100%" height={height} style={StyleSheet.absoluteFill} preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient id={id} x1="0" y1="0" x2="1" y2="0">
          {stops.map((c, i) => <Stop key={i} offset={String(i / (stops.length - 1))} stopColor={c} stopOpacity="1" />)}
        </SvgLinearGradient>
      </Defs>
      <Rect x="0" y="0" width="100%" height={height} rx={height / 2} ry={height / 2} fill={`url(#${id})`} />
    </Svg>
  );
}

/** Trilho arrastável 0–1 (matiz ou brilho). */
function GradientSlider({ id, stops, value, onChange, onCommit, label, valueText, thumbColor }) {
  const [w, setW] = useState(0);
  const st = useRef({ w: 0, x0: 0, v: value, cb: onChange, commit: onCommit });
  st.current.w = w; st.current.cb = onChange; st.current.commit = onCommit;
  const H = 28; const T = 26;
  const pick = (x) => {
    const s = st.current;
    const usable = Math.max(1, s.w - T);
    const v = Math.max(0, Math.min(1, (x - T / 2) / usable));
    s.v = v;
    s.cb && s.cb(v);
  };
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: (_e, gs) => Math.abs(gs.dx) > Math.abs(gs.dy),
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: (e) => { st.current.x0 = e.nativeEvent.locationX; pick(st.current.x0); },
    onPanResponderMove: (_e, gs) => pick(st.current.x0 + gs.dx),
    onPanResponderRelease: () => { const s = st.current; try { feedback.selection(); } catch {} s.commit && s.commit(s.v); },
    onPanResponderTerminate: () => { const s = st.current; s.commit && s.commit(s.v); },
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);
  const step = (d) => {
    const v = Math.max(0, Math.min(1, value + d));
    try { feedback.selection(); } catch {}
    onChange && onChange(v); onCommit && onCommit(v);
  };
  const x = (Math.max(0, Math.min(1, value))) * Math.max(0, w - T);
  return (
    <View
      style={{ height: H + 8, justifyContent: 'center' }}
      onLayout={(e) => setW(e.nativeEvent.layout.width)}
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={label}
      accessibilityValue={{ text: valueText }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => step(e.nativeEvent.actionName === 'increment' ? 0.05 : -0.05)}
      {...pan.panHandlers}
    >
      <View pointerEvents="none" style={{ height: H, borderRadius: H / 2, overflow: 'hidden' }}>
        {w > 0 ? <GradientTrack id={id} stops={stops} height={H} /> : null}
      </View>
      {w > 0 ? (
        <View pointerEvents="none" style={{
          position: 'absolute', left: x, top: (H + 8 - T) / 2, width: T, height: T, borderRadius: T / 2,
          backgroundColor: thumbColor, borderWidth: 3, borderColor: '#FFFFFF',
          ...Platform.select({
            web: { boxShadow: '0 1px 5px rgba(0,0,0,0.30)' },
            default: { shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 3 },
          }),
        }} />
      ) : null}
    </View>
  );
}

/**
 * Seletor completo. `value` = chave da paleta ou '#hex'; `onPreview(hexOuNull)`
 * alimenta a prévia ao vivo; `onChange(valor)` grava.
 */
export function AccentPicker({ value, isDark, onChange, onPreview, tx }) {
  const g = useGroupedColors();
  const cur = normalizeAccent(value);
  const isCustom = /^#/.test(cur);
  const [open, setOpen] = useState(false);
  const [hl, setHl] = useState(() => hexHL(isCustom ? cur : '#2F80ED'));
  useEffect(() => { if (isCustom) setHl(hexHL(cur)); }, [cur, isCustom]);
  const customHex = hslHex(hl.h, CUSTOM_SAT, hl.l);
  const choose = (v) => {
    try { feedback.selection(); } catch {}
    onPreview && onPreview(null);
    onChange && onChange(v);
    try {
      if (Platform.OS !== 'web') AccessibilityInfo.announceForAccessibility?.(tx('settings.accent.chosen', 'Cor do destaque alterada'));
    } catch {}
  };
  const hueStops = useMemo(() => [0, 40, 80, 120, 160, 200, 240, 280, 320, 360].map((h) => hslHex(h, CUSTOM_SAT, 0.5)), []);
  const lightStops = useMemo(() => [0.22, 0.34, 0.45, 0.56, 0.68].map((l) => hslHex(hl.h, CUSTOM_SAT, l)), [hl.h]);
  const commitCustom = (next) => { const hex = hslHex(next.h, CUSTOM_SAT, next.l); onPreview && onPreview(null); onChange && onChange(hex); };
  return (
    <View style={{ paddingHorizontal: 8, paddingTop: 8, paddingBottom: 6 }}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap' }} accessibilityRole="radiogroup">
        {ACCENT_PALETTE.map((p) => {
          const color = p.key === 'graphite' ? (isDark ? '#F5F5F7' : '#111111') : (resolveAccent(p.key, isDark) || p.light);
          return (
            <SwatchItem
              key={p.key}
              g={g}
              isDark={isDark}
              label={tx(p.i18n, p.fb)}
              color={color}
              selected={cur === p.key}
              onPress={() => { setOpen(false); if (cur !== p.key) choose(p.key); }}
            />
          );
        })}
        <SwatchItem
          g={g}
          isDark={isDark}
          custom
          label={tx('settings.accent.custom', 'Personalizada')}
          color={isCustom ? (resolveAccent(cur, isDark) || cur) : null}
          selected={isCustom}
          onPress={() => {
            try { feedback.selection(); } catch {}
            if (!isCustom) { choose(customHex); setOpen(true); } else setOpen((o) => !o);
          }}
        />
      </View>
      {open ? (
        <View style={{ marginTop: 8, marginHorizontal: 8, padding: 12, borderRadius: 14, backgroundColor: g.fill }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
            <View style={{ width: 22, height: 22, borderRadius: 11, backgroundColor: resolveAccent(customHex, isDark) || customHex, marginRight: 8 }} />
            <Text style={{ fontSize: 13, fontWeight: '600', color: g.text, flex: 1 }}>{tx('settings.accent.customTitle', 'Sua cor')}</Text>
            <Text style={{ fontSize: 13, color: g.secondary, fontVariant: ['tabular-nums'] }} selectable>{customHex}</Text>
          </View>
          <Text style={{ fontSize: 12, color: g.secondary, marginBottom: 2 }}>{tx('settings.accent.hue', 'Matiz')}</Text>
          <GradientSlider
            id="chatyyHue"
            stops={hueStops}
            value={hl.h / 360}
            thumbColor={hslHex(hl.h, CUSTOM_SAT, 0.5)}
            label={tx('settings.accent.hue', 'Matiz')}
            valueText={`${hl.h}°`}
            onChange={(v) => { const n = { ...hl, h: Math.round(v * 360) % 360 }; setHl(n); onPreview && onPreview(hslHex(n.h, CUSTOM_SAT, n.l)); }}
            onCommit={(v) => commitCustom({ ...hl, h: Math.round(v * 360) % 360 })}
          />
          <Text style={{ fontSize: 12, color: g.secondary, marginTop: 8, marginBottom: 2 }}>{tx('settings.accent.brightness', 'Brilho')}</Text>
          <GradientSlider
            id="chatyyLight"
            stops={lightStops}
            value={(hl.l - 0.22) / 0.46}
            thumbColor={customHex}
            label={tx('settings.accent.brightness', 'Brilho')}
            valueText={`${Math.round(((hl.l - 0.22) / 0.46) * 100)}%`}
            onChange={(v) => { const n = { ...hl, l: 0.22 + v * 0.46 }; setHl(n); onPreview && onPreview(hslHex(n.h, CUSTOM_SAT, n.l)); }}
            onCommit={(v) => commitCustom({ ...hl, l: 0.22 + v * 0.46 })}
          />
        </View>
      ) : null}
    </View>
  );
}
