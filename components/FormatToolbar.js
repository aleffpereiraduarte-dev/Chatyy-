import React, { useRef, useEffect } from 'react';
import { View, TouchableOpacity, Text, StyleSheet, Animated, Platform } from 'react-native';
// Static import — Metro precisa do módulo no bundle de qualquer jeito;
// `require` dentro do handler escondia a dependência e dificultava bundle.
let _Haptics = null;
try { _Haptics = require('expo-haptics'); } catch {}

// WhatsApp/Telegram-grade markdown toolbar.
// Pills com glyph estilizado por tipo (B negrito, I itálico, S tachado, etc).
// Tap aplica/desaplica o marker na seleção, ou insere par com cursor no meio.
const BUTTONS = [
  { id: 'bold',   marker: '*',   glyph: 'B',   tip: 'Negrito' },
  { id: 'italic', marker: '_',   glyph: 'I',   tip: 'Itálico' },
  { id: 'strike', marker: '~',   glyph: 'S',   tip: 'Tachado' },
  { id: 'mono',   marker: '`',   glyph: '</>', tip: 'Monoespaçado' },
  { id: 'spoil',  marker: '||',  glyph: '▮',   tip: 'Spoiler' },
  { id: 'code',   marker: '```', glyph: '⌨',   tip: 'Bloco código', block: true },
];

const GLYPH_STYLES = {
  bold:   { fontWeight: '800' },
  italic: { fontStyle: 'italic' },
  strike: { textDecorationLine: 'line-through' },
  mono:   { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 14, fontWeight: '700' },
  spoil:  { fontWeight: '800' },
  code:   { fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 14 },
};

// Detecção de tema escuro robusta — calcula luminância do `colors.background`
// em vez de regex em hex. Cobre `#fff`, `#0d0d0d`, `rgb(...)`, nomes (white/black).
function _isDarkBg(bg) {
  if (!bg || typeof bg !== 'string') return false;
  const lower = bg.toLowerCase().trim();
  if (lower === 'black' || lower === '#000' || lower === '#000000') return true;
  if (lower === 'white' || lower === '#fff' || lower === '#ffffff') return false;
  // hex → r,g,b
  let r = 255, g = 255, b = 255;
  const hex = lower.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (hex) {
    const h = hex[1].length === 3
      ? hex[1].split('').map(c => c + c).join('')
      : hex[1];
    r = parseInt(h.slice(0, 2), 16);
    g = parseInt(h.slice(2, 4), 16);
    b = parseInt(h.slice(4, 6), 16);
  } else {
    const m = lower.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
    if (m) { r = +m[1]; g = +m[2]; b = +m[3]; }
  }
  // perceived luminance (sRGB simplified)
  const lum = (r * 299 + g * 587 + b * 114) / 1000;
  return lum < 128;
}

export default function FormatToolbar({ text = '', setText, selection, colors = {}, inputRef }) {
  const enterAnim = useRef(new Animated.Value(0)).current;
  // Tracks last cursor request — reaplica num useEffect depois do `text` mudar
  // pra não competir com o re-render do TextInput. (Antes setNativeProps logo
  // após setText era ignorado/clampado porque o text ainda não estava renderizado.)
  const pendingCursorRef = useRef(null);

  useEffect(() => {
    Animated.spring(enterAnim, { toValue: 1, tension: 220, friction: 18, useNativeDriver: true }).start();
  }, [enterAnim]);

  // Aplica o cursor pendente DEPOIS do commit do text. requestAnimationFrame
  // garante que o TextInput já consumiu a nova prop `value`.
  useEffect(() => {
    const pos = pendingCursorRef.current;
    if (pos == null) return;
    pendingCursorRef.current = null;
    const apply = () => {
      try {
        if (inputRef?.current?.setNativeProps) {
          inputRef.current.setNativeProps({ selection: { start: pos, end: pos } });
        }
        if (inputRef?.current?.focus) inputRef.current.focus();
      } catch {}
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
    else setTimeout(apply, 16);
  }, [text, inputRef]);

  const wrapSelection = (marker, isBlock) => {
    const start = selection?.start ?? text.length;
    const end   = selection?.end   ?? text.length;
    if (start === end) {
      // Cursor único — insere marker duplo. Para code block, adiciona quebras
      // de linha (```\n…\n```) que é o padrão markdown real.
      const open = isBlock ? marker + '\n' : marker;
      const close = isBlock ? '\n' + marker : marker;
      const next = text.slice(0, start) + open + close + text.slice(start);
      setText(next);
      pendingCursorRef.current = start + open.length;
    } else {
      const selected = text.slice(start, end);
      // Se já tem o marker em volta da seleção, REMOVE (toggle).
      const before = text.slice(Math.max(0, start - marker.length), start);
      const after  = text.slice(end, end + marker.length);
      if (before === marker && after === marker) {
        const cleaned = text.slice(0, start - marker.length) + selected + text.slice(end + marker.length);
        setText(cleaned);
        pendingCursorRef.current = start - marker.length + selected.length;
        return;
      }
      const open = isBlock ? marker + '\n' : marker;
      const close = isBlock ? '\n' + marker : marker;
      setText(text.slice(0, start) + open + selected + close + text.slice(end));
      pendingCursorRef.current = end + open.length + close.length;
    }
    if (_Haptics?.selectionAsync) {
      _Haptics.selectionAsync().catch(() => {});
    }
  };

  const isDark = _isDarkBg(colors.background);
  const tray = isDark ? 'rgba(20,20,28,0.98)' : 'rgba(248,248,250,0.98)';
  const pill = isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)';
  const pillActive = '#7C3AED';

  return (
    <Animated.View
      style={[
        styles.container,
        {
          backgroundColor: tray,
          borderTopColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          opacity: enterAnim,
          transform: [{
            translateY: enterAnim.interpolate({ inputRange: [0, 1], outputRange: [10, 0] }),
          }],
        },
      ]}
    >
      {BUTTONS.map(b => (
        <TouchableOpacity
          key={b.id}
          onPress={() => wrapSelection(b.marker, b.block)}
          activeOpacity={0.65}
          style={[styles.pill, { backgroundColor: pill }]}
          accessibilityLabel={b.tip}
          accessibilityRole="button"
        >
          <Text style={[styles.glyph, { color: pillActive }, GLYPH_STYLES[b.id]]}>{b.glyph}</Text>
        </TouchableOpacity>
      ))}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 9,
    gap: 6,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  pill: {
    flex: 1,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: 38,
  },
  glyph: {
    fontSize: 15,
    letterSpacing: 0.2,
  },
});
