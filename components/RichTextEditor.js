import { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, ScrollView, StyleSheet, Platform, TextInput } from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { FontSize, Spacing, BorderRadius, FontFamily } from '../constants/theme';
import { IconBold, IconItalic, IconUnderline, IconLink } from './Icons';

// ─── WebView import (mobile only) ───
let WebView = null;
if (Platform.OS !== 'web') {
  try {
    WebView = require('react-native-webview').default;
  } catch {}
}

// ─── Toolbar button definitions ───
const TOOLBAR_BUTTONS = [
  { id: 'bold',          command: 'bold',          icon: 'bold',          label: 'B' },
  { id: 'italic',        command: 'italic',        icon: 'italic',        label: 'I' },
  { id: 'underline',     command: 'underline',     icon: 'underline',     label: 'U' },
  { id: 'strikethrough', command: 'strikeThrough', icon: null,            label: 'S' },
  { id: 'divider1' },
  { id: 'fontSize1',     command: 'fontSize',      arg: '2',              icon: null, label: 'A-' },
  { id: 'fontSize3',     command: 'fontSize',      arg: '5',              icon: null, label: 'A+' },
  { id: 'divider1b' },
  { id: 'colorRed',      command: 'foreColor',     arg: '#c5221f',        icon: null, label: 'A', color: '#c5221f' },
  { id: 'colorBlue',     command: 'foreColor',     arg: '#1a73e8',        icon: null, label: 'A', color: '#1a73e8' },
  { id: 'colorGreen',    command: 'foreColor',     arg: '#34a853',        icon: null, label: 'A', color: '#34a853' },
  { id: 'colorBlack',    command: 'foreColor',     arg: '#000000',        icon: null, label: 'A', color: '#000000' },
  { id: 'divider1c' },
  { id: 'alignLeft',     command: 'justifyLeft',   icon: null,            label: '\u2261' },
  { id: 'alignCenter',   command: 'justifyCenter', icon: null,            label: '\u2263' },
  { id: 'alignRight',    command: 'justifyRight',  icon: null,            label: '\u2262' },
  { id: 'divider2' },
  { id: 'link',          command: 'createLink',    icon: 'link',          label: null },
  { id: 'divider2b' },
  { id: 'bulletList',    command: 'insertUnorderedList', icon: null,      label: '\u2022\u2261' },
  { id: 'numberedList',  command: 'insertOrderedList',   icon: null,      label: '1.' },
  { id: 'blockquote',    command: 'formatBlock',   arg: 'BLOCKQUOTE',     icon: null, label: '\u201C' },
  { id: 'code',          command: 'formatBlock',   arg: 'PRE',            icon: null, label: '</>' },
  { id: 'divider3' },
  { id: 'clearFormat',   command: 'removeFormat',  icon: null,            label: 'T\u0338' },
  { id: 'divider4' },
  { id: 'undo',          command: 'undo',          icon: null,            label: '\u21A9' },
  { id: 'redo',          command: 'redo',           icon: null,            label: '\u21AA' },
];

const ICON_MAP = {
  bold: IconBold,
  italic: IconItalic,
  underline: IconUnderline,
  link: IconLink,
};

// ─── Toolbar Button ───
function ToolbarButton({ btn, onPress, colors, activeCommands }) {
  if (btn.id.startsWith('divider')) {
    return <View style={[styles.divider, { backgroundColor: colors.border }]} />;
  }

  const IconComponent = btn.icon ? ICON_MAP[btn.icon] : null;
  const isActive = activeCommands.includes(btn.command);

  return (
    <TouchableOpacity
      onPress={() => onPress(btn)}
      activeOpacity={0.6}
      style={[
        styles.toolbarBtn,
        { backgroundColor: isActive ? colors.primaryLight : 'transparent' },
      ]}
      accessibilityLabel={btn.id}
      accessibilityRole="button"
    >
      {IconComponent ? (
        <IconComponent
          size={18}
          color={isActive ? colors.primary : colors.textSecondary}
        />
      ) : (
        <Text
          style={[
            styles.toolbarLabel,
            {
              color: btn.color || (isActive ? colors.primary : colors.textSecondary),
              fontWeight: btn.id === 'bold' ? '700' : '500',
              fontStyle: btn.id === 'italic' ? 'italic' : 'normal',
              textDecorationLine: btn.id === 'underline' ? 'underline'
                : btn.id === 'strikethrough' ? 'line-through'
                : 'none',
            },
          ]}
        >
          {btn.label}
        </Text>
      )}
    </TouchableOpacity>
  );
}

// ─── Formatting Toolbar ───
function Toolbar({ onCommand, colors, activeCommands }) {
  return (
    <View style={[styles.toolbar, { borderBottomColor: colors.border, backgroundColor: colors.surface }]}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.toolbarContent}
        keyboardShouldPersistTaps="always"
      >
        {TOOLBAR_BUTTONS.map(btn => (
          <ToolbarButton
            key={btn.id}
            btn={btn}
            onPress={onCommand}
            colors={colors}
            activeCommands={activeCommands}
          />
        ))}
      </ScrollView>
    </View>
  );
}

// ─── Web Editor (contentEditable div) ───
function WebEditor({ value, onChange, placeholder, minHeight, colors, isDark }) {
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
    <View style={[styles.editorContainer, { backgroundColor: colors.background, borderColor: colors.border }]}>
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
function MobileEditor({ value, onChange, placeholder, minHeight, colors, isDark }) {
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
      <View style={[styles.editorContainer, { backgroundColor: colors.background, borderColor: colors.border }]}>
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
    <View style={[styles.editorContainer, { backgroundColor: colors.background, borderColor: colors.border }]}>
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
export default function RichTextEditor({ value, onChange, placeholder, minHeight }) {
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
    />
  );
}

// ─── Styles ───
const styles = StyleSheet.create({
  editorContainer: {
    borderWidth: 1,
    borderRadius: 12,
    overflow: 'hidden',
    ...Platform.select({
      web: { boxShadow: '0 2px 8px rgba(0,0,0,0.06)', transition: 'border-color 0.2s, box-shadow 0.2s' },
      default: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8, elevation: 2 },
    }),
  },
  toolbar: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
  },
  toolbarContent: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 1,
    flexWrap: 'wrap',
  },
  toolbarBtn: {
    width: 30,
    height: 30,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      web: { cursor: 'pointer', transition: 'background 0.15s' },
      default: {},
    }),
  },
  toolbarLabel: {
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  divider: {
    width: 1,
    height: 18,
    marginHorizontal: 3,
    opacity: 0.3,
  },
  fallbackInput: {
    padding: Spacing.md,
    fontSize: FontSize.base,
    textAlignVertical: 'top',
  },
});
