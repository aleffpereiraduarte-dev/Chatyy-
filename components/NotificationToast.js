import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, Animated, Platform, Dimensions } from 'react-native';
import { PanGestureHandler, State as GHState } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { Colors, FontSize, BorderRadius, Spacing, Shadow } from '../constants/theme';
import { SPRING_GENTLE } from '../utils/animations';
import { useLanguage } from '../context/LanguageContext';
import { IconMail, IconMessageSquare, IconVideo, IconBell, IconX, IconReply } from './Icons';
import { playNotificationAlert, triggerHaptic } from '../services/notificationSound';

const TOAST_DURATION = 4000;
const SWIPE_DISMISS_THRESHOLD = -60;
const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Determine notification type from data
function getNotificationType(data) {
  if (!data) return 'email';
  if (data.type === 'chat_message') return 'chat';
  if (data.type === 'meeting_reminder') return 'meeting';
  if (data.type === 'live' || data.type === 'live_start') return 'live';
  return 'email';
}

// Type-specific accent colors
const TYPE_ACCENTS = {
  email: { light: '#2563eb', dark: '#60a5fa' },
  chat: { light: '#10b981', dark: '#34d399' },
  meeting: { light: '#111111', dark: '#111111' },
  live: { light: '#dc2626', dark: '#f87171' },
};

// Avatar color from name
function getAvatarColor(name) {
  const colors = ['#5C5C5C', '#4A4A4A', '#6B6B6B', '#3D3D3D', '#545454', '#636363']; // [2026-10-10] P&B neutro
  let hash = 0;
  for (let i = 0; i < (name || '').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  return colors[Math.abs(hash) % colors.length];
}

// Get initials from name (skip emojis)
function getInitials(name) {
  if (!name) return '?';
  const clean = name.replace(/^[\u{1F300}-\u{1FAD6}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\s]+/u, '').trim();
  if (!clean) return name.substring(0, 1);
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  return parts[0].substring(0, 2).toUpperCase();
}

// Urgency colors
function getUrgencyStyle(data, isDark) {
  if (data?.urgency === 'high') return { borderColor: isDark ? '#f87171' : '#dc2626', borderWidth: 1.5 };
  return { borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)', borderWidth: 0.5 };
}

// Category badge keys
const CATEGORY_STYLES = {
  action_required: { key: 'toast.categoryAction', color: '#dc2626', bg: '#fef2f2' },
  finance: { key: 'toast.categoryFinance', color: '#d97706', bg: '#fffbeb' },
  calendar: { key: 'toast.categoryCalendar', color: '#111111', bg: '#F1F3F5' },
  security: { key: 'toast.categorySecurity', color: '#dc2626', bg: '#fef2f2' },
  shipping: { key: 'toast.categoryShipping', color: '#0d9488', bg: '#f0fdfa' },
  work: { key: 'toast.categoryWork', color: '#2563eb', bg: '#eff6ff' },
  social: { key: 'toast.categorySocial', color: '#e11d48', bg: '#fff1f2' },
  newsletter: { key: 'toast.categoryNewsletter', color: '#475569', bg: '#f1f5f9' },
};

// Type icon component
function TypeIcon({ type, color, size = 16 }) {
  switch (type) {
    case 'chat':
      return <IconMessageSquare size={size} color={color} />;
    case 'meeting':
      return <IconVideo size={size} color={color} />;
    case 'live':
      // Pulsing red dot — chosen over a generic camera/play icon because
      // every other live surface in the app uses the heartbeat dot
      // vocabulary (LiveIndicator, LiveBar, profile CTA). Keeps the brand
      // language consistent.
      return <LivePulseDot size={size} />;
    case 'email':
    default:
      return <IconMail size={size} color={color} />;
  }
}

// Pulsing red dot for the live notification type icon badge. Native-driven
// opacity loop, mounted once when the toast is up so the work stops when
// the toast dismisses.
function LivePulseDot({ size = 16 }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 0.35, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  return (
    <Animated.View style={{
      width: size * 0.55,
      height: size * 0.55,
      borderRadius: size,
      backgroundColor: '#dc2626',
      opacity: pulse,
    }} />
  );
}

// Type label key
function getTypeLabel(type) {
  switch (type) {
    case 'chat': return 'toast.typeChat';
    case 'meeting': return 'toast.typeMeeting';
    case 'live': return 'live.aoVivo';
    case 'email':
    default: return 'toast.typeEmail';
  }
}

// ─── [2026-10-16 native-toast] Banner NATIVO (modules/expo-inapp-banner) ───
// iOS/Android com o módulo: o banner é desenhado, animado (molas UIKit /
// ViewPropertyAnimator, 120 Hz) e arrastado na UI thread — não trava com o JS.
// Kill switch: globalThis.__chatyy_native_toast = false → toast JS abaixo.
let _bannerMod;
function _nativeBanner() {
  if (Platform.OS === 'web') return null;
  try { if (globalThis.__chatyy_native_toast === false) return null; } catch {}
  if (_bannerMod === undefined) {
    try { _bannerMod = require('../modules/expo-inapp-banner'); } catch { _bannerMod = null; }
  }
  try { return _bannerMod && _bannerMod.isAvailable() ? _bannerMod : null; } catch { return null; }
}

const CHAT_OPEN_TYPES = /^(chat_message|chat_mention|chat_keyword|voicemail|group|group_message)$/;
const CHAT_REPLY_TYPES = /^(chat_message|chat_mention|chat_keyword|group|group_message)$/;

function _absUrl(u) {
  if (!u || typeof u !== 'string') return '';
  if (/^(https?:|file:)/i.test(u)) return u;
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return 'https://chatyy.com.br' + u;
  return '';
}

function _avatarUrlFor(data) {
  const d = data || {};
  const direct = d.sender_avatar || d.from_avatar || d.avatar_url || d.avatar || '';
  if (direct) return _absUrl(String(direct));
  // push de e-mail: push-notify.php manda o avatar do remetente em `image`
  if (typeof d.image === 'string' && d.image.indexOf('get_avatar') >= 0) return _absUrl(d.image);
  return '';
}

// Toque no banner/toast → abre o destino (conta certa primeiro; chat pelo
// handler compartilhado do push: troca de conta + replace em vez de empilhar).
function _openFromNotificationData(data) {
  if (data && data.conversation_id && CHAT_OPEN_TYPES.test(String(data.type || ''))) {
    try { require('../services/pushNotifications').handleNotificationNavigation(data); } catch {
      require('../services/openConversation').openConversation(`/chat-conversation?id=${data.conversation_id}`);
    }
    return;
  }
  if (data?.recipient_email) {
    try {
      const pn = require('../services/pushNotifications');
      pn.ensureNotificationAccount(data).then((ok) => { if (ok) _toastNavigate(data); });
      return;
    } catch {}
  }
  _toastNavigate(data);
}

function _toastNavigate(data) {
  if (data?.type === 'meeting_reminder' && data?.room_id) {
    router.push(`/meeting-detail?room_id=${data.room_id}`);
  } else if ((data?.type === 'live' || data?.type === 'live_start') && data?.session_id) {
    // Live broadcast started by a friend — jump straight into the viewer.
    // Pass host_email + host_name so the live-viewer's connecting overlay
    // already shows the right avatar instead of a "?" placeholder while
    // WebRTC handshakes. The session id is canonical (chat_live_sessions
    // PG row), so the viewer subscribes to the right WS room on mount.
    const params = new URLSearchParams();
    params.set('sessionId', data.session_id);
    if (data.host_email) params.set('hostEmail', data.host_email);
    if (data.host_name) params.set('hostName', data.host_name);
    router.push(`/live-viewer?${params.toString()}`);
  } else if (data?.type === 'new_email' && data?.uid) {
    const folder = data.folder || 'INBOX';
    router.push(`/read?uid=${data.uid}&folder=${encodeURIComponent(folder)}`);
  } else {
    router.push('/inbox');
  }
}

function _playAlert(notifType) {
  if (Platform.OS !== 'web') {
    try { triggerHaptic(notifType); } catch {}
  }
  let notifPrefs = {};
  try {
    if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
      const stored = localStorage.getItem('chatyy_notif_prefs');
      if (stored) notifPrefs = JSON.parse(stored);
    }
  } catch {}
  try { playNotificationAlert(notifPrefs, notifType); } catch {}
}

let _bannerSeq = 0;

export default function NotificationToast({ notification, onDismiss }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(-160)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.92)).current;
  const progressAnim = useRef(new Animated.Value(1)).current;
  // [2026-10-16 native-toast] arrasto = translationY do RNGH ligado por
  // Animated.event com native driver (antes PanResponder no JS → travava).
  const dragY = useRef(new Animated.Value(0)).current;
  const swipeAnim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);
  const [isVisible, setIsVisible] = useState(false);
  const dismissingRef = useRef(false);
  // Banner nativo: id atual + dados por id (eventos chegam assíncronos).
  const nativeIdRef = useRef(null);
  const nativeDataRef = useRef(new Map());
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  // Notificação que o nativo NÃO conseguiu mostrar → cai no toast JS.
  const [jsFallbackFor, setJsFallbackFor] = useState(null);
  const useJs = !_nativeBanner() || (notification && jsFallbackFor === notification);

  // Eventos do banner nativo (uma vez).
  useEffect(() => {
    const nb = _nativeBanner();
    if (!nb) return undefined;
    const subs = [
      nb.addListener('onBannerPress', (e) => {
        const data = nativeDataRef.current.get(e?.id);
        if (data !== undefined) _openFromNotificationData(data);
      }),
      nb.addListener('onBannerReply', (e) => {
        const data = nativeDataRef.current.get(e?.id);
        const text = String(e?.text || '').trim();
        if (!data || !data.conversation_id || !text) return;
        try { require('../services/pushNotifications').sendQuickReplyFromBanner?.(data, text); } catch {}
      }),
      nb.addListener('onBannerDismiss', (e) => {
        const id = e?.id;
        // Limpa depois: o press chega antes do dismiss, mas por garantia.
        setTimeout(() => { nativeDataRef.current.delete(id); }, 2000);
        if (id && id === nativeIdRef.current) {
          nativeIdRef.current = null;
          onDismissRef.current?.();
        }
      }),
    ];
    return () => { subs.forEach((s) => { try { s.remove(); } catch {} }); };
  }, []);

  // Mostra no nativo.
  useEffect(() => {
    if (!notification) return;
    const nb = _nativeBanner();
    if (!nb || jsFallbackFor === notification) return;
    const data = notification.data || {};
    const notifType = getNotificationType(data);
    const title = notification.title || t('toast.newEmail');
    const id = `b${++_bannerSeq}`;
    nativeIdRef.current = id;
    nativeDataRef.current.set(id, data);
    _playAlert(notifType);
    const canReply = !!(data.conversation_id && CHAT_REPLY_TYPES.test(String(data.type || '')));
    const reply = t('chatConv.reply');
    const enter = t('live.enter');
    nb.show({
      id,
      title,
      body: notification.body || '',
      meta: t('toast.now'),
      avatarUrl: _avatarUrlFor(data),
      initials: getInitials(data.from || title),
      avatarColor: getAvatarColor(data.from || title),
      accent: TYPE_ACCENTS[notifType]?.[isDark ? 'dark' : 'light'] || '#10b981',
      dark: !!isDark,
      urgent: data.urgency === 'high',
      durationMs: TOAST_DURATION,
      canReply,
      replyPlaceholder: ((reply && reply !== 'chatConv.reply') ? reply : 'Responder') + '…',
      actionLabel: notifType === 'live' ? ((enter && enter !== 'live.enter') ? enter : 'Entrar') : '',
      closeLabel: t('common.close'),
    }).then((ok) => {
      if (!ok && nativeIdRef.current === id) {
        nativeIdRef.current = null;
        setJsFallbackFor(notification);
      }
    });
  }, [notification]);

  // Desmontou com banner nativo na tela → tira.
  useEffect(() => () => {
    if (nativeIdRef.current) { try { _nativeBanner()?.dismiss(nativeIdRef.current); } catch {} }
  }, []);

  useEffect(() => {
    if (!notification || !useJs) return;
    dismissingRef.current = false;
    setIsVisible(true);

    // Reset animations
    progressAnim.setValue(1);
    swipeAnim.setValue(0);
    dragY.setValue(0);
    slideAnim.setValue(-160);
    opacityAnim.setValue(0);
    scaleAnim.setValue(0.92);

    const notifType = getNotificationType(notification.data);
    // jsFallbackFor: o efeito nativo já tocou som/vibração.
    if (jsFallbackFor !== notification) _playAlert(notifType);

    // Slide in. Why: SPRING_BOUNCY overshot then bobbed for ~600ms — felt like
    // a notification "fell out of the sky". Tightened to a snappy spring
    // (tension 220, friction 22) so the toast lands clean and stays put.
    // Scale settles at a slightly softer rate so the avatar doesn't pop.
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 220, friction: 22,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        tension: 200, friction: 18,
        useNativeDriver: true,
      }),
    ]).start();

    // Progress bar countdown — [2026-10-16 native-toast] scaleX (origem à
    // esquerda) com native driver; antes animava `width` no JS a 60 fps.
    const progress = Animated.timing(progressAnim, {
      toValue: 0,
      duration: TOAST_DURATION,
      useNativeDriver: true,
    });
    progress.start();

    timerRef.current = setTimeout(() => dismiss(), TOAST_DURATION);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      progress.stop();
      slideAnim.stopAnimation();
      opacityAnim.stopAnimation();
      scaleAnim.stopAnimation();
    };
  }, [notification, useJs]);

  const dismiss = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: -160,
        ...SPRING_GENTLE,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 220,
        useNativeDriver: true,
      }),
      Animated.spring(scaleAnim, {
        toValue: 0.92,
        ...SPRING_GENTLE,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setIsVisible(false);
      onDismiss?.();
    });
  }, [onDismiss]);

  const swipeDismiss = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    // Haptic on swipe-to-dismiss — confirms the gesture registered. Before,
    // the toast just silently disappeared and users doubted whether their
    // swipe did anything.
    try {
      if (Platform.OS !== 'web') {
        // [2026-10-18 polish2] via services/haptics (Core Haptics + pref "Vibração ao tocar").
        require('../services/haptics').hapticEvent('sheetClose');
      }
    } catch {}
    Animated.parallel([
      Animated.timing(swipeAnim, {
        toValue: -200,
        duration: 180,
        useNativeDriver: true,
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: true,
      }),
    ]).start(() => {
      setIsVisible(false);
      onDismiss?.();
    });
  }, [onDismiss]);

  // Arrasto (RNGH, native driver): só p/ cima segue o dedo; p/ baixo resiste.
  const onPanEvent = useRef(Animated.event(
    [{ nativeEvent: { translationY: dragY } }],
    { useNativeDriver: Platform.OS !== 'web' },
  )).current;
  const onPanState = useCallback((e) => {
    const ne = e?.nativeEvent || {};
    if (ne.state === GHState.BEGAN || ne.state === GHState.ACTIVE) {
      if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
      return;
    }
    if (ne.state !== GHState.END && ne.state !== GHState.CANCELLED && ne.state !== GHState.FAILED) return;
    const ty = Number(ne.translationY) || 0;
    const vy = Number(ne.velocityY) || 0;
    if (ne.state === GHState.END && (ty < SWIPE_DISMISS_THRESHOLD || vy < -500)) {
      swipeDismiss();
      return;
    }
    Animated.spring(dragY, { toValue: 0, ...SPRING_GENTLE, useNativeDriver: Platform.OS !== 'web' }).start();
    if (!dismissingRef.current) {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => dismiss(), TOAST_DURATION / 2);
    }
  }, [swipeDismiss, dismiss]);
  const dragClamped = useRef(dragY.interpolate({
    inputRange: [-400, 0, 400],
    outputRange: [-400, 0, 36],
    extrapolate: 'clamp',
  })).current;

  const handleTap = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const data = notification?.data;
    dismiss();
    _openFromNotificationData(data);
  }, [notification, dismiss]);

  if (!useJs || !isVisible || !notification) return null;

  const title = notification.title || t('toast.newEmail');
  const body = notification.body || '';
  const data = notification.data || {};
  const notifType = getNotificationType(data);
  const subtitle = data.subtitle || notification.subtitle || null;
  const actionHint = data.actionHint || null;
  const avatarColor = getAvatarColor(data.from || title);
  const initials = getInitials(data.from || title);
  const urgencyStyle = getUrgencyStyle(data, isDark);
  const catStyle = CATEGORY_STYLES[data?.category];
  const categoryBadge = catStyle ? { label: t(catStyle.key), color: catStyle.color, bg: catStyle.bg } : null;
  const isAI = data.ai === true;
  const maxWidth = Platform.OS === 'web' ? 420 : SCREEN_WIDTH - 20;
  const accentColor = TYPE_ACCENTS[notifType]?.[isDark ? 'dark' : 'light'] || colors.primary;

  return (
    <PanGestureHandler
      onGestureEvent={onPanEvent}
      onHandlerStateChange={onPanState}
      activeOffsetY={[-8, 8]}
      failOffsetX={[-24, 24]}
    >
    <Animated.View
      style={{
        position: 'absolute',
        top: insets.top + (Platform.OS === 'ios' ? 4 : 12),
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 9999,
        transform: [
          { translateY: Animated.add(Animated.add(slideAnim, swipeAnim), dragClamped) },
          { scale: scaleAnim },
        ],
        opacity: opacityAnim,
      }}
    >
      <TouchableOpacity
        activeOpacity={0.88}
        onPress={handleTap}
        style={{
          maxWidth,
          width: '94%',
          // Glass: stronger transparency + heavier blur on web. Native still uses
          // mostly-opaque rgba since RN doesn't support backdropFilter.
          backgroundColor: Platform.OS === 'web'
            ? (isDark ? 'rgba(24, 28, 42, 0.72)' : 'rgba(255, 255, 255, 0.72)')
            : (isDark ? 'rgba(30, 41, 55, 0.98)' : 'rgba(255, 255, 255, 0.98)'),
          borderRadius: 20,
          overflow: 'hidden',
          ...Shadow.xl,
          ...(Platform.OS === 'web' ? {
            backdropFilter: 'blur(32px) saturate(180%)',
            WebkitBackdropFilter: 'blur(32px) saturate(180%)',
            boxShadow: isDark
              ? '0 12px 40px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.06)'
              : '0 12px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06), inset 0 1px 0 rgba(255,255,255,0.6)',
            cursor: 'pointer',
          } : {}),
          ...(Platform.OS === 'ios' ? {
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 8 },
            shadowOpacity: isDark ? 0.35 : 0.12,
            shadowRadius: 20,
          } : {}),
          ...urgencyStyle,
        }}
      >
        {/* Swipe hint bar — matches reels comments handle (R21) for consistency */}
        <View style={{
          alignItems: 'center',
          paddingTop: 7,
          paddingBottom: 2,
        }}>
          <View style={{
            width: 40,
            height: 5,
            borderRadius: 3,
            backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.10)',
          }} />
        </View>

        {/* Main content row */}
        <View style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          paddingHorizontal: 14,
          paddingBottom: actionHint ? 8 : 12,
          paddingTop: 6,
        }}>
          {/* Avatar with type icon overlay */}
          <View style={{ position: 'relative', marginRight: 12 }}>
            <View style={{
              width: 46,
              height: 46,
              borderRadius: 23,
              backgroundColor: avatarColor,
              alignItems: 'center',
              justifyContent: 'center',
              // Subtle purple ring — brand-aware, soft.
              borderWidth: 2,
              borderColor: isDark ? 'rgba(17, 17, 17,0.55)' : 'rgba(17, 17, 17,0.35)',
            }}>
              <Text style={{
                color: '#fff',
                fontSize: 17,
                fontWeight: '700',
                letterSpacing: 0.3,
              }}>
                {initials}
              </Text>
            </View>
            {/* Type icon badge (bottom-right) */}
            <View style={{
              position: 'absolute',
              bottom: -3,
              right: -3,
              width: 22,
              height: 22,
              borderRadius: 11,
              backgroundColor: colors.surface,
              alignItems: 'center',
              justifyContent: 'center',
              shadowColor: '#000',
              shadowOffset: { width: 0, height: 1 },
              shadowOpacity: 0.15,
              shadowRadius: 2,
              elevation: 2,
              ...(Platform.OS === 'web' ? {
                boxShadow: '0 1px 3px rgba(0,0,0,0.12)',
              } : {}),
            }}>
              {data.emoji ? (
                <Text style={{ fontSize: 12 }}>{data.emoji}</Text>
              ) : (
                <TypeIcon type={notifType} color={accentColor} size={12} />
              )}
            </View>
          </View>

          {/* Text content */}
          <View style={{ flex: 1 }}>
            {/* Top row: app name + type label + time */}
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 3 }}>
              <Text style={{
                fontSize: 11,
                fontWeight: '700',
                color: accentColor,
                letterSpacing: 0.6,
                textTransform: 'uppercase',
              }}>
                {t(getTypeLabel(notifType))}
              </Text>
              {isAI && (
                <View style={{
                  marginLeft: 6,
                  backgroundColor: 'rgba(17, 17, 17, 0.1)',
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 9, fontWeight: '700', color: colors.primary, letterSpacing: 0.3 }}>AI</Text>
                </View>
              )}
              <Text style={{
                fontSize: 11,
                color: colors.textTertiary,
                marginLeft: 'auto',
              }}>
                {t('toast.now')}
              </Text>
            </View>

            {/* Title (sender) */}
            <Text
              numberOfLines={1}
              style={{
                fontSize: 15,
                fontWeight: '700',
                color: colors.text,
                marginBottom: 2,
              }}
            >
              {title}
            </Text>

            {/* Body (message/subject) */}
            <Text
              numberOfLines={2}
              style={{
                fontSize: 13.5,
                color: colors.textSecondary,
                lineHeight: 19,
                letterSpacing: -0.1,
                fontWeight: '500',
              }}
            >
              {body}
            </Text>

            {/* Category badge */}
            {categoryBadge && (
              <View style={{
                alignSelf: 'flex-start',
                marginTop: 6,
                backgroundColor: categoryBadge.bg,
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 10,
              }}>
                <Text style={{
                  fontSize: 10.5,
                  fontWeight: '600',
                  color: categoryBadge.color,
                  letterSpacing: 0.2,
                }}>
                  {categoryBadge.label}
                </Text>
              </View>
            )}
          </View>

          {/* For live broadcasts: surface a red "Entrar" action pill instead
              of the bare dismiss X \u2014 the friend's stream is the actionable
              thing, not "ok thanks". Tap fires handleTap so the navigation
              + dismiss path stays unified. The X stays accessible via the
              swipe-up gesture. */}
          {notifType === 'live' ? (
            <TouchableOpacity
              onPress={(e) => {
                e.stopPropagation?.();
                handleTap();
              }}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={{
                marginLeft: 8,
                paddingHorizontal: 12,
                paddingVertical: 7,
                borderRadius: 12,
                backgroundColor: '#dc2626',
                alignItems: 'center',
                justifyContent: 'center',
                ...(Platform.OS === 'web' ? { boxShadow: '0 2px 8px rgba(220,38,38,0.35)' } : {}),
              }}
              accessibilityRole="button"
              accessibilityLabel={t('live.enter') || 'Entrar'}
            >
              <Text style={{ fontSize: 12, color: '#fff', fontWeight: '800', letterSpacing: 0.4 }}>
                {(t('live.enter') || 'Entrar').toUpperCase()}
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={(e) => {
                e.stopPropagation?.();
                if (timerRef.current) clearTimeout(timerRef.current);
                dismiss();
              }}
              accessibilityRole="button"
              accessibilityLabel={t('common.close')}
              hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
              style={{
                marginLeft: 8,
                width: 22,
                height: 22,
                borderRadius: 11,
                backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.05)',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <IconX size={11} color={colors.textTertiary} />
            </TouchableOpacity>
          )}
        </View>

        {/* Action hint bar */}
        {actionHint && (
          <View style={{
            flexDirection: 'row',
            alignItems: 'center',
            paddingHorizontal: 14,
            paddingBottom: 10,
            paddingTop: 2,
          }}>
            <View style={{
              backgroundColor: colors.primaryLight,
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 12,
              flexDirection: 'row',
              alignItems: 'center',
            }}>
              <View style={{ marginRight: 4 }}><IconReply size={12} color={colors.primary} /></View>
              <Text style={{
                fontSize: 12,
                fontWeight: '600',
                color: colors.primary,
              }}>
                {actionHint}
              </Text>
            </View>
          </View>
        )}

        {/* Progress bar — bumped opacity (0.7→0.9) so the time-remaining cue
            actually reads as a countdown, not a faint smear.
            Web: brand-gradient (lavender → purple) for that signature Chatyy
            sheen. Native: solid accent (LinearGradient on web only avoids an
            extra dep here). High-urgency overrides to error red. */}
        <Animated.View
          style={{
            height: 3,
            borderBottomLeftRadius: 20,
            borderBottomRightRadius: 0,
            backgroundColor: data.urgency === 'high' ? colors.error : accentColor,
            opacity: 0.95,
            width: '100%',
            transformOrigin: 'left',
            transform: [{ scaleX: progressAnim }],
            ...(Platform.OS === 'web' && data.urgency !== 'high' ? {
              backgroundImage: 'linear-gradient(90deg, #111111 0%, #111111 100%)',
              backgroundColor: 'transparent',
            } : {}),
          }}
        />
      </TouchableOpacity>
    </Animated.View>
    </PanGestureHandler>
  );
}
