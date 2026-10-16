// components/notes/NativeNoteBody.js — [2026-10-16 native-notes-editor]
//
// Corpo da nota no editor NATIVO (modules/expo-email-native → view
// ChatyyNotesEditor: UITextView TextKit 1 / EditText + spans). O texto da nota
// (markdown-leve: "# título", "- item", "[] tarefa", "[x] feita", "> citação",
// "---", ``` código ```, **negrito**, *itálico*, ~~tachado~~, ==marca==…) entra
// e sai CRU — o nativo só pinta atributos, então ida e volta é identidade e o
// formato salvo no servidor (chatyy_notes.content) não muda.
//
// A tela (app/notes.js › NoteEditor) continua dona do salvamento (contentRef +
// debounce do onAutoSave). Aqui: view nativa + barra de formatação acima do
// teclado + ponte do menu "/" (onSlash → menu JS → exec('block', id)).
//
// Qualquer erro → onFailure(msg) e a tela volta ao TextInput JS na hora
// (marca globalThis.__chatyy_native_notes_editor_failed).
// Desligar (OTA/console): globalThis.__chatyy_native_notes_editor = false

import React, { forwardRef, useCallback, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Platform, processColor, ScrollView, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { getNativeNotesEditorView } from '../../modules/expo-email-native';
import { IconBold, IconItalic, IconCheckbox, IconChevronDown, IconType } from '../Icons';

export const NOTES_EDITOR_KILL_SWITCH = '__chatyy_native_notes_editor';

/** Liga o editor nativo? (binário com a view + kill switch + não falhou nesta sessão). */
export function nativeNotesEditorEnabled() {
  try {
    if (Platform.OS === 'web') return false;
    if (globalThis[NOTES_EDITOR_KILL_SWITCH] === false) return false;
    if (globalThis[`${NOTES_EDITOR_KILL_SWITCH}_failed`]) return false;
    return !!getNativeNotesEditorView();
  } catch { return false; }
}

function markFailed(msg) {
  try {
    globalThis[`${NOTES_EDITOR_KILL_SWITCH}_failed`] = true;
    console.warn('[native_notes_editor] fallback JS:', msg);
    try { require('../../services/crashReporter').reportNativeFallback('native_notes_editor', msg); } catch {}
  } catch {}
}

/** Hook: [ligado, onFailure] com queda para o TextInput JS na 1ª falha. */
export function useNativeNotesEditor() {
  const [failed, setFailed] = useState(() => {
    try { return !!globalThis[`${NOTES_EDITOR_KILL_SWITCH}_failed`]; } catch { return false; }
  });
  const enabled = !failed && nativeNotesEditorEnabled();
  const onFailure = useCallback((msg) => {
    markFailed(msg);
    setFailed(true);
  }, []);
  return [enabled, onFailure];
}

class Boundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error) {
    try { this.props.onFailure?.(String(error?.message || error)); } catch {}
  }

  render() {
    if (this.state.failed) return null;
    return this.props.children;
  }
}

/** Ids do menu "/" (app/notes.js slashOptions) → bloco do nativo. */
export const SLASH_TO_BLOCK = {
  h1: 'h1', h2: 'h2', h3: 'h3', bullet: 'bullet', num: 'number', todo: 'todo',
  code: 'code', quote: 'quote', divider: 'divider', toggle: 'toggle',
};

const NativeNoteBodyInner = forwardRef(function NativeNoteBodyInner(props, ref) {
  const {
    initialText, placeholder, textColor, secondaryColor, isDark, autoFocus = false, t, style,
  } = props;
  const propsRef = useRef(props);
  propsRef.current = props;
  const Native = getNativeNotesEditorView();
  const nativeRef = useRef(null);
  const initialRef = useRef(initialText || '');
  const [focused, setFocused] = useState(false);
  const [block, setBlock] = useState('plain');
  const [hasSel, setHasSel] = useState(false);

  const exec = useCallback((command, arg) => {
    try { nativeRef.current?.exec?.(command, arg ?? null); } catch {}
  }, []);

  useImperativeHandle(ref, () => ({
    exec,
    focus: () => { try { nativeRef.current?.focus?.(); } catch {} },
    blur: () => { try { nativeRef.current?.blur?.(); } catch {} },
    setText: (s) => { try { nativeRef.current?.setText?.(String(s ?? '')); } catch {} },
    getText: async () => { try { return await nativeRef.current?.getText?.(); } catch { return null; } },
  }), [exec]);

  // P&B: caixa marcada = tinta do texto com o check na cor do fundo.
  const theme = useMemo(() => ({
    text: processColor(textColor),
    secondary: processColor(secondaryColor),
    placeholder: processColor(secondaryColor + '88'),
    accent: processColor(textColor),
    onAccent: processColor(isDark ? '#000000' : '#FFFFFF'),
    codeBg: processColor(isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.05)'),
    highlight: processColor(isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)'),
    link: processColor(textColor),
    tint: processColor(textColor),
  }), [textColor, secondaryColor, isDark]);

  const handlers = useMemo(() => ({
    onChange: (e) => {
      const text = (e?.nativeEvent ?? e)?.text;
      if (typeof text === 'string') { try { propsRef.current.onChangeText?.(text); } catch {} }
    },
    onSelectionChange: (e) => {
      const ev = e?.nativeEvent ?? e;
      setBlock(String(ev?.block || 'plain'));
      setHasSel(Number(ev?.end) > Number(ev?.start));
    },
    onFocusChange: (e) => {
      const f = !!(e?.nativeEvent ?? e)?.focused;
      setFocused(f);
      try { propsRef.current.onFocusChange?.(f); } catch {}
    },
    onSlash: (e) => {
      const ev = e?.nativeEvent ?? e;
      try { propsRef.current.onSlash?.(!!ev?.active, String(ev?.query || '')); } catch {}
    },
  }), []);

  if (!Native) return null;

  const btn = (key, active, onPress, child, label) => (
    <TouchableOpacity
      key={key}
      onPress={onPress}
      style={[styles.tbBtn, active && { backgroundColor: isDark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.07)' }]}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: !!active }}
      hitSlop={{ top: 4, bottom: 4, left: 2, right: 2 }}
    >
      {child}
    </TouchableOpacity>
  );
  const glyph = (s, extra) => <Text style={[styles.tbGlyph, { color: textColor }, extra]}>{s}</Text>;

  return (
    <View style={[styles.fill, style]}>
      <Native
        ref={nativeRef}
        style={styles.fill}
        initialText={initialRef.current}
        placeholder={placeholder || ''}
        fontSize={17}
        theme={theme}
        padding={20}
        bottomInset={0}
        autoFocus={!!autoFocus}
        {...handlers}
      />
      {focused ? (
        <View style={[styles.toolbar, {
          backgroundColor: isDark ? '#111111' : '#FFFFFF',
          borderTopColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)',
        }]}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.tbRow}>
            {btn('todo', block === 'todo', () => exec('toggleTodo'), <IconCheckbox size={20} color={textColor} />, t('notesEditor.slashTodo'))}
            {btn('h1', block === 'h1', () => exec('block', 'h1'), <IconType size={19} color={textColor} />, t('notesEditor.slashH1'))}
            {btn('h2', block === 'h2', () => exec('block', 'h2'), glyph('H2', { fontSize: 14 }), t('notesEditor.slashH2'))}
            {btn('bullet', block === 'bullet', () => exec('block', 'bullet'), glyph('•', { fontSize: 22, lineHeight: 24 }), t('notesEditor.slashBullet'))}
            {btn('number', block === 'number', () => exec('block', 'number'), glyph('1.', { fontSize: 15 }), t('notesEditor.slashNumbered'))}
            {btn('quote', block === 'quote', () => exec('block', 'quote'), glyph('“', { fontSize: 22, lineHeight: 26 }), t('notesEditor.slashQuote'))}
            <View style={[styles.tbSep, { backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.10)' }]} />
            {btn('b', false, () => exec('wrap', '**'), <IconBold size={18} color={textColor} />, t('chat.bold'))}
            {btn('i', false, () => exec('wrap', '*'), <IconItalic size={18} color={textColor} />, t('chat.italic'))}
            {btn('s', false, () => exec('wrap', '~~'), glyph('S', { textDecorationLine: 'line-through', fontSize: 16 }), t('chat.strikethrough'))}
            {hasSel ? btn('code', false, () => exec('wrap', '`'), glyph('</>', { fontSize: 13 }), t('notesEditor.slashCode')) : null}
            {btn('code-block', block === 'code', () => exec('block', 'code'), glyph('{ }', { fontSize: 14 }), t('notesEditor.slashCode'))}
            {btn('divider', false, () => exec('block', 'divider'), glyph('—', { fontSize: 18 }), t('notesEditor.slashDivider'))}
          </ScrollView>
          {btn('done', false, () => { try { nativeRef.current?.blur?.(); } catch {} }, <IconChevronDown size={20} color={textColor} />, t('common.done'))}
        </View>
      ) : null}
    </View>
  );
});

const NativeNoteBody = forwardRef(function NativeNoteBody(props, ref) {
  return (
    <Boundary onFailure={props.onFailure}>
      <NativeNoteBodyInner {...props} ref={ref} />
    </Boundary>
  );
});

export default NativeNoteBody;

const styles = StyleSheet.create({
  fill: { flex: 1 },
  toolbar: {
    flexDirection: 'row',
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingLeft: 6,
    paddingRight: 4,
    height: 46,
  },
  tbRow: { alignItems: 'center', paddingRight: 8 },
  tbBtn: {
    minWidth: 40,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    marginHorizontal: 1,
  },
  tbGlyph: { fontSize: 16, fontWeight: '700' },
  tbSep: { width: StyleSheet.hairlineWidth, height: 22, marginHorizontal: 6 },
});
