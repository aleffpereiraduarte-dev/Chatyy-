// RichTextOverlay — WYSIWYG visual overlay for markdown-style chat composer.
//
// Why this exists
// ----------------
// The chat composer keeps using a plain RN <TextInput> internally (markdown
// stays in `inputText` and gets sent to the backend as-is), but the user
// reported that seeing raw `**bold**` `_italic_` etc. while typing is ugly
// and slow — they want Telegram/iMessage parity where the formatting renders
// inline.
//
// RN's <TextInput> does NOT support inline styled spans. The only sane path
// without rewriting the composer as a WebView editor (pell-rich / TenTap) is
// to render an absolutely-positioned <Text> layer ON TOP of the TextInput
// that paints the same string with the markdown markers HIDDEN and the
// matched text styled (bold/italic/strike/mono). The TextInput underneath
// becomes transparent text + visible caret + visible selection.
//
// Pros:  no native deps, no WebView, 100% RN, works web/iOS/Android
// Cons:  caret offset can drift when markers are hidden (we mitigate by
//        keeping the same character count — markers stay in the underlying
//        TextInput, they're just painted over with a zero-width transparent
//        span so layout stays identical)
//
// Usage
// -----
//   <View style={{ position:'relative' }}>
//     <TextInput
//       style={[composerStyle, { color: 'transparent' }]}  // text invisible
//       value={inputText}
//       onChangeText={setInputText}
//       ...
//     />
//     <RichTextOverlay
//       text={inputText}
//       style={composerStyle}   // SAME font/size/lineHeight as TextInput
//       colors={colors}
//     />
//   </View>
//
// The overlay is `pointerEvents: 'none'` so taps still hit the input. The
// caret + selection handles stay visible because RN paints those separately
// from the text glyphs.

import React, { useMemo } from 'react';
import { Text, View, StyleSheet, Platform } from 'react-native';

// Same precedence as the bubble renderer (chat-conversation.js line ~973):
//   ``` code block ```, ||spoiler||, **bold**, __italic__, ~~strike~~,
//   single *, _, ~, ` variants.
// Order matters: longer markers first so `**` doesn't get eaten by `*`.
const FORMAT_REGEX = /(```[\s\S]+?```|\|\|[^|]+?\|\||\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g;

const MARKER_STYLE = {
  // Markers stay in the layout (so caret math matches the TextInput) but
  // are drawn at the same color as the background ish — almost invisible.
  // We don't make them fully transparent because some renderers collapse
  // zero-opacity glyph metrics and that would shift the caret.
  opacity: 0.0,
};

function _parseSpans(text) {
  if (!text) return [{ text: '', fmt: null }];
  const out = [];
  let last = 0;
  let m;
  FORMAT_REGEX.lastIndex = 0;
  while ((m = FORMAT_REGEX.exec(text)) !== null) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), fmt: null });
    const raw = m[0];
    let marker = '';
    let fmt = null;
    if (raw.startsWith('```')) { marker = '```'; fmt = { fontFamily: Platform.OS === 'web' ? 'monospace' : 'Courier' }; }
    else if (raw.startsWith('||')) { marker = '||'; fmt = { opacity: 0.5 }; } // spoiler hint
    else if (raw.startsWith('**')) { marker = '**'; fmt = { fontWeight: '700' }; }
    else if (raw.startsWith('__')) { marker = '__'; fmt = { fontStyle: 'italic' }; }
    else if (raw.startsWith('~~')) { marker = '~~'; fmt = { textDecorationLine: 'line-through' }; }
    else if (raw.startsWith('*'))  { marker = '*';  fmt = { fontWeight: '700' }; }
    else if (raw.startsWith('_'))  { marker = '_';  fmt = { fontStyle: 'italic' }; }
    else if (raw.startsWith('~'))  { marker = '~';  fmt = { textDecorationLine: 'line-through' }; }
    else if (raw.startsWith('`'))  { marker = '`';  fmt = { fontFamily: Platform.OS === 'web' ? 'monospace' : 'Courier' }; }
    const inner = raw.slice(marker.length, raw.length - marker.length);
    out.push({ marker, before: true });
    out.push({ text: inner, fmt });
    out.push({ marker, before: false });
    last = m.index + raw.length;
  }
  if (last < text.length) out.push({ text: text.slice(last), fmt: null });
  return out;
}

function RichTextOverlay({ text = '', style, colors = {} }) {
  const spans = useMemo(() => _parseSpans(text), [text]);
  const textColor = (style && style.color) || colors.text || '#111';

  return (
    <View
      pointerEvents="none"
      style={styles.overlay}
      accessible={false}
      importantForAccessibility="no-hide-descendants"
    >
      <Text style={[style, { color: textColor }]} selectable={false}>
        {spans.map((s, i) => {
          if (s.marker) {
            // Render the marker characters but invisible — they MUST stay
            // in layout so the underlying TextInput glyph positions match.
            return <Text key={i} style={MARKER_STYLE}>{s.marker}</Text>;
          }
          return <Text key={i} style={s.fmt}>{s.text}</Text>;
        })}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Match the input's content inset visually. The consumer should set the
    // same paddingHorizontal/paddingVertical on its wrapper so this aligns.
  },
});

export default React.memo(RichTextOverlay);
