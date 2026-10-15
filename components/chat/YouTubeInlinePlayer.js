// [2026-10-15 yt-inline] Player do YouTube DENTRO do app (WhatsApp/Telegram).
//
// Toque na prévia de um link do YouTube (watch / youtu.be / shorts / live /
// embed) numa conversa → overlay FLUTUANTE com o vídeo tocando (embed
// youtube-nocookie num WebView, playsinline=1, só o iframe — nenhum JS de
// terceiros além do próprio player). A conversa continua utilizável por
// baixo: o overlay não tem fundo, só o cartão recebe toques. Minimizar →
// mini player arrastável que gruda no canto mais próximo (PiP do Telegram).
// "Abrir no YouTube" → services/openLink (app do YouTube se instalado).
// iOS: allowsPictureInPictureMediaPlayback (PiP do sistema pela tela cheia).
//
// Montado UMA vez em app/_layout.js (<YouTubeInlineHost />); sem host montado
// openYouTubeInline() devolve false e quem chamou segue o caminho antigo.
// Kill switch (OTA): globalThis.__chatyy_yt_inline = false. Web: desligado.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, Platform, PanResponder, Animated, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX, IconChevronDown, IconChevronUp } from '../Icons';
import { useLanguage } from '../../context/LanguageContext';

// ─── estado global mínimo ───────────────────────────────────────────────────
let _cur = null;
const _subs = new Set();
function _emit() { for (const f of Array.from(_subs)) { try { f(_cur); } catch {} } }

export function isYouTubeInlineEnabled() {
  if (Platform.OS === 'web') return false;
  try { return globalThis.__chatyy_yt_inline !== false; } catch { return true; }
}

/** { id, short, start, url } | null */
export function parseYouTube(raw) {
  const u = String(raw == null ? '' : raw).trim().replace(/[.,;:!?…)\]]+$/u, '');
  const m = /^https?:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(u);
  if (!m) return null;
  const host = m[1].toLowerCase().replace(/:\d+$/, '');
  const path = m[2] || '';
  const q = (m[3] || '') + (m[4] ? '&' + m[4].slice(1) : '');
  const qp = (k) => {
    const r = new RegExp('[?&]' + k + '=([^&]*)').exec(q);
    if (!r) return '';
    try { return decodeURIComponent(r[1]); } catch { return r[1]; }
  };
  let id = '';
  let short = false;
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    id = path.split('/')[1] || '';
  } else if (/^(www\.|m\.)?youtube(-nocookie)?\.com$/.test(host)) {
    if (/^\/watch\/?$/.test(path)) id = qp('v');
    else {
      const pm = /^\/(shorts|embed|live|v)\/([^/]+)/.exec(path);
      if (pm) { id = pm[2]; short = pm[1] === 'shorts'; }
    }
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  let start = 0;
  const t = qp('t') || qp('start');
  if (t) {
    if (/^\d+s?$/.test(t)) start = parseInt(t, 10) || 0;
    else {
      const tm = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(t);
      if (tm) start = (+tm[1] || 0) * 3600 + (+tm[2] || 0) * 60 + (+tm[3] || 0);
    }
  }
  return { id, short, start, url: u };
}

/** Info do vídeo SE o player embutido vai tratar este link; senão null. */
export function youTubeInlineInfo(url) {
  if (!isYouTubeInlineEnabled()) return null;
  try { return parseYouTube(url); } catch { return null; }
}

/** true = abriu no player embutido. Nunca lança. */
export function openYouTubeInline(url) {
  try {
    const info = youTubeInlineInfo(url);
    if (!info || _subs.size === 0) return false;
    _cur = { ...info, key: Date.now() };
    _emit();
    return true;
  } catch { return false; }
}

export function closeYouTubeInline() { _cur = null; _emit(); }

// ─── host ───────────────────────────────────────────────────────────────────
const BASE_URL = 'https://chatyy.com.br/';
const M = 8; // margem das bordas

function _html(v) {
  const qs = `playsinline=1&autoplay=1&rel=0&modestbranding=1${v.start ? `&start=${v.start}` : ''}`;
  return '<!doctype html><html><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">'
    + '<style>html,body{margin:0;padding:0;height:100%;background:#000;overflow:hidden}'
    + 'iframe{position:absolute;top:0;left:0;width:100%;height:100%;border:0}</style></head><body>'
    + `<iframe src="https://www.youtube-nocookie.com/embed/${v.id}?${qs}" `
    + 'allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen '
    + 'referrerpolicy="strict-origin-when-cross-origin"></iframe></body></html>';
}

let _WebView;
function _getWebView() {
  if (_WebView !== undefined) return _WebView;
  try { _WebView = require('react-native-webview').WebView || null; } catch { _WebView = null; }
  return _WebView;
}

export function YouTubeInlineHost() {
  const [vid, setVid] = useState(_cur);
  useEffect(() => {
    const f = (v) => setVid(v);
    _subs.add(f);
    setVid(_cur);
    return () => { _subs.delete(f); };
  }, []);
  if (!vid || Platform.OS === 'web' || !_getWebView()) return null;
  return <FloatingPlayer key={vid.key} vid={vid} />;
}

export default YouTubeInlineHost;

function FloatingPlayer({ vid }) {
  const WebView = _getWebView();
  const { t } = useLanguage();
  const tt = (k, fb) => { try { const v = t(k); return v && v !== k ? v : fb; } catch { return fb; } };
  const insets = useSafeAreaInsets();
  const { width: winW, height: winH } = useWindowDimensions();
  const [mini, setMini] = useState(false);

  // Tamanhos: vídeo 16:9 (shorts 9:16) + barra de controles.
  const barH = mini ? 30 : 38;
  let cardW; let videoW; let videoH;
  if (!mini) {
    cardW = Math.min(winW - M * 2, 560);
    if (vid.short) {
      videoH = Math.min(winH * 0.55, cardW * 16 / 9);
      videoW = videoH * 9 / 16;
    } else { videoW = cardW; videoH = cardW * 9 / 16; }
  } else if (vid.short) {
    videoW = 120; videoH = 120 * 16 / 9; cardW = Math.max(videoW, 128);
  } else {
    cardW = Math.min(winW * 0.55, 260); videoW = cardW; videoH = cardW * 9 / 16;
  }
  cardW = Math.round(cardW); videoW = Math.round(videoW); videoH = Math.round(videoH);
  const cardH = barH + videoH;

  const bounds = useMemo(() => ({
    left: M,
    right: Math.max(M, winW - cardW - M),
    top: insets.top + 56,
    bottom: Math.max(insets.top + 56, winH - cardH - insets.bottom - 84), // acima do composer
  }), [winW, winH, cardW, cardH, insets.top, insets.bottom]);
  const boundsRef = useRef(bounds); boundsRef.current = bounds;
  const miniRef = useRef(mini); miniRef.current = mini;

  const pos = useRef(new Animated.ValueXY({ x: (winW - cardW) / 2, y: insets.top + 56 })).current;
  const posRef = useRef({ x: (winW - cardW) / 2, y: insets.top + 56 });
  const cornerRef = useRef({ right: true, bottom: false });

  const target = (b, isMini, corner) => (isMini
    ? { x: corner.right ? b.right : b.left, y: corner.bottom ? b.bottom : b.top }
    : { x: (b.left + b.right) / 2, y: corner.bottom ? b.bottom : b.top });

  const moveTo = (p) => {
    posRef.current = p;
    Animated.spring(pos, { toValue: p, useNativeDriver: true, friction: 8, tension: 70 }).start();
  };

  // Re-encaixa quando muda tamanho/modo/rotação.
  useEffect(() => { moveTo(target(bounds, mini, cornerRef.current)); }, [mini, bounds]); // eslint-disable-line react-hooks/exhaustive-deps

  const pan = useMemo(() => {
    let start = { x: 0, y: 0 };
    return PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_e, g) => Math.abs(g.dx) + Math.abs(g.dy) > 6,
      onPanResponderGrant: () => { pos.stopAnimation(); start = { ...posRef.current }; },
      onPanResponderMove: (_e, g) => { pos.setValue({ x: start.x + g.dx, y: start.y + g.dy }); },
      onPanResponderRelease: (_e, g) => {
        const b = boundsRef.current;
        const x = start.x + g.dx + g.vx * 120;
        const y = start.y + g.dy + g.vy * 120;
        cornerRef.current = {
          right: x > (b.left + b.right) / 2,
          bottom: y > (b.top + b.bottom) / 2,
        };
        moveTo(target(b, miniRef.current, cornerRef.current));
      },
      onPanResponderTerminate: () => { moveTo(target(boundsRef.current, miniRef.current, cornerRef.current)); },
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const openExternal = () => {
    closeYouTubeInline();
    try { require('../../services/openLink').openLink(`https://www.youtube.com/watch?v=${vid.id}${vid.start ? `&t=${vid.start}s` : ''}`); } catch {}
  };

  const onNav = (req) => {
    try {
      const url = String((req && req.url) || '');
      if (req && req.isTopFrame === false) return true; // o próprio iframe do player
      if (!url || url.startsWith('about:') || url === BASE_URL || url.startsWith('data:')) return true;
      // Toque no logo/título do YouTube dentro do player → app/navegador interno.
      if (/^https?:\/\//i.test(url)) { setTimeout(() => { try { require('../../services/openLink').openLink(url); } catch {} }, 0); }
      return false;
    } catch { return false; }
  };

  const html = useMemo(() => _html(vid), [vid]);
  const ic = mini ? 16 : 20;
  const hit = { top: 8, bottom: 8, left: 8, right: 8 };

  return (
    <View pointerEvents="box-none" style={StyleSheet.absoluteFill}>
      <Animated.View
        style={[s.card, { width: cardW, height: cardH, transform: pos.getTranslateTransform() }]}
      >
        <View style={[s.bar, { height: barH }]} {...pan.panHandlers}>
          <View style={s.grip} />
          <View style={{ flex: 1 }} />
          {!mini ? (
            <TouchableOpacity onPress={openExternal} hitSlop={hit} style={s.textBtn} accessibilityRole="button">
              <Text style={s.textBtnLabel} numberOfLines={1}>{tt('ytPlayer.openInYouTube', 'Abrir no YouTube')}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={() => setMini((v) => !v)}
            hitSlop={hit}
            style={s.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={mini ? tt('ytPlayer.expand', 'Expandir') : tt('ytPlayer.minimize', 'Minimizar')}
          >
            {mini ? <IconChevronUp size={ic} color="#FFFFFF" /> : <IconChevronDown size={ic} color="#FFFFFF" />}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={closeYouTubeInline}
            hitSlop={hit}
            style={s.iconBtn}
            accessibilityRole="button"
            accessibilityLabel={tt('common.close', 'Fechar')}
          >
            <IconX size={ic} color="#FFFFFF" />
          </TouchableOpacity>
        </View>
        <View style={[s.videoWrap, { height: videoH }]}>
          <View style={{ width: videoW, height: videoH }}>
            <WebView
              source={{ html, baseUrl: BASE_URL }}
              originWhitelist={['*']}
              style={s.web}
              javaScriptEnabled
              domStorageEnabled
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              allowsPictureInPictureMediaPlayback
              allowsFullscreenVideo
              allowsAirPlayForMediaPlayback
              setSupportMultipleWindows={false}
              scrollEnabled={false}
              bounces={false}
              overScrollMode="never"
              onShouldStartLoadWithRequest={onNav}
            />
          </View>
        </View>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  card: {
    position: 'absolute', left: 0, top: 0, borderRadius: 12, overflow: 'hidden', backgroundColor: '#000000',
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 12,
  },
  bar: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, backgroundColor: '#111111' },
  grip: { width: 28, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.35)', marginLeft: 4 },
  textBtn: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: 'rgba(255,255,255,0.14)', marginRight: 4, maxWidth: 200 },
  textBtnLabel: { color: '#FFFFFF', fontSize: 12.5, fontWeight: '600' },
  iconBtn: { paddingHorizontal: 6, paddingVertical: 4 },
  videoWrap: { width: '100%', alignItems: 'center', backgroundColor: '#000000' },
  web: { flex: 1, backgroundColor: '#000000' },
});
