import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Image,
  ActivityIndicator, TextInput, Platform, Keyboard, Dimensions,
  Alert, Modal, Pressable, Linking, Animated, ScrollView, PanResponder,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';
import { useLanguage } from '../context/LanguageContext';
import { BorderRadius, FontSize, Spacing, Shadow } from '../constants/theme';
import * as api from '../services/api';
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
  IconStar, IconStarFilled, IconBarChart,
} from '../components/Icons';
import { WebView } from 'react-native-webview';
import ChatMediaViewer from '../components/ChatMediaViewer';
import AvatarCircle from '../components/AvatarCircle';
import { MentionAutocomplete, isMentioning, insertMention, isUserMentioned } from '../components/MentionInput';
import { ScheduleToast, CustomScheduleModal, ScheduledMessagesModal } from '../components/ScheduleModals';
import GifPickerPanel from '../components/GifPicker';

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
    <View style={{ alignSelf: 'flex-start', marginBottom: 4, marginLeft: 8 }}>
      {name && <Text style={{ fontSize: 11, color: colors.textTertiary, marginBottom: 2, marginLeft: 4 }}>{name}</Text>}
      <View style={{ backgroundColor: colors.surface, borderRadius: 18, borderBottomLeftRadius: 4, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', gap: 4, alignItems: 'center' }}>
        {recording ? (
          <>
            <IconMic size={14} color={colors.error || '#EF4444'} style={{ marginRight: 2 }} />
            <Text style={{ fontSize: 12, color: colors.textTertiary, fontStyle: 'italic' }}>{t ? t('chat.recording') : 'recording...'}</Text>
          </>
        ) : (
          [dot1, dot2, dot3].map((dot, i) => (
            <Animated.View key={i} style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.textTertiary, transform: [{ translateY: dot }] }} />
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
        URL_REGEX.test(part) ? (
          <Text key={i} style={{ color: linkColor, textDecorationLine: 'underline' }}
            onPress={() => { try { Linking.openURL(part); } catch {} }}>
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
      {preview.image && <Image source={{ uri: preview.image }} style={linkPreviewStyles.image} resizeMode="cover" />}
      <View style={linkPreviewStyles.textContainer}>
        <Text style={[linkPreviewStyles.domain, { color: colors.textTertiary }]}>{preview.domain}</Text>
        {preview.title ? <Text style={[linkPreviewStyles.title, { color: colors.text }]} numberOfLines={2}>{preview.title}</Text> : null}
        {preview.description ? <Text style={[linkPreviewStyles.desc, { color: colors.textSecondary }]} numberOfLines={2}>{preview.description}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}
const linkPreviewStyles = StyleSheet.create({
  container: { borderWidth: 1, borderRadius: 8, overflow: 'hidden', marginTop: 6, maxWidth: 280 },
  image: { width: '100%', height: 140 },
  textContainer: { padding: 8 },
  domain: { fontSize: 11, textTransform: 'uppercase', marginBottom: 2 },
  title: { fontSize: 14, fontWeight: '600', marginBottom: 2 },
  desc: { fontSize: 12, lineHeight: 16 },
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
function SwipeReplyWrap({ children, onReply, disabled, colors, style }) {
  const swipeX = useRef(new Animated.Value(0)).current;
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, g) => !disabled && g.dx > 20 && Math.abs(g.dx) > Math.abs(g.dy) * 3,
      onMoveShouldSetPanResponderCapture: () => false,
      onStartShouldSetPanResponder: () => false,
      onPanResponderMove: (_, g) => {
        if (g.dx > 0) swipeX.setValue(Math.min(g.dx, 80));
      },
      onPanResponderRelease: (_, g) => {
        if (g.dx > 50) {
          try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
          onReply?.();
        }
        Animated.spring(swipeX, { toValue: 0, useNativeDriver: Platform.OS !== 'web', friction: 8 }).start();
      },
    })
  ).current;

  return (
    <Animated.View {...(disabled ? {} : panResponder.panHandlers)} style={[{ transform: [{ translateX: swipeX }] }, style]}>
      <Animated.View style={{ position: 'absolute', left: -30, top: '50%', marginTop: -10, opacity: swipeX.interpolate({ inputRange: [0, 50], outputRange: [0, 0.8], extrapolate: 'clamp' }) }} pointerEvents="none">
        <IconReply size={20} color={colors.textTertiary} />
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
  if (!dateStr) return '';
  const d = new Date(dateStr + (dateStr.includes('Z') ? '' : 'Z'));
  const now = new Date();
  const diffMin = Math.floor((now - d) / 60000);
  if (diffMin < 1) return t('chat.justNow') || 'agora';
  if (diffMin < 60) return `há ${diffMin} min`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) {
    // Today: show time like "hoje às 14:30"
    return `hoje às ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  if (diffHr < 48) {
    return `ontem às ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  }
  return `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })} às ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
}

const QUICK_REACTIONS = [
  { key: 'thumbsup', Icon: IconThumbsUp },
  { key: 'heart', Icon: IconHeart },
  { key: 'laugh', Icon: IconLaughFace },
  { key: 'surprise', Icon: IconSurpriseFace },
  { key: 'sad', Icon: IconSadFace },
  { key: 'pray', Icon: IconPrayHands },
];

const REACTION_ICON_MAP = {
  thumbsup: IconThumbsUp, heart: IconHeart, laugh: IconLaughFace,
  surprise: IconSurpriseFace, sad: IconSadFace, pray: IconPrayHands,
};

// ============================================================
// AUDIO PLAYER COMPONENT
// ============================================================

function AudioPlayer({ url, duration, isOwn, colors }) {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const soundRef = useRef(null);
  const intervalRef = useRef(null);

  useEffect(() => {
    return () => {
      if (Platform.OS === 'web') {
        try { soundRef.current?.pause(); } catch {}
      } else {
        soundRef.current?.unloadAsync?.().catch(() => {});
      }
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  const togglePlay = async () => {
    try {
      if (Platform.OS === 'web') {
        // Web: use HTML5 Audio
        if (playing && soundRef.current) {
          soundRef.current.pause();
          setPlaying(false);
          if (intervalRef.current) clearInterval(intervalRef.current);
          return;
        }
        if (!soundRef.current) {
          const audio = new window.Audio(url);
          audio.onended = () => { setPlaying(false); setProgress(0); if (intervalRef.current) clearInterval(intervalRef.current); };
          soundRef.current = audio;
        }
        soundRef.current.currentTime = 0;
        await soundRef.current.play();
        setPlaying(true);
        intervalRef.current = setInterval(() => {
          const a = soundRef.current;
          if (a && a.duration > 0) setProgress(a.currentTime / a.duration);
        }, 100);
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
          if (status.playing && status.duration > 0) setProgress(status.currentTime / status.duration);
          if (!status.playing && status.currentTime >= status.duration && status.duration > 0) {
            setPlaying(false); setProgress(0); if (intervalRef.current) clearInterval(intervalRef.current);
          }
        });
        player.play();
        soundRef.current = player;
        setPlaying(true);
      } else {
        await soundRef.current.seekTo(0);
        soundRef.current.play();
        setPlaying(true);
      }
    } catch (e) {
      console.warn('Audio play error:', e);
    }
  };

  const tintColor = isOwn ? 'rgba(255,255,255,0.9)' : colors.primary;
  const trackBg = isOwn ? 'rgba(255,255,255,0.3)' : colors.border;

  return (
    <View style={audioStyles.container}>
      <TouchableOpacity onPress={togglePlay} style={audioStyles.playBtn}>
        {playing ? (
          <IconPause size={20} color={tintColor} />
        ) : (
          <IconPlay size={20} color={tintColor} />
        )}
      </TouchableOpacity>
      <View style={audioStyles.trackWrap}>
        <View style={[audioStyles.track, { backgroundColor: trackBg }]}>
          <View style={[audioStyles.trackFill, { backgroundColor: tintColor, width: `${progress * 100}%` }]} />
        </View>
        <Text style={[audioStyles.duration, { color: isOwn ? 'rgba(255,255,255,0.6)' : colors.textTertiary }]}>
          {duration ? formatDuration(duration) : '0:00'}
        </Text>
      </View>
      <IconMic size={14} color={tintColor} style={{ marginLeft: 4 }} />
    </View>
  );
}

const audioStyles = StyleSheet.create({
  container: { flexDirection: 'row', alignItems: 'center', minWidth: 200, paddingVertical: 4 },
  playBtn: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  trackWrap: { flex: 1, marginLeft: 4 },
  track: { height: 4, borderRadius: 2, overflow: 'hidden' },
  trackFill: { height: '100%', borderRadius: 2 },
  duration: { fontSize: 10, marginTop: 2 },
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
          <TouchableOpacity onPress={onClose} style={{ padding: 8 }}>
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
        <Text style={[locStyles.label, { color: isOwn ? '#fff' : colors.text }]} numberOfLines={2}>
          {label || 'Localização'}
        </Text>
      </View>
      {isStillLive && updatedAt && (
        <Text style={{ fontSize: 10, color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary, paddingHorizontal: 4, paddingBottom: 2 }}>
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
        <Text style={{ fontSize: 13, fontWeight: '600', color: isOwn ? '#fff' : colors.text }}>
          {isVideo
            ? (isIncoming ? 'Videochamada recebida' : 'Videochamada')
            : (isIncoming ? 'Chamada recebida' : 'Chamada de voz')
          }
        </Text>
        {callData.started_at && (
          <Text style={{ fontSize: 11, color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary }}>
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

function ContactMessage({ content, isOwn, colors }) {
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
        <Text style={[contactStyles.name, { color: isOwn ? '#fff' : colors.text }]}>{contactData.name || t('chatConv.contact')}</Text>
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
function safeAlert(title, message) {
  if (Platform.OS === 'web') {
    try { window.alert(message || title); } catch {}
  } else {
    try { Alert.alert(title, message); } catch {}
  }
}

// ============================================================
// AUDIO RECORDER
// ============================================================

function AudioRecorder({ onSend, onCancel, colors }) {
  const [recording, setRecording] = useState(null);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState(null);
  const intervalRef = useRef(null);
  const startTimeRef = useRef(0);
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    startRecording();
    return () => {
      mountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      if (Platform.OS === 'web') {
        try {
          const mr = mediaRecorderRef.current;
          if (mr && mr.state !== 'inactive') mr.stop();
          if (mr?.stream) mr.stream.getTracks().forEach(t => t.stop());
        } catch {}
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
        <View style={recStyles.center}>
          <IconAlertTriangle size={18} color={colors.error || '#ef4444'} />
          <Text style={{ color: colors.error || '#ef4444', fontSize: FontSize.sm, marginLeft: 8, flex: 1 }}>{error}</Text>
        </View>
        <TouchableOpacity onPress={onCancel} style={recStyles.btn}>
          <IconX size={20} color={colors.textSecondary} />
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <View style={[recStyles.container, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
      <TouchableOpacity onPress={handleCancel} style={recStyles.btn}>
        <IconTrash size={20} color={colors.error} />
      </TouchableOpacity>
      <View style={recStyles.center}>
        <View style={[recStyles.dot, { backgroundColor: '#ef4444' }]} />
        <Text style={[recStyles.timer, { color: colors.text }]}>{formatDuration(duration)}</Text>
      </View>
      <TouchableOpacity onPress={handleSend} style={[recStyles.sendBtn, { backgroundColor: colors.primary }]}>
        <IconSend size={18} color="#fff" />
      </TouchableOpacity>
    </View>
  );
}

const recStyles = StyleSheet.create({
  container: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: Spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  btn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  center: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  timer: { fontSize: FontSize.lg, fontWeight: '700', fontVariant: ['tabular-nums'] },
  hint: { fontSize: FontSize.xs },
  sendBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
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
  const mountedRef = useRef(true);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [newMsgCount, setNewMsgCount] = useState(0);
  const isScrolledUpRef = useRef(false);

  useEffect(() => { return () => { mountedRef.current = false; }; }, []);

  const conversationId = parseInt(params.id, 10);
  const conversationName = params.name || t('chat.defaultName');
  const conversationType = params.type || 'direct';

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

  const [messages, setMessages] = useState([]);
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
  const [inputFocused, setInputFocused] = useState(false);
  const [readReceipts, setReadReceipts] = useState([]);

  // WhatsApp features state
  const [mediaPreview, setMediaPreview] = useState({ visible: false, uri: null, type: 'image', file: null });
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [showPollCreator, setShowPollCreator] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [presence, setPresence] = useState(null); // { status, last_seen }
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [mediaViewer, setMediaViewer] = useState({ visible: false, fileUrl: '', fileName: '', fileSize: 0, type: '' });
  const [forwardMsg, setForwardMsg] = useState(null);
  const [forwardConversations, setForwardConversations] = useState([]);
  const [forwardLoading, setForwardLoading] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  const [showGroupInfo, setShowGroupInfo] = useState(false);
  const [mentionedEmails, setMentionedEmails] = useState([]);
  const [showMentionPopup, setShowMentionPopup] = useState(false);
  const [showStarredModal, setShowStarredModal] = useState(false);
  const [starredMessages, setStarredMessages] = useState([]);
  const [starredLoading, setStarredLoading] = useState(false);
  const [profileViewer, setProfileViewer] = useState(null); // { name, email }
  const [members, setMembers] = useState([]);
  const [editGroupName, setEditGroupName] = useState('');

  // Disappearing messages
  const [disappearingTimer, setDisappearingTimer] = useState(0);
  const [showDisappearingModal, setShowDisappearingModal] = useState(false);

  // Wallpaper (from chatyy settings, server-side)
  const wallpaperColor = chatyySettings.wallpaper || 'none';
  const [showWallpaperPicker, setShowWallpaperPicker] = useState(false);
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
    setChatLocked(false);
    setChatUnlocked(true);
    safeAlert(t('chatConv.lockRemoved') || 'Lock removed', t('chatConv.lockRemovedDesc') || 'Chat lock has been removed');
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
    const otherEmail = (params.email || '').toLowerCase();

    const findPresence = (data) => {
      if (!data || conversationType !== 'direct') return null;
      // Find the specific contact's presence, not just any non-self user
      if (otherEmail) {
        return data.find(p => p.email?.toLowerCase() === otherEmail);
      }
      return data.find(p => p.email !== currentEmail);
    };

    // Update own presence to online
    api.chatPresence('online').then(r => {
      if (r.success && r.data) {
        const found = findPresence(r.data);
        if (found) setPresence(found);
      }
    }).catch(() => {});

    // Poll presence every 15 seconds
    const presenceInterval = setInterval(() => {
      api.chatPresence('online').then(r => {
        if (r.success && r.data && mountedRef.current) {
          const found = findPresence(r.data);
          if (found) setPresence(found);
        }
      }).catch(() => {});
    }, 15000);

    return () => clearInterval(presenceInterval);
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
    if (showLoader) setLoading(true);
    if (beforeId) setLoadingMore(true);
    try {
      const r = await api.chatMessages(conversationId, 50, beforeId);
      if (r.success && mountedRef.current) {
        const newMsgs = decryptMessages(r.data?.messages || []);
        if (beforeId) {
          setMessages(prev => [...newMsgs, ...prev]);
        } else {
          setMessages(newMsgs);
        }
        setHasMore(r.data?.has_more || false);
        if (r.data?.read_receipts) setReadReceipts(r.data.read_receipts);
        if (r.data?.disappearing_timer !== undefined) setDisappearingTimer(r.data.disappearing_timer);

        if (!beforeId && newMsgs.length > 0 && chatyySettings.read_receipts !== false) {
          const lastMsg = newMsgs[newMsgs.length - 1];
          api.chatRead(conversationId, lastMsg.id).catch(() => {});
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
    // Load group members on mount for mention autocomplete
    if (conversationType === 'group') {
      api.chatMembers(conversationId).then(r => {
        if (r.success) setMembers(r.data || []);
      }).catch(() => {});
    }
  }, [loadMessages]);

  // WebSocket real-time messages + slow polling fallback
  const [typingUser, setTypingUser] = useState(null);
  const [typingIsRecording, setTypingIsRecording] = useState(false);
  const typingTimerRef = useRef(null);
  useEffect(() => {
    let wsUnsubs = [];
    try {
      const mailWs = require('../services/websocket').default;
      // Subscribe to this conversation's channel
      if (mailWs.isConnected) {
        mailWs._send({ type: 'subscribe', channel: `chat_${conversationId}` });
      }
      // Listen for new chat messages via WS
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
            const tempIdx = prev.findIndex(m =>
              typeof m.id === 'string' && m.id.startsWith('tmp_') && m._pending &&
              m.sender === msg.sender_email && m.content === msg.content
            );
            if (tempIdx !== -1) {
              const next = [...prev];
              next[tempIdx] = { ...msg, _pending: false };
              return next;
            }
            return [...prev, msg];
          });
          // Mark as read since user is viewing the conversation
          if (msg.sender_email !== currentEmail && msg.id && chatyySettings.read_receipts !== false) {
            api.chatRead(conversationId, msg.id).catch(() => {});
            if (isScrolledUpRef.current) setNewMsgCount(c => c + 1);
          }
        }
      });
      wsUnsubs.push(unsubMsg);
      // Listen for typing indicators
      const unsubTyping = mailWs.on('typing', (data) => {
        if (!mountedRef.current) return;
        if (String(data?.conversation_id) === String(conversationId) && data?.email !== currentEmail) {
          setTypingUser(data.name || data.email?.split('@')[0]);
          setTypingIsRecording(!!data.recording);
          if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
          typingTimerRef.current = setTimeout(() => { setTypingUser(null); setTypingIsRecording(false); }, 3000);
        }
      });
      wsUnsubs.push(unsubTyping);
      // Re-subscribe on reconnect
      const unsubConn = mailWs.on('connection', (data) => {
        if (data.status === 'authenticated') {
          mailWs._send({ type: 'subscribe', channel: `chat_${conversationId}` });
        }
      });
      wsUnsubs.push(unsubConn);
    } catch {}
    // Slow fallback polling (every 15s instead of 3s)
    const pollingRef = { current: false };
    pollRef.current = setInterval(async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try { await loadMessages(false); } finally { pollingRef.current = false; }
    }, 15000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      wsUnsubs.forEach(fn => fn?.());
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, [loadMessages, conversationId, currentEmail]);

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
    if (!text || sending) return;

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
      } : null,
      created_at: new Date().toISOString(),
      _pending: true,
    };
    setMessages(prev => [...prev, optimisticMsg]);
    if (Platform.OS !== 'web') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    requestAnimationFrame(() => {
      flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true });
    });

    try {
      // Encrypt if E2E is enabled
      const contentToSend = (e2eEnabled && e2eKeys)
        ? e2eService.createEnvelope(text, currentEmail, e2eKeys)
        : text;

      const r = await api.chatSend(conversationId, contentToSend, 'text', replyId, currentMentions);
      if (r.success && r.data?.message) {
        // Replace temp message with real server message (show decrypted text)
        const serverMsg = { ...r.data.message, _pending: false };
        if (e2eEnabled) {
          serverMsg.content = text; // We already know the plaintext
          serverMsg._e2e = true;
        }
        setMessages(prev => prev.map(m => m.id === tempId ? serverMsg : m));
      } else {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false } : m));
      }
    } catch {
      setMessages(prev => prev.map(m => m.id === tempId ? { ...m, _failed: true, _pending: false } : m));
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
      if (r.success && r.data?.message) {
        setMessages(prev => prev.map(m => m.id === tempId ? { ...r.data.message, _pending: false } : m));
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
        try { const mailWs = require('../services/websocket').default; if (mailWs.isConnected) mailWs._send({ type: 'typing', conversation_id: conversationId, recording: true }); } catch {}
        return;
      case 'location': return handleShareLocation();
      case 'liveLocation': return handleShareLiveLocation();
      case 'contact': return handleShareContact();
      case 'poll': setShowPollCreator(true); return;
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
          resolve({ uri, blob: file, name: file.name, type: file.type });
        } else {
          resolve(null);
        }
      };
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
        allowsMultipleSelection: false,
        videoMaxDuration: 120,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      const file = {
        uri: asset.uri,
        name: asset.fileName || `media_${Date.now()}.${asset.type === 'video' ? 'mp4' : 'jpg'}`,
        type: asset.type === 'video' ? 'video/mp4' : 'image/jpeg',
      };
      setMediaPreview({ visible: true, uri: asset.uri, type: asset.type === 'video' ? 'video' : 'image', file });
    } catch (e) {
      console.warn('Gallery error:', e);
    }
  };

  const handleAttachFile = async () => {
    try {
      if (Platform.OS === 'web') {
        const file = await handleWebFilePick('*/*');
        if (file) await uploadAndSendFile(file);
        return;
      }
      const result = await DocumentPicker.getDocumentAsync({
        type: '*/*',
        copyToCacheDirectory: true,
      });
      if (result.canceled || !result.assets?.[0]) return;
      const asset = result.assets[0];
      await uploadAndSendFile({
        uri: asset.uri,
        name: asset.name || 'file',
        type: asset.mimeType || 'application/octet-stream',
      });
    } catch (e) {
      console.warn('File pick error:', e);
    }
  };

  const uploadAndSendFile = async (file, forceViewOnce = false) => {
    setUploading(true);
    try {
      const r = await api.chatUploadFile(conversationId, file, '', forceViewOnce);
      if (r.success && r.data) {
        const msg = r.data.message || r.data;
        if (msg.id) {
          setMessages(prev => [...prev, msg]);
          requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));
        }
      } else {
        safeAlert(t('common.error') || 'Error', r.message || t('chatConv.uploadError') || 'Failed to send file');
      }
    } catch {
      safeAlert(t('common.error') || 'Error', t('chatConv.uploadError') || 'Failed to send file');
    } finally {
      setUploading(false);
    }
  };

  const handleSendAudio = async (audioData) => {
    setIsRecording(false);
    setUploading(true);
    try {
      const filePayload = {
        uri: audioData.uri,
        name: audioData.name,
        type: audioData.type,
      };
      if (audioData.blob) filePayload.blob = audioData.blob;
      const r = await api.chatUploadFile(conversationId, filePayload, `Audio (${formatDuration(audioData.duration)})`);
      if (r.success && r.data) {
        const msg = r.data.message || r.data;
        if (msg.id) {
          setMessages(prev => [...prev, msg]);
          requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));
        }
      }
    } catch {} finally {
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
      if (r.success && r.data?.message) {
        setMessages(prev => [...prev, r.data.message]);
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
      if (r.success && r.data?.message) {
        setMessages(prev => [...prev, r.data.message]);
        requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));

        // Start background location updates
        const msgId = r.data.message.id;
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
          } catch { clearInterval(updateInterval); }
        }, 10000);

        // Auto-stop after duration
        setTimeout(() => {
          clearInterval(updateInterval);
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
        Alert.alert(t('chatConv.permission') || 'Permission', t('chatConv.contactsPermission') || 'Allow contacts access in settings.');
        return;
      }
      const { data } = await Contacts.getContactsAsync({
        fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
        sort: Contacts.SortTypes.FirstName,
      });
      if (!data || data.length === 0) {
        Alert.alert('Info', t('chatConv.noContacts') || 'No contacts found');
        return;
      }

      const contactList = data.slice(0, 30).filter(c => c.name);
      if (contactList.length === 0) return;

      Alert.alert(
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
      if (r.success && r.data?.message) {
        setMessages(prev => [...prev, r.data.message]);
        requestAnimationFrame(() => flatListRef.current?.scrollToOffset?.({ offset: 0, animated: true }));
      }
    } catch {}
  };

  // ============================================================
  // MESSAGE ACTIONS
  // ============================================================

  const handleDelete = async (msgId) => {
    const deleteForEveryone = async () => {
      try {
        const r = await api.chatDelete(msgId);
        if (r.success) {
          setMessages(prev => prev.map(m =>
            m.id === msgId ? { ...m, deleted_at: new Date().toISOString(), content: '' } : m
          ));
        }
      } catch {}
      setSelectedMsg(null);
    };
    const deleteForMe = () => {
      setMessages(prev => prev.filter(m => m.id !== msgId));
      setSelectedMsg(null);
    };
    if (Platform.OS === 'web') {
      const choice = window.confirm(t('chatConv.deleteForEveryone') || 'Delete for everyone? (Cancel = delete for me only)');
      if (choice) deleteForEveryone();
      else deleteForMe();
      return;
    }
    Alert.alert(t('chat.deleteMessage'), t('chat.deleteConfirm'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('chatConv.deleteForMe'), onPress: deleteForMe },
      { text: t('chatConv.deleteForEveryone'), style: 'destructive', onPress: deleteForEveryone },
    ]);
  };

  const handleReact = async (msgId, emoji) => {
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

  const loadGroupMembers = async () => {
    try {
      const r = await api.chatMembers(conversationId);
      if (r.success) setMembers(r.data || []);
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
    Alert.alert(
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
        Alert.alert(t('common.error'), r.message || 'Error');
      }
    } catch {}
  };

  const handleRemoveMember = (memberEmail, memberName) => {
    Alert.alert(
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
      const prefix = `[${t('chatConv.forwarded')}] `;
      const senderName = forwardMsg.sender_name || forwardMsg.sender_email?.split('@')[0] || '';
      const content = forwardMsg.type === 'text'
        ? `${prefix}${senderName}: ${forwardMsg.content}`
        : forwardMsg.content || forwardMsg.file_name || '';
      await api.chatSend(targetConvId, forwardMsg.type === 'text' ? content : `${prefix}${senderName}: ${content}`, 'text');
      setForwardMsg(null);
      Alert.alert(t('chatConv.forwarded'), t('chatConv.forwardedSuccess'));
    } catch {
      Alert.alert(t('chatConv.forwardError'));
    }
  };

  const handleLongPress = (msg) => {
    if (msg.type === 'system' || msg.deleted_at) return;
    setSelectedMsg(msg);
  };

  // Start call from chat
  const [startingCall, setStartingCall] = useState(false);
  const [callingOverlay, setCallingOverlay] = useState(null); // { roomId, video, name, status }
  const callingRing1 = useRef(new Animated.Value(0)).current;
  const callingRing2 = useRef(new Animated.Value(0)).current;
  const callingRing3 = useRef(new Animated.Value(0)).current;
  const callingFade = useRef(new Animated.Value(0)).current;
  const callingTimeoutRef = useRef(null);

  useEffect(() => {
    if (!callingOverlay) return;
    const { startCallingTone, stopRingtone } = require('../services/ringtone');
    startCallingTone();

    // Fade in
    Animated.timing(callingFade, { toValue: 1, duration: 400, useNativeDriver: Platform.OS !== 'web' }).start();

    // Pulsing rings
    const createPulse = (anim, delay) => Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        Animated.timing(anim, { toValue: 1, duration: 2000, easing: undefined, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(anim, { toValue: 0, duration: 0, useNativeDriver: Platform.OS !== 'web' }),
      ])
    );
    const p1 = createPulse(callingRing1, 0);
    const p2 = createPulse(callingRing2, 600);
    const p3 = createPulse(callingRing3, 1200);
    p1.start(); p2.start(); p3.start();

    // Listen for call_accepted / call_declined via WebSocket
    let unsubAccepted, unsubDeclined;
    try {
      const mailWs = require('../services/websocket').default;
      unsubAccepted = mailWs.on('call_accepted', (data) => {
        if (data?.room_id === callingOverlay.roomId) {
          setCallingOverlay(prev => prev ? { ...prev, status: 'accepted' } : null);
          const otherEmail = conversationType === 'direct' ? (members.find(m => m.email !== currentEmail)?.email || params.email || '') : '';
          setTimeout(() => {
            setCallingOverlay(null);
            router.push(`/call?roomId=${data.room_id}&contactName=${encodeURIComponent(callingOverlay.name)}&contactEmail=${encodeURIComponent(otherEmail)}&isVideo=${callingOverlay.video ? '1' : '0'}&conversationId=${conversationId}`);
          }, 800);
        }
      });
      unsubDeclined = mailWs.on('call_declined', (data) => {
        if (data?.room_id === callingOverlay.roomId) {
          setCallingOverlay(prev => prev ? { ...prev, status: 'declined' } : null);
          setTimeout(() => setCallingOverlay(null), 2000);
        }
      });
    } catch {}

    // Auto-dismiss after 45s if no response (timeout) — do NOT navigate to meet
    callingTimeoutRef.current = setTimeout(() => {
      setCallingOverlay(prev => {
        if (prev && !prev.status) {
          return { ...prev, status: 'no_answer' };
        }
        return prev;
      });
      // Close overlay after showing "no answer" for 2s
      setTimeout(() => setCallingOverlay(null), 2000);
    }, 45000);

    return () => {
      p1.stop(); p2.stop(); p3.stop();
      stopRingtone();
      callingFade.setValue(0);
      callingRing1.setValue(0);
      callingRing2.setValue(0);
      callingRing3.setValue(0);
      if (unsubAccepted) unsubAccepted();
      if (unsubDeclined) unsubDeclined();
      if (callingTimeoutRef.current) clearTimeout(callingTimeoutRef.current);
    };
  }, [callingOverlay?.roomId]);

  const startCall = async (videoEnabled) => {
    if (startingCall) return;
    setStartingCall(true);
    try {
      // Generate a unique call ID (no meeting room needed - P2P WebRTC)
      const callId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const otherEmail = conversationType === 'direct' ? (members.find(m => m.email !== currentEmail)?.email || params.email || '') : '';
      const otherName = conversationName || t('chat.unknown');

      // Send push notification for the call
      api.callNotify(conversationId, callId, videoEnabled).catch(() => {});

      // Navigate to call screen as caller — WebRTC signaling happens in call screen
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
    const r = await api.chatSetDisappearing(conversationId, timer);
    if (r.success) {
      setDisappearingTimer(timer);
    }
  };

  const handleCancelCall = () => {
    setCallingOverlay(null);
  };

  // ============================================================
  // PRESENCE SUBTITLE
  // ============================================================

  const getPresenceText = () => {
    if (conversationType === 'group') return t('chatConv.group') || 'grupo';
    if (presence) {
      // Check if "online" is stale (last_seen > 2 min ago means they left without setting offline)
      if (presence.status === 'online') {
        if (presence.last_seen) {
          const lastSeenDate = new Date(presence.last_seen + (presence.last_seen.includes('Z') ? '' : 'Z'));
          const diffMin = (Date.now() - lastSeenDate.getTime()) / 60000;
          if (diffMin > 2) {
            return `${t('chatConv.lastSeen') || 'visto por último'} ${formatLastSeen(presence.last_seen, t)}`;
          }
        }
        return 'online';
      }
      if (presence.status === 'away') return t('chatConv.away') || 'ausente';
      if (presence.last_seen) return `${t('chatConv.lastSeen') || 'visto por último'} ${formatLastSeen(presence.last_seen, t)}`;
      return 'offline';
    }
    // Fallback: show last message time from the other person
    const otherEmail = params.email || '';
    if (otherEmail && messages.length > 0) {
      const lastOtherMsg = [...messages].reverse().find(m => m.sender_email === otherEmail && m.type !== 'system');
      if (lastOtherMsg?.created_at) {
        return `${t('chatConv.lastSeen') || 'visto por último'} ${formatLastSeen(lastOtherMsg.created_at, t)}`;
      }
    }
    return '';
  };

  const getPresenceColor = () => {
    if (!presence || conversationType === 'group') return colors.textTertiary;
    if (presence.status === 'online') return '#10b981';
    if (presence.status === 'away') return '#f59e0b';
    return colors.textTertiary;
  };

  // ============================================================
  // GROUP MESSAGES BY DATE
  // ============================================================

  const messagesWithSeparators = React.useMemo(() => {
    const result = [];
    let lastDate = '';
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      const d = new Date(msg.created_at + 'Z');
      const dateKey = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
      if (dateKey !== lastDate) {
        result.push({ _type: 'separator', _key: 'sep-' + dateKey, date: msg.created_at });
        lastDate = dateKey;
      }
      // Determine if this is the last message in a group from the same sender
      const nextMsg = messages[i + 1];
      const isLastInGroup = !nextMsg ||
        nextMsg.sender_email !== msg.sender_email ||
        nextMsg.type === 'system' ||
        msg.type === 'system' ||
        (new Date(nextMsg.created_at + 'Z') - d > 60000); // >1min gap = new group
      result.push({ ...msg, _isLastInGroup: isLastInGroup });
    }
    return result;
  }, [messages]);

  // ============================================================
  // RENDER MESSAGE
  // ============================================================

  const renderMessage = ({ item }) => {
    if (item._type === 'separator') {
      return (
        <View style={styles.dateSeparator}>
          <Text style={[styles.dateText, { color: colors.textSecondary, backgroundColor: colors.surface }]}>
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
          <Text style={[styles.deletedText, { color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary }]}>
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
              <Text style={[styles.deletedText, { color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary }]}>
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
          const fileUrl = msg.file_url?.startsWith('http') ? msg.file_url : `https://mail.onemundo.com.br${msg.file_url}`;
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
        case 'image':
          return (
            <TouchableOpacity onPress={() => msg.file_url && setMediaViewer({ visible: true, fileUrl: msg.file_url, fileName: msg.file_name || 'image', fileSize: msg.file_size || 0, type: 'image' })} activeOpacity={0.9}>
              <Image
                source={{ uri: msg.file_url?.startsWith('http') ? msg.file_url : `https://mail.onemundo.com.br${msg.file_url}` }}
                style={styles.chatImage}
                resizeMode="cover"
              />
              {msg.content && msg.content !== msg.file_name && (
                <Text style={[styles.msgText, { color: isOwn ? '#fff' : colors.text, fontSize: msgFontSize, lineHeight: msgLineHeight, marginTop: 4 }]}>{msg.content}</Text>
              )}
            </TouchableOpacity>
          );

        case 'video': {
          const videoUrl = msg.file_url?.startsWith('http') ? msg.file_url : `https://mail.onemundo.com.br${msg.file_url}`;
          return (
            <TouchableOpacity
              onPress={() => msg.file_url && setMediaViewer({ visible: true, fileUrl: msg.file_url, fileName: msg.file_name || 'video', fileSize: msg.file_size || 0, type: 'video' })}
              style={styles.videoThumb}
            >
              {Platform.OS === 'web' ? (
                <View style={styles.videoPreviewWrap}>
                  <video
                    src={videoUrl}
                    preload="metadata"
                    muted
                    playsInline
                    style={{ width: 240, height: 140, objectFit: 'cover', borderRadius: 12, backgroundColor: '#000' }}
                    onLoadedData={(e) => { try { e.target.currentTime = 0.5; } catch {} }}
                  />
                  <View style={styles.videoOverlayAbsolute}>
                    <View style={[styles.videoPlayBtn, { backgroundColor: 'rgba(0,0,0,0.55)' }]}>
                      <IconPlay size={24} color="#fff" />
                    </View>
                  </View>
                  {msg.file_size > 0 && (
                    <View style={styles.videoDurationBadge}>
                      <Text style={styles.videoDurationText}>
                        {msg.file_size < 1048576 ? (msg.file_size / 1024).toFixed(0) + ' KB' : (msg.file_size / 1048576).toFixed(1) + ' MB'}
                      </Text>
                    </View>
                  )}
                </View>
              ) : (
                <View style={styles.videoOverlay}>
                  <View style={[styles.videoPlayBtn, { backgroundColor: 'rgba(0,0,0,0.5)' }]}>
                    <IconPlay size={24} color="#fff" />
                  </View>
                </View>
              )}
              <Text style={[styles.msgText, { color: isOwn ? '#fff' : colors.text, fontSize: msgFontSize, lineHeight: msgLineHeight, marginTop: 4 }]} numberOfLines={1}>
                {msg.file_name || msg.content || 'Video'}
              </Text>
            </TouchableOpacity>
          );
        }

        case 'audio':
          return (
            <AudioPlayer
              url={msg.file_url?.startsWith('http') ? msg.file_url : `https://mail.onemundo.com.br${msg.file_url}`}
              duration={msg.duration || 0}
              isOwn={isOwn}
              colors={colors}
            />
          );

        case 'location':
          return <LocationMessage content={msg.content} isOwn={isOwn} colors={colors} onOpenMap={setMapModalData} />;

        case 'contact':
          return <ContactMessage content={msg.content} isOwn={isOwn} colors={colors} />;

        case 'sticker':
          return (
            <Image
              source={{ uri: msg.content || msg.file_url }}
              style={{ width: 120, height: 120 }}
              resizeMode="contain"
            />
          );

        case 'gif':
          return (
            <Image
              source={{ uri: msg.content }}
              style={{ width: 200, height: 200, borderRadius: 8 }}
              resizeMode="contain"
            />
          );

        case 'file':
          return (
            <TouchableOpacity
              onPress={() => msg.file_url && setMediaViewer({ visible: true, fileUrl: msg.file_url, fileName: msg.file_name || msg.content || 'file', fileSize: msg.file_size || 0, type: 'file' })}
              style={styles.fileAttach}
            >
              <IconFileText size={20} color={isOwn ? 'rgba(255,255,255,0.8)' : colors.primary} />
              <View style={{ flex: 1 }}>
                <Text style={[styles.msgText, { color: isOwn ? '#fff' : colors.text, fontSize: msgFontSize, lineHeight: msgLineHeight }]} numberOfLines={1}>{msg.file_name || msg.content}</Text>
                {msg.file_size > 0 && (
                  <Text style={{ fontSize: 11, color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary }}>
                    {msg.file_size < 1048576 ? (msg.file_size / 1024).toFixed(0) + ' KB' : (msg.file_size / 1048576).toFixed(1) + ' MB'}
                  </Text>
                )}
              </View>
            </TouchableOpacity>
          );

        case 'poll': {
          const poll = msg.poll;
          if (!poll) return <Text style={[styles.msgText, { color: isOwn ? '#fff' : colors.text }]}>{msg.content}</Text>;
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
                <Text style={{ fontWeight: '700', fontSize: msgFontSize, color: isOwn ? '#fff' : colors.text, flex: 1 }}>{poll.question}</Text>
              </View>
              {poll.multiple_choice && (
                <Text style={{ fontSize: 11, color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary, marginBottom: 6 }}>
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
                      <Text style={{ flex: 1, fontSize: msgFontSize - 1, color: isOwn ? '#fff' : colors.text, fontWeight: voted ? '600' : '400' }}>{opt}</Text>
                      <Text style={{ fontSize: 12, color: isOwn ? 'rgba(255,255,255,0.6)' : colors.textSecondary, marginLeft: 8 }}>{pct}%</Text>
                    </View>
                  </TouchableOpacity>
                );
              })}
              <Text style={{ fontSize: 11, color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary, marginTop: 2 }}>
                {(t('chat.pollVotes') || '{n} votos').replace('{n}', poll.total_votes)}
              </Text>
            </View>
          );
        }

        default: { // text
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
                  <Text style={{ fontSize: 13, fontWeight: '600', color: isOwn ? '#fff' : colors.text }}>
                    {isVideo ? 'Videochamada' : 'Chamada de voz'}
                  </Text>
                  <Text style={{ fontSize: 11, color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary }}>
                    Toque para entrar
                  </Text>
                </View>
              </TouchableOpacity>
            );
          }
          const urlMatch = msg.content && msg.content.match(URL_REGEX);
          const firstUrl = urlMatch ? urlMatch[0] : null;
          return (
            <View>
              <TextWithLinks
                text={msg.content}
                style={[styles.msgText, { color: isOwn ? '#fff' : colors.text, fontSize: msgFontSize, lineHeight: msgLineHeight }]}
                linkColor={isOwn ? '#bbdefb' : colors.primary}
                mentionColor={isOwn ? '#bbdefb' : '#1a73e8'}
                colors={colors}
              />
              {firstUrl && <LinkPreview url={firstUrl} colors={colors} />}
            </View>
          );
        }
      }
    };

    const isLastInGroup = msg._isLastInGroup !== false;

    return (
      <SwipeReplyWrap
        disabled={isDeleted || isSystem}
        onReply={() => { setReplyTo(msg); inputRef.current?.focus(); }}
        colors={colors}
        style={{ marginBottom: isLastInGroup ? 6 : 1 }}
      >
        <TouchableOpacity
          activeOpacity={0.8}
          onLongPress={() => handleLongPress(msg)}
          style={[styles.msgRow, isOwn ? styles.msgRowOwn : styles.msgRowOther]}
        >
          {!isOwn && conversationType === 'group' && !isDeleted && isLastInGroup && (
            <View style={styles.msgSenderRow}>
              <TouchableOpacity activeOpacity={0.7} onPress={() => setProfileViewer({ name: msg.sender_name || msg.sender_email, email: msg.sender_email })}>
                <AvatarCircle name={msg.sender_name || msg.sender_email} email={msg.sender_email} size={28} style={{ marginRight: 6 }} />
              </TouchableOpacity>
              <Text style={[styles.msgSender, { color: colors.primary }]}>
                {msg.sender_name || msg.sender_email.split('@')[0]}
              </Text>
            </View>
          )}

          <View style={[
            styles.bubble,
            isOwn
              ? [styles.bubbleOwn, { backgroundColor: colors.primary },
                 isLastInGroup && { borderBottomRightRadius: 4 }]
              : [styles.bubbleOther, { backgroundColor: isUserMentioned(msg, currentEmail) ? (isDark ? '#1a3a2a' : '#d9f2e6') : colors.surface },
                 isLastInGroup && { borderBottomLeftRadius: 4 }],
            !isLastInGroup && { borderRadius: 18 },
            isDeleted && styles.bubbleDeleted,
            (msg.type === 'sticker' || msg.type === 'gif') && { backgroundColor: 'transparent', borderWidth: 0, paddingHorizontal: 0, elevation: 0 },
            msg._pending && { opacity: 0.7 },
            msg._failed && { opacity: 0.5 },
          ]}>
          {msg.reply_to && !isDeleted && (
            <View style={[styles.replyIndicator, {
              backgroundColor: isOwn ? 'rgba(255,255,255,0.15)' : colors.border + '40',
              borderLeftColor: isOwn ? '#fff' : colors.primary,
            }]}>
              <Text style={[styles.replyName, { color: isOwn ? '#fff' : colors.primary }]} numberOfLines={1}>
                {msg.reply_to?.sender_name || t('chat.unknown')}
              </Text>
              <Text style={[styles.replyText, { color: isOwn ? 'rgba(255,255,255,0.7)' : colors.textSecondary }]} numberOfLines={2}>
                {msg.reply_to.content || ''}
              </Text>
            </View>
          )}
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
                <Text style={[styles.editedLabel, { color: isOwn ? 'rgba(255,255,255,0.5)' : colors.textTertiary }]}>
                  {t('chatConv.edited')}
                </Text>
              )}
              <Text style={[styles.msgTime, { color: isOwn ? 'rgba(255,255,255,0.6)' : colors.textTertiary }]}>
                {formatTime(msg.created_at)}
              </Text>
              {isOwn && !isDeleted && (() => {
                if (msg._failed) return (
                  <IconAlertTriangle size={12} color="#EF4444" style={{ marginLeft: 2 }} />
                );
                if (msg._pending) return (
                  <IconClock size={12} color="rgba(255,255,255,0.4)" style={{ marginLeft: 2 }} />
                );
                const isRead = readReceipts.some(rr => rr.last_read_id >= msg.id);
                return isRead ? (
                  <View style={{ flexDirection: 'row', marginLeft: 2 }}>
                    <IconCheck size={12} color="#34D399" style={{ marginRight: -6 }} />
                    <IconCheck size={12} color="#34D399" />
                  </View>
                ) : (
                  <IconCheck size={12} color="rgba(255,255,255,0.6)" />
                );
              })()}
            </View>
          )}
        </View>

        {Object.keys(reactionGroups).length > 0 && !isDeleted && (
          <View style={[styles.reactionsRow, isOwn && styles.reactionsRowOwn]}>
            {Object.entries(reactionGroups).map(([emoji, users]) => (
              <TouchableOpacity
                key={emoji}
                onPress={() => handleReact(msg.id, emoji)}
                onLongPress={() => setReactionDetail({ emoji, reactors: users.map(u => ({ email: u, name: u.split('@')[0] })) })}
                delayLongPress={400}
                style={[styles.reactionChip, {
                  backgroundColor: users.includes(currentEmail) ? colors.primary + '20' : colors.surface,
                  borderColor: users.includes(currentEmail) ? colors.primary : colors.border,
                }]}
              >
                {(() => { const RIcon = REACTION_ICON_MAP[emoji]; return RIcon ? <RIcon size={14} color={colors.text} /> : <Text style={styles.reactionEmoji}>{emoji}</Text>; })()}
                <Text style={[styles.reactionCount, { color: colors.text }]}>{users.length}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
        </TouchableOpacity>
      </SwipeReplyWrap>
    );
  };

  // ============================================================
  // RENDER
  // ============================================================

  // Lock screen
  if (chatLocked && !chatUnlocked) {
    return (
      <View style={[styles.container, { backgroundColor: colors.background, justifyContent: 'center', alignItems: 'center' }]}>
        <View style={[styles.header, { borderBottomColor: colors.border, paddingTop: insets.top, position: 'absolute', top: 0, left: 0, right: 0 }]}>
          <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
            <IconArrowLeft size={22} color={colors.text} />
          </TouchableOpacity>
          <View style={styles.headerInfo}>
            <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>{conversationName}</Text>
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
      style={[styles.container, { backgroundColor: colors.background }]}
    >
      {/* Header with presence */}
      <View style={[styles.header, { borderBottomColor: colors.border, paddingTop: insets.top }]}>
        <TouchableOpacity onPress={() => router.back()} style={styles.headerBtn}>
          <IconArrowLeft size={22} color={colors.text} />
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
                backgroundColor: '#10b981', borderWidth: 2, borderColor: colors.background,
              }} />
            )}
          </View>
          </TouchableOpacity>
          <View style={{ flex: 1 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <Text style={[styles.headerTitle, { color: colors.text }]} numberOfLines={1}>
                {conversationName}
              </Text>
              {e2eEnabled && <IconLock size={13} color="#10b981" />}
            </View>
            {(getPresenceText() !== '') && (
              <Text style={[styles.headerSubtitle, { color: getPresenceColor() }]} numberOfLines={1}>
                {getPresenceText()}
              </Text>
            )}
          </View>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleStartAudioCall} disabled={startingCall} style={styles.headerBtn}>
          <IconPhone size={19} color={colors.primary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={handleStartVideoCall} disabled={startingCall} style={styles.headerBtn}>
          {startingCall
            ? <ActivityIndicator size="small" color={colors.primary} />
            : <IconVideo size={20} color={colors.primary} />}
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowDisappearingModal(true)} style={styles.headerBtn}>
          <IconClock size={16} color={disappearingTimer > 0 ? '#10b981' : colors.textTertiary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            if (chatLocked) {
              Alert.alert(
                t('chatConv.chatLockTitle') || 'Chat Lock',
                t('chatConv.removeLockConfirm') || 'Remove password lock from this chat?',
                [
                  { text: t('common.cancel'), style: 'cancel' },
                  { text: t('chatConv.removeLock') || 'Remove Lock', style: 'destructive', onPress: handleRemoveChatLock },
                ]
              );
            } else {
              setShowLockSetup(true);
              setLockPassInput('');
            }
          }}
          style={styles.headerBtn}
        >
          <IconLock size={16} color={chatLocked ? '#f59e0b' : colors.textTertiary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setShowWallpaperPicker(true)} style={styles.headerBtn}>
          <IconImage size={17} color={colors.textTertiary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { setShowStarredModal(true); loadStarredMessages(); }}
          style={styles.headerBtn}
        >
          <IconStar size={17} color={colors.textTertiary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { setShowScheduledMessages(true); loadScheduledMessages(); }}
          style={styles.headerBtn}
        >
          <IconClock size={17} color={colors.textTertiary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => router.push(`/chat-new?group_id=${conversationId}&mode=info`)}
          style={styles.headerBtn}
        >
          <IconUsers size={20} color={colors.text} />
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
                Alert.alert(
                  t('chatConv.securityCode') || 'Security Code',
                  `${safetyNumber}\n\n${t('chatConv.securityCodeDesc') || 'Compare this code with the other person to verify the encryption is secure.'}`,
                );
              }
            } else {
              Alert.alert(
                t('chatConv.e2eEnabled') || 'End-to-End Encryption',
                t('chatConv.e2eGroupDesc') || 'Messages in this conversation are end-to-end encrypted. Only participants can read them.',
              );
            }
          }}
          style={{
            flexDirection: 'row', alignItems: 'center', justifyContent: 'center',
            paddingVertical: 6, backgroundColor: colors.surface, gap: 6,
          }}
        >
          <IconLock size={12} color="#10b981" />
          <Text style={{ fontSize: 11, color: colors.textTertiary }}>
            {t('chatConv.e2eBanner') || 'Messages are end-to-end encrypted. Tap to verify.'}
          </Text>
        </TouchableOpacity>
      )}

      {/* Chat wallpaper */}
      {Platform.OS === 'web' && wallpaperColor === 'none' && (
        <View style={[styles.wallpaper, { opacity: colors === require('../constants/theme').DarkColors ? 0.03 : 0.04 }]} pointerEvents="none">
          <View style={styles.wallpaperPattern} />
        </View>
      )}
      {wallpaperColor !== 'none' && wallpaperColor.startsWith('#') && (
        <View style={[styles.wallpaper, { backgroundColor: wallpaperColor, opacity: 0.15 }]} pointerEvents="none" />
      )}

      {/* Messages */}
      {loading ? (
        <View style={styles.loaderWrap}>
          <ActivityIndicator size="large" color={colors.primary} />
        </View>
      ) : (
        <FlatList
          ref={flatListRef}
          data={[...messagesWithSeparators].reverse()}
          inverted
          keyExtractor={(item) => item._key || String(item.id)}
          renderItem={renderMessage}
          contentContainerStyle={[styles.messageList, { paddingTop: Spacing.sm }]}
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          bounces={false}
          overScrollMode="never"
          onEndReached={handleLoadMore}
          onEndReachedThreshold={0.3}
          onScroll={(e) => {
            const y = e.nativeEvent.contentOffset.y;
            const scrolledUp = y > 300;
            isScrolledUpRef.current = scrolledUp;
            setShowScrollDown(scrolledUp);
            if (!scrolledUp) setNewMsgCount(0);
          }}
          scrollEventThrottle={100}
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
              <Text style={[styles.emptyText, { color: colors.textTertiary }]}>
                {t('chatConv.empty')}
              </Text>
            </View>
          }
        />
      )}

      {/* Reply/Edit indicator */}
      {(replyTo || editingMsg) && (
        <View style={[styles.replyBar, { backgroundColor: colors.surface, borderTopColor: colors.border }]}>
          <View style={[styles.replyBarLine, { backgroundColor: colors.primary }]} />
          <View style={styles.replyBarContent}>
            <Text style={[styles.replyBarLabel, { color: colors.primary }]}>
              {editingMsg ? t('chat.editing') : t('chat.replyingTo', { name: replyTo?.sender_name || t('chat.message') })}
            </Text>
            <Text style={[styles.replyBarText, { color: colors.textSecondary }]} numberOfLines={1}>
              {editingMsg ? editingMsg.content : replyTo?.content}
            </Text>
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
          style={[styles.scrollDownFab, { backgroundColor: colors.surface, borderColor: colors.border }]}
          activeOpacity={0.8}
        >
          <IconChevronDown size={20} color={colors.textSecondary} />
          {newMsgCount > 0 && (
            <View style={[styles.scrollDownBadge, { backgroundColor: colors.primary }]}>
              <Text style={styles.scrollDownBadgeText}>{newMsgCount > 99 ? '99+' : newMsgCount}</Text>
            </View>
          )}
        </TouchableOpacity>
      )}

      {/* Audio Recorder (replaces input bar when recording) */}
      {isRecording ? (
        <View style={{ paddingBottom: Math.max(insets.bottom, Spacing.sm) }}>
          <AudioRecorder
            onSend={handleSendAudio}
            onCancel={() => setIsRecording(false)}
            colors={colors}
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
        <View style={[styles.inputBar, {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          paddingBottom: keyboardHeight > 0 ? Spacing.sm : Math.max(insets.bottom, Spacing.sm),
        }]}>
          {/* Attachment button (opens menu) */}
          <TouchableOpacity
            onPress={() => setShowAttachMenu(true)}
            disabled={uploading}
            style={styles.attachBtn}
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
              backgroundColor: colors.background,
              borderColor: colors.border,
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
              // Send typing indicator via WebSocket
              try {
                const mailWs = require('../services/websocket').default;
                if (mailWs.isConnected) {
                  mailWs._send({ type: 'typing', conversation_id: conversationId });
                }
              } catch {}
            }}
            multiline
            maxLength={5000}
            onSubmitEditing={Platform.OS === 'web' ? handleSend : undefined}
            blurOnSubmit={Platform.OS === 'web'}
            onFocus={() => setInputFocused(true)}
            onBlur={() => setInputFocused(false)}
          />

          {/* GIF button */}
          {!inputText.trim() && (
            <TouchableOpacity
              onPress={() => setShowGifPicker(prev => !prev)}
              style={{ paddingHorizontal: 4, paddingVertical: 8 }}
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
                onPress={handleSend}
                onLongPress={() => { if (!sending && inputText.trim()) setShowScheduleMenu(true); }}
                delayLongPress={400}
                disabled={sending}
                style={[styles.sendBtn, { backgroundColor: colors.primary }]}
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
                try { const mailWs = require('../services/websocket').default; if (mailWs.isConnected) mailWs._send({ type: 'typing', conversation_id: conversationId, recording: true }); } catch {}
              }}
              style={[styles.sendBtn, { backgroundColor: colors.primary }]}
            >
              <IconMic size={20} color="#fff" />
            </TouchableOpacity>
          )}
          {inputFocused && (
            <Text style={{ fontSize: 10, color: colors.textTertiary, marginTop: 2, marginLeft: 42 }}>
              *bold*  _italic_  ~strikethrough~  `code`
            </Text>
          )}
        </View>
        </View>
      )}

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
          onCreated={(msg) => { setMessages(prev => [...prev, msg]); setShowPollCreator(false); setTimeout(() => flatListRef.current?.scrollToEnd({ animated: true }), 200); }}
        />
      </Modal>

      {/* Message Action Modal */}
      <Modal
        visible={!!selectedMsg}
        transparent
        animationType="fade"
        onRequestClose={() => setSelectedMsg(null)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setSelectedMsg(null)}
        >
          <View style={[styles.actionSheet, { backgroundColor: colors.surface }, Shadow.lg]}>
            <View style={styles.quickReactions}>
              {QUICK_REACTIONS.map(r => (
                <TouchableOpacity
                  key={r.key}
                  onPress={() => { handleReact(selectedMsg?.id, r.key); setSelectedMsg(null); }}
                  style={styles.quickReactionBtn}
                >
                  <r.Icon size={28} color={colors.text} />
                </TouchableOpacity>
              ))}
            </View>

            <View style={[styles.actionDivider, { backgroundColor: colors.border }]} />

            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => handleReply(selectedMsg)}
            >
              <IconReply size={18} color={colors.text} />
              <Text style={[styles.actionText, { color: colors.text }]}>{t('chatConv.reply')}</Text>
            </TouchableOpacity>

            {!selectedMsg?.deleted_at && (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => handleForward(selectedMsg)}
              >
                <IconForward size={18} color={colors.text} />
                <Text style={[styles.actionText, { color: colors.text }]}>{t('chatConv.forward')}</Text>
              </TouchableOpacity>
            )}

            {!selectedMsg?.deleted_at && (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => handleStarMessage(selectedMsg)}
              >
                {selectedMsg?.starred
                  ? <IconStarFilled size={18} color="#f59e0b" />
                  : <IconStar size={18} color={colors.text} />}
                <Text style={[styles.actionText, { color: colors.text }]}>{selectedMsg?.starred ? t('chat.unstar') : t('chat.star')}</Text>
              </TouchableOpacity>
            )}

            {selectedMsg?.sender_email === currentEmail && !selectedMsg?.deleted_at && selectedMsg?.type === 'text' && (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => handleEdit(selectedMsg)}
              >
                <IconEdit size={18} color={colors.text} />
                <Text style={[styles.actionText, { color: colors.text }]}>{t('chatConv.edit')}</Text>
              </TouchableOpacity>
            )}

            {selectedMsg?.sender_email === currentEmail && !selectedMsg?.deleted_at && (
              <TouchableOpacity
                style={styles.actionItem}
                onPress={() => handleDelete(selectedMsg?.id)}
              >
                <IconTrash size={18} color={colors.error} />
                <Text style={[styles.actionText, { color: colors.error }]}>{t('chatConv.delete')}</Text>
              </TouchableOpacity>
            )}

            <TouchableOpacity
              style={styles.actionItem}
              onPress={() => setSelectedMsg(null)}
            >
              <IconX size={18} color={colors.textSecondary} />
              <Text style={[styles.actionText, { color: colors.textSecondary }]}>{t('common.cancel')}</Text>
            </TouchableOpacity>
          </View>
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
        onSend={(caption, viewOnce) => {
          setMediaPreview({ visible: false, uri: null, type: 'image', file: null });
          if (mediaPreview.file) {
            uploadAndSendFile(mediaPreview.file, viewOnce);
          }
        }}
        mediaUri={mediaPreview.uri}
        mediaType={mediaPreview.type}
        colors={colors}
      />

      {/* Profile photo viewer */}
      {profileViewer && (
        <Modal visible transparent animationType="fade" onRequestClose={() => setProfileViewer(null)}>
          <Pressable style={styles.profileViewerOverlay} onPress={() => setProfileViewer(null)}>
            <View style={styles.profileViewerContent}>
              {profileViewer.email ? (
                <Image
                  source={{ uri: api.getAvatarUrlForEmail(profileViewer.email) }}
                  style={styles.profileViewerImage}
                  resizeMode="cover"
                  onError={() => {}}
                />
              ) : (
                <AvatarCircle name={profileViewer.name} email={null} size={Dimensions.get('window').width * 0.7} />
              )}
              <Text style={styles.profileViewerName}>{profileViewer.name}</Text>
              {!!profileViewer.email && (
                <Text style={styles.profileViewerEmail}>{profileViewer.email}</Text>
              )}
            </View>
            <TouchableOpacity style={styles.profileViewerClose} onPress={() => setProfileViewer(null)}>
              <IconX size={24} color="#fff" />
            </TouchableOpacity>
          </Pressable>
        </Modal>
      )}

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

            {/* Leave Group Button */}
            <TouchableOpacity
              onPress={handleLeaveGroup}
              style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: Spacing.md, marginTop: Spacing.lg, gap: 10 }}
            >
              <IconX size={20} color="#dc2626" />
              <Text style={{ fontSize: FontSize.md, color: '#dc2626', fontWeight: '600' }}>
                {t('chatConv.leaveGroup') || 'Sair do grupo'}
              </Text>
            </TouchableOpacity>
          </ScrollView>
        </View>
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

      {/* Full-screen Calling Overlay (WhatsApp style) */}
      {callingOverlay && (
        <Modal visible transparent animationType="none" onRequestClose={handleCancelCall}>
          <Animated.View style={[styles.callingFullScreen, { opacity: callingFade }]}>
            <View style={[styles.callingBg, { backgroundColor: callingOverlay.video ? '#064e3b' : '#1e1b4b' }]} />
            <View style={styles.callingBgOverlay} />

            {/* Top - call type */}
            <View style={styles.callingTop}>
              <Text style={styles.callingTypeText}>
                {callingOverlay.video ? (t('call.videoCall') || 'Chamada de video') : (t('call.audioCall') || 'Chamada de voz')}
              </Text>
            </View>

            {/* Center - avatar with rings */}
            <View style={styles.callingCenter}>
              <View style={styles.callingAvatarArea}>
                {[callingRing1, callingRing2, callingRing3].map((anim, i) => (
                  <Animated.View key={i} style={{
                    position: 'absolute',
                    width: 140, height: 140, borderRadius: 70,
                    borderWidth: 2,
                    borderColor: callingOverlay.video ? 'rgba(34,197,94,0.5)' : 'rgba(129,140,248,0.5)',
                    opacity: anim.interpolate({ inputRange: [0, 1], outputRange: [0.6, 0] }),
                    transform: [{ scale: anim.interpolate({ inputRange: [0, 1], outputRange: [1, 2.2] }) }],
                  }} />
                ))}
                <AvatarCircle
                  name={callingOverlay.name}
                  email={conversationType === 'direct' ? (members.find(m => m.email !== currentEmail)?.email) : null}
                  size={110}
                />
              </View>
              <Text style={styles.callingName}>{callingOverlay.name}</Text>
              <Text style={styles.callingStatus}>
                {callingOverlay.status === 'accepted' ? (t('call.connecting') || 'Conectando...')
                  : callingOverlay.status === 'declined' ? (t('call.declined') || 'Chamada recusada')
                  : callingOverlay.status === 'no_answer' ? (t('call.noAnswer') || 'Sem resposta')
                  : (t('call.ringing') || 'Chamando...')}
              </Text>
            </View>

            {/* Bottom - cancel button */}
            <View style={styles.callingBottom}>
              <TouchableOpacity onPress={handleCancelCall} style={styles.callingEndBtn} activeOpacity={0.7}>
                <IconPhoneOff size={28} color="#fff" />
              </TouchableOpacity>
              <Text style={styles.callingEndLabel}>{t('call.cancel') || 'Cancelar'}</Text>
            </View>
          </Animated.View>
        </Modal>
      )}

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
          {starredLoading ? (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}><ActivityIndicator size="large" color={colors.primary} /></View>
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
    paddingHorizontal: Spacing.xs, paddingBottom: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerBtn: { width: 36, height: 44, alignItems: 'center', justifyContent: 'center' },
  headerInfo: { flex: 1, marginHorizontal: 6 },
  headerTitle: { fontSize: FontSize.md, fontWeight: '700' },
  headerSubtitle: { fontSize: 11, marginTop: 1 },
  loaderWrap: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  messageList: { paddingHorizontal: Spacing.sm, paddingTop: Spacing.xs },
  dateSeparator: {
    alignItems: 'center',
    marginVertical: Spacing.md,
  },
  dateLine: { flex: 1, height: 0 },
  dateText: {
    fontSize: 11, fontWeight: '600',
    paddingHorizontal: 12, paddingVertical: 4,
    borderRadius: 8, overflow: 'hidden',
  },
  systemMsg: { alignItems: 'center', marginVertical: Spacing.xs, paddingHorizontal: Spacing.lg },
  systemText: { fontSize: 12, textAlign: 'center', fontStyle: 'italic' },
  scrollDownFab: {
    position: 'absolute', right: 16, bottom: 80,
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 1,
    shadowColor: '#000', shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.15, shadowRadius: 4, elevation: 4,
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
  msgRow: { maxWidth: '82%' },
  msgRowOwn: { alignSelf: 'flex-end' },
  msgRowOther: { alignSelf: 'flex-start' },
  msgSenderRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 2, marginLeft: 4 },
  msgSender: { fontSize: 12, fontWeight: '700' },
  replyIndicator: {
    borderLeftWidth: 3, borderRadius: BorderRadius.sm,
    paddingHorizontal: 10, paddingVertical: 5,
    marginBottom: 4,
  },
  replyName: { fontSize: 12, fontWeight: '700' },
  replyText: { fontSize: 12 },
  bubble: {
    borderRadius: 18, paddingHorizontal: 12,
    paddingTop: 8, paddingBottom: 5,
  },
  bubbleOwn: { },
  bubbleOther: { borderWidth: 0 },
  bubbleDeleted: { opacity: 0.5 },
  msgText: { fontSize: 15, lineHeight: 21 },
  deletedText: { fontSize: 14, fontStyle: 'italic' },
  msgMeta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 3, marginTop: 2 },
  editedLabel: { fontSize: 10 },
  msgTime: { fontSize: 10, fontWeight: '400' },
  chatImage: { width: 240, height: 200, borderRadius: 12, marginBottom: 2 },
  videoThumb: { paddingVertical: 2 },
  videoPreviewWrap: { position: 'relative', width: 240, height: 140, borderRadius: 12, overflow: 'hidden', marginBottom: 4 },
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
    width: 240, height: 140, borderRadius: 12,
    backgroundColor: 'rgba(0,0,0,0.25)', alignItems: 'center', justifyContent: 'center',
    marginBottom: 4,
  },
  videoPlayBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center' },
  fileAttach: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, minWidth: 180 },
  reactionsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4 },
  reactionsRowOwn: { justifyContent: 'flex-end' },
  reactionChip: {
    flexDirection: 'row', alignItems: 'center', gap: 3,
    paddingHorizontal: 8, paddingVertical: 3,
    borderRadius: 12, borderWidth: 1,
  },
  reactionEmoji: { fontSize: 14 },
  reactionCount: { fontSize: 11, fontWeight: '600' },
  loadMoreBtn: {
    alignSelf: 'center', paddingVertical: Spacing.sm, paddingHorizontal: Spacing.lg,
    borderRadius: 20, borderWidth: 1, marginBottom: Spacing.sm,
  },
  loadMoreText: { fontSize: FontSize.sm, fontWeight: '500' },
  emptyMessages: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingTop: 100 },
  emptyText: { fontSize: FontSize.md },
  replyBar: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: Spacing.md, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  replyBarLine: { width: 3, height: '100%', borderRadius: 2, marginRight: Spacing.sm },
  replyBarContent: { flex: 1 },
  replyBarLabel: { fontSize: 12, fontWeight: '700' },
  replyBarText: { fontSize: 13 },
  replyBarClose: { padding: 8 },
  uploadBar: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    paddingHorizontal: Spacing.md, paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  uploadText: { fontSize: FontSize.sm },
  inputBar: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 6, paddingTop: 6,
    gap: 6,
  },
  input: {
    flex: 1, minHeight: 42, maxHeight: 120,
    borderRadius: 22, paddingHorizontal: 16,
    paddingVertical: Platform.OS === 'ios' ? 10 : 8,
    fontSize: 16, borderWidth: 0,
  },
  attachBtn: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
  },
  sendBtn: {
    width: 42, height: 42, borderRadius: 21,
    alignItems: 'center', justifyContent: 'center',
  },
  modalOverlay: {
    flex: 1, justifyContent: 'center', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  actionSheet: {
    borderRadius: 20, padding: Spacing.md,
    minWidth: 280, maxWidth: 340,
  },
  quickReactions: {
    flexDirection: 'row', justifyContent: 'center', gap: Spacing.md,
    paddingVertical: Spacing.sm,
  },
  quickReactionBtn: { padding: 6 },
  actionDivider: { height: StyleSheet.hairlineWidth, marginVertical: Spacing.sm },
  actionItem: {
    flexDirection: 'row', alignItems: 'center', gap: Spacing.md,
    paddingVertical: Spacing.md, paddingHorizontal: Spacing.sm,
  },
  actionText: { fontSize: FontSize.md, fontWeight: '500' },
  forwardModal: {
    flex: 1, marginTop: 80, borderTopLeftRadius: BorderRadius.xl, borderTopRightRadius: BorderRadius.xl,
    ...Shadow.lg,
  },
  forwardHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    padding: Spacing.md, borderBottomWidth: StyleSheet.hairlineWidth,
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
  callingFullScreen: {
    flex: 1, position: 'relative',
  },
  callingBg: {
    ...StyleSheet.absoluteFillObject,
  },
  callingBgOverlay: {
    ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.3)',
  },
  callingTop: {
    paddingTop: 60, alignItems: 'center',
  },
  callingTypeText: {
    color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: '500', letterSpacing: 0.5,
  },
  callingCenter: {
    flex: 1, justifyContent: 'center', alignItems: 'center', paddingBottom: 40,
  },
  callingAvatarArea: {
    width: 160, height: 160, alignItems: 'center', justifyContent: 'center', marginBottom: 24,
  },
  callingName: {
    color: '#fff', fontSize: 30, fontWeight: '700', marginBottom: 8, textAlign: 'center',
  },
  callingStatus: {
    color: 'rgba(255,255,255,0.5)', fontSize: 16,
  },
  callingBottom: {
    paddingBottom: 60, alignItems: 'center',
  },
  callingEndBtn: {
    width: 70, height: 70, borderRadius: 35, backgroundColor: '#ef4444',
    alignItems: 'center', justifyContent: 'center', marginBottom: 10,
  },
  callingEndLabel: {
    color: 'rgba(255,255,255,0.7)', fontSize: 13, fontWeight: '600',
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
