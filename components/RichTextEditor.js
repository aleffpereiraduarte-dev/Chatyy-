import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, TextInput, Animated } from 'react-native';
import Svg, { Path, Line, Circle, Rect } from 'react-native-svg';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius, FontFamily } from '../constants/theme';
import { IconBold, IconItalic, IconUnderline, IconLink } from './Icons';

// ─── Inline SVG icons for the formatting toolbar ───
// Local to RichTextEditor so we don't bloat the global Icons.js with editor-only glyphs.
const fmtSvgProps = (color) => ({
  width: 18, height: 18, viewBox: '0 0 24 24',
  fill: 'none', stroke: color, strokeWidth: 2,
  strokeLinecap: 'round', strokeLinejoin: 'round',
});
const FmtIconStrike = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Path d="M16 4H9a3 3 0 0 0-2.83 4" />
    <Path d="M14 12a4 4 0 0 1 0 8H6" />
    <Line x1="4" y1="12" x2="20" y2="12" />
  </Svg>
);
const FmtIconAlignLeft = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Line x1="4" y1="6" x2="20" y2="6" />
    <Line x1="4" y1="12" x2="14" y2="12" />
    <Line x1="4" y1="18" x2="18" y2="18" />
  </Svg>
);
const FmtIconAlignCenter = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Line x1="4" y1="6" x2="20" y2="6" />
    <Line x1="7" y1="12" x2="17" y2="12" />
    <Line x1="5" y1="18" x2="19" y2="18" />
  </Svg>
);
const FmtIconAlignRight = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Line x1="4" y1="6" x2="20" y2="6" />
    <Line x1="10" y1="12" x2="20" y2="12" />
    <Line x1="6" y1="18" x2="20" y2="18" />
  </Svg>
);
const FmtIconBulletList = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Line x1="9" y1="6" x2="20" y2="6" />
    <Line x1="9" y1="12" x2="20" y2="12" />
    <Line x1="9" y1="18" x2="20" y2="18" />
    <Circle cx="5" cy="6" r="1.4" fill={color} />
    <Circle cx="5" cy="12" r="1.4" fill={color} />
    <Circle cx="5" cy="18" r="1.4" fill={color} />
  </Svg>
);
const FmtIconNumberedList = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Line x1="10" y1="6" x2="20" y2="6" />
    <Line x1="10" y1="12" x2="20" y2="12" />
    <Line x1="10" y1="18" x2="20" y2="18" />
    <Path d="M4 4v4" />
    <Path d="M3 14h3l-3 4h3" />
  </Svg>
);
const FmtIconQuote = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Path d="M3 21c3 0 7-1 7-8V5c0-1.25-.75-2-2-2H4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2h2.6c-.4 4-2 4.4-3.6 4.4z" />
    <Path d="M15 21c3 0 7-1 7-8V5c0-1.25-.75-2-2-2h-4c-1.25 0-2 .75-2 2v6c0 1.25.75 2 2 2h2.6c-.4 4-2 4.4-3.6 4.4z" />
  </Svg>
);
const FmtIconCode = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Path d="M16 18l6-6-6-6" />
    <Path d="M8 6l-6 6 6 6" />
  </Svg>
);
const FmtIconClear = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Path d="M4 7h16" />
    <Path d="M9 7V4h6v3" />
    <Line x1="6" y1="20" x2="18" y2="6" />
  </Svg>
);
const FmtIconUndo = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Path d="M3 7v6h6" />
    <Path d="M3 13a9 9 0 1 0 3-7L3 9" />
  </Svg>
);
const FmtIconRedo = ({ color }) => (
  <Svg {...fmtSvgProps(color)}>
    <Path d="M21 7v6h-6" />
    <Path d="M21 13a9 9 0 1 1-3-7l3 3" />
  </Svg>
);
const FmtIconTextSize = ({ color, big }) => (
  <Svg {...fmtSvgProps(color)}>
    {big ? (
      <>
        <Path d="M5 18l4-12 4 12" />
        <Line x1="6" y1="14" x2="12" y2="14" />
        <Path d="M14 18l3-9 3 9" />
        <Line x1="15" y1="15" x2="19" y2="15" />
      </>
    ) : (
      <>
        <Path d="M6 18l3-9 3 9" />
        <Line x1="7" y1="15" x2="11" y2="15" />
        <Path d="M15 18l2-6 2 6" />
        <Line x1="15.5" y1="16" x2="18.5" y2="16" />
      </>
    )}
  </Svg>
);
const FmtIconColorSwatch = ({ color }) => (
  <Svg width={18} height={18} viewBox="0 0 24 24">
    <Path d="M12 4l-7 12a3.5 3.5 0 0 0 0 1c.4 1.5 1.7 3 4 3 1.7 0 3.3-1 5-3" stroke="#94a3b8" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    <Rect x="4" y="18" width="16" height="3" rx="1" fill={color} />
  </Svg>
);

// ─── WebView import (mobile only) ───
let WebView = null;
if (Platform.OS !== 'web') {
  try {
    WebView = require('react-native-webview').default;
  } catch {}
}

// ─── Toolbar button definitions (grouped) ───
// Each group renders inside a row with a thin divider between groups.
// `iconKey` references `renderFmtIcon()` below.
const TOOLBAR_GROUPS = [
  // 1. Inline format
  [
    { id: 'bold',          command: 'bold',          iconKey: 'bold' },
    { id: 'italic',        command: 'italic',        iconKey: 'italic' },
    { id: 'underline',     command: 'underline',     iconKey: 'underline' },
    { id: 'strikethrough', command: 'strikeThrough', iconKey: 'strike' },
  ],
  // 2. Font size
  [
    { id: 'fontSize1', command: 'fontSize', arg: '2', iconKey: 'sizeSmall' },
    { id: 'fontSize3', command: 'fontSize', arg: '5', iconKey: 'sizeLarge' },
  ],
  // 3. Color swatches
  [
    { id: 'colorRed',   command: 'foreColor', arg: '#dc2626', iconKey: 'swatch', color: '#dc2626' },
    { id: 'colorBlue',  command: 'foreColor', arg: '#2563eb', iconKey: 'swatch', color: '#2563eb' },
    { id: 'colorGreen', command: 'foreColor', arg: '#16a34a', iconKey: 'swatch', color: '#16a34a' },
    { id: 'colorBlack', command: 'foreColor', arg: '#111827', iconKey: 'swatch', color: '#111827' },
  ],
  // 4. Alignment
  [
    { id: 'alignLeft',   command: 'justifyLeft',   iconKey: 'alignLeft' },
    { id: 'alignCenter', command: 'justifyCenter', iconKey: 'alignCenter' },
    { id: 'alignRight',  command: 'justifyRight',  iconKey: 'alignRight' },
  ],
  // 5. Lists / blocks
  [
    { id: 'bulletList',   command: 'insertUnorderedList', iconKey: 'bullet' },
    { id: 'numberedList', command: 'insertOrderedList',   iconKey: 'numbered' },
    { id: 'blockquote',   command: 'formatBlock', arg: 'BLOCKQUOTE', iconKey: 'quote' },
    { id: 'code',         command: 'formatBlock', arg: 'PRE',        iconKey: 'code' },
  ],
  // 6. Link + clear format
  [
    { id: 'link',        command: 'createLink',   iconKey: 'link' },
    { id: 'clearFormat', command: 'removeFormat', iconKey: 'clear' },
  ],
  // 7. Undo / redo
  [
    { id: 'undo', command: 'undo', iconKey: 'undo' },
    { id: 'redo', command: 'redo', iconKey: 'redo' },
  ],
];

function renderFmtIcon(key, color, btn) {
  switch (key) {
    case 'bold':       return <IconBold size={18} color={color} />;
    case 'italic':     return <IconItalic size={18} color={color} />;
    case 'underline':  return <IconUnderline size={18} color={color} />;
    case 'strike':     return <FmtIconStrike color={color} />;
    case 'link':       return <IconLink size={18} color={color} />;
    case 'sizeSmall':  return <FmtIconTextSize color={color} big={false} />;
    case 'sizeLarge':  return <FmtIconTextSize color={color} big />;
    case 'swatch':     return <FmtIconColorSwatch color={btn?.color || color} />;
    case 'alignLeft':  return <FmtIconAlignLeft color={color} />;
    case 'alignCenter':return <FmtIconAlignCenter color={color} />;
    case 'alignRight': return <FmtIconAlignRight color={color} />;
    case 'bullet':     return <FmtIconBulletList color={color} />;
    case 'numbered':   return <FmtIconNumberedList color={color} />;
    case 'quote':      return <FmtIconQuote color={color} />;
    case 'code':       return <FmtIconCode color={color} />;
    case 'clear':      return <FmtIconClear color={color} />;
    case 'undo':       return <FmtIconUndo color={color} />;
    case 'redo':       return <FmtIconRedo color={color} />;
    default:           return null;
  }
}
// ─── Toolbar Button — pill with scale-pop on press, active tint ───
function ToolbarButton({ btn, onPress, colors, activeCommands }) {
  const isActive = activeCommands.includes(btn.command);
  const scale = useRef(new Animated.Value(1)).current;
  const onIn = useCallback(() => {
    Animated.spring(scale, { toValue: 0.9, useNativeDriver: true, friction: 6, tension: 200 }).start();
  }, [scale]);
  const onOut = useCallback(() => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: true, friction: 5, tension: 200 }).start();
  }, [scale]);

  const iconColor = isActive ? colors.primary : (colors.textSecondary || '#64748b');
  // 1A = ~10% alpha; tints active button without overpowering the icon
  const bg = isActive ? (colors.primary + '1A') : 'transparent';

  return (
    <TouchableOpacity
      onPress={() => onPress(btn)}
      onPressIn={onIn}
      onPressOut={onOut}
      activeOpacity={0.85}
      accessibilityLabel={btn.id}
      accessibilityRole="button"
    >
      <Animated.View
        style={[
          styles.toolbarBtn,
          {
            backgroundColor: bg,
            transform: [{ scale }],
            ...Platform.select({
              web: { cursor: 'pointer', transition: 'background-color 0.15s ease' },
              default: {},
            }),
          },
        ]}
      >
        {renderFmtIcon(btn.iconKey, iconColor, btn)}
      </Animated.View>
    </TouchableOpacity>
  );
}

// ─── Formatting Toolbar — grouped pills + dividers ───
function Toolbar({ onCommand, colors, activeCommands }) {
  return (
    <View
      style={[
        styles.toolbar,
        {
          backgroundColor: colors.surfaceVariant || colors.surface,
          borderColor: colors.borderLight,
        },
      ]}
    >
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.toolbarContent}
        keyboardShouldPersistTaps="always"
      >
        {TOOLBAR_GROUPS.map((group, gi) => (
          <View key={`g${gi}`} style={styles.toolbarGroupRow}>
            <View style={styles.toolbarGroup}>
              {group.map(btn => (
                <ToolbarButton
                  key={btn.id}
                  btn={btn}
                  onPress={onCommand}
                  colors={colors}
                  activeCommands={activeCommands}
                />
              ))}
            </View>
            {gi < TOOLBAR_GROUPS.length - 1 && (
              <View style={[styles.divider, { backgroundColor: colors.borderLight }]} />
            )}
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Web Editor (contentEditable div) ───
function WebEditor({ value, onChange, placeholder, minHeight, colors, isDark, cardMode }) {
  const editorRef = useRef(null);
  const [activeCommands, setActiveCommands] = useState([]);
  const isInternalChange = useRef(false);
  const [ghostText, setGhostText] = useState('');
  const ghostTimerRef = useRef(null);
  const ghostAbortRef = useRef(null);

  // Set initial value
  useEffect(() => {
    if (editorRef.current && value && !editorRef.current.innerHTML) {
      editorRef.current.innerHTML = value;
    }
  }, [value]);

  // Cleanup ghost timer on unmount
  useEffect(() => {
    return () => {
      clearTimeout(ghostTimerRef.current);
      if (ghostAbortRef.current) ghostAbortRef.current.abort?.();
    };
  }, []);

  const checkActiveFormats = useCallback(() => {
    const cmds = ['bold', 'italic', 'underline', 'strikeThrough',
                  'insertUnorderedList', 'insertOrderedList'];
    const active = cmds.filter(cmd => {
      try { return document.queryCommandState(cmd); } catch { return false; }
    });
    setActiveCommands(active);
  }, []);

  const handleInput = useCallback(() => {
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      // Treat empty editor or only whitespace/br as empty
      const isEmpty = !html || html === '<br>' || html.replace(/<br\s*\/?>/g, '').trim() === '';
      onChange(isEmpty ? '' : html);
    }
    checkActiveFormats();

    // Smart compose: debounce 800ms after typing
    setGhostText('');
    clearTimeout(ghostTimerRef.current);
    if (ghostAbortRef.current) { ghostAbortRef.current.abort?.(); ghostAbortRef.current = null; }

    // Check if smart compose is enabled
    try {
      if (typeof localStorage !== 'undefined' && localStorage.getItem('smart_compose') === 'false') return;
    } catch {}

    ghostTimerRef.current = setTimeout(async () => {
      if (!editorRef.current) return;
      const text = editorRef.current.innerText || '';
      if (text.trim().length < 10) return;
      try {
        const { aiAssist } = await import('../services/api');
        const r = await aiAssist('smart_compose', { text: text.slice(-200) });
        if (r.success && r.data?.result) {
          setGhostText(r.data.result);
        }
      } catch {}
    }, 800);
  }, [onChange, checkActiveFormats]);

  const handleKeyUp = useCallback(() => {
    checkActiveFormats();
  }, [checkActiveFormats]);

  const handleMouseUp = useCallback(() => {
    checkActiveFormats();
  }, [checkActiveFormats]);

  const handleCommand = useCallback((btn) => {
    if (!editorRef.current) return;
    editorRef.current.focus();

    if (btn.command === 'createLink') {
      const selection = window.getSelection();
      const selectedText = selection?.toString() || '';
      const url = prompt('Enter URL:', selectedText.startsWith('http') ? selectedText : 'https://');
      if (url) {
        document.execCommand('createLink', false, url);
      }
    } else if (btn.command === 'fontSize' || btn.command === 'foreColor') {
      document.execCommand(btn.command, false, btn.arg);
    } else if (btn.command === 'formatBlock' && btn.arg) {
      const current = document.queryCommandValue('formatBlock');
      if (current.toLowerCase() === btn.arg.toLowerCase()) {
        document.execCommand('formatBlock', false, 'P');
      } else {
        document.execCommand('formatBlock', false, btn.arg);
      }
    } else if (btn.command.startsWith('justify')) {
      document.execCommand(btn.command, false, null);
    } else {
      document.execCommand(btn.command, false, null);
    }

    handleInput();
  }, [handleInput]);

  // Keyboard shortcuts
  const handleKeyDown = useCallback((e) => {
    // Tab: accept smart compose suggestion
    if (e.key === 'Tab' && ghostText) {
      e.preventDefault();
      document.execCommand('insertText', false, ghostText);
      setGhostText('');
      handleInput();
      return;
    }
    // Escape: dismiss ghost text
    if (e.key === 'Escape' && ghostText) {
      setGhostText('');
      return;
    }
    // Any other key clears ghost
    if (ghostText && !e.metaKey && !e.ctrlKey && !e.altKey && e.key.length === 1) {
      setGhostText('');
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey) {
      const shortcuts = { b: 'bold', i: 'italic', u: 'underline' };
      if (shortcuts[e.key]) {
        e.preventDefault();
        document.execCommand(shortcuts[e.key], false, null);
        handleInput();
      }
    }
  }, [handleInput, ghostText]);

  const editorStyle = useMemo(() => ({
    minHeight: minHeight || 250,
    padding: 20,
    fontSize: 15,
    lineHeight: '1.75',
    color: colors.text,
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    outline: 'none',
    cursor: 'text',
    overflowY: 'auto',
    wordBreak: 'break-word',
    letterSpacing: '0.01em',
  }), [minHeight, colors.text]);

  const placeholderStyle = useMemo(() => ({
    position: 'absolute',
    top: Spacing.md,
    left: Spacing.md,
    color: colors.textTertiary || colors.textSecondary,
    fontSize: FontSize.base,
    fontFamily: FontFamily.base,
    pointerEvents: 'none',
    userSelect: 'none',
  }), [colors]);

  // Track whether content is empty for placeholder display
  const [isEmpty, setIsEmpty] = useState(!value);

  // Sync isEmpty when value changes externally (e.g. reply loads, template, AI)
  useEffect(() => {
    const empty = !value || value === '<br>' || value.replace(/<br\s*\/?>/g, '').trim() === '';
    setIsEmpty(empty);
  }, [value]);

  const onInputWrapped = useCallback(() => {
    handleInput();
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      setIsEmpty(!html || html === '<br>' || html.replace(/<br\s*\/?>/g, '').trim() === '');
    }
  }, [handleInput]);

  // Handle paste — support inline images
  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (ev) => {
          document.execCommand('insertImage', false, ev.target.result);
          handleInput();
        };
        reader.readAsDataURL(file);
        return;
      }
    }
    // Allow normal HTML paste for non-image content
  }, [handleInput]);

  return (
    <View style={[cardMode ? styles.editorContainerFlat : styles.editorContainer, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <Toolbar onCommand={handleCommand} colors={colors} activeCommands={activeCommands} />
      <View style={{ position: 'relative', flex: 1 }}>
        {isEmpty && placeholder ? (
          <div style={placeholderStyle}>{placeholder}</div>
        ) : null}
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={onInputWrapped}
          onKeyUp={handleKeyUp}
          onKeyDown={handleKeyDown}
          onMouseUp={handleMouseUp}
          onFocus={() => checkActiveFormats()}
          onPaste={handlePaste}
          style={editorStyle}
          data-testid="rich-text-editor"
        />
        {ghostText ? (
          <div style={{
            position: 'absolute', bottom: 8, left: Spacing.md, right: Spacing.md,
            color: colors.textTertiary, opacity: 0.5, fontSize: FontSize.sm,
            pointerEvents: 'none', userSelect: 'none',
            whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          }}>
            {ghostText} <span style={{ opacity: 0.6, fontSize: 11 }}>Tab ↹</span>
          </div>
        ) : null}
      </View>
      <style
        dangerouslySetInnerHTML={{
          __html: `
            [contenteditable] blockquote {
              border-left: 3px solid ${colors.border};
              padding-left: ${Spacing.md}px;
              margin-left: 0;
              color: ${colors.textSecondary};
            }
            [contenteditable] pre {
              background: ${colors.surfaceVariant || colors.surface};
              padding: ${Spacing.sm}px ${Spacing.md}px;
              border-radius: ${BorderRadius.sm}px;
              font-family: ${FontFamily.mono};
              font-size: ${FontSize.sm}px;
              overflow-x: auto;
            }
            [contenteditable] a {
              color: ${colors.primary};
              text-decoration: underline;
            }
            [contenteditable] ul, [contenteditable] ol {
              padding-left: ${Spacing.xxl}px;
              margin: ${Spacing.xs}px 0;
            }
          `,
        }}
      />
    </View>
  );
}

// ─── Mobile Editor (WebView with contentEditable) ───
function MobileEditor({ value, onChange, placeholder, minHeight, colors, isDark, cardMode }) {
  const webViewRef = useRef(null);
  const [activeCommands, setActiveCommands] = useState([]);
  const [webViewHeight, setWebViewHeight] = useState(minHeight || 200);
  const initialValueRef = useRef(value || '');
  const lastSentValueRef = useRef(value || '');

  // When value changes externally (AI improve, template, etc), push it via postMessage
  useEffect(() => {
    if (webViewRef.current && value !== lastSentValueRef.current) {
      lastSentValueRef.current = value;
      webViewRef.current.postMessage(JSON.stringify({
        type: 'setContent',
        html: value || '',
      }));
    }
  }, [value]);

  const htmlContent = useMemo(() => {
    const bgColor = colors.background;
    const textColor = colors.text;
    const borderColor = colors.border;
    const surfaceVariant = colors.surfaceVariant || colors.surface;
    const primaryColor = colors.primary;
    const secondaryColor = colors.textSecondary;
    const tertiaryColor = colors.textTertiary || colors.textSecondary;
    const editorMinHeight = (minHeight || 200) - 20;

    return `
<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: ${bgColor};
      color: ${textColor};
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: ${FontSize.base}px;
      line-height: 1.6;
      height: 100%;
      -webkit-text-size-adjust: 100%;
    }
    #editor {
      min-height: ${editorMinHeight}px;
      padding: ${Spacing.md}px;
      outline: none;
      word-break: break-word;
      -webkit-user-select: text;
    }
    #editor:empty::before {
      content: attr(data-placeholder);
      color: ${tertiaryColor};
      pointer-events: none;
    }
    #editor blockquote {
      border-left: 3px solid ${borderColor};
      padding-left: ${Spacing.md}px;
      margin-left: 0;
      color: ${secondaryColor};
    }
    #editor pre {
      background: ${surfaceVariant};
      padding: ${Spacing.sm}px ${Spacing.md}px;
      border-radius: ${BorderRadius.sm}px;
      font-family: monospace;
      font-size: ${FontSize.sm}px;
      overflow-x: auto;
    }
    #editor a { color: ${primaryColor}; text-decoration: underline; }
    #editor ul, #editor ol { padding-left: ${Spacing.xxl}px; margin: ${Spacing.xs}px 0; }
  </style>
</head>
<body>
  <div
    id="editor"
    contenteditable="true"
    data-placeholder="${(placeholder || '').replace(/"/g, '&quot;')}"
  >${initialValueRef.current || ''}</div>
  <script>
    var editor = document.getElementById('editor');
    var lastHtml = '';

    function getHtml() {
      var html = editor.innerHTML;
      var isEmpty = !html || html === '<br>' || html.replace(/<br\\s*\\/?>/g, '').trim() === '';
      return isEmpty ? '' : html;
    }

    function checkFormats() {
      var cmds = ['bold', 'italic', 'underline', 'strikeThrough',
                  'insertUnorderedList', 'insertOrderedList'];
      var active = [];
      cmds.forEach(function(cmd) {
        try { if (document.queryCommandState(cmd)) active.push(cmd); } catch(e) {}
      });
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'activeFormats',
        formats: active
      }));
    }

    function sendContent() {
      var html = getHtml();
      if (html !== lastHtml) {
        lastHtml = html;
        window.ReactNativeWebView.postMessage(JSON.stringify({
          type: 'contentChange',
          html: html
        }));
      }
      checkFormats();
      // Send height for auto-resize
      var h = Math.max(document.body.scrollHeight, ${editorMinHeight});
      window.ReactNativeWebView.postMessage(JSON.stringify({
        type: 'heightChange',
        height: h
      }));
    }

    editor.addEventListener('input', sendContent);
    editor.addEventListener('keyup', checkFormats);
    editor.addEventListener('mouseup', checkFormats);
    editor.addEventListener('touchend', checkFormats);

    // Listen for commands from React Native
    window.addEventListener('message', function(e) {
      handleMsg(e.data);
    });
    document.addEventListener('message', function(e) {
      handleMsg(e.data);
    });

    function handleMsg(data) {
      try {
        var msg = JSON.parse(data);
        if (msg.type === 'execCommand') {
          editor.focus();
          if (msg.command === 'createLink') {
            document.execCommand('createLink', false, msg.arg || 'https://');
          } else if (msg.arg) {
            var current = document.queryCommandValue('formatBlock');
            if (current.toLowerCase() === msg.arg.toLowerCase()) {
              document.execCommand('formatBlock', false, 'P');
            } else {
              document.execCommand('formatBlock', false, msg.arg);
            }
          } else {
            document.execCommand(msg.command, false, null);
          }
          sendContent();
        } else if (msg.type === 'setContent') {
          editor.innerHTML = msg.html || '';
          lastHtml = getHtml();
        } else if (msg.type === 'focus') {
          editor.focus();
        }
      } catch(e) {}
    }

    // Initial height report
    setTimeout(sendContent, 100);
  <\/script>
</body>
</html>`;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [colors, minHeight, placeholder]);

  const handleMessage = useCallback((event) => {
    try {
      const msg = JSON.parse(event.nativeEvent.data);
      if (msg.type === 'contentChange') {
        lastSentValueRef.current = msg.html;
        onChange(msg.html);
      } else if (msg.type === 'activeFormats') {
        setActiveCommands(msg.formats || []);
      } else if (msg.type === 'heightChange') {
        const h = Math.max(msg.height, minHeight || 200);
        setWebViewHeight(h);
      }
    } catch {}
  }, [onChange, minHeight]);

  const handleCommand = useCallback((btn) => {
    if (!webViewRef.current) return;

    if (btn.command === 'createLink') {
      // On mobile, use a simple Alert-based prompt
      const { Alert } = require('react-native');
      Alert.prompt?.(
        'Insert Link',
        'Enter URL:',
        (url) => {
          if (url) {
            webViewRef.current.postMessage(JSON.stringify({
              type: 'execCommand',
              command: 'createLink',
              arg: url,
            }));
          }
        },
        'plain-text',
        'https://'
      ) || (() => {
        // Fallback if Alert.prompt not available (Android)
        webViewRef.current.postMessage(JSON.stringify({
          type: 'execCommand',
          command: 'createLink',
          arg: 'https://',
        }));
      })();
      return;
    }

    webViewRef.current.postMessage(JSON.stringify({
      type: 'execCommand',
      command: btn.command,
      arg: btn.arg || null,
    }));
  }, []);

  if (!WebView) {
    // Fallback if WebView not available: simple TextInput
    return (
      <View style={[cardMode ? styles.editorContainerFlat : styles.editorContainer, { backgroundColor: colors.background, borderColor: colors.border }]}>
        <TextInput
          multiline
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={colors.textSecondary}
          style={[
            styles.fallbackInput,
            {
              color: colors.text,
              minHeight: minHeight || 200,
              backgroundColor: colors.background,
            },
          ]}
        />
      </View>
    );
  }

  return (
    <View style={[cardMode ? styles.editorContainerFlat : styles.editorContainer, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <Toolbar onCommand={handleCommand} colors={colors} activeCommands={activeCommands} />
      <WebView
        ref={webViewRef}
        source={{ html: htmlContent }}
        onMessage={handleMessage}
        originWhitelist={['*']}
        javaScriptEnabled
        domStorageEnabled
        keyboardDisplayRequiresUserAction={false}
        hideKeyboardAccessoryView={false}
        scrollEnabled={false}
        style={{ height: webViewHeight, backgroundColor: 'transparent' }}
        containerStyle={{ flex: 0 }}
      />
    </View>
  );
}

// ─── Main Export ───
// `cardMode` (default false) — when true, the editor renders without its own
// border/shadow so a parent card can supply them (used by compose.js body card).
export default function RichTextEditor({ value, onChange, placeholder, minHeight, cardMode = false }) {
  const { colors, isDark } = useTheme();

  if (Platform.OS === 'web') {
    return (
      <WebEditor
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        minHeight={minHeight}
        colors={colors}
        isDark={isDark}
        cardMode={cardMode}
      />
    );
  }

  return (
    <MobileEditor
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      minHeight={minHeight}
      colors={colors}
      isDark={isDark}
      cardMode={cardMode}
    />
  );
}

// ─── Styles ───
const styles = StyleSheet.create({
  // Default container (used when cardMode=false): owns its border + shadow.
  editorContainer: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: '0 2px 8px rgba(0,0,0,0.06)', transition: 'border-color 0.2s, box-shadow 0.2s' },
      default: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
    }),
  },
  // Flat container (used when parent supplies the card chrome, e.g. compose).
  editorContainerFlat: {
    borderWidth: 0,
    borderRadius: 0,
    overflow: 'hidden',
    backgroundColor: 'transparent',
  },
  toolbar: {
    borderRadius: 12,
    marginHorizontal: 4,
    marginTop: 4,
    marginBottom: 8,
    flexDirection: 'row',
  },
  toolbarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    gap: 0,
  },
  toolbarGroupRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  toolbarGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 4,
    gap: 2,
  },
  toolbarBtn: {
    width: 36,
    height: 36,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  toolbarLabel: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  divider: {
    width: 1,
    height: 16,
    marginHorizontal: 6,
    opacity: 0.6,
  },
  fallbackInput: {
    padding: Spacing.md,
    fontSize: FontSize.base,
    textAlignVertical: 'top',
  },
});
