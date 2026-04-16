import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, ScrollView, Modal,
  ActivityIndicator, RefreshControl, TextInput, Alert,
  Animated, PanResponder, Platform, LayoutAnimation, UIManager, Image,
} from 'react-native';
// FlatList only (FlashList crashes iOS)
const ListComponent = FlatList;
import { useRouter, useFocusEffect } from 'expo-router';
import * as api from '../services/api';
import { emailToDisplayName } from '../services/api';
import { cacheConversations, getCachedConversations } from '../services/chatCache';
import mqttService from '../services/mqtt';

// Subscribe all conversations to MQTT for real-time message delivery (Telegram-style)
function mqttSubscribeAll(conversations) {
  if (!conversations?.length) return;
  for (const conv of conversations) {
    if (conv.id) mqttService.subscribeConversation(conv.id);
  }
}
import { IconMessageSquare, IconSearch, IconX, IconTrash, IconArchive, IconVolume2, IconCheck, IconMail } from './Icons';
import AvatarCircle from './AvatarCircle';
import StatusCamera from './StatusCamera';
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

const ACCENT = '#7C3AED';
const ACCENT2 = '#6D28D9';
const ACCENT_GLOW = 'rgba(124,58,237,0.35)';
const SWIPE_THRESHOLD = 40; // lowered from 60 for better responsiveness
// Must match the `.swipeActionsLeft/.swipeActionsRight` width below (160)
// so the row opens EXACTLY flush with the action buttons — otherwise the
// last button (delete) has a 10px dead zone where clicks hit the row
// instead, which was the "arrasta pra apagar bugado no web" complaint.
const SWIPE_MAX = 164;
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
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: false }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: false }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);
  const bg = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)';
  return (
    <Animated.View style={[s.row, { opacity }]}>
      <View style={[{
        width: 50, height: 50, borderRadius: 25, backgroundColor: bg, marginRight: 15,
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
  const dots = [
    { opacity: useRef(new Animated.Value(0.3)).current, scale: useRef(new Animated.Value(0.7)).current },
    { opacity: useRef(new Animated.Value(0.3)).current, scale: useRef(new Animated.Value(0.7)).current },
    { opacity: useRef(new Animated.Value(0.3)).current, scale: useRef(new Animated.Value(0.7)).current },
  ];
  useEffect(() => {
    const animate = (d, delay) => Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(d.opacity, { toValue: 1, duration: 280, useNativeDriver: false }),
          Animated.spring(d.scale, { toValue: 1.15, tension: 200, friction: 6, useNativeDriver: false }),
        ]),
        Animated.parallel([
          Animated.timing(d.opacity, { toValue: 0.3, duration: 280, useNativeDriver: false }),
          Animated.spring(d.scale, { toValue: 0.7, tension: 200, friction: 8, useNativeDriver: false }),
        ]),
        Animated.delay(500 - delay),
      ])
    );
    const anims = dots.map((d, i) => animate(d, i * 180));
    anims.forEach(a => a.start());
    return () => anims.forEach(a => a.stop());
  }, []);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3 }}>
      {dots.map((d, i) => (
        <Animated.View key={i} style={{
          width: 6, height: 6, borderRadius: 3,
          backgroundColor: color || '#25D366',
          opacity: d.opacity,
          transform: [{ scale: d.scale }],
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
              ? 'linear-gradient(135deg, rgba(124,58,237,0.6) 0%, rgba(109,40,217,0.6) 100%)'
              : 'linear-gradient(135deg, rgba(124,58,237,0.7) 0%, rgba(109,40,217,0.7) 100%)',
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
// Format activity status text from last_seen timestamp
function formatActivityStatus(isOnline, lastSeen, t) {
  if (isOnline) return { text: t?.('chat.online') || 'online', color: '#22c55e' };
  if (!lastSeen) return null;
  const now = Date.now();
  const seen = new Date(lastSeen.endsWith('Z') || lastSeen.includes('+') ? lastSeen : lastSeen + 'Z').getTime();
  if (isNaN(seen)) return null;
  const diffMin = Math.floor((now - seen) / 60000);
  if (diffMin < 1) return { text: t?.('chat.online') || 'online', color: '#22c55e' };
  if (diffMin < 60) return { text: (t?.('chat.activeMinAgo') || 'active {n}m ago').replace('{n}', diffMin), color: null };
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return { text: (t?.('chat.activeHourAgo') || 'active {n}h ago').replace('{n}', diffHours), color: null };
  return null; // >24h: show nothing
}

const ConversationRow = React.memo(function ConversationRow({
  conversation, colors, onPress, onDelete, onArchive, onMute, onPin, onMarkUnread,
  currentEmail, t, isOnline: isOnlineProp, isDark, isLocked, typingUsers,
  selectionMode, isSelected, onLongPress, onToggleSelect, draftText, noteText, lastSeen,
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
    else if (lastMsg.type === 'gif') content = '\uD83C\uDFAC GIF';
    else if (lastMsg.type === 'sticker') content = '\uD83D\uDCAB ' + (t('chat.sticker') || 'Sticker');
    else if (lastMsg.type === 'video' && !content.startsWith('\uD83C\uDFA5')) content = '\uD83C\uDFA5 ' + (t('chat.video') || 'Video');
    else if (lastMsg.type === 'audio' && !content.startsWith('\uD83D\uDCDE')) content = '\uD83C\uDFB5 ' + (t('chat.audio') || 'Audio');
    else if (lastMsg.type === 'file') content = '\uD83D\uDCCE ' + (lastMsg.file_name || t('chat.file') || 'Arquivo');
    else if (lastMsg.type === 'poll') content = '\uD83D\uDCCA ' + (t('chat.poll') || 'Enquete');
    else if (lastMsg.type === 'playlist') content = '\uD83C\uDFB5 ' + (t('chatConv.playlist') || 'Playlist');
    else if (lastMsg.type === 'meetup') content = '\uD83D\uDCC5 ' + (t('chatConv.meetup') || 'Encontro');
    // Fallback: if content is a raw tenor/giphy URL (legacy gif sent as text), show "GIF"
    else if (typeof content === 'string' && /^https?:\/\/(media[0-9]*\.)?(tenor|giphy)\.com\//i.test(content.trim())) {
      content = '\uD83C\uDFAC GIF';
    }

    if (lastMsg.type === 'system') {
      preview = content;
    } else if ((isGroup || isChannel) && lastMsg.sender_email !== currentEmail) {
      const sender = emailToDisplayName(lastMsg.sender_name || lastMsg.sender_email || '');
      preview = content;
      previewSender = sender;
    } else if (lastMsg.sender_email === currentEmail) {
      // WhatsApp-style: "You: message" for own messages in 1-1 chats
      preview = content;
      previewSender = t('chat.you') || 'Você';
    } else {
      preview = content;
    }
  }

  // ── Swipe with refs for fresh props ──
  const translateX = useRef(new Animated.Value(0)).current;
  const swipeOpen = useRef(false);
  const propsRef = useRef({ onDelete, onArchive, onMute, onPin, onMarkUnread });
  propsRef.current = { onDelete, onArchive, onMute, onPin, onMarkUnread };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        if (Math.abs(g.dx) < 10) return false;
        return Math.abs(g.dx) > Math.abs(g.dy) * 1.2;
      },
      onMoveShouldSetPanResponderCapture: () => false,
      onStartShouldSetPanResponder: () => false,
      onPanResponderMove: (_, g) => {
        // Rubber band resistance beyond threshold
        const dx = g.dx;
        const sign = dx < 0 ? -1 : 1;
        const abs = Math.abs(dx);
        const clamped = abs <= SWIPE_MAX
          ? abs
          : SWIPE_MAX + (abs - SWIPE_MAX) * 0.3; // 30% resistance past limit
        translateX.setValue(sign * Math.min(clamped, SWIPE_MAX * 1.15));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx < -SWIPE_THRESHOLD || (g.vx < -0.3 && g.dx < -20)) {
          swipeOpen.current = 'left';
          Animated.spring(translateX, { toValue: -SWIPE_MAX, tension: 120, friction: 12, useNativeDriver: false }).start();
        } else if (g.dx > SWIPE_THRESHOLD || (g.vx > 0.3 && g.dx > 20)) {
          swipeOpen.current = 'right';
          Animated.spring(translateX, { toValue: SWIPE_MAX, tension: 120, friction: 12, useNativeDriver: false }).start();
        } else {
          swipeOpen.current = false;
          Animated.spring(translateX, { toValue: 0, tension: 150, friction: 14, useNativeDriver: false }).start();
        }
      },
    })
  ).current;

  const resetSwipe = useCallback(() => {
    swipeOpen.current = false;
    Animated.spring(translateX, { toValue: 0, friction: 8, tension: 100, useNativeDriver: false }).start();
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
      ? (isDark ? 'rgba(124,58,237,0.04)' : 'rgba(124,58,237,0.03)')
      : colors.background;

  // Native swipe row content
  const rowContent = (
        <TouchableOpacity
          style={[
            s.row,
            {
              backgroundColor: isSelected ? (isDark ? 'rgba(124,58,237,0.12)' : 'rgba(124,58,237,0.08)') : rowBg,
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
            {/* Instagram-style note bubble above avatar */}
            {noteText ? (
              <View style={{
                position: 'absolute', top: -6, left: -4, right: -4,
                backgroundColor: isDark ? '#2d1b69' : '#ede9fe',
                borderRadius: 10, paddingHorizontal: 5, paddingVertical: 2,
                borderWidth: 1, borderColor: isDark ? '#7C3AED' : '#c4b5fd',
                zIndex: 5, alignItems: 'center',
              }}>
                <Text style={{ fontSize: 8, color: isDark ? '#c4b5fd' : '#6d28d9', fontWeight: '700' }} numberOfLines={1}>
                  {noteText}
                </Text>
              </View>
            ) : null}
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
                {!isGroup && !isChannel && (() => {
                  const activity = formatActivityStatus(isOnline, lastSeen, t);
                  if (!activity) return null;
                  return (
                    <Text style={{ fontSize: 11, fontWeight: '500', color: activity.color || (isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'), marginLeft: 6, flexShrink: 0 }} numberOfLines={1}>
                      {activity.text}
                    </Text>
                  );
                })()}
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                {isPinned && (
                  <View style={s.pinnedIconWrap}>
                    <IconPin size={14} color={isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)'} />
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
              ) : !typingName && draftText ? (
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 10 }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(220,38,38,0.08)', borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1, flex: 1 }}>
                    <Text style={[s.rowPreview, { color: '#dc2626', fontWeight: '500', flex: 1 }]} numberOfLines={1}>
                      <Text style={{ color: '#dc2626', fontWeight: '700' }}>{t('chat.draft') || 'Rascunho'}: </Text>
                      {draftText}
                    </Text>
                  </View>
                </View>
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
                  <IconBellOff size={14} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'} />
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
          <TouchableOpacity style={[s.nativeSwipeBtn, { backgroundColor: '#0EA5E9' }]} onPress={() => { swipeRef.current?.close(); propsRef.current.onMarkUnread?.(conversation); }}>
            <Animated.View style={{ transform: [{ scale }], alignItems: 'center' }}><IconMail size={20} color="#fff" /></Animated.View>
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
        <TouchableOpacity style={[s.swipeActionBtnWide, { borderRadius: 14, marginRight: 4, marginVertical: 3, background: 'linear-gradient(135deg, #0EA5E9 0%, #0284C7 100%)' }]} onPress={() => { resetSwipe(); propsRef.current.onMarkUnread?.(conversation); }}>
          <IconMail size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{t('chat.markUnread') || 'Unread'}</Text>
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
  // Deep property comparison instead of reference comparison
  if (prev.isDark !== next.isDark) return false;
  if (prev.isLocked !== next.isLocked) return false;
  if (prev.isOnline !== next.isOnline) return false;
  if (prev.lastSeen !== next.lastSeen) return false;
  if (prev.selectionMode !== next.selectionMode) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.draftText !== next.draftText) return false;

  // Compare conversation properties, not reference
  const prevConv = prev.conversation;
  const nextConv = next.conversation;
  if (prevConv.id !== nextConv.id) return false;
  if ((prevConv.unread_count || 0) !== (nextConv.unread_count || 0)) return false;
  if ((prevConv.last_message?.id) !== (nextConv.last_message?.id)) return false;
  if ((prevConv.pinned || false) !== (nextConv.pinned || false)) return false;
  if ((prevConv.muted || false) !== (nextConv.muted || false)) return false;
  if ((prevConv.last_message_at) !== (nextConv.last_message_at)) return false;
  if ((prevConv.display_name || prevConv.name) !== (nextConv.display_name || nextConv.name)) return false;

  // Compare typing only for THIS conversation, not all (comparing all caused every row to re-render when anyone typed)
  const convId = prev.conversation?.id;
  if ((prev.typingUsers?.[convId]) !== (next.typingUsers?.[convId])) return false;

  return true; // All properties match, skip re-render
});

// ── Animated empty state chat bubbles ──
function EmptyBubbles({ isDark }) {
  const float1 = useRef(new Animated.Value(0)).current;
  const float2 = useRef(new Animated.Value(0)).current;
  const float3 = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.8)).current;

  useEffect(() => {
    // Entry animation
    Animated.spring(scale, { toValue: 1, tension: 40, friction: 7, useNativeDriver: false }).start();

    // Floating animations
    const makeFloat = (anim, duration) => Animated.loop(
      Animated.sequence([
        Animated.timing(anim, { toValue: -8, duration, useNativeDriver: false }),
        Animated.timing(anim, { toValue: 8, duration, useNativeDriver: false }),
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
            ? 'linear-gradient(135deg, rgba(124,58,237,0.15) 0%, rgba(109,40,217,0.15) 100%)'
            : 'linear-gradient(135deg, rgba(124,58,237,0.12) 0%, rgba(109,40,217,0.12) 100%)',
          boxShadow: isDark ? '0 4px 16px rgba(124,58,237,0.1)' : '0 4px 16px rgba(124,58,237,0.08)',
        } : {
          backgroundColor: isDark ? 'rgba(124,58,237,0.15)' : 'rgba(124,58,237,0.12)',
        }),
      }]}>
        <View style={{ flexDirection: 'row', gap: 4, padding: 10, alignItems: 'center' }}>
          <View style={{ width: 40, height: 6, borderRadius: 3, backgroundColor: isDark ? 'rgba(124,58,237,0.3)' : 'rgba(124,58,237,0.25)' }} />
          <View style={{ width: 24, height: 6, borderRadius: 3, backgroundColor: isDark ? 'rgba(124,58,237,0.2)' : 'rgba(124,58,237,0.15)' }} />
        </View>
      </Animated.View>

      {/* Bubble 2 - medium right */}
      <Animated.View style={[bubbleBase, {
        width: 120, height: 36, right: 0, top: 52,
        borderBottomRightRadius: 6,
        transform: [{ translateY: float2 }],
        ...(isWeb ? {
          background: isDark
            ? 'linear-gradient(135deg, rgba(167,139,250,0.15) 0%, rgba(124,58,237,0.15) 100%)'
            : 'linear-gradient(135deg, rgba(167,139,250,0.12) 0%, rgba(124,58,237,0.12) 100%)',
          boxShadow: isDark ? '0 4px 16px rgba(167,139,250,0.1)' : '0 4px 16px rgba(167,139,250,0.08)',
        } : {
          backgroundColor: isDark ? 'rgba(167,139,250,0.15)' : 'rgba(167,139,250,0.12)',
        }),
      }]}>
        <View style={{ flexDirection: 'row', gap: 4, padding: 10, alignItems: 'center' }}>
          <View style={{ width: 50, height: 6, borderRadius: 3, backgroundColor: isDark ? 'rgba(167,139,250,0.3)' : 'rgba(167,139,250,0.25)' }} />
          <View style={{ width: 30, height: 6, borderRadius: 3, backgroundColor: isDark ? 'rgba(167,139,250,0.2)' : 'rgba(167,139,250,0.15)' }} />
        </View>
      </Animated.View>

      {/* Bubble 3 - small left */}
      <Animated.View style={[bubbleBase, {
        width: 80, height: 32, left: 20, top: 88,
        borderBottomLeftRadius: 6,
        transform: [{ translateY: float3 }],
        ...(isWeb ? {
          background: isDark
            ? 'linear-gradient(135deg, rgba(124,58,237,0.1) 0%, rgba(99,102,241,0.1) 100%)'
            : 'linear-gradient(135deg, rgba(124,58,237,0.08) 0%, rgba(99,102,241,0.08) 100%)',
          boxShadow: isDark ? '0 4px 12px rgba(124,58,237,0.08)' : '0 4px 12px rgba(124,58,237,0.06)',
        } : {
          backgroundColor: isDark ? 'rgba(124,58,237,0.1)' : 'rgba(124,58,237,0.08)',
        }),
      }]}>
        <View style={{ flexDirection: 'row', gap: 3, padding: 10, alignItems: 'center' }}>
          <View style={{ width: 28, height: 5, borderRadius: 2.5, backgroundColor: isDark ? 'rgba(124,58,237,0.25)' : 'rgba(124,58,237,0.2)' }} />
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

// Bootstrap the native cache from MMKV if MMKV has data but the native
// SQLite has nothing yet. This happens on first launch after upgrading
// to a build that has the native cache module.
if (Platform.OS === 'ios' && _preloadedConversations?.length > 0) {
  try {
    const Native = require('../modules/expo-chat-cache').default;
    if (Native?.getCachedConversationsSync && Native?.saveConversations) {
      const existing = Native.getCachedConversationsSync();
      if (!existing || existing.length === 0) {
        // Fire-and-forget — populates the native cache so next launch is even faster
        Native.saveConversations(_preloadedConversations).catch(() => {});
      }
    }
  } catch {}
}

// Native chat cache (iOS only) — synchronous SQLite read for instant first paint.
// Used as a SECONDARY source: if MMKV preload was empty (e.g. fresh install),
// the native module's SQLite still has the conversations from a previous session.
const _NativeChatCache = (() => {
  if (Platform.OS !== 'ios') return null;
  try { return require('../modules/expo-chat-cache').default; } catch { return null; }
})();
const _readNativeConversationsSync = () => {
  if (!_NativeChatCache?.getCachedConversationsSync) return null;
  try {
    const list = _NativeChatCache.getCachedConversationsSync();
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch { return null; }
};
const _saveNativeConversations = (convs) => {
  if (!_NativeChatCache?.saveConversations || !Array.isArray(convs)) return;
  try { _NativeChatCache.saveConversations(convs); } catch {}
};

// ── Status Stories Row (Instagram-style, unified with Notes) ──
function StatusStoriesRow({ colors, isDark, user, router, t, setActiveTab }) {
  const [statuses, setStatuses] = useState([]);
  const [notes, setNotes] = useState([]);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [showStatusComposer, setShowStatusComposer] = useState(false);
  const [statusEditor, setStatusEditor] = useState(null);
  const [statusCaption, setStatusCaption] = useState('');
  const [statusPublishing, setStatusPublishing] = useState(false);
  const [showCustomCamera, setShowCustomCamera] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  const load = useCallback(() => {
    // Load statuses
    api.statusList?.().then(r => {
      if (r?.success && r.data) {
        const list = Array.isArray(r.data) ? r.data : (r.data.statuses || []);
        setStatuses(list);
      }
    }).catch(() => {});
    // Load notes
    api.chatGetNotes?.().then(r => {
      if (r?.success && r.data) {
        const list = Array.isArray(r.data) ? r.data : (r.data.notes || []);
        setNotes(list);
      }
    }).catch(() => {});
  }, []);

  useEffect(() => {
    let alive = true;
    load();
    const interval = setInterval(() => { if (alive) load(); }, 120000);
    return () => { alive = false; clearInterval(interval); };
  }, [load]);

  const myStatus = statuses.find(s => s.email === user?.email);
  const myNote = notes.find(n => n.email === user?.email);
  const otherStatuses = statuses.filter(s => s.email !== user?.email);

  // Merge: for each contact, if they have a status → status; else if they have a note → note
  const notesByEmail = new Map(notes.filter(n => n.email !== user?.email).map(n => [n.email, n]));
  const statusEmails = new Set(otherStatuses.map(s => s.email));
  const notesOnly = Array.from(notesByEmail.values()).filter(n => !statusEmails.has(n.email));

  const [statusViewerEmail, setStatusViewerEmail] = useState(null);
  const [statusViewIdx, setStatusViewIdx] = useState(0);
  const openStatus = (email) => {
    setStatusViewIdx(0);
    // On mobile there's no 'status' tab — open as fullscreen viewer modal
    setStatusViewerEmail(email || null);
  };

  const saveNote = async () => {
    const trimmed = noteText.trim().slice(0, 60);
    setSavingNote(true);
    try {
      const r = await api.chatSetNote?.(trimmed);
      if (r?.success) { setShowNoteModal(false); setNoteText(''); load(); }
    } catch {}
    setSavingNote(false);
  };

  const myDisplayName = user?.name || user?.email?.split('@')[0] || '';

  return (
    <View style={{ paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 14 }}>
        {/* Your story/note */}
        <TouchableOpacity
          onPress={() => {
            if (myStatus) { openStatus(user?.email); return; }
            if (Platform.OS === 'web') {
              // Web: file picker (no custom camera)
              (async () => {
                try {
                  const ImagePicker = await import('expo-image-picker');
                  const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, quality: 1.0, videoMaxDuration: 60 });
                  if (!r.canceled && r.assets?.[0]) {
                    const asset = r.assets[0];
                    const isVideo = asset.mimeType?.startsWith('video') || asset.uri?.includes('.mp4');
                    setStatusEditor({ uri: asset.uri, type: isVideo ? 'video' : 'image', file: { uri: asset.uri, name: isVideo ? 'status.mp4' : 'status.jpg', type: asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg') } });
                    setStatusCaption('');
                  }
                } catch {}
              })();
            } else {
              // Native: open custom Instagram-style camera (StatusCamera component)
              setShowCustomCamera(true);
            }
          }}
          onLongPress={() => setShowNoteModal(true)}
          activeOpacity={0.7}
          style={{ alignItems: 'center', width: 68 }}
        >
          <View style={{ position: 'relative' }}>
            {myStatus ? (
              <View style={{ borderWidth: 2.5, borderColor: '#7C3AED', borderRadius: 33, padding: 2.5 }}>
                <AvatarCircle name={myDisplayName} email={user?.email} size={54} />
              </View>
            ) : (
              <View style={{ padding: 2.5, position: 'relative' }}>
                <AvatarCircle name={myDisplayName} email={user?.email} size={54} />
                {myNote?.content && (
                  <View style={{ position: 'absolute', top: -4, left: -6, right: -6, backgroundColor: isDark ? '#2a2a3e' : '#fff', borderRadius: 14, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)', zIndex: 2 }}>
                    <Text style={{ fontSize: 10, color: colors.text, textAlign: 'center' }} numberOfLines={2}>{myNote.content}</Text>
                  </View>
                )}
              </View>
            )}
            {/* Always show + badge to add more stories (Instagram lets you add even when you have one) */}
            <View style={{ position: 'absolute', bottom: 0, right: 0, width: 20, height: 20, borderRadius: 10, backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: isDark ? '#0d0d0d' : '#fff' }}>
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', marginTop: -2 }}>+</Text>
            </View>
          </View>
          <Text style={{ fontSize: 11, color: colors.text, marginTop: 5, fontWeight: '500' }} numberOfLines={1}>
            {myNote || myStatus ? myDisplayName : (t('status.yourStory') || 'Sua nota')}
          </Text>
        </TouchableOpacity>

        {/* Status stories (photos/videos) */}
        {otherStatuses.map((s) => (
          <TouchableOpacity key={`st-${s.email}`} onPress={() => openStatus(s.email)} activeOpacity={0.7} style={{ alignItems: 'center', width: 68 }}>
            <View style={{ borderWidth: 2.5, borderColor: s.viewed ? (isDark ? 'rgba(255,255,255,0.25)' : 'rgba(0,0,0,0.2)') : '#7C3AED', borderRadius: 33, padding: 2.5 }}>
              <AvatarCircle name={s.name || s.email} email={s.email} size={54} />
            </View>
            <Text style={{ fontSize: 11, color: colors.text, marginTop: 5, fontWeight: '500' }} numberOfLines={1}>
              {s.name || s.email?.split('@')[0]}
            </Text>
          </TouchableOpacity>
        ))}

        {/* Notes only (no status) */}
        {notesOnly.map((n) => (
          <TouchableOpacity key={`note-${n.email}`} activeOpacity={0.7} style={{ alignItems: 'center', width: 68 }}
            onPress={() => {
              const convEmail = n.email;
              try {
                const convs = (require('../services/chatCache').getCachedConversations?.()) || [];
                // Navigate to chat conversation
                router.push(`/chat?newChat=${encodeURIComponent(convEmail)}`);
              } catch {}
            }}>
            <View style={{ padding: 2.5, position: 'relative' }}>
              <AvatarCircle name={n.name || n.email} email={n.email} size={54} />
              {n.content && (
                <View style={{ position: 'absolute', top: -4, left: -6, right: -6, backgroundColor: isDark ? '#2a2a3e' : '#fff', borderRadius: 14, paddingHorizontal: 7, paddingVertical: 3, borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' }}>
                  <Text style={{ fontSize: 10, color: colors.text, textAlign: 'center' }} numberOfLines={2}>{n.content}</Text>
                </View>
              )}
            </View>
            <Text style={{ fontSize: 11, color: colors.text, marginTop: 5, fontWeight: '500' }} numberOfLines={1}>
              {n.name || n.email?.split('@')[0]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Note create/edit modal */}
      {showNoteModal && (
        <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center', zIndex: 1000 }}>
          <View style={{ backgroundColor: isDark ? '#1a1a2e' : '#fff', borderRadius: 20, padding: 20, margin: 20, width: '88%', maxWidth: 400 }}>
            <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 12 }}>
              {t('notes.newNote') || 'Nova nota'}
            </Text>
            <TextInput
              value={noteText}
              onChangeText={(v) => setNoteText(v.slice(0, 60))}
              placeholder={t('notes.placeholder') || 'O que você está pensando?'}
              placeholderTextColor={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'}
              style={{ borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.1)', borderRadius: 12, padding: 12, fontSize: 15, color: colors.text, minHeight: 60, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) }}
              multiline
              autoFocus
              maxLength={60}
            />
            <Text style={{ fontSize: 11, color: colors.textSecondary, textAlign: 'right', marginTop: 4 }}>
              {noteText.length}/60 · {t('notes.expires') || 'expira em 24h'}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 16 }}>
              <TouchableOpacity onPress={() => { setShowNoteModal(false); setNoteText(''); }}
                style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.05)', alignItems: 'center' }}>
                <Text style={{ color: colors.text, fontWeight: '600' }}>{t('common.cancel') || 'Cancelar'}</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={saveNote} disabled={savingNote || !noteText.trim()}
                style={{ flex: 1, padding: 12, borderRadius: 10, backgroundColor: '#7C3AED', alignItems: 'center', opacity: (!noteText.trim() || savingNote) ? 0.5 : 1 }}>
                <Text style={{ color: '#fff', fontWeight: '700' }}>{savingNote ? '...' : (t('common.save') || 'Salvar')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Status Composer — Instagram-style pick sheet */}
      {showStatusComposer && (
        <View style={{ position:'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.55)', justifyContent:'flex-end', zIndex:1200 }}>
          <TouchableOpacity activeOpacity={1} style={{ flex:1 }} onPress={() => setShowStatusComposer(false)} />
          <View style={{ backgroundColor: isDark ? '#1F2C33' : '#fff', borderTopLeftRadius:22, borderTopRightRadius:22, paddingTop:12, paddingBottom:34, paddingHorizontal:18 }}>
            <View style={{ alignSelf:'center', width:36, height:4, backgroundColor: isDark?'rgba(255,255,255,0.15)':'rgba(0,0,0,0.12)', borderRadius:2, marginBottom:14 }} />
            <Text style={{ fontSize:17, fontWeight:'700', color: colors.text, textAlign:'center', marginBottom:14 }}>
              {t('status.createStatus') || 'Criar status'}
            </Text>
            {[
              { key:'text',  icon:'T',  color:'#7C3AED', label: t('status.typeText')  || 'Texto' },
              { key:'photo', icon:'📷', color:'#10B981', label: t('status.typePhoto') || 'Foto' },
              { key:'video', icon:'🎥', color:'#EF4444', label: t('status.typeVideo') || 'Vídeo' },
            ].map(opt => (
              <TouchableOpacity
                key={opt.key}
                onPress={async () => {
                  setShowStatusComposer(false);
                  if (opt.key === 'text') { setTimeout(() => setShowNoteModal(true), 150); return; }
                  try {
                    const ImagePicker = await import('expo-image-picker');
                    const mediaTypes = opt.key === 'video' ? ImagePicker.MediaTypeOptions.Videos : ImagePicker.MediaTypeOptions.Images;
                    const pick = async (source) => {
                      const launch = source === 'camera' ? ImagePicker.launchCameraAsync : ImagePicker.launchImageLibraryAsync;
                      const permFn = source === 'camera' ? ImagePicker.requestCameraPermissionsAsync : ImagePicker.requestMediaLibraryPermissionsAsync;
                      const perm = await permFn();
                      if (!perm.granted) return;
                      const r = await launch({ mediaTypes, quality: 1.0, videoMaxDuration: 60, videoQuality: 1 });
                      if (r.canceled || !r.assets?.[0]) return;
                      const asset = r.assets[0];
                      const file = { uri: asset.uri, name: opt.key === 'video' ? 'status.mp4' : 'status.jpg', type: asset.mimeType || (opt.key === 'video' ? 'video/mp4' : 'image/jpeg') };
                      setStatusEditor({ uri: asset.uri, type: opt.key, file });
                      setStatusCaption('');
                    };
                    if (opt.key === 'video') { pick('gallery'); }
                    else {
                      Alert.alert(t('status.addPhoto') || 'Adicionar foto', t('status.pickSource') || 'De onde?', [
                        { text: t('status.camera') || 'Câmera', onPress: () => pick('camera') },
                        { text: t('status.gallery') || 'Galeria', onPress: () => pick('gallery') },
                        { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
                      ], { cancelable: true });
                    }
                  } catch (e) { console.warn('[composer]', e?.message); }
                }}
                style={{ flexDirection:'row', alignItems:'center', paddingVertical:14, gap:14 }}
              >
                <View style={{ width:42, height:42, borderRadius:21, backgroundColor: opt.color + '22', alignItems:'center', justifyContent:'center' }}>
                  <Text style={{ fontSize: opt.key === 'text' ? 20 : 22, fontWeight:'700', color: opt.color }}>{opt.icon}</Text>
                </View>
                <Text style={{ flex:1, fontSize:15.5, fontWeight:'600', color: colors.text }}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </View>
      )}

      {/* Status Viewer (Instagram-like fullscreen story) */}
      <Modal visible={!!statusViewerEmail} transparent={false} animationType="fade" onRequestClose={() => setStatusViewerEmail(null)}>
        {statusViewerEmail && (() => {
          // statuses = [{ email, name, items: [{ id, content, type, bg_color, media_url, ... }] }]
          const group = statuses.find(s => s.email === statusViewerEmail);
          const items = group?.items || [];
          if (items.length === 0) return (
            <View style={{ flex: 1, backgroundColor: '#000', justifyContent: 'center', alignItems: 'center' }}>
              <Text style={{ color: '#fff', fontSize: 16 }}>Nenhum status encontrado</Text>
              <TouchableOpacity onPress={() => setStatusViewerEmail(null)} style={{ marginTop: 20, paddingVertical: 12, paddingHorizontal: 24, borderRadius: 20, backgroundColor: '#7C3AED' }}>
                <Text style={{ color: '#fff', fontWeight: '700' }}>Fechar</Text>
              </TouchableOpacity>
            </View>
          );
          const item = items[statusViewIdx] || items[0];
          const isImage = item.type === 'image';
          const isVideo = item.type === 'video';
          const raw = item.content || '';
          const mediaPath = raw.split('\n')[0] || '';
          const mediaUrl = mediaPath.startsWith('http') ? mediaPath : (mediaPath.startsWith('/') ? 'https://chatyy.com.br' + mediaPath : '');
          const caption = raw.includes('\n') ? raw.split('\n').slice(1).join('\n').trim() : '';
          const bgColor = item.bg_color || '#7C3AED';
          const displayName = group.name || group.email?.split('@')[0] || '';
          try { api.statusView?.(item.id).catch(() => {}); } catch {}
          return (
            <View style={{ flex: 1, backgroundColor: (isImage || isVideo) ? '#000' : bgColor }}>
              {/* Progress bars (1 per item) */}
              <View style={{ position: 'absolute', top: Platform.OS === 'ios' ? 50 : 10, left: 8, right: 8, flexDirection: 'row', gap: 4, zIndex: 10 }}>
                {items.map((_, i) => (
                  <View key={i} style={{ flex: 1, height: 2.5, backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 2 }}>
                    {i <= (statusViewIdx || 0) && <View style={{ width: '100%', height: '100%', backgroundColor: '#fff', borderRadius: 2 }} />}
                  </View>
                ))}
              </View>
              {/* Header */}
              <View style={{ position: 'absolute', top: Platform.OS === 'ios' ? 60 : 20, left: 12, right: 12, flexDirection: 'row', alignItems: 'center', zIndex: 10 }}>
                <AvatarCircle name={displayName} email={group.email} size={36} />
                <View style={{ flex: 1, marginLeft: 10 }}>
                  <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>{displayName}</Text>
                  <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11 }}>
                    {(() => { try { const d = new Date(item.created_at); const h = Math.round((Date.now() - d.getTime()) / 3600000); return h < 1 ? 'Agora' : h + 'h'; } catch { return ''; } })()}
                  </Text>
                </View>
                <TouchableOpacity onPress={() => { setStatusViewerEmail(null); setStatusViewIdx(0); }} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' }}>
                  <IconX size={18} color="#fff" />
                </TouchableOpacity>
              </View>
              {/* Content */}
              {isImage && mediaUrl ? (
                Platform.OS === 'web'
                  ? <img src={mediaUrl} alt="" style={{ flex: 1, width: '100%', height: '100%', objectFit: 'contain' }} />
                  : <Image source={{ uri: mediaUrl }} style={{ flex: 1, width: '100%' }} resizeMode="contain" />
              ) : isVideo && mediaUrl ? (
                Platform.OS === 'web'
                  ? <video src={mediaUrl} autoPlay playsInline loop style={{ flex: 1, width: '100%', objectFit: 'contain' }} />
                  : (() => { try { const { Video } = require('expo-av'); return <Video source={{ uri: mediaUrl }} style={{ flex: 1 }} resizeMode="contain" shouldPlay isLooping />; } catch { return null; } })()
              ) : (
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30 }}>
                  <Text style={{ color: '#fff', fontSize: 24, fontWeight: '600', textAlign: 'center', lineHeight: 34 }}>{raw}</Text>
                </View>
              )}
              {caption ? (
                <View style={{ position: 'absolute', bottom: 50, left: 16, right: 16, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 12, padding: 12 }}>
                  <Text style={{ color: '#fff', fontSize: 15, textAlign: 'center' }}>{caption}</Text>
                </View>
              ) : null}
              {/* Tap zones: left=prev, right=next */}
              <View style={{ position: 'absolute', top: 100, left: 0, right: 0, bottom: 60, flexDirection: 'row', zIndex: 5 }} pointerEvents="box-none">
                <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => {
                  if ((statusViewIdx || 0) > 0) setStatusViewIdx(i => (i || 0) - 1);
                  else { setStatusViewerEmail(null); setStatusViewIdx(0); }
                }} />
                <TouchableOpacity style={{ flex: 1 }} activeOpacity={1} onPress={() => {
                  if ((statusViewIdx || 0) < items.length - 1) setStatusViewIdx(i => (i || 0) + 1);
                  else { setStatusViewerEmail(null); setStatusViewIdx(0); }
                }} />
              </View>
              {/* Music indicator */}
              {item.music_title ? (
                <View style={{ position: 'absolute', bottom: caption ? 100 : 50, left: 16, right: 16, flexDirection: 'row', alignItems: 'center', gap: 8, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 20, paddingHorizontal: 12, paddingVertical: 6 }}>
                  <Text style={{ fontSize: 14 }}>🎵</Text>
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 }} numberOfLines={1}>{item.music_title} — {item.music_artist}</Text>
                </View>
              ) : null}
            </View>
          );
        })()}
      </Modal>

      {/* Instagram-style custom camera (native only) */}
      <StatusCamera
        visible={showCustomCamera}
        t={t}
        onClose={() => setShowCustomCamera(false)}
        onCapture={({ uri, type }) => {
          setShowCustomCamera(false);
          const isVideo = type === 'video';
          setStatusEditor({ uri, type: isVideo ? 'video' : 'image', file: { uri, name: isVideo ? 'status.mp4' : 'status.jpg', type: isVideo ? 'video/mp4' : 'image/jpeg' } });
          setStatusCaption('');
        }}
      />

      {/* Status Editor — FULLSCREEN preview + caption + emoji stickers (Instagram-like) */}
      <Modal visible={!!statusEditor} transparent={false} animationType="slide" onRequestClose={() => { setStatusEditor(null); setStatusCaption(''); }}>
        {statusEditor && (
        <View style={{ flex:1, backgroundColor:'#000' }}>
          <View style={{ flex: 1, justifyContent:'center', alignItems:'center' }}>
            {statusEditor.type === 'image' ? (
              <Image source={{ uri: statusEditor.uri }} style={{ width:'100%', height:'100%', resizeMode:'contain' }} />
            ) : (
              Platform.OS === 'web'
                ? <video src={statusEditor.uri} autoPlay loop playsInline muted style={{ width:'100%', height:'100%', objectFit:'contain' }} />
                : (() => { try { const { Video } = require('expo-av'); return <Video source={{ uri: statusEditor.uri }} style={{ width:'100%', height:'100%' }} resizeMode="contain" shouldPlay isLooping isMuted />; } catch { return null; } })()
            )}
          </View>
          <View style={{ position:'absolute', top:40, left:12, right:12, flexDirection:'row', justifyContent:'space-between', alignItems:'center' }}>
            <TouchableOpacity onPress={() => { setStatusEditor(null); setStatusCaption(''); }} style={{ width:40, height:40, borderRadius:20, backgroundColor:'rgba(0,0,0,0.55)', alignItems:'center', justifyContent:'center' }}>
              <Text style={{ color:'#fff', fontSize:20 }}>✕</Text>
            </TouchableOpacity>
          </View>
          <View style={{ position:'absolute', bottom:140, left:0, right:0, flexDirection:'row', justifyContent:'center', flexWrap:'wrap', gap:8, paddingHorizontal:16 }}>
            {['😂','❤️','🔥','👏','😮','😢','🎉','🙌'].map(em => (
              <TouchableOpacity key={em} onPress={() => setStatusCaption(c => (c + ' ' + em).trim())} style={{ width:42, height:42, borderRadius:21, backgroundColor:'rgba(0,0,0,0.45)', alignItems:'center', justifyContent:'center' }}>
                <Text style={{ fontSize:22 }}>{em}</Text>
              </TouchableOpacity>
            ))}
          </View>
          <View style={{ position:'absolute', bottom:40, left:12, right:12, flexDirection:'row', alignItems:'center', gap:10 }}>
            <View style={{ flex:1, backgroundColor:'rgba(0,0,0,0.55)', borderRadius:24, paddingHorizontal:16, paddingVertical:10 }}>
              <TextInput
                value={statusCaption}
                onChangeText={setStatusCaption}
                placeholder={t('status.captionPlaceholder') || 'Escreva uma legenda...'}
                placeholderTextColor="rgba(255,255,255,0.6)"
                style={{ color:'#fff', fontSize:15, padding:0, ...(Platform.OS === 'web' ? { outlineStyle:'none' } : {}) }}
                maxLength={500}
                multiline
              />
            </View>
            <TouchableOpacity
              disabled={statusPublishing}
              onPress={async () => {
                if (statusPublishing) return;
                setStatusPublishing(true);
                try {
                  const up = await api.statusUpload(statusEditor.file);
                  if (up?.success && up.data?.url) {
                    const content = statusCaption.trim() ? (up.data.url + '\n' + statusCaption.trim()) : up.data.url;
                    await api.statusPublish(content, statusEditor.type === 'video' ? 'video' : 'image', '#000000');
                    setStatusEditor(null); setStatusCaption('');
                    load();
                  }
                } catch {} finally { setStatusPublishing(false); }
              }}
              style={{ width:54, height:54, borderRadius:27, backgroundColor:'#7C3AED', alignItems:'center', justifyContent:'center', opacity: statusPublishing ? 0.6 : 1 }}
            >
              {statusPublishing ? <ActivityIndicator color="#fff" /> : <Text style={{ color:'#fff', fontSize:22, fontWeight:'700' }}>→</Text>}
            </TouchableOpacity>
          </View>
        </View>
        )}
      </Modal>
    </View>
  );
}

export default function ChatListTab({ colors, isDark, t, user, router, searchQuery = '', setActiveTab }) {
  // Try MMKV preload first; fall back to the native SQLite cache (iOS).
  // Both reads are synchronous so the very first render already has data,
  // eliminating the empty-list flash that was happening before.
  const _initialConvs = (() => {
    if (_preloadedConversations?.length) return _preloadedConversations;
    const native = _readNativeConversationsSync();
    return native || [];
  })();
  const [conversations, setConversations] = useState(() => _initialConvs.filter(c => !c.archived));
  const [archivedConversations, setArchivedConversations] = useState(() => _initialConvs.filter(c => c.archived));
  // Sync ref for conversations count — avoids async setState detection bug
  const _convsCountRef = useRef(_initialConvs.length);
  _convsCountRef.current = conversations?.length || 0;
  // Skip the loading spinner if we already painted from cache
  const [loading, setLoading] = useState(_initialConvs.length === 0);
  const [refreshing, setRefreshing] = useState(false);
  // Local searchText kept for the legacy chatConversations() network call
  // path; mirrors the parent-provided searchQuery prop so the same value
  // drives both the filter and the debounced server request. Removed the
  // duplicate TextInput (parent now owns the visible search bar).
  const [searchText, setSearchText] = useState('');
  useEffect(() => { setSearchText(searchQuery || ''); }, [searchQuery]);
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
  const [chatFolders, setChatFolders] = useState([]);

  // Instagram Notes state
  const [notes, setNotes] = useState([]);
  const [myNote, setMyNote] = useState(null);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [showStatusComposer, setShowStatusComposer] = useState(false);
  const [noteInput, setNoteInput] = useState('');

  // Load chat folders (custom user filters)
  useEffect(() => {
    let alive = true;
    api.chatFoldersList().then(r => {
      if (!alive) return;
      if (r?.success && Array.isArray(r.data?.folders)) {
        setChatFolders(r.data.folders);
      }
    }).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Load Instagram Notes
  useEffect(() => {
    let alive = true;
    const loadNotes = () => {
      api.chatGetNotes().then(r => {
        if (!alive) return;
        if (r?.success) {
          setNotes(r.data?.notes || []);
          setMyNote(r.data?.my_note || null);
        }
      }).catch(() => {});
    };
    loadNotes();
    const interval = setInterval(loadNotes, 60000); // refresh every 60s
    return () => { alive = false; clearInterval(interval); };
  }, []);

  const handleSetNote = useCallback(async (overrideText) => {
    const text = (overrideText !== undefined ? overrideText : noteInput).trim();
    try {
      const r = await api.chatSetNote(text);
      if (r?.success) {
        if (text) {
          setMyNote({ email: user?.email, content: text, created_at: new Date().toISOString() });
        } else {
          setMyNote(null);
        }
        setShowNoteModal(false);
        setNoteInput('');
      }
    } catch {}
  }, [noteInput, user?.email]);

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
    // Single-flight sequencing: focus + refresh + WS fallback + search debounce
    // can all fire loadConversations() near-simultaneously. Without a
    // sequence id, a slow OLDER request can resolve AFTER a newer one and
    // overwrite the up-to-date list with stale data → flicker / order
    // rollback the user reports as "list jumping".
    const seq = ++loadConvSeqRef.current;
    const isFresh = () => seq === loadConvSeqRef.current;
    // FAST PATH: already have data on screen → skip SQLite read entirely,
    // go straight to silent background delta sync (no flicker, no wait).
    // Use sync detection — async setState side-effect was causing wrong
    // alreadyHasVisible on iOS, making the app skip API fetch entirely.
    const alreadyHasVisible = _convsCountRef.current > 0;

    if (alreadyHasVisible && !searchText) {
      // Data is already painted — silent delta sync only
      api.chatConversations('', false).then(r => {
        if (!isFresh()) return;
        if (!r?.success) return;
        const convs = Array.isArray(r.data) ? r.data : (r.data?.conversations || []);
        if (!convs.length) return;
        const fpNew = convs.map(c => `${c.id}:${c.unread_count ?? 0}:${c.updated_at || c.last_message_at || ''}`).join('|');
        if (fpNew === lastConvsRef.current) return; // unchanged — skip setState
        lastConvsRef.current = fpNew;
        setConversations(convs.filter(c => !c.archived));
        setArchivedConversations(convs.filter(c => c.archived));
        cacheConversations(convs).catch(() => {});
        _saveNativeConversations(convs);
        mqttSubscribeAll(convs);
      }).catch(() => {});
      setLoading(false);
      setRefreshing(false);
      return;
    }

    // SLOW PATH: no data yet — check SQLite cache then API
    try {
      const cached = await getCachedConversations();
      if (!isFresh()) return;
      if (cached.length > 0) {
        setConversations(cached.filter(c => !c.archived));
        setArchivedConversations(cached.filter(c => c.archived));
        setLoading(false);
        // Background delta sync
        if (!searchText) {
          const fp = (arr) => arr.map(c => `${c.id}:${c.unread_count ?? 0}:${c.updated_at || c.last_message_at || ''}`).join('|');
          api.chatConversations('', false).then(r => {
            if (!isFresh()) return;
            if (!r?.success) return;
            const convs = Array.isArray(r.data) ? r.data : (r.data?.conversations || []);
            if (!convs.length || fp(convs) === fp(cached)) return;
            setConversations(convs.filter(c => !c.archived));
            setArchivedConversations(convs.filter(c => c.archived));
            cacheConversations(convs).catch(() => {});
            _saveNativeConversations(convs);
            mqttSubscribeAll(convs);
          }).catch(() => {});
        }
        setRefreshing(false);
        return;
      }
    } catch {}

    // NO CACHE AT ALL → full API fetch
    if (showLoader) setLoading(true);
    try {
      const r = await api.chatConversations(searchText, false);
      // Allow stale responses if screen is empty — never leave user on blank
      if (!isFresh() && _convsCountRef.current > 0) return;
      if (r.success) {
        const convs = Array.isArray(r.data) ? r.data : (r.data?.conversations || []);
        setConversations(convs.filter(c => !c.archived));
        cacheConversations(convs).catch(() => {});
        mqttSubscribeAll(convs);
      }
      const rAll = await api.chatConversations(searchText, true);
      if (!isFresh()) return;
      if (rAll.success) {
        const all = Array.isArray(rAll.data) ? rAll.data : (rAll.data?.conversations || []);
        setArchivedConversations(all.filter(c => c.archived));
        cacheConversations(all).catch(() => {});
        _saveNativeConversations(all);
      }
    } catch {} finally {
      if (isFresh()) { setLoading(false); setRefreshing(false); }
    }
  }, [searchText]);

  useEffect(() => {
    // If we already painted from MMKV/native cache, do a silent sync
    // (no spinner ever flashes). Only show the loader on a truly cold start.
    loadConversations(_initialConvs.length === 0);
    // Safety: force loading off after 5s in case API hangs
    const safety = setTimeout(() => setLoading(false), 5000);
    return () => clearTimeout(safety);
  }, [loadConversations]);

  // ─── Refresh on focus ───
  // When user navigates back from chat-conversation, immediately re-sync
  // so the last message + unread count update without delay.
  // Throttled to once per 800ms to avoid double-fires from React Navigation transitions.
  const lastFocusRefreshRef = useRef(0);
  const lastConvsRef = useRef(null);
  const loadConvSeqRef = useRef(0);
  useFocusEffect(
    useCallback(() => {
      const now = Date.now();
      if (now - lastFocusRefreshRef.current < 800) return;
      lastFocusRefreshRef.current = now;
      // Silent delta sync (no loading indicator — instant, no flicker if unchanged)
      api.chatConversations(searchText || '', false).then(r => {
        if (r?.success) {
          const convs = Array.isArray(r.data) ? r.data : (r.data?.conversations || []);
          // Fast dedup: fingerprint includes id + unread_count + updated_at
          // so we re-render when a new message arrives or unread count changes,
          // but skip the setState (and flicker) when nothing actually changed.
          const newFingerprint = convs.map(c => `${c.id}:${c.unread_count ?? 0}:${c.updated_at || c.last_message_at || ''}`).join('|');
          if (convs.length > 0 && newFingerprint !== lastConvsRef.current) {
            lastConvsRef.current = newFingerprint;
            setConversations(convs.filter(c => !c.archived));
            cacheConversations(convs).catch(() => {});
          }
        }
      }).catch(() => {});
    }, [searchText])
  );

  useEffect(() => {
    api.chatGetLocked().then(r => {
      if (r.success && r.data?.locked_conversations) {
        setLockedIds(new Set(r.data.locked_conversations.map(Number)));
      }
    }).catch(() => {});
  }, []);

  const handleSearchChange = useCallback((text) => {
    setSearchText(text);
    // ⭐ Native FTS5 search — sub-100ms even with 100k cached messages.
    // Returns matching MESSAGES with their conversation info; we use that
    // to highlight which conversations have a match. If the native cache
    // is unavailable we fall through to the network search below.
    if (Platform.OS === 'ios' && text.trim().length >= 2 && _NativeChatCache?.searchMessagesSync) {
      try {
        const hits = _NativeChatCache.searchMessagesSync(text.trim(), 200);
        if (Array.isArray(hits) && hits.length > 0) {
          const convIds = new Set(hits.map(m => m.conversation_id).filter(Boolean));
          setConversations(prev => prev.filter(c => convIds.has(c.id)));
          return; // Don't hit the network — instant local result
        }
      } catch {}
    }
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
          // Don't bump unread for messages we sent ourselves (echoed back
          // by relay) — without this, the badge counts the user's own
          // outgoing messages.
          const senderEmail = (data.sender_email || data.sender || '').toLowerCase();
          const isSelf = senderEmail && user?.email && senderEmail === String(user.email).toLowerCase();
          // Spring LayoutAnimation when conversation moves to top
          try {
            LayoutAnimation.configureNext({
              duration: 300,
              update: { type: LayoutAnimation.Types.spring, springDamping: 0.7 },
            });
          } catch {}
          setConversations(prev => {
            const idx = prev.findIndex(c => c.id == data.conversation_id || c.conversation_id == data.conversation_id);
            if (idx === -1) {
              loadConversations(false);
              return prev;
            }
            // Move updated conversation to top with spring animation
            const updated = {
              ...prev[idx],
              last_message: {
                ...(prev[idx].last_message || {}),
                content: data.content || data.message,
                type: data.type || 'text',
                sender_email: data.sender_email || data.sender,
                sender_name: data.sender_name || data.sender_email || data.sender,
                created_at: data.created_at || new Date().toISOString(),
              },
              last_message_type: data.type || 'text',
              last_message_sender: data.sender_email || data.sender,
              last_message_at: data.created_at || new Date().toISOString(),
              unread_count: isSelf ? (prev[idx].unread_count || 0) : ((prev[idx].unread_count || 0) + 1),
            };
            // Keep pinned conversations at top, insert updated after pinned
            const pinned = prev.filter((c, i) => i !== idx && !!c.pinned);
            const unpinned = prev.filter((c, i) => i !== idx && !c.pinned);
            if (updated.pinned) {
              return [updated, ...pinned.filter(c => c.id !== updated.id), ...unpinned];
            }
            return [...pinned, updated, ...unpinned];
          });
        }, 100);
      }));

      unsubs.push(mailWs.on('chat_read', (data) => {
        setConversations(prev => {
          const idx = prev.findIndex(c => c.id == data.conversation_id || c.conversation_id == data.conversation_id);
          if (idx === -1) return prev;
          // Only update the specific conversation, return prev for unchanged
          return prev.map((c, i) => {
            if (i !== idx) return c;
            return { ...c, unread_count: 0 };
          });
        });
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
        if (p && p.status) newMap.set(email, { status: p.status, last_seen: p.last_seen || '' });
      }
      // Merge with existing (don't lose entries not in this response)
      let changed = false;
      for (const [email, val] of newMap) {
        const cur = presencesRef.current.get(email);
        if (!cur || cur.status !== val.status || cur.last_seen !== val.last_seen) {
          changed = true;
          break;
        }
      }
      if (!changed && newMap.size !== presencesRef.current.size) changed = true;
      if (changed) {
        // Merge: keep existing entries, update with new ones
        const merged = new Map(presencesRef.current);
        for (const [email, val] of newMap) {
          merged.set(email, val);
        }
        presencesRef.current = merged;
        setPresenceVersion(v => v + 1);
      }
    });

    // Listen for real-time presence broadcasts (online/offline changes)
    const unsubPresence = mailWs.on('presence', (data) => {
      if (data?.email && data?.status) {
        const cur = presencesRef.current.get(data.email);
        const newVal = { status: data.status, last_seen: data.last_seen || new Date().toISOString() };
        if (!cur || cur.status !== newVal.status) {
          const merged = new Map(presencesRef.current);
          merged.set(data.email, newVal);
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
    const unreadParam = (conv.unread_count > 0) ? `&unread=${conv.unread_count}` : '';
    router.push(`/chat-conversation?id=${conv.id}&name=${encodeURIComponent(displayName)}&type=${conv.type}${emailParam}${unreadParam}`);
  }, [user?.email, router]);

  const toggleFabMenu = useCallback(() => {
    if (showFabMenu) {
      Animated.timing(fabMenuAnim, { toValue: 0, duration: 200, useNativeDriver: false }).start(() => setShowFabMenu(false));
    } else {
      setShowFabMenu(true);
      Animated.spring(fabMenuAnim, { toValue: 1, tension: 100, friction: 12, useNativeDriver: false }).start();
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

  const handleMarkUnreadConversation = useCallback(async (conv) => {
    try {
      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, unread_count: Math.max(c.unread_count || 0, 1) } : c));
      await api.chatMarkUnread(conv.id);
    } catch {}
  }, []);

  const unreadCount = useMemo(() => conversations.filter(c => c.unread_count > 0).length, [conversations]);
  const groupCount = useMemo(() => conversations.filter(c => c.type === 'group').length, [conversations]);
  const channelCount = useMemo(() => conversations.filter(c => c.type === 'channel').length, [conversations]);
  const favoritesCount = useMemo(() => conversations.filter(c => c.pinned).length, [conversations]);
  const archivedCount = archivedConversations.length;

  // ─── Draft indicators (AsyncStorage-backed) ───
  const [drafts, setDrafts] = useState({});
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const keys = await AsyncStorage.getAllKeys();
        const draftKeys = keys.filter(k => k.startsWith('chat_draft_'));
        if (draftKeys.length === 0) { if (alive) setDrafts({}); return; }
        const pairs = await AsyncStorage.multiGet(draftKeys);
        const d = {};
        for (const [key, val] of pairs) {
          if (val && val.trim()) {
            const convId = key.replace('chat_draft_', '');
            d[convId] = val;
          }
        }
        if (alive) setDrafts(d);
      } catch {}
    })();
    return () => { alive = false; };
  }, [conversations]);

  const filteredConversations = useMemo(() => {
    if (filter === 'archived') return archivedConversations;
    // Folder filter: filter values like "folder_<id>" → match by folder filter_type/value
    let folderFilter = null;
    if (typeof filter === 'string' && filter.startsWith('folder_')) {
      const fid = parseInt(filter.slice(7), 10);
      folderFilter = chatFolders.find(f => Number(f.id) === fid) || null;
    }
    const sq = (searchQuery || '').trim().toLowerCase();
    let list = conversations.filter(c => {
      if (filter === 'unread') return c.unread_count > 0;
      if (filter === 'favorites') return !!c.pinned;
      if (filter === 'groups') return c.type === 'group';
      if (filter === 'channels') return c.type === 'channel';
      if (folderFilter) {
        const ft = folderFilter.filter_type;
        const fv = folderFilter.filter_value;
        if (ft === 'unread') return c.unread_count > 0;
        if (ft === 'groups') return c.type === 'group';
        if (ft === 'channels') return c.type === 'channel';
        if (ft === 'tag' && fv) return (c.tags || '').split(',').includes(fv);
        if (ft === 'name' && fv) return (c.name || '').toLowerCase().includes(String(fv).toLowerCase());
        return true;
      }
      return true;
    });
    // WhatsApp-style search: match conversation display name, last message,
    // and member emails/names. `display_name` is what the UI actually shows
    // (ChatListTab:251), so we MUST match against it too.
    if (sq) {
      list = list.filter(c => {
        try {
          const rawName = String(c.display_name || c.name || c.other_email || '').toLowerCase();
          if (rawName.includes(sq)) return true;
          // Also try the email-to-display-name conversion used by the UI so a
          // search for "rene" matches "rene.reis@…" → "Rene Reis".
          const pretty = String(emailToDisplayName(c.display_name || c.name || c.other_email || '') || '').toLowerCase();
          if (pretty && pretty.includes(sq)) return true;
          // last_message is an OBJECT ({content, sender_email, ...}), not a
          // string. Extract `.content` defensively. The previous code called
          // .toLowerCase() on the raw object → TypeError → entire useMemo
          // crashed → React fell back to the unfiltered list (the symptom
          // the user saw: typing "An" showed everything).
          let lastStr = '';
          const lm = c.last_message;
          if (typeof lm === 'string') lastStr = lm;
          else if (lm && typeof lm === 'object') lastStr = String(lm.content || lm.text || '');
          else if (c.last_message_content) lastStr = String(c.last_message_content);
          if (lastStr && lastStr.toLowerCase().includes(sq)) return true;
          // Member email/name match (groups, etc.)
          const members = c.members;
          if (Array.isArray(members)) {
            for (const m of members) {
              const s = (typeof m === 'string' ? m : (m?.email || m?.name || ''));
              if (String(s).toLowerCase().includes(sq)) return true;
            }
          }
          return false;
        } catch {
          return false;
        }
      });
    }
    list.sort((a, b) => {
      const aPinned = a.pinned ? 1 : 0;
      const bPinned = b.pinned ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return (b.last_message_at || '').localeCompare(a.last_message_at || '');
    });
    return list;
  }, [filter, conversations, archivedConversations, searchQuery, chatFolders]);

  // Remote message search — fires when the user types 2+ chars.
  // Uses a monotonic request ID ref instead of a closure-scoped `cancelled`
  // flag so out-of-order responses (HTTP/2 multiplexing, HTTP/3 QUIC) can't
  // overwrite newer state. Also accepts multiple response shapes from the
  // backend (`data: []` or `data.results: []` or `data.hits: []`).
  const [messageHits, setMessageHits] = useState([]);
  const [searchingMessages, setSearchingMessages] = useState(false);
  const latestSearchReqId = useRef(0);
  useEffect(() => {
    const q = (searchQuery || '').trim();
    if (q.length < 2) {
      latestSearchReqId.current++; // invalidate any in-flight request
      setMessageHits([]);
      setSearchingMessages(false);
      return;
    }
    const myId = ++latestSearchReqId.current;
    setSearchingMessages(true);
    const timer = setTimeout(async () => {
      try {
        const r = await api.apiCall('chat_search', { query: q, limit: 20 });
        if (myId !== latestSearchReqId.current) return; // stale response
        // Backend chat_search returns `data` as array directly. Older clones
        // might wrap in `data.results` or `data.hits`. Accept any of them.
        const raw = r?.success
          ? (Array.isArray(r.data) ? r.data : (r.data?.results ?? r.data?.hits ?? []))
          : [];
        setMessageHits(Array.isArray(raw) ? raw : []);
      } catch {
        if (myId === latestSearchReqId.current) setMessageHits([]);
      } finally {
        if (myId === latestSearchReqId.current) setSearchingMessages(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

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
                backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#ffffff',
                borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
                ...(isWeb ? { boxShadow: isDark ? 'none' : '0 1px 2px rgba(0,0,0,0.04)' } : {}),
              },
          isWeb && { transition: 'all 0.18s cubic-bezier(0.4,0,0.2,1)', cursor: 'pointer' },
        ]}
        onPress={() => setFilter(filter === value ? 'all' : value)}
        activeOpacity={0.7}
      >
        <Text style={[s.chipText, active ? { color: '#fff' } : { color: isDark ? '#cbd5e1' : '#475569' }]}>
          {label}
        </Text>
        {count > 0 ? (
          <View style={[
            s.chipBadge,
            {
              backgroundColor: active ? 'rgba(255,255,255,0.28)' : (isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.12)'),
            },
          ]}>
            <Text style={[s.chipBadgeText, { color: active ? '#fff' : '#7C3AED' }]}>{count > 99 ? '99+' : count}</Text>
          </View>
        ) : null}
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
              ? 'linear-gradient(135deg, rgba(124,58,237,0.06) 0%, rgba(109,40,217,0.06) 100%)'
              : 'linear-gradient(135deg, rgba(124,58,237,0.06) 0%, rgba(109,40,217,0.04) 100%)',
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

  // Build a map of email -> note content for quick lookup
  const notesMap = useMemo(() => {
    const map = {};
    for (const n of notes) {
      if (n.email && n.content) map[n.email] = n.content;
    }
    return map;
  }, [notes]);

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
          onMarkUnread={handleMarkUnreadConversation}
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
            if (p instanceof Map) { const v = p.get(otherEmail); return v?.status === 'online' || v === 'online'; }
            return false;
          })()}
          lastSeen={(() => {
            if (item.type === 'group') return null;
            const members = item.members || [];
            const other = members.find(m => {
              if (m && typeof m === 'object') return m.email !== user?.email;
              if (typeof m === 'string') return m !== user?.email;
              return false;
            });
            const otherEmail = other ? (typeof other === 'string' ? other : other?.email) : null;
            if (!otherEmail) return null;
            const p = presencesRef.current;
            if (p instanceof Map) { const v = p.get(otherEmail); return v?.last_seen || null; }
            return null;
          })()}
          isLocked={lockedIds.has(item.id) && !unlockedIds.has(item.id)}
          typingUsers={typingUsers}
          selectionMode={selectionMode}
          isSelected={selectedIds.has(item.id)}
          onLongPress={() => enterSelectionMode(item.id)}
          onToggleSelect={() => toggleSelected(item.id)}
          draftText={drafts[String(item.id)] || null}
          noteText={(() => {
            if (item.type !== 'direct') return null;
            const members = item.members || [];
            const other = members.find(m => {
              if (m && typeof m === 'object') return m.email !== user?.email;
              if (typeof m === 'string') return m !== user?.email;
              return false;
            });
            const otherEmail = other ? (typeof other === 'string' ? other : other?.email) : null;
            return otherEmail ? (notesMap[otherEmail] || null) : null;
          })()}
        />
      </>
    );
  }, [filter, pinnedCount, isDark, colors, t, handleConversationPress, handleDeleteConversation, handleArchiveConversation, handleMuteConversation, handlePinConversation, handleMarkUnreadConversation, user?.email, lockedIds, unlockedIds, typingUsers, selectionMode, selectedIds, enterSelectionMode, toggleSelected, drafts, notesMap]);
  // NOTE: presenceVersion removed from deps to prevent 15s flicker cycle
  // isOnline calculated inside ConversationRow using presencesRef directly

  const keyExtractor = useCallback((item) => String(item.id), []);

  const ListHeaderComponent = useMemo(() => (
    <>
      {/* Chatyy One AI quick access (like Snapchat's My AI) */}
      {!(searchQuery || '').trim() && (
        <TouchableOpacity
          onPress={() => { try { router.push('/one'); } catch {} }}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 12,
            paddingHorizontal: 16, paddingVertical: 12,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
          }}
        >
          <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: '#7C3AED', alignItems: 'center', justifyContent: 'center',
            ...(isWeb ? { boxShadow: '0 2px 12px rgba(124,58,237,0.4)' } : {}) }}>
            <Svg width={24} height={24} viewBox="0 0 24 24" fill="none">
              <Path d="M12 3l1.8 4.6L18 9l-4.2 1.4L12 15l-1.8-4.6L6 9l4.2-1.4z" fill="#fff" />
              <Path d="M19 15l.9 2.3L22 18l-2.1.7L19 21l-.9-2.3L16 18l2.1-.7z" fill="#fff" />
            </Svg>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
              {t?.('one.title') || 'Chatyy One'}
            </Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }} numberOfLines={1}>
              {t?.('one.subtitle') || 'Pergunte qualquer coisa • IA pessoal'}
            </Text>
          </View>
          <View style={{ backgroundColor: '#7C3AED', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3 }}>
            <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700', letterSpacing: 0.5 }}>AI</Text>
          </View>
        </TouchableOpacity>
      )}

      {/* Status stories (Instagram-style) — only when not searching */}
      {!(searchQuery || '').trim() && (
        <StatusStoriesRow colors={colors} isDark={isDark} user={user} router={router} t={t} setActiveTab={setActiveTab} />
      )}
      {renderArchivedHeader()}
      {renderPinnedLabel()}
      {(searchQuery || '').trim().length >= 2 && filteredConversations.length > 0 && (
        <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: isDark ? '#a78bfa' : '#7C3AED', letterSpacing: 0.3 }}>
            CONVERSAS
          </Text>
        </View>
      )}
    </>
  ), [filter, pinnedCount, isDark, colors, t, archivedCount, searchQuery, filteredConversations.length, user, router]);

  // Footer: "MENSAGENS" section with chat_search hits, shown when searching
  const ListFooterComponent = useMemo(() => {
    const sq = (searchQuery || '').trim();
    if (sq.length < 2) return null;
    return (
      <View style={{ paddingTop: 8 }}>
        <View style={{ paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: isDark ? '#a78bfa' : '#7C3AED', letterSpacing: 0.3 }}>
            MENSAGENS
          </Text>
          {searchingMessages && <ActivityIndicator size="small" color={isDark ? '#a78bfa' : '#7C3AED'} />}
        </View>
        {messageHits.length === 0 && !searchingMessages && (
          <View style={{ paddingHorizontal: 16, paddingVertical: 12 }}>
            <Text style={{ fontSize: 14, color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.4)' }}>
              {'Nenhuma mensagem encontrada'}
            </Text>
          </View>
        )}
        {messageHits.map((hit) => {
          const snippet = (hit.snippet || hit.content || '').replace(/<b>/g, '').replace(/<\/b>/g, '');
          const convName = hit.conv_name || hit.conversation_name || (hit.sender_email || '').split('@')[0];
          const date = hit.created_at ? new Date(hit.created_at).toLocaleDateString() : '';
          return (
            <TouchableOpacity
              key={`hit-${hit.id}`}
              onPress={() => router.push({
                pathname: '/chat-conversation',
                params: {
                  conversationId: String(hit.conversation_id),
                  scrollToMessageId: String(hit.id),
                  highlightMessageId: String(hit.id),
                },
              })}
              activeOpacity={0.7}
              style={{
                flexDirection: 'row', alignItems: 'center',
                paddingHorizontal: 16, paddingVertical: 10, gap: 12,
                borderBottomWidth: 0.5,
                borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)',
              }}
            >
              <View style={{
                width: 40, height: 40, borderRadius: 20,
                backgroundColor: isDark ? 'rgba(167,139,250,0.18)' : 'rgba(124,58,237,0.1)',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <IconSearch size={18} color={isDark ? '#a78bfa' : '#7C3AED'} />
              </View>
              <View style={{ flex: 1 }}>
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Text style={{ fontSize: 15, fontWeight: '600', color: colors.text }} numberOfLines={1}>
                    {convName}
                  </Text>
                  <Text style={{ fontSize: 11, color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)' }}>
                    {date}
                  </Text>
                </View>
                <Text style={{ fontSize: 13, color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)', marginTop: 2 }} numberOfLines={2}>
                  {snippet}
                </Text>
              </View>
            </TouchableOpacity>
          );
        })}
      </View>
    );
  }, [searchQuery, messageHits, searchingMessages, isDark, colors, router]);

  const ListEmptyComponent = useMemo(() => loading ? null : (
    <View style={s.emptyContainer}>
      <EmptyBubbles isDark={isDark} />
      <View style={{ marginTop: 24 }}>
        {isWeb ? (
          <Text style={[s.emptyTitle, {
            backgroundImage: `linear-gradient(135deg, ${ACCENT} 0%, #A78BFA 50%, ${ACCENT2} 100%)`,
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
          background: `linear-gradient(135deg, ${ACCENT} 0%, #A78BFA 100%)`,
        }]}
        onPress={() => router.push('/chat-new')}
        activeOpacity={0.8}
      >
        <Text style={s.emptyActionText}>{t('chat.newConversation') || 'Iniciar conversa'}</Text>
      </TouchableOpacity>
    </View>
  ), [loading, isDark, colors, t, router]);

  const ItemSeparatorComponent = useCallback(() => (
    <View style={[s.separator, { backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.05)', marginLeft: 84, marginRight: 18 }]} />
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
          backgroundColor: isDark ? 'rgba(124,58,237,0.12)' : 'rgba(124,58,237,0.08)',
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

      {/* Search is rendered by the parent (chat.js) as a WhatsApp-style
          toggleable bar in the header. The `searchQuery` prop is piped in
          and drives `filteredConversations` below. No duplicate input here. */}
      {!selectionMode && <>
      {/* Instagram Notes strip — only shown when there are notes to display,
          otherwise the status/stories row already surfaces the "Seu status"
          CTA and we'd have two duplicate affordances. */}
      {(notes.length > 0 || myNote) && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={{ flexGrow: 0, flexShrink: 0, height: 90 }}
          contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 8, gap: 12, alignItems: 'center' }}
        >
          {/* Set your note button */}
          <TouchableOpacity
            onPress={() => { setNoteInput(myNote?.content || ''); setShowNoteModal(true); }}
            style={{ alignItems: 'center', width: 64 }}
          >
            <View style={{
              width: 52, height: 52, borderRadius: 26,
              borderWidth: 2, borderColor: myNote ? ACCENT : (isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'),
              borderStyle: myNote ? 'solid' : 'dashed',
              alignItems: 'center', justifyContent: 'center',
              backgroundColor: isDark ? 'rgba(124,58,237,0.08)' : 'rgba(124,58,237,0.05)',
            }}>
              {myNote ? (
                <Text style={{ fontSize: 9, color: colors.text, textAlign: 'center', paddingHorizontal: 3 }} numberOfLines={2}>
                  {myNote.content}
                </Text>
              ) : (
                <Text style={{ fontSize: 20, color: ACCENT, fontWeight: '300' }}>+</Text>
              )}
            </View>
            <Text style={{ fontSize: 10, color: colors.textSecondary, marginTop: 3, fontWeight: '600' }} numberOfLines={1}>
              {myNote ? (t('chat.setNote') || 'Set note') : (t('chat.setNote') || 'Set note')}
            </Text>
          </TouchableOpacity>
          {/* Other users' notes */}
          {notes.map((note) => {
            const displayName = emailToDisplayName(note.email || '');
            return (
              <View key={note.email} style={{ alignItems: 'center', width: 64 }}>
                <View style={{
                  width: 52, height: 52, borderRadius: 26,
                  borderWidth: 2, borderColor: ACCENT,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: isDark ? 'rgba(124,58,237,0.12)' : 'rgba(124,58,237,0.06)',
                  padding: 3,
                }}>
                  <Text style={{ fontSize: 9, color: colors.text, textAlign: 'center' }} numberOfLines={2}>
                    {note.content}
                  </Text>
                </View>
                <Text style={{ fontSize: 10, color: colors.textSecondary, marginTop: 3, fontWeight: '500' }} numberOfLines={1}>
                  {displayName.split(' ')[0]}
                </Text>
              </View>
            );
          })}
        </ScrollView>
      )}
      {/* Filters */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={{ flexGrow: 0, flexShrink: 0, height: 50 }}
        contentContainerStyle={s.filtersRow}
      >
        <FilterChip label={t('chat.filterAll') || 'Todas'} value="all" />
        <FilterChip label={t('chat.filterUnread') || 'Nao lidas'} value="unread" count={unreadCount} />
        <FilterChip label={t('chat.filterFavorites') || 'Favoritas'} value="favorites" count={favoritesCount} />
        <FilterChip label={t('chat.filterGroups') || 'Grupos'} value="groups" count={groupCount} />
        <FilterChip label={t('chat.channels') || 'Canais'} value="channels" count={channelCount} />
        {chatFolders.map(f => (
          <FilterChip key={f.id} label={(f.icon ? f.icon + ' ' : '') + f.name} value={`folder_${f.id}`} />
        ))}
        <FilterChip label={t('chat.filterArchived') || 'Arquivadas'} value="archived" count={archivedCount} />
      </ScrollView>
      </>}

      {/* List */}
      {loading && !refreshing ? (
        <View style={{ flex: 1, paddingTop: 8 }}>
          {(() => {
            // Native CAGradientLayer shimmer skeletons (iOS) — much smoother
            // than the JS placeholder loop. Falls back to the JS skeletons
            // on Android/web.
            if (Platform.OS === 'ios') {
              try {
                const { Skeleton } = require('../modules/expo-native-toolkit');
                if (Skeleton) {
                  return [0, 1, 2, 3, 4, 5, 6].map(i => (
                    <Skeleton key={i} variant="chatRow" style={{ height: 72, width: '100%' }} />
                  ));
                }
              } catch {}
            }
            return [0, 1, 2, 3, 4, 5, 6].map(i => <SkeletonRow key={i} isDark={isDark} index={i} />);
          })()}
        </View>
      ) : (
        <ListComponent
          data={filteredConversations}
          keyExtractor={keyExtractor}
          estimatedItemSize={80}
          ListHeaderComponent={ListHeaderComponent}
          ListFooterComponent={ListFooterComponent}
          renderItem={renderItem}
          ListEmptyComponent={ListEmptyComponent}
          contentContainerStyle={[filteredConversations.length === 0 && s.listEmpty]}
          ItemSeparatorComponent={ItemSeparatorComponent}
          removeClippedSubviews={Platform.OS !== 'web'}
          initialNumToRender={15}
          maxToRenderPerBatch={10}
          windowSize={10}
          updateCellsBatchingPeriod={30}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={ACCENT}
              colors={[ACCENT, ACCENT2]}
              progressBackgroundColor={isDark ? '#1F2C33' : '#fff'}
            />
          }
          extraData={{ typingUsers, selectionMode, lockedIds, unlockedIds, isDark, colors }}
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
              <View style={[s.fabMenuIcon, { backgroundColor: '#6D28D9' }]}>
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

      {/* Set Note Modal */}
      {showNoteModal && (
        <View style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center',
          zIndex: 100,
        }}>
          <TouchableOpacity style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} activeOpacity={1} onPress={() => setShowNoteModal(false)} />
          <View style={{
            width: 300, borderRadius: 20, padding: 24,
            backgroundColor: isDark ? '#1F2C33' : '#fff',
            ...(isWeb ? { boxShadow: '0 12px 40px rgba(0,0,0,0.3)' } : { elevation: 10 }),
          }}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text, textAlign: 'center', marginBottom: 4 }}>
              {t('chat.setNote') || 'Set note'}
            </Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center', marginBottom: 16 }}>
              {t('chat.noteHint') || 'Share what you are thinking...'}
            </Text>
            <TextInput
              value={noteInput}
              onChangeText={(v) => setNoteInput(v.slice(0, 60))}
              placeholder={t('chat.notePlaceholder') || 'Your note (max 60 chars)'}
              placeholderTextColor={colors.textTertiary || '#999'}
              maxLength={60}
              style={{
                borderWidth: 1.5, borderColor: isDark ? 'rgba(255,255,255,0.15)' : 'rgba(0,0,0,0.12)',
                borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10,
                fontSize: 15, color: colors.text, textAlign: 'center',
                backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)',
              }}
              autoFocus
            />
            <Text style={{ fontSize: 11, color: colors.textSecondary, textAlign: 'right', marginTop: 4 }}>
              {noteInput.length}/60
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
              {myNote && (
                <TouchableOpacity
                  onPress={() => handleSetNote('')}
                  style={{
                    flex: 1, paddingVertical: 10, borderRadius: 12,
                    backgroundColor: isDark ? 'rgba(239,68,68,0.15)' : 'rgba(239,68,68,0.1)',
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: '#EF4444', fontWeight: '700', fontSize: 14 }}>
                    {t('common.delete') || 'Delete'}
                  </Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity
                onPress={handleSetNote}
                style={{
                  flex: 1, paddingVertical: 10, borderRadius: 12,
                  backgroundColor: ACCENT, alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }}>
                  {t('common.save') || 'Save'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      )}
    </View>
  );
}

const s = StyleSheet.create({
  searchWrap: {
    paddingHorizontal: 14,
    paddingTop: 6,
    paddingBottom: 6,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 20,
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
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 8,
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 20,
    borderWidth: 1,
    height: 34,
    justifyContent: 'center',
    flexShrink: 0,
  },
  chipActive: {
    backgroundColor: '#7C3AED',
    borderColor: '#7C3AED',
    ...Platform.select({
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 6 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 10px rgba(124,58,237,0.3)' },
    }),
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.1,
  },
  chipBadge: {
    minWidth: 22,
    height: 20,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipBadgeText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.2,
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
    paddingHorizontal: 18,
    paddingVertical: 14,
    minHeight: 76,
    ...(Platform.OS === 'web' ? {
      transition: 'background-color 0.15s ease, box-shadow 0.15s ease',
      cursor: 'pointer',
    } : {}),
  },
  avatarWrap: {
    position: 'relative',
    marginRight: 14,
  },
  onlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: '#22c55e',
    borderWidth: 2.5,
    zIndex: 5,
    overflow: 'visible',
  },
  groupBadge: {
    width: 20,
    height: 20,
    borderRadius: 6,
    backgroundColor: 'rgba(124,58,237,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  groupBadgeDark: {
    backgroundColor: 'rgba(124,58,237,0.15)',
  },
  groupBadgeText: {
    fontSize: 10,
    fontWeight: '800',
    color: ACCENT,
  },
  pinnedIconWrap: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowContent: { flex: 1 },
  rowTop: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 3,
  },
  rowName: {
    fontSize: 16.5,
    fontWeight: '600',
    flex: 1,
    letterSpacing: -0.15,
  },
  rowNameUnread: { fontWeight: '700' },
  rowTime: { fontSize: 12, letterSpacing: 0, fontWeight: '400' },
  rowBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 4,
  },
  rowPreview: {
    fontSize: 14.5,
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
    backgroundColor: '#25D366',
  },
  unreadBadgeShadow: {
    ...Platform.select({
      ios: { shadowColor: '#25D366', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 3 },
      web: { boxShadow: '0 2px 6px rgba(37,211,102,0.3)' },
      default: {},
    }),
  },
  unreadText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
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
      web: { background: `linear-gradient(135deg, ${ACCENT} 0%, ${ACCENT2} 100%)`, boxShadow: `0 3px 8px rgba(124,58,237,0.3)` },
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
    paddingHorizontal: 44,
  },
  emptyTitle: {
    fontSize: 24,
    fontWeight: '700',
    letterSpacing: -0.3,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 15,
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 22,
    letterSpacing: 0,
  },
  emptyAction: {
    marginTop: 28,
    backgroundColor: ACCENT,
    paddingHorizontal: 36,
    paddingVertical: 14,
    borderRadius: 26,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.3, shadowRadius: 10 },
      android: { elevation: 5 },
      web: { boxShadow: `0 4px 18px rgba(124,58,237,0.35)`, transition: 'transform 0.15s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.15s ease' },
    }),
  },
  emptyActionText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0,
  },
  listEmpty: { flexGrow: 1 },
  fab: {
    position: 'absolute',
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#7C3AED',
    ...Platform.select({
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 12 },
      android: { elevation: 6 },
      web: {
        boxShadow: '0 4px 16px rgba(124,58,237,0.4), 0 2px 4px rgba(0,0,0,0.1)',
        transition: 'transform 0.15s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.15s ease',
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
