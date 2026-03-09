import { useEffect, useRef, useState, useCallback } from 'react';
import { View, Text, TouchableOpacity, Animated, Platform, Dimensions, PanResponder } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useTheme } from '../context/ThemeContext';
import { Colors, FontSize, BorderRadius, Spacing, Shadow } from '../constants/theme';
import { SPRING_BOUNCY, SPRING_GENTLE, fadeIn } from '../utils/animations';
import { useLanguage } from '../context/LanguageContext';
import { IconMail, IconMessageSquare, IconVideo, IconBell } from './Icons';
import { playNotificationAlert, triggerHaptic } from '../services/notificationSound';

const TOAST_DURATION = 4000;
const SWIPE_DISMISS_THRESHOLD = -60;
const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Determine notification type from data
function getNotificationType(data) {
  if (!data) return 'email';
  if (data.type === 'chat_message') return 'chat';
  if (data.type === 'meeting_reminder') return 'meeting';
  return 'email';
}

// Type-specific accent colors
const TYPE_ACCENTS = {
  email: { light: '#2563eb', dark: '#60a5fa' },
  chat: { light: '#10b981', dark: '#34d399' },
  meeting: { light: '#8b5cf6', dark: '#c084fc' },
};

// Avatar color from name
function getAvatarColor(name) {
  const colors = ['#2563eb', '#16a34a', '#dc2626', '#f59e0b', '#8b5cf6', '#ea580c', '#0d9488', '#e11d48'];
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
  calendar: { key: 'toast.categoryCalendar', color: '#7c3aed', bg: '#f5f3ff' },
  security: { key: 'toast.categorySecurity', color: '#dc2626', bg: '#fef2f2' },
  shipping: { key: 'toast.categoryShipping', color: '#0d9488', bg: '#f0fdfa' },
  work: { key: 'toast.categoryWork', color: '#2563eb', bg: '#eff6ff' },
  social: { key: 'toast.categorySocial', color: '#e11d48', bg: '#fff1f2' },
  newsletter: { key: 'toast.categoryNewsletter', color: '#64748b', bg: '#f8fafc' },
};

// Type icon component
function TypeIcon({ type, color, size = 16 }) {
  switch (type) {
    case 'chat':
      return <IconMessageSquare size={size} color={color} />;
    case 'meeting':
      return <IconVideo size={size} color={color} />;
    case 'email':
    default:
      return <IconMail size={size} color={color} />;
  }
}

// Type label key
function getTypeLabel(type) {
  switch (type) {
    case 'chat': return 'toast.typeChat';
    case 'meeting': return 'toast.typeMeeting';
    case 'email':
    default: return 'toast.typeEmail';
  }
}

export default function NotificationToast({ notification, onDismiss }) {
  const { colors, isDark } = useTheme();
  const { t } = useLanguage();
  const insets = useSafeAreaInsets();
  const slideAnim = useRef(new Animated.Value(-160)).current;
  const opacityAnim = useRef(new Animated.Value(0)).current;
  const scaleAnim = useRef(new Animated.Value(0.92)).current;
  const progressAnim = useRef(new Animated.Value(1)).current;
  const swipeAnim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);
  const [isVisible, setIsVisible] = useState(false);
  const dismissingRef = useRef(false);

  // Swipe-to-dismiss PanResponder
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gestureState) => {
        // Only capture vertical upward swipes
        return Math.abs(gestureState.dy) > 8 && gestureState.dy < 0 && Math.abs(gestureState.dy) > Math.abs(gestureState.dx);
      },
      onPanResponderGrant: () => {
        // Pause auto-dismiss timer during swipe
        if (timerRef.current) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }
      },
      onPanResponderMove: (_, gestureState) => {
        // Only allow upward movement (negative dy)
        if (gestureState.dy < 0) {
          swipeAnim.setValue(gestureState.dy);
        }
      },
      onPanResponderRelease: (_, gestureState) => {
        if (gestureState.dy < SWIPE_DISMISS_THRESHOLD || gestureState.vy < -0.5) {
          // Swipe far enough or fast enough — dismiss
          swipeDismiss();
        } else {
          // Snap back
          Animated.spring(swipeAnim, {
            toValue: 0,
            ...SPRING_GENTLE,
            useNativeDriver: Platform.OS !== 'web',
          }).start();
          // Restart auto-dismiss timer
          timerRef.current = setTimeout(() => dismiss(), TOAST_DURATION / 2);
        }
      },
    })
  ).current;

  useEffect(() => {
    if (!notification) return;
    dismissingRef.current = false;
    setIsVisible(true);

    // Reset animations
    progressAnim.setValue(1);
    swipeAnim.setValue(0);
    slideAnim.setValue(-160);
    opacityAnim.setValue(0);
    scaleAnim.setValue(0.92);

    const notifType = getNotificationType(notification.data);

    // Haptic feedback on native
    if (Platform.OS !== 'web') {
      triggerHaptic(notifType);
    }

    // Load Chatyy notification prefs and play sound
    let notifPrefs = {};
    try {
      if (Platform.OS === 'web' && typeof localStorage !== 'undefined') {
        const stored = localStorage.getItem('chatyy_notif_prefs');
        if (stored) notifPrefs = JSON.parse(stored);
      }
    } catch {}
    playNotificationAlert(notifPrefs, notifType);

    // Slide in with spring
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: 0,
        ...SPRING_BOUNCY,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(opacityAnim, {
        toValue: 1,
        duration: 200,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.spring(scaleAnim, {
        toValue: 1,
        ...SPRING_BOUNCY,
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]).start();

    // Progress bar countdown
    Animated.timing(progressAnim, {
      toValue: 0,
      duration: TOAST_DURATION,
      useNativeDriver: false,
    }).start();

    timerRef.current = setTimeout(() => dismiss(), TOAST_DURATION);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [notification]);

  const dismiss = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    Animated.parallel([
      Animated.spring(slideAnim, {
        toValue: -160,
        ...SPRING_GENTLE,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 220,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.spring(scaleAnim, {
        toValue: 0.92,
        ...SPRING_GENTLE,
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]).start(() => {
      setIsVisible(false);
      onDismiss?.();
    });
  }, [onDismiss]);

  const swipeDismiss = useCallback(() => {
    if (dismissingRef.current) return;
    dismissingRef.current = true;
    Animated.parallel([
      Animated.timing(swipeAnim, {
        toValue: -200,
        duration: 180,
        useNativeDriver: Platform.OS !== 'web',
      }),
      Animated.timing(opacityAnim, {
        toValue: 0,
        duration: 180,
        useNativeDriver: Platform.OS !== 'web',
      }),
    ]).start(() => {
      setIsVisible(false);
      onDismiss?.();
    });
  }, [onDismiss]);

  const handleTap = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    const data = notification?.data;
    dismiss();

    // Navigate based on notification type
    if (data?.type === 'chat_message' && data?.conversation_id) {
      router.push(`/chat-conversation?id=${data.conversation_id}`);
    } else if (data?.type === 'meeting_reminder' && data?.room_id) {
      router.push(`/meeting-detail?room_id=${data.room_id}`);
    } else if (data?.type === 'new_email' && data?.uid) {
      const folder = data.folder || 'INBOX';
      router.push(`/read?uid=${data.uid}&folder=${encodeURIComponent(folder)}`);
    } else {
      router.push('/inbox');
    }
  }, [notification, dismiss]);

  if (!isVisible || !notification) return null;

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
    <Animated.View
      {...panResponder.panHandlers}
      style={{
        position: 'absolute',
        top: insets.top + (Platform.OS === 'ios' ? 4 : 12),
        left: 0,
        right: 0,
        alignItems: 'center',
        zIndex: 9999,
        transform: [
          { translateY: slideAnim },
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
          backgroundColor: isDark ? 'rgba(30, 41, 55, 0.98)' : 'rgba(255, 255, 255, 0.98)',
          borderRadius: 20,
          overflow: 'hidden',
          ...Shadow.xl,
          ...(Platform.OS === 'web' ? {
            backdropFilter: 'blur(24px)',
            WebkitBackdropFilter: 'blur(24px)',
            boxShadow: isDark
              ? '0 12px 40px rgba(0,0,0,0.4), 0 2px 8px rgba(0,0,0,0.2)'
              : '0 12px 40px rgba(0,0,0,0.14), 0 2px 8px rgba(0,0,0,0.06)',
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
        {/* Swipe hint bar */}
        <View style={{
          alignItems: 'center',
          paddingTop: 6,
          paddingBottom: 2,
        }}>
          <View style={{
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: isDark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.08)',
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
                  backgroundColor: 'rgba(139, 92, 246, 0.1)',
                  paddingHorizontal: 5,
                  paddingVertical: 1,
                  borderRadius: 4,
                }}>
                  <Text style={{ fontSize: 9, fontWeight: '700', color: '#8b5cf6', letterSpacing: 0.3 }}>AI</Text>
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

          {/* Dismiss button */}
          <TouchableOpacity
            onPress={(e) => {
              e.stopPropagation?.();
              if (timerRef.current) clearTimeout(timerRef.current);
              dismiss();
            }}
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
            <Text style={{ fontSize: 11, color: colors.textTertiary, fontWeight: '700' }}>{'\u2715'}</Text>
          </TouchableOpacity>
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
              <Text style={{ fontSize: 12, marginRight: 4 }}>{'\u21A9'}</Text>
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

        {/* Progress bar */}
        <Animated.View
          style={{
            height: 3,
            borderBottomLeftRadius: 20,
            borderBottomRightRadius: 0,
            backgroundColor: data.urgency === 'high' ? colors.error : accentColor,
            opacity: 0.7,
            width: progressAnim.interpolate({
              inputRange: [0, 1],
              outputRange: ['0%', '100%'],
            }),
          }}
        />
      </TouchableOpacity>
    </Animated.View>
  );
}
