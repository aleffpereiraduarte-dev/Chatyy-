// AvatarLightbox — profile-photo viewer (quick-view card + full-screen).
//
// WAVE 95 (2026-05-21). User complaint: "se eu clico na foto de perfil do
// meu amigo deveria ficar grande pra eu ver". Tap avatar → dark fullscreen
// with the full-size photo, pinch-zoom, swipe-down to dismiss.
//
// [2026-10-17 avatar-card] Redesign nível WhatsApp iOS:
//  • variant="card" (lista de conversas): CARTÃO compacto centralizado —
//    foto quadrada (~280pt, cantos 16) com o nome numa faixa translúcida no
//    topo e a fileira de ações (Mensagem / Ligar / Vídeo / Info) embaixo.
//    Fundo = blur nativo no iOS (NativeBlur, com guarda de binário) / dim
//    rgba 0.6 nos demais. Tocar fora ou arrastar p/ baixo fecha; tocar na foto
//    abre a TELA CHEIA dentro do MESMO Modal (iOS: nunca Modal sobre Modal,
//    nunca troca de tipo de Modal — só troca o conteúdo).
//  • variant="full" (padrão — perfil, dados do contato, cabeçalho da conversa):
//    fundo PRETO sólido, barra com voltar à esquerda + nome centralizado (NUNCA
//    e-mail), foto ajustada à largura na maior resolução disponível (miniatura
//    do cache na hora + size=1024 com fade por cima), pinch-zoom, arrastar p/
//    baixo fecha.
//  • Foto pequena (largura natural < largura da tela × pixelRatio / 1.5): não
//    amplia além de ~1.5× — mostra num tamanho que fica nítido, centralizada no
//    preto (como o WhatsApp faz com fotos pequenas).
//  • Ações: cada botão só aparece se o chamador passou o handler. Grupo =
//    Mensagem + Info. Própria foto (isSelf) = sem fileira de ações.
//  Kill switches: globalThis.__chatyy_avatar_card_off (cartão → tela cheia
//  direto, comportamento antigo), __chatyy_avatar_lowres_fit_off (sempre
//  largura total).
//
// We don't reuse ChatMediaViewer here because:
//  1) ChatMediaViewer expects message context (messageId, conversationId,
//     view-once, share/star/report actions) and would download the avatar
//     into chat cache, polluting the media gallery
//  2) avatars are SMALL (a few hundred KB max), no need for paged neighbor
//     preload, blurhash placeholders, or HLS pipeline
//  3) lightbox feels different from media viewer — no bottom action bar,
//     no metadata header, just the photo.
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, Modal, StyleSheet, Platform, TouchableOpacity,
  Animated, PanResponder, StatusBar, Pressable, PixelRatio, useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconChevronLeft, IconMessageCircle, IconPhone, IconVideo, IconInfo } from './Icons';
import { useLanguage } from '../context/LanguageContext';
import { useTheme } from '../context/ThemeContext';
import { BlurBackdrop } from './NativeBlur';
// [2026-10-14 avatar-instant] Abre INSTANTÂNEO (nível WhatsApp): mostra NA HORA a
// miniatura que a lista/cabeçalho já pintou (MESMA URL canônica → cache de
// memória/disco do expo-image ou do navegador) e carrega a versão grande
// (size=1024) por cima, com fade quando chega. Nada de tela preta/spinner:
// iniciais embaixo de tudo, miniatura, depois a grande.
import { avatarViewerSources, prefetchAvatarFull, avatarSource } from '../services/avatar';
import { getCachedAvatarUriOrNull } from '../services/avatarCache';
import { useCaptureProtectedSurface } from '../services/chatPrivacy'; // [2026-10-22 print-local]

function _isMe(email) {
  try {
    const me = String(require('../services/api').getActiveAccountEmail?.() || '').trim().toLowerCase();
    const e = String(email || '').trim().toLowerCase();
    return !!me && !!e && me === e;
  } catch { return false; }
}

let ExpoImage = null;
if (Platform.OS !== 'web') {
  try { ExpoImage = require('expo-image').Image; } catch {}
}

// url → { w, h } natural size (px), so a reopen sizes the photo right on frame 1.
const _natCache = new Map();
function _natFromLoadEvent(e) {
  try {
    const src = (e && e.source) || (e && e.nativeEvent && e.nativeEvent.source) || null;
    const w = Number(src && src.width) || 0;
    const h = Number(src && src.height) || 0;
    return (w > 0 && h > 0) ? { w, h } : null;
  } catch { return null; }
}

// Never show a raw e-mail: "joao.silva@chatyy.com.br" → "joao.silva".
function _safeName(name) {
  const s = typeof name === 'string' ? name.trim() : '';
  if (!s) return '';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) return s.split('@')[0];
  return s;
}

const CARD_MAX = 280;

export default function AvatarLightbox({
  visible, onClose, email, uri, name,
  // [2026-10-17 avatar-card]
  variant = 'full', isGroup = false, isSelf = false,
  onMessage, onCall, onVideoCall, onInfo,
}) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const { colors, isDark } = useTheme();
  const tt = useCallback((k, fb) => { try { const v = t(k); return (v && v !== k) ? v : fb; } catch { return fb; } }, [t]);
  const { width: winW, height: winH } = useWindowDimensions();
  // [2026-10-22 print-local] Foto de perfil de OUTRA pessoa = sem print
  // (Android FLAG_SECURE só enquanto aberto; Android 14+ avisa a tentativa).
  const _protect = !!visible && !isSelf && !_isMe(email);
  const _secReady = useCaptureProtectedSurface(_protect, 'chatyy-profile-photo', { t, kind: 'profile_photo' });

  const cardEnabled = variant === 'card' && !globalThis.__chatyy_avatar_card_off;
  const [view, setView] = useState(cardEnabled ? 'card' : 'full'); // 'card' | 'full'
  const openedFromCardRef = useRef(false);

  const [imgError, setImgError] = useState(false);
  const [fullError, setFullError] = useState(false);
  const [thumbNat, setThumbNat] = useState(null);
  const [fullNat, setFullNat] = useState(null);
  const fullOpacity = useRef(new Animated.Value(0)).current;
  const zoomIn = useRef(new Animated.Value(0.94)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;
  const cardScale = useRef(new Animated.Value(0.86)).current;
  const cardY = useRef(new Animated.Value(0)).current;

  // Track current scale/translation imperatively so the PanResponder math
  // doesn't fight Animated.Value updates mid-gesture.
  const stateRef = useRef({ scale: 1, lastScale: 1, tx: 0, ty: 0, lastTx: 0, lastTy: 0, pinchStartDist: 0 });

  const resetFullGesture = useCallback(() => {
    stateRef.current = { scale: 1, lastScale: 1, tx: 0, ty: 0, lastTx: 0, lastTy: 0, pinchStartDist: 0 };
    scale.setValue(1); translateX.setValue(0); translateY.setValue(0);
  }, [scale, translateX, translateY]);

  useEffect(() => {
    if (visible) {
      const startView = cardEnabled ? 'card' : 'full';
      openedFromCardRef.current = false;
      setView(startView);
      setImgError(false);
      setFullError(false);
      fullOpacity.setValue(0);
      resetFullGesture();
      zoomIn.setValue(0.94);
      cardScale.setValue(0.86);
      cardY.setValue(0);
      opacity.setValue(0);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }),
        startView === 'card'
          ? Animated.spring(cardScale, { toValue: 1, useNativeDriver: true, speed: 20, bounciness: 6 })
          : Animated.spring(zoomIn, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 3 }),
      ]).start();
    } else {
      opacity.setValue(0);
    }
  }, [visible]);

  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const closingRef = useRef(false);
  const requestClose = useCallback(() => {
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      closingRef.current = false;
      try { onCloseRef.current && onCloseRef.current(); } catch {}
    });
  }, [opacity]);
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  // Card photo → full-screen, inside the SAME Modal (content swap only).
  const openFull = useCallback(() => {
    openedFromCardRef.current = true;
    resetFullGesture();
    zoomIn.setValue(0.9);
    setView('full');
    Animated.spring(zoomIn, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 2 }).start();
  }, [resetFullGesture, zoomIn]);

  // Back in full-screen: back to the card when it came from there, else close.
  const fullBack = useCallback(() => {
    if (openedFromCardRef.current && cardEnabled) {
      openedFromCardRef.current = false;
      resetFullGesture();
      opacity.setValue(1);
      cardScale.setValue(0.94);
      cardY.setValue(0);
      setView('card');
      Animated.spring(cardScale, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 4 }).start();
      return;
    }
    requestClose();
  }, [cardEnabled, resetFullGesture, opacity, cardScale, cardY, requestClose]);

  // Run an action AFTER the Modal is gone (iOS: never present/push while a
  // Modal is still dismissing).
  const runAction = useCallback((fn) => {
    if (typeof fn !== 'function') return;
    if (closingRef.current) return;
    closingRef.current = true;
    Animated.timing(opacity, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => {
      closingRef.current = false;
      try { onCloseRef.current && onCloseRef.current(); } catch {}
      setTimeout(() => { try { fn(); } catch (e) { console.warn('[AvatarLightbox] action failed:', e?.message || e); } }, Platform.OS === 'ios' ? 60 : 0);
    });
  }, [opacity]);

  // [2026-10-14 avatar-instant] thumb = URL canônica da lista (já em cache);
  // full = mesma foto em size=1024. E-mail vem da prop OU do `email=` da URL
  // get_avatar (perfil passa identity.avatar_url relativa do servidor).
  const _src = avatarViewerSources({ email, uri, name });
  let thumbUri = _src.thumb || '';
  const fullUri = _src.full || '';
  // Nativo: a lista pinta o arquivo do disco (services/avatarCache) — usar o
  // MESMO file:// acerta o cache de memória do expo-image na hora.
  if (Platform.OS !== 'web' && thumbUri && /^https?:/i.test(thumbUri)) {
    thumbUri = getCachedAvatarUriOrNull(thumbUri) || thumbUri;
  }
  // Sem `v=` = iniciais geradas → não existe "versão grande", fica só a miniatura.
  const hasFull = !!fullUri && fullUri !== _src.thumb && !fullError
    && (fullUri.indexOf('get_avatar') === -1 || /[?&]v=/.test(fullUri));
  // Garante a grande em voo assim que abrir (no-op se já pré-carregada).
  useEffect(() => {
    if (visible && hasFull) { try { prefetchAvatarFull(fullUri, { high: true }); } catch {} }
  }, [visible, fullUri]);
  useEffect(() => {
    if (!visible) return;
    setThumbNat(_natCache.get(thumbUri) || null);
    setFullNat(_natCache.get(fullUri) || null);
  }, [visible, thumbUri, fullUri]);
  const onFullLoad = useCallback((e) => {
    const n = _natFromLoadEvent(e);
    if (n) { try { _natCache.set(fullUri, n); } catch {} setFullNat(n); }
    Animated.timing(fullOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [fullOpacity, fullUri]);
  const onThumbLoad = useCallback((e) => {
    const n = _natFromLoadEvent(e);
    if (n) { try { _natCache.set(thumbUri, n); } catch {} setThumbNat(n); }
  }, [thumbUri]);

  // Pinch-zoom: classic 2-finger handler (no gesture-handler dep). Created
  // once; reads the latest close via requestCloseRef.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (_, g) => Math.abs(g.dx) > 2 || Math.abs(g.dy) > 2 || g.numberActiveTouches === 2,
      onPanResponderGrant: (evt) => {
        const touches = evt.nativeEvent.touches;
        if (touches && touches.length === 2) {
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          stateRef.current.pinchStartDist = Math.sqrt(dx * dx + dy * dy);
        }
      },
      onPanResponderMove: (evt, g) => {
        const touches = evt.nativeEvent.touches;
        if (touches && touches.length === 2) {
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          const dist = Math.sqrt(dx * dx + dy * dy);
          // Second finger landed mid-gesture: start the pinch from here.
          if (!(stateRef.current.pinchStartDist > 0)) { stateRef.current.pinchStartDist = dist; return; }
          const nextScale = Math.max(1, Math.min(5, stateRef.current.lastScale * (dist / stateRef.current.pinchStartDist)));
          stateRef.current.scale = nextScale;
          scale.setValue(nextScale);
        } else if (stateRef.current.scale > 1.02) {
          // Pan only when zoomed in.
          const nx = stateRef.current.lastTx + g.dx;
          const ny = stateRef.current.lastTy + g.dy;
          stateRef.current.tx = nx;
          stateRef.current.ty = ny;
          translateX.setValue(nx);
          translateY.setValue(ny);
        } else if (g.dy > 0) {
          // At rest scale — vertical swipe-down dismisses.
          translateY.setValue(g.dy);
          opacity.setValue(Math.max(0.2, 1 - g.dy / 700));
        }
      },
      onPanResponderRelease: (_, g) => {
        if (stateRef.current.scale <= 1.02 && g.dy > 120 && Math.abs(g.dx) < 200) {
          requestCloseRef.current && requestCloseRef.current();
          return;
        }
        stateRef.current.lastScale = stateRef.current.scale;
        stateRef.current.lastTx = stateRef.current.tx;
        stateRef.current.lastTy = stateRef.current.ty;
        stateRef.current.pinchStartDist = 0;
        if (stateRef.current.scale < 1.05) {
          stateRef.current = { ...stateRef.current, scale: 1, lastScale: 1, tx: 0, ty: 0, lastTx: 0, lastTy: 0 };
          Animated.parallel([
            Animated.spring(scale, { toValue: 1, useNativeDriver: true, bounciness: 4 }),
            Animated.spring(translateX, { toValue: 0, useNativeDriver: true }),
            Animated.spring(translateY, { toValue: 0, useNativeDriver: true }),
            Animated.timing(opacity, { toValue: 1, duration: 150, useNativeDriver: true }),
          ]).start();
        }
      },
    })
  ).current;

  // Card: swipe-down closes; a plain tap on the photo opens full-screen
  // (handled by the Pressable — this responder only claims real drags).
  const cardPan = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => g.dy > 8 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => {
        const dy = Math.max(0, g.dy);
        cardY.setValue(dy);
        opacity.setValue(Math.max(0.25, 1 - dy / 500));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 90 || g.vy > 0.9) { requestCloseRef.current && requestCloseRef.current(); return; }
        Animated.parallel([
          Animated.spring(cardY, { toValue: 0, useNativeDriver: true, bounciness: 4 }),
          Animated.timing(opacity, { toValue: 1, duration: 120, useNativeDriver: true }),
        ]).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(cardY, { toValue: 0, useNativeDriver: true }).start();
        opacity.setValue(1);
      },
    })
  ).current;

  const ImageComponent = ExpoImage || require('react-native').Image;
  const showImage = !!thumbUri && !imgError;
  const displayName = _safeName(name) || (email ? String(email).split('@')[0] : '');

  // Initials fallback so we still show SOMETHING if the avatar 404s.
  const initials = (() => {
    const src = displayName;
    if (!src) return '?';
    const parts = src.split(/[\s._\-]+/).filter(Boolean);
    if (parts.length >= 2) return ((parts[0][0] || '') + (parts[1][0] || '')).toUpperCase();
    return (parts[0]?.slice(0, 2) || '?').toUpperCase();
  })();

  // ── Full-screen photo box (low-res aware) ──────────────────────────────
  // Best known natural size: the big one once loaded/known; the thumb when
  // there is no big one (or it failed). While the big one is in flight with
  // no cached size, keep full width (progressive load, no jump-then-grow).
  const nat = fullNat || ((!hasFull) ? thumbNat : null);
  const availH = Math.max(200, winH - insets.top - insets.bottom - 120);
  let photoBox = Math.min(winW, availH);
  if (nat && nat.w > 0 && !globalThis.__chatyy_avatar_lowres_fit_off) {
    const crispPt = (nat.w * 1.5) / (PixelRatio.get() || 2);
    if (crispPt < photoBox) photoBox = Math.max(160, Math.round(crispPt));
  }
  const photoW = photoBox;
  const photoH = (nat && nat.w > 0) ? Math.min(availH, Math.round(photoBox * (nat.h / nat.w))) : photoBox;

  const renderLayers = (w, h, fit, keyPrefix, round) => (
    <>
      {/* Camada 0: iniciais (nunca tela preta). Camada 1: miniatura do cache
          (instantânea, sem fade). Camada 2: versão grande, fade ao carregar. */}
      <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="none">
        <View style={[styles.initialsDisc, round ? { width: w * 0.7, height: w * 0.7, borderRadius: w * 0.35 } : { width: w, height: h, borderRadius: 0 }]}>
          <Text style={[styles.fallbackInitials, { fontSize: Math.round(w * 0.26) }]} allowFontScaling={false}>{initials}</Text>
        </View>
      </View>
      {showImage ? (
        <ImageComponent
          source={avatarSource(thumbUri)} // [avatar-privacy-auth 2026-10-14]
          style={[StyleSheet.absoluteFill, { width: w, height: h }]}
          onError={() => setImgError(true)}
          onLoad={onThumbLoad}
          {...(ExpoImage ? { contentFit: fit, cachePolicy: 'memory-disk', transition: 0, recyclingKey: `${keyPrefix}-thumb#${_src.thumb || ''}` } : { resizeMode: fit })}
        />
      ) : null}
      {hasFull ? (
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: fullOpacity }]} pointerEvents="none">
          <ImageComponent
            source={avatarSource(fullUri)} // [avatar-privacy-auth 2026-10-14]
            style={{ width: w, height: h }}
            onLoad={onFullLoad}
            onError={() => setFullError(true)}
            {...(ExpoImage ? { contentFit: fit, cachePolicy: 'memory-disk', transition: 0, priority: 'high', recyclingKey: `${keyPrefix}-full#${fullUri}` } : { resizeMode: fit })}
          />
        </Animated.View>
      ) : null}
    </>
  );

  // ── Card actions (only the handlers the caller passed) ────────────────
  const actions = [];
  if (!isSelf) {
    if (typeof onMessage === 'function') actions.push({ key: 'msg', Icon: IconMessageCircle, label: tt('avatarLightbox.message', 'Mensagem'), fn: onMessage });
    if (!isGroup && typeof onCall === 'function') actions.push({ key: 'call', Icon: IconPhone, label: tt('avatarLightbox.call', 'Ligar'), fn: onCall });
    if (!isGroup && typeof onVideoCall === 'function') actions.push({ key: 'video', Icon: IconVideo, label: tt('avatarLightbox.video', 'Vídeo'), fn: onVideoCall });
    if (typeof onInfo === 'function') actions.push({ key: 'info', Icon: IconInfo, label: tt('avatarLightbox.info', 'Info'), fn: onInfo });
  }

  const cardSize = Math.min(CARD_MAX, winW - 64);
  const cardBg = colors?.surfaceElevated || (isDark ? '#1c1c1e' : '#ffffff');
  const fg = colors?.text || (isDark ? '#ffffff' : '#111111');
  const divider = colors?.divider || colors?.border || (isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.08)');

  const cardNode = (
    <>
      <BlurBackdrop isDark={isDark} dim={0.6} intensity={40} />
      <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel={tt('avatarLightbox.closePhoto', 'Fechar foto')} />
      <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="box-none">
        <Animated.View
          {...cardPan.panHandlers}
          style={[styles.card, { width: cardSize, backgroundColor: cardBg, transform: [{ translateY: cardY }, { scale: cardScale }] }]}
        >
          <Pressable
            onPress={openFull}
            accessibilityRole="imagebutton"
            accessibilityLabel={tt('avatarLightbox.viewPhoto', 'Ver foto')}
            style={{ width: cardSize, height: cardSize, backgroundColor: isDark ? '#111111' : '#e9e9eb' }}
          >
            {renderLayers(cardSize, cardSize, 'cover', 'avcard', false)}
            {displayName ? (
              <View style={styles.cardNameBar} pointerEvents="none">
                <Text style={styles.cardName} numberOfLines={1} allowFontScaling={false}>{displayName}</Text>
              </View>
            ) : null}
          </Pressable>
          {actions.length ? (
            <View style={[styles.actionsRow, { borderTopColor: divider }]}>
              {actions.map((a) => (
                <TouchableOpacity
                  key={a.key}
                  onPress={() => runAction(a.fn)}
                  style={styles.actionBtn}
                  accessibilityRole="button"
                  accessibilityLabel={a.label}
                  activeOpacity={0.6}
                >
                  <a.Icon size={22} color={fg} />
                  <Text style={[styles.actionLabel, { color: fg }]} numberOfLines={1} allowFontScaling={false}>{a.label}</Text>
                </TouchableOpacity>
              ))}
            </View>
          ) : null}
        </Animated.View>
      </View>
    </>
  );

  const fullNode = (
    <View style={[StyleSheet.absoluteFill, styles.fullRoot]}>
      {Platform.OS === 'android' && <StatusBar backgroundColor="#000" barStyle="light-content" />}
      <View style={[StyleSheet.absoluteFill, styles.center]} pointerEvents="box-none">
        <Animated.View
          {...panResponder.panHandlers}
          style={{ width: photoW, height: photoH, transform: [{ translateX }, { translateY }, { scale }, { scale: zoomIn }] }}
        >
          {renderLayers(photoW, photoH, 'contain', 'avlb', true)}
        </Animated.View>
      </View>
      {/* Top bar — back on the left, name centered. Never the e-mail. */}
      <View style={[styles.topBar, { paddingTop: insets.top + 4 }]} pointerEvents="box-none">
        <TouchableOpacity
          onPress={fullBack}
          style={styles.backBtn}
          accessibilityLabel={openedFromCardRef.current ? tt('avatarLightbox.back', 'Voltar') : tt('common.close', 'Fechar')}
          accessibilityRole="button"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
        >
          <IconChevronLeft size={28} color="#fff" />
        </TouchableOpacity>
        <View style={styles.topTitleWrap} pointerEvents="none">
          {displayName ? (
            <Text style={styles.topTitle} numberOfLines={1} allowFontScaling={false}>{displayName}</Text>
          ) : null}
        </View>
        <View style={styles.backBtn} pointerEvents="none" />
      </View>
    </View>
  );

  return (
    <Modal
      visible={!!visible && _secReady}
      transparent
      animationType="none"
      onRequestClose={view === 'full' ? fullBack : requestClose}
      statusBarTranslucent
    >
      <Animated.View style={[styles.root, { opacity }]}>
        {view === 'card' ? cardNode : fullNode}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  center: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  fullRoot: {
    backgroundColor: '#000000',
  },
  initialsDisc: {
    backgroundColor: '#1c1c1e',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fallbackInitials: {
    color: '#fff',
    fontWeight: '700',
  },
  card: {
    borderRadius: 16,
    overflow: 'hidden',
    shadowColor: '#000',
    shadowOpacity: 0.35,
    shadowRadius: 24,
    shadowOffset: { width: 0, height: 10 },
    elevation: 16,
  },
  cardNameBar: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    paddingHorizontal: 14,
    paddingVertical: 9,
    backgroundColor: 'rgba(0,0,0,0.38)',
  },
  cardName: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  actionsRow: {
    flexDirection: 'row',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  actionBtn: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
  },
  actionLabel: {
    fontSize: 12,
    fontWeight: '500',
    marginTop: 4,
  },
  topBar: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 8,
    paddingHorizontal: 4,
    backgroundColor: '#000000',
  },
  backBtn: {
    width: 44, height: 44,
    justifyContent: 'center', alignItems: 'center',
  },
  topTitleWrap: {
    flex: 1,
    alignItems: 'center',
    paddingHorizontal: 8,
  },
  topTitle: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
});
