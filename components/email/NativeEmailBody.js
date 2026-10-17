// [2026-10-15 native-email] Corpo do e-mail em view NATIVA dedicada
// (modules/expo-email-native, view ChatyyEmailBody): iOS WKWebView com JS do
// conteúdo desligado + WKContentRuleList; Android WebView travado + CSP.
//
// Este arquivo monta o documento (CSS base, CSP, modo escuro) e cuida da
// altura automática (a view mede o <body> e devolve onContentHeight → um único
// scroll, o do leitor). Quem decide QUANDO usar é o chamador: isNativeEmailBodyOn().
//
// Modos de cor (tema escuro):
//   'dark'   e-mail declara suporte a escuro (<meta color-scheme ... dark>) → iOS
//            liga prefers-color-scheme: dark e o CSS dele manda (Apple Mail).
//   'invert' e-mail com cores próprias (newsletter, texto #333 inline) →
//            inversão inteligente: inverte o documento e re-inverte imagens,
//            vídeos e fundos com imagem (cores de marca/fotos ficam certas).
//   'theme'  e-mail simples sem cor → texto na cor do app, fundo transparente.
// Tema claro: 'light' (como o remetente escreveu).
// Kill switch só da inversão: globalThis.__chatyy_email_dark_invert = false →
// e-mail com cores vai num cartão branco (comportamento antigo).
import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { Platform, Alert, Animated } from 'react-native';
import { getNativeEmailBodyView } from '../../modules/expo-email-native';

const AUTHORED_COLOR_RE = /(?:[;"'\s]color\s*:|bgcolor\s*=|background(?:-color)?\s*:|<font[^>]+color)/i;
const SUPPORTS_DARK_RE = /<meta[^>]+(?:color-scheme|supported-color-schemes)[^>]+dark/i;

// Altura medida por conteúdo → reabrir o mesmo e-mail já nasce do tamanho
// certo (sem "pulo"). LRU simples, só memória.
const _heightCache = new Map();
function _cacheHeight(key, h) {
  if (!key) return;
  _heightCache.delete(key);
  _heightCache.set(key, h);
  if (_heightCache.size > 200) _heightCache.delete(_heightCache.keys().next().value);
}

// Medições (QA): últimas aberturas, tempo até o 1º desenho do corpo.
function _metric(entry) {
  try {
    const g = globalThis;
    const arr = g.__chatyy_email_metrics || (g.__chatyy_email_metrics = []);
    arr.push(entry);
    if (arr.length > 30) arr.shift();
    if (typeof __DEV__ !== 'undefined' && __DEV__) console.log('[email-native] body first paint', entry);
  } catch {}
}

export function isNativeEmailBodyOn() {
  if (Platform.OS === 'web') return false;
  return !!getNativeEmailBodyView();
}

/** Modo de cor do corpo (ver cabeçalho). */
export function pickEmailColorMode(rawHtml, isDark) {
  if (!isDark) return 'light';
  const raw = String(rawHtml || '');
  if (Platform.OS === 'ios' && SUPPORTS_DARK_RE.test(raw)) return 'dark';
  if (AUTHORED_COLOR_RE.test(raw)) {
    let inv = true;
    try { if (globalThis.__chatyy_email_dark_invert === false) inv = false; } catch {}
    return inv ? 'invert' : 'card';
  }
  return 'theme';
}

function _hex(c, fb) {
  const s = String(c || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(s)) return s;
  if (/^#[0-9a-f]{3}$/i.test(s)) return '#' + s.slice(1).split('').map((x) => x + x).join('');
  return fb;
}

function _invertHex(h) {
  const n = parseInt(h.slice(1), 16);
  const r = 255 - ((n >> 16) & 255), g = 255 - ((n >> 8) & 255), b = 255 - (n & 255);
  return '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * Documento completo para a view nativa.
 * body = fragmento JÁ sanitizado (sanitizeHtml + processEmailHtml do leitor).
 */
export function buildEmailDocument(body, { mode = 'light', colors = {}, blockRemote = true, allowHosts = [], fontSize = 15 } = {}) {
  const text = _hex(colors.text, '#111111');
  const link = _hex(colors.primary, '#1a73e8');
  const appBg = _hex(colors.surface || colors.background, mode === 'light' ? '#ffffff' : '#000000');
  const hosts = (allowHosts || []).filter((h) => /^[a-z0-9.-]+$/i.test(h));
  const hostSrc = hosts.map((h) => `https://${h} https://*.${h}`).join(' ');
  const remote = blockRemote ? '' : ' https: http:';
  const csp = [
    `img-src data: blob: cid: ${hostSrc}${remote}`,
    `style-src 'unsafe-inline'${remote}`,
    `font-src data:${remote}`,
    "media-src 'none'",
    "frame-src 'none'",
    "child-src 'none'",
    "object-src 'none'",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    // iOS: JS do conteúdo já é desligado no WKWebView (e o nosso script mora
    // num mundo isolado). Android: a CSP é quem barra o JS do e-mail.
    ...(Platform.OS === 'android' ? ["script-src 'none'"] : []),
  ].join('; ');

  let colorCss = '';
  let bodyColor = '#111111';
  if (mode === 'theme') {
    bodyColor = text;
    colorCss = `a{color:${link}}blockquote{color:${text};opacity:.8;border-left-color:#3a3a3c}`; // [2026-10-16 polish] borda da citação discreta no preto
  } else if (mode === 'dark') {
    bodyColor = text;
    colorCss = `:root{color-scheme:light dark}`;
  } else if (mode === 'invert') {
    // fundo do cartão = inverso do fundo do app → depois do invert(1) bate certinho
    const cardBg = _invertHex(appBg);
    colorCss =
      `#cy-clip{background:${cardBg};filter:invert(1) hue-rotate(180deg)}` +
      `#cy-clip img,#cy-clip video,#cy-clip picture,#cy-clip canvas,#cy-clip svg,` +
      `#cy-clip [style*="background-image"],#cy-clip [background]{filter:invert(1) hue-rotate(180deg)}` +
      `#cy-clip [style*="background-image"] img,#cy-clip [background] img{filter:none}`;
  } else if (mode === 'card') {
    colorCss = `#cy-clip{background:#ffffff;border-radius:10px;padding:10px}`;
  }

  const base =
    'html,body{margin:0;padding:0;-webkit-text-size-adjust:100%;text-size-adjust:100%;background:transparent;height:auto!important;min-height:0!important;overflow-x:hidden}' +
    '*{-webkit-tap-highlight-color:transparent}' +
    `body{margin:12px;font-family:-apple-system,system-ui,Roboto,"Segoe UI",sans-serif;font-size:${fontSize}px;line-height:1.6;color:${bodyColor};overflow-wrap:break-word;word-wrap:break-word}` +
    '#cy-clip{overflow:hidden}#cy-root{display:flow-root}' +
    'img{max-width:100%;height:auto}video{max-width:100%}' +
    'pre{white-space:pre-wrap;word-break:break-word}' +
    'blockquote{margin:8px 0 8px 2px;padding-left:12px;border-left:3px solid #c8c8c8}' +
    'table{border-collapse:collapse}';

  const viewport = 'width=device-width,initial-scale=1,minimum-scale=1,maximum-scale=4,user-scalable=yes';
  return '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<meta name="viewport" content="${viewport}">` +
    '<meta name="format-detection" content="telephone=no">' +
    `<style>${base}${colorCss}</style></head>` +
    `<body><div id="cy-clip"><div id="cy-root">${body || ''}</div></div></body></html>`;
}

/** Abre link do corpo: só esquemas conhecidos; web → navegador interno. */
export function openEmailLink(url, { colors, isDark } = {}) {
  const u = String(url || '').trim();
  if (!u) return;
  if (/^(mailto|tel|sms):/i.test(u)) {
    import('expo-linking').then((L) => L.openURL(u)).catch(() => {});
    return;
  }
  if (!/^https?:\/\//i.test(u)) return; // javascript:, data:, cid:, file: … nunca
  try { require('../../services/openLink').openLink(u, { colors, isDark, fallback: 'inapp' }); } catch {} // [2026-10-15 native-browser] links do Chatyy → tela do app
}

export default function NativeEmailBody({
  html, // fragmento já sanitizado
  rawHtml, // HTML original (só p/ decidir modo de cor)
  isDark, colors, blockRemote = true, allowHosts, contentKey,
  labels, onLinkPress, onZoomChange, onHeight, minHeight = 24,
}) {
  const NativeView = getNativeEmailBodyView();
  const mode = pickEmailColorMode(rawHtml != null ? rawHtml : html, isDark);
  const doc = useMemo(
    () => buildEmailDocument(html, { mode, colors, blockRemote, allowHosts }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, mode, blockRemote, (allowHosts || []).join(','), colors?.text, colors?.primary, colors?.surface, colors?.background],
  );
  const hKey = contentKey ? `${contentKey}|${mode}|${blockRemote ? 1 : 0}` : '';
  const [height, setHeight] = useState(() => (hKey && _heightCache.get(hKey)) || 0);
  // 0.02 (não 0): view com alpha 0 pode ter rAF/desenho pausados (WebKit/Android).
  const shown = useRef(new Animated.Value(height > 0 ? 1 : 0.02)).current;
  const mountedAt = useRef(Date.now());

  useEffect(() => {
    const cached = hKey ? _heightCache.get(hKey) : 0;
    if (cached) setHeight(cached);
    mountedAt.current = Date.now();
  }, [hKey]);

  const onContentHeight = useCallback((e) => {
    const h = Number(e?.nativeEvent?.height) || 0;
    if (h <= 0) return;
    const hh = Math.max(minHeight, Math.ceil(h));
    setHeight(hh);
    _cacheHeight(hKey, hh);
    onHeight?.(hh);
    Animated.timing(shown, { toValue: 1, duration: 140, useNativeDriver: true }).start();
  }, [hKey, minHeight, onHeight, shown]);

  const onFirstPaint = useCallback((e) => {
    _metric({
      native_ms: Math.round(Number(e?.nativeEvent?.ms) || 0),
      mount_ms: Date.now() - mountedAt.current,
      platform: Platform.OS,
      mode,
      bytes: (html || '').length,
    });
  }, [mode, html]);

  const handleLink = useCallback((e) => {
    const url = e?.nativeEvent?.url;
    if (!url) return;
    if (onLinkPress) onLinkPress(url);
    else openEmailLink(url, { colors, isDark });
  }, [onLinkPress, colors, isDark]);

  const handleLongPress = useCallback((e) => {
    // iOS mostra o menu nativo sozinho; Android → folha simples.
    if (Platform.OS !== 'android') return;
    const url = e?.nativeEvent?.url;
    if (!url) return;
    const L = labels || {};
    Alert.alert(url.length > 120 ? url.slice(0, 120) + '…' : url, undefined, [
      { text: L.cancel || 'Cancelar', style: 'cancel' },
      {
        text: L.copyLink || 'Copiar link',
        onPress: () => {
          try { require('expo-clipboard').setStringAsync(url); } catch {}
        },
      },
      { text: L.open || 'Abrir', onPress: () => (onLinkPress ? onLinkPress(url) : openEmailLink(url, { colors, isDark })) },
    ]);
  }, [labels, onLinkPress, colors, isDark]);

  const handleZoom = useCallback((e) => {
    onZoomChange?.(!!e?.nativeEvent?.zoomed);
  }, [onZoomChange]);

  if (!NativeView) return null;
  return (
    <Animated.View style={{ opacity: shown }}>
      <NativeView
        style={{ width: '100%', height: Math.max(1, height || 1) }}
        html={doc}
        blockRemote={!!blockRemote}
        allowHosts={allowHosts || []}
        appearance={mode === 'dark' ? 'dark' : 'light'}
        labels={labels || {}}
        onContentHeight={onContentHeight}
        onLinkPress={handleLink}
        onLinkLongPress={handleLongPress}
        onFirstPaint={onFirstPaint}
        onZoomChange={handleZoom}
      />
    </Animated.View>
  );
}
