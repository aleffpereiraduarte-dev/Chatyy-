// AvatarLightbox — fullscreen tap-to-view modal for profile photos.
//
// WAVE 95 (2026-05-21). User complaint: "se eu clico na foto de perfil do
// meu amigo deveria ficar grande pra eu ver". WhatsApp/Telegram-style:
// tap any AvatarCircle marked tappable → opens dark fullscreen with the
// full-size photo, pinch-zoom, double-tap-to-zoom, tap-out to dismiss.
//
// We don't reuse ChatMediaViewer here because:
//  1) ChatMediaViewer expects message context (messageId, conversationId,
//     view-once, share/star/report actions) and would download the avatar
//     into chat cache, polluting the media gallery
//  2) avatars are SMALL (a few hundred KB max), no need for paged neighbor
//     preload, blurhash placeholders, or HLS pipeline
//  3) lightbox feels different from media viewer — no bottom action bar,
//     no metadata header, just the photo. That's what users expect when
//     they tap an avatar.
import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, Modal, StyleSheet, Platform, TouchableOpacity,
  Animated, PanResponder, Dimensions, StatusBar, Pressable,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX } from './Icons';
import { useLanguage } from '../context/LanguageContext';
// [2026-10-14 avatar-instant] Abre INSTANTÂNEO (nível WhatsApp): mostra NA HORA a
// miniatura que a lista/cabeçalho já pintou (MESMA URL canônica → cache de
// memória/disco do expo-image ou do navegador) e carrega a versão grande
// (size=1024) por cima, com fade quando chega. Nada de tela preta/spinner:
// iniciais embaixo de tudo, miniatura, depois a grande.
import { avatarViewerSources, prefetchAvatarFull, avatarSource } from '../services/avatar';
import { getCachedAvatarUriOrNull } from '../services/avatarCache';

let ExpoImage = null;
if (Platform.OS !== 'web') {
  try { ExpoImage = require('expo-image').Image; } catch {}
}

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

export default function AvatarLightbox({ visible, onClose, email, uri, name }) {
  const insets = useSafeAreaInsets();
  const { t } = useLanguage();
  const [imgError, setImgError] = useState(false);
  const [fullError, setFullError] = useState(false);
  const fullOpacity = useRef(new Animated.Value(0)).current;
  const zoomIn = useRef(new Animated.Value(0.94)).current;
  const scale = useRef(new Animated.Value(1)).current;
  const translateX = useRef(new Animated.Value(0)).current;
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  // Track current scale/translation imperatively so the PanResponder math
  // doesn't fight Animated.Value updates mid-gesture.
  const stateRef = useRef({ scale: 1, lastScale: 1, tx: 0, ty: 0, lastTx: 0, lastTy: 0, pinchStartDist: 0 });

  useEffect(() => {
    if (visible) {
      setImgError(false);
      setFullError(false);
      fullOpacity.setValue(0);
      stateRef.current = { scale: 1, lastScale: 1, tx: 0, ty: 0, lastTx: 0, lastTy: 0, pinchStartDist: 0 };
      scale.setValue(1); translateX.setValue(0); translateY.setValue(0);
      zoomIn.setValue(0.94);
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 160, useNativeDriver: true }),
        Animated.spring(zoomIn, { toValue: 1, useNativeDriver: true, speed: 22, bounciness: 3 }),
      ]).start();
    } else {
      opacity.setValue(0);
    }
  }, [visible]);

  const requestClose = useCallback(() => {
    Animated.timing(opacity, { toValue: 0, duration: 150, useNativeDriver: true }).start(() => {
      try { onClose && onClose(); } catch {}
    });
  }, [onClose]);

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
  const onFullLoad = useCallback(() => {
    Animated.timing(fullOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
  }, [fullOpacity]);

  // Pinch-zoom: classic 2-finger handler. We don't pull in react-native-gesture-handler
  // because AvatarCircle is leaf-rendered everywhere and we want zero extra deps
  // for this lightbox.
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
        if (touches && touches.length === 2 && stateRef.current.pinchStartDist > 0) {
          const dx = touches[0].pageX - touches[1].pageX;
          const dy = touches[0].pageY - touches[1].pageY;
          const dist = Math.sqrt(dx * dx + dy * dy);
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
        } else {
          // At rest scale — vertical swipe-down dismisses.
          if (g.dy > 0) {
            translateY.setValue(g.dy);
            opacity.setValue(Math.max(0.2, 1 - g.dy / SCREEN_H));
          }
        }
      },
      onPanResponderRelease: (_, g) => {
        // Swipe-down to dismiss when not zoomed.
        if (stateRef.current.scale <= 1.02 && g.dy > 120 && Math.abs(g.dx) < 200) {
          requestClose();
          return;
        }
        // Snap back to center when slightly off
        stateRef.current.lastScale = stateRef.current.scale;
        stateRef.current.lastTx = stateRef.current.tx;
        stateRef.current.lastTy = stateRef.current.ty;
        stateRef.current.pinchStartDist = 0;
        if (stateRef.current.scale < 1.05) {
          // Reset to 1 with spring
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

  const ImageComponent = ExpoImage || require('react-native').Image;
  const showImage = !!thumbUri && !imgError;

  // Initials fallback so we still show SOMETHING if the avatar 404s.
  const initials = (() => {
    const src = (name && typeof name === 'string' && name.trim()) ? name.trim() : (email ? String(email).split('@')[0] : '');
    if (!src) return '?';
    const parts = src.split(/[\s._\-]+/).filter(Boolean);
    if (parts.length >= 2) return ((parts[0][0] || '') + (parts[1][0] || '')).toUpperCase();
    return (parts[0]?.slice(0, 2) || '?').toUpperCase();
  })();

  return (
    <Modal visible={!!visible} transparent animationType="none" onRequestClose={requestClose} statusBarTranslucent>
      {/* eslint-disable-next-line react-native/no-inline-styles */}
      <Animated.View style={[styles.root, { opacity }]}>
        {Platform.OS === 'android' && <StatusBar backgroundColor="#000" barStyle="light-content" />}
        {/* Tap-out backdrop. We capture taps that aren't part of a pan gesture. */}
        <Pressable style={StyleSheet.absoluteFill} onPress={requestClose} accessibilityLabel={t('avatarLightbox.closePhoto')}>
          <View style={StyleSheet.absoluteFill} />
        </Pressable>

        {/* Photo + pan/pinch wrapper. Lives ABOVE the backdrop so gestures route here first. */}
        <Animated.View
          {...panResponder.panHandlers}
          style={[
            styles.imageWrap,
            { transform: [{ translateX }, { translateY }, { scale }, { scale: zoomIn }] },
          ]}
        >
          {/* Camada 0: iniciais (nunca tela preta). Camada 1: miniatura do cache
              (instantânea, sem fade). Camada 2: versão grande, fade ao carregar. */}
          <View style={[styles.fallback, styles.fallbackCenter]} pointerEvents="none">
            <Text style={styles.fallbackInitials} allowFontScaling={false}>{initials}</Text>
          </View>
          {showImage ? (
            <ImageComponent
              source={avatarSource(thumbUri)} // [avatar-privacy-auth 2026-10-14]
              style={[styles.image, StyleSheet.absoluteFill]}
              onError={() => setImgError(true)}
              {...(ExpoImage ? { contentFit: 'contain', cachePolicy: 'memory-disk', transition: 0, recyclingKey: `avlb-thumb#${_src.thumb || ''}` } : { resizeMode: 'contain' })}
            />
          ) : null}
          {hasFull ? (
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: fullOpacity }]} pointerEvents="none">
              <ImageComponent
                source={avatarSource(fullUri)} // [avatar-privacy-auth 2026-10-14]
                style={styles.image}
                onLoad={onFullLoad}
                onError={() => setFullError(true)}
                {...(ExpoImage ? { contentFit: 'contain', cachePolicy: 'memory-disk', transition: 0, priority: 'high', recyclingKey: `avlb-full#${fullUri}` } : { resizeMode: 'contain' })}
              />
            </Animated.View>
          ) : null}
        </Animated.View>

        {/* Header — name + close button. Sits above wrapper so it stays tappable. */}
        <View style={[styles.header, { paddingTop: insets.top + 8 }]} pointerEvents="box-none">
          <View style={{ flex: 1, paddingHorizontal: 16 }} pointerEvents="none">
            {name ? (
              <Text style={styles.headerName} numberOfLines={1} allowFontScaling={false}>{name}</Text>
            ) : null}
            {email && email !== name ? (
              <Text style={styles.headerEmail} numberOfLines={1} allowFontScaling={false}>{email}</Text>
            ) : null}
          </View>
          <TouchableOpacity
            onPress={requestClose}
            style={styles.closeBtn}
            accessibilityLabel={t('common.close')}
            accessibilityRole="button"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <IconX size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.96)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  imageWrap: {
    width: SCREEN_W,
    height: SCREEN_W,
    justifyContent: 'center',
    alignItems: 'center',
  },
  image: {
    width: SCREEN_W,
    height: SCREEN_W,
  },
  fallback: {
    width: SCREEN_W * 0.7,
    height: SCREEN_W * 0.7,
    borderRadius: (SCREEN_W * 0.7) / 2,
    backgroundColor: '#111111',
    justifyContent: 'center',
    alignItems: 'center',
  },
  fallbackCenter: {
    // fallback ocupa o centro do quadrado da foto (absoluteFill + mesmo círculo)
    position: 'absolute',
    left: SCREEN_W * 0.15,
    top: SCREEN_W * 0.15,
  },
  fallbackInitials: {
    color: '#fff',
    fontWeight: '700',
    fontSize: 96,
  },
  header: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    paddingBottom: 10,
    paddingHorizontal: 6,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  headerName: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '600',
  },
  headerEmail: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 13,
    marginTop: 1,
  },
  closeBtn: {
    width: 40, height: 40, borderRadius: 20,
    justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    marginRight: 8,
  },
});
