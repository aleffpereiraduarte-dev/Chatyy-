import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList,
  ActivityIndicator, RefreshControl, TextInput, Alert,
  Animated, PanResponder, Platform, LayoutAnimation, UIManager, Image,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import * as api from '../services/api';
import { emailToDisplayName } from '../services/api';
import { cacheConversations, getCachedConversations } from '../services/chatCache';
import { IconMessageSquare, IconSearch, IconX, IconTrash, IconArchive, IconVolume2, IconCheck } from './Icons';
import AvatarCircle from './AvatarCircle';
import BroadcastModal from './BroadcastModal';

// Enable LayoutAnimation on Android
if (Platform.OS === 'android' && UIManager.setLayoutAnimationEnabledExperimental) {
  UIManager.setLayoutAnimationEnabledExperimental(true);
}

const ACCENT = '#25D366';
const SWIPE_THRESHOLD = 70;
const SWIPE_MAX = 160;
const useNative = Platform.OS !== 'web';

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
  const Svg = require('react-native-svg').default;
  const { Path } = require('react-native-svg');
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
  const Svg = require('react-native-svg').default;
  const { Path, Rect } = require('react-native-svg');
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <Rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <Path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </Svg>
  );
}

// Muted bell-off icon
function IconBellOff({ size = 24, color = '#666' }) {
  const Svg = require('react-native-svg').default;
  const { Path } = require('react-native-svg');
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
function SkeletonRow({ isDark }) {
  const opacity = useRef(new Animated.Value(0.3)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
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
      <View style={[{ width: 56, height: 56, borderRadius: 28, backgroundColor: bg, marginRight: 15 }]} />
      <View style={{ flex: 1, gap: 10 }}>
        <View style={{ width: '60%', height: 14, borderRadius: 7, backgroundColor: bg }} />
        <View style={{ width: '85%', height: 12, borderRadius: 6, backgroundColor: bg }} />
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
        <Animated.View key={i} style={{ width: 5, height: 5, borderRadius: 2.5, backgroundColor: color || ACCENT, opacity: dot }} />
      ))}
    </View>
  );
}

// ── Online pulse animation ──
function PulsingOnlineDot({ colors }) {
  const pulse = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.5, duration: 1200, useNativeDriver: useNative }),
        Animated.timing(pulse, { toValue: 1, duration: 1200, useNativeDriver: useNative }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, []);
  const pulseOpacity = pulse.interpolate({ inputRange: [1, 1.5], outputRange: [0.6, 0] });
  return (
    <View style={[s.onlineDot, { borderColor: colors.background }]}>
      <Animated.View style={{
        position: 'absolute', width: 14, height: 14, borderRadius: 7,
        backgroundColor: ACCENT, opacity: pulseOpacity,
        transform: [{ scale: pulse }],
      }} />
    </View>
  );
}

// ── Group avatar stack (2-3 member photos) ──
function GroupAvatarStack({ conversation, size = 56 }) {
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
            borderWidth: 2, borderColor: '#fff', zIndex: 2 - i,
            overflow: 'hidden',
          }}>
            <AvatarCircle name={name} email={email} size={smallSize - 4} />
          </View>
        );
      })}
      {members.length > 2 && (
        <View style={{
          position: 'absolute', right: 0, top: (size - smallSize) / 2,
          width: smallSize * 0.7, height: smallSize * 0.7, borderRadius: smallSize * 0.35,
          backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center',
          borderWidth: 1.5, borderColor: '#fff', zIndex: 3,
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
}) {
  const isGroup = conversation.type === 'group';
  const isChannel = conversation.type === 'channel';
  const displayName = emailToDisplayName(conversation.display_name || conversation.name || t('chat.unknown'));
  const unread = conversation.unread_count > 0;
  const lastMsg = conversation.last_message;
  const isArchived = conversation.archived;
  const isPinned = !!conversation.pinned;
  const isMuted = !!conversation.muted;

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

    let content = lastMsg.content || '';
    if (content.startsWith('{')) {
      try {
        const parsed = JSON.parse(content);
        if (parsed.call_type === 'video') content = '\uD83D\uDCF9 ' + (t('chat.videoCall') || 'Chamada de video');
        else if (parsed.call_type === 'audio') content = '\uD83D\uDCDE ' + (t('chat.voiceCall') || 'Chamada de voz');
        else if (parsed.type === 'location') content = '\uD83D\uDCCD ' + (t('chat.location') || 'Localiza\u00E7\u00E3o');
        else if (parsed.type === 'contact') content = '\uD83D\uDC64 ' + (t('chat.contact') || 'Contato');
        else content = '\uD83D\uDCCE ' + (t('chat.attachment') || 'Anexo');
      } catch {}
    }
    if (lastMsg.type === 'image') content = '\uD83D\uDCF7 ' + (t('chat.photo') || 'Foto');
    else if (lastMsg.type === 'video' && !content.startsWith('\uD83C\uDFA5')) content = '\uD83C\uDFA5 ' + (t('chat.video') || 'V\u00EDdeo');
    else if (lastMsg.type === 'audio' && !content.startsWith('\uD83D\uDCDE')) content = '\uD83C\uDFB5 ' + (t('chat.audio') || '\u00C1udio');
    else if (lastMsg.type === 'file') content = '\uD83D\uDCCE ' + (lastMsg.file_name || t('chat.file') || 'Arquivo');

    if (lastMsg.type === 'system') {
      preview = content;
    } else if (isGroup && lastMsg.sender_email !== currentEmail) {
      const sender = emailToDisplayName(lastMsg.sender_name || lastMsg.sender_email || '');
      // Store sender separately for bold rendering
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
        // Need strong horizontal intent to avoid blocking FlatList scroll
        if (Math.abs(g.dx) < 25) return false;
        if (Math.abs(g.dx) < Math.abs(g.dy) * 2.5) return false;
        return true;
      },
      onMoveShouldSetPanResponderCapture: () => false,
      onStartShouldSetPanResponder: () => false,
      onPanResponderMove: (_, g) => {
        translateX.setValue(Math.max(Math.min(g.dx, SWIPE_MAX), -SWIPE_MAX));
      },
      onPanResponderRelease: (_, g) => {
        const velocity = Math.abs(g.vx);
        if (g.dx < -SWIPE_THRESHOLD || (g.vx < -0.5 && g.dx < -30)) {
          // Snap left open (archive/delete)
          swipeOpen.current = 'left';
          Animated.spring(translateX, { toValue: -SWIPE_MAX, friction: 8, tension: 80, useNativeDriver: useNative }).start();
        } else if (g.dx > SWIPE_THRESHOLD || (g.vx > 0.5 && g.dx > 30)) {
          // Snap right open (mute/pin)
          swipeOpen.current = 'right';
          Animated.spring(translateX, { toValue: SWIPE_MAX, friction: 8, tension: 80, useNativeDriver: useNative }).start();
        } else {
          // Snap back
          swipeOpen.current = false;
          Animated.spring(translateX, { toValue: 0, friction: 8, tension: 100, useNativeDriver: useNative }).start();
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
        <View style={{ flexDirection: 'row', marginRight: 2 }}>
          <IconCheck size={14} color="#53BDEB" style={{ marginRight: -8 }} />
          <IconCheck size={14} color="#53BDEB" />
        </View>
      );
    }
    if (statusType === 'delivered') {
      return (
        <View style={{ flexDirection: 'row', marginRight: 2 }}>
          <IconCheck size={14} color={isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)'} style={{ marginRight: -8 }} />
          <IconCheck size={14} color={isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)'} />
        </View>
      );
    }
    return (
      <IconCheck size={14} color={isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.3)'} style={{ marginRight: 2 }} />
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

  return (
    <View style={s.swipeContainer}>
      {/* Left actions (revealed on swipe right): Mute + Pin */}
      <Animated.View style={[s.swipeActionsLeft, { opacity: leftOpacity }]}>
        <TouchableOpacity style={[s.swipeActionBtnWide, { backgroundColor: '#6366F1', borderRadius: 14, marginLeft: 4, marginVertical: 3 }]} onPress={() => { resetSwipe(); propsRef.current.onMute?.(conversation); }}>
          <IconVolume2 size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{t('chat.mute') || 'Mute'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.swipeActionBtnWide, { backgroundColor: '#F59E0B', borderRadius: 14, marginRight: 4, marginVertical: 3 }]} onPress={() => { resetSwipe(); propsRef.current.onPin?.(conversation); }}>
          <IconPin size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{isPinned ? (t('chat.unpin') || 'Unpin') : (t('chat.pin') || 'Pin')}</Text>
        </TouchableOpacity>
      </Animated.View>
      {/* Right actions (revealed on swipe left): Archive + Delete */}
      <Animated.View style={[s.swipeActionsRight, { opacity: rightOpacity }]}>
        <TouchableOpacity style={[s.swipeActionBtnWide, { backgroundColor: '#3B82F6', borderRadius: 14, marginLeft: 4, marginVertical: 3 }]} onPress={() => { resetSwipe(); propsRef.current.onArchive?.(conversation); }}>
          <IconArchive size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{isArchived ? (t('chat.unarchive') || 'Unarchive') : (t('chat.archive') || 'Archive')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[s.swipeActionBtnWide, { backgroundColor: '#EF4444', borderRadius: 14, marginRight: 4, marginVertical: 3 }]} onPress={() => { resetSwipe(); propsRef.current.onDelete?.(conversation); }}>
          <IconTrash size={22} color="#fff" />
          <Text style={s.swipeActionLabel}>{t('chat.delete') || 'Delete'}</Text>
        </TouchableOpacity>
      </Animated.View>
      <Animated.View {...panResponder.panHandlers} style={{ transform: [{ translateX }], backgroundColor: colors.background }}>
        <TouchableOpacity
          style={[
            s.row,
            { backgroundColor: isPinned ? (isDark ? 'rgba(255,255,255,0.03)' : 'rgba(37,211,102,0.03)') : colors.background },
          ]}
          onPress={() => {
            if (swipeOpen.current) { resetSwipe(); return; }
            onPress();
          }}
          activeOpacity={0.6}
          delayPressIn={60}
        >
          <View style={s.avatarWrap}>
            {isGroup ? (
              <GroupAvatarStack conversation={conversation} size={56} />
            ) : (
              <AvatarCircle
                name={displayName}
                email={otherEmail}
                size={56}
              />
            )}
            {isOnline && <PulsingOnlineDot colors={colors} />}
          </View>
          <View style={s.rowContent}>
            <View style={s.rowTop}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1, marginRight: 10 }}>
                {isChannel && <Text style={{ fontSize: 14, marginRight: 3 }}>{'\uD83D\uDCE2'}</Text>}
                <Text style={[s.rowName, { color: colors.text }, unread && s.rowNameUnread]} numberOfLines={1}>{displayName}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                {isPinned && <IconPin size={12} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'} />}
                {isLocked && <IconLock size={12} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'} />}
                <Text style={[s.rowTime, unread ? { color: ACCENT, fontWeight: '700' } : { color: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)' }]}>
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
                  <Text style={[s.rowPreview, { color: ACCENT, fontStyle: 'italic', fontWeight: '500', flex: 0 }]} numberOfLines={1}>
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
                  <View style={[s.unreadBadge, s.unreadBadgeShadow, { minWidth: 24, backgroundColor: ACCENT }]}>
                    <Text style={s.unreadText}>@</Text>
                  </View>
                )}
                {unread && (
                  <View style={[s.unreadBadge, s.unreadBadgeShadow, isMuted && { backgroundColor: isDark ? '#555' : '#999' }]}>
                    <Text style={s.unreadText}>{conversation.unread_count > 99 ? '99+' : conversation.unread_count}</Text>
                  </View>
                )}
              </View>
            </View>
          </View>
        </TouchableOpacity>
      </Animated.View>
    </View>
  );
}, (prev, next) => {
  // Custom comparison for performance - only re-render when these change
  return (
    prev.conversation === next.conversation &&
    prev.isDark === next.isDark &&
    prev.isLocked === next.isLocked &&
    prev.typingUsers === next.typingUsers &&
    prev.isOnline === next.isOnline
  );
});

export default function ChatListTab({ colors, isDark, t, user, router }) {
  const [conversations, setConversations] = useState([]);
  const [archivedConversations, setArchivedConversations] = useState([]);
  const [loading, setLoading] = useState(true);
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
  const searchTimerRef = useRef(null);
  const wsUpdateTimer = useRef(null);

  const loadConversations = useCallback(async (showLoader) => {
    // Show cached conversations immediately so the list appears instant
    if (showLoader) {
      try {
        const cached = await getCachedConversations();
        if (cached.length > 0) {
          setConversations(cached.filter(c => !c.archived));
          setArchivedConversations(cached.filter(c => c.archived));
          setLoading(false); // Hide skeleton as soon as cache is ready
        } else {
          setLoading(true);
        }
      } catch {
        setLoading(true);
      }
    }
    try {
      // Load both in parallel for speed
      const [r, rAll] = await Promise.all([
        api.chatConversations(searchText, false),
        api.chatConversations(searchText, true),
      ]);
      if (r.success) {
        const convs = Array.isArray(r.data) ? r.data : (r.data?.conversations || []);
        setConversations(convs);
        // Update cache in background (don't await)
        cacheConversations(convs).catch(() => {});
      }
      if (rAll.success) {
        const all = Array.isArray(rAll.data) ? rAll.data : (rAll.data?.conversations || []);
        const archived = all.filter(c => c.archived);
        setArchivedConversations(archived);
        // Cache all conversations (active + archived)
        cacheConversations(all).catch(() => {});
      }
    } catch {} finally { setLoading(false); setRefreshing(false); }
  }, [searchText]);

  useEffect(() => { loadConversations(true); }, [loadConversations]);

  // Load locked conversations
  useEffect(() => {
    api.chatGetLocked().then(r => {
      if (r.success && r.data?.locked_conversations) {
        setLockedIds(new Set(r.data.locked_conversations.map(Number)));
      }
    }).catch(() => {});
  }, []);

  // Debounced search
  const handleSearchChange = useCallback((text) => {
    setSearchText(text);
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => {
      loadConversations(false);
    }, 400);
  }, [loadConversations]);

  // WebSocket: typing + new message + read receipts
  useEffect(() => {
    let unsubs = [];
    try {
      const mailWs = require('../services/websocket').default;

      // Typing indicators
      unsubs.push(mailWs.on('typing', (data) => {
        if (!data?.conversation_id || data?.email === user?.email) return;
        const name = emailToDisplayName(data.name || data.email || '');
        setTypingUsers(prev => ({ ...prev, [data.conversation_id]: name }));
        setTimeout(() => {
          setTypingUsers(prev => {
            const next = { ...prev };
            if (next[data.conversation_id] === name) delete next[data.conversation_id];
            return next;
          });
        }, 3000);
      }));

      // New message → update specific conversation locally instead of full reload
      unsubs.push(mailWs.on('chat_message', (data) => {
        if (wsUpdateTimer.current) clearTimeout(wsUpdateTimer.current);
        wsUpdateTimer.current = setTimeout(() => {
          setConversations(prev => {
            const idx = prev.findIndex(c => c.id == data.conversation_id || c.conversation_id == data.conversation_id);
            if (idx === -1) {
              // New conversation - do a full load
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
            // Move to top
            const [moved] = updated.splice(idx, 1);
            updated.unshift(moved);
            return updated;
          });
        }, 100);
      }));

      // Read receipt → update unread count locally
      unsubs.push(mailWs.on('chat_read', (data) => {
        setConversations(prev => prev.map(c =>
          (c.id == data.conversation_id || c.conversation_id == data.conversation_id)
            ? { ...c, unread_count: 0 }
            : c
        ));
      }));
    } catch {}
    return () => unsubs.forEach(fn => fn?.());
  }, [user?.email, loadConversations]);

  // Presence polling with Map ref - only triggers re-render when online set changes
  useEffect(() => {
    const updatePresences = (data) => {
      if (!Array.isArray(data)) return;
      const newMap = new Map();
      data.forEach(p => { if (p.email) newMap.set(p.email, p.status); });
      // Check if anything changed
      let changed = newMap.size !== presencesRef.current.size;
      if (!changed) {
        for (const [email, status] of newMap) {
          if (presencesRef.current.get(email) !== status) { changed = true; break; }
        }
      }
      if (changed) {
        presencesRef.current = newMap;
        setPresenceVersion(v => v + 1);
      }
    };
    api.chatPresence('online').then(r => { if (r.success && r.data) updatePresences(r.data); }).catch(() => {});
    const interval = setInterval(() => {
      api.chatPresence('online').then(r => { if (r.success && r.data) updatePresences(r.data); }).catch(() => {});
    }, 20000);
    return () => clearInterval(interval);
  }, []);

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

  const handleDeleteConversation = useCallback((conv) => {
    safeAlert(t('chat.deleteConversation'), t('chat.deleteConversationConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t('chat.delete'), style: 'destructive',
        onPress: async () => {
          try {
            const r = await api.chatDeleteConversation(conv.id);
            if (r.success) {
              LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
              setConversations(prev => prev.filter(c => c.id !== conv.id));
              setArchivedConversations(prev => prev.filter(c => c.id !== conv.id));
            }
            else safeAlert(t('chat.deleteConversationError'));
          } catch { safeAlert(t('chat.deleteConversationError')); }
        },
      },
    ]);
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
            : { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)' },
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
        style={[s.archivedHeader, { backgroundColor: isDark ? '#1a2e1f' : '#f0faf3', borderBottomColor: isDark ? '#2a3a2e' : '#d8f0de' }]}
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
        />
      </>
    );
  }, [filter, pinnedCount, isDark, colors, t, handleConversationPress, handleDeleteConversation, handleArchiveConversation, handleMuteConversation, handlePinConversation, user?.email, presenceVersion, lockedIds, unlockedIds, typingUsers]);

  const keyExtractor = useCallback((item) => String(item.id), []);

  // Stable FlatList sub-components to avoid re-creation on each render
  const ListHeaderComponent = useMemo(() => (
    <>
      {renderArchivedHeader()}
      {renderPinnedLabel()}
    </>
  ), [filter, pinnedCount, isDark, colors, t, archivedCount]);

  const ListEmptyComponent = useMemo(() => loading ? null : (
    <View style={s.emptyContainer}>
      <View style={[s.emptyIconOuter, { backgroundColor: isDark ? 'rgba(37,211,102,0.06)' : 'rgba(37,211,102,0.06)' }]}>
        <View style={[s.emptyIconWrap, { backgroundColor: isDark ? 'rgba(37,211,102,0.12)' : 'rgba(37,211,102,0.10)', borderColor: isDark ? 'rgba(37,211,102,0.2)' : 'rgba(37,211,102,0.18)' }]}>
          <IconMessageSquare size={44} color={ACCENT} />
        </View>
      </View>
      <Text style={[s.emptyTitle, { color: colors.text }]}>{t('chat.empty')}</Text>
      <Text style={[s.emptySubtitle, { color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)' }]}>{t('chat.emptyDesc')}</Text>
      <TouchableOpacity
        style={s.emptyAction}
        onPress={() => router.push('/chat-new')}
        activeOpacity={0.8}
      >
        <Text style={s.emptyActionText}>{t('chat.newConversation') || 'Iniciar conversa'}</Text>
      </TouchableOpacity>
    </View>
  ), [loading, isDark, colors, t, router]);

  const ItemSeparatorComponent = useCallback(() => (
    <View style={[s.separator, { backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', marginLeft: 86 }]} />
  ), [isDark]);

  return (
    <View style={{ flex: 1 }}>
      {/* Search */}
      <View style={s.searchWrap}>
        <View style={[
          s.searchBar,
          {
            backgroundColor: isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.04)',
            borderColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
          },
          searchText.length > 0 && { borderColor: ACCENT + '40' },
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

      {/* List */}
      {loading && !refreshing ? (
        <View style={{ flex: 1, paddingTop: 8 }}>
          {[0, 1, 2, 3, 4, 5, 6].map(i => <SkeletonRow key={i} isDark={isDark} />)}
        </View>
      ) : (
        <FlatList
          data={filteredConversations}
          keyExtractor={keyExtractor}
          ListHeaderComponent={ListHeaderComponent}
          renderItem={renderItem}
          ListEmptyComponent={ListEmptyComponent}
          contentContainerStyle={[filteredConversations.length === 0 && s.listEmpty]}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={ACCENT} />}
          ItemSeparatorComponent={ItemSeparatorComponent}
          // Performance optimizations
          removeClippedSubviews={Platform.OS !== 'web'}
          maxToRenderPerBatch={15}
          windowSize={11}
          initialNumToRender={12}
          updateCellsBatchingPeriod={50}
          getItemLayout={(data, index) => ({ length: 80, offset: 80 * index, index })}
        />
      )}

      {/* FAB */}
      <TouchableOpacity
        style={[s.fab, { bottom: 80 }]}
        onPress={() => router.push('/chat-new')}
        onLongPress={() => setShowBroadcast(true)}
        activeOpacity={0.82}
      >
        <IconMessageSquare size={26} color="#fff" />
      </TouchableOpacity>

      {/* Broadcast Modal */}
      <BroadcastModal
        visible={showBroadcast}
        onClose={() => setShowBroadcast(false)}
        onCreated={() => { setShowBroadcast(false); loadConversations(false); }}
        colors={colors}
        t={t}
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
    borderRadius: 26,
    paddingHorizontal: 16,
    height: 44,
    gap: 10,
    borderWidth: 1,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.06, shadowRadius: 8 },
      android: { elevation: 2 },
      web: { boxShadow: '0 1px 6px rgba(0,0,0,0.06)', transition: 'border-color 0.2s ease, box-shadow 0.2s ease' },
    }),
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
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  chipActive: {
    backgroundColor: ACCENT,
    borderColor: ACCENT,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.35, shadowRadius: 6 },
      android: { elevation: 4 },
      web: { boxShadow: `0 3px 10px rgba(37,211,102,0.35), 0 1px 3px rgba(37,211,102,0.2)` },
    }),
  },
  chipText: {
    fontSize: 13,
    fontWeight: '600',
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
  },
  avatarWrap: {
    position: 'relative',
    marginRight: 15,
  },
  onlineDot: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 15,
    height: 15,
    borderRadius: 8,
    backgroundColor: ACCENT,
    borderWidth: 2.5,
    zIndex: 5,
    overflow: 'visible',
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 0 }, shadowOpacity: 0.6, shadowRadius: 5 },
      android: { elevation: 4 },
      web: { boxShadow: `0 0 0 2.5px rgba(37,211,102,0.2), 0 0 8px rgba(37,211,102,0.5)` },
    }),
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
    letterSpacing: 0.15,
  },
  rowNameUnread: { fontWeight: '800' },
  rowTime: { fontSize: 11, letterSpacing: 0.3, fontWeight: '500' },
  rowBottom: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 3,
  },
  rowPreview: {
    fontSize: 14,
    flex: 1,
    marginRight: 10,
    lineHeight: 20,
    letterSpacing: 0.05,
  },
  unreadBadge: {
    minWidth: 24,
    height: 22,
    borderRadius: 12,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 7,
  },
  unreadBadgeShadow: {
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.45, shadowRadius: 6 },
      android: { elevation: 4 },
      web: { boxShadow: `0 2px 8px rgba(37,211,102,0.45), 0 0px 2px rgba(37,211,102,0.2)`, background: 'linear-gradient(135deg, #25D366 0%, #128C7E 100%)' },
    }),
  },
  unreadText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '800',
    letterSpacing: 0.3,
  },
  separator: {
    height: StyleSheet.hairlineWidth,
  },
  swipeContainer: {
    position: 'relative',
    overflow: 'hidden',
  },
  swipeActionsLeft: {
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 160,
    flexDirection: 'row',
    gap: 2,
  },
  swipeActionsRight: {
    position: 'absolute', right: 0, top: 0, bottom: 0, width: 160,
    flexDirection: 'row',
    gap: 2,
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
  archivedHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: 1,
    marginHorizontal: 12,
    marginTop: 4,
    marginBottom: 4,
    borderRadius: 12,
  },
  archivedHeaderIcon: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 14,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4 },
      android: { elevation: 2 },
      web: { boxShadow: `0 2px 6px rgba(37,211,102,0.25)` },
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
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 8,
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
  emptyIconOuter: {
    width: 140,
    height: 140,
    borderRadius: 70,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  emptyIconWrap: {
    width: 100,
    height: 100,
    borderRadius: 50,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
  },
  emptyTitle: {
    fontSize: 22,
    fontWeight: '700',
    marginTop: 20,
    letterSpacing: 0.3,
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
    paddingHorizontal: 32,
    paddingVertical: 14,
    borderRadius: 26,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 8 },
      android: { elevation: 6 },
      web: { boxShadow: `0 4px 14px rgba(37,211,102,0.35), 0 2px 4px rgba(0,0,0,0.08)` },
    }),
  },
  emptyActionText: {
    color: '#fff',
    fontSize: 15.5,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  listEmpty: { flexGrow: 1 },
  fab: {
    position: 'absolute',
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 18,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.45, shadowRadius: 14 },
      android: { elevation: 12 },
      web: { boxShadow: `0 8px 24px rgba(37,211,102,0.45), 0 2px 8px rgba(0,0,0,0.1)`, transition: 'transform 0.15s ease, box-shadow 0.15s ease' },
    }),
  },
  loaderWrap: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
});
