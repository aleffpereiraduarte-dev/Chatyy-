import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, FlatList, Text, TouchableOpacity, StyleSheet, Image, InteractionManager,
  ActivityIndicator, TextInput, Platform, Keyboard, Dimensions,
  Alert, Modal, Pressable, Linking, Animated, ScrollView, PanResponder, Share, BackHandler,
} from 'react-native';
// FlashList reverted to FlatList
// Native UICollectionView chat view (iOS only) — WhatsApp-style instant render.
// Reads messages directly from SQLite via expo-chat-cache, on the same thread
// that lays out the cells. No JS bridge in the scroll path = no flicker.
import { NativeModules } from 'react-native';
const _NativeChatView = (() => {
  if (Platform.OS !== 'ios') return null;
  try { return require('../modules/expo-native-chat-view').default; } catch { return null; }
})();
import Svg, { Path } from 'react-native-svg';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth, isChildAccount, getChildRestrictions } from '../context/AuthContext';
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
  IconClock, IconAlertTriangle, IconLock, IconForward, IconChevronDown, IconWifiOff,
  IconStar, IconStarFilled, IconBarChart, IconInfo, IconGlobe,
  IconCopy, IconPin, IconShield, IconBell, IconCalendar, IconSearch,
} from '../components/Icons';
import * as Clipboard from 'expo-clipboard';
import { WebView } from 'react-native-webview';
import ChatMediaViewer from '../components/ChatMediaViewer';
import AvatarCircle from '../components/AvatarCircle';
import { registerAudioPlayer, stopAllAudio } from '../services/audioManager';
import { getCachedAudioUri } from '../services/audioCache';
import ProfileViewerModal from '../components/ProfileViewerModal';
import { MentionAutocomplete, isMentioning, insertMention, isUserMentioned } from '../components/MentionInput';
import { ScheduleToast, CustomScheduleModal, ScheduledMessagesModal } from '../components/ScheduleModals';
import GifPickerPanel from '../components/GifPicker';
import StickerPicker from '../components/StickerPicker';
import MediaGallery from '../components/MediaGallery';
import FormatToolbar from '../components/FormatToolbar';
import { getCachedUri, preCacheUrls, cacheMedia, saveMediaPermanent, saveConversationMedia } from '../services/mediaCache';
const ExpoImage = Image;
import { cacheMessages, getCachedMessages, getLastSyncId, cacheSingleMessage, savePendingMessage, removePendingMessage, getPendingMessages } from '../services/chatCache';
import SyncBar from '../components/SyncBar';
let ChatBubbleSkeleton = null; try { ChatBubbleSkeleton = require('../components/SkeletonLoader').ChatBubbleSkeleton; } catch {}

// ============================================================
// ANIMATED PRESSABLE (scale-on-press micro-interaction)
// ============================================================
function AnimatedPressable({ children, onPress, onLongPress, delayLongPress, style, activeOpacity = 0.9, ...props }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  const nd = Platform.OS !== 'web';
  const handlePressIn = () => {
    Animated.spring(scaleAnim, { toValue: 0.92, useNativeDriver: false, tension: 400, friction: 12 }).start();
  };
  const handlePressOut = () => {
    Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: false, tension: 200, friction: 10 }).start();
  };
  return (
    <TouchableOpacity onPress={onPress} onLongPress={onLongPress} delayLongPress={delayLongPress} onPressIn={handlePressIn} onPressOut={handlePressOut} activeOpacity={activeOpacity} {...props}>
      <Animated.View style={[style, { transform: [{ scale: scaleAnim }] }]}>
        {children}
      </Animated.View>
    </TouchableOpacity>
  );
}

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
// MESSAGE SEND ANIMATION (spring slide-up + fade-in for new messages)
// ============================================================
function MessageSendAnim({ children, animate }) {
  const translateY = useRef(new Animated.Value(animate ? 30 : 0)).current;
  const opacity = useRef(new Animated.Value(animate ? 0 : 1)).current;
  const scale = useRef(new Animated.Value(animate ? 0.92 : 1)).current;
  useEffect(() => {
    if (animate) {
      const nd = Platform.OS !== 'web';
      Animated.parallel([
        Animated.spring(translateY, { toValue: 0, useNativeDriver: false, tension: 120, friction: 14 }),
        Animated.spring(scale, { toValue: 1, useNativeDriver: false, tension: 120, friction: 14 }),
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: false }),
      ]).start();
    }
  }, []);
  if (!animate) return children;
  return (
    <Animated.View style={{ transform: [{ translateY }, { scale }], opacity }}>
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
          Animated.timing(dot, { toValue: -5, duration: 250, useNativeDriver: false }),
          Animated.timing(dot, { toValue: 0, duration: 250, useNativeDriver: false }),
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
    <View style={{ alignSelf: 'flex-start', marginBottom: 10, marginLeft: 14 }}>
      {name && <Text style={{ fontSize: 11.5, color: colors.textTertiary, marginBottom: 4, marginLeft: 10, fontWeight: '700', letterSpacing: 0 }}>{name}</Text>}
      <View style={{
        backgroundColor: colors.surface,
        borderRadius: 22, borderBottomLeftRadius: 6,
        paddingHorizontal: 18, paddingVertical: 14,
        flexDirection: 'row', gap: 7, alignItems: 'center', minWidth: 64,
        ...Platform.select({
          ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 10 },
          android: { elevation: 3 },
          web: { boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 4px 14px rgba(0,0,0,0.08)' },
        }),
      }}>
        {recording ? (
          <>
            <IconMic size={15} color={colors.error || '#EF4444'} style={{ marginRight: 3 }} />
            <Text style={{ fontSize: 12.5, color: colors.textTertiary, fontStyle: 'italic', fontWeight: '600' }}>{t ? t('chat.recording') : 'gravando...'}</Text>
          </>
        ) : (
          [dot1, dot2, dot3].map((dot, i) => (
            <Animated.View key={i} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#25D366', transform: [{ translateY: dot }] }} />
          ))
        )}
      </View>
    </View>
  );
}

// ============================================================
// RICH TEXT FORMATTING (WhatsApp-style)
// ============================================================
// Spoiler that toggles on tap (Telegram-style ||spoiler||)
function SpoilerText({ children, style }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Text
      style={[
        style,
        !revealed && {
          backgroundColor: 'rgba(120,120,120,0.55)',
          color: 'transparent',
        },
      ]}
      onPress={() => setRevealed(true)}
      suppressHighlighting
    >
      {children}
    </Text>
  );
}

function FormattedText({ text, style, colors }) {
  if (!text) return <Text style={style}>{''}</Text>;
  const parts = [];
  // Match ||spoiler||, ```code blocks```, *bold*, _italic_, ~strike~, `inline code`
  const formatRegex = /(\|\|[^|\n]+\|\||```[\s\S]+?```|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~|`[^`\n]+`)/g;
  let lastIndex = 0;
  let match;

  while ((match = formatRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), fmt: null });
    }
    const raw = match[0];
    if (raw.startsWith('||') && raw.endsWith('||')) {
      parts.push({ text: raw.slice(2, -2), spoiler: true });
    } else if (raw.startsWith('```') && raw.endsWith('```')) {
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
      {parts.map((p, i) =>
        p.spoiler ? (
          <SpoilerText key={i} style={style}>{p.text}</SpoilerText>
        ) : (
          <Text key={i} style={p.fmt}>{p.text}</Text>
        )
      )}
    </Text>
  );
}

// ============================================================
// TEXT WITH CLICKABLE LINKS + @MENTIONS + #HASHTAGS
// ============================================================
const URL_REGEX = /(https?:\/\/[^\s<]+)/g;
const MENTION_PAT = /@([\w.\-]+(?:@[\w.\-]+\.\w+)?)/g;
const HASHTAG_PAT = /(?:^|\s)(#[\w\u00C0-\u017F]{2,30})/g;

function TextWithLinks({ text, style, linkColor, colors, mentionColor, router: routerProp }) {
  if (!text) return null;
  const urlParts = text.split(URL_REGEX);
  const mTest = new RegExp(MENTION_PAT.source);
  const hTest = new RegExp(HASHTAG_PAT.source);
  const hasMentions = mTest.test(text);
  const hasHashtags = hTest.test(text);
  if (urlParts.length === 1 && !hasMentions && !hasHashtags) {
    return <FormattedText text={text} style={style} colors={colors} />;
  }
  // Parse hashtags inside a string segment, returning array of segments to render
  const renderHashtags = (str, kp) => {
    const hRe = new RegExp(HASHTAG_PAT.source, 'g');
    const segs = []; let li = 0, ht;
    while ((ht = hRe.exec(str)) !== null) {
      const tagStart = ht.index + (ht[0].length - ht[1].length);
      if (tagStart > li) segs.push({ t: 'x', v: str.slice(li, tagStart) });
      segs.push({ t: '#', v: ht[1] });
      li = hRe.lastIndex;
    }
    if (li < str.length) segs.push({ t: 'x', v: str.slice(li) });
    return segs.map((p, j) =>
      p.t === '#' ? (
        <Text
          key={`${kp}_h${j}`}
          style={{ color: linkColor, fontWeight: '600' }}
          onPress={() => { try { routerProp?.push({ pathname: '/chat-conversation', params: { searchHashtag: p.v } }); } catch {} }}
        >{p.v}</Text>
      ) : (
        <FormattedText key={`${kp}_x${j}`} text={p.v} colors={colors} />
      )
    );
  };
  const renderMentions = (str, kp) => {
    if (!str) return null;
    if (!mTest.test(str)) return renderHashtags(str, kp);
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
        : renderHashtags(p.v, `${kp}_t${j}`)
    );
  };
  return (
    <Text style={style}>
      {urlParts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <Text key={i} style={{ color: linkColor, textDecorationLine: 'underline' }}
            onPress={() => { try { if (/chatyy\.com\.br\/docs\//.test(part) && routerProp) { routerProp.push({ pathname: '/documentos', params: { url: part } }); } else { Linking.openURL(part); } } catch {} }}>
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
    borderWidth: 0, borderRadius: 16, overflow: 'hidden', marginTop: 6, maxWidth: 280,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 8 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 12px rgba(0,0,0,0.1)' },
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
  try { _NativeSwipeable = require('react-native-gesture-handler').Swipeable; } catch {}
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
    // Fix PostgreSQL timezone format: +00 → +00:00
    s = s.replace(/([+-]\d{2})$/, '$1:00');
    if (!s.includes('Z') && !s.includes('+') && !s.includes('-', 10)) s += 'Z';
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

function AudioPlayer({ url, duration, isOwn, colors, messageId }) {
  const isDarkMode = colors.background === '#0B141A' || colors.background === '#000' || colors.background === '#000000' || (colors.background && colors.background.startsWith('#0'));
  const ownMetaColor = isDarkMode ? 'rgba(233,237,239,0.6)' : 'rgba(17,27,33,0.45)';
  const ownTextColor = isDarkMode ? '#E9EDEF' : '#111B21';
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [caching, setCaching] = useState(false);
  const [cacheProgress, setCacheProgress] = useState(0);
  const soundRef = useRef(null);
  const intervalRef = useRef(null);
  const cachedUriRef = useRef(null);
  const cachingRef = useRef(false);
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

  // Pre-cache audio on mount
  useEffect(() => {
    const unregister = registerAudioPlayer(stopPlayback);
    let cancelled = false;

    if (url) {
      // Start caching in background
      getCachedAudioUri(url, messageId, (p) => {
        if (!cancelled) setCacheProgress(p);
      }).then(localUri => {
        if (!cancelled && localUri) {
          cachedUriRef.current = localUri;
          // On web: preload the cached/blob URL into an Audio element
          if (Platform.OS === 'web') {
            try {
              const audio = new window.Audio();
              audio.preload = 'auto';
              audio.src = localUri;
              audio.onended = () => { setPlaying(false); setProgress(0); setCurrentTime(0); if (intervalRef.current) clearInterval(intervalRef.current); };
              audio.onerror = () => { soundRef.current = null; };
              soundRef.current = audio;
            } catch {}
          }
        }
      }).catch(() => {});
    }

    return () => {
      cancelled = true;
      unregister();
      if (Platform.OS === 'web') {
        try { soundRef.current?.pause(); } catch {}
        // Revoke blob URLs to prevent memory leaks
        if (cachedUriRef.current && cachedUriRef.current.startsWith('blob:')) {
          try { URL.revokeObjectURL(cachedUriRef.current); } catch {}
        }
      } else {
        try { soundRef.current?._subscription?.remove?.(); } catch {}
        soundRef.current?.remove?.();
        soundRef.current = null;
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [stopPlayback, url, messageId]);

  // Resolve the best URI to play (cached local or original remote)
  const resolvePlayUri = useCallback(async () => {
    // If we already have a cached URI from the pre-cache, use it
    if (cachedUriRef.current) return cachedUriRef.current;

    // Otherwise try to cache now (with progress indicator)
    if (cachingRef.current) return url; // Already caching, use remote for now
    cachingRef.current = true;
    setCaching(true);
    try {
      const localUri = await getCachedAudioUri(url, messageId, (p) => setCacheProgress(p));
      cachedUriRef.current = localUri || url;
      return cachedUriRef.current;
    } catch {
      return url;
    } finally {
      setCaching(false);
      cachingRef.current = false;
    }
  }, [url, messageId]);

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
          const playUri = await resolvePlayUri();
          if (!playUri) { console.warn('Audio URL is empty'); return; }
          const audio = new window.Audio(playUri);
          audio.preload = 'auto';
          audio.onended = () => { setPlaying(false); setProgress(0); setCurrentTime(0); if (intervalRef.current) clearInterval(intervalRef.current); };
          audio.onerror = () => { setPlaying(false); soundRef.current = null; };
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
        const playUri = await resolvePlayUri();
        if (!playUri) { console.warn('Audio URL is empty'); return; }
        await setAudioModeAsync({ playsInSilentMode: true });
        const player = createAudioPlayer({ uri: playUri });
        const subscription = player.addListener('playbackStatusUpdate', (status) => {
          if (status.error) { console.warn('Audio playback error:', status.error); setPlaying(false); return; }
          if (status.playing && status.duration > 0) {
            setProgress(status.currentTime / status.duration);
            setCurrentTime(status.currentTime);
          }
          if (!status.playing && status.currentTime >= status.duration && status.duration > 0) {
            setPlaying(false); setProgress(0); setCurrentTime(0); if (intervalRef.current) clearInterval(intervalRef.current);
          }
        });
        soundRef.current = player;
        soundRef.current._subscription = subscription;
        player.play();
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
      <View style={{ position: 'relative' }}>
        <TouchableOpacity onPress={togglePlay} style={[audioStyles.playBtn, { backgroundColor: isOwn ? 'rgba(255,255,255,0.15)' : colors.primary + '18' }]} accessibilityLabel={caching ? 'Downloading' : playing ? 'Pause' : 'Play'} accessibilityRole="button">
          {caching ? (
            <ActivityIndicator size={18} color={tintColor} />
          ) : playing ? (
            <IconPause size={20} color={tintColor} />
          ) : (
            <IconPlay size={20} color={tintColor} />
          )}
        </TouchableOpacity>
        {caching && cacheProgress > 0 && cacheProgress < 1 && (
          <View style={{ position: 'absolute', bottom: -2, left: 4, right: 4, height: 2, borderRadius: 1, backgroundColor: tintDim, overflow: 'hidden' }}>
            <View style={{ width: `${Math.round(cacheProgress * 100)}%`, height: '100%', backgroundColor: tintColor, borderRadius: 1 }} />
          </View>
        )}
      </View>
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

  // Use OpenStreetMap tiles via Leaflet — free, no API key, no quota
  const buildMapHtml = (showPulse) => lat && lng ? `<!DOCTYPE html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>*{margin:0;padding:0;pointer-events:none}html,body,#map{width:100%;height:100%;background:#dde6ed}.leaflet-control-attribution{display:none!important}</style>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
</head><body><div id="map"></div><script>
var map=L.map('map',{zoomControl:false,attributionControl:false,dragging:false,scrollWheelZoom:false,doubleClickZoom:false,touchZoom:false,keyboard:false}).setView([${lat},${lng}],15);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png',{maxZoom:19}).addTo(map);
var marker=L.circleMarker([${lat},${lng}],{radius:8,fillColor:'#${showPulse ? '3b82f6' : 'ef4444'}',fillOpacity:1,color:'#fff',weight:3}).addTo(map);
${showPulse ? `var pulse=L.circleMarker([${lat},${lng}],{radius:16,fillColor:'#3b82f6',fillOpacity:0.25,color:'#3b82f6',weight:1}).addTo(map);
var s=16,g=true;setInterval(function(){s+=g?0.5:-0.5;if(s>=24)g=false;if(s<=12)g=true;pulse.setRadius(s);},50);` : ''}
window.updatePos=function(la,ln){var p=[la,ln];marker.setLatLng(p);${showPulse ? 'pulse.setLatLng(p);' : ''}map.panTo(p);};
</script></body></html>` : '';
  const staticMapHtml = buildMapHtml(false);
  const liveMapHtml = buildMapHtml(true);
  // Static fallback URL (no key needed)
  const staticMapUrl = lat && lng
    ? `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=15&size=440x240&markers=${lat},${lng},red-pushpin`
    : null;

  const handlePress = () => {
    if (lat && lng && onOpenMap) {
      onOpenMap({ lat, lng, label, isLive, liveUntil });
    }
  };

  return (
    <TouchableOpacity onPress={handlePress} activeOpacity={0.8} style={locStyles.container}>
      {lat && lng && (
        <View style={locStyles.mapImage}>
          {Platform.OS !== 'web' ? (
            <WebView
              source={{ html: isStillLive ? liveMapHtml : staticMapHtml }}
              style={{ width: 220, height: 120 }}
              scrollEnabled={false}
              javaScriptEnabled
              originWhitelist={['*']}
              pointerEvents="none"
            />
          ) : (
            <View style={{ width: 220, height: 120, position: 'relative' }}>
              <iframe
                srcDoc={isStillLive ? liveMapHtml : staticMapHtml}
                style={{ width: 220, height: 120, border: 'none', pointerEvents: 'none' }}
                title="map"
              />
            </View>
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

function CallMessage({ content, isOwn, colors, currentEmail, isDarkMode }) {
  let callData;
  try { callData = JSON.parse(content); } catch { return null; }
  if (!callData?.call_type) return null;

  const isVideo = callData.call_type === 'video';
  const isCaller = callData.caller_email === currentEmail;
  const isIncoming = !isCaller;
  const ownTextColor = isDarkMode ? '#E9EDEF' : '#111B21';
  const ownMetaColor = isDarkMode ? 'rgba(233,237,239,0.6)' : 'rgba(17,27,33,0.45)';

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
  const [addressSuggestions, setAddressSuggestions] = useState([]);
  const [searchingAddress, setSearchingAddress] = useState(false);
  const [pickedCoords, setPickedCoords] = useState(null); // { lat, lng }
  const addrDebounceRef = useRef(null);

  // Nominatim autocomplete (free OpenStreetMap geocoding)
  useEffect(() => {
    if (addrDebounceRef.current) clearTimeout(addrDebounceRef.current);
    const q = location.trim();
    if (q.length < 3 || pickedCoords) {
      setAddressSuggestions([]);
      return;
    }
    addrDebounceRef.current = setTimeout(async () => {
      setSearchingAddress(true);
      try {
        const r = await fetch(
          `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=5&addressdetails=1&accept-language=pt-BR`,
          { headers: { 'User-Agent': 'Chatyy/1.0' } }
        );
        const data = await r.json();
        setAddressSuggestions(Array.isArray(data) ? data : []);
      } catch {
        setAddressSuggestions([]);
      } finally {
        setSearchingAddress(false);
      }
    }, 400);
    return () => { if (addrDebounceRef.current) clearTimeout(addrDebounceRef.current); };
  }, [location, pickedCoords]);

  const pickAddress = (item) => {
    setLocation(item.display_name);
    setPickedCoords({ lat: parseFloat(item.lat), lng: parseFloat(item.lon) });
    setAddressSuggestions([]);
  };

  const handleCreate = async () => {
    if (!title.trim() || !dateText.trim()) return;
    setSending(true);
    try {
      // Pass coords as part of location string if picked: "address|lat,lng"
      const locStr = pickedCoords
        ? `${location.trim()}|${pickedCoords.lat},${pickedCoords.lng}`
        : location.trim();
      const r = await api.chatCreateMeetup(conversationId, title.trim(), dateText.trim(), locStr, description.trim());
      if (r.success && r.data) {
        onCreated({
          id: r.data.id,
          sender_email: '',
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
        <View style={{ marginBottom: 12 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.background, paddingHorizontal: 10 }}>
            <Text style={{ fontSize: 16, marginRight: 6 }}>📍</Text>
            <TextInput
              style={{ flex: 1, padding: 10, fontSize: 15, color: colors.text, paddingLeft: 0 }}
              placeholder="Buscar endereço (rua, cidade, ponto turístico...)"
              placeholderTextColor={colors.textTertiary}
              value={location}
              onChangeText={(v) => { setLocation(v); setPickedCoords(null); }}
              autoCapitalize="none"
            />
            {searchingAddress && <ActivityIndicator size="small" color="#ec4899" />}
            {pickedCoords && <Text style={{ fontSize: 14 }}>✅</Text>}
          </View>
          {addressSuggestions.length > 0 && (
            <View style={{ marginTop: 4, borderWidth: 1, borderColor: colors.border, borderRadius: 10, backgroundColor: colors.surface, maxHeight: 200, overflow: 'hidden' }}>
              <ScrollView keyboardShouldPersistTaps="handled" nestedScrollEnabled>
                {addressSuggestions.map((s, idx) => (
                  <TouchableOpacity
                    key={s.place_id || idx}
                    onPress={() => pickAddress(s)}
                    style={{ paddingHorizontal: 12, paddingVertical: 10, borderBottomWidth: idx < addressSuggestions.length - 1 ? 1 : 0, borderBottomColor: colors.border + '40', flexDirection: 'row', alignItems: 'flex-start', gap: 8 }}
                    activeOpacity={0.6}
                  >
                    <Text style={{ fontSize: 14, marginTop: 1 }}>📍</Text>
                    <Text style={{ flex: 1, fontSize: 13, color: colors.text, lineHeight: 18 }} numberOfLines={2}>
                      {s.display_name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            </View>
          )}
        </View>

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
// PLAYLIST CREATOR MODAL — with Deezer song search
// ============================================================
function PlaylistCreatorModal({ colors, t, conversationId, onClose, onCreated }) {
  const [name, setName] = useState('');
  const [sending, setSending] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [selectedSongs, setSelectedSongs] = useState([]);
  const debounceRef = useRef(null);

  // Debounced search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!searchQuery.trim() || searchQuery.trim().length < 2) {
      setSearchResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const tracks = await api.searchDeezerMusic(searchQuery.trim());
        setSearchResults(tracks || []);
      } catch {} finally {
        setSearching(false);
      }
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery]);

  const toggleSong = (track) => {
    setSelectedSongs(prev => {
      const exists = prev.find(s => s.id === track.id);
      if (exists) return prev.filter(s => s.id !== track.id);
      return [...prev, track];
    });
  };

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSending(true);
    try {
      const r = await api.chatCreatePlaylist(conversationId, name.trim());
      if (r.success && r.data) {
        const playlistMsg = r.data.message || r.data;
        // Add all selected songs to the playlist
        for (const song of selectedSongs) {
          try {
            await api.chatPlaylistAddSong(playlistMsg.id, {
              title: song.title,
              artist: song.artist,
              url: '',
              cover: song.coverUrl || '',
              preview_url: song.previewUrl || '',
              duration: song.duration || 30,
            });
          } catch {}
        }
        onCreated(playlistMsg);
      } else { onClose(); }
    } catch { onClose(); }
    setSending(false);
  };

  return (
    <Pressable style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.6)' }} onPress={onClose}>
      <Pressable
        style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: 24, borderTopRightRadius: 24,
          paddingHorizontal: 18, paddingTop: 16, paddingBottom: 24,
          maxHeight: '88%',
        }}
        onPress={e => e.stopPropagation()}
      >
        {/* Drag handle */}
        <View style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, backgroundColor: colors.border, marginBottom: 14 }} />

        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 14 }}>
          <View style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: '#a855f7' + '20', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
            <Text style={{ fontSize: 22 }}>🎵</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ fontSize: 18, fontWeight: '800', color: colors.text }}>
              {t('chatConv.createPlaylist') || 'Criar Playlist'}
            </Text>
            <Text style={{ fontSize: 12, color: colors.textTertiary, marginTop: 1 }}>
              {selectedSongs.length === 0 ? 'Adicione músicas pra começar' : `${selectedSongs.length} música${selectedSongs.length > 1 ? 's' : ''} selecionada${selectedSongs.length > 1 ? 's' : ''}`}
            </Text>
          </View>
        </View>

        {/* Playlist name input */}
        <TextInput
          style={{
            borderWidth: 1, borderColor: colors.border, borderRadius: 12,
            paddingHorizontal: 14, height: 44, fontSize: 15,
            color: colors.text, marginBottom: 12, backgroundColor: colors.background,
          }}
          placeholder={t('chatConv.playlistNamePlaceholder') || 'Nome da playlist...'}
          placeholderTextColor={colors.textTertiary}
          value={name}
          onChangeText={setName}
        />

        {/* Search bar */}
        <View style={{
          flexDirection: 'row', alignItems: 'center', gap: 10,
          borderWidth: 1, borderColor: colors.border, borderRadius: 12,
          paddingHorizontal: 14, height: 44, backgroundColor: colors.background, marginBottom: 12,
        }}>
          <Text style={{ fontSize: 16 }}>🔍</Text>
          <TextInput
            style={{ flex: 1, fontSize: 14, color: colors.text, paddingVertical: 0 }}
            placeholder="Buscar música no Deezer..."
            placeholderTextColor={colors.textTertiary}
            value={searchQuery}
            onChangeText={setSearchQuery}
            autoCapitalize="none"
          />
          {searching && <ActivityIndicator size="small" color="#a855f7" />}
        </View>

        {/* Selected songs chip strip */}
        {selectedSongs.length > 0 && (
          <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 10 }} contentContainerStyle={{ gap: 6, paddingHorizontal: 2 }}>
            {selectedSongs.map((s, i) => (
              <View key={s.id || i} style={{
                flexDirection: 'row', alignItems: 'center', gap: 6,
                backgroundColor: '#a855f7' + '22',
                borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6,
                maxWidth: 200,
              }}>
                <Text style={{ fontSize: 11, color: '#a855f7', fontWeight: '700' }} numberOfLines={1}>{s.title}</Text>
                <TouchableOpacity onPress={() => toggleSong(s)} hitSlop={6}>
                  <Text style={{ color: '#a855f7', fontSize: 14, fontWeight: '900' }}>×</Text>
                </TouchableOpacity>
              </View>
            ))}
          </ScrollView>
        )}

        {/* Search results */}
        <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled">
          {searchResults.length === 0 && !searching && searchQuery.length >= 2 && (
            <Text style={{ textAlign: 'center', color: colors.textTertiary, fontSize: 13, paddingVertical: 24 }}>
              Nenhuma música encontrada
            </Text>
          )}
          {searchResults.length === 0 && !searching && searchQuery.length < 2 && (
            <View style={{ alignItems: 'center', paddingVertical: 32 }}>
              <Text style={{ fontSize: 48, marginBottom: 8 }}>🎶</Text>
              <Text style={{ color: colors.textTertiary, fontSize: 13, textAlign: 'center' }}>
                Digite o nome de uma música ou artista pra começar
              </Text>
            </View>
          )}
          {searchResults.map((track, idx) => {
            const isSelected = !!selectedSongs.find(s => s.id === track.id);
            return (
              <TouchableOpacity
                key={track.id || idx}
                onPress={() => toggleSong(track)}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 12,
                  paddingVertical: 8, paddingHorizontal: 4,
                  borderRadius: 10,
                  backgroundColor: isSelected ? '#a855f7' + '12' : 'transparent',
                  marginBottom: 4,
                }}
                activeOpacity={0.6}
              >
                {track.coverUrl
                  ? <Image source={{ uri: track.coverUrl }} style={{ width: 48, height: 48, borderRadius: 6 }} />
                  : <View style={{ width: 48, height: 48, borderRadius: 6, backgroundColor: '#a855f7' + '22', alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 22 }}>🎵</Text></View>}
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 14, fontWeight: '600', color: colors.text }} numberOfLines={1}>{track.title}</Text>
                  <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }} numberOfLines={1}>{track.artist}</Text>
                </View>
                <View style={{
                  width: 28, height: 28, borderRadius: 14,
                  borderWidth: 2,
                  borderColor: isSelected ? '#a855f7' : colors.border,
                  backgroundColor: isSelected ? '#a855f7' : 'transparent',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  {isSelected && <Text style={{ color: '#fff', fontSize: 14, fontWeight: '900' }}>✓</Text>}
                </View>
              </TouchableOpacity>
            );
          })}
        </ScrollView>

        <TouchableOpacity
          onPress={handleCreate}
          disabled={sending || !name.trim()}
          style={{
            backgroundColor: !name.trim() ? colors.border : '#a855f7',
            borderRadius: 14, paddingVertical: 14, alignItems: 'center', marginTop: 10,
          }}
        >
          {sending
            ? <ActivityIndicator color="#fff" />
            : <Text style={{ color: '#fff', fontSize: 15, fontWeight: '700' }}>
                {selectedSongs.length === 0
                  ? (t('chatConv.createPlaylistEmpty') || 'Criar playlist vazia')
                  : `Criar playlist com ${selectedSongs.length} música${selectedSongs.length > 1 ? 's' : ''}`}
              </Text>
          }
        </TouchableOpacity>
      </Pressable>
    </Pressable>
  );
}

// ============================================================
// PLAYLIST EDITOR MODAL — add/remove songs from existing playlist
// ============================================================
function PlaylistEditorModal({ colors, isDark, t, editor, onClose, onUpdated }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [songs, setSongs] = useState(editor?.playlist?.songs || []);
  const [busy, setBusy] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => { setSongs(editor?.playlist?.songs || []); }, [editor]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!searchQuery.trim() || searchQuery.trim().length < 2) { setSearchResults([]); return; }
    debounceRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const tracks = await api.searchDeezerMusic(searchQuery.trim());
        setSearchResults(tracks || []);
      } catch {} finally { setSearching(false); }
    }, 350);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [searchQuery]);

  const addSong = async (track) => {
    if (!editor?.messageId) return;
    setBusy(true);
    try {
      const r = await api.chatPlaylistAddSong(editor.messageId, {
        title: track.title,
        artist: track.artist,
        url: '',
        cover: track.coverUrl || '',
        preview_url: track.previewUrl || '',
        duration: track.duration || 30,
      });
      if (r?.success && Array.isArray(r.data?.songs)) {
        setSongs(r.data.songs);
        onUpdated?.({ messageId: editor.messageId, playlist: { ...editor.playlist, songs: r.data.songs } });
      }
    } catch {} finally { setBusy(false); }
  };

  const removeSong = async (idx) => {
    if (!editor?.messageId) return;
    setBusy(true);
    try {
      const r = await api.chatPlaylistRemoveSong(editor.messageId, idx);
      if (r?.success && Array.isArray(r.data?.songs)) {
        setSongs(r.data.songs);
        onUpdated?.({ messageId: editor.messageId, playlist: { ...editor.playlist, songs: r.data.songs } });
      }
    } catch {} finally { setBusy(false); }
  };

  if (!editor) return null;

  return (
    <Pressable style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.65)' }} onPress={onClose}>
      <Pressable
        style={{
          backgroundColor: colors.surface,
          borderTopLeftRadius: 28, borderTopRightRadius: 28,
          paddingTop: 0, paddingBottom: 24,
          maxHeight: '92%',
          overflow: 'hidden',
          ...(Platform.OS === 'web' ? { boxShadow: '0 -8px 40px rgba(168,85,247,0.20)' } : {}),
        }}
        onPress={e => e.stopPropagation()}
      >
        {/* Gradient header — purple → pink */}
        <View style={{
          paddingHorizontal: 20, paddingTop: 16, paddingBottom: 18,
          ...(Platform.OS === 'web'
            ? { background: 'linear-gradient(135deg, #a855f7 0%, #ec4899 100%)' }
            : { backgroundColor: '#a855f7' }),
        }}>
          <View style={{ alignSelf: 'center', width: 44, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.5)', marginBottom: 14 }} />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
            {/* Big album-art tile — uses first song cover or fallback */}
            {songs[0]?.cover ? (
              <Image source={{ uri: songs[0].cover }} style={{
                width: 64, height: 64, borderRadius: 12, borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)',
                ...(Platform.OS === 'web' ? { boxShadow: '0 4px 18px rgba(0,0,0,0.25)' } : {}),
              }} />
            ) : (
              <View style={{
                width: 64, height: 64, borderRadius: 12,
                backgroundColor: 'rgba(255,255,255,0.18)',
                alignItems: 'center', justifyContent: 'center',
                borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)',
              }}>
                <Text style={{ fontSize: 30 }}>🎵</Text>
              </View>
            )}
            <View style={{ flex: 1 }}>
              <Text style={{ fontSize: 11, fontWeight: '700', color: 'rgba(255,255,255,0.85)', letterSpacing: 1.2, textTransform: 'uppercase', marginBottom: 3 }}>
                Playlist
              </Text>
              <Text style={{ fontSize: 20, fontWeight: '800', color: '#fff', marginBottom: 3 }} numberOfLines={1}>
                {editor.playlist?.playlist_name || 'Playlist'}
              </Text>
              <Text style={{ fontSize: 12, fontWeight: '600', color: 'rgba(255,255,255,0.85)' }}>
                {songs.length} {songs.length === 1 ? 'música' : 'músicas'}
                {songs.length > 0 ? ` · ${Math.round(songs.reduce((a, s) => a + (s.duration || 30), 0) / 60)} min` : ''}
              </Text>
            </View>
            <TouchableOpacity
              onPress={onClose}
              hitSlop={10}
              style={{
                width: 32, height: 32, borderRadius: 16,
                backgroundColor: 'rgba(255,255,255,0.22)',
                alignItems: 'center', justifyContent: 'center',
              }}
            >
              <IconX size={18} color="#fff" />
            </TouchableOpacity>
          </View>
        </View>

        <View style={{ paddingHorizontal: 18, paddingTop: 14 }}>
          {/* Existing songs in this playlist */}
          {songs.length > 0 && (
            <>
              <Text style={{ fontSize: 11, fontWeight: '700', color: colors.textTertiary, letterSpacing: 1, textTransform: 'uppercase', marginBottom: 8 }}>
                Na playlist
              </Text>
              <ScrollView style={{ maxHeight: 200 }} contentContainerStyle={{ paddingBottom: 8 }}>
                {songs.map((s, idx) => (
                  <View key={idx} style={{
                    flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 8, paddingHorizontal: 8,
                    borderRadius: 12, marginBottom: 4,
                    backgroundColor: colors.background,
                  }}>
                    <View style={{ width: 28, alignItems: 'center' }}>
                      <Text style={{ fontSize: 13, fontWeight: '700', color: colors.textTertiary }}>{idx + 1}</Text>
                    </View>
                    {s.cover
                      ? <Image source={{ uri: s.cover }} style={{ width: 44, height: 44, borderRadius: 8 }} />
                      : <View style={{ width: 44, height: 44, borderRadius: 8, backgroundColor: '#a855f7' + '22', alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 20 }}>🎵</Text></View>}
                    <View style={{ flex: 1 }}>
                      <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }} numberOfLines={1}>{s.title}</Text>
                      <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }} numberOfLines={1}>{s.artist}</Text>
                    </View>
                    <TouchableOpacity
                      onPress={() => removeSong(idx)}
                      disabled={busy}
                      style={{
                        width: 32, height: 32, borderRadius: 16,
                        backgroundColor: colors.error + '18',
                        alignItems: 'center', justifyContent: 'center',
                      }}
                      activeOpacity={0.6}
                    >
                      <IconTrash size={15} color={colors.error} />
                    </TouchableOpacity>
                  </View>
                ))}
              </ScrollView>
            </>
          )}

          {/* Search bar */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 10,
            borderWidth: 0,
            borderRadius: 14,
            paddingHorizontal: 16, height: 48,
            backgroundColor: colors.background,
            marginTop: songs.length > 0 ? 14 : 4,
            marginBottom: 10,
            ...(Platform.OS === 'web' ? { boxShadow: '0 1px 4px rgba(0,0,0,0.04)' } : {}),
          }}>
            <IconSearch size={18} color={colors.textTertiary} />
            <TextInput
              style={{ flex: 1, fontSize: 15, color: colors.text, paddingVertical: 0 }}
              placeholder="Buscar música no Deezer…"
              placeholderTextColor={colors.textTertiary}
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoCapitalize="none"
            />
            {searching && <ActivityIndicator size="small" color="#a855f7" />}
            {!!searchQuery && !searching && (
              <TouchableOpacity onPress={() => setSearchQuery('')} hitSlop={8}>
                <IconX size={16} color={colors.textTertiary} />
              </TouchableOpacity>
            )}
          </View>

          {/* Search results — empty state and list */}
          <ScrollView style={{ maxHeight: 320 }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ paddingBottom: 8 }}>
            {searchQuery.length < 2 && (
              <View style={{ alignItems: 'center', paddingVertical: 28 }}>
                <View style={{
                  width: 64, height: 64, borderRadius: 32,
                  backgroundColor: '#a855f7' + '14',
                  alignItems: 'center', justifyContent: 'center', marginBottom: 12,
                }}>
                  <Text style={{ fontSize: 30 }}>🎼</Text>
                </View>
                <Text style={{ fontSize: 13, color: colors.textSecondary, textAlign: 'center', paddingHorizontal: 32, lineHeight: 18 }}>
                  Digite o nome de uma música, artista ou álbum para adicionar à playlist.
                </Text>
              </View>
            )}
            {searchResults.length === 0 && !searching && searchQuery.length >= 2 && (
              <Text style={{ textAlign: 'center', color: colors.textTertiary, fontSize: 13, paddingVertical: 16 }}>
                Nenhuma música encontrada
              </Text>
            )}
            {searchResults.map((track, idx) => {
              const already = !!songs.find(s => s.title === track.title && s.artist === track.artist);
              return (
                <TouchableOpacity
                  key={track.id || idx}
                  disabled={already || busy}
                  onPress={() => addSong(track)}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 12,
                    paddingVertical: 9, paddingHorizontal: 8,
                    borderRadius: 12, marginBottom: 4,
                    opacity: already ? 0.55 : 1,
                  }}
                  activeOpacity={0.65}
                >
                  {track.coverUrl
                    ? <Image source={{ uri: track.coverUrl }} style={{ width: 48, height: 48, borderRadius: 8 }} />
                    : <View style={{ width: 48, height: 48, borderRadius: 8, backgroundColor: '#a855f7' + '22', alignItems: 'center', justifyContent: 'center' }}><Text style={{ fontSize: 22 }}>🎵</Text></View>}
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 14, fontWeight: '700', color: colors.text }} numberOfLines={1}>{track.title}</Text>
                    <Text style={{ fontSize: 12, color: colors.textSecondary, marginTop: 1 }} numberOfLines={1}>
                      {track.artist}{track.duration ? ` · ${Math.floor(track.duration / 60)}:${String(track.duration % 60).padStart(2, '0')}` : ''}
                    </Text>
                  </View>
                  <View style={{
                    width: 36, height: 36, borderRadius: 18,
                    backgroundColor: already ? colors.border : '#a855f7',
                    alignItems: 'center', justifyContent: 'center',
                    ...(Platform.OS === 'web' && !already ? { boxShadow: '0 2px 6px rgba(168,85,247,0.35)' } : {}),
                  }}>
                    {already
                      ? <IconCheck size={18} color={colors.textSecondary} strokeWidth={3} />
                      : <Text style={{ color: '#fff', fontSize: 22, fontWeight: '300', marginTop: -2 }}>+</Text>}
                  </View>
                </TouchableOpacity>
              );
            })}
          </ScrollView>
        </View>
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
  const [editedUri, setEditedUri] = useState(null);
  const [editing, setEditing] = useState(false);

  // Reset edits when media changes
  useEffect(() => { setEditedUri(null); }, [mediaUri]);

  if (!visible || !mediaUri) return null;

  const isVideo = mediaType === 'video';
  const currentUri = editedUri || mediaUri;

  const applyImageOp = async (op) => {
    if (isVideo || editing) return;
    setEditing(true);
    try {
      const ImageManipulator = require('expo-image-manipulator');
      let actions = [];
      if (op === 'rotateLeft') actions = [{ rotate: -90 }];
      else if (op === 'rotateRight') actions = [{ rotate: 90 }];
      else if (op === 'flipH') actions = [{ flip: ImageManipulator.FlipType.Horizontal }];
      else if (op === 'flipV') actions = [{ flip: ImageManipulator.FlipType.Vertical }];
      const result = await ImageManipulator.manipulateAsync(currentUri, actions, {
        compress: 0.92,
        format: ImageManipulator.SaveFormat.JPEG,
      });
      setEditedUri(result.uri);
    } catch (e) {
      console.warn('Image edit error:', e);
    } finally {
      setEditing(false);
    }
  };

  return (
    <Modal visible transparent animationType="slide" onRequestClose={onClose} statusBarTranslucent>
      <View style={previewStyles.container}>
        {/* Header */}
        <View style={previewStyles.header}>
          <TouchableOpacity onPress={onClose} style={previewStyles.headerBtn}>
            <IconX size={24} color="#fff" />
          </TouchableOpacity>
          <View style={{ flex: 1 }} />
          {!isVideo && (
            <View style={{ flexDirection: 'row', gap: 4 }}>
              <TouchableOpacity onPress={() => applyImageOp('rotateLeft')} disabled={editing} style={previewStyles.headerBtn} accessibilityLabel="Rotate left">
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>↺</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => applyImageOp('rotateRight')} disabled={editing} style={previewStyles.headerBtn} accessibilityLabel="Rotate right">
                <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>↻</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => applyImageOp('flipH')} disabled={editing} style={previewStyles.headerBtn} accessibilityLabel="Flip horizontal">
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>⇋</Text>
              </TouchableOpacity>
              <TouchableOpacity onPress={() => applyImageOp('flipV')} disabled={editing} style={previewStyles.headerBtn} accessibilityLabel="Flip vertical">
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>⇅</Text>
              </TouchableOpacity>
              {editedUri && (
                <TouchableOpacity onPress={() => setEditedUri(null)} disabled={editing} style={previewStyles.headerBtn} accessibilityLabel="Reset edits">
                  <Text style={{ color: '#25D366', fontSize: 13, fontWeight: '700' }}>{t('common.reset') || 'Reset'}</Text>
                </TouchableOpacity>
              )}
            </View>
          )}
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
            <Image source={{ uri: currentUri }} style={previewStyles.previewImage} resizeMode="contain" />
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
            onPress={() => onSend(caption, viewOnce, editedUri)}
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
  // Preview state — set after stopping (to listen before sending, WhatsApp-style)
  const [previewData, setPreviewData] = useState(null); // { uri, blob?, name, type, duration, waveform }
  const [previewPlaying, setPreviewPlaying] = useState(false);
  const [previewProgress, setPreviewProgress] = useState(0); // 0..1
  const previewAudioRef = useRef(null); // HTMLAudioElement on web, expo-audio player on native
  const previewIntervalRef = useRef(null);
  // Slide-to-cancel
  const slideX = useRef(new Animated.Value(0)).current;
  const cancelledRef = useRef(false);
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
        Animated.timing(pulseAnim, { toValue: 1.6, duration: 600, useNativeDriver: false }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: false }),
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
      // ⭐ Native AVAudioEngine recorder (iOS only) — real waveform samples + lower latency.
      // Falls back to expo-audio on Android or if the native module is missing.
      let nativeRec = null;
      if (Platform.OS === 'ios') {
        try {
          const { Audio: NativeAudio } = require('../modules/expo-native-toolkit');
          if (NativeAudio?.startRecording) {
            const path = await NativeAudio.startRecording();
            nativeRec = {
              __native: true, NativeAudio, path,
              stop: async () => {
                const result = await NativeAudio.stopRecording();
                return result; // { path, durationMs, samples }
              },
            };
          }
        } catch {}
      }
      const recorder = nativeRec || (() => {
        const AudioMod = require('expo-audio/build/AudioModule').default;
        const { RecordingPresets } = require('expo-audio');
        const r = new AudioMod.AudioRecorder(RecordingPresets.HIGH_QUALITY);
        return r;
      })();
      if (!nativeRec) {
        await recorder.prepareToRecordAsync();
        recorder.record();
      }
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

  // STOP recording -> enter preview mode (WhatsApp-style: listen, then send or delete)
  const handleStop = async () => {
    if (!recording) return;
    if (intervalRef.current) clearInterval(intervalRef.current);
    if (waveIntervalRef.current) clearInterval(waveIntervalRef.current);
    if (pulseLoopRef.current) pulseLoopRef.current.stop();
    try {
      if (Platform.OS === 'web') {
        await stopWebRecorder();
        const mr = mediaRecorderRef.current;
        if (mr?.stream) mr.stream.getTracks().forEach(t => t.stop());
        try { audioCtxRef.current?.close(); } catch {}
        if (chunksRef.current.length === 0) { onCancel(); return; }
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const uri = URL.createObjectURL(blob);
        // Snapshot the captured waveform for preview rendering
        const snapshot = waveformLevels.slice(-60);
        setPreviewData({ uri, blob, name: `audio_${Date.now()}.webm`, type: 'audio/webm', duration, waveform: snapshot });
      } else {
        await recording.stop();
        const uri = recording.uri;
        try { const { setAudioModeAsync } = require('expo-audio'); await setAudioModeAsync({ allowsRecording: false }); } catch {}
        if (uri) {
          setPreviewData({ uri, name: `audio_${Date.now()}.m4a`, type: 'audio/mp4', duration, waveform: [] });
        } else {
          onCancel();
        }
      }
    } catch (e) {
      console.warn('Stop recording error:', e);
      try { const { setAudioModeAsync } = require('expo-audio'); await setAudioModeAsync({ allowsRecording: false }); } catch {}
      onCancel();
    }
    setRecording(null);
  };

  // CONFIRM send from preview
  const handleConfirmSend = () => {
    if (!previewData) return;
    // Stop any preview playback
    try {
      if (Platform.OS === 'web' && previewAudioRef.current) {
        previewAudioRef.current.pause();
      }
    } catch {}
    if (previewIntervalRef.current) { clearInterval(previewIntervalRef.current); previewIntervalRef.current = null; }
    onSend(previewData);
  };

  // DELETE preview and exit
  const handleDeletePreview = () => {
    try {
      if (Platform.OS === 'web' && previewAudioRef.current) previewAudioRef.current.pause();
    } catch {}
    if (previewIntervalRef.current) { clearInterval(previewIntervalRef.current); previewIntervalRef.current = null; }
    if (previewData?.uri && Platform.OS === 'web') {
      try { URL.revokeObjectURL(previewData.uri); } catch {}
    }
    setPreviewData(null);
    setPreviewPlaying(false);
    setPreviewProgress(0);
    onCancel();
  };

  // PLAY/PAUSE preview
  const togglePreviewPlay = () => {
    if (!previewData) return;
    if (Platform.OS === 'web') {
      try {
        if (!previewAudioRef.current) {
          const audio = new window.Audio(previewData.uri);
          audio.onended = () => {
            setPreviewPlaying(false);
            setPreviewProgress(0);
            if (previewIntervalRef.current) { clearInterval(previewIntervalRef.current); previewIntervalRef.current = null; }
          };
          previewAudioRef.current = audio;
        }
        const audio = previewAudioRef.current;
        if (previewPlaying) {
          audio.pause();
          setPreviewPlaying(false);
          if (previewIntervalRef.current) { clearInterval(previewIntervalRef.current); previewIntervalRef.current = null; }
        } else {
          audio.play().catch(() => {});
          setPreviewPlaying(true);
          previewIntervalRef.current = setInterval(() => {
            if (!audio || !audio.duration) return;
            setPreviewProgress(audio.currentTime / audio.duration);
          }, 80);
        }
      } catch {}
    } else {
      // Native: use expo-audio AudioPlayer
      try {
        const { AudioModule } = require('expo-audio');
        if (!previewAudioRef.current) {
          const player = AudioModule?.default ? new AudioModule.default.AudioPlayer(previewData.uri) : null;
          previewAudioRef.current = player;
        }
        const player = previewAudioRef.current;
        if (!player) return;
        if (previewPlaying) {
          player.pause?.();
          setPreviewPlaying(false);
        } else {
          player.play?.();
          setPreviewPlaying(true);
        }
      } catch {}
    }
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
  const recBg = isDarkBg ? 'rgba(37,211,102,0.08)' : 'rgba(37,211,102,0.06)';
  const previewBg = isDarkBg ? 'rgba(37,211,102,0.10)' : 'rgba(37,211,102,0.08)';
  const waveColor = '#25D366';
  const slideCancelColor = colors.textSecondary;

  // ─── PREVIEW MODE (after stopping recording, before sending) ───
  if (previewData) {
    const previewWaveform = previewData.waveform && previewData.waveform.length > 0
      ? previewData.waveform
      : Array.from({ length: 36 }, () => 0.2 + Math.random() * 0.7);
    const playedBars = Math.floor(previewProgress * previewWaveform.length);
    return (
      <View style={[recStyles.container, recStyles.previewPill, { backgroundColor: previewBg, borderTopColor: colors.border }]}>
        {/* Delete button */}
        <TouchableOpacity onPress={handleDeletePreview} style={recStyles.iconBtn} accessibilityLabel="Apagar gravação">
          <View style={recStyles.trashWrap}>
            <IconTrash size={20} color={colors.error || '#ef4444'} />
          </View>
        </TouchableOpacity>

        {/* Play / Pause */}
        <TouchableOpacity onPress={togglePreviewPlay} style={recStyles.previewPlayBtn} accessibilityLabel={previewPlaying ? 'Pausar' : 'Reproduzir'}>
          {previewPlaying
            ? <IconPause size={20} color="#fff" />
            : <IconPlay size={20} color="#fff" />}
        </TouchableOpacity>

        {/* Static waveform with played-progress overlay */}
        <View style={[recStyles.waveform, { marginLeft: 4 }]}>
          {previewWaveform.slice(0, 36).map((level, i) => {
            const played = i < playedBars;
            return (
              <View
                key={i}
                style={[
                  recStyles.waveBar,
                  {
                    height: Math.max(4, level * 30),
                    backgroundColor: played ? '#25D366' : (isDarkBg ? '#374151' : '#9ca3af'),
                    opacity: played ? 1 : 0.55,
                  },
                ]}
              />
            );
          })}
        </View>

        {/* Duration */}
        <Text style={[recStyles.timer, { color: colors.text, marginLeft: 8, marginRight: 8 }]}>
          {formatDuration(previewData.duration || duration)}
        </Text>

        {/* Send */}
        <TouchableOpacity onPress={handleConfirmSend} style={recStyles.sendBtn} accessibilityLabel="Enviar áudio">
          <IconSend size={20} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  }

  // ─── RECORDING MODE ───
  return (
    <View style={[recStyles.container, recStyles.recordPill, { backgroundColor: recBg, borderTopColor: colors.border }]}>
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

          {/* Live waveform */}
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

        {/* Slide hint with animated arrow */}
        <View style={recStyles.slideRow}>
          <Animated.Text style={[recStyles.slideArrow, {
            color: slideCancelColor,
            transform: [{ translateX: pulseAnim.interpolate({ inputRange: [1, 1.6], outputRange: [0, -4] }) }],
            opacity: pulseAnim.interpolate({ inputRange: [1, 1.6], outputRange: [0.7, 1] }),
          }]}>{'‹‹'}</Animated.Text>
          <Text style={[recStyles.slideHint, { color: slideCancelColor }]}>
            {t('chatConv.slideToCancel') || 'Deslize para cancelar · toque ✓ para pré-ouvir'}
          </Text>
        </View>
      </View>

      {/* Right: STOP button (enters preview) */}
      <TouchableOpacity onPress={handleStop} style={recStyles.stopBtn} accessibilityLabel="Parar e pré-ouvir">
        <View style={recStyles.stopSquare} />
      </TouchableOpacity>
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
  recordPill: {
    marginHorizontal: 10,
    marginBottom: 4,
    borderRadius: 28,
    borderTopWidth: 0,
    paddingHorizontal: 8,
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 14px rgba(37,211,102,0.18)' } : {}),
  },
  previewPill: {
    marginHorizontal: 10,
    marginBottom: 4,
    borderRadius: 28,
    borderTopWidth: 0,
    paddingHorizontal: 8,
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 14px rgba(37,211,102,0.20)' } : {}),
  },
  previewPlayBtn: {
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: '#25D366',
    alignItems: 'center', justifyContent: 'center',
    marginLeft: 4,
    ...(Platform.OS === 'web' ? { boxShadow: '0 1px 6px rgba(37,211,102,0.35)' } : {}),
  },
  stopBtn: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: '#ef4444',
    ...(Platform.OS === 'web' ? { boxShadow: '0 2px 8px rgba(239,68,68,0.4)' } : {}),
  },
  stopSquare: {
    width: 16, height: 16, borderRadius: 3, backgroundColor: '#fff',
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
  const _nativeChatViewRef = useRef(null);
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

  // Unified back handler — works for header button, hardware back, swipe gesture
  const goBack = useCallback(() => {
    try { Keyboard.dismiss(); } catch {}
    // Web: prefer browser history back if available (handles PWA + bookmarked URLs)
    if (Platform.OS === 'web') {
      try {
        if (typeof window !== 'undefined' && window.history && window.history.length > 1) {
          window.history.back();
          return;
        }
      } catch {}
      try { router.replace('/chat'); } catch {}
      try { if (typeof window !== 'undefined') window.location.href = '/chat'; } catch {}
      return;
    }
    try {
      const can = typeof router.canGoBack === 'function' ? router.canGoBack() : true;
      if (can) router.back();
      else router.replace('/chat');
    } catch {
      try { router.replace('/chat'); } catch {}
    }
  }, [router]);

  // Android hardware back
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => { goBack(); return true; });
    return () => { try { sub.remove?.(); } catch {} };
  }, [goBack]);

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

  // Fetch conversation name: try MMKV cache first (<1ms), then API
  useEffect(() => {
    if (!conversationId) return;
    // Try cached conversations first (instant)
    const { getCachedConversations } = require('../services/chatCache');
    getCachedConversations().then(cached => {
      const conv = cached.find(c => c.id === conversationId || String(c.id) === String(conversationId));
      if (conv) {
        const name = emailToDisplayName(conv.display_name || conv.name || '');
        if (name) setConversationName(name);
      }
    }).catch(() => {});
    // Then fetch fresh from API (will use nearest edge server)
    api.chatConversations().then(r => {
      if (!r.success) return;
      const convs = Array.isArray(r.data) ? r.data : (r.data?.conversations || []);
      const conv = convs.find(c => c.id === conversationId || String(c.id) === String(conversationId));
      if (conv) {
        const name = emailToDisplayName(conv.display_name || conv.name || '');
        if (name) setConversationName(name);
      }
    }).catch(() => {});
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

  // Native chat cache (iOS only) — synchronous SQLite read in Swift.
  // Used by both the initial render (useState initializer below) and by
  // every place that calls `cacheMessages` so the native cache stays in sync.
  const _NativeChatCache = (() => {
    if (Platform.OS !== 'ios') return null;
    try { return require('../modules/expo-chat-cache').default; } catch { return null; }
  })();
  const _saveToNativeCache = (msgs) => {
    if (!_NativeChatCache || !conversationId || !Array.isArray(msgs) || msgs.length === 0) return;
    try { _NativeChatCache.saveMessages?.(conversationId, msgs); } catch {}
  };
  // Wrap cacheSingleMessage so every callsite below also writes to native.
  // Keeps the JS persistence (chatCache.js → expo-sqlite) intact for Android/web.
  const _cacheOne = (cid, msg) => {
    cacheSingleMessage(cid, msg).catch(() => {});
    if (msg) _saveToNativeCache([msg]);
  };

  // INSTANT initial render via the native ExpoChatCacheModule (iOS only).
  // The Swift module exposes a synchronous getCachedMessagesSync() so we can
  // populate the initial state with cached messages on the very first render —
  // no async gap, no flicker between mount and the SQLite/MMKV cache loading.
  // On Android / web we still go through the async cache (small flicker).
  const _initialCached = (() => {
    if (!_NativeChatCache || !conversationId) return null;
    try {
      const cached = _NativeChatCache.getCachedMessagesSync?.(conversationId, 50);
      if (Array.isArray(cached) && cached.length > 0) return cached;
    } catch {}
    return null;
  })();
  const [messages, setMessages] = useState(() => _initialCached || []);
  // Map of remote URL → local cached path (native only)
  const [cachedUris, setCachedUris] = useState({});
  // Skip the loader if we already painted from the native cache
  const [loading, setLoading] = useState(() => !_initialCached);
  const [sending, setSending] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [inputText, setInputText] = useState('');
  const [aiQuickReplies, setAiQuickReplies] = useState([]);
  const lastQuickReplyMsgId = useRef(null);
  const [chatLeakWarning, setChatLeakWarning] = useState(null);
  const [chatToneWarning, setChatToneWarning] = useState(null);
  const chatSendBypassGuards = useRef(false);
  const [audioTranscription, setAudioTranscription] = useState(null);

  // Auto-fetch AI quick replies when last incoming message changes.
  // Sends LAST 10 messages so AI understands the conversation context, not just the last msg.
  useEffect(() => {
    const _myEmail = user?.email || '';
    if (!messages || messages.length === 0) return;
    const last = messages[messages.length - 1];
    if (!last || last.sender_email === _myEmail) {
      if (aiQuickReplies.length > 0) setAiQuickReplies([]);
      return;
    }
    if (lastQuickReplyMsgId.current === last.id) return;
    // Skip if last is a non-text message (image/audio/etc) or super short
    if (last.type && last.type !== 'text') return;
    if (!last.content || last.content.length < 2) return;
    lastQuickReplyMsgId.current = last.id;
    (async () => {
      try {
        // Build context: last 10 text messages, mark which are "EU" vs "OUTRO"
        const recent = messages
          .slice(-10)
          .filter(m => m && (!m.type || m.type === 'text') && m.content && !m._failed && !m._pending && !m.deleted_at)
          .map(m => ({
            sender: m.sender_email === _myEmail ? 'EU' : (m.sender_name || m.sender_email?.split('@')[0] || 'OUTRO'),
            text: String(m.content).slice(0, 300),
          }));
        if (recent.length === 0) return;
        const r = await api.aiQuickReplies(recent, 'EU');
        if (r?.success && Array.isArray(r.data?.replies)) {
          setAiQuickReplies(r.data.replies.slice(0, 3));
        }
      } catch {}
    })();
  }, [messages, user?.email]);
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
  const [playlistEditor, setPlaylistEditor] = useState(null); // { messageId, playlist }
  const [isRecording, setIsRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState({}); // { [tempId]: 0-100 }
  const [wsConnected, setWsConnected] = useState(true);
  const wsDisconnectTimerRef = useRef(null);
  const hasEverConnectedRef = useRef(false); // Only show banner after first successful connection + disconnect
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

  // Wallpaper — per-conversation override (AsyncStorage) falls back to global setting.
  const [perConvWallpaper, setPerConvWallpaper] = useState(undefined); // undefined = not loaded; null/string = loaded
  useEffect(() => {
    let alive = true;
    if (!conversationId) return;
    (async () => {
      try {
        const AS = require('@react-native-async-storage/async-storage').default;
        const v = await AS.getItem(`chatyy_wallpaper_${conversationId}`);
        if (alive) setPerConvWallpaper(v); // null when never set, string when set
      } catch { if (alive) setPerConvWallpaper(null); }
    })();
    return () => { alive = false; };
  }, [conversationId]);
  const wallpaperColor = (perConvWallpaper && perConvWallpaper !== '__global__')
    ? perConvWallpaper
    : (chatyySettings.wallpaper || 'none');
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
  const [e2eKeys, setE2eKeys] = useState(null);
  const e2eSecretKeyRef = useRef(null);
  const [e2eInitializing, setE2eInitializing] = useState(false);

  // Initialize E2EE: register keys on server, check conversation E2E status, fetch member keys
  useEffect(() => {
    if (!conversationId || !currentEmail) return;
    let cancelled = false;

    const initE2EE = async () => {
      try {
        const e2eeOrch = require('../services/e2ee');

        // 1. Initialize E2EE keys for this device (registers with server, idempotent)
        await e2eeOrch.initialize(currentEmail);

        // 2. Get our secret key for decryption
        const secretKey = await e2eeOrch.getSecretKey();
        if (secretKey && !cancelled) {
          e2eSecretKeyRef.current = secretKey;
        }

        // 3. Check if this conversation has E2EE enabled
        const isE2ee = await e2eeOrch.checkConversationE2E(conversationId);
        if (cancelled) return;

        if (isE2ee) {
          setE2eEnabled(true);

          // 4. Fetch public keys for all members (for encrypting outgoing messages)
          const memberEmails = membersRef.current.map(m => m.email).filter(Boolean);
          if (memberEmails.length > 0) {
            const keys = await e2eeOrch.getConversationKeys(memberEmails);
            if (!cancelled) setE2eKeys(keys);
          }
        }
      } catch (err) {
        console.warn('[E2EE] Init error:', err?.message);
      }
    };

    // Small delay to let members load first
    const timer = setTimeout(initE2EE, 500);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [conversationId, currentEmail, members.length]);

  // Toggle E2E for this conversation
  const handleToggleE2E = useCallback(async () => {
    if (e2eInitializing) return;
    setE2eInitializing(true);

    try {
      const e2eeOrch = require('../services/e2ee');

      if (e2eEnabled) {
        // Disable E2E
        const result = await e2eeOrch.disableE2E(conversationId);
        if (result.success) {
          setE2eEnabled(false);
          setE2eKeys(null);
        } else {
          safeAlert(t('common.error'), result.error || t('chatConv.e2eDisableFailed'));
        }
      } else {
        // Enable E2E — first ensure our keys are registered
        await e2eeOrch.initialize(currentEmail);

        const result = await e2eeOrch.enableE2E(conversationId);
        if (result.success) {
          setE2eEnabled(true);

          // Fetch all member keys
          const memberEmails = membersRef.current.map(m => m.email).filter(Boolean);
          const keys = await e2eeOrch.getConversationKeys(memberEmails);
          setE2eKeys(keys);

          // Get secret key if not yet loaded
          if (!e2eSecretKeyRef.current) {
            const secretKey = await e2eeOrch.getSecretKey();
            if (secretKey) e2eSecretKeyRef.current = secretKey;
          }
        } else if (result.missingKeys?.length > 0) {
          const names = result.missingKeys.map(e => e.split('@')[0]).join(', ');
          safeAlert(
            t('chatConv.e2eEnabled'),
            (t('chatConv.e2eMissingKeys') || 'Some members have not set up encryption yet: ') + names,
          );
        } else {
          safeAlert(t('common.error'), result.error || t('chatConv.e2eEnableFailed'));
        }
      }
    } catch (err) {
      console.warn('[E2EE] Toggle error:', err?.message);
      safeAlert(t('common.error'), t('chatConv.e2eToggleError') || 'Failed to toggle encryption');
    } finally {
      setE2eInitializing(false);
    }
  }, [e2eEnabled, e2eInitializing, conversationId, currentEmail, t]);

  // Wallpaper — saved per conversation only (no longer touches global chatyy settings).
  // Pass null/'__global__' to revert to the global wallpaper.
  const saveWallpaper = useCallback((color) => {
    if (!conversationId) return;
    const AS = require('@react-native-async-storage/async-storage').default;
    if (color === null || color === '__global__') {
      setPerConvWallpaper('__global__');
      AS.removeItem(`chatyy_wallpaper_${conversationId}`).catch(() => {});
      return;
    }
    const val = color || 'none';
    setPerConvWallpaper(val);
    AS.setItem(`chatyy_wallpaper_${conversationId}`, val).catch(() => {});
  }, [conversationId]);

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
    // ── Strategy: load 20 msgs, cache everything, scroll-up loads more ──
    // 1. Show last 20 from MMKV cache INSTANTLY (<1ms)
    // 2. Fetch only NEW messages from API (since_id = last cached)
    // 3. Scroll up → load 20 more (beforeId pagination)
    // 4. Everything gets saved to MMKV cache on device
    const PAGE_SIZE = 20;
    let sinceId = 0;
    if (!beforeId) {
      try {
        // Show last 20 cached messages INSTANTLY
        const cached = await getCachedMessages(conversationId, PAGE_SIZE);
        if (cached.length > 0 && mountedRef.current) {
          setMessages(cached);
          setHasMore(true); // There may be older messages in cache or server
          if (showLoader) setLoading(false); // Hide spinner — cached content showing
          // Only fetch messages newer than what we have
          sinceId = await getLastSyncId(conversationId);
        } else if (showLoader) {
          setLoading(true);
        }
      } catch {
        if (showLoader) setLoading(true);
      }
    }
    if (beforeId) setLoadingMore(true);
    try {
      // Fetch from API (nearest edge server, auto-detected):
      // - First open: last 20 messages (sinceId=0, beforeId=null)
      // - Has cache: only new messages since last sync (sinceId > 0)
      // - Scroll up: 20 older messages (beforeId = oldest visible)
      const r = await api.chatMessages(conversationId, PAGE_SIZE, beforeId, sinceId);
      if (r.success && mountedRef.current) {
        const newMsgs = decryptMessages(r.data?.messages || []);
        if (beforeId) {
          // Scrolling up — prepend older messages
          setMessages(prev => [...newMsgs, ...prev]);
          // Save to device cache
          cacheMessages(conversationId, newMsgs).catch(() => {});
          _saveToNativeCache(newMsgs);
        } else if (sinceId > 0 && newMsgs.length > 0) {
          // Incremental sync — MERGE new messages into existing state instead of
          // replacing the whole array. Replacing causes React to re-render every
          // bubble (new references) and the screen flickers. Merge preserves the
          // existing message object references so only the new rows actually mount.
          cacheMessages(conversationId, newMsgs).catch(() => {});
          _saveToNativeCache(newMsgs);
          if (mountedRef.current) {
            setMessages(prev => {
              const existingIds = new Set(prev.map(m => m.id));
              const toAdd = newMsgs.filter(m => !existingIds.has(m.id));
              if (toAdd.length === 0) return prev; // no actual change → no re-render
              // Append new ones and sort by id ascending (FlatList is inverted so newer = higher id)
              const merged = [...prev, ...toAdd];
              merged.sort((a, b) => (a.id || 0) - (b.id || 0));
              return merged;
            });
          }
        } else if (sinceId === 0 && newMsgs.length > 0) {
          // Fresh load (no cache): show and save
          setMessages(newMsgs);
          cacheMessages(conversationId, newMsgs).catch(() => {});
          _saveToNativeCache(newMsgs);
        }

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
            const remoteUrls = mediaMsgs.map(m => api.getMediaUrl(m.file_url));
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
              // Auto-save media permanently for offline access (WhatsApp-style)
              saveConversationMedia(newMsgs).catch(() => {});
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
    // Restore any pending (unsent) messages from local storage and retry them
    // Clear ALL pending messages on conversation open (prevents re-send loop)
    // Messages that were "pending" but actually sent will appear from server history
    // Restore pending (unsent) messages — show them with _pending flag so user can see and retry
    getPendingMessages(conversationId).then(pending => {
      if (!pending.length || !mountedRef.current) return;
      const pendingMsgs = pending.map(p => ({
        id: p.temp_id || `pending_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        conversation_id: conversationId,
        sender_email: p.sender_email || currentEmail,
        content: p.content,
        type: p.type || 'text',
        created_at: p.created_at || new Date().toISOString(),
        _pending: true,
        _queued: true,
      }));
      // Show pending messages at the bottom (user can see what wasn't sent)
      setMessages(prev => {
        const existingIds = new Set(prev.map(m => m.content));
        const newPending = pendingMsgs.filter(m => !existingIds.has(m.content));
        return newPending.length > 0 ? [...prev, ...newPending] : prev;
      });
    }).catch(() => {});
    if (false) { // Keep original disabled block for reference
    getPendingMessages(conversationId).then(pending => {
      if (!pending.length || !mountedRef.current) return;
      const pendingMsgs = pending.map(p => ({
        id: p.temp_id,
        conversation_id: conversationId,
        sender_email: p.sender_email || currentEmail,
        content: p.content,
        type: p.type || 'text',
        reply_to_id: p.reply_to_id || null,
        created_at: p.created_at || new Date().toISOString(),
        _pending: true,
      }));
      setMessages(prev => {
        const existingIds = new Set(prev.map(m => m.id));
        const newPending = pendingMsgs.filter(m => !existingIds.has(m.id));
        return newPending.length > 0 ? [...prev, ...newPending] : prev;
      });
      pending.forEach(async (p) => {
        try {
          // Reuse temp_id as client_message_id so retries dedupe on server
          const r = await api.chatSend(conversationId, p.content, p.type || 'text', p.reply_to_id, p.mentions, null, p.temp_id, p.temp_id);
          if (r.success && r.data?.id && mountedRef.current) {
            setMessages(prev => prev.map(m => m.id === p.temp_id ? { ...r.data, _pending: false } : m));
            removePendingMessage(conversationId, p.temp_id).catch(() => {});
            _cacheOne(conversationId, r.data);
            try {
              const mailWs = require('../services/websocket').default;
              mailWs.relayChatMessage(conversationId, r.data, p.temp_id, getMemberEmails());
            } catch {}
          } else if (mountedRef.current) {
            setMessages(prev => prev.map(m => m.id === p.temp_id ? { ...m, _failed: true, _pending: false } : m));
          }
        } catch {
          if (mountedRef.current) {
            setMessages(prev => prev.map(m => m.id === p.temp_id ? { ...m, _failed: true, _pending: false } : m));
          }
        }
      });
    }).catch(() => {});
    } // end if(false) disabled auto-retry
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
      const mqttService = require('../services/mqtt').default;
      // Subscribe to this conversation via both WS and MQTT
      mailWs.subscribe(`chat_${conversationId}`);
      mqttService.subscribeConversation(conversationId);

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
            _cacheOne(conversationId, msg);
          }
          // Background-cache + permanently save media files (native only)
          if (msg.file_url && (msg.type === 'image' || msg.type === 'video' || msg.type === 'audio' || msg.type === 'voice')) {
            const remoteUrl = api.getMediaUrl(msg.file_url);
            saveMediaPermanent(remoteUrl).then(localUri => {
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

      // Listen for message delivery/read status updates via WS (instant tick updates)
      const unsubMsgStatus = mailWs.on('message_status', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) === String(conversationId) && data?.message_ids?.length) {
          const idsSet = new Set(data.message_ids);
          if (data.status === 'read') {
            // Update read receipts to trigger blue ticks via existing _readStatus enrichment
            const maxId = Math.max(...data.message_ids.filter(id => typeof id === 'number'));
            if (maxId > 0) {
              setReadReceipts(prev => {
                const email = data.reader_email || 'peer';
                const existing = prev.find(rr => rr.email === email);
                if (existing) {
                  return prev.map(rr => rr.email === email ? { ...rr, last_read_id: Math.max(rr.last_read_id || 0, maxId) } : rr);
                }
                return [...prev, { email, last_read_id: maxId }];
              });
            }
          }
          // For delivered status, we don't need special handling since the existing
          // _readStatus logic already shows double gray ticks for non-pending non-read messages
        }
      });
      wsUnsubs.push(unsubMsgStatus);

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
            setWsConnected(true); wsConnectedRef.current = true; hasEverConnectedRef.current = true;
          }
          // Re-flush any chat sends queued while offline (server dedupes via client_message_id).
          (async () => {
            try {
              const { getOfflineQueue, removeFromQueue } = require('../services/offlineCache');
              const queue = await getOfflineQueue();
              const chatActions = (queue || []).filter(a => a.type === 'chat_send' && a.conversation_id === conversationId);
              for (const a of chatActions) {
                try {
                  const r = await api.chatSend(
                    a.conversation_id,
                    a.content,
                    a.msgType || 'text',
                    a.reply_to_id,
                    a.mentions || null,
                    null,
                    a.temp_id || a.id,
                    a.client_message_id || a.id,
                  );
                  if (r?.success) {
                    await removeFromQueue(a.id);
                    if (mountedRef.current && r.data?.id) {
                      setMessages(prev => prev.map(m =>
                        (m.id === a.temp_id || m._client_id === a.client_message_id || m._client_id === a.id)
                          ? { ...r.data, _pending: false, _failed: false, _queued: false }
                          : m
                      ));
                    }
                  }
                } catch {}
              }
            } catch {}
          })();
          offlineQueueRef.current = [];
        } else if (data.status === 'disconnected') {
          wsConnectedRef.current = false;
          // Only show banner if we HAD a connection before (not on initial load)
          if (!wsDisconnectTimerRef.current && mountedRef.current && hasEverConnectedRef.current) {
            wsDisconnectTimerRef.current = setTimeout(() => {
              if (mountedRef.current && !wsConnectedRef.current) setWsConnected(false);
              wsDisconnectTimerRef.current = null;
            }, 8000); // 8s delay — very generous to avoid flicker
          }
        }
      });
      wsUnsubs.push(unsubConn);
      // Set initial connection state - keep true to avoid showing banner on mount
      // Banner will only show after a real disconnect event
      if (mailWs.isConnected) setWsConnected(true);
    } catch {}

    // MQTT listeners — guaranteed delivery via EMQX (no polling needed)
    let mqttUnsubs = [];
    try {
      const mqttService = require('../services/mqtt').default;

      // MQTT message listener (same dedup as WS — mqtt.js already deduplicates)
      const unsubMqttMsg = mqttService.on('chat_message', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) !== String(conversationId)) return;
        const msg = data?.message || data;
        if (!msg?.id) return;
        setMessages(prev => {
          if (prev.some(m => m.id === msg.id)) return prev; // Already have it (from WS)
          // Replace optimistic temp message
          const tempIdx = prev.findIndex(m =>
            typeof m.id === 'string' && m.id.startsWith('tmp_') && (m._pending || m._failed) &&
            m.sender_email === msg.sender_email && m.content === msg.content
          );
          if (tempIdx !== -1) {
            const next = [...prev];
            next[tempIdx] = { ...msg, _pending: false };
            return next;
          }
          _cacheOne(conversationId, msg);
          return [...prev, msg];
        });
      });
      mqttUnsubs.push(unsubMqttMsg);

      // MQTT read receipts
      const unsubMqttRead = mqttService.on('chat_read', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) !== String(conversationId)) return;
        if (data?.email !== currentEmail) {
          setReadReceipts(prev => {
            const existing = prev.find(rr => rr.email === data.email);
            if (existing) return prev.map(rr => rr.email === data.email ? { ...rr, last_read_id: Math.max(rr.last_read_id || 0, data.last_read_id || 0) } : rr);
            return [...prev, { email: data.email, last_read_id: data.last_read_id || 0 }];
          });
        }
      });
      mqttUnsubs.push(unsubMqttRead);

      // MQTT reactions
      const unsubMqttReact = mqttService.on('chat_reaction', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) !== String(conversationId)) return;
        if (data?.message_id) {
          setMessages(prev => prev.map(m => {
            if (m.id !== data.message_id) return m;
            const reactions = [...(m.reactions || [])];
            const idx = reactions.findIndex(r => r.emoji === data.emoji && r.email === data.email);
            if (data.removed && idx !== -1) reactions.splice(idx, 1);
            else if (!data.removed && idx === -1) reactions.push({ emoji: data.emoji, email: data.email });
            return { ...m, reactions };
          }));
        }
      });
      mqttUnsubs.push(unsubMqttReact);

      // MQTT edits
      const unsubMqttEdit = mqttService.on('chat_edit', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) !== String(conversationId)) return;
        if (data?.message_id && data?.content) {
          setMessages(prev => prev.map(m => m.id === data.message_id ? { ...m, content: data.content, edited_at: data.edited_at || new Date().toISOString() } : m));
        }
      });
      mqttUnsubs.push(unsubMqttEdit);

      // MQTT deletes
      const unsubMqttDelete = mqttService.on('chat_delete', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) !== String(conversationId)) return;
        if (data?.message_id) {
          setMessages(prev => prev.filter(m => m.id !== data.message_id));
        }
      });
      mqttUnsubs.push(unsubMqttDelete);
    } catch {}

    // No polling — WS + MQTT handle all real-time delivery
    return () => {
      if (wsDisconnectTimerRef.current) { clearTimeout(wsDisconnectTimerRef.current); wsDisconnectTimerRef.current = null; }
      wsUnsubs.forEach(fn => fn?.());
      mqttUnsubs.forEach(fn => fn?.());
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

  const handleLoadMore = useCallback(async () => {
    if (!hasMore || loadingMore || messages.length === 0) return;
    // Fast path: single O(n) scan to find the oldest real id (was doing filter()+indexing)
    let oldestId = Infinity;
    for (let i = 0; i < messages.length; i++) {
      const id = messages[i]?.id;
      if (typeof id === 'number' && id < oldestId) oldestId = id;
    }
    if (!isFinite(oldestId)) return;

    setLoadingMore(true);
    // Defer the heavy work off the interaction thread so the pull-down gesture
    // stays buttery smooth. Without this, the SQLite query + filter + setState
    // blocks the JS thread for ~800ms on big conversations and the drag freezes.
    const run = async () => {
      try {
        // Ask cache for JUST the older slice (limited to 20), not 500-row sweep.
        // Falls back to the 500 scan if the cache helper doesn't support beforeId.
        let olderCached = [];
        try {
          const allCached = await getCachedMessages(conversationId, 500);
          // Inline loop — faster than filter() for this size and avoids allocation
          const out = [];
          for (let i = 0; i < allCached.length && out.length < 20; i++) {
            const m = allCached[i];
            if (typeof m.id === 'number' && m.id < oldestId) out.push(m);
          }
          olderCached = out;
        } catch {}

        if (olderCached.length > 0 && mountedRef.current) {
          // Merge without replacing references — only prepend new rows
          setMessages(prev => {
            const existingIds = new Set();
            for (const m of prev) existingIds.add(m.id);
            const toAdd = olderCached.filter(m => !existingIds.has(m.id));
            if (toAdd.length === 0) return prev;
            return [...toAdd, ...prev];
          });
          // If cache had fewer than 20, top up from server in the background
          if (olderCached.length < 20) {
            const topId = olderCached[0]?.id || oldestId;
            loadMessages(false, topId);
            return;
          }
          setLoadingMore(false);
          return;
        }
        // Cache had nothing — fetch from server (loadMessages handles its own loadingMore)
        loadMessages(false, oldestId);
      } catch {
        if (mountedRef.current) setLoadingMore(false);
      }
    };
    // Wait until the drag/scroll animation finishes before doing ANY work.
    // InteractionManager is the iOS-reliable way to yield to the gesture thread;
    // setTimeout(0) still runs on the JS thread and can block the scroll.
    InteractionManager.runAfterInteractions(() => { run(); });
  }, [hasMore, loadingMore, messages, loadMessages, conversationId]);

  // ============================================================
  // SEND TEXT MESSAGE
  // ============================================================

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text) return;
    if (sending) { setSending(false); return; }

    // ─── AI guards: detect leak first, then tone ───
    if (text.length > 10 && !chatSendBypassGuards.current) {
      try {
        const [leakRes, toneRes] = await Promise.all([
          api.aiDetectLeak(text.slice(0, 2000)).catch(() => null),
          text.length > 30 ? api.aiToneCheck(text.slice(0, 1500)).catch(() => null) : Promise.resolve(null),
        ]);
        if (leakRes?.success && leakRes.data?.has_secret) {
          setChatLeakWarning({ text, types: leakRes.data.types || [], warning: leakRes.data.warning || 'Informacao sensivel detectada' });
          return;
        }
        if (toneRes?.success && toneRes.data?.warning && (toneRes.data?.score || 0) >= 80) {
          setChatToneWarning({ text, tone: toneRes.data.tone || 'hostile', score: toneRes.data.score, suggestion: toneRes.data.suggestion || '' });
          return;
        }
      } catch {}
    }
    chatSendBypassGuards.current = false;

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

    // Haptic feedback on send (WhatsApp-style)
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}

    // Optimistic: show message immediately before server confirms
    // Generate a stable client_message_id for WhatsApp-style deduplication on retry
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
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
    // Persist pending message to local storage for offline resilience
    const pendingData = { temp_id: tempId, client_message_id: msgId, conversation_id: conversationId, content: text, type: 'text', reply_to_id: replyId, mentions: currentMentions, created_at: optimisticMsg.created_at, sender_email: currentEmail };
    savePendingMessage(conversationId, pendingData).catch(() => {});
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
      const sendPromise = api.chatSend(conversationId, contentToSend, 'text', replyId, currentMentions, null, tempId, msgId);
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
        // Remove from pending storage now that it's confirmed
        removePendingMessage(conversationId, tempId).catch(() => {});
        // Cache sent message locally
        _cacheOne(conversationId, serverMsg);
        // Relay via WS for instant delivery to other participants
        try {
          const mailWs = require('../services/websocket').default;
          mailWs.relayChatMessage(conversationId, r.data, tempId, getMemberEmails());
        } catch {}
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false } : m));
      }
    } catch {
      // Network error → queue for auto-retry when back online (works whether truly offline
      // or just a transient failure: server dedupes by client_message_id so re-sends are safe).
      try {
        const { queueOfflineAction } = require('../services/offlineCache');
        await queueOfflineAction({
          type: 'chat_send',
          conversation_id: conversationId,
          content: contentToSend,
          msgType: 'text',
          reply_to_id: replyId,
          mentions: currentMentions,
          temp_id: tempId,
          client_message_id: msgId,
        });
        // Mark as queued (still pending, not failed) — UI shows clock icon
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _pending: true, _failed: false, _queued: true, _client_id: msgId } : m));
      } catch {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false } : m));
      }
    } finally {
      setSending(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  };

  // ============================================================
  // SEND GIF
  // ============================================================
  const handleSendGif = async (gif) => {
    setShowGifPicker(false);
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMsg = {
      id: tempId, conversation_id: conversationId, sender_email: currentEmail,
      content: gif.url, type: 'gif', created_at: new Date().toISOString(), _pending: true,
    };
    setMessages(prev => [...prev, optimisticMsg]);
    requestAnimationFrame(() => { flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }); });
    try {
      const r = await api.chatSend(conversationId, gif.url, 'gif', null, null, null, tempId, msgId);
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
    const msgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const tempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMsg = {
      id: tempId, conversation_id: conversationId, sender_email: currentEmail,
      content: emoji, type: 'sticker', created_at: new Date().toISOString(), _pending: true,
    };
    setMessages(prev => [...prev, optimisticMsg]);
    requestAnimationFrame(() => { flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }); });
    try {
      const r = await api.chatSend(conversationId, emoji, 'sticker', null, null, null, tempId, msgId);
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
      let resolved = false;
      const safeResolve = (val) => { if (!resolved) { resolved = true; resolve(val); } };
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.onchange = (e) => {
        const file = e.target.files?.[0];
        if (file) {
          const uri = URL.createObjectURL(file);
          safeResolve({ uri, blob: file, name: file.name, type: file.type || 'application/octet-stream' });
        } else {
          safeResolve(null);
        }
      };
      // Handle cancel: focus returns to window without file selection
      const handleFocus = () => {
        setTimeout(() => {
          safeResolve(null);
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
      let r = null;

      // Try Rust upload first (direct to R2, 10x faster, no PHP workers)
      // Use chunked upload for large files (>10MB), direct for small
      const fileSize = file.size || file.blob?.size || 0;
      let rustResult = null;
      if (api.rustChunkedUpload && fileSize > 10 * 1024 * 1024) {
        // Large file — chunked upload with progress
        rustResult = await api.rustChunkedUpload(file, user?.email, 'chat', (pct) => {
          if (mountedRef.current) setUploadProgress(prev => ({ ...prev, [tempId]: Math.round(pct * 100) }));
        });
      } else if (api.rustUpload) {
        rustResult = await api.rustUpload(file, user?.email, 'chat');
      }
      if (rustResult?.success && rustResult.cdn_url) {
        // Rust uploaded to R2 — now tell PHP to create the message record
        r = await api.apiCall('chat_send', {
          conversation_id: conversationId,
          content: caption || file.name || '',
          type: fileType,
          file_url: rustResult.cdn_url,
          file_name: rustResult.filename || file.name,
          view_once: forceViewOnce ? 1 : 0,
        }, 'POST');
      }

      // Fallback to PHP upload if Rust failed
      if (!r?.success) {
        r = await api.chatUploadFile(conversationId, file, caption, forceViewOnce, (progress) => {
          if (mountedRef.current) {
            setUploadProgress(prev => ({ ...prev, [tempId]: Math.round(progress * 100) }));
          }
        });
      }

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
        safeAlert(t('common.error') || 'Error', r?.message || t('chatConv.uploadError') || 'Failed to send file');
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

  const sharingLocationRef = useRef(false);
  const handleShareLocation = async () => {
    // Anti-duplicate guard: ignore if already sending
    if (sharingLocationRef.current) return;
    sharingLocationRef.current = true;
    try {
      setUploading(true);
      let latitude, longitude;

      if (Platform.OS === 'web') {
        if (!navigator?.geolocation) {
          safeAlert('Error', t('chatConv.locationError') || 'Geolocation not available');
          return;
        }
        const pos = await new Promise((resolve, reject) => {
          // Lower accuracy = much faster (uses cell tower / wifi triangulation)
          navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: false, timeout: 6000, maximumAge: 30000 });
        });
        latitude = pos.coords.latitude;
        longitude = pos.coords.longitude;
      } else {
        const Location = require('expo-location');
        const { status } = await Location.requestForegroundPermissionsAsync();
        if (status !== 'granted') {
          safeAlert(t('chatConv.permission') || 'Permission', t('chatConv.locationPermission') || 'Allow location access in settings.');
          return;
        }
        // Try cached last-known first (instant), then fall back to fresh location
        try {
          const cached = await Location.getLastKnownPositionAsync({ maxAge: 60000, requiredAccuracy: 200 });
          if (cached) {
            latitude = cached.coords.latitude;
            longitude = cached.coords.longitude;
          }
        } catch {}
        if (latitude == null) {
          // Balanced accuracy is 5x faster than High and good enough for messaging
          const loc = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
          latitude = loc.coords.latitude;
          longitude = loc.coords.longitude;
        }
      }

      // Send IMMEDIATELY without waiting for reverse geocoding (do that in parallel/background)
      const optimisticLabel = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
      const content = JSON.stringify({ latitude, longitude, label: optimisticLabel, address: '' });
      const locMsgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const locTempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const r = await api.chatSend(conversationId, content, 'location', null, null, null, locTempId, locMsgId);
      let inserted = null;
      if (r.success && r.data?.id) {
        inserted = r.data;
        setMessages(prev => [...prev, r.data]);
        requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));
      }

      // Background: reverse geocode and update the message label (non-blocking)
      (async () => {
        try {
          let address = '';
          if (Platform.OS !== 'web') {
            const Location = require('expo-location');
            const [geo] = await Location.reverseGeocodeAsync({ latitude, longitude });
            if (geo) address = [geo.street, geo.streetNumber, geo.district, geo.city].filter(Boolean).join(', ');
          } else {
            const geoRes = await fetch(`https://nominatim.openstreetmap.org/reverse?format=json&lat=${latitude}&lon=${longitude}&zoom=18&addressdetails=1`, { headers: { 'Accept-Language': 'pt-BR' } });
            const geoData = await geoRes.json();
            if (geoData?.address) {
              const a = geoData.address;
              address = [a.road, a.house_number, a.suburb || a.neighbourhood, a.city || a.town || a.village].filter(Boolean).join(', ');
            }
          }
          if (address && inserted?.id) {
            const newContent = JSON.stringify({ latitude, longitude, label: address, address });
            // Update locally
            setMessages(prev => prev.map(m => m.id === inserted.id ? { ...m, content: newContent } : m));
            // Persist server-side via update_live_location (works for static too)
            try { await api.chatUpdateLiveLocation(inserted.id, latitude, longitude, { address }); } catch {}
          }
        } catch {}
      })();
    } catch (e) {
      console.warn('Location error:', e);
      safeAlert(t('common.error') || 'Error', t('chatConv.locationError') || 'Could not get location');
    } finally {
      setUploading(false);
      // Release the guard after a short delay to absorb double-taps
      setTimeout(() => { sharingLocationRef.current = false; }, 1500);
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

      const liveMsgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const liveTempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const r = await api.chatSend(conversationId, content, 'location', null, null, null, liveTempId, liveMsgId);
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

  const [showContactPicker, setShowContactPicker] = useState(false);
  const [contactPickerList, setContactPickerList] = useState([]);
  const [contactPickerSearch, setContactPickerSearch] = useState('');

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
      const contactList = data.filter(c => c.name && (c.phoneNumbers?.length > 0 || c.emails?.length > 0));
      if (contactList.length === 0) {
        safeAlert('Info', t('chatConv.noContacts') || 'No contacts found');
        return;
      }
      setContactPickerList(contactList);
      setContactPickerSearch('');
      setShowContactPicker(true);
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
      const contactMsgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const contactTempId = `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const r = await api.chatSend(conversationId, content, 'contact', null, null, null, contactTempId, contactMsgId);
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
    // Kids can't delete messages
    if (isChildAccount()) {
      const r = getChildRestrictions();
      if (r && !r.can_delete_messages) {
        safeAlert('🔒', 'Voce nao pode apagar mensagens. Seu responsavel controla essa permissao.');
        return;
      }
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
    Animated.spring(reactionBounceScale, { toValue: 1, friction: 3, tension: 300, useNativeDriver: false }).start(() => {
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
        Animated.spring(heartScale, { toValue: 1, friction: 3, tension: 200, useNativeDriver: false }),
        Animated.timing(heartOpacity, { toValue: 0, duration: 400, useNativeDriver: false }),
      ]).start(() => setHeartPopMsg(null));
    } else {
      lastTapRef.current[msg.id] = now;
    }
  }, [handleReact]);

  // ---- Search within conversation ----
  // 1. Local search first (instant) on loaded messages
  // 2. If query >= 3 chars and local results < 3, fall back to server-side FTS
  //    (covers older messages not in local cache)
  const handleSearchMessages = useCallback(async (q) => {
    setSearchQuery(q);
    if (!q.trim()) { setSearchResults([]); setSearchIdx(0); return; }
    const lower = q.toLowerCase();
    const localResults = messages.filter(m =>
      m.content && !m._type && m.type !== 'system' && m.content.toLowerCase().includes(lower)
    ).reverse();

    setSearchResults(localResults);
    setSearchIdx(0);
    if (localResults.length > 0) {
      flatListRef.current?.scrollToItem?.({ item: localResults[0], animated: true });
    }

    // Server-side FTS for thorough search across all messages in this conversation
    if (q.trim().length >= 3) {
      try {
        const r = await api.apiCall('chat_search', { query: q.trim(), conversation_id: conversationId, limit: 50 });
        if (r?.success && Array.isArray(r.data)) {
          // Filter to current conversation + de-dupe with local
          const localIds = new Set(localResults.map(m => m.id));
          const serverNew = r.data
            .filter(m => m.conversation_id === conversationId && !localIds.has(m.id))
            .map(m => ({
              id: m.id,
              conversation_id: m.conversation_id,
              sender_email: m.sender_email,
              content: m.content,
              type: m.type || 'text',
              created_at: m.created_at,
              sender_name: m.sender_name,
            }));
          if (serverNew.length > 0) {
            // Merge: local first (already in view), then server-only
            const merged = [...localResults, ...serverNew];
            // Sort by id desc so most recent is first
            merged.sort((a, b) => (b.id || 0) - (a.id || 0));
            setSearchResults(merged);
          }
        }
      } catch {}
    }
  }, [messages, conversationId]);

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

    // Check WebSocket connectivity — calls require signaling via WS
    try {
      const mailWs = require('../services/websocket').default;
      if (!mailWs || !mailWs.isConnected) {
        safeAlert(t('common.error') || 'Error', t('chat.callNoConnection') || 'No connection to server. Check your internet and try again.');
        return;
      }
    } catch {
      safeAlert(t('common.error') || 'Error', t('chat.callNoConnection') || 'No connection to server. Check your internet and try again.');
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

  // Snapshot the "first unread id" ONCE when conversation opens — this way the unread
  // separator stays visible until the user leaves the conversation, instead of
  // disappearing as soon as they read messages.
  // Strategy: take the unread_count from URL param (set by ChatListTab when opening)
  // and mark the (last - unread_count + 1)th incoming message as the first unread.
  const firstUnreadIdRef = useRef(null);
  const initialUnreadCountRef = useRef(parseInt(params.unread || '0', 10));
  useEffect(() => {
    if (firstUnreadIdRef.current !== null) return;
    if (messages.length === 0) return;
    const unreadN = initialUnreadCountRef.current;
    if (unreadN <= 0) return;
    // Find the Nth-from-end incoming message (skip own + system)
    let count = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (!m || m._type || m.type === 'system') continue;
      if (m.sender_email === currentEmail) continue;
      count++;
      if (count >= unreadN) {
        firstUnreadIdRef.current = m.id;
        break;
      }
    }
  }, [messages, currentEmail]);

  const messagesWithSeparators = React.useMemo(() => {
    const result = [];
    let lastDate = '';
    let unreadInserted = false;
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const ca = msg.created_at || '';
      const d = new Date(ca.endsWith('Z') || ca.includes('+') ? ca : ca + 'Z');
      const dateKey = isNaN(d.getTime()) ? 'unknown' : `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (dateKey !== lastDate) {
        result.push({ _type: 'separator', _key: 'sep-' + dateKey, date: msg.created_at });
        lastDate = dateKey;
      }
      // Insert unread separator BEFORE the first unread message (one-time per session)
      if (!unreadInserted && firstUnreadIdRef.current && msg.id === firstUnreadIdRef.current) {
        result.push({ _type: 'unread_separator', _key: 'unread-sep' });
        unreadInserted = true;
      }
      const nextMsg = messages[i + 1];
      const nextCa = nextMsg?.created_at || '';
      const isLastInGroup = !nextMsg ||
        nextMsg.sender_email !== msg.sender_email ||
        nextMsg.type === 'system' ||
        msg.type === 'system' ||
        (new Date(nextCa.endsWith('Z') || nextCa.includes('+') ? nextCa : nextCa + 'Z') - d > 60000);
      result.push({ ...msg, _isLastInGroup: isLastInGroup });
    }
    return result;
  }, [messages, firstUnreadIdRef.current]);

  // Memoize reversed array to avoid re-creating every render
  const reversedMessages = useMemo(() => [...messagesWithSeparators].reverse(), [messagesWithSeparators]);

  // Enrich messages with per-item derived state. CRITICAL for perf: we keep a
  // WeakMap cache so messages that don't need updating reuse their exact same
  // wrapper object (same reference) across renders. Without this, the spread
  // `{ ...item, ... }` creates fresh objects on every WS read-receipt update
  // and the whole list re-renders / flickers even though `MemoizedMessageRow`
  // comparator would have caught the equality.
  const highlightedMsgId = searchResults.length > 0 && searchResults[searchIdx] ? searchResults[searchIdx].id : null;
  const _enrichCacheRef = useRef(new Map()); // id → { enriched, source }
  // Precompute the highest `last_read_id` across all read receipts once — O(r)
  const maxReadId = useMemo(() => {
    if (!readReceipts || readReceipts.length === 0) return -1;
    let max = -1;
    for (let i = 0; i < readReceipts.length; i++) {
      const v = readReceipts[i]?.last_read_id;
      if (typeof v === 'number' && v > max) max = v;
    }
    return max;
  }, [readReceipts]);
  const enrichedMessages = useMemo(() => {
    const cache = _enrichCacheRef.current;
    const out = new Array(reversedMessages.length);
    const newCache = new Map();
    for (let i = 0; i < reversedMessages.length; i++) {
      const item = reversedMessages[i];
      if (item._type === 'separator') { out[i] = item; continue; }
      const isOwn = item.sender_email === currentEmail;
      let readStatus = 1;
      if (item._pending) readStatus = 0;
      else if (item._failed) readStatus = -1;
      else if (isOwn && typeof item.id === 'number' && item.id <= maxReadId) readStatus = 2;
      const isHighlighted = item.id === highlightedMsgId;
      const isHeartPop = item.id === heartPopMsg;
      const uploadPct = uploadProgress[item.id];
      // Check if we can reuse the previous enriched wrapper (reference-identical)
      const prev = cache.get(item.id);
      if (prev &&
          prev.source === item &&
          prev.enriched._isHighlighted === isHighlighted &&
          prev.enriched._heartPop === isHeartPop &&
          prev.enriched._uploadPct === uploadPct &&
          prev.enriched._readStatus === readStatus) {
        out[i] = prev.enriched;
        newCache.set(item.id, prev);
        continue;
      }
      const enriched = {
        ...item,
        _isHighlighted: isHighlighted,
        _heartPop: isHeartPop,
        _uploadPct: uploadPct,
        _readStatus: readStatus,
      };
      out[i] = enriched;
      newCache.set(item.id, { enriched, source: item });
    }
    _enrichCacheRef.current = newCache; // drop stale entries
    return out;
  }, [reversedMessages, highlightedMsgId, heartPopMsg, uploadProgress, maxReadId, currentEmail]);

  // Stable key extractor
  const msgKeyExtractor = useCallback((item) => item._key || String(item.id), []);

  // Edit history viewer
  const [editHistoryModal, setEditHistoryModal] = useState({ visible: false, loading: false, versions: [], currentContent: '' });
  const openEditHistory = useCallback(async (messageId) => {
    const current = messages.find(m => m.id === messageId);
    setEditHistoryModal({ visible: true, loading: true, versions: [], currentContent: current?.content || '' });
    try {
      const r = await api.chatMessageHistory(messageId);
      if (r?.success) {
        setEditHistoryModal(prev => ({ ...prev, loading: false, versions: r.data?.versions || [] }));
      } else {
        setEditHistoryModal(prev => ({ ...prev, loading: false }));
      }
    } catch {
      setEditHistoryModal(prev => ({ ...prev, loading: false }));
    }
  }, [messages]);

  // Floating "today/yesterday/date" pill — updated as user scrolls
  const [floatingDate, setFloatingDate] = useState('');
  const floatingDateOpacity = useRef(new Animated.Value(0)).current;
  const floatingHideTimer = useRef(null);
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 30, minimumViewTime: 50 }).current;
  const onViewableItemsChanged = useRef(({ viewableItems }) => {
    if (!viewableItems || viewableItems.length === 0) return;
    // Inverted list: first viewable = newest in current view
    const top = viewableItems[0]?.item;
    if (!top) return;
    const ca = top.created_at || top.date;
    if (!ca) return;
    try {
      const d = new Date(ca.endsWith?.('Z') || ca.includes?.('+') ? ca : ca + 'Z');
      if (isNaN(d.getTime())) return;
      const label = formatDateSeparator(ca, t);
      setFloatingDate(label);
      Animated.timing(floatingDateOpacity, { toValue: 1, duration: 180, useNativeDriver: true }).start();
      if (floatingHideTimer.current) clearTimeout(floatingHideTimer.current);
      floatingHideTimer.current = setTimeout(() => {
        Animated.timing(floatingDateOpacity, { toValue: 0, duration: 400, useNativeDriver: true }).start();
      }, 1500);
    } catch {}
  }).current;

  // One-time auto-scroll to first unread message when conversation opens
  const didScrollToUnreadRef = useRef(false);
  useEffect(() => {
    if (didScrollToUnreadRef.current) return;
    if (!firstUnreadIdRef.current) return;
    if (!flatListRef.current) return;
    if (enrichedMessages.length === 0) return;
    const tm = setTimeout(() => {
      try {
        const idx = enrichedMessages.findIndex(m => m._type === 'unread_separator');
        if (idx >= 0) {
          flatListRef.current?.scrollToIndex?.({ index: idx, animated: false, viewPosition: 0.5 });
          didScrollToUnreadRef.current = true;
        }
      } catch {}
    }, 350);
    return () => clearTimeout(tm);
  }, [enrichedMessages]);

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

  // Resolve a raw file_url to a local cached path (if available) or absolute remote URL.
  //
  // Three-layer lookup:
  //   1. JS state `cachedUris` (filled by background download in this session)
  //   2. Native ExpoChatCache.getLocalUriSync — synchronous, persists across sessions
  //   3. Remote URL fallback (network)
  //
  // The native call is synchronous so it's safe to call inside render. If the
  // file is on disk, the FlashList row gets file:// from frame 1 — no flicker,
  // no buffering, no network roundtrip. The native module also schedules a
  // background download for any URL we ask for that isn't cached yet.
  const resolveMediaUri = (fileUrl) => {
    if (!fileUrl) return fileUrl;
    const absolute = fileUrl.startsWith('http') ? fileUrl : `https://chatyy.com.br${fileUrl}`;
    if (cachedUris[absolute]) return cachedUris[absolute];
    if (_NativeChatCache?.getLocalUriSync) {
      try {
        const local = _NativeChatCache.getLocalUriSync(absolute);
        if (local) return local;
        // Fire-and-forget background download for next time
        _NativeChatCache.prefetchMedia?.(absolute);
      } catch {}
    }
    return absolute;
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
          <Text style={[styles.dateText, { color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.5)', backgroundColor: isDark ? '#111111' : '#E1F2DA' }]}>
            {formatDateSeparator(item.date, t)}
          </Text>
        </View>
      );
    }
    if (item._type === 'unread_separator') {
      return (
        <View style={{ flexDirection: 'row', alignItems: 'center', marginVertical: 8, paddingHorizontal: 12 }}>
          <View style={{ flex: 1, height: 1, backgroundColor: '#34B7F1' }} />
          <View style={{ marginHorizontal: 12, paddingHorizontal: 10, paddingVertical: 3, backgroundColor: isDark ? '#0B3F5C' : '#DCF1FA', borderRadius: 12 }}>
            <Text style={{ fontSize: 11, fontWeight: '700', color: '#34B7F1', letterSpacing: 0.3 }}>
              {(t('chatConv.unreadMessages') || 'NÃO LIDAS').toUpperCase()}
            </Text>
          </View>
          <View style={{ flex: 1, height: 1, backgroundColor: '#34B7F1' }} />
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
                  blurRadius={msg._blurred ? 30 : (imgUploading ? 2 : 0)}
                  recyclingKey={`img-${msg.id}`}
                />
                {msg._blurred && (
                  <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.4)' }}>
                    <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>🔒</Text>
                    <Text style={{ color: '#fff', fontSize: 11, marginTop: 4 }}>Protegido</Text>
                  </View>
                )}
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
                messageId={msg.id}
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

        case 'gif': {
          // Strip any stray commas/spaces from the URL (paranoia: some clients send weird chars)
          const gifUrl = String(msg.content || '').trim().replace(/,/g, '.').replace(/\s+/g, '');
          if (!gifUrl || !/^https?:\/\//.test(gifUrl)) {
            return <Text style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text }]}>{msg.content}</Text>;
          }
          return (
            <Image
              source={{ uri: gifUrl }}
              style={{ width: 220, height: 180, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.05)' }}
              resizeMode="cover"
            />
          );
        }

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
            <View style={{ minWidth: 260, maxWidth: 300, backgroundColor: isOwn ? 'rgba(0,0,0,0.1)' : (isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)'), borderRadius: 12, padding: 12, marginVertical: 2 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 10 }}>
                <View style={{ width: 40, height: 40, borderRadius: 10, backgroundColor: '#ec4899', alignItems: 'center', justifyContent: 'center', marginRight: 10 }}>
                  <Text style={{ fontSize: 18 }}>📍</Text>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontWeight: '700', fontSize: 15, color: isOwn ? ownTextColor : colors.text }}>{meetup.title}</Text>
                  <Text style={{ fontSize: 12, color: isOwn ? ownMetaColor : colors.textSecondary, marginTop: 1 }}>{t('chatConv.meetup') || 'Encontro'}</Text>
                </View>
              </View>
              <View style={{ backgroundColor: isOwn ? 'rgba(0,0,0,0.08)' : (isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.02)'), borderRadius: 8, padding: 10, marginBottom: 8, gap: 6 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                  <IconClock size={15} color="#ec4899" />
                  <Text style={{ fontSize: 13, fontWeight: '600', color: isOwn ? ownTextColor : colors.text }}>{dateStr}</Text>
                </View>
                {meetup.location ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                    <IconMapPin size={15} color="#ec4899" />
                    <Text style={{ fontSize: 13, color: isOwn ? ownMetaColor : colors.textSecondary }}>{meetup.location}</Text>
                  </View>
                ) : null}
              </View>
              {meetup.description ? (
                <Text style={{ fontSize: 13, color: isOwn ? ownMetaColor : colors.textSecondary, marginBottom: 8 }}>{meetup.description}</Text>
              ) : null}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 8, gap: 12 }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Text style={{ fontSize: 13 }}>✅</Text>
                  <Text style={{ fontSize: 12, fontWeight: '700', color: isOwn ? ownTextColor : colors.text }}>{goingCount}</Text>
                </View>
                {maybeCount > 0 && (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                    <Text style={{ fontSize: 13 }}>🤔</Text>
                    <Text style={{ fontSize: 12, fontWeight: '600', color: isOwn ? ownMetaColor : colors.textSecondary }}>{maybeCount}</Text>
                  </View>
                )}
              </View>
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
            <TouchableOpacity
              activeOpacity={0.85}
              onPress={() => setPlaylistEditor({ messageId: msg.id, playlist })}
              style={{ minWidth: 240, maxWidth: 300 }}
            >
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
                  {t('chatConv.emptyPlaylist') || 'Toque pra adicionar músicas'}
                </Text>
              )}
              {/* Add songs hint */}
              <View style={{ marginTop: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: isOwn ? 'rgba(255,255,255,0.15)' : (colors.border + '40'), flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                <Text style={{ fontSize: 11, color: isOwn ? 'rgba(255,255,255,0.7)' : '#a855f7', fontWeight: '700' }}>
                  ✏️ Toque pra editar
                </Text>
              </View>
            </TouchableOpacity>
          );
        }

        case 'file': {
          // If the file is actually audio/video/image based on extension, render as that type
          const _fName = (msg.file_name || msg.content || '').toLowerCase();
          if (/\.(m4a|mp3|wav|ogg|aac|opus)$/i.test(_fName)) {
            // Render as audio player
            return (
              <AudioPlayer
                url={msg._localUri || resolveMediaUri(msg.file_url)}
                duration={msg.duration || 0}
                isOwn={isOwn}
                colors={colors}
                messageId={msg.id}
              />
            );
          }
          const handleOpenFile = () => {
            if (!msg.file_url) return;
            // Open in-app modal viewer (ChatMediaViewer with WebView for PDFs/docs)
            setMediaViewer({
              visible: true,
              fileUrl: msg.file_url,
              fileName: msg.file_name || msg.content || 'file',
              fileSize: msg.file_size || 0,
              type: 'file',
            });
          };
          return (
            <TouchableOpacity
              onPress={handleOpenFile}
              style={styles.fileAttach}
              activeOpacity={0.7}
              hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
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
        }

        case 'poll': {
          const poll = msg.poll;
          if (!poll) return <Text style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text }]}>{msg.content}</Text>;
          const handleVote = async (optIdx) => {
            // Optimistic update — show vote change immediately, then sync with server.
            // Backend `chat_vote_poll` is a toggle: tapping the same option removes the vote;
            // for single-choice, voting on a different option replaces the previous one.
            setMessages(prev => prev.map(m => {
              if (m.id !== msg.id) return m;
              const p = { ...(m.poll || {}) };
              const myVotes = new Set(p.my_votes || []);
              const counts = [...(p.vote_counts || [])];
              if (p.multiple_choice) {
                if (myVotes.has(optIdx)) {
                  myVotes.delete(optIdx);
                  counts[optIdx] = Math.max(0, (counts[optIdx] || 0) - 1);
                } else {
                  myVotes.add(optIdx);
                  counts[optIdx] = (counts[optIdx] || 0) + 1;
                }
              } else {
                // Single choice
                if (myVotes.has(optIdx)) {
                  // Tapping same option = unvote (matches backend toggle)
                  myVotes.delete(optIdx);
                  counts[optIdx] = Math.max(0, (counts[optIdx] || 0) - 1);
                } else {
                  // Switching: clear previous, add new
                  for (const prev of myVotes) counts[prev] = Math.max(0, (counts[prev] || 0) - 1);
                  myVotes.clear();
                  myVotes.add(optIdx);
                  counts[optIdx] = (counts[optIdx] || 0) + 1;
                }
              }
              const total = counts.reduce((a, b) => a + (b || 0), 0);
              return { ...m, poll: { ...p, my_votes: Array.from(myVotes), vote_counts: counts, total_votes: total } };
            }));
            try {
              const r = await api.chatVotePoll(poll.id, optIdx);
              if (r.success) {
                setMessages(prev => prev.map(m => m.id === msg.id ? { ...m, poll: { ...m.poll, vote_counts: r.data.vote_counts, total_votes: r.data.total_votes, my_votes: r.data.my_votes } } : m));
              }
            } catch {}
          };
          const accent = isOwn ? '#fff' : colors.primary;
          const bgFill = isOwn ? 'rgba(255,255,255,0.18)' : (colors.primary + '20');
          const bgFillVoted = isOwn ? 'rgba(255,255,255,0.34)' : (colors.primary + '38');
          const trackBg = isOwn ? 'rgba(255,255,255,0.08)' : (colors.border + '40');
          return (
            <View style={{ minWidth: 240, maxWidth: 300, paddingVertical: 4 }}>
              {/* Header with badge */}
              <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 12, gap: 8 }}>
                <View style={{
                  width: 32, height: 32, borderRadius: 16,
                  backgroundColor: isOwn ? 'rgba(255,255,255,0.18)' : (colors.primary + '18'),
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <IconBarChart size={17} color={accent} />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: isOwn ? 'rgba(255,255,255,0.65)' : colors.textSecondary, letterSpacing: 0.4, textTransform: 'uppercase', marginBottom: 2 }}>
                    {poll.multiple_choice ? (t('chat.pollMultipleBadge') || 'Enquete · múltipla') : (t('chat.pollBadge') || 'Enquete')}
                  </Text>
                  <Text style={{ fontWeight: '700', fontSize: msgFontSize, color: isOwn ? ownTextColor : colors.text, lineHeight: msgFontSize + 4 }}>
                    {poll.question}
                  </Text>
                </View>
              </View>

              {/* Options with animated progress bars */}
              {poll.options.map((opt, idx) => {
                const voted = poll.my_votes?.includes(idx);
                const count = poll.vote_counts?.[idx] || 0;
                const pct = poll.total_votes > 0 ? Math.round((count / poll.total_votes) * 100) : 0;
                const isWinning = pct > 0 && pct === Math.max(...(poll.options.map((_, i) => {
                  const c = poll.vote_counts?.[i] || 0;
                  return poll.total_votes > 0 ? Math.round((c / poll.total_votes) * 100) : 0;
                })));
                return (
                  <TouchableOpacity
                    key={idx}
                    onPress={() => handleVote(idx)}
                    activeOpacity={0.75}
                    style={{
                      marginBottom: 8, borderRadius: 12, overflow: 'hidden',
                      backgroundColor: trackBg,
                      borderWidth: voted ? 1.5 : 0,
                      borderColor: voted ? accent : 'transparent',
                    }}
                  >
                    {/* Progress fill */}
                    <View
                      style={{
                        position: 'absolute', left: 0, top: 0, bottom: 0,
                        width: `${pct}%`,
                        backgroundColor: voted ? bgFillVoted : bgFill,
                      }}
                    />
                    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 11, gap: 8 }}>
                      {/* Vote check circle */}
                      <View style={{
                        width: 20, height: 20, borderRadius: 10,
                        borderWidth: 1.8, borderColor: voted ? accent : (isOwn ? 'rgba(255,255,255,0.4)' : colors.border),
                        backgroundColor: voted ? accent : 'transparent',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        {voted && <IconCheck size={12} color={isOwn ? colors.primary : '#fff'} strokeWidth={3} />}
                      </View>
                      <Text style={{
                        flex: 1, fontSize: msgFontSize, color: isOwn ? ownTextColor : colors.text,
                        fontWeight: voted ? '700' : '500',
                      }}>
                        {opt}
                      </Text>
                      {pct > 0 && (
                        <Text style={{
                          fontSize: 13, fontWeight: '700',
                          color: voted ? accent : (isOwn ? 'rgba(255,255,255,0.7)' : colors.textSecondary),
                          minWidth: 36, textAlign: 'right',
                        }}>
                          {pct}%
                        </Text>
                      )}
                    </View>
                  </TouchableOpacity>
                );
              })}

              {/* Footer with total votes + final result indicator */}
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 }}>
                <Text style={{ fontSize: 11, color: isOwn ? 'rgba(255,255,255,0.6)' : colors.textTertiary, fontWeight: '600' }}>
                  {poll.total_votes === 0
                    ? (t('chat.pollNoVotes') || 'Nenhum voto ainda')
                    : (poll.total_votes === 1 ? '1 voto' : `${poll.total_votes} votos`)}
                </Text>
                {poll.my_votes?.length > 0 && (
                  <Text style={{ fontSize: 11, color: accent, fontWeight: '700' }}>
                    ✓ Você votou
                  </Text>
                )}
              </View>
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
              {msg._filtered && msg._hidden && (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <Text style={{ fontSize: 12, color: '#f59e0b' }}>🔒 Mensagem bloqueada pelo controle parental</Text>
                </View>
              )}
              <TextWithLinks
                text={msg.content}
                style={[styles.msgText, { color: isOwn ? ownTextColor : colors.text, fontSize: msgFontSize, lineHeight: msgLineHeight }]}
                linkColor={isOwn ? '#53BDEB' : colors.primary}
                mentionColor={isOwn ? '#53BDEB' : '#1a73e8'}
                colors={colors}
                router={router}
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
              ? [styles.bubbleOwn, { backgroundColor: isDark ? '#005C4B' : '#D9FDD3' },
                 isLastInGroup && { borderBottomRightRadius: 6 },
                 Platform.OS === 'web' && {
                   background: isDark
                     ? 'linear-gradient(135deg, #005C4B 0%, #003c30 100%)'
                     : 'linear-gradient(135deg, #DCF8C6 0%, #b5ec98 100%)',
                 },
                 ]
              : [styles.bubbleOther, { backgroundColor: isUserMentioned(msg, currentEmail) ? (isDark ? '#1a3a2a' : '#d9f2e6') : (isDark ? '#1f2c33' : '#FFFFFF') },
                 isLastInGroup && { borderBottomLeftRadius: 6 },
                 ],
            !isLastInGroup && { borderRadius: 22 },
            isDeleted && styles.bubbleDeleted,
            (msg.type === 'sticker' || msg.type === 'gif') && { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, elevation: 0 },
            msg._pending && { opacity: 0.7 },
            msg._failed && { opacity: 0.5 },
            msg._isHighlighted && { borderWidth: 2, borderColor: '#f59e0b' },
          ]}>
          {/* Bubble tail (triangle pointer) for last message in group */}
          {isLastInGroup && msg.type !== 'sticker' && msg.type !== 'gif' && (
            <View style={{
              position: 'absolute', bottom: 0,
              ...(isOwn
                ? { right: -6 }
                : { left: -6 }),
              width: 0, height: 0,
              borderTopWidth: 8, borderTopColor: 'transparent',
              borderBottomWidth: 0,
              ...(isOwn
                ? {
                    borderLeftWidth: 8,
                    borderLeftColor: isDark ? '#005C4B' : '#DCF8C6',
                    borderRightWidth: 0,
                  }
                : {
                    borderRightWidth: 8,
                    borderRightColor: isUserMentioned(msg, currentEmail) ? (isDark ? '#1a3a2a' : '#d9f2e6') : (isDark ? '#111111' : '#FFFFFF'),
                    borderLeftWidth: 0,
                  }),
            }} />
          )}
          {msg._heartPop && (
            <Animated.View pointerEvents="none" style={{ position: 'absolute', top: '30%', left: '35%', zIndex: 99, transform: [{ scale: heartScale }], opacity: heartOpacity }}>
              <Text style={{ fontSize: 48 }}>❤️</Text>
            </Animated.View>
          )}
          {/* Forwarded label (above reply, above content) */}
          {msg.forwarded_from && !isDeleted && (
            <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4, opacity: 0.7 }}>
              <Text style={{ fontSize: 11, color: isOwn ? 'rgba(255,255,255,0.85)' : colors.textSecondary, fontStyle: 'italic' }}>
                ↪ {msg.forward_count > 1 ? (t('chatConv.forwardedMany') || 'Encaminhada varias vezes') : (t('chatConv.forwarded') || 'Encaminhada')}
              </Text>
            </View>
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
                      source={{ uri: api.getMediaUrl(msg.reply_to.file_url) }}
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
              {disappearingTimer > 0 ? <IconClock size={10} color={isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary} style={{ marginRight: 2 }} /> : null}
              {!!msg.starred && !isDeleted && (
                <IconStarFilled size={10} color={isOwn ? 'rgba(255,255,255,0.7)' : '#f59e0b'} style={{ marginRight: 2 }} />
              )}
              {!!msg._e2e && (
                <IconLock size={10} color={isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary} style={{ marginRight: 2 }} />
              )}
              {msg.edited_at && !isDeleted && (
                <TouchableOpacity onPress={() => openEditHistory(msg.id)} hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}>
                  <Text style={[styles.editedLabel, { color: isOwn ? ownMetaColor : colors.textTertiary, textDecorationLine: 'underline' }]}>
                    {t('chatConv.edited')}
                  </Text>
                </TouchableOpacity>
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
                          // Use existing temp_id and generate client_message_id for dedup on retry
                          const retryTempId = (typeof msg.id === 'string' && msg.id.startsWith('tmp_')) ? msg.id : `tmp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
                          const retryMsgId = 'msg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
                          const r = await api.chatSend(conversationId, msg.content, 'text', msg.reply_to_id, null, null, retryTempId, retryMsgId);
                          if (r.success && r.data?.id) {
                            setMessages(prev => prev.map(m => m.id === msg.id ? { ...r.data, _pending: false } : m));
                            // Clean up pending storage and cache the confirmed message
                            if (typeof msg.id === 'string' && msg.id.startsWith('tmp_')) {
                              removePendingMessage(conversationId, msg.id).catch(() => {});
                            }
                            _cacheOne(conversationId, r.data);
                            try { const mailWs = require('../services/websocket').default; mailWs.relayChatMessage(conversationId, r.data, msg.id, getMemberEmails()); } catch {}
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
                if (msg._queued) return (
                  <View style={{ flexDirection: 'row', alignItems: 'center', marginLeft: 2, gap: 1 }}>
                    <IconWifiOff size={10} color={ownMetaColor} />
                    <IconClock size={10} color={ownMetaColor} />
                  </View>
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
                  // Blue double ticks - read (with slight glow on web)
                  return (
                    <View style={[{ flexDirection: 'row', marginLeft: 3 }, Platform.OS === 'web' && { filter: 'drop-shadow(0 0 2px rgba(83,189,235,0.5))' }]}>
                      <IconCheck size={14} color="#53BDEB" style={{ marginRight: -7 }} />
                      <IconCheck size={14} color="#53BDEB" />
                    </View>
                  );
                }
                // Gray double ticks - delivered (server confirmed, not yet read)
                return (
                  <View style={{ flexDirection: 'row', marginLeft: 2 }}>
                    <IconCheck size={13} color={ownMetaColor} style={{ marginRight: -7 }} />
                    <IconCheck size={13} color={ownMetaColor} />
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
        <View style={[styles.header, { backgroundColor: isDark ? '#0a0a0a' : '#075E54', paddingTop: insets.top, position: 'absolute', top: 0, left: 0, right: 0 }]}>
          <TouchableOpacity onPress={goBack} style={styles.headerBtn}>
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
      style={[styles.container, { backgroundColor: isDark ? '#0b141a' : '#efeae2' }]}
    >
      {/* Header with presence — gradient on web for premium feel */}
      <View style={[styles.header, {
        backgroundColor: isDark ? '#1f2c33' : '#075E54',
        paddingTop: insets.top,
        ...(Platform.OS === 'web'
          ? {
              background: isDark
                ? 'linear-gradient(180deg, #1f2c33 0%, #182229 100%)'
                : 'linear-gradient(180deg, #128C7E 0%, #075E54 100%)',
              boxShadow: '0 2px 12px rgba(0,0,0,0.18)',
            }
          : {}),
      }]}>
        <TouchableOpacity onPress={goBack} style={styles.headerBtn} accessibilityLabel={t('common.back') || 'Back'} accessibilityRole="button">
          <IconArrowLeft size={22} color="#fff" />
        </TouchableOpacity>
        <TouchableOpacity style={[styles.headerInfo, { flexDirection: 'row', alignItems: 'center', gap: 12 }]} onPress={() => {
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
          <View style={{
            position: 'relative',
            padding: 2,
            borderRadius: 24,
            backgroundColor: 'rgba(255,255,255,0.18)',
          }}>
            <AvatarCircle
              name={conversationName}
              email={conversationType === 'direct' ? (params.email || '') : null}
              size={42}
            />
            {presence?.status === 'online' && conversationType === 'direct' && (
              <View style={{
                position: 'absolute', bottom: 1, right: 1,
                width: 14, height: 14, borderRadius: 7,
                backgroundColor: '#25D366', borderWidth: 2.5, borderColor: isDark ? '#1f2c33' : '#075E54',
                ...(Platform.OS === 'web' ? { boxShadow: '0 0 8px rgba(37,211,102,0.6)' } : {}),
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

      {/* WhatsApp-style sync/connecting bar */}
      <SyncBar />

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
        <View style={[styles.wallpaper, { opacity: isDark ? 0.03 : 0.04, backgroundColor: isDark ? '#000000' : '#ECE5DD' }]} pointerEvents="none">
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

      {/* Connection banner removed - reconnection is silent like WhatsApp */}

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
        <ChatBubbleSkeleton count={8} />
      ) : (_NativeChatView && conversationId) ? (
        <_NativeChatView
          ref={(r) => { _nativeChatViewRef.current = r; }}
          style={{ flex: 1 }}
          conversationId={conversationId}
          myEmail={user?.email || ''}
          ownBubbleColor={isDark ? '#005c4b' : '#dcf8c6'}
          otherBubbleColor={isDark ? '#1f2c33' : '#ffffff'}
          listBackgroundColor={isDark ? '#0b141a' : '#efeae2'}
          textColor={isDark ? '#e9edef' : '#111b21'}
          metaColor={isDark ? 'rgba(233,237,239,0.6)' : 'rgba(17,27,33,0.45)'}
          onMessageTap={(e) => {
            const id = e?.nativeEvent?.messageId;
            const msg = messages.find(m => m.id === id);
            if (msg && (msg.type === 'image' || msg.type === 'video') && msg.file_url) {
              setMediaViewer({ url: resolveMediaUri(msg.file_url), type: msg.type });
            }
          }}
          onMessageLongPress={(e) => {
            const id = e?.nativeEvent?.messageId;
            const msg = messages.find(m => m.id === id);
            if (msg) setMessageMenu({ message: msg });
          }}
          onReachTop={() => { if (hasMore && !loadingMore) handleLoadMore(); }}
          onReactionTap={(e) => {
            const { messageId, emoji } = e?.nativeEvent || {};
            if (messageId && emoji) {
              api.chatReact(messageId, emoji).catch(() => {});
            }
          }}
          onRefresh={async () => {
            // Pull-to-refresh: re-fetch messages from server.
            // The native UICollectionView shows the spinner; we MUST call
            // endRefreshing() when done so it disappears.
            try {
              await loadMessages(true);
            } catch {}
            try {
              const ref = _nativeChatViewRef.current;
              if (ref?.endRefreshing) {
                ref.endRefreshing();
              } else if (NativeModules?.ExpoNativeChatView?.endRefreshing) {
                NativeModules.ExpoNativeChatView.endRefreshing(ref);
              }
            } catch {}
          }}
          onSwipeReply={(e) => {
            const id = e?.nativeEvent?.messageId;
            const msg = messages.find(m => m.id === id);
            if (msg) setReplyTo(msg);
          }}
          onContextAction={(e) => {
            const { action, messageId, emoji } = e?.nativeEvent || {};
            const msg = messages.find(m => m.id === messageId);
            if (!msg) return;
            switch (action) {
              case 'reply': setReplyTo(msg); break;
              case 'forward': setForwarding(msg); break;
              case 'star': handleStarMessage?.(msg); break;
              case 'delete': handleDeleteMessage?.(msg); break;
              case 'react':
                if (emoji) api.chatReact(messageId, emoji).catch(() => {});
                break;
              case 'info':
                setMessageMenu({ message: msg, infoOnly: true });
                break;
              default: break;
            }
          }}
        />
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
          viewabilityConfig={viewabilityConfig}
          onViewableItemsChanged={onViewableItemsChanged}
          onScrollToIndexFailed={(info) => {
            // FlatList may not have measured target item yet — fall back to offset estimate
            const offset = (info.averageItemLength || 80) * info.index;
            try { flatListRef.current?.scrollToOffset?.({ offset, animated: false }); } catch {}
            setTimeout(() => {
              try { flatListRef.current?.scrollToIndex?.({ index: info.index, animated: false, viewPosition: 0.5 }); } catch {}
            }, 200);
          }}
          initialNumToRender={15}
          maxToRenderPerBatch={8}
          windowSize={7}
          removeClippedSubviews={Platform.OS !== 'web'}
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
            <View style={[styles.emptyMessages, { transform: [{ scaleY: -1 }] }]}>
              <View style={{
                width: 96, height: 96, borderRadius: 48,
                backgroundColor: isDark ? 'rgba(37,211,102,0.10)' : 'rgba(37,211,102,0.10)',
                alignItems: 'center', justifyContent: 'center', marginBottom: 18,
                ...(Platform.OS === 'web' ? { boxShadow: '0 8px 32px rgba(37,211,102,0.18)' } : {}),
              }}>
                <View style={{
                  width: 72, height: 72, borderRadius: 36,
                  backgroundColor: isDark ? 'rgba(37,211,102,0.18)' : 'rgba(37,211,102,0.18)',
                  alignItems: 'center', justifyContent: 'center',
                }}>
                  <IconLock size={32} color="#25D366" />
                </View>
              </View>
              <Text style={{
                fontSize: 16, fontWeight: '800', textAlign: 'center',
                color: isDark ? '#e9edef' : '#111b21',
                marginBottom: 6, letterSpacing: -0.2,
              }}>
                {e2eEnabled
                  ? (t('chatConv.e2eEmptyTitle') || 'Conversa protegida')
                  : (t('chatConv.emptyTitle') || 'Diga olá')}
              </Text>
              <Text style={{
                fontSize: 13.5, textAlign: 'center', lineHeight: 19,
                paddingHorizontal: 48,
                color: isDark ? 'rgba(233,237,239,0.55)' : 'rgba(17,27,33,0.55)',
              }}>
                {e2eEnabled
                  ? (t('chatConv.e2eEmpty') || 'Mensagens protegidas com criptografia de ponta a ponta. Ninguém fora desta conversa pode ler.')
                  : (t('chatConv.empty') || 'Envie uma mensagem para iniciar a conversa.')}
              </Text>
            </View>
          }
          // Performance optimizations
          removeClippedSubviews={Platform.OS !== 'web'}
        />
      )}

      {/* Contact Picker (WhatsApp-style) */}
      <Modal visible={showContactPicker} animationType="slide" onRequestClose={() => setShowContactPicker(false)}>
        <View style={{ flex: 1, backgroundColor: colors.background, paddingTop: insets.top }}>
          {/* Header */}
          <View style={{
            flexDirection: 'row', alignItems: 'center', gap: 12,
            paddingHorizontal: 16, paddingVertical: 12,
            borderBottomWidth: 1, borderBottomColor: colors.border,
            backgroundColor: isDark ? '#0a0a0a' : '#075E54',
          }}>
            <TouchableOpacity onPress={() => setShowContactPicker(false)} hitSlop={12}>
              <IconArrowLeft size={22} color="#fff" />
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={{ color: '#fff', fontSize: 18, fontWeight: '700' }}>
                {t('chatConv.selectContact') || 'Selecionar contato'}
              </Text>
              <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 12, marginTop: 1 }}>
                {(contactPickerList.length || 0) + ' contatos'}
              </Text>
            </View>
          </View>

          {/* Search bar */}
          <View style={{ paddingHorizontal: 14, paddingVertical: 10, backgroundColor: isDark ? '#000' : '#f7f7f7' }}>
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 10,
              backgroundColor: isDark ? '#1c1c1e' : '#fff',
              borderRadius: 24, paddingHorizontal: 16, height: 42,
              borderWidth: 1, borderColor: colors.border,
            }}>
              <Text style={{ fontSize: 16, color: colors.textTertiary }}>🔍</Text>
              <TextInput
                value={contactPickerSearch}
                onChangeText={setContactPickerSearch}
                placeholder={t('common.search') || 'Buscar...'}
                placeholderTextColor={colors.textTertiary}
                style={{ flex: 1, fontSize: 15, color: colors.text, paddingVertical: 0 }}
                autoCapitalize="none"
              />
            </View>
          </View>

          {/* List */}
          <FlatList
            data={(() => {
              const q = contactPickerSearch.trim().toLowerCase();
              if (!q) return contactPickerList;
              return contactPickerList.filter(c =>
                (c.name || '').toLowerCase().includes(q) ||
                (c.phoneNumbers?.[0]?.number || '').includes(q) ||
                (c.emails?.[0]?.email || '').toLowerCase().includes(q)
              );
            })()}
            keyExtractor={(item, i) => String(item.id || item.lookupKey || i)}
            initialNumToRender={20}
            renderItem={({ item: c }) => {
              const phone = c.phoneNumbers?.[0]?.number || '';
              const email = c.emails?.[0]?.email || '';
              const initials = (c.name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase();
              const colorPalette = ['#25D366', '#34B7F1', '#F59E0B', '#A78BFA', '#EC4899', '#10B981', '#3B82F6'];
              const hash = (c.name || '').split('').reduce((a, ch) => a + ch.charCodeAt(0), 0);
              const avatarColor = colorPalette[hash % colorPalette.length];
              return (
                <TouchableOpacity
                  onPress={() => {
                    setShowContactPicker(false);
                    sendContact(c);
                  }}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 14,
                    paddingHorizontal: 16, paddingVertical: 12,
                    borderBottomWidth: 0.5, borderBottomColor: colors.border + '60',
                  }}
                  activeOpacity={0.6}
                >
                  <View style={{
                    width: 50, height: 50, borderRadius: 25,
                    backgroundColor: avatarColor,
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Text style={{ color: '#fff', fontSize: 17, fontWeight: '700' }}>{initials}</Text>
                  </View>
                  <View style={{ flex: 1 }}>
                    <Text style={{ fontSize: 16, fontWeight: '600', color: colors.text }} numberOfLines={1}>{c.name}</Text>
                    {!!phone && <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }} numberOfLines={1}>{phone}</Text>}
                    {!phone && !!email && <Text style={{ fontSize: 13, color: colors.textSecondary, marginTop: 2 }} numberOfLines={1}>{email}</Text>}
                  </View>
                  <View style={{
                    width: 32, height: 32, borderRadius: 16,
                    backgroundColor: '#25D366' + '18',
                    alignItems: 'center', justifyContent: 'center',
                  }}>
                    <Text style={{ color: '#25D366', fontSize: 18, fontWeight: '700' }}>›</Text>
                  </View>
                </TouchableOpacity>
              );
            }}
            ListEmptyComponent={
              <View style={{ paddingVertical: 60, alignItems: 'center' }}>
                <Text style={{ fontSize: 14, color: colors.textTertiary }}>
                  {t('chatConv.noContactsFound') || 'Nenhum contato encontrado'}
                </Text>
              </View>
            }
          />
        </View>
      </Modal>

      {/* Edit history modal */}
      <Modal
        visible={editHistoryModal.visible}
        animationType="fade"
        transparent
        onRequestClose={() => setEditHistoryModal({ visible: false, loading: false, versions: [], currentContent: '' })}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'center', padding: 20 }}>
          <View style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 18, maxHeight: '80%' }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
              <Text style={{ fontSize: 17, fontWeight: '700', color: colors.text }}>
                {t('chatConv.editHistory') || 'Histórico de edições'}
              </Text>
              <TouchableOpacity onPress={() => setEditHistoryModal({ visible: false, loading: false, versions: [], currentContent: '' })}>
                <IconX size={22} color={colors.textSecondary} />
              </TouchableOpacity>
            </View>
            {editHistoryModal.loading ? (
              <ActivityIndicator color={colors.primary} style={{ marginVertical: 24 }} />
            ) : (
              <ScrollView style={{ maxHeight: 420 }}>
                {editHistoryModal.versions.length === 0 ? (
                  <Text style={{ color: colors.textSecondary, fontSize: 13, textAlign: 'center', paddingVertical: 16 }}>
                    {t('chatConv.editHistoryEmpty') || 'Sem versões anteriores'}
                  </Text>
                ) : (
                  editHistoryModal.versions.map((v, i) => (
                    <View key={i} style={{ paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: colors.border }}>
                      <Text style={{ fontSize: 11, color: colors.textTertiary, marginBottom: 4 }}>
                        {v.edited_at ? new Date(v.edited_at.endsWith?.('Z') ? v.edited_at : v.edited_at + 'Z').toLocaleString() : ''}
                      </Text>
                      <Text style={{ fontSize: 14, color: colors.text, lineHeight: 20 }}>{v.content}</Text>
                    </View>
                  ))
                )}
                <View style={{ paddingVertical: 10, borderTopWidth: 2, borderTopColor: colors.primary, marginTop: 6 }}>
                  <Text style={{ fontSize: 11, color: colors.primary, marginBottom: 4, fontWeight: '700' }}>
                    {t('chatConv.editHistoryCurrent') || 'VERSÃO ATUAL'}
                  </Text>
                  <Text style={{ fontSize: 14, color: colors.text, lineHeight: 20 }}>{editHistoryModal.currentContent}</Text>
                </View>
              </ScrollView>
            )}
          </View>
        </View>
      </Modal>

      {/* Floating today/date pill — appears while scrolling */}
      {!!floatingDate && (
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute', top: 12, alignSelf: 'center', zIndex: 100,
            opacity: floatingDateOpacity,
          }}
        >
          <View style={{
            paddingHorizontal: 14, paddingVertical: 6, borderRadius: 14,
            backgroundColor: isDark ? 'rgba(20,20,20,0.92)' : 'rgba(255,255,255,0.95)',
            shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 8, shadowOffset: { width: 0, height: 2 }, elevation: 4,
          }}>
            <Text style={{ fontSize: 12, fontWeight: '700', color: isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)' }}>
              {floatingDate}
            </Text>
          </View>
        </Animated.View>
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
                source={{ uri: api.getMediaUrl(replyTo.file_url) }}
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
          style={[styles.scrollDownFab, { backgroundColor: isDark ? '#111111' : '#fff' }]}
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
            backgroundColor: isDark ? '#000000' : '#ECE5DD',
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
                    backgroundColor: isDark ? '#111111' : '#fff',
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

        {/* AI Quick Replies (3 chip buttons above input) */}
        {aiQuickReplies.length > 0 && inputText.trim().length === 0 && !replyTo && !editingMsg && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ maxHeight: 44 }}
            contentContainerStyle={{ paddingHorizontal: 12, gap: 8, alignItems: 'center' }}
          >
            {aiQuickReplies.map((reply, i) => (
              <TouchableOpacity
                key={i}
                onPress={() => {
                  setInputText(reply);
                  setAiQuickReplies([]);
                }}
                style={{
                  backgroundColor: isDark ? '#1f2937' : '#fff',
                  borderWidth: 1,
                  borderColor: colors.border || '#e5e7eb',
                  paddingHorizontal: 14,
                  paddingVertical: 8,
                  borderRadius: 18,
                }}
              >
                <Text style={{ color: colors.text, fontSize: 13 }}>✨ {reply}</Text>
              </TouchableOpacity>
            ))}
          </ScrollView>
        )}

        <View style={[styles.inputBar, {
          backgroundColor: isDark ? '#000000' : '#ECE5DD',
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
              backgroundColor: isDark ? '#111111' : '#fff',
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

      {/* AI Leak / Tone Warnings */}
      {chatLeakWarning && (
        <View style={{ position:'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.6)', justifyContent:'center', alignItems:'center', padding:20, zIndex:99999 }}>
          <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:24, maxWidth:400, width:'100%' }}>
            <Text style={{ fontSize:18, fontWeight:'700', color:'#dc2626', marginBottom:8 }}>🔒 Informacao sensivel</Text>
            <Text style={{ fontSize:14, color:colors.text, marginBottom:16 }}>{chatLeakWarning.warning}</Text>
            <View style={{ flexDirection:'row', gap:8 }}>
              <TouchableOpacity onPress={() => setChatLeakWarning(null)} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:colors.background, alignItems:'center' }}><Text style={{ color:colors.text, fontWeight:'600' }}>Editar</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => { setChatLeakWarning(null); chatSendBypassGuards.current = true; setTimeout(handleSend, 50); }} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:'#dc2626', alignItems:'center' }}><Text style={{ color:'#fff', fontWeight:'600' }}>Enviar mesmo</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      )}
      {chatToneWarning && (
        <View style={{ position:'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.6)', justifyContent:'center', alignItems:'center', padding:20, zIndex:99999 }}>
          <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:24, maxWidth:400, width:'100%' }}>
            <Text style={{ fontSize:18, fontWeight:'700', color:'#ef4444', marginBottom:8 }}>⚠️ Tom: {chatToneWarning.tone}</Text>
            <Text style={{ fontSize:14, color:colors.text, marginBottom:12 }}>Sua mensagem soa hostil ({chatToneWarning.score}/100). Quer revisar?</Text>
            {chatToneWarning.suggestion ? (
              <View style={{ backgroundColor:colors.background, padding:10, borderRadius:8, marginBottom:14 }}>
                <Text style={{ fontSize:13, color:colors.text }}>{chatToneWarning.suggestion}</Text>
              </View>
            ) : null}
            <View style={{ flexDirection:'row', gap:8 }}>
              <TouchableOpacity onPress={() => setChatToneWarning(null)} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:colors.background, alignItems:'center' }}><Text style={{ color:colors.text, fontWeight:'600' }}>Editar</Text></TouchableOpacity>
              <TouchableOpacity onPress={() => { setChatToneWarning(null); chatSendBypassGuards.current = true; setTimeout(handleSend, 50); }} style={{ flex:1, paddingVertical:12, borderRadius:8, backgroundColor:'#ef4444', alignItems:'center' }}><Text style={{ color:'#fff', fontWeight:'600' }}>Enviar</Text></TouchableOpacity>
            </View>
          </View>
        </View>
      )}

      {/* Audio Transcription + Summary modal */}
      {audioTranscription && (
        <View style={{ position:'absolute', top:0, left:0, right:0, bottom:0, backgroundColor:'rgba(0,0,0,0.7)', justifyContent:'center', alignItems:'center', padding:16, zIndex:99999 }}>
          <View style={{ backgroundColor:colors.surface, borderRadius:16, padding:20, maxWidth:500, width:'100%', maxHeight:'85%' }}>
            <View style={{ flexDirection:'row', alignItems:'center', justifyContent:'space-between', marginBottom:12 }}>
              <Text style={{ fontSize:18, fontWeight:'700', color:colors.text }}>🎙️ Audio</Text>
              <TouchableOpacity onPress={() => setAudioTranscription(null)}><Text style={{ fontSize:24, color:colors.textSecondary }}>×</Text></TouchableOpacity>
            </View>
            {audioTranscription.loading ? (
              <View style={{ padding:20, alignItems:'center' }}>
                <ActivityIndicator color={colors.primary} />
                <Text style={{ color:colors.textSecondary, marginTop:8 }}>Transcrevendo via Whisper...</Text>
              </View>
            ) : audioTranscription.error ? (
              <Text style={{ color:'#ef4444' }}>Erro: {audioTranscription.error}</Text>
            ) : (
              <ScrollView>
                {audioTranscription.summary ? (
                  <View style={{ marginBottom:12, padding:12, backgroundColor:colors.primary+'15', borderRadius:8 }}>
                    <Text style={{ fontSize:11, color:colors.textSecondary, fontWeight:'600', marginBottom:4 }}>RESUMO</Text>
                    <Text style={{ color:colors.text, fontSize:14, lineHeight:20 }}>{audioTranscription.summary}</Text>
                  </View>
                ) : null}
                {audioTranscription.keyPoints?.length > 0 && (
                  <View style={{ marginBottom:12 }}>
                    <Text style={{ fontSize:11, color:colors.textSecondary, fontWeight:'600', marginBottom:4 }}>PONTOS CHAVE</Text>
                    {audioTranscription.keyPoints.map((kp, i) => (
                      <Text key={i} style={{ color:colors.text, fontSize:13, marginBottom:2 }}>• {kp}</Text>
                    ))}
                  </View>
                )}
                <Text style={{ fontSize:11, color:colors.textSecondary, fontWeight:'600', marginBottom:4 }}>TRANSCRICAO</Text>
                <Text style={{ color:colors.text, fontSize:13, lineHeight:18 }}>{audioTranscription.text}</Text>
              </ScrollView>
            )}
          </View>
        </View>
      )}

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
          <Pressable style={{ backgroundColor: colors.surface, borderRadius: 16, padding: 20, width: 300 }} onPress={() => {}}>
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
            {/* Clear chat — soft delete (per-user, keeps conversation) */}
            <TouchableOpacity
              onPress={() => {
                setShowExportModal(false);
                const doClear = async () => {
                  try {
                    const r = await api.apiCall('chat_clear', { conversation_id: conversationId }, 'POST');
                    if (r?.success) {
                      setMessages([]);
                      try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
                    }
                  } catch {}
                };
                if (Platform.OS === 'web') {
                  if (window.confirm(t('chatConv.clearChatConfirm') || 'Limpar todas as mensagens dessa conversa? (so para voce)')) doClear();
                } else {
                  Alert.alert(
                    t('chatConv.clearChat') || 'Limpar conversa',
                    t('chatConv.clearChatConfirm') || 'Apagar todas as mensagens dessa conversa? Isso so afeta voce.',
                    [
                      { text: t('common.cancel') || 'Cancelar', style: 'cancel' },
                      { text: t('chatConv.clear') || 'Limpar', style: 'destructive', onPress: doClear },
                    ]
                  );
                }
              }}
              style={{ paddingVertical: 14, borderBottomWidth: 1, borderBottomColor: colors.border }}
            >
              <Text style={{ fontSize: 15, color: '#ef4444' }}>🗑 {t('chatConv.clearChat') || 'Limpar conversa'}</Text>
            </TouchableOpacity>
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

      {/* Playlist Editor Modal — add/remove songs after creation */}
      <Modal visible={!!playlistEditor} transparent animationType="slide" onRequestClose={() => setPlaylistEditor(null)}>
        <PlaylistEditorModal
          colors={colors}
          isDark={isDark}
          t={t}
          editor={playlistEditor}
          onClose={() => setPlaylistEditor(null)}
          onUpdated={(updated) => {
            // updated.messageId, updated.playlist (with new songs)
            setMessages(prev => prev.map(m => m.id === updated.messageId ? { ...m, content: JSON.stringify(updated.playlist) } : m));
          }}
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
            Animated.spring(ctxScaleAnim, { toValue: 1, useNativeDriver: false, tension: 300, friction: 20 }),
            Animated.timing(ctxOpacityAnim, { toValue: 1, duration: 200, useNativeDriver: false }),
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

              {/* Save to Saved Messages (Telegram-style) */}
              {!selectedMsg?.deleted_at && typeof selectedMsg?.id === 'number' && (
                <TouchableOpacity
                  style={styles.ctxIconBtn}
                  onPress={async () => {
                    setSelectedMsg(null);
                    try {
                      const r = await api.chatSaveMessage(selectedMsg.id);
                      if (r.success) {
                        try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
                      }
                    } catch {}
                  }}
                  activeOpacity={0.6}
                >
                  <View style={[styles.ctxIconCircle, { backgroundColor: colors.border + '50' }]}>
                    <IconArchive size={20} color={colors.text} />
                  </View>
                  <Text style={[styles.ctxIconLabel, { color: colors.textSecondary }]}>{t('chat.saveMessage')}</Text>
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

              {/* AI: Transcribe + Summarize voice / audio */}
              {!selectedMsg?.deleted_at && (selectedMsg?.type === 'voice' || selectedMsg?.type === 'audio') && selectedMsg?.file_url && (
                <TouchableOpacity
                  style={styles.ctxSecondaryItem}
                  onPress={async () => {
                    setSelectedMsg(null);
                    try {
                      // Download audio to local file then send via FormData
                      const FS = require('expo-file-system/legacy');
                      const localFile = FS.cacheDirectory + 'ai_transcribe_' + Date.now() + '.m4a';
                      const dl = await FS.downloadAsync(selectedMsg.file_url, localFile);
                      if (dl.status === 200) {
                        setAudioTranscription({ loading: true });
                        const r = await api.aiTranscribeAudio(dl.uri);
                        if (r?.success && r.data?.text) {
                          // Now summarize
                          const sumRes = await api.aiSummarizeAudio(r.data.text);
                          setAudioTranscription({
                            text: r.data.text,
                            summary: sumRes?.data?.summary || '',
                            keyPoints: sumRes?.data?.key_points || [],
                            sentiment: sumRes?.data?.sentiment || '',
                          });
                        } else {
                          setAudioTranscription({ error: r?.message || 'Falha na transcricao' });
                        }
                        try { await FS.deleteAsync(dl.uri, { idempotent: true }); } catch {}
                      }
                    } catch (e) {
                      setAudioTranscription({ error: e?.message || 'Erro' });
                    }
                  }}
                  activeOpacity={0.6}
                >
                  <Text style={{ fontSize: 18, marginLeft: 0, marginRight: 4 }}>✨</Text>
                  <Text style={[styles.ctxSecondaryText, { color: colors.text }]}>Transcrever + resumir</Text>
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
                        {(r.delivered_at || r.read_at) ? (() => {
                          const ts = r.delivered_at || r.read_at;
                          const str = ts.endsWith('Z') || ts.includes('+') ? ts : ts + 'Z';
                          const d = new Date(str);
                          return isNaN(d.getTime()) ? ts : d.toLocaleString([], { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
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
        onSend={async (caption, viewOnce, editedUri) => {
          const fileToSend = mediaPreview.file;
          setMediaPreview({ visible: false, uri: null, type: 'image', file: null });
          if (!fileToSend) return;
          // If image was edited (rotated/flipped), use the edited file URI on native
          let toSend = fileToSend;
          if (editedUri && Platform.OS !== 'web' && mediaPreview.type === 'image') {
            toSend = { ...fileToSend, uri: editedUri };
          }
          // Compress images on web before upload (max 2048px, 80% quality)
          if (Platform.OS === 'web' && mediaPreview.type === 'image' && toSend.blob) {
            try {
              const compressed = await compressImageWeb(toSend.blob, 2048, 0.8);
              if (compressed) {
                uploadAndSendFile({ ...toSend, blob: compressed, uri: URL.createObjectURL(compressed) }, viewOnce, caption || '');
                return;
              }
            } catch {}
          }
          uploadAndSendFile(toSend, viewOnce, caption || '');
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
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.45)' }} onPress={() => setShowHeaderMenu(false)}>
          <Pressable
            style={{
              position: 'absolute', top: insets.top + 56, right: 10,
              backgroundColor: colors.surface, borderRadius: 18,
              minWidth: 268, paddingVertical: 6, overflow: 'hidden',
              borderWidth: isDark ? 1 : 0, borderColor: 'rgba(255,255,255,0.06)',
              ...Platform.select({
                ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 12 }, shadowOpacity: 0.32, shadowRadius: 28 },
                android: { elevation: 14 },
                web: { boxShadow: '0 14px 38px rgba(0,0,0,0.32)' },
              }),
            }}
            onPress={e => e.stopPropagation()}
          >
            {(() => {
              const sections = [
                { divider: false, items: [
                  { Icon: IconUsers, tint: '#34B7F1', label: conversationType === 'group' ? (t('chatConv.groupInfo') || 'Info do grupo') : (t('chatConv.contactInfo') || 'Info do contato'), onPress: () => {
                    setShowHeaderMenu(false);
                    if (conversationType === 'group') { setEditGroupName(conversationName); loadGroupMembers(); setShowGroupInfo(true); }
                    else { setProfileViewer({ name: conversationName, email: params.email || '' }); }
                  }},
                ]},
                { divider: true, items: [
                  { Icon: IconSearch, tint: '#A78BFA', label: t('chat.searchPlaceholder') || 'Buscar', onPress: () => { setShowHeaderMenu(false); setShowSearchBar(true); setTimeout(() => searchInputRef.current?.focus(), 200); }},
                  { Icon: IconStar, tint: '#F59E0B', label: t('chat.starredMessages') || 'Favoritas', onPress: () => { setShowHeaderMenu(false); setShowStarredModal(true); loadStarredMessages(); }},
                  { Icon: IconImage, tint: '#EC4899', label: t('chatConv.media') || 'Mídia, links e docs', onPress: () => { setShowHeaderMenu(false); setShowMediaGallery(true); }},
                ]},
                { divider: true, items: [
                  { Icon: IconClock, tint: disappearingTimer > 0 ? '#10b981' : '#6B7280', label: t('chat.disappearing') || 'Mensagens temporárias', badge: disappearingTimer > 0, onPress: () => { setShowHeaderMenu(false); setShowDisappearingModal(true); }},
                  { Icon: IconLock, tint: chatLocked ? '#f59e0b' : '#6B7280', label: chatLocked ? (t('chatConv.removeLock') || 'Remover bloqueio') : (t('chatConv.setLock') || 'Bloquear chat'), badge: chatLocked, onPress: () => {
                    setShowHeaderMenu(false);
                    if (chatLocked) { safeAlert(t('chatConv.chatLockTitle') || 'Chat Lock', t('chatConv.removeLockConfirm') || 'Remove password lock?', [{ text: t('common.cancel'), style: 'cancel' }, { text: t('chatConv.removeLock') || 'Remove', style: 'destructive', onPress: handleRemoveChatLock }]); }
                    else { setShowLockSetup(true); setLockPassInput(''); }
                  }},
                  { Icon: IconShield, tint: e2eEnabled ? '#10b981' : '#6B7280', label: e2eEnabled ? (t('chatConv.e2eEnabled') || 'Criptografia ativa') : (t('chatConv.e2eEnable') || 'Ativar criptografia E2E'), badge: e2eEnabled, onPress: () => {
                    setShowHeaderMenu(false);
                    if (e2eEnabled) {
                      safeAlert(t('chatConv.e2eEnabled'), t('chatConv.e2eDisableConfirm') || 'Future messages will no longer be encrypted.', [{ text: t('common.cancel'), style: 'cancel' }, { text: t('chatConv.e2eDisable') || 'Disable', style: 'destructive', onPress: handleToggleE2E }]);
                    } else { handleToggleE2E(); }
                  }},
                  { Icon: IconBell, tint: mutedUntil ? '#f59e0b' : '#6B7280', label: mutedUntil ? (t('chatConv.unmute') || 'Remover silêncio') : (t('chatConv.muteChat') || 'Silenciar conversa'), badge: !!mutedUntil, onPress: () => { setShowHeaderMenu(false); if (mutedUntil) { handleMuteChat(null); } else { setShowMuteModal(true); } }},
                ]},
                { divider: true, items: [
                  { Icon: IconImage, tint: '#3B82F6', label: t('chatConv.wallpaper') || 'Papel de parede', onPress: () => { setShowHeaderMenu(false); setShowWallpaperPicker(true); }},
                  { Icon: IconCalendar, tint: '#8B5CF6', label: t('chatConv.scheduled') || 'Mensagens agendadas', onPress: () => { setShowHeaderMenu(false); setShowScheduledMessages(true); loadScheduledMessages(); }},
                  { Icon: IconForward, tint: '#10B981', label: t('chatConv.exportChat') || 'Exportar conversa', onPress: () => { setShowHeaderMenu(false); setShowExportModal(true); }},
                ]},
                ...(conversationType === 'direct' ? [{ divider: true, items: [
                  iBlockedThem
                    ? { Icon: IconAlertTriangle, tint: '#6B7280', label: t('chat.unblockUser') || 'Desbloquear', onPress: () => { setShowHeaderMenu(false); handleUnblockUser(params.email || ''); }}
                    : { Icon: IconAlertTriangle, tint: '#EF4444', danger: true, label: t('chat.blockUser') || 'Bloquear', onPress: () => { setShowHeaderMenu(false); handleBlockUser(params.email || ''); }},
                  { Icon: IconAlertTriangle, tint: '#EF4444', danger: true, label: t('chat.reportUser') || 'Denunciar', onPress: () => { setShowHeaderMenu(false); handleReportUser(params.email || ''); }},
                ]}] : []),
              ];
              const out = [];
              sections.forEach((sec, sidx) => {
                if (sec.divider && sidx > 0) {
                  out.push(
                    <View key={`div-${sidx}`} style={{ height: 1, backgroundColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.06)', marginVertical: 4, marginHorizontal: 12 }} />
                  );
                }
                sec.items.forEach((item, iidx) => {
                  const Ico = item.Icon;
                  out.push(
                    <TouchableOpacity
                      key={`s${sidx}-i${iidx}`}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 14, paddingVertical: 11 }}
                      onPress={item.onPress}
                      activeOpacity={0.55}
                    >
                      <View style={{
                        width: 38, height: 38, borderRadius: 11,
                        backgroundColor: (item.tint || '#6B7280') + '20',
                        alignItems: 'center', justifyContent: 'center',
                      }}>
                        {Ico ? <Ico size={19} color={item.tint || '#6B7280'} /> : null}
                      </View>
                      <Text style={{
                        fontSize: 15, color: item.danger ? '#EF4444' : colors.text, flex: 1,
                        fontWeight: '500', letterSpacing: -0.1,
                      }}>
                        {item.label}
                      </Text>
                      {item.badge && <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#10b981' }} />}
                    </TouchableOpacity>
                  );
                });
              });
              return out;
            })()}
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
  headerTitle: { fontSize: 17, fontWeight: '800', letterSpacing: -0.2 },
  headerSubtitle: { fontSize: 12, marginTop: 3, opacity: 0.8, fontWeight: '600', letterSpacing: 0.1 },
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
    marginVertical: 14,
  },
  dateLine: { flex: 1, height: 0 },
  dateText: {
    fontSize: 11.5, fontWeight: '700', letterSpacing: 0.5,
    paddingHorizontal: 18, paddingVertical: 8,
    borderRadius: 22, overflow: 'hidden',
    textTransform: 'uppercase',
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.08, shadowRadius: 10 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 10px rgba(0,0,0,0.08), 0 0 0 1px rgba(0,0,0,0.03)' },
    }),
  },
  systemMsg: { alignItems: 'center', marginVertical: 8, paddingHorizontal: Spacing.lg },
  systemText: { fontSize: 12, textAlign: 'center', fontStyle: 'italic', lineHeight: 18, letterSpacing: 0.1 },
  scrollDownFab: {
    position: 'absolute', right: 18, bottom: 90,
    width: 48, height: 48, borderRadius: 24,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 0,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.25, shadowRadius: 18 },
      android: { elevation: 10 },
      web: { boxShadow: '0 6px 24px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)', backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', transition: 'transform 0.2s ease, box-shadow 0.2s ease' },
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
  msgRow: { maxWidth: Platform.OS === 'web' ? '62%' : '78%' },
  msgRowOwn: { alignSelf: 'flex-end', marginRight: 8 },
  msgRowOther: { alignSelf: 'flex-start', marginLeft: 8 },
  msgSenderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 3, marginLeft: 6 },
  msgSender: { fontSize: 12.5, fontWeight: '800', letterSpacing: -0.1 },
  replyIndicator: {
    borderLeftWidth: 3.5, borderRadius: 10,
    paddingHorizontal: 12, paddingVertical: 8,
    marginBottom: 6,
  },
  replyName: { fontSize: 12.5, fontWeight: '800', letterSpacing: -0.1 },
  replyText: { fontSize: 12.5, lineHeight: 17, marginTop: 3, opacity: 0.85 },
  bubble: {
    borderRadius: 20, paddingHorizontal: 13,
    paddingTop: 8, paddingBottom: 8,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.07, shadowRadius: 6 },
      android: { elevation: 2 },
      web: { boxShadow: '0 1px 2px rgba(0,0,0,0.04), 0 4px 12px rgba(0,0,0,0.06)' },
    }),
  },
  bubbleOwn: {
    borderTopRightRadius: 20, borderBottomRightRadius: 6,
    borderTopLeftRadius: 20, borderBottomLeftRadius: 20,
  },
  bubbleOther: {
    borderTopLeftRadius: 20, borderBottomLeftRadius: 6,
    borderTopRightRadius: 20, borderBottomRightRadius: 20,
    borderWidth: 0, borderColor: 'transparent',
  },
  bubbleDeleted: { opacity: 0.5 },
  msgText: { fontSize: 15, lineHeight: 21.5, letterSpacing: -0.05 },
  deletedText: { fontSize: 14, fontStyle: 'italic', opacity: 0.7 },
  msgMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 4, marginTop: 5 },
  editedLabel: { fontSize: 10, fontStyle: 'italic' },
  msgTime: { fontSize: 11, fontWeight: '500', letterSpacing: 0.1 },
  chatImage: {
    width: 250, height: 210, borderRadius: 16, marginBottom: 2,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.15, shadowRadius: 12 },
      android: { elevation: 5 },
      web: { boxShadow: '0 4px 18px rgba(0,0,0,0.14), 0 1px 4px rgba(0,0,0,0.08)' },
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
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.1, shadowRadius: 6 },
      android: { elevation: 3 },
      web: { boxShadow: '0 2px 8px rgba(0,0,0,0.08)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)', transition: 'transform 0.15s cubic-bezier(0.34,1.56,0.64,1)' },
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
    paddingHorizontal: Spacing.md + 2, paddingVertical: 13,
    borderTopWidth: 0, borderRadius: 20, marginHorizontal: 10, marginBottom: 6,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 3 }, shadowOpacity: 0.10, shadowRadius: 12 },
      android: { elevation: 4 },
      web: { backdropFilter: 'blur(24px)', WebkitBackdropFilter: 'blur(24px)', boxShadow: '0 4px 20px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)' },
    }),
  },
  replyBarLine: { width: 4, height: '100%', borderRadius: 2.5, marginRight: Spacing.md },
  replyBarContent: { flex: 1 },
  replyBarLabel: { fontSize: 12, fontWeight: '800', letterSpacing: -0.1 },
  replyBarText: { fontSize: 13, marginTop: 3, lineHeight: 18, opacity: 0.85 },
  replyBarClose: { padding: 10, borderRadius: 20 },
  uploadBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  uploadText: { fontSize: FontSize.sm },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 8, paddingTop: 8, paddingBottom: 8,
    gap: 6,
    borderTopWidth: 0,
    ...Platform.select({
      ios: {},
      android: {},
      web: { maxWidth: 960, alignSelf: 'center', width: '100%' },
    }),
  },
  attachBtn: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'flex-end', marginBottom: 2,
    ...(Platform.OS === 'web' ? { transition: 'background-color 0.15s ease', cursor: 'pointer' } : {}),
  },
  input: {
    flex: 1, minHeight: 44, maxHeight: 120,
    borderRadius: 26, paddingHorizontal: 18,
    paddingTop: Platform.OS === 'ios' ? 12 : 10,
    paddingBottom: Platform.OS === 'ios' ? 12 : 10,
    fontSize: 15, borderWidth: 0,
    ...Platform.select({
      ios: { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.04, shadowRadius: 3 },
      android: { elevation: 1 },
      web: { outlineStyle: 'none', boxShadow: '0 1px 3px rgba(0,0,0,0.04), inset 0 0 0 1px rgba(0,0,0,0.05)' },
    }),
  },
  sendBtn: {
    width: 46, height: 46, borderRadius: 23,
    alignItems: 'center', justifyContent: 'center',
    alignSelf: 'flex-end', marginBottom: 2,
    ...Platform.select({
      ios: { shadowColor: '#25D366', shadowOffset: { width: 0, height: 4 }, shadowOpacity: 0.4, shadowRadius: 12 },
      android: { elevation: 7 },
      web: {
        background: 'linear-gradient(135deg, #25D366 0%, #128C7E 100%)',
        boxShadow: '0 6px 20px rgba(37,211,102,0.42), 0 2px 6px rgba(37,211,102,0.18)',
        transition: 'transform 0.15s cubic-bezier(0.34,1.56,0.64,1), box-shadow 0.2s ease',
        cursor: 'pointer',
      },
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
