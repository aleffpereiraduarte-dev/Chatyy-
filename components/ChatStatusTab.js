import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform,
  Modal, TextInput, Image, Animated, Dimensions, KeyboardAvoidingView,
  ActivityIndicator, PanResponder, Pressable,
} from 'react-native';
import AvatarCircle from './AvatarCircle';
import StatusCamera from './StatusCamera';
import { IconPlus, IconCamera, IconEdit, IconX, IconSearch, IconTrash, IconEye, IconChevronLeft, IconChevronRight, IconSend, IconPause, IconPlay, IconForward } from './Icons';
import * as api from '../services/api';
import { BASE_URL, chatCreate, chatSend, chatConversations, statusViewers, emailToDisplayName, searchDeezerMusic } from '../services/api';
import { getCached, setCache } from '../services/cache';
// Lazy import to avoid circular dependency / initialization errors on web
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}
import Svg, { Circle as SvgCircle, Path, Rect, Defs, LinearGradient, Stop } from 'react-native-svg';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Stable component for native audio playback via hidden WebView
// Using a proper component (not IIFE) prevents remounting on every parent render
function NativeAudioPlayer({ url }) {
  if (!url || Platform.OS === 'web') return null;
  const WebView = require('react-native-webview').WebView;
  const html = `<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><audio id="a" src="${url}" autoplay loop playsinline webkit-playsinline></audio><script>var a=document.getElementById('a');a.play().catch(function(){});document.addEventListener('visibilitychange',function(){if(!document.hidden)a.play().catch(function(){});});</script></body></html>`;
  return (
    <WebView
      source={{ html, baseUrl: 'https://chatyy.com.br' }}
      style={{ width: 1, height: 1, position: 'absolute', top: -10, left: -10, opacity: 0 }}
      mediaPlaybackRequiresUserAction={false}
      allowsInlineMediaPlayback={true}
      javaScriptEnabled={true}
      originWhitelist={['*']}
    />
  );
}

// Native video player for status viewer (separate component for valid hook usage)
function StatusVideoPlayer({ url }) {
  if (Platform.OS === 'web') return null;
  try {
    const { useVideoPlayer, VideoView } = require('expo-video');
    const player = useVideoPlayer(url, (p) => { p.loop = true; p.play(); });
    return <VideoView player={player} style={{ width: SCREEN_WIDTH, height: '100%' }} contentFit="contain" />;
  } catch { return null; }
}

const STATUS_DURATION = 5000;
const ACCENT = '#7C3AED';
const GRADIENT_COLORS = ['#7C3AED', '#6D28D9', '#6D28D9'];

// --- Music Note Icon ---
function IconMusicNote({ size = 20, color = '#fff' }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d="M9 18V5l12-2v13" />
      <SvgCircle cx="6" cy="18" r="3" />
      <SvgCircle cx="18" cy="16" r="3" />
    </Svg>
  );
}

// --- Audio player for music previews (web + native via hidden WebView) ---
let _statusAudioRef = null;
// Native audio URL is stored here and rendered by a hidden WebView in the component
let _nativeAudioUrl = null;
let _nativeAudioCallback = null;
function playStatusAudio(url) {
  stopStatusAudio();
  if (!url) return;
  if (Platform.OS !== 'web') {
    _nativeAudioUrl = url;
    if (_nativeAudioCallback) _nativeAudioCallback(url);
    return;
  }
  try {
    _statusAudioRef = new Audio(url);
    _statusAudioRef.volume = 0.7;
    _statusAudioRef.loop = true;
    _statusAudioRef.crossOrigin = 'anonymous';
    _statusAudioRef.play().catch((err) => {
      console.warn('[StatusMusic] Play failed:', err.message, 'URL:', url);
      // Retry without crossOrigin (some CDNs don't send CORS headers for audio)
      _statusAudioRef.crossOrigin = null;
      _statusAudioRef.load();
      _statusAudioRef.play().catch(() => {});
    });
  } catch (e) { console.warn('[StatusMusic] Audio error:', e.message); }
}
function stopStatusAudio() {
  if (_statusAudioRef) {
    try { _statusAudioRef.pause(); _statusAudioRef.src = ''; } catch {}
    _statusAudioRef = null;
  }
  _nativeAudioUrl = null;
  if (_nativeAudioCallback) _nativeAudioCallback(null);
}

function timeAgo(dateStr, t) {
  if (!dateStr) return '';
  let str = String(dateStr);
  // Fix PostgreSQL format: "2026-03-22 16:05:53.149596+00" -> ISO 8601
  if (!str.includes('T')) str = str.replace(' ', 'T');
  if (!str.endsWith('Z') && !str.includes('+')) str += 'Z';
  // Fix "+00" -> "+00:00" for Safari compatibility
  if (str.match(/\+\d{2}$/)) str += ':00';
  const now = Date.now();
  const then = new Date(str).getTime();
  if (isNaN(then)) return '';
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t?.('time.now') || 'now';
  if (mins < 60) return (t?.('time.min') || '{n} min').replace('{n}', mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return (t?.('time.hours') || '{n}h').replace('{n}', hrs);
  return `${Math.floor(hrs / 24)}d`;
}

const TEXT_BG_COLORS = [
  '#6D28D9', '#6D28D9', '#7C3AED', '#1A73E8', '#6B5CE7',
  '#E84393', '#D63031', '#E17055', '#FDCB6E', '#00B894',
];

// Instagram-style photo filters (CSS filter values for web; overlay tint for native)
const PHOTO_FILTERS = [
  { key: 'normal',    label: 'Normal',    css: 'none',                                    tint: null },
  { key: 'clarendon', label: 'Clarendon', css: 'contrast(1.2) saturate(1.35)',             tint: 'rgba(127,187,227,0.15)' },
  { key: 'gingham',   label: 'Gingham',   css: 'brightness(1.05) hue-rotate(-10deg)',      tint: 'rgba(230,230,250,0.15)' },
  { key: 'moon',      label: 'Moon',      css: 'grayscale(1) contrast(1.1) brightness(1.1)', tint: 'rgba(160,160,186,0.3)' },
  { key: 'lark',      label: 'Lark',      css: 'contrast(0.9) brightness(1.15) saturate(1.2)', tint: 'rgba(242,242,220,0.1)' },
  { key: 'reyes',     label: 'Reyes',     css: 'sepia(0.22) brightness(1.1) contrast(0.85) saturate(0.75)', tint: 'rgba(239,205,173,0.2)' },
  { key: 'juno',      label: 'Juno',      css: 'contrast(1.15) brightness(1.05) saturate(1.7) sepia(0.1)', tint: 'rgba(127,140,200,0.1)' },
  { key: 'slumber',   label: 'Slumber',   css: 'saturate(0.66) brightness(1.05)',          tint: 'rgba(125,105,24,0.15)' },
  { key: 'aden',      label: 'Aden',      css: 'hue-rotate(-20deg) contrast(0.9) saturate(0.85) brightness(1.2)', tint: 'rgba(66,10,14,0.1)' },
  { key: 'valencia',  label: 'Valencia',  css: 'contrast(1.08) brightness(1.08) sepia(0.08)', tint: 'rgba(58,3,3,0.1)' },
];

// ─── Draggable sticker (PanResponder for touch drag, double-tap to remove) ───
function DraggableSticker({ sticker, onMove, onRemove }) {
  const pan = useRef(new Animated.ValueXY({ x: sticker.x, y: sticker.y })).current;
  const lastTap = useRef(0);
  const panR = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => {
      pan.setOffset({ x: pan.x._value, y: pan.y._value });
      pan.setValue({ x: 0, y: 0 });
    },
    onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
    onPanResponderRelease: (_, gs) => {
      pan.flattenOffset();
      onMove?.(pan.x._value, pan.y._value);
      // Double-tap to delete
      const now = Date.now();
      if (now - lastTap.current < 300) { onRemove?.(); }
      lastTap.current = now;
    },
  })).current;
  const renderContent = () => {
    if (sticker.emoji) return <Text style={{ fontSize: 48 }}>{sticker.emoji}</Text>;
    if (sticker.type === 'poll') return (
      <View style={{ backgroundColor: 'rgba(124,58,237,0.9)', borderRadius: 14, padding: 14, width: 220 }}>
        <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700', textAlign: 'center', marginBottom: 10 }}>{sticker.question}</Text>
        <View style={{ flexDirection: 'row', gap: 8 }}>
          <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 20, paddingVertical: 8, alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '600' }}>{sticker.optionA}</Text>
          </View>
          <View style={{ flex: 1, backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 20, paddingVertical: 8, alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '600' }}>{sticker.optionB}</Text>
          </View>
        </View>
      </View>
    );
    if (sticker.type === 'question') return (
      <View style={{ backgroundColor: 'rgba(239,68,68,0.9)', borderRadius: 14, padding: 14, width: 220, alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700', marginBottom: 6 }}>{sticker.prompt}</Text>
        <View style={{ backgroundColor: 'rgba(255,255,255,0.25)', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 16, width: '100%', alignItems: 'center' }}>
          <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 13 }}>Toque pra responder</Text>
        </View>
      </View>
    );
    if (sticker.type === 'countdown') return (
      <View style={{ backgroundColor: 'rgba(16,185,129,0.9)', borderRadius: 14, padding: 14, width: 200, alignItems: 'center' }}>
        <Text style={{ color: '#fff', fontSize: 11, fontWeight: '600', marginBottom: 4 }}>{sticker.label}</Text>
        <Text style={{ color: '#fff', fontSize: 28, fontWeight: '800' }}>⏳</Text>
        <Text style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12, marginTop: 4 }}>
          {(() => {
            try { const d = new Date(sticker.targetDate); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
          })()}
        </Text>
      </View>
    );
    if (sticker.type === 'mention') return (
      <View style={{ backgroundColor: 'rgba(59,130,246,0.9)', borderRadius: 20, paddingVertical: 8, paddingHorizontal: 16 }}>
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>@{sticker.username}</Text>
      </View>
    );
    if (sticker.type === 'quiz') return (
      <View style={{ backgroundColor: 'rgba(245,158,11,0.9)', borderRadius: 14, padding: 14, width: 220 }}>
        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', textAlign: 'center', marginBottom: 8 }}>{sticker.question}</Text>
        {(sticker.options || []).map((opt, i) => (
          <View key={i} style={{ backgroundColor: i === sticker.correct ? 'rgba(16,185,129,0.5)' : 'rgba(255,255,255,0.2)', borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12, marginBottom: 4, alignItems: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '600' }}>{opt}</Text>
          </View>
        ))}
      </View>
    );
    return null;
  };
  return (
    <Animated.View
      {...panR.panHandlers}
      style={{ position: 'absolute', zIndex: 20, transform: pan.getTranslateTransform() }}
    >
      {renderContent()}
    </Animated.View>
  );
}

// ─── Draggable text overlay on photos ───
function DraggableTextOverlay({ text, color, fontSize, onMove, onRemove }) {
  const pan = useRef(new Animated.ValueXY({ x: SCREEN_WIDTH / 2 - 80, y: SCREEN_HEIGHT / 3 })).current;
  const lastTap = useRef(0);
  const panR = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onPanResponderGrant: () => { pan.setOffset({ x: pan.x._value, y: pan.y._value }); pan.setValue({ x: 0, y: 0 }); },
    onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
    onPanResponderRelease: (_, gs) => {
      pan.flattenOffset();
      onMove?.(pan.x._value, pan.y._value);
      const now = Date.now();
      if (now - lastTap.current < 300) { onRemove?.(); }
      lastTap.current = now;
    },
  })).current;
  if (!text) return null;
  return (
    <Animated.View
      {...panR.panHandlers}
      style={{ position: 'absolute', zIndex: 25, transform: pan.getTranslateTransform(),
        backgroundColor: 'rgba(0,0,0,0.5)', paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8 }}
    >
      <Text style={{ color: color || '#fff', fontSize: fontSize || 24, fontWeight: '700', textAlign: 'center' }}>{text}</Text>
    </Animated.View>
  );
}

function EmptyStatusIllustration({ isDark }) {
  return (
    <Svg width={120} height={120} viewBox="0 0 100 100" fill="none">
      <SvgCircle cx="50" cy="50" r="35" stroke={isDark ? '#374151' : '#e5e7eb'} strokeWidth="2" strokeDasharray="8 4" />
      <Rect x="38" y="35" width="24" height="30" rx="4" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="2" fill="none" />
      <SvgCircle cx="50" cy="47" r="5" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="1.5" fill="none" />
      <Path d="M38 58 L44 52 L48 56 L54 48 L62 58" stroke={isDark ? '#4b5563' : '#9ca3af'} strokeWidth="1.5" fill="none" strokeLinejoin="round" />
      <Path d="M68 30 L72 26" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />
      <Path d="M72 34 L76 34" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />
      <Path d="M68 38 L72 42" stroke={ACCENT} strokeWidth="2" strokeLinecap="round" />
    </Svg>
  );
}

/** Renders a segmented ring around an avatar (one arc per status item) */
function SegmentedRing({ items, size, viewed }) {
  const count = items?.length || 1;
  const ringSize = size + 10;
  const radius = (ringSize / 2) - 3;
  const circumference = 2 * Math.PI * radius;
  const gapDeg = count > 1 ? 6 : 0;
  const totalGapDeg = gapDeg * count;
  const segmentDeg = (360 - totalGapDeg) / count;
  const segmentLen = (segmentDeg / 360) * circumference;
  const gapLen = (gapDeg / 360) * circumference;

  return (
    <View style={{ position: 'absolute', top: -5, left: -5 }}>
      <Svg width={ringSize} height={ringSize}>
        <Defs>
          <LinearGradient id="ringGrad" x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor="#7C3AED" />
            <Stop offset="0.5" stopColor="#6D28D9" />
            <Stop offset="1" stopColor="#6D28D9" />
          </LinearGradient>
        </Defs>
        {Array.from({ length: count }).map((_, i) => {
          const isViewed = viewed || items?.[i]?.viewed;
          const offset = -((segmentLen + gapLen) * i) + (circumference * 0.25);
          return (
            <SvgCircle
              key={i}
              cx={ringSize / 2}
              cy={ringSize / 2}
              r={radius}
              stroke={isViewed ? 'rgba(150,150,150,0.35)' : 'url(#ringGrad)'}
              strokeWidth={3}
              fill="none"
              strokeDasharray={`${segmentLen} ${circumference - segmentLen}`}
              strokeDashoffset={offset}
              strokeLinecap="round"
            />
          );
        })}
      </Svg>
    </View>
  );
}

/** Horizontal story-style avatar scroller */
function StoryScroller({ statuses, myStatuses, currentEmail, currentName, onOpenViewer, onOpenCreator, isDark, colors, t }) {
  const hasMyStatus = myStatuses.length > 0;
  const myStatusGroup = hasMyStatus
    ? { ownerEmail: currentEmail, ownerName: currentName, items: myStatuses }
    : null;

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.storyScroller}
      style={styles.storyScrollerContainer}
    >
      {/* My status always first */}
      <TouchableOpacity
        style={styles.storyItem}
        onPress={() => hasMyStatus ? onOpenViewer(myStatusGroup) : onOpenCreator()}
        activeOpacity={0.7}
      >
        <View style={styles.storyAvatarWrap}>
          {hasMyStatus && <SegmentedRing items={myStatuses} size={62} viewed={false} />}
          <AvatarCircle name={currentName} email={currentEmail} size={62} />
          {!hasMyStatus && (
            <View style={[styles.storyPlusBadge, {
              borderColor: isDark ? '#1a1a2e' : '#fff',
            }]}>
              <IconPlus size={14} color="#fff" />
            </View>
          )}
        </View>
        <Text style={[styles.storyName, { color: colors.text }]} numberOfLines={1}>
          {t?.('status.myStatus') || 'My status'}
        </Text>
      </TouchableOpacity>

      {/* Contact statuses */}
      {statuses.map((group) => {
        const allViewed = group.items.every((item) => item.viewed);
        return (
          <TouchableOpacity
            key={group.ownerEmail}
            style={styles.storyItem}
            onPress={() => onOpenViewer(group)}
            activeOpacity={0.7}
          >
            <View style={styles.storyAvatarWrap}>
              <SegmentedRing items={group.items} size={62} viewed={allViewed} />
              <AvatarCircle name={group.ownerName} email={group.ownerEmail} size={62} />
            </View>
            <Text style={[styles.storyName, { color: allViewed ? colors.textSecondary : colors.text }]} numberOfLines={1}>
              {group.ownerName}
            </Text>
          </TouchableOpacity>
        );
      })}
    </ScrollView>
  );
}


// Pre-load cached statuses synchronously (native only — web uses async IndexedDB)
// so the very first render already has data and the tab doesn't flicker when
// it mounts. Mirrors the anti-flicker pattern used in ChatListTab.js.
let _preloadedStatuses = null;
if (Platform.OS !== 'web') {
  try {
    const { getString: _gs } = require('../services/mmkv');
    const raw = _gs('chat_statuses');
    if (raw) _preloadedStatuses = JSON.parse(raw);
  } catch {}
}

// Fingerprint a status group list so we can skip setState when nothing
// actually changed (id + viewed_at + created_at of every item).
function _fingerprintStatuses(mine, others) {
  try {
    const parts = [];
    for (const it of (mine || [])) {
      parts.push(`m:${it.id}:${it.viewed_at || ''}:${it.created_at || ''}`);
    }
    for (const g of (others || [])) {
      for (const it of (g.items || [])) {
        parts.push(`o:${g.ownerEmail || g.email || ''}:${it.id}:${it.viewed_at || ''}:${it.created_at || ''}`);
      }
    }
    return parts.join('|');
  } catch { return ''; }
}

export default function ChatStatusTab({ colors, isDark, t, user, router }) {
  // Read MMKV preload synchronously so the very first render already has data.
  const _initialMine = (_preloadedStatuses && Array.isArray(_preloadedStatuses.mine)) ? _preloadedStatuses.mine : [];
  const _initialOthers = (_preloadedStatuses && Array.isArray(_preloadedStatuses.others)) ? _preloadedStatuses.others : [];
  const _hadPreload = _initialMine.length > 0 || _initialOthers.length > 0;

  const [contactStatuses, setContactStatuses] = useState(() => _initialOthers);
  const [myStatuses, setMyStatuses] = useState(() => _initialMine);
  // Skip the loading spinner if we already painted from cache
  const [loading, setLoading] = useState(!_hadPreload);
  // Track the last fingerprint we rendered so we can skip setState on
  // unchanged poll/WS responses (no flicker when nothing actually changed).
  const lastStatusesFpRef = useRef(_hadPreload ? _fingerprintStatuses(_initialMine, _initialOthers) : null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  // Viewer state
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerStatuses, setViewerStatuses] = useState([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerOwnerName, setViewerOwnerName] = useState('');
  const [viewerOwnerEmail, setViewerOwnerEmail] = useState('');
  const [viewerReply, setViewerReply] = useState('');
  const [isPaused, setIsPaused] = useState(false);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);
  const animRef = useRef(null);
  const viewerOpacity = useRef(new Animated.Value(0)).current;

  // Viewers modal state
  const [viewersModal, setViewersModal] = useState(false);
  const [viewersList, setViewersList] = useState([]);
  const [viewersLoading, setViewersLoading] = useState(false);

  // Reaction state
  const QUICK_REACTIONS = ['\u{1F60D}', '\u{1F525}', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F44F}'];
  const [statusReactions, setStatusReactions] = useState({}); // { [status_id]: [{ emoji, user_email }] }
  const [myReactions, setMyReactions] = useState({}); // { [status_id]: emoji }

  // Forward modal state
  const [forwardModalVisible, setForwardModalVisible] = useState(false);
  const [forwardConversations, setForwardConversations] = useState([]);
  const [forwardLoading, setForwardLoading] = useState(false);

  const handleShowViewers = useCallback(async (statusId) => {
    setViewersLoading(true);
    setViewersModal(true);
    setIsPaused(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (animRef.current) animRef.current.stop();
    try {
      const r = await statusViewers(statusId);
      if (r.success && r.data?.viewers) {
        setViewersList(r.data.viewers);
      }
    } catch (err) {
      console.warn('[Status] Failed to load viewers:', err);
    } finally {
      setViewersLoading(false);
    }
  }, []);

  // Handle emoji reaction on a status
  const handleReact = useCallback(async (emoji) => {
    const item = viewerStatuses[viewerIndex];
    if (!item) return;
    const statusId = item.id;
    // Optimistic update
    setMyReactions(prev => ({ ...prev, [statusId]: prev[statusId] === emoji ? null : emoji }));
    setStatusReactions(prev => {
      const existing = (prev[statusId] || []).filter(r => r.user_email !== currentEmail);
      if (!(myReactions[statusId] === emoji)) {
        existing.push({ emoji, user_email: currentEmail });
      }
      return { ...prev, [statusId]: existing };
    });
    try {
      await api.apiCall('status_react', { status_id: statusId, emoji }, 'POST');
    } catch (err) {
      console.warn('[Status] React failed:', err);
    }
  }, [viewerStatuses, viewerIndex, currentEmail, myReactions]);

  // Open forward modal
  const handleOpenForward = useCallback(async () => {
    setIsPaused(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (animRef.current) animRef.current.stop();
    setForwardModalVisible(true);
    setForwardLoading(true);
    try {
      const r = await chatConversations();
      if (r.success && r.data?.conversations) {
        setForwardConversations(r.data.conversations.slice(0, 20));
      }
    } catch (err) {
      console.warn('[Status] Load conversations failed:', err);
    } finally {
      setForwardLoading(false);
    }
  }, []);

  // Forward status content to a conversation
  const handleForwardToConversation = useCallback(async (conv) => {
    const item = viewerStatuses[viewerIndex];
    if (!item) return;
    setForwardModalVisible(false);
    setIsPaused(false);

    try {
      const statusType = item.type || 'text';
      const statusLabel = `\u27A1\uFE0F ${t?.('status.forwardedStatus') || 'Status encaminhado'}`;

      if (statusType === 'image' && item.content) {
        const imgUrl = (item.content || '').split('\n')[0];
        const fullUrl = imgUrl.startsWith('/') ? BASE_URL + imgUrl : imgUrl;
        const caption = (item.content || '').includes('\n') ? (item.content || '').split('\n').slice(1).join('\n') : '';
        const msg = caption ? `${statusLabel}\n${caption}` : statusLabel;
        await chatSend(conv.id, msg, 'image', null, null, fullUrl);
      } else if (statusType === 'video' && item.content) {
        const vidUrl = (item.content || '').split('\n')[0];
        const fullUrl = vidUrl.startsWith('/') ? BASE_URL + vidUrl : vidUrl;
        await chatSend(conv.id, statusLabel, 'video', null, null, fullUrl);
      } else {
        const statusPreview = (item.content || '').substring(0, 200);
        await chatSend(conv.id, `${statusLabel}\n\n"${statusPreview}"\n\n- ${viewerOwnerName}`, 'text');
      }
      // Navigate to the conversation
      router.push(`/chat-conversation?id=${conv.id}&name=${encodeURIComponent(conv.name || conv.other_name || '')}`);
      closeViewer();
    } catch (err) {
      console.warn('[Status] Forward failed:', err);
    }
  }, [viewerStatuses, viewerIndex, viewerOwnerName, t, router, closeViewer]);

  // Creator state
  const [cameraVisible, setCameraVisible] = useState(false);
  const [creatorVisible, setCreatorVisible] = useState(false);
  const [creatorMode, setCreatorMode] = useState('text');
  const [textContent, setTextContent] = useState('');
  const [textBgColor, setTextBgColor] = useState(TEXT_BG_COLORS[0]);
  const [textFontStyle, setTextFontStyle] = useState('normal'); // 'normal' | 'serif' | 'mono'
  const [statusPrivacy, setStatusPrivacy] = useState('all'); // 'all' | 'contacts' | 'except'
  const [photoUri, setPhotoUri] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoFilter, setPhotoFilter] = useState('normal');
  const [stickers, setStickers] = useState([]); // [{ id, emoji, x, y }]
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [textOverlays, setTextOverlays] = useState([]); // [{ id, text, x, y, color }]
  const [showAddTextInput, setShowAddTextInput] = useState(false);
  const [newOverlayText, setNewOverlayText] = useState('');
  const [drawMode, setDrawMode] = useState(false);
  const [drawColor, setDrawColor] = useState('#fff');
  const [drawPaths, setDrawPaths] = useState([]); // [{ points: [{x,y}], color }]
  const currentDrawPath = useRef(null);
  const [publishing, setPublishing] = useState(false);
  const [sendingReply, setSendingReply] = useState(false);
  const [nativeAudioSrc, setNativeAudioSrc] = useState(null);

  // Register native audio callback for hidden WebView player
  useEffect(() => {
    if (Platform.OS !== 'web') {
      _nativeAudioCallback = (url) => setNativeAudioSrc(url);
      return () => { _nativeAudioCallback = null; };
    }
  }, []);

  // Music state
  const [musicPickerVisible, setMusicPickerVisible] = useState(false);
  const [musicQuery, setMusicQuery] = useState('');
  const [musicResults, setMusicResults] = useState([]);
  const [musicSearching, setMusicSearching] = useState(false);
  const [selectedMusic, setSelectedMusic] = useState(null);
  const musicSearchTimer = useRef(null);
  const statusAudioRef = useRef(null);
  const photoObjectUrlRef = useRef(null);

  // Cleanup musicSearchTimer and object URLs on unmount
  useEffect(() => {
    return () => {
      if (musicSearchTimer.current) clearTimeout(musicSearchTimer.current);
      if (photoObjectUrlRef.current) {
        try { URL.revokeObjectURL(photoObjectUrlRef.current); } catch {}
        photoObjectUrlRef.current = null;
      }
    };
  }, []);

  const currentEmail = user?.email || '';
  const currentName = user?.name || user?.email?.split('@')[0] || '';

  // Reply to a status — sends a chat message to the status owner (WhatsApp-style)
  const handleStatusReply = useCallback(async () => {
    const text = viewerReply.trim();
    if (!text || sendingReply || !viewerOwnerEmail) return;
    setSendingReply(true);
    try {
      // Find or create direct conversation with status owner
      const createRes = await chatCreate([viewerOwnerEmail], '', 'direct');
      const convId = createRes?.data?.conversation_id || createRes?.data?.id;
      if (!convId) throw new Error('No conversation');

      // Build reply message with status reference (include image if photo status)
      const currentItem = viewerStatuses[viewerIndex];
      const statusType = currentItem?.type || 'text';

      if (statusType === 'image' && currentItem?.content) {
        // For image status: send the status image as an image message with reply text
        const imgUrl = (currentItem.content || '').split('\n')[0];
        const fullUrl = imgUrl.startsWith('/') ? BASE_URL + imgUrl : imgUrl;
        const statusLabel = `↩️ ${t?.('status.replyToStatus') || 'Respondeu ao seu status'}`;
        // Send as image type with the reply text as content
        await chatSend(convId, `${statusLabel}: ${text}`, 'image', null, null, fullUrl);
      } else if (statusType === 'video' && currentItem?.content) {
        const vidUrl = (currentItem.content || '').split('\n')[0];
        const fullUrl = vidUrl.startsWith('/') ? BASE_URL + vidUrl : vidUrl;
        const statusLabel = `↩️ ${t?.('status.replyToStatus') || 'Respondeu ao seu status'}`;
        await chatSend(convId, `${statusLabel}: ${text}`, 'video', null, null, fullUrl);
      } else {
        // Text status: quote the text
        const statusPreview = (currentItem?.content || '').substring(0, 80);
        const replyMsg = `↩️ ${t?.('status.replyToStatus') || 'Respondeu ao seu status'}: "${statusPreview}"\n\n${text}`;
        await chatSend(convId, replyMsg, 'text');
      }

      setViewerReply('');
    } catch (err) {
      console.warn('[Status] Reply failed:', err);
    } finally {
      setSendingReply(false);
    }
  }, [viewerReply, sendingReply, viewerOwnerEmail, viewerStatuses, viewerIndex, t]);

  // Swipe down to dismiss
  const panY = useRef(new Animated.Value(0)).current;
  const closeViewerRef = useRef(null);
  // Keep ref in sync (updated after closeViewer is defined below)

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onMoveShouldSetPanResponder: (_, gs) => gs.dy > 10 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.5,
      onPanResponderMove: (_, gs) => {
        if (gs.dy > 0) panY.setValue(gs.dy);
      },
      onPanResponderRelease: (_, gs) => {
        if (gs.dy > 120) {
          closeViewerRef.current?.();
        } else {
          Animated.spring(panY, { toValue: 0, useNativeDriver: true, tension: 40 }).start();
        }
      },
    })
  ).current;

  // Load statuses from API
  const loadStatuses = useCallback(async () => {
    // FAST PATH: if we already have data on screen (from MMKV preload or a
    // previous sync), skip the async SQLite/IndexedDB read entirely and go
    // straight to a silent API delta sync — no flicker, no wait.
    let alreadyHasVisible = false;
    setMyStatuses(prev => {
      setContactStatuses(prev2 => {
        alreadyHasVisible = (prev?.length || 0) > 0 || (prev2?.length || 0) > 0;
        return prev2;
      });
      return prev;
    });

    if (!alreadyHasVisible) {
      // SLOW PATH: no data yet — check the async disk cache (offline support).
      try {
        const cached = await getCached('statuses');
        if (cached) {
          setMyStatuses(cached.mine || []);
          setContactStatuses(cached.others || []);
          setLoading(false);
          lastStatusesFpRef.current = _fingerprintStatuses(cached.mine, cached.others);
        }
      } catch {}
    }

    try {
      const r = await api.statusList();
      if (r.success && r.data) {
        const mine = [];
        const others = [];
        const groups = r.data.statuses || r.data;
        const groupList = Array.isArray(groups) ? groups : [];
        for (const group of groupList) {
          if (group.email === currentEmail) {
            mine.push(...(group.items || []).map(item => ({
              ...item,
              bgColor: item.bg_color || item.bgColor || '#6D28D9',
              timestamp: item.created_at,
            })));
          } else {
            others.push({
              ownerEmail: group.email,
              ownerName: group.name || group.email.split('@')[0],
              items: (group.items || []).map(item => ({
                ...item,
                bgColor: item.bg_color || item.bgColor || '#6D28D9',
                timestamp: item.created_at,
              })),
            });
          }
        }
        // Only setState if the data actually changed (fingerprint diff).
        // This is what kills the flicker on every poll/WS tick.
        const fp = _fingerprintStatuses(mine, others);
        if (fp !== lastStatusesFpRef.current) {
          lastStatusesFpRef.current = fp;
          setMyStatuses(mine);
          setContactStatuses(others);
          setCache('statuses', { mine, others }, 2592000000).catch(() => {}); // 30 days
          // Persist to MMKV for synchronous preload on next app launch
          if (Platform.OS !== 'web') {
            try {
              const { setString: _ss } = require('../services/mmkv');
              _ss('chat_statuses', JSON.stringify({ mine, others }));
            } catch {}
          }
        }
      }
    } catch {} finally {
      setLoading(false);
    }
  }, [currentEmail]);

  useEffect(() => {
    loadStatuses();

    // WebSocket: instant status updates when someone adds a status
    let unsubStatus = null;
    if (mailWs?.on) {
      unsubStatus = mailWs.on('status_update', () => { loadStatuses(); });
    }

    // Fallback polling at 60s — only needed if WS misses an event
    const interval = setInterval(loadStatuses, 60000);
    return () => {
      clearInterval(interval);
      unsubStatus?.();
    };
  }, [loadStatuses]);

  // Filter by search
  const filteredStatuses = contactStatuses.filter((s) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return s.ownerName.toLowerCase().includes(q) || s.ownerEmail.toLowerCase().includes(q);
  });

  const recentStatuses = filteredStatuses.filter(
    (s) => !s.items.every((item) => item.viewed)
  );
  const viewedStatuses = filteredStatuses.filter(
    (s) => s.items.every((item) => item.viewed)
  );

  // All status groups for swiping between people
  const [allStatusGroups, setAllStatusGroups] = useState([]);
  const [currentGroupIndex, setCurrentGroupIndex] = useState(0);

  // ─── Viewer Logic ───
  const openViewer = useCallback((statusGroup) => {
    // Build list of all groups for horizontal swiping
    const myGroup = myStatuses.length > 0
      ? { ownerEmail: currentEmail, ownerName: currentName, items: myStatuses }
      : null;
    const allGroups = [];
    if (myGroup) allGroups.push(myGroup);
    contactStatuses.forEach(g => allGroups.push(g));
    setAllStatusGroups(allGroups);

    // Find index of the tapped group
    const groupIdx = allGroups.findIndex(g => g.ownerEmail === statusGroup.ownerEmail);
    setCurrentGroupIndex(groupIdx >= 0 ? groupIdx : 0);

    setViewerStatuses(statusGroup.items);
    setViewerOwnerName(statusGroup.ownerName);
    setViewerOwnerEmail(statusGroup.ownerEmail);
    setViewerIndex(0);
    setViewerReply('');
    setIsPaused(false);
    panY.setValue(0);
    viewerOpacity.setValue(0);
    setViewerVisible(true);
    Animated.timing(viewerOpacity, { toValue: 1, duration: 250, useNativeDriver: true }).start();
  }, [viewerOpacity, panY, myStatuses, contactStatuses, currentEmail, currentName]);

  const closeViewer = useCallback(() => {
    stopStatusAudio();
    Animated.timing(viewerOpacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
      setViewerVisible(false);
    });
    if (timerRef.current) clearTimeout(timerRef.current);
    if (animRef.current) animRef.current.stop();
    progressAnim.setValue(0);
    panY.setValue(0);
    loadStatuses();
  }, [progressAnim, viewerOpacity, panY, loadStatuses]);

  // Keep the ref in sync so panResponder can call it
  closeViewerRef.current = closeViewer;

  // Switch to next person's statuses
  const goToNextPerson = useCallback(() => {
    const nextIdx = currentGroupIndex + 1;
    if (nextIdx < allStatusGroups.length) {
      const nextGroup = allStatusGroups[nextIdx];
      setCurrentGroupIndex(nextIdx);
      setViewerStatuses(nextGroup.items);
      setViewerOwnerName(nextGroup.ownerName);
      setViewerOwnerEmail(nextGroup.ownerEmail);
      setViewerIndex(0);
      setViewerReply('');
      progressAnim.setValue(0);
    } else {
      closeViewer();
    }
  }, [currentGroupIndex, allStatusGroups, progressAnim, closeViewer]);

  // Switch to previous person's statuses
  const goToPrevPerson = useCallback(() => {
    const prevIdx = currentGroupIndex - 1;
    if (prevIdx >= 0) {
      const prevGroup = allStatusGroups[prevIdx];
      setCurrentGroupIndex(prevIdx);
      setViewerStatuses(prevGroup.items);
      setViewerOwnerName(prevGroup.ownerName);
      setViewerOwnerEmail(prevGroup.ownerEmail);
      setViewerIndex(0);
      setViewerReply('');
      progressAnim.setValue(0);
    }
  }, [currentGroupIndex, allStatusGroups, progressAnim]);

  const advanceViewer = useCallback(() => {
    const currentItem = viewerStatuses[viewerIndex];
    if (currentItem && !currentItem.viewed) {
      api.statusView(currentItem.id).catch(() => {});
      setViewerStatuses(prev => prev.map((s, idx) => idx === viewerIndex ? { ...s, viewed: true } : s));
      // ALSO propagate the viewed flag to the main contactStatuses array so
      // that the status immediately moves to the "Visualizados" (viewed)
      // section below the "Recentes" list, WhatsApp-style. Previously the
      // flag was only updated in the viewer's local state, so closing the
      // viewer left the status still in the "Recentes" section until the
      // next 60s API refresh.
      setContactStatuses(prev => prev.map(group => ({
        ...group,
        items: group.items.map(it => it.id === currentItem.id ? { ...it, viewed: true } : it),
      })));
    }

    if (viewerIndex < viewerStatuses.length - 1) {
      setViewerIndex((prev) => prev + 1);
    } else {
      // Move to next person's statuses instead of closing
      goToNextPerson();
    }
  }, [viewerStatuses, viewerIndex, goToNextPerson]);

  const goBackViewer = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (animRef.current) animRef.current.stop();
    if (viewerIndex > 0) {
      setViewerIndex(prev => prev - 1);
    } else {
      // At first status of this person, go to previous person
      goToPrevPerson();
    }
  }, [viewerIndex, goToPrevPerson]);

  // Play music when viewing a status with music
  useEffect(() => {
    if (!viewerVisible || viewerStatuses.length === 0) {
      setNativeAudioSrc(null);
      stopStatusAudio();
      return;
    }
    const item = viewerStatuses[viewerIndex];
    if (item?.music_preview_url) {
      if (Platform.OS === 'web') {
        playStatusAudio(item.music_preview_url);
      } else {
        // Native: set state directly to render WebView audio player
        setNativeAudioSrc(item.music_preview_url);
      }
    } else {
      setNativeAudioSrc(null);
      stopStatusAudio();
    }
  }, [viewerVisible, viewerIndex, viewerStatuses]);

  useEffect(() => {
    if (!viewerVisible || viewerStatuses.length === 0 || isPaused) return;

    progressAnim.setValue(0);
    const anim = Animated.timing(progressAnim, {
      toValue: 1,
      duration: STATUS_DURATION,
      useNativeDriver: true,
    });
    animRef.current = anim;
    anim.start();

    timerRef.current = setTimeout(advanceViewer, STATUS_DURATION);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      anim.stop();
    };
  }, [viewerVisible, viewerIndex, viewerStatuses.length, isPaused]);

  // Tap left half = previous, right half = next
  const handleViewerTap = useCallback((evt) => {
    const tapX = evt?.nativeEvent?.locationX || evt?.nativeEvent?.pageX || SCREEN_WIDTH / 2;
    if (timerRef.current) clearTimeout(timerRef.current);
    if (animRef.current) animRef.current.stop();

    if (tapX < SCREEN_WIDTH * 0.3) {
      goBackViewer();
    } else {
      advanceViewer();
    }
  }, [advanceViewer, goBackViewer]);

  // Long press = pause
  const handleLongPress = useCallback(() => {
    setIsPaused(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    if (animRef.current) animRef.current.stop();
  }, []);

  const handlePressOut = useCallback(() => {
    if (isPaused) setIsPaused(false);
  }, [isPaused]);

  // ─── Creator Logic ───
  const openCreator = useCallback((mode = 'text') => {
    setTextContent('');
    setPhotoUri(null);
    setPhotoFile(null);
    setSelectedMusic(null);
    setMusicPickerVisible(false);
    setMusicQuery('');
    setMusicResults([]);
    setCreatorMode(mode);
    setTextFontStyle('normal');
    setStatusPrivacy('all');
    setTextBgColor(TEXT_BG_COLORS[Math.floor(Math.random() * TEXT_BG_COLORS.length)]);
    // Instagram-style camera mode (native only)
    if (mode === 'camera' && Platform.OS !== 'web') {
      setCameraVisible(true);
      return;
    }
    if (mode === 'photo') {
      if (Platform.OS === 'web') {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.onchange = (e) => {
          const file = e.target.files?.[0];
          if (file) {
            setPhotoFile(file);
            if (photoObjectUrlRef.current) { try { URL.revokeObjectURL(photoObjectUrlRef.current); } catch {} }
            const objUrl = URL.createObjectURL(file);
            photoObjectUrlRef.current = objUrl;
            setPhotoUri(objUrl);
            setCreatorVisible(true);
          }
        };
        input.click();
      } else {
        // Native: ask the user whether to take a new photo or pick from
        // gallery — previously hard-coded to gallery only.
        const pickFromSource = async (source) => {
          try {
            const ImagePicker = await import('expo-image-picker');
            const launch = source === 'camera'
              ? ImagePicker.launchCameraAsync
              : ImagePicker.launchImageLibraryAsync;
            const permFn = source === 'camera'
              ? ImagePicker.requestCameraPermissionsAsync
              : ImagePicker.requestMediaLibraryPermissionsAsync;
            const perm = await permFn();
            if (!perm.granted) return;
            const result = await launch({ mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 });
            if (!result.canceled && result.assets?.[0]) {
              const asset = result.assets[0];
              setPhotoUri(asset.uri);
              setPhotoFile({ uri: asset.uri, name: 'status.jpg', type: asset.mimeType || 'image/jpeg' });
              setCreatorVisible(true);
            }
          } catch (e) {
            console.warn('[status photo]', e?.message);
          }
        };
        const { Alert } = require('react-native');
        Alert.alert(
          t?.('status.addPhoto') || 'Adicionar foto',
          t?.('status.pickSource') || 'De onde voce quer tirar a foto?',
          [
            { text: t?.('status.camera') || 'Camera', onPress: () => pickFromSource('camera') },
            { text: t?.('status.gallery') || 'Galeria', onPress: () => pickFromSource('gallery') },
            { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
          ],
          { cancelable: true }
        );
      }
    } else {
      setCreatorVisible(true);
    }
  }, [t]);

  // Handler for when StatusCamera captures a photo/video
  const handleCameraCapture = useCallback(async (capture) => {
    setCameraVisible(false);
    if (!capture?.uri) return;
    setPublishing(true);
    try {
      const file = { uri: capture.uri, name: capture.type === 'video' ? 'status.mp4' : 'status.jpg', type: capture.type === 'video' ? 'video/mp4' : 'image/jpeg' };
      const uploadR = await api.statusUpload(file);
      if (uploadR.success && uploadR.data?.url) {
        const statusType = capture.type === 'video' ? 'video' : 'image';
        const r = await api.statusPublish(uploadR.data.url, statusType, '#000000', null, {});
        if (r.success) loadStatuses();
      }
    } catch (e) {
      console.warn('[StatusCamera publish]', e);
    } finally {
      setPublishing(false);
    }
  }, [loadStatuses]);

  const publishStatus = useCallback(async () => {
    if (publishing) return;
    if (creatorMode === 'text' && !textContent.trim()) return;
    if ((creatorMode === 'photo' || creatorMode === 'video') && !photoFile) return;

    const musicData = selectedMusic ? {
      title: selectedMusic.title,
      artist: selectedMusic.artist,
      previewUrl: selectedMusic.previewUrl,
      coverUrl: selectedMusic.coverUrl,
    } : null;

    // Extra metadata for font style and privacy
    const extraMeta = {
      font_style: textFontStyle !== 'normal' ? textFontStyle : undefined,
      privacy: statusPrivacy !== 'all' ? statusPrivacy : undefined,
      filter: photoFilter !== 'normal' ? photoFilter : undefined,
      stickers: stickers.length > 0 ? stickers.map(s => ({
        ...(s.emoji ? { emoji: s.emoji } : {}),
        ...(s.type ? { type: s.type, ...s } : {}),
        x: Math.round(s.x), y: Math.round(s.y),
      })) : undefined,
      text_overlays: textOverlays.length > 0 ? textOverlays.map(to => ({ text: to.text, x: Math.round(to.x), y: Math.round(to.y), color: to.color })) : undefined,
      draw_paths: drawPaths.length > 0 ? drawPaths.map(p => ({ color: p.color, points: p.points.map(pt => ({ x: Math.round(pt.x), y: Math.round(pt.y) })) })) : undefined,
    };

    setPublishing(true);
    try {
      if ((creatorMode === 'photo' || creatorMode === 'video') && photoFile) {
        const uploadR = await api.statusUpload(photoFile);
        if (uploadR.success && uploadR.data?.url) {
          const caption = textContent.trim();
          const content = caption ? uploadR.data.url + '\n' + caption : uploadR.data.url;
          const statusType = creatorMode === 'video' ? 'video' : 'image';
          const r = await api.statusPublish(content, statusType, '#000000', musicData, extraMeta);
          if (r.success) { setCreatorVisible(false); setMusicPickerVisible(false); setSelectedMusic(null); loadStatuses(); }
        }
      } else {
        const r = await api.statusPublish(textContent.trim(), 'text', textBgColor, musicData, extraMeta);
        if (r.success) { setCreatorVisible(false); setMusicPickerVisible(false); setTextContent(''); setSelectedMusic(null); loadStatuses(); }
      }
    } catch {} finally {
      setPublishing(false);
    }
  }, [textContent, textBgColor, creatorMode, photoFile, publishing, loadStatuses, selectedMusic, textFontStyle, statusPrivacy]);

  const deleteMyStatus = useCallback(async (statusId) => {
    try {
      await api.statusDelete(statusId);
      setMyStatuses(prev => prev.filter(s => s.id !== statusId));
    } catch {}
  }, []);

  // ─── Labels ───
  const hasMyStatus = myStatuses.length > 0;
  const myStatusGroup = hasMyStatus
    ? { ownerEmail: currentEmail, ownerName: currentName, items: myStatuses }
    : null;

  const myStatusLabel = t?.('status.myStatus') || 'Meu status';
  const addStatusLabel = t?.('status.tapToAdd') || 'Toque para adicionar status';
  const disappearsLabel = t?.('status.disappears') || 'Desaparece em 24 horas';
  const recentLabel = t?.('status.recentUpdates') || 'Atualizacoes recentes';
  const viewedLabel = t?.('status.viewed') || 'Visualizados';
  const typePlaceholder = t?.('status.typeSomething') || 'Digite um status...';
  const emptyLabel = t?.('status.noUpdates') || 'Nenhuma atualizacao recente';

  const isOwnStatus = viewerOwnerEmail === currentEmail;
  const currentViewerItem = viewerStatuses[viewerIndex];

  const renderStatusRow = (statusGroup) => {
    const latestItem = statusGroup.items[statusGroup.items.length - 1];
    const time = timeAgo(latestItem?.timestamp, t);
    const allViewed = statusGroup.items.every((item) => item.viewed);
    const count = statusGroup.items.length;

    return (
      <TouchableOpacity
        key={statusGroup.ownerEmail}
        style={[styles.statusRow, { backgroundColor: isDark ? colors.card : '#fff' }]}
        onPress={() => openViewer(statusGroup)}
        activeOpacity={0.7}
      >
        <View style={styles.avatarWrapper}>
          <SegmentedRing items={statusGroup.items} size={52} viewed={allViewed} />
          <AvatarCircle name={statusGroup.ownerName} email={statusGroup.ownerEmail} size={52} />
        </View>
        <View style={styles.statusInfo}>
          <Text style={[styles.statusName, { color: colors.text }]} numberOfLines={1}>
            {statusGroup.ownerName}
          </Text>
          <View style={styles.statusMeta}>
            <Text style={[styles.statusTime, { color: colors.textSecondary }]}>{time}</Text>
            {count > 1 && (
              <View style={[styles.countPill, { backgroundColor: isDark ? '#2d3748' : '#f0f0f0' }]}>
                <Text style={[styles.countPillText, { color: colors.textSecondary }]}>{count}</Text>
              </View>
            )}
          </View>
        </View>
      </TouchableOpacity>
    );
  };

  if (loading) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" color={ACCENT} />
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
      {/* Search */}
      {showSearch && (
        <View style={[styles.searchBar, {
          backgroundColor: isDark ? colors.card : '#fff',
        }]}>
          <IconSearch size={18} color={colors.textSecondary} />
          <TextInput
            style={[styles.searchInput, { color: colors.text }]}
            placeholder={t?.('search.placeholder') || 'Pesquisar...'}
            placeholderTextColor={colors.textSecondary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoFocus
          />
          {searchQuery.length > 0 && (
            <TouchableOpacity onPress={() => setSearchQuery('')}>
              <IconX size={18} color={colors.textSecondary} />
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => { setShowSearch(false); setSearchQuery(''); }} style={{ marginLeft: 8 }}>
            <IconX size={20} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {!showSearch && (
        <View style={styles.inlineSearchRow}>
          <TouchableOpacity
            style={[styles.searchToggle, {
              backgroundColor: isDark ? colors.card : '#fff',
            }]}
            onPress={() => setShowSearch(true)}
          >
            <IconSearch size={18} color={colors.textSecondary} />
            <Text style={[styles.searchToggleText, { color: colors.textSecondary }]}>
              {t?.('search.placeholder') || 'Pesquisar...'}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <ScrollView style={styles.scrollView} showsVerticalScrollIndicator={false}>
        {/* Horizontal story scroller */}
        {(filteredStatuses.length > 0 || hasMyStatus) && (
          <StoryScroller
            statuses={filteredStatuses}
            myStatuses={myStatuses}
            currentEmail={currentEmail}
            currentName={currentName}
            onOpenViewer={openViewer}
            onOpenCreator={openCreator}
            isDark={isDark}
            colors={colors}
            t={t}
          />
        )}

        {/* My Status Card */}
        <View style={[styles.myStatusCard, {
          backgroundColor: isDark ? colors.card : '#fff',
          ...(Platform.OS === 'web' ? { boxShadow: '0 2px 12px rgba(0,0,0,0.08)' } : {}),
        }]}>
          <TouchableOpacity
            style={styles.myStatusRow}
            onPress={() => hasMyStatus ? openViewer(myStatusGroup) : openCreator()}
            activeOpacity={0.7}
          >
            <View style={styles.myAvatarWrapper}>
              {hasMyStatus && (
                <SegmentedRing items={myStatuses} size={56} viewed={false} />
              )}
              <AvatarCircle name={currentName} email={currentEmail} size={56} />
              {!hasMyStatus && (
                <View style={[styles.plusBadge, {
                  borderColor: isDark ? colors.card : '#fff',
                }]}>
                  <IconPlus size={14} color="#fff" />
                </View>
              )}
            </View>
            <View style={styles.statusInfo}>
              <Text style={[styles.myStatusName, { color: colors.text }]}>
                {myStatusLabel}
              </Text>
              <Text style={[styles.myStatusSub, { color: colors.textSecondary }]}>
                {hasMyStatus
                  ? `${myStatuses.length} ${myStatuses.length > 1 ? 'status' : 'status'} - ${timeAgo(myStatuses[myStatuses.length - 1]?.timestamp, t)}`
                  : addStatusLabel
                }
              </Text>
            </View>
            <View style={styles.myStatusActions}>
              {hasMyStatus && (
                <TouchableOpacity
                  style={[styles.actionCircle, { backgroundColor: isDark ? '#3a1c1e' : '#fce4ec' }]}
                  onPress={() => {
                    const last = myStatuses[myStatuses.length - 1];
                    if (last) deleteMyStatus(last.id);
                  }}
                >
                  <IconTrash size={18} color="#D63031" />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.actionCircle, {
                  backgroundColor: isDark ? '#1a332a' : '#e8f5e9',
                  marginLeft: hasMyStatus ? 10 : 0,
                }]}
                onPress={openCreator}
              >
                <IconEdit size={20} color={ACCENT} />
              </TouchableOpacity>
            </View>
          </TouchableOpacity>
        </View>

        {/* Recent Updates */}
        {recentStatuses.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionAccent} />
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{recentLabel}</Text>
              <Text style={[styles.sectionCount, { color: colors.textSecondary }]}>{recentStatuses.length}</Text>
            </View>
            {recentStatuses.map((s) => renderStatusRow(s))}
          </View>
        )}

        {/* Viewed */}
        {viewedStatuses.length > 0 && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={[styles.sectionAccent, { backgroundColor: isDark ? '#555' : '#bbb' }]} />
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>{viewedLabel}</Text>
              <Text style={[styles.sectionCount, { color: colors.textSecondary }]}>{viewedStatuses.length}</Text>
            </View>
            {viewedStatuses.map((s) => renderStatusRow(s))}
          </View>
        )}

        {/* Empty state */}
        {recentStatuses.length === 0 && viewedStatuses.length === 0 && !hasMyStatus && (
          <View style={styles.emptyContainer}>
            <EmptyStatusIllustration isDark={isDark} />
            <Text style={[styles.emptyText, { color: colors.text }]}>{emptyLabel}</Text>
            <Text style={[styles.emptySubtext, { color: colors.textSecondary }]}>{disappearsLabel}</Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => openCreator()}
              activeOpacity={0.8}
            >
              <IconPlus size={18} color="#fff" />
              <Text style={styles.emptyButtonText}>{t?.('status.addStatus') || 'Adicionar status'}</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* FABs */}
      <TouchableOpacity
        style={[styles.fabSecondary, {
          backgroundColor: isDark ? '#2a2e2b' : '#fff',
          ...(Platform.OS === 'web' ? { boxShadow: '0 3px 12px rgba(0,0,0,0.12)' } : {}),
        }]}
        onPress={() => Platform.OS !== 'web' ? openCreator('camera') : openCreator('photo')}
        activeOpacity={0.8}
      >
        <IconCamera size={22} color={ACCENT} />
      </TouchableOpacity>
      <TouchableOpacity
        style={[styles.fab, Platform.OS === 'web' && { boxShadow: '0 4px 14px rgba(124,58,237,0.4), 0 2px 6px rgba(0,0,0,0.1)' }]}
        onPress={() => openCreator('text')}
        activeOpacity={0.8}
      >
        <IconEdit size={24} color="#fff" />
      </TouchableOpacity>

      {/* ─── Instagram-style Camera Modal ─── */}
      {Platform.OS !== 'web' && (
        <Modal visible={cameraVisible} animationType="slide" transparent={false} statusBarTranslucent onRequestClose={() => setCameraVisible(false)}>
          <StatusCamera
            visible={cameraVisible}
            onClose={() => setCameraVisible(false)}
            onCapture={handleCameraCapture}
            t={t}
          />
        </Modal>
      )}

      {/* ─── Full-Screen Status Viewer Modal ─── */}
      <Modal visible={viewerVisible} animationType="none" transparent statusBarTranslucent onRequestClose={closeViewer}>
        <Animated.View
          style={[styles.viewerContainer, { opacity: viewerOpacity }]}
          {...panResponder.panHandlers}
        >
          <Animated.View style={[StyleSheet.absoluteFill, {
            transform: [{ translateY: panY }],
            backgroundColor: '#000',
          }]}>
            {/* Progress bars */}
            <View style={styles.progressBarRow}>
              {viewerStatuses.map((item, idx) => (
                <View key={item.id || idx} style={styles.progressBarTrack}>
                  <Animated.View
                    style={[styles.progressBarFill, {
                      width: idx < viewerIndex ? '100%'
                        : idx === viewerIndex ? progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] })
                        : '0%',
                    }]}
                  />
                </View>
              ))}
            </View>

            {/* Header */}
            <View style={styles.viewerHeader}>
              <AvatarCircle name={viewerOwnerName} email={viewerOwnerEmail} size={40} />
              <View style={styles.viewerHeaderInfo}>
                <Text style={styles.viewerName} numberOfLines={1}>{viewerOwnerName}</Text>
                <Text style={styles.viewerTime}>
                  {timeAgo(currentViewerItem?.timestamp, t)}
                </Text>
              </View>
              {isOwnStatus && currentViewerItem?.view_count != null && (
                <TouchableOpacity
                  style={styles.viewCountBadge}
                  onPress={() => handleShowViewers(currentViewerItem?.id)}
                  activeOpacity={0.7}
                >
                  <IconEye size={14} color="rgba(255,255,255,0.8)" />
                  <Text style={styles.viewCountText}>{currentViewerItem?.view_count}</Text>
                </TouchableOpacity>
              )}
              <TouchableOpacity onPress={closeViewer} style={styles.viewerClose}>
                <IconX size={26} color="#fff" />
              </TouchableOpacity>
            </View>

            {/* Content area with tap zones */}
            <TouchableOpacity
              style={styles.viewerContent}
              activeOpacity={1}
              onPress={handleViewerTap}
              onLongPress={handleLongPress}
              onPressOut={handlePressOut}
              delayLongPress={300}
            >
              {/* Left/Right tap zone indicators */}
              {viewerIndex > 0 && (
                <View style={styles.tapZoneLeft} pointerEvents="none">
                  <View style={styles.tapZoneArrow}>
                    <IconChevronLeft size={20} color="rgba(255,255,255,0.4)" />
                  </View>
                </View>
              )}

              {!currentViewerItem ? null : currentViewerItem?.type === 'text' ? (
                <View style={[styles.viewerTextCard, { backgroundColor: currentViewerItem?.bgColor || '#6D28D9' }]}>
                  <Text style={[styles.viewerText, {
                    fontFamily: currentViewerItem?.font_style === 'serif' ? (Platform.OS === 'ios' ? 'Georgia' : 'serif')
                      : currentViewerItem?.font_style === 'mono' ? (Platform.OS === 'ios' ? 'Courier' : 'monospace')
                      : undefined,
                    fontStyle: currentViewerItem?.font_style === 'serif' ? 'italic' : 'normal',
                  }]}>{currentViewerItem?.content}</Text>
                </View>
              ) : currentViewerItem?.type === 'video' ? (
                <View style={{ flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center', backgroundColor: '#000' }}>
                  {Platform.OS === 'web' ? (
                    <video
                      src={(() => { const url = (currentViewerItem?.content || '').split('\n')[0]; return url.startsWith('/') ? BASE_URL + url : url; })()}
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      autoPlay muted={false} playsInline loop
                    />
                  ) : (
                    <StatusVideoPlayer url={(() => { const url = (currentViewerItem?.content || '').split('\n')[0]; return url.startsWith('/') ? BASE_URL + url : url; })()} />
                  )}
                  {(currentViewerItem?.content || '').includes('\n') && (
                    <View style={styles.viewerCaptionBar}>
                      <Text style={styles.viewerCaption}>
                        {(currentViewerItem?.content || '').split('\n').slice(1).join('\n')}
                      </Text>
                    </View>
                  )}
                </View>
              ) : currentViewerItem?.type === 'image' ? (
                <View style={{ flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' }}>
                  <Image
                    source={{ uri: (() => { const url = (currentViewerItem?.content || '').split('\n')[0]; return url.startsWith('/') ? BASE_URL + url : url; })() }}
                    style={styles.viewerImage}
                    resizeMode="contain"
                  />
                  {(currentViewerItem?.content || '').includes('\n') && (
                    <View style={styles.viewerCaptionBar}>
                      <Text style={styles.viewerCaption}>
                        {(currentViewerItem?.content || '').split('\n').slice(1).join('\n')}
                      </Text>
                    </View>
                  )}
                </View>
              ) : null}

              {/* Music overlay — shows song title + artist when status has music */}
              {currentViewerItem?.music_title ? (
                <View style={styles.musicOverlay} pointerEvents="none">
                  {currentViewerItem.music_cover_url ? (
                    <Image source={{ uri: currentViewerItem.music_cover_url }} style={styles.musicOverlayCover} />
                  ) : null}
                  <View style={styles.musicOverlayInfo}>
                    <IconMusicNote size={14} color="rgba(255,255,255,0.9)" />
                    <Text style={styles.musicOverlayTitle} numberOfLines={1}>
                      {currentViewerItem.music_title}
                    </Text>
                    <Text style={styles.musicOverlayArtist} numberOfLines={1}>
                      {currentViewerItem.music_artist}
                    </Text>
                  </View>
                </View>
              ) : null}

              {/* Paused indicator */}
              {isPaused && (
                <View style={styles.pausedOverlay} pointerEvents="none">
                  <View style={styles.pausedBadge}>
                    <Text style={styles.pausedText}>II</Text>
                  </View>
                </View>
              )}
            </TouchableOpacity>

            {/* Reaction badges on current status */}
            {(() => {
              const itemReactions = statusReactions[currentViewerItem?.id] || [];
              if (itemReactions.length === 0) return null;
              const grouped = {};
              itemReactions.forEach(r => { grouped[r.emoji] = (grouped[r.emoji] || 0) + 1; });
              return (
                <View style={styles.reactionBadgesRow} pointerEvents="none">
                  {Object.entries(grouped).map(([emoji, count]) => (
                    <View key={emoji} style={styles.reactionBadge}>
                      <Text style={styles.reactionBadgeEmoji}>{emoji}</Text>
                      {count > 1 && <Text style={styles.reactionBadgeCount}>{count}</Text>}
                    </View>
                  ))}
                </View>
              );
            })()}

            {/* Emoji reaction bar + Forward (only for other people's statuses) */}
            {!isOwnStatus && (
              <View style={styles.reactionBar}>
                {QUICK_REACTIONS.map((emoji) => (
                  <TouchableOpacity
                    key={emoji}
                    onPress={() => handleReact(emoji)}
                    style={[styles.reactionBtn, myReactions[currentViewerItem?.id] === emoji && styles.reactionBtnActive]}
                    activeOpacity={0.6}
                  >
                    <Text style={styles.reactionEmoji}>{emoji}</Text>
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  onPress={handleOpenForward}
                  style={styles.forwardBtn}
                  activeOpacity={0.7}
                >
                  <IconForward size={20} color="#fff" />
                </TouchableOpacity>
              </View>
            )}

            {/* Reply input (only for other people's statuses) */}
            {!isOwnStatus && (
              <View style={styles.replyBar}>
                <View style={styles.replyInputWrap}>
                  <TextInput
                    style={styles.replyInput}
                    value={viewerReply}
                    onChangeText={setViewerReply}
                    placeholder={t?.('status.reply') || 'Responder...'}
                    placeholderTextColor="rgba(255,255,255,0.4)"
                    returnKeyType="send"
                    onSubmitEditing={handleStatusReply}
                    editable={!sendingReply}
                    onFocus={() => {
                      setIsPaused(true);
                      if (timerRef.current) clearTimeout(timerRef.current);
                      if (animRef.current) animRef.current.stop();
                    }}
                    onBlur={() => setIsPaused(false)}
                  />
                </View>
                {viewerReply.trim().length > 0 && (
                  <TouchableOpacity
                    style={styles.replySendBtn}
                    onPress={handleStatusReply}
                    disabled={sendingReply}
                    activeOpacity={0.7}
                  >
                    {sendingReply
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <IconSend size={20} color="#fff" />
                    }
                  </TouchableOpacity>
                )}
              </View>
            )}

            {/* Own status view count footer — tap to see who viewed */}
            {isOwnStatus && currentViewerItem?.view_count > 0 && (
              <TouchableOpacity
                style={styles.viewersFooter}
                onPress={() => handleShowViewers(currentViewerItem?.id)}
                activeOpacity={0.7}
              >
                <IconEye size={16} color="rgba(255,255,255,0.6)" />
                <Text style={styles.viewersText}>
                  {currentViewerItem?.view_count} {currentViewerItem?.view_count === 1 ? (t?.('status.viewer') || 'visualização') : (t?.('status.viewers') || 'visualizações')}
                </Text>
                <IconChevronRight size={14} color="rgba(255,255,255,0.4)" />
              </TouchableOpacity>
            )}
          </Animated.View>
        </Animated.View>
      </Modal>

      {/* ─── Viewers List Modal ─── */}
      <Modal visible={viewersModal} transparent animationType="slide" onRequestClose={() => { setViewersModal(false); setIsPaused(false); }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={() => { setViewersModal(false); setIsPaused(false); }}>
          <Pressable style={{ backgroundColor: isDark ? '#1a1a2e' : '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '60%', paddingBottom: 34 }}>
            <View style={{ alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : '#d1d5db', marginBottom: 12 }} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <IconEye size={18} color={isDark ? '#fff' : '#111'} />
                <Text style={{ fontSize: 17, fontWeight: '700', color: isDark ? '#fff' : '#111' }}>
                  {viewersList.length} {viewersList.length === 1 ? (t?.('status.viewer') || 'visualização') : (t?.('status.viewers') || 'visualizações')}
                </Text>
              </View>
            </View>
            {viewersLoading ? (
              <ActivityIndicator size="large" color={ACCENT} style={{ marginVertical: 32 }} />
            ) : viewersList.length === 0 ? (
              <Text style={{ textAlign: 'center', color: isDark ? '#6b7280' : '#9ca3af', marginVertical: 32, fontSize: 15 }}>
                {t?.('status.noViewers') || 'Ninguém viu ainda'}
              </Text>
            ) : (
              <ScrollView>
                {viewersList.map((v, i) => (
                  <View key={i} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 }}>
                    <AvatarCircle name={v.name || v.viewer_email} email={v.viewer_email} size={40} />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600', color: isDark ? '#fff' : '#111' }}>
                        {emailToDisplayName(v.name || v.viewer_email)}
                      </Text>
                      <Text style={{ fontSize: 12, color: isDark ? '#6b7280' : '#9ca3af', marginTop: 2 }}>
                        {v.viewed_at ? timeAgo(v.viewed_at, t) : ''}
                      </Text>
                    </View>
                  </View>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ─── Forward to Chat Modal ─── */}
      <Modal visible={forwardModalVisible} transparent animationType="slide" onRequestClose={() => { setForwardModalVisible(false); setIsPaused(false); }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={() => { setForwardModalVisible(false); setIsPaused(false); }}>
          <Pressable style={{ backgroundColor: isDark ? '#1a1a2e' : '#fff', borderTopLeftRadius: 20, borderTopRightRadius: 20, maxHeight: '60%', paddingBottom: 34 }}>
            <View style={{ alignItems: 'center', paddingVertical: 16, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : '#d1d5db', marginBottom: 12 }} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <IconForward size={18} color={isDark ? '#fff' : '#111'} />
                <Text style={{ fontSize: 17, fontWeight: '700', color: isDark ? '#fff' : '#111' }}>
                  {t?.('status.forwardTo') || 'Encaminhar para...'}
                </Text>
              </View>
            </View>
            {forwardLoading ? (
              <ActivityIndicator size="large" color={ACCENT} style={{ marginVertical: 32 }} />
            ) : forwardConversations.length === 0 ? (
              <Text style={{ textAlign: 'center', color: isDark ? '#6b7280' : '#9ca3af', marginVertical: 32, fontSize: 15 }}>
                {t?.('status.noConversations') || 'Nenhuma conversa'}
              </Text>
            ) : (
              <ScrollView>
                {forwardConversations.map((conv) => (
                  <TouchableOpacity
                    key={conv.id}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 }}
                    onPress={() => handleForwardToConversation(conv)}
                    activeOpacity={0.6}
                  >
                    <AvatarCircle
                      name={conv.name || conv.other_name || conv.other_email || ''}
                      email={conv.other_email || conv.id}
                      size={40}
                    />
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600', color: isDark ? '#fff' : '#111' }} numberOfLines={1}>
                        {conv.name || conv.other_name || emailToDisplayName(conv.other_email || '')}
                      </Text>
                      {conv.last_message && (
                        <Text style={{ fontSize: 12, color: isDark ? '#6b7280' : '#9ca3af', marginTop: 2 }} numberOfLines={1}>
                          {conv.last_message}
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ─── Status Creator Modal ─── */}
      <Modal visible={creatorVisible} animationType="slide" transparent={false} onRequestClose={() => { if (musicPickerVisible) { setMusicPickerVisible(false); stopStatusAudio(); } else { setCreatorVisible(false); } }}>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {/* ─── Music Picker (rendered INSIDE creator modal to avoid iOS stacking issues) ─── */}
          {musicPickerVisible ? (
            <View style={{ flex: 1, backgroundColor: isDark ? '#1a1a2e' : '#fff' }}>
              {/* Header with back button */}
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 54 : 16, paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' }}>
                <TouchableOpacity onPress={() => { setMusicPickerVisible(false); stopStatusAudio(); setMusicQuery(''); setMusicResults([]); }} style={{ padding: 4 }}>
                  <IconChevronLeft size={24} color={isDark ? '#fff' : '#111'} />
                </TouchableOpacity>
                <Text style={{ fontSize: 18, fontWeight: '700', color: isDark ? '#fff' : '#111', flex: 1, textAlign: 'center', marginRight: 28 }}>
                  {t?.('status.addMusic') || 'Adicionar musica'}
                </Text>
              </View>

              {/* Search input */}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginHorizontal: 16, marginVertical: 12, backgroundColor: isDark ? '#2d3748' : '#f3f4f6', borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8 }}>
                <IconSearch size={18} color={isDark ? '#6b7280' : '#9ca3af'} />
                <TextInput
                  style={{ flex: 1, marginLeft: 8, fontSize: 15, color: isDark ? '#fff' : '#111', paddingVertical: 0 }}
                  placeholder={t?.('status.searchMusic') || 'Buscar musica ou artista...'}
                  placeholderTextColor={isDark ? '#6b7280' : '#9ca3af'}
                  value={musicQuery}
                  onChangeText={(q) => {
                    setMusicQuery(q);
                    if (musicSearchTimer.current) clearTimeout(musicSearchTimer.current);
                    if (q.trim().length >= 2) {
                      const searchTerm = q.trim();
                      musicSearchTimer.current = setTimeout(async () => {
                        try {
                          setMusicSearching(true);
                          const results = await searchDeezerMusic(searchTerm);
                          setMusicResults(Array.isArray(results) ? results : []);
                        } catch (err) {
                          console.warn('[MusicPicker] Search error:', err);
                          setMusicResults([]);
                        } finally {
                          setMusicSearching(false);
                        }
                      }, 400);
                    } else {
                      setMusicResults([]);
                    }
                  }}
                  autoFocus
                />
                {musicQuery.length > 0 && (
                  <TouchableOpacity onPress={() => { setMusicQuery(''); setMusicResults([]); }}>
                    <IconX size={18} color={isDark ? '#6b7280' : '#9ca3af'} />
                  </TouchableOpacity>
                )}
              </View>

              {/* Results */}
              {musicSearching && <ActivityIndicator size="large" color={ACCENT} style={{ marginVertical: 24 }} />}

              <ScrollView style={{ flex: 1 }}>
                {!musicSearching && musicResults.length === 0 && musicQuery.length >= 2 && (
                  <Text style={{ textAlign: 'center', color: isDark ? '#6b7280' : '#9ca3af', marginVertical: 24, fontSize: 14 }}>
                    {t?.('status.noMusicResults') || 'Nenhum resultado encontrado'}
                  </Text>
                )}

                {!musicSearching && musicResults.length === 0 && musicQuery.length < 2 && (
                  <View style={{ alignItems: 'center', marginTop: 60 }}>
                    <IconMusicNote size={48} color={isDark ? '#374151' : '#d1d5db'} />
                    <Text style={{ color: isDark ? '#6b7280' : '#9ca3af', marginTop: 16, fontSize: 15 }}>
                      {t?.('status.searchMusicHint') || 'Pesquise uma musica para adicionar'}
                    </Text>
                  </View>
                )}

                {musicResults.map((track) => (
                  <TouchableOpacity
                    key={track.id}
                    style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, gap: 12 }}
                    onPress={() => {
                      stopStatusAudio();
                      setSelectedMusic(track);
                      setMusicPickerVisible(false);
                      setMusicQuery('');
                      setMusicResults([]);
                    }}
                    activeOpacity={0.6}
                  >
                    {/* Cover art */}
                    {track.coverUrl ? (
                      <Image source={{ uri: track.coverUrl }} style={{ width: 50, height: 50, borderRadius: 6 }} />
                    ) : (
                      <View style={{ width: 50, height: 50, borderRadius: 6, backgroundColor: isDark ? '#374151' : '#e5e7eb', alignItems: 'center', justifyContent: 'center' }}>
                        <IconMusicNote size={20} color={isDark ? '#6b7280' : '#9ca3af'} />
                      </View>
                    )}

                    {/* Song info */}
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 15, fontWeight: '600', color: isDark ? '#fff' : '#111' }} numberOfLines={1}>
                        {track.title}
                      </Text>
                      <Text style={{ fontSize: 13, color: isDark ? '#6b7280' : '#9ca3af', marginTop: 2 }} numberOfLines={1}>
                        {track.artist}
                      </Text>
                    </View>

                    {/* Preview play button */}
                    <TouchableOpacity
                      style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: ACCENT, alignItems: 'center', justifyContent: 'center' }}
                      onPress={(e) => {
                        e.stopPropagation?.();
                        if (_statusAudioRef && _statusAudioRef.src && _statusAudioRef.src.includes(track.previewUrl?.split('?')[0])) {
                          stopStatusAudio();
                        } else {
                          playStatusAudio(track.previewUrl);
                        }
                      }}
                    >
                      <IconPlay size={16} color="#fff" />
                    </TouchableOpacity>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          ) : (
          <View style={[styles.creatorContainer, { backgroundColor: creatorMode === 'photo' ? '#000' : textBgColor }]}>
            {/* Subtle pattern overlay for text mode */}
            {creatorMode === 'text' && (
              <View style={styles.creatorPatternOverlay} pointerEvents="none" />
            )}

            <View style={styles.creatorHeader}>
              <TouchableOpacity onPress={() => { setCreatorVisible(false); setMusicPickerVisible(false); setPhotoFilter('normal'); setStickers([]); setShowStickerPicker(false); setTextOverlays([]); setShowAddTextInput(false); setDrawMode(false); setDrawPaths([]); }} style={styles.creatorCloseBtn}>
                <IconX size={26} color="#fff" />
              </TouchableOpacity>

              {/* Font style toggle (text mode only) */}
              {creatorMode === 'text' && (
                <TouchableOpacity
                  onPress={() => {
                    const fonts = ['normal', 'serif', 'mono'];
                    const idx = fonts.indexOf(textFontStyle);
                    setTextFontStyle(fonts[(idx + 1) % fonts.length]);
                  }}
                  style={styles.fontToggleBtn}
                  activeOpacity={0.7}
                >
                  <Text style={[styles.fontToggleText, {
                    fontFamily: textFontStyle === 'serif' ? (Platform.OS === 'ios' ? 'Georgia' : 'serif')
                      : textFontStyle === 'mono' ? (Platform.OS === 'ios' ? 'Courier' : 'monospace')
                      : undefined,
                  }]}>Aa</Text>
                </TouchableOpacity>
              )}

              {/* Privacy toggle */}
              <TouchableOpacity
                onPress={() => {
                  const privacyOptions = ['all', 'contacts', 'except'];
                  const idx = privacyOptions.indexOf(statusPrivacy);
                  setStatusPrivacy(privacyOptions[(idx + 1) % privacyOptions.length]);
                }}
                style={styles.privacyToggleBtn}
                activeOpacity={0.7}
              >
                {statusPrivacy === 'all' ? (
                  <IconEye size={18} color="#fff" />
                ) : statusPrivacy === 'contacts' ? (
                  <IconEye size={18} color={ACCENT} />
                ) : (
                  <IconEye size={18} color="#FF6B6B" />
                )}
                <Text style={styles.privacyToggleText}>
                  {statusPrivacy === 'all' ? (t?.('status.privacyAll') || 'All')
                    : statusPrivacy === 'contacts' ? (t?.('status.privacyContacts') || 'Contacts')
                    : (t?.('status.privacyExcept') || 'Except')}
                </Text>
              </TouchableOpacity>

              <View style={{ flex: 1 }} />
              {creatorMode === 'text' && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.colorPicker}>
                  {TEXT_BG_COLORS.map((c) => (
                    <TouchableOpacity
                      key={c}
                      onPress={() => setTextBgColor(c)}
                      style={[
                        styles.colorDot,
                        { backgroundColor: c },
                        textBgColor === c && styles.colorDotSelected,
                      ]}
                    >
                      {textBgColor === c && (
                        <View style={styles.colorDotInner} />
                      )}
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}
            </View>

            <View style={styles.creatorBody}>
              {creatorMode === 'photo' && photoUri ? (
                <View style={styles.creatorPhotoWrap}>
                  {Platform.OS === 'web' ? (
                    <img
                      src={photoUri}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'contain',
                        filter: (PHOTO_FILTERS.find(f => f.key === photoFilter) || {}).css || 'none',
                      }}
                    />
                  ) : (
                    <View style={{ flex: 1, position: 'relative' }}>
                      <Image source={{ uri: photoUri }} style={styles.creatorPhoto} resizeMode="contain" />
                      {/* Native filter overlay tint */}
                      {(() => {
                        const f = PHOTO_FILTERS.find(fi => fi.key === photoFilter);
                        return f?.tint ? <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: f.tint }} pointerEvents="none" /> : null;
                      })()}
                    </View>
                  )}
                  {/* Draggable emoji stickers — PanResponder for drag */}
                  {stickers.map(st => (
                    <DraggableSticker key={st.id} sticker={st}
                      onMove={(x, y) => setStickers(prev => prev.map(s => s.id === st.id ? { ...s, x, y } : s))}
                      onRemove={() => setStickers(prev => prev.filter(s => s.id !== st.id))}
                    />
                  ))}
                </View>
              ) : (
                <TextInput
                  style={[styles.creatorInput, {
                    fontFamily: textFontStyle === 'serif' ? (Platform.OS === 'ios' ? 'Georgia' : 'serif')
                      : textFontStyle === 'mono' ? (Platform.OS === 'ios' ? 'Courier' : 'monospace')
                      : undefined,
                    fontStyle: textFontStyle === 'serif' ? 'italic' : 'normal',
                  }]}
                  placeholder={typePlaceholder}
                  placeholderTextColor="rgba(255,255,255,0.35)"
                  value={textContent}
                  onChangeText={setTextContent}
                  multiline
                  textAlign="center"
                  textAlignVertical="center"
                  autoFocus
                  maxLength={500}
                />
              )}
              {creatorMode === 'photo' && (
                <TextInput
                  style={[styles.captionInput, { color: '#fff' }]}
                  placeholder={t?.('status.addCaption') || 'Adicionar legenda...'}
                  placeholderTextColor="rgba(255,255,255,0.4)"
                  value={textContent}
                  onChangeText={setTextContent}
                  maxLength={200}
                />
              )}

              {/* Instagram-style filter strip (photo mode only) */}
              {creatorMode === 'photo' && photoUri && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false}
                  style={{ position: 'absolute', bottom: 50, left: 0, right: 0 }}
                  contentContainerStyle={{ paddingHorizontal: 12, gap: 10, alignItems: 'center' }}
                >
                  {PHOTO_FILTERS.map(f => (
                    <TouchableOpacity key={f.key} onPress={() => setPhotoFilter(f.key)} activeOpacity={0.8}
                      style={{ alignItems: 'center', width: 72 }}>
                      <View style={{
                        width: 62, height: 62, borderRadius: 8, overflow: 'hidden',
                        borderWidth: photoFilter === f.key ? 2.5 : 0,
                        borderColor: '#7C3AED',
                      }}>
                        {Platform.OS === 'web' ? (
                          <img src={photoUri} alt="" style={{ width: 62, height: 62, objectFit: 'cover', filter: f.css }} />
                        ) : (
                          <View style={{ width: 62, height: 62 }}>
                            <Image source={{ uri: photoUri }} style={{ width: 62, height: 62 }} resizeMode="cover" />
                            {f.tint && <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: f.tint }} />}
                          </View>
                        )}
                      </View>
                      <Text style={{ color: photoFilter === f.key ? '#7C3AED' : 'rgba(255,255,255,0.7)', fontSize: 10, fontWeight: '600', marginTop: 4 }}>{f.label}</Text>
                    </TouchableOpacity>
                  ))}
                </ScrollView>
              )}

              {/* Text overlays (draggable) */}
              {textOverlays.map(to => (
                <DraggableTextOverlay key={to.id} text={to.text} color={to.color}
                  onMove={(x, y) => setTextOverlays(prev => prev.map(t2 => t2.id === to.id ? { ...t2, x, y } : t2))}
                  onRemove={() => setTextOverlays(prev => prev.filter(t2 => t2.id !== to.id))}
                />
              ))}

              {/* Sticker + Text buttons (photo mode) */}
              {creatorMode === 'photo' && photoUri && (
                <View style={{ position: 'absolute', top: 8, right: 12, zIndex: 20, gap: 8 }}>
                  <TouchableOpacity onPress={() => setShowStickerPicker(p => !p)}
                    style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ fontSize: 22 }}>😊</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => { setShowAddTextInput(true); setNewOverlayText(''); }}
                    style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>Aa</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => setDrawMode(d => !d)}
                    style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: drawMode ? '#7C3AED' : 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                    <Text style={{ color: '#fff', fontSize: 18 }}>✏️</Text>
                  </TouchableOpacity>
                  {drawPaths.length > 0 && (
                    <TouchableOpacity onPress={() => setDrawPaths(prev => prev.slice(0, -1))}
                      style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                      <Text style={{ color: '#fff', fontSize: 14 }}>↩️</Text>
                    </TouchableOpacity>
                  )}
                </View>
              )}

              {/* Draw color picker (when draw mode active) */}
              {drawMode && creatorMode === 'photo' && (
                <View style={{ position: 'absolute', top: 8, left: 12, zIndex: 20, flexDirection: 'row', gap: 6 }}>
                  {['#fff', '#FF3B30', '#FF9500', '#FFCC00', '#34C759', '#007AFF', '#AF52DE', '#000'].map(c => (
                    <TouchableOpacity key={c} onPress={() => setDrawColor(c)}
                      style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: c, borderWidth: drawColor === c ? 3 : 1, borderColor: drawColor === c ? '#7C3AED' : 'rgba(255,255,255,0.4)' }}
                    />
                  ))}
                </View>
              )}

              {/* Draw canvas overlay (SVG paths) */}
              {creatorMode === 'photo' && (drawPaths.length > 0 || drawMode) && (
                <View
                  style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: drawMode ? 15 : 5 }}
                  pointerEvents={drawMode ? 'auto' : 'none'}
                  onStartShouldSetResponder={() => drawMode}
                  onMoveShouldSetResponder={() => drawMode}
                  onResponderGrant={(e) => {
                    if (!drawMode) return;
                    const { locationX, locationY } = e.nativeEvent;
                    currentDrawPath.current = { points: [{ x: locationX, y: locationY }], color: drawColor };
                  }}
                  onResponderMove={(e) => {
                    if (!drawMode || !currentDrawPath.current) return;
                    const { locationX, locationY } = e.nativeEvent;
                    currentDrawPath.current.points.push({ x: locationX, y: locationY });
                    setDrawPaths(prev => {
                      const next = [...prev];
                      if (next.length > 0 && next[next.length - 1] === currentDrawPath.current) {
                        next[next.length - 1] = { ...currentDrawPath.current };
                      } else {
                        next.push(currentDrawPath.current);
                      }
                      return next;
                    });
                  }}
                  onResponderRelease={() => { currentDrawPath.current = null; }}
                >
                  <Svg width="100%" height="100%" style={{ position: 'absolute', top: 0, left: 0 }}>
                    {drawPaths.map((p, i) => {
                      if (!p.points || p.points.length < 2) return null;
                      const d = p.points.map((pt, j) => `${j === 0 ? 'M' : 'L'}${pt.x},${pt.y}`).join(' ');
                      return <Path key={i} d={d} stroke={p.color} strokeWidth={3} fill="none" strokeLinecap="round" strokeLinejoin="round" />;
                    })}
                  </Svg>
                </View>
              )}

              {/* Add text input modal */}
              {showAddTextInput && (
                <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.7)', zIndex: 40, justifyContent: 'center', alignItems: 'center' }}>
                  <View style={{ width: '80%', backgroundColor: '#1a1a2e', borderRadius: 16, padding: 20 }}>
                    <TextInput
                      value={newOverlayText}
                      onChangeText={setNewOverlayText}
                      placeholder="Digite o texto..."
                      placeholderTextColor="rgba(255,255,255,0.4)"
                      style={{ color: '#fff', fontSize: 18, borderBottomWidth: 1, borderBottomColor: 'rgba(255,255,255,0.2)', paddingBottom: 10, marginBottom: 16, textAlign: 'center' }}
                      autoFocus
                      maxLength={100}
                    />
                    <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'center' }}>
                      <TouchableOpacity onPress={() => setShowAddTextInput(false)}
                        style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.1)' }}>
                        <Text style={{ color: '#fff' }}>Cancelar</Text>
                      </TouchableOpacity>
                      <TouchableOpacity onPress={() => {
                        if (newOverlayText.trim()) {
                          const colors = ['#fff', '#FFD700', '#FF6B6B', '#7C3AED', '#10B981', '#3B82F6'];
                          setTextOverlays(prev => [...prev, {
                            id: Date.now(), text: newOverlayText.trim(),
                            x: SCREEN_WIDTH / 2 - 60, y: SCREEN_HEIGHT / 3,
                            color: colors[Math.floor(Math.random() * colors.length)],
                          }]);
                        }
                        setShowAddTextInput(false);
                      }} style={{ paddingHorizontal: 20, paddingVertical: 10, borderRadius: 20, backgroundColor: '#7C3AED' }}>
                        <Text style={{ color: '#fff', fontWeight: '700' }}>Adicionar</Text>
                      </TouchableOpacity>
                    </View>
                  </View>
                </View>
              )}
              {showStickerPicker && (
                <View style={{ position: 'absolute', top: 56, right: 12, backgroundColor: 'rgba(0,0,0,0.85)', borderRadius: 16, padding: 12, width: 260, zIndex: 30, maxHeight: SCREEN_HEIGHT * 0.55 }}>
                  <ScrollView showsVerticalScrollIndicator={false}>
                    {/* Interactive stickers section */}
                    <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700', marginBottom: 8, letterSpacing: 0.5 }}>INTERATIVOS</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
                      {[
                        { key: 'poll', icon: '📊', label: 'Enquete' },
                        { key: 'question', icon: '❓', label: 'Pergunta' },
                        { key: 'countdown', icon: '⏳', label: 'Contagem' },
                        { key: 'mention', icon: '@', label: 'Menção' },
                        { key: 'quiz', icon: '🧠', label: 'Quiz' },
                        { key: 'location', icon: '📍', label: 'Local' },
                      ].map(s => (
                        <TouchableOpacity key={s.key} onPress={() => {
                          setShowStickerPicker(false);
                          if (s.key === 'poll') {
                            setStickers(prev => [...prev, { id: Date.now(), type: 'poll', x: 40, y: 200, question: 'Sim ou Não?', optionA: 'Sim', optionB: 'Não' }]);
                          } else if (s.key === 'question') {
                            setStickers(prev => [...prev, { id: Date.now(), type: 'question', x: 40, y: 200, prompt: 'Me pergunte algo...' }]);
                          } else if (s.key === 'countdown') {
                            const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(12, 0, 0, 0);
                            setStickers(prev => [...prev, { id: Date.now(), type: 'countdown', x: 60, y: 200, label: 'Evento', targetDate: tomorrow.toISOString() }]);
                          } else if (s.key === 'mention') {
                            setStickers(prev => [...prev, { id: Date.now(), type: 'mention', x: 80, y: 250, username: user?.name || user?.email?.split('@')[0] || 'amigo' }]);
                          } else if (s.key === 'quiz') {
                            setStickers(prev => [...prev, { id: Date.now(), type: 'quiz', x: 40, y: 180, question: 'Qual a resposta?', options: ['A', 'B', 'C'], correct: 0 }]);
                          } else if (s.key === 'location') {
                            setStickers(prev => [...prev, { id: Date.now(), emoji: '📍', x: 100 + Math.random() * 80, y: 150 + Math.random() * 150 }]);
                          }
                        }} style={{ width: 72, height: 62, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 10, padding: 4 }}>
                          <Text style={{ fontSize: s.key === 'mention' ? 18 : 22 }}>{s.icon}</Text>
                          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 9, marginTop: 2, fontWeight: '600' }}>{s.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    {/* Emoji stickers */}
                    <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700', marginBottom: 8, letterSpacing: 0.5 }}>EMOJIS</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {['😂','❤️','🔥','👏','🎉','😍','🥺','💀','🤩','😎','🥳','💯','🙌','✨','💕','🦋','🌈','⭐','🎵','📍','⏰','🗓️'].map(em => (
                        <TouchableOpacity key={em} onPress={() => {
                          setStickers(prev => [...prev, { id: Date.now() + Math.random(), emoji: em, x: 80 + Math.random() * 100, y: 100 + Math.random() * 200 }]);
                          setShowStickerPicker(false);
                        }} style={{ width: 38, height: 38, alignItems: 'center', justifyContent: 'center' }}>
                          <Text style={{ fontSize: 24 }}>{em}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  </ScrollView>
                </View>
              )}
            </View>

            {/* Selected music indicator */}
            {selectedMusic && (
              <View style={styles.selectedMusicBar}>
                {selectedMusic.coverUrl ? (
                  <Image source={{ uri: selectedMusic.coverUrl }} style={styles.selectedMusicCover} />
                ) : null}
                <View style={styles.selectedMusicInfo}>
                  <IconMusicNote size={14} color="#fff" />
                  <Text style={styles.selectedMusicTitle} numberOfLines={1}>{selectedMusic.title}</Text>
                  <Text style={styles.selectedMusicArtist} numberOfLines={1}>{selectedMusic.artist}</Text>
                </View>
                <TouchableOpacity onPress={() => setSelectedMusic(null)} style={{ padding: 6 }}>
                  <IconX size={18} color="rgba(255,255,255,0.7)" />
                </TouchableOpacity>
              </View>
            )}

            <View style={styles.creatorFooter}>
              {/* Add Music button */}
              <TouchableOpacity
                style={styles.addMusicBtn}
                onPress={() => setMusicPickerVisible(true)}
                activeOpacity={0.7}
              >
                <IconMusicNote size={20} color="#fff" />
                <Text style={styles.addMusicText}>
                  {selectedMusic ? (t?.('status.changeMusic') || 'Trocar musica') : (t?.('status.addMusic') || 'Adicionar musica')}
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[styles.sendBtn,
                  publishing && styles.sendBtnDisabled,
                  creatorMode === 'text' && !textContent.trim() && styles.sendBtnDisabled,
                ]}
                onPress={publishStatus}
                disabled={publishing || (creatorMode === 'text' && !textContent.trim())}
                activeOpacity={0.8}
              >
                {publishing ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <View style={styles.sendBtnInner}>
                    <IconEdit size={18} color="#fff" />
                    <Text style={styles.sendBtnText}>{t?.('status.publish') || 'Publicar'}</Text>
                  </View>
                )}
              </TouchableOpacity>
            </View>
          </View>
          )}
        </KeyboardAvoidingView>
      </Modal>
      {/* Hidden WebView for native audio playback */}
      {Platform.OS !== 'web' && nativeAudioSrc && (
        <NativeAudioPlayer key={nativeAudioSrc} url={nativeAudioSrc} />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },

  // Story horizontal scroller
  storyScrollerContainer: {
    maxHeight: 110,
    marginTop: 4,
  },
  storyScroller: {
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 2,
  },
  storyItem: {
    alignItems: 'center',
    width: 80,
    marginRight: 4,
  },
  storyAvatarWrap: {
    position: 'relative',
    marginBottom: 6,
  },
  storyPlusBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2.5,
  },
  storyName: {
    fontSize: 11,
    fontWeight: '500',
    textAlign: 'center',
    width: 72,
  },

  // Search
  inlineSearchRow: {
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 4,
  },
  searchToggle: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 22,
    paddingHorizontal: 16,
    paddingVertical: 10,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4 },
      android: { elevation: 1 },
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.06)' },
    }),
  },
  searchToggleText: {
    fontSize: 15,
    marginLeft: 10,
  },
  searchBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 16,
    marginTop: 8,
    marginBottom: 4,
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    marginLeft: 10,
    marginRight: 8,
    paddingVertical: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },

  scrollView: { flex: 1 },

  // My Status Card
  myStatusCard: {
    marginHorizontal: 16,
    marginTop: 6,
    marginBottom: 6,
    borderRadius: 18,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 10 },
      android: { elevation: 3 },
    }),
  },
  myStatusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 16,
  },
  myAvatarWrapper: { position: 'relative' },
  plusBadge: {
    position: 'absolute',
    bottom: -1,
    right: -1,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2.5,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.3, shadowRadius: 3 },
      android: { elevation: 3 },
      web: { boxShadow: '0 1px 4px rgba(124,58,237,0.3)' },
    }),
  },
  myStatusName: {
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.1,
  },
  myStatusSub: {
    fontSize: 13,
    marginTop: 3,
    letterSpacing: 0.1,
  },
  myStatusActions: { flexDirection: 'row', alignItems: 'center' },
  actionCircle: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Status rows
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
    marginHorizontal: 16,
    marginBottom: 3,
    borderRadius: 16,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4 },
      android: { elevation: 1 },
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.04)' },
    }),
  },
  avatarWrapper: { position: 'relative' },
  statusInfo: { flex: 1, marginLeft: 16 },
  statusName: { fontSize: 16, fontWeight: '600', letterSpacing: 0.15 },
  statusMeta: { flexDirection: 'row', alignItems: 'center', marginTop: 3, gap: 8 },
  statusTime: { fontSize: 13, letterSpacing: 0.1 },
  countPill: {
    paddingHorizontal: 7,
    paddingVertical: 1,
    borderRadius: 8,
  },
  countPillText: {
    fontSize: 11,
    fontWeight: '700',
  },

  // Section headers
  section: { marginTop: 14 },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 10,
    marginLeft: 16,
  },
  sectionAccent: {
    width: 3,
    height: 16,
    borderRadius: 2,
    backgroundColor: ACCENT,
    marginRight: 10,
  },
  sectionTitle: {
    fontSize: 11.5,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 1.3,
    flex: 1,
  },
  sectionCount: {
    fontSize: 11,
    fontWeight: '600',
    marginRight: 16,
  },

  // Empty state
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 60,
    paddingHorizontal: 40,
  },
  emptyText: {
    fontSize: 18,
    fontWeight: '700',
    textAlign: 'center',
    marginTop: 24,
  },
  emptySubtext: {
    fontSize: 14,
    marginTop: 8,
    textAlign: 'center',
    lineHeight: 20,
  },
  emptyButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: ACCENT,
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 24,
    gap: 8,
    ...Platform.select({
      web: { boxShadow: '0 3px 10px rgba(124,58,237,0.3)' },
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.3, shadowRadius: 8 },
      android: { elevation: 4 },
    }),
  },
  emptyButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
  },

  // FABs
  fabSecondary: {
    position: 'absolute',
    bottom: 96,
    right: 24,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.15, shadowRadius: 8 },
      android: { elevation: 6 },
    }),
  },
  fab: {
    position: 'absolute',
    bottom: 28,
    right: 20,
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.35, shadowRadius: 10 },
      android: { elevation: 8 },
    }),
  },

  // ─── Full-Screen Viewer ───
  viewerContainer: {
    flex: 1,
    backgroundColor: '#000',
  },
  progressBarRow: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingTop: Platform.OS === 'ios' ? 54 : 14,
    gap: 4,
  },
  progressBarTrack: {
    flex: 1,
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.2)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  progressBarFill: {
    height: '100%',
    backgroundColor: '#fff',
    borderRadius: 2,
  },
  viewerHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  viewerHeaderInfo: { flex: 1, marginLeft: 12 },
  viewerName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  viewerTime: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 12,
    marginTop: 2,
  },
  viewCountBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 14,
    gap: 5,
    marginRight: 8,
  },
  viewCountText: {
    color: 'rgba(255,255,255,0.85)',
    fontSize: 13,
    fontWeight: '600',
  },
  viewerClose: {
    padding: 8,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.1)',
  },
  viewerContent: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  tapZoneLeft: {
    position: 'absolute',
    left: 8,
    top: '45%',
    zIndex: 5,
  },
  tapZoneArrow: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  viewerTextCard: {
    width: '100%',
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  viewerText: {
    color: '#fff',
    fontSize: 28,
    fontWeight: '700',
    textAlign: 'center',
    lineHeight: 40,
    textShadowColor: 'rgba(0,0,0,0.25)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  viewerImage: { width: SCREEN_WIDTH, height: '100%' },
  viewerCaptionBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 24,
    paddingVertical: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)' } : {}),
  },
  viewerCaption: {
    color: '#fff',
    fontSize: 16,
    textAlign: 'center',
    lineHeight: 22,
    textShadowColor: 'rgba(0,0,0,0.3)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  pausedOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pausedBadge: {
    backgroundColor: 'rgba(0,0,0,0.4)',
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pausedText: {
    color: '#fff',
    fontSize: 20,
    fontWeight: '900',
    letterSpacing: 2,
  },

  // Reply bar
  replyBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 12,
    paddingBottom: Platform.OS === 'ios' ? 36 : 16,
  },
  replyInputWrap: {
    flex: 1,
    borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.12)',
    overflow: 'hidden',
  },
  replyInput: {
    height: 44,
    paddingHorizontal: 18,
    color: '#fff',
    fontSize: 15,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  replySendBtn: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 8,
  },

  // Viewers footer
  viewersFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 18,
    paddingVertical: 14,
    paddingBottom: Platform.OS === 'ios' ? 36 : 18,
    gap: 8,
  },
  viewersText: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 13,
  },

  // Reaction bar
  reactionBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 6,
    gap: 4,
  },
  reactionBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionBtnActive: {
    backgroundColor: 'rgba(124,58,237,0.4)',
    borderWidth: 1.5,
    borderColor: 'rgba(124,58,237,0.7)',
  },
  reactionEmoji: {
    fontSize: 22,
  },
  forwardBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(255,255,255,0.1)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 4,
  },

  // Reaction badges on status
  reactionBadgesRow: {
    flexDirection: 'row',
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingBottom: 4,
    gap: 6,
    flexWrap: 'wrap',
  },
  reactionBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 14,
    paddingHorizontal: 8,
    paddingVertical: 4,
    gap: 3,
  },
  reactionBadgeEmoji: {
    fontSize: 16,
  },
  reactionBadgeCount: {
    color: 'rgba(255,255,255,0.8)',
    fontSize: 12,
    fontWeight: '600',
  },

  // ─── Creator ───
  creatorContainer: { flex: 1 },
  creatorPatternOverlay: {
    ...StyleSheet.absoluteFillObject,
    opacity: 0.04,
    backgroundColor: '#fff',
  },
  creatorHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 54 : 16,
    paddingBottom: 12,
    zIndex: 2,
  },
  creatorCloseBtn: {
    width: 42,
    height: 42,
    borderRadius: 21,
    backgroundColor: 'rgba(0,0,0,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  colorPicker: { flexDirection: 'row', maxWidth: 260 },
  colorDot: {
    width: 32,
    height: 32,
    borderRadius: 16,
    marginHorizontal: 4,
    borderWidth: 2.5,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.15, shadowRadius: 3 },
      android: { elevation: 2 },
      web: { boxShadow: '0 1px 4px rgba(0,0,0,0.2)' },
    }),
  },
  colorDotSelected: {
    borderColor: '#fff',
    transform: [{ scale: 1.15 }],
  },
  colorDotInner: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: 'rgba(255,255,255,0.8)',
  },
  creatorBody: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
  },
  creatorInput: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '700',
    textAlign: 'center',
    width: '100%',
    maxHeight: 260,
    lineHeight: 44,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', caretColor: '#fff' } : {}),
  },
  creatorPhotoWrap: {
    flex: 1,
    width: '100%',
    borderRadius: 20,
    overflow: 'hidden',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 8 },
      android: { elevation: 4 },
      web: { boxShadow: '0 4px 16px rgba(0,0,0,0.3)' },
    }),
  },
  creatorPhoto: {
    width: '100%',
    flex: 1,
  },
  captionInput: {
    fontSize: 16,
    textAlign: 'center',
    width: '100%',
    paddingVertical: 14,
    borderTopWidth: 1,
    borderTopColor: 'rgba(255,255,255,0.12)',
    marginTop: 10,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  creatorFooter: {
    paddingHorizontal: 20,
    paddingBottom: Platform.OS === 'ios' ? 40 : 28,
    alignItems: 'center',
    zIndex: 2,
  },
  sendBtn: {
    backgroundColor: 'rgba(255,255,255,0.22)',
    paddingHorizontal: 40,
    paddingVertical: 16,
    borderRadius: 30,
    minWidth: 180,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.15)',
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' } : {}),
  },
  sendBtnDisabled: { opacity: 0.35 },
  sendBtnInner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  sendBtnText: {
    color: '#fff',
    fontSize: 17,
    fontWeight: '700',
    letterSpacing: 0.3,
  },

  // Music overlay in viewer
  musicOverlay: {
    position: 'absolute',
    bottom: 80,
    left: 16,
    right: 16,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    gap: 10,
    ...(Platform.OS === 'web' ? { backdropFilter: 'blur(10px)' } : {}),
  },
  musicOverlayCover: {
    width: 40, height: 40, borderRadius: 6,
  },
  musicOverlayInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  musicOverlayTitle: {
    color: '#fff', fontSize: 14, fontWeight: '700',
    flexShrink: 1,
  },
  musicOverlayArtist: {
    color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '500',
  },

  // Add music button in creator
  addMusicBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
    marginBottom: 12,
    alignSelf: 'center',
  },
  addMusicText: {
    color: '#fff', fontSize: 14, fontWeight: '600',
  },

  // Selected music indicator in creator
  selectedMusicBar: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.3)',
    borderRadius: 12,
    marginHorizontal: 20,
    marginBottom: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    gap: 8,
  },
  selectedMusicCover: {
    width: 36, height: 36, borderRadius: 4,
  },
  selectedMusicInfo: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flexWrap: 'wrap',
  },
  selectedMusicTitle: {
    color: '#fff', fontSize: 13, fontWeight: '600',
    flexShrink: 1,
  },
  selectedMusicArtist: {
    color: 'rgba(255,255,255,0.6)', fontSize: 11,
  },

  // Font toggle button in creator
  fontToggleBtn: {
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: 10,
  },
  fontToggleText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },

  // Privacy toggle button in creator
  privacyToggleBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginLeft: 8,
  },
  privacyToggleText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
});
