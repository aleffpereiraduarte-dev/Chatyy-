import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { KEYBOARD_CONTROLLER_ACTIVE as _KC_ACTIVE } from '../utils/threadKeyboard'; // [2026-10-08 photo-editor] gate do zoom UI-thread
import {
  View, Text, TouchableOpacity, TouchableWithoutFeedback, StyleSheet, Modal, Image, Platform,
  Dimensions, Animated, PanResponder, ActivityIndicator, Linking, StatusBar, Alert, FlatList, Share, ScrollView, Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX, IconDownload, IconPlay, IconPause, IconLock, IconCheck, IconShare, IconStar, IconStarFilled, IconMoreHorizontal, IconInfo, IconForward, IconType, IconCopy, IconChevronLeft, IconChevronRight } from './Icons';
// [2026-10-09 more-native] share do ARQUIVO (não do link) + texto da foto (Vision OCR já no binário iOS)
import { shareMediaFile, canRecognizeImageText, recognizeImageText } from '../utils/mediaNativeActions';
import { useLanguage } from '../context/LanguageContext';
import NativeDocPreview, { hasNativePdfView } from './NativeDocPreview'; // [2026-10-09 native-docs]
import { cachedVideoSource } from '../services/videoCacheSource'; // [2026-10-10 native-audit]
// [2026-10-14 adv-privacy] Conversa com privacidade avançada → visualizador protegido.
import { useAdvancedPrivacy, acquireCaptureProtection } from '../services/chatPrivacy';
import { PrivacyWatermark, viewerHandle } from './chat/useConversationPrivacy';
// Wave 14: 3D / depth-photo parallax view. Lazy-loaded so web stays green
// (expo-sensors isn't available in the web bundle).
let ParallaxPortraitView = null;
if (Platform.OS !== 'web') {
  try { ParallaxPortraitView = require('./ParallaxPortraitView').default; } catch {}
}

// expo-screen-capture: prevent screenshots & screen recordings while a
// view-once media is on screen. Android sets FLAG_SECURE (black thumbnail
// in the screenshot, black frames in screen recordings); iOS only fires
// a `screenshotListener` event we react to (FLAG_SECURE has no iOS twin).
// Lazy-loaded so web stays green.
let ScreenCapture = null;
if (Platform.OS !== 'web') {
  try { ScreenCapture = require('expo-screen-capture'); } catch {}
}

// expo-video for native MOV/MP4 playback (SDK 55+)
let ExpoVideo = null;
let useVideoPlayer = null;
if (Platform.OS !== 'web') {
  try {
    const mod = require('expo-video');
    ExpoVideo = mod.VideoView;
    useVideoPlayer = mod.useVideoPlayer;
  } catch {}
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// ============================================================
// [2026-10-08 photo-editor] UI-THREAD ZOOM (Reanimated 4 + RNGH Gesture API)
// ============================================================
// Pinça com ponto focal, duplo-toque no ponto tocado, arrasto com limites +
// inércia (withDecay) quando ampliado, e arrastar-pra-baixo-pra-fechar com o
// fundo esmaecendo — tudo na UI thread (JS ocupado não engasga o gesto).
// Ampliado → o FlatList pai desliga a paginação (onZoomChange) para o arrasto
// mexer na foto e não trocar de item. Sem ampliar, o arrasto horizontal falha
// rápido (manualActivation) e a paginação nativa do FlatList assume.
// OTA SAFETY: mesmo gate do SwipeReplyRow (Reanimated só quando o binário o
// tem — runtime 2.6.0+); fora disso fica o caminho PanResponder legado.
let _ZRea = null;
let _ZGH = null;
if (Platform.OS !== 'web' && _KC_ACTIVE) {
  try {
    // eslint-disable-next-line global-require
    _ZRea = require('react-native-reanimated');
    // eslint-disable-next-line global-require
    _ZGH = require('react-native-gesture-handler');
  } catch { _ZRea = null; _ZGH = null; }
}
const _UI_ZOOM = !!(
  _ZRea && _ZRea.default && _ZRea.useSharedValue && _ZRea.useAnimatedStyle
  && _ZRea.withSpring && _ZRea.withTiming && _ZRea.withDecay && _ZRea.runOnJS
  && _ZGH && _ZGH.Gesture && _ZGH.GestureDetector && _ZGH.GestureHandlerRootView
);
const _zRunOnJS = _UI_ZOOM ? _ZRea.runOnJS : null;
const _zWithSpring = _UI_ZOOM ? _ZRea.withSpring : null;
const _zWithTiming = _UI_ZOOM ? _ZRea.withTiming : null;
const _zWithDecay = _UI_ZOOM ? _ZRea.withDecay : null;
// Hook que existe sempre (regra dos hooks) — null fora do caminho UI-thread.
const _useMaybeSharedValue = _UI_ZOOM ? _ZRea.useSharedValue : () => null;
const _Z_MAX = 5;
const _Z_DOUBLE = 2.5;
const _Z_SPRING = { damping: 24, stiffness: 260, mass: 0.8 };

function _zClamp(v, lo, hi) {
  'worklet';
  return v < lo ? lo : (v > hi ? hi : v);
}
// Meia-folga máxima de translação para a escala s (imagem 'contain' no box).
function _zBoundX(s, cw, ch, nw, nh) {
  'worklet';
  let dw = cw;
  if (nw > 0 && nh > 0) dw = nw * Math.min(cw / nw, ch / nh);
  return Math.max(0, (dw * s - cw) / 2);
}
function _zBoundY(s, cw, ch, nw, nh) {
  'worklet';
  let dh = ch;
  if (nw > 0 && nh > 0) dh = nh * Math.min(cw / nw, ch / nh);
  return Math.max(0, (dh * s - ch) / 2);
}

// Fundo preto do viewer controlado pelo progresso do arrasto (UI thread).
function _DismissBackdrop({ sv }) {
  const st = _ZRea.useAnimatedStyle(() => ({ opacity: 1 - (sv ? sv.get() : 0) * 0.92 }));
  const RA = _ZRea.default;
  return <RA.View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }, st]} />;
}

// [2026-10-14 swipe-album] Reescrito p/ o swipe do álbum ficar nível Fotos do iOS:
//  • sem zoom: o arrasto horizontal FALHA o pan em ~4 px (o UIScrollView paginado
//    do FlatList assume sozinho, 1 página por gesto, velocidade decide);
//    vertical p/ baixo = fechar; 2 dedos = pinça (o pan ativa só p/ segurar o pager
//    enquanto pinça — antes a pinça a partir de 1× podia passar de página).
//  • ampliado: o pan ativa em ~5 px (antes do UIScrollView, ~10 pt) e move a foto;
//    se a foto JÁ está encostada na borda e o arrasto começa p/ fora → o pan falha
//    e o pager pagina (handoff do Fotos). Soltar puxando além da borda (elástico)
//    também troca de página (onEdgeSwipe).
//  • o pager NÃO é mais desligado ao ampliar (scrollEnabled fixo): quem segura o
//    pager é o pan ativo do RNGH. Página que sai (isActive=false) volta a 1×.
//  • natW/natH em shared values: o gesto não é recriado quando a foto termina de
//    carregar (antes o useMemo dependia de nw/nh → handlers nativos refeitos no
//    meio do swipe p/ uma página que acabou de carregar).
function UIZoomSurface({ children, natW, natH, dismissSV, onDismissStart, onDismissEnd, onZoomChange, isActive = true, onEdgeSwipe, onDoubleTap, onPageableChange }) {
  const RA = _ZRea.default;
  const sc = _ZRea.useSharedValue(1);
  const tx = _ZRea.useSharedValue(0);
  const ty = _ZRea.useSharedValue(0);
  const cw = _ZRea.useSharedValue(SCREEN_W);
  const ch = _ZRea.useSharedValue(SCREEN_H);
  const nwSV = _ZRea.useSharedValue(natW || 0);
  const nhSV = _ZRea.useSharedValue(natH || 0);
  const s0 = _ZRea.useSharedValue(1);
  const tx0 = _ZRea.useSharedValue(0);
  const ty0 = _ZRea.useSharedValue(0);
  const fx0 = _ZRea.useSharedValue(0);
  const fy0 = _ZRea.useSharedValue(0);
  const sx = _ZRea.useSharedValue(0);
  const sy = _ZRea.useSharedValue(0);
  const rawX = _ZRea.useSharedValue(0);
  const rawY = _ZRea.useSharedValue(0);
  const lastTX = _ZRea.useSharedValue(0);
  const lastTY = _ZRea.useSharedValue(0);
  const edge = _ZRea.useSharedValue(0); // bit1 = encostada à esquerda, bit2 = à direita (no toque)
  const want = _ZRea.useSharedValue(0); // modo pedido antes do activate()
  const decided = _ZRea.useSharedValue(0); // já chamou activate()/fail() neste gesto
  const pinched = _ZRea.useSharedValue(0); // houve pinça neste gesto
  const pinchLive = _ZRea.useSharedValue(0); // pinça em andamento
  const mode = _ZRea.useSharedValue(0); // 0 nada, 1 pan ampliado, 2 dispensar, 3 segurar (pinça a partir de 1×)
  const zoomed = _ZRea.useSharedValue(0);
  const pageable = _ZRea.useSharedValue(1); // o pager pode pegar o arrasto (sem zoom, ou ampliada encostada na borda)

  useEffect(() => { nwSV.set(natW || 0); nhSV.set(natH || 0); }, [natW, natH, nwSV, nhSV]);

  const cbRef = useRef({});
  cbRef.current = { onDismissStart, onDismissEnd, onZoomChange, onEdgeSwipe, onDoubleTap, onPageableChange };
  const jsDismissStart = useCallback(() => { try { cbRef.current.onDismissStart && cbRef.current.onDismissStart(); } catch {} }, []);
  const jsDismissEnd = useCallback((d) => { try { cbRef.current.onDismissEnd && cbRef.current.onDismissEnd(!!d); } catch {} }, []);
  const jsZoom = useCallback((z) => { try { cbRef.current.onZoomChange && cbRef.current.onZoomChange(!!z); } catch {} }, []);
  const jsEdge = useCallback((d) => { try { cbRef.current.onEdgeSwipe && cbRef.current.onEdgeSwipe(d); } catch {} }, []);
  const jsDbl = useCallback(() => { try { cbRef.current.onDoubleTap && cbRef.current.onDoubleTap(); } catch {} }, []);
  const jsPageable = useCallback((p) => { try { cbRef.current.onPageableChange && cbRef.current.onPageableChange(!!p); } catch {} }, []);

  // Ao desmontar ampliado (troca de mídia / fechar) devolve o estado "sem zoom".
  useEffect(() => () => { if (zoomed.get() === 1) jsZoom(false); if (pageable.get() !== 1) jsPageable(true); }, [zoomed, jsZoom, pageable, jsPageable]);
  // Página que saiu da tela volta a 1× (como o Fotos/WhatsApp).
  useEffect(() => {
    if (isActive) return;
    try {
      if (sc.get() !== 1 || tx.get() !== 0 || ty.get() !== 0) { sc.set(1); tx.set(0); ty.set(0); }
      if (zoomed.get() === 1) { zoomed.set(0); jsZoom(false); }
      if (pageable.get() !== 1) { pageable.set(1); jsPageable(true); }
    } catch {}
  }, [isActive, sc, tx, ty, zoomed, jsZoom, pageable, jsPageable]);

  const gesture = useMemo(() => {
    const G = _ZGH.Gesture;
    const setPageable = (p) => {
      'worklet';
      if (p !== pageable.get()) {
        pageable.set(p);
        _zRunOnJS(jsPageable)(p === 1);
      }
    };
    const setZoomFlag = (z) => {
      'worklet';
      if (z !== zoomed.get()) {
        zoomed.set(z);
        _zRunOnJS(jsZoom)(z === 1);
      }
      if (z === 0) setPageable(1);
      else setPageable(0); // ampliando: trava o pager até a foto assentar (reportEdge decide)
    };
    const bx = (s) => { 'worklet'; return _zBoundX(s, cw.get(), ch.get(), nwSV.get(), nhSV.get()); };
    const by = (s) => { 'worklet'; return _zBoundY(s, cw.get(), ch.get(), nwSV.get(), nhSV.get()); };
    // Depois que a foto assenta: ampliada e encostada numa borda horizontal →
    // libera o pager (o arrasto p/ fora pagina); no meio da foto → pager travado.
    const reportEdge = (finished) => {
      'worklet';
      if (finished === false) return;
      const s = sc.get();
      if (s <= 1.02 || zoomed.get() !== 1) { setPageable(1); return; }
      const mx = bx(s);
      const x = tx.get();
      setPageable((x >= mx - 2 || x <= -mx + 2) ? 1 : 0);
    };
    const rubber = (v, m) => {
      'worklet';
      if (v > m) return m + (v - m) * 0.35;
      if (v < -m) return -m + (v + m) * 0.35;
      return v;
    };
    const settle = () => {
      'worklet';
      let s = _zClamp(sc.get(), 1, _Z_MAX);
      const reset = s <= 1.02;
      if (reset) s = 1;
      const mx = bx(s);
      const my = by(s);
      // Escala volta ao teto → recentra proporcionalmente.
      const ratio = sc.get() > 0 ? s / sc.get() : 1;
      sc.set(_zWithSpring(s, _Z_SPRING));
      tx.set(_zWithSpring(reset ? 0 : _zClamp(tx.get() * ratio, -mx, mx), _Z_SPRING, reportEdge));
      ty.set(_zWithSpring(reset ? 0 : _zClamp(ty.get() * ratio, -my, my), _Z_SPRING));
      setZoomFlag(reset ? 0 : 1);
    };

    const pinch = G.Pinch()
      .onStart((e) => {
        'worklet';
        pinched.set(1);
        pinchLive.set(1);
        setPageable(0);
        s0.set(sc.get());
        tx0.set(tx.get());
        ty0.set(ty.get());
        fx0.set(e.focalX - cw.get() / 2);
        fy0.set(e.focalY - ch.get() / 2);
      })
      .onUpdate((e) => {
        'worklet';
        let ns = s0.get() * e.scale;
        if (ns < 1) ns = 1 - (1 - ns) * 0.45;            // elástico abaixo de 1
        if (ns > _Z_MAX) ns = _Z_MAX + (ns - _Z_MAX) * 0.3; // elástico acima do teto
        const s00 = s0.get() || 1;
        const cx = (fx0.get() - tx0.get()) / s00;          // ponto do conteúdo sob o foco
        const cy = (fy0.get() - ty0.get()) / s00;
        const fx = e.focalX - cw.get() / 2;
        const fy = e.focalY - ch.get() / 2;
        sc.set(ns);
        tx.set(fx - ns * cx);
        ty.set(fy - ns * cy);
      })
      .onEnd(() => { 'worklet'; pinchLive.set(0); settle(); });

    const pan = G.Pan()
      .manualActivation(true)
      .averageTouches(true)
      .onTouchesDown((e) => {
        'worklet';
        const n = e.allTouches ? e.allTouches.length : 0;
        if (n === 1 && e.allTouches[0]) {
          sx.set(e.allTouches[0].absoluteX);
          sy.set(e.allTouches[0].absoluteY);
          pinched.set(0);
          want.set(0);
          decided.set(0);
          const s = sc.get();
          if (s > 1.02) {
            const mx = bx(s);
            const x = tx.get();
            edge.set((x >= mx - 2 ? 1 : 0) + (x <= -mx + 2 ? 2 : 0));
          } else {
            edge.set(3);
          }
        }
      })
      .onTouchesMove((e, mgr) => {
        'worklet';
        if (decided.get() === 1) return; // decide UMA vez por gesto (activate repetido re-setava o estado do recognizer)
        const n = e.numberOfTouches;
        const isZoomed = sc.get() > 1.02;
        const act = (w) => { decided.set(1); want.set(w); mgr.activate(); };
        const fail = () => { decided.set(1); mgr.fail(); };
        if (n >= 2) {
          // Pinça: o pan ativa só p/ SEGURAR o pager (sem ele, o UIScrollView
          // pode reconhecer o arrasto de 2 dedos e passar de página no meio da pinça).
          act(isZoomed ? 1 : 3);
          return;
        }
        if (n !== 1) return;
        const t0 = e.allTouches[0];
        if (!t0) return;
        const dx = t0.absoluteX - sx.get();
        const dy = t0.absoluteY - sy.get();
        const adx = dx < 0 ? -dx : dx;
        const ady = dy < 0 ? -dy : dy;
        if (isZoomed) {
          if (dx * dx + dy * dy < 25) return; // decide em ~5 px (o UIScrollView só começa em ~10 pt)
          const ed = edge.get();
          if (adx > ady && ((dx > 0 && (ed & 1)) || (dx < 0 && (ed & 2)))) {
            fail(); // já na borda e puxando p/ fora → o pager pagina
            return;
          }
          act(1);
          return;
        }
        // Sem zoom: horizontal é 100% do pager → falha JÁ (não fica "pendente").
        if (adx > 4 && adx >= ady) { fail(); return; }
        if (dy < -8 && ady > adx) { fail(); return; }
        if (dy > 8 && dy > adx * 1.2) act(2);
      })
      .onStart(() => {
        'worklet';
        let w = want.get();
        if (w === 0) w = sc.get() > 1.02 ? 1 : 3;
        mode.set(w);
        lastTX.set(0);
        lastTY.set(0);
        rawX.set(tx.get());
        rawY.set(ty.get());
        tx0.set(tx.get());
        ty0.set(ty.get());
        if (w === 2) _zRunOnJS(jsDismissStart)();
      })
      .onUpdate((e) => {
        'worklet';
        const m = mode.get();
        if (m === 1) {
          const ddx = e.translationX - lastTX.get();
          const ddy = e.translationY - lastTY.get();
          lastTX.set(e.translationX);
          lastTY.set(e.translationY);
          if (e.numberOfPointers > 1 || pinchLive.get() === 1) {
            // a pinça manda na posição; só ressincroniza a base
            rawX.set(tx.get());
            rawY.set(ty.get());
            return;
          }
          const s = sc.get();
          const mx = bx(s);
          const my = by(s);
          rawX.set(rawX.get() + ddx);
          rawY.set(rawY.get() + ddy);
          tx.set(rubber(rawX.get(), mx));
          ty.set(rubber(rawY.get(), my));
        } else if (m === 2) {
          const dy = e.translationY > 0 ? e.translationY : 0;
          ty.set(e.translationY > 0 ? e.translationY : e.translationY * 0.2);
          tx.set(e.translationX * 0.6);
          sc.set(Math.max(0.78, 1 - dy / (ch.get() * 1.6)));
          if (dismissSV) dismissSV.set(_zClamp(dy / (ch.get() * 0.5), 0, 1));
        }
      })
      .onEnd((e, success) => {
        'worklet';
        const m = mode.get();
        mode.set(0);
        if (m === 1) {
          if (pinched.get() === 1) {
            // settle() da pinça já assentou; se depois dela ainda arrastou com 1
            // dedo, só devolve p/ dentro dos limites da escala final.
            if (zoomed.get() !== 1) return;
            const sF = _zClamp(sc.get(), 1, _Z_MAX);
            const fmx = bx(sF);
            const fmy = by(sF);
            const fx = tx.get();
            const fy = ty.get();
            if (fx > fmx || fx < -fmx) tx.set(_zWithSpring(_zClamp(fx, -fmx, fmx), _Z_SPRING, reportEdge));
            if (fy > fmy || fy < -fmy) ty.set(_zWithSpring(_zClamp(fy, -fmy, fmy), _Z_SPRING));
            return;
          }
          const s = sc.get();
          const mx = bx(s);
          const my = by(s);
          const x = tx.get();
          const y = ty.get();
          // Soltou puxando além da borda (elástico) → troca de página.
          const over = x > mx ? x - mx : (x < -mx ? x + mx : 0);
          let dir = 0;
          if (over > 40 || (over > 6 && e.velocityX > 600)) dir = -1;
          else if (over < -40 || (over < -6 && e.velocityX < -600)) dir = 1;
          if (dir !== 0) _zRunOnJS(jsEdge)(dir);
          tx.set((x > mx || x < -mx) ? _zWithSpring(_zClamp(x, -mx, mx), _Z_SPRING, reportEdge) : _zWithDecay({ velocity: e.velocityX, clamp: [-mx, mx] }, reportEdge));
          ty.set((y > my || y < -my) ? _zWithSpring(_zClamp(y, -my, my), _Z_SPRING) : _zWithDecay({ velocity: e.velocityY, clamp: [-my, my] }));
        } else if (m === 2) {
          const go = success !== false && (e.translationY > 110 || e.velocityY > 900);
          if (go) {
            ty.set(_zWithTiming(ch.get(), { duration: 200 }));
            if (dismissSV) dismissSV.set(_zWithTiming(1, { duration: 200 }));
            _zRunOnJS(jsDismissEnd)(true);
          } else {
            tx.set(_zWithSpring(0, _Z_SPRING));
            ty.set(_zWithSpring(0, _Z_SPRING));
            sc.set(_zWithSpring(1, _Z_SPRING));
            if (dismissSV) dismissSV.set(_zWithSpring(0, _Z_SPRING));
            _zRunOnJS(jsDismissEnd)(false);
          }
        }
      });

    const dbl = G.Tap()
      .numberOfTaps(2)
      .maxDelay(260)
      .maxDistance(24) // arrasto não conta como toque (2 swipes rápidos ≠ duplo toque)
      .onEnd((e, success) => {
        'worklet';
        if (success === false) return;
        _zRunOnJS(jsDbl)();
        if (sc.get() > 1.02) {
          sc.set(_zWithSpring(1, _Z_SPRING));
          tx.set(_zWithSpring(0, _Z_SPRING));
          ty.set(_zWithSpring(0, _Z_SPRING));
          setZoomFlag(0);
          return;
        }
        const s = _Z_DOUBLE;
        const fx = e.x - cw.get() / 2;
        const fy = e.y - ch.get() / 2;
        const mx = bx(s);
        const my = by(s);
        sc.set(_zWithSpring(s, _Z_SPRING));
        setZoomFlag(1);
        tx.set(_zWithSpring(_zClamp(-fx * (s - 1), -mx, mx), _Z_SPRING, reportEdge));
        ty.set(_zWithSpring(_zClamp(-fy * (s - 1), -my, my), _Z_SPRING));
      });

    return G.Simultaneous(pinch, pan, dbl);
  }, [dismissSV, jsZoom, jsDismissStart, jsDismissEnd, jsEdge, jsDbl, sc, tx, ty, cw, ch, nwSV, nhSV, s0, tx0, ty0, fx0, fy0, sx, sy, rawX, rawY, lastTX, lastTY, edge, want, pinched, pinchLive, mode, zoomed, pageable, jsPageable]);

  const aStyle = _ZRea.useAnimatedStyle(() => ({
    transform: [{ translateX: tx.get() }, { translateY: ty.get() }, { scale: sc.get() }],
  }));

  return (
    <_ZGH.GestureHandlerRootView style={s.mediaContainer}>
      <_ZGH.GestureDetector gesture={gesture}>
        <View
          style={s.mediaContainer}
          collapsable={false}
          onLayout={(e) => {
            const { width, height } = e.nativeEvent.layout;
            if (width > 0) cw.set(width);
            if (height > 0) ch.set(height);
          }}
        >
          <RA.View style={[s.mediaContainer, aStyle]}>
            {children}
          </RA.View>
        </View>
      </_ZGH.GestureDetector>
    </_ZGH.GestureHandlerRootView>
  );
}
// HEIC/HEIF are iOS-native captures. Server already transcodes for thumbnails
// (ImageMagick fallback in driveGenerateThumbnail). Listing them here lets the
// fullscreen viewer pick the image branch on iOS, where native ImageIO renders
// HEIC directly. Android falls through to <Image> which on RN 0.83+ also
// decodes HEIC via libheif.
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif'];
const VIDEO_EXTS = ['mp4', 'mov', 'avi', 'webm', 'mkv', 'm4v', '3gp'];
const PDF_EXTS = ['pdf'];
// [2026-10-09 native-docs] Office/iWork/RTF/CSV open on-device (iOS WKWebView
// local render / Android "Abrir com…") — no Google viewer.
const DOCX_EXTS = ['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'rtf', 'odt', 'ods', 'odp', 'pages', 'numbers', 'key', 'csv'];
const PREVIEWABLE_EXTS = [...PDF_EXTS, ...DOCX_EXTS];

function getExt(filename) {
  return (filename || '').split('.').pop().toLowerCase();
}

function getFullUrl(url, _noLocal) {
  if (!url) return '';
  // If the source is already a local file (e.g. just-recorded outbox audio),
  // hand it back untouched — no normalization, no remote prefix.
  if (typeof url === 'string' && (url.startsWith('file://') || url.startsWith('content://') || url.startsWith('blob:'))) {
    return url;
  }
  // CRITICAL (2026-05-19): route through api.getMediaUrl() so we produce the
  // SAME canonical URL that the chat bubble used at render time (CDN host:
  // media.chatyy.com.br for /data/chat-files/). Previously this hardcoded
  // `https://chatyy.com.br${url}` for relative paths AND left existing
  // chatyy.com.br absolute URLs untouched — but the bubble caches under the
  // CDN-rewritten URL (see app/chat-conversation.js#resolveMediaUri which
  // uses api.getMediaUrl). Result: tap-to-open computed a DIFFERENT
  // urlToKey() hash than the bubble's cache entry, getLocalUriIfCached
  // returned null, the viewer tried to fetch from the origin host (slower /
  // sometimes unreachable behind Cloudflare), and the user saw a blank
  // viewer or eternal spinner ("fotos não tá abrindo no celular"). Routing
  // through api.getMediaUrl unifies the cache lookup with the bubble path.
  let full;
  try {
    const _api = require('../services/api');
    if (_api?.getMediaUrl) {
      full = _api.getMediaUrl(url);
    } else {
      full = url.startsWith('http') ? url : `https://chatyy.com.br${url}`;
    }
  } catch {
    full = url.startsWith('http') ? url : `https://chatyy.com.br${url}`;
  }
  if (!full) full = url.startsWith('http') ? url : `https://chatyy.com.br${url}`;
  // OFFLINE-FIRST: if we already have the file on disk (mediaCache.syncIndex),
  // return that path instead of the CDN URL. ImageViewer / VideoPlayer /
  // PreviewViewer / GenericFileViewer all hand the result straight to native
  // surfaces (RN Image / expo-video / WKWebView / Linking) which accept
  // file:// URIs uniformly. This is the whole "tocando offline" guarantee —
  // when the radio drops mid-stream, native keeps reading from disk and
  // playback never pauses.
  if (Platform.OS !== 'web' && !_noLocal) {
    try {
      const { getLocalUriIfCached } = require('../services/mediaCache');
      const local = getLocalUriIfCached(full);
      if (local) return local;
      // Belt-and-suspenders: also try the original (non-CDN-rewritten) URL
      // in case the cache was populated by a code path that didn't go
      // through api.getMediaUrl (older sessions, manual saves, etc.).
      if (full !== url && url.startsWith('http')) {
        const alt = getLocalUriIfCached(url);
        if (alt) return alt;
      }
    } catch {}
  }
  // WKWebView (iOS) is strict about reserved-but-unencoded characters in URLs.
  // Filenames sometimes contain "$", spaces, or unicode (e.g. legacy uploads
  // where the filename was "$value.pdf") which makes the WebView refuse to
  // resolve the resource — user sees a blank dark screen. Re-encode anything
  // that isn't already percent-encoded so WKWebView accepts the URL.
  try {
    if (/[ $#?]|[^\x20-\x7E]/.test(full) && !/%[0-9A-Fa-f]{2}/.test(full)) {
      return encodeURI(full);
    }
  } catch {}
  return full;
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

// WAVE 60: WhatsApp/IG-grade viewer chrome helpers.
// Initials from sender name or email → 1-2 uppercase chars for the avatar
// circle. Mirrors the chat list pattern.
function senderInitials(name, email) {
  const src = (name && name.trim()) || (email || '').split('@')[0] || '';
  if (!src) return '?';
  const parts = src.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return (parts[0] || '?').slice(0, 2).toUpperCase();
}

// Stable color from a string — used for the avatar bg when no photo is
// available. Matches the chat list palette so the same user shows the same
// color across screens.
function colorFromString(str) {
  const palette = ['#111111', '#111111', '#F59E0B', '#10B981', '#3B82F6', '#EF4444', '#111111', '#06B6D4'];
  let hash = 0;
  for (let i = 0; i < (str || '').length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return palette[Math.abs(hash) % palette.length];
}

// "agora", "5 min", "2 h", "ontem" or short date — IG-style compact label.
function viewerRelativeTime(ts, t) {
  if (!ts) return '';
  const ms = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
  if (!ms || isNaN(ms)) return '';
  const diff = Date.now() - ms;
  if (diff < 60000) return t?.('time.now') || 'agora';
  if (diff < 3600000) return Math.floor(diff / 60000) + ' min';
  if (diff < 86400000) return Math.floor(diff / 3600000) + ' h';
  if (diff < 172800000) return t?.('viewer.yesterday') || 'ontem';
  try {
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' });
  } catch {
    return '';
  }
}

// ============================================================
// IMAGE VIEWER with pan/zoom
// ============================================================
// Native UIScrollView+UIImageView for iOS — pinch/zoom 60fps perfect.
// Falls back to the JS PanResponder implementation on Android/web.
let _NativeImageZoomView = null;
if (Platform.OS === 'ios') {
  try { _NativeImageZoomView = require('../modules/expo-native-toolkit').ImageZoomView; } catch {}
  // Try alternative export shape (native modules sometimes export differently)
  if (!_NativeImageZoomView) {
    try {
      const { requireNativeView } = require('expo');
      _NativeImageZoomView = requireNativeView('ExpoNativeImageZoomView');
    } catch {}
  }
}

function NativeImageViewerWithLoading({ url }) {
  const { t } = useLanguage();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [retryEpoch, setRetryEpoch] = useState(0);

  useEffect(() => {
    setLoading(true);
    setError(null);
    let cancelled = false;
    const timeout = setTimeout(() => {
      if (!cancelled) {
        setLoading(false);
        setError(t('mediaViewer.loadTimeout'));
      }
    }, 20000);
    Image.prefetch(url)
      .then(() => {
        if (cancelled) return;
        clearTimeout(timeout);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        clearTimeout(timeout);
        setLoading(false);
        setError(t('mediaViewer.loadFailed'));
      });
    return () => { cancelled = true; clearTimeout(timeout); };
  }, [url, retryEpoch]);

  return (
    <View style={s.mediaContainer}>
      {!loading && !error && (
        <_NativeImageZoomView key={retryEpoch} style={s.mediaContainer} uri={url} />
      )}
      {loading && (
        <View style={[s.mediaContainer, { alignItems: 'center', justifyContent: 'center' }]}>
          <ActivityIndicator size="large" color="#fff" />
          <Text style={{ color: 'rgba(255,255,255,0.6)', marginTop: 12, fontSize: 13 }}>
            {t('chatConv.loadingImage')}
          </Text>
        </View>
      )}
      {error && (
        <View style={[s.mediaContainer, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
          <Text style={{ color: '#fff', fontSize: 15, fontWeight: '600', marginBottom: 6 }}>
            {t('mediaViewer.oops')}
          </Text>
          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
            {error}
          </Text>
          <TouchableOpacity
            onPress={() => setRetryEpoch(e => e + 1)}
            style={{ backgroundColor: '#111111', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 }}
            accessibilityLabel={t('common.tryAgain')}
            accessibilityRole="button"
          >
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }}>{t('common.tryAgain')}</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

// Passthrough used when react-native-gesture-handler's PinchGestureHandler
// isn't on the path (keeps the image rendering without pinch instead of
// crashing). Defined at module scope so it isn't remounted each render.
function _PinchPassthrough({ children }) { return children; }

function ImageViewer({ url, messageId, conversationId, fileSize, createdAt, t, placeholderUri, blurhash, thumbUri, onDismissMove, onDismissEnd, dismissSV, onDismissStart, onZoomChange, isActive = true, onEdgeSwipe, onDoubleTap, onPageableChange }) {
  // [2026-10-08 photo-editor] tamanho natural (limites do pan no zoom UI-thread)
  const [_nat, _setNat] = useState(null);
  // We deliberately DO NOT use `_NativeImageZoomView` here even on iOS. The
  // native view downloads via raw URLSession which (a) lacks the loading
  // indicator the user expects and (b) silently fails for some CDN routes.
  // The JS PanResponder implementation below uses RN Image which has a
  // proper `onLoadEnd` event and honors the shared image cache (so the
  // image is already warm from the chat bubble). 60fps zoom still works
  // because scale/translate are driven via useNativeDriver where possible.

  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const [loading, setLoading] = useState(true);
  const [imageError, setImageError] = useState(null);
  // R2-backed redownload state. When the original URL 404s (cache evicted
  // or CDN purge propagation issue), tap "Baixar de novo" → server returns
  // a fresh CDN/origin/presigned URL → we render that. `freshUrl` overrides
  // `url` once set so the parent doesn't have to be aware.
  const [freshUrl, setFreshUrl] = useState(null);
  const [redownloading, setRedownloading] = useState(false);
  const [redownloadFailed, setRedownloadFailed] = useState(null); // { deleted? }
  // Bump on retry tap → forces RN <Image> to remount + re-fetch (changing
  // the `key` prop is the only reliable way; setting state alone won't
  // re-trigger the network request after onError fired).
  const [retryEpoch, setRetryEpoch] = useState(0);
  // [2026-10-08 media-local-store] URLs já tentadas nesta abertura (fallback
  // automático de host: origem US → CDN R2) — cada uma no máximo 1×.
  const _triedRef = useRef(new Set());
  // Reset state whenever the URL changes so the spinner stops spinning on
  // the previous image when the modal is opened for a new one.
  useEffect(() => {
    setLoading(true);
    setImageError(null);
    setFreshUrl(null);
    setRedownloading(false);
    setRedownloadFailed(null);
    _triedRef.current = new Set();
  }, [url]);
  const handleRetry = useCallback(() => {
    _triedRef.current = new Set();
    setFreshUrl(null);
    setLoading(true);
    setImageError(null);
    setRetryEpoch(e => e + 1);
  }, []);
  const handleRedownload = useCallback(async () => {
    if (!messageId || redownloading) return;
    setRedownloading(true);
    setRedownloadFailed(null);
    try {
      const { requestRedownload } = require('../services/mediaCache');
      const r = await requestRedownload(messageId, url, { conversationId });
      if (r?.ok && (r.localUri || r.url)) {
        _triedRef.current = new Set();
        setFreshUrl(r.localUri || r.url);
        setImageError(null);
        setLoading(true);
        setRetryEpoch(e => e + 1);
      } else {
        setRedownloadFailed({ deleted: !!r?.deleted, error: r?.error || 'unknown' });
      }
    } catch (e) {
      setRedownloadFailed({ error: 'network' });
    } finally {
      setRedownloading(false);
    }
  }, [messageId, redownloading, url, conversationId]);
  // [2026-10-08 media-local-store] Cópia LOCAL da mensagem (store permanente)
  // vence a URL remota — mesmo se a URL mudou ou o servidor perdeu o arquivo.
  const _localForMsg = useMemo(() => {
    if (Platform.OS === 'web' || !messageId) return null;
    if (typeof url === 'string' && (url.startsWith('file://') || url.startsWith('content://'))) return null;
    try { return require('../services/mediaCache').getLocalUriForMessage?.(messageId) || null; } catch { return null; }
  }, [messageId, url]);
  const effectiveUrl = freshUrl || _localForMsg || url;
  const lastScale = useRef(1);
  const lastTranslateX = useRef(0);
  const lastTranslateY = useRef(0);
  const lastTap = useRef(0);
  // Swipe-DOWN-to-dismiss (WhatsApp/IG signature). Only fires when the image
  // is NOT zoomed and the drag is predominantly vertical + downward. In an
  // album the horizontal drags fall through to the parent paging FlatList;
  // when zoomed, drags pan the image (handled above). Callbacks are read
  // through a ref so the once-created PanResponder never captures a stale
  // closure of the parent's handlers.
  const isDismissing = useRef(false);
  const _dismissCb = useRef({});
  _dismissCb.current = { onDismissMove, onDismissEnd };

  const resetTransform = useCallback(() => {
    Animated.spring(scale, { toValue: 1, useNativeDriver: false, friction: 8, tension: 60 }).start();
    Animated.spring(translateX, { toValue: 0, useNativeDriver: false, friction: 8, tension: 60 }).start();
    Animated.spring(translateY, { toValue: 0, useNativeDriver: false, friction: 8, tension: 60 }).start();
    lastTranslateX.current = 0;
    lastTranslateY.current = 0;
  }, [scale, translateX, translateY]);

  const panResponder = useRef(
    PanResponder.create({
      // Only own SINGLE-finger gestures. Two-finger pinch is handled by the
      // RNGH PinchGestureHandler wrapping the image, so the two gesture
      // systems don't fight over the same touch stream.
      onStartShouldSetPanResponder: (e) => ((e?.nativeEvent?.touches?.length || 1) < 2),
      onMoveShouldSetPanResponder: (e, g) => ((e?.nativeEvent?.touches?.length || 1) < 2) && (Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2),
      onPanResponderGrant: () => {
        // Double-tap to zoom
        const now = Date.now();
        if (now - lastTap.current < 300) {
          const target = lastScale.current > 1 ? 1 : 2.5;
          Animated.spring(scale, { toValue: target, useNativeDriver: false, friction: 7 }).start();
          if (target === 1) {
            Animated.spring(translateX, { toValue: 0, useNativeDriver: false }).start();
            Animated.spring(translateY, { toValue: 0, useNativeDriver: false }).start();
            lastTranslateX.current = 0;
            lastTranslateY.current = 0;
          }
          lastScale.current = target;
        }
        lastTap.current = now;
        isDismissing.current = false;
      },
      onPanResponderMove: (_, g) => {
        if (lastScale.current > 1) {
          // Zoomed → pan the image.
          translateX.setValue(lastTranslateX.current + g.dx);
          translateY.setValue(lastTranslateY.current + g.dy);
          return;
        }
        // Not zoomed → swipe-down-to-dismiss. The image tracks the finger and
        // shrinks slightly; the parent fades the black backdrop via the
        // progress callback so the chat shows through underneath (IG/WA feel).
        if (g.dy > 0 && Math.abs(g.dy) > Math.abs(g.dx)) {
          isDismissing.current = true;
          translateY.setValue(g.dy);
          scale.setValue(Math.max(0.82, 1 - g.dy / (SCREEN_H * 1.5)));
          try { _dismissCb.current.onDismissMove && _dismissCb.current.onDismissMove(g.dy); } catch {}
        }
      },
      onPanResponderRelease: (_, g) => {
        if (lastScale.current > 1) {
          lastTranslateX.current += g.dx;
          lastTranslateY.current += g.dy;
          return;
        }
        if (isDismissing.current) {
          isDismissing.current = false;
          // Past ~120px OR a fast flick → dismiss. Otherwise spring back.
          const shouldDismiss = g.dy > 120 || g.vy > 0.8;
          if (shouldDismiss) {
            try { _dismissCb.current.onDismissEnd && _dismissCb.current.onDismissEnd(true); } catch {}
          } else {
            Animated.spring(translateY, { toValue: 0, useNativeDriver: false, friction: 8, tension: 60 }).start();
            Animated.spring(scale, { toValue: 1, useNativeDriver: false, friction: 8, tension: 60 }).start();
            try { _dismissCb.current.onDismissEnd && _dismissCb.current.onDismissEnd(false); } catch {}
          }
        }
      },
      onPanResponderTerminate: () => {
        if (isDismissing.current) {
          isDismissing.current = false;
          Animated.spring(translateY, { toValue: 0, useNativeDriver: false }).start();
          Animated.spring(scale, { toValue: 1, useNativeDriver: false }).start();
          try { _dismissCb.current.onDismissEnd && _dismissCb.current.onDismissEnd(false); } catch {}
        }
      },
    })
  ).current;

  // Pinch-to-zoom via react-native-gesture-handler. Composes with the
  // single-finger PanResponder above (see the touches-length guard). Scale is
  // clamped to [1, 4]; releasing below ~1 springs back to fit and recenters.
  let _GH = null, _PinchHandler = null;
  try { _GH = require('react-native-gesture-handler'); _PinchHandler = _GH.PinchGestureHandler; } catch {}
  const _PinchWrap = _PinchHandler || _PinchPassthrough;
  const _pinchBase = useRef(1);
  const onPinchEvent = useCallback((ev) => {
    const next = Math.max(1, Math.min(4, _pinchBase.current * (ev?.nativeEvent?.scale || 1)));
    scale.setValue(next);
  }, [scale]);
  const onPinchStateChange = useCallback((ev) => {
    const st = ev?.nativeEvent?.state;
    const S = _GH?.State;
    if (!S) return;
    if (st === S.BEGAN || st === S.ACTIVE) {
      if (st === S.BEGAN) _pinchBase.current = lastScale.current || 1;
    } else if (st === S.END || st === S.CANCELLED || st === S.FAILED) {
      const committed = Math.max(1, Math.min(4, _pinchBase.current * (ev?.nativeEvent?.scale || 1)));
      lastScale.current = committed;
      if (committed <= 1.01) {
        lastScale.current = 1;
        resetTransform();
      }
    }
  }, [_GH, resetTransform]);

  // Instant blurred placeholder backdrop. Painted BEHIND the high-res photo
  // (and behind the spinner) so the user sees "the right photo, just fuzzy"
  // the moment they tap — instead of staring at a black screen + spinner
  // for the 200-2000ms while the full-res streams in. Priority order
  // matches the bubble: blurhash > base64 LQIP > thumb URL. Falls through
  // to nothing if the message had none of these (older messages pre-LQIP).
  let _PlaceholderImage = Image;
  try { _PlaceholderImage = require('expo-image').Image || Image; } catch {}
  const _hasInstantPreview = !!(blurhash || placeholderUri || thumbUri);

  // [2026-10-08 photo-editor] imagem içada: usada pelo zoom UI-thread OU pelo legado.
  const _imgEl = (
    <>
        {/* [WAVE 72 2026-05-21] Use expo-image instead of RN <Image>.
            Why: the chat bubble renders via ChatMedia → expo-image which
            keeps the bytes in expo-image's NATIVE memory+disk cache. RN
            <Image> uses a SEPARATE cache layer (NSURLCache on iOS / Fresco
            on Android), so opening the viewer for a photo that was already
            painted in the bubble paid a fresh network round-trip — ~1-2s on
            cellular. Switching the viewer to expo-image makes it a memory-
            cache HIT in the common case (bubble visible → tap → viewer):
            zero-latency paint, no spinner.
            • `cachePolicy="memory-disk"` shares the bubble's disk cache.
            • `priority="high"` jumps the queue when not yet cached.
            • `transition=0` avoids the 200ms fade-in (the loading state is
              gated by `loading` which we drive ourselves via onLoad). */}
        <_PlaceholderImage
          key={retryEpoch}
          // [2026-10-01] Fill the whole available area (flex:1) instead of a
          // fixed SCREEN_H*0.75 box. The fixed box left ~12.5% black above and
          // below; the top gap hid behind the opaque header bar while the
          // bottom gap stayed visible, so the photo READ as "stuck to the top
          // with a big black gap below". Filling the container + contentFit
          // 'contain' centers any photo (tall or short) with balanced spacing.
          // Pinch-zoom / swipe-dismiss / paging are unaffected — they live on
          // the wrapping Animated.View's transform, not on the image size.
          source={{ uri: effectiveUrl }}
          style={[s.fullImage, { height: undefined, flex: 1 }]}
          contentFit="contain"
          resizeMode="contain"
          cachePolicy="memory-disk"
          priority="high"
          transition={0}
          onLoad={(ev) => {
            setLoading(false);
            try {
              const src = ev?.source || ev?.nativeEvent?.source;
              if (src && src.width > 0 && src.height > 0) _setNat({ w: src.width, h: src.height });
            } catch {}
          }}
          onLoadEnd={() => setLoading(false)}
          onError={(e) => {
            setLoading(false);
            // [2026-10-08 media-local-store] Ordem de recuperação ANTES de
            // mostrar erro: (1) cópia local (por URL ou pela mensagem);
            // (2) se o local falhou, a URL remota original; (3) hosts
            // alternativos (origem US → CDN R2), 1× cada.
            try { _triedRef.current.add(effectiveUrl); } catch {}
            const _switchTo = (next) => {
              _triedRef.current.add(next);
              setFreshUrl(next);
              setImageError(null);
              setLoading(true);
              setRetryEpoch(epc => epc + 1);
            };
            try {
              const mc = require('../services/mediaCache');
              const isLocal = typeof effectiveUrl === 'string' && effectiveUrl.startsWith('file://');
              if (!isLocal) {
                const local = (effectiveUrl && mc.getLocalUriIfCached(effectiveUrl))
                  || (messageId ? mc.getLocalUriForMessage?.(messageId) : null);
                if (local && local !== effectiveUrl && !_triedRef.current.has(local)) { _switchTo(local); return; }
              }
              const remoteOrig = (typeof url === 'string' && /^https?:/i.test(url)) ? url : null;
              if (isLocal && remoteOrig && !_triedRef.current.has(remoteOrig)) { _switchTo(remoteOrig); return; }
              const base = remoteOrig || (!isLocal ? effectiveUrl : null);
              if (base) {
                const alts = require('../services/api').getMediaFallbackUrls?.(base) || [];
                const next = alts.find(a => a && !_triedRef.current.has(a));
                if (next) { _switchTo(next); return; }
              }
            } catch {}
            const raw = e?.nativeEvent?.error || '';
            // NUNCA mostrar o texto cru do servidor/SO (vinha "The requested URL
            // was not found on this server." em inglês). Classifica e traduz.
            const lower = String(raw).toLowerCase();
            const offlineLike = !raw
              || lower.includes('offline')
              || lower.includes('internet connection')
              || lower.includes('not connected')
              || lower.includes('unable to resolve')
              || lower.includes('no address associated')
              || lower.includes('failed to connect')
              || lower.includes('network connection was lost')
              || lower.includes('-1009')
              || lower.includes('econnreset');
            let _offlineNow = false;
            try { const ni = require('../services/networkInfo'); const tp = ni.getNetworkType?.(); _offlineNow = tp === 'none'; } catch {}
            const notFound = /not found|404|410|gone|no such/.test(lower);
            if (notFound) {
              setImageError(t?.('media.notOnServer') || 'Este arquivo não está mais no servidor e não há cópia salva neste aparelho.');
            } else if (offlineLike && (_offlineNow || !raw || !lower.includes('http'))) {
              setImageError(t?.('media.offlineCacheMiss') || 'Sem internet — esta mídia ainda não foi baixada.');
            } else {
              setImageError(t?.('media.loadFailedHint') || 'Não foi possível carregar agora. Verifique a conexão e tente de novo.');
            }
          }}
        />
    </>
  );

  return (
    <View style={s.mediaContainer}>
      {/* WhatsApp-style blurred preview behind the spinner. blurRadius keeps
          the thumb readable but not "good enough" — encourages the eye to
          stay until the high-res lands. blurhash uses ExpoImage native
          decode (faster than RN Image); thumbUri is the server-side
          small variant; placeholderUri is the embedded base64 LQIP. */}
      {loading && !imageError && _hasInstantPreview && (
        <_PlaceholderImage
          source={blurhash ? { blurhash } : { uri: placeholderUri || thumbUri }}
          style={[s.fullImage, { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }]}
          contentFit="contain"
          resizeMode="contain"
          blurRadius={placeholderUri || thumbUri ? 20 : 0}
          pointerEvents="none"
        />
      )}
      {loading && !imageError && <ActivityIndicator size="large" color="#fff" style={s.loader} />}
      {imageError && (
        <View style={[s.loader, { alignItems: 'center', justifyContent: 'center', padding: 24 }]}>
          {/* Header copy pivots on the failure type:
              - redownloadFailed.deleted (410)        → "Mensagem apagada"
              - imageError === offline cache-miss     → "Sem internet" (NOT
                "removida do cache" — the photo was never downloaded on this
                device; calling it "removed" misleads the user into thinking
                we deleted their photo).
              - everything else (transient / 404)     → "Mídia indisponível"
                (also more accurate than "removida do cache" — the message
                file may be gone from the server, not from our cache). */}
          {(() => {
            const offlineCopy = t?.('media.offlineCacheMiss') || 'Sem internet — esta mídia ainda não foi baixada.';
            const isOffline = imageError === offlineCopy;
            let header;
            if (redownloadFailed?.deleted) {
              header = t?.('media.messageDeleted') || 'Mensagem apagada';
            } else if (isOffline) {
              header = t?.('media.offlineTitle') || 'Sem internet';
            } else {
              header = t?.('media.fileUnavailable') || 'Mídia indisponível';
            }
            return (
              <>
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginBottom: 8 }}>
                  {header}
                </Text>
                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, textAlign: 'center', marginBottom: 4 }} numberOfLines={3}>
                  {redownloadFailed?.deleted
                    ? (t?.('media.messageDeletedHint') || 'O remetente apagou essa mensagem.')
                    : (imageError || '')}
                </Text>
              </>
            );
          })()}
          {/* "Last downloaded X ago" — only shown when we know the createdAt */}
          {!!createdAt && (
            <Text style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11, marginBottom: 16 }}>
              {(t?.('media.lastDownloaded') || 'Há {0}').replace('{0}', (() => {
                try { return require('../services/mediaCache').formatRelativeAge(createdAt); }
                catch { return ''; }
              })())}
            </Text>
          )}
          {messageId && !redownloadFailed?.deleted ? (
            <TouchableOpacity
              onPress={handleRedownload}
              disabled={redownloading}
              style={{
                backgroundColor: redownloading ? '#111111' : '#111111',
                paddingHorizontal: 20, paddingVertical: 10,
                borderRadius: 10, flexDirection: 'row', alignItems: 'center',
              }}
              accessibilityLabel={t?.('media.redownload') || 'Baixar de novo'}
              accessibilityRole="button"
            >
              {redownloading ? (
                <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
              ) : (
                <IconDownload size={16} color="#fff" />
              )}
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', marginLeft: 6 }}>
                {redownloading
                  ? (t?.('media.redownloading') || 'Baixando...')
                  : (t?.('media.redownload') || 'Baixar de novo')}
                {!redownloading && fileSize > 0 ? ` (${formatSize(fileSize)})` : ''}
              </Text>
            </TouchableOpacity>
          ) : null}
          {messageId && redownloadFailed && !redownloadFailed.deleted && !redownloading ? (
            <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 10, textAlign: 'center' }}>
              {t?.('media.redownloadFailed') || 'Não deu para baixar agora. Tente de novo em instantes.'}
            </Text>
          ) : null}
          {!redownloadFailed?.deleted ? (
            <TouchableOpacity
              onPress={handleRetry}
              style={messageId
                ? { marginTop: 8, paddingHorizontal: 16, paddingVertical: 8, borderRadius: 10 }
                : { backgroundColor: '#111111', paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 }}
              accessibilityLabel={t?.('chat.retry') || 'Tentar novamente'}
              accessibilityRole="button"
            >
              <Text style={{ color: messageId ? 'rgba(255,255,255,0.8)' : '#fff', fontSize: 14, fontWeight: '600' }}>
                {t?.('chat.retry') || 'Tentar novamente'}
              </Text>
            </TouchableOpacity>
          ) : null}
        </View>
      )}
      {_UI_ZOOM ? (
        <UIZoomSurface
          natW={_nat?.w}
          natH={_nat?.h}
          dismissSV={dismissSV}
          onDismissStart={onDismissStart}
          onDismissEnd={onDismissEnd}
          onZoomChange={onZoomChange}
          isActive={isActive}
          onEdgeSwipe={onEdgeSwipe}
          onDoubleTap={onDoubleTap}
          onPageableChange={onPageableChange}
        >
          {_imgEl}
        </UIZoomSurface>
      ) : (
      <_PinchWrap onGestureEvent={onPinchEvent} onHandlerStateChange={onPinchStateChange}>
      <Animated.View
        {...panResponder.panHandlers}
        style={[s.mediaContainer, {
          transform: [
            { scale },
            { translateX },
            { translateY },
          ],
        }]}
      >
        {_imgEl}
      </Animated.View>
      </_PinchWrap>
      )}
    </View>
  );
}

// ============================================================
// NATIVE VIDEO PLAYER
// First tries the AVPlayerLayer-wrapped Expo View from
// expo-native-toolkit (instant + hardware accelerated). Falls back to
// expo-video on Android/web or if the native module isn't loaded.
// ============================================================
let _NativeVideoPlayerView = null;
if (Platform.OS === 'ios') {
  try { _NativeVideoPlayerView = require('../modules/expo-native-toolkit').VideoPlayer; } catch {}
}

// [2026-10-11 video-fullhd] Web: can this browser's <video> play an HLS
// playlist by itself (Safari / iOS web)? Cached after the first probe.
let _hlsNativeWeb = null;
function _canPlayHlsNatively() {
  if (_hlsNativeWeb !== null) return _hlsNativeWeb;
  try {
    const v = typeof document !== 'undefined' ? document.createElement('video') : null;
    _hlsNativeWeb = !!(v && v.canPlayType && v.canPlayType('application/vnd.apple.mpegurl'));
  } catch { _hlsNativeWeb = false; }
  return _hlsNativeWeb;
}

function NativeVideoPlayer({ url, isActive = true, allowPip = true, noCache = false }) {
  // Prefer expo-video — has native AVPlayerViewController controls,
  // PiP, fullscreen, scrubbing, captions. Custom AVPlayerLayer view
  // exists for perf-sensitive inline playback but has no UI chrome
  // (was leaving the viewer black on first open because props ordering
  // could land uri before autoplay, so no play() ever fired).
  if (useVideoPlayer && ExpoVideo) {
    // [fix 2026-10-02] Do NOT auto-play on mount. The viewer FlatList preloads
    // the neighbor slides, so playing on mount made the NEXT video start playing
    // before you swiped to it ("o vídeo toca antes de abrir, passando de lado").
    // Only play the slide that's actually active; pause the rest.
    // [2026-10-10 native-audit] native disk cache (reopen = no re-download);
    // never for view-once media (noCache) — nothing of it may persist.
    const player = useVideoPlayer(noCache ? url : cachedVideoSource(url), (p) => {
      try { p.loop = false; p.muted = false; } catch {}
    });
    useEffect(() => {
      if (!player) return;
      try { if (isActive) player.play(); else player.pause(); } catch {}
    }, [isActive, player]);
    // [2026-10-14 offline-media] Vídeo remoto sem internet → expo-video ficava
    // "carregando" p/ sempre. Erro do player + offline = aviso no lugar.
    const { t: _tv } = useLanguage();
    const [_vidOfflineErr, _setVidOfflineErr] = useState(false);
    useEffect(() => {
      if (!player || typeof player.addListener !== 'function') return undefined;
      let sub = null;
      try {
        sub = player.addListener('statusChange', (ev) => {
          const st = ev && ev.status;
          if (st === 'readyToPlay') { _setVidOfflineErr(false); return; }
          if (st !== 'error') return;
          let online = true;
          try { const oc = require('../services/offlineCache'); if (typeof oc.isOnline === 'function') online = !!oc.isOnline(); } catch {}
          if (!online && !(typeof url === 'string' && url.startsWith('file://'))) _setVidOfflineErr(true);
        });
      } catch {}
      return () => { try { sub?.remove?.(); } catch {} };
    }, [player, url]);

    // Wave 14 — pinch-to-scrub. Uses react-native-gesture-handler's
    // PinchGestureHandler so the gesture composes cleanly with the
    // existing horizontal swipe-between-photos paging gesture; the
    // pinch's velocity * duration gives us a delta seek per frame.
    // Two-finger spread = scrub forward, pinch = scrub back. Falls back
    // to native controls when RNGH isn't on the path.
    let PinchHandler = null;
    let GH = null;
    try { GH = require('react-native-gesture-handler'); PinchHandler = GH?.PinchGestureHandler; } catch {}

    const pinchState = useRef({ baseTime: 0 });
    const onPinchEvent = useCallback((ev) => {
      try {
        const dur = player?.duration || 0;
        if (!dur || dur < 1) return;
        if (pinchState.current.baseTime <= 0) pinchState.current.baseTime = player.currentTime || 0;
        // scale ranges roughly 0.5..3 — map to delta of ±0.5 * duration
        const delta = (ev.nativeEvent.scale - 1) * dur * 0.5;
        const next = Math.max(0, Math.min(dur, pinchState.current.baseTime + delta));
        try { player.currentTime = next; } catch {}
      } catch {}
    }, [player]);
    const onPinchStateChange = useCallback((ev) => {
      if (ev.nativeEvent.state === GH?.State?.END || ev.nativeEvent.state === GH?.State?.CANCELLED) {
        pinchState.current.baseTime = 0;
      } else if (ev.nativeEvent.state === GH?.State?.BEGAN) {
        pinchState.current.baseTime = player?.currentTime || 0;
      }
    }, [player]);

    const videoNode = (
      <ExpoVideo
        player={player}
        style={s.fullVideo}
        allowsFullscreen
        allowsPictureInPicture={allowPip}
        // [2026-10-07 ios-native] WhatsApp-style PiP: a playing video floats
        // when the user leaves the app (home / app switch) and keeps playing;
        // only the ACTIVE slide opts in (neighbors are preloaded + paused).
        // View-once media never PiPs (it would outlive the "seen once" view).
        startsPictureInPictureAutomatically={allowPip && isActive}
        nativeControls
        contentFit="contain"
      />
    );

    return (
      <View style={s.mediaContainer}>
        {PinchHandler ? (
          <PinchHandler onGestureEvent={onPinchEvent} onHandlerStateChange={onPinchStateChange}>
            {videoNode}
          </PinchHandler>
        ) : videoNode}
        {_vidOfflineErr ? (
          <View pointerEvents="none" style={{ position: 'absolute', left: 24, right: 24, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 15, textAlign: 'center', backgroundColor: 'rgba(0,0,0,0.6)', paddingHorizontal: 14, paddingVertical: 10, borderRadius: 12, overflow: 'hidden' }}>
              {_tv?.('media.offlineCacheMiss') || 'Sem internet — esta mídia ainda não foi baixada.'}
            </Text>
          </View>
        ) : null}
      </View>
    );
  }
  if (_NativeVideoPlayerView) {
    return (
      <View style={s.mediaContainer}>
        <_NativeVideoPlayerView
          style={s.fullVideo}
          uri={url}
          autoplay={true}
          loop={false}
          muted={false}
        />
      </View>
    );
  }
  return null;
}

// VIDEO PLAYER (web fallback + native fallback)
// ============================================================
// Modern web video player — custom controls (no <video controls>),
// auto-hide overlay, big center play button, sleek bottom bar with
// progress + time + volume + fullscreen. Click anywhere on video
// toggles play/pause. Spacebar/arrow shortcuts.
// ============================================================
function fmtT(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ModernWebVideoPlayer({ url, videoRef }) {
  const { t } = useLanguage();
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pos, setPos] = useState(0);
  const [dur, setDur] = useState(0);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [showCtl, setShowCtl] = useState(true);
  const [buffered, setBuffered] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const containerRef = useRef(null);
  const hideTimer = useRef(null);
  const progRef = useRef(null);

  const scheduleHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = setTimeout(() => setShowCtl(false), 2400);
  }, []);

  useEffect(() => {
    scheduleHide();
    return () => { if (hideTimer.current) clearTimeout(hideTimer.current); };
  }, [scheduleHide]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener?.('fullscreenchange', onFs);
    return () => document.removeEventListener?.('fullscreenchange', onFs);
  }, []);

  const showAndSchedule = useCallback(() => {
    setShowCtl(true);
    scheduleHide();
  }, [scheduleHide]);

  const togglePlay = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play().catch(() => {}); } else { v.pause(); }
  }, [videoRef]);

  const seek = useCallback((pct) => {
    const v = videoRef.current;
    if (!v || !isFinite(v.duration)) return;
    v.currentTime = Math.max(0, Math.min(v.duration, v.duration * pct));
  }, [videoRef]);

  const seekFromEvent = useCallback((e) => {
    if (!progRef.current) return;
    const rect = progRef.current.getBoundingClientRect();
    const x = (e.touches?.[0]?.clientX ?? e.clientX) - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    seek(pct);
  }, [seek]);

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onPlay = () => { setPlaying(true); scheduleHide(); };
    const onPause = () => { setPlaying(false); setShowCtl(true); if (hideTimer.current) clearTimeout(hideTimer.current); };
    const onTime = () => { if (!scrubbing) setPos(v.currentTime || 0); };
    const onMeta = () => { setDur(v.duration || 0); setLoading(false); };
    const onWait = () => setLoading(true);
    const onCanPlay = () => setLoading(false);
    const onProg = () => {
      try {
        if (v.buffered.length && isFinite(v.duration) && v.duration > 0) {
          setBuffered(v.buffered.end(v.buffered.length - 1) / v.duration);
        }
      } catch {}
    };
    const onVol = () => { setMuted(v.muted); setVolume(v.volume); };
    v.addEventListener('play', onPlay);
    v.addEventListener('pause', onPause);
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('waiting', onWait);
    v.addEventListener('canplay', onCanPlay);
    v.addEventListener('progress', onProg);
    v.addEventListener('volumechange', onVol);
    return () => {
      v.removeEventListener('play', onPlay);
      v.removeEventListener('pause', onPause);
      v.removeEventListener('timeupdate', onTime);
      v.removeEventListener('loadedmetadata', onMeta);
      v.removeEventListener('waiting', onWait);
      v.removeEventListener('canplay', onCanPlay);
      v.removeEventListener('progress', onProg);
      v.removeEventListener('volumechange', onVol);
    };
  }, [videoRef, scrubbing, scheduleHide]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); togglePlay(); }
      else if (e.key === 'ArrowRight') { const v = videoRef.current; if (v) v.currentTime = Math.min(v.duration || 0, (v.currentTime || 0) + 5); showAndSchedule(); }
      else if (e.key === 'ArrowLeft') { const v = videoRef.current; if (v) v.currentTime = Math.max(0, (v.currentTime || 0) - 5); showAndSchedule(); }
      else if (e.key === 'm' || e.key === 'M') { const v = videoRef.current; if (v) v.muted = !v.muted; }
      else if (e.key === 'f' || e.key === 'F') { toggleFs(); }
    };
    document.addEventListener?.('keydown', onKey);
    return () => document.removeEventListener?.('keydown', onKey);
  }, [togglePlay, videoRef, showAndSchedule]);

  const toggleFs = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (!document.fullscreenElement) {
      el.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }, []);

  const toggleMute = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
  }, [videoRef]);

  const pct = dur > 0 ? (pos / dur) * 100 : 0;
  const bufPct = (buffered * 100) || 0;

  return (
    <View style={s.mediaContainer}>
      <div
        ref={containerRef}
        onMouseMove={showAndSchedule}
        onMouseLeave={() => playing && setShowCtl(false)}
        style={{
          position: 'relative',
          width: '100%',
          height: '100%',
          maxWidth: '100%',
          maxHeight: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#000',
          borderRadius: fullscreen ? 0 : 12,
          overflow: 'hidden',
          cursor: showCtl ? 'default' : 'none',
        }}
      >
        <video
          ref={videoRef}
          src={url}
          playsInline
          onClick={togglePlay}
          onDoubleClick={toggleFs}
          style={{
            maxWidth: '100%',
            maxHeight: '100%',
            width: 'auto',
            height: 'auto',
            objectFit: 'contain',
            cursor: 'pointer',
          }}
        />

        {/* Loading spinner */}
        {loading && (
          <div style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            pointerEvents: 'none',
          }}>
            <div style={{
              width: 56,
              height: 56,
              borderRadius: 28,
              border: '3px solid rgba(255,255,255,0.2)',
              borderTopColor: '#fff',
              animation: 'mvSpin 0.9s linear infinite',
            }} />
          </div>
        )}

        {/* Big center play button (only when paused, not loading) */}
        {!playing && !loading && (
          <button
            onClick={togglePlay}
            aria-label={t('common.play')}
            style={{
              position: 'absolute',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 84,
              height: 84,
              borderRadius: 42,
              border: 'none',
              background: 'rgba(0,0,0,0.55)',
              backdropFilter: 'blur(14px)',
              WebkitBackdropFilter: 'blur(14px)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              boxShadow: '0 4px 24px rgba(0,0,0,0.5)',
              transition: 'transform 0.15s ease, background 0.15s ease',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1.06)'; e.currentTarget.style.background = 'rgba(0,0,0,0.7)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.transform = 'translate(-50%, -50%) scale(1)'; e.currentTarget.style.background = 'rgba(0,0,0,0.55)'; }}
          >
            <svg width="32" height="32" viewBox="0 0 24 24" fill="#fff">
              <path d="M8 5v14l11-7z" />
            </svg>
          </button>
        )}

        {/* Bottom controls bar */}
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            padding: '40px 16px 12px',
            background: 'linear-gradient(180deg, rgba(0,0,0,0) 0%, rgba(0,0,0,0.85) 100%)',
            opacity: showCtl ? 1 : 0,
            transition: 'opacity 0.25s ease',
            pointerEvents: showCtl ? 'auto' : 'none',
          }}
        >
          {/* Progress bar */}
          <div
            ref={progRef}
            onMouseDown={(e) => { setScrubbing(true); seekFromEvent(e); }}
            onMouseMove={(e) => { if (e.buttons === 1) seekFromEvent(e); }}
            onMouseUp={() => setScrubbing(false)}
            onMouseLeave={() => setScrubbing(false)}
            onTouchStart={(e) => { setScrubbing(true); seekFromEvent(e); }}
            onTouchMove={seekFromEvent}
            onTouchEnd={() => setScrubbing(false)}
            style={{
              position: 'relative',
              height: 18,
              display: 'flex',
              alignItems: 'center',
              cursor: 'pointer',
              marginBottom: 6,
            }}
          >
            <div style={{
              position: 'absolute',
              left: 0,
              right: 0,
              height: 4,
              borderRadius: 2,
              background: 'rgba(255,255,255,0.25)',
              overflow: 'hidden',
            }}>
              <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${bufPct}%`,
                background: 'rgba(255,255,255,0.35)',
              }} />
              <div style={{
                position: 'absolute',
                left: 0,
                top: 0,
                bottom: 0,
                width: `${pct}%`,
                background: '#111111',
                borderRadius: 2,
                transition: scrubbing ? 'none' : 'width 0.1s linear',
              }} />
            </div>
            <div style={{
              position: 'absolute',
              left: `calc(${pct}% - 7px)`,
              width: 14,
              height: 14,
              borderRadius: 7,
              background: '#fff',
              boxShadow: '0 2px 6px rgba(0,0,0,0.5)',
              transition: scrubbing ? 'none' : 'left 0.1s linear',
              pointerEvents: 'none',
            }} />
          </div>

          {/* Bottom row: play, time, volume, fullscreen */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={togglePlay} aria-label={playing ? t('common.pause') : t('common.play')} style={ctlBtn}>
              {playing ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M6 4h4v16H6zm8 0h4v16h-4z"/></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M8 5v14l11-7z"/></svg>
              )}
            </button>
            <span style={{ color: '#fff', fontSize: 13, fontWeight: 500, fontVariantNumeric: 'tabular-nums', minWidth: 90 }}>
              {fmtT(pos)} <span style={{ color: 'rgba(255,255,255,0.55)' }}>/ {fmtT(dur)}</span>
            </span>
            <div style={{ flex: 1 }} />
            <button onClick={toggleMute} aria-label={muted ? t('feed.unmute') : t('chat.mute')} style={ctlBtn}>
              {muted || volume === 0 ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M3.63 3.63a1 1 0 0 0 0 1.41L7.29 8.7 7 9H4a1 1 0 0 0-1 1v4a1 1 0 0 0 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71v-4.17l4.18 4.18c-.49.37-1.02.68-1.6.91a1 1 0 0 0 .76 1.85c.86-.35 1.66-.83 2.36-1.42l1.27 1.27a1 1 0 0 0 1.41 0 1 1 0 0 0 0-1.41L5.05 3.63a1 1 0 0 0-1.42 0zM19 12a7 7 0 0 0-1.16-3.86l-1.45 1.45A5 5 0 0 1 17 12c0 .67-.13 1.31-.37 1.9l1.51 1.51A7 7 0 0 0 19 12zm-2.5 0a4.5 4.5 0 0 0-.16-1.18l-1.71 1.71v.04l1.6 1.6a4.4 4.4 0 0 0 .27-2.17zM12 4l-1.65 1.65L12 7.3z"/></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M3 10v4a1 1 0 0 0 1 1h3l3.29 3.29c.63.63 1.71.18 1.71-.71V6.41c0-.89-1.08-1.34-1.71-.71L7 9H4a1 1 0 0 0-1 1zm13.5 2A4.5 4.5 0 0 0 14 7.97v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v.41a1 1 0 0 0 .68.95A8.01 8.01 0 0 1 20 12a8 8 0 0 1-5.32 7.41A1 1 0 0 0 14 20.36v.41a1 1 0 0 0 1.32.95C19.21 20.4 22 16.52 22 12s-2.79-8.4-6.68-9.72A1 1 0 0 0 14 3.23z"/></svg>
              )}
            </button>
            <button onClick={toggleFs} aria-label={fullscreen ? t('mediaViewer.exitFullscreen') : t('viewer.fullscreen')} style={ctlBtn}>
              {fullscreen ? (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M5 16h3v3h2v-5H5v2zm3-8H5v2h5V5H8v3zm6 11h2v-3h3v-2h-5v5zm2-11V5h-2v5h5V8h-3z"/></svg>
              ) : (
                <svg width="20" height="20" viewBox="0 0 24 24" fill="#fff"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>
              )}
            </button>
          </div>
        </div>

        {/* Inline keyframes */}
        <style>{`
          @keyframes mvSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        `}</style>
      </div>
    </View>
  );
}

const ctlBtn = {
  width: 36,
  height: 36,
  border: 'none',
  background: 'transparent',
  cursor: 'pointer',
  borderRadius: 18,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  transition: 'background 0.15s ease',
};

// ============================================================
function VideoPlayer({ url, isActive = true, allowPip = true, noCache = false }) {
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(true);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(0);
  const [position, setPosition] = useState(0);
  const videoRef = useRef(null);
  const webVideoRef = useRef(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    return () => {
      if (Platform.OS === 'web') {
        try { webVideoRef.current?.pause(); } catch {}
      } else {
        videoRef.current?.unloadAsync?.().catch(() => {});
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  if (Platform.OS === 'web') {
    return <ModernWebVideoPlayer url={url} videoRef={webVideoRef} />;
  }

  // Native: try expo-video first (best MOV support)
  if (useVideoPlayer && ExpoVideo) {
    return <NativeVideoPlayer url={url} isActive={isActive} allowPip={allowPip} noCache={noCache} />;
  }

  // No expo-video module on this build — fall back to the native AVPlayer
  // view (iOS) via NativeVideoPlayer. No more per-video WebView (that was the
  // jank the video players were migrated off of).
  return <NativeVideoPlayer url={url} isActive={isActive} allowPip={allowPip} />;
}

// ============================================================
// Build preview.html URL for PDF/DOCX files
// ============================================================
function buildPreviewUrl(fileUrl, fileName) {
  const ext = getExt(fileName);
  const typeMap = { pdf: 'pdf', docx: 'docx', doc: 'docx' };
  const type = typeMap[ext] || '';
  return `/preview.html?url=${encodeURIComponent(fileUrl)}&type=${encodeURIComponent(type)}&name=${encodeURIComponent(fileName || 'file')}`;
}

// ============================================================
// PREVIEW VIEWER (PDF/DOCX)
// iOS WKWebView bug: PDFs inside <iframe> show blank. Workaround: load the
// PDF URL DIRECTLY as the WebView source — WKWebView has native PDF rendering
// when the PDF is the document root (not embedded).
// Android / web: iframe via preview.html works fine.
// Office docs (doc/xlsx): google viewer iframe works on Android + web; on iOS
// WKWebView handles the iframe OK because the inner content is HTML (not PDF).
// ============================================================
function PreviewViewer({ url, filename, messageId, fileSize, t }) {
  const ext = getExt(filename);
  const isPdf = ext === 'pdf';
  const fullFileUrl = getFullUrl(url);

  if (Platform.OS === 'web') {
    // [2026-10-09 native-docs] Office no longer goes through docs.google.com
    // (the attachment URL leaked to Google) → download/open card instead.
    if (!isPdf) {
      return <GenericFileViewer url={url} filename={filename} fileSize={fileSize || 0} messageId={messageId} t={t} />;
    }
    return (
      <View style={[s.mediaContainer, { alignItems: 'stretch', justifyContent: 'flex-start', width: '100%' }]}>
        <iframe
          src={fullFileUrl}
          style={{ width: '100%', height: SCREEN_H - 100, minHeight: 400, border: 'none', borderRadius: 8 }}
          title={filename}
        />
      </View>
    );
  }

  // [2026-10-09 native-docs] Native:
  //   - PDF + binary with ExpoNativePdfView → PDFKit (iOS) / PdfRenderer (Android).
  //   - PDF on older iOS binaries → WKWebView with the PDF as document root
  //     (PDFKit-backed) + the redownload error state below.
  //   - Office docs, or PDF on older Android binaries → NativeDocPreview's
  //     local path: download to cache, render the local file in WKWebView (iOS)
  //     or "Abrir com…" via the system (Android). Never docs.google.com.
  if (isPdf && hasNativePdfView()) {
    return (
      <View style={[s.mediaContainer, { alignItems: 'stretch', justifyContent: 'flex-start', width: '100%' }]}>
        <NativeDocPreview url={fullFileUrl} filename={filename} kind="pdf" dark openLabel={t?.('doc.openWith')} errorLabel={t?.('doc.openFailed')} />
      </View>
    );
  }
  if (isPdf && Platform.OS === 'ios') {
    try {
      require('react-native-webview');
      return <WebViewWithErrorFallback source={{ uri: fullFileUrl }} url={url} filename={filename} messageId={messageId} fileSize={fileSize} t={t} />;
    } catch {}
  }
  return (
    <View style={[s.mediaContainer, { alignItems: 'stretch', justifyContent: 'flex-start', width: '100%' }]}>
      <NativeDocPreview url={fullFileUrl} filename={filename} kind={isPdf ? 'pdf' : 'doc'} dark errorLabel={t?.('doc.openFailed')} />
    </View>
  );
}

// Wrapper around WebView that shows a friendly "file unavailable" state when
// the HTTP response is 4xx/5xx. Before this guard, iOS would show a blank
// black screen (WKWebView's default for failed PDF loads) and the user had
// no idea whether the file was gone, their network was down, or the app
// was broken.
function WebViewWithErrorFallback({ source, url, filename, messageId, fileSize, t }) {
  const { WebView } = require('react-native-webview');
  const [errored, setErrored] = useState(null); // { code, description } | null
  const [redownloading, setRedownloading] = useState(false);
  const [redownloadedSource, setRedownloadedSource] = useState(null);
  const [redownloadFailed, setRedownloadFailed] = useState(null);
  const handleRedownload = useCallback(async () => {
    if (!messageId || redownloading) return;
    setRedownloading(true);
    setRedownloadFailed(null);
    try {
      const { requestRedownload } = require('../services/mediaCache');
      const r = await requestRedownload(messageId, url);
      if (r?.ok && (r.localUri || r.url)) {
        setRedownloadedSource({ uri: r.localUri || r.url });
        setErrored(null);
      } else {
        setRedownloadFailed({ deleted: !!r?.deleted, error: r?.error || 'unknown' });
      }
    } catch {
      setRedownloadFailed({ error: 'network' });
    } finally {
      setRedownloading(false);
    }
  }, [messageId, redownloading, url]);
  if (errored) {
    return (
      <View style={[s.mediaContainer, { justifyContent: 'center', alignItems: 'center', padding: 24 }]}>
        <View style={[s.fileIcon, { backgroundColor: '#EF4444' + '22' }]}>
          <Text style={[s.fileExtText, { color: '#EF4444' }]}>!</Text>
        </View>
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', marginTop: 16, textAlign: 'center' }}>
          {redownloadFailed?.deleted
            ? (t?.('media.messageDeleted') || 'Mensagem apagada')
            : (errored.code === 404
                ? (t?.('media.cacheEvicted') || 'Mídia removida do cache')
                : (t?.('media.fileUnavailable') || 'Arquivo indisponível'))}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13, marginTop: 6, textAlign: 'center' }}>
          {redownloadFailed?.deleted
            ? (t?.('media.messageDeletedHint') || 'O remetente apagou essa mensagem.')
            : (errored.code === 404
                ? (t?.('media.cacheEvictedHint') || 'Toque em "Baixar de novo" para recuperar do servidor.')
                : (errored.code === 0
                    // code 0 = native onError (network/offline) — surface
                    // localized copy, NOT the raw English NSURLError message.
                    ? (t?.('media.offlineCacheMiss') || 'Sem internet — esta mídia ainda não foi baixada.')
                    : (t?.('media.fileUnavailableHint') || 'Não foi possível carregar. Tente novamente em alguns segundos.')))}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, marginTop: 12, textAlign: 'center' }} numberOfLines={2}>
          {filename}
        </Text>
        {messageId && !redownloadFailed?.deleted && (
          <TouchableOpacity
            onPress={handleRedownload}
            disabled={redownloading}
            style={{
              marginTop: 16,
              backgroundColor: redownloading ? '#111111' : '#111111',
              paddingHorizontal: 20, paddingVertical: 10,
              borderRadius: 10, flexDirection: 'row', alignItems: 'center',
            }}
            accessibilityLabel={t?.('media.redownload') || 'Baixar de novo'}
            accessibilityRole="button"
          >
            {redownloading ? (
              <ActivityIndicator size="small" color="#fff" style={{ marginRight: 8 }} />
            ) : (
              <IconDownload size={16} color="#fff" />
            )}
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', marginLeft: 6 }}>
              {redownloading
                ? (t?.('media.redownloading') || 'Baixando...')
                : (t?.('media.redownload') || 'Baixar de novo')}
              {!redownloading && fileSize > 0 ? ` (${formatSize(fileSize)})` : ''}
            </Text>
          </TouchableOpacity>
        )}
      </View>
    );
  }
  const effectiveSource = redownloadedSource || source;
  // Use a stretched container — `s.mediaContainer` has `alignItems:'center'`
  // which collapses the WebView to its intrinsic width (0px) on iOS,
  // producing the dark/blank PDF screen the user reported. Override the
  // alignment so the WebView fills the modal.
  return (
    <View style={[s.mediaContainer, { alignItems: 'stretch', justifyContent: 'flex-start', width: '100%' }]}>
      <WebView
        source={effectiveSource}
        style={{ flex: 1, width: '100%', backgroundColor: '#fff' }}
        javaScriptEnabled
        domStorageEnabled
        startInLoadingState
        allowsInlineMediaPlayback
        bounces={false}
        // [2026-10-07 app-feel-webview] native scroll feel, no popups/glow.
        decelerationRate={0.998} /* [2026-10-11] número: "normal" (texto) derrubava o Android (RNCWebView espera Double) */
        overScrollMode="never"
        textZoom={100}
        setSupportMultipleWindows={false}
        allowsLinkPreview={false}
        originWhitelist={['*']}
        renderLoading={() => <ActivityIndicator size="large" color="#fff" style={s.loader} />}
        onHttpError={(e) => {
          const code = e?.nativeEvent?.statusCode;
          if (code && code >= 400) setErrored({ code, description: e?.nativeEvent?.description });
        }}
        onError={(e) => {
          setErrored({ code: 0, description: e?.nativeEvent?.description || 'load error' });
        }}
      />
    </View>
  );
}

// ============================================================
// GENERIC FILE VIEWER (download-only fallback)
// ============================================================
function GenericFileViewer({ url, filename, fileSize, messageId, t }) {
  const ext = getExt(filename);
  const [resolvedUrl, setResolvedUrl] = useState(url);
  const [redownloading, setRedownloading] = useState(false);
  const [redownloadDone, setRedownloadDone] = useState(false);
  const [redownloadFailed, setRedownloadFailed] = useState(null);
  // Fire a redownload when the user taps the secondary button — useful when
  // the file_url is stale and the original Linking.openURL would 404 in
  // Safari/Chrome. After it resolves, swap the download button's target URL.
  const handleRedownload = useCallback(async () => {
    if (!messageId || redownloading) return;
    setRedownloading(true);
    setRedownloadFailed(null);
    try {
      const { requestRedownload } = require('../services/mediaCache');
      const r = await requestRedownload(messageId, url);
      if (r?.ok && (r.localUri || r.url)) {
        setResolvedUrl(r.localUri || r.url);
        setRedownloadDone(true);
      } else {
        setRedownloadFailed({ deleted: !!r?.deleted, error: r?.error || 'unknown' });
      }
    } catch {
      setRedownloadFailed({ error: 'network' });
    } finally {
      setRedownloading(false);
    }
  }, [messageId, redownloading, url]);

  return (
    <View style={[s.mediaContainer, { justifyContent: 'center', alignItems: 'center' }]}>
      <View style={s.fileIcon}>
        <Text style={s.fileExtText}>{ext.toUpperCase()}</Text>
      </View>
      <Text style={s.fileNameText} numberOfLines={2}>{filename}</Text>
      {fileSize > 0 && <Text style={s.fileSizeText}>{formatSize(fileSize)}</Text>}
      <TouchableOpacity
        style={s.openExternalBtn}
        onPress={() => Linking.openURL(resolvedUrl).catch(() => {})}
        accessibilityLabel={t?.('files.download') || 'Baixar'}
        accessibilityRole="button"
      >
        <IconDownload size={18} color="#fff" />
        <Text style={s.openExternalText}>
          {t?.('mediaViewer.openOrDownload') || 'Abrir / Baixar'}
        </Text>
      </TouchableOpacity>
      {messageId ? (
        <TouchableOpacity
          onPress={handleRedownload}
          disabled={redownloading || redownloadFailed?.deleted}
          style={{
            marginTop: 12,
            paddingHorizontal: 14, paddingVertical: 8,
            borderRadius: 8, flexDirection: 'row', alignItems: 'center',
            opacity: redownloading ? 0.7 : 1,
          }}
          accessibilityLabel={t?.('media.redownload') || 'Baixar de novo'}
          accessibilityRole="button"
        >
          {redownloading && <ActivityIndicator size="small" color="#111111" style={{ marginRight: 8 }} />}
          <Text style={{ color: '#111111', fontSize: 13, fontWeight: '500' }}>
            {redownloadFailed?.deleted
              ? (t?.('media.messageDeleted') || 'Mensagem apagada')
              : redownloadDone
                ? (t?.('media.redownloaded') || 'Atualizado a partir do servidor')
                : redownloading
                  ? (t?.('media.redownloading') || 'Baixando...')
                  : (t?.('media.redownload') || 'Baixar de novo')}
          </Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

// The AI assistant (one@chatyy.ai, local-part "one") is branded "Bia". Map any
// derived sender label so the media viewer never shows the raw "one".
function isAssistantSender(name, email) {
  const lp = (email || '').split('@')[0].toLowerCase();
  return lp === 'one' || (name || '').trim().toLowerCase() === 'one';
}

// [2026-10-14 native-viewer] Founder: "o swipe passando de uma foto pro lado
// ainda está muito ruim, MUITO — coloca isso em NATIVO". iOS/Android abrem o
// visualizador NATIVO (modules/expo-media-viewer: UICollectionView + zoom
// UIScrollView / ViewPager2 + Matrix, vídeo AVPlayer / Media3) e este
// componente não renderiza o pager JS. Binário sem o módulo, web, view-once ou
// lista com documento → pager JS de sempre. Kill switch OTA/console:
// globalThis.__chatyy_native_viewer = false.
let _NV = null;
function _nativeViewer() {
  if (_NV !== null) return _NV || null;
  _NV = false;
  if (Platform.OS === 'ios' || Platform.OS === 'android') {
    try {
      const m = require('../modules/expo-media-viewer');
      if (m && typeof m.isAvailable === 'function' && m.isAvailable()) _NV = m;
    } catch {}
  }
  return _NV || null;
}
function _nvIsMedia(it) {
  if (!it || !it.fileUrl) return false;
  if (it.viewOnce || it.isViewOnce || it.is_view_once) return false;
  const e = getExt(it.fileName);
  return it.type === 'image' || it.type === 'video' || IMAGE_EXTS.includes(e) || VIDEO_EXTS.includes(e);
}
function _nvEligible(list, viewOnce, secure) {
  try { if (globalThis.__chatyy_native_viewer === false) return false; } catch {}
  if (viewOnce || !Array.isArray(list) || list.length === 0) return false;
  if (!_nativeViewer()) return false;
  // [2026-10-14 adv-privacy] Binário sem `secure` no viewer nativo (Dialog sem
  // FLAG_SECURE) → pager JS, que fica na janela protegida da Activity.
  if (secure) { try { if (!_nativeViewer().supportsSecure?.()) return false; } catch { return false; } }
  return list.every(_nvIsMedia);
}
function _nvDate(ts) {
  if (!ts) return '';
  try {
    let ms = typeof ts === 'number' ? (ts < 1e12 ? ts * 1000 : ts) : Date.parse(ts);
    if ((!ms || isNaN(ms)) && typeof ts === 'string') {
      let iso = ts.trim().replace(' ', 'T');
      if (!/([zZ]|[+-]\d\d:?\d\d)$/.test(iso)) iso += 'Z';
      ms = Date.parse(iso);
    }
    if (!ms || isNaN(ms)) return '';
    const d = new Date(ms);
    return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}
function _nvItems(list, ctx) {
  const single = list.length === 1;
  return list.map((it) => {
    const isVid = it.type === 'video' || VIDEO_EXTS.includes(getExt(it.fileName));
    const fu = String(it.fileUrl || '');
    const isLocalSrc = /^(file|content):\/\//.test(fu);
    let local = '';
    if (isLocalSrc) local = fu;
    else {
      const c = getFullUrl(fu);
      if (typeof c === 'string' && c.startsWith('file://')) local = c;
    }
    const mid = it.messageId != null ? it.messageId : (it.id != null ? it.id : (single ? ctx.messageId : null));
    if (!local && mid != null && mid !== 0) {
      try {
        const lp = require('../services/mediaCache').getLocalUriForMessage?.(mid);
        if (typeof lp === 'string' && lp) local = lp.startsWith('/') ? 'file://' + lp : lp;
      } catch {}
    }
    const remote = isLocalSrc ? '' : getFullUrl(fu, true);
    let uri = remote || local;
    // Vídeo: MP4 já no aparelho vence; senão HLS adaptativo (como o pager JS).
    if (isVid && it.hlsUrl && !local) uri = getFullUrl(it.hlsUrl, true);
    let th = it.thumbUri ? getFullUrl(it.thumbUri) : (it.placeholderUri || it.thumbB64Uri || '');
    if (!th && single) th = ctx.thumbUri ? getFullUrl(ctx.thumbUri) : (ctx.placeholderUri || '');
    const cap = String((it.caption != null ? it.caption : (single ? ctx.caption : '')) || '').trim();
    return {
      uri: uri || '',
      localUri: local || '',
      thumbUri: th || '',
      type: isVid ? 'video' : 'image',
      messageId: mid != null ? String(mid) : '',
      caption: cap,
      senderName: ctx.senderName || '',
      dateLabel: _nvDate(it.createdAt || it.created_at || ctx.createdAt),
      width: Number(it.width || it.videoWidth || 0) || 0,
      height: Number(it.height || it.videoHeight || 0) || 0,
    };
  });
}

// ============================================================
// MAIN MODAL
// ============================================================
// [2026-10-14 swipe-album] Página do álbum memoizada: trocar de página só
// re-renderiza as 2 páginas cujo isActive mudou (antes o extraData re-renderizava
// TODAS as páginas montadas + recalculava a URL — que virava file:// depois do
// cache e recarregava a foto vizinha no meio do swipe). URL congelada por item.
const _AlbumPage = memo(function _AlbumPage({ item, isActive, pageW, webH, conversationId, viewOnce, t, onDismissMove, onDismissEnd, dismissSV, onDismissStart, onZoomChange, onEdgeSwipe, onDoubleTap, onPageableChange }) {
  const fileUrl = item?.fileUrl;
  const u = useMemo(() => getFullUrl(fileUrl), [fileUrl]);
  const e = getExt(item?.fileName);
  const isImg = item?.type === 'image' || IMAGE_EXTS.includes(e);
  const isVid = item?.type === 'video' || VIDEO_EXTS.includes(e);
  const isPrv = PREVIEWABLE_EXTS.includes(e);
  return (
    // [2026-10-14 album-swipe] Web: a célula do VirtualizedList (row,
    // altura = conteúdo) deixava a página com 0 px → foto PRETA no
    // álbum. Altura explícita = altura medida do pager.
    <View style={Platform.OS === 'web' && webH > 0 ? { width: pageW, height: webH } : { width: pageW, flex: 1 }}>
      {isImg ? <ImageViewer url={u} messageId={item?.messageId || item?.id || 0} conversationId={conversationId} fileSize={item?.fileSize} createdAt={item?.createdAt || item?.created_at} t={t} placeholderUri={item?.placeholderUri || item?.thumbB64Uri} blurhash={item?.blurhash} thumbUri={item?.thumbUri} onDismissMove={onDismissMove} onDismissEnd={onDismissEnd} dismissSV={dismissSV} onDismissStart={onDismissStart} onZoomChange={onZoomChange} isActive={isActive} onEdgeSwipe={onEdgeSwipe} onDoubleTap={onDoubleTap} onPageableChange={onPageableChange} /> :
       isVid ? <VideoPlayer url={u} isActive={isActive} allowPip={!viewOnce} noCache={!!viewOnce} /> :
       isPrv ? <PreviewViewer url={u} filename={item?.fileName} messageId={item?.messageId || item?.id || 0} fileSize={item?.fileSize} t={t} /> :
       <GenericFileViewer url={u} filename={item?.fileName} fileSize={item?.fileSize} messageId={item?.messageId || item?.id || 0} t={t} />}
    </View>
  );
}, (a, b) => {
  // O chat-conversation remonta o mediaList (objetos novos) a cada render dele;
  // compara só os campos que a página usa.
  for (const k of ['isActive', 'pageW', 'webH', 'conversationId', 'viewOnce', 't', 'onDismissMove', 'onDismissEnd', 'dismissSV', 'onDismissStart', 'onZoomChange', 'onEdgeSwipe', 'onDoubleTap', 'onPageableChange']) {
    if (a[k] !== b[k]) return false;
  }
  const x = a.item || {};
  const y = b.item || {};
  if (x === y) return true;
  for (const k of ['fileUrl', 'fileName', 'type', 'messageId', 'id', 'fileSize', 'createdAt', 'created_at', 'placeholderUri', 'thumbB64Uri', 'blurhash', 'thumbUri']) {
    if (x[k] !== y[k]) return false;
  }
  return true;
});

export default function ChatMediaViewer({ visible, onClose, fileUrl, hlsUrl, fileName, fileSize, type, viewOnce, mediaList, initialIndex, conversationId, messageId, senderName, senderEmail, createdAt, caption, videoDuration, videoWidth, videoHeight, mimeType, onForward, t, colors, placeholderUri: _propPlaceholderUri, thumbUri: _propThumbUri, secure: _secureProp }) {
  const insets = useSafeAreaInsets();
  // [2026-10-14 adv-privacy] secure = prop OU flag da conversa (store). Protegido
  // (view-once ou privacidade avançada) → sem salvar/compartilhar/encaminhar/OCR.
  const _advPrivSt = useAdvancedPrivacy(conversationId);
  const _secure = !!_secureProp || !!_advPrivSt.enabled;
  const _locked = !!viewOnce || _secure;
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  // WAVE 60: WhatsApp/IG-grade viewer chrome. The ugly "IMG_1234.jpg 299KB"
  // header is gone — we now show sender avatar + name + relative time, and
  // tap on the photo toggles bars (parity with IG). The filename + bytes
  // moved into the info sheet (long-press More menu) so power users still
  // have access without the cellphone-camera-file-name being the first
  // thing the user sees.
  const [_chromeVisible, _setChromeVisible] = useState(true);
  const [_infoSheetOpen, _setInfoSheetOpen] = useState(false);
  const [_starred, _setStarred] = useState(false);
  // [2026-10-09 more-native] Texto da foto: null | { loading } | { text } | { empty }
  const [_ocr, _setOcr] = useState(null);
  const [_ocrCopied, _setOcrCopied] = useState(false);
  const [_sharing, _setSharing] = useState(false);
  const _chromeOpacity = useRef(new Animated.Value(1)).current;
  // Open animation (subtle scale-in behind the Modal's fade) + swipe-down
  // dismiss backdrop. _bgOpacity drives a full-black layer so a downward drag
  // reveals the chat underneath (WhatsApp/IG). _openScale gives the "no hard
  // cut" entrance the founder asked for ("quando abre foto").
  const _bgOpacity = useRef(new Animated.Value(1)).current;
  const _openScale = useRef(new Animated.Value(1)).current;
  const _onDismissMove = useCallback((dy) => {
    const p = Math.max(0, Math.min(1, dy / (SCREEN_H * 0.6)));
    _bgOpacity.setValue(1 - p * 0.92);
    // Fade chrome out as the drag grows (only if it was visible).
    _chromeOpacity.setValue(Math.max(0, 1 - dy / 90) * (_chromeVisible ? 1 : 0));
  }, [_bgOpacity, _chromeOpacity, _chromeVisible]);
  const _onDismissEnd = useCallback((dismiss) => {
    if (dismiss) {
      Animated.timing(_bgOpacity, { toValue: 0, duration: 160, useNativeDriver: true }).start(() => {
        try { onClose && onClose(); } catch {}
      });
    } else {
      Animated.spring(_bgOpacity, { toValue: 1, useNativeDriver: true, friction: 8, tension: 60 }).start();
      Animated.timing(_chromeOpacity, { toValue: _chromeVisible ? 1 : 0, duration: 160, useNativeDriver: true }).start();
    }
  }, [_bgOpacity, _chromeOpacity, _chromeVisible, onClose]);
  // [2026-10-08 photo-editor] Zoom/dispensar na UI thread: progresso do arrasto
  // (0..1) num shared value que esmaece o fundo sem passar pelo JS; ampliado →
  // paginação do FlatList desligada.
  const _dismissSV = _useMaybeSharedValue(0);
  const [_zoomed, _setZoomed] = useState(false);
  const _onZoomChange = useCallback((z) => { _setZoomed(!!z); }, []);
  // [2026-10-14 swipe-album] iOS: ampliada no MEIO da foto → pager travado
  // (o arrasto é só da foto); encostada na borda → pager liberado p/ o arrasto
  // p/ fora paginar (Fotos do iOS). Decidido na UI thread (UIZoomSurface).
  const [_pagerLocked, _setPagerLocked] = useState(false);
  const _onPageableChange = useCallback((p) => { _setPagerLocked(!p); }, []);
  const _onDismissStart = useCallback(() => {
    Animated.timing(_chromeOpacity, { toValue: 0, duration: 120, useNativeDriver: true }).start();
  }, [_chromeOpacity]);
  useEffect(() => {
    if (!visible) return;
    _setZoomed(false);
    _setPagerLocked(false);
    try { if (_dismissSV) _dismissSV.set(0); } catch {}
  }, [visible, _dismissSV]);
  const _toggleChrome = useCallback(() => {
    _setChromeVisible(v => {
      const next = !v;
      Animated.timing(_chromeOpacity, {
        toValue: next ? 1 : 0,
        duration: 220,
        useNativeDriver: true,
      }).start();
      return next;
    });
  }, [_chromeOpacity]);
  // [2026-10-14 swipe-album] Toque simples mostra/esconde a barra; no nativo
  // espera a janela do duplo toque (260 ms) — antes o 1º toque do duplo-toque-
  // pra-zoom também piscava a barra.
  const _chromeTapTimer = useRef(null);
  const _dblTapAt = useRef(0);
  const _onBackdropPress = useCallback(() => {
    if (!_UI_ZOOM) { _toggleChrome(); return; }
    if (Date.now() - _dblTapAt.current < 400) return; // 2º toque do duplo toque
    if (_chromeTapTimer.current) clearTimeout(_chromeTapTimer.current);
    _chromeTapTimer.current = setTimeout(() => { _chromeTapTimer.current = null; _toggleChrome(); }, 280);
  }, [_toggleChrome]);
  const _onDoubleTap = useCallback(() => {
    _dblTapAt.current = Date.now();
    if (_chromeTapTimer.current) { clearTimeout(_chromeTapTimer.current); _chromeTapTimer.current = null; }
  }, []);
  useEffect(() => () => { if (_chromeTapTimer.current) clearTimeout(_chromeTapTimer.current); }, []);
  // Reset chrome to visible whenever a new media is opened so the user
  // doesn't open a fresh image and find a bare black screen.
  useEffect(() => {
    if (!visible) return;
    _setChromeVisible(true);
    _setInfoSheetOpen(false);
    _chromeOpacity.setValue(1);
    _bgOpacity.setValue(1);
    _openScale.setValue(0.96);
    Animated.spring(_openScale, { toValue: 1, useNativeDriver: true, friction: 7, tension: 70 }).start();
  }, [visible, _chromeOpacity, _bgOpacity, _openScale]);

  // Build the effective array. When the caller passes mediaList we render
  // FlatList horizontal with paging + neighbor preload (Instagram pattern).
  // Otherwise fall back to the single-item view (existing behavior preserved).
  const _list = (Array.isArray(mediaList) && mediaList.length > 0)
    ? mediaList
    : (visible ? [{ fileUrl, hlsUrl, fileName, fileSize, type }] : []);
  // [2026-10-14 native-viewer] Sessão nativa aberta → fica nativo até fechar
  // (mesmo se a lista mudar no meio).
  const _nvSessionRef = useRef(0);
  const [_nvFailed, _setNvFailed] = useState(false);
  const _nvOn = !!visible && !_nvFailed && (_nvSessionRef.current !== 0 || _nvEligible(_list, viewOnce, _secure));
  const _initialLive = Math.max(0, Math.min(_list.length - 1, Number(initialIndex) || 0));
  // [2026-10-14 swipe-album] Índice inicial CONGELADO por abertura. O
  // chat-conversation recalcula mediaList/initialIndex a cada render dele (upload
  // terminando, id temp→real, álbum reagrupado); se o initialIndex mudava com o
  // viewer aberto, o efeito abaixo devolvia o contador à foto tocada ("volta pra
  // página original").
  const _initRef = useRef(null);
  if (!visible) _initRef.current = null;
  else if (_initRef.current === null) _initRef.current = _initialLive;
  const _initial = _initRef.current !== null ? Math.min(_initRef.current, Math.max(0, _list.length - 1)) : _initialLive;
  const _initOffsetRef = useRef(null);
  if (!visible) _initOffsetRef.current = null;
  else if (_initOffsetRef.current === null) _initOffsetRef.current = { x: _initial * SCREEN_W, y: 0 };
  const [_currentIdx, _setCurrentIdx] = useState(_initial);
  // Reset on every open so reopening from a different index doesn't restore
  // the previous viewer position.
  useEffect(() => { if (visible) _setCurrentIdx(_initial); }, [visible, _initial]);

  // [2026-10-14 native-viewer] Abre/fecha o viewer nativo; ações voltam por
  // evento e reaproveitam os handlers deste componente (salvar na galeria,
  // compartilhar arquivo, encaminhar).
  const _nvSubsRef = useRef([]);
  const _nvActRef = useRef(null);
  const _nvCtxRef = useRef(null);
  _nvCtxRef.current = {
    list: _list, onClose, onForward, t, messageId, caption, createdAt, secure: _secure,
    placeholderUri: _propPlaceholderUri, thumbUri: _propThumbUri,
    senderName: isAssistantSender(senderName, senderEmail) ? 'Bia' : (senderName || (senderEmail || '').split('@')[0] || ''),
  };
  const _nvCleanup = useCallback(() => {
    for (const sub of _nvSubsRef.current) { try { sub.remove(); } catch {} }
    _nvSubsRef.current = [];
  }, []);
  const _nvOnAction = useCallback(async (e) => {
    const NV = _nativeViewer();
    const ctx = _nvCtxRef.current || {};
    const list = ctx.list || [];
    const it = list[e?.index] || list[0];
    if (!NV || !it) return;
    if (e.action === 'share') {
      NV.setActionState('share', 'busy');
      try { await shareMediaFile({ url: getFullUrl(it.fileUrl), fileName: it.fileName }); } catch {}
      NV.setActionState('share', 'idle');
    } else if (e.action === 'save') {
      NV.setActionState('save', 'busy');
      let ok = false;
      try {
        const fn = _nvActRef.current && _nvActRef.current.save;
        if (fn) ok = !!(await fn({ url: getFullUrl(it.fileUrl), active: it, fileName: it.fileName }));
      } catch {}
      NV.setActionState('save', ok ? 'done' : 'idle');
    } else if (e.action === 'forward') {
      try { if (typeof ctx.onForward === 'function') ctx.onForward(it); } catch {}
    } else if (e.action === 'star') {
      _setStarred(!!e.starred);
      try { require('expo-haptics').selectionAsync?.(); } catch {}
    }
  }, []);
  useEffect(() => {
    const NV = _nativeViewer();
    if (!visible) {
      if (_nvSessionRef.current !== 0) {
        _nvSessionRef.current = 0;
        _nvCleanup();
        if (NV) NV.close();
      }
      if (_nvFailed) _setNvFailed(false);
      return undefined;
    }
    if (!_nvOn || !NV || _nvSessionRef.current !== 0) return undefined;
    _nvSessionRef.current = -1; // abrindo
    const ctx = _nvCtxRef.current || {};
    const _tt = (k) => {
      try {
        const v = typeof ctx.t === 'function' ? ctx.t(k) : '';
        return typeof v === 'string' && v && v !== k ? v : undefined;
      } catch { return undefined; }
    };
    const items = _nvItems(ctx.list || [], ctx);
    const _same = (e) => !!e && _nvSessionRef.current > 0 && e.session === _nvSessionRef.current;
    _nvCleanup();
    _nvSubsRef.current = [
      NV.addListener('onIndexChange', (e) => {
        if (_same(e) && typeof e.index === 'number') _setCurrentIdx(e.index);
      }),
      NV.addListener('onAction', (e) => { if (_same(e)) _nvOnAction(e); }),
      NV.addListener('onClose', (e) => {
        if (!_same(e)) return;
        _nvSessionRef.current = 0;
        _nvCleanup();
        try { const c = _nvCtxRef.current; if (c && typeof c.onClose === 'function') c.onClose(); } catch {}
      }),
    ];
    try { Keyboard.dismiss(); } catch {}
    NV.open({
      items,
      index: _initial,
      labels: {
        close: _tt('nativeViewer.close'),
        share: _tt('nativeViewer.share'),
        save: _tt('nativeViewer.save'),
        forward: _tt('nativeViewer.forward'),
        star: _tt('nativeViewer.star'),
        unstar: _tt('nativeViewer.unstar'),
        play: _tt('nativeViewer.play'),
        pause: _tt('nativeViewer.pause'),
        loadFailed: _tt('nativeViewer.loadFailed'),
        retry: _tt('nativeViewer.retry'),
        protected: _tt('advPriv.protectedTitle'),
      },
      allowShare: !ctx.secure,
      allowSave: !ctx.secure,
      allowForward: !ctx.secure && typeof ctx.onForward === 'function',
      allowStar: true,
      secure: !!ctx.secure,
    }).then((sid) => {
      if (sid > 0) {
        if (_nvSessionRef.current === -1) _nvSessionRef.current = sid;
        else NV.close(); // fechado enquanto abria
      } else if (_nvSessionRef.current === -1) {
        // Não abriu (sem Activity/VC): cai no pager JS.
        _nvSessionRef.current = 0;
        _nvCleanup();
        _setNvFailed(true);
      }
    });
    return undefined;
  }, [visible, _nvOn]);
  useEffect(() => () => {
    if (_nvSessionRef.current !== 0) {
      _nvSessionRef.current = 0;
      _nvCleanup();
      try { _nativeViewer()?.close(); } catch {}
    }
  }, [_nvCleanup]);
  // [2026-10-14 album-swipe] Pager do álbum: ref p/ as setas do web + índice
  // pelo onScroll no web (RNW não emite onMomentumScrollEnd).
  const _pagerRef = useRef(null);
  const [_webPagerH, _setWebPagerH] = useState(0);
  const _idxRef = useRef(_initial);
  _idxRef.current = _currentIdx;
  // [2026-10-14 swipe-album] Largura REAL da página = largura medida do pager
  // (antes: SCREEN_W de quando o módulo carregou; se a janela difere, o
  // pagingEnabled do UIScrollView pagina pela largura do bounds e a página
  // "parava no meio"). getItemLayout/offsets/índice usam esta largura.
  const [_pageW, _setPageW] = useState(SCREEN_W);
  const _pageWRef = useRef(SCREEN_W);
  _pageWRef.current = _pageW;
  const _onWebPagerScroll = useCallback((e) => {
    const x = e?.nativeEvent?.contentOffset?.x;
    const w = _pageWRef.current;
    if (typeof x !== 'number' || !(w > 0)) return;
    const i = Math.round(x / w);
    if (i >= 0 && i !== _idxRef.current) _setCurrentIdx(i);
  }, []);
  // Fim do swipe (nativo): índice pela posição final. onScrollEndDrag cobre o
  // caso sem momentum (soltou exatamente alinhado → iOS não emite momentum).
  const _settleFromOffset = useCallback((e, requireAligned) => {
    const x = e?.nativeEvent?.contentOffset?.x;
    const w = _pageWRef.current;
    if (typeof x !== 'number' || !(w > 0)) return;
    const i = Math.round(x / w);
    if (requireAligned && Math.abs(x - i * w) > 1) return;
    const n = Array.isArray(mediaList) ? mediaList.length : 0;
    if (i >= 0 && (n === 0 || i < n) && i !== _idxRef.current) _setCurrentIdx(i);
  }, [mediaList]);
  const _goToPage = useCallback((i) => {
    const n = Array.isArray(mediaList) ? mediaList.length : 0;
    if (!(n > 1) || i < 0 || i >= n) return;
    try { _pagerRef.current?.scrollToIndex?.({ index: i, animated: true }); } catch {
      try { _pagerRef.current?.scrollToOffset?.({ offset: i * _pageWRef.current, animated: true }); } catch {}
    }
    _setCurrentIdx(i);
  }, [mediaList]);
  // [2026-10-14 swipe-album] Web: o scroll-snap "x mandatory" do RNW deixava um
  // flick longo no touch pular VÁRIAS fotos (medido: 2→5 num arraste rápido).
  // scroll-snap-stop: always nas células = 1 página por gesto, como no nativo.
  useEffect(() => {
    if (Platform.OS !== 'web' || typeof document === 'undefined') return;
    try {
      if (document.getElementById('chatyy-pager-snapstop')) return;
      const st = document.createElement('style');
      st.id = 'chatyy-pager-snapstop';
      st.textContent = '[data-chatyy-pager] > div > div { scroll-snap-stop: always; }';
      document.head.appendChild(st);
    } catch {}
  }, []);
  // Ampliado e soltou puxando além da borda → página vizinha (Fotos do iOS).
  const _onEdgeSwipe = useCallback((dir) => { _goToPage(_idxRef.current + (dir > 0 ? 1 : -1)); }, [_goToPage]);
  const _onPagerLayout = useCallback((e) => {
    const w = e?.nativeEvent?.layout?.width || 0;
    const h = Math.round(e?.nativeEvent?.layout?.height || 0);
    if (w > 0 && Math.abs(w - _pageWRef.current) > 0.5) {
      _pageWRef.current = w;
      _setPageW(w);
      // realinha na página atual com a largura nova (sem animação)
      const i = _idxRef.current;
      requestAnimationFrame(() => { try { _pagerRef.current?.scrollToOffset?.({ offset: i * w, animated: false }); } catch {} });
    }
    if (Platform.OS === 'web' && h > 0) _setWebPagerH((old) => (old === h ? old : h));
  }, []);
  useEffect(() => {
    if (Platform.OS !== 'web' || !visible || !(Array.isArray(mediaList) && mediaList.length > 1) || typeof document === 'undefined') return undefined;
    const onKey = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      const cur = mediaList[_idxRef.current];
      if (cur && cur.type === 'video') return; // ← → do vídeo = avançar/voltar 5 s
      e.preventDefault?.();
      _goToPage(_idxRef.current + (e.key === 'ArrowRight' ? 1 : -1));
    };
    document.addEventListener?.('keydown', onKey);
    return () => document.removeEventListener?.('keydown', onKey);
  }, [visible, mediaList, _goToPage]);

  // Block screenshots / screen recording while a view-once media is on
  // screen. Android: FLAG_SECURE makes thumbnails + screen recordings show
  // black frames. iOS: prevent-flag is a no-op (Apple won't expose it),
  // but we still register a screenshot listener so we can render a
  // watermark overlay (user email + timestamp) — anyone who screenshots
  // captures the overlay and is identifiable. Cleanup releases the flag
  // on unmount so other screens (gallery, etc.) stay screenshottable.
  const [_watermarkVisible, _setWatermarkVisible] = useState(false);
  // [2026-10-14 adv-privacy] Visualizador protegido aberto: Android FLAG_SECURE
  // (pager JS) e iOS escudo durante gravação/espelhamento. O aviso de print da
  // conversa vem do useConversationPrivacy (tela de baixo continua em foco).
  useEffect(() => {
    if (!visible || !_locked || Platform.OS === 'web') return undefined;
    return acquireCaptureProtection('chatyy-viewer-protected', {
      labels: {
        title: (typeof t === 'function' && t('advPriv.protectedTitle')) || 'Conteúdo protegido',
        subtitle: (typeof t === 'function' && t('advPriv.protectedRecording')) || '',
      },
    });
  }, [visible, _locked]);
  const [_currentUserEmail, _setCurrentUserEmail] = useState('');
  useEffect(() => {
    if (!visible || !viewOnce || !ScreenCapture) return;
    // Resolve current user email lazily so the import stays optional.
    try {
      const auth = require('../context/AuthContext');
      // Hooks can't run here — we read straight from SecureStore mirror.
      const SecureStore = require('expo-secure-store');
      SecureStore.getItemAsync?.('current_user_email').then((e) => {
        if (e) _setCurrentUserEmail(String(e));
      }).catch(() => {});
    } catch {}
    let sub;
    (async () => {
      try { await ScreenCapture.preventScreenCaptureAsync('chatyy-view-once'); } catch {}
      try {
        sub = ScreenCapture.addScreenshotListener?.(() => {
          // Make the watermark immediately visible so the *next* attempt
          // (or a screen recording running in parallel) captures it. We
          // also keep it on for a few seconds in case the user tries
          // again. The watermark is the recipient's own email — the
          // sender doesn't see it on their side because they're never
          // marked as "viewing" their own view-once media.
          _setWatermarkVisible(true);
          setTimeout(() => _setWatermarkVisible(false), 6000);
          // Notify the peer that this user just took a screenshot. Backend
          // (chat.php case 'chat_screenshot_event') inserts a system msg
          // with subtype='screenshot' and emits a WS event so both sides
          // see the system bubble in real time. Fire-and-forget — if the
          // backend hasn't shipped yet this 400s silently and the local
          // watermark UX still works.
          if (conversationId) {
            try { globalThis.__chatyy_vo_shot_at = Date.now(); } catch {} // [2026-10-14 adv-privacy] sem aviso duplo
            try {
              const api = require('../services/api');
              api.apiCall?.('chat_screenshot_event', {
                conversation_id: conversationId,
                message_id: messageId || 0,
              }, 'POST').catch(() => {});
            } catch {}
          }
        });
      } catch {}
    })();
    return () => {
      try { sub?.remove?.(); } catch {}
      try { ScreenCapture.allowScreenCaptureAsync?.('chatyy-view-once')?.catch?.(() => {}); } catch {}
      _setWatermarkVisible(false);
    };
  }, [visible, viewOnce]);

  // Preload neighbors so swipe between is instant. Image.prefetch on RN +
  // ExpoImage.prefetch when available.
  useEffect(() => {
    if (!visible || _list.length < 2 || _nvOn) return;
    const neighbors = [];
    if (_currentIdx + 1 < _list.length) neighbors.push(_list[_currentIdx + 1]);
    if (_currentIdx - 1 >= 0) neighbors.push(_list[_currentIdx - 1]);
    for (const n of neighbors) {
      if (!n?.fileUrl) continue;
      const u = getFullUrl(n.fileUrl);
      const isImg = n.type === 'image' || IMAGE_EXTS.includes(getExt(n.fileName));
      if (!isImg) continue;
      // [2026-10-10 native-audit] Native: ONLY expo-image (the viewer renders
      // with expo-image, cachePolicy memory-disk). RN Image.prefetch filled a
      // SEPARATE cache (NSURLCache / Fresco) → every neighbor photo was
      // downloaded twice. RN prefetch kept only as the no-expo-image fallback.
      let _ei = null;
      try { _ei = require('expo-image').Image; } catch {}
      if (Platform.OS !== 'web' && _ei?.prefetch) {
        try { const _r = _ei.prefetch(u, 'memory-disk'); if (_r?.catch) _r.catch(() => {}); } catch {}
      } else {
        try { Image.prefetch?.(u); } catch {}
        try { _ei?.prefetch?.(u); } catch {}
      }
    }
  }, [visible, _currentIdx, _list, _nvOn]);

  // HLS offline manifest resolution. When the active item is a video AND we
  // have a previously-downloaded m3u8 sitting at
  // `documentDirectory/video-offline/<messageId>/index.m3u8`, swap the player
  // source to that local file:// URI. Without this, an offline user sees
  // VideoPlayer spin forever because expo-video can't fetch the manifest
  // tree off the network. _hlsLocalUri === '' means "no cache available";
  // null means "haven't checked yet" (player keeps streaming URL).
  // _hlsOffline = true when device is offline AND no cache exists → render
  // the "Vídeo não disponível offline" message instead of mounting the
  // player at all.
  const [_hlsLocalUri, _setHlsLocalUri] = useState(null);
  const [_hlsOfflineUnavailable, _setHlsOfflineUnavailable] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web' || !visible) {
      _setHlsLocalUri(null);
      _setHlsOfflineUnavailable(false);
      return;
    }
    const it = _list[_currentIdx];
    if (!it) return;
    const itType = it.type;
    const itHls = it.hlsUrl;
    const itFileUrl = it.fileUrl;
    if (itType !== 'video') {
      _setHlsLocalUri(null);
      _setHlsOfflineUnavailable(false);
      return;
    }
    // Pick a stable video id — the message id is what cacheHlsVideo uses.
    const vidId = it.messageId || it.id || messageId;
    if (!vidId) {
      _setHlsLocalUri('');
      _setHlsOfflineUnavailable(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const hlsMod = require('../services/hlsOffline');
        const local = await hlsMod.getLocalManifest?.(String(vidId));
        if (cancelled) return;
        if (local) {
          // Normalize to a file:// URI — expo-video wants the scheme.
          _setHlsLocalUri(local.startsWith('file://') ? local : 'file://' + local);
          _setHlsOfflineUnavailable(false);
          return;
        }
        _setHlsLocalUri('');
        // No cache. If we're also offline, surface "not available offline"
        // rather than letting the player spin on a dead URL. HLS manifests
        // resolved via .m3u8 will never paint without the network.
        const isHlsSource = (itHls && String(itHls).toLowerCase().includes('.m3u8'))
          || (itFileUrl && String(itFileUrl).toLowerCase().includes('.m3u8'));
        if (!isHlsSource) {
          // mp4 path — VideoPlayer + getFullUrl already handle file:// cache.
          _setHlsOfflineUnavailable(false);
          return;
        }
        try {
          const ni = require('../services/networkInfo');
          const t = ni.getNetworkType?.();
          _setHlsOfflineUnavailable(t === 'none');
        } catch {
          _setHlsOfflineUnavailable(false);
        }
      } catch {
        if (!cancelled) {
          _setHlsLocalUri('');
          _setHlsOfflineUnavailable(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [visible, _currentIdx, _list, messageId]);

  // OFFLINE-FIRST: when the viewer opens, force a disk cache for the active
  // item. The user's tap = explicit intent → bypass the cellular gate so
  // video/document downloads happen even when policy says wifi-only. Once
  // cached, future opens read from disk and survive network drops.
  useEffect(() => {
    if (!visible || Platform.OS === 'web') return;
    // view-once must never be persisted to the disk cache (it would survive
    // the one-time view and be re-openable from the cache).
    if (viewOnce) return;
    const it = _list[_currentIdx];
    if (!it?.fileUrl) return;
    if (it.viewOnce || it.isViewOnce || it.is_view_once) return;
    // Skip if already a local URI (outbox / just-saved).
    if (it.fileUrl.startsWith('file://') || it.fileUrl.startsWith('content://')) return;
    // CRITICAL (2026-05-19 #2): use api.getMediaUrl so the cache-write key
    // matches the cache-read key in getFullUrl(). Previously hardcoded
    // `https://chatyy.com.br${url}` which hashed under a DIFFERENT key
    // (different hostname) than the Image source above (which is
    // media.chatyy.com.br via getMediaUrl). Result: this useEffect was
    // downloading a SECOND copy of every photo under a key that nobody else
    // ever looks up, while the cache lookup in getFullUrl kept missing → user
    // saw "Mídia removida do cache" even though we technically had the file
    // on disk under the wrong key.
    let absolute;
    try {
      const _api = require('../services/api');
      absolute = _api?.getMediaUrl ? _api.getMediaUrl(it.fileUrl)
        : (it.fileUrl.startsWith('http') ? it.fileUrl : `https://chatyy.com.br${it.fileUrl}`);
    } catch {
      absolute = it.fileUrl.startsWith('http') ? it.fileUrl : `https://chatyy.com.br${it.fileUrl}`;
    }
    try {
      const mediaCache = require('../services/mediaCache');
      const { getLocalUriIfCached } = mediaCache;
      if (getLocalUriIfCached(absolute)) return; // already cached
      // [offline persist 2026-10-04] Media the user actually OPENS is media
      // they care about — persist it to the PERMANENT dir (documentDirectory)
      // via saveMediaPermanent instead of the OS-purgeable cacheDirectory that
      // plain cacheMedia uses for non-Keep-Always conversations. This is the
      // WhatsApp guarantee: a photo/video you viewed survives iOS cache purges
      // and the LRU sweep, so it's always there offline. Bounded by what the
      // user opens (not the full history). view-once is already excluded above.
      const _mid = (it && (it.messageId ?? it.message_id)) ?? messageId ?? null;
      mediaCache.saveMediaPermanent(absolute, {
        conversationId: conversationId != null ? conversationId : undefined,
        // [2026-10-08 media-local-store] → media/<conta>/<conv>/<msgId>.<ext>
        messageId: _mid != null ? _mid : undefined,
      }).then((local) => {
        // Best-effort: write the local file path back into SQLite so a cold
        // open resolves from disk without waiting on the in-memory syncIndex.
        try {
          const localFileUri = (typeof local === 'string' && local)
            ? (local.startsWith('file://') ? local : (local.startsWith('/') ? `file://${local}` : null))
            : null;
          if (localFileUri && _mid != null && conversationId != null) {
            const nativeDb = require('../services/db');
            nativeDb.dbUpdateMessageFields?.(conversationId, _mid, { local_path: localFileUri });
          }
        } catch {}
      }).catch(() => {});
    } catch {}
  }, [visible, _currentIdx, _list, conversationId, viewOnce, messageId]);

  if (!visible) return null;

  const _active = _list[_currentIdx] || _list[0];
  // Privacy belt-and-suspenders: when the active item has no fileUrl (most
  // common shape for a deleted msg after the per-bubble strip), the viewer
  // has nothing to display. Auto-close instead of rendering a blank/
  // last-frame placeholder that could surface a still-cached image. The
  // viewOnce flow still opens with an empty URL intentionally (the pill
  // owns its own loading state) so we leave that path untouched.
  if (!viewOnce && (!_active || !_active.fileUrl)) {
    // useEffect can't be added below an early return — invoke onClose via
    // microtask so React unwinds cleanly without dropping a "setState in
    // render" warning.
    try { Promise.resolve().then(() => onClose && onClose()); } catch {}
    return null;
  }

  // Prefer HLS playlist for videos when available (chunk-streamed, <500ms
  // first frame). Falls back to the progressive mp4 fileUrl when HLS isn't
  // generated yet (transcode is async during chat_send).
  //
  // OFFLINE WIN: when hlsOffline.getLocalManifest() returned a file:// URI
  // (resolved in the effect above), substitute it for the streaming URL so
  // expo-video reads the rewritten manifest + .ts segments off disk. This is
  // the user-visible fix for "video bubble spins forever on a dropped wifi".
  // [2026-10-11 video-fullhd] The chat HLS is now an adaptive ladder (master
  // playlist → 1080p/720p/480p): AVPlayer / ExoPlayer pick the best rendition
  // the network allows and switch mid-play. Web: <video> only plays HLS
  // natively on Safari — Chrome/Firefox/Edge would show a dead player, so they
  // keep the progressive MP4.
  const _webHlsOk = Platform.OS !== 'web' || _canPlayHlsNatively();
  // [2026-10-14 offline-media] MP4 já baixado no aparelho vence o HLS remoto
  // (antes, sem manifesto HLS offline, o vídeo salvo NÃO abria em modo avião).
  const _mp4Url = getFullUrl(_active?.fileUrl);
  const _mp4Local = typeof _mp4Url === 'string' && _mp4Url.startsWith('file://');
  let url = (_active?.type === 'video' && _active?.hlsUrl && _webHlsOk && !_mp4Local)
    ? getFullUrl(_active.hlsUrl)
    : _mp4Url;
  if (_active?.type === 'video' && _hlsLocalUri && typeof _hlsLocalUri === 'string'
      && _hlsLocalUri.startsWith('file://')) {
    url = _hlsLocalUri;
  }
  const ext = getExt(_active?.fileName);
  const isImage = _active?.type === 'image' || IMAGE_EXTS.includes(ext);
  const isVideo = _active?.type === 'video' || VIDEO_EXTS.includes(ext);
  const isPreviewable = PREVIEWABLE_EXTS.includes(ext);
  const _activeFileName = _active?.fileName;
  const _activeFileSize = _active?.fileSize;
  // media_kind tagging (set by the backup pipeline via photos_set_media_kind).
  // Used to surface a small "LIVE" / "BURST" / "SLO-MO" / "RAW" badge so
  // recipients know the format up front. Falls back to no badge when unset.
  const _activeMediaKind = _active?.mediaKind || _active?.media_kind || null;
  const _multi = _list.length > 1;
  // Caption shown over the bottom chrome (WhatsApp/IG). Per-item in an album,
  // falls back to the single-item prop. Empty string → nothing renders.
  const _activeCaption = String((_active?.caption != null ? _active.caption : caption) || '').trim();

  // [2026-10-14 native-viewer] _ovr = item vindo do viewer nativo ({ url,
  // active, fileName }); devolve true quando salvou.
  const handleDownload = async (_ovr) => {
    if (viewOnce) return false;
    const _dlUrl = (_ovr && _ovr.url) || url;
    const _dlActive = (_ovr && _ovr.active) || _active;
    const _dlName = (_ovr && _ovr.fileName) || fileName;
    let _dlOk = false;
    if (Platform.OS === 'web') {
      // Stream as blob to avoid opening media.chatyy in a new tab
      try {
        setSaving(true);
        const res = await fetch(_dlUrl, { credentials: 'include' });
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = blobUrl;
        link.download = _dlName || 'download';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch {
        // Fallback (still in same tab)
        window.location.href = _dlUrl;
      } finally {
        setSaving(false);
      }
    } else {
      // Save to device gallery (like WhatsApp)
      try {
        setSaving(true);
        const ML = require('expo-media-library');
        const perm = await ML.requestPermissionsAsync(true); // true = write access
        if (perm.status !== 'granted' && perm.accessPrivileges !== 'all') {
          // [2026-10-06 UX2] i18n (t is an optional prop in this viewer)
          Alert.alert(
            (typeof t === 'function' && t('common.permission')) || 'Permissão necessária',
            (typeof t === 'function' && t('viewer.photosPermissionHint')) || 'Vá em Ajustes > Chatyy > Fotos e selecione "Todas as fotos".',
          );
          setSaving(false);
          return;
        }
        // SDK 55 moved the download API; the legacy shim still exposes
        // downloadAsync + copyAsync + deleteAsync which is all we need here.
        let FS;
        try { FS = require('expo-file-system/legacy'); } catch { FS = require('expo-file-system'); }

        let sourceUri = _dlUrl;

        // [WAVE 81 2026-05-21] file:// existence guard. User report iOS:
        //   "ao salvar the file ahsgvg.jpg could not be opened because
        //    there is no such file"
        // Root cause: url here resolves via getFullUrl(_dlActive.fileUrl) which
        // can return a stale file:// path when the chat-conversation row
        // passed `fullUri` (msg._localUri or imgLocalPath) and the underlying
        // file was evicted by iOS or deleted from chat-media-saved/. The
        // iOS PHPhotoLibrary errors include the missing filename literally —
        // sanitize-recover instead of bubbling the cryptic error.
        if (sourceUri.startsWith('file://')) {
          try {
            const info = await FS.getInfoAsync(sourceUri);
            if (!info?.exists) {
              // Local gone — fall back to remote URL on the active item.
              const remote = _dlActive?.fileUrl
                ? (_dlActive.fileUrl.startsWith('http')
                    ? _dlActive.fileUrl
                    : `https://chatyy.com.br${_dlActive.fileUrl}`)
                : null;
              if (remote) sourceUri = remote;
            }
          } catch {
            // getInfoAsync threw — fall back to remote if we have one.
            const remote = _dlActive?.fileUrl
              ? (_dlActive.fileUrl.startsWith('http')
                  ? _dlActive.fileUrl
                  : `https://chatyy.com.br${_dlActive.fileUrl}`)
              : null;
            if (remote) sourceUri = remote;
          }
        }

        // If the URL is already a local file:// (from mediaCache), skip the
        // download step entirely — FS.downloadAsync of a file:// URL fails
        // with "unsupported scheme" on iOS.
        if (!sourceUri.startsWith('file://')) {
          // [WAVE 81 2026-05-21] Derive ext from URL only, never from the
          // user-supplied fileName. Sanitize fileName-derived ext to safe
          // alphanumeric. iOS rejects/echos user filenames containing weird
          // chars in PHPhotoLibrary error messages ("ahsgvg.jpg" came from
          // a user-typed name on send).
          const urlExt = sourceUri.match(/\.(png|jpe?g|gif|webp|heic|heif|mp4|mov|m4v|webm)(\?|$)/i)?.[1];
          const nameExt = (_dlName || '').split('?')[0].split('.').pop();
          const safeExt = (urlExt || (nameExt && /^[a-zA-Z0-9]{2,5}$/.test(nameExt) ? nameExt : 'jpg')).toLowerCase();
          const tempPath = FS.cacheDirectory + 'chatyy_save_' + Date.now() + '.' + safeExt;
          const download = await FS.downloadAsync(sourceUri, tempPath);
          if (!download?.uri || (download.status && download.status >= 400)) {
            Alert.alert(t?.('common.error') || 'Erro', t?.('mediaViewer.downloadFailedStatus', { status: download?.status || '?' }) || `Download falhou (status ${download?.status || '?'}).`);
            setSaving(false);
            return;
          }
          sourceUri = download.uri;
        }

        // [WAVE 81 2026-05-21] Sanity-check the final source path exists.
        // Without this, ML.createAssetAsync/saveToLibraryAsync surface the
        // cryptic "could not be opened because there is no such file" error
        // with the user-typed filename ("ahsgvg.jpg") — confusing UX.
        try {
          const fc = await FS.getInfoAsync(sourceUri);
          if (!fc?.exists) {
            Alert.alert(t?.('mediaViewer.saveErrorTitle') || 'Erro ao salvar', t?.('mediaViewer.fileUnavailableSave') || 'Arquivo não disponível. Tente abrir a imagem e salvar novamente.');
            setSaving(false);
            return;
          }
        } catch { /* getInfoAsync may throw on some URIs; fall through */ }

        // [WAVE 91 2026-05-21] Save to gallery — robust pipeline. Previous
        // implementation flipped setSaved(true) on createAssetAsync success
        // but the asset wasn't guaranteed to surface in the user's gallery
        // app (Android 10+ MediaStore can write to an invisible private
        // bucket; iOS limited-access can create the PHAsset off the main
        // library album). User report: "diz que salvou mas não aparece em
        // /Photos/Camera Roll". Fix:
        //   1. createAssetAsync → guarantees PHAsset (iOS) / MediaStore row.
        //   2. Verify the returned asset has a valid id BEFORE flipping
        //      saved=true. Without id the call silently no-ops.
        //   3. Move into a "Chatyy" album so the photo is discoverable in
        //      Photos > Albums (iOS) / Gallery > Chatyy (Android).
        //   4. Surface real errors instead of swallowing them.
        let ok = false;
        let savedAsset = null;
        try {
          // [WAVE 91] getInfoAsync(file://) right before save — last-line
          // defense against file disappearing between download and save.
          if (sourceUri.startsWith('file://')) {
            const info = await FS.getInfoAsync(sourceUri);
            if (!info?.exists || (info.size !== undefined && info.size === 0)) {
              throw new Error('source_missing_or_empty');
            }
          }
          const asset = await ML.createAssetAsync(sourceUri);
          if (asset && asset.id) {
            savedAsset = asset;
            ok = true;
          } else {
            // createAssetAsync resolved but didn't return a valid id — that
            // means the file system call succeeded but the MediaStore /
            // PHPhotoLibrary insertion didn't take. Fall through to
            // saveToLibraryAsync as a last attempt.
            throw new Error('asset_id_missing');
          }
        } catch (saveErr) {
          try {
            // saveToLibraryAsync returns void on iOS (and undefined on
            // Android); we treat resolution-without-throw as success.
            await ML.saveToLibraryAsync(sourceUri);
            ok = true;
          } catch (saveErr2) {
            // [WAVE 81 2026-05-21] Strip the iOS-supplied filename from the
            // error message so users don't see weird names like "ahsgvg.jpg"
            // in their own UI — surface a clean friendly message instead.
            const rawMsg = String(saveErr2?.message || saveErr?.message || '');
            const cleanMsg = /no such file|could not be opened/i.test(rawMsg)
              ? (t?.('mediaViewer.fileNotFound') || 'Arquivo não encontrado. Toque na imagem para abrir e tente salvar de novo.')
              : /source_missing_or_empty/i.test(rawMsg)
              ? (t?.('mediaViewer.fileEmpty') || 'Arquivo vazio ou ausente. Tente abrir a imagem novamente.')
              : (rawMsg || t?.('mediaViewer.photosPermCheck') || 'Verifique as permissões de Fotos em Ajustes > Chatyy');
            Alert.alert(t?.('mediaViewer.saveErrorTitle') || 'Erro ao salvar', cleanMsg);
          }
        }
        // [WAVE 91 2026-05-21] After a successful createAssetAsync, move
        // the asset into a "Chatyy" album so it's discoverable in the
        // user's Photos app. Without this on iOS limited-access mode the
        // asset shows up only in "Recents" (sometimes missed by user) and
        // on Android 11+ the bucket name comes out as
        // "expo-media-library" which never appears in the Gallery UI.
        // Best-effort: failure here doesn't undo the save.
        if (ok && savedAsset && savedAsset.id) {
          try {
            // [2026-10-13] Android 11+: mover para o álbum pede 'Permitir que o app modifique essa foto?' — no Android fica só na galeria.
            if (Platform.OS === 'android') throw new Error('skip-album-android');
            const album = await ML.getAlbumAsync('Chatyy');
            if (album) {
              await ML.addAssetsToAlbumAsync([savedAsset], album, false);
            } else {
              await ML.createAlbumAsync('Chatyy', savedAsset, false);
            }
          } catch (albumErr) {
            // Album move failed — the asset is still in the library, just
            // not in a Chatyy album. Don't surface this to the user; the
            // photo IS saved.
            if (__DEV__) try { console.warn('[saveMedia] album move failed', albumErr); } catch {}
          }
        }
        if (ok) {
          _dlOk = true;
          setSaved(true);
          setTimeout(() => setSaved(false), 2000);
        }
        // Cleanup temp file if we created one
        if (sourceUri !== _dlUrl && sourceUri.startsWith(FS.cacheDirectory)) {
          FS.deleteAsync(sourceUri, { idempotent: true }).catch(() => {});
        }
      } catch (e) {
        Alert.alert(t?.('mediaViewer.saveErrorTitle') || 'Erro ao salvar', String(e?.message || t?.('mediaViewer.photosPermCheck') || 'Verifique as permissões de Fotos em Ajustes > Chatyy'));
      } finally {
        setSaving(false);
      }
    }
    return _dlOk;
  };

  // View-once: block context menu and screenshots on web
  const viewOnceStyle = viewOnce && Platform.OS === 'web' ? {
    WebkitUserSelect: 'none',
    userSelect: 'none',
    WebkitTouchCallout: 'none',
    pointerEvents: 'auto',
  } : {};

  _nvActRef.current = { save: handleDownload };
  // [2026-10-14 native-viewer] Viewer nativo na tela → nada do pager JS.
  if (_nvOn) return null;

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <View
        style={[s.backdrop, viewOnceStyle]}
        onContextMenu={_locked ? (e) => e.preventDefault?.() : undefined}
      >
        {/* [2026-10-14 adv-privacy] web: sem bloqueio real → marca d'água com o @ de quem vê. */}
        {Platform.OS === 'web' && _locked ? (
          <PrivacyWatermark
            handle={(() => { try { return viewerHandle(require('../services/api').getActiveAccountEmail?.() || ''); } catch { return ''; } })()}
            label={(typeof t === 'function' && t('advPriv.watermark')) || 'Protegido'}
            dark
            style={{ zIndex: 9998 }}
          />
        ) : null}
        {/* Full-black backdrop layer. Opacity is driven by _bgOpacity so a
            swipe-down fades it out and reveals the chat behind (the Modal is
            transparent). pointerEvents=none so it never swallows touches. */}
        <Animated.View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { backgroundColor: _dismissSV ? 'transparent' : '#000', opacity: _bgOpacity }]}
        >
          {_dismissSV ? <_DismissBackdrop sv={_dismissSV} /> : null}
        </Animated.View>
        {/* View-once watermark — appears after a screenshot is detected
            (iOS) so the captured image carries the viewer's email +
            timestamp. The overlay is intentionally semi-transparent so
            it doesn't ruin the legitimate viewing experience, but is
            still readable in any saved capture or screen recording. */}
        {viewOnce && _watermarkVisible && (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              alignItems: 'center', justifyContent: 'center', zIndex: 9999,
            }}
          >
            <Text style={{
              color: 'rgba(255,255,255,0.55)', fontSize: 22, fontWeight: '700',
              transform: [{ rotate: '-22deg' }], textAlign: 'center',
              textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4,
            }}>
              {(_currentUserEmail || 'chatyy.com.br') + '\n' + new Date().toLocaleString()}
            </Text>
          </View>
        )}
        {/* WAVE 60: Header modernizado WhatsApp/IG-grade. Antes: nome
            "IMG_xxx.jpg" + "299 KB" feio. Agora: avatar do sender + nome
            + tempo relativo no centro, X à esquerda, More à direita.
            Filename + bytes movidos pro InfoSheet (toque em More) — info
            técnica continua acessível pra power users sem poluir a UI.
            Bars (top + bottom) fazem fade via _chromeOpacity quando o user
            toca na foto (parity Instagram). */}
        <Animated.View
          pointerEvents={_chromeVisible ? 'auto' : 'none'}
          style={[
            s.headerBar,
            {
              paddingTop: Math.max(insets.top, 12) + 6,
              opacity: _chromeOpacity,
            },
          ]}
        >
          <TouchableOpacity
            onPress={onClose}
            style={s.headerIconBtn}
            hitSlop={14}
            accessibilityLabel={(typeof t === 'function' && t('common.close')) || 'Fechar'}
            accessibilityRole="button"
          >
            <IconX size={24} color="#fff" />
          </TouchableOpacity>

          <View style={s.headerCenter}>
            {/* Sender row — avatar circle (initials, stable color) + name +
                relative time. Falls back to "Mídia" header when there's no
                sender (rare; happens for outbox previews where sender
                wasn't piped through yet). */}
            {(senderName || senderEmail) ? (
              <View style={s.senderRow}>
                <View style={[s.avatar, { backgroundColor: colorFromString(senderEmail || senderName || '') }]}>
                  <Text style={s.avatarText}>{isAssistantSender(senderName, senderEmail) ? 'B' : senderInitials(senderName, senderEmail)}</Text>
                </View>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    {viewOnce && <IconLock size={12} color="#fff" />}
                    <Text style={s.senderName} numberOfLines={1}>
                      {isAssistantSender(senderName, senderEmail) ? 'Bia' : (senderName || (senderEmail || '').split('@')[0])}
                    </Text>
                  </View>
                  <Text style={s.senderMeta} numberOfLines={1}>
                    {viewOnce
                      ? ((typeof t === 'function' && t('chat.viewOnceLabel')) || 'Visualização única')
                      : viewerRelativeTime(createdAt || _active?.createdAt || _active?.created_at, t)}
                  </Text>
                </View>
              </View>
            ) : (
              <View style={s.senderRow}>
                <View style={{ flex: 1, minWidth: 0 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    {viewOnce && <IconLock size={14} color="#fff" />}
                    <Text style={s.senderName} numberOfLines={1}>
                      {isImage ? ((typeof t === 'function' && t('viewer.imageLabel')) || 'Foto')
                        : isVideo ? ((typeof t === 'function' && t('viewer.videoLabel')) || 'Vídeo')
                        : ((typeof t === 'function' && t('viewer.fileLabel')) || 'Arquivo')}
                    </Text>
                  </View>
                </View>
              </View>
            )}

            {/* Pills row — page count "3/12" + media_kind LIVE/BURST/etc.
                Sit under the sender so the title line stays clean. */}
            {(_multi || (_activeMediaKind && _activeMediaKind !== 'regular')) && (
              <View style={{ flexDirection: 'row', gap: 6, marginTop: 4, marginLeft: 40 }}>
                {_multi && (
                  <View style={s.pill}>
                    <Text style={s.pillText}>{`${_currentIdx + 1} / ${_list.length}`}</Text>
                  </View>
                )}
                {_activeMediaKind && _activeMediaKind !== 'regular' && (() => {
                  const LABELS = {
                    live_photo: 'LIVE', burst: 'BURST', slowmo: 'SLO-MO',
                    timelapse: 'TIME-LAPSE', raw: 'RAW',
                  };
                  const label = LABELS[_activeMediaKind] || _activeMediaKind.toUpperCase();
                  return (
                    <View style={[s.pill, { backgroundColor: 'rgba(255,255,255,0.92)' }]}>
                      <Text style={[s.pillText, { color: '#111', fontWeight: '800', letterSpacing: 0.5 }]}>{label}</Text>
                    </View>
                  );
                })()}
              </View>
            )}
          </View>

          <TouchableOpacity
            onPress={() => _setInfoSheetOpen(o => !o)}
            style={s.headerIconBtn}
            hitSlop={14}
            accessibilityLabel={(typeof t === 'function' && t('viewer.info')) || 'Mais'}
            accessibilityRole="button"
          >
            <IconMoreHorizontal size={22} color="#fff" />
          </TouchableOpacity>
        </Animated.View>

        {/* Content — single-item path renders inline; multi-item path uses
            a paging FlatList so swipe between feels native.
            WAVE 60: wrapped in a transparent tap-zone so a single tap on the
            backdrop toggles top/bottom chrome (Instagram parity). Pan/zoom
            gestures inside ImageViewer still win because PanResponder
            captures movement; only the unmodified tap reaches us here. */}
        <TouchableWithoutFeedback onPress={_onBackdropPress} accessible={false}>
        <Animated.View style={{ flex: 1, transform: [{ scale: _openScale }] }}>
        {_multi ? (
          <FlatList
            ref={_pagerRef}
            dataSet={Platform.OS === 'web' ? { chatyyPager: '1' } : undefined}
            data={_list}
            extraData={Platform.OS === 'web' ? `${_currentIdx}_${_webPagerH}_${_pageW}` : `${_currentIdx}_${_pageW}`}
            // chave = posição: a URL muda com o viewer aberto (upload terminou,
            // local→remoto) e remontava a página visível (flash/zoom perdido).
            keyExtractor={(it, i) => `p${i}`}
            horizontal
            // [2026-10-14 swipe-album] Paginação NATIVA do UIScrollView: 1 página
            // por gesto, velocidade/flick decide. O pager fica SEMPRE ligado —
            // ampliado, quem segura o arrasto é o pan do zoom (UIZoomSurface)
            // ativando antes do UIScrollView; na borda ele falha e o pager pagina.
            pagingEnabled
            // Android: mantém o comportamento antigo (pager desligado enquanto
            // ampliado — o HorizontalScrollView intercepta o toque do filho).
            scrollEnabled={Platform.OS === 'android' ? !_zoomed : !_pagerLocked}
            decelerationRate="fast"
            disableIntervalMomentum
            directionalLockEnabled
            removeClippedSubviews={false}
            initialNumToRender={3}
            maxToRenderPerBatch={2}
            windowSize={5}
            showsHorizontalScrollIndicator={false}
            initialScrollIndex={_initial}
            // nativo: já nasce na página certa (sem 1 frame da página 0 antes do scrollToIndex)
            contentOffset={Platform.OS !== 'web' && _initial > 0 ? _initOffsetRef.current || undefined : undefined}
            getItemLayout={(_, i) => ({ length: _pageW, offset: _pageW * i, index: i })}
            onScrollToIndexFailed={() => {}}
            onMomentumScrollEnd={(e) => _settleFromOffset(e, false)}
            onScrollEndDrag={Platform.OS !== 'web' ? (e) => _settleFromOffset(e, true) : undefined}
            // [2026-10-14 album-swipe] Web (react-native-web) não emite
            // onMomentumScrollEnd → o contador ficava parado em "2 / 3" depois
            // de passar. No web o índice sai do onScroll.
            onScroll={Platform.OS === 'web' ? _onWebPagerScroll : undefined}
            onLayout={_onPagerLayout}
            scrollEventThrottle={32}
            renderItem={({ item, index }) => (
              <_AlbumPage
                item={item}
                isActive={index === _currentIdx}
                pageW={_pageW}
                webH={Platform.OS === 'web' ? _webPagerH : 0}
                conversationId={conversationId}
                viewOnce={viewOnce}
                t={t}
                onDismissMove={_onDismissMove}
                onDismissEnd={_onDismissEnd}
                dismissSV={_dismissSV}
                onDismissStart={_onDismissStart}
                onZoomChange={_onZoomChange}
                onEdgeSwipe={_onEdgeSwipe}
                onDoubleTap={_onDoubleTap}
                onPageableChange={_onPageableChange}
              />
            )}
          />
        ) : (
          isImage ? (
            // Wave 14: iOS portrait photos render with 3D parallax. Backend
            // tags `media_kind: 'portrait'` when the iOS backup pipeline
            // detects the depth aux channel; `depthUrl` is the masked
            // foreground subject (generated server-side from the AVDepthData
            // map). When either is missing we fall back to the regular pan-
            // and-zoom image viewer.
            (_activeMediaKind === 'portrait' && ParallaxPortraitView) ? (
              <View style={s.mediaContainer}>
                <ParallaxPortraitView
                  fileUrl={url}
                  depthUrl={_active?.depthUrl || _active?.depth_url || url}
                  width={SCREEN_W}
                  height={SCREEN_H * 0.75}
                />
              </View>
            ) : (
              <ImageViewer
                url={url}
                messageId={_active?.messageId || _active?.id || messageId || 0}
                conversationId={conversationId}
                fileSize={_activeFileSize}
                createdAt={_active?.createdAt || _active?.created_at}
                t={typeof t === 'function' ? t : undefined}
                placeholderUri={_active?.placeholderUri || _active?.thumbB64Uri}
                blurhash={_active?.blurhash}
                thumbUri={_active?.thumbUri}
                onDismissMove={_onDismissMove}
                onDismissEnd={_onDismissEnd}
                dismissSV={_dismissSV}
                onDismissStart={_onDismissStart}
                onZoomChange={_onZoomChange}
                onDoubleTap={_onDoubleTap}
              />
            )
          ) : isVideo ? (
            // Offline + no HLS cache → don't mount the player (it'd spin
            // forever on a dead manifest URL). Show a friendly message
            // instead. The mp4 progressive path falls through to VideoPlayer
            // because _hlsOfflineUnavailable only flips true for .m3u8 sources.
            _hlsOfflineUnavailable ? (
              <View style={s.mediaContainer}>
                <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16, textAlign: 'center', paddingHorizontal: 32 }}>
                  {(typeof t === 'function' && t('chat.video.offlineUnavailable')) || 'Vídeo não disponível offline'}
                </Text>
              </View>
            ) : (
              <VideoPlayer url={url} allowPip={!viewOnce} noCache={!!viewOnce} />
            )
          ) : isPreviewable ? (
            <PreviewViewer
              url={url}
              filename={_activeFileName}
              messageId={_active?.messageId || _active?.id || messageId || 0}
              fileSize={_activeFileSize}
              t={typeof t === 'function' ? t : undefined}
            />
          ) : (
            <GenericFileViewer
              url={url}
              filename={_activeFileName}
              fileSize={_activeFileSize}
              messageId={_active?.messageId || _active?.id || messageId || 0}
              t={typeof t === 'function' ? t : undefined}
            />
          )
        )}
        </Animated.View>
        </TouchableWithoutFeedback>

        {/* [2026-10-14 album-swipe] Web: mouse não "arrasta" o carrossel — setas
            anterior/próxima (e ← → do teclado) passam entre as mídias do álbum. */}
        {Platform.OS === 'web' && _multi && !_zoomed && (
          <>
            {_currentIdx > 0 && (
              <TouchableOpacity
                onPress={() => _goToPage(_currentIdx - 1)}
                style={[s.webNavBtn, { left: 12 }]}
                accessibilityRole="button"
                accessibilityLabel={(typeof t === 'function' && t('common.back')) || 'Voltar'}
              >
                <IconChevronLeft size={26} color="#fff" />
              </TouchableOpacity>
            )}
            {_currentIdx < _list.length - 1 && (
              <TouchableOpacity
                onPress={() => _goToPage(_currentIdx + 1)}
                style={[s.webNavBtn, { right: 12 }]}
                accessibilityRole="button"
                accessibilityLabel={(typeof t === 'function' && t('common.next')) || 'Próximo'}
              >
                <IconChevronRight size={26} color="#fff" />
              </TouchableOpacity>
            )}
          </>
        )}

        {/* Caption — the text the sender attached to the photo (WhatsApp/IG).
            Sits just above the action bar, fades with the rest of the chrome,
            and scrolls internally when long so it never covers the photo. */}
        {!!_activeCaption && (
          <Animated.View
            pointerEvents={_chromeVisible ? 'auto' : 'none'}
            style={[
              s.captionWrap,
              {
                bottom: Math.max(insets.bottom, 12) + 6 + 60,
                opacity: _chromeOpacity,
              },
            ]}
          >
            <ScrollView
              style={{ maxHeight: 112 }}
              showsVerticalScrollIndicator={false}
              bounces={false}
            >
              <Text style={s.captionText}>{_activeCaption}</Text>
            </ScrollView>
          </Animated.View>
        )}

        {/* WAVE 60: Bottom action bar — Share / Download / Star (WhatsApp/IG
            grade). Lives in its own row at the bottom, fades with the top
            chrome on tap. View-once hides Download + Share (download path
            already blocked) but keeps Star (lets the user remember the
            moment without saving the file itself). */}
        <Animated.View
          pointerEvents={_chromeVisible ? 'auto' : 'none'}
          style={[
            s.actionBar,
            {
              paddingBottom: Math.max(insets.bottom, 12) + 6,
              opacity: _chromeOpacity,
            },
          ]}
        >
          {!_locked && (
            <TouchableOpacity
              onPress={async () => {
                // [2026-10-09 more-native] share sheet nativo com o ARQUIVO
                // (Salvar imagem / AirDrop / outros apps recebem a mídia, não
                // um link). Fallback interno: link, como antes.
                if (_sharing) return;
                _setSharing(true);
                try { await shareMediaFile({ url, fileName: _activeFileName }); } catch {}
                _setSharing(false);
              }}
              disabled={_sharing}
              style={s.actionBtn}
              hitSlop={10}
              accessibilityLabel={(typeof t === 'function' && t('viewer.share')) || 'Compartilhar'}
              accessibilityRole="button"
            >
              {_sharing ? <ActivityIndicator size="small" color="#fff" /> : <IconShare size={22} color="#fff" />}
            </TouchableOpacity>
          )}
          {/* [2026-10-09 more-native] Texto da foto (Live Text-lite, iOS Vision on-device). */}
          {!_locked && isImage && canRecognizeImageText() && (
            <TouchableOpacity
              onPress={async () => {
                if (_ocr?.loading) return;
                _setOcrCopied(false);
                _setOcr({ loading: true });
                const r = await recognizeImageText(url, { fileName: _activeFileName });
                _setOcr(r?.text ? { text: r.text } : { empty: true });
              }}
              style={s.actionBtn}
              hitSlop={10}
              accessibilityLabel={typeof t === 'function' ? t('viewer.copyText') : 'viewer.copyText'}
              accessibilityRole="button"
            >
              <IconType size={22} color="#fff" />
            </TouchableOpacity>
          )}
          {!_locked && (
            <TouchableOpacity
              onPress={() => handleDownload()}
              disabled={saving}
              style={s.actionBtn}
              hitSlop={10}
              accessibilityLabel={(typeof t === 'function' && t('viewer.download')) || 'Baixar'}
              accessibilityRole="button"
            >
              {saving ? <ActivityIndicator size="small" color="#fff" />
                : saved ? <IconCheck size={22} color="#fff" strokeWidth={3} />
                : <IconDownload size={22} color="#fff" />}
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={() => _setStarred(s => !s)}
            style={s.actionBtn}
            hitSlop={10}
            accessibilityLabel={(typeof t === 'function' && t('viewer.star')) || 'Favorito'}
            accessibilityRole="button"
          >
            {_starred
              ? <IconStarFilled size={22} color="#fff" />
              : <IconStar size={22} color="#fff" />}
          </TouchableOpacity>
          {/* Forward — opens the app's existing forward picker for this media.
              Only shown when a handler is wired and the item isn't view-once
              (view-once media must not be forwardable). Safe no-op if absent. */}
          {!_locked && typeof onForward === 'function' && (
            <TouchableOpacity
              onPress={() => { try { onForward(_active || { messageId: messageId || 0, fileUrl: url }); } catch {} }}
              style={s.actionBtn}
              hitSlop={10}
              accessibilityLabel={(typeof t === 'function' && t('viewer.forward')) || 'Encaminhar'}
              accessibilityRole="button"
            >
              <IconForward size={22} color="#fff" />
            </TouchableOpacity>
          )}
        </Animated.View>

        {/* WAVE 60: Info sheet — opens on More tap. Surfaces the technical
            details (filename, file size, sender email, date) that used to
            pollute the main header. Power users still have access; new
            users get a clean fullscreen photo experience. */}
        {/* [2026-10-09 more-native] Sheet do texto reconhecido: texto SELECIONÁVEL
            (seleção nativa do sistema) + Copiar. */}
        {!!_ocr && (
          <TouchableWithoutFeedback onPress={() => _setOcr(null)}>
            <View style={s.infoOverlay}>
              <TouchableWithoutFeedback>
                <View style={[s.infoSheet, { paddingBottom: Math.max(insets.bottom, 16) + 12, maxHeight: '70%' }]}>
                  <View style={s.infoHandle} />
                  <Text style={s.infoTitle}>{typeof t === 'function' ? t('viewer.textInImage') : 'viewer.textInImage'}</Text>
                  {_ocr.loading ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 18 }}>
                      <ActivityIndicator color="#fff" />
                      <Text style={{ color: 'rgba(255,255,255,0.7)', marginLeft: 10, fontSize: 14 }}>
                        {typeof t === 'function' ? t('viewer.recognizingText') : 'viewer.recognizingText'}
                      </Text>
                    </View>
                  ) : _ocr.empty ? (
                    <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, paddingVertical: 18 }}>
                      {typeof t === 'function' ? t('viewer.noTextFound') : 'viewer.noTextFound'}
                    </Text>
                  ) : (
                    <>
                      <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ paddingBottom: 8 }}>
                        <Text selectable style={{ color: '#fff', fontSize: 16, lineHeight: 22 }}>{_ocr.text}</Text>
                      </ScrollView>
                      <TouchableOpacity
                        onPress={async () => {
                          try {
                            const C = require('expo-clipboard');
                            await C.setStringAsync(_ocr.text);
                            _setOcrCopied(true);
                            try { require('expo-haptics').notificationAsync(require('expo-haptics').NotificationFeedbackType.Success); } catch {}
                          } catch {}
                        }}
                        style={{ marginTop: 12, height: 46, borderRadius: 23, backgroundColor: '#fff', flexDirection: 'row', alignItems: 'center', justifyContent: 'center' }}
                        accessibilityRole="button"
                      >
                        {_ocrCopied ? <IconCheck size={18} color="#000" strokeWidth={3} /> : <IconCopy size={18} color="#000" />}
                        <Text style={{ color: '#000', fontSize: 15, fontWeight: '600', marginLeft: 8 }}>
                          {typeof t === 'function' ? t(_ocrCopied ? 'common.copied' : 'common.copy') : 'common.copy'}
                        </Text>
                      </TouchableOpacity>
                    </>
                  )}
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        )}

        {_infoSheetOpen && (
          <TouchableWithoutFeedback onPress={() => _setInfoSheetOpen(false)}>
            <View style={s.infoOverlay}>
              <TouchableWithoutFeedback>
                <View style={[s.infoSheet, { paddingBottom: Math.max(insets.bottom, 16) + 12 }]}>
                  <View style={s.infoHandle} />
                  <Text style={s.infoTitle}>
                    {(typeof t === 'function' && t('viewer.imageInfo')) || 'Detalhes'}
                  </Text>
                  {!!(senderName || senderEmail) && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.sentBy')) || 'Enviado por'}</Text>
                      <Text style={s.infoVal} numberOfLines={1}>{isAssistantSender(senderName, senderEmail) ? 'Bia' : (senderName || senderEmail)}</Text>
                    </View>
                  )}
                  {!!(createdAt || _active?.createdAt || _active?.created_at) && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.date')) || 'Data'}</Text>
                      <Text style={s.infoVal}>
                        {(() => {
                          try {
                            const tsRaw = createdAt || _active?.createdAt || _active?.created_at;
                            const ms = typeof tsRaw === 'number' ? (tsRaw < 1e12 ? tsRaw * 1000 : tsRaw) : Date.parse(tsRaw);
                            return new Date(ms).toLocaleString();
                          } catch { return ''; }
                        })()}
                      </Text>
                    </View>
                  )}
                  {!!_activeFileName && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.fileName')) || 'Arquivo'}</Text>
                      <Text style={s.infoVal} numberOfLines={1}>{_activeFileName}</Text>
                    </View>
                  )}
                  {_activeFileSize > 0 && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.fileSize')) || 'Tamanho'}</Text>
                      <Text style={s.infoVal}>{formatSize(_activeFileSize)}</Text>
                    </View>
                  )}
                  {/* WAVE 73: video-specific metadata (duration + resolution).
                      Backend doesn't always populate width/height (only when
                      the ffmpeg poster pass writes image_variants.full_w/h),
                      so we render the row conditionally. Resolution becomes
                      a "1920×1080 (HD)" / "3840×2160 (4K)" label so users
                      get the same intuition as YouTube. */}
                  {isVideo && (_active?.videoDuration > 0 || _active?.duration > 0 || videoDuration > 0) && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.duration')) || 'Duração'}</Text>
                      <Text style={s.infoVal}>{(() => {
                        const sec = Math.floor(_active?.videoDuration || _active?.duration || videoDuration || 0);
                        if (sec >= 3600) return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
                        return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
                      })()}</Text>
                    </View>
                  )}
                  {isVideo && ((_active?.videoHeight || videoHeight) > 0) && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.resolution')) || 'Resolução'}</Text>
                      <Text style={s.infoVal}>{(() => {
                        const w = _active?.videoWidth || videoWidth || 0;
                        const h = _active?.videoHeight || videoHeight || 0;
                        const tag = h >= 2160 ? ' (4K)' : h >= 1080 ? ' (HD)' : '';
                        return `${w || '?'}×${h}${tag}`;
                      })()}</Text>
                    </View>
                  )}
                  {/* MIME type — useful for "what app can open this" intuition.
                      Surfaced for files and videos; images skip it (the format
                      is obvious from the visual). Falls back to extension-
                      derived guess when the backend didn't tag mimeType. */}
                  {!isImage && (mimeType || _active?.mimeType) && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.mime')) || 'Tipo'}</Text>
                      <Text style={s.infoVal} numberOfLines={1}>{_active?.mimeType || mimeType}</Text>
                    </View>
                  )}
                  {!isImage && !isVideo && !mimeType && !_active?.mimeType && !!ext && (
                    <View style={s.infoRow}>
                      <Text style={s.infoKey}>{(typeof t === 'function' && t('viewer.fileType')) || 'Formato'}</Text>
                      <Text style={s.infoVal}>{ext.toUpperCase()}</Text>
                    </View>
                  )}
                </View>
              </TouchableWithoutFeedback>
            </View>
          </TouchableWithoutFeedback>
        )}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    // The visible black is painted by the animated _bgOpacity layer so the
    // swipe-down dismiss can fade it; this container stays transparent.
    backgroundColor: 'transparent',
  },
  captionWrap: {
    position: 'absolute', left: 0, right: 0,
    paddingHorizontal: 18,
    zIndex: 20,
  },
  captionText: {
    color: '#fff', fontSize: 15, lineHeight: 21,
    textShadowColor: 'rgba(0,0,0,0.75)', textShadowRadius: 5,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingBottom: 10,
    gap: 12,
  },
  headerInfo: { flex: 1 },
  headerTitle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  headerSize: { color: 'rgba(255,255,255,0.5)', fontSize: 12, marginTop: 1 },
  headerBtn: { padding: 8 },
  // WAVE 60 — WhatsApp/IG-grade viewer chrome
  headerBar: {
    position: 'absolute', top: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'flex-start',
    paddingHorizontal: 8, paddingBottom: 12,
    zIndex: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  headerIconBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    marginTop: 2,
  },
  headerCenter: { flex: 1, paddingHorizontal: 4, justifyContent: 'center' },
  senderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  avatar: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 12, fontWeight: '700', letterSpacing: 0.3 },
  senderName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  senderMeta: { color: 'rgba(255,255,255,0.65)', fontSize: 11, marginTop: 1 },
  pill: {
    paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  pillText: { color: '#fff', fontSize: 11, fontWeight: '600' },
  // [2026-10-14 album-swipe] setas do carrossel no web.
  webNavBtn: { position: 'absolute', top: '50%', marginTop: -24, width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center', zIndex: 20 },
  actionBar: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around',
    paddingTop: 12, paddingHorizontal: 24,
    backgroundColor: 'rgba(0,0,0,0.45)',
    zIndex: 20,
  },
  actionBtn: {
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.10)',
  },
  infoOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    justifyContent: 'flex-end',
    zIndex: 50,
  },
  infoSheet: {
    backgroundColor: '#1a1a1a',
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: 20, paddingTop: 10,
  },
  infoHandle: {
    alignSelf: 'center',
    width: 36, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    marginBottom: 14,
  },
  infoTitle: { color: '#fff', fontSize: 17, fontWeight: '700', marginBottom: 14 },
  infoRow: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.08)',
  },
  infoKey: { color: 'rgba(255,255,255,0.6)', fontSize: 13, flexShrink: 0, marginRight: 12 },
  infoVal: { color: '#fff', fontSize: 13, fontWeight: '500', flex: 1, textAlign: 'right' },
  mediaContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loader: {
    position: 'absolute',
    zIndex: 10,
  },
  fullImage: {
    width: SCREEN_W,
    height: SCREEN_H * 0.75,
  },
  fullVideo: {
    width: SCREEN_W,
    height: SCREEN_H * 0.65,
  },
  fileIcon: {
    width: 80,
    height: 80,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 16,
  },
  fileExtText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '700',
  },
  fileNameText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '500',
    textAlign: 'center',
    paddingHorizontal: 40,
    marginBottom: 6,
  },
  fileSizeText: {
    color: 'rgba(255,255,255,0.5)',
    fontSize: 13,
    marginBottom: 24,
  },
  openExternalBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: '#111111',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 10,
  },
  openExternalText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
});
