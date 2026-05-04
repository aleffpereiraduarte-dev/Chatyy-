import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, ScrollView, Modal,
  ActivityIndicator, RefreshControl, TextInput, Alert, ActionSheetIOS,
  Animated, PanResponder, Platform, LayoutAnimation, UIManager, Image,
  KeyboardAvoidingView, Pressable, Dimensions,
} from 'react-native';
// FlatList only (FlashList crashes iOS)
const ListComponent = FlatList;
import { useRouter, useFocusEffect } from 'expo-router';
import * as api from '../services/api';
import { emailToDisplayName } from '../services/api';
import { cacheConversations, getCachedConversations, prewarmConversationsCache, prefetchConversation } from '../services/chatCache';
import { userScopedKey } from '../services/cache';
import { getCachedMessagesSync } from '../services/smartChatCache';
import mqttService from '../services/mqtt';

// Subscribe all conversations to MQTT for real-time message delivery (Telegram-style)
function mqttSubscribeAll(conversations) {
  if (!conversations?.length) return;
  for (const conv of conversations) {
    if (conv.id) mqttService.subscribeConversation(conv.id);
  }
}
import CachedImage from './CachedImage';
import { IconMessageSquare, IconSearch, IconX, IconTrash, IconArchive, IconVolume2, IconCheck, IconMail, IconEye, IconMusic, IconUserPlus, IconSparkles, IconHeart, IconUsers, IconBell } from './Icons';
import AvatarCircle from './AvatarCircle';
import StatusCamera, { FILTERS as STATUS_FILTERS, FilterOverlay } from './StatusCamera';
import BroadcastModal from './BroadcastModal';
import CreateGroupFlow from './CreateGroupFlow';
import ChannelDiscoverModal from './ChannelDiscoverModal';
import BrandFab from './BrandFab';
import Svg, { Path, Rect, Line, Circle as SvgCircle } from 'react-native-svg';
import CircularProgressArc from './CircularProgressArc';
// Shared status fetch/cache/WS — gives the home row WS instant updates +
// fingerprint diff (no flicker) + MMKV preload that the duplicated local
// path never had. See hooks/useStatuses.js for the contract.
import useStatuses from '../hooks/useStatuses';
// Shared status ring+avatar+badge primitive (was duplicated 3×). Solid
// purple ring, +/↩ badge, optional Notes overlay. Same look the user
// already loves on home, just one source of truth now.
import StoryRingAvatar from './status/StoryRingAvatar';

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

function normalizeISO(s) {
  if (!s) return s;
  let t = String(s);
  if (t.indexOf('T') < 0 && t.indexOf(' ') > 0) t = t.replace(' ', 'T');
  t = t.replace(/\.(\d{3})\d+/, '.$1');
  t = t.replace(/([+-])(\d{2})$/, '$1$2:00');
  if (!/Z$/.test(t) && !/[+-]\d{2}:?\d{2}$/.test(t)) t = t + 'Z';
  return t;
}
function formatChatTime(dateStr, t) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(normalizeISO(dateStr));
  if (isNaN(date.getTime())) return '';
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
          backgroundColor: color || '#7C3AED',
          opacity: d.opacity,
          transform: [{ scale: d.scale }],
        }} />
      ))}
    </View>
  );
}

// ── Online pulse animation ──
// The previous version was a static dot; the name lied. Now it actually
// pulses: a translucent halo expands + fades behind the green pip every
// ~2s so "online" reads at a glance. Keeps the layout footprint same
// (halo is absolutely positioned over the dot).
function PulsingOnlineDot({ colors, isDark }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 1400, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0.55, 0.25, 0] });
  return (
    <View style={[s.onlineDot, {
      borderColor: isDark ? '#0B141A' : colors.background,
    }]}>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: -2.5, top: -2.5,
          width: 13, height: 13, borderRadius: 6.5,
          backgroundColor: '#22c55e',
          opacity: haloOpacity,
          transform: [{ scale: haloScale }],
        }}
      />
    </View>
  );
}

// ── Group avatar stack (2-3 member photos) ──
function GroupAvatarStack({ conversation, size = 56, isDark }) {
  // Prefer the group's uploaded photo (set by the admin via the group-info
  // modal). Only falls back to stacked member avatars when no photo exists.
  const groupPhoto = conversation.avatar_url || conversation.avatar || '';
  if (groupPhoto) {
    return <AvatarCircle name={conversation.display_name || conversation.name || '?'} email={null} size={size} uri={groupPhoto} />;
  }
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
// Format activity status text from last_seen timestamp.
// Only shown for online state — the "X min atrás" lower-state was redundant
// with the message timestamp on the right of the row and added visual noise.
function formatActivityStatus(isOnline, lastSeen, t) {
  if (isOnline) return { text: t?.('chat.online') || 'online', color: '#22c55e' };
  if (lastSeen) {
    const now = Date.now();
    const seen = new Date(lastSeen.endsWith('Z') || lastSeen.includes('+') ? lastSeen : lastSeen + 'Z').getTime();
    if (!isNaN(seen) && (now - seen) < 60000) {
      return { text: t?.('chat.online') || 'online', color: '#22c55e' };
    }
  }
  return null;
}

const ConversationRow = React.memo(function ConversationRow({
  conversation, colors, onPress, onPressIn, onDelete, onArchive, onMute, onPin, onMarkUnread, onEmail,
  currentEmail, t, isOnline: isOnlineProp, isDark, isLocked, typingUsers,
  selectionMode, isSelected, onLongPress, onToggleSelect, draftText, noteText, lastSeen,
}) {
  const isGroup = conversation.type === 'group';
  const isChannel = conversation.type === 'channel';
  // For direct chats, check if the user has set a local nickname for the peer.
  // Applies only to direct convs (groups keep server-side name). Sync read
  // from MMKV cache so the row doesn't flicker on scroll.
  const _peerEmail = (!isGroup && !isChannel)
    ? (conversation.other_email || conversation.contact_email || conversation.email || '')
    : '';
  let _nickname = '';
  if (_peerEmail) {
    try { _nickname = require('../services/nicknames').getNickname(_peerEmail); } catch {}
  }
  const displayName = _nickname
    || emailToDisplayName(conversation.display_name || conversation.name || t('chat.unknown'));
  const unread = conversation.unread_count > 0;
  const lastMsg = conversation.last_message;
  const isArchived = conversation.archived;
  const isPinned = !!conversation.pinned;
  const isMuted = !!conversation.muted;
  const [hovered, setHovered] = useState(false);

  // Prefer server-provided other_email/contact_email — those are computed
  // authoritatively by chat.php:buildConversationData knowing exactly who
  // the current user is. Falling back to client-side .find() is only safe
  // when currentEmail is known; otherwise the first member listed may BE
  // the current user, which used to make their own photo appear in every
  // direct-chat avatar on cold boot (the web bug the user reported).
  const _me = (currentEmail || '').toLowerCase();
  const serverPeer = conversation.other_email || conversation.contact_email || conversation.peer_email || null;
  let otherEmail = null;
  if (!isGroup) {
    if (serverPeer && serverPeer.toLowerCase() !== _me) {
      otherEmail = serverPeer;
    } else if (_me) {
      const otherMember = (conversation.members || []).find(m => {
        const e = typeof m === 'string' ? m : (m?.email || '');
        return e && e.toLowerCase() !== _me;
      });
      otherEmail = otherMember
        ? (typeof otherMember === 'string' ? otherMember : otherMember?.email)
        : null;
    }
    // If we still have nothing, rather than defaulting to the current user
    // (which paints their own avatar), stay null — AvatarCircle renders the
    // initials from `name` instead.
  }

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
    // Strip backslash-escaped punctuation (e.g. "Olá\!" → "Olá!")
    content = content.replace(/\\([!?.,:;'"()\[\]#@&*~`<>|])/g, '$1');
    // Strip markdown markers in chat list preview — render plain text only.
    // User reported: "Quando eu uso bold aparece estranho no chatlist" — the
    // bubble renders **word** as bold but the list preview was leaving the
    // raw asterisks/underscores/tildes visible. WhatsApp/Telegram both flatten
    // formatting in previews. Remove pairs of *…*, **…**, _…_, ~…~, ```…```.
    content = content
      .replace(/```([\s\S]*?)```/g, '$1')          // code block
      .replace(/\|\|([^|]+)\|\|/g, '$1')           // spoiler ||x||
      .replace(/\*\*([^*]+)\*\*/g, '$1')           // **bold**
      .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')   // *bold* (single-asterisk variant)
      .replace(/_([^_\n]+)_/g, '$1')               // _italic_
      .replace(/~([^~\n]+)~/g, '$1')               // ~strike~
      .replace(/`([^`\n]+)`/g, '$1');              // `code`
    if (content.startsWith('{')) {
      try {
        const parsed = JSON.parse(content);
        // call_card stores call kind as boolean `video`, not `call_type`.
        const isCall = lastMsg.type === 'call_card' || parsed.call_id || parsed.call_type !== undefined || parsed.caller_email;
        if (isCall) {
          const isVideo = parsed.call_type === 'video' || parsed.video === true;
          const st = parsed.status || '';
          if (st === 'missed' || st === 'declined' || st === 'rejected' || st === 'no_answer') {
            content = '\uD83D\uDCDE ' + (t('chat.callMissed') || 'Chamada perdida');
          } else if (isVideo) {
            content = '\uD83D\uDCF9 ' + (t('chat.videoCall') || 'Chamada de v\u00EDdeo');
          } else {
            content = '\uD83D\uDCDE ' + (t('chat.voiceCall') || 'Chamada de voz');
          }
        }
        else if (parsed.type === 'location') content = '\uD83D\uDCCD ' + (t('chat.location') || 'Localização');
        else if (parsed.type === 'contact') content = '\uD83D\uDC64 ' + (t('chat.contact') || 'Contato');
        else content = '\uD83D\uDCCE ' + (t('chat.attachment') || 'Anexo');
      } catch {}
    }
    if (lastMsg.type === 'call_card' && !/Chamada/.test(content)) {
      content = '\uD83D\uDCDE ' + (t('chat.voiceCall') || 'Chamada');
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
  const propsRef = useRef({ onDelete, onArchive, onMute, onPin, onMarkUnread, onEmail });
  propsRef.current = { onDelete, onArchive, onMute, onPin, onMarkUnread, onEmail };

  // Swipe is mobile-only. On web/desktop the gesture was janky (mouse drag
  // competed with scroll + selection) — user reported "movimentação muito
  // ruim". Web uses long-press / right-click to open the actions menu
  // instead. PanResponder returning false from all handlers is a no-op.
  const panResponder = useRef(
    Platform.OS === 'web'
      ? { panHandlers: {} }
      : PanResponder.create({
          onMoveShouldSetPanResponder: (_, g) => {
            if (Math.abs(g.dx) < 10) return false;
            return Math.abs(g.dx) > Math.abs(g.dy) * 1.2;
          },
          onMoveShouldSetPanResponderCapture: () => false,
          onStartShouldSetPanResponder: () => false,
          onPanResponderMove: (_, g) => {
            const dx = g.dx;
            const sign = dx < 0 ? -1 : 1;
            const abs = Math.abs(dx);
            const clamped = abs <= SWIPE_MAX
              ? abs
              : SWIPE_MAX + (abs - SWIPE_MAX) * 0.3;
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

  // ── Native Swipeable refs/callbacks declared unconditionally.
  // They were previously declared INSIDE `if (NativeSwipeable && !isWeb && !selectionMode)`
  // which caused "Rendered fewer hooks than expected" when user long-presses (selectionMode
  // flips true → the if-branch is skipped → hooks count drops → React crashes).
  // React's Rules of Hooks: never conditional.
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
        <TouchableOpacity style={[s.nativeSwipeBtn, { backgroundColor: '#0EA5E9' }]} onPress={() => { swipeRef.current?.close(); propsRef.current.onEmail?.(conversation); }}>
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

  // ── Status checkmarks (Chatyy purple on read, gray on delivered/sent) ──
  // Purple (#7C3AED) is the Chatyy brand color — replaces the WhatsApp blue
  // so the list matches the thread's own read indicator.
  const renderStatusIcon = () => {
    if (!statusType) return null;
    if (statusType === 'read') {
      return (
        <View style={{ flexDirection: 'row', marginRight: 3 }}>
          <IconCheck size={15} color="#7C3AED" style={{ marginRight: -8 }} />
          <IconCheck size={15} color="#7C3AED" />
        </View>
      );
    }
    if (statusType === 'delivered') {
      return (
        <View style={{ flexDirection: 'row', marginRight: 3 }}>
          <IconCheck size={15} color={isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)'} style={{ marginRight: -8 }} />
          <IconCheck size={15} color={isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.45)'} />
        </View>
      );
    }
    return (
      <IconCheck size={15} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'} style={{ marginRight: 3 }} />
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
              // Telegram-style hairline divider — but rendered full-width.
              // The Telegram pattern (line starts after avatar at 80pt) requires
              // a separate child View; here we use a full-width hairline so we
              // don't shift the avatar/content. Visually nearly indistinguishable.
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: isDark ? '#313131' : '#EEEEEE',
              ...(isWeb ? { transition: 'background-color 0.2s ease' } : {}),
            },
          ]}
          onPress={() => {
            if (selectionMode) { onToggleSelect?.(); return; }
            if (swipeOpen.current) { resetSwipe(); return; }
            onPress();
          }}
          onPressIn={() => {
            // Touch-down prefetch — start the network request before the
            // tap is even recognized. The 80-150ms between finger-down and
            // onPress gets folded into the conversation-open latency.
            if (selectionMode || swipeOpen.current) return;
            try { onPressIn?.(); } catch {}
          }}
          onLongPress={() => {
            if (!selectionMode) onLongPress?.();
          }}
          delayLongPress={isWeb ? 300 : 500}
          activeOpacity={0.6}
          delayPressIn={60}
          {...(isWeb ? {
            onMouseEnter: () => setHovered(true),
            onMouseLeave: () => setHovered(false),
            // Right-click → instant action menu (via selection mode which
            // renders Pin/Archive/Delete buttons in the header). Prevents
            // the default browser context menu from stealing the gesture.
            onContextMenu: (e) => {
              try { e?.preventDefault?.(); } catch {}
              if (!selectionMode) onLongPress?.();
            },
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
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 5, marginRight: 10 }}>
                  <IconLock size={13} color={isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)'} />
                  <Text style={[s.rowPreview, { color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)', flex: 1 }]} numberOfLines={1}>
                    {t('chat.lockedChat') || 'Chat bloqueado'}
                  </Text>
                </View>
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
                        <Text style={{ fontWeight: '400', color: '#0088CC' }}>{previewSender}: </Text>
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
                {/* Mention badge: @ indicator takes priority visually — stays
                    even when the chat is muted so you never miss being called
                    out. Paired with the unread count. */}
                {conversation.unread_mentions > 0 && (
                  <View style={[s.unreadBadge, s.unreadBadgeShadow, { backgroundColor: '#7C3AED', marginRight: 4, minWidth: 22 }]}>
                    <Text style={[s.unreadText, { fontSize: 13, fontWeight: '800' }]}>@</Text>
                  </View>
                )}
                {unread && (
                  <View style={[
                    s.unreadBadge,
                    s.unreadBadgeShadow,
                    isMuted && !conversation.unread_mentions && { backgroundColor: isDark ? '#555' : '#999' },
                  ]}>
                    <Text style={s.unreadText}>{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </TouchableOpacity>
  );

  // Use native Swipeable on iOS/Android, PanResponder on web. Hooks declared above —
  // here we only BRANCH the JSX, never the hook order.
  if (NativeSwipeable && !isWeb && !selectionMode) {
    return (
      <NativeSwipeable ref={swipeRef} friction={1.5} leftThreshold={50} rightThreshold={50} overshootLeft={false} overshootRight={false}
        renderLeftActions={renderLeftActions} renderRightActions={renderRightActions}
>
        {rowContent}
      </NativeSwipeable>
    );
  }

  // Web: no swipe — long-press / right-click opens the action header (via
  // parent's enterSelectionMode). Returning raw rowContent eliminates the
  // jankiness the user reported with PanResponder+mouse dragging.
  if (isWeb) return rowContent;

  // Native fallback (rare — would only hit if NativeSwipeable didn't load)
  return (
    <View style={s.swipeContainer}>
      <Animated.View style={[s.swipeActionsLeft, { opacity: leftOpacity }]}>
        <TouchableOpacity style={[s.swipeActionBtnWide, { borderRadius: 14, marginLeft: 4, marginVertical: 3, backgroundColor: '#8B5CF6' }]} onPress={() => { resetSwipe(); propsRef.current.onMute?.(conversation); }}>
          <IconVolume2 size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{t('chat.mute') || 'Mute'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.swipeActionBtnWide, { borderRadius: 14, marginRight: 4, marginVertical: 3, backgroundColor: '#F59E0B' }]} onPress={() => { resetSwipe(); propsRef.current.onPin?.(conversation); }}>
          <IconPin size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{isPinned ? (t('chat.unpin') || 'Unpin') : (t('chat.pin') || 'Pin')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.swipeActionBtnWide, { borderRadius: 14, marginRight: 4, marginVertical: 3, backgroundColor: '#0EA5E9' }]} onPress={() => { resetSwipe(); propsRef.current.onMarkUnread?.(conversation); }}>
          <IconMail size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{t('chat.markUnread') || 'Unread'}</Text>
        </TouchableOpacity>
      </Animated.View>
      <Animated.View style={[s.swipeActionsRight, { opacity: rightOpacity }]}>
        <TouchableOpacity style={[s.swipeActionBtnWide, { borderRadius: 14, marginLeft: 4, marginVertical: 3, backgroundColor: '#3B82F6' }]} onPress={() => { resetSwipe(); propsRef.current.onArchive?.(conversation); }}>
          <IconArchive size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{isArchived ? (t('chat.unarchive') || 'Unarchive') : (t('chat.archive') || 'Archive')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.swipeActionBtnWide, { borderRadius: 14, marginRight: 4, marginVertical: 3, backgroundColor: '#EF4444' }]} onPress={() => { resetSwipe(); propsRef.current.onDelete?.(conversation); }}>
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
  // Re-render when delivery/read state of the last outbound message changes
  // so ✓ → ✓✓ → ✓✓ roxo animates in without waiting for a new message.
  if ((prevConv.last_message?.delivered_at || '') !== (nextConv.last_message?.delivered_at || '')) return false;
  if ((prevConv.last_message?.read_at || '') !== (nextConv.last_message?.read_at || '')) return false;
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

// Pre-load cached conversations synchronously for an instant first paint.
// Native: MMKV read. Web: localStorage mirror of the IndexedDB list (kept
// small — 100 most recent rows — because localStorage is capped at ~5 MB.
// Full history still lives in IndexedDB, localStorage just buys us a single
// synchronous readable chunk so React's first render has data).
let _preloadedConversations = null;
if (Platform.OS !== 'web') {
  try {
    const { getString: _gs } = require('../services/mmkv');
    const raw = _gs('chat_conversations');
    if (raw) _preloadedConversations = JSON.parse(raw);
  } catch {}
} else if (typeof localStorage !== 'undefined') {
  try {
    // The mirror is now scoped per active account (`u:<email>:chatyy_convs_v1`)
    // to keep two browser sessions on the same machine from leaking each
    // other's chat list. On a fresh install both keys are missing and the
    // first paint shows the skeleton — same as before. The bare key is
    // only consulted as a one-shot fallback for users whose last write
    // predates the scoping.
    const scopedKey = userScopedKey('chatyy_convs_v1');
    const raw = localStorage.getItem(scopedKey) || (scopedKey !== 'chatyy_convs_v1' ? localStorage.getItem('chatyy_convs_v1') : null);
    if (raw) _preloadedConversations = JSON.parse(raw);
  } catch {}
}

// Native SQLite chat cache disabled — crashed via FTS5 triggers. SmartCache
// (pure JS, MMKV/localStorage backed, synchronous) replaces it.
const _NativeChatCache = null;
const _SmartCache = (() => {
  try { return require('../services/smartChatCache'); } catch { return null; }
})();
const _readNativeConversationsSync = () => {
  if (!_SmartCache?.getCachedConversationsSync) return null;
  try {
    const list = _SmartCache.getCachedConversationsSync();
    return Array.isArray(list) && list.length > 0 ? list : null;
  } catch { return null; }
};
const _saveNativeConversations = (convs) => {
  if (!Array.isArray(convs)) return;
  try { _SmartCache?.cacheConversations?.(convs); } catch {}
  // Also push a top-30 snapshot to the App Group so the native iOS
  // ShareExtension UI can render its contact list without round-tripping
  // through React Native at all (build 418+).
  try {
    if (Platform.OS !== 'ios') return;
    const { Intents } = require('../modules/expo-native-toolkit');
    const sorted = [...convs].sort((a, b) =>
      new Date(b.last_message_at || b.updated_at || 0) -
      new Date(a.last_message_at || a.updated_at || 0)
    );
    const snapshot = sorted.slice(0, 30).map(c => ({
      id: String(c.id),
      name: c.name || c.display_name || c.other_email || '',
      email: (c.other_email || c.email || '').toLowerCase(),
      avatarUrl: c.avatar_url || (c.other_email
        ? api.getAvatarUrlForEmail?.(c.other_email) || ''
        : ''),
      type: c.type || (c.is_group ? 'group' : 'direct'),
      lastMessageAt: c.last_message_at || c.updated_at || '',
    }));
    Intents.setShareExtensionConversations(snapshot);
  } catch {}
};

// ── Status Stories Row (Instagram-style, unified with Notes) ──
function StatusStoriesRow({ colors, isDark, user, router, t, setActiveTab }) {
  // Status feed comes from the shared hook now: WS deltas, MMKV preload,
  // fingerprint-diff-anti-flicker, 30d disk cache, video warm-cache. The
  // local `statuses` state lives just to keep the optimistic mutation
  // helpers (mark-viewed, delete) familiar to the rest of this component.
  const { groups: hookGroups, refetch: refetchStatuses, markViewed: markStatusViewed, removeStatus: removeStatusFromCache, removeGroup: removeStatusGroup } = useStatuses(user?.email, { warmCacheVideos: true });
  const [statuses, setStatuses] = useState(hookGroups);
  // Mirror hook output → local state. setState is a noop when reference is
  // unchanged (React bails) so this only fires on actual data deltas.
  useEffect(() => { setStatuses(hookGroups); }, [hookGroups]);
  const [notes, setNotes] = useState([]);
  const [showNoteModal, setShowNoteModal] = useState(false);
  const [showStatusComposer, setShowStatusComposer] = useState(false);
  const [statusEditor, setStatusEditor] = useState(null);
  const [statusCaption, setStatusCaption] = useState('');
  const [editorFilterIdx, setEditorFilterIdx] = useState(0);
  const [statusPublishing, setStatusPublishing] = useState(false);
  const [statusUploadPct, setStatusUploadPct] = useState(0);
  const [showCustomCamera, setShowCustomCamera] = useState(false);
  const [noteText, setNoteText] = useState('');
  const [savingNote, setSavingNote] = useState(false);

  // Notes still has its own loader — different endpoint, different cadence
  // (60s vs 120s), no WS. Kept inline; if/when chatGetNotes also gets a
  // WS event we can extract a `useNotes` hook.
  const loadNotes = useCallback(() => {
    api.chatGetNotes?.().then(r => {
      if (r?.success && r.data) {
        const list = Array.isArray(r.data) ? r.data : (r.data.notes || []);
        setNotes(list);
      }
    }).catch(() => {});
  }, []);
  // `load()` keeps its public contract for the seven call-sites that fire
  // after note-save/status-publish/etc. — it now drives the hook's refetch
  // + reloads notes in parallel.
  const load = useCallback(() => {
    refetchStatuses();
    loadNotes();
  }, [refetchStatuses, loadNotes]);
  // Notes mount+interval (statuses are owned by the hook).
  useEffect(() => {
    loadNotes();
    const t = setInterval(loadNotes, 60000);
    return () => clearInterval(t);
  }, [loadNotes]);

  const myStatusGroup = statuses.find(s => s.email === user?.email);
  const myStatus = myStatusGroup?.items?.length > 0 ? myStatusGroup : null;
  const myNote = notes.find(n => n.email === user?.email);
  // Instagram/WhatsApp pattern: after viewing all of someone's statuses, they
  // disappear from the main-page story row. They're still accessible via the
  // user's profile page (Recentes highlight). A group is "fully viewed" when
  // every status inside it was seen (`viewed: true`); unread stays on top,
  // viewed falls to the end and is trimmed.
  const otherStatuses = statuses
    .filter(s => s.email !== user?.email && s.items?.length > 0)
    .filter(s => (s.items || []).some(it => !it.viewed));

  // Merge: for each contact, if they have a status → status; else if they have a note → note
  const notesByEmail = new Map(notes.filter(n => n.email !== user?.email).map(n => [n.email, n]));
  const statusEmails = new Set(otherStatuses.map(s => s.email));
  const notesOnly = Array.from(notesByEmail.values()).filter(n => !statusEmails.has(n.email));

  const [statusViewerEmail, setStatusViewerEmail] = useState(null);
  const [statusViewersFor, setStatusViewersFor] = useState(null); // item being inspected for viewer list
  const [statusViewersList, setStatusViewersList] = useState([]);
  const [statusViewersLoading, setStatusViewersLoading] = useState(false);

  // Fetch the viewers whenever the sheet target changes.
  useEffect(() => {
    if (!statusViewersFor?.id) { setStatusViewersList([]); return; }
    setStatusViewersLoading(true);
    (async () => {
      try {
        const r = await api.apiCall('status_viewers', { status_id: statusViewersFor.id });
        const list = r?.data?.viewers || r?.data || [];
        setStatusViewersList(Array.isArray(list) ? list : []);
      } catch {} finally { setStatusViewersLoading(false); }
    })();
  }, [statusViewersFor?.id]);
  const [statusViewIdx, setStatusViewIdx] = useState(0);
  const _viewedIds = useRef(new Set());
  const openStatus = (email) => {
    setStatusViewIdx(0);
    setStatusViewerEmail(email || null);
  };

  // Prefetch the next few status items' images as soon as a viewer opens
  // or advances — this makes left/right taps feel instant instead of
  // waiting on R2. Uses expo-image's prefetch (no-op on web where the
  // browser already caches fetched URLs).
  useEffect(() => {
    if (!statusViewerEmail) return;
    const group = statuses.find(s => s.email === statusViewerEmail);
    const items = group?.items || [];
    const upcoming = items.slice(statusViewIdx, statusViewIdx + 3);
    const urls = upcoming
      .map(it => {
        const u = it.media_url || '';
        if (!u) return null;
        return u.startsWith('http') ? u : 'https://chatyy.com.br' + u;
      })
      .filter(Boolean);
    if (urls.length === 0) return;
    try {
      const { Image: ExpoImg } = require('expo-image');
      if (ExpoImg?.prefetch) ExpoImg.prefetch(urls).catch(() => {});
    } catch {}
    if (Platform.OS === 'web' && typeof document !== 'undefined') {
      // Hint the browser cache via <link rel="preload"> so next tap reads
      // from memory. Removed when viewer closes (via empty array effect).
      urls.forEach(u => {
        try {
          const link = document.createElement('link');
          link.rel = 'preload';
          link.as = 'image';
          link.href = u;
          document.head.appendChild(link);
          // Remove after 60s — no need to keep these around forever
          setTimeout(() => { try { link.remove(); } catch {} }, 60000);
        } catch {}
      });
    }
  }, [statusViewerEmail, statusViewIdx, statuses]);

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
            const openComposer = () => {
              if (Platform.OS === 'web') {
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
                setShowCustomCamera(true);
              }
            };

            if (myStatus) {
              // If the user already has an active story, tapping the ring
              // should OPEN it — that's the muscle memory from Instagram /
              // WhatsApp. The "+" badge at the bottom-right of the ring
              // (always visible) is the path to ADD another.
              //
              // Previously this opened Alert.alert with 3 options (View /
              // Add / Cancel) but multi-button Alert doesn't render on web
              // at all and felt noisy on native. Opening directly is the
              // expected UX.
              const group = statuses.find(s => s.email === user?.email);
              const hasItems = group?.items?.length > 0;
              if (hasItems) {
                openStatus(user?.email);
                return;
              }
              // Status expired → fall through to composer
            }
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
              // Native: try custom camera, fallback to system picker if it crashes
              try {
                setShowCustomCamera(true);
              } catch {
                (async () => {
                  try {
                    const ImagePicker = await import('expo-image-picker');
                    const perm = await ImagePicker.requestCameraPermissionsAsync();
                    if (!perm.granted) return;
                    const r = await ImagePicker.launchCameraAsync({ mediaTypes: ImagePicker.MediaTypeOptions.All, quality: 1.0, videoMaxDuration: 60 });
                    if (!r.canceled && r.assets?.[0]) {
                      const asset = r.assets[0];
                      const isVideo = asset.mimeType?.startsWith('video') || asset.duration > 0;
                      setStatusEditor({ uri: asset.uri, type: isVideo ? 'video' : 'image', file: { uri: asset.uri, name: isVideo ? 'status.mp4' : 'status.jpg', type: asset.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg') } });
                      setStatusCaption('');
                    }
                  } catch {}
                })();
              }
            }
          }}
          onLongPress={() => setShowNoteModal(true)}
          activeOpacity={0.7}
          style={{ alignItems: 'center', width: 68 }}
        >
          <StoryRingAvatar
            name={myDisplayName}
            email={user?.email}
            size={54}
            ringStyle={myStatus ? 'solid' : 'none'}
            badge="plus"
            note={!myStatus && myNote?.content ? myNote.content : null}
            isDark={isDark}
            colors={colors}
          />
          <Text style={{ fontSize: 11, color: colors.text, marginTop: 5, fontWeight: '500' }} numberOfLines={1}>
            {myNote || myStatus ? myDisplayName : (t('status.yourStory') || 'Sua nota')}
          </Text>
        </TouchableOpacity>

        {/* Status stories (photos/videos) — unviewed have bright purple ring,
            partially-viewed keep a dimmer ring. Fully-viewed groups already
            filtered out above → only reachable via the user's profile. */}
        {otherStatuses.map((s) => {
          const allViewed = (s.items || []).every(it => it.viewed);
          return (
            <View key={`st-${s.email}`} style={{ alignItems: 'center', width: 68 }}>
              <TouchableOpacity
                onPress={() => openStatus(s.email)}
                onLongPress={() => {
                  // WhatsApp-style action sheet: Reply (DM) + Mute. The badge
                  // (↩) already covers reply on a single tap; long-press here
                  // surfaces the "silenciar status de X" privacy control that
                  // was previously only reachable from the status tab.
                  const peerName = s.name || s.email?.split('@')[0] || '';
                  const goReply = () => {
                    try {
                      const { chatCreate } = require('../services/api');
                      chatCreate([s.email], '', 'direct').then(r => {
                        const cid = r?.data?.conversation_id || r?.data?.id;
                        if (!cid) return;
                        const name = encodeURIComponent(peerName);
                        router.push(`/chat-conversation?id=${cid}&name=${name}&type=direct&email=${encodeURIComponent(s.email)}&replyStatus=1`);
                      }).catch(() => {});
                    } catch {}
                  };
                  const doMute = async () => {
                    try { await api.statusMute(s.email); } catch {}
                    try { removeStatusGroup?.(s.email); } catch {}
                    try { require('react-native').Vibration.vibrate(8); } catch {}
                  };
                  const buttons = [
                    { text: t('status.reply') || 'Responder', onPress: goReply },
                    { text: `${t('status.muteAction') || 'Silenciar status de'} ${peerName}`, style: 'destructive', onPress: doMute },
                    { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
                  ];
                  Alert.alert(peerName || (t('status.title') || 'Status'), null, buttons);
                }}
                delayLongPress={350}
                activeOpacity={0.7}
                style={{ alignItems: 'center' }}
              >
                <StoryRingAvatar
                  name={s.name || s.email}
                  email={s.email}
                  size={54}
                  ringStyle="solid"
                  allViewed={allViewed}
                  badge="reply"
                  badgeAccessibilityLabel={t('status.reply') || 'Responder'}
                  onBadgePress={() => { try {
                    const { chatCreate } = require('../services/api');
                    chatCreate([s.email], '', 'direct').then(r => {
                      const cid = r?.data?.conversation_id || r?.data?.id;
                      if (!cid) return;
                      const name = encodeURIComponent(s.name || s.email?.split('@')[0] || '');
                      router.push(`/chat-conversation?id=${cid}&name=${name}&type=direct&email=${encodeURIComponent(s.email)}&replyStatus=1`);
                    }).catch(() => {});
                  } catch {} }}
                  isDark={isDark}
                  colors={colors}
                />
                <Text style={{ fontSize: 11, color: colors.text, marginTop: 5, fontWeight: '500' }} numberOfLines={1}>
                  {s.name || s.email?.split('@')[0]}
                </Text>
              </TouchableOpacity>
            </View>
          );
        })}

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
              { key:'text',   icon:'T',  color:'#7C3AED', label: t('status.typeText')  || 'Texto' },
              { key:'camera', icon:'📷', color:'#10B981', label: t('status.typeCamera') || 'Câmera' },
            ].map(opt => (
              <TouchableOpacity
                key={opt.key}
                onPress={() => {
                  setShowStatusComposer(false);
                  if (opt.key === 'text') { setTimeout(() => setShowNoteModal(true), 150); return; }
                  // Single Instagram-style entry: StatusCamera handles photo/video/boomerang + gallery.
                  // Drops the iOS Alert + native ImagePicker chain that left users seeing two
                  // different capture UIs depending on which button they tapped.
                  setTimeout(() => setShowCustomCamera(true), 140);
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
          // Media URL lives in `media_url` after the 2026-04-22 schema fix.
          // Legacy rows had the URL in `content` — keep a fallback so cached
          // responses still render. Caption (text that came AFTER a newline
          // in the old scheme) stays with `content` in the new layout too.
          const raw = item.content || '';
          const legacyMediaInContent = (isImage || isVideo) && /^(\/|https?:\/\/)/.test(raw);
          const rawMedia = item.media_url || (legacyMediaInContent ? raw.split('\n')[0] : '');
          const mediaUrl = rawMedia.startsWith('http')
            ? rawMedia
            : (rawMedia.startsWith('/') ? 'https://chatyy.com.br' + rawMedia : '');
          const caption = legacyMediaInContent
            ? (raw.includes('\n') ? raw.split('\n').slice(1).join('\n').trim() : '')
            : (isImage || isVideo ? raw.trim() : '');
          const bgColor = item.bg_color || item.background || '#7C3AED';
          const displayName = group.name || group.email?.split('@')[0] || '';
          if (item.id && !_viewedIds.current.has(item.id)) {
            _viewedIds.current.add(item.id);
            try { api.statusView?.(item.id).catch(() => {}); } catch {}
            // Update the hook's internal cache (mine/others/groups + MMKV
            // fingerprint reset) so the row collapses without waiting for the
            // 2-minute poll. The mirror useEffect picks up the new groups ref
            // and writes through to local `statuses`.
            try { markStatusViewed(item.id); } catch {}
          }
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
                    {(() => {
                      try {
                        // PG returns "2026-04-22 01:30:00.123+00" which
                        // Safari (and older JS engines) can't parse. Normalize
                        // to ISO: replace space with T, "+00" → "+00:00".
                        let iso = String(item.created_at || '').replace(' ', 'T');
                        iso = iso.replace(/([+-]\d{2})$/, '$1:00');
                        const d = new Date(iso);
                        const ms = d.getTime();
                        if (!Number.isFinite(ms)) return '';
                        const h = Math.round((Date.now() - ms) / 3600000);
                        if (h < 1) return 'Agora';
                        if (h < 24) return h + 'h';
                        return Math.floor(h / 24) + 'd';
                      } catch { return ''; }
                    })()}
                  </Text>
                </View>
                {(group.email || '').toLowerCase() === (user?.email || '').toLowerCase() && item?.id && (
                  <>
                    <TouchableOpacity
                      onPress={() => {
                        const statusId = item.id;
                        const doDelete = async () => {
                          try {
                            await api.statusDelete?.(statusId);
                          } catch {}
                          try { removeStatusFromCache(statusId); } catch {}
                          const remaining = (items || []).filter(it => it.id !== statusId);
                          if (remaining.length === 0) { setStatusViewerEmail(null); setStatusViewIdx(0); }
                          else { setStatusViewIdx(i => Math.min(i || 0, remaining.length - 1)); }
                        };
                        if (Platform.OS === 'web') {
                          if (typeof window !== 'undefined' && window.confirm(t?.('status.deleteConfirm') || 'Apagar este status?')) doDelete();
                        } else {
                          Alert.alert(
                            t?.('status.deleteTitle') || 'Apagar status',
                            t?.('status.deleteConfirm') || 'Apagar este status?',
                            [
                              { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                              { text: t?.('common.delete') || 'Excluir', style: 'destructive', onPress: doDelete },
                            ]
                          );
                        }
                      }}
                      style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}
                      accessibilityLabel={t?.('common.delete') || 'Excluir'}
                    >
                      <IconTrash size={18} color="#ef4444" />
                    </TouchableOpacity>
                    <TouchableOpacity
                      onPress={() => {
                        setStatusViewerEmail(null);
                        setStatusViewIdx(0);
                        setTimeout(() => { setShowCustomCamera(true); }, 140);
                      }}
                      style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center', marginRight: 8 }}
                      accessibilityLabel={t?.('status.addMore') || 'Adicionar outro'}
                    >
                      <Text style={{ color: '#fff', fontSize: 22, lineHeight: 24, fontWeight: '300' }}>+</Text>
                    </TouchableOpacity>
                  </>
                )}
                <TouchableOpacity onPress={() => { setStatusViewerEmail(null); setStatusViewIdx(0); }} style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' }}>
                  <IconX size={18} color="#fff" />
                </TouchableOpacity>
              </View>
              {/* Content — use expo-image on native for memory+disk cache,
                  so re-opening the same status (or navigating next/prev
                  through items) doesn't re-download from R2 every time. */}
              {isImage && mediaUrl ? (
                Platform.OS === 'web'
                  ? <img src={mediaUrl} alt="" style={{ flex: 1, width: '100%', height: '100%', objectFit: 'contain' }} />
                  : (() => {
                      let ExpoImg = null;
                      try { ExpoImg = require('expo-image').Image; } catch {}
                      if (ExpoImg) {
                        return <ExpoImg source={{ uri: mediaUrl }} style={{ flex: 1, width: '100%' }} contentFit="contain" cachePolicy="memory-disk" transition={120} />;
                      }
                      return <CachedImage source={{ uri: mediaUrl }} style={{ flex: 1, width: '100%' }} resizeMode="contain" />;
                    })()
              ) : isVideo && mediaUrl ? (
                Platform.OS === 'web'
                  ? (
                      // muted required for browser autoplay (Chrome/Safari
                      // block autoplay with sound). Tap toggles mute.
                      <video
                        src={mediaUrl}
                        autoPlay
                        muted
                        playsInline
                        loop
                        style={{ flex: 1, width: '100%', objectFit: 'contain' }}
                        onClick={(e) => { try { e.currentTarget.muted = !e.currentTarget.muted; } catch {} }}
                      />
                    )
                  : (() => {
                      // Prefer expo-video — expo-av's <Video> was returning
                      // null on first render in this modal, leaving the
                      // viewer black. expo-video is bundled with SDK 55+.
                      try {
                        const { useVideoPlayer, VideoView } = require('expo-video');
                        const StatusModalVideo = ({ uri }) => {
                          const player = useVideoPlayer(uri, (p) => { try { p.loop = true; p.muted = false; p.play(); } catch {} });
                          return <VideoView player={player} style={{ flex: 1 }} contentFit="contain" nativeControls={false} />;
                        };
                        return <StatusModalVideo uri={mediaUrl} />;
                      } catch {}
                      try {
                        const { Video } = require('expo-av');
                        return <Video source={{ uri: mediaUrl }} style={{ flex: 1 }} resizeMode="contain" shouldPlay isLooping />;
                      } catch { return null; }
                    })()
              ) : (
                // Text status (no media): just show the content as big text
                // on the background color. For image/video types where we
                // somehow got no URL, show a friendly fallback instead of
                // an empty black screen.
                <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 30 }}>
                  <Text style={{ color: '#fff', fontSize: 24, fontWeight: '600', textAlign: 'center', lineHeight: 34 }}>
                    {(isImage || isVideo) && !mediaUrl
                      ? (t?.('status.mediaUnavailable') || 'Mídia indisponível')
                      : raw}
                  </Text>
                </View>
              )}
              {caption ? (
                <View style={{ position: 'absolute', bottom: 80, left: 16, right: 16, backgroundColor: 'rgba(0,0,0,0.4)', borderRadius: 12, padding: 12 }}>
                  <Text style={{ color: '#fff', fontSize: 15, textAlign: 'center' }}>{caption}</Text>
                </View>
              ) : null}
              {/* Seen-by bar — only visible on the user's OWN status.
                  WhatsApp-parity: tap to open the list of who viewed it. */}
              {(group.email || '').toLowerCase() === (user?.email || '').toLowerCase() && (
                <TouchableOpacity
                  onPress={() => setStatusViewersFor(item)}
                  activeOpacity={0.8}
                  style={{ position: 'absolute', bottom: 24, left: 16, right: 16, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 24, paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10, zIndex: 6 }}
                  accessibilityLabel={t('status.seenBy') || 'Visualizações'}
                  accessibilityRole="button"
                >
                  <IconEye size={18} color="#fff" />
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', flex: 1 }}>
                    {(item.views || 0) === 0
                      ? (t('status.noViewsYet') || 'Ninguém viu ainda')
                      : `${item.views || 0} ${(item.views || 0) === 1 ? (t('status.viewSingular') || 'visualização') : (t('status.viewPlural') || 'visualizações')}`}
                  </Text>
                  <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>›</Text>
                </TouchableOpacity>
              )}

              {/* Inline viewers sheet — rendered INSIDE the status Modal so the
                  status doesn't dismiss when it slides up. WhatsApp-parity. */}
              {statusViewersFor?.id === item.id && (
                <View
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end', zIndex: 20 }}
                  pointerEvents="box-none"
                >
                  <TouchableOpacity
                    activeOpacity={1}
                    onPress={() => setStatusViewersFor(null)}
                    style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.55)' }}
                  />
                  <View style={{
                    backgroundColor: isDark ? '#111' : '#fff',
                    borderTopLeftRadius: 22, borderTopRightRadius: 22,
                    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 32,
                    maxHeight: '70%',
                  }}>
                    <View style={{ alignItems: 'center', marginBottom: 10 }}>
                      <View style={{ width: 42, height: 4, borderRadius: 2, backgroundColor: isDark ? '#333' : '#ddd' }} />
                    </View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                      <IconEye size={18} color={colors.text} />
                      <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text, flex: 1 }}>
                        {t?.('status.seenBy') || 'Visualizações'} · {statusViewersList.length}
                      </Text>
                      <TouchableOpacity onPress={() => setStatusViewersFor(null)} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                        <IconX size={20} color={colors.textSecondary} />
                      </TouchableOpacity>
                    </View>
                    {statusViewersLoading ? (
                      <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                        <ActivityIndicator size="small" color="#7C3AED" />
                      </View>
                    ) : statusViewersList.length === 0 ? (
                      <View style={{ paddingVertical: 32, alignItems: 'center' }}>
                        <IconEye size={36} color={colors.textSecondary} />
                        <Text style={{ color: colors.textSecondary, marginTop: 10, fontSize: 14 }}>
                          {t?.('status.noViewsYet') || 'Ninguém viu ainda'}
                        </Text>
                      </View>
                    ) : (
                      <FlatList
                        data={statusViewersList}
                        keyExtractor={(u, i) => u.email || String(i)}
                        renderItem={({ item: viewer }) => {
                          const email = viewer.email || '';
                          const name = viewer.name || email.split('@')[0] || '';
                          return (
                            <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 }}>
                              <AvatarCircle name={name} email={email} size={42} />
                              <View style={{ flex: 1 }}>
                                <Text style={{ color: colors.text, fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{name}</Text>
                                {viewer.viewed_at ? (
                                  <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 1 }}>
                                    {(() => {
                                      try {
                                        let iso = String(viewer.viewed_at || '').replace(' ', 'T');
                                        iso = iso.replace(/([+-]\d{2})$/, '$1:00');
                                        const d = new Date(iso);
                                        if (isNaN(d.getTime())) return '';
                                        return d.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
                                      } catch { return ''; }
                                    })()}
                                  </Text>
                                ) : null}
                              </View>
                            </View>
                          );
                        }}
                      />
                    )}
                  </View>
                </View>
              )}
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
                  <IconMusic size={14} color="#fff" />
                  <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 }} numberOfLines={1}>{item.music_title} — {item.music_artist}</Text>
                </View>
              ) : null}
            </View>
          );
        })()}
      </Modal>

      {/* Status Viewers sheet now rendered INLINE inside the status Modal
          (above) so opening it doesn't dismiss the status. */}


      {/* Instagram-style custom camera (NATIVE ONLY — crashes on web) */}
      {Platform.OS !== 'web' && (
        <Modal visible={showCustomCamera} transparent={false} animationType="slide" onRequestClose={() => setShowCustomCamera(false)}>
          <StatusCamera
            visible={showCustomCamera}
            t={t}
            onClose={() => setShowCustomCamera(false)}
            onCapture={async (payload) => {
              setShowCustomCamera(false);
              // Multi-select carousel from gallery → upload each + publish as
              // one story sequence, no single-item editor pass.
              if (payload?.multi && Array.isArray(payload.items) && payload.items.length > 1) {
                setStatusPublishing(true);
                try {
                  const carouselItems = [];
                  for (const it of payload.items) {
                    const isVideo = it.type === 'video';
                    const file = {
                      uri: it.uri,
                      name: isVideo ? 'status.mp4' : 'status.jpg',
                      type: isVideo ? 'video/mp4' : 'image/jpeg',
                    };
                    try {
                      const up = await api.statusUpload(file);
                      if (up?.success && up.data?.url) {
                        carouselItems.push({
                          media_url: up.data.url,
                          type: isVideo ? 'video' : 'image',
                          background: '#000000',
                        });
                      }
                    } catch (e) { console.warn('[carousel upload]', e?.message); }
                  }
                  if (carouselItems.length > 0 && api.statusCarouselPublish) {
                    await api.statusCarouselPublish(carouselItems, { privacy: 'all' });
                    load();
                  }
                } finally { setStatusPublishing(false); }
                return;
              }
              const { uri, type, isBoomerang } = payload || {};
              if (!uri) return;
              const isVideo = type === 'video';
              setStatusEditor({
                uri,
                type: isVideo ? 'video' : 'image',
                isBoomerang: !!isBoomerang,
                file: { uri, name: isVideo ? 'status.mp4' : 'status.jpg', type: isVideo ? 'video/mp4' : 'image/jpeg' },
              });
              setStatusCaption('');
            }}
          />
        </Modal>
      )}

      {/* Status Editor — FULLSCREEN preview + caption + filters (Instagram-like) */}
      <Modal visible={!!statusEditor} transparent={false} animationType="slide" onRequestClose={() => { setStatusEditor(null); setStatusCaption(''); setEditorFilterIdx(0); }}>
        {statusEditor && (
        <View style={{ flex:1, backgroundColor:'#000' }}>
          {/* Image/Video preview with filter overlay + Instagram-style gestures */}
          <View style={{ flex: 1 }}>
            {statusEditor.type === 'image' ? (
              (() => {
                const ImageEditorGestures = require('./ImageEditorGestures').default;
                const cssFilter = (() => {
                  const f = STATUS_FILTERS[editorFilterIdx];
                  if (!f?.adjust) return 'none';
                  const a = f.adjust;
                  const parts = [];
                  if (a.brightness) parts.push(`brightness(${a.brightness})`);
                  if (a.contrast) parts.push(`contrast(${a.contrast})`);
                  if (a.saturate) parts.push(`saturate(${a.saturate})`);
                  if (a.sepia) parts.push(`sepia(${a.sepia})`);
                  if (a.grayscale) parts.push(`grayscale(${a.grayscale})`);
                  if (a.hueRotate) parts.push(`hue-rotate(${a.hueRotate}deg)`);
                  return parts.join(' ') || 'none';
                })();
                // On web, apply CSS filter via container style
                return (
                  <View style={{ flex: 1, ...(Platform.OS === 'web' ? { filter: cssFilter, WebkitFilter: cssFilter } : {}) }}>
                    <ImageEditorGestures
                      uri={statusEditor.uri}
                      filterOverlay={Platform.OS !== 'web' ? <FilterOverlay filter={STATUS_FILTERS[editorFilterIdx]} /> : null}
                    />
                  </View>
                );
              })()
            ) : (
              Platform.OS === 'web'
                ? <video src={statusEditor.uri} autoPlay loop playsInline muted style={{ width:'100%', height:'100%', objectFit:'contain' }} />
                : (() => {
                    // Prefer expo-video (SDK 55+ — currently bundled). expo-av is
                    // legacy and was returning null on first render here, leaving
                    // the editor blank. Both APIs have a different shape so we
                    // try the new one first and fall back to expo-av.
                    try {
                      const { VideoView, useVideoPlayer } = require('expo-video');
                      // useVideoPlayer is a hook so we wrap in an inline component
                      const StatusEditorVideo = ({ uri }) => {
                        const player = useVideoPlayer(uri, (p) => { try { p.loop = true; p.muted = true; p.play(); } catch {} });
                        return <VideoView player={player} style={{ width:'100%', height:'100%' }} contentFit="contain" nativeControls={false} />;
                      };
                      return <StatusEditorVideo uri={statusEditor.uri} />;
                    } catch {}
                    try {
                      const { Video } = require('expo-av');
                      return <Video source={{ uri: statusEditor.uri }} style={{ width:'100%', height:'100%' }} resizeMode="contain" shouldPlay isLooping isMuted />;
                    } catch { return null; }
                  })()
            )}
          </View>

          {/* Close button */}
          <View style={{ position:'absolute', top: Platform.OS === 'ios' ? 54 : 40, left:12, right:12, flexDirection:'row', justifyContent:'space-between', alignItems:'center', zIndex: 10 }}>
            <TouchableOpacity onPress={() => { setStatusEditor(null); setStatusCaption(''); setEditorFilterIdx(0); }} style={{ width:40, height:40, borderRadius:20, backgroundColor:'rgba(0,0,0,0.55)', alignItems:'center', justifyContent:'center' }}>
              <Text style={{ color:'#fff', fontSize:20 }}>✕</Text>
            </TouchableOpacity>
            {STATUS_FILTERS[editorFilterIdx]?.key !== 'normal' && (
              <View style={{ backgroundColor:'rgba(0,0,0,0.5)', borderRadius:16, paddingHorizontal:12, paddingVertical:5 }}>
                <Text style={{ color:'#fff', fontSize:12, fontWeight:'700' }}>{STATUS_FILTERS[editorFilterIdx]?.label}</Text>
              </View>
            )}
          </View>

          {/* Filter thumbnails (Instagram-style horizontal scroll) — images only */}
          {statusEditor.type === 'image' && (
            <View style={{ position:'absolute', bottom: 130, left:0, right:0, height: 100 }}>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal:12, gap:8 }}>
                {STATUS_FILTERS.map((f, i) => (
                  <TouchableOpacity key={f.key} onPress={() => setEditorFilterIdx(i)} activeOpacity={0.7} style={{ alignItems:'center', width: 72 }}>
                    <View style={{ width:68, height:68, borderRadius:8, overflow:'hidden', borderWidth: editorFilterIdx === i ? 3 : 2, borderColor: editorFilterIdx === i ? '#fff' : 'transparent' }}>
                      <CachedImage source={{ uri: statusEditor.uri }} style={{ width:'100%', height:'100%' }} resizeMode="cover" />
                      <FilterOverlay filter={f} style={{ borderRadius: 6 }} />
                    </View>
                    <Text style={{ color: editorFilterIdx === i ? '#fff' : 'rgba(255,255,255,0.6)', fontSize:10, fontWeight: editorFilterIdx === i ? '800' : '600', marginTop:3 }} numberOfLines={1}>{f.label}</Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}

          {/* Emoji row */}
          <View style={{ position:'absolute', bottom: statusEditor.type === 'image' ? 235 : 140, left:0, right:0, flexDirection:'row', justifyContent:'center', flexWrap:'wrap', gap:8, paddingHorizontal:16 }}>
            {['😂','❤️','🔥','👏','😮','😢','🎉','🙌'].map(em => (
              <TouchableOpacity key={em} onPress={() => setStatusCaption(c => (c + ' ' + em).trim())} style={{ width:42, height:42, borderRadius:21, backgroundColor:'rgba(0,0,0,0.45)', alignItems:'center', justifyContent:'center' }}>
                <Text style={{ fontSize:22 }}>{em}</Text>
              </TouchableOpacity>
            ))}
          </View>

          {/* Caption + Send — wrapped in KeyboardAvoidingView so the input
              lifts above the keyboard instead of being covered by it (was
              showing only the keyboard with a blank screen behind). */}
          <KeyboardAvoidingView
            behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            style={{ position:'absolute', bottom:0, left:0, right:0 }}
            keyboardVerticalOffset={0}
          >
          <View style={{ paddingBottom:40, paddingLeft:12, paddingRight:12, flexDirection:'row', alignItems:'center', gap:10 }}>
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
                setStatusUploadPct(0);
                try {
                  const up = await api.statusUpload(statusEditor.file, (pct) => {
                    setStatusUploadPct(Math.max(0, Math.min(100, Math.round(pct))));
                  });
                  if (up?.success && up.data?.url) {
                    // statusPublish routes media_url + content separately:
                    // media_url gets just the URL (clean), caption goes in
                    // extraMeta.caption → backend writes it to the content
                    // column. Viewer renders content as the caption overlay.
                    const extraMeta = statusEditor.isBoomerang
                      ? { is_boomerang: true, caption: statusCaption.trim() }
                      : (statusCaption.trim() ? { caption: statusCaption.trim() } : null);
                    const pubRes = await api.statusPublish(up.data.url, statusEditor.type === 'video' ? 'video' : 'image', '#000000', null, extraMeta);
                    setStatusEditor(null); setStatusCaption(''); setEditorFilterIdx(0);
                    // Optimistic insert — show the new status in the row
                    // immediately while the next load() refreshes from the
                    // server. Was waiting up to 2 minutes (poll interval)
                    // for the post to surface visually.
                    if (pubRes?.success) {
                      const newId = pubRes.data?.id || pubRes.id || Date.now();
                      const optimisticItem = {
                        id: newId,
                        type: statusEditor.type === 'video' ? 'video' : 'image',
                        media_url: up.data.url,
                        content: statusCaption.trim(),
                        bg_color: '#000000',
                        background: '#000000',
                        views: 0,
                        viewed: false,
                        created_at: new Date().toISOString(),
                        meta: extraMeta || null,
                        is_boomerang: !!(extraMeta && extraMeta.is_boomerang),
                      };
                      setStatuses(prev => {
                        const myEmail = user?.email;
                        const existing = prev.find(g => g.email === myEmail);
                        if (existing) {
                          return prev.map(g => g.email === myEmail
                            ? { ...g, items: [...(g.items || []), optimisticItem] }
                            : g);
                        }
                        return [{
                          email: myEmail,
                          name: user?.email?.split('@')[0] || '',
                          is_own: true,
                          items: [optimisticItem],
                        }, ...prev];
                      });
                    }
                    // Server-truth refresh kicks in after a short delay so the
                    // INSERT has settled, then again 2s later as a safety net.
                    setTimeout(() => load(), 200);
                    setTimeout(() => load(), 2000);
                  }
                } catch {} finally { setStatusPublishing(false); setStatusUploadPct(0); }
              }}
              style={{ width:54, height:54, borderRadius:27, backgroundColor:'#7C3AED', alignItems:'center', justifyContent:'center', opacity: statusPublishing ? 0.6 : 1 }}
            >
              {statusPublishing ? <ActivityIndicator color="#fff" /> : <Text style={{ color:'#fff', fontSize:22, fontWeight:'700' }}>→</Text>}
            </TouchableOpacity>
          </View>
          </KeyboardAvoidingView>

          {/* Upload progress overlay — fullscreen translucent layer with
              ring + percentage so the user sees the post in flight instead
              of the editor freezing silently. */}
          {statusPublishing && (
            <View pointerEvents="none" style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.55)',
              alignItems: 'center', justifyContent: 'center',
            }}>
              <View style={{
                width: 120, height: 120, borderRadius: 60,
                backgroundColor: 'rgba(0,0,0,0.7)',
                alignItems: 'center', justifyContent: 'center',
                borderWidth: 3, borderColor: 'rgba(255,255,255,0.18)',
              }}>
                <CircularProgressArc
                  pct={statusUploadPct || 0}
                  size={120}
                  strokeWidth={4}
                  color="#7C3AED"
                  inset={5}
                  style={{ position: 'absolute' }}
                />
                <Text style={{ color: '#fff', fontSize: 22, fontWeight: '700' }}>{statusUploadPct || 0}%</Text>
              </View>
              <Text style={{ color: '#fff', fontSize: 14, marginTop: 16, fontWeight: '600' }}>
                {statusEditor.type === 'video' ? (t('status.uploadingVideo') || 'Enviando vídeo...') : (t('status.uploadingPhoto') || 'Enviando foto...')}
              </Text>
            </View>
          )}
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
  // Lazy single-pass partition — was 2× filter (active + archived) on every
  // initial mount even when both sets came from the same array.
  const [conversations, setConversations] = useState(() => _initialConvs.filter(c => !c.archived));
  const [archivedConversations, setArchivedConversations] = useState(() => {
    if (!_initialConvs.length) return [];
    const arch = []; for (const c of _initialConvs) if (c.archived) arch.push(c);
    return arch;
  });
  // Sync ref for conversations count — avoids async setState detection bug
  const _convsCountRef = useRef(_initialConvs.length);
  _convsCountRef.current = conversations?.length || 0;
  // Debounce lock for conversation taps so a double-tap doesn't push the
  // same chat onto the stack twice (user complaint: "tenho que clicar 2 vez
  // para voltar").
  const _navLockRef = useRef(null);
  // Skip the loading spinner if we already painted from cache
  const [loading, setLoading] = useState(_initialConvs.length === 0);
  // WS down banner — surfaces an "offline" hint at the top of the list so
  // the user knows new messages aren't syncing live. Only shows after a
  // 3.5s delay (set by the connection listener) so brief flaps don't flash.
  const [wsDownBanner, setWsDownBanner] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Local searchText kept for the legacy chatConversations() network call
  // path; mirrors the parent-provided searchQuery prop so the same value
  // drives both the filter and the debounced server request. Removed the
  // duplicate TextInput (parent now owns the visible search bar).
  const [searchText, setSearchText] = useState('');
  useEffect(() => { setSearchText(searchQuery || ''); }, [searchQuery]);
  // Debounced search query — drives the heavy local filter so typing stays
  // smooth on 1000+ chats. 200ms feels instant but skips ~5 keystrokes' worth
  // of synchronous map+filter work.
  const [debouncedQuery, setDebouncedQuery] = useState(searchQuery || '');
  useEffect(() => {
    const q = (searchQuery || '').trim();
    if (q.length === 0) {
      // Clearing search: apply immediately so the UI doesn't feel laggy.
      setDebouncedQuery('');
      return;
    }
    const id = setTimeout(() => setDebouncedQuery(searchQuery || ''), 200);
    return () => clearTimeout(id);
  }, [searchQuery]);
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
  // Contact-discovery banner (WhatsApp pattern: surface "X amigos no Chatyy"
  // straight from the chat list so users find friends without first hunting
  // through the FAB → New chat flow). null = hide; 'cta' = first-run CTA;
  // { count } = found-count badge. Dismiss persists 7 days via AsyncStorage.
  const [contactBanner, setContactBanner] = useState(null);
  const [contactBannerSyncing, setContactBannerSyncing] = useState(false);
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const dismissedAt = Number((await AsyncStorage.getItem('chat:contactBannerDismissedAt')) || 0);
        if (dismissedAt && (Date.now() - dismissedAt) < 7 * 24 * 60 * 60 * 1000) return;
        const { getCachedContacts } = require('../services/contactSync');
        const cached = await getCachedContacts();
        if (cancelled) return;
        if (cached && Array.isArray(cached.chatyContacts) && cached.chatyContacts.length > 0) {
          // Stash up to 5 preview avatars so the banner can render an
          // overlapping circle stack (WhatsApp pattern). Rest of the list
          // is reachable behind the tap → /chat-new.
          setContactBanner({
            count: cached.chatyContacts.length,
            preview: cached.chatyContacts.slice(0, 5),
          });
        } else {
          setContactBanner('cta');
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);
  const dismissContactBanner = useCallback(async () => {
    setContactBanner(null);
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      AsyncStorage.setItem('chat:contactBannerDismissedAt', String(Date.now())).catch(() => {});
    } catch {}
  }, []);
  const handleContactBannerPress = useCallback(async () => {
    if (Platform.OS === 'web') return;
    if (contactBanner === 'cta') {
      // First run: ask permission, sync, jump to chat-new with the matches.
      setContactBannerSyncing(true);
      try {
        const { syncContacts } = require('../services/contactSync');
        const r = await syncContacts(true, t);
        if (r && Array.isArray(r.chatyContacts) && r.chatyContacts.length > 0) {
          setContactBanner({
            count: r.chatyContacts.length,
            preview: r.chatyContacts.slice(0, 5),
          });
        }
      } catch {} finally { setContactBannerSyncing(false); }
      try { router.push('/chat-new'); } catch {}
    } else {
      try { router.push('/chat-new'); } catch {}
    }
  }, [contactBanner, router, t]);
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

  // iMessage-style long-press menu — declarado abaixo (após os handlers de
  // pin/mute/archive/delete) pra evitar TDZ em useCallback deps. Ref-based
  // wrapper aqui pra poder ser referenciado sem importar a ordem.
  const lpMenuRef = useRef(null);
  // Custom WhatsApp-style action sheet (icon-on-the-right list) replaces
  // ActionSheetIOS / Alert. The state holds the conversation being acted
  // on; null = sheet closed.
  const [lpMenuConv, setLpMenuConv] = useState(null);
  const showLongPressMenu = useCallback((conv) => {
    // Haptic medium impact — same WhatsApp gives on long-press preview.
    try {
      const H = require('expo-haptics');
      H.impactAsync(H.ImpactFeedbackStyle.Medium).catch(() => {});
    } catch {}
    lpMenuRef.current?.(conv);
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

  // Toggle read/unread on the selected chats. Mirrors WhatsApp: if any
  // selected chat has unread, the action marks ALL as read; if all are
  // already read, the action marks them unread. Optimistic UI: bump
  // unread_count locally before the round-trip so the dot disappears
  // / reappears immediately.
  const handleBulkToggleUnread = useCallback(async () => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    const selected = conversations.filter(c => selectedIds.has(c.id));
    const anyUnread = selected.some(c => (c.unread_count || 0) > 0);
    setConversations(prev => prev.map(c => {
      if (!selectedIds.has(c.id)) return c;
      return anyUnread ? { ...c, unread_count: 0 } : { ...c, unread_count: Math.max(c.unread_count || 0, 1) };
    }));
    for (const id of ids) {
      try {
        if (anyUnread) await api.chatReadAck?.(id);
        else await api.chatMarkUnread?.(id);
      } catch {}
    }
    loadConversations(false);
    exitSelectionMode();
  }, [selectedIds, conversations, exitSelectionMode]);

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
        // Single-pass partition: was 2× filter (one for active, one for
        // archived) — O(n) doubled per refresh. Now single O(n) loop.
        const _active = []; const _arch = [];
        for (const c of convs) (c.archived ? _arch : _active).push(c);
        setConversations(_active);
        setArchivedConversations(_arch);
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
        // Mirror cached snapshot into App Group so the native ShareExtension
        // works on cold-start before the network refresh lands.
        _saveNativeConversations(cached);
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

  // Telegram-style prewarm: once the list is painted, quietly pull the
  // last few messages of the top conversations that have no local cache
  // yet (user never opened them). On native this also prefetches media.
  // Single-shot per session — tracked by a ref so a list refresh doesn't
  // re-spam the API.
  const _prewarmedRef = useRef(false);
  useEffect(() => {
    if (_prewarmedRef.current) return;
    if (!Array.isArray(conversations) || conversations.length === 0) return;
    _prewarmedRef.current = true;
    // Give the initial render a frame to commit before we start firing
    // background requests. Also avoids a thundering-herd at login when
    // the list, inbox, and meetings all mount together.
    const kick = setTimeout(() => {
      prewarmConversationsCache(conversations, { topN: 10, perConv: 5 }).catch(() => {});
    }, 1500);
    return () => clearTimeout(kick);
  }, [conversations]);

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
    // Native FTS5 search disabled — crashes via corrupted triggers. Fall through
    // to network search (api.chatSearch) below, which is still sub-500ms.
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      loadConversations(false);
    }, 400);
  }, [loadConversations]);

  useEffect(() => {
    let unsubs = [];
    try {
      const mailWs = require('../services/websocket').default;

      // Subscribe to the user's personal chat channel. The backend emits
      // `chat_summary` events to `chat_user_{email}` whenever any
      // conversation the user is in receives a new message (WhatsApp-style
      // channel split). Without this subscribe, the WS hub drops the
      // event silently and the list never updates the last-message
      // preview / unread badge / reorder. Bug reported 2026-04-19.
      if (user?.email) {
        try { mailWs.subscribe(`chat_user_${user.email}`); } catch {}
      }

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

      // Debounce the "notification" side effects (sound + haptic) so a burst
      // of messages triggers one notification, not five. Last-heard conv id
      // + 1.2s window covers the typical WhatsApp-style quick reply pattern.
      let _lastNotifyAt = 0;
      // Handler shared between `chat_message` (self or sender's other-device
      // broadcast) and `chat_summary` (per-user fan-out from the new
      // channel-split: recipients receive chat_summary, NEVER chat_message,
      // on their per-user channel so the in-thread and list-screen paths
      // don't both fire). Server guarantees the same payload shape.
      const onIncomingForList = (data) => {
        if (wsUpdateTimer.current) clearTimeout(wsUpdateTimer.current);
        wsUpdateTimer.current = setTimeout(() => {
          // Don't bump unread for messages we sent ourselves (echoed back
          // by relay) — without this, the badge counts the user's own
          // outgoing messages.
          const senderEmail = (data.sender_email || data.sender || '').toLowerCase();
          const isSelf = senderEmail && user?.email && senderEmail === String(user.email).toLowerCase();
          // Sound + soft haptic when someone else's message lands and the
          // user is NOT inside that conversation (chat-conversation fires
          // its own receive sound for the open thread). Throttled to 1/1.2s.
          if (!isSelf) {
            const now = Date.now();
            if (now - _lastNotifyAt > 1200) {
              _lastNotifyAt = now;
              try { require('../services/notificationSound').playChatReceiveSound(); } catch {}
            }
          }
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
              // Conversation not in local cache — common when the user was
              // just added to a group OR the cache is stale. Insert an
              // optimistic placeholder at the top so the bubble appears
              // immediately, then refetch to fill in members/avatar/etc.
              loadConversations(false);
              const senderLc = String(data.sender_email || data.sender || '').toLowerCase();
              const meLc = String(user?.email || '').toLowerCase();
              const placeholder = {
                id: data.conversation_id,
                conversation_id: data.conversation_id,
                type: data.conversation_type || 'direct',
                name: data.conversation_name || data.sender_name || data.sender_email || data.sender || '',
                display_name: data.conversation_name || data.sender_name || '',
                avatar: data.conversation_avatar || '',
                other_email: data.conversation_type === 'group' ? null : (senderLc !== meLc ? data.sender_email : null),
                last_message: {
                  content: data.content || data.message,
                  type: data.type || 'text',
                  sender_email: data.sender_email || data.sender,
                  sender_name: data.sender_name || data.sender_email || data.sender,
                  created_at: data.created_at || new Date().toISOString(),
                },
                last_message_at: data.created_at || new Date().toISOString(),
                last_message_sender: data.sender_email || data.sender,
                last_message_type: data.type || 'text',
                unread_count: senderLc === meLc ? 0 : 1,
                muted: 0,
                pinned: 0,
              };
              return [placeholder, ...prev];
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
      };
      unsubs.push(mailWs.on('chat_message', onIncomingForList));
      // chat_summary is the new per-user-channel event introduced by the
      // WhatsApp-style channel split in chat.php. Recipients receive it
      // INSTEAD of chat_message, so the list has to listen to both to cover
      // old-server (still firing chat_message) and new-server paths.
      unsubs.push(mailWs.on('chat_summary', onIncomingForList));

      unsubs.push(mailWs.on('chat_read', (data) => {
        const meLower = (user?.email || '').toLowerCase();
        const readerLower = (data?.reader_email || data?.email || '').toLowerCase();
        // Who did the reading: me (just opened my own chat) OR the peer
        // (read my outbound). In the peer case we bump last_message.read_at
        // so the purple ✓✓ appears in the list without waiting for a fresh
        // chat_list fetch.
        setConversations(prev => {
          const idx = prev.findIndex(c => c.id == data.conversation_id || c.conversation_id == data.conversation_id);
          if (idx === -1) return prev;
          return prev.map((c, i) => {
            if (i !== idx) return c;
            const next = { ...c };
            if (!readerLower || readerLower === meLower) {
              next.unread_count = 0;
            } else if (c.last_message && c.last_message.sender_email
                       && c.last_message.sender_email.toLowerCase() === meLower
                       && !c.last_message.read_at) {
              next.last_message = { ...c.last_message, read_at: new Date().toISOString() };
            }
            return next;
          });
        });
      }));

      // Peer delivered (received) our outbound → upgrade ✓ to ✓✓ gray.
      unsubs.push(mailWs.on('chat_delivered', (data) => {
        const meLower = (user?.email || '').toLowerCase();
        setConversations(prev => {
          const idx = prev.findIndex(c => c.id == data?.conversation_id);
          if (idx === -1) return prev;
          return prev.map((c, i) => {
            if (i !== idx) return c;
            if (c.last_message && c.last_message.sender_email
                && c.last_message.sender_email.toLowerCase() === meLower
                && !c.last_message.delivered_at) {
              return { ...c, last_message: { ...c.last_message, delivered_at: new Date().toISOString() } };
            }
            return c;
          });
        });
      }));

      // Reconnect catchup — messages that arrived while WS was down never
      // hit the chat_message listener above, so the list would stay frozen
      // on the old state until manual refresh or the 2-min interval tick.
      // On every re-authentication, force a fresh chat_list fetch so new
      // conversations + updated last-message previews land immediately.
      let wasConnected = true;
      let bannerTimer = null;
      unsubs.push(mailWs.on('connection', (data) => {
        if (data?.status === 'authenticated') {
          if (!wasConnected) { try { loadConversations(false); } catch {} }
          wasConnected = true;
          if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
          setWsDownBanner(false);
        } else if (data?.status === 'disconnected') {
          wasConnected = false;
          // Match chat-conversation pattern: 3.5s delay before showing
          // banner so a brief flap (network change, app resume) doesn't
          // flash the banner unnecessarily.
          if (!bannerTimer) {
            bannerTimer = setTimeout(() => {
              if (!wasConnected) setWsDownBanner(true);
              bannerTimer = null;
            }, 3500);
          }
        }
      }));
      unsubs.push(() => { if (bannerTimer) clearTimeout(bannerTimer); });
      // App returning from background: refresh the entire conversation list
      // so the last-message preview and unread counts reflect anything that
      // arrived while WS was dead. Without this the list shows stale bubbles
      // until the user manually pulls to refresh.
      unsubs.push(mailWs.on('foreground', () => {
        try { loadConversations(false); } catch {}
      }));
      // silent_sync (background FCM hint) → refresh the list so a message
      // that landed while the app was suspended shows up the moment the
      // user opens the chat tab. Telegram does the same on background fetch.
      unsubs.push(mailWs.on('silent_sync', (data) => {
        if (data?.type && data.type !== 'chat') return;
        try { loadConversations(false); } catch {}
      }));
      // status_new — backend broadcasts this when ANY contact (or your own
      // other device) publishes a status. Triggers a load() so the new
      // status circle appears in the row instantly instead of waiting up
      // to 2 minutes for the polling interval.
      unsubs.push(mailWs.on('status_new', (data) => {
        try { load(); } catch {}
      }));
      unsubs.push(mailWs.on('status_published', () => { try { load(); } catch {} }));
      unsubs.push(mailWs.on('status_added', () => { try { load(); } catch {} }));
      unsubs.push(mailWs.on('status_deleted', () => { try { load(); } catch {} }));
    } catch {}
    return () => {
      unsubs.forEach(fn => fn?.());
      if (wsUpdateTimer.current) clearTimeout(wsUpdateTimer.current);
      Object.values(typingTimeoutsRef.current).forEach(id => clearTimeout(id));
      typingTimeoutsRef.current = {};
      try {
        const mailWs = require('../services/websocket').default;
        if (user?.email) mailWs.unsubscribe(`chat_user_${user.email}`);
      } catch {}
    };
  }, [user?.email, loadConversations]);

  // WebSocket-based presence (single source of truth)
  useEffect(() => {
    let mailWs;
    try { mailWs = require('../services/websocket').default; } catch { return; }
    let intervalId;

    const queryDmPresences = () => {
      const dmEmails = [];
      const meLc = (user?.email || '').toLowerCase();
      for (const conv of conversations) {
        if (conv.type === 'direct' && conv.members) {
          const other = conv.members.find(m => {
            const e = typeof m === 'string' ? m : (m?.email || '');
            return e && e.toLowerCase() !== meLc;
          });
          const otherEmail = (other ? (typeof other === 'string' ? other : other?.email) : null)
            || conv.other_email || conv.contact_email || null;
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
    // Debounce guard: without this a double-tap pushed two chat-conversation
    // screens onto the stack, so the user had to hit back twice to escape.
    // 800ms is generous enough to swallow a finger-fumble without blocking
    // the next deliberate tap.
    const now = Date.now();
    const last = _navLockRef.current;
    if (last && last.id === conv.id && (now - last.at) < 800) return;
    _navLockRef.current = { id: conv.id, at: now };
    // Haptic click on row-open — WhatsApp pattern, confirms the tap took.
    try {
      if (Platform.OS !== 'web') {
        const Haptics = require('expo-haptics');
        Haptics.selectionAsync().catch(() => {});
      }
    } catch {}

    const meLc = (user?.email || '').toLowerCase();
    // Prefer server-computed peer (never returns the caller themselves).
    // Only fall back to members.find() when we know who "me" is — otherwise
    // .find(e !== '') picks the FIRST member and that's often the current
    // user, which used to open the chat with `email=me` and paint the user's
    // own avatar in the header.
    let otherEmail = null;
    if (conv.type === 'direct') {
      const serverPeer = conv.other_email || conv.contact_email || null;
      if (serverPeer && serverPeer.toLowerCase() !== meLc) {
        otherEmail = serverPeer;
      } else if (meLc && conv.members) {
        const otherMember = conv.members.find(m => {
          const e = typeof m === 'string' ? m : (m?.email || '');
          return e && e.toLowerCase() !== meLc;
        });
        otherEmail = otherMember
          ? (typeof otherMember === 'string' ? otherMember : otherMember?.email)
          : null;
      }
    }
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
      // WhatsApp-parity: also wipe local media + cached messages for this
      // conversation. Without this the user's phone keeps multi-GB of chat
      // media that they already decided to delete.
      try {
        const sm = require('../services/smartChatCache');
        const cached = sm.getCachedMessagesSync?.(conv.id, 1000) || [];
        if (cached.length > 0) {
          const { deleteConversationMedia } = require('../services/mediaCache');
          deleteConversationMedia(cached).catch(() => {});
        }
        sm.clearConversation?.(conv.id);
      } catch {}
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
    // Optimistic toggle
    const wasMuted = !!conv.muted;
    setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, muted: !wasMuted } : c));
    try {
      // muteUntil null toggles. Pass 0 to unmute, or a unix ts to mute until.
      await api.chatMute(conv.id, wasMuted ? 0 : (Math.floor(Date.now()/1000) + 8*3600));
      loadConversations(false);
    } catch {
      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, muted: wasMuted } : c));
    }
  }, [loadConversations]);

  const handlePinConversation = useCallback(async (conv) => {
    // Optimistic toggle so swipe feels instant
    setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, pinned: !c.pinned } : c));
    try {
      // chat_pin pins a MESSAGE (needs message_id). For pinning the whole
      // conversation to top of the list we need chat_pin_conversation which
      // in email.php maps to the chat_favorite/chat_pin_conversation case.
      await api.apiCall('chat_pin_conversation', { conversation_id: conv.id }, 'POST');
      loadConversations(false);
    } catch {
      // Revert optimistic toggle on error
      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, pinned: !c.pinned } : c));
    }
  }, [loadConversations]);

  const handleMarkUnreadConversation = useCallback(async (conv) => {
    try {
      setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, unread_count: Math.max(c.unread_count || 0, 1) } : c));
      await api.chatMarkUnread(conv.id);
    } catch {}
  }, []);

  // Real implementação do long-press menu (referenciada via lpMenuRef).
  // Roda após render de todos os handlers, evitando problema de declaração.
  useEffect(() => {
    lpMenuRef.current = (conv) => {
      // WhatsApp-style: open the custom sheet. The sheet itself reads
      // conv state (pinned/muted/locked) to flip labels and pulls the
      // peer email for the Block row in direct chats.
      setLpMenuConv(conv);
    };
  }, []);

  // Imperative menu actions, exposed to the rendered sheet.
  const lpActions = useRef({});
  useEffect(() => {
    lpActions.current = {
      onPin: (conv) => handlePinConversation(conv),
      onMute: (conv) => handleMuteConversation(conv),
      onMarkUnread: (conv) => handleMarkUnreadConversation(conv),
      onArchive: (conv) => handleArchiveConversation(conv),
      onSelect: (conv) => enterSelectionMode(conv.id),
      onDelete: (conv) => handleDeleteConversation(conv),
      onLockToggle: async (conv) => {
        try {
          await api.chatLock(conv.id, !conv.locked);
          setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, locked: !conv.locked ? 1 : 0 } : c));
        } catch {}
      },
      onClear: (conv) => {
        safeAlert(
          t('chat.clearChat') || 'Limpar conversa',
          t('chat.clearChatConfirm') || 'Apagar todas as mensagens? A conversa permanece na lista.',
          [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
            {
              text: t('chat.clear') || 'Limpar', style: 'destructive',
              onPress: async () => {
                try { await api.chatClearHistory(conv.id); } catch {}
                setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, last_message: '' } : c));
              },
            },
          ]
        );
      },
      onBlock: (conv) => {
        const peerEmail = conv?.other_email || conv?.contact_email || conv?.email || '';
        if (!peerEmail) return;
        safeAlert(
          (t('chat.blockUser') || 'Bloquear') + '?',
          (t('chat.blockUserConfirm') || 'Vocês não vão mais trocar mensagens nem chamadas.'),
          [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
            {
              text: t('chat.block') || 'Bloquear', style: 'destructive',
              onPress: async () => { try { await api.chatBlockUser(peerEmail); } catch {} },
            },
          ]
        );
      },
      onAddToList: (conv) => { try { router?.push(`/chat-folders?addId=${conv.id}`); } catch {} },
      // Pinned-only: enter the wiggle/drag reorder mode for the avatar grid.
      // Sheet only surfaces this entry when conv.pinned, so we don't need a
      // guard here.
      onReorderPinned: () => setPinnedEditMode(true),
    };
  }, [t, handlePinConversation, handleMuteConversation, handleMarkUnreadConversation, handleArchiveConversation, handleDeleteConversation, enterSelectionMode, router]);

  // Legacy ActionSheetIOS / Alert path lived here — replaced by the custom
  // WhatsApp-style sheet rendered below (state-driven via lpMenuConv). The
  // old branch is preserved in git history if we ever need to fall back.
  /* eslint-disable */
  if (false) {
    const conv = {};
    const isPinned = !!conv.pinned;
    const isMuted = !!conv.muted;
    const isLocked = !!conv.locked;
    const isDirect = (conv.type || 'direct') === 'direct';
    const peerEmail = isDirect
      ? (conv.other_email || conv.contact_email || conv.email || '')
      : '';
    const pinLabel = isPinned ? (t('chat.unpin') || 'Desafixar') : (t('chat.pin') || 'Fixar conversa');
    const muteLabel = isMuted ? (t('chat.unmute') || 'Reativar som') : (t('chat.mute') || 'Silenciar');
    const lockLabel = isLocked ? (t('chat.unlockChat') || 'Desbloquear chat') : (t('chat.lockChat') || 'Bloquear chat');
    const unreadLabel = (conv.unread_count || 0) > 0 ? (t('chat.markRead') || 'Marcar como lida') : (t('chat.markUnread') || 'Marcar como não lida');
    const blockLabel = peerEmail
      ? `${t('chat.blockUser') || 'Bloquear'} ${conv.display_name || conv.name || peerEmail.split('@')[0]}`
      : null;

      // Confirm-then-act helpers reused for the destructive entries. The
      // alert keeps WhatsApp parity (single confirm step + a destructive
      // button), instead of dropping the user straight into a clear/delete.
      const confirmClear = () => {
        safeAlert(
          t('chat.clearChat') || 'Limpar conversa',
          t('chat.clearChatConfirm') || 'Apagar todas as mensagens? A conversa permanece na lista.',
          [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
            {
              text: t('chat.clear') || 'Limpar', style: 'destructive',
              onPress: async () => {
                try { await api.chatClearHistory(conv.id); } catch {}
                setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, last_message: '', last_message_at: c.last_message_at } : c));
              },
            },
          ]
        );
      };
      const confirmBlock = () => {
        if (!peerEmail) return;
        safeAlert(
          (t('chat.blockUser') || 'Bloquear') + '?',
          (t('chat.blockUserConfirm') || 'Vocês não vão mais trocar mensagens nem chamadas.'),
          [
            { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
            {
              text: t('chat.block') || 'Bloquear', style: 'destructive',
              onPress: async () => { try { await api.chatBlockUser(peerEmail); } catch {} },
            },
          ]
        );
      };
      const handleLockToggle = async () => {
        try {
          await api.chatLock(conv.id, !isLocked);
          setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, locked: !isLocked ? 1 : 0 } : c));
        } catch {}
      };

      if (Platform.OS === 'ios') {
        // Order matches WhatsApp: read/unread → pin → mute → lock → archive
        // → favorites/list → divider → block → clear → delete → cancel.
        // Block hidden in groups since the API is per-user.
        const options = [
          unreadLabel,
          pinLabel,
          muteLabel,
          lockLabel,
          t('chat.archive') || 'Arquivar',
          t('chat.addToList') || 'Adicionar a lista',
          t('chat.selectMore') || 'Selecionar várias',
        ];
        if (blockLabel) options.push(blockLabel);
        options.push(t('chat.clearChat') || 'Limpar conversa');
        options.push(t('chat.delete') || 'Excluir');
        options.push(t('common.cancel') || 'Cancelar');
        const cancelIdx = options.length - 1;
        const deleteIdx = cancelIdx - 1;
        const clearIdx = cancelIdx - 2;
        const blockIdx = blockLabel ? cancelIdx - 3 : -1;
        ActionSheetIOS.showActionSheetWithOptions(
          {
            options,
            cancelButtonIndex: cancelIdx,
            destructiveButtonIndex: blockLabel ? [blockIdx, clearIdx, deleteIdx] : [clearIdx, deleteIdx],
            title: conv.display_name || conv.name || '',
          },
          (idx) => {
            if (idx === 0) handleMarkUnreadConversation(conv);
            else if (idx === 1) handlePinConversation(conv);
            else if (idx === 2) handleMuteConversation(conv);
            else if (idx === 3) handleLockToggle();
            else if (idx === 4) handleArchiveConversation(conv);
            else if (idx === 5) {
              try { router?.push(`/chat-folders?addId=${conv.id}`); } catch {}
            }
            else if (idx === 6) enterSelectionMode(conv.id);
            else if (idx === blockIdx) confirmBlock();
            else if (idx === clearIdx) confirmClear();
            else if (idx === deleteIdx) handleDeleteConversation(conv);
          }
        );
      } else if (Platform.OS === 'android') {
        // Android Alert allows up to 3 buttons cleanly — use a custom
        // bottom sheet would be ideal, but Alert keeps native parity.
        Alert.alert(
          conv.display_name || conv.name || '',
          '',
          [
            { text: pinLabel, onPress: () => handlePinConversation(conv) },
            { text: muteLabel, onPress: () => handleMuteConversation(conv) },
            { text: lockLabel, onPress: () => handleLockToggle() },
            { text: t('chat.archive') || 'Arquivar', onPress: () => handleArchiveConversation(conv) },
            { text: unreadLabel, onPress: () => handleMarkUnreadConversation(conv) },
            ...(blockLabel ? [{ text: blockLabel, style: 'destructive', onPress: () => confirmBlock() }] : []),
            { text: t('chat.clearChat') || 'Limpar conversa', style: 'destructive', onPress: () => confirmClear() },
            { text: t('chat.delete') || 'Excluir', style: 'destructive', onPress: () => handleDeleteConversation(conv) },
            { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
          ],
          { cancelable: true }
        );
      } else {
        enterSelectionMode(conv.id);
      }
  }
  /* eslint-enable */

  // Email swipe action — opens compose pre-filled with the recipient(s).
  //   • Direct: the peer's email goes to `to`.
  //   • Group / channel: every member except me goes to `to` (comma-list)
  //     so the user can blast the whole group at once. Previously this was
  //     a no-op for groups, which made the swipe button look broken.
  const handleEmailConversation = useCallback((conv) => {
    if (!router) return;
    const _meLc = (user?.email || '').toLowerCase();
    const members = conv?.members || [];
    const peers = [];
    for (const m of members) {
      const e = typeof m === 'string' ? m : (m?.email || '');
      if (e && e.toLowerCase() !== _meLc) peers.push(e);
    }
    let target = '';
    if (conv?.type === 'group' || conv?.type === 'channel') {
      // Group: blast all members. Comma-separated; compose screen splits
      // and renders chips. Limit to 50 to avoid pathological URL bloat.
      target = peers.slice(0, 50).join(',');
    } else {
      target = peers[0] || conv?.other_email || conv?.contact_email || conv?.email || '';
    }
    if (!target) return;
    const params = new URLSearchParams({ to: target });
    if (conv?.name && (conv?.type === 'group' || conv?.type === 'channel')) {
      params.set('subject', `[${conv.name}]`);
    }
    router.push(`/compose?${params.toString()}`);
  }, [router, user?.email]);

  const unreadCount = useMemo(() => conversations.filter(c => c.unread_count > 0).length, [conversations]);
  const groupCount = useMemo(() => conversations.filter(c => c.type === 'group').length, [conversations]);
  const channelCount = useMemo(() => conversations.filter(c => c.type === 'channel').length, [conversations]);
  const favoritesCount = useMemo(() => conversations.filter(c => c.pinned).length, [conversations]);
  const archivedCount = archivedConversations.length;

  // ─── Pinned avatar grid: user-defined order + size ───
  // Persisted per user in AsyncStorage (chatyy:pinned_order_v1 = id[],
  // chatyy:pinned_size_v1 = 's'|'m'|'l'). Long-press a pinned avatar →
  // "Reorganizar" enters edit mode: row wiggles, drag swaps positions,
  // tap "Concluir" exits + persists.
  const [pinnedOrder, setPinnedOrder] = useState([]);          // ordered conv ids
  const [pinnedSize, setPinnedSize] = useState('m');           // 's' | 'm' | 'l'
  const [pinnedEditMode, setPinnedEditMode] = useState(false);
  const [pinDraggingId, setPinDraggingId] = useState(null);
  const pinDragTxRef = useRef(new Map());                      // id → Animated.Value(translateX)
  const pinWiggleAnim = useRef(new Animated.Value(0)).current; // shared wiggle driver
  // Hydrate prefs on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const o = await AsyncStorage.getItem(userScopedKey('chatyy:pinned_order_v1'));
        const s = await AsyncStorage.getItem(userScopedKey('chatyy:pinned_size_v1'));
        if (cancelled) return;
        if (o) { try { const arr = JSON.parse(o); if (Array.isArray(arr)) setPinnedOrder(arr); } catch {} }
        if (s === 's' || s === 'l') setPinnedSize(s);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);
  // Persist helpers.
  const savePinnedOrder = useCallback((arr) => {
    setPinnedOrder(arr);
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      AsyncStorage.setItem(userScopedKey('chatyy:pinned_order_v1'), JSON.stringify(arr)).catch(() => {});
    } catch {}
  }, []);
  const savePinnedSize = useCallback((sz) => {
    setPinnedSize(sz);
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      AsyncStorage.setItem(userScopedKey('chatyy:pinned_size_v1'), sz).catch(() => {});
    } catch {}
  }, []);
  // Wiggle loop while in edit mode (subtle ±1.8°).
  useEffect(() => {
    if (!pinnedEditMode) {
      pinWiggleAnim.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pinWiggleAnim, { toValue: 1, duration: 110, useNativeDriver: true }),
        Animated.timing(pinWiggleAnim, { toValue: -1, duration: 220, useNativeDriver: true }),
        Animated.timing(pinWiggleAnim, { toValue: 0, duration: 110, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pinnedEditMode, pinWiggleAnim]);

  // ─── Draft indicators (AsyncStorage-backed) ───
  // Live-updated via DeviceEventEmitter: every keystroke that autosaves a
  // draft in chat-conversation emits a 'chatyy:draft' event; we patch the
  // map in place so the list shows "Rascunho: ..." immediately without
  // waiting for a re-render of the whole conversations array.
  const [drafts, setDrafts] = useState({});
  // Feature C — drafts grouping: collapsible "Rascunhos" section at top
  // when 2+ drafts exist. Default = collapsed if 3+, expanded if exactly 2.
  const [draftsSectionOpen, setDraftsSectionOpen] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const keys = await AsyncStorage.getAllKeys();
        // Drafts now live under the per-user scoped prefix produced by
        // userScopedKey(`chat_draft_<id>`) — i.e. "u:<email>:chat_draft_<id>".
        // Compute the active prefix once and accept either the scoped form
        // (current writes) or the legacy bare prefix (pre-scoping leftovers).
        const scopedPrefix = userScopedKey('chat_draft_');
        const legacyPrefix = 'chat_draft_';
        const draftKeys = keys.filter(k => k.startsWith(scopedPrefix) || k.startsWith(legacyPrefix));
        if (draftKeys.length === 0) { if (alive) setDrafts({}); return; }
        const pairs = await AsyncStorage.multiGet(draftKeys);
        const d = {};
        for (const [key, val] of pairs) {
          if (val && val.trim()) {
            // Strip whichever prefix is in use to recover the conv id.
            const convId = key.startsWith(scopedPrefix)
              ? key.slice(scopedPrefix.length)
              : key.slice(legacyPrefix.length);
            d[convId] = val;
          }
        }
        if (alive) setDrafts(d);
      } catch {}
    })();
    return () => { alive = false; };
  }, [conversations]);

  useEffect(() => {
    try {
      const { DeviceEventEmitter } = require('react-native');
      const sub = DeviceEventEmitter.addListener('chatyy:draft', (p) => {
        if (!p?.conversationId) return;
        setDrafts(prev => {
          const next = { ...prev };
          const t = (p.text || '').trim();
          if (t) next[String(p.conversationId)] = t;
          else delete next[String(p.conversationId)];
          return next;
        });
      });
      return () => sub.remove();
    } catch { return undefined; }
  }, []);

  const filteredConversations = useMemo(() => {
    if (filter === 'archived') return archivedConversations;
    // Folder filter: filter values like "folder_<id>" → match by folder filter_type/value
    let folderFilter = null;
    if (typeof filter === 'string' && filter.startsWith('folder_')) {
      const fid = parseInt(filter.slice(7), 10);
      folderFilter = chatFolders.find(f => Number(f.id) === fid) || null;
    }
    const sq = (debouncedQuery || '').trim().toLowerCase();
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
  }, [filter, conversations, archivedConversations, debouncedQuery, chatFolders]);

  // Feature C — partition drafts at the top so we can render a collapsible
  // "Rascunhos (X)" section above the rest. When 2+ drafts exist:
  //   - default collapsed when 3+ (the section header replaces the rows)
  //   - default expanded when exactly 2 (still shown as a labelled group)
  // 1 draft = no special grouping (left in place inline).
  const draftConvIds = useMemo(() => {
    const ids = new Set();
    for (const k of Object.keys(drafts || {})) {
      const v = drafts[k];
      if (v && String(v).trim()) ids.add(String(k));
    }
    return ids;
  }, [drafts]);
  const draftConversations = useMemo(() => (
    filteredConversations.filter(c => draftConvIds.has(String(c.id)))
  ), [filteredConversations, draftConvIds]);
  const hasDraftSection = draftConversations.length >= 2;
  // Auto-init collapsed/expanded when count crosses thresholds. We only adjust
  // when transitioning the count buckets so user toggles aren't overwritten.
  const draftCountRef = useRef(0);
  useEffect(() => {
    const n = draftConversations.length;
    if (draftCountRef.current === n) return;
    draftCountRef.current = n;
    if (n <= 1) {
      setDraftsSectionOpen(true); // not used when n<2 but reset for safety
    } else if (n === 2) {
      setDraftsSectionOpen(true);
    } else if (n >= 3) {
      setDraftsSectionOpen(false);
    }
  }, [draftConversations.length]);

  // visibleConversations definido MAIS ABAIXO (após pinnedConversations e
  // pinnedAvatarsMode), porque referencia ambos. Se ficar aqui dá TDZ no
  // primeiro render — useMemo tenta ler antes de existirem, dedup falha e
  // pinned aparecem 2x (no avatar grid + na lista). Movido pra L~3340.

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
    (async () => {
      try {
        const { dbSearchMessages } = require('../services/db');
        const local = await dbSearchMessages(q, 20);
        if (myId !== latestSearchReqId.current) return;
        if (Array.isArray(local) && local.length) {
          const mapped = local.map(m => {
            let raw = null; try { raw = m.raw_json ? JSON.parse(m.raw_json) : null; } catch {}
            return { ...(raw || {}), id: m.id, conversation_id: m.conversation_id, content: m.content, sender_email: m.sender_email, created_at: m.created_at, _local: true };
          });
          setMessageHits(mapped);
          setSearchingMessages(false);
        }
      } catch {}
    })();
    const timer = setTimeout(async () => {
      try {
        const r = await api.apiCall('chat_search', { query: q, limit: 20 });
        if (myId !== latestSearchReqId.current) return;
        const raw = r?.success
          ? (Array.isArray(r.data) ? r.data : (r.data?.results ?? r.data?.hits ?? []))
          : [];
        if (Array.isArray(raw) && raw.length) {
          const seen = new Set();
          const merged = [];
          for (const hit of raw) {
            const key = `${hit.conversation_id}:${hit.id}`;
            if (seen.has(key)) continue;
            seen.add(key); merged.push(hit);
          }
          setMessageHits(merged);
        } else {
          setMessageHits(prev => prev.filter(m => m._local));
        }
      } catch {
        if (myId === latestSearchReqId.current) setMessageHits(prev => prev.filter(m => m._local));
      } finally {
        if (myId === latestSearchReqId.current) setSearchingMessages(false);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const pinnedCount = useMemo(() => filteredConversations.filter(c => c.pinned).length, [filteredConversations]);

  // iMessage-style: pinned conversations render as a horizontal grid of large
  // circular avatars at the top, capped at 9 (iMessage's limit). Below that
  // limit, fall back to the regular list-with-pin-badge layout — 10+ pinned
  // chats look messy as big circles. Only on `filter === 'all'` and not
  // Smart-pin (opt-in): top 3 most active conversations of last 30d auto-fixar
  // when user toggled it ON in settings. Fetched once on mount, cached for
  // the session — refetch on pull-to-refresh or filter change.
  const [smartPinEnabled, setSmartPinEnabled] = useState(false);
  const [smartPinIds, setSmartPinIds] = useState([]); // server-returned conv ids
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const s = await api.chatGetSettings();
        if (cancelled) return;
        const on = !!(s?.data?.smart_pin_enabled);
        setSmartPinEnabled(on);
        if (on) {
          const r = await api.chatTopActive(3);
          if (cancelled) return;
          setSmartPinIds(Array.isArray(r?.data?.conversation_ids) ? r.data.conversation_ids : []);
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, []);

  // Pinned conversations = manual pins + (when smart-pin ON) top-active conv
  // ids resolved against the loaded conversation list. The smart-pin entries
  // get an `_smartPin: true` flag so the UI can render the ✨ differentiator.
  const pinnedConversations = useMemo(() => {
    const manual = filteredConversations.filter(c => c.pinned).slice(0, 9);
    let combined = manual;
    if (smartPinEnabled && smartPinIds.length > 0) {
      const manualIds = new Set(manual.map(c => c.id));
      const smart = smartPinIds
        .map(id => filteredConversations.find(c => c.id === id && !manualIds.has(c.id)))
        .filter(Boolean)
        .map(c => ({ ...c, _smartPin: true }));
      combined = [...manual, ...smart].slice(0, 9);
    }
    // Apply user-defined order (chatyy:pinned_order_v1). Items present in
    // the order array sort by their index; everything else falls to the
    // end keeping the natural (recent-activity) order. Dropped/missing
    // ids in `pinnedOrder` are tolerated — they just have no effect.
    if (pinnedOrder.length === 0) return combined;
    const orderMap = new Map(pinnedOrder.map((id, i) => [String(id), i]));
    const TAIL = 1e6;
    return [...combined].sort((a, b) => {
      const ai = orderMap.has(String(a.id)) ? orderMap.get(String(a.id)) : TAIL;
      const bi = orderMap.has(String(b.id)) ? orderMap.get(String(b.id)) : TAIL;
      return ai - bi;
    });
  }, [filteredConversations, smartPinEnabled, smartPinIds, pinnedOrder]);

  // iMessage avatar grid mode triggers when there's any pinned (manual or smart)
  // and the user is on the "all" filter without a search query.
  const pinnedAvatarsMode = useMemo(() => {
    return filter === 'all'
      && !((searchQuery || '').trim())
      && pinnedConversations.length > 0
      && pinnedConversations.length <= 9;
  }, [filter, searchQuery, pinnedConversations.length]);

  // visibleConversations — derivado de filteredConversations, exclui as pinadas
  // quando o avatar grid tá ativo (pra não mostrar duplicado). Movido pra cá
  // depois do pinnedConversations/pinnedAvatarsMode pra evitar TDZ.
  const visibleConversations = useMemo(() => {
    let base = filteredConversations;
    if (pinnedAvatarsMode) {
      const pinnedIds = new Set(pinnedConversations.map(c => c.id));
      base = base.filter(c => !pinnedIds.has(c.id));
    }
    if (!hasDraftSection) return base;
    if (draftsSectionOpen) return base;
    // Collapsed: hide rows that have drafts (the header pill represents them).
    return base.filter(c => !draftConvIds.has(String(c.id)));
  }, [filteredConversations, hasDraftSection, draftsSectionOpen, draftConvIds, pinnedAvatarsMode, pinnedConversations]);

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
    // iMessage-style grid: avatares grandes circulares no topo, até 9 fixadas.
    // Acima de 9 cai no fallback "FIXADAS" (lista vertical com badge de pin)
    // — 10+ bolas grandes ficam estranhas.
    if (pinnedAvatarsMode) {
      // Size presets: S=52, M=64 (default), L=80. SLOT_W = sizePx + gap(14)
      // is the per-item slice the drag uses to compute swap target indexes.
      const sizePx = pinnedSize === 's' ? 52 : pinnedSize === 'l' ? 80 : 64;
      const SLOT_W = sizePx + 14;
      const wiggleRotate = pinWiggleAnim.interpolate({
        inputRange: [-1, 1], outputRange: ['-1.8deg', '1.8deg'],
      });
      // Lazy-init Animated.Values per id so they survive across renders.
      pinnedConversations.forEach(c => {
        if (!pinDragTxRef.current.has(c.id)) {
          pinDragTxRef.current.set(c.id, new Animated.Value(0));
        }
      });
      const buildPanForItem = (item, idx) => PanResponder.create({
        onStartShouldSetPanResponder: () => false,
        onStartShouldSetPanResponderCapture: () => false,
        onMoveShouldSetPanResponder: (_, g) =>
          pinnedEditMode && Math.abs(g.dx) > 4 && Math.abs(g.dx) > Math.abs(g.dy),
        onMoveShouldSetPanResponderCapture: (_, g) =>
          pinnedEditMode && Math.abs(g.dx) > 4 && Math.abs(g.dx) > Math.abs(g.dy),
        onPanResponderGrant: () => {
          setPinDraggingId(item.id);
          try { require('react-native').Vibration.vibrate(8); } catch {}
        },
        onPanResponderMove: (_, g) => {
          const tx = pinDragTxRef.current.get(item.id);
          if (tx) tx.setValue(g.dx);
          const delta = Math.round(g.dx / SLOT_W);
          const target = Math.max(0, Math.min(pinnedConversations.length - 1, idx + delta));
          pinnedConversations.forEach((other, oidx) => {
            if (other.id === item.id) return;
            const t = pinDragTxRef.current.get(other.id);
            if (!t) return;
            let shift = 0;
            if (delta > 0 && oidx > idx && oidx <= target) shift = -SLOT_W;
            else if (delta < 0 && oidx < idx && oidx >= target) shift = SLOT_W;
            t.setValue(shift);
          });
        },
        onPanResponderRelease: (_, g) => {
          const delta = Math.round(g.dx / SLOT_W);
          const target = Math.max(0, Math.min(pinnedConversations.length - 1, idx + delta));
          const dragTx = pinDragTxRef.current.get(item.id);
          const resetAll = () => {
            pinnedConversations.forEach(c => pinDragTxRef.current.get(c.id)?.setValue(0));
          };
          if (target !== idx && dragTx) {
            // Settle the dragged item visually at its new slot, then commit
            // the new id order and reset all transforms in one frame so
            // the layout reshuffle doesn't flicker.
            Animated.timing(dragTx, {
              toValue: (target - idx) * SLOT_W,
              duration: 140, useNativeDriver: true,
            }).start(() => {
              const ids = pinnedConversations.map(c => c.id);
              const [moved] = ids.splice(idx, 1);
              ids.splice(target, 0, moved);
              savePinnedOrder(ids);
              resetAll();
            });
          } else {
            Animated.parallel(
              pinnedConversations
                .map(c => pinDragTxRef.current.get(c.id))
                .filter(Boolean)
                .map(v => Animated.spring(v, { toValue: 0, friction: 7, useNativeDriver: true }))
            ).start();
          }
          setPinDraggingId(null);
        },
        onPanResponderTerminate: () => {
          pinnedConversations.forEach(c => pinDragTxRef.current.get(c.id)?.setValue(0));
          setPinDraggingId(null);
        },
        onPanResponderTerminationRequest: () => false,
      });
      return (
        <View style={{
          paddingVertical: 14,
          paddingLeft: 14,
          backgroundColor: isDark ? 'rgba(124,58,237,0.04)' : 'rgba(124,58,237,0.02)',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
        }}>
          {/* Header strip — discoverable Reorganizar button. Long-press tambem
              continua funcionando, mas user reportou que nao acha como mexer
              em ordem/tamanho. Botao explicito resolve o "ainda nao deixa". */}
          {!pinnedEditMode ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 14, marginBottom: 10 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <IconPin size={11} color={isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.4)'} />
                <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.4, color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }}>
                  {(t?.('chat.pinned') || 'FIXADAS').toUpperCase()}
                </Text>
              </View>
              <TouchableOpacity
                onPress={() => {
                  try { require('react-native').Vibration.vibrate(8); } catch {}
                  setPinnedEditMode(true);
                }}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={t?.('chat.reorderPinned') || 'Reorganizar fixados'}
                style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12, backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)' }}
              >
                <Text style={{ fontSize: 11, fontWeight: '700', color: '#7C3AED', letterSpacing: 0.3 }}>
                  {t?.('chat.editPinned') || 'Editar'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEnabled={!pinnedEditMode}
            contentContainerStyle={{ paddingRight: 14, gap: 14, alignItems: 'center' }}
          >
            {pinnedConversations.map((item, idx) => {
              const isGroup = item.type === 'group' || item.type === 'channel';
              const peerEmail = !isGroup ? (item.other_email || item.contact_email || item.email || '') : '';
              let nick = '';
              if (peerEmail) { try { nick = require('../services/nicknames').getNickname(peerEmail); } catch {} }
              const name = nick || emailToDisplayName(item.display_name || item.name || '?');
              const unread = item.unread_count || 0;
              const tx = pinDragTxRef.current.get(item.id) || new Animated.Value(0);
              const isDragging = pinDraggingId === item.id;
              const pan = pinnedEditMode ? buildPanForItem(item, idx) : null;
              return (
                <Animated.View
                  key={item.id}
                  {...(pan ? pan.panHandlers : {})}
                  style={{
                    width: sizePx + 4, alignItems: 'center',
                    transform: [
                      { translateX: tx },
                      { rotate: pinnedEditMode ? wiggleRotate : '0deg' },
                      { scale: isDragging ? 1.08 : 1 },
                    ],
                    zIndex: isDragging ? 10 : 1,
                    ...(isDragging ? Platform.select({
                      ios: { shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
                      android: { elevation: 8 },
                      default: {},
                    }) : {}),
                  }}
                >
                  <TouchableOpacity
                    disabled={pinnedEditMode}
                    onPress={() => {
                      if (selectionMode) toggleSelected(item.id);
                      else handleConversationPress(item);
                    }}
                    onLongPress={() => showLongPressMenu(item)}
                    delayLongPress={isWeb ? 300 : 500}
                    activeOpacity={0.75}
                  >
                    <View style={{ position: 'relative' }}>
                      {isGroup
                        ? <GroupAvatarStack conversation={item} size={sizePx} isDark={isDark} />
                        : <AvatarCircle name={name} email={peerEmail} size={sizePx} />
                      }
                      {/* Edit-mode unpin badge — iOS Home-screen style. Tap (×)
                          desafixa direto sem precisar abrir long-press menu. */}
                      {pinnedEditMode ? (
                        <TouchableOpacity
                          onPress={() => {
                            try { require('react-native').Vibration.vibrate(8); } catch {}
                            handlePinConversation(item);
                          }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityLabel={t?.('chat.unpin') || 'Desafixar'}
                          style={{
                            position: 'absolute', top: -4, left: -4,
                            width: 24, height: 24, borderRadius: 12,
                            backgroundColor: isDark ? '#0d1117' : '#fff',
                            borderWidth: 1.5, borderColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.12)',
                            alignItems: 'center', justifyContent: 'center',
                            zIndex: 5,
                            ...Platform.select({
                              ios: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
                              android: { elevation: 3 },
                              default: {},
                            }),
                          }}
                        >
                          <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={isDark ? '#fff' : '#0f172a'} strokeWidth={2.5} strokeLinecap="round">
                            <Path d="M18 6 6 18M6 6l12 12" />
                          </Svg>
                        </TouchableOpacity>
                      ) : null}
                      <View style={{
                        position: 'absolute', bottom: -2, right: -2,
                        width: 22, height: 22, borderRadius: 11,
                        backgroundColor: isDark ? '#0d1117' : '#fff',
                        borderWidth: 2, borderColor: isDark ? '#0d1117' : '#fff',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        <View style={{
                          width: 18, height: 18, borderRadius: 9,
                          backgroundColor: item._smartPin ? '#F59E0B' : '#7C3AED',
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          {item._smartPin
                            ? <IconSparkles size={10} color="#fff" />
                            : <IconPin size={10} color="#fff" />
                          }
                        </View>
                      </View>
                      {unread > 0 && (
                        <View style={{
                          position: 'absolute', top: -2, right: -2,
                          minWidth: 22, height: 22, borderRadius: 11,
                          paddingHorizontal: 5,
                          backgroundColor: '#EF4444',
                          borderWidth: 2, borderColor: isDark ? '#0d1117' : '#fff',
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800' }}>
                            {unread > 99 ? '99+' : unread}
                          </Text>
                        </View>
                      )}
                      {selectionMode && selectedIds.has(item.id) && (
                        <View style={{
                          position: 'absolute', left: 0, top: 0,
                          width: sizePx, height: sizePx, borderRadius: sizePx / 2,
                          borderWidth: 3, borderColor: '#7C3AED',
                        }} />
                      )}
                    </View>
                    <Text
                      numberOfLines={1}
                      style={{
                        marginTop: 6, fontSize: 11, fontWeight: '600',
                        color: colors.text, textAlign: 'center', maxWidth: sizePx + 4,
                      }}
                    >
                      {name}
                    </Text>
                  </TouchableOpacity>
                </Animated.View>
              );
            })}
            {/* Edit-mode controls: segmented [S][M][L] picker + Concluir.
                Substitui o cycle button antigo ("Tamanho · M") que escondia
                opções e dava feedback ruim. iOS/iMessage-style. */}
            {pinnedEditMode ? (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginLeft: 4 }}>
                <View style={{
                  flexDirection: 'row',
                  height: 34, borderRadius: 17,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(124,58,237,0.08)',
                  borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(124,58,237,0.18)',
                  padding: 2,
                }}>
                  {['s', 'm', 'l'].map(sz => {
                    const sel = pinnedSize === sz;
                    return (
                      <TouchableOpacity
                        key={sz}
                        onPress={() => {
                          if (pinnedSize === sz) return;
                          try { require('react-native').Vibration.vibrate(6); } catch {}
                          savePinnedSize(sz);
                        }}
                        activeOpacity={0.75}
                        style={{
                          paddingHorizontal: 12, height: 28, borderRadius: 14,
                          alignItems: 'center', justifyContent: 'center',
                          backgroundColor: sel ? '#7C3AED' : 'transparent',
                        }}
                        accessibilityLabel={`${t('chat.pinnedSize') || 'Tamanho'} ${sz.toUpperCase()}`}
                      >
                        <Text style={{ fontSize: 12, fontWeight: '700', color: sel ? '#fff' : (isDark ? 'rgba(255,255,255,0.7)' : '#7C3AED') }}>
                          {sz.toUpperCase()}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </View>
                <TouchableOpacity
                  onPress={() => {
                    try { require('react-native').Vibration.vibrate(8); } catch {}
                    setPinnedEditMode(false);
                  }}
                  activeOpacity={0.75}
                  style={{
                    paddingHorizontal: 14, height: 34, borderRadius: 17,
                    flexDirection: 'row', alignItems: 'center', gap: 6,
                    backgroundColor: '#7C3AED',
                  }}
                  accessibilityLabel={t('common.done') || 'Concluir'}
                >
                  <IconCheck size={14} color="#fff" />
                  <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>
                    {t('common.done') || 'Concluir'}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : null}
          </ScrollView>
        </View>
      );
    }
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
    return (
      <>
        <ConversationRow
          conversation={item}
          colors={colors}
          isDark={isDark}
          t={t}
          onPress={() => handleConversationPress(item)}
          onPressIn={() => { try { prefetchConversation(item.id); } catch {} }}
          onDelete={handleDeleteConversation}
          onArchive={handleArchiveConversation}
          onMute={handleMuteConversation}
          onPin={handlePinConversation}
          onMarkUnread={handleMarkUnreadConversation}
          onEmail={handleEmailConversation}
          currentEmail={user?.email}
          isOnline={(() => {
            if (item.type === 'group') return false;
            const members = item.members || [];
            const _meLc = (user?.email || '').toLowerCase();
            const other = members.find(m => {
              const e = typeof m === 'string' ? m : (m?.email || '');
              return e && e.toLowerCase() !== _meLc;
            });
            const otherEmail = (other ? (typeof other === 'string' ? other : other?.email) : null) || item.other_email || item.contact_email || null;
            if (!otherEmail) return false;
            const p = presencesRef.current;
            if (p instanceof Map) { const v = p.get(otherEmail); return v?.status === 'online' || v === 'online'; }
            return false;
          })()}
          lastSeen={(() => {
            if (item.type === 'group') return null;
            const members = item.members || [];
            const _meLc = (user?.email || '').toLowerCase();
            const other = members.find(m => {
              const e = typeof m === 'string' ? m : (m?.email || '');
              return e && e.toLowerCase() !== _meLc;
            });
            const otherEmail = (other ? (typeof other === 'string' ? other : other?.email) : null) || item.other_email || item.contact_email || null;
            if (!otherEmail) return null;
            const p = presencesRef.current;
            if (p instanceof Map) { const v = p.get(otherEmail); return v?.last_seen || null; }
            return null;
          })()}
          isLocked={lockedIds.has(item.id) && !unlockedIds.has(item.id)}
          typingUsers={typingUsers}
          selectionMode={selectionMode}
          isSelected={selectedIds.has(item.id)}
          onLongPress={() => showLongPressMenu(item)}
          onToggleSelect={() => toggleSelected(item.id)}
          draftText={drafts[String(item.id)] || null}
          noteText={(() => {
            if (item.type !== 'direct') return null;
            const members = item.members || [];
            const _meLc = (user?.email || '').toLowerCase();
            const other = members.find(m => {
              const e = typeof m === 'string' ? m : (m?.email || '');
              return e && e.toLowerCase() !== _meLc;
            });
            const otherEmail = (other ? (typeof other === 'string' ? other : other?.email) : null) || item.other_email || item.contact_email || null;
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
      {/* Feature C — Drafts section header (collapsible) when 2+ drafts exist */}
      {hasDraftSection && (
        <TouchableOpacity
          onPress={() => setDraftsSectionOpen(v => !v)}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 10,
            paddingHorizontal: 16, paddingVertical: 10,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
            backgroundColor: isDark ? 'rgba(220,38,38,0.06)' : 'rgba(220,38,38,0.05)',
          }}
        >
          <Text style={{ color: '#dc2626', fontSize: 13, fontWeight: '700', flex: 1 }}>
            {(t?.('chat.draftsSection') || 'Rascunhos')} ({draftConversations.length})
          </Text>
          <Text style={{ color: '#dc2626', fontSize: 16, fontWeight: '700', transform: [{ rotate: draftsSectionOpen ? '180deg' : '0deg' }] }}>
            ⌄
          </Text>
        </TouchableOpacity>
      )}
      {/* WS down banner — only shown after 3.5s delay (set by the connection
          listener) so brief reconnects don't flash. Lets the user know
          messages aren't syncing live so they don't think the app is broken. */}
      {wsDownBanner && (
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          paddingHorizontal: 14, paddingVertical: 8,
          backgroundColor: isDark ? '#3a2a14' : '#fff5e6',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        }}>
          <ActivityIndicator size="small" color={isDark ? '#f59e0b' : '#d97706'} />
          <Text style={{ flex: 1, fontSize: 13, color: isDark ? '#f59e0b' : '#92400e' }}>
            {t?.('chat.reconnecting') || 'Reconectando…'}
          </Text>
        </View>
      )}
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
      {/* Contact-discovery banner (WhatsApp pattern) — auto-shown only on
          native and only if not dismissed in the last 7 days. Tap → opens
          chat-new (which also runs the sync), or runs the sync inline if
          the user hasn't granted Contacts permission yet. Hidden during
          search and during selection mode to avoid clutter. */}
      {Platform.OS !== 'web' && contactBanner && !selectionMode && !((searchQuery || '').trim()) && (
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 12,
          paddingHorizontal: 14, paddingVertical: 10,
          backgroundColor: isDark ? 'rgba(34,197,94,0.10)' : 'rgba(34,197,94,0.08)',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
        }}>
          <TouchableOpacity
            onPress={handleContactBannerPress}
            disabled={contactBannerSyncing}
            style={{ flexDirection: 'row', alignItems: 'center', gap: 12, flex: 1 }}
            activeOpacity={0.7}
            accessibilityRole="button"
          >
            {/* Leading visual: when we know specific friends are on Chatyy,
                show their overlapping avatar stack (WhatsApp pattern — feels
                concrete and personal). Falls back to the green +icon for the
                generic CTA where we don't have a list yet. */}
            {contactBanner !== 'cta' && Array.isArray(contactBanner?.preview) && contactBanner.preview.length > 0 ? (
              <View style={{ flexDirection: 'row', width: 38 + (Math.min(contactBanner.preview.length, 4) - 1) * 18, height: 38 }}>
                {contactBanner.preview.slice(0, 4).map((c, i) => (
                  <View key={(c?.email || c?.id || c?.name || i) + ':' + i} style={{
                    position: 'absolute', left: i * 18, top: 0,
                    borderWidth: 2, borderColor: isDark ? '#0f1c14' : '#fff',
                    borderRadius: 19,
                    zIndex: 4 - i,
                  }}>
                    <AvatarCircle name={c?.name || c?.email || ''} email={c?.email} size={34} />
                  </View>
                ))}
              </View>
            ) : (
              <View style={{
                width: 38, height: 38, borderRadius: 19,
                backgroundColor: '#22c55e',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <IconUserPlus size={20} color="#fff" />
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }} numberOfLines={1}>
                {contactBanner === 'cta'
                  ? (t?.('chat.findFriendsTitle') || 'Encontre amigos do seu celular')
                  : (t?.('chat.foundFriendsTitle') || 'Amigos no Chatyy').replace('{n}', String(contactBanner.count))}
              </Text>
              <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }} numberOfLines={1}>
                {contactBanner === 'cta'
                  ? (t?.('chat.findFriendsHint') || 'Achamos quem já tá no Chatyy pelo número salvo')
                  : (t?.('chat.foundFriendsHint') || `${contactBanner.count} contato${contactBanner.count === 1 ? '' : 's'} já no Chatyy — toque pra ver`)}
              </Text>
            </View>
            {contactBannerSyncing ? <ActivityIndicator size="small" color="#22c55e" /> : null}
          </TouchableOpacity>
          <TouchableOpacity
            onPress={dismissContactBanner}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            accessibilityLabel={t?.('common.dismiss') || 'Dispensar'}
          >
            <IconX size={18} color={colors.textTertiary || '#999'} />
          </TouchableOpacity>
        </View>
      )}
      {renderPinnedLabel()}
      {(searchQuery || '').trim().length >= 2 && filteredConversations.length > 0 && (
        <View style={{ paddingHorizontal: 16, paddingTop: 10, paddingBottom: 6 }}>
          <Text style={{ fontSize: 13, fontWeight: '700', color: isDark ? '#a78bfa' : '#7C3AED', letterSpacing: 0.3 }}>
            CONVERSAS
          </Text>
        </View>
      )}
    </>
  ), [filter, pinnedCount, isDark, colors, t, archivedCount, searchQuery, filteredConversations.length, user, router, pinnedAvatarsMode, pinnedConversations, selectionMode, selectedIds, handleConversationPress, enterSelectionMode, toggleSelected, contactBanner, contactBannerSyncing, handleContactBannerPress, dismissContactBanner]);

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
          const date = hit.created_at ? (_d => isNaN(_d.getTime()) ? '' : _d.toLocaleDateString())(new Date(hit.created_at)) : '';
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
  }, [searchQuery, messageHits, searchingMessages, isDark, colors, router, wsDownBanner, t, hasDraftSection, draftConversations.length, draftsSectionOpen]);

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
            <TouchableOpacity
              onPress={handleBulkToggleUnread}
              style={{ padding: 6 }}
              accessibilityLabel={t('chat.markUnread') || 'Mark unread'}
              accessibilityRole="button"
            >
              <IconMail size={20} color={colors.text} />
            </TouchableOpacity>
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
        <FilterChip label={t('chat.filterUnread') || 'Não lidas'} value="unread" count={unreadCount} />
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
          data={visibleConversations}
          keyExtractor={keyExtractor}
          estimatedItemSize={80}
          ListHeaderComponent={ListHeaderComponent}
          ListFooterComponent={ListFooterComponent}
          renderItem={renderItem}
          ListEmptyComponent={ListEmptyComponent}
          contentContainerStyle={[visibleConversations.length === 0 && s.listEmpty]}
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

      {/* FAB button — Telegram-grade glass orb */}
      <BrandFab
        style={{ position: 'absolute', right: 18, bottom: 80 }}
        onPress={toggleFabMenu}
        onLongPress={() => setShowBroadcast(true)}
        size={58}
        radius={18}
        color={ACCENT}
        accessibilityLabel={t?.('chat.newConversation') || 'New conversation'}
        contentTransform={[{
          rotate: fabMenuAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '45deg'] }),
        }]}
      >
        <Svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
          <Line x1="12" y1="5" x2="12" y2="19" />
          <Line x1="5" y1="12" x2="19" y2="12" />
        </Svg>
      </BrandFab>

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
      <ChatLongPressSheet
        conv={lpMenuConv}
        onClose={() => setLpMenuConv(null)}
        actions={lpActions.current}
        colors={colors}
        isDark={isDark}
        t={t}
        currentUserEmail={user?.email}
        router={router}
        typingUsers={typingUsers}
        presencesRef={presencesRef}
      />
    </View>
  );
}

// ─────────────────────────────────────────────────────────────────────
// ChatLongPressSheet — WhatsApp-style action sheet with icon-on-the-right
// rows. Replaces ActionSheetIOS (no icons) and Android Alert (no
// destructive grouping). Renders inside a Modal so it floats above
// the chat list and intercepts taps via a tinted backdrop.
// ─────────────────────────────────────────────────────────────────────
function ChatLongPressSheet({ conv, onClose, actions, colors, isDark, t, currentUserEmail, router, typingUsers, presencesRef }) {
  const slideY = React.useRef(new Animated.Value(40)).current;
  const scale = React.useRef(new Animated.Value(0.95)).current;
  const backdrop = React.useRef(new Animated.Value(0)).current;
  // Drag offset for swipe-down-to-dismiss. Sums with slideY in the
  // transform so the open animation and the gesture don't fight each other.
  const panY = React.useRef(new Animated.Value(0)).current;
  const onCloseRef = React.useRef(onClose);
  React.useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const [previewMsgs, setPreviewMsgs] = React.useState([]);
  // Fix 3 — track async-refresh state so the peek shows skeleton bubbles
  // (instead of "Sem mensagens ainda") while api.chatMessages is in flight
  // on cold cache + missing last_message.
  const [loading, setLoading] = React.useState(false);
  React.useEffect(() => {
    if (conv) {
      // Sync read first — sheet pops with whatever is cached so the user
      // never sees an empty peek even on cold conversations.
      let initial = [];
      try {
        // Bumpado de 6 -> 12 mensagens — user reportou peek "nao mostrando
        // todas as conversas" (i.e., poucas msgs visiveis). Cache local
        // costuma ter mais que 6 quando a conversa ja foi aberta.
        initial = (getCachedMessagesSync(conv.id, 16) || []).slice(-12);
        setPreviewMsgs(initial);
      } catch { setPreviewMsgs([]); }
      Animated.parallel([
        Animated.spring(slideY, { toValue: 0, tension: 100, friction: 11, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, tension: 100, friction: 11, useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 1, duration: 200, useNativeDriver: true }),
      ]).start();
      // Then async-refresh from backend so the peek always shows the
      // *real* last messages (with timestamps + read state) even when
      // the local cache is cold or stale. We only swap in if we got
      // back as many or more rows than what we already had — avoids
      // visual flicker if the network call returns empty.
      let cancelled = false;
      setLoading(true);
      (async () => {
        try {
          const r = await api.chatMessages(conv.id, 12);
          if (cancelled) return;
          const fresh = Array.isArray(r?.messages) ? r.messages
                       : Array.isArray(r) ? r : [];
          if (fresh.length >= initial.length && fresh.length > 0) {
            setPreviewMsgs(fresh.slice(-12));
          }
        } catch {}
        finally { if (!cancelled) setLoading(false); }
      })();
      return () => { cancelled = true; };
    } else {
      slideY.setValue(40);
      scale.setValue(0.95);
      backdrop.setValue(0);
      panY.setValue(0);
      setLoading(false);
    }
  }, [conv, slideY, scale, backdrop, panY]);

  // Swipe-down-to-dismiss — mirrors the Profile peek pattern. Vertical drag
  // moves the whole peek (preview card + action menu) down while fading the
  // backdrop. Past 110px or velocity 0.6 commits the close; otherwise spring.
  const SH = Dimensions.get('window').height;
  const _commitDragClose = React.useCallback(() => {
    Animated.parallel([
      Animated.timing(panY, { toValue: SH, duration: 220, useNativeDriver: true }),
      Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
    ]).start(() => {
      try { onCloseRef.current?.(); } catch {}
      panY.setValue(0);
    });
  }, [panY, backdrop, SH]);
  const _snapBackDrag = React.useCallback(() => {
    Animated.parallel([
      Animated.spring(panY, { toValue: 0, friction: 8, tension: 90, useNativeDriver: true }),
      Animated.timing(backdrop, { toValue: 1, duration: 160, useNativeDriver: true }),
    ]).start();
  }, [panY, backdrop]);
  // Capture variants are critical here: the peek wraps a TouchableOpacity
  // preview card + N TouchableOpacity action items, all of which grab the
  // start responder. Plain `onMoveShouldSetPanResponder` never fires once
  // a child owns the gesture. The Capture phase runs BEFORE children, so
  // the parent can yank the responder on a vertical drag (>4px down,
  // mostly vertical) without breaking taps on items.
  const dragResponder = React.useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      onMoveShouldSetPanResponder: (_, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
      onMoveShouldSetPanResponderCapture: (_, g) => g.dy > 4 && Math.abs(g.dy) > Math.abs(g.dx),
      onPanResponderMove: (_, g) => {
        if (g.dy < 0) return;
        panY.setValue(g.dy);
        const op = Math.max(0, 1 - (g.dy / (SH * 0.5)));
        backdrop.setValue(op);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dy > 110 || g.vy > 0.6) _commitDragClose(); else _snapBackDrag();
      },
      onPanResponderTerminate: () => _snapBackDrag(),
      onPanResponderTerminationRequest: () => false,
    })
  ).current;

  if (!conv) return null;

  const isPinned = !!conv.pinned;
  const isMuted = !!conv.muted;
  const isLocked = !!conv.locked;
  const isDirect = (conv.type || 'direct') === 'direct';
  const peerEmail = isDirect
    ? (conv.other_email || conv.contact_email || conv.email || '')
    : '';
  const hasUnread = (conv.unread_count || 0) > 0;
  const peerName = conv.display_name || conv.name || (peerEmail ? peerEmail.split('@')[0] : '');
  // Menu de bloquear/limpar fica feio com email completo ("anacarla.pereiraramos").
  // Pega so o primeiro nome — mesma logica do WhatsApp ("Bloquear Ana"). Cai
  // pro display name inteiro se nao tiver espaco/dot pra cortar.
  const firstName = (() => {
    const raw = String(peerName || '').trim();
    if (!raw) return '';
    const bySpace = raw.split(/\s+/)[0];
    if (bySpace && bySpace !== raw) return bySpace;
    const byDot = raw.split('.')[0];
    return byDot && byDot.length >= 2 ? byDot : raw;
  })();

  const cardBg = isDark ? '#1f2937' : '#ffffff';
  const text = isDark ? '#f9fafb' : '#0f172a';
  const subText = isDark ? '#9ca3af' : '#6b7280';
  const divider = isDark ? '#374151' : '#e5e7eb';
  const danger = '#ef4444';

  // Inline SVG renderers for icons we don't already have. Kept tiny —
  // only the strokes we need so they tree-shake cleanly.
  const Ic = {
    Bubble: (props) => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </Svg>
    ),
    Pin: (props) => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M12 17v5" />
        <Path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7" />
        <Path d="M6 11h12l-1.5 6h-9L6 11z" />
      </Svg>
    ),
    Bell: (props) => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <Path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </Svg>
    ),
    Lock: (props) => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Rect x={3} y={11} width={18} height={11} rx={2} />
        <Path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </Svg>
    ),
    Archive: (props) => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M21 8v13H3V8" />
        <Path d="M1 3h22v5H1z" />
        <Path d="M10 12h4" />
      </Svg>
    ),
    List: (props) => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M8 6h13M8 12h13M8 18h13" />
        <SvgCircle cx={3.5} cy={6} r={1.5} fill={props.color} />
        <SvgCircle cx={3.5} cy={12} r={1.5} fill={props.color} />
        <SvgCircle cx={3.5} cy={18} r={1.5} fill={props.color} />
      </Svg>
    ),
    Users: (props) => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <SvgCircle cx={9} cy={7} r={4} />
        <Path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </Svg>
    ),
    Ban: (props) => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <SvgCircle cx={12} cy={12} r={10} />
        <Path d="M4.93 4.93l14.14 14.14" />
      </Svg>
    ),
    XCircle: (props) => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <SvgCircle cx={12} cy={12} r={10} />
        <Path d="M15 9l-6 6M9 9l6 6" />
      </Svg>
    ),
    Trash: (props) => (
      <Svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M3 6h18" />
        <Path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
        <Path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
      </Svg>
    ),
  };

  const items = [
    { label: hasUnread ? (t('chat.markRead') || 'Marcar como lida') : (t('chat.markUnread') || 'Marcar como não lida'), icon: Ic.Bubble, color: text, onPress: () => actions.onMarkUnread?.(conv) },
    { label: isPinned ? (t('chat.unpin') || 'Desafixar') : (t('chat.pin') || 'Fixar'), icon: Ic.Pin, color: text, onPress: () => actions.onPin?.(conv) },
    ...(isPinned ? [{ label: t('chat.reorderPinned') || 'Reorganizar fixados', icon: Ic.List, color: text, onPress: () => actions.onReorderPinned?.() }] : []),
    { label: isMuted ? (t('chat.unmute') || 'Reativar som') : (t('chat.mute') || 'Silenciar'), icon: Ic.Bell, color: text, onPress: () => actions.onMute?.(conv) },
    { label: isLocked ? (t('chat.unlockChat') || 'Desbloquear chat') : (t('chat.lockChat') || 'Bloquear chat'), icon: Ic.Lock, color: text, onPress: () => actions.onLockToggle?.(conv) },
    { label: t('chat.archive') || 'Arquivar', icon: Ic.Archive, color: text, onPress: () => actions.onArchive?.(conv) },
    { label: t('chat.addToList') || 'Adicionar a lista', icon: Ic.List, color: text, onPress: () => actions.onAddToList?.(conv) },
    { label: t('chat.selectMore') || 'Selecionar várias', icon: Ic.Users, color: text, onPress: () => actions.onSelect?.(conv) },
    { divider: true },
    ...(peerEmail ? [{ label: `${t('chat.block') || 'Bloquear'} ${firstName}`.trim(), icon: Ic.Ban, color: danger, onPress: () => actions.onBlock?.(conv) }] : []),
    { label: t('chat.clearChat') || 'Limpar conversa', icon: Ic.XCircle, color: danger, onPress: () => actions.onClear?.(conv) },
    { label: t('chat.delete') || 'Excluir', icon: Ic.Trash, color: danger, onPress: () => actions.onDelete?.(conv) },
  ];

  const handleTap = (fn) => {
    onClose();
    setTimeout(() => fn?.(), 80);
  };

  // Tap on the preview opens the full conversation. Same nav signature
  // as a regular row tap: id, name, type, optional email param so the
  // chat-conversation screen can resolve direct DMs by handle.
  const openConv = () => {
    onClose();
    setTimeout(() => {
      try {
        const emailParam = peerEmail ? `&email=${encodeURIComponent(peerEmail)}` : '';
        router?.push(`/chat-conversation?id=${conv.id}&name=${encodeURIComponent(peerName)}&type=${conv.type || 'direct'}${emailParam}`);
      } catch {}
    }, 80);
  };

  return (
    <Modal visible={!!conv} transparent animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <View style={StyleSheet.absoluteFillObject}>
        <Animated.View style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.55)', opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={onClose} />
        </Animated.View>
        <Animated.View
          {...dragResponder.panHandlers}
          style={{
            position: 'absolute', left: 12, right: 12, bottom: Platform.OS === 'ios' ? 30 : 16,
            opacity: backdrop,
            transform: [{ translateY: Animated.add(slideY, panY) }, { scale }],
          }}
        >
          {/* ── Preview card (peek into the conversation) ── */}
          <ConversationPeekCard
            conv={conv}
            previewMsgs={previewMsgs}
            currentUserEmail={currentUserEmail}
            colors={colors}
            isDark={isDark}
            t={t}
            onOpen={openConv}
            loading={loading}
            typingUsers={typingUsers}
            presencesRef={presencesRef}
          />

          {/* ── Action menu ── */}
          <View style={{
            backgroundColor: cardBg,
            borderRadius: 14,
            marginTop: 10,
            overflow: 'hidden',
            ...Platform.select({
              ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 18 },
              android: { elevation: 12 },
              default: {},
            }),
          }}>
            {items.map((it, i) => {
              if (it.divider) {
                return <View key={`div-${i}`} style={{ height: 7, backgroundColor: isDark ? '#0f172a' : '#f3f4f6' }} />;
              }
              const Ico = it.icon;
              const isLast = i === items.length - 1;
              return (
                <TouchableOpacity
                  key={i}
                  onPress={() => handleTap(it.onPress)}
                  activeOpacity={0.7}
                  style={{
                    flexDirection: 'row', alignItems: 'center',
                    paddingHorizontal: 18, paddingVertical: 14,
                    borderBottomWidth: isLast ? 0 : StyleSheet.hairlineWidth,
                    borderBottomColor: divider,
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={it.label}
                >
                  <Text style={{ flex: 1, fontSize: 16, color: it.color, fontWeight: '500' }}>
                    {it.label}
                  </Text>
                  {Ico ? <Ico color={it.color} /> : null}
                </TouchableOpacity>
              );
            })}
          </View>
        </Animated.View>
      </View>
    </Modal>
  );
}

// ConversationPeekCard — static rendering of the last 5 messages so the
// long-press menu shows a WhatsApp-style preview of the thread above it.
// Tapping the card navigates into the full conversation. Falls back to
// a single bubble built from `last_message` if nothing is cached yet.
function ConversationPeekCard({ conv, previewMsgs, currentUserEmail, colors, isDark, t, onOpen, loading, typingUsers, presencesRef }) {
  const cardBg = isDark ? '#0b141a' : '#efeae2';
  const headerBg = isDark ? '#1f2c33' : '#7C3AED';
  const ownBubble = '#7C3AED';
  const peerBubble = isDark ? '#202c33' : '#ffffff';
  const ownText = '#ffffff';
  const peerText = isDark ? '#e9edef' : '#0f172a';
  const meta = isDark ? 'rgba(255,255,255,0.55)' : '#6b7280';
  const peerEmail = conv?.other_email || conv?.contact_email || conv?.email || '';
  const peerName = conv?.display_name || conv?.name || (peerEmail ? peerEmail.split('@')[0] : '');
  const lastSeen = conv?.last_seen_text || conv?.presence_text || '';
  const isGroup = (conv?.type || 'direct') === 'group';
  const isLocked = !!conv?.locked;

  // Fix 2 — derive online + typing state from the same WS sources the chat
  // list itself uses: presencesRef Map keyed by lowercase email + typingUsers
  // dict keyed by conv id. Direct chats only — group online dot would lie.
  const isPeerOnline = (() => {
    if (isGroup || !peerEmail) return false;
    try {
      const p = presencesRef?.current;
      if (p instanceof Map) {
        const v = p.get(peerEmail) || p.get(peerEmail.toLowerCase());
        return v?.status === 'online' || v === 'online';
      }
    } catch {}
    return !!conv?.online;
  })();
  const peerTyping = !!(typingUsers && conv?.id && typingUsers[conv.id]);

  // Fix 5 — emoji/paperclip/mic icons for the mock input bar.
  const SmileIc = (props) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <SvgCircle cx={12} cy={12} r={10} />
      <Path d="M8 14s1.5 2 4 2 4-2 4-2" />
      <Path d="M9 9h.01" />
      <Path d="M15 9h.01" />
    </Svg>
  );
  const PaperclipIc = (props) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
    </Svg>
  );
  const MicIc = (props) => (
    <Svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <Path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <Path d="M12 19v4M8 23h8" />
    </Svg>
  );

  // Reusable header JSX (used by lock-gated branch + normal branch).
  const headerJSX = (
    <View style={{
      flexDirection: 'row', alignItems: 'center', gap: 10,
      paddingHorizontal: 14, paddingVertical: 12,
      backgroundColor: headerBg,
    }}>
      <PeekAvatar email={peerEmail} name={peerName} size={36} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Text style={{ fontSize: 15, fontWeight: '700', color: '#fff', flexShrink: 1 }} numberOfLines={1}>
            {peerName}
          </Text>
          {/* Fix 2 — online dot for direct chats only */}
          {(!isGroup && isPeerOnline) ? (
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E' }} />
          ) : null}
        </View>
        {peerTyping ? (
          <Text style={{ fontSize: 11, color: '#fff', fontStyle: 'italic', fontWeight: '600' }} numberOfLines={1}>
            {t?.('chat.typing') || 'digitando...'}
          </Text>
        ) : (lastSeen ? (
          <Text style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)' }} numberOfLines={1}>
            {lastSeen}
          </Text>
        ) : null)}
      </View>
    </View>
  );

  // Fix 1 — privacy: locked chats must NEVER show bubbles or thumbnails
  // in the peek. The list row already hides the preview text/icon for
  // locked rows; the peek was leaking full content. Render a lock-only
  // state instead.
  if (isLocked) {
    return (
      <TouchableOpacity activeOpacity={0.95} onPress={onOpen} accessibilityRole="button" accessibilityLabel={peerName}>
        <View style={{
          height: 360,
          backgroundColor: cardBg,
          borderRadius: 14,
          overflow: 'hidden',
          ...Platform.select({
            ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 22 },
            android: { elevation: 16 },
            default: {},
          }),
        }}>
          {headerJSX}
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
            <IconLock size={36} color={isDark ? 'rgba(255,255,255,0.55)' : '#6b7280'} />
            <Text style={{ fontSize: 14, color: isDark ? 'rgba(255,255,255,0.7)' : '#6b7280', fontWeight: '500' }}>
              {t?.('chat.lockedPreview') || 'Conversa bloqueada'}
            </Text>
          </View>
        </View>
      </TouchableOpacity>
    );
  }

  // Build display rows. If we have cached/fetched, use them. Otherwise
  // synthesize a single bubble from the conversation's last_message
  // snippet — and carry over `last_message_at` so the time still renders.
  // `last_message` arrives as an OBJECT in the conversations payload
  // (with .content, .sender_email, .type, .read_at, etc.) — rendering
  // the object directly produced "[object Object]" in the bubble.
  const lm = conv?.last_message;
  const lmIsObj = lm && typeof lm === 'object';
  const lmText = lmIsObj
    ? (typeof lm.content === 'string' ? lm.content : '')
    : (typeof lm === 'string' ? lm : '');
  let rows = (previewMsgs && previewMsgs.length)
    ? previewMsgs.slice(-8)
    : (lmText ? [{
        id: lmIsObj ? (lm.id || 'fallback') : 'fallback',
        sender_email: (lmIsObj && lm.sender_email) || conv?.last_message_sender_email || peerEmail || '',
        content: lmText,
        created_at: (lmIsObj && lm.created_at) || conv?.last_message_at || conv?.last_active_at || '',
        type: (lmIsObj && lm.type) || 'text',
        delivered_at: lmIsObj ? lm.delivered_at : null,
        read_at: lmIsObj ? lm.read_at : null,
        thumb_b64: lmIsObj ? lm.thumb_b64 : null,
        file_url: lmIsObj ? lm.file_url : null,
      }] : []);
  // Drop system/separator rows. Keep call_card so the peek mirrors the
  // real thread (calls show as "📞 Chamada"), but discard transient
  // signaling payloads where content is JSON without a real type set —
  // those are leaked WS frames, not user messages.
  rows = rows.filter(m => {
    if (!m || m.type === 'system' || m.type === 'separator') return false;
    const c = String(m.content || '');
    if (c.startsWith('{') && (!m.type || m.type === 'text')) {
      try {
        const p = JSON.parse(c);
        if (p && (p.room_id || p.call_id) && p.caller_email) return false;
      } catch {}
    }
    return true;
  }).slice(-5);

  // HH:mm formatter local to the peek — keeps the bubble clock format
  // tight (12:34) without re-running the chat list helper that adds day
  // labels we don't want inside a single-thread preview.
  const fmtClock = (iso) => {
    if (!iso) return '';
    try {
      const d = new Date(String(iso).replace(' ', 'T'));
      if (isNaN(d.getTime())) return '';
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  };

  // Fix 4 — restore correct WhatsApp/Telegram tick semantics: read = brand
  // blue (high contrast vs purple bubble), delivered = white, sent = dimmed
  // white. Was inverted before (read white, delivered also white-ish), so
  // users couldn't distinguish read from delivered.
  const StatusTicks = ({ msg }) => {
    if (!msg) return null;
    const isRead = !!msg.read_at;
    const isDelivered = !!msg.delivered_at;
    const color = isRead ? '#60A5FA'
                : isDelivered ? '#ffffff'
                : 'rgba(255,255,255,0.7)';
    if (!isDelivered && !isRead) {
      return <IconCheck size={12} color={color} />;
    }
    return (
      <View style={{ flexDirection: 'row' }}>
        <IconCheck size={12} color={color} style={{ marginRight: -6 }} />
        <IconCheck size={12} color={color} />
      </View>
    );
  };

  // Fix 3 — pulsing skeleton bubble for the cold-cache loading window.
  // Animated.loop with native driver so it costs ~nothing on the JS thread.
  const SkeletonBubble = ({ side, widthPct }) => {
    const opacity = React.useRef(new Animated.Value(0.5)).current;
    React.useEffect(() => {
      const loop = Animated.loop(Animated.sequence([
        Animated.timing(opacity, { toValue: 1.0, duration: 500, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.5, duration: 500, useNativeDriver: true }),
      ]));
      loop.start();
      return () => loop.stop();
    }, [opacity]);
    const isOwn = side === 'right';
    const bg = isOwn ? ownBubble : peerBubble;
    return (
      <Animated.View style={{
        opacity,
        alignSelf: isOwn ? 'flex-end' : 'flex-start',
        width: `${widthPct}%`,
        height: 32,
        backgroundColor: bg,
        borderRadius: 12,
        marginVertical: 2,
        ...(isDark ? {} : (isOwn ? {} : { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.05)' })),
      }} />
    );
  };

  // Peek height adapta ao numero de mensagens — antes era fixo 360px e ficava
  // vazio com poucas msgs. Agora: 200/280/360 conforme densidade. User report:
  // "peek n ta mostrando as conversas todos" — visual feel era de "card vazio".
  const peekHeight = rows.length <= 1 ? 200
                    : rows.length <= 3 ? 280
                    : 360;
  return (
    <TouchableOpacity activeOpacity={0.95} onPress={onOpen} accessibilityRole="button" accessibilityLabel={peerName}>
      <View style={{
        height: peekHeight,
        backgroundColor: cardBg,
        borderRadius: 14,
        overflow: 'hidden',
        ...Platform.select({
          ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 8 }, shadowOpacity: 0.3, shadowRadius: 22 },
          android: { elevation: 16 },
          default: {},
        }),
      }}>
        {/* Header */}
        {headerJSX}

        {/* Messages — scroll disabled (peek is static) */}
        <View style={{ flex: 1, paddingHorizontal: 10, paddingVertical: 8, justifyContent: 'flex-end' }}>
          {rows.length === 0 && loading ? (
            <View style={{ gap: 8, paddingBottom: 4 }}>
              <SkeletonBubble side="left" widthPct={60} />
              <SkeletonBubble side="right" widthPct={45} />
              <SkeletonBubble side="left" widthPct={70} />
            </View>
          ) : rows.length === 0 ? (
            <View style={{ alignItems: 'center', justifyContent: 'center', paddingVertical: 30 }}>
              <Text style={{ fontSize: 13, color: meta }}>
                {t?.('chat.noMessagesYet') || 'Sem mensagens ainda'}
              </Text>
            </View>
          ) : (
            rows.map((m, idx) => {
              const isOwn = (m.sender_email || '').toLowerCase() === (currentUserEmail || '').toLowerCase();
              const bubbleBg = isOwn ? ownBubble : peerBubble;
              const txtCol = isOwn ? ownText : peerText;
              const subTxt = isOwn ? 'rgba(255,255,255,0.75)' : meta;
              const replyAccent = isOwn ? 'rgba(255,255,255,0.7)' : '#7C3AED';
              // Mirror the list-row formatter: strip markdown pairs, decode
              // JSON-encoded payloads (call_card / location / contact /
              // attachment), short-circuit known typed messages, and finally
              // catch raw tenor/giphy links as GIFs. Without this the peek
              // was rendering raw call_invite JSON ({"call_id":"..."}) as
              // a plain text bubble.
              // Defensive: cache rows can carry objects in `content` if a
              // bad payload slipped past the validator — coerce to string
              // safely so the bubble never reads "[object Object]".
              let body = (typeof m.content === 'string' ? m.content : '').slice(0, 200);
              body = body
                .replace(/```([\s\S]*?)```/g, '$1')
                .replace(/\|\|([^|]+)\|\|/g, '$1')
                .replace(/\*\*([^*]+)\*\*/g, '$1')
                .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1$2')
                .replace(/_([^_\n]+)_/g, '$1')
                .replace(/~([^~\n]+)~/g, '$1')
                .replace(/`([^`\n]+)`/g, '$1');
              if (body.startsWith('{')) {
                try {
                  const parsed = JSON.parse(body);
                  const isCall = m.type === 'call_card' || parsed.call_id || parsed.call_type !== undefined || parsed.caller_email;
                  if (isCall) {
                    const isVideo = parsed.call_type === 'video' || parsed.video === true;
                    const st = parsed.status || '';
                    if (st === 'missed' || st === 'declined' || st === 'rejected' || st === 'no_answer') {
                      body = '📞 ' + (t?.('chat.callMissed') || 'Chamada perdida');
                    } else if (isVideo) {
                      body = '📹 ' + (t?.('chat.videoCall') || 'Chamada de vídeo');
                    } else {
                      body = '📞 ' + (t?.('chat.voiceCall') || 'Chamada de voz');
                    }
                  } else if (parsed.type === 'location') body = '📍 ' + (t?.('chat.location') || 'Localização');
                  else if (parsed.type === 'contact') body = '👤 ' + (t?.('chat.contact') || 'Contato');
                  else body = '📎 ' + (t?.('chat.attachment') || 'Anexo');
                } catch {}
              }
              if (m.type === 'call_card' && !/Chamada/.test(body)) {
                body = '📞 ' + (t?.('chat.voiceCall') || 'Chamada');
              }

              // Resolve image/video/sticker/gif thumbnails so the peek
              // shows the actual photo (WhatsApp-style) instead of a
              // generic "📷 Foto" text label. Priority: thumb_b64 (instant
              // base64 LQIP) → image_variants.thumb → file_url. Tenor/Giphy
              // GIFs already arrive as direct URLs in `content`.
              let thumbUri = null;
              const _absolutize = (u) => !u ? null : (u.startsWith('http') || u.startsWith('data:') ? u : `https://chatyy.com.br${u.startsWith('/') ? '' : '/'}${u}`);
              if (m.type === 'image' || m.type === 'video' || m.type === 'sticker' || m.type === 'gif') {
                if (m.thumb_b64) {
                  thumbUri = `data:image/jpeg;base64,${m.thumb_b64}`;
                } else if (m.image_variants) {
                  try {
                    const v = typeof m.image_variants === 'string' ? JSON.parse(m.image_variants) : m.image_variants;
                    thumbUri = _absolutize(v?.thumb || v?.small || v?.medium);
                  } catch {}
                }
                if (!thumbUri) thumbUri = _absolutize(m.file_url || m._localUri);
                // Tenor/Giphy GIFs land in `content` as a raw URL.
                if (!thumbUri && m.type === 'gif' && typeof m.content === 'string' && /^https?:\/\//.test(m.content)) {
                  thumbUri = m.content.trim();
                }
              }

              if (m.type === 'image') body = '📷 ' + (t?.('chat.photo') || 'Foto');
              else if (m.type === 'video' && !body.startsWith('🎥')) body = '🎬 ' + (t?.('chat.video') || 'Vídeo');
              else if ((m.type === 'audio' || m.type === 'voice') && !body.startsWith('📞')) body = '🎙 ' + (t?.('chat.audio') || 'Áudio');
              else if (m.type === 'sticker') body = '💫 ' + (t?.('chat.sticker') || 'Sticker');
              else if (m.type === 'gif') body = '🎬 GIF';
              else if (m.type === 'file') body = '📎 ' + (m.file_name || t?.('chat.file') || 'Arquivo');
              else if (m.type === 'poll') body = '📊 ' + (t?.('chat.poll') || 'Enquete');
              else if (m.type === 'location') body = '📍 ' + (t?.('chat.location') || 'Localização');
              else if (m.type === 'contact') body = '👤 ' + (t?.('chat.contact') || 'Contato');
              else if (typeof body === 'string' && /^https?:\/\/(media[0-9]*\.)?(tenor|giphy)\.com\//i.test(body.trim())) {
                body = '🎬 GIF';
                if (!thumbUri) thumbUri = body.trim();
              }

              const senderLabel = (!isOwn && isGroup)
                ? (m.sender_name || (m.sender_email ? m.sender_email.split('@')[0] : ''))
                : '';
              const replyText = m.reply_to_content || m.reply_to_text || (m.reply_to && m.reply_to.content) || '';
              const replyAuthor = m.reply_to_sender_name
                || (m.reply_to_sender_email ? m.reply_to_sender_email.split('@')[0] : '')
                || (m.reply_to && (m.reply_to.sender_name || m.reply_to.sender_email)) || '';
              const time = fmtClock(m.created_at);

              const hasThumb = !!thumbUri;
              return (
                <View key={m.id || idx} style={{
                  alignSelf: isOwn ? 'flex-end' : 'flex-start',
                  maxWidth: '82%',
                  backgroundColor: bubbleBg,
                  borderRadius: 12,
                  paddingHorizontal: hasThumb ? 4 : 10,
                  paddingTop: hasThumb ? 4 : 5,
                  paddingBottom: 4,
                  marginVertical: 2,
                  ...(isDark ? {} : (isOwn ? {} : { borderWidth: StyleSheet.hairlineWidth, borderColor: 'rgba(0,0,0,0.05)' })),
                }}>
                  {senderLabel ? (
                    <Text style={{ fontSize: 11, fontWeight: '700', color: '#7C3AED', marginBottom: 1, paddingHorizontal: hasThumb ? 6 : 0 }} numberOfLines={1}>
                      {senderLabel}
                    </Text>
                  ) : null}
                  {hasThumb ? (
                    <View style={{
                      width: 160, height: 120, borderRadius: 8, overflow: 'hidden',
                      backgroundColor: isDark ? 'rgba(0,0,0,0.25)' : 'rgba(0,0,0,0.08)',
                      marginBottom: 3,
                    }}>
                      <Image source={{ uri: thumbUri }} style={{ width: '100%', height: '100%' }} resizeMode="cover" />
                      {(m.type === 'video') && (
                        <View style={{
                          position: 'absolute', left: 0, right: 0, top: 0, bottom: 0,
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          <View style={{
                            width: 36, height: 36, borderRadius: 18,
                            backgroundColor: 'rgba(0,0,0,0.55)',
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Svg width={16} height={16} viewBox="0 0 24 24" fill="#fff">
                              <Path d="M8 5v14l11-7z" />
                            </Svg>
                          </View>
                        </View>
                      )}
                    </View>
                  ) : null}
                  {replyText ? (
                    <View style={{
                      borderLeftWidth: 3, borderLeftColor: replyAccent,
                      backgroundColor: isOwn ? 'rgba(255,255,255,0.15)' : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(124,58,237,0.06)'),
                      paddingHorizontal: 6, paddingVertical: 3,
                      borderRadius: 4, marginBottom: 3,
                    }}>
                      {replyAuthor ? (
                        <Text style={{ fontSize: 10, fontWeight: '700', color: replyAccent }} numberOfLines={1}>
                          {replyAuthor}
                        </Text>
                      ) : null}
                      <Text style={{ fontSize: 11, color: subTxt }} numberOfLines={1}>
                        {String(replyText).slice(0, 80)}
                      </Text>
                    </View>
                  ) : null}
                  <Text style={{ fontSize: 14, color: txtCol, lineHeight: 19 }} numberOfLines={3}>
                    {body || '—'}
                  </Text>
                  {(time || isOwn) ? (
                    <View style={{ flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-end', gap: 4, marginTop: 1 }}>
                      {time ? (
                        <Text style={{ fontSize: 10, color: subTxt }}>{time}</Text>
                      ) : null}
                      {isOwn ? <StatusTicks msg={m} /> : null}
                    </View>
                  ) : null}
                </View>
              );
            })
          )}
        </View>

        {/* Fix 5 — mock input bar styled like the real chat input. Tapping
            still opens the conversation; we trade the explicit "tap to open"
            label for visual continuity (smile + Mensagem placeholder + clip
            + mic). */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          paddingHorizontal: 12, paddingVertical: 10,
          backgroundColor: isDark ? '#0a1014' : '#f0f2f5',
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
        }}>
          <View style={{
            flex: 1, height: 32, borderRadius: 16,
            backgroundColor: isDark ? '#1f2c33' : '#fff',
            flexDirection: 'row', alignItems: 'center',
            paddingHorizontal: 10, gap: 8,
          }}>
            <SmileIc color={meta} />
            <Text style={{ flex: 1, fontSize: 13, color: meta }}>
              {t?.('chat.message') || 'Mensagem'}
            </Text>
            <PaperclipIc color={meta} />
          </View>
          <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: ownBubble, alignItems: 'center', justifyContent: 'center' }}>
            <MicIc color="#fff" />
          </View>
        </View>
      </View>
    </TouchableOpacity>
  );
}

function PeekAvatar({ email, name, size }) {
  const initial = (name || email || '?').trim().charAt(0).toUpperCase();
  return (
    <View style={{
      width: size, height: size, borderRadius: size / 2,
      backgroundColor: 'rgba(255,255,255,0.18)',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <Text style={{ color: '#fff', fontSize: size * 0.42, fontWeight: '700' }}>{initial}</Text>
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
  // Why: search bar height 36→38 + radius 20→19 reads more like a real
  // input pill (matches input fields elsewhere in the app); web focus-within
  // glow makes typing feel responsive even before the first keystroke.
  searchBar: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 19,
    paddingHorizontal: 14,
    height: 38,
    gap: 8,
    borderWidth: 0,
    ...(Platform.OS === 'web' ? { transition: 'background-color 200ms ease, box-shadow 200ms ease' } : {}),
  },
  searchCancelBtn: {
    paddingVertical: 8,
    paddingHorizontal: 4,
    ...(Platform.OS === 'web' ? { cursor: 'pointer' } : {}),
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    padding: 0,
    letterSpacing: -0.05,
    fontWeight: '500',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  // Clear button (×) — bumped padding hit area + web hover so it reads as a
  // real tap target, not a decoration. Background tint added on hover.
  searchClearBtn: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 160ms ease, transform 160ms ease' } : {}),
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
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 2 },
      android: { elevation: 1 },
      web: { boxShadow: '0 1px 2px rgba(0,0,0,0.1)' },
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
