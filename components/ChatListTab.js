import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, ScrollView, Modal,
  ActivityIndicator, RefreshControl, TextInput, Alert, ActionSheetIOS,
  Animated, PanResponder, Platform, LayoutAnimation, UIManager, Image,
  KeyboardAvoidingView, Pressable, Dimensions, AppState,
} from 'react-native';
// FlatList only (FlashList crashes iOS)
const ListComponent = FlatList;
import { useRouter, useFocusEffect } from 'expo-router';
import * as api from '../services/api';
import { useConfirm } from './ConfirmModal';
import { emailToDisplayName, BASE_URL } from '../services/api';
import { cacheConversations, getCachedConversations, prewarmConversationsCache, prefetchConversation } from '../services/chatCache';
import { prefetchAvatarsForList } from '../services/avatarCache';
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
import AvatarLightbox from './AvatarLightbox';
import ChatyyOneAvatar from './ChatyyOneAvatar';
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
import StoryViewer from './status/StoryViewer';
import LiveBar from './LiveBar';
import { useLanguage } from '../context/LanguageContext';

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

// WhatsApp parity — only 3 conversations may sit at the very top of the
// list at once. Pinning a 4th silently displaces the oldest pin (the one
// with the earliest pinned_at, falling back to last activity).
const MAX_PINNED_CHATS = 3;

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
function formatChatTime(dateStr, t, locale) {
  if (!dateStr) return '';
  const now = new Date();
  const date = new Date(normalizeISO(dateStr));
  if (isNaN(date.getTime())) return '';
  const diffMs = now - date;
  const diffMin = Math.floor(diffMs / 60000);
  const diffDays = Math.floor(diffMs / 86400000);
  const loc = locale || undefined;
  if (diffMin < 1) return t?.('time.now') || 'agora';
  if (diffMin < 60) return `${diffMin}m`;
  if (diffDays === 0) return date.toLocaleTimeString(loc, { hour: '2-digit', minute: '2-digit' });
  if (diffDays === 1) return t?.('time.yesterday') || 'Ontem';
  if (diffDays < 7) return date.toLocaleDateString(loc, { weekday: 'short' });
  return date.toLocaleDateString(loc, { day: '2-digit', month: '2-digit', year: '2-digit' });
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

// Tiny clock icon for scheduled-message indicator in preview
function IconClockMini({ size = 12, color = '#666' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <SvgCircle cx="12" cy="12" r="10" />
      <Path d="M12 6v6l4 2" />
    </Svg>
  );
}

// ── Skeleton loader for conversation rows ──
// 2026-05-13 crash hotfix: align driver with FeedSkeleton (useNativeDriver:true).
// Animated.Value(`opacity`) was running JS-driven here while the sibling
// FeedSkeleton in ChatFeedTab ran native. When the home page mounted both
// tabs cold (Conversas + Feed pre-rendered) some render paths reused the
// same animated node identity (memoized through React's Animated bridge),
// surfacing as "JS driven animation on animated node that has been moved
// to native earlier". Opacity is native-compatible, so true is the right
// driver — and unblocks the JS thread on cold start.
function SkeletonRow({ isDark, index }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(index * 80),
        Animated.timing(opacity, { toValue: 0.7, duration: 800, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.3, duration: 800, useNativeDriver: true }),
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
    // 2026-05-13 crash hotfix: opacity + transform.scale are both native-
    // compatible props, so flipping to useNativeDriver:true here removes any
    // chance of cross-driver leakage when these dot Values get re-used across
    // typing-state churn on chat-list rows. Also keeps the typing indicator
    // off the JS thread under heavy scroll.
    const animate = (d, delay) => Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.parallel([
          Animated.timing(d.opacity, { toValue: 1, duration: 280, useNativeDriver: true }),
          Animated.spring(d.scale, { toValue: 1.15, tension: 200, friction: 6, useNativeDriver: true }),
        ]),
        Animated.parallel([
          Animated.timing(d.opacity, { toValue: 0.3, duration: 280, useNativeDriver: true }),
          Animated.spring(d.scale, { toValue: 0.7, tension: 200, friction: 8, useNativeDriver: true }),
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
        Animated.timing(pulse, { toValue: 1, duration: 1600, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, []);
  const haloScale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] });
  const haloOpacity = pulse.interpolate({ inputRange: [0, 0.4, 1], outputRange: [0.6, 0.28, 0] });
  const innerScale = pulse.interpolate({ inputRange: [0, 0.5, 1], outputRange: [1, 1.08, 1] });
  return (
    <Animated.View style={[s.onlineDot, {
      borderColor: isDark ? '#0B141A' : colors.background,
      transform: [{ scale: innerScale }],
      ...(Platform.OS === 'web'
        ? { boxShadow: '0 0 8px rgba(34,197,94,0.7), 0 0 14px rgba(34,197,94,0.4)' }
        : {
            shadowColor: '#22c55e',
            shadowOffset: { width: 0, height: 0 },
            shadowOpacity: 0.85,
            shadowRadius: 5,
            elevation: 4,
          }),
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
    </Animated.View>
  );
}

// ── Group avatar (WhatsApp-style: single circle, no stack) ──
// 2026-05-09: user reclamou que o "+1" das fotos empilhadas parecia
// notificação. WhatsApp usa só um círculo único (foto do grupo OU iniciais
// do nome). Removido o stack + pill "+N" pra ficar limpo.
function GroupAvatarStack({ conversation, size = 56, isDark }) {
  const groupPhoto = conversation.avatar_url || conversation.avatar || '';
  const name = conversation.display_name || conversation.name || '?';
  // When the group has no uploaded photo, fall back to a 2-4 tile collage
  // built from the members list (WhatsApp parity). Only fires when there's
  // no explicit group avatar — once the admin uploads one, the single
  // image takes over again. Falsy-filtered to skip stub entries with no
  // identifying data.
  const collageMembers = !groupPhoto
    ? (conversation.members || [])
        .filter(m => m && (m.email || m.display_name || m.name))
        .slice(0, 4)
    : null;
  return (
    <AvatarCircle
      name={name}
      email={null}
      size={size}
      uri={groupPhoto || undefined}
      members={collageMembers && collageMembers.length >= 2 ? collageMembers : undefined}
    />
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
  currentEmail, t, language, isOnline: isOnlineProp, isDark, isLocked, typingUsers,
  selectionMode, isSelected, onLongPress, onToggleSelect, draftText, draftEditedAt, noteText, lastSeen,
  // WAVE 95 (2026-05-21): tap-on-avatar opens fullscreen lightbox while the
  // rest of the row still opens the conversation. Without this prop the
  // avatar stays a non-tappable visual element (legacy behavior).
  onAvatarPress,
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

  // typingUsers[convId] may be a string (legacy 1:1) or an array (group, one
  // entry per active typer). Normalize to an array for rendering, then derive
  // a single display string ("Ana", "Ana, João", "Ana e mais 2").
  const _typingRaw = typingUsers?.[conversation.id];
  const typingNames = Array.isArray(_typingRaw) ? _typingRaw : (_typingRaw ? [_typingRaw] : []);
  const typingName = typingNames.length
    ? (typingNames.length <= 2
        ? typingNames.join(', ')
        : `${typingNames.slice(0, 2).join(', ')} +${typingNames.length - 2}`)
    : null;

  let preview = '';
  let previewSender = null;
  let statusType = null;
  // Scheduled-message indicator: surface a tiny clock prefix on the row when
  // there's a pending scheduled outgoing message. Backend may attach this on
  // the conversation row directly or on lastMsg under a few different keys —
  // we accept any of them so we stay resilient to the shape that ships.
  const hasScheduled = !!(
    conversation.scheduled_at ||
    conversation.has_scheduled ||
    conversation.scheduled_message ||
    (lastMsg && (lastMsg.scheduled_at || lastMsg.is_scheduled))
  );
  if (typingName) {
    preview = '';
  } else if (lastMsg) {
    if (lastMsg.sender_email === currentEmail) {
      if (lastMsg.read_at) statusType = 'read';
      else if (lastMsg.delivered_at) statusType = 'delivered';
      else statusType = 'sent';
    }

    let content = typeof lastMsg.content === 'string' ? lastMsg.content : (lastMsg.content ? JSON.stringify(lastMsg.content) : '');
    // Caption captured separately so media-type labels can surface real text
    // ("📷 sunset at the beach" instead of "📷 Foto").
    let caption = typeof lastMsg.caption === 'string' && lastMsg.caption.trim() ? lastMsg.caption.trim() : '';
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
        // Location msgs carry the type only on lastMsg.type (DB column) —
        // the JSON payload is `{latitude, longitude, live, ...}` with NO
        // `type` field. Old `parsed.type==='location'` missed and the raw
        // JSON leaked into chat list preview (reported 2026-05-12 iOS print).
        else if (lastMsg.type === 'location' || parsed.type === 'location' || (typeof parsed.latitude === 'number' && typeof parsed.longitude === 'number')) {
          content = '\uD83D\uDCCD ' + (parsed.live ? (t('chat.liveLocation') || 'Localização ao vivo') : (t('chat.location') || 'Localização'));
        }
        else if (parsed.type === 'contact' || lastMsg.type === 'contact') content = '\uD83D\uDC64 ' + (t('chat.contact') || 'Contato');
        else if (parsed.file_url || parsed.attachment_url || parsed.media_url || (parsed.url && parsed.mime_type)) {
          content = '\uD83D\uDCCE ' + (t('chat.attachment') || 'Anexo');
        }
        else if (typeof parsed.text === 'string') content = parsed.text;
        else if (typeof parsed.body === 'string') content = parsed.body;
        else if (typeof parsed.caption === 'string') content = parsed.caption;
        if (!caption && typeof parsed.caption === 'string' && parsed.caption.trim()) {
          caption = parsed.caption.trim();
        }
      } catch {
        // Silent-fail audit: when content "looked like JSON" (started with
        // `{` and ended with `}`) but failed to parse, the raw JSON-ish
        // string leaked into the preview row as-is — user sees `{"foo":...`
        // garbage instead of a clean message preview. Bug class flagged in
        // memory ("JSON leaked into chat list preview 2026-05-12"). Fall
        // back to a generic media/text label so the row at least reads.
        const looksLikeMedia = /file_url|attachment|media|http/i.test(content);
        content = looksLikeMedia
          ? ('📎 ' + (t('chat.attachment') || 'Anexo'))
          : (t('chat.message') || 'Mensagem');
      }
    }
    if (lastMsg.type === 'call_card' && !/Chamada/.test(content)) {
      content = '\uD83D\uDCDE ' + (t('chat.voiceCall') || 'Chamada');
    }
    if (lastMsg.type === 'image') content = '\uD83D\uDCF7 ' + (caption || t('chat.photo') || 'Foto');
    else if (lastMsg.type === 'gif') content = '\uD83C\uDFAC ' + (caption || 'GIF');
    else if (lastMsg.type === 'sticker') content = '\uD83D\uDCAB ' + (caption || t('chat.sticker') || 'Sticker');
    else if (lastMsg.type === 'video' && !content.startsWith('\uD83C\uDFA5')) content = '\uD83C\uDFA5 ' + (caption || t('chat.video') || 'Video');
    else if (lastMsg.type === 'audio' && !content.startsWith('\uD83D\uDCDE')) content = '\uD83C\uDFB5 ' + (caption || t('chat.audio') || 'Audio');
    else if (lastMsg.type === 'file') content = '\uD83D\uDCCE ' + (lastMsg.file_name || caption || t('chat.file') || 'Arquivo');
    else if (lastMsg.type === 'poll') content = '\uD83D\uDCCA ' + (caption || t('chat.poll') || 'Enquete');
    else if (lastMsg.type === 'playlist') content = '\uD83C\uDFB5 ' + (caption || t('chatConv.playlist') || 'Playlist');
    else if (lastMsg.type === 'meetup') content = '\uD83D\uDCC5 ' + (caption || t('chatConv.meetup') || 'Encontro');
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

  // ── Mute icon fade (true→false transition fades out 200ms instead of popping) ──
  // muteVisible keeps the icon mounted during the fade-out animation so layout
  // doesn't snap shut before the opacity finishes. Unmounted when fully hidden
  // so the row's flex gap doesn't keep an empty 14px slot for unmuted chats.
  const muteOpacity = useRef(new Animated.Value(isMuted ? 1 : 0)).current;
  const prevMutedRef = useRef(isMuted);
  const [muteVisible, setMuteVisible] = useState(isMuted);
  useEffect(() => {
    if (prevMutedRef.current !== isMuted) {
      if (isMuted) {
        setMuteVisible(true);
        Animated.timing(muteOpacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
      } else {
        Animated.timing(muteOpacity, { toValue: 0, duration: 200, useNativeDriver: true })
          .start(({ finished }) => { if (finished) setMuteVisible(false); });
      }
      prevMutedRef.current = isMuted;
    }
  }, [isMuted]);

  // ── Mention badge pop (when unread_mentions count increases) ──
  const mentionScale = useRef(new Animated.Value(1)).current;
  const prevMentionsRef = useRef(conversation.unread_mentions || 0);
  useEffect(() => {
    const cur = conversation.unread_mentions || 0;
    const prev = prevMentionsRef.current;
    if (cur > prev) {
      mentionScale.setValue(0.8);
      Animated.sequence([
        Animated.spring(mentionScale, { toValue: 1.2, tension: 220, friction: 6, useNativeDriver: true }),
        Animated.spring(mentionScale, { toValue: 1, tension: 180, friction: 8, useNativeDriver: true }),
      ]).start();
    }
    prevMentionsRef.current = cur;
  }, [conversation.unread_mentions]);

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

  // ── Status checkmarks (WhatsApp parity: blue on read, gray on delivered/sent) ──
  // [2026-05-21] User explicit request: "quando ver fica azul" — matches
  // the thread's own AnimatedCheckStatus (#53BDEB). Was Chatyy brand purple
  // (#7C3AED) but the user expects WhatsApp blue.
  const renderStatusIcon = () => {
    if (!statusType) return null;
    if (statusType === 'read') {
      return (
        <View style={{ flexDirection: 'row', marginRight: 3 }}>
          <IconCheck size={15} strokeWidth={2.6} color="#53BDEB" style={{ marginRight: -8 }} />
          <IconCheck size={15} strokeWidth={2.6} color="#53BDEB" />
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

  // Row background. Priority: hover (transient) > unread (faint brand tint, the
  // iMessage/WhatsApp "this row wants attention" cue) > pinned (very faint) >
  // base. The unread tint is intentionally lighter than the press-state so a
  // hover/press still reads as a distinct layer on top of it.
  const rowBg = hovered
    ? (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.025)')
    : (unread && !isMuted)
      ? (isDark ? 'rgba(124,58,237,0.07)' : 'rgba(124,58,237,0.045)')
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
            if (selectionMode) { onToggleSelect?.(conversation); return; }
            if (swipeOpen.current) { resetSwipe(); return; }
            onPress?.(conversation);
          }}
          onPressIn={() => {
            // Touch-down prefetch — start the network request before the
            // tap is even recognized. The 80-150ms between finger-down and
            // onPress gets folded into the conversation-open latency.
            if (selectionMode || swipeOpen.current) return;
            try { onPressIn?.(conversation); } catch {}
          }}
          onLongPress={() => {
            if (!selectionMode) onLongPress?.(conversation);
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
              if (!selectionMode) onLongPress?.(conversation);
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
              <View style={[
                // Unread direct chats get a soft brand-purple gradient halo so
                // the avatar visually "lifts" — the iMessage/Instagram cue that
                // there's something new here. Muted chats skip it (the count
                // pill already de-emphasizes to grey). Web uses a real conic-ish
                // glow; native falls back to a colored shadow that reads as a ring.
                (unread && !isMuted) && (isWeb
                  ? { borderRadius: 28, boxShadow: `0 0 0 2px rgba(124,58,237,0.55), 0 2px 10px rgba(124,58,237,0.3)` }
                  : {
                      borderRadius: 28,
                      shadowColor: '#7C3AED',
                      shadowOffset: { width: 0, height: 0 },
                      shadowOpacity: 0.55,
                      shadowRadius: 5,
                      elevation: 4,
                    }),
                isWeb && isDark && !((unread && !isMuted)) ? {
                  borderRadius: 28,
                  boxShadow: isOnline
                    ? `0 0 12px rgba(34,197,94,0.3), 0 2px 8px rgba(0,0,0,0.2)`
                    : `0 2px 8px rgba(0,0,0,0.2)`,
                } : null,
              ]}>
                <AvatarCircle
                  name={displayName}
                  email={otherEmail}
                  size={50}
                  // WAVE 95: tap-avatar → fullscreen lightbox (only for direct
                  // chats; group/channel avatars don't have a single photo to
                  // enlarge — the row tap still opens the conversation).
                  // Disabled in selection mode so multi-select gestures still
                  // work without ambiguity.
                  onPress={selectionMode ? undefined : (onAvatarPress ? () => onAvatarPress({ name: displayName, email: otherEmail }) : undefined)}
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
                {/* Member count badge removido — confundia com unread badge.
                    Tipo de conv (grupo/canal) já fica claro pelo avatar e
                    estilo do row. Member count fica visível dentro do
                    chat-conversation header onde é contexto correto. */}
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
                  {lastMsg ? formatChatTime(lastMsg.created_at, t, language) : ''}
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
              ) : !typingName && draftText ? (() => {
                // audit gap #2 — fade red → grey based on draft age. Fresh
                // (<1h) gets the urgent red treatment users already know
                // from WhatsApp; older keeps the "draft" semantics but in
                // muted text + a "há Xh" hint so it doesn't keep shouting
                // for attention forever.
                const ageMs = draftEditedAt ? (Date.now() - draftEditedAt) : null;
                const isFresh = ageMs !== null && ageMs < 3600000; // 1h
                const ageLabel = (() => {
                  if (ageMs === null || ageMs < 3600000) return null;
                  const hours = Math.floor(ageMs / 3600000);
                  // Use locale-aware "hAgo" prefix (pt-BR "há", es "hace",
                  // en="") and the "ago" suffix (en "ago", pt-BR/es "atrás").
                  // Builds the form  "<prefix> Xh <suffix>" trimmed — pt-BR
                  // "há 2h", es "hace 2h", en "2h ago". Without this fix the
                  // chat list shipped a hardcoded "há" to every locale.
                  const pre = (t && t('time.hAgo')) || '';
                  const suf = (t && t('time.ago')) || '';
                  if (hours < 24) {
                    const unit = `${hours}h`;
                    return [pre, unit, pre ? '' : suf].filter(Boolean).join(' ').trim();
                  }
                  const days = Math.floor(hours / 24);
                  const unit = `${days}d`;
                  return [pre, unit, pre ? '' : suf].filter(Boolean).join(' ').trim();
                })();
                const muted = isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)';
                const tint = isFresh ? '#dc2626' : muted;
                const bg = isFresh
                  ? 'rgba(220,38,38,0.08)'
                  : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)');
                return (
                  <View style={{ flex: 1, marginRight: 10 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: bg, borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1 }}>
                      <Text style={[s.rowPreview, { color: tint, fontWeight: '500', flex: 1 }]} numberOfLines={1}>
                        <Text style={{ color: tint, fontWeight: '700' }}>{t('chat.draft') || 'Rascunho'}: </Text>
                        {draftText}
                      </Text>
                    </View>
                    {ageLabel ? (
                      <Text style={{ fontSize: 10, color: muted, marginTop: 2, marginLeft: 6 }}>{ageLabel}</Text>
                    ) : null}
                  </View>
                );
              })() : typingName ? (
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, marginRight: 10 }}>
                  <TypingDotsInline color={ACCENT} />
                  <Text style={[s.rowPreview, { color: ACCENT, fontStyle: 'italic', fontWeight: '600', flex: 0 }]} numberOfLines={1}>
                    {isGroup ? `${typingName} ` : ''}{(isGroup && typingNames.length > 1) ? (t('chat.typingMultiple') || 'estão digitando...') : (t('chat.typing') || 'digitando...')}
                  </Text>
                </View>
              ) : (
                <View style={{ flex: 1, flexDirection: 'row', alignItems: 'center', marginRight: 10 }}>
                  {hasScheduled && (
                    <View style={{ marginRight: 4, opacity: 0.85 }}>
                      <IconClockMini size={13} color={isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)'} />
                    </View>
                  )}
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
                {/* Mute icon stays mounted during the fade-out (muteVisible
                    flips false only after the 200ms timing finishes), so the
                    true→false transition fades instead of popping. Unmounted
                    when fully hidden so unmuted rows don't carry a phantom
                    14px slot in the flex gap. */}
                {muteVisible && (
                  <Animated.View style={{ opacity: muteOpacity }} pointerEvents="none">
                    <IconBellOff size={14} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'} />
                  </Animated.View>
                )}
                {conversation.has_mention && unread && (
                  <View style={[s.unreadBadge, s.unreadBadgeShadow, { backgroundColor: '#FF6B9D', minWidth: 24 }]}>
                    <Text style={[s.unreadText, { fontWeight: '900' }]}>@</Text>
                  </View>
                )}
                {/* Mention badge: @ indicator takes priority visually — stays
                    even when the chat is muted so you never miss being called
                    out. Paired with the unread count. Uses a warmer pink tone
                    (#FF6B9D) + heavier weight so it reads instantly different
                    from the green unread-count pill. Spring-pop scale when the
                    count increases so a fresh @mention catches the eye. */}
                {conversation.unread_mentions > 0 && (
                  <Animated.View style={[s.unreadBadge, s.unreadBadgeShadow, { backgroundColor: '#FF6B9D', marginRight: 4, minWidth: 22, transform: [{ scale: mentionScale }] }]}>
                    <Text style={[s.unreadText, { fontSize: 13, fontWeight: '900' }]}>@</Text>
                  </Animated.View>
                )}
                {unread && (
                  <View style={[
                    s.unreadBadge,
                    s.unreadBadgeShadow,
                    // Muted chats get a neutral grey pill with NO purple glow —
                    // the badge stays informative but visually de-emphasized so
                    // the brand-purple unread accent is reserved for live chats.
                    isMuted && !conversation.unread_mentions && {
                      backgroundColor: isDark ? '#555' : '#9aa3b2',
                      ...Platform.select({
                        ios: { shadowOpacity: 0 },
                        android: { elevation: 0 },
                        web: { boxShadow: 'none' },
                        default: {},
                      }),
                    },
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
  if (prev.draftEditedAt !== next.draftEditedAt) return false;
  // noteText + currentEmail both feed the row render (the Instagram note bubble
  // above the avatar, and the "is this my own message / who's the peer" logic).
  // They were missing here, so a note change or an account switch left the row
  // stale until something else invalidated it. Adding them can only trigger a
  // genuinely-needed repaint — it never skips one.
  if (prev.noteText !== next.noteText) return false;
  if (prev.currentEmail !== next.currentEmail) return false;

  // Compare conversation properties, not reference
  const prevConv = prev.conversation;
  const nextConv = next.conversation;
  if (prevConv.id !== nextConv.id) return false;
  if ((prevConv.unread_count || 0) !== (nextConv.unread_count || 0)) return false;
  if ((prevConv.last_message?.id) !== (nextConv.last_message?.id)) return false;
  // Re-render when the last message is edited (content changes) or deleted
  // (tombstone) in place — the message_id stays the same, so the id check
  // above won't catch it. Without these the preview text would stay stale
  // until a brand-new message arrived.
  if ((prevConv.last_message?.content || '') !== (nextConv.last_message?.content || '')) return false;
  if ((prevConv.last_message?.deleted_at || '') !== (nextConv.last_message?.deleted_at || '')) return false;
  // Re-render when delivery/read state of the last outbound message changes
  // so ✓ → ✓✓ → ✓✓ roxo animates in without waiting for a new message.
  if ((prevConv.last_message?.delivered_at || '') !== (nextConv.last_message?.delivered_at || '')) return false;
  if ((prevConv.last_message?.read_at || '') !== (nextConv.last_message?.read_at || '')) return false;
  if ((prevConv.pinned || false) !== (nextConv.pinned || false)) return false;
  if ((prevConv.muted || false) !== (nextConv.muted || false)) return false;
  // Re-render when @mention count changes so the spring-pop scale fires.
  if ((prevConv.unread_mentions || 0) !== (nextConv.unread_mentions || 0)) return false;
  if ((prevConv.last_message_at) !== (nextConv.last_message_at)) return false;
  if ((prevConv.display_name || prevConv.name) !== (nextConv.display_name || nextConv.name)) return false;

  // Compare typing only for THIS conversation, not all (comparing all caused every row to re-render when anyone typed)
  // typingUsers[convId] is now an array (per-typer list); compare by joined
  // content so a brand-new array reference with the same names is a no-op.
  const convId = prev.conversation?.id;
  const _typKey = (v) => Array.isArray(v) ? v.join('') : (v == null ? '' : String(v));
  if (_typKey(prev.typingUsers?.[convId]) !== _typKey(next.typingUsers?.[convId])) return false;

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
        backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
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
        backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.035)',
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
        backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
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
    // BUG #3: donate INSendMessageIntent for the top recents so the iOS
    // share sheet "Suggested" row populates with avatars even when the user
    // hasn't sent a message in this session. Apple Intelligence ranks
    // suggestions by frequency-of-donation; a single donate-after-send
    // misses cold-starters (first open of the app) and devices that
    // upgraded over from a build that never donated. We donate the top 8
    // direct conversations (the suggestions row only shows ~5–8 anyway)
    // and skip groups (INSendMessageIntent surfaces best for 1:1).
    try {
      const directs = snapshot.filter(c => c.type !== 'group').slice(0, 8);
      directs.forEach(c => {
        if (!c.id || !c.email) return;
        Intents.donateRecipient({
          conversationId: String(c.id),
          name: c.name || c.email,
          email: c.email,
          avatarUri: c.avatarUrl || '',
        });
      });
    } catch {}
  } catch {}
};

// ── Status Stories Row (Instagram-style, unified with Notes) ──
function StatusStoriesRow({ colors, isDark, user, router, t, setActiveTab }) {
  // Status feed comes from the shared hook now: WS deltas, MMKV preload,
  // fingerprint-diff-anti-flicker, 30d disk cache, video warm-cache. The
  // local `statuses` state lives just to keep the optimistic mutation
  // helpers (mark-viewed, delete) familiar to the rest of this component.
  const { groups: hookGroups, loading: statusLoading, refetch: refetchStatuses, markViewed: markStatusViewed, removeStatus: removeStatusFromCache, removeGroup: removeStatusGroup } = useStatuses(user?.email, { warmCacheVideos: true });
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
  // Repost seed — when the user taps "Repostar" on their own story we
  // pre-populate the camera composer with the original media so they
  // can re-publish without re-recording. Shape: { uri, type, width?,
  // height?, caption? } or null. Consumed by StatusCamera below and
  // cleared on close.
  const [repostSeed, setRepostSeed] = useState(null);
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

  // [WAVE 93 2026-05-21] Pull-to-refresh bus subscription. Parent's onRefresh
  // emits 'refresh' here; we drive refetchStatuses + loadNotes together so
  // the entire strip surface stays consistent with the rest of the chat list
  // pull cadence. Bus is a one-line shim (components/statusRefreshBus.js)
  // — keeps the hook ownership untouched.
  useEffect(() => {
    try {
      const bus = require('./statusRefreshBus').default;
      const unsub = bus.on('refresh', () => { try { load(); } catch {} });
      return () => { try { unsub?.(); } catch {} };
    } catch { return undefined; }
  }, [load]);

  // Active live broadcasts (Instagram parity). Map: lowercased email → session id.
  // Refreshed every 45s. Lives outrank story rings — a host who is both
  // posting status AND streaming live shows the red AO VIVO ring, with tap
  // going to /live-viewer instead of the story viewer.
  const [livesByEmail, setLivesByEmail] = useState({});
  // [#1161, 2026-05-18] Per-host stale-tick guard. Mirrors the pattern in
  // Profile.js (line ~1218): if a `live_ended` WS event lands while a
  // `live_list` poll is in flight, the poll response carries a DB snapshot
  // taken BEFORE the end committed — and would re-paint the AO VIVO badge
  // for that host across the entire chat list + LiveBar. We track the
  // moment each host's end signal landed; any poll response that started
  // BEFORE that moment is rebased (the ended host is stripped from the
  // map even if it's still in the response). 30s window covers backend
  // write→read replication lag + WS round-trip.
  const liveEndedAtByHostRef = useRef({});
  useEffect(() => {
    if (!user?.email) return undefined;
    let cancelled = false;
    const tick = async () => {
      const startedAt = Date.now();
      try {
        const r = await api.apiCall?.('live_list', null, 'POST');
        if (cancelled) return;
        const lives = r?.data?.lives || r?.lives || [];
        const map = {};
        for (const l of lives) {
          if (l?.host_email && l?.id) {
            const hostKey = String(l.host_email).toLowerCase();
            // Stale-response guard — skip hosts that received an end
            // signal AFTER this poll left. Without this, a poll fired
            // T=0, host ends T=2 (clears state), poll lands T=3 carrying
            // the still-live snapshot → badge re-sticks until next poll.
            const endedAt = liveEndedAtByHostRef.current[hostKey] || 0;
            if (endedAt >= startedAt && Date.now() - endedAt < 30000) continue;
            map[hostKey] = { id: l.id, host_name: l.host_name, viewer_count: l.viewer_count };
          }
        }
        setLivesByEmail(map);
      } catch {
        if (!cancelled) setLivesByEmail({});
      }
    };
    tick();
    const iv = setInterval(tick, 45000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [user?.email]);
  const liveAoVivo = (t('live.aoVivo') || 'AO VIVO').toUpperCase();
  const openLiveViewer = useCallback(async (email, sessionId, hostName) => {
    try {
      // Self-live exception — tapping your own AO VIVO ring on the chat list
      // routes to /live-broadcast (your host panel) instead of /live-viewer,
      // since the viewer can't watch its own outgoing stream and would show
      // "Stream indisponível".
      const isSelf = email && user?.email && String(email).toLowerCase() === String(user.email).toLowerCase();
      if (isSelf) {
        const sid = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
        router.push(`/live-broadcast${sid}`);
        return;
      }
      // [WAVE 43 2026-05-20] Permissive pre-tap status verify. Antes (WAVE 38)
      // bloqueava entry no /live-viewer sempre que `liveStatusCf` retornava
      // qualquer coisa que não fosse `status='live'`. Isso causava bug user:
      // "não tá deixando conectar na live, mostra 'live encerrada'" em
      // múltiplos cenários false-positive:
      //   1. Backend retorna 404 (`Session not found`) — `r.data` é null mas
      //      `r` truthy → bloqueava com alert "Live encerrada".
      //   2. CF Stream ainda não ingerindo frames → `is_live=false` mas
      //      status='live' no PG (esse caso já passa). Outros cenários onde
      //      `r` é success=false sem `data` válido bloqueavam falsamente.
      //   3. Timeout/transient backend hiccup → trata como ended.
      //   4. Auto-end backend (5min sem viewers) marca live legítima como
      //      'ended' enquanto host ainda transmite (live_list:6717-6757).
      // Nova regra: SÓ bloqueamos quando o backend CONFIRMA explicitamente
      // `status==='ended'`. Qualquer outra resposta (404, timeout, success
      // false, success true com status indeterminado) deixa entrar — o
      // /live-viewer tem 2 sources of truth próprios (live_list poll +
      // live_session_info WS) que vão converter pra liveEnded se for o caso.
      try {
        console.log('[LIVE-TRACE] openLiveViewer pre-tap', { sessionId, hostEmail: email, ts: Date.now() });
        // Timeout race — se backend demorar >2s, deixa entrar mesmo assim.
        const probe = api.liveStatusCf(sessionId);
        const timeoutP = new Promise((resolve) => setTimeout(() => resolve({ __probeTimeout: true }), 2000));
        const r = await Promise.race([probe, timeoutP]);
        if (r?.__probeTimeout) {
          console.log('[LIVE-TRACE] liveStatusCf timeout — allow entry');
        } else {
          const dataStatus = String(r?.data?.status || '').toLowerCase();
          const topStatus = String(r?.status || '').toLowerCase();
          const explicitEnded = dataStatus === 'ended' || topStatus === 'ended';
          const isLiveSignal = dataStatus === 'live' || dataStatus === 'active' || r?.data?.is_live === true;
          console.log('[LIVE-TRACE] liveStatusCf result', {
            success: r?.success,
            dataStatus,
            topStatus,
            is_live: r?.data?.is_live,
            message: r?.message,
          });
          console.log('[LIVE-TRACE] decision', {
            allow: !explicitEnded || isLiveSignal,
            fallback: explicitEnded && !isLiveSignal ? 'tryNewerSessionFromHost' : 'allowEntry',
          });
          if (explicitEnded && !isLiveSignal) {
            // Backend confirmed this exact session is ended. Antes de
            // bloquear, tenta achar uma session NOVA do mesmo host na
            // live_list — cobre o caso "host re-broadcast, card velho
            // ainda mostra session_id antigo" comum em race conditions.
            let newerSessionId = null;
            let newerHostName = null;
            try {
              const listR = await Promise.race([
                api.liveList(),
                new Promise((resolve) => setTimeout(() => resolve(null), 1500)),
              ]);
              if (listR && email) {
                const sessions = Array.isArray(listR?.lives)
                  ? listR.lives
                  : (Array.isArray(listR?.data?.lives) ? listR.data.lives : []);
                const emailLower = String(email).toLowerCase();
                const hit = sessions.find(s => String(s?.host_email || '').toLowerCase() === emailLower);
                if (hit && hit.id && String(hit.id) !== String(sessionId)) {
                  newerSessionId = hit.id;
                  newerHostName = hit.host_name || null;
                }
              }
            } catch {}
            if (newerSessionId) {
              console.log('[LIVE-TRACE] redirect to newer session', { from: sessionId, to: newerSessionId });
              // Update local cache to the new id so next tap hits it directly.
              if (email) {
                const emailLower = String(email).toLowerCase();
                setLivesByEmail(prev => ({
                  ...prev,
                  [emailLower]: { id: newerSessionId, host_name: newerHostName || hostName || emailLower.split('@')[0], viewer_count: 0 },
                }));
              }
              const params2 = new URLSearchParams();
              params2.set('sessionId', String(newerSessionId));
              if (email) params2.set('hostEmail', email);
              if (newerHostName || hostName) params2.set('hostName', String(newerHostName || hostName));
              router.push(`/live-viewer?${params2.toString()}`);
              return;
            }
            // No newer session — clear stale card and surface a friendlier
            // message. Still allow tap-through if user insists.
            if (email) {
              const emailLower = String(email).toLowerCase();
              setLivesByEmail(prev => {
                if (!prev[emailLower]) return prev;
                const n = { ...prev }; delete n[emailLower]; return n;
              });
            }
            try {
              const { Alert } = require('react-native');
              Alert.alert(
                t('live.endedTitle') || 'Live encerrada',
                t('live.endedBody') || 'Esta transmissão já terminou.',
              );
            } catch {}
            return;
          }
        }
      } catch (e) {
        console.log('[LIVE-TRACE] liveStatusCf threw — allow entry', { message: e?.message });
        // Probe threw — never block. /live-viewer has its own ended detection.
      }
      const params = new URLSearchParams();
      params.set('sessionId', sessionId);
      if (email) params.set('hostEmail', email);
      if (hostName) params.set('hostName', hostName);
      router.push(`/live-viewer?${params.toString()}`);
    } catch {}
  }, [router, user?.email, t]);

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

  // Live-only entries: hosts streaming right now who don't already appear in
  // the strip via a status. Rendered as a prepended live ring in the strip
  // (Instagram's red AO VIVO ring) so followers always see active broadcasts
  // at the top of home.
  const liveOnlyEntries = useMemo(() => {
    const out = [];
    for (const [email, info] of Object.entries(livesByEmail)) {
      if (email === (user?.email || '').toLowerCase()) continue;
      if (statusEmails.has(email)) continue;
      out.push({ email, name: info.host_name || email.split('@')[0], session_id: info.id });
    }
    return out;
  }, [livesByEmail, statusEmails, user?.email]);

  // Full list of active lives (excluding self) for the dedicated LiveBar at
  // the very top of the chat list — surfaces EVERY broadcaster, regardless
  // of whether they also have an active status. The story strip below still
  // paints the red ring on duplicates, but the LiveBar is the "go here NOW"
  // bar (Instagram parity).
  const allLivesList = useMemo(() => {
    const out = [];
    for (const [email, info] of Object.entries(livesByEmail)) {
      if (email === (user?.email || '').toLowerCase()) continue;
      out.push({
        host_email: email,
        host_name: info.host_name || email.split('@')[0],
        id: info.id,
        viewer_count: info.viewer_count || 0,
      });
    }
    return out;
  }, [livesByEmail, user?.email]);

  const [statusViewerEmail, setStatusViewerEmail] = useState(null);
  // [bug #982] Snapshot the items shown to the viewer when it opens. If the
  // background `statuses` poll re-fetches and the target user is filtered out
  // (privacy block, 24h TTL, server-side hide), the live items.length flips
  // to 0 and `visible` would collapse → modal closes mid-watch ("ele some").
  // The snapshot persists so the user can finish the stories they opened.
  const [statusViewerLockedItems, setStatusViewerLockedItems] = useState(null);
  const [statusViewerLockedGroup, setStatusViewerLockedGroup] = useState(null);
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
  // [WAVE 79 2026-05-21] When the user taps a status bubble that is still
  // a manifest-only placeholder (real status_list hasn't resolved yet) we
  // can't open the viewer with empty media_urls or it shows the "Mídia
  // indisponível" empty-state. Instead, stash the pending email here and
  // wait for the next hookGroups update to land with real items, then open.
  // Bug user 2026-05-21: "abre status, foto não aparece, se eu volto e
  // entro de novo aí aparece".
  const [pendingStatusEmail, setPendingStatusEmail] = useState(null);
  const pendingTimeoutRef = useRef(null);
  const openStatus = (email) => {
    setStatusViewIdx(0);
    if (!email) {
      setStatusViewerEmail(null);
      setStatusViewerLockedGroup(null);
      setStatusViewerLockedItems(null);
      setPendingStatusEmail(null);
      return;
    }
    const lc = String(email).toLowerCase();
    const g = statuses.find(s => String(s.email || '').toLowerCase() === lc);
    const isPlaceholder = !!g && (g.items || []).length > 0 && (g.items || []).every(it => it?._placeholder);
    if (g && !isPlaceholder) {
      // Happy path: real items already cached. Open immediately and lock
      // the snapshot so a mid-watch refetch can't collapse the modal.
      setStatusViewerLockedGroup(g);
      setStatusViewerLockedItems(g.items || []);
      setStatusViewerEmail(email);
      setPendingStatusEmail(null);
      return;
    }
    // Placeholder or missing group → wait for real data. Mark pending +
    // force a refetch + arm a 4s timeout fallback. Effect below opens the
    // viewer the moment real items arrive.
    setStatusViewerLockedGroup(null);
    setStatusViewerLockedItems(null);
    setStatusViewerEmail(null);
    setPendingStatusEmail(email);
    try { refetchStatuses?.(); } catch {}
    if (pendingTimeoutRef.current) clearTimeout(pendingTimeoutRef.current);
    pendingTimeoutRef.current = setTimeout(() => {
      // Last-chance fallback after 4s: open with whatever we have (placeholder
      // or all) so the user isn't stuck on a tap with no feedback. Viewer's
      // per-item _placeholder loading state will cover the visual gap.
      setPendingStatusEmail(prev => {
        if (prev) {
          setStatusViewerEmail(prev);
          const lc2 = String(prev).toLowerCase();
          const g2 = statuses.find(s => String(s.email || '').toLowerCase() === lc2);
          if (g2) {
            setStatusViewerLockedGroup(g2);
            setStatusViewerLockedItems(g2.items || []);
          }
        }
        return null;
      });
    }, 4000);
  };
  // Resolve pending open the moment hookGroups lands with real items.
  useEffect(() => {
    if (!pendingStatusEmail) return;
    const lc = String(pendingStatusEmail).toLowerCase();
    const g = statuses.find(s => String(s.email || '').toLowerCase() === lc);
    if (!g) return;
    const stillPlaceholder = (g.items || []).length > 0 && (g.items || []).every(it => it?._placeholder);
    if (stillPlaceholder) return;
    if (pendingTimeoutRef.current) { clearTimeout(pendingTimeoutRef.current); pendingTimeoutRef.current = null; }
    setStatusViewerLockedGroup(g);
    setStatusViewerLockedItems(g.items || []);
    setStatusViewerEmail(pendingStatusEmail);
    setPendingStatusEmail(null);
  }, [statuses, pendingStatusEmail]);
  useEffect(() => () => { if (pendingTimeoutRef.current) clearTimeout(pendingTimeoutRef.current); }, []);

  // [WAVE 79 2026-05-21] Eager prefetch of the FIRST media item for the top
  // 5 status groups in the strip — fires as soon as the strip has real
  // (non-placeholder) items. By the time the user taps a bubble, the first
  // image is already on disk so the viewer paints instantly without the
  // "tela em branco" gap. Top 5 keeps the bandwidth bounded (R2 + native
  // disk cache); the viewer's existing per-tap prefetch covers the rest.
  const stripPrefetchedRef = useRef(new Set());
  useEffect(() => {
    if (!statuses || statuses.length === 0) return;
    // [WAVE 93 2026-05-21] Widened from top-5/first-item to top-8/first-two.
    // Users who blast through the strip with quick taps hit cold cache on
    // the second item (because the viewer's i+1 prefetch fires only after
    // it mounts → 200-400ms behind). Pre-warming the second item from the
    // strip closes that gap. Cap kept tight (16 URLs max) to stay polite
    // on cellular — R2 + expo-image dedup so re-renders are cheap.
    const candidates = statuses.slice(0, 8);
    const urls = [];
    const pushItem = (it) => {
      if (!it || it._placeholder) return;
      const raw = it.media_url || ((it.type === 'image' || it.type === 'video') && /^(\/|https?:\/\/)/.test(String(it.content || '')) ? String(it.content).split('\n')[0] : '');
      if (!raw) return;
      const url = raw.startsWith('http') ? raw : `${api.BASE_URL}${raw}`;
      if (stripPrefetchedRef.current.has(url)) return;
      stripPrefetchedRef.current.add(url);
      urls.push({ url, isVideo: it.type === 'video' });
      // Also warm the thumbnail for video items so the poster paints
      // instantly when the viewer mounts — kills the black-flash gap.
      if (it.thumbnail_url) {
        const traw = String(it.thumbnail_url);
        const turl = traw.startsWith('http') ? traw : `${api.BASE_URL}${traw}`;
        if (!stripPrefetchedRef.current.has(turl)) {
          stripPrefetchedRef.current.add(turl);
          urls.push({ url: turl, isVideo: false });
        }
      }
    };
    for (const g of candidates) {
      const items = g.items || [];
      pushItem(items[0]);
      pushItem(items[1]);
    }
    if (urls.length === 0) return;
    try {
      const { Image: ExpoImg } = require('expo-image');
      const imgUrls = urls.filter(u => !u.isVideo).map(u => u.url);
      if (imgUrls.length && ExpoImg?.prefetch) ExpoImg.prefetch(imgUrls).catch(() => {});
    } catch {}
    if (Platform.OS !== 'web') {
      try {
        const { cacheMedia } = require('../services/mediaCache');
        urls.forEach(({ url }) => { cacheMedia(url, { force: true }).catch(() => {}); });
      } catch {}
    }
  }, [statuses]);

  // Prefetch the next few status items' images as soon as a viewer opens
  // or advances — this makes left/right taps feel instant instead of
  // waiting on R2. Uses expo-image's prefetch (no-op on web where the
  // browser already caches fetched URLs).
  useEffect(() => {
    if (!statusViewerEmail) return;
    const _sve = String(statusViewerEmail).toLowerCase();
    const group = statuses.find(s => String(s.email || '').toLowerCase() === _sve);
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

  // Hide the entire stories strip when there's nothing to surface — no own
  // story/note, no other active stories, no contact notes. A lone "Seu
  // status" circle floating left-aligned looks like a layout glitch (caught
  // in QA 2026-05-07). The status camera in the chat list header still
  // gives a one-tap entrypoint for new posts.
  const stripHasContent = !!myStatus || !!myNote || otherStatuses.length > 0 || notesOnly.length > 0 || liveOnlyEntries.length > 0;
  const hasLives = allLivesList.length > 0;
  // [WAVE 43B 2026-05-20] Skeleton rings durante o cold-fetch — substitui o
  // `return null` que deixava a área em branco por ~200-800ms (perceived
  // "demora") em primeiras aberturas sem cache. 4 bubbles falsos no mesmo
  // tamanho do row real evitam layout shift quando os dados chegam.
  if (!stripHasContent && !hasLives) {
    if (statusLoading) {
      const skBg = isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)';
      return (
        <View style={{ paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)' }}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 14, gap: 14 }}>
            {[0,1,2,3,4].map(i => (
              <View key={`sk-${i}`} style={{ alignItems: 'center', width: 70 }}>
                <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: skBg }} />
                <View style={{ width: 36, height: 9, borderRadius: 4, backgroundColor: skBg, marginTop: 7 }} />
              </View>
            ))}
          </ScrollView>
        </View>
      );
    }
    return null;
  }

  return (
    <View style={{ paddingTop: stripHasContent ? 14 : 0, paddingBottom: stripHasContent ? 12 : 0, borderBottomWidth: stripHasContent ? StyleSheet.hairlineWidth : 0, borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)' }}>
      {/* Dedicated live bar — prepended above the story strip so contacts
          who are streaming RIGHT NOW are the very first thing the user
          sees on the chat list. Renders only when at least one host is
          live. Tap routes to /live-viewer via openLiveViewer (same path
          as every other live entry-point). */}
      {hasLives && (
        <LiveBar
          lives={allLivesList}
          onOpen={(email, sessionId, name) => openLiveViewer(email, sessionId, name)}
          t={t}
          isDark={isDark}
          colors={colors}
        />
      )}
      {stripHasContent ? (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ paddingHorizontal: 16, gap: 16 }}>
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
          style={{ alignItems: 'center', width: 70 }}
        >
          <StoryRingAvatar
            name={myDisplayName}
            email={user?.email}
            size={56}
            ringStyle={myStatus ? 'solid' : 'none'}
            badge="plus"
            note={!myStatus && myNote?.content ? myNote.content : null}
            isDark={isDark}
            colors={colors}
          />
          <Text style={{ fontSize: 11.5, color: colors.text, marginTop: 7, fontWeight: '600', letterSpacing: -0.15 }} numberOfLines={1}>
            {myNote || myStatus ? myDisplayName : (t('status.yourStory') || 'Sua nota')}
          </Text>
        </TouchableOpacity>

        {/* Live-only entries — broadcasters with no current status. Painted
            with the red AO VIVO ring + tap routes to /live-viewer. Prepended
            so they always sit at the head of the strip (after Your Story). */}
        {liveOnlyEntries.map((l) => (
          <View key={`live-only-${l.email}`} style={{ alignItems: 'center', width: 68 }}>
            <TouchableOpacity
              onPress={() => openLiveViewer(l.email, l.session_id, l.name)}
              activeOpacity={0.7}
              style={{ alignItems: 'center' }}
            >
              <StoryRingAvatar
                name={l.name}
                email={l.email}
                size={54}
                ringStyle="none"
                isLive
                liveLabel={liveAoVivo}
                isDark={isDark}
                colors={colors}
              />
              <Text style={{ fontSize: 11.5, color: colors.text, marginTop: 6, fontWeight: '500', letterSpacing: -0.1 }} numberOfLines={1}>
                {l.name}
              </Text>
            </TouchableOpacity>
          </View>
        ))}

        {/* Status stories (photos/videos) — unviewed have bright purple ring,
            partially-viewed keep a dimmer ring. Fully-viewed groups already
            filtered out above → only reachable via the user's profile. */}
        {otherStatuses.map((s) => {
          const allViewed = (s.items || []).every(it => it.viewed);
          const liveInfo = livesByEmail[(s.email || '').toLowerCase()];
          const isLive = !!liveInfo;
          return (
            <View key={`st-${s.email}`} style={{ alignItems: 'center', width: 68 }}>
              <TouchableOpacity
                onPress={() => isLive ? openLiveViewer(s.email, liveInfo.id) : openStatus(s.email)}
                onPressIn={() => {
                  // WhatsApp/IG pattern: warm the first item the moment the
                  // finger touches the ring. By the time onPress fires + the
                  // viewer mounts, the full payload is already on disk so
                  // there's no spinner / black-frame flash.
                  if (Platform.OS === 'web' || isLive) return;
                  try {
                    const { cacheMedia } = require('../services/mediaCache');
                    const first = (s.items || [])[0];
                    if (!first) return;
                    const raw = first.media_url
                      || ((first.type === 'image' || first.type === 'video') && /^(\/|https?:\/\/)/.test(String(first.content || ''))
                          ? first.content : '');
                    if (raw) {
                      const url = raw.startsWith('http') ? raw : `${api.BASE_URL}${raw}`;
                      cacheMedia(url, { force: true }).catch(() => {});
                    }
                    if (first.thumbnail_url) {
                      const _thumb = first.thumbnail_url;
                      const turl = _thumb.startsWith('http') ? _thumb : `${api.BASE_URL}${_thumb}`;
                      cacheMedia(turl, { force: true }).catch(() => {});
                    }
                  } catch {}
                }}
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
                  isLive={isLive}
                  liveLabel={liveAoVivo}
                  badge={isLive ? null : 'reply'}
                  badgeAccessibilityLabel={t('status.reply') || 'Responder'}
                  onBadgePress={isLive ? undefined : () => { try {
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
                <Text style={{ fontSize: 11.5, color: colors.text, marginTop: 6, fontWeight: '500', letterSpacing: -0.1 }} numberOfLines={1}>
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
            <Text style={{ fontSize: 11.5, color: colors.text, marginTop: 6, fontWeight: '500', letterSpacing: -0.1 }} numberOfLines={1}>
              {n.name || n.email?.split('@')[0]}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>
      ) : null}

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

      {/* Status Viewer — unified canonical component (Wave 4 consolidation).
          Replaces a 300-line inline Modal that duplicated StoryViewer.
          Same UX (Instagram-like fullscreen story) + viewers sheet, but the
          single component is also used by Profile and (next) ChatStatusTab. */}
      {(() => {
        // [2026-05-15 bug #982] Email comparison must be case-insensitive.
        // Server canonicalizes addresses to lowercase, but `openStatus(email)`
        // can be invoked with the original-case email from a click target
        // (e.g. when suporte@boraum opens duarte@CHATYY.com.br from another
        // surface). A strict !== match returned -1, so `groupIdx = 0` fell
        // back to a DIFFERENT user's group (or own, which has 0 items when
        // the viewer hasn't posted today). Result: modal flashed and closed
        // ("ele some") because items.length was 0.
        const _sve = String(statusViewerEmail || '').toLowerCase();
        const _idx = statuses.findIndex(s => String(s.email || '').toLowerCase() === _sve);
        const liveGroup = _idx >= 0 ? statuses[_idx] : null;
        // Prefer the live group if present (fresh items including any newly
        // posted), fall back to the locked snapshot captured at openStatus
        // time so a refetch that filters duarte out can't close the viewer.
        const group = liveGroup || statusViewerLockedGroup;
        const groupIdx = _idx >= 0 ? _idx : 0;
        const items = (liveGroup?.items?.length ? liveGroup.items : statusViewerLockedItems) || [];
        const isOwn = !!group && (group.email || '').toLowerCase() === (user?.email || '').toLowerCase();
        return (
          <StoryViewer
            visible={!!statusViewerEmail && items.length > 0}
            stories={items}
            startIdx={statusViewIdx || 0}
            ownerName={group?.name || group?.email?.split('@')[0] || ''}
            ownerEmail={group?.email || ''}
            isSelf={isOwn}
            isDark={isDark}
            t={t}
            groupIndex={groupIdx}
            groupCount={statuses.length}
            onNextGroup={() => {
              const next = statuses[groupIdx + 1];
              if (next?.email) { setStatusViewerEmail(next.email); setStatusViewIdx(0); }
            }}
            onPrevGroup={() => {
              const prev = statuses[groupIdx - 1];
              if (prev?.email) { setStatusViewerEmail(prev.email); setStatusViewIdx(0); }
            }}
            onClose={() => { setStatusViewerEmail(null); setStatusViewIdx(0); setStatusViewerLockedGroup(null); setStatusViewerLockedItems(null); }}
            onMarkViewed={(itemId) => { try { markStatusViewed(itemId); } catch {} }}
            onDelete={async (statusId) => {
              try { await api.statusDelete?.(statusId); } catch {}
              try { removeStatusFromCache(statusId); } catch {}
              const remaining = (items || []).filter(it => it.id !== statusId);
              if (remaining.length === 0) { setStatusViewerEmail(null); setStatusViewIdx(0); setStatusViewerLockedGroup(null); setStatusViewerLockedItems(null); }
              else { setStatusViewIdx(i => Math.min(i || 0, remaining.length - 1)); }
            }}
            onAddMore={() => {
              setStatusViewerEmail(null); setStatusViewIdx(0);
              setTimeout(() => { setShowCustomCamera(true); }, 140);
            }}
            onRepost={(story) => {
              // Repost own status: dismiss the viewer, then route to the
              // camera composer with the original media pre-loaded. The
              // camera surface accepts an onCapture-shape seed via
              // setRepostSeed; if the caller hasn't wired that state yet,
              // we still open the camera so the user lands somewhere
              // useful (better than a no-op).
              setStatusViewerEmail(null); setStatusViewIdx(0);
              if (!story) return;
              try {
                const rawUrl = (story.media_url || story.content || '').split('\n')[0];
                const fullUrl = rawUrl
                  ? (rawUrl.startsWith('http') ? rawUrl : (BASE_URL + rawUrl))
                  : null;
                if (fullUrl && typeof setRepostSeed === 'function') {
                  setRepostSeed({
                    uri: fullUrl,
                    type: story.type === 'video' ? 'video' : 'photo',
                    width: story.width || undefined,
                    height: story.height || undefined,
                    caption: story?.meta?.caption || '',
                  });
                }
              } catch {}
              setTimeout(() => { setShowCustomCamera(true); }, 160);
            }}
            onReply={async (story, text) => {
              try {
                await api.statusReplyDM?.(story?.id, text);
              } catch {
                // Offline / 5xx — queue for replay so the DM reply doesn't
                // disappear. Server creates / reuses the direct convo idempotently.
                try {
                  const { queueOfflineAction } = require('../services/offlineCache');
                  await queueOfflineAction({
                    type: 'status_reply_dm',
                    params: { status_id: story?.id, content: text },
                  });
                } catch {}
              }
            }}
            onReact={async (story, emoji) => {
              try {
                await api.statusReact?.(story?.id, emoji);
              } catch {
                // Offline / 5xx — queue the emoji reaction. Author-only
                // visibility means a silent drop is invisible to the viewer
                // but breaks the author's "X reacted" notification. Replay
                // restores parity.
                try {
                  const { queueOfflineAction } = require('../services/offlineCache');
                  await queueOfflineAction({
                    type: 'status_react',
                    params: { status_id: story?.id, emoji },
                  });
                } catch {}
              }
            }}
            onSeenByPress={(item) => setStatusViewersFor(item)}
            viewersFor={statusViewersFor}
            viewersList={statusViewersList}
            viewersLoading={statusViewersLoading}
            onCloseViewers={() => setStatusViewersFor(null)}
            onMentionPress={({ email, username }) => {
              // Mention sticker tap → user profile. Dismiss viewer first so
              // the navigation lands on a clean stack (instead of stacking
              // /u/<email> on top of the modal).
              setStatusViewerEmail(null); setStatusViewIdx(0);
              setStatusViewerLockedGroup(null); setStatusViewerLockedItems(null);
              const target = email || username;
              if (!target) return;
              setTimeout(() => {
                try { router.push(`/u/${encodeURIComponent(target)}`); } catch {}
              }, 150);
            }}
          />
        );
      })()}


      {/* Instagram-style custom camera (NATIVE ONLY — crashes on web) */}
      {Platform.OS !== 'web' && (
        <Modal visible={showCustomCamera} transparent={false} animationType="slide" onRequestClose={() => { setShowCustomCamera(false); setRepostSeed(null); }}>
          <StatusCamera
            visible={showCustomCamera}
            t={t}
            initialSeed={repostSeed}
            onClose={() => { setShowCustomCamera(false); setRepostSeed(null); }}
            onCapture={async (payload) => {
              setRepostSeed(null);
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
            behavior={Platform.OS === 'ios' ? 'padding' : undefined}
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
  const confirm = useConfirm();
  const { language } = useLanguage();
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
  // WAVE 95 (2026-05-21): chat-list row avatar tap → fullscreen lightbox.
  // Row tap (anywhere else) still opens the conversation.
  const [avatarLightbox, setAvatarLightbox] = useState(null); // { name, email }
  const [conversations, setConversations] = useState(() => _initialConvs.filter(c => !c.archived));
  const [archivedConversations, setArchivedConversations] = useState(() => {
    if (!_initialConvs.length) return [];
    const arch = []; for (const c of _initialConvs) if (c.archived) arch.push(c);
    return arch;
  });
  // Sync ref for conversations count — avoids async setState detection bug
  const _convsCountRef = useRef(_initialConvs.length);
  _convsCountRef.current = conversations?.length || 0;
  // Web badge: empurra unread total pro document.title + navigator.setAppBadge
  // (no-op em mobile). Recomputado quando conversations muda.
  React.useEffect(() => {
    try {
      // Muted conversations must NOT inflate the app/title badge (WhatsApp
      // parity): a muted chat can still accrue unread_count for the in-list
      // bubble, but the global badge only counts unmuted unread.
      const total = (conversations || []).reduce((sum, c) => sum + (c.muted ? 0 : (c.unread_count || 0)), 0);
      const { setChatUnread } = require('../services/webBadge');
      setChatUnread(total);
    } catch {}
  }, [conversations]);
  // Debounce lock for conversation taps so a double-tap doesn't push the
  // same chat onto the stack twice (user complaint: "tenho que clicar 2 vez
  // para voltar").
  const _navLockRef = useRef(null);
  // Skip the loading spinner if we already painted from cache
  const [loading, setLoading] = useState(_initialConvs.length === 0);
  // WS down banner — surfaces an "offline" hint at the top of the list so
  // the user knows new messages aren't syncing live. Only shows after a
  // 12s delay (set by the connection listener) so brief flaps don't flash.
  // On reconnect we fade-out over 500ms instead of an abrupt flip (matches
  // WhatsApp's reconnect-pill dismiss animation).
  const [wsDownBanner, setWsDownBanner] = useState(false);
  const wsDownBannerOpacity = useRef(new Animated.Value(1)).current;
  // Auto-sync badge — fires from onlineRecoveryOrchestrator when an outbox
  // flush + delta sync round is running after coming back online. WhatsApp
  // shows the same kind of subtle "Connecting..." → "Updating..." hint at
  // the top of the chat list. Hidden when wsDownBanner is on (the WS-down
  // banner already represents the same "we're catching up" state).
  const [syncingBadge, setSyncingBadge] = useState(false);
  useEffect(() => {
    // WhatsApp Web parity (2026-05-18, #1131): web NEVER shows the inline
    // "Sincronizando..." pill at the top of the chat list. WhatsApp Web's
    // sync feedback is the rare "Computer not connected" full-screen state,
    // not a chronic banner. Users complained the pill stayed visible
    // permanently on cold start + every brief WS flap. Skip the subscription
    // entirely on web so it's impossible to render. Native keeps the
    // delayed-show + 5s ceiling.
    if (Platform.OS === 'web') return;
    let unsub = null;
    let cancelled = false;
    let showTimer = null;       // gate: only flip true after 2500ms
    let hideFailsafe = null;    // hard 4s ceiling
    (async () => {
      try {
        const m = await import('../services/onlineRecoveryOrchestrator');
        if (cancelled) return;
        if (typeof m.subscribeSyncStatus === 'function') {
          unsub = m.subscribeSyncStatus(({ running }) => {
            if (cancelled) return;
            if (running) {
              // WhatsApp-invisible-sync (2026-05-18): suppress the brief
              // reconnect flashes. If the recovery finishes inside 2500ms
              // (the common case on healthy networks), the user never sees
              // the badge at all — feels like nothing happened.
              if (showTimer) { try { clearTimeout(showTimer); } catch {} }
              showTimer = setTimeout(() => {
                showTimer = null;
                setSyncingBadge(true);
                // Hard ceiling — clear after 4s no matter what orchestrator
                // says. Covers WS reconnect loops that get stuck on
                // running:true.
                if (hideFailsafe) { try { clearTimeout(hideFailsafe); } catch {} }
                hideFailsafe = setTimeout(() => {
                  hideFailsafe = null;
                  setSyncingBadge(false);
                }, 4000);
              }, 2500);
            } else {
              // Recovery finished — clear pending "show" timer + hide now.
              if (showTimer) { try { clearTimeout(showTimer); } catch {} showTimer = null; }
              if (hideFailsafe) { try { clearTimeout(hideFailsafe); } catch {} hideFailsafe = null; }
              setSyncingBadge(false);
            }
          });
        }
      } catch {}
    })();
    return () => {
      cancelled = true;
      if (showTimer) { try { clearTimeout(showTimer); } catch {} showTimer = null; }
      if (hideFailsafe) { try { clearTimeout(hideFailsafe); } catch {} hideFailsafe = null; }
      if (typeof unsub === 'function') { try { unsub(); } catch {} }
    };
  }, []);
  // [silent-fail-w3] Surface a load failure when the cold-start fetch fails
  // AND the user has nothing on screen — previously the catch swallowed it,
  // leaving the user staring at the empty-state copy "start a new chat" even
  // when the real problem was a 5xx / 401. Banner offers tap-to-retry.
  const [loadError, setLoadError] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  // Real-time toast when a peer reacts to my status. Backend fires the
  // `status_reaction` WS event to the owner with reactor_name + emoji + status_id.
  // Tap toast → open the status in the unified viewer.
  const [reactionToast, setReactionToast] = useState(null); // { reactor_name, reactor_email, emoji, status_id }
  const reactionToastY = useRef(new Animated.Value(-120)).current;
  const reactionToastTimer = useRef(null);
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
  // Memoize FlatList extraData so it doesn't get a fresh object every render.
  // Was a perf gap — every keystroke / presence event re-invalidated row diffs.
  const extraDataMemo = React.useMemo(
    () => ({ typingUsers, selectionMode, lockedIds, unlockedIds, isDark, colors, presenceVersion }),
    [typingUsers, selectionMode, lockedIds, unlockedIds, isDark, colors, presenceVersion]
  );
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
        if (!r?.success) {
          // Silent-fail audit: server returned non-success while cached
          // rows are on screen. Keeping stale UI is correct (user has
          // something usable) but at least log so the WS reconnect
          // banner / auto-heal layer can pick it up — previously this
          // hid 401/500 cascades on the chat list completely.
          if (r?.message) console.warn('[ChatList] background sync non-success', r.message);
          return;
        }
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
      }).catch((e) => {
        console.warn('[ChatList] background sync threw', e?.message);
      });
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
        setLoadError(false);
      } else if (_convsCountRef.current === 0) {
        // [silent-fail-w3] Non-success on cold start with empty screen —
        // surface the error banner so the user sees something actionable.
        console.warn('[silent-fail-w3] chatList cold non-success', r?.message);
        setLoadError(true);
      }
      const rAll = await api.chatConversations(searchText, true);
      if (!isFresh()) return;
      if (rAll.success) {
        const all = Array.isArray(rAll.data) ? rAll.data : (rAll.data?.conversations || []);
        setArchivedConversations(all.filter(c => c.archived));
        cacheConversations(all).catch(() => {});
        _saveNativeConversations(all);
      }
    } catch (e) {
      // [silent-fail-w3] Was `catch {}` — completely silent. Now log + flag
      // the banner if there's nothing on screen for the user to look at.
      console.warn('[silent-fail-w3] chatList cold threw', e?.message);
      if (_convsCountRef.current === 0) setLoadError(true);
    } finally {
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

  // Disk-persist OTHER users' avatars (documentDirectory/avatar-saved).
  // Fires whenever the conversation set's email roster changes — refs
  // dedup so a no-op state update (same set) doesn't re-trigger. Run
  // independently of the prewarm hook so it works even when the list
  // is re-loaded from the silent delta sync (focus refresh).
  const _avatarPrefetchHashRef = useRef('');
  useEffect(() => {
    if (Platform.OS === 'web') return;
    if (!Array.isArray(conversations) || conversations.length === 0) return;
    // Collect unique peer emails. WhatsApp parity: each row has either a
    // 1:1 peer (other_email / peer) or a group (members[]). Drag both
    // shapes so group rows also seed members' faces.
    const emailsSet = new Set();
    for (const c of conversations) {
      if (!c) continue;
      const candidates = [
        c.other_email, c.peer, c.peer_email,
      ];
      for (const e of candidates) {
        if (typeof e === 'string' && e.includes('@')) emailsSet.add(e.toLowerCase());
      }
      if (Array.isArray(c.members)) {
        for (const m of c.members) {
          if (m && typeof m.email === 'string' && m.email.includes('@')) {
            emailsSet.add(m.email.toLowerCase());
          }
        }
      }
    }
    if (emailsSet.size === 0) return;
    const emails = Array.from(emailsSet).sort();
    const hash = emails.join('|');
    if (hash === _avatarPrefetchHashRef.current) return;
    _avatarPrefetchHashRef.current = hash;
    // Defer one frame so the initial render commits before the network
    // pool fills up. cacheAvatar's 3-slot semaphore keeps it bounded.
    const kick = setTimeout(() => {
      prefetchAvatarsForList(emails).catch(() => {});
    }, 800);
    return () => clearTimeout(kick);
  }, [conversations]);

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
      // WhatsApp parity: prewarm ALL conversations with last 50 msgs each so
      // tapping any chat paints instantly from local cache, not just the top
      // 10. Concurrency=3 keeps the hit on cold start bounded; the bulk of
      // work happens 1-2s after chat list mount and never blocks UI.
      prewarmConversationsCache(conversations, { topN: 50, perConv: 50, concurrency: 3 }).catch(() => {});
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
      // Read-current active conv at the moment each WS event fires (not at
      // effect-mount time) — getActiveConversation is updated by
      // chat-conversation.js on every mount/unmount.
      const { getActiveConversation } = require('../services/pushNotifications');
      const activeConvId = () => { try { return getActiveConversation(); } catch { return null; } };

      // Subscribe to the user's personal chat channel. The backend emits
      // `chat_summary` events to `chat_user_{email}` whenever any
      // conversation the user is in receives a new message (WhatsApp-style
      // channel split). Without this subscribe, the WS hub drops the
      // event silently and the list never updates the last-message
      // preview / unread badge / reorder. Bug reported 2026-04-19.
      if (user?.email) {
        try { mailWs.subscribe(`chat_user_${user.email}`); } catch {}
      }

      // Global lives channel — instant home-strip updates when ANY user
      // goes live or ends their live. Without this, the strip waits up to
      // 45s for the next live_list poll. Two events:
      //   live_started — push entry into livesByEmail
      //   live_ended   — remove entry from livesByEmail
      try { mailWs.subscribe('lives_global'); } catch {}
      unsubs.push(mailWs.on('live_started', (payload) => {
        const data = payload?.data || payload || {};
        const email = (data.host_email || '').toLowerCase();
        if (!email || email === (user?.email || '').toLowerCase()) return;
        // [WAVE 38 2026-05-20] BEFORE: o handler retornava `prev` sem update
        // se já houvesse entry pra esse email — isso causava bug "AO VIVO
        // mostra session antiga". Cenário: host A inicia live #1, fecha
        // (live_ended limpa), inicia live #2 imediato. Em race, live_list
        // tick antigo poderia ter recriado a entry de #1 antes do
        // live_started #2 chegar — e o handler ignorava o evento novo. Agora
        // SEMPRE atualiza a entry com o session_id + host_name novos.
        // Stale-protection: comparamos started_at (se vier) com 6h
        // freshness gate igual o Profile.js (WAVE 37) pra rejeitar replay
        // de eventos durante reconnect.
        if (data.started_at) {
          try {
            const startedMs = new Date(data.started_at).getTime();
            if (Number.isFinite(startedMs) && (Date.now() - startedMs) > 6 * 3600 * 1000) {
              console.warn('[ChatListTab.live] ignoring stale live_started echo, age>6h');
              return;
            }
          } catch {}
        }
        setLivesByEmail(prev => {
          const existing = prev[email];
          const sid = data.session_id;
          // Same session_id already painted? Skip — no churn.
          if (existing && String(existing.id || '') === String(sid)) return prev;
          // Different session → replace (host re-broadcast scenario).
          return { ...prev, [email]: { id: sid, host_name: data.host_name || email.split('@')[0], viewer_count: 0 } };
        });
      }));
      unsubs.push(mailWs.on('live_ended', (payload) => {
        const data = payload?.data || payload || {};
        const email = (data.host_email || '').toLowerCase();
        const sid = String(data.session_id || data.id || '');
        // Drop by EITHER host_email OR session_id — server payloads vary
        // (auto-staled lives carry both; legacy `live_end` from WS path may
        // carry only host_email or only session_id depending on which hub
        // forwarded it). Belt-and-suspenders so the strip always clears.
        if (!email && !sid) return;
        // [#1161, 2026-05-18] Stamp the per-host end timestamp so an
        // in-flight live_list poll that lands AFTER this WS event can't
        // resurrect the badge. See `liveEndedAtByHostRef` declaration.
        // We resolve host_email from the entry when the payload only
        // carries session_id — covers both legacy + CF live_end payloads.
        const stampedHosts = new Set();
        if (email) stampedHosts.add(email);
        setLivesByEmail(prev => {
          let mutated = false;
          const next = { ...prev };
          for (const k of Object.keys(prev)) {
            const entry = prev[k];
            if (email && k === email) { delete next[k]; mutated = true; stampedHosts.add(k); continue; }
            if (sid && String(entry?.id || '') === sid) { delete next[k]; mutated = true; stampedHosts.add(k); }
          }
          return mutated ? next : prev;
        });
        const now = Date.now();
        try {
          stampedHosts.forEach((h) => {
            if (h) liveEndedAtByHostRef.current[h] = now;
          });
        } catch {}
      }));

      unsubs.push(mailWs.on('typing', (data) => {
        if (!data?.conversation_id || data?.email === user?.email) return;
        const name = emailToDisplayName(data.name || data.email || '');
        const convId = data.conversation_id;
        // Track an ARRAY of names per conversation so a group with several
        // people typing shows "Ana, João estão digitando…" instead of
        // flickering between single names. Each typer has its own 3s expiry
        // timer keyed by "convId::name" so one person stopping doesn't reset
        // the others. typingUsers[convId] is normalized to an array; the row
        // renderer joins it.
        setTypingUsers(prev => {
          const cur = prev[convId];
          const arr = Array.isArray(cur) ? cur : (cur ? [cur] : []);
          if (arr.includes(name)) return prev;
          return { ...prev, [convId]: [...arr, name] };
        });
        const tkey = `${convId}::${name}`;
        if (typingTimeoutsRef.current[tkey]) clearTimeout(typingTimeoutsRef.current[tkey]);
        typingTimeoutsRef.current[tkey] = setTimeout(() => {
          setTypingUsers(prev => {
            const cur = prev[convId];
            const arr = Array.isArray(cur) ? cur : (cur ? [cur] : []);
            const left = arr.filter(n => n !== name);
            const next = { ...prev };
            if (left.length) next[convId] = left;
            else delete next[convId];
            return next;
          });
          delete typingTimeoutsRef.current[tkey];
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
        // Task #886 — auto-download voice notes the instant the WS event lands,
        // even when the user is NOT inside the conversation. WhatsApp parity:
        // by the time the user opens the chat the audio is already on disk and
        // plays offline-clean. Other media types (image/video/file) still use
        // the in-conversation `_isHeavyByUrl` cellular gate via tap-to-DL.
        // Fire-and-forget; force:true because audio is tiny (~50KB-300KB) and
        // we never want the cellular gate to defer voice — it would feel laggy.
        // Refs to avoid closure stale: data.* is read fresh each event.
        try {
          const t = String(data?.type || '').toLowerCase();
          if ((t === 'audio' || t === 'voice') && data?.file_url && Platform.OS !== 'web') {
            const remote = api.getMediaUrl(data.file_url);
            if (remote) {
              // Shared #886 helper — writes to permanent dir (matches
              // chat-conversation path), logs [audio_offline], idempotent.
              const { prefetchAudioMessage } = require('../services/mediaCache');
              prefetchAudioMessage(remote).catch(() => {});
            }
          }
        } catch {}
        // [STAGE-E 2026-05-20 GAP#3] WhatsApp parity: conversation moves
        // to top INSTANTLY on new message. Drop 100ms debounce → 0 so the
        // list shifts in the same frame as the WS event. LayoutAnimation
        // smooths the move. Bursts still coalesce naturally because React
        // batches state updates per frame.
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
          // WhatsApp parity: auto-unarchive when a new message lands in an
          // archived conversation. Without this, msgs would sit silent in
          // the archived bucket until the user browsed there. WhatsApp's
          // default is to re-promote (the "Keep Chats Archived" setting,
          // which we don't expose yet, would be the only way to opt out).
          // We capture the archived row here so the setConversations branch
          // below can re-insert it with full metadata instead of building a
          // bare placeholder.
          let unarchivedConv = null;
          setArchivedConversations(prevArch => {
            const ai = prevArch.findIndex(c => c.id == data.conversation_id || c.conversation_id == data.conversation_id);
            if (ai === -1) return prevArch;
            // WhatsApp parity: a MUTED archived chat stays archived when a new
            // message lands — muting is the user's explicit "leave it in the
            // archive" signal. We just bump its last_message in place so the
            // archived bucket shows the fresh preview, and skip the promote.
            if (prevArch[ai].muted) {
              const senderLc = String(data.sender_email || data.sender || '').toLowerCase();
              const meLc = String(user?.email || '').toLowerCase();
              const nextArch = [...prevArch];
              nextArch[ai] = {
                ...nextArch[ai],
                last_message: {
                  ...(nextArch[ai].last_message || {}),
                  content: data.content || data.message,
                  type: data.type || 'text',
                  sender_email: data.sender_email || data.sender,
                  sender_name: data.sender_name || data.sender_email || data.sender,
                  created_at: data.created_at || new Date().toISOString(),
                },
                last_message_type: data.type || 'text',
                last_message_sender: data.sender_email || data.sender,
                last_message_at: data.created_at || new Date().toISOString(),
                unread_count: senderLc === meLc ? (nextArch[ai].unread_count || 0) : ((nextArch[ai].unread_count || 0) + 1),
              };
              return nextArch;
            }
            unarchivedConv = { ...prevArch[ai], archived: 0 };
            // Persist the unarchive server-side so the next chat_list fetch
            // doesn't bounce the conv back into the archived bucket.
            try { api.chatArchive(unarchivedConv.id, false).catch(() => {}); } catch {}
            const nextArch = [...prevArch];
            nextArch.splice(ai, 1);
            return nextArch;
          });
          let nextConvsForCache = null;
          setConversations(prev => {
            const idx = prev.findIndex(c => c.id == data.conversation_id || c.conversation_id == data.conversation_id);
            if (idx === -1 && unarchivedConv) {
              // Conv was archived — promote it to top with the fresh msg.
              const senderLc = String(data.sender_email || data.sender || '').toLowerCase();
              const meLc = String(user?.email || '').toLowerCase();
              const promoted = {
                ...unarchivedConv,
                archived: 0,
                last_message: {
                  ...(unarchivedConv.last_message || {}),
                  content: data.content || data.message,
                  type: data.type || 'text',
                  sender_email: data.sender_email || data.sender,
                  sender_name: data.sender_name || data.sender_email || data.sender,
                  created_at: data.created_at || new Date().toISOString(),
                },
                last_message_type: data.type || 'text',
                last_message_sender: data.sender_email || data.sender,
                last_message_at: data.created_at || new Date().toISOString(),
                unread_count: senderLc === meLc ? 0 : ((unarchivedConv.unread_count || 0) + 1),
              };
              const pinned = prev.filter(c => !!c.pinned);
              const unpinned = prev.filter(c => !c.pinned);
              nextConvsForCache = [...pinned, promoted, ...unpinned];
              return nextConvsForCache;
            }
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
              // Don't bump unread for a message landing IN the chat the user
              // is currently inside — they're reading it now, so the badge
              // should stay at 0. Without this guard, every msg WS event
              // (including own outbound echoes from other devices) bumped
              // the list badge by 1 even when the conv was open, so the
              // user backed out and saw "ghost" unread for a chat they had
              // just been reading. activeConvId is set by chat-conversation.js
              // on mount and cleared on unmount.
              unread_count: (isSelf || (() => { const a = activeConvId(); return a && String(a) === String(data.conversation_id); })()) ? (prev[idx].unread_count || 0) : ((prev[idx].unread_count || 0) + 1),
            };
            // Keep pinned conversations at top, insert updated after pinned
            const pinned = prev.filter((c, i) => i !== idx && !!c.pinned);
            const unpinned = prev.filter((c, i) => i !== idx && !c.pinned);
            if (updated.pinned) {
              nextConvsForCache = [updated, ...pinned.filter(c => c.id !== updated.id), ...unpinned];
              return nextConvsForCache;
            }
            nextConvsForCache = [...pinned, updated, ...unpinned];
            return nextConvsForCache;
          });
          // Web: persist the incrementally-updated list to IndexedDB so a page
          // reload paints the moved conversation + new last_message instantly
          // instead of re-fetching (skeleton flash / "perpetual re-sync").
          // Native reloads via loadConversations elsewhere; the idx===-1
          // placeholder branch already triggers loadConversations(false), which
          // caches on its own — so only the promoted/updated paths need this.
          if (Platform.OS === 'web' && nextConvsForCache) {
            try { cacheConversations(nextConvsForCache).catch(() => {}); } catch {}
          }
        }, 0);
      };
      unsubs.push(mailWs.on('chat_message', onIncomingForList));
      // chat_summary is the new per-user-channel event introduced by the
      // WhatsApp-style channel split in chat.php. Recipients receive it
      // INSTEAD of chat_message, so the list has to listen to both to cover
      // old-server (still firing chat_message) and new-server paths.
      unsubs.push(mailWs.on('chat_summary', onIncomingForList));

      // Backend broadcasts `delete`/`edit` when a message is deleted-for-all
      // or edited. The list never subscribed to these, so a deleted/edited
      // LAST message left a stale preview ("Mensagem apagada" never showed,
      // and edits never updated the row text) until a fresh message landed
      // or a manual chat_list refetch ran. We only touch the row when the
      // affected message IS the conversation's last_message — older messages
      // don't drive the preview.
      const _delMsgId = (d) => d?.message_id ?? d?.id ?? d?.msg_id;
      unsubs.push(mailWs.on('delete', (data) => {
        const convId = data?.conversation_id;
        const mid = _delMsgId(data);
        if (convId == null || mid == null) return;
        setConversations(prev => {
          const idx = prev.findIndex(c => c.id == convId || c.conversation_id == convId);
          if (idx === -1) return prev;
          const lm = prev[idx].last_message;
          if (!lm || String(lm.id) !== String(mid)) return prev;
          const tomb = t('chatConv.deletedMessage') || 'Mensagem apagada';
          return prev.map((c, i) => {
            if (i !== idx) return c;
            return {
              ...c,
              last_message: {
                ...lm,
                content: tomb,
                type: 'text',
                file_url: null,
                file_name: null,
                deleted_at: data?.deleted_at || new Date().toISOString(),
              },
            };
          });
        });
      }));
      unsubs.push(mailWs.on('edit', (data) => {
        const convId = data?.conversation_id;
        const mid = _delMsgId(data);
        if (convId == null || mid == null) return;
        const newContent = data?.content ?? data?.message ?? data?.new_content;
        if (newContent == null) return;
        setConversations(prev => {
          const idx = prev.findIndex(c => c.id == convId || c.conversation_id == convId);
          if (idx === -1) return prev;
          const lm = prev[idx].last_message;
          if (!lm || String(lm.id) !== String(mid)) return prev;
          return prev.map((c, i) => {
            if (i !== idx) return c;
            return {
              ...c,
              last_message: {
                ...lm,
                content: newContent,
                edited_at: data?.edited_at || new Date().toISOString(),
              },
            };
          });
        });
      }));

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
      // AppState bg→fg grace (2026-05-18 #1143, "never-fall" UX): every
      // time the app comes back to foreground we record the timestamp.
      // The very first WS close that lands inside the 3s window after a
      // resume is a sleep/wake blip (radio woke up slower than the JS
      // socket), NOT a real disconnect — we extend the banner suppress to
      // 15s so the auto-heal cycle completes silently. Without this, every
      // unlock surfaced "Reconectando…" for a few seconds and the user
      // thought the app was always reconnecting.
      let lastForegroundTs = Date.now();
      const fgGraceAppStateSub = AppState.addEventListener('change', (s) => {
        if (s === 'active') lastForegroundTs = Date.now();
      });
      unsubs.push(() => { try { fgGraceAppStateSub.remove(); } catch {} });
      unsubs.push(mailWs.on('connection', (data) => {
        if (data?.status === 'authenticated') {
          if (!wasConnected) {
            try { loadConversations(false); } catch {}
            // [#1211 2026-05-19] PHONE-FIRST CATCH-UP: pull every event missed
            // for known convs since their last-seen pts and let chatSync
            // mirror the new_message hydrated rows into SQLite (the applyEvents
            // SQLite hook lives in services/chatSync.js). Before this, only
            // the conv list was refreshed on reconnect; missed messages for
            // convs the user wasn't actively viewing never landed on disk —
            // they'd show up briefly on the chat-conversation screen via
            // applyEvents but disappear on cold start. With this hook the
            // device DB stays in sync regardless of which screen is up.
            // We pull conv IDs from the cached chat list (chatCache) instead
            // of the React state closure (which can be stale at WS-connect
            // time) so cold-start reconnects catch up correctly.
            (async () => {
              try {
                const { getCachedConversations } = require('../services/chatCache');
                const cs = (await getCachedConversations?.()) || [];
                const ids = (Array.isArray(cs) ? cs : [])
                  .map(c => Number(c?.id))
                  .filter(n => Number.isFinite(n) && n > 0)
                  .slice(0, 200);
                if (ids.length === 0) return;
                const { syncConversations: _syncConvs, applyEvents: _applyEv } = require('../services/chatSync');
                if (typeof _syncConvs !== 'function') return;
                const perConv = await _syncConvs(ids);
                if (!Array.isArray(perConv)) return;
                for (const c of perConv) {
                  try {
                    // No-op setMessages — applyEvents will mirror to SQLite
                    // via the chatCache hook inside chatSync.applyEvents.
                    _applyEv?.(c.events || [], null, () => {}, c.messages || []);
                  } catch {}
                }
              } catch {}
            })();
          }
          wasConnected = true;
          if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
          // Fade-out (500ms) instead of an abrupt flip when we reconnect.
          // If the banner never painted, the fade is a no-op since opacity
          // resets to 1 on the next show. Match WhatsApp's reconnect-pill
          // dismiss animation so the recovery feels smooth.
          if (wsDownBannerOpacity.__lastShown) {
            Animated.timing(wsDownBannerOpacity, {
              toValue: 0, duration: 500, useNativeDriver: true,
            }).start(({ finished }) => {
              if (finished) {
                setWsDownBanner(false);
                wsDownBannerOpacity.setValue(1);
                wsDownBannerOpacity.__lastShown = false;
              }
            });
          } else {
            setWsDownBanner(false);
          }
        } else if (data?.status === 'disconnected') {
          wasConnected = false;
          if (!bannerTimer) {
            // Base suppress = 12s (most reconnects on flaky cellular heal
            // under 10s). If we JUST returned from background (<3s ago),
            // extend to 15s — sleep/wake blips need extra slack because
            // the OS radio takes 1-2s to renegotiate before the WS can
            // even attempt to handshake.
            const sinceForeground = Date.now() - lastForegroundTs;
            const suppressMs = sinceForeground < 3000 ? 15000 : 12000;
            bannerTimer = setTimeout(() => {
              if (!wasConnected && !mailWs.isConnected) {
                wsDownBannerOpacity.setValue(1);
                wsDownBannerOpacity.__lastShown = true;
                setWsDownBanner(true);
              }
              bannerTimer = null;
            }, suppressMs);
          }
        }
      }));
      unsubs.push(() => { if (bannerTimer) clearTimeout(bannerTimer); });

      // Watchdog: poll the live socket while the banner is visible. Covers
      // the iOS race where the 'authenticated' event gets dropped after the
      // OS resumes the radio — without this, the banner sits forever even
      // though chat is fully online. Also kicks ensureHealthy() so a dead
      // socket reconnects without waiting for the next NetInfo flap.
      // WhatsApp parity (2026-05-17): bumped 3000 → 1500 so the banner
      // clears within 1.5s of WS heal (was sticking up to 3s after recovery
      // because the 'authenticated' event would sometimes race the watchdog
      // tick). Also fires ensureHealthy() twice as often on a dead socket so
      // a stuck connection self-repairs faster on flaky cellular.
      const healWatchdog = setInterval(() => {
        try {
          if (mailWs?.isConnected) {
            if (bannerTimer) { clearTimeout(bannerTimer); bannerTimer = null; }
            wasConnected = true;
            setWsDownBanner(false);
          } else if (!wasConnected && mailWs?.ensureHealthy) {
            mailWs.ensureHealthy(1000).catch(() => {});
          }
        } catch {}
      }, 1500);
      unsubs.push(() => clearInterval(healWatchdog));

      // Real-time reaction toast — peer reacted to MY status. Suppress on
      // own-device echoes (rare, but in case the WS server fans-out a self
      // event during multi-device). Removed reactions don't toast.
      unsubs.push(mailWs.on('status_reaction', (data) => {
        try {
          if (!data || data?.removed) return;
          const reactor = String(data.reactor_email || data.viewer_email || '').toLowerCase();
          if (!reactor || reactor === (user?.email || '').toLowerCase()) return;
          const emoji = String(data.emoji || '').slice(0, 8);
          if (!emoji) return;
          const reactorName = String(data.reactor_name || reactor.split('@')[0] || '').slice(0, 40);
          setReactionToast({
            reactor_name: reactorName,
            reactor_email: reactor,
            emoji,
            status_id: data.status_id,
          });
          if (reactionToastTimer.current) clearTimeout(reactionToastTimer.current);
          // Slide in, then schedule slide-out at 3.5s.
          Animated.spring(reactionToastY, { toValue: 0, useNativeDriver: true, friction: 8 }).start();
          reactionToastTimer.current = setTimeout(() => {
            Animated.timing(reactionToastY, { toValue: -120, duration: 220, useNativeDriver: true })
              .start(() => setReactionToast(null));
          }, 3500);
        } catch {}
      }));
      unsubs.push(() => { if (reactionToastTimer.current) clearTimeout(reactionToastTimer.current); });
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

      // Native AppState backup — the WS 'foreground' event only fires when
      // the WS is still connected. If the device suspended long enough that
      // the socket died (iOS aggressively kills idle connections after ~30s
      // background), the WS reconnect handler runs but the foreground event
      // never reaches us. AppState fires regardless of WS state, so we
      // refresh the list directly. Throttled to 2s to avoid double-fires
      // alongside the WS path.
      let lastAppStateRefresh = 0;
      const _onAppStateChange = (next) => {
        if (next !== 'active') return;
        const now = Date.now();
        if (now - lastAppStateRefresh < 2000) return;
        lastAppStateRefresh = now;
        try { loadConversations(false); } catch {}
      };
      const appStateSub = AppState.addEventListener('change', _onAppStateChange);
      unsubs.push(() => { try { appStateSub?.remove?.(); } catch {} });
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
        // Bug 2026-05-12: subscribe-then-query, not the other way
        // around. The previous order left a window where the server
        // had no record we were watching these emails, so any
        // online/offline change in those few milliseconds reached us
        // through the 15s poll only. Now any state change from t=0
        // pushes to us instantly.
        mailWs.watchPresence(dmEmails);
        mailWs.queryPresence(dmEmails);
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
        // Re-render not only when online/offline flips but also when last_seen
        // advances (peer went offline → "visto por último" timestamp moves).
        // Without the last_seen check the row's subtitle stayed frozen on a
        // stale "visto às HH:MM" after the first offline broadcast.
        if (!cur || cur.status !== newVal.status || cur.last_seen !== newVal.last_seen) {
          const merged = new Map(presencesRef.current);
          merged.set(data.email, newVal);
          presencesRef.current = merged;
          setPresenceVersion(v => v + 1);
        }
      }
    });

    // Query immediately + then every 45s as a backstop. Real-time
    // updates already flow via the `presence` WS event (handler above)
    // — the periodic poll is just to catch missed broadcasts after WS
    // reconnects or transient hiccups. WhatsApp uses ~60s; we go
    // slightly tighter at 45s to feel snappier without burning battery.
    queryDmPresences();
    intervalId = setInterval(queryDmPresences, 45000);

    return () => {
      unsubResult?.();
      unsubPresence?.();
      if (intervalId) clearInterval(intervalId);
    };
  }, [conversations, user?.email]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    loadConversations(false);
    // [WAVE 93 2026-05-21] Refresh the Status strip too when the user pulls
    // to refresh. Without this the strip's last-known data sat stale for
    // up to the poll cadence (now 45s) even though the user explicitly
    // requested fresh data. The hook's refetch is debounced + fingerprint-
    // diffed so a no-change response is a free no-op render-wise.
    try {
      const ev = require('./statusRefreshBus').default;
      ev.emit?.('refresh');
    } catch {}
  }, [loadConversations]);

  // Pull-to-refresh sync: when the user pulls from the very top of the list,
  // negative scrollY translates the StatusStoriesRow downward so the strip
  // tracks the gesture instead of the spinner appearing in front of a static
  // strip. Only kicks in for negative offsets (overscroll); regular scroll
  // leaves the strip in place. Native driver because translateY only.
  const pullTranslateY = useRef(new Animated.Value(0)).current;
  const onListScroll = useCallback((e) => {
    const y = e?.nativeEvent?.contentOffset?.y;
    if (typeof y !== 'number') return;
    // Damp by 0.6 so the strip doesn't out-pace the pull (matches iOS feel).
    pullTranslateY.setValue(y < 0 ? Math.max(y * 0.6, -120) : 0);
  }, [pullTranslateY]);

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
    // Saved Messages — self-chat conversation gets routed to the dedicated
    // /saved-messages screen (Telegram-parity: tabs, search-within, header
    // reminders, "Cabeçalho" insert). The conv itself is the same backend
    // row — saved-messages screen redirects into chat-conversation with
    // saved=1 so all the rendering stays shared.
    const peerLc = String(otherEmail || '').toLowerCase();
    const isSelf = conv.type === 'saved' || (conv.type === 'direct' && peerLc && peerLc === meLc);
    if (isSelf) {
      router.push('/saved-messages');
      return;
    }
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
    // Biometric gate: deleting a chat is destructive (wipes local cache +
    // server row + remote-storage media) and irreversible. Require Face ID
    // / fingerprint / device passcode before we proceed so a momentarily
    // unattended phone can't have its history nuked.
    try {
      const { confirmWithBiometric } = require('../services/biometricGate');
      const ok = await confirmWithBiometric({
        reason: (t?.('chat.deleteConfirmBio')) || 'Confirme para apagar a conversa',
      });
      if (!ok) return;
    } catch {}
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
  }, [t]);

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
    const willPin = !conv.pinned;

    // WhatsApp parity: at most MAX_PINNED_CHATS (3) conversations can be
    // pinned. When the user pins a 4th, silently unpin the oldest pin (the
    // one with the earliest last_message_at — best proxy for "stale pin"
    // when we don't have a pinned_at column) so the user never hits a wall.
    let displaceId = null;
    if (willPin) {
      const currentPins = conversations.filter(c => !!c.pinned && c.id !== conv.id);
      if (currentPins.length >= MAX_PINNED_CHATS) {
        const _recency = (c) => new Date(
          c.last_message_at || c.last_message?.created_at || c.updated_at || c.last_activity || 0
        ).getTime();
        const oldest = currentPins.slice().sort((a, b) => _recency(a) - _recency(b))[0];
        displaceId = oldest?.id || null;
      }
    }

    // Optimistic toggle (plus displacement) so swipe feels instant.
    setConversations(prev => prev.map(c => {
      if (c.id === conv.id) return { ...c, pinned: willPin };
      if (displaceId && c.id === displaceId) return { ...c, pinned: false };
      return c;
    }));

    try {
      // chat_pin pins a MESSAGE (needs message_id). For pinning the whole
      // conversation to top of the list we need chat_pin_conversation which
      // in email.php maps to the chat_favorite/chat_pin_conversation case.
      if (displaceId) {
        // Server-side toggle for the displaced row first, so when the
        // refetch lands below it reflects the new ordering.
        try { await api.apiCall('chat_pin_conversation', { conversation_id: displaceId }, 'POST'); } catch {}
      }
      await api.apiCall('chat_pin_conversation', { conversation_id: conv.id }, 'POST');
      loadConversations(false);
    } catch {
      // Revert optimistic toggles on error.
      setConversations(prev => prev.map(c => {
        if (c.id === conv.id) return { ...c, pinned: !willPin };
        if (displaceId && c.id === displaceId) return { ...c, pinned: true };
        return c;
      }));
    }
  }, [conversations, loadConversations]);

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
      // Spam report — confirm-then-fire. Optimistic: we don't change list state,
      // just notify backend and rely on shadowban tally server-side.
      onReportSpam: async (conv) => {
        const ok = await confirm?.({
          title: t('chat.reportSpam') || 'Reportar como spam',
          message: t('chat.reportSpamConfirm') || 'O remetente será marcado e poderá ter sua busca por número desativada se houver mais relatos.',
          confirmLabel: t('chat.report') || 'Reportar',
          destructive: true,
        });
        if (ok === false) return; // confirm may be undefined in legacy paths
        try { await api.chatReportSpam(conv.id, ''); } catch (e) { console.warn('[chatReportSpam]', e?.message); }
      },
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
      const confirmClear = async () => {
        const ok = await confirm({
          title: t('chat.clearChat') || 'Limpar conversa',
          message: t('chat.clearChatConfirm') || 'Apagar todas as mensagens? A conversa permanece na lista.',
          confirmLabel: t('chat.clear') || 'Limpar',
          destructive: true,
        });
        if (!ok) return;
        try { await api.chatClearHistory(conv.id); } catch {}
        setConversations(prev => prev.map(c => c.id === conv.id ? { ...c, last_message: '', last_message_at: c.last_message_at } : c));
      };
      const confirmBlock = async () => {
        if (!peerEmail) return;
        const ok = await confirm({
          title: (t('chat.blockUser') || 'Bloquear') + '?',
          message: t('chat.blockUserConfirm') || 'Vocês não vão mais trocar mensagens nem chamadas.',
          confirmLabel: t('chat.block') || 'Bloquear',
          destructive: true,
        });
        if (!ok) return;
        try { await api.chatBlockUser(peerEmail); } catch {}
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
  // Per-pin size: cada conversa fixada tem seu proprio tamanho. Antes era um
  // global ('m' aplicado a todos), user pediu pra individualizar
  // ("pode ser um tamanho na ordem que a pessoa quiser"). pinnedSize global
  // vira o DEFAULT pra novas pins; pinnedSizes[id] sobrescreve por item.
  const [pinnedSize, setPinnedSize] = useState('m');           // 's' | 'm' | 'l' default
  const [pinnedSizes, setPinnedSizes] = useState({});          // { [convId]: 's'|'m'|'l' }
  const [pinnedEditMode, setPinnedEditMode] = useState(false);
  // Persist a flag so the "Toque pra mudar tamanho" hint only shows the
  // FIRST time the user enters edit mode. After tapping "Pronto" once,
  // we stop rendering the hint pill (was overlapping pin cards).
  const [pinnedHintSeen, setPinnedHintSeen] = useState(true);
  useEffect(() => {
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const v = await AsyncStorage.getItem(userScopedKey('chatyy:pinned_resize_hint_seen_v1'));
        setPinnedHintSeen(v === '1');
      } catch { setPinnedHintSeen(false); }
    })();
  }, [userScopedKey]);
  const markPinnedHintSeen = useCallback(() => {
    setPinnedHintSeen(true);
    try {
      const AsyncStorage = require('@react-native-async-storage/async-storage').default;
      AsyncStorage.setItem(userScopedKey('chatyy:pinned_resize_hint_seen_v1'), '1').catch(() => {});
    } catch {}
  }, [userScopedKey]);
  const [pinDraggingId, setPinDraggingId] = useState(null);
  const pinDragTxRef = useRef(new Map());                      // id → Animated.Value(translateX)
  const pinWiggleAnim = useRef(new Animated.Value(0)).current; // shared wiggle driver
  // [7173 polish 2026-05-22] Subtle spring "pop" when long-press enters edit
  // mode — matches iOS Home-screen jiggle entrance. One-shot 1 → 1.04 → 1.
  const pinEntrancePop = useRef(new Animated.Value(1)).current;
  // Hydrate prefs on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const o = await AsyncStorage.getItem(userScopedKey('chatyy:pinned_order_v1'));
        const s = await AsyncStorage.getItem(userScopedKey('chatyy:pinned_size_v1'));
        const sm = await AsyncStorage.getItem(userScopedKey('chatyy:pinned_sizes_v1'));
        if (cancelled) return;
        if (o) { try { const arr = JSON.parse(o); if (Array.isArray(arr)) setPinnedOrder(arr); } catch {} }
        if (s === 's' || s === 'l') setPinnedSize(s);
        if (sm) {
          try {
            const m = JSON.parse(sm);
            if (m && typeof m === 'object') setPinnedSizes(m);
          } catch {}
        }
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
  // Cicla S → M → L → S pra UM pin so. Chamado quando user toca o avatar
  // em edit mode. Persiste o mapa inteiro como JSON (poucos KB no max).
  const cyclePinSize = useCallback((id) => {
    // Bug 2026-05-04: pinDragTxRef ficava STALE depois de um drag, e quando
    // user cycava tamanho o avatar desenhava com translateX antigo (saia da
    // tela cortado pela esquerda no print SC). Resetar todos os tx aqui
    // garante layout limpo a cada mudanca de tamanho.
    try {
      pinDragTxRef.current.forEach(v => { try { v.setValue(0); } catch {} });
    } catch {}
    setPinnedSizes(prev => {
      const cur = prev[id] || pinnedSize || 'm';
      const next = cur === 's' ? 'm' : cur === 'm' ? 'l' : 's';
      const out = { ...prev, [id]: next };
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        AsyncStorage.setItem(userScopedKey('chatyy:pinned_sizes_v1'), JSON.stringify(out)).catch(() => {});
      } catch {}
      return out;
    });
  }, [pinnedSize]);
  // Helper que retorna o tamanho efetivo de um pin (override individual,
  // fallback pro default global).
  const getPinSize = useCallback((id) => pinnedSizes[id] || pinnedSize || 'm', [pinnedSizes, pinnedSize]);
  // Wiggle loop while in edit mode (subtle ±1.8°).
  useEffect(() => {
    // Reset translateX SEMPRE no toggle (entrada OU saida do edit mode), pra
    // garantir que avatares nao herdam tx residual de drags antigos. Sem isso
    // o user reportou (foto 2026-05-04) "SC saindo cortado pela esquerda
    // depois de trocar tamanho" — wrapper recalcula width mas tx fica stale.
    try {
      pinDragTxRef.current.forEach(v => { try { v.setValue(0); } catch {} });
    } catch {}
    if (!pinnedEditMode) {
      pinWiggleAnim.setValue(0);
      // Reset entrance pop so next enter replays cleanly.
      try { pinEntrancePop.setValue(1); } catch {}
      return undefined;
    }
    // [7173 polish 2026-05-22] One-shot spring pop on edit-mode entry.
    // 1 → 1.04 → 1, ~280ms total. Runs ONCE per entry, not in the loop.
    Animated.sequence([
      Animated.spring(pinEntrancePop, { toValue: 1.04, tension: 260, friction: 7, useNativeDriver: true }),
      Animated.spring(pinEntrancePop, { toValue: 1, tension: 200, friction: 8, useNativeDriver: true }),
    ]).start();
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pinWiggleAnim, { toValue: 1, duration: 110, useNativeDriver: true }),
        Animated.timing(pinWiggleAnim, { toValue: -1, duration: 220, useNativeDriver: true }),
        Animated.timing(pinWiggleAnim, { toValue: 0, duration: 110, useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pinnedEditMode, pinWiggleAnim, pinEntrancePop]);

  // ─── Draft indicators (AsyncStorage-backed) ───
  // Live-updated via DeviceEventEmitter: every keystroke that autosaves a
  // draft in chat-conversation emits a 'chatyy:draft' event; we patch the
  // map in place so the list shows "Rascunho: ..." immediately without
  // waiting for a re-render of the whole conversations array.
  const [drafts, setDrafts] = useState({});
  // Tracks when each draft was last edited in this session (audit gap #2 —
  // draft timestamp relative). Persisted alongside the draft text so the row
  // can show a stale-draft hint after >1h. Initial hydrate has no real
  // timestamp; we approximate "old" by leaving it null and only painting
  // the urgent red color once we see a fresh edit event during the session.
  const [draftTimes, setDraftTimes] = useState({});
  // Feature C — drafts grouping: collapsible "Rascunhos" section at top
  // when 2+ drafts exist. Default = collapsed if 3+, expanded if exactly 2.
  const [draftsSectionOpen, setDraftsSectionOpen] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        const keys = await AsyncStorage.getAllKeys();
        // Drafts live under the per-user scoped prefix produced by
        // userScopedKey(`chat_draft_<id>`) — i.e. "u:<email>:chat_draft_<id>".
        // We ONLY read scoped keys. Legacy unscoped `chat_draft_<id>` from
        // pre-scoping sessions used to surface here as ghost drafts ("Rascunho:
        // We" no Rene Reis sem haver rascunho real — print 2026-05-05) porque
        // o clearDraft so removia a chave scoped, deixando a legacy gravada
        // pra sempre. Garbage-collect aqui tambem (deleta keys legacy).
        const scopedPrefix = userScopedKey('chat_draft_');
        const legacyPrefix = 'chat_draft_';
        const scopedKeys = keys.filter(k => k.startsWith(scopedPrefix));
        const legacyKeys = keys.filter(k => k.startsWith(legacyPrefix) && !k.startsWith(scopedPrefix));
        if (legacyKeys.length > 0) {
          AsyncStorage.multiRemove(legacyKeys).catch(() => {});
        }
        if (scopedKeys.length === 0) { if (alive) setDrafts({}); return; }
        const pairs = await AsyncStorage.multiGet(scopedKeys);
        const d = {};
        for (const [key, val] of pairs) {
          if (val && val.trim()) {
            const convId = key.slice(scopedPrefix.length);
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
        const cid = String(p.conversationId);
        setDrafts(prev => {
          const next = { ...prev };
          const t = (p.text || '').trim();
          if (t) next[cid] = t;
          else delete next[cid];
          return next;
        });
        // Stamp the edit time on every draft event (audit gap #2) so the row
        // can fade red→grey as the draft ages past 1h.
        setDraftTimes(prev => {
          const next = { ...prev };
          if ((p.text || '').trim()) next[cid] = Date.now();
          else delete next[cid];
          return next;
        });
      });
      return () => sub.remove();
    } catch { return undefined; }
  }, []);

  // Locked-chats partition. Mirrors WhatsApp's "Conversas trancadas" hidden
  // folder: locked rows are pulled out of the main list so a glance at the
  // home screen reveals no peer name, no preview, no avatar. The user
  // opens the folder explicitly (biometric / PIN gate handled per-row in
  // ChatLongPressSheet → onLockToggle).
  const lockedConversations = useMemo(
    () => conversations.filter(c => !!c.locked && !c.archived),
    [conversations]
  );
  const lockedCount = lockedConversations.length;

  const filteredConversations = useMemo(() => {
    if (filter === 'archived') return archivedConversations;
    // Dedicated "locked" pseudo-filter (entered by tapping the hidden
    // section footer). Lives outside the standard partition so locked
    // rows never leak into search/unread/folder filters.
    if (filter === 'locked') return lockedConversations;
    // Folder filter: filter values like "folder_<id>" → match by folder filter_type/value
    let folderFilter = null;
    if (typeof filter === 'string' && filter.startsWith('folder_')) {
      const fid = parseInt(filter.slice(7), 10);
      folderFilter = chatFolders.find(f => Number(f.id) === fid) || null;
    }
    const sq = (debouncedQuery || '').trim().toLowerCase();
    // Accent-insensitive name matching (BR users: searching "joao" must match
    // "João", "ana" must match "Ana" / "Aná"). NFD splits a letter into its
    // base char + a combining diacritic; stripping the combining marks (the
    // U+0300–U+036F range) gives a fold-insensitive key for both query + name.
    const _stripAccents = (str) => String(str || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
    const nsq = _stripAccents(sq);
    // Drop orphan direct chats — no name, no peer, no messages — that show
    // up as "Desconhecido / Nenhuma mensagem" rows. They get created when a
    // chat is initiated but never receives a message and the peer email
    // wasn't persisted; pure clutter for the user.
    let list = conversations.filter(c => {
      // Locked chats live in the dedicated hidden folder. Excluding them
      // here keeps the main list free of "redacted" rows that would
      // otherwise leak metadata (timestamp, unread count) to a shoulder-
      // surfer even when the bubble preview was already redacted.
      if (c.locked) return false;
      if (c.type === 'group' || c.type === 'channel') return true;
      const hasName = !!(c.display_name || c.name);
      const hasPeer = !!(c.other_email || c.contact_email || c.peer_email || c.email);
      const hasMessage = !!(c.last_message || c.last_message_content || c.last_message_at);
      return hasName || hasPeer || hasMessage;
    }).filter(c => {
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
          if (_stripAccents(rawName).includes(nsq)) return true;
          // Also try the email-to-display-name conversion used by the UI so a
          // search for "rene" matches "rene.reis@…" → "Rene Reis".
          const pretty = String(emailToDisplayName(c.display_name || c.name || c.other_email || '') || '').toLowerCase();
          if (pretty && _stripAccents(pretty).includes(nsq)) return true;
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
    // Saved Messages auto-pin: a self-chat (peer == current user) always
    // surfaces at the top, mirroring WhatsApp/Telegram. We compute an
    // effective-pinned bit so the user doesn't need to manually pin it.
    const meLc = (user?.email || '').toLowerCase();
    const isSelfChat = (c) => {
      if (c.type === 'group' || c.type === 'channel' || !meLc) return false;
      const peer = String(c.other_email || c.contact_email || c.peer_email || c.email || '').toLowerCase();
      return !!peer && peer === meLc;
    };
    // Recency key: backend now returns last_message_at, but optimistic WS
    // updates and older cached rows may only have last_message.created_at /
    // updated_at. Fall back so the re-sort doesn't collapse to a no-op (which
    // would freeze the list order on stale data).
    const _sortKey = (c) => String(c.last_message_at || c.last_message?.created_at || c.updated_at || '');
    list.sort((a, b) => {
      const aPinned = (a.pinned || isSelfChat(a)) ? 1 : 0;
      const bPinned = (b.pinned || isSelfChat(b)) ? 1 : 0;
      if (aPinned !== bPinned) return bPinned - aPinned;
      return _sortKey(b).localeCompare(_sortKey(a));
    });
    return list;
  }, [filter, conversations, archivedConversations, lockedConversations, debouncedQuery, chatFolders, user?.email]);

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
    const manual = filteredConversations.filter(c => c.pinned).slice(0, MAX_PINNED_CHATS);
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
      // Size presets: S=52, M=64 (default), L=80. Cada pin agora pode ter
      // tamanho proprio (user pediu "individual"). Drag math usa MAIOR size
      // como SLOT_W aproximado — ordem fica perfeita; offsets visuais durante
      // drag podem ficar 0-15px off em mix S/L mas compromete mais que faz mal.
      // [7173 polish 2026-05-22] Bumped sizes for iMessage-style presence.
      // M (default) jumped 64→72 — matches iOS Messages pinned tiles. S kept
      // close to old M (60) so users who downsized don't lose their layout.
      // L grew 80→84 for visual impact in 1-2 pin layouts.
      const SIZE_OF = (sz) => sz === 's' ? 60 : sz === 'l' ? 84 : 72;
      const sizePx = SIZE_OF(pinnedSize);
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
      // DRAG_SLOT: media dinamica das larguras de slot atuais (sizePx + gap).
      // Antes era constante 78 — mas com pins de tamanhos diferentes (s=52,
      // m=64, l=80) o calculo de target ficava off por 15-25px (audit #2).
      const DRAG_SLOT = (() => {
        if (!pinnedConversations.length) return 78;
        const widths = pinnedConversations.map(c => {
          const sz = pinnedSizes[c.id] || pinnedSize || 'm';
          const px = SIZE_OF(sz);
          return px + 14;
        });
        return Math.round(widths.reduce((a, b) => a + b, 0) / widths.length);
      })();
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
          // Audit #6: re-resolver idx ATUAL pelo id em vez de usar o do
          // closure — se a lista reordenou (msg nova chegou) durante o drag,
          // o idx antigo aponta pra item errado e o reorder vai mover gente
          // que nao era pra mover.
          const curIdx = pinnedConversations.findIndex(c => c.id === item.id);
          if (curIdx === -1) return;
          const tx = pinDragTxRef.current.get(item.id);
          if (tx) tx.setValue(g.dx);
          const delta = Math.round(g.dx / DRAG_SLOT);
          const target = Math.max(0, Math.min(pinnedConversations.length - 1, curIdx + delta));
          pinnedConversations.forEach((other, oidx) => {
            if (other.id === item.id) return;
            const t = pinDragTxRef.current.get(other.id);
            if (!t) return;
            let shift = 0;
            if (delta > 0 && oidx > curIdx && oidx <= target) shift = -DRAG_SLOT;
            else if (delta < 0 && oidx < curIdx && oidx >= target) shift = DRAG_SLOT;
            t.setValue(shift);
          });
        },
        onPanResponderRelease: (_, g) => {
          const curIdx = pinnedConversations.findIndex(c => c.id === item.id);
          const dragTx = pinDragTxRef.current.get(item.id);
          const resetAll = () => {
            pinnedConversations.forEach(c => pinDragTxRef.current.get(c.id)?.setValue(0));
          };
          if (curIdx === -1) {
            // Item desapareceu durante drag — reseta tudo e bail.
            resetAll();
            setPinDraggingId(null);
            return;
          }
          const delta = Math.round(g.dx / DRAG_SLOT);
          const target = Math.max(0, Math.min(pinnedConversations.length - 1, curIdx + delta));
          if (target !== curIdx && dragTx) {
            // Settle the dragged item visually at its new slot, then commit
            // the new id order and reset all transforms in one frame so
            // the layout reshuffle doesn't flicker.
            Animated.timing(dragTx, {
              toValue: (target - curIdx) * DRAG_SLOT,
              duration: 140, useNativeDriver: true,
            }).start(() => {
              const ids = pinnedConversations.map(c => c.id);
              const [moved] = ids.splice(curIdx, 1);
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
          // [7173 polish 2026-05-22] Dropped purple tint wash + bumped vertical
          // padding (14→16) to give bigger avatars breathing room. iOS Messages
          // has no chip/background around pinned tiles — just clean separation.
          paddingTop: 16,
          paddingBottom: 18,
          paddingLeft: 14,
          backgroundColor: 'transparent',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
        }}>
          {/* Header strip — discoverable Reorganizar button OR (in edit mode)
              the dismiss/Pronto control. Both states render the strip ABOVE
              the horizontal pin scroll, so nothing overlaps a pin card.
              Long-press tambem continua funcionando. */}
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingRight: 14, marginBottom: 10 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, minWidth: 0 }}>
              {/* IconPin removido (bug print 3 — 2026-05-08): mesmo em size 14
                  o SVG continuava parecendo bullet/blob esfumado antes do
                  texto "FIXADAS". WhatsApp/Telegram não usam ícone aqui;
                  o caps + letterSpacing já comunica que é section header. */}
              {pinnedEditMode && !pinnedHintSeen ? (
                <Text
                  numberOfLines={1}
                  style={{ fontSize: 11, fontWeight: '600', color: isDark ? 'rgba(255,255,255,0.7)' : '#7C3AED', flexShrink: 1 }}
                >
                  {t?.('chat.tapToResize') || 'Toque pra mudar tamanho'}
                </Text>
              ) : (
                <Text style={{ fontSize: 11, fontWeight: '700', letterSpacing: 0.4, color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }}>
                  {((() => { const v = t?.('chat.pinned'); return v && v !== 'chat.pinned' ? v : 'FIXADAS'; })()).toUpperCase()}
                </Text>
              )}
            </View>
            {/* Pressable + bigger hit area + explicit cursor pra web — RNW
                TouchableOpacity hitSlop unreliable em headless e em alguns
                browsers. User reportou "Editar nao funciona no navegador". */}
            {!pinnedEditMode ? (
              <Pressable
                onPress={() => {
                  try { require('react-native').Vibration.vibrate(8); } catch {}
                  setPinnedEditMode(true);
                }}
                accessibilityRole="button"
                accessibilityLabel={t?.('chat.reorderPinned') || 'Reorganizar fixados'}
                hitSlop={10}
                style={({ pressed }) => ({
                  width: 32, height: 32, borderRadius: 16,
                  alignItems: 'center', justifyContent: 'center',
                  backgroundColor: pressed
                    ? (isDark ? 'rgba(124,58,237,0.32)' : 'rgba(124,58,237,0.20)')
                    : 'transparent',
                  ...(Platform.OS === 'web' ? { cursor: 'pointer', userSelect: 'none' } : {}),
                })}
              >
                {/* [7172 polish 2026-05-22] Replaced "Editar" text with pencil SVG.
                    User wanted a discreet icon, matching iOS/WhatsApp where pinned
                    sections don't have a labeled button. */}
                <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
                  <Path
                    d="M16.475 5.408l2.117 2.117M14.69 7.193l-9.39 9.39a1.5 1.5 0 00-.421.815l-.5 2.5a.5.5 0 00.59.59l2.5-.5a1.5 1.5 0 00.815-.42l9.39-9.39M14.69 7.193l1.785-1.785a1.5 1.5 0 012.117 0l0 0a1.5 1.5 0 010 2.117l-1.785 1.785M14.69 7.193l2.117 2.117"
                    stroke={isDark ? '#A78BFA' : '#7C3AED'}
                    strokeWidth={1.8}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </Svg>
              </Pressable>
            ) : (
              <TouchableOpacity
                onPress={() => {
                  try { require('react-native').Vibration.vibrate(8); } catch {}
                  markPinnedHintSeen();
                  setPinnedEditMode(false);
                }}
                activeOpacity={0.75}
                style={{
                  paddingHorizontal: 14, height: 32, borderRadius: 16,
                  flexDirection: 'row', alignItems: 'center', gap: 6,
                  backgroundColor: '#7C3AED',
                  ...(Platform.OS === 'web' ? { cursor: 'pointer', userSelect: 'none' } : {}),
                }}
                accessibilityLabel={t?.('common.done') || 'Concluir'}
              >
                <IconCheck size={14} color="#fff" />
                <Text style={{ fontSize: 12, fontWeight: '700', color: '#fff' }}>
                  {t?.('common.done') || 'Concluir'}
                </Text>
              </TouchableOpacity>
            )}
          </View>
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEnabled={!pinnedEditMode}
            contentContainerStyle={{ paddingRight: 14, gap: 14, alignItems: 'flex-end' }}
          >
            {pinnedConversations.map((item, idx) => {
              const isGroup = item.type === 'group' || item.type === 'channel';
              const peerEmail = !isGroup ? (item.other_email || item.contact_email || item.email || '') : '';
              let nick = '';
              if (peerEmail) { try { nick = require('../services/nicknames').getNickname(peerEmail); } catch {} }
              const name = nick || emailToDisplayName(item.display_name || item.name || '?');
              const unread = item.unread_count || 0;
              // Fix #3 do audit: garantir que a Animated.Value sempre exista
              // no ref ANTES de ler. Antes `|| new Animated.Value(0)` criava
              // throwaways que sumiam em re-renders, causando dessync entre
              // frames (foto SC saindo cortado).
              if (!pinDragTxRef.current.has(item.id)) {
                pinDragTxRef.current.set(item.id, new Animated.Value(0));
              }
              const tx = pinDragTxRef.current.get(item.id);
              const isDragging = pinDraggingId === item.id;
              const pan = pinnedEditMode ? buildPanForItem(item, idx) : null;
              // Tamanho proprio deste pin (override individual ou default)
              const itemSize = getPinSize(item.id);
              const itemSizePx = SIZE_OF(itemSize);
              // SLOT DINAMICO: largura do wrapper = tamanho do avatar.
              // ScrollView ja tem `gap: 14` entre items, entao gap visual
              // entre avatares fica CONSTANTE de 14px independente das
              // combinacoes de tamanho. Antes (SLOT_W_FIXED=84) avatares
              // pequenos tinham padding interno enorme criando gaps
              // visuais variaveis (foto user 2026-05-04).
              const SLOT_W = itemSizePx;
              return (
                <Animated.View
                  key={item.id}
                  {...(pan ? pan.panHandlers : {})}
                  style={{
                    width: SLOT_W, alignItems: 'center',
                    transform: [
                      { translateX: tx },
                      { rotate: pinnedEditMode ? wiggleRotate : '0deg' },
                      { scale: isDragging ? 1.08 : 1 },
                      // [7173 polish 2026-05-22] entrance pop layered last so
                      // it composes on top of drag scale without conflicting.
                      { scale: pinnedEditMode ? pinEntrancePop : 1 },
                    ],
                    zIndex: isDragging ? 10 : 1,
                    ...(isDragging ? Platform.select({
                      ios: { shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 4 } },
                      android: { elevation: 8 },
                      default: {},
                    }) : {}),
                  }}
                >
                  <Pressable
                    onPress={() => {
                      // Em edit mode: tap cicla S→M→L do PROPRIO pin (iMessage-like).
                      // Fora de edit mode: abre conversa.
                      if (pinnedEditMode) {
                        try { require('react-native').Vibration.vibrate(6); } catch {}
                        cyclePinSize(item.id);
                        return;
                      }
                      if (selectionMode) toggleSelected(item.id);
                      else handleConversationPress(item);
                    }}
                    onLongPress={() => showLongPressMenu(item)}
                    delayLongPress={isWeb ? 300 : 500}
                    style={({ pressed }) => ({
                      opacity: pressed ? 0.75 : 1,
                      ...(Platform.OS === 'web' ? { cursor: 'pointer', userSelect: 'none' } : {}),
                    })}
                  >
                    <View style={{ position: 'relative' }}>
                      {isGroup
                        ? <GroupAvatarStack conversation={item} size={itemSizePx} isDark={isDark} />
                        : <AvatarCircle name={name} email={peerEmail} size={itemSizePx} />
                      }
                      {/* Edit-mode unpin badge — iOS Home-screen style. Tap (×)
                          desafixa direto sem precisar abrir long-press menu. */}
                      {pinnedEditMode ? (
                        <Pressable
                          onPress={() => {
                            try { require('react-native').Vibration.vibrate(8); } catch {}
                            handlePinConversation(item);
                          }}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                          accessibilityLabel={t?.('chat.unpin') || 'Desafixar'}
                          style={({ pressed }) => ({
                            position: 'absolute', top: -4, left: -4,
                            width: 24, height: 24, borderRadius: 12,
                            backgroundColor: isDark ? '#0d1117' : '#fff',
                            borderWidth: 1.5, borderColor: isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.12)',
                            alignItems: 'center', justifyContent: 'center',
                            zIndex: 5,
                            opacity: pressed ? 0.7 : 1,
                            ...Platform.select({
                              ios: { shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 4, shadowOffset: { width: 0, height: 2 } },
                              android: { elevation: 3 },
                              web: { cursor: 'pointer', userSelect: 'none' },
                              default: {},
                            }),
                          })}
                        >
                          <Svg width={12} height={12} viewBox="0 0 24 24" fill="none" stroke={isDark ? '#fff' : '#0f172a'} strokeWidth={2.5} strokeLinecap="round">
                            <Path d="M18 6 6 18M6 6l12 12" />
                          </Svg>
                        </Pressable>
                      ) : null}
                      {item._smartPin && (
                        <View style={{
                          position: 'absolute', bottom: -2, right: -2,
                          width: 22, height: 22, borderRadius: 11,
                          backgroundColor: isDark ? '#0d1117' : '#fff',
                          borderWidth: 2, borderColor: isDark ? '#0d1117' : '#fff',
                          alignItems: 'center', justifyContent: 'center',
                        }}>
                          <View style={{
                            width: 18, height: 18, borderRadius: 9,
                            backgroundColor: '#F59E0B',
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            <IconSparkles size={10} color="#fff" />
                          </View>
                        </View>
                      )}
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
                          width: itemSizePx, height: itemSizePx, borderRadius: itemSizePx / 2,
                          borderWidth: 3, borderColor: '#7C3AED',
                        }} />
                      )}
                    </View>
                    <Text
                      numberOfLines={1}
                      ellipsizeMode="tail"
                      style={{
                        // [7173 polish 2026-05-22] iMessage-style label: 12px,
                        // centered, single line ellipsized. Bump fontSize 11→12
                        // since avatars grew 64→72 — proportional balance.
                        marginTop: 6, fontSize: 12, fontWeight: '500',
                        color: colors.text, textAlign: 'center',
                        maxWidth: Math.max(SLOT_W + 8, 64),
                      }}
                    >
                      {name}
                    </Text>
                  </Pressable>
                </Animated.View>
              );
            })}
            {/* Inline hint + Concluir moved to header strip ABOVE the
                horizontal scroll — see the View at the start of this
                section. The previous inline pill overlapped pin cards
                (Lucas Catine bug print 2026-05-08). */}
          </ScrollView>
        </View>
      );
    }
    return (
      <View style={[s.sectionLabel, { borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)' }]}>
        {/* Small crisp pin glyph reads as a real section marker (not the old
            esfumado blob — this is a thin-stroke SVG sized to match the caps).
            Tinted brand purple so the PINNED group feels like a first-class
            section, WhatsApp/Telegram-style. */}
        <IconPin size={11} color={isDark ? '#A78BFA' : '#7C3AED'} />
        <Text style={[s.sectionLabelText, { color: isDark ? 'rgba(167,139,250,0.85)' : 'rgba(124,58,237,0.85)' }]}>
          {(() => { const v = t('chat.pinned'); return v && v !== 'chat.pinned' ? v : 'FIXADAS'; })()}
        </Text>
      </View>
    );
  };

  // Locked-chats hidden section. Rendered as a row similar to Archived;
  // tap opens the dedicated `filter='locked'` view. The biometric/PIN
  // gate is enforced per-row in ChatLongPressSheet → onLockToggle on
  // entry, and once `chatUnlocked` is set per-conversation the actual
  // bubble preview still renders gated until the user authenticates.
  // Hidden when there are no locked chats so the home screen stays clean.
  const renderLockedHeader = () => {
    if (filter !== 'all' || lockedCount === 0) return null;
    // Entering the hidden section is itself gated by Face ID / passcode.
    // The per-chat gate still fires when the user opens one of the rows,
    // but the index-level gate stops a shoulder-surfer from even reading
    // the redacted-row count / order without authenticating once.
    const openLocked = async () => {
      try {
        const { confirmWithBiometric } = require('../services/biometricGate');
        const ok = await confirmWithBiometric({
          reason: t('chat.hiddenSection') || 'Conversas trancadas',
        });
        if (!ok) return;
      } catch {}
      setFilter('locked');
    };
    return (
      <TouchableOpacity
        style={[s.archivedHeader, {
          borderBottomColor: isDark ? '#2a2e3a' : '#dadbe0',
          backgroundColor: isDark ? '#1c1c24' : '#f3f3f7',
        }]}
        onPress={openLocked}
        activeOpacity={0.65}
        accessibilityLabel={t('chat.hiddenSection') || 'Conversas trancadas'}
        accessibilityRole="button"
      >
        <View style={[s.archivedHeaderIcon, { backgroundColor: '#52525b' }]}>
          <IconLock size={16} color="#fff" />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[s.archivedHeaderText, { color: colors.text }]}>
            {t('chat.hiddenSection') || 'Conversas trancadas'}
          </Text>
          <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 2 }}>
            {t('chat.hiddenSectionDesc') || 'Toque para ver suas conversas trancadas'}
          </Text>
        </View>
        <View style={[s.archivedCountBadge, { backgroundColor: '#52525b' }]}>
          <Text style={s.archivedCountText}>{lockedCount}</Text>
        </View>
      </TouchableOpacity>
    );
  };

  const renderArchivedHeader = () => {
    if (filter !== 'all' || archivedCount === 0) return null;
    return (
      <TouchableOpacity
        style={[s.archivedHeader, {
          borderBottomColor: isDark ? '#2a3a2e' : '#d8f0de',
          backgroundColor: isDark ? '#161617' : '#f6f6f7',
          ...(isWeb ? { transition: 'background 0.2s ease' } : {}),
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

  // Stable row callbacks — the ConversationRow already invokes these with its
  // own `conversation`, so we don't need to mint per-item arrow closures inside
  // renderItem (was 5 fresh closures × every row × every list render = GC churn
  // and a renderItem identity that flipped on each conversations update). These
  // take a conversation and delegate to the existing id-based handlers.
  const rowPrefetch = useCallback((conv) => {
    try { prefetchConversation(conv.id); } catch {}
  }, []);
  const rowToggleSelect = useCallback((conv) => {
    toggleSelected(conv.id);
  }, [toggleSelected]);

  const renderItem = useCallback(({ item, index }) => {
    // Resolve the peer email ONCE per render (was three separate IIFEs walking
    // item.members + lowercasing currentEmail + scanning, called for every row
    // every render). On a list of 200 convs that's 600 array walks per scroll
    // tick — visible in JS profile as the dominant cost when the list updates.
    let otherEmail = null;
    let presenceVal = null;
    if (item.type !== 'group') {
      const _meLc = (user?.email || '').toLowerCase();
      const members = item.members;
      let other = null;
      if (members && members.length) {
        for (let i = 0; i < members.length; i++) {
          const m = members[i];
          const e = typeof m === 'string' ? m : (m?.email || '');
          if (e && e.toLowerCase() !== _meLc) { other = m; break; }
        }
      }
      otherEmail = (other ? (typeof other === 'string' ? other : other?.email) : null)
        || item.other_email || item.contact_email || null;
      if (otherEmail) {
        const p = presencesRef.current;
        if (p instanceof Map) presenceVal = p.get(otherEmail);
      }
    }
    const isOnline = !!(presenceVal && (presenceVal.status === 'online' || presenceVal === 'online'));
    const lastSeen = (presenceVal && presenceVal.last_seen) || null;
    const noteText = (item.type === 'direct' && otherEmail) ? (notesMap[otherEmail] || null) : null;
    return (
      <ConversationRow
        conversation={item}
        colors={colors}
        isDark={isDark}
        t={t}
        language={language}
        onPress={handleConversationPress}
        onPressIn={rowPrefetch}
        onDelete={handleDeleteConversation}
        onArchive={handleArchiveConversation}
        onMute={handleMuteConversation}
        onPin={handlePinConversation}
        onMarkUnread={handleMarkUnreadConversation}
        onEmail={handleEmailConversation}
        currentEmail={user?.email}
        isOnline={isOnline}
        lastSeen={lastSeen}
        isLocked={lockedIds.has(item.id) && !unlockedIds.has(item.id)}
        typingUsers={typingUsers}
        selectionMode={selectionMode}
        isSelected={selectedIds.has(item.id)}
        onLongPress={showLongPressMenu}
        onToggleSelect={rowToggleSelect}
        draftText={drafts[String(item.id)] || null}
        draftEditedAt={draftTimes[String(item.id)] || null}
        noteText={noteText}
        onAvatarPress={setAvatarLightbox}
      />
    );
  }, [isDark, colors, t, language, handleConversationPress, rowPrefetch, handleDeleteConversation, handleArchiveConversation, handleMuteConversation, handlePinConversation, handleMarkUnreadConversation, handleEmailConversation, user?.email, lockedIds, unlockedIds, typingUsers, selectionMode, selectedIds, showLongPressMenu, rowToggleSelect, drafts, draftTimes, notesMap, setAvatarLightbox]);
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
      {/* Real-time reaction toast — peer reacted to my status. Slides in from
          top, auto-dismisses 3.5s, tap opens the status. Lives ABOVE the WS
          banner so a reaction during a reconnect still surfaces. */}
      {reactionToast && (
        <Animated.View
          pointerEvents="box-none"
          style={{
            position: 'absolute', top: Platform.OS === 'ios' ? 50 : 20, left: 12, right: 12,
            zIndex: 100,
            transform: [{ translateY: reactionToastY }],
          }}
        >
          <TouchableOpacity
            activeOpacity={0.85}
            onPress={() => {
              const me = (user?.email || '').toLowerCase();
              setStatusViewerEmail(me);
              const myItems = (statuses.find(s => (s.email || '').toLowerCase() === me)?.items) || [];
              const targetIdx = Math.max(0, myItems.findIndex(it => it.id === reactionToast.status_id));
              setStatusViewIdx(targetIdx);
              if (reactionToastTimer.current) clearTimeout(reactionToastTimer.current);
              Animated.timing(reactionToastY, { toValue: -120, duration: 180, useNativeDriver: true })
                .start(() => setReactionToast(null));
            }}
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 12,
              backgroundColor: isDark ? 'rgba(20,20,28,0.96)' : '#fff',
              borderRadius: 16, paddingHorizontal: 14, paddingVertical: 12,
              borderWidth: 1, borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
              shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 16, shadowOffset: { width: 0, height: 6 },
              elevation: 8,
            }}
            accessibilityLabel={`${reactionToast.reactor_name} reagiu ao seu status com ${reactionToast.emoji}`}
            accessibilityRole="button"
          >
            <View style={{ position: 'relative' }}>
              <AvatarCircle name={reactionToast.reactor_name} email={reactionToast.reactor_email} size={40} />
              <View style={{
                position: 'absolute', bottom: -4, right: -4,
                width: 24, height: 24, borderRadius: 12,
                backgroundColor: isDark ? '#0d0d0d' : '#fff',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <Text style={{ fontSize: 16 }}>{reactionToast.emoji}</Text>
              </View>
            </View>
            <View style={{ flex: 1 }}>
              <Text style={{ color: colors.text, fontSize: 14, fontWeight: '700' }} numberOfLines={1}>
                {reactionToast.reactor_name}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 1 }} numberOfLines={1}>
                {t?.('status.reactedToYour') || 'reagiu ao seu status'}
              </Text>
            </View>
          </TouchableOpacity>
        </Animated.View>
      )}
      {/* Sync badge — WhatsApp-style subtle "Sincronizando..." while the
          onlineRecoveryOrchestrator is flushing the outbox + delta-pulling
          missed messages after a reconnect. Hidden while wsDownBanner is
          visible (that banner already represents the catching-up state).
          Tiny, muted purple-gray so it doesn't compete with content. */}
      {syncingBadge && !wsDownBanner && (
        <View
          accessibilityLiveRegion="polite"
          accessibilityLabel={t?.('chat.syncing') || 'Sincronizando...'}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            paddingHorizontal: 14, paddingVertical: 5,
            backgroundColor: isDark ? 'rgba(124,58,237,0.10)' : 'rgba(124,58,237,0.06)',
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.14)',
          }}>
          <ActivityIndicator size="small" color={isDark ? 'rgba(180,150,255,0.85)' : '#7C3AED'} />
          <Text style={{ flex: 1, fontSize: 11.5, color: isDark ? 'rgba(200,180,255,0.85)' : '#6D28D9', fontWeight: '500' }}>
            {t?.('chat.syncing') || 'Sincronizando...'}
          </Text>
        </View>
      )}
      {/* WS down banner — only shown after 12s delay (15s if we just
          returned from background, to absorb sleep/wake blips). Visual
          tuned to WhatsApp pattern: subtle muted gray (not alarming yellow)
          since this is informational, not an error — most reconnects succeed
          in seconds and the user shouldn't feel the app is broken. Fades
          out over 500ms on reconnect instead of flipping abruptly. */}
      {wsDownBanner && (
        <Animated.View
          accessibilityRole="alert"
          accessibilityLiveRegion="polite"
          accessibilityLabel={t?.('chat.reconnecting') || 'Reconectando…'}
          style={{
          flexDirection: 'row', alignItems: 'center', gap: 8,
          paddingHorizontal: 14, paddingVertical: 6,
          backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)',
          opacity: wsDownBannerOpacity,
        }}>
          <ActivityIndicator size="small" color={isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)'} />
          <Text style={{ flex: 1, fontSize: 12, color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)', fontWeight: '500' }}>
            {t?.('chat.reconnecting') || 'Reconectando…'}
          </Text>
        </Animated.View>
      )}
      {/* [silent-fail-w3] Cold-start fetch failed and nothing is cached →
          1-line banner with a tap-to-retry pill. Tinted red so users
          distinguish it from the gray WS reconnecting banner above. */}
      {loadError && !loading && (
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel={t?.('chat.retry') || 'Tentar novamente'}
          onPress={() => { setLoadError(false); loadConversations(true); }}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 8,
            paddingHorizontal: 14, paddingVertical: 8,
            backgroundColor: isDark ? 'rgba(220,38,38,0.10)' : 'rgba(220,38,38,0.06)',
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: isDark ? 'rgba(220,38,38,0.20)' : 'rgba(220,38,38,0.18)',
          }}>
          <Text style={{ flex: 1, fontSize: 12, color: '#dc2626', fontWeight: '600' }}>
            {t?.('chat.loadError') || 'Erro ao carregar conversas.'}
          </Text>
          <Text style={{ fontSize: 12, color: '#dc2626', fontWeight: '700' }}>
            {t?.('chat.retry') || 'Tentar novamente'}
          </Text>
        </TouchableOpacity>
      )}
      {/* Chatyy One AI quick access (like Snapchat's My AI) */}
      {!(searchQuery || '').trim() && (
        <TouchableOpacity
          onPress={() => { try { router.push('/one'); } catch {} }}
          activeOpacity={0.7}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 14,
            paddingHorizontal: 16, paddingVertical: 14,
            borderBottomWidth: StyleSheet.hairlineWidth,
            borderBottomColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.05)',
          }}
        >
          {/* WAVE 46 (2026-05-21): swap solid purple + sparkle for the real
              app icon with a winking-eye animation (~every 4–8s). Same 52px
              footprint so layout doesn't shift. */}
          <ChatyyOneAvatar size={52} />
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <Text style={{ fontSize: 16, fontWeight: '700', color: colors.text }}>
                {t?.('one.title') || 'Chatyy One'}
              </Text>
              <View style={{
                backgroundColor: isDark ? 'rgba(124,58,237,0.22)' : 'rgba(124,58,237,0.14)',
                borderRadius: 6, paddingHorizontal: 6, paddingVertical: 1,
              }}>
                <Text style={{ color: '#7C3AED', fontSize: 9, fontWeight: '800', letterSpacing: 0.6 }}>AI</Text>
              </View>
            </View>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }} numberOfLines={1}>
              {t?.('one.subtitle') || 'Pergunte qualquer coisa • IA pessoal'}
            </Text>
          </View>
          <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
            <Path d="M9 6l6 6-6 6" stroke={colors.textSecondary} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </Svg>
        </TouchableOpacity>
      )}

      {/* Status stories (Instagram-style) — only when not searching.
          Wrapped in an Animated.View tied to pullTranslateY so the strip
          slides down with the pull-to-refresh gesture (audit gap #1). */}
      {!(searchQuery || '').trim() && (
        <Animated.View style={{ transform: [{ translateY: pullTranslateY }] }}>
          <StatusStoriesRow colors={colors} isDark={isDark} user={user} router={router} t={t} setActiveTab={setActiveTab} />
        </Animated.View>
      )}
      {renderArchivedHeader()}
      {renderLockedHeader()}
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
  ), [filter, pinnedCount, isDark, colors, t, archivedCount, lockedCount, searchQuery, filteredConversations.length, user, router, pinnedAvatarsMode, pinnedConversations, selectionMode, selectedIds, handleConversationPress, enterSelectionMode, toggleSelected, contactBanner, contactBannerSyncing, handleContactBannerPress, dismissContactBanner, pinnedEditMode, pinnedSize, pinnedSizes, pinDraggingId, typingUsers, lockedIds, unlockedIds]);

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
          // WAVE 55 fix: chat-conversation lê `params.id` (não `conversationId`).
          // Antes o tap em search result navegava com param errado → tela abria
          // com id=0 e nada renderizava. Passa também `type` + `name` pra header
          // não ficar em branco enquanto resolve a conversa.
          const hitType = hit.conv_type || hit.conversation_type || hit.type || 'direct';
          const peerEmail = hit.peer_email || hit.other_email || hit.contact_email || hit.sender_email || '';
          return (
            <TouchableOpacity
              key={`hit-${hit.id}`}
              onPress={() => router.push({
                pathname: '/chat-conversation',
                params: {
                  id: String(hit.conversation_id),
                  name: encodeURIComponent(convName || ''),
                  type: hitType,
                  ...(peerEmail ? { email: peerEmail } : {}),
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
          extraData={extraDataMemo}
          onScroll={onListScroll}
          scrollEventThrottle={16}
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

      {/* WAVE 95 — Avatar lightbox (tap on a row avatar → fullscreen photo).
          Row tap (anywhere else) still opens the conversation; only the small
          avatar circle on the left triggers this. */}
      <AvatarLightbox
        visible={!!avatarLightbox}
        email={avatarLightbox?.email}
        name={avatarLightbox?.name}
        onClose={() => setAvatarLightbox(null)}
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
        // Bumpado pra 40 (2026-05-04 round 3) — user reportou "peek so puxa
        // ate ontem". Causa: limit=12 cobria so 1-2 dias em conv ativa. 40
        // garante history mais profundo. Backend chat_messages cap=100.
        initial = (getCachedMessagesSync(conv.id, 50) || []).slice(-40);
        setPreviewMsgs(initial);
      } catch { setPreviewMsgs([]); }
      // Polish: responsive iOS-style spring (damping≈18, mass 0.7, stiffness 200)
      // — overshoots subtly so the peek feels tactile instead of "linear pop".
      Animated.parallel([
        Animated.spring(slideY, { toValue: 0, stiffness: 200, damping: 18, mass: 0.7, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, stiffness: 220, damping: 19, mass: 0.7, useNativeDriver: true }),
        Animated.timing(backdrop, { toValue: 1, duration: 220, useNativeDriver: true }),
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
          const r = await api.chatMessages(conv.id, 40);
          if (cancelled) return;
          const fresh = Array.isArray(r?.messages) ? r.messages
                       : Array.isArray(r) ? r : [];
          if (fresh.length >= initial.length && fresh.length > 0) {
            setPreviewMsgs(fresh.slice(-40));
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

  // Tap-outside dismiss — fade backdrop + the peek before unmount so the
  // modal doesn't pop out. Mirrors iOS/Telegram action-sheet dismiss feel.
  const handleBackdropTap = React.useCallback(() => {
    Animated.parallel([
      Animated.timing(backdrop, { toValue: 0, duration: 200, useNativeDriver: true }),
      Animated.timing(slideY, { toValue: 30, duration: 200, useNativeDriver: true }),
      Animated.timing(scale, { toValue: 0.96, duration: 200, useNativeDriver: true }),
    ]).start(() => {
      try { onCloseRef.current?.(); } catch {}
    });
  }, [backdrop, slideY, scale]);
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
  // only the strokes we need so they tree-shake cleanly. `size` prop
  // honored (default 22pt — matches WhatsApp action sheet icons).
  const Ic = {
    Bubble: (props) => (
      <Svg width={props.size || 22} height={props.size || 22} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
      </Svg>
    ),
    Pin: (props) => (
      <Svg width={props.size || 22} height={props.size || 22} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M12 17v5" />
        <Path d="M9 11V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v7" />
        <Path d="M6 11h12l-1.5 6h-9L6 11z" />
      </Svg>
    ),
    Bell: (props) => (
      <Svg width={props.size || 22} height={props.size || 22} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
        <Path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      </Svg>
    ),
    Lock: (props) => (
      <Svg width={props.size || 22} height={props.size || 22} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Rect x={3} y={11} width={18} height={11} rx={2} />
        <Path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </Svg>
    ),
    Archive: (props) => (
      <Svg width={props.size || 22} height={props.size || 22} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M21 8v13H3V8" />
        <Path d="M1 3h22v5H1z" />
        <Path d="M10 12h4" />
      </Svg>
    ),
    List: (props) => (
      <Svg width={props.size || 22} height={props.size || 22} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M8 6h13M8 12h13M8 18h13" />
        <SvgCircle cx={3.5} cy={6} r={1.5} fill={props.color} />
        <SvgCircle cx={3.5} cy={12} r={1.5} fill={props.color} />
        <SvgCircle cx={3.5} cy={18} r={1.5} fill={props.color} />
      </Svg>
    ),
    Users: (props) => (
      <Svg width={props.size || 22} height={props.size || 22} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <Path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
        <SvgCircle cx={9} cy={7} r={4} />
        <Path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
      </Svg>
    ),
    Ban: (props) => (
      <Svg width={props.size || 22} height={props.size || 22} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <SvgCircle cx={12} cy={12} r={10} />
        <Path d="M4.93 4.93l14.14 14.14" />
      </Svg>
    ),
    XCircle: (props) => (
      <Svg width={props.size || 22} height={props.size || 22} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
        <SvgCircle cx={12} cy={12} r={10} />
        <Path d="M15 9l-6 6M9 9l6 6" />
      </Svg>
    ),
    Trash: (props) => (
      <Svg width={props.size || 22} height={props.size || 22} viewBox="0 0 24 24" fill="none" stroke={props.color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
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
    // Spam report — fires chat_report_spam. Server tally per sender; >10
    // reports in 24h auto-shadowbans them from contact search.
    { label: t('chat.reportSpam') || 'Reportar como spam', icon: Ic.AlertTriangle || Ic.Ban, color: danger, onPress: () => actions.onReportSpam?.(conv) },
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
    <Modal visible={!!conv} transparent animationType="none" onRequestClose={handleBackdropTap} statusBarTranslucent>
      <View style={StyleSheet.absoluteFillObject}>
        {/* Backdrop — slightly lighter (0.40) per Telegram spec; tap fades out
            both backdrop and peek before unmount instead of hard popping. */}
        <Animated.View style={[StyleSheet.absoluteFillObject, { backgroundColor: 'rgba(0,0,0,0.40)', opacity: backdrop }]}>
          <Pressable style={StyleSheet.absoluteFillObject} onPress={handleBackdropTap} />
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

          {/* ── Action menu ──
              Polish: radius 14→16 (matches preview card 22 hierarchy),
              hairline separators (RN's StyleSheet.hairlineWidth resolves to
              0.5pt on @2x/@3x — exactly what the spec asks for),
              16/600 labels, 22pt icons aligned right (already there). */}
          <View style={{
            backgroundColor: cardBg,
            borderRadius: 16,
            marginTop: 10,
            overflow: 'hidden',
            ...Platform.select({
              ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.18, shadowRadius: 24 },
              android: { elevation: 14 },
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
                  <Text style={{ flex: 1, fontSize: 16, color: it.color, fontWeight: '600', letterSpacing: -0.1 }}>
                    {it.label}
                  </Text>
                  {Ico ? <Ico color={it.color} size={22} /> : null}
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
  // Polish: avatar 36→40, name 15/700→16/700, last seen 11→12 regular,
  // 1px hairline divider beneath separates header from messages.
  const headerJSX = (
    <View style={{
      backgroundColor: headerBg,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: 'rgba(255,255,255,0.10)',
    }}>
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 12,
        paddingHorizontal: 14, paddingVertical: 12,
      }}>
        <PeekAvatar email={peerEmail} name={peerName} size={36} />
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Text style={{ fontSize: 16, fontWeight: '700', color: '#fff', flexShrink: 1, letterSpacing: -0.15 }} numberOfLines={1}>
              {peerName}
            </Text>
            {/* Fix 2 — online dot for direct chats only */}
            {(!isGroup && isPeerOnline) ? (
              <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#22C55E' }} />
            ) : null}
          </View>
          {peerTyping ? (
            <Text style={{ fontSize: 12, color: '#fff', fontStyle: 'italic', fontWeight: '600', marginTop: 1 }} numberOfLines={1}>
              {t?.('chat.typing') || 'digitando...'}
            </Text>
          ) : (lastSeen ? (
            <Text style={{ fontSize: 12, color: 'rgba(255,255,255,0.78)', fontWeight: '400', marginTop: 1 }} numberOfLines={1}>
              {lastSeen}
            </Text>
          ) : null)}
        </View>
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
          borderRadius: 22,
          overflow: 'hidden',
          ...Platform.select({
            ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.18, shadowRadius: 24 },
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
    ? previewMsgs.slice(-30)
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

  // Peek height adapta ao numero de mensagens. Round 3 (2026-05-04): bumpado
  // pra suportar ate 30 msgs sem corte — user pediu "puxar conversa antiga
  // alem de ontem". Maior limite: 60% da tela.
  const peekHeight = rows.length <= 1 ? 200
                    : rows.length <= 3 ? 280
                    : rows.length <= 8 ? 380
                    : Math.min(560, 380 + (rows.length - 8) * 24);
  return (
    <TouchableOpacity activeOpacity={0.95} onPress={onOpen} accessibilityRole="button" accessibilityLabel={peerName}>
      <View style={{
        height: peekHeight,
        backgroundColor: cardBg,
        // Polish: 14→22pt radius, Telegram-soft shadow (opacity 0.18, radius 24,
        // offset 0/12) instead of the previous heavier 0.3 / 8 / 22.
        borderRadius: 22,
        overflow: 'hidden',
        ...Platform.select({
          ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.18, shadowRadius: 24 },
          android: { elevation: 16 },
          default: {},
        }),
      }}>
        {/* Header */}
        {headerJSX}

        {/* Messages — scroll disabled (peek is static).
            Polish: consistent 12V/14H interior padding (was 8V/10H), keeps
            content from kissing the rounded corners of the card. */}
        <View style={{ flex: 1, paddingHorizontal: 14, paddingVertical: 12, justifyContent: 'flex-end' }}>
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
              // status_reply: o markdown stripper acima come os underscores
              // de reply_text/media_url, mas a estrutura JSON continua valida.
              // Pra surfacar a resposta no peek (em vez de "Anexo" generico),
              // detectar pela shape: precisa ser status_reply OU JSON com
              // status object aninhado. Re-parsear m.content original (sem
              // markdown stripping) pra recuperar reply_text com underscore.
              if (m.type === 'status_reply' || (body.startsWith('{') && body.includes('"status"'))) {
                try {
                  const raw = typeof m.content === 'string' ? m.content : '';
                  const sr = JSON.parse(raw);
                  if (sr && sr.reply_text !== undefined && sr.status) {
                    const stType = sr.status?.type;
                    const tag = stType === 'image' ? (t?.('status.typePhoto') || 'Foto')
                              : stType === 'video' ? (t?.('status.typeVideo') || 'Vídeo')
                              : (t?.('status.statusLabel') || 'Status');
                    const txt = String(sr.reply_text || '').trim();
                    body = txt ? ('↩ ' + txt + ' · ' + tag) : ('↩ ' + tag);
                  }
                } catch {}
              } else if (body.startsWith('{')) {
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
                  {/* Polish: numberOfLines 3→2 to keep bubbles compact and
                      let more rows fit vertically; the full text stays
                      one tap away inside the conversation. */}
                  <Text style={{ fontSize: 14, color: txtCol, lineHeight: 19 }} numberOfLines={2}>
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
    paddingVertical: 10,
    gap: 8,
  },
  // Filter pills — taller + rounder so they read like real WhatsApp/Telegram
  // category chips. The active state gets a soft purple lift via chipActive
  // (boxShadow on web, elevation native) so the selected filter pops.
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 999,
    borderWidth: 1,
    height: 37,
    justifyContent: 'center',
    flexShrink: 0,
  },
  chipActive: {
    backgroundColor: '#7C3AED',
    borderColor: '#7C3AED',
    ...Platform.select({
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.34, shadowRadius: 9 },
      android: { elevation: 4 },
      web: { boxShadow: '0 3px 12px rgba(124,58,237,0.36)' },
    }),
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 0.05,
  },
  chipBadge: {
    minWidth: 20,
    height: 20,
    borderRadius: 999,
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
    paddingTop: 18,
    paddingBottom: 7,
  },
  sectionLabelText: {
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 1.5,
    textTransform: 'uppercase',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
    minHeight: 78,
    ...(Platform.OS === 'web' ? {
      transition: 'background-color 0.18s ease, box-shadow 0.18s ease',
      cursor: 'pointer',
    } : {}),
  },
  avatarWrap: {
    position: 'relative',
    marginRight: 14,
    // Subtle lift under the avatar so it reads as a layered token, iMessage-
    // style. Soft + tight so it never looks like a heavy drop shadow.
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.10, shadowRadius: 4 },
      android: {},
      web: {},
      default: {},
    }),
  },
  onlineDot: {
    position: 'absolute',
    bottom: 1,
    right: 1,
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
    marginBottom: 4,
  },
  rowName: {
    fontSize: 16.5,
    fontWeight: '600',
    flex: 1,
    letterSpacing: -0.3,
  },
  rowNameUnread: { fontWeight: '700', letterSpacing: -0.35 },
  // Timestamp sits flush-right, tabular-ish so the right column stays aligned
  // across rows regardless of "agora" vs "14:32" vs "Ontem".
  rowTime: { fontSize: 12, letterSpacing: -0.1, fontWeight: '500', fontVariant: ['tabular-nums'] },
  rowBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 3,
  },
  rowPreview: {
    fontSize: 14.5,
    flex: 1,
    marginRight: 10,
    lineHeight: 20,
    letterSpacing: -0.1,
  },
  // Unread badge — brand-purple pill (was WhatsApp green). Crisp squircle pill
  // with a soft brand glow so a fresh count reads as the colored attention dot.
  // minWidth === height keeps single-digit counts a perfect circle; multi-digit
  // grows into a clean pill.
  unreadBadge: {
    minWidth: 21,
    height: 21,
    borderRadius: 999,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 6.5,
    backgroundColor: '#7C3AED',
  },
  unreadBadgeShadow: {
    ...Platform.select({
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.38, shadowRadius: 5 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 7px rgba(124,58,237,0.4)' },
      default: {},
    }),
  },
  unreadText: {
    color: '#fff',
    fontSize: 11.5,
    fontWeight: '800',
    letterSpacing: 0.1,
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
      ios: { backgroundColor: ACCENT },
      android: { backgroundColor: ACCENT },
      web: { backgroundColor: ACCENT },
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
    fontSize: 25,
    fontWeight: '800',
    letterSpacing: -0.6,
    textAlign: 'center',
  },
  emptySubtitle: {
    fontSize: 15,
    textAlign: 'center',
    marginTop: 12,
    lineHeight: 22,
    letterSpacing: 0,
    maxWidth: 300,
  },
  // Empty-state CTA — pill button lifted with the brand purple glow so it
  // reads as the obvious next action on an otherwise empty screen.
  emptyAction: {
    marginTop: 30,
    backgroundColor: ACCENT,
    paddingHorizontal: 38,
    paddingVertical: 15,
    borderRadius: 999,
    ...Platform.select({
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.32, shadowRadius: 12 },
      android: { elevation: 4 },
      web: { boxShadow: `0 6px 18px rgba(124,58,237,0.34)`, transition: 'transform 0.15s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.15s ease' },
    }),
  },
  emptyActionText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  listEmpty: { flexGrow: 1 },
  fab: {
    position: 'absolute',
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#7C3AED',
    ...Platform.select({
      ios: { shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.4, shadowRadius: 14 },
      android: { elevation: 6 },
      web: {
        boxShadow: '0 8px 22px rgba(124,58,237,0.42)',
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
