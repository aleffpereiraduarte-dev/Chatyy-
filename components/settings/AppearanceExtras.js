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
import React, { useMemo, useRef, useState } from 'react';
import { View, Text, Pressable, ScrollView, PanResponder, StyleSheet, Platform, DeviceEventEmitter } from 'react-native';
import ChatWallpaper from '../wallpaper/ChatWallpaper';
import { buildValue, bubbleFor, resolve as resolveWallpaper, specFor } from '../wallpaper/wallpaperSpec';
import { IconCheck } from '../Icons';
import { useGroupedColors } from './SettingsKit';
import { feedback } from '../../constants/motion';

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
function bubbleTokens(isDark, wallpaper) {
  const tint = bubbleFor(wallpaper, isDark);
  return {
    ownBg: tint ? tint.bg : (isDark ? '#333336' : '#111111'),
    ownText: tint ? tint.text : (isDark ? '#F5F5F7' : '#FFFFFF'),
    ownMeta: tint ? tint.meta : (isDark ? 'rgba(245,245,247,0.62)' : 'rgba(255,255,255,0.62)'),
    otherBg: isDark ? '#1C1C1E' : '#EEEEF0',
    otherText: isDark ? '#F5F5F7' : '#111111',
    otherMeta: isDark ? 'rgba(235,235,245,0.55)' : 'rgba(60,60,67,0.74)',
    wall: isDark ? '#000000' : '#FFFFFF',
    read: '#53BDEB',
  };
}
// bubble_shape → raio/rabicho (mesmos números da conversa).
function shapeRadius(shape) {
  if (shape === 'square') return { r: 4, tail: 2 };
  if (shape === 'classic') return { r: 10, tail: 4 };
  return { r: 18, tail: 5 };
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

function PreviewBubble({ own, text, time, tk, fontPx, shape, last }) {
  const { r, tail } = shapeRadius(shape);
  const fs = fontPx;
  const lh = lineHeightFor(fontPx);
  const corner = last ? tail : r;
  return (
    <View style={{ alignSelf: own ? 'flex-end' : 'flex-start', maxWidth: '82%', marginTop: last ? 2 : 6 }}>
      <View style={{
        backgroundColor: own ? tk.ownBg : tk.otherBg,
        borderRadius: r,
        ...(own ? { borderBottomRightRadius: corner } : { borderBottomLeftRadius: corner }),
        paddingLeft: 11, paddingRight: 8, paddingTop: 6, paddingBottom: 5,
        flexDirection: 'row', flexWrap: 'wrap', alignItems: 'flex-end', justifyContent: 'flex-end',
      }}>
        <Text style={{ color: own ? tk.ownText : tk.otherText, fontSize: fs, lineHeight: lh, flexShrink: 1 }}>{text}</Text>
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
export function ChatPreviewCard({ isDark, wallpaper, bubbleShape, fontPx, tx }) {
  const tk = bubbleTokens(isDark, wallpaper);
  const px = normFontPx(fontPx) || FONT_DEFAULT;
  return (
    <View
      style={{ backgroundColor: tk.wall, paddingHorizontal: 12, paddingTop: 12, paddingBottom: 12, overflow: 'hidden' }}
      accessible
      accessibilityLabel={tx('settings.appear.previewA11y', 'Prévia da conversa')}
    >
      <WallpaperLayer value={wallpaper} isDark={isDark} />
      <View style={{ alignSelf: 'center', paddingHorizontal: 10, paddingVertical: 3, borderRadius: 10, backgroundColor: isDark ? 'rgba(44,44,46,0.92)' : 'rgba(255,255,255,0.92)', borderWidth: StyleSheet.hairlineWidth, borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.08)', marginBottom: 4 }}>
        <Text style={{ fontSize: 12, fontWeight: '600', color: isDark ? '#EBEBF5' : '#3C3C43' }}>{tx('settings.appear.previewToday', 'Hoje')}</Text>
      </View>
      <PreviewBubble own={false} tk={tk} fontPx={px} shape={bubbleShape} time="10:41" text={tx('settings.appear.previewMsg1', 'Bom dia! Viu como ficou o novo visual?')} />
      <PreviewBubble own={false} last tk={tk} fontPx={px} shape={bubbleShape} time="10:41" text={tx('settings.appear.previewMsg2', 'Muda o tema e olha aqui.')} />
      <PreviewBubble own last tk={tk} fontPx={px} shape={bubbleShape} time="10:42" text={tx('settings.appear.previewMsg3', 'Ficou elegante. Vou deixar assim.')} />
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
