import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, Image,
  ActivityIndicator, TextInput, Platform, Keyboard, Dimensions,
  Alert, Modal, Pressable, Linking, Animated, ScrollView, PanResponder, Share,
} from 'react-native';
// FlashList reverted to FlatList
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
import { emailToDisplayName } from '../services/api';
import * as e2eService from '../services/e2e';
import * as DocumentPicker from 'expo-document-picker';
import * as Haptics from 'expo-haptics';
import {
  IconArrowLeft, IconSend, IconUsers, IconMoreVert, IconVideo, IconPhone, IconPhoneOff,
  IconX, IconEdit, IconTrash, IconReply, IconPaperclip, IconImage, IconFileText,
  IconCheck, IconCheckCircle, IconMic, IconPlay, IconPause, IconStop,
  IconCamera, IconMapPin, IconSmile, IconNavigation, IconUser, IconPlus,
  IconThumbsUp, IconHeart, IconLaughFace, IconSurpriseFace, IconSadFace, IconPrayHands,
  IconClock, IconAlertTriangle, IconLock, IconForward, IconChevronDown,
  IconStar, IconStarFilled, IconBarChart, IconInfo, IconGlobe,
  IconCopy, IconPin,
} from '../components/Icons';
import * as Clipboard from 'expo-clipboard';
import { WebView } from 'react-native-webview';
import ChatMediaViewer from '../components/ChatMediaViewer';
import AvatarCircle from '../components/AvatarCircle';
import { registerAudioPlayer, stopAllAudio } from '../services/audioManager';
import ProfileViewerModal from '../components/ProfileViewerModal';
import { MentionAutocomplete, isMentioning, insertMention, isUserMentioned } from '../components/MentionInput';
import { ScheduleToast, CustomScheduleModal, ScheduledMessagesModal } from '../components/ScheduleModals';
import GifPickerPanel from '../components/GifPicker';
import StickerPicker from '../components/StickerPicker';
import MediaGallery from '../components/MediaGallery';
import FormatToolbar from '../components/FormatToolbar';
import { getCachedUri, preCacheUrls, cacheMedia } from '../services/mediaCache';
const ExpoImage = Image;
import { cacheMessages, getCachedMessages, getLastSyncId, cacheSingleMessage } from '../services/chatCache';

// ============================================================
// HELPERS
// ============================================================

function formatTime(dateStr) {
  if (!dateStr) return '';
  // Handle both server format (no Z suffix) and ISO format (with Z suffix)
  const str = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const d = new Date(str);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateSeparator(dateStr, t) {
  if (!dateStr) return '';
  const str = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const d = new Date(str);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const msgDate = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diffDays = Math.floor((today - msgDate) / 86400000);

  if (diffDays === 0) return t('date.today');
  if (diffDays === 1) return t('date.yesterday');
  const locale = t('_locale') || undefined;
  if (diffDays < 7) return d.toLocaleDateString(locale, { weekday: 'long' });
  return d.toLocaleDateString(locale, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ============================================================
// IMAGE COMPRESSION (Web only - reduces upload size for faster sends)
// ============================================================
function compressImageWeb(blob, maxDimension = 2048, quality = 0.8) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') { resolve(null); return; }
    const img = new window.Image();
    const url = URL.createObjectURL(blob);
    img.onload = () => {
      URL.revokeObjectURL(url);
      let { width, height } = img;
      // Skip if already small enough
      if (width <= maxDimension && height <= maxDimension && blob.size < 500000) {
        resolve(null); return;
      }
      // Scale down to maxDimension
      if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      canvas.toBlob((result) => {
        resolve(result);
      }, 'image/jpeg', quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

// ============================================================
// MESSAGE SEND ANIMATION (slide-up + fade-in for new messages)
// ============================================================
function MessageSendAnim({ children, animate }) {
  const translateY = useRef(new Animated.Value(animate ? 20 : 0)).current;
  const opacity = useRef(new Animated.Value(animate ? 0 : 1)).current;
  useEffect(() => {
    if (animate) {
      const nd = Platform.OS !== 'web';
      Animated.parallel([
        Animated.timing(translateY, { toValue: 0, duration: 200, useNativeDriver: nd }),
        Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: nd }),
      ]).start();
    }
  }, []);
  if (!animate) return children;
  return (
    <Animated.View style={{ transform: [{ translateY }], opacity }}>
      {children}
    </Animated.View>
  );
}

// ============================================================
// TYPING BUBBLE (WhatsApp-style bouncing dots)
// ============================================================
function TypingBubble({ name, colors, recording, t }) {
  const dot1 = useRef(new Animated.Value(0)).current;
  const dot2 = useRef(new Animated.Value(0)).current;
  const dot3 = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const nativeDriver = Platform.OS !== 'web';
    const animateDot = (dot, delay) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(dot, { toValue: -5, duration: 250, useNativeDriver: nativeDriver }),
          Animated.timing(dot, { toValue: 0, duration: 250, useNativeDriver: nativeDriver }),
          Animated.delay(600 - delay),
        ])
      );
    const a1 = animateDot(dot1, 0);
    const a2 = animateDot(dot2, 150);
    const a3 = animateDot(dot3, 300);
    a1.start(); a2.start(); a3.start();
    return () => { a1.stop(); a2.stop(); a3.stop(); };
  }, []);

  return (
    <View style={{ alignSelf: 'flex-start', marginBottom: 8, marginLeft: 12 }}>
      {name && <Text style={{ fontSize: 11, color: colors.textTertiary, marginBottom: 4, marginLeft: 8, fontWeight: '600', letterSpacing: 0.2 }}>{name}</Text>}
      <View style={{
        backgroundColor: colors.surface, borderRadius: 8, borderBottomLeftRadius: 2,
        paddingHorizontal: 16, paddingVertical: 10, flexDirection: 'row', gap: 5, alignItems: 'center',
        ...Platform.select({
          ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3 },
          android: { elevation: 1 },
          web: { boxShadow: '0 1px 1px rgba(0,0,0,0.06)' },
        }),
      }}>
        {recording ? (
          <>
            <IconMic size={14} color={colors.error || '#EF4444'} style={{ marginRight: 3 }} />
            <Text style={{ fontSize: 12, color: colors.textTertiary, fontStyle: 'italic', fontWeight: '500' }}>{t ? t('chat.recording') : 'recording...'}</Text>
          </>
        ) : (
          [dot1, dot2, dot3].map((dot, i) => (
            <Animated.View key={i} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textTertiary, opacity: 0.55, transform: [{ translateY: dot }] }} />
          ))
        )}
      </View>
    </View>
  );
}

// ============================================================
// RICH TEXT FORMATTING (WhatsApp-style)
// ============================================================
function FormattedText({ text, style, colors }) {
  if (!text) return <Text style={style}>{''}</Text>;
  const parts = [];
  // Match ```code blocks```, *bold*, _italic_, ~strike~, `inline code`
  const formatRegex = /(```[\s\S]+?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g;
  let lastIndex = 0;
  let match;

  while ((match = formatRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), fmt: null });
    }
    const raw = match[0];
    if (raw.startsWith('```') && raw.endsWith('```')) {
      const inner = raw.slice(3, -3);
      parts.push({ text: inner, fmt: { fontFamily: Platform.OS === 'web' ? 'monospace' : 'Courier', backgroundColor: 'rgba(0,0,0,0.06)', fontSize: 13 } });
    } else if (raw.startsWith('*')) {
      parts.push({ text: raw.slice(1, -1), fmt: { fontWeight: '700' } });
    } else if (raw.startsWith('_')) {
      parts.push({ text: raw.slice(1, -1), fmt: { fontStyle: 'italic' } });
    } else if (raw.startsWith('~')) {
      parts.push({ text: raw.slice(1, -1), fmt: { textDecorationLine: 'line-through' } });
    } else if (raw.startsWith('`')) {
      parts.push({ text: raw.slice(1, -1), fmt: { fontFamily: Platform.OS === 'web' ? 'monospace' : 'Courier', backgroundColor: 'rgba(0,0,0,0.06)' } });
    }
    lastIndex = match.index + raw.length;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), fmt: null });

  if (parts.length === 0) return <Text style={style}>{text}</Text>;

  return (
    <Text style={style}>
      {parts.map((p, i) => (
        <Text key={i} style={p.fmt}>{p.text}</Text>
      ))}
    </Text>
  );
}

// ============================================================
// TEXT WITH CLICKABLE LINKS + @MENTIONS
// ============================================================
const URL_REGEX = /(https?:\/\/[^\s<]+)/g;
const MENTION_PAT = /@([\w.\-]+(?:@[\w.\-]+\.\w+)?)/g;

function TextWithLinks({ text, style, linkColor, colors, mentionColor }) {
  if (!text) return null;
  const urlParts = text.split(URL_REGEX);
  const mTest = new RegExp(MENTION_PAT.source);
  const hasMentions = mTest.test(text);
  if (urlParts.length === 1 && !hasMentions) {
    return <FormattedText text={text} style={style} colors={colors} />;
  }
  const renderMentions = (str, kp) => {
    if (!str) return null;
    if (!mTest.test(str)) return <FormattedText key={kp} text={str} colors={colors} />;
    const re = new RegExp(MENTION_PAT.source, 'g');
    const segs = []; let li = 0, mt;
    while ((mt = re.exec(str)) !== null) {
      if (mt.index > li) segs.push({ t: 'x', v: str.slice(li, mt.index) });
      segs.push({ t: '@', v: mt[0] });
      li = re.lastIndex;
    }
    if (li < str.length) segs.push({ t: 'x', v: str.slice(li) });
    return segs.map((p, j) =>
      p.t === '@'
        ? <Text key={`${kp}_m${j}`} style={{ color: mentionColor || linkColor, fontWeight: '700' }}>{p.v}</Text>
        : <FormattedText key={`${kp}_t${j}`} text={p.v} colors={colors} />
    );
  };
  return (
    <Text style={style}>
      {urlParts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <Text key={i} style={{ color: linkColor, textDecorationLine: 'underline' }}
            onPress={() => { try { if (/chatyy\.com\.br\/docs\//.test(part)) { router.push({ pathname: '/documentos', params: { url: part } }); } else { Linking.openURL(part); } } catch {} }}>
            {part}
          </Text>
        ) : (
          renderMentions(part, `p${i}`)
        )
      )}
    </Text>
  );
}

// ============================================================
// LINK PREVIEW CARD (WhatsApp-style)
// ============================================================
function LinkPreview({ url, colors }) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    let cancelled = false;
    api.chatLinkPreview(url).then(r => {
      if (!cancelled && r.success && r.data?.title) setPreview(r.data);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [url]);
  if (!preview) return null;
  return (
    <TouchableOpacity onPress={() => { try { Linking.openURL(url); } catch {} }} activeOpacity={0.7} style={[linkPreviewStyles.container, { borderColor: colors.border, backgroundColor: colors.surface }]}>
      {preview.image && <ExpoImage source={{ uri: preview.image }} style={linkPreviewStyles.image} contentFit="cover" cachePolicy="memory-disk" />}
      <View style={linkPreviewStyles.textContainer}>
        <Text style={[linkPreviewStyles.domain, { color: colors.textTertiary }]}>{preview.domain}</Text>
        {preview.title ? <Text style={[linkPreviewStyles.title, { color: colors.text }]} numberOfLines={2}>{preview.title}</Text> : null}
        {preview.description ? <Text style={[linkPreviewStyles.desc, { color: colors.textSecondary }]} numberOfLines={2}>{preview.description}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}
const linkPreviewStyles = StyleSheet.create({
  container: {
    borderWidth: 0, borderRadius: 8, overflow: 'hidden', marginTop: 6, maxWidth: 280,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4 },
      android: { elevation: 2 },
      web: { boxShadow: '0 1px 6px rgba(0,0,0,0.08)' },
    }),
  },
  image: { width: '100%', height: 140 },
  textContainer: { padding: 12 },
  domain: { fontSize: 10, textTransform: 'uppercase', marginBottom: 4, letterSpacing: 0.5, fontWeight: '600' },
  title: { fontSize: 14, fontWeight: '600', marginBottom: 4, lineHeight: 19 },
  desc: { fontSize: 12, lineHeight: 17 },
});

// ============================================================
// REACTION DETAIL MODAL
// ============================================================
function ReactionDetailModal({ visible, onClose, emoji, reactors, colors }) {
  if (!visible) return null;
  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' }} onPress={onClose}>
        <Pressable style={{ backgroundColor: colors.background, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: '50%', paddingBottom: 34 }}>
          <View style={{ alignItems: 'center', padding: 16, borderBottomWidth: 1, borderBottomColor: colors.border }}>
            <Text style={{ fontSize: 32 }}>{emoji}</Text>
            <Text style={{ color: colors.textSecondary, marginTop: 4, fontSize: 14 }}>{reactors.length}</Text>
          </View>
          <ScrollView>
            {reactors.map((r, i) => (
              <View key={i} style={{ flexDirection: 'row', alignItems: 'center', padding: 12, gap: 12 }}>
                <AvatarCircle name={r.name || r.email} email={r.email} size={36} />
                <Text style={{ color: colors.text, fontSize: 15 }}>{r.name || r.email}</Text>
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

// ============================================================
// SWIPE TO REPLY WRAPPER
// ============================================================
let _NativeSwipeable = null;
if (Platform.OS !== 'web') {
  try { const mod = 'react-native' + '-gesture-handler'; _NativeSwipeable = require(mod).Swipeable; } catch {}
}

function SwipeReplyWrap({ children, onReply, onInfo, disabled, colors, style }) {
  const isNative = Platform.OS !== 'web';
  const swipeRef = useRef(null);

  // Native: use Swipeable for smooth 60fps swipe
  if (_NativeSwipeable && isNative && !disabled) {
    const renderLeft = useCallback((progress, dragX) => {
      const scale = dragX.interpolate({ inputRange: [0, 40], outputRange: [0.3, 1], extrapolate: 'clamp' });
      return (
        <Animated.View style={{ width: 40, justifyContent: 'center', alignItems: 'center' }}>
          <Animated.View style={{ transform: [{ scale }] }}><IconReply size={18} color={colors.primary} /></Animated.View>
        </Animated.View>
      );
    }, [colors.primary]);

    const renderRight = useCallback((progress, dragX) => {
      if (!onInfo) return null;
      const scale = dragX.interpolate({ inputRange: [-40, 0], outputRange: [1, 0.3], extrapolate: 'clamp' });
      return (
        <Animated.View style={{ width: 40, justifyContent: 'center', alignItems: 'center' }}>
          <Animated.View style={{ transform: [{ scale }] }}><IconInfo size={18} color={colors.textTertiary || '#999'} /></Animated.View>
        </Animated.View>
      );
    }, [onInfo, colors.textTertiary]);

    return (
      <_NativeSwipeable ref={swipeRef} friction={2} leftThreshold={30} rightThreshold={30} overshootLeft={false} overshootRight={false}
        renderLeftActions={onReply ? renderLeft : undefined}
        renderRightActions={onInfo ? renderRight : undefined}
        onSwipeableOpen={(d) => {
          if (d === 'left' && onReply) {
            try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
            onReply();
          }
          if (d === 'right' && onInfo) {
            try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
            onInfo();
          }
          setTimeout(() => swipeRef.current?.close(), 200);
        }}>
        <View style={style}>{children}</View>
      </_NativeSwipeable>
    );
  }

  // Web: PanResponder fallback
  const swipeX = useRef(new Animated.Value(0)).current;
  const propsRef = useRef({ onReply, onInfo, disabled });
  propsRef.current = { onReply, onInfo, disabled };

  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => {
        if (propsRef.current.disabled) return false;
        return g.dx > 8 && g.dx > Math.abs(g.dy) * 1.5;
      },
      onMoveShouldSetPanResponderCapture: () => false,
      onStartShouldSetPanResponder: () => false,
      onPanResponderGrant: () => { swipeX.stopAnimation(); swipeX.setValue(0); },
      onPanResponderMove: (_, g) => {
        const val = Math.min(65, Math.max(0, g.dx));
        swipeX.setValue(val);
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx > 30) propsRef.current.onReply?.();
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: false, stiffness: 250, damping: 20, mass: 0.7 }).start();
      },
    })
  ).current;

  const replyOpacity = swipeX.interpolate({ inputRange: [0, 30], outputRange: [0, 1], extrapolate: 'clamp' });
  const replyScale = swipeX.interpolate({ inputRange: [0, 30], outputRange: [0.2, 1], extrapolate: 'clamp' });

  return (
    <Animated.View {...panResponder.panHandlers} style={[{ transform: [{ translateX: swipeX }] }, style]}>
      <Animated.View style={{ position: 'absolute', left: -24, top: '50%', marginTop: -10, opacity: replyOpacity, transform: [{ scale: replyScale }] }} pointerEvents="none">
        <IconReply size={18} color={colors.primary} />
      </Animated.View>
      {children}
    </Animated.View>
  );
}

function getInitials(name) {
  if (!name) return '?';
  const parts = name.trim().split(/[\s@]+/);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name[0].toUpperCase();
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatLastSeen(dateStr, t) {
  const _t = typeof t === 'function' ? t : (k) => '';
  if (!dateStr) return '';
  let d;
  if (typeof dateStr === 'number') {
    d = new Date(dateStr);
  } else {
    let s = String(dateStr);
    if (!s.includes('T')) s = s.replace(' ', 'T');
    if (!s.includes('Z') && !s.includes('+')) s += 'Z';
    d = new Date(s);
  }
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const diffMs = now - d;
  const diffMin = Math.floor(diffMs / 60000);

  if (diffMin < 1) return _t('chat.justNow') || 'agora';

  const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Same calendar day
  if (d.toDateString() === now.toDateString()) {
    return `${_t('time.today') || 'hoje'} ${_t('time.at') || 'as'} ${timeStr}`;
  }

  // Yesterday
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return `${_t('time.yesterday') || 'ontem'} ${_t('time.at') || 'as'} ${timeStr}`;
  }

  // Older - show date
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${_t('time.at') || 'as'} ${timeStr}`;
}

const QUICK_REACTIONS = [
  { key: 'thumbsup', emoji: '👍' },
  { key: 'heart', emoji: '❤️' },
  { key: 'laugh', emoji: '😂' },
  { key: 'surprise', emoji: '😮' },
  { key: 'sad', emoji: '😢' },
  { key: 'fire', emoji: '🔥' },
  { key: 'pray', emoji: '🙏' },
  { key: 'clap', emoji: '👏' },
];

const REACTION_ICON_MAP = {
  thumbsup: IconThumbsUp, heart: IconHeart, laugh: IconLaughFace,
  surprise: IconSurpriseFace, sad: IconSadFace, pray: IconPrayHands,
};
const REACTION_EMOJI_MAP = { thumbsup: '👍', heart: '❤️', laugh: '😂', surprise: '😮', sad: '😢', fire: '🔥', pray: '🙏', clap: '👏' };

// ============================================================
// MEMOIZED MESSAGE ROW — prevents re-rendering every message on
// unrelated state changes (typing, emoji picker, input focus, etc.)
// The renderRef is a ref to the latest closure so memo never
// invalidates due to the render function itself changing.
// ============================================================

const MemoizedMessageRow = React.memo(function MemoizedMessageRow({ item, renderRef }) {
  return renderRef.current(item);
}, (prev, next) => {
  const a = prev.item;
  const b = next.item;
  // Date separators — compare by date string
  if (a._type === 'separator' || b._type === 'separator') {
    return a._type === b._type && a.date === b.date;
  }
  // Message comparison — only re-render when message data actually changed
  return (
    a.id === b.id &&
    a.content === b.content &&
    a.edited_at === b.edited_at &&
    a.deleted_at === b.deleted_at &&
    a.type === b.type &&
    a.starred === b.starred &&
    a._pending === b._pending &&
    a._failed === b._failed &&
    a._uploading === b._uploading &&
    a._isLastInGroup === b._isLastInGroup &&
    a._e2e === b._e2e &&
    a.view_once_opened === b.view_once_opened &&
    a.view_once_viewed_count === b.view_once_viewed_count &&
    a.is_view_once === b.is_view_once &&
    a._isHighlighted === b._isHighlighted &&
    a._heartPop === b._heartPop &&
    a._uploadPct === b._uploadPct &&
    a._readStatus === b._readStatus &&
    JSON.stringify(a.reactions) === JSON.stringify(b.reactions) &&
    JSON.stringify(a.reply_to) === JSON.stringify(b.reply_to)
  );
});

// ============================================================
// AUDIO WAVEFORM COMPONENT (WhatsApp-style)
// ============================================================

// Generate deterministic waveform bars from URL hash
function generateWaveformBars(url, count = 40) {
  let hash = 0;
  const str = url || 'audio';
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash) + str.charCodeAt(i);
    hash |= 0;
  }
  const bars = [];
  for (let i = 0; i < count; i++) {
    // Generate pseudo-random but deterministic heights
    const seed = Math.abs((hash * (i + 1) * 2654435761) | 0);
    const normalized = (seed % 1000) / 1000;
    // Shape: bell curve-ish (louder in middle)
    const position = i / count;
    const envelope = Math.sin(position * Math.PI) * 0.5 + 0.5;
    bars.push(0.15 + normalized * 0.85 * envelope);
  }
  return bars;
}

function AudioPlayer({ url, duration, isOwn, colors }) {
  const isDarkMode = colors.background === '#0B141A' || colors.background === '#000' || colors.background === '#000000' || (colors.background && colors.background.startsWith('#0'));
  const ownMetaColor = isDarkMode ? 'rgba(233,237,239,0.6)' : 'rgba(17,27,33,0.45)';
  const ownTextColor = isDarkMode ? '#E9EDEF' : '#111B21';
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const soundRef = useRef(null);
  const intervalRef = useRef(null);
  const waveformBars = useMemo(() => generateWaveformBars(url), [url]);

  const cycleSpeed = useCallback(() => {
    const next = speed === 1 ? 1.5 : speed === 1.5 ? 2 : 1;
    setSpeed(next);
    if (soundRef.current) {
      if (Platform.OS === 'web') {
        soundRef.current.playbackRate = next;
      } else {
        try { soundRef.current.rate = next; } catch {}
      }
    }
  }, [speed]);

  const stopPlayback = useCallback(() => {
    if (Platform.OS === 'web') {
      try { soundRef.current?.pause(); } catch {}
    } else {
      try { soundRef.current?.pause?.(); } catch {}
    }
    setPlaying(false);
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, []);

  useEffect(() => {
    const unregister = registerAudioPlayer(stopPlayback);
    // Preload audio on web so playback starts instantly
    if (Platform.OS === 'web' && url) {
      try {
        const audio = new window.Audio();
        audio.preload = 'auto';
        audio.src = url;
        audio.onended = () => { setPlaying(false); setProgress(0); setCurrentTime(0); if (intervalRef.current) clearInterval(intervalRef.current); };
        soundRef.current = audio;
      } catch {}
    }
    return () => {
      unregister();
      if (Platform.OS === 'web') {
        try { soundRef.current?.pause(); } catch {}
      } else {
        soundRef.current?.unloadAsync?.().catch(() => {});
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [stopPlayback, url]);

  const togglePlay = async () => {
    try {
      if (Platform.OS === 'web') {
        // Web: use preloaded HTML5 Audio
        if (playing && soundRef.current) {
          soundRef.current.pause();
          setPlaying(false);
          if (intervalRef.current) clearInterval(intervalRef.current);
          return;
        }
        if (!soundRef.current) {
          const audio = new window.Audio(url);
          audio.preload = 'auto';
          audio.onended = () => { setPlaying(false); setProgress(0); setCurrentTime(0); if (intervalRef.current) clearInterval(intervalRef.current); };
          soundRef.current = audio;
        }
        // Resume from current position instead of restarting (only reset if finished)
        if (soundRef.current.ended || soundRef.current.currentTime >= (soundRef.current.duration || Infinity)) {
          soundRef.current.currentTime = 0;
        }
        soundRef.current.playbackRate = speed;
        await soundRef.current.play();
        setPlaying(true);
        intervalRef.current = setInterval(() => {
          const a = soundRef.current;
          if (a && a.duration > 0) {
            setProgress(a.currentTime / a.duration);
            setCurrentTime(a.currentTime);
          }
        }, 50);
        return;
      }
      // Native: use expo-audio
      const { createAudioPlayer, setAudioModeAsync } = require('expo-audio');
      if (playing && soundRef.current) {
        soundRef.current.pause();
        setPlaying(false);
        if (intervalRef.current) clearInterval(intervalRef.current);
        return;
      }
      if (!soundRef.current) {
        await setAudioModeAsync({ playsInSilentMode: true });
        const player = createAudioPlayer({ uri: url });
        player.addListener('playbackStatusUpdate', (status) => {
          if (status.playing && status.duration > 0) {
            setProgress(status.currentTime / status.duration);
            setCurrentTime(status.currentTime);
          }
          if (!status.playing && status.currentTime >= status.duration && status.duration > 0) {
            setPlaying(false); setProgress(0); setCurrentTime(0); if (intervalRef.current) clearInterval(intervalRef.current);
          }
        });
        player.play();
        soundRef.current = player;
        setPlaying(true);
      } else {
        // Resume from current position; only reset if playback finished
        soundRef.current.play();
        setPlaying(true);
      }
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  };

  const tintColor = isOwn ? 'rgba(255,255,255,0.9)' : colors.primary;
  const tintDim = isOwn ? 'rgba(255,255,255,0.3)' : (colors.border || '#ddd');
  const playedBarIdx = Math.floor(progress * waveformBars.length);
  const displayTime = playing ? currentTime : (duration || 0);

  return (
    <View style={audioStyles.container}>
      <TouchableOpacity onPress={togglePlay} style={[audioStyles.playBtn, { backgroundColor: isOwn ? 'rgba(255,255,255,0.15)' : colors.primary + '18' }]} accessibilityLabel={playing ? 'Pause' : 'Play'} accessibilityRole="button">
        {playing ? (
          <IconPause size={20} color={tintColor} />
        ) : (
          <IconPlay size={20} color={tintColor} />
        )}
      </TouchableOpacity>
      <View style={audioStyles.trackWrap}>
        <View style={audioStyles.waveformRow}>
          {waveformBars.map((height, i) => (
            <View
              key={i}
              style={{
                width: 3,
                height: Math.max(4, height * 30),
                borderRadius: 2,
                backgroundColor: i < playedBarIdx ? tintColor : tintDim,
                ...(Platform.OS === 'web' ? { transition: 'background-color 0.15s ease' } : {}),
              }}
            />
          ))}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[audioStyles.duration, { color: isOwn ? ownMetaColor : colors.textTertiary }]}>
            {formatDuration(displayTime)}
          </Text>
          <TouchableOpacity onPress={cycleSpeed} style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 8, backgroundColor: isOwn ? 'rgba(255,255,255,0.15)' : colors.primary + '18' }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: isOwn ? 'rgba(255,255,255,0.8)' : colors.primary }}>{speed}x</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

const audioStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', minWidth: 240, paddingVertical: 6 },
  playBtn: {
    width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.1, shadowRadius: 4 },
      android: { elevation: 2 },
      web: { boxShadow: '0 1px 6px rgba(0,0,0,0.1)' },
    }),
  },
  trackWrap: { flex: 1, marginLeft: 12 },
  waveformRow: { flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 36 },
  duration: { fontSize: 10.5, marginTop: 5, fontWeight: '600', letterSpacing: 0.3 },
});

// ============================================================
// LOCATION MESSAGE COMPONENT (Embedded map, WhatsApp-style)
// ============================================================

function MapModal({ visible, onClose, lat, lng, label, isLive, liveUntil }) {
  if (!visible || !lat || !lng) return null;
  const isStillLive = isLive && liveUntil && (Date.now() / 1000) < liveUntil;

  const mapHtml = `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<style>*{margin:0;padding:0}html,body,#map{width:100%;height:100%}</style>
<script src="https://maps.googleapis.com/maps/api/js?key=AIzaSyAcrlg5RjgsSTvYB7I4V4-USUVPbFWDFYk"></script>
</head><body><div id="map"></div><script>
var map=new google.maps.Map(document.getElementById('map'),{center:{lat:${lat},lng:${lng}},zoom:16,disableDefaultUI:false,zoomControl:true,mapTypeControl:false,streetViewControl:false,fullscreenControl:false});
${isStillLive ? `
var dot=new google.maps.Marker({position:{lat:${lat},lng:${lng}},map:map,icon:{path:google.maps.SymbolPath.CIRCLE,scale:10,fillColor:'#3b82f6',fillOpacity:1,strokeColor:'#fff',strokeWeight:3}});
var pulse=new google.maps.Marker({position:{lat:${lat},lng:${lng}},map:map,icon:{path:google.maps.SymbolPath.CIRCLE,scale:20,fillColor:'#3b82f6',fillOpacity:0.3,strokeColor:'#3b82f6',strokeWeight:1}});
var pSize=20,growing=true;
setInterval(function(){pSize+=growing?1:-1;if(pSize>=30)growing=false;if(pSize<=15)growing=true;pulse.setIcon({path:google.maps.SymbolPath.CIRCLE,scale:pSize,fillColor:'#3b82f6',fillOpacity:0.2,strokeColor:'#3b82f6',strokeWeight:1});},50);
window.updatePos=function(la,ln){var p={lat:la,lng:ln};dot.setPosition(p);pulse.setPosition(p);map.panTo(p);};
` : `
new google.maps.Marker({position:{lat:${lat},lng:${lng}},map:map});
`}
</script></body></html>`;

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', paddingTop: Platform.OS === 'ios' ? 50 : 10, paddingHorizontal: 12, paddingBottom: 10, backgroundColor: '#075e54' }}>
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }} accessibilityLabel="Close map" accessibilityRole="button">
            <IconArrowLeft size={22} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1, marginLeft: 8 }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }} numberOfLines={1}>
              {label || 'Localização'}
            </Text>
            {isStillLive && (
              <Text style={{ color: '#25d366', fontSize: 12 }}>Localização ao vivo</Text>
            )}
          </View>
          <TouchableOpacity
            onPress={() => {
              const url = `https://maps.google.com/maps?q=${lat},${lng}&z=16`;
              Linking.openURL(url).catch(() => {});
            }}
            style={{ padding: 8 }}
            accessibilityLabel="Open in Maps"
            accessibilityRole="button"
          >
            <IconNavigation size={20} color="#fff" />
          </TouchableOpacity>
        </View>
        {Platform.OS === 'web' ? (
          <iframe
            src={`https://www.google.com/maps/embed/v1/place?key=AIzaSyAcrlg5RjgsSTvYB7I4V4-USUVPbFWDFYk&q=${lat},${lng}&zoom=16`}
            style={{ flex: 1, width: '100%', height: '100%', border: 'none' }}
            allowFullScreen
          />
        ) : (
          <WebView
            source={{ html: mapHtml }}
            style={{ flex: 1 }}
            javaScriptEnabled
            originWhitelist={['*']}
          />
        )}
      </View>
    </Modal>
  );
}

function LocationMessage({ content, isOwn, colors, onOpenMap }) {
  const isDarkMode = colors.background === '#0B141A' || (colors.background && colors.background < '#333');
  const ownMetaColor = isDarkMode ? 'rgba(233,237,239,0.6)' : 'rgba(17,27,33,0.45)';
  const ownTextColor = isDarkMode ? '#E9EDEF' : '#111B21';
  let lat, lng, label, isLive = false, liveUntil = 0, updatedAt = '';
  try {
    const data = JSON.parse(content);
    lat = data.latitude;
    lng = data.longitude;
    label = data.label || data.address || '';
    isLive = data.live === true;
    liveUntil = data.live_until || 0;
    updatedAt = data.updated_at || '';
  } catch {
    label = content;
  }

  const isStillLive = isLive && liveUntil && (Date.now() / 1000) < liveUntil;

  // For the bubble preview: use static image for regular, embedded map for live
  const staticMapUrl = lat && lng
    ? `https://maps.googleapis.com/maps/api/staticmap?center=${lat},${lng}&zoom=15&size=440x240&markers=color:red%7C${lat},${lng}&key=AIzaSyAcrlg5RjgsSTvYB7I4V4-USUVPbFWDFYk`
    : null;

  // Live location: embedded mini-map with pulsing dot
  const liveMapHtml = lat && lng ? `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<style>*{margin:0;padding:0;pointer-events:none}html,body,#map{width:100%;height:100%}</style>
<script src="https://maps.googleapis.com/maps/api/js?key=AIzaSyAcrlg5RjgsSTvYB7I4V4-USUVPbFWDFYk"></script>
</head><body><div id="map"></div><script>
var map=new google.maps.Map(document.getElementById('map'),{center:{lat:${lat},lng:${lng}},zoom:15,disableDefaultUI:true,gestureHandling:'none'});
var dot=new google.maps.Marker({position:{lat:${lat},lng:${lng}},map:map,icon:{path:google.maps.SymbolPath.CIRCLE,scale:8,fillColor:'#3b82f6',fillOpacity:1,strokeColor:'#fff',strokeWeight:2}});
var pulse=new google.maps.Marker({position:{lat:${lat},lng:${lng}},map:map,icon:{path:google.maps.SymbolPath.CIRCLE,scale:16,fillColor:'#3b82f6',fillOpacity:0.3,strokeColor:'#3b82f6',strokeWeight:1}});
var s=16,g=true;setInterval(function(){s+=g?0.5:-0.5;if(s>=24)g=false;if(s<=12)g=true;pulse.setIcon({path:google.maps.SymbolPath.CIRCLE,scale:s,fillColor:'#3b82f6',fillOpacity:0.2,strokeColor:'#3b82f6',strokeWeight:1});},50);
window.updatePos=function(la,ln){var p={lat:la,lng:ln};dot.setPosition(p);pulse.setPosition(p);map.panTo(p);};
</script></body></html>` : '';

  const handlePress = () => {
    if (lat && lng && onOpenMap) {
      onOpenMap({ lat, lng, label, isLive, liveUntil });
    }
  };

  return (
    <TouchableOpacity onPress={handlePress} activeOpacity={0.8} style={locStyles.container}>
      {lat && lng && (
        <View style={locStyles.mapImage}>
          {isStillLive && Platform.OS !== 'web' ? (
            <WebView
              source={{ html: liveMapHtml }}
              style={{ width: 220, height: 120 }}
              scrollEnabled={false}
              javaScriptEnabled
              originWhitelist={['*']}
              pointerEvents="none"
            />
          ) : isStillLive && Platform.OS === 'web' ? (
            <View style={{ width: 220, height: 120, position: 'relative' }}>
              <iframe
                srcDoc={liveMapHtml}
                style={{ width: 220, height: 120, border: 'none', pointerEvents: 'none' }}
              />
            </View>
          ) : (
            staticMapUrl && (
              <Image
                source={{ uri: staticMapUrl }}
                style={{ width: 220, height: 120 }}
                resizeMode="cover"
              />
            )
          )}
          {!isStillLive && (
            <View style={locStyles.pinOverlay}>
              <IconNavigation size={16} color="#fff" />
            </View>
          )}
          {isStillLive && (
            <View style={locStyles.liveBadge}>
              <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#ef4444', marginRight: 4 }} />
              <Text style={{ color: '#fff', fontSize: 10, fontWeight: '700' }}>AO VIVO</Text>
            </View>
          )}
        </View>
      )}
      <View style={locStyles.labelRow}>
        <IconMapPin size={14} color={isOwn ? 'rgba(255,255,255,0.8)' : colors.primary} />
        <Text style={[locStyles.label, { color: isOwn ? ownTextColor : colors.text }]} numberOfLines={2}>
          {label || 'Localização'}
        </Text>
      </View>
      {isStillLive && updatedAt && (
        <Text style={{ fontSize: 10, color: isOwn ? ownMetaColor : colors.textTertiary, paddingHorizontal: 4, paddingBottom: 2 }}>
          Atualizado {formatLastSeen(updatedAt)}
        </Text>
      )}
    </TouchableOpacity>
  );
}

// ============================================================
// CALL MESSAGE COMPONENT (WhatsApp-style)
// ============================================================

function CallMessage({ content, isOwn, colors, currentEmail }) {
  let callData;
  try { callData = JSON.parse(content); } catch { return null; }
  if (!callData?.call_type) return null;

  const isVideo = callData.call_type === 'video';
  const isCaller = callData.caller_email === currentEmail;
  const isIncoming = !isCaller;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}>
      <View style={{
        width: 32, height: 32, borderRadius: 16,
        backgroundColor: isIncoming ? '#10b98120' : '#3b82f620',
        alignItems: 'center', justifyContent: 'center',
      }}>
        {isVideo
          ? <IconVideo size={16} color={isIncoming ? '#10b981' : '#3b82f6'} />
          : <IconPhone size={16} color={isIncoming ? '#10b981' : '#3b82f6'} />
        }
      </View>
      <View>
        <Text style={{ fontSize: 13, fontWeight: '600', color: isOwn ? ownTextColor : colors.text }}>
          {isVideo
            ? (isIncoming ? 'Videochamada recebida' : 'Videochamada')
            : (isIncoming ? 'Chamada recebida' : 'Chamada de voz')
          }
        </Text>
        {callData.started_at && (
          <Text style={{ fontSize: 11, color: isOwn ? ownMetaColor : colors.textTertiary }}>
            {new Date(callData.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        )}
      </View>
    </View>
  );
}

const locStyles = StyleSheet.create({
  container: { borderRadius: BorderRadius.md, overflow: 'hidden' },
  mapImage: { width: 220, height: 120, borderTopLeftRadius: BorderRadius.md, borderTopRightRadius: BorderRadius.md, overflow: 'hidden', position: 'relative', backgroundColor: '#e8f5e9' },
  pinOverlay: {
    position: 'absolute', bottom: 8, right: 8,
    width: 32, height: 32, borderRadius: 16,
    backgroundColor: '#10b981', alignItems: 'center', justifyContent: 'center',
  },
  liveBadge: {
    position: 'absolute', top: 8, left: 8,
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.6)', borderRadius: 10,
    paddingHorizontal: 8, paddingVertical: 3,
    zIndex: 2,
  },
  liveDot: {
    position: 'absolute', top: '50%', left: '50%',
    marginTop: -12, marginLeft: -12,
    width: 24, height: 24, alignItems: 'center', justifyContent: 'center',
    zIndex: 2,
  },
  liveDotCenter: {
    width: 12, height: 12, borderRadius: 6,
    backgroundColor: '#3b82f6', borderWidth: 2, borderColor: '#fff',
  },
  liveDotPulse: {
    position: 'absolute', width: 24, height: 24, borderRadius: 12,
    backgroundColor: 'rgba(59,130,246,0.3)',
  },
  labelRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, paddingHorizontal: 4 },
  label: { fontSize: FontSize.sm, flex: 1 },
});

// ============================================================
// CONTACT MESSAGE COMPONENT
// ============================================================

function ContactMessage({ content, isOwn, colors, t }) {
  const isDarkMode = colors.background === '#0B141A' || (colors.background && colors.background < '#333');
  const ownMetaColor = isDarkMode ? 'rgba(233,237,239,0.6)' : 'rgba(17,27,33,0.45)';
  const ownTextColor = isDarkMode ? '#E9EDEF' : '#111B21';
  let contactData;
  try {
    contactData = JSON.parse(content);
  } catch {
    contactData = { name: content };
  }

  return (
    <View style={contactStyles.container}>
      <View style={[contactStyles.avatar, { backgroundColor: isOwn ? 'rgba(255,255,255,0.2)' : colors.primary + '20' }]}>
        <IconUser size={20} color={isOwn ? '#fff' : colors.primary} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[contactStyles.name, { color: isOwn ? ownTextColor : colors.text }]}>{contactData.name || t('chatConv.contact')}</Text>
        {contactData.phone && (
          <TouchableOpacity onPress={() => Linking.openURL(`tel:${contactData.phone}`)}>
            <Text style={[contactStyles.phone, { color: isOwn ? 'rgba(255,255,255,0.7)' : colors.primary }]}>
              {contactData.phone}
            </Text>
          </TouchableOpacity>
        )}
        {contactData.email && (
          <Text style={[contactStyles.phone, { color: isOwn ? 'rgba(255,255,255,0.6)' : colors.textSecondary }]}>
            {contactData.email}
          </Text>
        )}
      </View>
    </View>
  );
}

const contactStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4, minWidth: 180 },
  avatar: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  name: { fontSize: FontSize.md, fontWeight: '600' },
  phone: { fontSize: FontSize.sm, marginTop: 1 },
});

// ============================================================
// ATTACHMENT MENU (+ Button)
// ============================================================

function AttachmentMenu({ visible, onClose, onPick, colors }) {
  const { t } = useLanguage();
  if (!visible) return null;
  const items = [
    { key: 'camera', icon: IconCamera, label: t('chatConv.camera') || 'Camera', color: '#ef4444' },
    { key: 'gallery', icon: IconImage, label: t('chatConv.gallery') || 'Gallery', color: '#8b5cf6' },
    { key: 'file', icon: IconFileText, label: t('chatConv.file') || 'File', color: '#3b82f6' },
    { key: 'audio', icon: IconMic, label: t('chatConv.audio') || 'Audio', color: '#f97316' },
    { key: 'location', icon: IconMapPin, label: t('chatConv.location') || 'Localização', color: '#10b981' },
    { key: 'liveLocation', icon: IconNavigation, label: t('chatConv.liveLocation') || 'Loc. ao vivo', color: '#059669' },
    { key: 'contact', icon: IconUser, label: t('chatConv.contact') || 'Contact', color: '#06b6d4' },
    { key: 'poll', icon: IconBarChart, label: t('chat.poll') || 'Enquete', color: '#f59e0b' },
    { key: 'meetup', icon: IconMapPin, label: t('chatConv.meetup') || 'Encontro', color: '#ec4899' },
    { key: 'playlist', icon: IconPlay, label: t('chatConv.playlist') || 'Playlist', color: '#a855f7' },
  ];

  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={attachStyles.overlay} onPress={onClose}>
        <Pressable style={[attachStyles.sheet, { backgroundColor: colors.surface }]} onPress={e => e.stopPropagation()}>
          <View style={[attachStyles.handle, { backgroundColor: colors.border }]} />
          <View style={attachStyles.grid}>
            {items.map(item => (
              <TouchableOpacity
                key={item.key}
                style={attachStyles.item}
                onPress={() => { onClose(); onPick(item.key); }}
              >
                <View style={[attachStyles.iconCircle, { backgroundColor: item.color }]}>
                  <item.icon size={24} color="#fff" />
                </View>
                <Text style={[attachStyles.label, { color: colors.textSecondary }]}>{item.label}</Text>
              </TouchableOpacity>
            ))}
          </View>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const attachStyles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.35)' },
  sheet: { borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingHorizontal: Spacing.lg, paddingBottom: 40, paddingTop: Spacing.sm },
  handle: { width: 36, height: 4, borderRadius: 2, alignSelf: 'center', marginBottom: Spacing.lg },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-around' },
  item: { alignItems: 'center', width: '30%', marginBottom: Spacing.xl || 24 },
  iconCircle: { width: 56, height: 56, borderRadius: 28, alignItems: 'center', justifyContent: 'center', marginBottom: 8 },
  label: { fontSize: FontSize.xs, fontWeight: '500' },
  viewOnceRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10, paddingHorizontal: 12, borderWidth: 1, borderRadius: 12, marginBottom: 16 },
  viewOnceLabel: { flex: 1, fontSize: 14, fontWeight: '600' },
  viewOnceDot: { width: 22, height: 22, borderRadius: 11, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
});

// ============================================================
// POLL CREATOR MODAL
// ============================================================
function PollCreatorModal({ colors, t, conversationId, onClose, onCreated }) {
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multipleChoice, setMultipleChoice] = useState(false);
  const [sending, setSending] = useState(false);

  const addOption = () => { if (options.length < 12) setOptions([...options, '']); };
  const updateOption = (idx, val) => { const o = [...options]; o[idx] = val; setOptions(o); };
  const removeOption = (idx) => { if (options.length > 2) setOptions(options.filter((_, i) => i !== idx)); };

  const handleCreate = async () => {
    const q = question.trim();
    const opts = options.map(o => o.trim()).filter(o => o !== '');
    if (!q) return;
    if (opts.length < 2) return;
    setSending(true);
    try {
      const r = await api.chatCreatePoll(conversationId, q, opts, multipleChoice);
      if (r.success && r.data?.message) { onCreated(r.data.message); }
      else { onClose(); }
    } catch { onClose(); }
    setSending(false);
  };

  return (
    <Pressable style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.4)' }} onPress={onClose}>
      <Pressable style={{ backgroundColor: colors.surface, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, maxHeight: '80%' }} onPress={e => e.stopPropagation()}>
        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 16 }}>
          <IconBarChart size={20} color={colors.primary} style={{ marginRight: 8 }} />
          <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, flex: 1 }}>{t('chat.pollCreate') || 'Criar enquete'}</Text>
          <TouchableOpacity onPress={onClose}><IconX size={22} color={colors.textSecondary} /></TouchableOpacity>
        </View>
        <ScrollView style={{ maxHeight: 400 }} showsVerticalScrollIndicator={false}>
          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 4 }}>{t('chat.pollQuestion') || 'Pergunta'}</Text>
          <TextInput value={question} onChangeText={setQuestion} placeholder={t('chat.pollQuestion') || 'Pergunta'}
            placeholderTextColor={colors.textTertiary} multiline
            style={{ backgroundColor: colors.border + '30', borderRadius: 10, padding: 12, fontSize: 15, color: colors.text, marginBottom: 16, minHeight: 44 }} />
          <Text style={{ fontSize: 13, fontWeight: '600', color: colors.textSecondary, marginBottom: 8 }}>{t('chat.pollOption') || 'Opções'}</Text>
          {options.map((opt, idx) => (
            <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
              <TextInput value={opt} onChangeText={v => updateOption(idx, v)}
                placeholder={`${t('chat.pollOption') || 'Opção'} ${idx + 1}`}
                placeholderTextColor={colors.textTertiary}
                style={{ flex: 1, backgroundColor: colors.border + '30', borderRadius: 10, padding: 10, fontSize: 14, color: colors.text }} />
              {options.length > 2 && (
                <TouchableOpacity onPress={() => removeOption(idx)} style={{ marginLeft: 8, padding: 4 }}>
                  <IconX size={18} color={colors.textTertiary} />
                </TouchableOpacity>
              )}
            </View>
          ))}
          {options.length < 12 && (
            <TouchableOpacity onPress={addOption} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8 }}>
              <IconPlus size={18} color={colors.primary} style={{ marginRight: 6 }} />
              <Text style={{ color: colors.primary, fontSize: 14, fontWeight: '500' }}>{t('chat.pollAddOption') || 'Adicionar opção'}</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => setMultipleChoice(!multipleChoice)}
            style={{ flexDirection: 'row', alignItems: 'center', marginTop: 12, paddingVertical: 8 }}>
            <View style={{ width: 22, height: 22, borderRadius: 4, borderWidth: 2, borderColor: multipleChoice ? colors.primary : colors.border,
              backgroundColor: multipleChoice ? colors.primary : 'transparent', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
              {multipleChoice && <IconCheck size={14} color="#fff" />}
            </View>
            <Text style={{ color: colors.text, fontSize: 14 }}>{t('chat.pollMultiple') || 'Múltipla escolha'}</Text>
          </TouchableOpacity>
        </ScrollView>
        <TouchableOpacity onPress={handleCreate} disabled={sending || !question.trim() || options.filter(o => o.trim()).length < 2}
          style={{ backgroundColor: colors.primary, borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16,
            opacity: (sending || !question.trim() || options.filter(o => o.trim()).length < 2) ? 0.5 : 1 }}>
          {sending
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>{t('chat.pollCreate') || 'Criar enquete'}</Text>
          }
        </TouchableOpacity>
      </Pressable>
    </Pressable>
  );
}

// ============================================================
// MEETUP CREATOR MODAL
// ============================================================
function MeetupCreatorModal({ colors, t, conversationId, onClose, onCreated }) {
  const [title, setTitle] = useState('');
  const [location, setLocation] = useState('');
  const [dateText, setDateText] = useState('');
  const [description, setDescription] = useState('');
  const [sending, setSending] = useState(false);

  const handleCreate = async () => {
    if (!title.trim() || !dateText.trim()) return;
    setSending(true);
    try {
      const r = await api.chatCreateMeetup(conversationId, title.trim(), dateText.trim(), location.trim(), description.trim());
      if (r.success && r.data) {
        onCreated({
          id: r.data.id,
          sender_email: '', // will be filled by server
          content: r.data.content,
          type: 'meetup',
          created_at: new Date().toISOString(),
        });
      } else { onClose(); }
    } catch { onClose(); }
    setSending(false);
  };

  return (
    <Pressable style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
      <Pressable style={{ backgroundColor: colors.surface, borderRadius: 20, padding: 20, width: '90%', maxWidth: 400 }} onPress={e => e.stopPropagation()}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 16 }}>📍 {t('chatConv.createMeetup') || 'Marcar Encontro'}</Text>

        <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600', marginBottom: 4 }}>{t('chatConv.meetupTitle') || 'Título'} *</Text>
        <TextInput
          style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, fontSize: 15, color: colors.text, marginBottom: 12, backgroundColor: colors.background }}
          placeholder={t('chatConv.meetupTitlePlaceholder') || 'Ex: Churrasco na casa do João'}
          placeholderTextColor={colors.textTertiary}
          value={title}
          onChangeText={setTitle}
        />

        <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600', marginBottom: 4 }}>{t('chatConv.meetupWhen') || 'Quando'} *</Text>
        <TextInput
          style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, fontSize: 15, color: colors.text, marginBottom: 12, backgroundColor: colors.background }}
          placeholder={t('chatConv.meetupWhenPlaceholder') || 'Ex: Sábado 15h, 2026-03-15 15:00'}
          placeholderTextColor={colors.textTertiary}
          value={dateText}
          onChangeText={setDateText}
        />

        <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600', marginBottom: 4 }}>{t('chatConv.meetupWhere') || 'Onde'}</Text>
        <TextInput
          style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, fontSize: 15, color: colors.text, marginBottom: 12, backgroundColor: colors.background }}
          placeholder={t('chatConv.meetupWherePlaceholder') || 'Ex: Shopping da Bahia'}
          placeholderTextColor={colors.textTertiary}
          value={location}
          onChangeText={setLocation}
        />

        <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600', marginBottom: 4 }}>{t('chatConv.meetupDescription') || 'Descrição'}</Text>
        <TextInput
          style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, fontSize: 15, color: colors.text, marginBottom: 16, backgroundColor: colors.background, minHeight: 60 }}
          placeholder={t('chatConv.meetupDescPlaceholder') || 'Detalhes do encontro...'}
          placeholderTextColor={colors.textTertiary}
          value={description}
          onChangeText={setDescription}
          multiline
        />

        <TouchableOpacity
          onPress={handleCreate}
          disabled={sending || !title.trim() || !dateText.trim()}
          style={{ backgroundColor: (!title.trim() || !dateText.trim()) ? colors.border : '#ec4899', borderRadius: 12, paddingVertical: 14, alignItems: 'center' }}
        >
          {sending
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>{t('chatConv.createMeetupBtn') || 'Marcar Encontro 📍'}</Text>
          }
        </TouchableOpacity>
      </Pressable>
    </Pressable>
  );
}

// ============================================================
// PLAYLIST CREATOR MODAL
// ============================================================
function PlaylistCreatorModal({ colors, t, conversationId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSending(true);
    try {
      const r = await api.chatCreatePlaylist(conversationId, name.trim());
      if (r.success && r.data) {
        onCreated({
          id: r.data.id,
          sender_email: '',
          content: r.data.content,
          type: 'playlist',
          created_at: new Date().toISOString(),
        });
      } else { onClose(); }
    } catch { onClose(); }
    setSending(false);
  };

  return (
    <Pressable style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.5)' }} onPress={onClose}>
      <Pressable style={{ backgroundColor: colors.surface, borderRadius: 20, padding: 20, width: '90%', maxWidth: 400 }} onPress={e => e.stopPropagation()}>
        <Text style={{ fontSize: 18, fontWeight: '700', color: colors.text, marginBottom: 16 }}>🎵 {t('chatConv.createPlaylist') || 'Criar Playlist'}</Text>

        <Text style={{ fontSize: 12, color: colors.textSecondary, fontWeight: '600', marginBottom: 4 }}>{t('chatConv.playlistName') || 'Nome da playlist'}</Text>
        <TextInput
          style={{ borderWidth: 1, borderColor: colors.border, borderRadius: 10, padding: 10, fontSize: 15, color: colors.text, marginBottom: 16, backgroundColor: colors.background }}
          placeholder={t('chatConv.playlistNamePlaceholder') || 'Ex: Músicas do role'}
          placeholderTextColor={colors.textTertiary}
          value={name}
          onChangeText={setName}
          autoFocus
        />

        <TouchableOpacity
          onPress={handleCreate}
          disabled={sending || !name.trim()}
          style={{ backgroundColor: !name.trim() ? colors.border : '#a855f7', borderRadius: 12, paddingVertical: 14, alignItems: 'center' }}
        >
          {sending
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>{t('chatConv.createPlaylistBtn') || 'Criar Playlist 🎵'}</Text>
          }
        </TouchableOpacity>
      </Pressable>
    </Pressable>
  );
}

// ============================================================
// MEDIA PREVIEW (WhatsApp-like preview before sending with view-once toggle)
// ============================================================
function MediaPreview({ visible, onClose, onSend, mediaUri, mediaType, colors }) {
  const { t } = useLanguage();
  const [caption, setCaption] = useState('');
  const [viewOnce, setViewOnce] = useState(false);

  if (!visible || !mediaUri) return null;

  const isVideo = mediaType === 'video';

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={previewStyles.container}>
        {/* Header */}
        <View style={previewStyles.header}>
          <TouchableOpacity onPress={onClose} style={previewStyles.headerBtn}>
            <IconX size={24} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
        </View>

        {/* Media */}
        <View style={previewStyles.mediaContainer}>
          {isVideo ? (
            Platform.OS === 'web' ? (
              <video src={mediaUri} controls style={{ width: '100%', maxHeight: '100%', objectFit: 'contain' }} />
            ) : (
              <View style={previewStyles.videoPlaceholder}>
                <IconPlay size={48} color="#fff" />
                <Text style={{ color: '#fff', marginTop: 8 }}>Video</Text>
              </View>
            )
          ) : (
            <Image source={{ uri: mediaUri }} style={previewStyles.previewImage} resizeMode="contain" />
          )}
        </View>

        {/* Bottom bar: caption + view-once + send */}
        <View style={previewStyles.bottomBar}>
          <View style={previewStyles.captionRow}>
            <TextInput
              style={previewStyles.captionInput}
              placeholder={t('chatConv.addCaption') || 'Adicionar legenda...'}
              placeholderTextColor="rgba(255,255,255,0.5)"
              value={caption}
              onChangeText={setCaption}
              maxLength={300}
            />

            {/* View Once button — WhatsApp "1" icon */}
            <TouchableOpacity
              onPress={() => setViewOnce(v => !v)}
              style={[previewStyles.viewOnceBtn, viewOnce && previewStyles.viewOnceBtnActive]}
            >
              <Text style={[previewStyles.viewOnceBtnText, viewOnce && { color: '#fff' }]}>1</Text>
            </TouchableOpacity>
          </View>

          {viewOnce && (
            <Text style={previewStyles.viewOnceHint}>
              {t('chatConv.viewOnceHint') || 'Foto/vídeo só pode ser visto uma vez'}
            </Text>
          )}

          {/* Send button */}
          <TouchableOpacity
            style={previewStyles.sendBtn}
            onPress={() => onSend(caption, viewOnce)}
          >
            <IconSend size={22} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );
}

const previewStyles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingTop: Platform.OS === 'ios' ? 54 : 16, paddingBottom: 8,
  },
  headerBtn: { padding: 8 },
  mediaContainer: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  previewImage: { width: '100%', height: '100%' },
  videoPlaceholder: { alignItems: 'center', justifyContent: 'center' },
  bottomBar: { paddingHorizontal: 12, paddingBottom: Platform.OS === 'ios' ? 34 : 16, paddingTop: 8 },
  captionRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  captionInput: {
    flex: 1, color: '#fff', fontSize: 16, backgroundColor: 'rgba(255,255,255,0.12)',
    borderRadius: 24, paddingHorizontal: 16, paddingVertical: 10,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  viewOnceBtn: {
    width: 36, height: 36, borderRadius: 18, borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.5)', alignItems: 'center', justifyContent: 'center',
  },
  viewOnceBtnActive: { backgroundColor: '#25D366', borderColor: '#25D366' },
  viewOnceBtnText: { fontSize: 16, fontWeight: '800', color: 'rgba(255,255,255,0.5)' },
  viewOnceHint: { color: '#25D366', fontSize: 12, textAlign: 'center', marginTop: 6, fontWeight: '500' },
  sendBtn: {
    width: 52, height: 52, borderRadius: 26, backgroundColor: '#25D366',
    alignItems: 'center', justifyContent: 'center', alignSelf: 'flex-end', marginTop: 10,
  },
});

// ============================================================
// SAFE ALERT (works on web + native)
// ============================================================
function safeAlert(title, message, buttons) {
  if (Platform.OS === 'web') {
    if (buttons && buttons.length > 0) {
      // Find destructive/OK button and cancel button
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

// ============================================================
// AUDIO RECORDER
// ============================================================

function AudioRecorder({ onSend, onCancel, colors, t }) {
  const [recording, setRecording] = useState(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const [waveformLevels, setWaveformLevels] = useState([]);
  const intervalRef = useRef(null);
  const startTimeRef = useRef(0);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const mountedRef = useRef(true);
  const analyserRef = useRef(null);
  const audioCtxRef = useRef(null);
  const waveIntervalRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const pulseLoopRef = useRef(null);

  useEffect(() => {
    mountedRef.current = true;
    startRecording();
    // Start pulsing animation for the red dot
    pulseLoopRef.current = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.6, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])
    );
    pulseLoopRef.current.start();
    return () => {
      mountedRef.current = false;
      if (pulseLoopRef.current) pulseLoopRef.current.stop();
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (waveIntervalRef.current) clearInterval(waveIntervalRef.current);
      if (Platform.OS === 'web') {
        try {
          const mr = mediaRecorderRef.current;
          if (mr && mr.state !== 'inactive') mr.stop();
          if (mr?.stream) mr.stream.getTracks().forEach(t => t.stop());
        } catch {}
        try { audioCtxRef.current?.close(); } catch {}
      }
    };
  }, []);

  const startTimer = () => {
    startTimeRef.current = Date.now();
    intervalRef.current = setInterval(() => {
      if (mountedRef.current) setDuration(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 1000);
  };

  const startRecording = async () => {
    try {
      if (Platform.OS === 'web') {
        // Check browser support
        if (typeof navigator === 'undefined' || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          setError(t('chatConv.audioNotSupported'));
          return;
        }
        if (typeof MediaRecorder === 'undefined') {
          setError(t('chatConv.mediaRecorderUnavailable'));
          return;
        }
        let stream;
        try {
          stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (e) {
          if (e.name === 'NotAllowedError') {
            setError(t('chatConv.micPermissionDenied'));
          } else if (e.name === 'NotFoundError') {
            setError(t('chatConv.micNotFound'));
          } else {
            setError(t('chatConv.micAccessError'));
          }
          return;
        }
        if (!mountedRef.current) { stream.getTracks().forEach(t => t.stop()); return; }

        const mimeType = typeof MediaRecorder.isTypeSupported === 'function' && MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
          ? 'audio/webm;codecs=opus'
          : 'audio/webm';
        const mr = new MediaRecorder(stream, { mimeType });
        chunksRef.current = [];
        mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunksRef.current.push(e.data); };
        mr.onerror = () => { if (mountedRef.current) setError(t('chatConv.recordingError')); };
        mr.start(200);
        mediaRecorderRef.current = mr;
        // Set up live waveform via Web Audio API AnalyserNode
        try {
          const actx = new (window.AudioContext || window.webkitAudioContext)();
          const source = actx.createMediaStreamSource(stream);
          const analyser = actx.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          audioCtxRef.current = actx;
          analyserRef.current = analyser;
          const dataArray = new Uint8Array(analyser.frequencyBinCount);
          waveIntervalRef.current = setInterval(() => {
            if (!mountedRef.current) return;
            analyser.getByteFrequencyData(dataArray);
            // Sample 30 bars from frequency data
            const bars = [];
            const step = Math.floor(dataArray.length / 30);
            for (let i = 0; i < 30; i++) {
              bars.push(dataArray[i * step] / 255);
            }
            setWaveformLevels(prev => [...prev.slice(-60), ...bars.slice(0, 1)]);
          }, 80);
        } catch {}
        setRecording('web');
        startTimer();
        return;
      }

      // Native: use expo-audio
      let expoAudio;
      try {
        expoAudio = require('expo-audio');
      } catch {
        setError(t('chatConv.audioModuleUnavailable'));
        return;
      }
      const perm = await expoAudio.requestRecordingPermissionsAsync();
      if (!perm.granted) {
        setError(t('chatConv.micPermissionDenied'));
        return;
      }
      if (!mountedRef.current) return;
      await expoAudio.setAudioModeAsync({ allowsRecording: true, playsInSilentMode: true });
      const AudioMod = require('expo-audio/build/AudioModule').default;
      const { RecordingPresets } = require('expo-audio');
      const recorder = new AudioMod.AudioRecorder(RecordingPresets.HIGH_QUALITY);
      await recorder.prepareToRecordAsync();
      recorder.record();
      if (!mountedRef.current) { try { await recorder.stop(); } catch {} return; }
      setRecording(recorder);
      startTimer();
    } catch (e) {
      console.warn('Recording error:', e);
      if (mountedRef.current) setError(t('chatConv.recordingStartError'));
    }
  };

  const stopWebRecorder = () => {
    return new Promise((resolve) => {
      const mr = mediaRecorderRef.current;
      if (!mr || mr.state === 'inactive') { resolve(); return; }
      mr.onstop = resolve;
      mr.stop();
    });
  };

  const handleSend = async () => {
    if (!recording) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    try {
      if (Platform.OS === 'web') {
        await stopWebRecorder();
        const mr = mediaRecorderRef.current;
        if (mr?.stream) mr.stream.getTracks().forEach(t => t.stop());
        if (chunksRef.current.length === 0) { onCancel(); return; }
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const uri = URL.createObjectURL(blob);
        onSend({ uri, blob, name: `audio_${Date.now()}.webm`, type: 'audio/webm', duration });
      } else {
        await recording.stop();
        const uri = recording.uri;
        try { const { setAudioModeAsync } = require('expo-audio'); await setAudioModeAsync({ allowsRecording: false }); } catch {}
        if (uri) {
          onSend({ uri, name: `audio_${Date.now()}.m4a`, type: 'audio/mp4', duration });
        }
      }
    } catch (e) {
      console.warn('Stop recording error:', e);
      try { const { setAudioModeAsync } = require('expo-audio'); await setAudioModeAsync({ allowsRecording: false }); } catch {}
    }
    setRecording(null);
  };

  const handleCancel = async () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (Platform.OS === 'web') {
      try {
        await stopWebRecorder();
        const mr = mediaRecorderRef.current;
        if (mr?.stream) mr.stream.getTracks().forEach(t => t.stop());
      } catch {}
    } else if (recording && recording !== 'web') {
      try { await recording.stop(); } catch {}
      try { const { setAudioModeAsync } = require('expo-audio'); await setAudioModeAsync({ allowsRecording: false }); } catch {}
    }
    setRecording(null);
    onCancel();
  };

  // Show error state instead of crashing
  if (error) {
    return (
      <View style={[recStyles.container, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
        <View style={recStyles.errorInner}>
          <IconAlertTriangle size={18} color={colors.error || '#ef4444'} />
          <Text style={[recStyles.errorText, { color: colors.error || '#ef4444' }]}>{error}</Text>
        </View>
        <TouchableOpacity onPress={onCancel} style={recStyles.iconBtn} accessibilityLabel="Cancelar gravação">
          <IconX size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    );
  }

  const isDarkBg = colors.surface === '#1e1e1e' || colors.surface === '#121212' || colors.surface === '#000';
  const recBg = isDarkBg ? 'rgba(239,68,68,0.08)' : 'rgba(239,68,68,0.05)';
  const waveColor = '#25D366';
  const slideCancelColor = colors.textSecondary;

  return (
    <View style={[recStyles.container, { backgroundColor: recBg, borderTopColor: colors.border }]}>
      {/* Left: trash / cancel */}
      <TouchableOpacity onPress={handleCancel} style={recStyles.iconBtn} accessibilityLabel="Cancelar gravação">
        <View style={recStyles.trashWrap}>
          <IconTrash size={20} color={colors.error || '#ef4444'} />
        </View>
      </TouchableOpacity>

      {/* Center: dot + timer + waveform + slide hint */}
      <View style={recStyles.centerCol}>
        <View style={recStyles.topRow}>
          {/* Pulsing red dot */}
          <View style={recStyles.dotOuter}>
            <Animated.View style={[recStyles.dotRing, { transform: [{ scale: pulseAnim }] }]} />
            <View style={recStyles.dotCore} />
          </View>

          {/* Timer */}
          <Text style={[recStyles.timer, { color: colors.text }]}>{formatDuration(duration)}</Text>

          {/* Waveform */}
          <View style={recStyles.waveform}>
            {waveformLevels.length === 0
              ? Array.from({ length: 28 }).map((_, i) => (
                  <View key={i} style={[recStyles.waveBar, { height: 4, backgroundColor: waveColor, opacity: 0.3 }]} />
                ))
              : waveformLevels.slice(-28).map((level, i) => (
                  <View
                    key={i}
                    style={[
                      recStyles.waveBar,
                      {
                        height: Math.max(4, level * 34),
                        backgroundColor: waveColor,
                        opacity: 0.55 + level * 0.45,
                      },
                    ]}
                  />
                ))
            }
          </View>
        </View>

        {/* Slide to cancel hint */}
        <View style={recStyles.slideRow}>
          <Text style={[recStyles.slideArrow, { color: slideCancelColor }]}>{'‹‹'}</Text>
          <Text style={[recStyles.slideHint, { color: slideCancelColor }]}>Deslize para cancelar</Text>
        </View>
      </View>

      {/* Right: lock icon + send button */}
      <View style={recStyles.rightCol}>
        <View style={recStyles.lockWrap}>
          <IconLock size={16} color={colors.textSecondary} />
        </View>
        <TouchableOpacity onPress={handleSend} style={recStyles.sendBtn} accessibilityLabel="Enviar áudio">
          <IconSend size={18} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

const recStyles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: Spacing.sm,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    minHeight: 64,
  },
  // Error state
  errorInner: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4,
  },
  errorText: { fontSize: FontSize.sm, flex: 1 },
  // Cancel / trash button
  iconBtn: {
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
  },
  trashWrap: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(239,68,68,0.1)',
  },
  // Center column
  centerCol: {
    flex: 1,
    flexDirection: 'column',
    justifyContent: 'center',
    paddingHorizontal: 6,
    gap: 2,
  },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  // Pulsing red dot
  dotOuter: {
    width: 16, height: 16,
    alignItems: 'center', justifyContent: 'center',
  },
  dotRing: {
    position: 'absolute',
    width: 16, height: 16, borderRadius: 8,
    backgroundColor: 'rgba(239,68,68,0.3)',
  },
  dotCore: {
    width: 10, height: 10, borderRadius: 5,
    backgroundColor: '#ef4444',
  },
  // Timer
  timer: {
    fontSize: 16,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    letterSpacing: 0.5,
    minWidth: 42,
  },
  // Waveform
  waveform: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
    height: 36,
    overflow: 'hidden',
  },
  waveBar: {
    width: 3,
    borderRadius: 2,
  },
  // Slide hint
  slideRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 24,
    marginTop: 1,
  },
  slideArrow: {
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: -2,
    opacity: 0.7,
  },
  slideHint: {
    fontSize: FontSize.xs,
    opacity: 0.7,
  },
  // Right column: lock + send
  rightCol: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    paddingLeft: 4,
  },
  lockWrap: {
    alignItems: 'center', justifyContent: 'center',
    opacity: 0.5,
  },
  sendBtn: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#25D366',
    shadowColor: '#25D366',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    elevation: 4,
  },
});

// ============================================================
// MAIN SCREEN
// ============================================================

export default function ChatConversationScreen() {
  const { colors, isDark } = useTheme();
  const { user } = useAuth();
  const { t } = useLanguage();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams();
  const flatListRef = useRef(null);
  const inputRef = useRef(null);
  const pollRef = useRef(null);
  const liveLocIntervalRef = useRef(null);
  const liveLocTimeoutRef = useRef(null);
  const presenceIntervalRef = useRef(null);
  const mountedRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [newMsgCount, setNewMsgCount] = useState(0);
  const isScrolledUpRef = useRef(false);

  useEffect(() => { return () => {
    mountedRef.current = false;
    if (liveLocIntervalRef.current) clearInterval(liveLocIntervalRef.current);
    if (liveLocTimeoutRef.current) clearTimeout(liveLocTimeoutRef.current);
    if (presenceIntervalRef.current) clearInterval(presenceIntervalRef.current);
    if (pollRef.current) clearInterval(pollRef.current);
  }; }, []);

  const conversationId = parseInt(params.id, 10) || 0;

  // Suppress push notifications for this conversation while it's open
  useEffect(() => {
    if (!conversationId) return;
    try {
      const { setActiveConversation, clearActiveConversation } = require('../services/pushNotifications');
      setActiveConversation(conversationId);
      return () => clearActiveConversation();
    } catch {}
  }, [conversationId]);

  const [conversationName, setConversationName] = useState(() => {
    return emailToDisplayName(params.name || '');
  });
  const conversationType = params.type || 'direct';

  // Fetch conversation name when not provided in params (e.g. from notification)
  useEffect(() => {
    if (conversationId) {
      api.chatConversations().then(r => {
        if (!r.success) return;
        const convs = Array.isArray(r.data) ? r.data : (r.data?.conversations || []);
        const conv = convs.find(c => c.id === conversationId || String(c.id) === String(conversationId));
        if (conv) {
          const name = emailToDisplayName(conv.display_name || conv.name || '');
          if (name) setConversationName(name);
        }
      }).catch(() => {});
    }
  }, [conversationId]);

  // Chatyy settings (font size, read receipts, etc.)
  const [chatyySettings, setChatyySettings] = useState({ font_size: 'medium', read_receipts: true });
  useEffect(() => {
    api.chatGetSettings().then(r => {
      if (r.success && r.data) setChatyySettings(r.data);
    }).catch(() => {});
  }, []);

  const fontSizeMap = { small: 13, medium: 15, large: 18 };
  const lineHeightMap = { small: 19, medium: 21, large: 26 };
  const msgFontSize = fontSizeMap[chatyySettings.font_size] || 15;
  const msgLineHeight = lineHeightMap[chatyySettings.font_size] || 21;
  // WhatsApp 2026: own bubble text color depends on theme
  const ownTextColor = isDark ? '#E9EDEF' : '#111B21';
  const ownMetaColor = isDark ? 'rgba(233,237,239,0.6)' : 'rgba(17,27,33,0.45)';

  const [messages, setMessages] = useState([]);
  // Map of remote URL → local cached path (native only)
  const [cachedUris, setCachedUris] = useState({});
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [inputText, setInputText] = useState('');
  const [replyTo, setReplyTo] = useState(null);
  const [editingMsg, setEditingMsg] = useState(null);
  const [selectedMsg, setSelectedMsg] = useState(null);
  const [showReactions, setShowReactions] = useState(null);
  const [reactionDetail, setReactionDetail] = useState(null);
  const [showFullEmojiPicker, setShowFullEmojiPicker] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [readReceipts, setReadReceipts] = useState([]);
  const [messageInfoModal, setMessageInfoModal] = useState(null); // { message, receipts, sent_at, loading }
  const [translatedMessages, setTranslatedMessages] = useState({}); // { [msgId]: { text, loading } }

  // Group invite link state
  const [inviteLink, setInviteLink] = useState(null);
  const [inviteLinkLoading, setInviteLinkLoading] = useState(false);
  // Mute state
  const [showMuteModal, setShowMuteModal] = useState(false);
  const [mutedUntil, setMutedUntil] = useState(null);

  // WhatsApp features state
  const [mediaPreview, setMediaPreview] = useState({ visible: false, uri: null, type: 'image', file: null });
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [showMeetupCreator, setShowMeetupCreator] = useState(false);
  const [showPlaylistCreator, setShowPlaylistCreator] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({}); // { [tempId]: 0-100 }
  const [wsConnected, setWsConnected] = useState(true); // assume connected initially, banner shows only after disconnect
  const wsDisconnectTimerRef = useRef(null); // 3s delay before showing reconnecting banner
  const offlineQueueRef = useRef([]); // Queue of messages to send when back online
  const lastTypingSentRef = useRef(0); // Debounce typing indicator
  const inputSelectionRef = useRef({ start: 0, end: 0 }); // Selection without re-renders
  const wsConnectedRef = useRef(true); // Track WS connection for polling gate
  const readDebounceRef = useRef(null); // Debounce chatRead calls
  const [presence, setPresence] = useState(null); // { status, last_seen }
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [mediaViewer, setMediaViewer] = useState({ visible: false, fileUrl: '', fileName: '', fileSize: 0, type: '' });
  const [forwardMsg, setForwardMsg] = useState(null);
  const [forwardConversations, setForwardConversations] = useState([]);
  const [forwardLoading, setForwardLoading] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  const [showMediaGallery, setShowMediaGallery] = useState(false);
  const [showFormatToolbar, setShowFormatToolbar] = useState(false);
  // inputSelection moved to inputSelectionRef to avoid re-renders on every cursor move
  const [showExportModal, setShowExportModal] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [mentionedEmails, setMentionedEmails] = useState([]);
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [showStarredModal, setShowStarredModal] = useState(false);
  const [starredMessages, setStarredMessages] = useState([]);
  const [starredLoading, setStarredLoading] = useState(false);
  const [profileViewer, setProfileViewer] = useState(null); // { name, email }
  const [members, setMembers] = useState([]);
  const membersRef = useRef([]);
  useEffect(() => { membersRef.current = members; }, [members]);
  const getMemberEmails = useCallback(() => membersRef.current.map(m => m.email).filter(Boolean), []);
  const [editGroupName, setEditGroupName] = useState('');

  // Disappearing messages
  const [disappearingTimer, setDisappearingTimer] = useState(0);
  const [showDisappearingModal, setShowDisappearingModal] = useState(false);

  // Wallpaper (from chatyy settings, server-side)
  const wallpaperColor = chatyySettings.wallpaper || 'none';
  const [showWallpaperPicker, setShowWallpaperPicker] = useState(false);
  const [showHeaderMenu, setShowHeaderMenu] = useState(false);
  const [mapModalData, setMapModalData] = useState(null); // { lat, lng, label, isLive, liveUntil }

  // Chat lock
  const [chatLocked, setChatLocked] = useState(false);
  const [chatUnlocked, setChatUnlocked] = useState(false);
  const [showLockSetup, setShowLockSetup] = useState(false);
  const [lockPassInput, setLockPassInput] = useState('');

  // Scheduled messages
  const [showScheduleMenu, setShowScheduleMenu] = useState(false);
  const [showScheduledMessages, setShowScheduledMessages] = useState(false);
  const [scheduledMessages, setScheduledMessages] = useState([]);
  const [showCustomSchedule, setShowCustomSchedule] = useState(false);
  const [customScheduleDate, setCustomScheduleDate] = useState('');
  const [scheduleToast, setScheduleToast] = useState('');

  // Block & Report
  const [showReportModal, setShowReportModal] = useState(false);
  const [reportTargetEmail, setReportTargetEmail] = useState('');
  const [reportMessageId, setReportMessageId] = useState(null);
  const [iBlockedThem, setIBlockedThem] = useState(false);
  const [theyBlockedMe, setTheyBlockedMe] = useState(false);

  // Search within conversation
  const [showSearchBar, setShowSearchBar] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const searchInputRef = useRef(null);

  // Pinned messages
  const [pinnedMessages, setPinnedMessages] = useState([]);
  const [showPinnedBanner, setShowPinnedBanner] = useState(true);

  const chatLockKey = `chat_lock_${conversationId}`;

  const getChatLockStorage = useCallback(() => {
    if (Platform.OS === 'web') {
      return localStorage.getItem(chatLockKey);
    }
    return null; // AsyncStorage handled in effect
  }, [chatLockKey]);

  useEffect(() => {
    const checkLock = async () => {
      if (Platform.OS === 'web') {
        const pw = localStorage.getItem(chatLockKey);
        if (pw) { setChatLocked(true); setChatUnlocked(false); }
      } else {
        try {
          const AsyncStorage = require('@react-native-async-storage/async-storage').default;
          const pw = await AsyncStorage.getItem(chatLockKey);
          if (pw) { setChatLocked(true); setChatUnlocked(false); }
        } catch {}
      }
    };
    checkLock();
  }, [chatLockKey]);

  const handleSetChatLock = async (password) => {
    if (!password || password.length < 4) {
      safeAlert(t('common.error'), t('chatConv.lockMinLength') || 'Password must be at least 4 characters');
      return;
    }
    if (Platform.OS === 'web') {
      localStorage.setItem(chatLockKey, password);
    } else {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        await AsyncStorage.setItem(chatLockKey, password);
      } catch {}
    }
    // Sync lock state with backend
    try { await api.chatLock(conversationId, true); } catch {}
    setChatLocked(true);
    setChatUnlocked(true); // Already in the chat, keep unlocked
    setShowLockSetup(false);
    setLockPassInput('');
    safeAlert(t('chatConv.lockSet') || 'Lock set', t('chatConv.lockSetDesc') || 'This chat is now password protected');
  };

  const handleRemoveChatLock = async () => {
    if (Platform.OS === 'web') {
      localStorage.removeItem(chatLockKey);
    } else {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        await AsyncStorage.removeItem(chatLockKey);
      } catch {}
    }
    // Sync lock state with backend
    try { await api.chatLock(conversationId, false); } catch {}
    setChatLocked(false);
    setChatUnlocked(true);
    safeAlert(t('chatConv.lockRemoved') || 'Lock removed', t('chatConv.lockRemovedDesc') || 'Chat lock has been removed');
  };

  // Block user
  const handleBlockUser = (email) => {
    if (!email) return;
    safeAlert(
      t('chat.blockUser'),
      t('chat.blockConfirm'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('chat.blockUser'),
          style: 'destructive',
          onPress: async () => {
            try {
              await api.chatBlockUser(email);
              setIBlockedThem(true);
              safeAlert(t('chat.userBlocked'));
            } catch (e) {
              safeAlert(t('common.error'), e.message || 'Failed to block user');
            }
          },
        },
      ]
    );
  };

  // Unblock user
  const handleUnblockUser = (email) => {
    if (!email) return;
    safeAlert(
      t('chat.unblockUser'),
      (t('chat.unblockConfirm') || 'Desbloquear este contato?'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('chat.unblockUser'),
          onPress: async () => {
            try {
              await api.chatUnblockUser(email);
              setIBlockedThem(false);
            } catch (e) {
              safeAlert(t('common.error'), e.message || 'Failed to unblock user');
            }
          },
        },
      ]
    );
  };

  // Report user — opens reason picker modal
  const handleReportUser = (email, messageId = null) => {
    if (!email) return;
    setReportTargetEmail(email);
    setReportMessageId(messageId);
    setShowReportModal(true);
  };

  const submitReport = async (reason) => {
    setShowReportModal(false);
    try {
      await api.chatReportUser(reportTargetEmail, reason, reportMessageId);
      safeAlert(t('chat.userReported'));
    } catch (e) {
      safeAlert(t('common.error'), e.message || 'Failed to report user');
    }
    setReportTargetEmail('');
    setReportMessageId(null);
  };

  const handleUnlockChat = async (password) => {
    let storedPw;
    if (Platform.OS === 'web') {
      storedPw = localStorage.getItem(chatLockKey);
    } else {
      try {
        const AsyncStorage = require('@react-native-async-storage/async-storage').default;
        storedPw = await AsyncStorage.getItem(chatLockKey);
      } catch {}
    }
    if (password === storedPw) {
      setChatUnlocked(true);
      setLockPassInput('');
    } else {
      safeAlert(t('common.error'), t('chatConv.wrongPassword') || 'Wrong password');
      setLockPassInput('');
    }
  };

  const currentEmail = user?.email || '';

  // ============================================================
  // KEYBOARD HANDLING (fixes modal keyboard overlap on iOS)
  // ============================================================

  useEffect(() => {
    if (Platform.OS === 'web') return;
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e) => setKeyboardHeight(e.endCoordinates.height);
    const onHide = () => setKeyboardHeight(0);
    const sub1 = Keyboard.addListener(showEvent, onShow);
    const sub2 = Keyboard.addListener(hideEvent, onHide);
    return () => { sub1.remove(); sub2.remove(); };
  }, []);

  // ============================================================
  // E2E ENCRYPTION
  // ============================================================

  const [e2eEnabled, setE2eEnabled] = useState(false);
  const [e2eKeys, setE2eKeys] = useState(null); // { email: pubKeyBase64 }
  const e2eSecretKeyRef = useRef(null);

  useEffect(() => {
    if (!currentEmail) return;
    let mounted = true;

    (async () => {
      try {
        // 1. Get/create our identity key pair
        const kp = await e2eService.getIdentityKeyPair();
        e2eSecretKeyRef.current = kp.secretKey;
        const myPubKey = await e2eService.getPublicKeyBase64();

        // 2. Upload our public key to server
        await api.e2eUploadKey(myPubKey);

        // 3. Get conversation members and their E2E keys
        const info = await api.chatMembers(conversationId);
        if (!mounted || !info.success || !info.data?.members) return;

        const emails = info.data.members.map(m => m.email);
        const kr = await api.e2eGetKeys(emails);
        if (!mounted || !kr.success || !kr.data?.keys) return;

        const keyMap = {};
        let allHave = true;
        for (const email of emails) {
          const devices = kr.data.keys[email];
          if (devices && devices.length > 0) {
            keyMap[email] = devices[0].public_key;
            e2eService.cachePublicKey(email, devices[0].public_key);
          } else {
            allHave = false;
          }
        }
        if (allHave) {
          setE2eKeys(keyMap);
          setE2eEnabled(true);
        }
      } catch {}
    })();

    return () => { mounted = false; };
  }, [conversationId, currentEmail]);

  // Wallpaper loaded from chatyySettings (server-side)
  const saveWallpaper = useCallback((color) => {
    const val = color || 'none';
    setChatyySettings(prev => ({ ...prev, wallpaper: val }));
    api.chatUpdateSettings({ wallpaper: val }).catch(() => {});
  }, []);

  // ============================================================
  // PRESENCE TRACKING
  // ============================================================

  useEffect(() => {
    if (conversationType !== 'direct') return;
    const otherEmail = (params.email || '').toLowerCase();
    if (!otherEmail) return;

    // Use WebSocket as the ONLY source of truth for presence
    let mailWs;
    try { mailWs = require('../services/websocket').default; } catch { return; }

    // Query presence immediately via WebSocket
    const queryPresenceViaWS = () => {
      if (mailWs.isConnected) {
        mailWs.queryPresence([otherEmail]);
      }
    };

    // Listen for presence_result responses
    const unsubResult = mailWs.on('presence_result', (presences) => {
      if (!mountedRef.current) return;
      const p = presences[otherEmail];
      if (p) {
        setPresence({ status: p.status, last_seen: p.last_seen });
      }
    });

    // Initial query
    queryPresenceViaWS();

    // Poll presence via WS every 10 seconds (lightweight - just a WS message, not HTTP)
    if (presenceIntervalRef.current) clearInterval(presenceIntervalRef.current);
    presenceIntervalRef.current = setInterval(queryPresenceViaWS, 10000);

    return () => {
      unsubResult?.();
      if (presenceIntervalRef.current) {
        clearInterval(presenceIntervalRef.current);
        presenceIntervalRef.current = null;
      }
    };
  }, [conversationId, conversationType, currentEmail, params.email]);

  // ============================================================
  // MESSAGES
  // ============================================================

  // Decrypt E2E messages in place
  const decryptMessages = useCallback((msgs) => {
    if (!e2eSecretKeyRef.current || !currentEmail) return msgs;
    return msgs.map(msg => {
      if (msg.type !== 'text' || !msg.content) return msg;
      const result = e2eService.openEnvelope(msg.content, currentEmail, e2eSecretKeyRef.current);
      if (result.encrypted) {
        return { ...msg, content: result.text, _e2e: true };
      }
      return msg;
    });
  }, [currentEmail]);

  const loadMessages = useCallback(async (showLoader, beforeId = null) => {
    // Local-first: show cached messages INSTANTLY, then sync only NEW messages from server.
    // This makes the conversation appear immediately (WhatsApp-style) even on slow networks.
    let sinceId = 0;
    if (!beforeId) {
      try {
        const cached = await getCachedMessages(conversationId, 50);
        if (cached.length > 0 && mountedRef.current) {
          setMessages(cached);
          if (showLoader) setLoading(false); // Hide spinner — cached content is showing
          // Only fetch messages newer than what we have cached
          sinceId = await getLastSyncId(conversationId);
        } else if (showLoader) {
          setLoading(true);
        }
      } catch {
        if (showLoader) setLoading(true);
      }
    } else {
      if (showLoader) setLoading(true);
    }
    if (beforeId) setLoadingMore(true);
    try {
      // If we have cached messages, only fetch new ones (since_id).
      // If paginating backwards (beforeId), fetch older messages normally.
      // If no cache, fetch latest 25 (sinceId=0, beforeId=null).
      const r = await api.chatMessages(conversationId, 25, beforeId, sinceId);
      if (r.success && mountedRef.current) {
        const newMsgs = decryptMessages(r.data?.messages || []);
        if (beforeId) {
          setMessages(prev => [...newMsgs, ...prev]);
          // Cache older messages too
          cacheMessages(conversationId, newMsgs).catch(() => {});
        } else if (sinceId > 0 && newMsgs.length > 0) {
          // Incremental sync: merge new messages with cached
          await cacheMessages(conversationId, newMsgs);
          const allCached = await getCachedMessages(conversationId, 50);
          if (mountedRef.current) setMessages(allCached);
        } else if (sinceId === 0) {
          // Fresh load (no cache): set messages and cache them
          setMessages(newMsgs);
          cacheMessages(conversationId, newMsgs).catch(() => {});
        }
        // sinceId > 0 && no new messages: cached messages are already showing, nothing to do

        setHasMore(r.data?.has_more || false);
        if (r.data?.read_receipts) setReadReceipts(r.data.read_receipts);
        if (r.data?.disappearing_timer !== undefined) setDisappearingTimer(r.data.disappearing_timer);

        if (!beforeId && newMsgs.length > 0 && chatyySettings.read_receipts !== false) {
          const lastMsg = newMsgs[newMsgs.length - 1];
          api.chatRead(conversationId, lastMsg.id).catch(() => {});
        }

        // Pre-cache media in background (native only — web uses browser cache)
        if (Platform.OS !== 'web') {
          const mediaMsgs = newMsgs.filter(m => m.file_url && (m.type === 'image' || m.type === 'video' || m.type === 'audio'));
          if (mediaMsgs.length > 0) {
            const remoteUrls = mediaMsgs.map(m => m.file_url?.startsWith('http') ? m.file_url : `https://chatyy.com.br${m.file_url}`);
            Promise.allSettled(remoteUrls.map(url => getCachedUri(url).then(local => ({ url, local })))).then(results => {
              const map = {};
              results.forEach(r => { if (r.status === 'fulfilled' && r.value.local !== r.value.url) map[r.value.url] = r.value.local; });
              if (Object.keys(map).length > 0 && mountedRef.current) setCachedUris(prev => ({ ...prev, ...map }));
            }).catch(() => {});
            // Fire-and-forget background download for any not yet cached
            preCacheUrls(remoteUrls).then(() => {
              Promise.allSettled(remoteUrls.map(url => getCachedUri(url).then(local => ({ url, local })))).then(results => {
                const map = {};
                results.forEach(r => { if (r.status === 'fulfilled' && r.value.local !== r.value.url) map[r.value.url] = r.value.local; });
                if (Object.keys(map).length > 0 && mountedRef.current) setCachedUris(prev => ({ ...prev, ...map }));
              }).catch(() => {});
            }).catch(() => {});
          }
        }
      }
    } catch {} finally {
      if (!mountedRef.current) return;
      setLoading(false);
      setLoadingMore(false);
    }
  }, [conversationId]);

  useEffect(() => {
    loadMessages(true);
    // Load pinned messages
    api.chatPinnedMessages(conversationId).then(r => {
      if (r.success) setPinnedMessages(r.data?.messages || []);
    }).catch(() => {});
    // Load members on mount (needed for mentions, calls, group info)
    api.chatMembers(conversationId).then(r => {
      if (r.success) setMembers(r.data?.members || []);
    }).catch(() => {});
    // Check block status for direct conversations
    if (conversationType === 'direct' && params.email) {
      api.chatCheckBlocked(params.email).then(r => {
        if (r.success) {
          setIBlockedThem(!!r.data?.i_blocked_them);
          setTheyBlockedMe(!!r.data?.they_blocked_me);
        }
      }).catch(() => {});
    }
  }, [loadMessages]);

  // WebSocket real-time messages + slow polling fallback
  const [typingUsers, setTypingUsers] = useState(new Map()); // Map<email, { name, recording, timer }>
  const typingUser = useMemo(() => {
    if (typingUsers.size === 0) return null;
    const entries = [...typingUsers.values()];
    if (entries.length === 1) return entries[0].name;
    return entries.map(e => e.name).join(', ');
  }, [typingUsers]);
  const typingIsRecording = useMemo(() => {
    if (typingUsers.size === 0) return false;
    return [...typingUsers.values()].some(e => e.recording);
  }, [typingUsers]);
  useEffect(() => {
    let wsUnsubs = [];
    try {
      const mailWs = require('../services/websocket').default;
      // Subscribe to this conversation's channel
      mailWs.subscribe(`chat_${conversationId}`);

      // Watch presence for DM partner
      if (conversationType === 'direct' && params.email) {
        mailWs.watchPresence([params.email]);
      }

      // Listen for new chat messages via WS (with deduplication in websocket.js)
      const unsubMsg = mailWs.on('chat_message', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) === String(conversationId) && data?.message) {
          // Decrypt E2E message if needed
          let msg = data.message;
          if (msg.type === 'text' && msg.content && e2eSecretKeyRef.current) {
            const result = e2eService.openEnvelope(msg.content, currentEmail, e2eSecretKeyRef.current);
            if (result.encrypted) msg = { ...msg, content: result.text, _e2e: true };
          }
          setMessages(prev => {
            if (prev.some(m => m.id === msg.id)) return prev;
            // Replace optimistic temp message if this is the real version from server
            // Match by content for text, or by sender+type+filename for media
            const tempIdx = prev.findIndex(m =>
              typeof m.id === 'string' && m.id.startsWith('tmp_') && (m._pending || m._failed) &&
              m.sender_email === msg.sender_email && (
                m.content === msg.content ||
                (m.type === msg.type && m.type !== 'text' && m.file_name === msg.file_name)
              )
            );
            if (tempIdx !== -1) {
              const next = [...prev];
              next[tempIdx] = { ...msg, _pending: false };
              return next;
            }
            return [...prev, msg];
          });
          // Save to local cache for offline access (fire-and-forget)
          if (msg.id && !String(msg.id).startsWith('tmp_')) {
            cacheSingleMessage(conversationId, msg).catch(() => {});
          }
          // Background-cache media files (native only)
          if (msg.file_url && (msg.type === 'image' || msg.type === 'video' || msg.type === 'audio')) {
            const remoteUrl = msg.file_url.startsWith('http') ? msg.file_url : `https://chatyy.com.br${msg.file_url}`;
            cacheMedia(remoteUrl).then(localUri => {
              if (localUri !== remoteUrl && mountedRef.current) {
                setCachedUris(prev => ({ ...prev, [remoteUrl]: localUri }));
              }
            }).catch(() => {});
          }

          // Mark as read since user is viewing the conversation (debounced)
          if (msg.sender_email !== currentEmail && msg.id && chatyySettings.read_receipts !== false) {
            clearTimeout(readDebounceRef.current);
            const msgId = msg.id;
            readDebounceRef.current = setTimeout(() => api.chatRead(conversationId, msgId).catch(() => {}), 500);
            if (isScrolledUpRef.current) setNewMsgCount(c => c + 1);
          }

          // Clear typing indicator for sender (they sent a message, they stopped typing)
          if (msg.sender_email && msg.sender_email !== currentEmail) {
            setTypingUsers(prev => {
              if (!prev.has(msg.sender_email)) return prev;
              const next = new Map(prev);
              const entry = next.get(msg.sender_email);
              if (entry?.timer) clearTimeout(entry.timer);
              next.delete(msg.sender_email);
              return next;
            });
          }
        }
      });
      wsUnsubs.push(unsubMsg);

      // Listen for message delivery acknowledgments (update pending -> sent)
      const unsubAck = mailWs.on('message_ack', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) === String(conversationId) && data?.temp_id) {
          setMessages(prev => prev.map(m =>
            m.id === data.temp_id ? { ...m, _pending: false, _delivered: data.delivered_to || 0 } : m
          ));
        }
      });
      wsUnsubs.push(unsubAck);

      // Listen for push notification refresh (when push arrives before WS)
      const unsubPush = mailWs.on('push_chat_refresh', (data) => {
        if (String(data?.conversation_id) === String(conversationId) && mountedRef.current) {
          loadMessages();
        }
      });
      wsUnsubs.push(unsubPush);
      // Listen for read receipt updates via WS (instant blue ticks)
      const unsubRead = mailWs.on('chat_read', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) === String(conversationId) && data?.email !== currentEmail) {
          setReadReceipts(prev => {
            const existing = prev.find(rr => rr.email === data.email);
            if (existing) {
              return prev.map(rr => rr.email === data.email ? { ...rr, last_read_id: Math.max(rr.last_read_id || 0, data.last_read_id || 0) } : rr);
            }
            return [...prev, { email: data.email, last_read_id: data.last_read_id || 0 }];
          });
        }
      });
      wsUnsubs.push(unsubRead);

      // Listen for typing indicators (supports multiple typers in groups)
      const unsubTyping = mailWs.on('typing', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) === String(conversationId) && data?.email !== currentEmail) {
          const email = data.email;
          const name = data.name || email?.split('@')[0];
          setTypingUsers(prev => {
            const next = new Map(prev);
            // Clear existing timer for this user
            const existing = next.get(email);
            if (existing?.timer) clearTimeout(existing.timer);
            // Set new timer to clear after 3s
            const timer = setTimeout(() => {
              setTypingUsers(p => {
                const n = new Map(p);
                n.delete(email);
                return n;
              });
            }, 3000);
            next.set(email, { name, recording: !!data.recording, timer });
            return next;
          });
        }
      });
      wsUnsubs.push(unsubTyping);

      // Listen for explicit stopped_typing
      const unsubStopTyping = mailWs.on('stopped_typing', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) === String(conversationId) && data?.email !== currentEmail) {
          setTypingUsers(prev => {
            if (!prev.has(data.email)) return prev;
            const next = new Map(prev);
            const entry = next.get(data.email);
            if (entry?.timer) clearTimeout(entry.timer);
            next.delete(data.email);
            return next;
          });
        }
      });
      wsUnsubs.push(unsubStopTyping);

      // Listen for presence updates via WS (online/offline)
      const unsubPresence = mailWs.on('presence', (data) => {
        if (!mountedRef.current) return;
        if (data?.email && conversationType === 'direct') {
          const partnerEmail = params.email || '';
          if (data.email === partnerEmail) {
            setPresence({ status: data.status, last_seen: data.last_seen });
          }
        }
      });
      wsUnsubs.push(unsubPresence);

      // Re-subscribe on reconnect + track connection status for UI banner
      const unsubConn = mailWs.on('connection', (data) => {
        if (data.status === 'authenticated') {
          mailWs.subscribe(`chat_${conversationId}`);
          if (conversationType === 'direct' && params.email) {
            mailWs.watchPresence([params.email]);
          }
          if (mountedRef.current) {
            // Cancel pending disconnect banner
            if (wsDisconnectTimerRef.current) { clearTimeout(wsDisconnectTimerRef.current); wsDisconnectTimerRef.current = null; }
            setWsConnected(true); wsConnectedRef.current = true;
          }
          // Flush offline queue on reconnect
          const queue = offlineQueueRef.current;
          if (queue.length > 0) {
            offlineQueueRef.current = [];
            queue.forEach(async (pending) => {
              try {
                const r = await api.chatSend(pending.conversationId, pending.content, pending.type, pending.replyId, pending.mentions);
                if (r.success && r.data?.id && mountedRef.current) {
                  setMessages(prev => prev.map(m => m.id === pending.tempId ? { ...r.data, _pending: false } : m));
                  // Relay via WS for instant delivery to other participants
                  mailWs.relayChatMessage(pending.conversationId, r.data, pending.tempId, getMemberEmails());
                } else if (mountedRef.current) {
                  setMessages(prev => prev.map(m => m.id === pending.tempId ? { ...m, _failed: true, _pending: false } : m));
                }
              } catch {
                if (mountedRef.current) setMessages(prev => prev.map(m => m.id === pending.tempId ? { ...m, _failed: true, _pending: false } : m));
              }
            });
          }
        } else if (data.status === 'disconnected') {
          wsConnectedRef.current = false;
          // Delay showing reconnecting banner by 3 seconds to avoid flicker on brief reconnections
          if (!wsDisconnectTimerRef.current && mountedRef.current) {
            wsDisconnectTimerRef.current = setTimeout(() => {
              if (mountedRef.current && !wsConnectedRef.current) setWsConnected(false);
              wsDisconnectTimerRef.current = null;
            }, 3000);
          }
        }
      });
      wsUnsubs.push(unsubConn);
      // Set initial connection state
      setWsConnected(mailWs.isConnected);
    } catch {}
    // Adaptive polling: only when WS is disconnected (5s), otherwise no polling needed
    const pollingRef = { current: false };
    pollRef.current = setInterval(async () => {
      if (pollingRef.current) return;
      if (wsConnectedRef.current) return; // Skip polling when WS is connected
      pollingRef.current = true;
      try { await loadMessages(false); } finally { pollingRef.current = false; }
    }, 5000); // 5s when WS is disconnected for fast catchup
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      if (wsDisconnectTimerRef.current) { clearTimeout(wsDisconnectTimerRef.current); wsDisconnectTimerRef.current = null; }
      wsUnsubs.forEach(fn => fn?.());
      // Clear all typing timers
      setTypingUsers(prev => {
        for (const entry of prev.values()) {
          if (entry?.timer) clearTimeout(entry.timer);
        }
        return new Map();
      });
      if (readDebounceRef.current) clearTimeout(readDebounceRef.current);
      // Unsubscribe from chat channel
      try {
        const mailWs = require('../services/websocket').default;
        mailWs.unsubscribe(`chat_${conversationId}`);
      } catch {}
    };
  }, [loadMessages, conversationId, currentEmail, conversationType, params.email]);

  const handleLoadMore = useCallback(() => {
    if (!hasMore || loadingMore || messages.length === 0) return;
    const oldestId = messages[0]?.id;
    if (oldestId) loadMessages(false, oldestId);
  }, [hasMore, loadingMore, messages, loadMessages]);

  // ============================================================
  // SEND TEXT MESSAGE
  // ============================================================

  const handleSend = async () => {
    const text = inputText.trim();
    // debug removed
    if (!text) return;
    if (sending) { setSending(false); return; }

    if (editingMsg) {
      setSending(true);
      try {
        const editContent = (e2eEnabled && e2eKeys) ? e2eService.createEnvelope(text, currentEmail, e2eKeys) : text;
        const r = await api.chatEdit(editingMsg.id, editContent);
        if (r.success) {
          setMessages(prev => prev.map(m =>
            m.id === editingMsg.id ? { ...m, content: text, edited_at: new Date().toISOString() } : m
          ));
          setEditingMsg(null);
          setInputText('');
        }
      } catch {} finally {
        setSending(false);
      }
      return;
    }

    const replyId = replyTo?.id || null;
    const currentMentions = [...mentionedEmails];
    setInputText('');
    setReplyTo(null);
    setMentionedEmails([]);
    setShowMentionPopup(false);
    setSending(true);

    // Optimistic: show message immediately before server confirms
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMsg = {
      id: tempId,
      conversation_id: conversationId,
      sender_email: currentEmail,
      content: text,
      type: 'text',
      reply_to_id: replyId,
      reply_to: replyId ? {
        id: replyTo.id,
        sender_email: replyTo.sender_email,
        sender_name: replyTo.sender_name || replyTo.sender_email?.split('@')[0],
        content: (replyTo.content || '').substring(0, 200),
        type: replyTo.type || 'text',
        file_url: replyTo.file_url || null,
      } : null,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setMessages(prev => [...prev, optimisticMsg]);
    try { if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    requestAnimationFrame(() => {
      flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true });
    });

    // Encrypt if E2E is enabled
    const contentToSend = (e2eEnabled && e2eKeys)
      ? e2eService.createEnvelope(text, currentEmail, e2eKeys)
      : text;

    // Stop typing indicator immediately when sending
    try { const mailWs = require('../services/websocket').default; mailWs.sendStoppedTyping(conversationId); } catch {}

    // Always try to send (don't queue offline - polling will catch up)
    try {
      // Timeout after 10s to prevent hanging
      const sendPromise = api.chatSend(conversationId, contentToSend, 'text', replyId, currentMentions);
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000));
      const r = await Promise.race([sendPromise, timeoutPromise]);
      if (r.success && r.data?.id) {
        // Replace temp message with real server message (show decrypted text)
        const serverMsg = { ...r.data, _pending: false };
        if (e2eEnabled) {
          serverMsg.content = text; // We already know the plaintext
          serverMsg._e2e = true;
        }
        setMessages(prev => prev.map(m => m.id === tempId ? serverMsg : m));
        // Cache sent message locally
        cacheSingleMessage(conversationId, serverMsg).catch(() => {});
        // Relay via WS for instant delivery to other participants
        try {
          const mailWs = require('../services/websocket').default;
          mailWs.relayChatMessage(conversationId, r.data, tempId, getMemberEmails());
        } catch {}
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false } : m));
      }
    } catch {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false } : m));
    } finally {
      setSending(false);
      // Keep focus on input so user can continue typing
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  // ============================================================
  // SEND GIF
  // ============================================================
  const handleSendGif = async (gif) => {
    setShowGifPicker(false);
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMsg = {
      id: tempId, conversation_id: conversationId, sender_email: currentEmail,
      content: gif.url, type: 'gif', created_at: new Date().toISOString(), _pending: true,
    };
    setMessages(prev => [...prev, optimisticMsg]);
    requestAnimationFrame(() => { flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }); });
    try {
      const r = await api.chatSend(conversationId, gif.url, 'gif');
      if (r.success && r.data?.id) {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...r.data, _pending: false } : m));
        try { const mailWs = require('../services/websocket').default; mailWs.relayChatMessage(conversationId, r.data, tempId, getMemberEmails()); } catch {}
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false } : m));
      }
    } catch {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false } : m));
    }
  };

  // ============================================================
  // SEND STICKER
  // ============================================================
  const handleSendSticker = async (emoji) => {
    setShowStickerPicker(false);
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMsg = {
      id: tempId, conversation_id: conversationId, sender_email: currentEmail,
      content: emoji, type: 'sticker', created_at: new Date().toISOString(), _pending: true,
    };
    setMessages(prev => [...prev, optimisticMsg]);
    requestAnimationFrame(() => { flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }); });
    try {
      const r = await api.chatSend(conversationId, emoji, 'sticker');
      if (r.success && r.data?.id) {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...r.data, _pending: false } : m));
        try { const mailWs = require('../services/websocket').default; mailWs.relayChatMessage(conversationId, r.data, tempId, getMemberEmails()); } catch {}
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false } : m));
      }
    } catch {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false } : m));
    }
  };

  // ============================================================
  // SCHEDULE MESSAGE
  // ============================================================

  const handleScheduleMessage = async (scheduledAt) => {
    const text = inputText.trim();
    if (!text) return;
    setShowScheduleMenu(false);
    setShowCustomSchedule(false);
    try {
      const r = await api.chatScheduleMessage(conversationId, text, scheduledAt);
      if (r.success) {
        setInputText('');
        const d = new Date(scheduledAt);
        const timeStr = d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        setScheduleToast(t('chat.messageScheduled', { time: timeStr }));
        setTimeout(() => setScheduleToast(''), 3000);
      }
    } catch {}
  };

  const getScheduleOptions = () => {
    const now = new Date();
    const todayAt18 = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 18, 0, 0);
    const tomorrowAt9 = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0);
    const options = [];
    if (todayAt18 > now) {
      options.push({ label: t('chat.scheduleToday', { time: '18:00' }), value: todayAt18.toISOString() });
    }
    options.push({ label: t('chat.scheduleTomorrow', { time: '09:00' }), value: tomorrowAt9.toISOString() });
    options.push({ label: t('chat.scheduleCustom'), value: 'custom' });
    return options;
  };

  const loadScheduledMessages = async () => {
    try {
      const r = await api.chatScheduledList();
      if (r.success && r.data?.scheduled_messages) {
        setScheduledMessages(r.data.scheduled_messages.filter(m => m.conversation_id === conversationId));
      }
    } catch {}
  };

  const handleCancelScheduled = async (id) => {
    try {
      const r = await api.chatScheduleCancel(id);
      if (r.success) {
        setScheduledMessages(prev => prev.filter(m => m.id !== id));
      }
    } catch {}
  };

  // ============================================================
  // ATTACHMENT HANDLERS
  // ============================================================

  const handlePickAttachment = async (type) => {
    switch (type) {
      case 'camera': return handleCamera();
      case 'gallery': return handleGallery();
      case 'file': return handleAttachFile();
      case 'audio':
        setIsRecording(true);
        try { const mailWs = require('../services/websocket').default; mailWs.sendTyping(conversationId, true); } catch {}
        return;
      case 'location': return handleShareLocation();
      case 'liveLocation': return handleShareLiveLocation();
      case 'contact': return handleShareContact();
      case 'poll': setShowPollCreator(true); return;
      case 'meetup': setShowMeetupCreator(true); return;
      case 'playlist': setShowPlaylistCreator(true); return;
    }
  };

  const handleWebFilePick = (accept) => {
    return new Promise((resolve) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.onchange = (e) => {
        const file = e.target.files?.[0];
        if (file) {
          const uri = URL.createObjectURL(file);
          resolve({ uri, blob: file, name: file.name, type: file.type || 'application/octet-stream' });
        } else {
          resolve(null);
        }
      };
      // Handle cancel: focus returns to window without file selection
      const handleFocus = () => {
        setTimeout(() => {
          if (!input.files?.length) resolve(null);
          window.removeEventListener('focus', handleFocus);
        }, 500);
      };
      window.addEventListener('focus', handleFocus);
      input.click();
    });
  };

  const handleCamera = async () => {
    try {
      if (Platform.OS === 'web') {
        const file = await handleWebFilePick('image/*,video/*');
        if (file) {
          const uri = file.blob ? URL.createObjectURL(file.blob) : file.uri;
          const isVid = file.type?.startsWith('video') || file.name?.match(/\.(mp4|mov|avi|webm|mkv)$/i);
          setMediaPreview({ visible: true, uri, type: isVid ? 'video' : 'image', file });
        }
        return;
      }
      const ImagePicker = require('expo-image-picker');
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        safeAlert(t('chatConv.permission') || 'Permission', t('chatConv.cameraPermission') || 'Allow camera access in settings.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.8,
        videoMaxDuration: 60,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const file = {
        uri: asset.uri,
        name: asset.fileName || `camera_${Date.now()}.${asset.type === 'video' ? 'mp4' : 'jpg'}`,
        type: asset.type === 'video' ? 'video/mp4' : 'image/jpeg',
      };
      setMediaPreview({ visible: true, uri: asset.uri, type: asset.type === 'video' ? 'video' : 'image', file });
    } catch (e) {
      console.warn('Camera error:', e);
    }
  };

  const handleGallery = async () => {
    try {
      if (Platform.OS === 'web') {
        const file = await handleWebFilePick('image/*,video/*');
        if (file) {
          // Show preview modal instead of direct upload
          const uri = file.blob ? URL.createObjectURL(file.blob) : file.uri;
          const isVid = file.type?.startsWith('video') || file.name?.match(/\.(mp4|mov|avi|webm|mkv)$/i);
          setMediaPreview({ visible: true, uri, type: isVid ? 'video' : 'image', file });
        }
        return;
      }
      const ImagePicker = require('expo-image-picker');
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        safeAlert(t('chatConv.permission') || 'Permission', t('chatConv.galleryPermission') || 'Allow gallery access in settings.');
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.8,
        allowsMultipleSelection: true,
        selectionLimit: 10,
        videoMaxDuration: 120,
      });
      if (result.canceled || !result.assets?.length) return;
      if (result.assets.length === 1) {
        const asset = result.assets[0];
        const file = {
          uri: asset.uri,
          name: asset.fileName || `media_${Date.now()}.${asset.type === 'video' ? 'mp4' : 'jpg'}`,
          type: asset.type === 'video' ? 'video/mp4' : 'image/jpeg',
        };
        setMediaPreview({ visible: true, uri: asset.uri, type: asset.type === 'video' ? 'video' : 'image', file });
      } else {
        // Multiple selection: upload each asset directly
        for (const asset of result.assets) {
          const file = {
            uri: asset.uri,
            name: asset.fileName || `media_${Date.now()}_${Math.random().toString(36).slice(2,6)}.${asset.type === 'video' ? 'mp4' : 'jpg'}`,
            type: asset.type === 'video' ? 'video/mp4' : 'image/jpeg',
          };
          try { await uploadAndSendFile(file); } catch (e) { console.warn('Multi-upload error:', e); }
        }
      }
    } catch (e) {
      console.warn('Gallery error:', e);
    }
  };

  const handleAttachFile = async () => {
    try {
      if (Platform.OS === 'web') {
        // Accept common document types + any file
        const file = await handleWebFilePick('.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.zip,.rar,.csv,.rtf,application/*,text/*,*/*');
        if (file) await uploadAndSendFile(file);
        return;
      }
      const result = await DocumentPicker.getDocumentAsync({
        type: ['*/*', 'application/pdf', 'application/msword',
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          'text/plain', 'application/zip'],
        copyToCacheDirectory: true,
        multiple: false,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const fileName = asset.name || 'file';
      const mimeType = asset.mimeType || asset.type || 'application/octet-stream';
      await uploadAndSendFile({
        uri: asset.uri,
        name: fileName,
        type: mimeType,
        size: asset.size,
      });
    } catch (e) {
      console.warn('File pick error:', e);
      if (e?.message && !e.message.includes('cancel')) {
        safeAlert(t('common.error') || 'Error', t('chatConv.filePickError') || 'Could not open file picker');
      }
    }
  };

  const uploadAndSendFile = async (file, forceViewOnce = false, caption = '') => {
    setUploading(true);
    const tempId = 'tmp_upload_' + Date.now();
    const mimeType = file.type || '';
    const fileType = mimeType.startsWith('image/') ? 'image'
      : mimeType.startsWith('video/') ? 'video'
      : mimeType.startsWith('audio/') ? 'audio'
      : 'file';
    // Use local URI as preview so images/videos show INSTANTLY before upload completes
    const localUri = file.blob ? URL.createObjectURL(file.blob) : file.uri;
    const optimisticMsg = {
      id: tempId,
      sender_email: user?.email,
      sender_name: '',
      content: caption || file.name || 'File',
      type: fileType,
      file_name: file.name,
      file_url: localUri || '',
      _localUri: localUri, // Keep reference for display during upload
      created_at: new Date().toISOString(),
      _pending: true,
      _uploading: true,
    };
    setMessages(prev => [...prev, optimisticMsg]);
    setUploadProgress(prev => ({ ...prev, [tempId]: 0 }));
    requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));
    try {
      // Use XHR for upload progress tracking on web
      const r = await api.chatUploadFile(conversationId, file, caption, forceViewOnce, (progress) => {
        if (mountedRef.current) {
          setUploadProgress(prev => ({ ...prev, [tempId]: Math.round(progress * 100) }));
        }
      });
      if (r.success && r.data) {
        const msg = r.data.message || r.data;
        setMessages(prev => prev.map(m => m.id === tempId ? { ...msg, _pending: false } : m));
        setUploadProgress(prev => { const n = { ...prev }; delete n[tempId]; return n; });
        requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));
        // Relay via WS for instant delivery
        try { const mailWs = require('../services/websocket').default; mailWs.relayChatMessage(conversationId, msg, tempId, getMemberEmails()); } catch {}
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false, _uploading: false } : m));
        setUploadProgress(prev => { const n = { ...prev }; delete n[tempId]; return n; });
        safeAlert(t('common.error') || 'Error', r.message || t('chatConv.uploadError') || 'Failed to send file');
      }
    } catch {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false, _uploading: false } : m));
      setUploadProgress(prev => { const n = { ...prev }; delete n[tempId]; return n; });
      safeAlert(t('common.error') || 'Error', t('chatConv.uploadError') || 'Failed to send file');
    } finally {
      setUploading(false);
    }
  };

  const handleSendAudio = async (audioData) => {
    setIsRecording(false);
    setUploading(true);
    // Optimistic: show audio message immediately with uploading indicator
    const tempId = 'tmp_audio_' + Date.now();
    const localUri = audioData.blob ? URL.createObjectURL(audioData.blob) : audioData.uri;
    const optimisticMsg = {
      id: tempId,
      sender_email: user?.email,
      sender_name: '',
      content: `Audio (${formatDuration(audioData.duration)})`,
      type: 'audio',
      file_url: localUri,
      _localUri: localUri,
      duration: audioData.duration,
      created_at: new Date().toISOString(),
      _pending: true,
      _uploading: true,
    };
    setMessages(prev => [...prev, optimisticMsg]);
    setUploadProgress(prev => ({ ...prev, [tempId]: 0 }));
    requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));
    try {
      const filePayload = {
        uri: audioData.uri,
        name: audioData.name,
        type: audioData.type,
      };
      if (audioData.blob) filePayload.blob = audioData.blob;
      const r = await api.chatUploadFile(conversationId, filePayload, `Audio (${formatDuration(audioData.duration)})`, false, (progress) => {
        if (mountedRef.current) setUploadProgress(prev => ({ ...prev, [tempId]: Math.round(progress * 100) }));
      });
      if (r.success && r.data) {
        const msg = r.data.message || r.data;
        setMessages(prev => prev.map(m => m.id === tempId ? { ...msg, _pending: false } : m));
        // Relay via WS for instant delivery
        try { const mailWs = require('../services/websocket').default; mailWs.relayChatMessage(conversationId, msg, tempId, getMemberEmails()); } catch {}
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false, _uploading: false } : m));
      }
      setUploadProgress(prev => { const n = { ...prev }; delete n[tempId]; return n; });
    } catch {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false, _uploading: false } : m));
      setUploadProgress(prev => { const n = { ...prev }; delete n[tempId]; return n; });
    } finally {
      setUploading(false);
    }
  };

  const handleShareLocation = async () => {
    try {
      setUploading(true);
      let latitude, longitude;

      if (Platform.OS === 'web') {
        // Web: use browser Geolocation API
        if (!navigator?.geolocation) {
          safeAlert('Error', t('chatConv.locationError') || 'Geolocation not available');
          setUploading(false);
          return;
        }
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
        });
        latitude = pos.coords.latitude;
        longitude = pos.coords.longitude;
      } else {
        // Native: use expo-location
        const Location = require('expo-location');
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          safeAlert(t('chatConv.permission') || 'Permission', t('chatConv.locationPermission') || 'Allow location access in settings.');
          setUploading(false);
          return;
        }
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        latitude = loc.coords.latitude;
        longitude = loc.coords.longitude;
      }

      let address = '';
      if (Platform.OS !== 'web') {
        try {
          const Location = require('expo-location');
          const [geo] = await Location.reverseGeocodeAsync({ latitude, longitude });
          if (geo) address = [geo.street, geo.streetNumber, geo.district, geo.city].filter(Boolean).join(', ');
        } catch {}
      } else {
        // Web: reverse geocode via free Nominatim API
        try {
          const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`, {
            headers: { 'Accept-Language': 'pt-BR' },
          });
          const geoData = await geoRes.json();
          if (geoData?.address) {
            const a = geoData.address;
            address = [a.road, a.house_number, a.suburb || a.neighbourhood, a.city || a.town || a.village].filter(Boolean).join(', ');
          }
        } catch {}
      }

      const content = JSON.stringify({
        latitude, longitude,
        label: address || `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
        address,
      });

      const r = await api.chatSend(conversationId, content, 'location');
      if (r.success && r.data?.id) {
        setMessages(prev => [...prev, r.data]);
        requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));
      }
    } catch (e) {
      console.warn('Location error:', e);
      safeAlert(t('common.error') || 'Error', t('chatConv.locationError') || 'Could not get location');
    } finally {
      setUploading(false);
    }
  };

  const handleShareLiveLocation = async () => {
    // Ask for duration
    const durations = [
      { label: '15 minutos', value: 15 * 60 },
      { label: '1 hora', value: 60 * 60 },
      { label: '8 horas', value: 8 * 60 * 60 },
    ];

    if (Platform.OS === 'web') {
      const choice = window.prompt('Compartilhar localização ao vivo por:\n1 - 15 minutos\n2 - 1 hora\n3 - 8 horas', '1');
      if (!choice) return;
      const idx = parseInt(choice) - 1;
      if (idx < 0 || idx > 2) return;
      startLiveLocation(durations[idx].value);
    } else {
      Alert.alert(
        t('chatConv.liveLocation') || 'Localização ao vivo',
        t('chatConv.liveLocationDuration') || 'Compartilhar por quanto tempo?',
        durations.map(d => ({ text: d.label, onPress: () => startLiveLocation(d.value) })).concat([{ text: t('common.cancel'), style: 'cancel' }]),
      );
    }
  };

  const startLiveLocation = async (durationSec) => {
    try {
      setUploading(true);
      let latitude, longitude;

      if (Platform.OS === 'web') {
        if (!navigator?.geolocation) {
          safeAlert('Error', t('chatConv.locationError') || 'Geolocation not available');
          setUploading(false);
          return;
        }
        const pos = await new Promise((resolve, reject) => {
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
        });
        latitude = pos.coords.latitude;
        longitude = pos.coords.longitude;
      } else {
        const Location = require('expo-location');
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          safeAlert(t('chatConv.permission') || 'Permission', t('chatConv.locationPermission') || 'Allow location access in settings.');
          setUploading(false);
          return;
        }
        const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High });
        latitude = loc.coords.latitude;
        longitude = loc.coords.longitude;
      }

      let address = '';
      if (Platform.OS === 'web') {
        try {
          const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`, { headers: { 'Accept-Language': 'pt-BR' } });
          const geoData = await geoRes.json();
          if (geoData?.address) {
            const a = geoData.address;
            address = [a.road, a.house_number, a.suburb || a.neighbourhood, a.city || a.town || a.village].filter(Boolean).join(', ');
          }
        } catch {}
      } else {
        try {
          const Location = require('expo-location');
          const [geo] = await Location.reverseGeocodeAsync({ latitude, longitude });
          if (geo) address = [geo.street, geo.streetNumber, geo.district, geo.city].filter(Boolean).join(', ');
        } catch {}
      }

      const liveUntil = Math.floor(Date.now() / 1000) + durationSec;
      const content = JSON.stringify({
        latitude, longitude, live: true, live_until: liveUntil,
        label: address || `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`,
        address, updated_at: new Date().toISOString(),
      });

      const r = await api.chatSend(conversationId, content, 'location');
      if (r.success && r.data?.id) {
        setMessages(prev => [...prev, r.data]);
        requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));

        // Start background location updates (stored for cleanup on unmount)
        const msgId = r.data.id;
        if (liveLocIntervalRef.current) clearInterval(liveLocIntervalRef.current);
        if (liveLocTimeoutRef.current) clearTimeout(liveLocTimeoutRef.current);
        const updateInterval = setInterval(async () => {
          try {
            let lat2, lng2;
            if (Platform.OS === 'web') {
              const p = await new Promise((res, rej) => navigator.geolocation.getCurrentPosition(res, rej, { enableHighAccuracy: true, timeout: 5000 }));
              lat2 = p.coords.latitude;
              lng2 = p.coords.longitude;
            } else {
              const Location = require('expo-location');
              const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
              lat2 = l.coords.latitude;
              lng2 = l.coords.longitude;
            }
            const res = await api.chatUpdateLiveLocation(msgId, lat2, lng2);
            if (!res.success) clearInterval(updateInterval);
          } catch (err) { console.warn('Live location update failed:', err); clearInterval(updateInterval); liveLocIntervalRef.current = null; }
        }, 10000);

        liveLocIntervalRef.current = updateInterval;
        // Auto-stop after duration
        liveLocTimeoutRef.current = setTimeout(() => {
          clearInterval(updateInterval);
          liveLocIntervalRef.current = null;
          liveLocTimeoutRef.current = null;
          api.chatStopLiveLocation(msgId).catch(() => {});
        }, durationSec * 1000);
      }
    } catch (e) {
      console.warn('Live location error:', e);
      safeAlert(t('common.error') || 'Error', t('chatConv.locationError') || 'Could not get location');
    } finally {
      setUploading(false);
    }
  };

  const handleShareContact = async () => {
    if (Platform.OS === 'web') {
      // Web: manual contact entry
      const name = window.prompt(t('chatConv.enterContactName') || 'Contact name:');
      if (!name) return;
      const phone = window.prompt(t('chatConv.enterContactPhone') || 'Phone (optional):') || '';
      const email = window.prompt(t('chatConv.enterContactEmail') || 'Email (optional):') || '';
      sendContact({ name, phoneNumbers: phone ? [{ number: phone }] : [], emails: email ? [{ email }] : [] });
      return;
    }
    try {
      const Contacts = require('expo-contacts');
      const { status } = await Contacts.requestPermissionsAsync();
      if (status !== 'granted') {
        safeAlert(t('chatConv.permission') || 'Permission', t('chatConv.contactsPermission') || 'Allow contacts access in settings.');
        return;
      }
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
        sort: Contacts.SortTypes.FirstName,
      });
      if (!data || data.length === 0) {
        safeAlert('Info', t('chatConv.noContacts') || 'No contacts found');
        return;
      }

      const contactList = data.slice(0, 30).filter(c => c.name);
      if (contactList.length === 0) return;

      safeAlert(
        t('chatConv.selectContact') || 'Select Contact',
        '',
        [
          ...contactList.slice(0, 15).map(c => ({
            text: `${c.name}${c.phoneNumbers?.[0]?.number ? ` (${c.phoneNumbers[0].number})` : ''}`,
            onPress: () => sendContact(c),
          })),
          { text: t('common.cancel') || 'Cancel', style: 'cancel' },
        ]
      );
    } catch (e) {
      console.warn('Contacts error:', e);
    }
  };

  const sendContact = async (contact) => {
    const content = JSON.stringify({
      name: contact.name || '',
      phone: contact.phoneNumbers?.[0]?.number || '',
      email: contact.emails?.[0]?.email || '',
    });
    try {
      const r = await api.chatSend(conversationId, content, 'contact');
      if (r.success && r.data?.id) {
        setMessages(prev => [...prev, r.data]);
        requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));
      }
    } catch {}
  };

  // ============================================================
  // MESSAGE ACTIONS
  // ============================================================

  const handleDelete = async (msgId) => {
    try { if (Platform.OS !== 'web') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning); } catch {}
    const msg = messages.find(m => m.id === msgId);
    const isMine = msg?.sender_email === user?.email;

    const deleteForEveryone = async () => {
      try {
        const r = await api.chatDelete(msgId, 'for_all');
        if (r.success) {
          setMessages(prev => prev.map(m =>
            m.id === msgId ? { ...m, deleted_at: new Date().toISOString(), content: '', file_url: '' } : m
          ));
          // Update cache to reflect deletion
          const { deleteCachedMessage: delCache } = require('../services/chatCache');
          delCache(conversationId, msgId).catch(() => {});
        }
      } catch {}
      setSelectedMsg(null);
    };
    const deleteForMe = async () => {
      try {
        await api.chatDelete(msgId, 'for_me');
      } catch {}
      setMessages(prev => prev.filter(m => m.id !== msgId));
      // Remove from local cache
      const { deleteCachedMessage: delCache } = require('../services/chatCache');
      delCache(conversationId, msgId).catch(() => {});
      setSelectedMsg(null);
    };
    if (Platform.OS === 'web') {
      if (isMine) {
        const choice = window.confirm(t('chatConv.deleteForEveryone') || 'Delete for everyone? (Cancel = delete for me only)');
        if (choice) deleteForEveryone();
        else deleteForMe();
      } else {
        if (window.confirm(t('chatConv.deleteForMe') || 'Delete this message for you?')) {
          deleteForMe();
        }
      }
      return;
    }
    const buttons = [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('chatConv.deleteForMe'), onPress: deleteForMe },
    ];
    // Only show "delete for everyone" for own messages or if admin
    if (isMine) {
      buttons.push({ text: t('chatConv.deleteForEveryone'), style: 'destructive', onPress: deleteForEveryone });
    }
    safeAlert(t('chat.deleteMessage'), t('chat.deleteConfirm'), buttons);
  };

  // Reaction bounce animation
  const [reactionBounceId, setReactionBounceId] = useState(null);
  const reactionBounceScale = useRef(new Animated.Value(1)).current;

  const handleReact = async (msgId, emoji) => {
    try { if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}
    // Trigger bounce animation
    setReactionBounceId(msgId);
    reactionBounceScale.setValue(0.3);
    const nd = Platform.OS !== 'web';
    Animated.spring(reactionBounceScale, { toValue: 1, friction: 3, tension: 300, useNativeDriver: nd }).start(() => {
      setTimeout(() => setReactionBounceId(null), 300);
    });
    try {
      const r = await api.chatReact(msgId, emoji);
      if (r.success) {
        setMessages(prev => prev.map(m => {
          if (m.id !== msgId) return m;
          return { ...m, reactions: r.data?.reactions || [] };
        }));
      }
    } catch {}
    setShowReactions(null);
  };

  const handleEdit = (msg) => {
    setEditingMsg(msg);
    setInputText(msg.content);
    setSelectedMsg(null);
    inputRef.current?.focus();
  };

  const handleReply = (msg) => {
    setReplyTo(msg);
    setSelectedMsg(null);
    inputRef.current?.focus();
  };

  // Double-tap to heart react with animated pop
  const lastTapRef = useRef({});
  const [heartPopMsg, setHeartPopMsg] = useState(null);
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;

  const handleDoubleTap = useCallback((msg) => {
    const now = Date.now();
    const lastTap = lastTapRef.current[msg.id] || 0;
    if (now - lastTap < 300) {
      lastTapRef.current[msg.id] = 0;
      handleReact(msg.id, 'heart');
      try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
      // Animated heart pop
      setHeartPopMsg(msg.id);
      heartScale.setValue(0);
      heartOpacity.setValue(1);
      const nd = Platform.OS !== 'web';
      Animated.sequence([
        Animated.spring(heartScale, { toValue: 1, friction: 3, tension: 200, useNativeDriver: nd }),
        Animated.timing(heartOpacity, { toValue: 0, duration: 400, useNativeDriver: nd }),
      ]).start(() => setHeartPopMsg(null));
    } else {
      lastTapRef.current[msg.id] = now;
    }
  }, [handleReact]);

  // ---- Search within conversation ----
  const handleSearchMessages = useCallback(async (q) => {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); setSearchIdx(0); return; }
    // Local search in loaded messages
    const lower = q.toLowerCase();
    const results = messages.filter(m => m.content && m.content.toLowerCase().includes(lower)).reverse();
    setSearchResults(results);
    setSearchIdx(0);
    if (results.length > 0) {
      flatListRef.current?.scrollToItem?.({ item: results[0], animated: true });
    }
  }, [messages]);

  const handleSearchNav = useCallback((dir) => {
    const next = dir === 'up' ? Math.min(searchIdx + 1, searchResults.length - 1) : Math.max(searchIdx - 1, 0);
    setSearchIdx(next);
    if (searchResults[next]) {
      flatListRef.current?.scrollToItem?.({ item: searchResults[next], animated: true });
    }
  }, [searchIdx, searchResults]);

  // ---- Pinned messages ----
  const handlePinMessage = useCallback(async (msg) => {
    try {
      const r = await api.chatPinMessage(msg.id);
      if (r.success) {
        setPinnedMessages(prev => {
          const exists = prev.find(p => p.id === msg.id);
          if (exists) return prev.filter(p => p.id !== msg.id);
          return [msg, ...prev];
        });
      }
    } catch {}
    setSelectedMsg(null);
  }, []);

  const loadGroupMembers = async () => {
    try {
      const r = await api.chatMembers(conversationId);
      if (r.success) setMembers(r.data?.members || []);
    } catch {}
  };

  const handleUpdateGroupName = async () => {
    if (!editGroupName.trim() || editGroupName === conversationName) {
      setShowGroupInfo(false);
      return;
    }
    try {
      await api.chatUpdate(conversationId, { name: editGroupName.trim() });
      // Update local state - the name param comes from router
      setShowGroupInfo(false);
    } catch {}
  };

  const myRole = members.find(m => m.email === user?.email)?.role;
  const isGroupAdmin = myRole === 'admin';

  const handleLeaveGroup = () => {
    safeAlert(
      t('chatConv.leaveGroup') || 'Sair do grupo',
      t('chatConv.leaveGroupConfirm') || 'Tem certeza que deseja sair deste grupo?',
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('chatConv.leave') || 'Sair', style: 'destructive',
          onPress: async () => {
            try {
              const r = await api.chatLeaveGroup(conversationId);
              if (r.success) {
                setShowGroupInfo(false);
                router.back();
              }
            } catch {}
          },
        },
      ]
    );
  };

  const handleGenerateInviteLink = async (regenerate = false) => {
    setInviteLinkLoading(true);
    try {
      const r = await api.chatGroupInviteLink(conversationId, regenerate);
      if (r.success && r.data?.link) {
        setInviteLink(r.data.link);
        // Copy to clipboard
        if (Platform.OS === 'web' && navigator.clipboard) {
          await navigator.clipboard.writeText(r.data.link);
          safeAlert(t('chatConv.groupLink'), t('chatConv.inviteLinkCopied'));
        } else {
          try { await Share.share({ message: r.data.link }); } catch {}
        }
      } else {
        safeAlert(t('common.error'), t('chatConv.inviteLinkError'));
      }
    } catch {
      safeAlert(t('common.error'), t('chatConv.inviteLinkError'));
    } finally {
      setInviteLinkLoading(false);
    }
  };

  const handleMuteChat = async (duration) => {
    let muteUntil = null;
    if (duration === '8h') {
      muteUntil = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();
    } else if (duration === '1w') {
      muteUntil = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    } else if (duration === 'forever') {
      muteUntil = '2099-12-31T23:59:59Z';
    }
    // null = unmute
    try {
      const r = await api.chatMute(conversationId, muteUntil);
      if (r.success) {
        setMutedUntil(muteUntil);
      }
    } catch {}
    setShowMuteModal(false);
  };

  const handleToggleAdmin = async (memberEmail, currentRole) => {
    const action = currentRole === 'admin' ? 'demote' : 'promote';
    try {
      const r = await api.chatGroupAdmin(conversationId, memberEmail, action);
      if (r.success) {
        // Refresh members
        const info = await api.chatGroupInfo(conversationId);
        if (info.success && info.data?.members) {
          setMembers(info.data.members);
        }
      } else {
        safeAlert(t('common.error'), r.message || 'Error');
      }
    } catch {}
  };

  const handleRemoveMember = (memberEmail, memberName) => {
    safeAlert(
      t('chatConv.removeMember') || 'Remover membro',
      (t('chatConv.removeMemberConfirm') || 'Remover {name} do grupo?').replace('{name}', memberName),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('chatConv.remove') || 'Remover', style: 'destructive',
          onPress: async () => {
            try {
              const r = await api.chatRemoveMember(conversationId, memberEmail);
              if (r.success) {
                setMembers(prev => prev.filter(m => m.email !== memberEmail));
              }
            } catch {}
          },
        },
      ]
    );
  };

  const loadStarredMessages = async () => {
    setStarredLoading(true);
    try {
      const r = await api.chatStarredMessages();
      if (r.success && r.data?.messages) {
        setStarredMessages(r.data.messages);
      }
    } catch {} finally {
      setStarredLoading(false);
    }
  };

  const handleStarMessage = async (msg) => {
    setSelectedMsg(null);
    const isStarred = msg.starred;
    // Optimistic update
    setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, starred: !isStarred } : m));
    try {
      const r = await api.chatStarMessage(msg.id, !isStarred);
      if (!r.success) {
        // Revert on failure
        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, starred: isStarred } : m));
      }
    } catch {
      setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, starred: isStarred } : m));
    }
  };

  const handleForward = async (msg) => {
    setSelectedMsg(null);
    setForwardMsg(msg);
    setForwardLoading(true);
    try {
      const r = await api.chatConversations();
      if (r.success) {
        const convs = Array.isArray(r.data) ? r.data : (r.data?.conversations || []);
        setForwardConversations(convs.filter(c => String(c.id) !== String(conversationId)));
      }
    } catch {} finally {
      setForwardLoading(false);
    }
  };

  const handleForwardTo = async (targetConvId) => {
    if (!forwardMsg) return;
    try {
      const r = await api.chatForward(forwardMsg.id, targetConvId);
      if (r.success) {
        setForwardMsg(null);
        safeAlert(t('chatConv.forwarded'), t('chatConv.forwardedSuccess'));
      } else {
        safeAlert(t('chatConv.forwardError'), r.message || '');
      }
    } catch {
      safeAlert(t('chatConv.forwardError'));
    }
  };

  const handleMessageInfo = async (msg) => {
    setSelectedMsg(null);
    setMessageInfoModal({ message: msg, receipts: [], sent_at: msg.created_at, loading: true });
    try {
      const r = await api.chatMessageInfo(msg.id);
      if (r.success && r.data) {
        setMessageInfoModal(prev => prev ? { ...prev, receipts: r.data.receipts || [], sent_at: r.data.sent_at, loading: false } : null);
      } else {
        setMessageInfoModal(prev => prev ? { ...prev, loading: false } : null);
      }
    } catch {
      setMessageInfoModal(prev => prev ? { ...prev, loading: false } : null);
    }
  };

  const handleLongPress = (msg) => {
    if (msg.type === 'system' || msg.deleted_at) return;
    try { if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy); } catch {}
    setSelectedMsg(msg);
  };

  const handleCopyMessage = async (msg) => {
    setSelectedMsg(null);
    if (!msg) return;
    let textToCopy = '';
    if (msg.type === 'text' || msg.type === 'image') {
      textToCopy = msg.content || '';
    } else if (msg.type === 'file' || msg.type === 'audio' || msg.type === 'video') {
      textToCopy = msg.file_name || msg.content || '';
    } else if (msg.type === 'location') {
      textToCopy = msg.content || '';
    } else if (msg.type === 'contact') {
      textToCopy = msg.content || '';
    } else {
      textToCopy = msg.content || '';
    }
    if (!textToCopy) return;
    try {
      await Clipboard.setStringAsync(textToCopy);
      if (Platform.OS !== 'web') {
        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
      }
    } catch {}
  };

  // Context menu animation refs
  const ctxScaleAnim = useRef(new Animated.Value(0.85)).current;
  const ctxOpacityAnim = useRef(new Animated.Value(0)).current;

  const handleTranslate = async (msg) => {
    setSelectedMsg(null);
    if (!msg?.content || msg.type !== 'text' && msg.type !== 'image') return;
    const textToTranslate = msg.content;
    if (!textToTranslate.trim()) return;

    // If already translated, toggle visibility
    if (translatedMessages[msg.id]?.text) {
      setTranslatedMessages(prev => {
        const copy = { ...prev };
        delete copy[msg.id];
        return copy;
      });
      return;
    }

    // Set loading state
    setTranslatedMessages(prev => ({ ...prev, [msg.id]: { text: '', loading: true } }));
    try {
      const r = await api.translate(textToTranslate);
      if (r.success && r.data?.translation) {
        setTranslatedMessages(prev => ({ ...prev, [msg.id]: { text: r.data.translation, loading: false } }));
      } else {
        setTranslatedMessages(prev => {
          const copy = { ...prev };
          delete copy[msg.id];
          return copy;
        });
        safeAlert(t('common.error'), t('chatConv.translateError'));
      }
    } catch {
      setTranslatedMessages(prev => {
        const copy = { ...prev };
        delete copy[msg.id];
        return copy;
      });
      safeAlert(t('common.error'), t('chatConv.translateError'));
    }
  };

  // Start call from chat
  const [startingCall, setStartingCall] = useState(false);

  const startCall = async (videoEnabled) => {
    if (startingCall) return;

    // Block group calls — only direct 1-on-1 calls supported
    if (conversationType !== 'direct') {
      safeAlert(t('common.error') || 'Error', t('chat.groupCallNotSupported') || 'Chamadas em grupo ainda não são suportadas');
      return;
    }

    let otherEmail = members.find(m => m.email !== currentEmail)?.email || params.email || '';
    // If members not loaded yet, fetch them now
    if (!otherEmail) {
      try {
        const r = await api.chatMembers(conversationId);
        if (r.success && r.data?.members) {
          setMembers(r.data.members);
          otherEmail = r.data.members.find(m => m.email !== currentEmail)?.email || '';
        }
      } catch {}
    }
    if (!otherEmail) {
      safeAlert(t('common.error') || 'Error', t('chat.callError') || 'Could not start call');
      return;
    }

    setStartingCall(true);
    // Stop any playing audio before starting a call
    stopAllAudio();
    try {
      const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const otherName = conversationName || t('chat.unknown');

      // Send push notification for the call
      api.callNotify(conversationId, callId, videoEnabled).catch(() => {});

      // Navigate to call screen as caller
      router.push(`/call?callId=${callId}&contactName=${encodeURIComponent(otherName)}&contactEmail=${encodeURIComponent(otherEmail)}&isVideo=${videoEnabled ? '1' : '0'}&conversationId=${conversationId}&isCaller=1`);
    } catch (e) {
      console.warn('Start call error:', e);
      safeAlert(t('common.error') || 'Error', t('chat.callError') || 'Could not start call');
    } finally {
      setStartingCall(false);
    }
  };
  const handleStartVideoCall = () => startCall(true);
  const handleStartAudioCall = () => startCall(false);

  // Disappearing messages handler
  const handleSetDisappearing = async (timer) => {
    setShowDisappearingModal(false);
    try {
      const r = await api.chatSetDisappearing(conversationId, timer);
      if (r.success) {
        setDisappearingTimer(timer);
      }
    } catch {}
  };


  // ============================================================
  // PRESENCE SUBTITLE
  // ============================================================

  const presenceText = useMemo(() => {
    // Show typing indicator in subtitle for groups
    if (conversationType === 'group') {
      if (typingUser) {
        const typerCount = typingUsers.size;
        if (typerCount === 1) return `${typingUser} ${t('chat.typing') || 'digitando...'}`;
        return `${typingUser} ${t('chat.typingMultiple') || 'estao digitando...'}`;
      }
      return t('chatConv.group') || 'grupo';
    }
    if (presence) {
      if (presence.status === 'online') {
        return t('chatConv.online') || 'online';
      }
      if (presence.last_seen) {
        const formatted = formatLastSeen(presence.last_seen, t);
        if (formatted) return `${t('chatConv.lastSeen') || 'visto por ultimo'} ${formatted}`;
      }
    }
    return '';
  }, [conversationType, presence, typingUser, typingUsers, t]);

  const presenceColor = useMemo(() => {
    if (!presence || conversationType === 'group') return colors.textTertiary;
    if (presence.status === 'online') return '#25D366';
    if (presence.status === 'away') return '#f59e0b';
    return colors.textTertiary;
  }, [presence, conversationType, colors.textTertiary]);

  // ============================================================
  // GROUP MESSAGES BY DATE
  // ============================================================

  const messagesWithSeparators = React.useMemo(() => {
    const result = [];
    let lastDate = '';
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const ca = msg.created_at || '';
      const d = new Date(ca.endsWith('Z') || ca.includes('+') ? ca : ca + 'Z');
      const dateKey = isNaN(d.getTime()) ? 'unknown' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (dateKey !== lastDate) {
        result.push({ _type: 'separator', _key: 'sep-' + dateKey, date: msg.created_at });
        lastDate = dateKey;
      }
      // Determine if this is the last message in a group from the same sender
      const nextMsg = messages[i + 1];
      const nextCa = nextMsg?.created_at || '';
      const isLastInGroup = !nextMsg ||
        nextMsg.sender_email !== msg.sender_email ||
        nextMsg.type === 'system' ||
        msg.type === 'system' ||
        (new Date(nextCa.endsWith('Z') || nextCa.includes('+') ? nextCa : nextCa + 'Z') - d > 60000); // >1min gap = new group
      result.push({ ...msg, _isLastInGroup: isLastInGroup });
    }
    return result;
  }, [messages]);

  // Memoize reversed array to avoid re-creating every render
  const reversedMessages = useMemo(() => [...messagesWithSeparators].reverse(), [messagesWithSeparators]);

  // Enrich messages with per-item derived state so MemoizedMessageRow comparator
  // can detect changes without the render closure re-running for every message.
  const highlightedMsgId = searchResults.length > 0 && searchResults[searchIdx] ? searchResults[searchIdx].id : null;
  const enrichedMessages = useMemo(() => {
    return reversedMessages.map(item => {
      if (item._type === 'separator') return item;
      const isOwn = item.sender_email === currentEmail;
      // Read status: 0=pending, 1=sent, 2=read
      let readStatus = 1;
      if (item._pending) readStatus = 0;
      else if (item._failed) readStatus = -1;
      else if (isOwn && typeof item.id === 'number' && readReceipts.some(rr => rr.last_read_id >= item.id)) readStatus = 2;
      return {
        ...item,
        _isHighlighted: item.id === highlightedMsgId,
        _heartPop: item.id === heartPopMsg,
        _uploadPct: uploadProgress[item.id],
        _readStatus: readStatus,
      };
    });
  }, [reversedMessages, highlightedMsgId, heartPopMsg, uploadProgress, readReceipts, currentEmail]);

  // Stable key extractor
  const msgKeyExtractor = useCallback((item) => item._key || String(item.id), []);

  // Optimized scroll handler - uses ref to avoid setState on every scroll event
  const showScrollDownRef = useRef(false);
  const handleFlatListScroll = useCallback((e) => {
    const y = e.nativeEvent.contentOffset.y;
    const scrolledUp = y > 300;
    isScrolledUpRef.current = scrolledUp;
    // Only trigger setState when the value actually changes
    if (showScrollDownRef.current !== scrolledUp) {
      showScrollDownRef.current = scrolledUp;
      setShowScrollDown(scrolledUp);
    }
    if (!scrolledUp) setNewMsgCount(0);
  }, []);

  // ============================================================
  // MEDIA CACHE HELPER
  // ============================================================

  // Resolve a raw file_url to local cached path (if available) or absolute remote URL
  const resolveMediaUri = (fileUrl) => {
    if (!fileUrl) return fileUrl;
    const absolute = fileUrl.startsWith('http') ? fileUrl : `https://chatyy.com.br${fileUrl}`;
    return cachedUris[absolute] || absolute;
  };

  // ============================================================
  // RENDER MESSAGE
  // ============================================================

  // Ref to the latest renderMessage closure — used by MemoizedMessageRow
  // so that the memo wrapper never invalidates due to function identity change.
  const renderMessageRef = useRef(null);

  const renderMessage = ({ item }) => {
    if (item._type === 'separator') {
      return (
        <View style={styles.dateSeparator}>
          <Text style={[styles.dateText, { color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)', backgroundColor: isDark ? '#1F2C34' : '#E1F2DA' }]}>
            {formatDateSeparator(item.date, t)}
          </Text>
        </View>
      );
    }

    const msg = item;
    const isOwn = msg.sender_email === currentEmail;
    const isSystem = msg.type === 'system';
    const isDeleted = !!msg.deleted_at;

    if (isSystem) {
      // Check if it's a call message (JSON with call_type)
      let callData;
      try { callData = JSON.parse(msg.content); } catch {}
      if (callData?.call_type) {
        const isCaller = callData.caller_email === currentEmail;
        const isVideo = callData.call_type === 'video';
        const callLabel = isVideo
          ? (isCaller ? (t('call.videoCall') || 'Videochamada') : (t('call.incomingVideo') || 'Videochamada recebida'))
          : (isCaller ? (t('call.audioCall') || 'Chamada de voz') : (t('call.incomingAudio') || 'Chamada recebida'));
        return (
          <View style={[styles.systemMsg, { backgroundColor: colors.surface, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 8, alignSelf: 'center', maxWidth: '80%' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}>
              <View style={{
                width: 32, height: 32, borderRadius: 16,
                backgroundColor: isCaller ? '#3b82f620' : '#10b98120',
                alignItems: 'center', justifyContent: 'center',
              }}>
                {isVideo
                  ? <IconVideo size={16} color={isCaller ? '#3b82f6' : '#10b981'} />
                  : <IconPhone size={16} color={isCaller ? '#3b82f6' : '#10b981'} />}
              </View>
              <View>
                <Text style={{ fontSize: 13, fontWeight: '600', color: colors.text }}>{callLabel}</Text>
                {callData.started_at && (
                  <Text style={{ fontSize: 11, color: colors.textTertiary }}>
                    {new Date(callData.started_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </Text>
                )}
              </View>
            </View>
          </View>
        );
      }
      // Disappearing timer system messages
      if (msg.content && msg.content.startsWith('disappearing_timer:')) {
        const timerVal = msg.content.split(':')[1];
        const timerLabels = { 'off': t('chat.disappearingOff'), '24 hours': t('chat.disappearing24h'), '7 days': t('chat.disappearing7d'), '90 days': t('chat.disappearing90d') };
        const senderName = msg.sender_name || msg.sender_email?.split('@')[0] || '';
        const timerLabel = timerLabels[timerVal] || timerVal;
        const text = t('chat.disappearingChanged').replace('{name}', senderName).replace('{timer}', timerLabel);
        return (
          <View style={styles.systemMsg}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
              <IconClock size={14} color={colors.textTertiary} />
              <Text style={[styles.systemText, { color: colors.textTertiary }]}>{text}</Text>
            </View>
          </View>
        );
      }
      // Don't show raw JSON for any system message
      let displayText = msg.content;
      if (displayText && displayText.startsWith('{')) {
        try { const parsed = JSON.parse(displayText); displayText = parsed.status || parsed.message || ''; } catch {}
      }
      if (!displayText) return null;
      return (
        <View style={styles.systemMsg}>
          <Text style={[styles.systemText, { color: colors.textTertiary }]}>{displayText}</Text>
        </View>
      );
    }

    const reactionGroups = {};
    if (msg.reactions) {
      msg.reactions.forEach(r => {
        const emoji = r.emoji || r.reaction;
        if (!emoji) return;
        const users = typeof r.users === 'string' ? r.users.split(',') : (r.users || []);
        reactionGroups[emoji] = users;
      });
    }

    // Render content based on message type
    const renderContent = () => {
      if (isDeleted) {
        return (
          <Text style={[styles.deletedText, { color: isOwn ? ownMetaColor : colors.textTertiary }]}>
            {t('chatConv.deletedMessage')}
          </Text>
        );
      }

      // View-once messages
      if (msg.is_view_once) {
        const typeIcon = msg.type === 'video' ? '🎥' : msg.type === 'audio' ? '🎵' : '📷';
        const typeLabel = msg.type === 'video' ? (t('chatConv.viewOnceVideo') || 'Vídeo') : msg.type === 'audio' ? (t('chatConv.viewOnceAudio') || 'Áudio') : (t('chatConv.viewOncePhoto') || 'Foto');

        if (msg.view_once_opened && !isOwn) {
          // Already viewed — show "opened" placeholder
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
              <Text style={{ fontSize: 20 }}>🔓</Text>
              <Text style={[styles.deletedText, { color: isOwn ? ownMetaColor : colors.textTertiary }]}>
                {t('chatConv.viewOnceOpened') || 'Aberta'}
              </Text>
            </View>
          );
        }

        if (isOwn) {
          // Sender sees indicator of how many viewed
          return (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
              <Text style={{ fontSize: 20 }}>{typeIcon}</Text>
              <View>
                <Text style={{ color: '#fff', fontSize: msgFontSize, fontWeight: '500' }}>
                  {typeLabel} · {t('chatConv.viewOnce') || 'Visualização única'}
                </Text>
                {msg.view_once_viewed_count > 0 && (
                  <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12, marginTop: 2 }}>
                    {t('chatConv.viewOnceViewed') || 'Aberta'} ✓
                  </Text>
                )}
              </View>
            </View>
          );
        }

        // Recipient - show "tap to view" with anti-screenshot overlay
        const handleViewOnce = () => {
          const fileUrl = msg.file_url?.startsWith('http') ? msg.file_url : `https://chatyy.com.br${msg.file_url}`;
          setMediaViewer({
            visible: true,
            fileUrl,
            fileName: msg.file_name || typeLabel,
            fileSize: msg.file_size || 0,
            type: msg.type === 'audio' ? 'audio' : msg.type === 'video' ? 'video' : 'image',
            viewOnce: true,
            messageId: msg.id,
          });
        };

        return (
          <TouchableOpacity onPress={handleViewOnce} style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 6 }}>
            <View style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: '#25D366', alignItems: 'center', justifyContent: 'center' }}>
              <Text style={{ fontSize: 22 }}>{typeIcon}</Text>
            </View>
            <View>
              <Text style={{ color: colors.text, fontSize: msgFontSize, fontWeight: '500' }}>
                {typeLabel} · {t('chatConv.viewOnce') || 'Visualização única'}
              </Text>
              <Text style={{ color: colors.textSecondary, fontSize: 12, marginTop: 2 }}>
                {t('chatConv.tapToView') || 'Toque para ver'}
              </Text>
            </View>
          </TouchableOpacity>
        );
      }

      switch (msg.type) {
        case 'image': {
          const imgUploading = msg._uploading && msg._uploadPct !== undefined;
          const imgProgress = msg._uploadPct || 0;
          return (
            <TouchableOpacity onPress={() => !msg._uploading && msg.file_url && setMediaViewer({ visible: true, fileUrl: msg.file_url, fileName: msg.file_name || 'image', fileSize: msg.file_size || 0, type: 'image' })} activeOpacity={0.9}>
              <View>
                <ExpoImage
                  source={{ uri: msg._localUri || resolveMediaUri(msg.file_url) }}
                  style={[styles.chatImage, imgUploading && { opacity: 0.7 }]}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  transition={150}
                  blurRadius={imgUploading ? 2 : 0}
                  recyclingKey={`img-${msg.id}`}
                />
                {imgUploading && (
                  <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.3)' }}>
                    <View style={{ width: 52, height: 52, borderRadius: 26, borderWidth: 3, borderColor: 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center' }}>
                      <Svg width={52} height={52} style={{ position: 'absolute' }}>
                        <Path
                          d={`M26,3 a23,23 0 ${imgProgress > 50 ? 1 : 0},1 ${23 * Math.sin(imgProgress / 100 * 2 * Math.PI)},${23 - 23 * Math.cos(imgProgress / 100 * 2 * Math.PI)}`}
                          fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round"
                        />
                      </Svg>
                      <IconX size={18} color="#fff" />
                    </View>
                  </View>
                )}
              </View>
              {msg.content && msg.content !== msg.file_name && (
                <Text style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text, fontSize: msgFontSize, lineHeight: msgLineHeight, marginTop: 4 }]}>{msg.content}</Text>
              )}
            </TouchableOpacity>
          );
        }

        case 'video': {
          const videoUrl = msg._localUri || resolveMediaUri(msg.file_url);
          const vidUploading = msg._uploading && msg._uploadPct !== undefined;
          const vidProgress = msg._uploadPct || 0;
          return (
            <TouchableOpacity
              onPress={() => !msg._uploading && msg.file_url && setMediaViewer({ visible: true, fileUrl: msg.file_url, fileName: msg.file_name || 'video', fileSize: msg.file_size || 0, type: 'video' })}
              style={styles.videoThumb}
            >
              {Platform.OS === 'web' ? (
                <View style={styles.videoPreviewWrap}>
                  <video
                    src={videoUrl}
                    preload="metadata"
                    muted
                    playsInline
                    style={{ width: 240, height: 140, objectFit: 'cover', borderRadius: 16, backgroundColor: '#000', opacity: vidUploading ? 0.7 : 1 }}
                    onLoadedData={(e) => { try { e.target.currentTime = 0.5; } catch {} }}
                  />
                  {vidUploading ? (
                    <View style={[styles.videoOverlayAbsolute, { backgroundColor: 'rgba(0,0,0,0.3)' }]}>
                      <View style={{ width: 52, height: 52, borderRadius: 26, borderWidth: 3, borderColor: 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center' }}>
                        <Svg width={52} height={52} style={{ position: 'absolute' }}>
                          <Path
                            d={`M26,3 a23,23 0 ${vidProgress > 50 ? 1 : 0},1 ${23 * Math.sin(vidProgress / 100 * 2 * Math.PI)},${23 - 23 * Math.cos(vidProgress / 100 * 2 * Math.PI)}`}
                            fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round"
                          />
                        </Svg>
                        <IconX size={18} color="#fff" />
                      </View>
                    </View>
                  ) : (
                    <View style={styles.videoOverlayAbsolute}>
                      <View style={[styles.videoPlayBtn, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                        <IconPlay size={24} color="#fff" />
                      </View>
                    </View>
                  )}
                  {msg.file_size > 0 && !vidUploading && (
                    <View style={styles.videoDurationBadge}>
                      <Text style={styles.videoDurationText}>
                        {msg.file_size < 1048576 ? (msg.file_size / 1024).toFixed(0) + ' KB' : (msg.file_size / 1048576).toFixed(1) + ' MB'}
                      </Text>
                    </View>
                  )}
                </View>
              ) : (
                <View style={[styles.videoOverlay, vidUploading && { backgroundColor: 'rgba(0,0,0,0.3)' }]}>
                  {vidUploading ? (
                    <View style={{ width: 52, height: 52, borderRadius: 26, borderWidth: 3, borderColor: 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center' }}>
                      <Svg width={52} height={52} style={{ position: 'absolute' }}>
                        <Path
                          d={`M26,3 a23,23 0 ${vidProgress > 50 ? 1 : 0},1 ${23 * Math.sin(vidProgress / 100 * 2 * Math.PI)},${23 - 23 * Math.cos(vidProgress / 100 * 2 * Math.PI)}`}
                          fill="none" stroke="#fff" strokeWidth={3} strokeLinecap="round"
                        />
                      </Svg>
                      <IconX size={18} color="#fff" />
                    </View>
                  ) : (
                    <View style={[styles.videoPlayBtn, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
                      <IconPlay size={24} color="#fff" />
                    </View>
                  )}
                </View>
              )}
              <Text style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text, fontSize: msgFontSize, lineHeight: msgLineHeight, marginTop: 4 }]} numberOfLines={1}>
                {msg.file_name || msg.content || 'Video'}
              </Text>
            </TouchableOpacity>
          );
        }

        case 'audio': {
          const audioUploading = msg._uploading && msg._uploadPct !== undefined;
          const audioProgress = msg._uploadPct || 0;
          return (
            <View>
              <AudioPlayer
                url={msg._localUri || resolveMediaUri(msg.file_url)}
                duration={msg.duration || 0}
                isOwn={isOwn}
                colors={colors}
              />
              {audioUploading && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                  <ActivityIndicator size={10} color={isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary} />
                  <Text style={{ fontSize: 10, color: isOwn ? ownMetaColor : colors.textTertiary }}>
                    {t('chat.uploading') || 'Enviando'} {audioProgress}%
                  </Text>
                </View>
              )}
            </View>
          );
        }

        case 'location':
          return <LocationMessage content={msg.content} isOwn={isOwn} colors={colors} onOpenMap={setMapModalData} />;

        case 'contact':
          return <ContactMessage content={msg.content} isOwn={isOwn} colors={colors} t={t} />;

        case 'sticker':
          // If content is a URL (image sticker), show as Image; otherwise it's an emoji
          if (msg.file_url || (msg.content && msg.content.startsWith('http'))) {
            return (
              <ExpoImage
                source={{ uri: resolveMediaUri(msg.file_url) || msg.content }}
                style={{ width: 120, height: 120 }}
                contentFit="contain"
                cachePolicy="memory-disk"
                recyclingKey={`sticker-${msg.id}`}
              />
            );
          }
          return (
            <Text style={{ fontSize: 64, lineHeight: 72 }}>{msg.content}</Text>
          );

        case 'gif':
          return (
            <ExpoImage
              source={{ uri: msg.content }}
              style={{ width: 220, height: 180, borderRadius: 12 }}
              contentFit="cover"
              cachePolicy="memory-disk"
              recyclingKey={`gif-${msg.id}`}
              placeholder={{ blurhash: 'LKO2?U%2Tw=w]~RBVZRi};RPxuwH' }}
              transition={200}
            />
          );

        case 'meetup': {
          let meetup;
          try { meetup = JSON.parse(msg.content); } catch { meetup = null; }
          if (!meetup) return <Text style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text }]}>{msg.content}</Text>;
          const rsvpList = meetup.rsvp || {};
          const goingCount = Object.values(rsvpList).filter(v => v === 'going').length;
          const maybeCount = Object.values(rsvpList).filter(v => v === 'maybe').length;
          const myRsvp = rsvpList[currentEmail] || null;
          const meetupDate = new Date(meetup.datetime);
          const dateStr = !isNaN(meetupDate.getTime()) ? meetupDate.toLocaleString(t('_locale') || undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : meetup.datetime;
          const handleRsvp = async (status) => {
            const r = await api.chatMeetupRsvp(msg.id, status);
            if (r.success) {
              setMessages(prev => prev.map(m => {
                if (m.id !== msg.id) return m;
                const d = JSON.parse(m.content);
                d.rsvp = r.data.rsvp;
                return { ...m, content: JSON.stringify(d) };
              }));
            }
          };
          return (
            <View style={{ minWidth: 240, maxWidth: 300 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <Text style={{ fontSize: 20, marginRight: 8 }}>📍</Text>
                <Text style={{ fontWeight: '700', fontSize: msgFontSize, color: isOwn ? ownTextColor : colors.text, flex: 1 }}>{meetup.title}</Text>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                <IconClock size={14} color={isOwn ? 'rgba(255,255,255,0.7)' : colors.textSecondary} />
                <Text style={{ fontSize: 13, color: isOwn ? ownMetaColor : colors.textSecondary }}>{dateStr}</Text>
              </View>
              {meetup.location ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <IconMapPin size={14} color={isOwn ? 'rgba(255,255,255,0.7)' : colors.textSecondary} />
                  <Text style={{ fontSize: 13, color: isOwn ? ownMetaColor : colors.textSecondary }}>{meetup.location}</Text>
                </View>
              ) : null}
              {meetup.description ? (
                <Text style={{ fontSize: 13, color: isOwn ? ownMetaColor : colors.textTertiary, marginBottom: 6 }}>{meetup.description}</Text>
              ) : null}
              <Text style={{ fontSize: 11, color: isOwn ? ownMetaColor : colors.textTertiary, marginBottom: 8 }}>
                ✅ {goingCount} {t('chatConv.going') || 'vão'}{maybeCount > 0 ? `  🤔 ${maybeCount} ${t('chatConv.maybe') || 'talvez'}` : ''}
              </Text>
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {['going', 'maybe', 'not_going'].map(status => {
                  const labels = { going: t('chatConv.imGoing') || 'Vou!', maybe: t('chatConv.imMaybe') || 'Talvez', not_going: t('chatConv.imNotGoing') || 'Não vou' };
                  const icons = { going: '✅', maybe: '🤔', not_going: '❌' };
                  const active = myRsvp === status;
                  return (
                    <TouchableOpacity
                      key={status}
                      onPress={() => handleRsvp(status)}
                      style={{
                        flex: 1, paddingVertical: 6, borderRadius: 8, alignItems: 'center',
                        backgroundColor: active ? (isOwn ? 'rgba(255,255,255,0.25)' : colors.primary + '20') : (isOwn ? 'rgba(255,255,255,0.1)' : colors.border + '40'),
                      }}
                    >
                      <Text style={{ fontSize: 14 }}>{icons[status]}</Text>
                      <Text style={{ fontSize: 10, color: isOwn ? ownTextColor : colors.text, fontWeight: active ? '700' : '400', marginTop: 2 }}>{labels[status]}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
            </View>
          );
        }

        case 'playlist': {
          let playlist;
          try { playlist = JSON.parse(msg.content); } catch { playlist = null; }
          if (!playlist) return <Text style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text }]}>{msg.content}</Text>;
          const songs = playlist.songs || [];
          return (
            <View style={{ minWidth: 240, maxWidth: 300 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <Text style={{ fontSize: 20, marginRight: 8 }}>🎵</Text>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: msgFontSize, color: isOwn ? ownTextColor : colors.text }}>{playlist.playlist_name}</Text>
                  <Text style={{ fontSize: 11, color: isOwn ? ownMetaColor : colors.textTertiary }}>
                    {songs.length} {songs.length === 1 ? (t('chatConv.song') || 'música') : (t('chatConv.songs') || 'músicas')} · {t('chatConv.by') || 'por'} {playlist.created_by_name}
                  </Text>
                </View>
              </View>
              {songs.slice(0, 5).map((song, idx) => (
                <View key={idx} style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 4, gap: 8 }}>
                  <Text style={{ fontSize: 12, color: isOwn ? ownMetaColor : colors.textTertiary, width: 18, textAlign: 'right' }}>{idx + 1}</Text>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 13, color: isOwn ? ownTextColor : colors.text, fontWeight: '500' }} numberOfLines={1}>{song.title}</Text>
                    {song.artist ? <Text style={{ fontSize: 11, color: isOwn ? ownMetaColor : colors.textTertiary }} numberOfLines={1}>{song.artist}</Text> : null}
                  </View>
                  {song.url ? (
                    <TouchableOpacity onPress={() => Linking.openURL(song.url)} style={{ padding: 4 }}>
                      <IconPlay size={14} color={isOwn ? 'rgba(255,255,255,0.7)' : colors.primary} />
                    </TouchableOpacity>
                  ) : null}
                </View>
              ))}
              {songs.length > 5 && (
                <Text style={{ fontSize: 11, color: isOwn ? ownMetaColor : colors.textTertiary, marginTop: 4, textAlign: 'center' }}>
                  +{songs.length - 5} {t('chatConv.moreSongs') || 'mais'}
                </Text>
              )}
              {songs.length === 0 && (
                <Text style={{ fontSize: 12, color: isOwn ? ownMetaColor : colors.textTertiary, fontStyle: 'italic', textAlign: 'center', paddingVertical: 8 }}>
                  {t('chatConv.emptyPlaylist') || 'Playlist vazia - adicione músicas!'}
                </Text>
              )}
            </View>
          );
        }

        case 'file':
          return (
            <TouchableOpacity
              onPress={() => msg.file_url && setMediaViewer({ visible: true, fileUrl: msg.file_url, fileName: msg.file_name || msg.content || 'file', fileSize: msg.file_size || 0, type: 'file' })}
              style={styles.fileAttach}
            >
              <IconFileText size={20} color={isOwn ? 'rgba(255,255,255,0.8)' : colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text, fontSize: msgFontSize, lineHeight: msgLineHeight }]} numberOfLines={1}>{msg.file_name || msg.content}</Text>
                {msg.file_size > 0 && (
                  <Text style={{ fontSize: 11, color: isOwn ? ownMetaColor : colors.textTertiary }}>
                    {msg.file_size < 1048576 ? (msg.file_size / 1024).toFixed(0) + ' KB' : (msg.file_size / 1048576).toFixed(1) + ' MB'}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          );

        case 'poll': {
          const poll = msg.poll;
          if (!poll) return <Text style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text }]}>{msg.content}</Text>;
          const handleVote = async (optIdx) => {
            const r = await api.chatVotePoll(poll.id, optIdx);
            if (r.success) {
              setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, poll: { ...m.poll, vote_counts: r.data.vote_counts, total_votes: r.data.total_votes, my_votes: r.data.my_votes } } : m));
            }
          };
          return (
            <View style={{ minWidth: 220, maxWidth: 280 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8 }}>
                <IconBarChart size={16} color={isOwn ? 'rgba(255,255,255,0.7)' : colors.primary} style={{ marginRight: 6 }} />
                <Text style={{ fontWeight: '700', fontSize: msgFontSize, color: isOwn ? ownTextColor : colors.text, flex: 1 }}>{poll.question}</Text>
              </View>
              {poll.multiple_choice && (
                <Text style={{ fontSize: 11, color: isOwn ? ownMetaColor : colors.textTertiary, marginBottom: 6 }}>
                  {t('chat.pollMultiple')}
                </Text>
              )}
              {poll.options.map((opt, idx) => {
                const voted = poll.my_votes?.includes(idx);
                const count = poll.vote_counts?.[idx] || 0;
                const pct = poll.total_votes > 0 ? Math.round((count / poll.total_votes) * 100) : 0;
                return (
                  <TouchableOpacity key={idx} onPress={() => handleVote(idx)} activeOpacity={0.7}
                    style={{ marginBottom: 6, borderRadius: 8, overflow: 'hidden', backgroundColor: isOwn ? 'rgba(255,255,255,0.1)' : colors.border + '30' }}>
                    <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, backgroundColor: voted ? (isOwn ? 'rgba(255,255,255,0.25)' : colors.primary + '30') : (isOwn ? 'rgba(255,255,255,0.1)' : colors.border + '40'), borderRadius: 8 }} />
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 10, paddingVertical: 8 }}>
                      {voted && <IconCheck size={14} color={isOwn ? '#fff' : colors.primary} style={{ marginRight: 6 }} />}
                      <Text style={{ flex: 1, fontSize: msgFontSize - 1, color: isOwn ? ownTextColor : colors.text, fontWeight: voted ? '600' : '400' }}>{opt}</Text>
                      <Text style={{ fontSize: 12, color: isOwn ? 'rgba(255,255,255,0.6)' : colors.textSecondary, marginLeft: 8 }}>{pct}%</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              <Text style={{ fontSize: 11, color: isOwn ? ownMetaColor : colors.textTertiary, marginTop: 2 }}>
                {(t('chat.pollVotes') || '{n} votos').replace('{n}', poll.total_votes)}
              </Text>
            </View>
          );
        }

        default: { // text
          // Detect GIF URLs (from Tenor, Giphy, or direct .gif links) — render as image instead of text
          const contentTrimmed = (msg.content || '').trim();
          const isGifUrl = contentTrimmed && /^https?:\/\//.test(contentTrimmed) && (
            contentTrimmed.includes('tenor.com') ||
            contentTrimmed.includes('giphy.com') ||
            /\.gif(\?.*)?$/i.test(contentTrimmed)
          );
          if (isGifUrl) {
            return (
              <ExpoImage
                source={{ uri: contentTrimmed }}
                style={{ width: 200, height: 200, borderRadius: 16 }}
                contentFit="contain"
                cachePolicy="memory-disk"
                recyclingKey={`gif-text-${msg.id}`}
              />
            );
          }

          // Detect old-style call messages: "Chamada de Voz\nEntrar: https://..."
          const callMatch = msg.content && /^(Chamada de Voz|Videochamada|Voice Call|Video Call)\n/i.test(msg.content);
          if (callMatch) {
            const isVideo = /^(Videochamada|Video Call)/i.test(msg.content);
            const roomMatch = msg.content.match(/meet\/([a-z0-9-]+)/i);
            return (
              <TouchableOpacity
                onPress={() => roomMatch?.[1] && router.push(`/meet/${roomMatch[1]}${isVideo ? '' : '?video=off'}`)}
                activeOpacity={0.7}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 2 }}
              >
                <View style={{
                  width: 32, height: 32, borderRadius: 16,
                  backgroundColor: isOwn ? 'rgba(255,255,255,0.15)' : '#3b82f620',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {isVideo
                    ? <IconVideo size={16} color={isOwn ? '#fff' : '#3b82f6'} />
                    : <IconPhone size={16} color={isOwn ? '#fff' : '#3b82f6'} />
                  }
                </View>
                <View>
                  <Text style={{ fontSize: 13, fontWeight: '600', color: isOwn ? ownTextColor : colors.text }}>
                    {isVideo ? 'Videochamada' : 'Chamada de voz'}
                  </Text>
                  <Text style={{ fontSize: 11, color: isOwn ? ownMetaColor : colors.textTertiary }}>
                    Toque para entrar
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }
          const urlMatch = msg.content && msg.content.match(URL_REGEX);
          const firstUrl = urlMatch ? urlMatch[0] : null;
          const msgTranslation = translatedMessages[msg.id];
          return (
            <View>
              <TextWithLinks
                text={msg.content}
                style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text, fontSize: msgFontSize, lineHeight: msgLineHeight }]}
                linkColor={isOwn ? '#53BDEB' : colors.primary}
                mentionColor={isOwn ? '#53BDEB' : '#1a73e8'}
                colors={colors}
              />
              {msgTranslation && (
                <View style={{ marginTop: 4, paddingTop: 4, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: isOwn ? 'rgba(255,255,255,0.2)' : colors.border }}>
                  {msgTranslation.loading ? (
                    <Text style={{ fontSize: 12, fontStyle: 'italic', color: isOwn ? ownMetaColor : colors.textTertiary }}>
                      {t('chatConv.translating')}
                    </Text>
                  ) : (
                    <View>
                      <Text style={{ fontSize: 10, fontWeight: '600', color: isOwn ? ownMetaColor : colors.textTertiary, marginBottom: 2, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                        {t('chatConv.translated')}
                      </Text>
                      <Text style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text, fontSize: msgFontSize, lineHeight: msgLineHeight }]}>
                        {msgTranslation.text}
                      </Text>
                    </View>
                  )}
                </View>
              )}
              {firstUrl && <LinkPreview url={firstUrl} colors={colors} />}
            </View>
          );
        }
      }
    };

    const isLastInGroup = msg._isLastInGroup !== false;

    return (
      <MessageSendAnim animate={!!msg._pending}>
      <SwipeReplyWrap
        disabled={isDeleted || isSystem}
        onReply={() => { setReplyTo(msg); inputRef.current?.focus(); }}
        onInfo={isOwn && !isDeleted ? () => handleMessageInfo(msg) : null}
        colors={colors}
        style={{ marginBottom: isLastInGroup ? 8 : 2 }}
      >
        <TouchableOpacity
          activeOpacity={0.8}
          onPress={() => handleDoubleTap(msg)}
          onLongPress={() => handleLongPress(msg)}
          style={[styles.msgRow, isOwn ? styles.msgRowOwn : styles.msgRowOther]}
        >
          {!isOwn && conversationType === 'group' && !isDeleted && isLastInGroup && (() => {
            // Generate consistent color from email hash (WhatsApp-style colored names)
            const senderColors = ['#25D366', '#53BDEB', '#E6A919', '#FF6B6B', '#9B59B6', '#E67E22', '#2ECC71', '#3498DB', '#E91E63', '#00BCD4'];
            const emailHash = (msg.sender_email || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            const senderColor = senderColors[emailHash % senderColors.length];
            return (
              <View style={styles.msgSenderRow}>
                <TouchableOpacity activeOpacity={0.7} onPress={() => setProfileViewer({ name: msg.sender_name || msg.sender_email, email: msg.sender_email })}>
                  <AvatarCircle name={msg.sender_name || msg.sender_email} email={msg.sender_email} size={28} style={{ marginRight: 6 }} />
                </TouchableOpacity>
                <Text style={[styles.msgSender, { color: senderColor }]}>
                  {msg.sender_name || msg.sender_email.split('@')[0]}
                </Text>
              </View>
            );
          })()}

          <View style={[
            styles.bubble,
            isOwn
              ? [styles.bubbleOwn, { backgroundColor: isDark ? '#005C4B' : '#DCF8C6' },
                 isLastInGroup && { borderBottomRightRadius: 2 },
                 ]
              : [styles.bubbleOther, { backgroundColor: isUserMentioned(msg, currentEmail) ? (isDark ? '#1a3a2a' : '#d9f2e6') : (isDark ? '#1F2C34' : '#FFFFFF') },
                 isLastInGroup && { borderBottomLeftRadius: 2 },
                 ],
            !isLastInGroup && { borderRadius: 22 },
            isDeleted && styles.bubbleDeleted,
            (msg.type === 'sticker' || msg.type === 'gif') && { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, elevation: 0 },
            msg._pending && { opacity: 0.7 },
            msg._failed && { opacity: 0.5 },
            msg._isHighlighted && { borderWidth: 2, borderColor: '#f59e0b' },
          ]}>
          {msg._heartPop && (
            <Animated.View pointerEvents="none" style={{ position: 'absolute', top: '30%', left: '35%', zIndex: 99, transform: [{ scale: heartScale }], opacity: heartOpacity }}>
              <Text style={{ fontSize: 48 }}>❤️</Text>
            </Animated.View>
          )}
          {msg.reply_to && !isDeleted && (() => {
            const replySenderColors = ['#25D366', '#53BDEB', '#E6A919', '#FF6B6B', '#9B59B6', '#E67E22', '#2ECC71', '#3498DB', '#E91E63', '#00BCD4'];
            const replyHash = (msg.reply_to?.sender_email || msg.reply_to?.sender_name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
            const replySenderColor = replySenderColors[replyHash % replySenderColors.length];
            return (
              <TouchableOpacity
                activeOpacity={0.7}
                onPress={() => {
                  const replyMsg = messages.find(m => m.id === msg.reply_to?.id);
                  if (replyMsg) {
                    try { flatListRef.current?.scrollToItem?.({ item: replyMsg, animated: true }); } catch {}
                  }
                }}
                style={[styles.replyIndicator, {
                  backgroundColor: isOwn ? 'rgba(255,255,255,0.12)' : (isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'),
                  borderLeftColor: replySenderColor,
                }]}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.replyName, { color: replySenderColor }]} numberOfLines={1}>
                      {msg.reply_to?.sender_name || t('chat.unknown')}
                    </Text>
                    <Text style={[styles.replyText, { color: isOwn ? ownMetaColor : colors.textSecondary }]} numberOfLines={2}>
                      {msg.reply_to.type === 'image' ? ('\uD83D\uDCF7 ' + (t('chat.photo') || 'Foto'))
                        : msg.reply_to.type === 'video' ? ('\uD83C\uDFA5 ' + (t('chat.video') || 'Video'))
                        : msg.reply_to.type === 'audio' ? ('\uD83C\uDFA4 ' + (t('chat.audio') || 'Audio'))
                        : (msg.reply_to.content || '')}
                    </Text>
                  </View>
                  {(msg.reply_to.type === 'image' || msg.reply_to.type === 'video') && msg.reply_to.file_url && (
                    <Image
                      source={{ uri: msg.reply_to.file_url.startsWith('http') ? msg.reply_to.file_url : `https://chatyy.com.br${msg.reply_to.file_url}` }}
                      style={{ width: 36, height: 36, borderRadius: 4, marginLeft: 8 }}
                      resizeMode="cover"
                    />
                  )}
                </View>
              </TouchableOpacity>
            );
          })()}
          {renderContent()}
          {msg.type !== 'sticker' && msg.type !== 'gif' && (
            <View style={styles.msgMeta}>
              {disappearingTimer > 0 && <IconClock size={10} color={isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary} style={{ marginRight: 2 }} />}
              {msg.starred && !isDeleted && (
                <IconStarFilled size={10} color={isOwn ? 'rgba(255,255,255,0.7)' : '#f59e0b'} style={{ marginRight: 2 }} />
              )}
              {msg._e2e && (
                <IconLock size={10} color={isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary} style={{ marginRight: 2 }} />
              )}
              {msg.edited_at && !isDeleted && (
                <Text style={[styles.editedLabel, { color: isOwn ? ownMetaColor : colors.textTertiary }]}>
                  {t('chatConv.edited')}
                </Text>
              )}
              <Text style={[styles.msgTime, { color: isOwn ? ownMetaColor : colors.textTertiary }]}>
                {formatTime(msg.created_at)}
              </Text>
              {isOwn && !isDeleted && (() => {
                if (msg._failed) return (
                  <TouchableOpacity
                    onPress={async () => {
                      // Retry failed text messages
                      if (msg.type === 'text' && msg.content) {
                        setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, _failed: false, _pending: true } : m));
                        try {
                          const r = await api.chatSend(conversationId, msg.content, 'text', msg.reply_to_id);
                          if (r.success && r.data?.id) {
                            setMessages(prev => prev.map(m => m.id === msg.id ? { ...r.data, _pending: false } : m));
                          } else {
                            setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, _failed: true, _pending: false } : m));
                          }
                        } catch {
                          setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, _failed: true, _pending: false } : m));
                        }
                      }
                    }}
                    style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2, gap: 2 }}
                    accessibilityLabel={t('chat.retry') || 'Tentar novamente'}
                  >
                    <IconAlertTriangle size={12} color="#EF4444" />
                  </TouchableOpacity>
                );
                if (msg._pending) return (
                  <IconClock size={12} color={ownMetaColor} style={{ marginLeft: 2 }} />
                );
                // WhatsApp-style message status:
                // Single gray check = sent (server has it)
                // Double gray checks = delivered (recipient received it)
                // Double blue checks = read
                const isRead = msg._readStatus === 2;
                if (isRead) {
                  // Gradient blue double ticks - read
                  return (
                    <View style={{ flexDirection: 'row', marginLeft: 3 }}>
                      <IconCheck size={13} color="#53BDEB" style={{ marginRight: -6 }} />
                      <IconCheck size={13} color="#53BDEB" />
                    </View>
                  );
                }
                // Gray double ticks - delivered (server confirmed, not yet read)
                return (
                  <View style={{ flexDirection: 'row', marginLeft: 2 }}>
                    <IconCheck size={12} color={ownMetaColor} style={{ marginRight: -6 }} />
                    <IconCheck size={12} color={ownMetaColor} />
                  </View>
                );
              })()}
            </View>
          )}
        </View>

        {Object.keys(reactionGroups).length > 0 && !isDeleted && (
          <Animated.View style={[styles.reactionsRow, isOwn && styles.reactionsRowOwn, reactionBounceId === msg.id && { transform: [{ scale: reactionBounceScale }] }]}>
            {Object.entries(reactionGroups).map(([emoji, users]) => (
              <TouchableOpacity
                key={emoji}
                onPress={() => setReactionDetail({ emoji, reactors: users.map(u => ({ email: u, name: emailToDisplayName(u) })) })}
                onLongPress={() => handleReact(msg.id, emoji)}
                delayLongPress={400}
                style={[styles.reactionChip, {
                  backgroundColor: users.includes(currentEmail) ? colors.primary + '20' : colors.surface,
                  borderColor: users.includes(currentEmail) ? colors.primary : colors.border,
                }]}
              >
                {(() => { const RIcon = REACTION_ICON_MAP[emoji]; return RIcon ? <RIcon size={14} color={colors.text} /> : <Text style={styles.reactionEmoji}>{REACTION_EMOJI_MAP[emoji] || emoji}</Text>; })()}
                <Text style={[styles.reactionCount, { color: colors.text }]}>{users.length}</Text>
              </TouchableOpacity>
            ))}
          </Animated.View>
        )}
        </TouchableOpacity>
      </SwipeReplyWrap>
      </MessageSendAnim>
    );
  };

  // Keep ref pointing at the latest renderMessage closure
  renderMessageRef.current = (item) => renderMessage({ item });

  // Stable renderItem for FlatList — delegates to MemoizedMessageRow
  const memoizedRenderItem = useCallback(({ item }) => (
    <MemoizedMessageRow item={item} renderRef={renderMessageRef} />
  ), []); // eslint-disable-line react-hooks/exhaustive-deps

  // ============================================================
  // RENDER
  // ============================================================

  // Lock screen
  if (chatLocked && !chatUnlocked) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <View style={[styles.header, { backgroundColor: isDark ? '#1F2C33' : '#075E54', paddingTop: insets.top, position: 'absolute', top: 0, left: 0, right: 0 }]}>
          <TouchableOpacity onPress={() => { Keyboard.dismiss(); router.back(); }} style={styles.headerBtn}>
            <IconArrowLeft size={22} color="#fff" />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <Text style={[styles.headerTitle, { color: '#fff' }]} numberOfLines={1}>{conversationName}</Text>
          </View>
        </View>
        <IconLock size={48} color={colors.textTertiary} />
        <Text style={{ color: colors.text, fontSize: 18, fontWeight: '600', marginTop: 16, marginBottom: 8 }}>
          {t('chatConv.chatLocked') || 'Chat Locked'}
        </Text>
        <Text style={{ color: colors.textSecondary, fontSize: 14, marginBottom: 24, textAlign: 'center', paddingHorizontal: 40 }}>
          {t('chatConv.enterPasswordToUnlock') || 'Enter password to unlock this chat'}
        </Text>
        <TextInput
          style={{
            width: 240, height: 44, borderRadius: 12,
            backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
            paddingHorizontal: 16, color: colors.text, fontSize: 16, textAlign: 'center',
          }}
          placeholder="••••"
          placeholderTextColor={colors.textTertiary}
          secureTextEntry
          value={lockPassInput}
          onChangeText={setLockPassInput}
          onSubmitEditing={() => handleUnlockChat(lockPassInput)}
        />
        <TouchableOpacity
          style={{ marginTop: 16, backgroundColor: colors.primary, paddingHorizontal: 32, paddingVertical: 12, borderRadius: 12 }}
          onPress={() => handleUnlockChat(lockPassInput)}
        >
          <Text style={{ color: '#fff', fontWeight: '600', fontSize: 15 }}>{t('chatConv.unlock') || 'Unlock'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View
      style={[styles.container, { backgroundColor: isDark ? '#0B141A' : '#ECE5DD' }]}
    >
      {/* Header with presence */}
      <View style={[styles.header, { backgroundColor: isDark ? '#1F2C33' : '#075E54', paddingTop: insets.top }]}>
        <TouchableOpacity onPress={() => { Keyboard.dismiss(); router.back(); }} style={styles.headerBtn} accessibilityLabel={t('common.back') || 'Back'} accessibilityRole="button">
          <IconArrowLeft size={22} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.headerInfo, { flexDirection: 'row', alignItems: 'center', gap: 10 }]} onPress={() => {
          if (conversationType === 'group') {
            setEditGroupName(conversationName);
            loadGroupMembers();
            setShowGroupInfo(true);
          }
        }}>
          <TouchableOpacity activeOpacity={0.7} onPress={() => {
            const email = conversationType === 'direct' ? (params.email || '') : null;
            setProfileViewer({ name: conversationName, email });
          }}>
          <View style={{ position: 'relative' }}>
            <AvatarCircle
              name={conversationName}
              email={conversationType === 'direct' ? (params.email || '') : null}
              size={38}
            />
            {presence?.status === 'online' && conversationType === 'direct' && (
              <View style={{
                position: 'absolute', bottom: 0, right: 0,
                width: 12, height: 12, borderRadius: 6,
                backgroundColor: '#25D366', borderWidth: 2, borderColor: isDark ? '#1F2C34' : '#fff',
              }} />
            )}
          </View>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={[styles.headerTitle, { color: '#fff' }]} numberOfLines={1}>
                {conversationName}
              </Text>
              {e2eEnabled && <IconLock size={13} color="#a5f3d8" />}
            </View>
            {(presenceText !== '') && (
              <Text style={[styles.headerSubtitle, { color: presenceColor === '#25D366' ? '#25D366' : 'rgba(255,255,255,0.7)' }]} numberOfLines={1}>
                {presenceText}
              </Text>
            )}
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleStartAudioCall} disabled={startingCall} style={styles.headerBtn} accessibilityLabel={t('call.callingAudio') || 'Audio call'} accessibilityRole="button">
          <IconPhone size={19} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity onPress={handleStartVideoCall} disabled={startingCall} style={styles.headerBtn} accessibilityLabel={t('call.callingVideo') || 'Video call'} accessibilityRole="button">
          {startingCall
            ? <ActivityIndicator size="small" color="#fff" />
            : <IconVideo size={20} color="#fff" />}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowHeaderMenu(true)} style={styles.headerBtn} accessibilityLabel={t('common.more') || 'More options'} accessibilityRole="button">
          <IconMoreVert size={20} color="#fff" />
        </TouchableOpacity>
      </View>

      {/* E2E Encryption Banner */}
      {e2eEnabled && (
        <TouchableOpacity
          onPress={async () => {
            if (conversationType === 'direct') {
              const myPub = await e2eService.getPublicKeyBase64();
              const otherEmail = params.email || '';
              const otherPub = e2eKeys?.[otherEmail];
              if (otherPub) {
                const safetyNumber = e2eService.generateSafetyNumber(myPub, otherPub);
                safeAlert(
                  t('chatConv.securityCode') || 'Security Code',
                  `${safetyNumber}\n\n${t('chatConv.securityCodeDesc') || 'Compare this code with the other person to verify the encryption is secure.'}`,
                );
              }
            } else {
              safeAlert(
                t('chatConv.e2eEnabled') || 'End-to-End Encryption',
                t('chatConv.e2eGroupDesc') || 'Messages in this conversation are end-to-end encrypted. Only participants can read them.',
              );
            }
          }}
          style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            paddingVertical: 6, paddingHorizontal: 16, backgroundColor: isDark ? 'rgba(255,255,255,0.03)' : 'rgba(37,211,102,0.04)', gap: 6,
          }}
        >
          <IconLock size={11} color={isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)'} />
          <Text style={{ fontSize: 11, color: isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.35)' }}>
            {t('chatConv.e2eBanner') || 'Messages are end-to-end encrypted. Tap to verify.'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Chat wallpaper */}
      {Platform.OS === 'web' && wallpaperColor === 'none' && (
        <View style={[styles.wallpaper, { opacity: isDark ? 0.03 : 0.04, backgroundColor: isDark ? '#0B141A' : '#ECE5DD' }]} pointerEvents="none">
          <View style={styles.wallpaperPattern} />
        </View>
      )}
      {wallpaperColor !== 'none' && wallpaperColor.startsWith('#') && (
        <View style={[styles.wallpaper, { backgroundColor: wallpaperColor, opacity: 0.15 }]} pointerEvents="none" />
      )}
      {wallpaperColor !== 'none' && !wallpaperColor.startsWith('#') && (
        <Image source={{ uri: wallpaperColor }} style={[styles.wallpaper, { opacity: isDark ? 0.15 : 0.2 }]} resizeMode="cover" pointerEvents="none" />
      )}

      {/* Disappearing messages banner */}
      {disappearingTimer > 0 && (
        <TouchableOpacity
          style={[styles.disappearingBanner, { backgroundColor: isDark ? 'rgba(16,185,129,0.15)' : 'rgba(16,185,129,0.1)' }]}
          onPress={() => setShowDisappearingModal(true)}
          activeOpacity={0.7}
        >
          <IconClock size={14} color="#10b981" />
          <Text style={[styles.disappearingBannerText, { color: isDark ? '#6ee7b7' : '#047857' }]}>
            {t('chat.disappearingActive') || 'Mensagens temporárias ativadas'} · {disappearingTimer <= 300 ? '5min' : disappearingTimer <= 3600 ? '1h' : disappearingTimer <= 86400 ? '24h' : disappearingTimer <= 604800 ? '7d' : '90d'}
          </Text>
          <Text style={[styles.disappearingBannerAction, { color: colors.primary }]}>
            {t('chat.disappearingChange') || 'Alterar'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Search within conversation */}
      {showSearchBar && (
        <View style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, paddingHorizontal: 12, paddingVertical: 6, gap: 8 }}>
          <TextInput
            ref={searchInputRef}
            value={searchQuery}
            onChangeText={handleSearchMessages}
            placeholder={t('chat.searchPlaceholder') || 'Search...'}
            placeholderTextColor={colors.textTertiary}
            style={{ flex: 1, fontSize: 14, color: colors.text, paddingVertical: 6, paddingHorizontal: 10, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)', borderRadius: 18 }}
            autoFocus
            returnKeyType="search"
          />
          {searchResults.length > 0 && (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={{ fontSize: 12, color: colors.textSecondary }}>{searchIdx + 1}/{searchResults.length}</Text>
              <TouchableOpacity onPress={() => handleSearchNav('up')} style={{ padding: 4 }}>
                <IconChevronDown size={16} color={colors.text} style={{ transform: [{ rotate: '180deg' }] }} />
              </TouchableOpacity>
              <TouchableOpacity onPress={() => handleSearchNav('down')} style={{ padding: 4 }}>
                <IconChevronDown size={16} color={colors.text} />
              </TouchableOpacity>
            </View>
          )}
          <TouchableOpacity onPress={() => { setShowSearchBar(false); setSearchQuery(''); setSearchResults([]); }} style={{ padding: 4 }}>
            <IconX size={18} color={colors.textSecondary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Connection status banner - WhatsApp-style */}
      {!wsConnected && (
        <View style={{
          flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
          paddingVertical: 6, backgroundColor: isDark ? '#332200' : '#FEF3C7', gap: 6,
        }}>
          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#F59E0B' }} />
          <Text style={{ fontSize: 12, color: isDark ? '#FCD34D' : '#92400E', fontWeight: '500' }}>
            {t('chat.reconnecting') || 'Reconectando...'}
          </Text>
        </View>
      )}

      {/* Pinned message banner */}
      {pinnedMessages.length > 0 && showPinnedBanner && !showSearchBar && (
        <TouchableOpacity
          activeOpacity={0.7}
          onPress={() => {
            const pinned = pinnedMessages[0];
            if (pinned) flatListRef.current?.scrollToItem?.({ item: pinned, animated: true });
          }}
          style={{ flexDirection: 'row', alignItems: 'center', backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.03)', paddingVertical: 8, paddingHorizontal: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border, gap: 8 }}
        >
          <IconStar size={14} color="#f59e0b" />
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 11, color: '#f59e0b', fontWeight: '600' }}>{t('chatConv.pinnedMessage') || 'Mensagem fixada'}</Text>
            <Text style={{ fontSize: 12, color: colors.textSecondary }} numberOfLines={1}>{pinnedMessages[0].content}</Text>
          </View>
          <TouchableOpacity onPress={() => setShowPinnedBanner(false)} style={{ padding: 4 }}>
            <IconX size={14} color={colors.textSecondary} />
          </TouchableOpacity>
        </TouchableOpacity>
      )}

      {/* Messages */}
      {loading && messages.length === 0 ? (
        <View style={styles.loaderWrap} />
      ) : (
        <FlatList
          ref={flatListRef}
          data={enrichedMessages}
          inverted
          keyExtractor={msgKeyExtractor}
          renderItem={memoizedRenderItem}
          contentContainerStyle={[styles.messageList, { paddingTop: Spacing.sm }]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          bounces={false}
          overScrollMode="never"
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.3}
          onScroll={handleFlatListScroll}
          scrollEventThrottle={16}
          ListHeaderComponent={
            typingUser ? <TypingBubble name={typingUser} colors={colors} recording={typingIsRecording} t={t} /> : null
          }
          ListFooterComponent={
            loadingMore ? (
              <View style={styles.loadMoreBtn}>
                <ActivityIndicator size="small" color={colors.primary} />
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyMessages}>
              <View style={{
                width: 80, height: 80, borderRadius: 40, backgroundColor: isDark ? 'rgba(37,211,102,0.08)' : 'rgba(37,211,102,0.06)',
                alignItems: 'center', justifyContent: 'center', marginBottom: 16, transform: [{ scaleY: -1 }],
              }}>
                <IconLock size={32} color={isDark ? 'rgba(37,211,102,0.4)' : 'rgba(37,211,102,0.35)'} />
              </View>
              <Text style={[{ fontSize: 13, textAlign: 'center', lineHeight: 20, paddingHorizontal: 40 }, { color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.35)' }]}>
                {e2eEnabled
                  ? (t('chatConv.e2eEmpty') || 'Mensagens protegidas com criptografia de ponta a ponta. Ninguem fora desta conversa pode ler.')
                  : (t('chatConv.empty') || 'Envie uma mensagem para iniciar a conversa')}
              </Text>
            </View>
          }
          // Performance optimizations
          removeClippedSubviews={Platform.OS !== 'web'}
        />
      )}

      {/* Reply/Edit indicator */}
      {(replyTo || editingMsg) && (
        <View style={[styles.replyBar, { backgroundColor: isDark ? colors.surface : colors.surface + 'F5', borderTopColor: colors.border }]}>
          <View style={[styles.replyBarLine, { backgroundColor: '#25D366' }]} />
          <View style={[styles.replyBarContent, { flexDirection: 'row', alignItems: 'center', gap: 8 }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.replyBarLabel, { color: colors.primary }]}>
                {editingMsg ? t('chat.editing') : t('chat.replyingTo', { name: replyTo?.sender_name || t('chat.message') })}
              </Text>
              <Text style={[styles.replyBarText, { color: colors.textSecondary }]} numberOfLines={1}>
                {editingMsg ? editingMsg.content
                  : replyTo?.type === 'image' ? ('\uD83D\uDCF7 ' + (t('chat.photo') || 'Foto'))
                  : replyTo?.type === 'video' ? ('\uD83C\uDFA5 ' + (t('chat.video') || 'Video'))
                  : replyTo?.type === 'audio' ? ('\uD83C\uDFA4 ' + (t('chat.audio') || 'Audio'))
                  : replyTo?.type === 'file' ? ('\uD83D\uDCCE ' + (replyTo?.file_name || replyTo?.content || t('chat.file') || 'Arquivo'))
                  : (replyTo?.content || '')}
              </Text>
            </View>
            {!editingMsg && (replyTo?.type === 'image' || replyTo?.type === 'video') && replyTo?.file_url && (
              <Image
                source={{ uri: replyTo.file_url.startsWith('http') ? replyTo.file_url : `https://chatyy.com.br${replyTo.file_url}` }}
                style={{ width: 40, height: 40, borderRadius: 6 }}
                resizeMode="cover"
              />
            )}
          </View>
          <TouchableOpacity
            onPress={() => { setReplyTo(null); setEditingMsg(null); setInputText(''); }}
            style={styles.replyBarClose}
          >
            <IconX size={18} color={colors.textTertiary} />
          </TouchableOpacity>
        </View>
      )}

      {/* Upload indicator */}
      {uploading && (
        <View style={[styles.uploadBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          <ActivityIndicator size="small" color={colors.primary} />
          <Text style={[styles.uploadText, { color: colors.textSecondary }]}>{t('chatConv.sending') || 'Sending...'}</Text>
        </View>
      )}

      {/* Scroll to bottom FAB */}
      {showScrollDown && (
        <TouchableOpacity
          onPress={() => {
            flatListRef.current?.scrollToOffset({ offset: 0, animated: true });
            setShowScrollDown(false);
            setNewMsgCount(0);
          }}
          style={[styles.scrollDownFab, { backgroundColor: isDark ? '#1F2C34' : '#fff' }]}
          activeOpacity={0.8}
          accessibilityLabel={t('chatConv.scrollToBottom') || 'Scroll to bottom'}
          accessibilityRole="button"
        >
          <IconChevronDown size={20} color={colors.textSecondary} />
          {newMsgCount > 0 && (
            <View style={[styles.scrollDownBadge, { backgroundColor: '#25D366' }]}>
              <Text style={styles.scrollDownBadgeText}>{newMsgCount > 99 ? '99+' : newMsgCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* Channel: only admins can send */}
      {conversationType === 'channel' && !members.find(m => m.email === currentEmail && m.role === 'admin') ? (
        <View style={{ paddingVertical: 14, paddingHorizontal: 20, backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.border, alignItems: 'center' }}>
          <Text style={{ color: colors.textTertiary, fontSize: 14 }}>{t('chat.onlyAdmins')}</Text>
        </View>
      ) : null}

      {/* Audio Recorder (replaces input bar when recording) */}
      {(conversationType !== 'channel' || members.find(m => m.email === currentEmail && m.role === 'admin')) && (isRecording ? (
        <View style={{ paddingBottom: Math.max(insets.bottom, Spacing.sm) }}>
          <AudioRecorder
            onSend={handleSendAudio}
            onCancel={() => setIsRecording(false)}
            colors={colors}
            t={t}
          />
        </View>
      ) : (
        /* Input Bar with Mention Autocomplete */
        <View style={{ position: 'relative' }}>
        {conversationType === 'group' && showMentionPopup && (
          <MentionAutocomplete
            inputText={inputText}
            members={members}
            currentEmail={currentEmail}
            visible={showMentionPopup}
            onSelect={(member) => {
              const { newText, mentionedEmail } = insertMention(inputText, member.email);
              setInputText(newText);
              setMentionedEmails(prev => [...prev.filter(e => e !== mentionedEmail), mentionedEmail]);
              setShowMentionPopup(false);
            }}
            colors={colors}
            t={t}
          />
        )}
        {/* Blocked banner */}
        {(iBlockedThem || theyBlockedMe) && conversationType === 'direct' ? (
          <View style={[styles.inputBar, {
            backgroundColor: isDark ? '#0B141A' : '#ECE5DD',
            paddingBottom: Math.max(insets.bottom, Spacing.sm),
            justifyContent: 'center', alignItems: 'center', paddingVertical: 16,
          }]}>
            <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginBottom: iBlockedThem ? 8 : 0 }}>
              {iBlockedThem
                ? (t('chat.youBlockedThis') || 'Você bloqueou este contato')
                : (t('chat.cantSendBlocked') || 'Não é possível enviar mensagens para este contato')}
            </Text>
            {iBlockedThem && (
              <TouchableOpacity
                onPress={() => handleUnblockUser(params.email || '')}
                style={{ paddingHorizontal: 20, paddingVertical: 8, borderRadius: 20, backgroundColor: isDark ? '#2a3942' : '#e5e7eb' }}
              >
                <Text style={{ color: '#25D366', fontWeight: '600', fontSize: 14 }}>
                  {t('chat.unblockUser')}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        ) : (
        <>
        {/* Smart quick reply suggestions */}
        {(() => {
          if (inputText || replyTo || editingMsg || isRecording) return null;
          const lastMsg = messages.find(m => m.sender_email !== currentEmail && !m.deleted_at && m.type === 'text' && m.content);
          if (!lastMsg) return null;
          // Only show if the last message was recent (< 5 min)
          const msgTime = new Date((lastMsg.created_at || '').endsWith('Z') ? lastMsg.created_at : (lastMsg.created_at + 'Z'));
          if (Date.now() - msgTime.getTime() > 300000) return null;
          // Generate contextual quick replies
          const content = (lastMsg.content || '').toLowerCase();
          let suggestions = [];
          if (content.includes('?') || content.includes('né') || content.includes('certo') || content.includes('right')) {
            suggestions = [t('quickReply.yes'), t('quickReply.no'), t('quickReply.maybe'), t('quickReply.sure')];
          } else if (content.includes('bom dia') || content.includes('boa tarde') || content.includes('boa noite') || content.includes('good morning') || content.includes('buenos')) {
            suggestions = [t('quickReply.goodMorning'), t('quickReply.howAreYou'), t('quickReply.hi')];
          } else if (content.includes('obrigad') || content.includes('valeu') || content.includes('thanks') || content.includes('gracias')) {
            suggestions = [t('quickReply.youreWelcome'), t('quickReply.atYourService'), '👍'];
          } else if (content.includes('kkk') || content.includes('haha') || content.includes('😂') || content.includes('lol') || content.includes('jaja')) {
            suggestions = [t('quickReply.haha'), t('quickReply.awesome'), '🤣'];
          } else if (content.includes('vamos') || content.includes('bora') || content.includes('partiu') || content.includes('let\'s go')) {
            suggestions = [t('quickReply.letsGo'), t('quickReply.imIn'), t('quickReply.notNow')];
          } else {
            suggestions = ['👍', '😊', 'Ok!', t('chatConv.aiReply') || '✨ IA'];
          }
          return (
            <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ maxHeight: 44, borderTopWidth: 0 }} contentContainerStyle={{ paddingHorizontal: 12, paddingVertical: 6, gap: 8 }}>
              {suggestions.map((s, i) => (
                <TouchableOpacity
                  key={i}
                  onPress={() => {
                    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
                    if (s === (t('chatConv.aiReply') || '✨ IA')) {
                      setInputText('');
                      inputRef.current?.focus();
                      return;
                    }
                    setInputText(s);
                    setTimeout(() => handleSend(), 100);
                  }}
                  activeOpacity={0.7}
                  style={{
                    backgroundColor: isDark ? '#1F2C34' : '#fff',
                    borderRadius: 18,
                    paddingHorizontal: 14,
                    paddingVertical: 7,
                    borderWidth: 0,
                  }}
                >
                  <Text style={{ fontSize: 13, color: colors.text, fontWeight: '500' }}>{s}</Text>
                </TouchableOpacity>
              ))}
            </ScrollView>
          );
        })()}

        <View style={[styles.inputBar, {
          backgroundColor: isDark ? '#0B141A' : '#ECE5DD',
          paddingBottom: keyboardHeight > 0 ? Spacing.sm : Math.max(insets.bottom, Spacing.sm),
        }]}>
          {/* Attachment button (opens menu) */}
          <TouchableOpacity
            onPress={() => setShowAttachMenu(true)}
            disabled={uploading}
            style={[styles.attachBtn, { borderRadius: 22 }]}
            accessibilityLabel={t('chatConv.attach') || 'Attach file'}
            accessibilityRole="button"
          >
            {uploading ? (
              <ActivityIndicator size="small" color={colors.textSecondary} />
            ) : (
              <IconPlus size={22} color={colors.textSecondary} />
            )}
          </TouchableOpacity>

          <TextInput
            ref={inputRef}
            style={[styles.input, {
              color: colors.text,
              backgroundColor: isDark ? '#1F2C34' : '#fff',
            }]}
            placeholder={t('chatConv.messagePlaceholder')}
            placeholderTextColor={colors.textTertiary}
            value={inputText}
            onChangeText={(text) => {
              setInputText(text);
              // Show/hide mention autocomplete for group chats
              if (conversationType === 'group') {
                setShowMentionPopup(isMentioning(text));
              }
              // Send typing indicator via WebSocket (debounced internally by websocket.js)
              try {
                const mailWs = require('../services/websocket').default;
                mailWs.sendTyping(conversationId);
              } catch {}
            }}
            multiline
            maxLength={5000}
            onSubmitEditing={Platform.OS === 'web' ? () => { if (sending) setSending(false); else handleSend(); } : undefined}
            blurOnSubmit={Platform.OS === 'web'}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
            onSelectionChange={(e) => { inputSelectionRef.current = e.nativeEvent.selection; }}
          />

          {/* Format button */}
          {inputText.trim().length > 0 && (
            <TouchableOpacity
              onPress={() => setShowFormatToolbar(prev => !prev)}
              style={{ paddingHorizontal: 3, paddingVertical: 8 }}
              accessibilityLabel={t('chatConv.format') || 'Format text'}
              accessibilityRole="button"
            >
              <Text style={{ fontSize: 14, fontWeight: '700', color: showFormatToolbar ? colors.primary : colors.textSecondary }}>Aa</Text>
            </TouchableOpacity>
          )}

          {/* Sticker button */}
          {!inputText.trim() && (
            <TouchableOpacity
              onPress={() => { setShowStickerPicker(prev => !prev); setShowGifPicker(false); }}
              style={{ paddingHorizontal: 3, paddingVertical: 8 }}
              accessibilityLabel={t('chatConv.stickers') || 'Stickers'}
              accessibilityRole="button"
            >
              <Text style={{ fontSize: 22, opacity: showStickerPicker ? 1 : 0.5 }}>😊</Text>
            </TouchableOpacity>
          )}

          {/* GIF button */}
          {!inputText.trim() && (
            <TouchableOpacity
              onPress={() => { setShowGifPicker(prev => !prev); setShowStickerPicker(false); }}
              style={{ paddingHorizontal: 4, paddingVertical: 8 }}
              accessibilityLabel="GIF"
              accessibilityRole="button"
            >
              <View style={{
                paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4,
                borderWidth: 1.5, borderColor: showGifPicker ? colors.primary : colors.textSecondary,
              }}>
                <Text style={{ fontSize: 11, fontWeight: '700', color: showGifPicker ? colors.primary : colors.textSecondary }}>GIF</Text>
              </View>
            </TouchableOpacity>
          )}

          {/* Show mic button when input is empty, send button when there's text */}
          {inputText.trim() ? (
            <View style={{ position: 'relative' }}>
              <TouchableOpacity
                onPress={() => { if (sending) { setSending(false); } else { handleSend(); } }}
                onLongPress={() => { if (!sending && inputText.trim()) setShowScheduleMenu(true); }}
                delayLongPress={400}
                style={[styles.sendBtn, { backgroundColor: '#25D366' }]}
                accessibilityLabel={t('chatConv.send') || 'Send message'}
                accessibilityRole="button"
              >
                {sending ? (
                  <ActivityIndicator size="small" color="#fff" />
                ) : (
                  <IconSend size={18} color="#fff" />
                )}
              </TouchableOpacity>
              {/* Schedule menu popup */}
              {showScheduleMenu && (
                <View style={[{
                  position: 'absolute', bottom: 48, right: 0, minWidth: 220,
                  backgroundColor: colors.surface, borderRadius: 12, overflow: 'hidden',
                  borderWidth: 1, borderColor: colors.border,
                }, Shadow.lg]}>
                  <Text style={{ fontSize: 13, fontWeight: '700', color: colors.text, paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 }}>
                    {t('chat.schedule')}
                  </Text>
                  {getScheduleOptions().map((opt, idx) => (
                    <TouchableOpacity
                      key={idx}
                      onPress={() => {
                        if (opt.value === 'custom') {
                          setShowScheduleMenu(false);
                          setShowCustomSchedule(true);
                        } else {
                          handleScheduleMessage(opt.value);
                        }
                      }}
                      style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 12, paddingHorizontal: 14, gap: 10 }}
                    >
                      <IconClock size={16} color={colors.primary} />
                      <Text style={{ fontSize: 14, color: colors.text }}>{opt.label}</Text>
                    </TouchableOpacity>
                  ))}
                  <TouchableOpacity
                    onPress={() => setShowScheduleMenu(false)}
                    style={{ paddingVertical: 10, alignItems: 'center', borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.border }}
                  >
                    <Text style={{ fontSize: 13, color: colors.textTertiary }}>{t('common.cancel')}</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ) : (
            <TouchableOpacity
              onPress={() => {
                setIsRecording(true);
                try { const mailWs = require('../services/websocket').default; mailWs.sendTyping(conversationId, true); } catch {}
              }}
              style={[styles.sendBtn, { backgroundColor: '#25D366' }]}
              accessibilityLabel={t('chatConv.recordAudio') || 'Record audio'}
              accessibilityRole="button"
            >
              <IconMic size={20} color="#fff" />
            </TouchableOpacity>
          )}
        </View>
        </>
        )}
        </View>
      ))}

      <ScheduleToast visible={!!scheduleToast} message={scheduleToast} colors={colors} />
      <CustomScheduleModal visible={showCustomSchedule} onClose={() => setShowCustomSchedule(false)} customDate={customScheduleDate} setCustomDate={setCustomScheduleDate} onSchedule={(iso) => { handleScheduleMessage(iso); setCustomScheduleDate(''); }} colors={colors} t={t} />
      <ScheduledMessagesModal visible={showScheduledMessages} onClose={() => setShowScheduledMessages(false)} messages={scheduledMessages} onCancel={handleCancelScheduled} colors={colors} t={t} />

      {/* GIF Picker Panel */}
      {showGifPicker && (
        <GifPickerPanel
          onSelect={handleSendGif}
          onClose={() => setShowGifPicker(false)}
          colors={colors}
          t={t}
        />
      )}

      {/* Sticker Picker Panel */}
      {showStickerPicker && (
        <StickerPicker
          onSelect={handleSendSticker}
          onClose={() => setShowStickerPicker(false)}
          colors={colors}
          t={t}
        />
      )}

      {/* Format Toolbar */}
      {showFormatToolbar && (
        <FormatToolbar
          text={inputText}
          setText={setInputText}
          selection={inputSelectionRef.current}
          colors={colors}
        />
      )}

      {/* Media Gallery */}
      <MediaGallery
        visible={showMediaGallery}
        onClose={() => setShowMediaGallery(false)}
        conversationId={conversationId}
        colors={colors}
        t={t}
      />

      {/* Export Modal */}
      <Modal visible={showExportModal} transparent animationType="fade" onRequestClose={() => setShowExportModal(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }} onPress={() => setShowExportModal(false)}>
          <Pressable style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 20, width: 280 }} onPress={() => {}}>
            <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text, marginBottom: 16 }}>{t('chat.exportChat')}</Text>
            {['txt', 'json'].map(fmt => (
              <TouchableOpacity
                key={fmt}
                onPress={async () => {
                  setShowExportModal(false);
                  try {
                    const r = await api.chatExport(conversationId, fmt);
                    if (r.success && r.data?.content && Platform.OS === 'web') {
                      const blob = new Blob([r.data.content], { type: fmt === 'json' ? 'application/json' : 'text/plain' });
                      const url = URL.createObjectURL(blob);
                      const a = document.createElement('a'); a.href = url; a.download = r.data.filename; a.click();
                      URL.revokeObjectURL(url);
                    }
                  } catch {}
                }}
                style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}
              >
                <Text style={{ fontSize: 15, color: colors.text }}>{fmt === 'txt' ? t('chat.exportTxt') : t('chat.exportJson')}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity onPress={() => setShowExportModal(false)} style={{ paddingVertical: 14 }}>
              <Text style={{ fontSize: 15, color: colors.textSecondary, textAlign: 'center' }}>{t('common.cancel') || 'Cancel'}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Reaction Detail Modal */}
      <ReactionDetailModal
        visible={!!reactionDetail}
        onClose={() => setReactionDetail(null)}
        emoji={reactionDetail?.emoji}
        reactors={reactionDetail?.reactors || []}
        colors={colors}
      />

      {/* Attachment Menu Modal */}
      <AttachmentMenu
        visible={showAttachMenu}
        onClose={() => setShowAttachMenu(false)}
        onPick={handlePickAttachment}
        colors={colors}
      />

      {/* Poll Creator Modal */}
      <Modal visible={showPollCreator} transparent animationType="slide" onRequestClose={() => setShowPollCreator(false)}>
        <PollCreatorModal
          colors={colors}
          t={t}
          conversationId={conversationId}
          onClose={() => setShowPollCreator(false)}
          onCreated={(msg) => { setMessages(prev => [...prev, msg]); setShowPollCreator(false); setTimeout(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }), 200); }}
        />
      </Modal>

      {/* Meetup Creator Modal */}
      <Modal visible={showMeetupCreator} transparent animationType="slide" onRequestClose={() => setShowMeetupCreator(false)}>
        <MeetupCreatorModal
          colors={colors}
          t={t}
          conversationId={conversationId}
          onClose={() => setShowMeetupCreator(false)}
          onCreated={(msg) => { setMessages(prev => [...prev, msg]); setShowMeetupCreator(false); setTimeout(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }), 200); }}
        />
      </Modal>

      {/* Playlist Creator Modal */}
      <Modal visible={showPlaylistCreator} transparent animationType="slide" onRequestClose={() => setShowPlaylistCreator(false)}>
        <PlaylistCreatorModal
          colors={colors}
          t={t}
          conversationId={conversationId}
          onClose={() => setShowPlaylistCreator(false)}
          onCreated={(msg) => { setMessages(prev => [...prev, msg]); setShowPlaylistCreator(false); setTimeout(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }), 200); }}
        />
      </Modal>

      {/* Message Action Modal — Modern Frosted Glass Context Menu */}
      <Modal
        visible={!!selectedMsg}
        transparent
        animationType="none"
        onRequestClose={() => setSelectedMsg(null)}
        onShow={() => {
          ctxScaleAnim.setValue(0.85);
          ctxOpacityAnim.setValue(0);
          Animated.parallel([
            Animated.spring(ctxScaleAnim, { toValue: 1, useNativeDriver: true, tension: 300, friction: 20 }),
            Animated.timing(ctxOpacityAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
          ]).start();
        }}
      >
        <Pressable
          style={styles.ctxOverlay}
          onPress={() => setSelectedMsg(null)}
        >
          <Animated.View style={[
            styles.ctxContainer,
            {
              opacity: ctxOpacityAnim,
              transform: [{ scale: ctxScaleAnim }],
              backgroundColor: colors.surface + 'EB',
            },
            Platform.OS === 'web' ? { backdropFilter: 'blur(40px)', WebkitBackdropFilter: 'blur(40px)' } : {},
          ]}>
            {/* Message Preview */}
            {selectedMsg && (
              <View style={[styles.ctxPreview, { backgroundColor: selectedMsg.sender_email === currentEmail ? (colors.primary + '18') : (colors.border + '60') }]}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.ctxPreviewSender, { color: colors.primary }]} numberOfLines={1}>
                    {selectedMsg.sender_email === currentEmail ? (t('chatConv.you') || 'You') : (selectedMsg.sender_name || emailToDisplayName(selectedMsg.sender_email))}
                  </Text>
                  <Text style={[styles.ctxPreviewText, { color: colors.textSecondary }]} numberOfLines={2}>
                    {selectedMsg.type === 'image' ? (selectedMsg.content && selectedMsg.content !== selectedMsg.file_name ? selectedMsg.content : (t('chatConv.viewOncePhoto') || 'Photo'))
                      : selectedMsg.type === 'video' ? (t('chatConv.viewOnceVideo') || 'Video')
                      : selectedMsg.type === 'audio' ? (t('chatConv.viewOnceAudio') || 'Audio')
                      : selectedMsg.type === 'file' ? (selectedMsg.file_name || (t('chatConv.file') || 'File'))
                      : selectedMsg.type === 'location' ? (t('chatConv.location') || 'Location')
                      : (selectedMsg.content || '')}
                  </Text>
                </View>
                <Text style={[styles.ctxPreviewTime, { color: colors.textSecondary }]}>{formatTime(selectedMsg.created_at)}</Text>
              </View>
            )}

            {/* Quick Reactions Row */}
            <View style={[styles.ctxReactionsRow, {
              backgroundColor: isDark ? 'rgba(40,40,60,0.7)' : 'rgba(255,255,255,0.85)',
              borderRadius: 30, marginHorizontal: 12, marginTop: 8, marginBottom: 4,
              ...(Platform.OS === 'web' ? { backdropFilter: 'blur(20px)', boxShadow: '0 2px 12px rgba(0,0,0,0.1)' } : { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8, elevation: 4 }),
            }]}>
              {QUICK_REACTIONS.map((r, i) => (
                <TouchableOpacity
                  key={r.key}
                  onPress={() => { handleReact(selectedMsg?.id, r.key); setSelectedMsg(null); }}
                  style={[styles.ctxReactionBtn, {
                    ...(Platform.OS === 'web' ? { transition: 'transform 0.15s ease', cursor: 'pointer' } : {}),
                  }]}
                  activeOpacity={0.6}
                >
                  <Text style={{ fontSize: 30 }}>{r.emoji}</Text>
                </TouchableOpacity>
              ))}
              <TouchableOpacity
                onPress={() => setShowFullEmojiPicker(true)}
                style={[styles.ctxReactionBtn, { width: 40, height: 40, borderRadius: 20, backgroundColor: isDark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.06)' }]}
                activeOpacity={0.6}
              >
                <IconPlus size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Primary Action Bar — Horizontal Icons (iMessage-style) */}
            <View style={[styles.ctxIconBar, { borderBottomColor: colors.border + '40' }]}>
              {/* Copy */}
              {!selectedMsg?.deleted_at && selectedMsg?.content && (
                <TouchableOpacity
                  style={styles.ctxIconBtn}
                  onPress={() => handleCopyMessage(selectedMsg)}
                  activeOpacity={0.6}
                >
                  <View style={[styles.ctxIconCircle, { backgroundColor: colors.border + '50' }]}>
                    <IconCopy size={20} color={colors.text} />
                  </View>
                  <Text style={[styles.ctxIconLabel, { color: colors.textSecondary }]}>{t('chatConv.copy') || 'Copy'}</Text>
                </TouchableOpacity>
              )}

              {/* Reply */}
              <TouchableOpacity
                style={styles.ctxIconBtn}
                onPress={() => handleReply(selectedMsg)}
                activeOpacity={0.6}
              >
                <View style={[styles.ctxIconCircle, { backgroundColor: colors.border + '50' }]}>
                  <IconReply size={20} color={colors.text} />
                </View>
                <Text style={[styles.ctxIconLabel, { color: colors.textSecondary }]}>{t('chatConv.reply')}</Text>
              </TouchableOpacity>

              {/* Forward */}
              {!selectedMsg?.deleted_at && (
                <TouchableOpacity
                  style={styles.ctxIconBtn}
                  onPress={() => handleForward(selectedMsg)}
                  activeOpacity={0.6}
                >
                  <View style={[styles.ctxIconCircle, { backgroundColor: colors.border + '50' }]}>
                    <IconForward size={20} color={colors.text} />
                  </View>
                  <Text style={[styles.ctxIconLabel, { color: colors.textSecondary }]}>{t('chatConv.forward')}</Text>
                </TouchableOpacity>
              )}

              {/* Star */}
              {!selectedMsg?.deleted_at && (
                <TouchableOpacity
                  style={styles.ctxIconBtn}
                  onPress={() => handleStarMessage(selectedMsg)}
                  activeOpacity={0.6}
                >
                  <View style={[styles.ctxIconCircle, { backgroundColor: selectedMsg?.starred ? '#f59e0b20' : (colors.border + '50') }]}>
                    {selectedMsg?.starred
                      ? <IconStarFilled size={20} color="#f59e0b" />
                      : <IconStar size={20} color={colors.text} />}
                  </View>
                  <Text style={[styles.ctxIconLabel, { color: colors.textSecondary }]}>{selectedMsg?.starred ? t('chat.unstar') : t('chat.star')}</Text>
                </TouchableOpacity>
              )}

              {/* Delete */}
              {selectedMsg?.sender_email === currentEmail && !selectedMsg?.deleted_at && (
                <TouchableOpacity
                  style={styles.ctxIconBtn}
                  onPress={() => handleDelete(selectedMsg?.id)}
                  activeOpacity={0.6}
                >
                  <View style={[styles.ctxIconCircle, { backgroundColor: (colors.error || '#EF4444') + '15' }]}>
                    <IconTrash size={20} color={colors.error || '#EF4444'} />
                  </View>
                  <Text style={[styles.ctxIconLabel, { color: colors.error || '#EF4444' }]}>{t('chatConv.delete')}</Text>
                </TouchableOpacity>
              )}
            </View>

            {/* Secondary Actions — Vertical List */}
            <View style={styles.ctxSecondaryList}>
              {/* Pin/Unpin */}
              {!selectedMsg?.deleted_at && (
                <TouchableOpacity
                  style={styles.ctxSecondaryItem}
                  onPress={() => handlePinMessage(selectedMsg)}
                  activeOpacity={0.6}
                >
                  <IconPin size={18} color={pinnedMessages.find(p => p.id === selectedMsg?.id) ? '#f59e0b' : colors.text} />
                  <Text style={[styles.ctxSecondaryText, { color: colors.text }]}>
                    {pinnedMessages.find(p => p.id === selectedMsg?.id) ? (t('chatConv.unpinMessage') || 'Unpin') : (t('chatConv.pinMessage') || 'Pin')}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Translate */}
              {!selectedMsg?.deleted_at && selectedMsg?.content && (selectedMsg?.type === 'text' || (selectedMsg?.type === 'image' && selectedMsg?.content !== selectedMsg?.file_name)) && (
                <TouchableOpacity
                  style={styles.ctxSecondaryItem}
                  onPress={() => handleTranslate(selectedMsg)}
                  activeOpacity={0.6}
                >
                  <IconGlobe size={18} color={colors.text} />
                  <Text style={[styles.ctxSecondaryText, { color: colors.text }]}>
                    {translatedMessages[selectedMsg?.id]?.text ? t('chatConv.hideTranslation') : t('chatConv.translate')}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Message Info (own messages only) */}
              {selectedMsg?.sender_email === currentEmail && !selectedMsg?.deleted_at && typeof selectedMsg?.id === 'number' && (
                <TouchableOpacity
                  style={styles.ctxSecondaryItem}
                  onPress={() => handleMessageInfo(selectedMsg)}
                  activeOpacity={0.6}
                >
                  <IconInfo size={18} color={colors.text} />
                  <Text style={[styles.ctxSecondaryText, { color: colors.text }]}>{t('chatConv.messageInfo')}</Text>
                </TouchableOpacity>
              )}

              {/* Edit (own text messages, within 15 min) */}
              {selectedMsg?.sender_email === currentEmail && !selectedMsg?.deleted_at && selectedMsg?.type === 'text' && (
                (() => {
                  const createdAt = selectedMsg?.created_at;
                  const canEdit = createdAt ? (Date.now() - new Date(createdAt.endsWith('Z') ? createdAt : createdAt + 'Z').getTime()) < 15 * 60 * 1000 : true;
                  return canEdit ? (
                    <TouchableOpacity
                      style={styles.ctxSecondaryItem}
                      onPress={() => handleEdit(selectedMsg)}
                      activeOpacity={0.6}
                    >
                      <IconEdit size={18} color={colors.text} />
                      <Text style={[styles.ctxSecondaryText, { color: colors.text }]}>{t('chatConv.edit')}</Text>
                    </TouchableOpacity>
                  ) : null;
                })()
              )}

              {/* Report (other people's messages) */}
              {selectedMsg?.sender_email && selectedMsg.sender_email !== currentEmail && (
                <TouchableOpacity
                  style={styles.ctxSecondaryItem}
                  onPress={() => { const email = selectedMsg.sender_email; const msgId = selectedMsg.id; setSelectedMsg(null); handleReportUser(email, msgId); }}
                  activeOpacity={0.6}
                >
                  <IconAlertTriangle size={18} color={colors.error || '#EF4444'} />
                  <Text style={[styles.ctxSecondaryText, { color: colors.error || '#EF4444' }]}>{t('chat.reportUser')}</Text>
                </TouchableOpacity>
              )}
            </View>
          </Animated.View>
        </Pressable>
      </Modal>
      {/* Full Emoji Picker Modal */}
      <Modal
        visible={showFullEmojiPicker}
        transparent
        animationType="slide"
        onRequestClose={() => setShowFullEmojiPicker(false)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setShowFullEmojiPicker(false)}>
          <Pressable style={[styles.emojiPickerSheet, { backgroundColor: colors.surface }, Shadow.lg]} onPress={e => e.stopPropagation()}>
            <View style={styles.emojiPickerHeader}>
              <Text style={[styles.emojiPickerTitle, { color: colors.text }]}>{t('chatConv.reactions') || 'Reactions'}</Text>
              <TouchableOpacity onPress={() => setShowFullEmojiPicker(false)} style={{ padding: 4 }}>
                <IconX size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            <ScrollView style={{ maxHeight: 320 }} showsVerticalScrollIndicator={false}>
              <Text style={[styles.emojiCategoryLabel, { color: colors.textSecondary }]}>{t('chatConv.emojiSmileys') || 'Smileys'}</Text>
              <View style={styles.emojiGrid}>
                {'😀😃😄😁😅😂🤣😊😇🥰😍🤩😘😗😋😛😜🤪😝🤑🤗🤭🤫🤔🤐🤨😐😑😶😏😒🙄😬🤥😌😔😪🤤😴😷🤒🤕🤢🤮🤧🥵🥶🥴😵🤯🤠🥳🥸😎🤓🧐😕😟🙁☹️😮😯😲😳🥺😦😧😨😰😥😢😭😱😖😣😞😓😩😫🥱😤😡😠🤬'.match(/./gu).map(em => (
                  <TouchableOpacity key={em} style={styles.emojiBtn} onPress={() => { handleReact(selectedMsg?.id, em); setShowFullEmojiPicker(false); setSelectedMsg(null); }}>
                    <Text style={styles.emojiBtnText}>{em}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={[styles.emojiCategoryLabel, { color: colors.textSecondary }]}>{t('chatConv.emojiGestures') || 'Gestures'}</Text>
              <View style={styles.emojiGrid}>
                {'👍👎👋🤚✋🖐️👌🤌🤏✌️🤞🤟🤘🤙👈👉👆👇☝️✊👊🤛🤜👏🙌👐🤲🤝🙏💪'.match(/./gu).map(em => (
                  <TouchableOpacity key={em} style={styles.emojiBtn} onPress={() => { handleReact(selectedMsg?.id, em); setShowFullEmojiPicker(false); setSelectedMsg(null); }}>
                    <Text style={styles.emojiBtnText}>{em}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={[styles.emojiCategoryLabel, { color: colors.textSecondary }]}>{t('chatConv.emojiHearts') || 'Hearts'}</Text>
              <View style={styles.emojiGrid}>
                {'❤️🧡💛💚💙💜🖤🤍🤎💔❣️💕💞💓💗💖💝💘💟'.match(/./gu).map(em => (
                  <TouchableOpacity key={em} style={styles.emojiBtn} onPress={() => { handleReact(selectedMsg?.id, em); setShowFullEmojiPicker(false); setSelectedMsg(null); }}>
                    <Text style={styles.emojiBtnText}>{em}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <Text style={[styles.emojiCategoryLabel, { color: colors.textSecondary }]}>{t('chatConv.emojiObjects') || 'Objects'}</Text>
              <View style={styles.emojiGrid}>
                {'🎉🎊🎈🎁🎂🍰🥂🍾🎶🎵🔥⭐💯✅❌⚡💡💤🎯🏆🥇🎖️🏅'.match(/./gu).map(em => (
                  <TouchableOpacity key={em} style={styles.emojiBtn} onPress={() => { handleReact(selectedMsg?.id, em); setShowFullEmojiPicker(false); setSelectedMsg(null); }}>
                    <Text style={styles.emojiBtnText}>{em}</Text>
                  </TouchableOpacity>
                ))}
              </View>
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
      {/* Message Info Modal (delivery/read timestamps) */}
      <Modal
        visible={!!messageInfoModal}
        transparent
        animationType="slide"
        onRequestClose={() => setMessageInfoModal(null)}
      >
        <Pressable style={styles.modalOverlay} onPress={() => setMessageInfoModal(null)}>
          <Pressable style={[styles.messageInfoSheet, { backgroundColor: colors.surface }, Shadow.lg]} onPress={e => e.stopPropagation()}>
            <View style={styles.messageInfoHeader}>
              <Text style={[styles.messageInfoTitle, { color: colors.text }]}>{t('chatConv.messageInfo')}</Text>
              <TouchableOpacity onPress={() => setMessageInfoModal(null)} style={{ padding: 4 }}>
                <IconX size={20} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>

            {/* Sent time */}
            {messageInfoModal?.sent_at && (
              <View style={styles.messageInfoRow}>
                <View style={[styles.messageInfoDot, { backgroundColor: '#8696A0' }]} />
                <View style={{ flex: 1 }}>
                  <Text style={[styles.messageInfoLabel, { color: colors.textSecondary }]}>{t('chatConv.sentAt')}</Text>
                  <Text style={[styles.messageInfoTime, { color: colors.text }]}>
                    {(() => {
                      const str = messageInfoModal.sent_at.endsWith('Z') || messageInfoModal.sent_at.includes('+') ? messageInfoModal.sent_at : messageInfoModal.sent_at + 'Z';
                      const d = new Date(str);
                      return isNaN(d.getTime()) ? messageInfoModal.sent_at : d.toLocaleString([], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                    })()}
                  </Text>
                </View>
              </View>
            )}

            {messageInfoModal?.loading ? (
              <ActivityIndicator size="small" color={colors.primary} style={{ marginVertical: 16 }} />
            ) : (
              (messageInfoModal?.receipts || []).map((r, idx) => (
                <View key={r.email || idx}>
                  {/* Participant name */}
                  <Text style={[styles.messageInfoParticipant, { color: colors.text }]}>{r.name || r.email}</Text>

                  {/* Delivered */}
                  <View style={styles.messageInfoRow}>
                    <View style={[styles.messageInfoDot, { backgroundColor: r.delivered_at ? '#53BDEB' : colors.textTertiary }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.messageInfoLabel, { color: colors.textSecondary }]}>{t('chatConv.deliveredAt')}</Text>
                      <Text style={[styles.messageInfoTime, { color: colors.text }]}>
                        {r.delivered_at ? (() => {
                          const str = r.delivered_at.endsWith('Z') || r.delivered_at.includes('+') ? r.delivered_at : r.delivered_at + 'Z';
                          const d = new Date(str);
                          return isNaN(d.getTime()) ? r.delivered_at : d.toLocaleString([], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                        })() : t('chatConv.notDelivered')}
                      </Text>
                    </View>
                  </View>

                  {/* Read */}
                  <View style={styles.messageInfoRow}>
                    <View style={[styles.messageInfoDot, { backgroundColor: r.read_at ? '#53BDEB' : colors.textTertiary }]} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.messageInfoLabel, { color: colors.textSecondary }]}>{t('chatConv.readAt')}</Text>
                      <Text style={[styles.messageInfoTime, { color: colors.text }]}>
                        {r.read_at ? (() => {
                          const str = r.read_at.endsWith('Z') || r.read_at.includes('+') ? r.read_at : r.read_at + 'Z';
                          const d = new Date(str);
                          return isNaN(d.getTime()) ? r.read_at : d.toLocaleString([], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                        })() : t('chatConv.notRead')}
                      </Text>
                    </View>
                  </View>

                  {idx < (messageInfoModal?.receipts || []).length - 1 && (
                    <View style={[styles.messageInfoDivider, { backgroundColor: colors.border }]} />
                  )}
                </View>
              ))
            )}

            {!messageInfoModal?.loading && (!messageInfoModal?.receipts || messageInfoModal.receipts.length === 0) && (
              <Text style={[styles.messageInfoEmpty, { color: colors.textTertiary }]}>
                {t('chatConv.notDelivered')}
              </Text>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Keyboard spacer for iOS/Android modal */}
      {keyboardHeight > 0 && Platform.OS !== 'web' && (
        <View style={{ height: keyboardHeight }} />
      )}

      {/* Media viewer modal */}
      <ChatMediaViewer
        visible={mediaViewer.visible}
        onClose={() => {
          if (mediaViewer.viewOnce && mediaViewer.messageId) {
            // Mark as viewed and hide from message list
            api.markViewOnce(mediaViewer.messageId).catch(() => {});
            setMessages(prev => prev.map(m =>
              m.id === mediaViewer.messageId ? { ...m, view_once_opened: true, file_url: '', content: '' } : m
            ));
          }
          setMediaViewer(v => ({ ...v, visible: false }));
        }}
        fileUrl={mediaViewer.fileUrl}
        fileName={mediaViewer.fileName}
        fileSize={mediaViewer.fileSize}
        type={mediaViewer.type}
        viewOnce={mediaViewer.viewOnce}
      />

      {/* Media preview before send (WhatsApp style) */}
      <MediaPreview
        visible={mediaPreview.visible}
        onClose={() => setMediaPreview({ visible: false, uri: null, type: 'image', file: null })}
        onSend={async (caption, viewOnce) => {
          const fileToSend = mediaPreview.file;
          setMediaPreview({ visible: false, uri: null, type: 'image', file: null });
          if (!fileToSend) return;
          // Compress images on web before upload (max 2048px, 80% quality)
          if (Platform.OS === 'web' && mediaPreview.type === 'image' && fileToSend.blob) {
            try {
              const compressed = await compressImageWeb(fileToSend.blob, 2048, 0.8);
              if (compressed) {
                uploadAndSendFile({ ...fileToSend, blob: compressed, uri: URL.createObjectURL(compressed) }, viewOnce, caption || '');
                return;
              }
            } catch {}
          }
          uploadAndSendFile(fileToSend, viewOnce, caption || '');
        }}
        mediaUri={mediaPreview.uri}
        mediaType={mediaPreview.type}
        colors={colors}
      />

      {/* Profile viewer modal */}
      <ProfileViewerModal
        visible={!!profileViewer}
        profile={profileViewer}
        onClose={() => setProfileViewer(null)}
        onMessage={null}
        onAudioCall={conversationType === 'direct' ? handleStartAudioCall : null}
        onVideoCall={conversationType === 'direct' ? handleStartVideoCall : null}
        presence={presence}
        conversationType={conversationType}
        colors={colors}
        t={t}
        formatLastSeen={formatLastSeen}
      />

      {/* Header More Menu */}
      <Modal visible={showHeaderMenu} transparent animationType="fade" onRequestClose={() => setShowHeaderMenu(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.35)' }} onPress={() => setShowHeaderMenu(false)}>
          <Pressable
            style={{
              position: 'absolute', top: insets.top + 52, right: 12,
              backgroundColor: colors.surface, borderRadius: 16,
              minWidth: 220, paddingVertical: 8,
              ...Platform.select({
                ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.15, shadowRadius: 16 },
                android: { elevation: 8 },
                web: { boxShadow: '0 6px 24px rgba(0,0,0,0.18)' },
              }),
            }}
            onPress={e => e.stopPropagation()}
          >
            {[
              { icon: <IconUsers size={18} color={colors.text} />, label: conversationType === 'group' ? (t('chatConv.groupInfo') || 'Info do grupo') : (t('chatConv.contactInfo') || 'Info do contato'), onPress: () => {
                setShowHeaderMenu(false);
                if (conversationType === 'group') { setEditGroupName(conversationName); loadGroupMembers(); setShowGroupInfo(true); }
                else { setProfileViewer({ name: conversationName, email: params.email || '' }); }
              }},
              { icon: <IconNavigation size={18} color={colors.text} style={{ transform: [{ rotate: '45deg' }] }} />, label: t('chat.searchPlaceholder') || 'Buscar', onPress: () => { setShowHeaderMenu(false); setShowSearchBar(true); setTimeout(() => searchInputRef.current?.focus(), 200); }},
              { icon: <IconStar size={18} color={colors.text} />, label: t('chat.starredMessages') || 'Favoritas', onPress: () => { setShowHeaderMenu(false); setShowStarredModal(true); loadStarredMessages(); }},
              { icon: <IconImage size={18} color={colors.text} />, label: t('chatConv.media') || 'Mídia', onPress: () => { setShowHeaderMenu(false); setShowMediaGallery(true); }},
              { icon: <IconClock size={18} color={disappearingTimer > 0 ? '#10b981' : colors.text} />, label: t('chat.disappearing') || 'Temporárias', badge: disappearingTimer > 0, onPress: () => { setShowHeaderMenu(false); setShowDisappearingModal(true); }},
              { icon: <IconLock size={18} color={chatLocked ? '#f59e0b' : colors.text} />, label: chatLocked ? (t('chatConv.removeLock') || 'Remover bloqueio') : (t('chatConv.setLock') || 'Bloquear chat'), onPress: () => {
                setShowHeaderMenu(false);
                if (chatLocked) { safeAlert(t('chatConv.chatLockTitle') || 'Chat Lock', t('chatConv.removeLockConfirm') || 'Remove password lock?', [{ text: t('common.cancel'), style: 'cancel' }, { text: t('chatConv.removeLock') || 'Remove', style: 'destructive', onPress: handleRemoveChatLock }]); }
                else { setShowLockSetup(true); setLockPassInput(''); }
              }},
              { icon: <IconImage size={18} color={colors.text} />, label: t('chatConv.wallpaper') || 'Papel de parede', onPress: () => { setShowHeaderMenu(false); setShowWallpaperPicker(true); }},
              { icon: <IconClock size={18} color={colors.text} />, label: t('chatConv.scheduled') || 'Agendadas', onPress: () => { setShowHeaderMenu(false); setShowScheduledMessages(true); loadScheduledMessages(); }},
              { icon: <IconClock size={18} color={mutedUntil ? '#f59e0b' : colors.text} />, label: mutedUntil ? (t('chatConv.unmute') || 'Remover silêncio') : (t('chatConv.muteChat') || 'Silenciar conversa'), onPress: () => { setShowHeaderMenu(false); if (mutedUntil) { handleMuteChat(null); } else { setShowMuteModal(true); } }},
              { icon: <IconForward size={18} color={colors.text} />, label: t('chatConv.exportChat') || 'Exportar conversa', onPress: () => { setShowHeaderMenu(false); setShowExportModal(true); }},
              ...(conversationType === 'direct' ? [
                iBlockedThem
                  ? { icon: <IconAlertTriangle size={18} color={colors.text} />, label: t('chat.unblockUser'), onPress: () => { setShowHeaderMenu(false); handleUnblockUser(params.email || ''); }}
                  : { icon: <IconAlertTriangle size={18} color={colors.error || '#EF4444'} />, label: t('chat.blockUser'), onPress: () => { setShowHeaderMenu(false); handleBlockUser(params.email || ''); }},
                { icon: <IconAlertTriangle size={18} color={colors.error || '#EF4444'} />, label: t('chat.reportUser'), onPress: () => { setShowHeaderMenu(false); handleReportUser(params.email || ''); }},
              ] : []),
            ].map((item, idx) => (
              <TouchableOpacity
                key={idx}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 14,
                  paddingHorizontal: 18, paddingVertical: 13,
                }}
                onPress={item.onPress}
                activeOpacity={0.6}
              >
                {item.icon}
                <Text style={{ fontSize: 15, color: colors.text, flex: 1 }}>{item.label}</Text>
                {item.badge && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#10b981' }} />}
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Forward message picker modal */}
      <Modal
        visible={!!forwardMsg}
        transparent
        animationType="slide"
        onRequestClose={() => setForwardMsg(null)}
      >
        <View style={[styles.forwardModal, { backgroundColor: colors.background }]}>
          <View style={[styles.forwardHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.forwardTitle, { color: colors.text }]}>{t('chatConv.forwardTo')}</Text>
            <TouchableOpacity onPress={() => setForwardMsg(null)}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
          {forwardLoading ? (
            <ActivityIndicator size="large" color={colors.primary} style={{ marginTop: 40 }} />
          ) : (
            <FlatList
              data={forwardConversations}
              keyExtractor={item => String(item.id)}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={[styles.forwardItem, { borderBottomColor: colors.border }]}
                  onPress={() => handleForwardTo(item.id)}
                >
                  <Text style={[styles.forwardItemName, { color: colors.text }]} numberOfLines={1}>
                    {item.name || t('chat.unknown')}
                  </Text>
                  <Text style={[styles.forwardItemType, { color: colors.textTertiary }]}>
                    {item.type === 'group' ? t('chat.group') : t('chat.direct')}
                  </Text>
                </TouchableOpacity>
              )}
              ListEmptyComponent={
                <Text style={[styles.forwardEmpty, { color: colors.textSecondary }]}>
                  {t('chatConv.noConversationsToForward')}
                </Text>
              }
            />
          )}
        </View>
      </Modal>
      {/* Group Info Modal */}
      <Modal
        visible={showGroupInfo}
        transparent
        animationType="slide"
        onRequestClose={() => setShowGroupInfo(false)}
      >
        <View style={[styles.forwardModal, { backgroundColor: colors.background }]}>
          <View style={[styles.forwardHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.forwardTitle, { color: colors.text }]}>{t('chatConv.groupInfo')}</Text>
            <TouchableOpacity onPress={() => setShowGroupInfo(false)}>
              <IconX size={22} color={colors.text} />
            </TouchableOpacity>
          </View>
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: Spacing.md }}>
            <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>{t('chatConv.groupName')}</Text>
            <TextInput
              style={[styles.groupNameInput, { color: colors.text, borderColor: colors.border, backgroundColor: colors.surface }]}
              value={editGroupName}
              onChangeText={setEditGroupName}
              placeholder={t('chatConv.groupName')}
              placeholderTextColor={colors.textTertiary}
            />
            <TouchableOpacity
              onPress={handleUpdateGroupName}
              style={[styles.groupSaveBtn, { backgroundColor: colors.primary }]}
            >
              <Text style={{ color: '#fff', fontWeight: '600' }}>{t('common.save')}</Text>
            </TouchableOpacity>

            <Text style={[styles.groupLabel, { color: colors.textSecondary, marginTop: Spacing.lg }]}>
              {t('chatConv.members')} ({members.length})
            </Text>
            {members.map((m, i) => {
              const isMe = m.email === user?.email;
              const memberName = m.display_name || m.email?.split('@')[0];
              return (
                <View key={m.email || i} style={[styles.memberRow, { borderBottomColor: colors.border }]}>
                  <TouchableOpacity activeOpacity={0.7} onPress={() => setProfileViewer({ name: m.display_name || m.email, email: m.email })}>
                    <AvatarCircle name={m.display_name || m.email} email={m.email} size={36} />
                  </TouchableOpacity>
                  <View style={{ flex: 1 }}>
                    <Text style={[{ fontSize: FontSize.md, fontWeight: '500', color: colors.text }]}>
                      {memberName}{isMe ? ` (${t('chatConv.you') || 'você'})` : ''}
                    </Text>
                    <Text style={{ fontSize: FontSize.xs, color: colors.textTertiary }}>{m.email}</Text>
                  </View>
                  {m.role === 'admin' && (
                    <View style={{ backgroundColor: '#25D366', paddingHorizontal: 8, paddingVertical: 2, borderRadius: 10, marginRight: 6 }}>
                      <Text style={{ fontSize: 11, color: '#fff', fontWeight: '600' }}>Admin</Text>
                    </View>
                  )}
                  {isGroupAdmin && !isMe && (
                    <View style={{ flexDirection: 'row', gap: 4 }}>
                      <TouchableOpacity
                        onPress={() => handleToggleAdmin(m.email, m.role)}
                        style={{ padding: 6, backgroundColor: colors.surface, borderRadius: 8 }}
                      >
                        <Text style={{ fontSize: 11, color: colors.primary, fontWeight: '600' }}>
                          {m.role === 'admin' ? (t('chatConv.demote') || 'Remover admin') : (t('chatConv.promote') || 'Tornar admin')}
                        </Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        onPress={() => handleRemoveMember(m.email, memberName)}
                        style={{ padding: 6, backgroundColor: '#fde8e8', borderRadius: 8 }}
                      >
                        <IconX size={14} color="#dc2626" />
                      </TouchableOpacity>
                    </View>
                  )}
                </View>
              );
            })}

            {/* Group Invite Link (admin only) */}
            {isGroupAdmin && (
              <View style={{ marginTop: Spacing.lg }}>
                <Text style={[styles.groupLabel, { color: colors.textSecondary }]}>{t('chatConv.groupLink') || 'Link do grupo'}</Text>
                <View style={{ flexDirection: 'row', gap: 8, marginTop: 8 }}>
                  <TouchableOpacity
                    onPress={() => handleGenerateInviteLink(false)}
                    disabled={inviteLinkLoading}
                    style={[styles.groupSaveBtn, { backgroundColor: colors.primary, flex: 1, opacity: inviteLinkLoading ? 0.6 : 1 }]}
                  >
                    {inviteLinkLoading
                      ? <ActivityIndicator size="small" color="#fff" />
                      : <Text style={{ color: '#fff', fontWeight: '600', textAlign: 'center' }}>{t('chatConv.shareLink') || 'Compartilhar link'}</Text>
                    }
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => handleGenerateInviteLink(true)}
                    disabled={inviteLinkLoading}
                    style={[styles.groupSaveBtn, { backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border }]}
                  >
                    <Text style={{ color: colors.text, fontWeight: '500', fontSize: 12 }}>{t('chatConv.regenerateLink') || 'Novo link'}</Text>
                  </TouchableOpacity>
                </View>
                {inviteLink && (
                  <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 6 }} numberOfLines={1}>{inviteLink}</Text>
                )}
              </View>
            )}

            {/* Mute Chat */}
            <TouchableOpacity
              onPress={() => setShowMuteModal(true)}
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.md, marginTop: Spacing.lg, gap: 10 }}
            >
              <IconClock size={20} color={mutedUntil ? '#f59e0b' : colors.text} />
              <Text style={{ fontSize: FontSize.md, color: mutedUntil ? '#f59e0b' : colors.text, fontWeight: '500' }}>
                {mutedUntil ? (t('chatConv.unmute') || 'Remover silêncio') : (t('chatConv.muteChat') || 'Silenciar conversa')}
              </Text>
            </TouchableOpacity>

            {/* Leave Group Button */}
            <TouchableOpacity
              onPress={handleLeaveGroup}
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.md, marginTop: Spacing.sm, gap: 10 }}
            >
              <IconX size={20} color="#dc2626" />
              <Text style={{ fontSize: FontSize.md, color: '#dc2626', fontWeight: '600' }}>
                {t('chatConv.leaveGroup') || 'Sair do grupo'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
      </Modal>

      {/* Mute Chat Modal */}
      <Modal visible={showMuteModal} transparent animationType="fade" onRequestClose={() => setShowMuteModal(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }} onPress={() => setShowMuteModal(false)}>
          <Pressable style={{ backgroundColor: colors.surface, borderRadius: 16, width: 300, padding: 20 }} onPress={e => e.stopPropagation()}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <IconClock size={20} color={colors.primary} />
              <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>{t('chatConv.muteChat') || 'Silenciar conversa'}</Text>
            </View>
            {[
              { label: t('chatConv.muteFor8h') || 'Silenciar por 8 horas', value: '8h' },
              { label: t('chatConv.muteFor1w') || 'Silenciar por 1 semana', value: '1w' },
              { label: t('chatConv.muteForever') || 'Silenciar sempre', value: 'forever' },
              ...(mutedUntil ? [{ label: t('chatConv.unmute') || 'Remover silêncio', value: null }] : []),
            ].map((opt, idx) => (
              <TouchableOpacity
                key={opt.value || 'unmute'}
                onPress={() => handleMuteChat(opt.value)}
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: idx === (mutedUntil ? 3 : 2) ? 0 : 0.5, borderBottomColor: colors.border }}
              >
                <Text style={{ fontSize: 15, color: opt.value === null ? '#f59e0b' : colors.text }}>{opt.label}</Text>
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Chat Lock Setup Modal */}
      <Modal
        visible={showLockSetup}
        transparent
        animationType="fade"
        onRequestClose={() => setShowLockSetup(false)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }}>
          <View style={{ backgroundColor: colors.background, borderRadius: 16, padding: 24, width: 300, alignItems: 'center' }}>
            <IconLock size={32} color={colors.primary} />
            <Text style={{ color: colors.text, fontSize: 17, fontWeight: '600', marginTop: 12, marginBottom: 6 }}>
              {t('chatConv.setLockTitle') || 'Set Chat Lock'}
            </Text>
            <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center', marginBottom: 16 }}>
              {t('chatConv.setLockDesc') || 'Set a password to protect this chat'}
            </Text>
            <TextInput
              style={{
                width: '100%', height: 44, borderRadius: 10,
                backgroundColor: colors.surface, borderWidth: 1, borderColor: colors.border,
                paddingHorizontal: 14, color: colors.text, fontSize: 16,
              }}
              placeholder={t('chatConv.passwordPlaceholder') || 'Password (min 4 chars)'}
              placeholderTextColor={colors.textTertiary}
              secureTextEntry
              value={lockPassInput}
              onChangeText={setLockPassInput}
              autoFocus
            />
            <View style={{ flexDirection: 'row', gap: 12, marginTop: 16 }}>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 11, borderRadius: 10, backgroundColor: colors.surface, alignItems: 'center' }}
                onPress={() => { setShowLockSetup(false); setLockPassInput(''); }}
              >
                <Text style={{ color: colors.text, fontWeight: '500' }}>{t('common.cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={{ flex: 1, paddingVertical: 11, borderRadius: 10, backgroundColor: colors.primary, alignItems: 'center' }}
                onPress={() => handleSetChatLock(lockPassInput)}
              >
                <Text style={{ color: '#fff', fontWeight: '600' }}>{t('chatConv.setLock') || 'Set Lock'}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>

      {/* Disappearing Messages Modal */}
      <Modal visible={showDisappearingModal} transparent animationType="fade" onRequestClose={() => setShowDisappearingModal(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }} onPress={() => setShowDisappearingModal(false)}>
          <Pressable style={{ backgroundColor: colors.surface, borderRadius: 16, width: 300, padding: 20 }} onPress={e => e.stopPropagation()}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <IconClock size={20} color={colors.primary} />
              <Text style={{ fontSize: 17, fontWeight: '600', color: colors.text }}>{t('chat.disappearing')}</Text>
            </View>
            {[
              { label: t('chat.disappearingOff'), value: 0 },
              { label: t('chat.disappearing5m'), value: 300 },
              { label: t('chat.disappearing1h'), value: 3600 },
              { label: t('chat.disappearing24h'), value: 86400 },
              { label: t('chat.disappearing7d'), value: 604800 },
              { label: t('chat.disappearing90d'), value: 7776000 },
            ].map(opt => (
              <TouchableOpacity
                key={opt.value}
                onPress={() => handleSetDisappearing(opt.value)}
                style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 14, borderBottomWidth: opt.value === 7776000 ? 0 : 0.5, borderBottomColor: colors.border }}
              >
                <Text style={{ fontSize: 15, color: colors.text }}>{opt.label}</Text>
                {disappearingTimer === opt.value && <IconCheck size={18} color={colors.primary} />}
              </TouchableOpacity>
            ))}
          </Pressable>
        </Pressable>
      </Modal>

      {/* Report User Modal */}
      <Modal visible={showReportModal} transparent animationType="fade" onRequestClose={() => setShowReportModal(false)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', alignItems: 'center' }} onPress={() => setShowReportModal(false)}>
          <Pressable style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 20, width: 300 }} onPress={e => e.stopPropagation()}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 4 }}>{t('chat.reportUser')}</Text>
            <Text style={{ fontSize: 13, color: colors.textSecondary, marginBottom: 16 }}>{t('chat.reportConfirm')}</Text>
            {[
              { key: 'spam', label: t('chat.reportReasonSpam') },
              { key: 'harassment', label: t('chat.reportReasonHarassment') },
              { key: 'inappropriate', label: t('chat.reportReasonInappropriate') },
              { key: 'other', label: t('chat.reportReasonOther') },
            ].map(r => (
              <TouchableOpacity
                key={r.key}
                style={{ paddingVertical: 13, paddingHorizontal: 8, borderBottomWidth: 1, borderBottomColor: colors.border }}
                onPress={() => submitReport(r.key)}
              >
                <Text style={{ fontSize: 15, color: colors.text }}>{r.label}</Text>
              </TouchableOpacity>
            ))}
            <TouchableOpacity style={{ paddingVertical: 13, alignItems: 'center' }} onPress={() => setShowReportModal(false)}>
              <Text style={{ fontSize: 15, color: colors.textSecondary }}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Wallpaper Picker Modal */}
      <MapModal
        visible={!!mapModalData}
        onClose={() => setMapModalData(null)}
        lat={mapModalData?.lat}
        lng={mapModalData?.lng}
        label={mapModalData?.label}
        isLive={mapModalData?.isLive}
        liveUntil={mapModalData?.liveUntil}
      />

      {showWallpaperPicker && (
        <Modal visible transparent animationType="slide" onRequestClose={() => setShowWallpaperPicker(false)}>
          <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'flex-end' }} onPress={() => setShowWallpaperPicker(false)}>
            <Pressable style={{ backgroundColor: colors.background, borderTopLeftRadius: 20, borderTopRightRadius: 20, padding: 20, paddingBottom: 40 }} onPress={e => e.stopPropagation()}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text, marginBottom: 16, textAlign: 'center' }}>
                {t('chatConv.wallpaper') || 'Papel de Parede'}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'center' }}>
                {/* No wallpaper */}
                <TouchableOpacity
                  onPress={() => { saveWallpaper('none'); setShowWallpaperPicker(false); }}
                  style={{
                    width: 52, height: 52, borderRadius: 26, borderWidth: 3,
                    borderColor: wallpaperColor === 'none' ? colors.primary : colors.border,
                    backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <IconX size={16} color={colors.textTertiary} />
                </TouchableOpacity>
                {/* Photo option */}
                <TouchableOpacity
                  onPress={async () => {
                    try {
                      const ImagePicker = require('expo-image-picker');
                      const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7 });
                      if (!result.canceled && result.assets?.[0]?.uri) {
                        saveWallpaper(result.assets[0].uri);
                        setShowWallpaperPicker(false);
                      }
                    } catch {}
                  }}
                  style={{
                    width: 52, height: 52, borderRadius: 26, borderWidth: 3,
                    borderColor: wallpaperColor && !wallpaperColor.startsWith('#') && wallpaperColor !== 'none' ? colors.primary : colors.border,
                    backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center',
                  }}
                >
                  <IconImage size={20} color={colors.primary} />
                </TouchableOpacity>
                {/* Color options */}
                {['#075E54', '#0C8767', '#E4DCD4', '#008069', '#1B3A2D', '#111B21', '#D5DBDF', '#EFEAE2', '#B3C8D6', '#FFC4C4'].map(c => (
                  <TouchableOpacity
                    key={c}
                    onPress={() => { saveWallpaper(c); setShowWallpaperPicker(false); }}
                    style={{
                      width: 52, height: 52, borderRadius: 26, backgroundColor: c, borderWidth: 3,
                      borderColor: wallpaperColor === c ? '#fff' : 'transparent',
                    }}
                  />
                ))}
              </View>
            </Pressable>
          </Pressable>
        </Modal>
      )}

      {/* Starred Messages Modal */}
      <Modal visible={showStarredModal} transparent animationType="slide" onRequestClose={() => setShowStarredModal(false)}>
        <View style={[styles.forwardModal, { backgroundColor: colors.background }]}>
          <View style={[styles.forwardHeader, { borderBottomColor: colors.border }]}>
            <Text style={[styles.forwardTitle, { color: colors.text }]}>{t('chat.starredMessages')}</Text>
            <TouchableOpacity onPress={() => setShowStarredModal(false)}><IconX size={22} color={colors.text} /></TouchableOpacity>
          </View>
          {starredLoading && starredMessages.length === 0 ? (
            <View style={{ flex: 1 }} />
          ) : starredMessages.length === 0 ? (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', padding: Spacing.lg }}>
              <IconStar size={48} color={colors.textTertiary} />
              <Text style={{ color: colors.textSecondary, fontSize: 15, marginTop: Spacing.md, textAlign: 'center' }}>{t('chat.noStarred')}</Text>
            </View>
          ) : (
            <FlatList
              data={starredMessages}
              keyExtractor={item => String(item.id)}
              contentContainerStyle={{ padding: Spacing.sm }}
              renderItem={({ item }) => (
                <TouchableOpacity
                  style={{ flexDirection: 'row', alignItems: 'center', padding: Spacing.sm, backgroundColor: colors.surface, borderRadius: BorderRadius.md, marginBottom: Spacing.xs }}
                  onPress={() => { setShowStarredModal(false); if (String(item.conversation_id) === String(conversationId)) { const idx = messages.findIndex(m => m.id === item.id); if (idx >= 0 && flatListRef.current) flatListRef.current.scrollToIndex({ index: idx, animated: true }); } }}
                >
                  <View style={{ flex: 1 }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 2 }}>
                      <IconStarFilled size={12} color="#f59e0b" style={{ marginRight: 4 }} />
                      <Text style={{ fontSize: 12, fontWeight: '600', color: colors.primary }} numberOfLines={1}>{item.sender_name || item.sender_email?.split('@')[0]}</Text>
                      {item.conversation_name ? <Text style={{ fontSize: 11, color: colors.textTertiary, marginLeft: 4 }} numberOfLines={1}>{item.conversation_name}</Text> : null}
                    </View>
                    <Text style={{ fontSize: 13, color: colors.text }} numberOfLines={2}>{item.type === 'text' ? item.content : `[${item.type}] ${item.file_name || item.content || ''}`}</Text>
                    <Text style={{ fontSize: 11, color: colors.textTertiary, marginTop: 2 }}>{formatTime(item.created_at)}</Text>
                  </View>
                </TouchableOpacity>
              )}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

// ============================================================
// STYLES
// ============================================================

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingBottom: 10, paddingTop: 4,
    borderBottomWidth: 0,
    zIndex: 10,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 4 },
      android: { elevation: 3 },
      web: { boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },
    }),
  },
  headerBtn: {
    width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center',
    ...(Platform.OS === 'web' ? { cursor: 'pointer', transition: 'background-color 0.15s ease, transform 0.15s ease' } : {}),
  },
  headerInfo: { flex: 1, marginHorizontal: 12 },
  headerTitle: { fontSize: 16.5, fontWeight: '700', letterSpacing: 0.15 },
  headerSubtitle: { fontSize: 11.5, marginTop: 2.5, opacity: 0.75, fontWeight: '500' },
  loaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  disappearingBanner: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
    paddingVertical: 8, paddingHorizontal: 14, gap: 6,
    borderBottomWidth: 0.5, borderBottomColor: 'rgba(0,0,0,0.06)',
  },
  disappearingBannerText: { fontSize: 12, fontWeight: '500', flex: 1 },
  disappearingBannerAction: { fontSize: 12, fontWeight: '700' },
  messageList: {
    paddingHorizontal: Spacing.sm, paddingTop: Spacing.xs,
    ...(Platform.OS === 'web' ? { maxWidth: 960, alignSelf: 'center', width: '100%' } : {}),
  },
  dateSeparator: {
    alignItems: 'center',
    marginVertical: 12,
  },
  dateLine: { flex: 1, height: 0 },
  dateText: {
    fontSize: 12, fontWeight: '500', letterSpacing: 0.1,
    paddingHorizontal: 14, paddingVertical: 6,
    borderRadius: 8, overflow: 'hidden',
    textTransform: 'capitalize',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 4 },
      android: { elevation: 1 },
      web: { boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
    }),
  },
  systemMsg: { alignItems: 'center', marginVertical: 8, paddingHorizontal: Spacing.lg },
  systemText: { fontSize: 12, textAlign: 'center', fontStyle: 'italic', lineHeight: 18, letterSpacing: 0.1 },
  scrollDownFab: {
    position: 'absolute', right: 16, bottom: 80,
    width: 44, height: 44, borderRadius: 22,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.2, shadowRadius: 14 },
      android: { elevation: 8 },
      web: { boxShadow: '0 4px 20px rgba(0,0,0,0.15)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', transition: 'transform 0.2s ease, box-shadow 0.2s ease' },
    }),
    zIndex: 10,
  },
  scrollDownBadge: {
    position: 'absolute', top: -6, right: -4,
    minWidth: 20, height: 20, borderRadius: 10,
    alignItems: 'center', justifyContent: 'center',
    paddingHorizontal: 4,
  },
  scrollDownBadgeText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  wallpaper: {
    ...StyleSheet.absoluteFillObject, zIndex: 0, overflow: 'hidden',
  },
  wallpaperPattern: {
    width: '100%', height: '100%',
    backgroundImage: `url("data:image/svg+xml,%3Csvg width='60' height='60' xmlns='http://www.w3.org/2000/svg'%3E%3Cg fill='%23666' fill-opacity='1'%3E%3Ccircle cx='10' cy='10' r='1.5'/%3E%3Ccircle cx='40' cy='25' r='1'/%3E%3Ccircle cx='25' cy='45' r='1.2'/%3E%3Cpath d='M50 5l3 5h-6z' fill-opacity='.5'/%3E%3Cpath d='M5 35l2 3.5h-4z' fill-opacity='.5'/%3E%3Cpath d='M55 50l2 3h-4z' fill-opacity='.4'/%3E%3C/g%3E%3C/svg%3E")`,
    backgroundRepeat: 'repeat',
  },
  msgRow: { maxWidth: Platform.OS === 'web' ? '65%' : '80%' },
  msgRowOwn: { alignSelf: 'flex-end', marginRight: 6 },
  msgRowOther: { alignSelf: 'flex-start', marginLeft: 6 },
  msgSenderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 2, marginLeft: 4 },
  msgSender: { fontSize: 12, fontWeight: '700' },
  replyIndicator: {
    borderLeftWidth: 4, borderRadius: 8,
    paddingHorizontal: 10, paddingVertical: 6,
    marginBottom: 4,
  },
  replyName: { fontSize: 12, fontWeight: '700', letterSpacing: 0.15 },
  replyText: { fontSize: 12.5, lineHeight: 17, marginTop: 2 },
  bubble: {
    borderRadius: 8, paddingHorizontal: 12,
    paddingTop: 6, paddingBottom: 6,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3 },
      android: { elevation: 1 },
      web: { boxShadow: '0 1px 1px rgba(0,0,0,0.06)' },
    }),
  },
  bubbleOwn: {
    borderTopRightRadius: 8, borderBottomRightRadius: 2,
    borderTopLeftRadius: 8, borderBottomLeftRadius: 8,
  },
  bubbleOther: {
    borderTopLeftRadius: 8, borderBottomLeftRadius: 2,
    borderTopRightRadius: 8, borderBottomRightRadius: 8,
    borderWidth: 0, borderColor: 'transparent',
  },
  bubbleDeleted: { opacity: 0.5 },
  msgText: { fontSize: 15, lineHeight: 21, letterSpacing: 0 },
  deletedText: { fontSize: 14, fontStyle: 'italic' },
  msgMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3, marginTop: 5 },
  editedLabel: { fontSize: 10, fontStyle: 'italic' },
  msgTime: { fontSize: 11, fontWeight: '400', letterSpacing: 0 },
  chatImage: {
    width: 240, height: 200, borderRadius: 16, marginBottom: 2,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 6 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 10px rgba(0,0,0,0.1)' },
    }),
  },
  videoThumb: { paddingVertical: 2 },
  videoPreviewWrap: { position: 'relative', width: 240, height: 140, borderRadius: 16, overflow: 'hidden', marginBottom: 4 },
  videoOverlayAbsolute: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    alignItems: 'center', justifyContent: 'center',
  },
  videoDurationBadge: {
    position: 'absolute', bottom: 6, right: 6,
    backgroundColor: 'rgba(0,0,0,0.7)', borderRadius: 4, paddingHorizontal: 6, paddingVertical: 2,
  },
  videoDurationText: { color: '#fff', fontSize: 10, fontWeight: '600' },
  videoOverlay: {
    width: 240, height: 140, borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  videoPlayBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  fileAttach: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, minWidth: 180 },
  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactionsRowOwn: { justifyContent: 'flex-end' },
  reactionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: 20, borderWidth: 1,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.08, shadowRadius: 4 },
      android: { elevation: 2 },
      web: { boxShadow: '0 2px 6px rgba(0,0,0,0.06)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)', transition: 'transform 0.15s ease' },
    }),
  },
  reactionEmoji: { fontSize: 15 },
  reactionCount: { fontSize: 11, fontWeight: '700' },
  loadMoreBtn: {
    alignSelf: 'center', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
    borderRadius: 20, borderWidth: 1, marginBottom: Spacing.sm,
  },
  loadMoreText: { fontSize: FontSize.sm, fontWeight: '500' },
  emptyMessages: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 },
  emptyText: { fontSize: FontSize.md },
  replyBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 12,
    borderTopWidth: 0, borderRadius: 16, marginHorizontal: 8, marginBottom: 4,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.06, shadowRadius: 6 },
      android: { elevation: 2 },
      web: { backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)', boxShadow: '0 2px 12px rgba(0,0,0,0.04)' },
    }),
  },
  replyBarLine: { width: 3.5, height: '100%', borderRadius: 2, marginRight: Spacing.sm },
  replyBarContent: { flex: 1 },
  replyBarLabel: { fontSize: 12, fontWeight: '700', letterSpacing: 0.1 },
  replyBarText: { fontSize: 13, marginTop: 2, lineHeight: 18 },
  replyBarClose: { padding: 10, borderRadius: 20 },
  uploadBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  uploadText: { fontSize: FontSize.sm },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 6, paddingTop: 6, paddingBottom: 6,
    gap: 5,
    borderTopWidth: 0,
    ...Platform.select({
      ios: {},
      android: {},
      web: { maxWidth: 960, alignSelf: 'center', width: '100%' },
    }),
  },
  attachBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'flex-end', marginBottom: 2,
  },
  input: {
    flex: 1, minHeight: 42, maxHeight: 120,
    borderRadius: 24, paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 11 : 9,
    paddingBottom: Platform.OS === 'ios' ? 11 : 9,
    fontSize: 15, borderWidth: 0,
    ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'flex-end', marginBottom: 2,
    ...Platform.select({
      ios: { shadowColor: '#25D366', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.3, shadowRadius: 8 },
      android: { elevation: 4 },
      web: { boxShadow: '0 2px 12px rgba(37,211,102,0.3)', transition: 'transform 0.15s ease, box-shadow 0.15s ease' },
    }),
  },
  modalOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
  },
  actionSheet: {
    borderRadius: 28, padding: Spacing.md,
    minWidth: 280, maxWidth: 340,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.25, shadowRadius: 32 },
      android: { elevation: 20 },
      web: { boxShadow: '0 12px 48px rgba(0,0,0,0.2), 0 4px 12px rgba(0,0,0,0.08)', backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)' },
    }),
  },
  quickReactions: {
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.lg,
    paddingVertical: Spacing.md,
  },
  quickReactionBtn: { padding: 10 },
  // Modern Context Menu styles
  ctxOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  ctxContainer: {
    borderRadius: 24, overflow: 'hidden',
    minWidth: 300, maxWidth: 360, width: '88%',
    ...Platform.select({
      ios: {
        backgroundColor: 'rgba(255,255,255,0.92)',
        shadowColor: '#000', shadowOffset: { width: 0, height: 16 }, shadowOpacity: 0.28, shadowRadius: 40,
      },
      android: { backgroundColor: 'rgba(255,255,255,0.95)', elevation: 24 },
      web: {
        backgroundColor: 'rgba(255,255,255,0.92)',
        boxShadow: '0 20px 60px rgba(0,0,0,0.22), 0 8px 20px rgba(0,0,0,0.08)',
        backdropFilter: 'blur(40px)', WebkitBackdropFilter: 'blur(40px)',
      },
    }),
  },
  ctxPreview: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 16, paddingVertical: 12,
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    gap: 10,
  },
  ctxPreviewSender: { fontSize: 13, fontWeight: '700', marginBottom: 2 },
  ctxPreviewText: { fontSize: 13, lineHeight: 18 },
  ctxPreviewTime: { fontSize: 11, fontWeight: '500', alignSelf: 'flex-start', marginTop: 2 },
  ctxReactionsRow: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    paddingVertical: 8, paddingHorizontal: 8,
    gap: 2,
  },
  ctxReactionBtn: {
    width: 48, height: 48, borderRadius: 24,
    justifyContent: 'center', alignItems: 'center',
  },
  ctxReactionAddBtn: {
    width: 40, height: 40, borderRadius: 20,
  },
  ctxIconBar: {
    flexDirection: 'row', justifyContent: 'center', alignItems: 'flex-start',
    paddingVertical: 12, paddingHorizontal: 8,
    gap: 4, borderBottomWidth: StyleSheet.hairlineWidth,
    flexWrap: 'wrap',
  },
  ctxIconBtn: {
    alignItems: 'center', justifyContent: 'center',
    width: 62, paddingVertical: 4,
  },
  ctxIconCircle: {
    width: 44, height: 44, borderRadius: 22,
    justifyContent: 'center', alignItems: 'center',
    marginBottom: 4,
  },
  ctxIconLabel: { fontSize: 10, fontWeight: '600', textAlign: 'center' },
  ctxSecondaryList: {
    paddingVertical: 4, paddingHorizontal: 8,
  },
  ctxSecondaryItem: {
    flexDirection: 'row', alignItems: 'center', gap: 14,
    paddingVertical: 13, paddingHorizontal: 12,
    borderRadius: 12,
  },
  ctxSecondaryText: { fontSize: 15, fontWeight: '500' },
  emojiPickerSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: Spacing.md, paddingBottom: 32, paddingTop: Spacing.md,
  },
  emojiPickerHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.sm, paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(128,128,128,0.2)',
  },
  emojiPickerTitle: { fontSize: FontSize.lg, fontWeight: '700' },
  emojiCategoryLabel: { fontSize: FontSize.sm, fontWeight: '600', marginTop: Spacing.md, marginBottom: Spacing.xs, paddingLeft: 4 },
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap' },
  emojiBtn: { width: '11.11%', aspectRatio: 1, justifyContent: 'center', alignItems: 'center' },
  emojiBtnText: { fontSize: 26 },
  actionDivider: { height: StyleSheet.hairlineWidth, marginVertical: Spacing.sm },
  actionItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: 14, paddingHorizontal: Spacing.sm,
    borderRadius: 12,
  },
  actionText: { fontSize: FontSize.md, fontWeight: '500' },
  messageInfoSheet: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    borderTopLeftRadius: 20, borderTopRightRadius: 20,
    paddingHorizontal: Spacing.lg, paddingBottom: 32, paddingTop: Spacing.md,
    maxHeight: '70%',
  },
  messageInfoHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: Spacing.md, paddingBottom: Spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: 'rgba(128,128,128,0.2)',
  },
  messageInfoTitle: { fontSize: FontSize.lg, fontWeight: '700' },
  messageInfoParticipant: { fontSize: FontSize.md, fontWeight: '600', marginTop: 12, marginBottom: 4 },
  messageInfoRow: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    paddingVertical: 6, paddingLeft: 4,
  },
  messageInfoDot: {
    width: 8, height: 8, borderRadius: 4, marginTop: 5,
  },
  messageInfoLabel: { fontSize: 12, fontWeight: '500' },
  messageInfoTime: { fontSize: 14, fontWeight: '400', marginTop: 1 },
  messageInfoDivider: { height: StyleSheet.hairlineWidth, marginVertical: 8 },
  messageInfoEmpty: { fontSize: 14, textAlign: 'center', paddingVertical: 20 },
  forwardModal: {
    flex: 1, marginTop: 80, borderTopLeftRadius: 24, borderTopRightRadius: 24,
    ...Shadow.lg,
  },
  forwardHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: Spacing.md, paddingTop: Spacing.lg, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  forwardTitle: { fontSize: FontSize.lg, fontWeight: '700' },
  forwardItem: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  forwardItemName: { fontSize: FontSize.md, fontWeight: '500', flex: 1 },
  forwardItemType: { fontSize: FontSize.xs, marginLeft: Spacing.sm },
  forwardEmpty: { textAlign: 'center', padding: Spacing.xl, fontSize: FontSize.md },
  groupLabel: { fontSize: FontSize.sm, fontWeight: '600', marginBottom: Spacing.xs },
  groupNameInput: {
    fontSize: FontSize.md, padding: Spacing.sm,
    borderWidth: 1, borderRadius: BorderRadius.md, marginBottom: Spacing.sm,
  },
  groupSaveBtn: {
    alignItems: 'center', paddingVertical: Spacing.sm,
    borderRadius: BorderRadius.md, marginBottom: Spacing.md,
  },
  memberRow: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.sm,
    paddingVertical: Spacing.sm, borderBottomWidth: StyleSheet.hairlineWidth,
  },
  memberAvatar: {
    width: 36, height: 36, borderRadius: 18,
    alignItems: 'center', justifyContent: 'center',
  },
  profileViewerOverlay: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.9)',
    justifyContent: 'center', alignItems: 'center',
  },
  profileViewerContent: {
    alignItems: 'center', gap: 16,
  },
  profileViewerImage: {
    width: Dimensions.get('window').width * 0.7,
    height: Dimensions.get('window').width * 0.7,
    borderRadius: Dimensions.get('window').width * 0.35,
  },
  profileViewerName: {
    color: '#fff', fontSize: 24, fontWeight: '700', textAlign: 'center',
  },
  profileViewerEmail: {
    color: 'rgba(255,255,255,0.6)', fontSize: 14, textAlign: 'center',
  },
  profileViewerClose: {
    position: 'absolute', top: 50, right: 20,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
});
