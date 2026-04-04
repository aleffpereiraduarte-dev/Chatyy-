import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet,
  ActivityIndicator, RefreshControl, TextInput, Alert,
  Animated, PanResponder, Platform, LayoutAnimation, UIManager, Image,
} from 'react-native';
// FlatList only (FlashList crashes iOS)
const ListComponent = FlatList;
import { useRouter, useFocusEffect } from 'expo-router';
import * as api from '../services/api';
import { emailToDisplayName } from '../services/api';
import { cacheConversations, getCachedConversations } from '../services/chatCache';
import { IconMessageSquare, IconSearch, IconX, IconTrash, IconArchive, IconVolume2, IconCheck } from './Icons';
import AvatarCircle from './AvatarCircle';
import BroadcastModal from './BroadcastModal';
import CreateGroupFlow from './CreateGroupFlow';
import ChannelDiscoverModal from './ChannelDiscoverModal';
import Svg, { Path, Rect, Line, Circle as SvgCircle } from 'react-native-svg';

let NativeSwipeable = null;
if (Platform.OS !== 'web') {
  try { NativeSwipeable = require('react-native-gesture-handler').Swipeable; } catch {}
}

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const ACCENT = '#25D366';
const ACCENT2 = '#128C7E';
const ACCENT_GLOW = 'rgba(37,211,102,0.35)';
const SWIPE_THRESHOLD = 60;
const SWIPE_MAX = 150;
const useNative = Platform.OS !== 'web';
const isWeb = Platform.OS === 'web';

function safeAlert(title, message, buttons) {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 0) {
      const cancelBtn = buttons.find(b => b.style === 'cancel');
      const actionBtn = buttons.find(b => b.style !== 'cancel') || buttons[0];
      const confirmed = window.confirm(`${title}\n\n${message || ''}`);
      if (confirmed && actionBtn?.onPress) actionBtn.onPress();
      else if (!confirmed && cancelBtn?.onPress) cancelBtn.onPress();
    } else {
      try { window.alert(message || title); } catch {}
    }
  } else {
    try { Alert.alert(title, message, buttons); } catch {}
  }
}

function formatChatTime(dateStr, t) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z');
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMin < 1) return t?.('time.now') || 'agora';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffDays === 0) return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return t?.('time.yesterday') || 'Ontem';
  if (diffDays < 7) return date.toLocaleDateString([], { weekday: 'short' });
  return date.toLocaleDateString([], { day: '2-digit', month: '2-digit', year: '2-digit' });
}

// Pin icon
function IconPin({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 17v5" />
      <Path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7" />
      <Path d="M6 11h12l-1.5 6h-9L6 11z" />
    </Svg>
  );
}

// Lock icon
function IconLock({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <Path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Svg>
  );
}

// Muted bell-off icon
function IconBellOff({ size = 24, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <Path d="M13.73 21a2 2 0 0 1-3.46 0" />
      <Path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
      <Path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
      <Path d="M18 8a6 6 0 0 0-9.33-5" />
      <Path d="m1 1 22 22" />
    </Svg>
  );
}

// ── Skeleton loader for conversation rows ──
function SkeletonRow({ isDark, index }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(index * 80),
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: useNative }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: useNative }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);
  const bg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  return (
    <Animated.View style={[s.row, { opacity }]}>
      <View style={[{
        width: 56, height: 56, borderRadius: 28, backgroundColor: bg, marginRight: 15,
        ...(isWeb ? { background: isDark
          ? 'linear-gradient(135deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%)'
          : 'linear-gradient(135deg, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.03) 100%)'
        } : {}),
      }]} />
      <View style={{ flex: 1, gap: 10 }}>
        <View style={{
          width: `${60 - index * 5}%`, height: 14, borderRadius: 7, backgroundColor: bg,
          ...(isWeb ? { background: isDark
            ? 'linear-gradient(90deg, rgba(255,255,255,0.08) 0%, rgba(255,255,255,0.04) 100%)'
            : 'linear-gradient(90deg, rgba(0,0,0,0.06) 0%, rgba(0,0,0,0.03) 100%)'
          } : {}),
        }} />
        <View style={{
          width: `${85 - index * 3}%`, height: 12, borderRadius: 6, backgroundColor: bg,
          ...(isWeb ? { background: isDark
            ? 'linear-gradient(90deg, rgba(255,255,255,0.06) 0%, rgba(255,255,255,0.03) 100%)'
            : 'linear-gradient(90deg, rgba(0,0,0,0.04) 0%, rgba(0,0,0,0.02) 100%)'
          } : {}),
        }} />
      </View>
    </Animated.View>
  );
}

// ── Animated typing dots for conversation row ──
function TypingDotsInline({ color }) {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const animate = (dot, delay) => Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(dot, { toValue: 1, duration: 300, useNativeDriver: useNative }),
        Animated.timing(dot, { toValue: 0.3, duration: 300, useNativeDriver: useNative }),
        Animated.delay(600 - delay),
      ])
    );
    const a1 = animate(dot1, 0); const a2 = animate(dot2, 200); const a3 = animate(dot3, 400);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, []);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      {[dot1, dot2, dot3].map((dot, i) => (
        <Animated.View key={i} style={{
          width: 6, height: 6, borderRadius: 3,
          backgroundColor: color || ACCENT, opacity: dot,
        }} />
      ))}
    </View>
  );
}

// ── Online pulse animation ──
function PulsingOnlineDot({ colors, isDark }) {
  return (
    <View style={[s.onlineDot, {
      borderColor: isDark ? '#0B141A' : colors.background,
    }]} />
  );
}

// ── Group avatar stack (2-3 member photos) ──
function GroupAvatarStack({ conversation, size = 56, isDark }) {
  const members = (conversation.members || []).slice(0, 3);
  const smallSize = size * 0.58;
  if (members.length < 2) {
    return <AvatarCircle name={conversation.display_name || conversation.name || '?'} email={null} size={size} />;
  }
  return (
    <View style={{ width: size, height: size, position: 'relative' }}>
      {members.slice(0, 2).map((m, i) => {
        const email = typeof m === 'string' ? m : m?.email;
        const name = typeof m === 'object' ? (m?.name || m?.email || '?') : m;
        return (
          <View key={i} style={{
            position: 'absolute',
            left: i === 0 ? 0 : size - smallSize,
            top: i === 0 ? 0 : size - smallSize,
            width: smallSize, height: smallSize, borderRadius: smallSize / 2,
            borderWidth: 2.5,
            borderColor: isDark ? '#0d1117' : '#fff',
            zIndex: 2 - i,
            overflow: 'hidden',
            ...(isWeb ? { boxShadow: '0 2px 6px rgba(0,0,0,0.15)' } : {}),
          }}>
            <AvatarCircle name={name} email={email} size={smallSize - 5} />
          </View>
        );
      })}
      {members.length > 2 && (
        <View style={{
          position: 'absolute', right: 0, top: (size - smallSize) / 2,
          width: smallSize * 0.7, height: smallSize * 0.7, borderRadius: smallSize * 0.35,
          alignItems: 'center', justifyContent: 'center',
          borderWidth: 1.5, borderColor: isDark ? '#0d1117' : '#fff', zIndex: 3,
          ...(isWeb ? {
            background: isDark
              ? 'linear-gradient(135deg, rgba(37,211,102,0.6) 0%, rgba(18,140,126,0.6) 100%)'
              : 'linear-gradient(135deg, rgba(37,211,102,0.7) 0%, rgba(18,140,126,0.7) 100%)',
            backdropFilter: 'blur(4px)',
          } : { backgroundColor: 'rgba(0,0,0,0.5)' }),
        }}>
          <Text style={{ color: '#fff', fontSize: 9, fontWeight: '800' }}>+{members.length - 2}</Text>
        </View>
      )}
    </View>
  );
}

// ── ConversationRow with swipe ──
const ConversationRow = React.memo(function ConversationRow({
  conversation, colors, onPress, onDelete, onArchive, onMute, onPin,
  currentEmail, t, isOnline: isOnlineProp, isDark, isLocked, typingUsers,
  selectionMode, isSelected, onLongPress, onToggleSelect,
}) {
  const isGroup = conversation.type === 'group';
  const isChannel = conversation.type === 'channel';
  const displayName = emailToDisplayName(conversation.display_name || conversation.name || t('chat.unknown'));
  const unread = conversation.unread_count > 0;
  const lastMsg = conversation.last_message;
  const isArchived = conversation.archived;
  const isPinned = !!conversation.pinned;
  const isMuted = !!conversation.muted;
  const [hovered, setHovered] = useState(false);

  const otherMember = !isGroup ? (conversation.members || []).find(m => {
    if (m && typeof m === 'object') return m.email !== currentEmail;
    if (typeof m === 'string') return m !== currentEmail;
    return false;
  }) : null;
  const otherEmail = otherMember ? (typeof otherMember === 'string' ? otherMember : otherMember?.email) : null;

  const isOnline = !!isOnlineProp;

  const typingName = typingUsers?.[conversation.id];

  let preview = '';
  let previewSender = null;
  let statusType = null;
  if (typingName) {
    preview = '';
  } else if (lastMsg) {
    if (lastMsg.sender_email === currentEmail) {
      if (lastMsg.read_at) statusType = 'read';
      else if (lastMsg.delivered_at) statusType = 'delivered';
      else statusType = 'sent';
    }

    let content = typeof lastMsg.content === 'string' ? lastMsg.content : (lastMsg.content ? JSON.stringify(lastMsg.content) : '');
    if (content.startsWith('{')) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.call_type === 'video') content = '\uD83D\uDCF9 ' + (t('chat.videoCall') || 'Chamada de video');
        else if (parsed.call_type === 'audio') content = '\uD83D\uDCDE ' + (t('chat.voiceCall') || 'Chamada de voz');
        else if (parsed.type === 'location') content = '\uD83D\uDCCD ' + (t('chat.location') || 'Localizacao');
        else if (parsed.type === 'contact') content = '\uD83D\uDC64 ' + (t('chat.contact') || 'Contato');
        else content = '\uD83D\uDCCE ' + (t('chat.attachment') || 'Anexo');
      } catch {}
    }
    if (lastMsg.type === 'image') content = '\uD83D\uDCF7 ' + (t('chat.photo') || 'Foto');
    else if (lastMsg.type === 'video' && !content.startsWith('\uD83C\uDFA5')) content = '\uD83C\uDFA5 ' + (t('chat.video') || 'Video');
    else if (lastMsg.type === 'audio' && !content.startsWith('\uD83D\uDCDE')) content = '\uD83C\uDFB5 ' + (t('chat.audio') || 'Audio');
    else if (lastMsg.type === 'file') content = '\uD83D\uDCCE ' + (lastMsg.file_name || t('chat.file') || 'Arquivo');

    if (lastMsg.type === 'system') {
      preview = content;
    } else if ((isGroup || isChannel) && lastMsg.sender_email !== currentEmail) {
      const sender = emailToDisplayName(lastMsg.sender_name || lastMsg.sender_email || '');
      preview = content;
      previewSender = sender;
    } else {
      preview = content;
    }
  }

  // ── Swipe with refs for fresh props ──
  const translateX = useRef(new Animated.Value(0)).current;
  const swipeOpen = useRef(false);
  const propsRef = useRef({ onDelete, onArchive, onMute, onPin });
  propsRef.current = { onDelete, onArchive, onMute, onPin };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        if (Math.abs(g.dx) < 15) return false;
        return Math.abs(g.dx) > Math.abs(g.dy) * 1.5;
      },
      onMoveShouldSetPanResponderCapture: () => false,
      onStartShouldSetPanResponder: () => false,
      onPanResponderMove: (_, g) => {
        translateX.setValue(Math.max(Math.min(g.dx, SWIPE_MAX), -SWIPE_MAX));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -SWIPE_THRESHOLD || (g.vx < -0.3 && g.dx < -20)) {
          swipeOpen.current = 'left';
          Animated.spring(translateX, { toValue: -SWIPE_MAX, tension: 120, friction: 12, useNativeDriver: useNative }).start();
        } else if (g.dx > SWIPE_THRESHOLD || (g.vx > 0.3 && g.dx > 20)) {
          swipeOpen.current = 'right';
          Animated.spring(translateX, { toValue: SWIPE_MAX, tension: 120, friction: 12, useNativeDriver: useNative }).start();
        } else {
          swipeOpen.current = false;
          Animated.spring(translateX, { toValue: 0, tension: 150, friction: 14, useNativeDriver: useNative }).start();
        }
      },
    })
  ).current;

  const resetSwipe = useCallback(() => {
    swipeOpen.current = false;
    Animated.spring(translateX, { toValue: 0, friction: 8, tension: 100, useNativeDriver: useNative }).start();
  }, []);

  // ── Status checkmarks ──
  const renderStatusIcon = () => {
    if (!statusType) return null;
    if (statusType === 'read') {
      return (
        <View style={{ flexDirection: 'row', marginRight: 3 }}>
          <IconCheck size={15} color="#53BDEB" style={{ marginRight: -8 }} />
          <IconCheck size={15} color="#53BDEB" />
        </View>
      );
    }
    if (statusType === 'delivered') {
      return (
        <View style={{ flexDirection: 'row', marginRight: 3 }}>
          <IconCheck size={15} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)'} style={{ marginRight: -8 }} />
          <IconCheck size={15} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)'} />
        </View>
      );
    }
    return (
      <IconCheck size={15} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.25)'} style={{ marginRight: 3 }} />
    );
  };

  // ── Left action opacity (swipe right reveals) ──
  const leftOpacity = translateX.interpolate({
    inputRange: [0, 60, SWIPE_MAX],
    outputRange: [0, 0.6, 1],
    extrapolate: 'clamp',
  });
  // ── Right action opacity (swipe left reveals) ──
  const rightOpacity = translateX.interpolate({
    inputRange: [-SWIPE_MAX, -60, 0],
    outputRange: [1, 0.6, 0],
    extrapolate: 'clamp',
  });

  // Row background
  const rowBg = hovered
    ? (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)')
    : isPinned
      ? (isDark ? 'rgba(37,211,102,0.04)' : 'rgba(37,211,102,0.03)')
      : colors.background;

  // Native swipe row content
  const rowContent = (
        <TouchableOpacity
          style={[
            s.row,
            {
              backgroundColor: isSelected ? (isDark ? 'rgba(37,211,102,0.12)' : 'rgba(37,211,102,0.08)') : rowBg,
              ...(isWeb ? { transition: 'background-color 0.2s ease' } : {}),
            },
          ]}
          onPress={() => {
            if (selectionMode) { onToggleSelect?.(); return; }
            if (swipeOpen.current) { resetSwipe(); return; }
            onPress();
          }}
          onLongPress={() => {
            if (!selectionMode) onLongPress?.();
          }}
          delayLongPress={500}
          activeOpacity={0.6}
          delayPressIn={60}
          {...(isWeb ? {
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
          } : {})}
        >
          {/* Selection checkbox */}
          {selectionMode && (
            <View style={{
              width: 26, height: 26, borderRadius: 13, marginRight: 10,
              borderWidth: 2, borderColor: isSelected ? ACCENT : (isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'),
              backgroundColor: isSelected ? ACCENT : 'transparent',
              alignItems: 'center', justifyContent: 'center',
            }}>
              {isSelected && <IconCheck size={16} color="#fff" />}
            </View>
          )}
          {/* Avatar area */}
          <View style={s.avatarWrap}>
            {isChannel ? (
              <View style={{
                width: 50, height: 50, borderRadius: 25,
                backgroundColor: isDark ? 'rgba(0,136,204,0.15)' : 'rgba(0,136,204,0.1)',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="#0088cc" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M3 11l18-5v12L3 13v-2z" />
                  <Path d="M11.6 16.8a3 3 0 11-5.8-1.6" />
                </Svg>
              </View>
            ) : isGroup ? (
              <GroupAvatarStack conversation={conversation} size={50} isDark={isDark} />
            ) : (
              <View style={isWeb && isDark ? {
                borderRadius: 28,
                boxShadow: isOnline
                  ? `0 0 12px rgba(34,197,94,0.3), 0 2px 8px rgba(0,0,0,0.2)`
                  : `0 2px 8px rgba(0,0,0,0.2)`,
              } : undefined}>
                <AvatarCircle
                  name={displayName}
                  email={otherEmail}
                  size={50}
                />
              </View>
            )}
            {isOnline && <PulsingOnlineDot colors={colors} isDark={isDark} />}
          </View>
          <View style={s.rowContent}>
            <View style={s.rowTop}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 10 }}>
                {(isGroup || isChannel) && (
                  <View style={[s.groupBadge, isDark && s.groupBadgeDark, isChannel && { backgroundColor: isDark ? 'rgba(0,136,204,0.15)' : 'rgba(0,136,204,0.1)' }]}>
                    <Text style={[s.groupBadgeText, isChannel && { color: '#0088cc' }]}>
                      {conversation.subscriber_count || (conversation.members || []).length}
                    </Text>
                  </View>
                )}
                <Text style={[s.rowName, { color: colors.text }, unread && s.rowNameUnread]} numberOfLines={1}>{displayName}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                {isPinned && (
                  <View style={[s.pinnedIconWrap, isDark && { backgroundColor: 'rgba(255,255,255,0.06)' }]}>
                    <IconPin size={11} color={isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)'} />
                  </View>
                )}
                {isLocked && <IconLock size={12} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'} />}
                <Text style={[s.rowTime, unread ? {
                  color: ACCENT, fontWeight: '700',
                } : {
                  color: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)',
                }]}>
                  {lastMsg ? formatChatTime(lastMsg.created_at, t) : ''}
                </Text>
              </View>
            </View>
            <View style={s.rowBottom}>
              {isLocked ? (
                <Text style={[s.rowPreview, { color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }]} numberOfLines={1}>
                  {'\uD83D\uDD12 ' + (t('chat.lockedChat') || 'Chat bloqueado')}
                </Text>
              ) : typingName ? (
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: 10 }}>
                  <TypingDotsInline color={ACCENT} />
                  <Text style={[s.rowPreview, { color: ACCENT, fontStyle: 'italic', fontWeight: '600', flex: 0 }]} numberOfLines={1}>
                    {isGroup ? `${typingName} ` : ''}{t('chat.typing') || 'digitando...'}
                  </Text>
                </View>
              ) : (
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 10 }}>
                  {renderStatusIcon()}
                  <Text
                    style={[
                      s.rowPreview,
                      {
                        color: unread
                          ? (isDark ? '#e0e0e0' : '#333')
                          : (isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)'),
                        fontWeight: unread ? '500' : '400',
                      },
                    ]}
                    numberOfLines={1}
                  >
                    {previewSender ? (
                      <>
                        <Text style={{ fontWeight: '700' }}>{previewSender}: </Text>
                        {preview}
                      </>
                    ) : (preview || t('chat.noMessages'))}
                  </Text>
                </View>
              )}
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                {isMuted && (
                  <IconBellOff size={15} color={isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'} />
                )}
                {conversation.has_mention && unread && (
                  <View style={[s.unreadBadge, s.unreadBadgeShadow, { minWidth: 24 }]}>
                    <Text style={s.unreadText}>@</Text>
                  </View>
                )}
                {unread && (
                  <View style={[
                    s.unreadBadge,
                    s.unreadBadgeShadow,
                    isMuted && { backgroundColor: isDark ? '#555' : '#999' },
                    isDark && isWeb && !isMuted && { boxShadow: `0 0 10px ${ACCENT_GLOW}, 0 2px 8px rgba(37,211,102,0.4)` },
                  ]}>
                    <Text style={s.unreadText}>{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </TouchableOpacity>
  );

  // Use native Swipeable on iOS/Android, PanResponder on web
  if (NativeSwipeable && !isWeb && !selectionMode) {
    const swipeRef = useRef(null);
    const renderLeftActions = useCallback((progress, dragX) => {
      const scale = dragX.interpolate({ inputRange: [0, 80], outputRange: [0.5, 1], extrapolate: 'clamp' });
      return (
        <View style={{ flexDirection: 'row' }}>
          <TouchableOpacity style={[s.nativeSwipeBtn, { backgroundColor: '#6366F1' }]} onPress={() => { swipeRef.current?.close(); propsRef.current.onMute?.(conversation); }}>
            <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}><IconVolume2 size={20} color="#fff" /></Animated.View>
          </TouchableOpacity>
          <TouchableOpacity style={[s.nativeSwipeBtn, { backgroundColor: '#F59E0B' }]} onPress={() => { swipeRef.current?.close(); propsRef.current.onPin?.(conversation); }}>
            <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}><IconPin size={20} color="#fff" /></Animated.View>
          </TouchableOpacity>
        </View>
      );
    }, [conversation]);
    const renderRightActions = useCallback((progress, dragX) => {
      const scale = dragX.interpolate({ inputRange: [-80, 0], outputRange: [1, 0.5], extrapolate: 'clamp' });
      return (
        <View style={{ flexDirection: 'row' }}>
          <TouchableOpacity style={[s.nativeSwipeBtn, { backgroundColor: '#3B82F6' }]} onPress={() => { swipeRef.current?.close(); propsRef.current.onArchive?.(conversation); }}>
            <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}><IconArchive size={20} color="#fff" /></Animated.View>
          </TouchableOpacity>
          <TouchableOpacity style={[s.nativeSwipeBtn, { backgroundColor: '#EF4444' }]} onPress={() => { swipeRef.current?.close(); propsRef.current.onDelete?.(conversation); }}>
            <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}><IconTrash size={20} color="#fff" /></Animated.View>
          </TouchableOpacity>
        </View>
      );
    }, [conversation]);
    return (
      <NativeSwipeable ref={swipeRef} friction={1.5} leftThreshold={50} rightThreshold={50} overshootLeft={false} overshootRight={false}
        renderLeftActions={renderLeftActions} renderRightActions={renderRightActions}
>
        {rowContent}
      </NativeSwipeable>
    );
  }

  // Web fallback with PanResponder
  return (
    <View style={s.swipeContainer}>
      <Animated.View style={[s.swipeActionsLeft, { opacity: leftOpacity }]}>
        <TouchableOpacity style={[s.swipeActionBtnWide, { borderRadius: 14, marginLeft: 4, marginVertical: 3, background: 'linear-gradient(135deg, #6366F1 0%, #8B5CF6 100%)' }]} onPress={() => { resetSwipe(); propsRef.current.onMute?.(conversation); }}>
          <IconVolume2 size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{t('chat.mute') || 'Mute'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.swipeActionBtnWide, { borderRadius: 14, marginRight: 4, marginVertical: 3, background: 'linear-gradient(135deg, #F59E0B 0%, #EF6C00 100%)' }]} onPress={() => { resetSwipe(); propsRef.current.onPin?.(conversation); }}>
          <IconPin size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{isPinned ? (t('chat.unpin') || 'Unpin') : (t('chat.pin') || 'Pin')}</Text>
        </TouchableOpacity>
      </Animated.View>
      <Animated.View style={[s.swipeActionsRight, { opacity: rightOpacity }]}>
        <TouchableOpacity style={[s.swipeActionBtnWide, { borderRadius: 14, marginLeft: 4, marginVertical: 3, background: 'linear-gradient(135deg, #3B82F6 0%, #2563EB 100%)' }]} onPress={() => { resetSwipe(); propsRef.current.onArchive?.(conversation); }}>
          <IconArchive size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{isArchived ? (t('chat.unarchive') || 'Unarchive') : (t('chat.archive') || 'Archive')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.swipeActionBtnWide, { borderRadius: 14, marginRight: 4, marginVertical: 3, background: 'linear-gradient(135deg, #EF4444 0%, #DC2626 100%)' }]} onPress={() => { resetSwipe(); propsRef.current.onDelete?.(conversation); }}>
          <IconTrash size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{t('chat.delete') || 'Excluir'}</Text>
        </TouchableOpacity>
      </Animated.View>
      <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }], backgroundColor: colors.background, width: '100%', zIndex: 2 }}>
        {rowContent}
      </Animated.View>
    </View>
  );
}, (prev, next) => {
  return (
    prev.conversation === next.conversation &&
    prev.isDark === next.isDark &&
    prev.isLocked === next.isLocked &&
    prev.typingUsers === next.typingUsers &&
    prev.isOnline === next.isOnline &&
    prev.selectionMode === next.selectionMode &&
    prev.isSelected === next.isSelected
  );
});

// ── Animated empty state chat bubbles ──
function EmptyBubbles({ isDark }) {
  const float1 = useRef(new Animated.Value(0)).current;
  const float2 = useRef(new Animated.Value(0)).current;
  const float3 = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    // Entry animation
    Animated.spring(scale, { toValue: 1, tension: 40, friction: 7, useNativeDriver: useNative }).start();

    // Floating animations
    const makeFloat = (anim, duration) => Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: -8, duration, useNativeDriver: useNative }),
        Animated.timing(anim, { toValue: 8, duration, useNativeDriver: useNative }),
      ])
    );
    const f1 = makeFloat(float1, 2000);
    const f2 = makeFloat(float2, 2400);
    const f3 = makeFloat(float3, 1800);
    f1.start(); f2.start(); f3.start();
    return () => { f1.stop(); f2.stop(); f3.stop(); };
  }, []);

  const bubbleBase = {
    borderRadius: 20,
    position: 'absolute',
  };

  return (
    <Animated.View style={{ width: 180, height: 140, position: 'relative', transform: [{ scale }] }}>
      {/* Bubble 1 - large left */}
      <Animated.View style={[bubbleBase, {
        width: 100, height: 36, left: 0, top: 20,
        borderBottomLeftRadius: 6,
        transform: [{ translateY: float1 }],
        ...(isWeb ? {
          background: isDark
            ? 'linear-gradient(135deg, rgba(37,211,102,0.15) 0%, rgba(18,140,126,0.15) 100%)'
            : 'linear-gradient(135deg, rgba(37,211,102,0.12) 0%, rgba(18,140,126,0.12) 100%)',
          boxShadow: isDark ? '0 4px 16px rgba(37,211,102,0.1)' : '0 4px 16px rgba(37,211,102,0.08)',
        } : {
          backgroundColor: isDark ? 'rgba(37,211,102,0.15)' : 'rgba(37,211,102,0.12)',
        }),
      }]}>
        <View style={{ flexDirection: 'row', gap: 4, padding: 10, alignItems: 'center' }}>
          <View style={{ width: 40, height: 6, borderRadius: 3, backgroundColor: isDark ? 'rgba(37,211,102,0.3)' : 'rgba(37,211,102,0.25)' }} />
          <View style={{ width: 24, height: 6, borderRadius: 3, backgroundColor: isDark ? 'rgba(37,211,102,0.2)' : 'rgba(37,211,102,0.15)' }} />
        </View>
      </Animated.View>

      {/* Bubble 2 - medium right */}
      <Animated.View style={[bubbleBase, {
        width: 120, height: 36, right: 0, top: 52,
        borderBottomRightRadius: 6,
        transform: [{ translateY: float2 }],
        ...(isWeb ? {
          background: isDark
            ? 'linear-gradient(135deg, rgba(0,212,170,0.15) 0%, rgba(37,211,102,0.15) 100%)'
            : 'linear-gradient(135deg, rgba(0,212,170,0.12) 0%, rgba(37,211,102,0.12) 100%)',
          boxShadow: isDark ? '0 4px 16px rgba(0,212,170,0.1)' : '0 4px 16px rgba(0,212,170,0.08)',
        } : {
          backgroundColor: isDark ? 'rgba(0,212,170,0.15)' : 'rgba(0,212,170,0.12)',
        }),
      }]}>
        <View style={{ flexDirection: 'row', gap: 4, padding: 10, alignItems: 'center' }}>
          <View style={{ width: 50, height: 6, borderRadius: 3, backgroundColor: isDark ? 'rgba(0,212,170,0.3)' : 'rgba(0,212,170,0.25)' }} />
          <View style={{ width: 30, height: 6, borderRadius: 3, backgroundColor: isDark ? 'rgba(0,212,170,0.2)' : 'rgba(0,212,170,0.15)' }} />
        </View>
      </Animated.View>

      {/* Bubble 3 - small left */}
      <Animated.View style={[bubbleBase, {
        width: 80, height: 32, left: 20, top: 88,
        borderBottomLeftRadius: 6,
        transform: [{ translateY: float3 }],
        ...(isWeb ? {
          background: isDark
            ? 'linear-gradient(135deg, rgba(37,211,102,0.1) 0%, rgba(99,102,241,0.1) 100%)'
            : 'linear-gradient(135deg, rgba(37,211,102,0.08) 0%, rgba(99,102,241,0.08) 100%)',
          boxShadow: isDark ? '0 4px 12px rgba(37,211,102,0.08)' : '0 4px 12px rgba(37,211,102,0.06)',
        } : {
          backgroundColor: isDark ? 'rgba(37,211,102,0.1)' : 'rgba(37,211,102,0.08)',
        }),
      }]}>
        <View style={{ flexDirection: 'row', gap: 3, padding: 10, alignItems: 'center' }}>
          <View style={{ width: 28, height: 5, borderRadius: 2.5, backgroundColor: isDark ? 'rgba(37,211,102,0.25)' : 'rgba(37,211,102,0.2)' }} />
        </View>
      </Animated.View>
    </Animated.View>
  );
}

// Pre-load cached conversations synchronously (native only — web uses async IndexedDB)
let _preloadedConversations = null;
if (Platform.OS !== 'web') {
  try {
    const { getString: _gs } = require('../services/mmkv');
    const raw = _gs('chat_conversations');
    if (raw) _preloadedConversations = JSON.parse(raw);
  } catch {}
}

export default function ChatListTab({ colors, isDark, t, user, router }) {
  const [conversations, setConversations] = useState(() => {
    if (_preloadedConversations?.length) return _preloadedConversations.filter(c => !c.archived);
    return [];
  });
  const [archivedConversations, setArchivedConversations] = useState(() => {
    if (_preloadedConversations?.length) return _preloadedConversations.filter(c => c.archived);
    return [];
  });
  const [loading, setLoading] = useState(true); // Always start loading — fetch will update
  const [refreshing, setRefreshing] = useState(false);
  const [searchText, setSearchText] = useState('');
  const [filter, setFilter] = useState('all');
  const presencesRef = useRef(new Map());
  const [presenceVersion, setPresenceVersion] = useState(0);
  const [showArchived, setShowArchived] = useState(false);
  const [lockedIds, setLockedIds] = useState(new Set());
  const [unlockedIds, setUnlockedIds] = useState(new Set());
  const [typingUsers, setTypingUsers] = useState({});
  const [showBroadcast, setShowBroadcast] = useState(false);
  const [showFabMenu, setShowFabMenu] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showCreateChannel, setShowCreateChannel] = useState(false);
  const [showDiscoverChannels, setShowDiscoverChannels] = useState(false);
  const fabMenuAnim = useRef(new Animated.Value(0)).current;
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const searchTimerRef = useRef(null);
  const wsUpdateTimer = useRef(null);
  const typingTimeoutsRef = useRef({});

  const exitSelectionMode = useCallback(() => {
    setSelectionMode(false);
    setSelectedIds(new Set());
  }, []);

  const toggleSelected = useCallback((id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (next.size === 0) setSelectionMode(false);
      return next;
    });
  }, []);

  const enterSelectionMode = useCallback((id) => {
    setSelectionMode(true);
    setSelectedIds(new Set([id]));
  }, []);

  const handleBulkDelete = useCallback(async () => {
    const ids = [...selectedIds];
    safeAlert(t('chat.deleteConversation'), t('chat.deleteConversationConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('chat.delete'), style: 'destructive',
        onPress: async () => {
          for (const id of ids) {
            try { await api.chatDeleteConversation(id); } catch {}
          }
          LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
          setConversations(prev => prev.filter(c => !selectedIds.has(c.id)));
          setArchivedConversations(prev => prev.filter(c => !selectedIds.has(c.id)));
          exitSelectionMode();
        },
      },
    ]);
  }, [selectedIds, t, exitSelectionMode]);

  const handleBulkArchive = useCallback(async () => {
    const ids = [...selectedIds];
    for (const id of ids) {
      try { await api.chatArchive(id, true); } catch {}
    }
    LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
    setConversations(prev => {
      const moved = prev.filter(c => selectedIds.has(c.id));
      setArchivedConversations(ar => [...ar, ...moved.map(c => ({ ...c, archived: 1 }))]);
      return prev.filter(c => !selectedIds.has(c.id));
    });
    exitSelectionMode();
  }, [selectedIds, exitSelectionMode]);

  const handleBulkMute = useCallback(async () => {
    const ids = [...selectedIds];
    for (const id of ids) {
      try { await api.chatMute(id); } catch {}
    }
    loadConversations(false);
    exitSelectionMode();
  }, [selectedIds, exitSelectionMode]);

  const handleBulkPin = useCallback(async () => {
    const ids = [...selectedIds];
    for (const id of ids) {
      try { await api.chatPin(id); } catch {}
    }
    loadConversations(false);
    exitSelectionMode();
  }, [selectedIds, exitSelectionMode]);

  const loadConversations = useCallback(async (showLoader) => {
    // ALWAYS try to show cached data first (instant, <1ms with MMKV)
    // This ensures the chat list appears immediately on open
    if (showLoader) {
      try {
        const cached = await getCachedConversations();
        if (cached.length > 0) {
          setConversations(cached.filter(c => !c.archived));
          setArchivedConversations(cached.filter(c => c.archived));
          setLoading(false);
        } else {
          setLoading(true);
        }
      } catch {
        setLoading(true);
      }
    }
    // Fetch fresh data in background (don't block the UI)
    try {
      const [r, rAll] = await Promise.all([
        api.chatConversations(searchText, false),
        api.chatConversations(searchText, true),
      ]);
      if (r.success) {
        const convs = Array.isArray(r.data) ? r.data : (r.data?.conversations || []);
        setConversations(convs);
        cacheConversations(convs).catch(() => {});
      }
      if (rAll.success) {
        const all = Array.isArray(rAll.data) ? rAll.data : (rAll.data?.conversations || []);
        const archived = all.filter(c => c.archived);
        setArchivedConversations(archived);
        cacheConversations(all).catch(() => {});
      }
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [searchText]);

  useEffect(() => {
    loadConversations(true);
    // Safety: force loading off after 5s in case API hangs
    const safety = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(safety);
  }, [loadConversations]);

  useEffect(() => {
    api.chatGetLocked().then(r => {
      if (r.success && r.data?.locked_conversations) {
        setLockedIds(new Set(r.data.locked_conversations.map(Number)));
      }
    }).catch(() => {});
  }, []);

  const handleSearchChange = useCallback((text) => {
    setSearchText(text);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      loadConversations(false);
    }, 400);
  }, [loadConversations]);

  useEffect(() => {
    let unsubs = [];
    try {
      const mailWs = require('../services/websocket').default;

      unsubs.push(mailWs.on('typing', (data) => {
        if (!data?.conversation_id || data?.email === user?.email) return;
        const name = emailToDisplayName(data.name || data.email || '');
        const convId = data.conversation_id;
        setTypingUsers(prev => ({ ...prev, [convId]: name }));
        // Clear previous timeout for this conversation to avoid accumulation
        if (typingTimeoutsRef.current[convId]) clearTimeout(typingTimeoutsRef.current[convId]);
        typingTimeoutsRef.current[convId] = setTimeout(() => {
          setTypingUsers(prev => {
            const next = { ...prev };
            if (next[convId] === name) delete next[convId];
            return next;
          });
          delete typingTimeoutsRef.current[convId];
        }, 3000);
      }));

      unsubs.push(mailWs.on('chat_message', (data) => {
        if (wsUpdateTimer.current) clearTimeout(wsUpdateTimer.current);
        wsUpdateTimer.current = setTimeout(() => {
          setConversations(prev => {
            const idx = prev.findIndex(c => c.id == data.conversation_id || c.conversation_id == data.conversation_id);
            if (idx === -1) {
              loadConversations(false);
              return prev;
            }
            const updated = [...prev];
            updated[idx] = {
              ...updated[idx],
              last_message: {
                ...(updated[idx].last_message || {}),
                content: data.content || data.message,
                type: data.type || 'text',
                sender_email: data.sender_email || data.sender,
                sender_name: data.sender_name || data.sender_email || data.sender,
                created_at: data.created_at || new Date().toISOString(),
              },
              last_message_type: data.type || 'text',
              last_message_sender: data.sender_email || data.sender,
              last_message_at: data.created_at || new Date().toISOString(),
              unread_count: (updated[idx].unread_count || 0) + 1,
            };
            const [moved] = updated.splice(idx, 1);
            updated.unshift(moved);
            return updated;
          });
        }, 100);
      }));

      unsubs.push(mailWs.on('chat_read', (data) => {
        setConversations(prev => prev.map(c =>
          (c.id == data.conversation_id || c.conversation_id == data.conversation_id)
            ? { ...c, unread_count: 0 }
            : c
        ));
      }));
    } catch {}
    return () => {
      unsubs.forEach(fn => fn?.());
      if (wsUpdateTimer.current) clearTimeout(wsUpdateTimer.current);
      Object.values(typingTimeoutsRef.current).forEach(id => clearTimeout(id));
      typingTimeoutsRef.current = {};
    };
  }, [user?.email, loadConversations]);

  // WebSocket-based presence (single source of truth)
  useEffect(() => {
    let mailWs;
    try { mailWs = require('../services/websocket').default; } catch { return; }
    let intervalId;

    const queryDmPresences = () => {
      const dmEmails = [];
      for (const conv of conversations) {
        if (conv.type === 'direct' && conv.members) {
          const other = conv.members.find(m => {
            if (m && typeof m === 'object') return m.email !== user?.email;
            if (typeof m === 'string') return m !== user?.email;
            return false;
          });
          const otherEmail = other ? (typeof other === 'string' ? other : other?.email) : null;
          if (otherEmail) dmEmails.push(otherEmail);
        }
      }
      if (dmEmails.length > 0 && mailWs.isConnected) {
        mailWs.queryPresence(dmEmails);
        // Also subscribe to real-time presence changes
        mailWs.watchPresence(dmEmails);
      }
    };

    // Listen for presence_result (from queryPresence)
    const unsubResult = mailWs.on('presence_result', (presences) => {
      if (!presences || typeof presences !== 'object') return;
      const newMap = new Map();
      for (const [email, p] of Object.entries(presences)) {
        if (p && p.status) newMap.set(email, p.status);
      }
      // Merge with existing (don't lose entries not in this response)
      let changed = false;
      for (const [email, status] of newMap) {
        if (presencesRef.current.get(email) !== status) {
          changed = true;
          break;
        }
      }
      if (!changed && newMap.size !== presencesRef.current.size) changed = true;
      if (changed) {
        // Merge: keep existing entries, update with new ones
        const merged = new Map(presencesRef.current);
        for (const [email, status] of newMap) {
          merged.set(email, status);
        }
        presencesRef.current = merged;
        setPresenceVersion(v => v + 1);
      }
    });

    // Listen for real-time presence broadcasts (online/offline changes)
    const unsubPresence = mailWs.on('presence', (data) => {
      if (data?.email && data?.status) {
        const current = presencesRef.current.get(data.email);
        if (current !== data.status) {
          const merged = new Map(presencesRef.current);
          merged.set(data.email, data.status);
          presencesRef.current = merged;
          setPresenceVersion(v => v + 1);
        }
      }
    });

    // Query immediately + every 15 seconds
    queryDmPresences();
    intervalId = setInterval(queryDmPresences, 15000);

    return () => {
      unsubResult?.();
      unsubPresence?.();
      if (intervalId) clearInterval(intervalId);
    };
  }, [conversations, user?.email]);

  useFocusEffect(useCallback(() => { loadConversations(false); }, [loadConversations]));

  const onRefresh = useCallback(() => { setRefreshing(true); loadConversations(false); }, [loadConversations]);

  const navigateToConversation = useCallback((conv) => {
    const otherMember = conv.type === 'direct' && conv.members ? conv.members.find(m => {
      if (m && typeof m === 'object') return m.email !== user?.email;
      if (typeof m === 'string') return m !== user?.email;
      return false;
    }) : null;
    const otherEmail = otherMember ? (typeof otherMember === 'string' ? otherMember : otherMember?.email) : null;
    const emailParam = otherEmail ? `&email=${encodeURIComponent(otherEmail)}` : '';
    let displayName = conv.display_name || conv.name || '';
    displayName = emailToDisplayName(displayName);
    router.push(`/chat-conversation?id=${conv.id}&name=${encodeURIComponent(displayName)}&type=${conv.type}${emailParam}`);
  }, [user?.email, router]);

  const toggleFabMenu = useCallback(() => {
    if (showFabMenu) {
      Animated.timing(fabMenuAnim, { toValue: 0, duration: 200, useNativeDriver: Platform.OS !== 'web' }).start(() => setShowFabMenu(false));
    } else {
      setShowFabMenu(true);
      Animated.spring(fabMenuAnim, { toValue: 1, tension: 100, friction: 12, useNativeDriver: Platform.OS !== 'web' }).start();
    }
  }, [showFabMenu, fabMenuAnim]);

  const handleGroupCreated = useCallback((result) => {
    setShowCreateGroup(false);
    setShowCreateChannel(false);
    loadConversations(false);
    if (result?.id) {
      router.push(`/chat-conversation?id=${result.id}&name=${encodeURIComponent(result.name || '')}&type=${result.type || 'group'}`);
    }
  }, [router, loadConversations]);

  const handleConversationPress = useCallback(async (conv) => {
    if (lockedIds.has(conv.id) && !unlockedIds.has(conv.id)) {
      if (Platform.OS !== 'web') {
        try {
          const LocalAuth = require('expo-local-authentication');
          const hasHardware = await LocalAuth.hasHardwareAsync();
          const isEnrolled = await LocalAuth.isEnrolledAsync();
          if (hasHardware && isEnrolled) {
            const result = await LocalAuth.authenticateAsync({
              promptMessage: t('chat.unlockChat') || 'Desbloquear conversa',
              cancelLabel: t('common.cancel') || 'Cancelar',
              disableDeviceFallback: false,
            });
            if (result.success) {
              setUnlockedIds(prev => new Set([...prev, conv.id]));
              navigateToConversation(conv);
            }
            return;
          }
        } catch {}
      }
      if (Platform.OS === 'web') {
        const pw = window.prompt(t('chat.enterPinToUnlock') || 'Digite seu PIN para desbloquear:');
        if (pw) {
          setUnlockedIds(prev => new Set([...prev, conv.id]));
          navigateToConversation(conv);
        }
        return;
      }
      navigateToConversation(conv);
      return;
    }
    navigateToConversation(conv);
  }, [lockedIds, unlockedIds, navigateToConversation, t]);

  const handleDeleteConversation = useCallback(async (conv) => {
    try {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setConversations(prev => prev.filter(c => c.id !== conv.id));
      setArchivedConversations(prev => prev.filter(c => c.id !== conv.id));
      await api.chatDeleteConversation(conv.id);
    } catch {}
  }, []);

  const handleArchiveConversation = useCallback(async (conv) => {
    const newArchived = !conv.archived;
    try {
      const r = await api.chatArchive(conv.id, newArchived);
      if (r.success) {
        LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
        if (newArchived) {
          setConversations(prev => prev.filter(c => c.id !== conv.id));
          setArchivedConversations(prev => [...prev, { ...conv, archived: 1 }]);
        } else {
          setArchivedConversations(prev => prev.filter(c => c.id !== conv.id));
          setConversations(prev => [{ ...conv, archived: 0 }, ...prev]);
        }
      }
    } catch {}
  }, []);

  const handleMuteConversation = useCallback(async (conv) => {
    try {
      await api.chatMute(conv.id);
      loadConversations(false);
    } catch {}
  }, [loadConversations]);

  const handlePinConversation = useCallback(async (conv) => {
    try {
      await api.chatPin(conv.id);
      loadConversations(false);
    } catch {}
  }, [loadConversations]);

  const unreadCount = useMemo(() => conversations.filter(c => c.unread_count > 0).length, [conversations]);
  const groupCount = useMemo(() => conversations.filter(c => c.type === 'group').length, [conversations]);
  const channelCount = useMemo(() => conversations.filter(c => c.type === 'channel').length, [conversations]);
  const archivedCount = archivedConversations.length;

  const filteredConversations = useMemo(() => {
    if (filter === 'archived') return archivedConversations;
    let list = conversations.filter(c => {
      if (filter === 'unread') return c.unread_count > 0;
      if (filter === 'groups') return c.type === 'group';
      if (filter === 'channels') return c.type === 'channel';
      return true;
    });
    list.sort((a, b) => {
      const aPinned = a.pinned ? 1 : 0;
      const bPinned = b.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return 0;
    });
    return list;
  }, [filter, conversations, archivedConversations]);

  const pinnedCount = useMemo(() => filteredConversations.filter(c => c.pinned).length, [filteredConversations]);

  const FilterChip = useCallback(({ label, value, count }) => {
    const active = filter === value;
    return (
      <TouchableOpacity
        style={[
          s.chip,
          active
            ? [s.chipActive]
            : {
                backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
                borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)',
              },
          isWeb && { transition: 'all 0.2s cubic-bezier(0.4,0,0.2,1)' },
        ]}
        onPress={() => setFilter(filter === value ? 'all' : value)}
        activeOpacity={0.65}
      >
        <Text style={[s.chipText, active ? { color: '#fff' } : { color: isDark ? '#aaa' : '#666' }]}>
          {label}{count > 0 ? ` ${count}` : ''}
        </Text>
      </TouchableOpacity>
    );
  }, [filter, isDark]);

  const renderPinnedLabel = () => {
    if (filter !== 'all' || pinnedCount === 0) return null;
    return (
      <View style={[s.sectionLabel, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
        <IconPin size={13} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'} />
        <Text style={[s.sectionLabelText, { color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)' }]}>
          {t('chat.pinned') || 'FIXADAS'}
        </Text>
      </View>
    );
  };

  const renderArchivedHeader = () => {
    if (filter !== 'all' || archivedCount === 0) return null;
    return (
      <TouchableOpacity
        style={[s.archivedHeader, {
          borderBottomColor: isDark ? '#2a3a2e' : '#d8f0de',
          ...(isWeb ? {
            background: isDark
              ? 'linear-gradient(135deg, rgba(37,211,102,0.06) 0%, rgba(18,140,126,0.06) 100%)'
              : 'linear-gradient(135deg, rgba(37,211,102,0.06) 0%, rgba(18,140,126,0.04) 100%)',
            transition: 'background 0.2s ease',
          } : {
            backgroundColor: isDark ? '#1a2e1f' : '#f0faf3',
          }),
        }]}
        onPress={() => setFilter('archived')}
        activeOpacity={0.65}
      >
        <View style={s.archivedHeaderIcon}>
          <IconArchive size={18} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.archivedHeaderText, { color: colors.text }]}>
            {t('chat.archived') || 'Arquivadas'}
          </Text>
        </View>
        <View style={s.archivedCountBadge}>
          <Text style={s.archivedCountText}>{archivedCount}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderItem = useCallback(({ item, index }) => {
    const showUnpinnedLabel = filter === 'all'
      && pinnedCount > 0
      && index === pinnedCount;
    return (
      <>
        {showUnpinnedLabel && (
          <View style={[s.sectionLabel, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
            <IconMessageSquare size={13} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'} />
            <Text style={[s.sectionLabelText, { color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)' }]}>
              {t('chat.conversations') || 'CONVERSAS'}
            </Text>
          </View>
        )}
        <ConversationRow
          conversation={item}
          colors={colors}
          isDark={isDark}
          t={t}
          onPress={() => handleConversationPress(item)}
          onDelete={handleDeleteConversation}
          onArchive={handleArchiveConversation}
          onMute={handleMuteConversation}
          onPin={handlePinConversation}
          currentEmail={user?.email}
          isOnline={(() => {
            if (item.type === 'group') return false;
            const members = item.members || [];
            const other = members.find(m => {
              if (m && typeof m === 'object') return m.email !== user?.email;
              if (typeof m === 'string') return m !== user?.email;
              return false;
            });
            const otherEmail = other ? (typeof other === 'string' ? other : other?.email) : null;
            if (!otherEmail) return false;
            const p = presencesRef.current;
            if (p instanceof Map) return p.get(otherEmail) === 'online';
            return false;
          })()}
          isLocked={lockedIds.has(item.id) && !unlockedIds.has(item.id)}
          typingUsers={typingUsers}
          selectionMode={selectionMode}
          isSelected={selectedIds.has(item.id)}
          onLongPress={() => enterSelectionMode(item.id)}
          onToggleSelect={() => toggleSelected(item.id)}
        />
      </>
    );
  }, [filter, pinnedCount, isDark, colors, t, handleConversationPress, handleDeleteConversation, handleArchiveConversation, handleMuteConversation, handlePinConversation, user?.email, presenceVersion, lockedIds, unlockedIds, typingUsers, selectionMode, selectedIds, enterSelectionMode, toggleSelected]);

  const keyExtractor = useCallback((item) => String(item.id), []);

  const ListHeaderComponent = useMemo(() => (
    <>
      {renderArchivedHeader()}
      {renderPinnedLabel()}
    </>
  ), [filter, pinnedCount, isDark, colors, t, archivedCount]);

  const ListEmptyComponent = useMemo(() => loading ? null : (
    <View style={s.emptyContainer}>
      <EmptyBubbles isDark={isDark} />
      <View style={{ marginTop: 24 }}>
        {isWeb ? (
          <Text style={[s.emptyTitle, {
            backgroundImage: `linear-gradient(135deg, ${ACCENT} 0%, #00d4aa 50%, ${ACCENT2} 100%)`,
            WebkitBackgroundClip: 'text',
            WebkitTextFillColor: 'transparent',
            backgroundClip: 'text',
          }]}>{t('chat.empty') || 'Comece uma conversa'}</Text>
        ) : (
          <Text style={[s.emptyTitle, { color: colors.text }]}>{t('chat.empty') || 'Comece uma conversa'}</Text>
        )}
      </View>
      <Text style={[s.emptySubtitle, { color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)' }]}>{t('chat.emptyDesc')}</Text>
      <TouchableOpacity
        style={[s.emptyAction, isWeb && {
          background: `linear-gradient(135deg, ${ACCENT} 0%, #00d4aa 100%)`,
        }]}
        onPress={() => router.push('/chat-new')}
        activeOpacity={0.8}
      >
        <Text style={s.emptyActionText}>{t('chat.newConversation') || 'Iniciar conversa'}</Text>
      </TouchableOpacity>
    </View>
  ), [loading, isDark, colors, t, router]);

  const ItemSeparatorComponent = useCallback(() => (
    <View style={[s.separator, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)', marginLeft: 86 }]} />
  ), [isDark]);

  return (
    <View style={[{ flex: 1 }, isWeb && isDark && {
      background: 'linear-gradient(180deg, rgba(13,17,23,1) 0%, rgba(10,14,20,1) 100%)',
    }]}>
      {/* Selection toolbar */}
      {selectionMode && (
        <View style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
          paddingHorizontal: 16, paddingVertical: 10,
          backgroundColor: isDark ? 'rgba(37,211,102,0.12)' : 'rgba(37,211,102,0.08)',
          borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
            <TouchableOpacity onPress={exitSelectionMode} style={{ padding: 4 }}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
              {(t('chat.selected') || '{count} selected').replace('{count}', String(selectedIds.size))}
            </Text>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <TouchableOpacity onPress={handleBulkPin} style={{ padding: 6 }}>
              <IconPin size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity onPress={handleBulkMute} style={{ padding: 6 }}>
              <IconVolume2 size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity onPress={handleBulkArchive} style={{ padding: 6 }}>
              <IconArchive size={20} color={colors.text} />
            </TouchableOpacity>
            <TouchableOpacity onPress={handleBulkDelete} style={{ padding: 6 }}>
              <IconTrash size={20} color={colors.error || '#EF4444'} />
            </TouchableOpacity>
          </View>
        </View>
      )}

      {/* Search */}
      {!selectionMode && <><View style={s.searchWrap}>
        <View style={[
          s.searchBar,
          {
            backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)',
            borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
          },
          searchText.length > 0 && {
            borderColor: ACCENT + '60',
            ...(isWeb ? { boxShadow: `0 0 0 2px ${ACCENT}20, 0 2px 8px rgba(37,211,102,0.1)` } : {}),
          },
          isWeb && {
            backdropFilter: 'blur(8px)',
            WebkitBackdropFilter: 'blur(8px)',
          },
        ]}>
          <IconSearch size={18} color={searchText.length > 0 ? ACCENT : (isDark ? '#777' : '#999')} />
          <TextInput
            style={[s.searchInput, { color: colors.text }]}
            placeholder={t('chat.searchPlaceholder') || 'Pesquisar'}
            placeholderTextColor={isDark ? '#555' : '#b0b0b0'}
            value={searchText}
            onChangeText={handleSearchChange}
            returnKeyType="search"
          />
          {searchText.length > 0 && (
            <TouchableOpacity onPress={() => { setSearchText(''); loadConversations(false); }} style={s.searchClearBtn}>
              <IconX size={14} color={isDark ? '#888' : '#999'} />
            </TouchableOpacity>
          )}
        </View>
        {searchText.length > 0 && (
          <TouchableOpacity
            onPress={() => { setSearchText(''); loadConversations(false); }}
            style={s.searchCancelBtn}
            activeOpacity={0.7}
          >
            <Text style={{ color: ACCENT, fontSize: 14, fontWeight: '600' }}>
              {t('common.cancel') || 'Cancelar'}
            </Text>
          </TouchableOpacity>
        )}
      </View>

      {/* Filters */}
      <View style={s.filtersRow}>
        <FilterChip label={t('chat.filterAll') || 'Todas'} value="all" />
        <FilterChip label={t('chat.filterUnread') || 'Nao lidas'} value="unread" count={unreadCount} />
        <FilterChip label={t('chat.filterGroups') || 'Grupos'} value="groups" count={groupCount} />
        <FilterChip label={t('chat.channels') || 'Canais'} value="channels" count={channelCount} />
        <FilterChip label={t('chat.filterArchived') || 'Arquivadas'} value="archived" count={archivedCount} />
      </View>
      </>}

      {/* List */}
      {loading && !refreshing ? (
        <View style={{ flex: 1, paddingTop: 8 }}>
          {[0, 1, 2, 3, 4, 5, 6].map(i => <SkeletonRow key={i} isDark={isDark} index={i} />)}
        </View>
      ) : (
        <ListComponent
          data={filteredConversations}
          keyExtractor={keyExtractor}
          estimatedItemSize={80}
          ListHeaderComponent={ListHeaderComponent}
          renderItem={renderItem}
          ListEmptyComponent={ListEmptyComponent}
          contentContainerStyle={[filteredConversations.length === 0 && s.listEmpty]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
          ItemSeparatorComponent={ItemSeparatorComponent}
          removeClippedSubviews={Platform.OS !== 'web'}
        />
      )}

      {/* FAB Menu Overlay */}
      {showFabMenu && (
        <TouchableOpacity
          style={s.fabOverlay}
          activeOpacity={1}
          onPress={toggleFabMenu}
        >
          {/* Menu items */}
          <Animated.View style={[s.fabMenuWrap, {
            bottom: 148,
            opacity: fabMenuAnim,
            transform: [{ translateY: fabMenuAnim.interpolate({ inputRange: [0, 1], outputRange: [30, 0] }) }],
          }]}>
            {/* New Chat */}
            <TouchableOpacity
              style={[s.fabMenuItem, {
                backgroundColor: isDark ? '#1F2C33' : '#fff',
                ...(isWeb ? { boxShadow: '0 2px 12px rgba(0,0,0,0.15)' } : {}),
              }]}
              onPress={() => { toggleFabMenu(); router.push('/chat-new'); }}
              activeOpacity={0.7}
            >
              <View style={[s.fabMenuIcon, { backgroundColor: ACCENT }]}>
                <IconMessageSquare size={18} color="#fff" />
              </View>
              <Text style={[s.fabMenuLabel, { color: colors.text }]}>{t('chat.newChat')}</Text>
            </TouchableOpacity>

            {/* New Group */}
            <TouchableOpacity
              style={[s.fabMenuItem, {
                backgroundColor: isDark ? '#1F2C33' : '#fff',
                ...(isWeb ? { boxShadow: '0 2px 12px rgba(0,0,0,0.15)' } : {}),
              }]}
              onPress={() => { toggleFabMenu(); setShowCreateGroup(true); }}
              activeOpacity={0.7}
            >
              <View style={[s.fabMenuIcon, { backgroundColor: '#128C7E' }]}>
                <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4-4v2" />
                  <SvgCircle cx="9" cy="7" r="4" />
                  <Path d="M23 21v-2a4 4 0 00-3-3.87" />
                  <Path d="M16 3.13a4 4 0 010 7.75" />
                </Svg>
              </View>
              <Text style={[s.fabMenuLabel, { color: colors.text }]}>{t('chat.newGroup')}</Text>
            </TouchableOpacity>

            {/* New Channel */}
            <TouchableOpacity
              style={[s.fabMenuItem, {
                backgroundColor: isDark ? '#1F2C33' : '#fff',
                ...(isWeb ? { boxShadow: '0 2px 12px rgba(0,0,0,0.15)' } : {}),
              }]}
              onPress={() => { toggleFabMenu(); setShowCreateChannel(true); }}
              activeOpacity={0.7}
            >
              <View style={[s.fabMenuIcon, { backgroundColor: '#0088cc' }]}>
                <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M3 11l18-5v12L3 13v-2z" />
                  <Path d="M11.6 16.8a3 3 0 11-5.8-1.6" />
                </Svg>
              </View>
              <Text style={[s.fabMenuLabel, { color: colors.text }]}>{t('chat.newChannel')}</Text>
            </TouchableOpacity>

            {/* Discover Channels */}
            <TouchableOpacity
              style={[s.fabMenuItem, {
                backgroundColor: isDark ? '#1F2C33' : '#fff',
                ...(isWeb ? { boxShadow: '0 2px 12px rgba(0,0,0,0.15)' } : {}),
              }]}
              onPress={() => { toggleFabMenu(); setShowDiscoverChannels(true); }}
              activeOpacity={0.7}
            >
              <View style={[s.fabMenuIcon, { backgroundColor: '#6c5ce7' }]}>
                <IconSearch size={18} color="#fff" />
              </View>
              <Text style={[s.fabMenuLabel, { color: colors.text }]}>{t('channel.discover')}</Text>
            </TouchableOpacity>
          </Animated.View>
        </TouchableOpacity>
      )}

      {/* FAB button */}
      <TouchableOpacity
        style={[s.fab, { bottom: 80 }]}
        onPress={toggleFabMenu}
        onLongPress={() => setShowBroadcast(true)}
        activeOpacity={0.82}
      >
        <Animated.View style={{
          transform: [{
            rotate: fabMenuAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] }),
          }],
        }}>
          <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
            <Line x1="12" y1="5" x2="12" y2="19" />
            <Line x1="5" y1="12" x2="19" y2="12" />
          </Svg>
        </Animated.View>
      </TouchableOpacity>

      {/* Broadcast Modal */}
      <BroadcastModal
        visible={showBroadcast}
        onClose={() => setShowBroadcast(false)}
        onCreated={() => { setShowBroadcast(false); loadConversations(false); }}
        colors={colors}
        t={t}
      />

      {/* Create Group Flow */}
      <CreateGroupFlow
        visible={showCreateGroup}
        onClose={() => setShowCreateGroup(false)}
        onCreated={handleGroupCreated}
        mode="group"
      />

      {/* Create Channel Flow */}
      <CreateGroupFlow
        visible={showCreateChannel}
        onClose={() => setShowCreateChannel(false)}
        onCreated={handleGroupCreated}
        mode="channel"
      />

      {/* Discover Channels */}
      <ChannelDiscoverModal
        visible={showDiscoverChannels}
        onClose={() => setShowDiscoverChannels(false)}
        onJoined={() => loadConversations(false)}
      />
    </View>
  );
}

const s = StyleSheet.create({
  searchWrap: {
    paddingHorizontal: 18,
    paddingTop: 8,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 14,
    height: 36,
    gap: 8,
    borderWidth: 0,
  },
  searchCancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 2,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
    letterSpacing: 0.1,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  searchClearBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
  },
  filtersRow: {
    flexDirection: 'row',
    paddingHorizontal: 18,
    paddingBottom: 10,
    gap: 8,
  },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 16,
    borderWidth: 0,
  },
  chipActive: {
    backgroundColor: '#1DAA61',
  },
  chipText: {
    fontSize: 13,
    fontWeight: '500',
    letterSpacing: 0,
  },
  sectionLabel: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 20,
    paddingVertical: 8,
    paddingTop: 14,
  },
  sectionLabelText: {
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  avatarWrap: {
    position: 'relative',
    marginRight: 14,
  },
  onlineDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
    width: 14,
    height: 14,
    borderRadius: 7,
    backgroundColor: '#25D366',
    borderWidth: 2,
    zIndex: 5,
    overflow: 'visible',
  },
  groupBadge: {
    width: 20,
    height: 20,
    borderRadius: 6,
    backgroundColor: 'rgba(37,211,102,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  groupBadgeDark: {
    backgroundColor: 'rgba(37,211,102,0.15)',
  },
  groupBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: ACCENT,
  },
  pinnedIconWrap: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowContent: { flex: 1 },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 4,
  },
  rowName: {
    fontSize: 17,
    fontWeight: '500',
    flex: 1,
    letterSpacing: 0,
  },
  rowNameUnread: { fontWeight: '700' },
  rowTime: { fontSize: 12, letterSpacing: 0, fontWeight: '400' },
  rowBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 2,
  },
  rowPreview: {
    fontSize: 14,
    flex: 1,
    marginRight: 10,
    lineHeight: 20,
    letterSpacing: 0,
  },
  unreadBadge: {
    minWidth: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6,
    backgroundColor: ACCENT,
  },
  unreadBadgeShadow: {},
  unreadText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0,
  },
  separator: {
    height: 0,
  },
  swipeContainer: {
    position: 'relative',
    overflow: 'hidden',
    zIndex: 0,
  },
  swipeActionsLeft: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 160,
    flexDirection: 'row',
    gap: 2,
    zIndex: 1,
    alignItems: 'stretch',
  },
  swipeActionsRight: {
    position: 'absolute', right: 0, top: 0, bottom: 0, width: 160,
    flexDirection: 'row',
    gap: 2,
    zIndex: 1,
    alignItems: 'stretch',
  },
  swipeActionBtnWide: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
  },
  swipeActionLabel: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.3,
    textTransform: 'uppercase',
  },
  nativeSwipeBtn: {
    width: 72,
    justifyContent: 'center',
    alignItems: 'center',
  },
  archivedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 4,
    borderRadius: 14,
  },
  archivedHeaderIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
    ...Platform.select({
      ios: { backgroundColor: ACCENT, shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4 },
      android: { backgroundColor: ACCENT, elevation: 2 },
      web: { background: `linear-gradient(135deg, ${ACCENT} 0%, ${ACCENT2} 100%)`, boxShadow: `0 3px 8px rgba(37,211,102,0.3)` },
    }),
  },
  archivedHeaderText: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  archivedCountBadge: {
    minWidth: 26,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
    ...Platform.select({
      ios: { backgroundColor: ACCENT },
      android: { backgroundColor: ACCENT },
      web: { background: `linear-gradient(135deg, ${ACCENT} 0%, ${ACCENT2} 100%)` },
    }),
  },
  archivedCountText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
  },
  emptyContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: 40,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: 0.3,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 15,
    textAlign: 'center',
    marginTop: 10,
    lineHeight: 22,
    letterSpacing: 0.1,
  },
  emptyAction: {
    marginTop: 28,
    backgroundColor: ACCENT,
    paddingHorizontal: 36,
    paddingVertical: 15,
    borderRadius: 28,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 8 },
      android: { elevation: 6 },
      web: { boxShadow: `0 6px 20px rgba(37,211,102,0.4), 0 2px 6px rgba(0,0,0,0.08)`, transition: 'transform 0.15s ease, box-shadow 0.15s ease' },
    }),
  },
  emptyActionText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  listEmpty: { flexGrow: 1 },
  fab: {
    position: 'absolute',
    right: 18,
    width: 56,
    height: 56,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#25D366',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 8 },
      android: { elevation: 6 },
      web: {
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        transition: 'transform 0.15s ease',
      },
    }),
  },
  loaderWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  fabOverlay: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.3)',
    zIndex: 100,
  },
  fabMenuWrap: {
    position: 'absolute',
    right: 18,
    gap: 8,
    zIndex: 101,
  },
  fabMenuItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    gap: 12,
    minWidth: 180,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.15, shadowRadius: 6 },
      android: { elevation: 4 },
    }),
  },
  fabMenuIcon: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  fabMenuLabel: {
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
});
