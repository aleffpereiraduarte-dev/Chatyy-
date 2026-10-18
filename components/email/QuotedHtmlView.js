// components/email/QuotedHtmlView.js — [2026-10-18 email-quote-html]
//
// Citação (responder/encaminhar) READ-ONLY com o HTML do original (links,
// negrito, listas, tabelas) abaixo do editor nativo. O texto editável continua
// no editor nativo; só a citação é renderizada aqui:
//   1. view nativa do leitor (ChatyyEmailBody via NativeEmailBody) quando o
//      binário tem — JS do conteúdo desligado, CSP, altura automática;
//   2. senão, um WebView leve só para a citação (sem edição, links abrem fora);
//   3. falhou tudo → texto puro (comportamento antigo).
// O HTML chega JÁ sanitizado (sanitizeQuotedHtml do compose).
import { useState, useCallback, useMemo } from 'react';
import { View, Text, Platform, StyleSheet } from 'react-native';
import NativeEmailBody, { isNativeEmailBodyOn, buildEmailDocument, pickEmailColorMode, openEmailLink } from './NativeEmailBody';

let _WebView;
function _getWebView() {
  if (_WebView !== undefined) return _WebView;
  try { _WebView = require('react-native-webview').WebView || null; } catch { _WebView = null; }
  return _WebView;
}

function _plain(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

const HEIGHT_JS = `(function(){function p(){try{var h=Math.ceil(document.documentElement.scrollHeight||document.body.scrollHeight||0);window.ReactNativeWebView.postMessage(String(h));}catch(e){}}
p();window.addEventListener('load',p);setTimeout(p,250);setTimeout(p,900);
try{new ResizeObserver(p).observe(document.body);}catch(e){}})();true;`;

function QuoteWebView({ html, colors, isDark }) {
  const WebView = _getWebView();
  const [h, setH] = useState(60);
  const mode = pickEmailColorMode(html, isDark);
  const doc = useMemo(() => buildEmailDocument(html, { mode, colors, blockRemote: true, fontSize: 14 }), [html, mode, colors]);
  const onMessage = useCallback((e) => {
    const n = parseInt(e?.nativeEvent?.data, 10);
    if (n > 0) setH(Math.min(n + 4, 6000));
  }, []);
  const onNav = useCallback((req) => {
    const url = String(req?.url || '');
    if (!url || url === 'about:blank' || url.startsWith('data:')) return true;
    openEmailLink(url, { colors, isDark });
    return false;
  }, [colors, isDark]);
  if (!WebView) return null;
  return (
    <WebView
      source={{ html: doc }}
      originWhitelist={['*']}
      // JS só para o NOSSO script de altura (o HTML já veio sem script e a
      // CSP do documento barra o resto no Android).
      javaScriptEnabled
      injectedJavaScript={HEIGHT_JS}
      onMessage={onMessage}
      onShouldStartLoadWithRequest={onNav}
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      textZoom={100}
      setSupportMultipleWindows={false}
      allowsLinkPreview={false}
      dataDetectorTypes="none"
      style={{ height: h, backgroundColor: 'transparent' }}
      containerStyle={{ flex: 0 }}
    />
  );
}

export function isQuoteHtmlOn() {
  if (Platform.OS === 'web') return false; // web já renderiza HTML no compose
  try { return globalThis.__chatyy_mail_quote_html !== false; } catch { return true; }
}

export default function QuotedHtmlView({ html, colors, isDark, labels }) {
  if (!html) return null;
  if (isNativeEmailBodyOn()) {
    return (
      <View style={st.wrap}>
        <NativeEmailBody html={html} isDark={isDark} colors={colors} blockRemote labels={labels} minHeight={24} />
      </View>
    );
  }
  if (_getWebView()) {
    return <View style={st.wrap}><QuoteWebView html={html} colors={colors} isDark={isDark} /></View>;
  }
  return (
    <Text style={[st.plain, { color: colors?.textSecondary }]} selectable>{_plain(html)}</Text>
  );
}

const st = StyleSheet.create({
  wrap: { marginTop: 4 },
  plain: { fontSize: 14, lineHeight: 20 },
});
