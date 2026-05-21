import { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, ScrollView, Platform,
  Modal, TextInput, Image, Animated, Dimensions, KeyboardAvoidingView,
  ActivityIndicator, PanResponder, Pressable, Alert, StatusBar,
  Linking, RefreshControl, FlatList,
} from 'react-native';
import CachedImage from './CachedImage';
import AvatarCircle from './AvatarCircle';
import StatusCamera from './StatusCamera';
import BrandFab from './BrandFab';
import { IconPlus, IconCamera, IconEdit, IconX, IconSearch, IconTrash, IconEye, IconChevronLeft, IconChevronRight, IconSend, IconPause, IconPlay, IconForward, IconSmile, IconType, IconBrush, IconUndo2, IconRotateCw, IconBookmark, IconBarChart, IconHelpCircle, IconClock, IconAtSign, IconAward, IconMapPin, IconLink, IconArrowRight, IconArchive, IconSliders, IconFeedShare, IconCheck, IconCheckbox, IconCheckboxChecked } from './Icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as api from '../services/api';
import * as Haptics from 'expo-haptics';
import { cacheMedia } from '../services/mediaCache';
import StoryRingAvatar from './status/StoryRingAvatar';
// Shared status fetch+cache+WS+poll source. Took over the inline
// loadStatuses + MMKV preload + fingerprint diff that used to live below;
// the local mine/others state stays as a mirror so the optimistic mutation
// paths (mark-viewed, delete) keep working unchanged.
import useStatuses, { isAllowedGifUrl } from '../hooks/useStatuses';
// GifPickerPanel mounts inline inside the sticker picker when the user taps
// the GIF tile. It already does Tenor search + mediaCache prefetching; we
// just hand it an onSelect that creates a new sticker with type='gif'.
import GifPickerPanel from './GifPicker';
import { BASE_URL, chatCreate, chatSend, chatConversations, statusViewers, emailToDisplayName, searchDeezerMusic } from '../services/api';
// (cache helpers moved into useStatuses hook)
// Lazy import to avoid circular dependency / initialization errors on web
let mailWs = null;
try { mailWs = require('../services/websocket').default; } catch {}
import Svg, { Circle as SvgCircle, Path, Rect, Defs, LinearGradient, Stop } from 'react-native-svg';
import AnimatedStatusText from './status/AnimatedStatusText';
import ReactionSwipeUp from './status/ReactionSwipeUp';

// Android status bar safe area — `StatusBar.currentHeight` is null on iOS
// (where the 54px ios padding already covers the notch) so we just hard-fall
// to 24dp baseline if the runtime didn't report it. Used by the Status
// composer header which was rendering UNDER the system bar on Android (clock
// + nav icons overlapping the X close button). Moved BELOW all imports
// 2026-05-14 because Metro's minifier hoisting created a TDZ on web
// (`ReferenceError: Cannot access 'Jr' before initialization`) when this
// const sat between import statements.
const ANDROID_TOP_INSET = (Platform.OS === 'android' ? (StatusBar.currentHeight || 24) : 0);

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

// Native video player for status viewer. Mirrors the WORKING pattern from
// components/ChatListTab.js StatusModalVideo (~line 1556). Two rules of thumb:
//
//   1) The HOOK (useVideoPlayer) MUST live inside the rendered inline component,
//      not inside try/catch — wrapping a hook in try/catch is a React anti-pattern
//      that can leave the dispatcher in a bad state when the catch ever fires
//      (e.g. transient module load) and turns subsequent re-renders into "tela
//      preta". Do the require()/import outside the hook; only the hook call sits
//      inline in the rendered component body.
//
//   2) Fall back to expo-av's <Video> if expo-video fails to load — keeps native
//      playback working on older bundles where expo-video isn't shipped.
function StatusVideoPlayer({ url, posterUrl, onDuration, onLoaded, onError }) {
  if (Platform.OS === 'web' || !url) return null;
  // Try expo-video first (SDK 55+).
  try {
    const { useVideoPlayer, VideoView } = require('expo-video');
    const Inner = ({ uri }) => {
      const player = useVideoPlayer(uri, (p) => {
        try { p.loop = true; p.muted = false; p.play(); } catch {}
      });
      // Report duration as soon as the player reaches readyToPlay so the
      // progress bar can match the real video length instead of the
      // hardcoded 5s default. Fires once per uri.
      useEffect(() => {
        if (!player) return;
        let reported = false;
        const sub = player.addListener?.('statusChange', ({ status }) => {
          if (status === 'readyToPlay' && !reported) {
            reported = true;
            try {
              const d = Math.max(0, Number(player.duration) || 0);
              if (d > 0 && typeof onDuration === 'function') onDuration(d * 1000);
              if (typeof onLoaded === 'function') onLoaded();
            } catch {}
          }
          if (status === 'error' && typeof onError === 'function') onError();
        });
        return () => { try { sub?.remove?.(); } catch {} };
      }, [player]);

      // Register the player with the global media manager so an incoming
      // call (call_invite WS event → stopAllAudio()) immediately pauses
      // the status story instead of letting it duel the ringtone.
      useEffect(() => {
        if (!player) return;
        let unregister = () => {};
        try {
          const { registerMediaPlayer } = require('../services/audioManager');
          unregister = registerMediaPlayer(() => {
            try { player.pause?.(); } catch {}
          });
        } catch {}
        return () => { try { unregister(); } catch {} };
      }, [player]);
      return (
        <View style={{ flex: 1, backgroundColor: '#000' }}>
          {/* Poster painted under the player. expo-video doesn't expose a
              poster prop, so we layer a static image behind the VideoView
              and let the video draw on top once it has the first frame.
              Eliminates the black-screen-while-buffering window. */}
          {posterUrl ? (
            <Image
              source={{ uri: posterUrl }}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
              resizeMode="contain"
            />
          ) : null}
          <VideoView player={player} style={{ flex: 1, backgroundColor: 'transparent' }} contentFit="contain" nativeControls={false} />
        </View>
      );
    };
    return <Inner uri={url} />;
  } catch {}
  // Fallback: expo-av (older binaries).
  try {
    const { Video } = require('expo-av');
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {posterUrl ? (
          <Image
            source={{ uri: posterUrl }}
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
            resizeMode="contain"
          />
        ) : null}
        <Video
          source={{ uri: url }}
          style={{ flex: 1, backgroundColor: 'transparent' }}
          resizeMode="contain"
          shouldPlay
          isLooping
          useNativeControls={false}
          onLoad={(s) => {
            try {
              const ms = Number(s?.durationMillis) || 0;
              if (ms > 0 && typeof onDuration === 'function') onDuration(ms);
              if (typeof onLoaded === 'function') onLoaded();
            } catch {}
          }}
          onError={() => { try { onError?.(); } catch {} }}
        />
      </View>
    );
  } catch (e) {
    console.warn('[StatusVideoPlayer] no video module', e?.message);
    if (typeof onError === 'function') onError();
    return null;
  }
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
  let str = String(dateStr).trim();
  if (!str) return '';
  // Fix PostgreSQL format: "2026-03-22 16:05:53.149596+00" -> ISO 8601
  if (!str.includes('T')) str = str.replace(' ', 'T');
  // Fix "+00" -> "+00:00" for Safari compatibility (do BEFORE the Z check
  // so we don't accidentally append Z to a string that has a bare "+00")
  if (str.match(/[+-]\d{2}$/)) str += ':00';
  if (!str.endsWith('Z') && !/[+-]\d{2}:\d{2}$/.test(str)) str += 'Z';
  const now = Date.now();
  const then = new Date(str).getTime();
  if (!Number.isFinite(then)) return '';
  // Guard against any NaN fallthrough — empty string instead of "NaNh"
  if (isNaN(then) || then <= 0) return '';
  const diffMs = Math.max(0, now - then);
  const mins = Math.floor(diffMs / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 1) return t?.('time.now') || 'now';
  if (mins < 60) return (t?.('time.min') || '{n} min').replace('{n}', mins);
  const hrs = Math.floor(mins / 60);
  if (!Number.isFinite(hrs)) return '';
  if (hrs < 24) return (t?.('time.hours') || '{n}h').replace('{n}', hrs);
  const days = Math.floor(hrs / 24);
  return `${days}d`;
}

const TEXT_BG_COLORS = [
  '#6D28D9', '#6D28D9', '#7C3AED', '#1A73E8', '#6B5CE7',
  '#E84393', '#D63031', '#E17055', '#FDCB6E', '#00B894',
];

// Text-status gradient presets — Instagram-style 6 multi-stop fills the
// composer offers alongside solid colors. `id` is the serialization key
// (persisted in bg_color as `gradient:<id>`) so the StoryViewer can
// reconstruct the same SVG <LinearGradient> from a published row. Order
// inside `colors` is top-left → bottom-right (SVG x1/y1=0, x2/y2=1).
// Note: expo-linear-gradient isn't in the dep tree on SDK 55, so we
// render via react-native-svg's <LinearGradient> (already imported above).
const TEXT_BG_GRADIENTS = [
  { id: 'purple_pink', colors: ['#8B5CF6', '#EC4899'] },
  { id: 'blue_cyan',   colors: ['#2563EB', '#06B6D4'] },
  { id: 'orange_red',  colors: ['#F97316', '#EF4444'] },
  { id: 'green_teal',  colors: ['#10B981', '#14B8A6'] },
  { id: 'sunset',      colors: ['#FACC15', '#F97316', '#EF4444'] },
  { id: 'aurora',      colors: ['#06B6D4', '#8B5CF6', '#EC4899'] },
];

// Resolve a published `bg_color` (string solid OR `gradient:<id>` token)
// back to a gradient descriptor. Returns null for plain hex colors so the
// caller can fall through to backgroundColor.
function resolveGradient(bgColor) {
  if (!bgColor || typeof bgColor !== 'string') return null;
  if (!bgColor.startsWith('gradient:')) return null;
  const id = bgColor.slice('gradient:'.length);
  return TEXT_BG_GRADIENTS.find(g => g.id === id) || null;
}

// Circular 40x40 glass button used in the photo-status editor top-right
// toolbar. Defined once so each tool shares the same hit target, backdrop
// blur, and subtle shadow — keeps the row visually coherent.
const editorToolBtnStyle = {
  width: 40, height: 40, borderRadius: 20,
  backgroundColor: 'rgba(0,0,0,0.55)',
  alignItems: 'center', justifyContent: 'center',
  ...(Platform.OS === 'web'
    ? { backdropFilter: 'blur(10px)', boxShadow: '0 2px 6px rgba(0,0,0,0.25)' }
    : { shadowColor: '#000', shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.25, shadowRadius: 4 }),
};

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

// Basic URL validator for the link sticker. Accepts:
//   - full http/https URLs (with or without subdomain)
//   - bare domains like "chatyy.com.br" (we prepend https:// when used)
// Rejects junk like "abc", whitespace-only, or strings with no domain.
// We deliberately stay lax-but-sane: server-side and Linking.openURL will
// reject malformed targets, this just keeps the picker UX from accepting
// obviously-wrong input.
function isValidStickerUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return false;
  if (/\s/.test(s)) return false;
  // Allow scheme + host or bare host with TLD.
  return /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}([\/?#].*)?$/i.test(s);
}

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
    // Slider sticker — Instagram-style "emoji slider". Composer paints a
    // static preview at 50% with the chosen emoji riding on the track. The
    // live drag interaction happens inside StoryViewer (viewer-only), so
    // here we just sketch the look.
    if (sticker.type === 'slider') {
      const emoji = sticker.emoji || '🔥';
      const pct = Math.max(0, Math.min(100, Number(sticker.preview) || 50));
      return (
        <View style={{
          backgroundColor: 'rgba(15,23,42,0.92)', borderRadius: 18,
          paddingTop: 14, paddingBottom: 18, paddingHorizontal: 16, width: 240,
        }}>
          <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', textAlign: 'center', marginBottom: 12 }}>
            {sticker.question || 'Qual o seu nível?'}
          </Text>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.18)', position: 'relative' }}>
            <View style={{
              position: 'absolute', left: 0, top: 0, bottom: 0,
              width: `${pct}%`,
              borderRadius: 4,
              backgroundColor: '#F59E0B',
            }} />
            <Text style={{
              position: 'absolute', top: -14,
              left: `${pct}%`,
              transform: [{ translateX: -16 }],
              fontSize: 30,
            }}>{emoji}</Text>
          </View>
        </View>
      );
    }
    // GIF sticker — composer preview. Renders as an animated WebP/GIF via
    // expo-image on native (which supports animated formats) or <img> on web.
    // Width/height come from the GIF metadata so the dragged frame is sized
    // proportionally — capped at 200x200 in the composer so a tall GIF
    // doesn't dominate the canvas (the viewer rendering uses the stored
    // dimensions, this is just composer sizing).
    if (sticker.type === 'gif' && sticker.url) {
      const maxDim = 200;
      const w = Math.max(1, Number(sticker.width) || 200);
      const h = Math.max(1, Number(sticker.height) || 200);
      const ratio = w / h;
      const renderW = ratio >= 1 ? Math.min(maxDim, w) : Math.min(maxDim, w * (maxDim / h));
      const renderH = ratio >= 1 ? Math.min(maxDim, h * (maxDim / w)) : Math.min(maxDim, h);
      if (Platform.OS === 'web') {
        return (
          <img
            src={sticker.url}
            alt=""
            style={{ width: renderW, height: renderH, borderRadius: 8, objectFit: 'cover' }}
          />
        );
      }
      // Native: prefer expo-image (animated webp/gif support) → fallback Image.
      try {
        const { Image: ExpoImage } = require('expo-image');
        return (
          <ExpoImage
            source={{ uri: sticker.url }}
            style={{ width: renderW, height: renderH, borderRadius: 8 }}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        );
      } catch {
        return (
          <Image
            source={{ uri: sticker.url }}
            style={{ width: renderW, height: renderH, borderRadius: 8 }}
            resizeMode="cover"
          />
        );
      }
    }
    // Link sticker — composer preview. Mirrors the in-viewer pill so the
    // creator sees roughly what viewers will see (white pill, purple CTA
    // arrow). Drag it like any other sticker; the live tappable surface
    // lives in StoryViewer, this is just the static composer rendering.
    if (sticker.type === 'link') return (
      <View style={{
        flexDirection: 'row', alignItems: 'center', gap: 8,
        backgroundColor: 'rgba(255,255,255,0.95)',
        borderRadius: 22, paddingHorizontal: 14, paddingVertical: 8,
        shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
      }}>
        <Text style={{ color: '#111', fontSize: 13, fontWeight: '700' }} numberOfLines={1}>
          {sticker.label || 'Saiba mais'}
        </Text>
        <View style={{
          width: 22, height: 22, borderRadius: 11, backgroundColor: '#7C3AED',
          alignItems: 'center', justifyContent: 'center',
        }}>
          <IconArrowRight size={13} color="#fff" />
        </View>
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

// ─── Animated long-press peek ───
//
// Shown while the user is HOLDING on a status circle. Renders a mini story
// player that auto-advances through the user's items at 1.5× speed
// (~3.3s per item vs the in-viewer 5s). Includes the same segmented
// progress bar row Instagram shows so the user can see the carousel length
// without committing to the full viewer.
//
// Implementation notes:
//   - Single Animated.Value driving the active segment width — no per-frame
//     setState. The "advance to next item" step is the only setState the
//     component does, and only once per ~3.3s tick.
//   - Native driver is OFF for the width interpolation (RN can't drive %
//     widths natively), but the animation still runs off the JS thread's
//     setInterval — we use Animated.timing which is paint-frame driven.
//   - Stops at the last item and freezes the frame (no auto-close); user
//     releases finger → Pressable parent dismisses the peek modal.
//   - Releases its timer + Animated cleanly on unmount so a quick tap-and-
//     release doesn't leave an orphan animation incrementing in the bg.
const PEEK_DURATION_MS = Math.round(5000 / 1.5); // 5s @ normal → 3.33s @ 1.5×
function AnimatedPeekPreview({ group, ownerName, t }) {
  const items = group?.items || [];
  const [activeIdx, setActiveIdx] = useState(0);
  const progress = useRef(new Animated.Value(0)).current;
  const animRef = useRef(null);

  useEffect(() => {
    if (!items.length) return undefined;
    let cancelled = false;
    progress.setValue(0);
    animRef.current?.stop?.();
    animRef.current = Animated.timing(progress, {
      toValue: 1,
      duration: PEEK_DURATION_MS,
      useNativeDriver: false,
    });
    animRef.current.start(({ finished }) => {
      if (cancelled) return;
      if (finished) {
        // Auto-advance — but freeze on the last item so the peek doesn't
        // loop forever. Releasing dismisses the modal.
        setActiveIdx(prev => Math.min(prev + 1, items.length - 1));
      }
    });
    return () => {
      cancelled = true;
      animRef.current?.stop?.();
    };
  }, [activeIdx, items.length, progress]);

  if (!items.length) return null;
  const cur = items[activeIdx] || items[items.length - 1];
  const url = ((cur?.media_url || cur?.content || '').split('\n')[0] || '');
  const fullUrl = url.startsWith('/') ? BASE_URL + url : url;
  const posterRaw = cur?.thumbnail_url;
  const posterUrl = posterRaw ? (posterRaw.startsWith('/') ? BASE_URL + posterRaw : posterRaw) : '';

  return (
    <View style={{ flex: 1 }}>
      {/* Media */}
      {cur?.type === 'video' && url ? (
        // Use the server poster as the visual — keeps the peek lightweight
        // (no real video decoder spin-up just for a hold preview).
        posterUrl ? (
          <View style={{ flex: 1 }}>
            <CachedImage source={{ uri: posterUrl }} style={{ flex: 1 }} resizeMode="cover" />
            <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ color: '#fff', fontSize: 20 }}>▶</Text>
              </View>
            </View>
          </View>
        ) : (
          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontSize: 14 }}>▶ {ownerName}</Text>
          </View>
        )
      ) : url ? (
        <CachedImage source={{ uri: fullUrl }} style={{ flex: 1 }} resizeMode="cover" />
      ) : (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 16, backgroundColor: cur?.background || cur?.bg_color || '#1a1a1a' }}>
          <Text style={{ color: '#fff', fontSize: 18, textAlign: 'center', fontWeight: '600' }}>{cur?.content || ''}</Text>
        </View>
      )}

      {/* Segmented progress bars — Instagram parity. The active segment
          width interpolates from 0 → 100% over PEEK_DURATION_MS. Past
          segments stay solid white, future segments stay dim. */}
      <View style={{
        position: 'absolute', top: 8, left: 8, right: 8,
        flexDirection: 'row', gap: 3,
      }}>
        {items.map((_, i) => (
          <View key={i} style={{
            flex: 1, height: 2.5, borderRadius: 1.5,
            backgroundColor: 'rgba(255,255,255,0.28)', overflow: 'hidden',
          }}>
            {i < activeIdx ? (
              <View style={{ width: '100%', height: '100%', backgroundColor: '#fff' }} />
            ) : i === activeIdx ? (
              <Animated.View style={{
                height: '100%',
                width: progress.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                backgroundColor: '#fff',
              }} />
            ) : null}
          </View>
        ))}
      </View>

      {/* Footer — owner + relative time */}
      <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, padding: 12, backgroundColor: 'rgba(0,0,0,0.5)' }}>
        <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600' }} numberOfLines={1}>
          {ownerName}
        </Text>
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11 }}>
          {(() => {
            try {
              const ts = cur?.timestamp || cur?.created_at;
              if (!ts) return '';
              let iso = String(ts).replace(' ', 'T').replace(/([+-]\d{2})$/, '$1:00');
              const ms = new Date(iso).getTime();
              if (!Number.isFinite(ms)) return '';
              const h = Math.round((Date.now() - ms) / 3600000);
              if (h < 1) return t?.('time.now') || 'Agora';
              if (h < 24) return `${h}h`;
              return `${Math.floor(h / 24)}d`;
            } catch { return ''; }
          })()}
        </Text>
      </View>
    </View>
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
function SegmentedRing({ items, size, viewed, closeFriends = false }) {
  const count = items?.length || 1;
  const ringSize = size + 10;
  const radius = (ringSize / 2) - 3;
  const circumference = 2 * Math.PI * radius;
  const gapDeg = count > 1 ? 6 : 0;
  const totalGapDeg = gapDeg * count;
  const segmentDeg = (360 - totalGapDeg) / count;
  const segmentLen = (segmentDeg / 360) * circumference;
  const gapLen = (gapDeg / 360) * circumference;
  // Close-friends ring: bright IG-style green gradient. Default is the
  // brand purple. ID is parameterized so multiple rings on the same
  // screen with different palettes don't collide on the Defs registry.
  const gradId = closeFriends ? 'ringGradCF' : 'ringGrad';

  return (
    <View style={{ position: 'absolute', top: -5, left: -5 }}>
      <Svg width={ringSize} height={ringSize}>
        <Defs>
          <LinearGradient id={gradId} x1="0" y1="0" x2="1" y2="1">
            <Stop offset="0" stopColor={closeFriends ? '#34D399' : '#7C3AED'} />
            <Stop offset="0.5" stopColor={closeFriends ? '#10B981' : '#6D28D9'} />
            <Stop offset="1" stopColor={closeFriends ? '#047857' : '#6D28D9'} />
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
              stroke={isViewed ? 'rgba(150,150,150,0.35)' : `url(#${gradId})`}
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
          <StoryRingAvatar
            name={currentName}
            email={currentEmail}
            size={62}
            ringStyle={hasMyStatus ? 'segmented' : 'none'}
            segments={hasMyStatus ? myStatuses.length : 1}
            itemsViewed={hasMyStatus ? myStatuses.map(it => !!it.viewed) : null}
            badge={!hasMyStatus ? 'plus' : null}
            // Mirror the close-friends green ring on the owner's own row
            // so it's a consistent visual signal. We're the author, so we
            // always pass the privacy through.
            closeFriends={
              hasMyStatus && myStatuses.some(
                (it) => (it?.meta?.privacy || it?.privacy) === 'close_friends'
              )
            }
            isDark={isDark}
            colors={colors}
          />
        </View>
        <Text style={[styles.storyName, { color: colors.text }]} numberOfLines={1}>
          {t?.('status.myStatus') || 'My status'}
        </Text>
      </TouchableOpacity>

      {/* Contact statuses */}
      {statuses.map((group) => {
        const allViewed = group.items.every((item) => item.viewed);
        // Close-friends ring (IG parity): if ANY item in the group carries
        // meta.privacy === 'close_friends', paint the whole row's ring
        // green so the restricted audience scope is visible at a glance.
        // Backend only surfaces close-friends statuses to the owner +
        // people on the close-friends list, so by the time we see one
        // here we KNOW we're an authorized viewer — the green ring is
        // safe to surface.
        const isCloseFriends = group.items.some(
          (it) => (it?.meta?.privacy || it?.privacy) === 'close_friends'
        );
        return (
          <TouchableOpacity
            key={group.ownerEmail}
            style={styles.storyItem}
            onPress={() => onOpenViewer(group)}
            activeOpacity={0.7}
          >
            <View style={styles.storyAvatarWrap}>
              <StoryRingAvatar
                name={group.ownerName}
                email={group.ownerEmail}
                size={62}
                ringStyle="segmented"
                segments={group.items.length}
                itemsViewed={group.items.map(it => !!it.viewed)}
                allViewed={allViewed}
                closeFriends={isCloseFriends}
                isDark={isDark}
                colors={colors}
              />
              {/* Music note badge — Instagram parity. Show when ANY item in
                  the carousel has a music overlay so the viewer knows there
                  is audio before tapping. Kept inline (not part of
                  StoryRingAvatar) because it's specific to this surface. */}
              {group.items?.some(it => it.music_title) ? (
                <View style={styles.storyMusicBadge}>
                  <IconMusicNote size={10} color="#fff" />
                </View>
              ) : null}
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


// (MMKV preload + fingerprint diff lived here as inline helpers; both
// migrated into hooks/useStatuses.js. The local mine/others state below
// gets seeded by the hook's mirror useEffect.)

export default function ChatStatusTab({ colors, isDark, t, user, router, autoNewStatus }) {
  // Real safe-area insets — `StatusBar.currentHeight` (the const fallback used
  // before) returned 0 on a few Pixel/Galaxy devices when the composer Modal
  // mounted before the system bar measurement settled, leaving the back/Save/
  // Music row UNDER the clock+wifi icons. useSafeAreaInsets reads the runtime
  // insets the OS actually computed for this window, so it stays correct on
  // every device including the punch-hole Pixels.
  const insets = useSafeAreaInsets();
  const [contactStatuses, setContactStatuses] = useState([]);
  const [myStatuses, setMyStatuses] = useState([]);
  // Hook reports loading state; we keep a local copy for places that still
  // read `loading` (e.g. spinner conditionals) without needing to depend on
  // the hook's full return shape.
  const [loading, setLoading] = useState(true);
  // (fingerprint diff lives inside useStatuses now)
  const [searchQuery, setSearchQuery] = useState('');
  const [showSearch, setShowSearch] = useState(false);

  // Viewer state
  const [viewerVisible, setViewerVisible] = useState(false);
  const [viewerStatuses, setViewerStatuses] = useState([]);
  const [viewerIndex, setViewerIndex] = useState(0);
  const [viewerOwnerName, setViewerOwnerName] = useState('');
  const [viewerOwnerEmail, setViewerOwnerEmail] = useState('');
  // Long-press preview state — shows the latest status as a small floating
  // card on top of the row, dismissible by tap-outside. Doesn't mark the
  // status as viewed (vs the full viewer modal).
  const [previewGroup, setPreviewGroup] = useState(null);
  const [viewerReply, setViewerReply] = useState('');
  const [isPaused, setIsPaused] = useState(false);

  // Hoisted above handleReact (~line 916) which references these in its
  // dep array. Previously declared at line 1131 — created a real TDZ on
  // web (`Cannot access 'Jr' before initialization`) because useCallback
  // evaluates deps at render time, BEFORE that later line ran.
  const currentEmail = user?.email || '';
  const currentName = user?.name || user?.email?.split('@')[0] || '';

  // closeViewer is declared later (~line 1384). Forward callbacks
  // (handleOpenForward, next/prev nav, etc.) call it via this ref to
  // avoid TDZ on web minified bundle (`Cannot access 'Ca'`).
  const closeViewerRef = useRef(null);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const timerRef = useRef(null);
  const animRef = useRef(null);
  const viewerOpacity = useRef(new Animated.Value(0)).current;

  // Viewers modal state
  const [viewersModal, setViewersModal] = useState(false);
  const [viewersList, setViewersList] = useState([]);

  // Per-status analytics modal (creator-only). Opened from the own-status
  // long-press menu under "Estatísticas". `analyticsData` carries the
  // backend payload (impressions, reactions, replies, completion/exit
  // rates) — null while loading or before first open. Errors fall back
  // to a "Não foi possível carregar" message but keep the modal open
  // so the user can tap "Tentar novamente".
  const [analyticsModalOpen, setAnalyticsModalOpen] = useState(false);
  const [analyticsLoading, setAnalyticsLoading] = useState(false);
  const [analyticsData, setAnalyticsData] = useState(null);
  const [analyticsError, setAnalyticsError] = useState(null);
  const [analyticsStatusId, setAnalyticsStatusId] = useState(null);

  // Archive browser sheet — opened from "Arquivo" pill above the strip.
  // Long-press an archived row inside the sheet to repost it as a fresh
  // 24h story (mirrors Instagram archive). Lazy-loaded on open so we
  // don't pay the round-trip until the user actually wants to browse.
  const [archiveSheetOpen, setArchiveSheetOpen] = useState(false);
  const [archiveItems, setArchiveItems] = useState([]);
  const [archiveLoading, setArchiveLoading] = useState(false);

  // Pull-to-refresh state — feeds RefreshControl on the home scroll.
  const [refreshing, setRefreshing] = useState(false);

  // Muted section expand toggle (Instagram-style: muted users collapsed
  // until tapped). Starts collapsed so the recent/viewed dominate.
  const [showMuted, setShowMuted] = useState(false);

  // Heart-pulse Animated.Value driven by WS incoming-status events. When
  // a contact publishes while the home feed is open, we trigger a brief
  // ring scale pulse on their tile so the user notices a fresh story
  // arrived without having to scroll. Map: ownerEmail → Animated.Value.
  const pulseRefs = useRef({}).current;
  const getPulseFor = useCallback((email) => {
    const key = String(email || '').toLowerCase();
    if (!pulseRefs[key]) pulseRefs[key] = new Animated.Value(1);
    return pulseRefs[key];
  }, [pulseRefs]);
  const triggerPulse = useCallback((email) => {
    const v = getPulseFor(email);
    Animated.sequence([
      Animated.timing(v, { toValue: 1.16, duration: 220, useNativeDriver: true }),
      Animated.spring(v, { toValue: 1, friction: 3, tension: 80, useNativeDriver: true }),
    ]).start();
  }, [getPulseFor]);

  // Own-status view-count badge. Sums views across all my active items so
  // we can render "123 visualizações" pill on the big tile.
  const myViewCount = (myStatuses || []).reduce((acc, s) => acc + (Number(s?.view_count) || 0), 0);

  // Caption translation cache + busy state. Keyed by status id; value is
  // either a translated string or the sentinel '__loading__' / '__none__'.
  const [translatedCaptions, setTranslatedCaptions] = useState({});
  const requestTranslate = useCallback(async (statusId) => {
    if (!statusId) return;
    const userLocale = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language : 'pt-BR';
    setTranslatedCaptions(prev => ({ ...prev, [statusId]: '__loading__' }));
    try {
      const r = await api.apiCall('status_translate_caption', {
        status_id: statusId, target_locale: userLocale,
      }, 'POST');
      if (r?.success && typeof r?.data?.translation === 'string') {
        setTranslatedCaptions(prev => ({ ...prev, [statusId]: r.data.translation }));
      } else {
        setTranslatedCaptions(prev => ({ ...prev, [statusId]: '__none__' }));
      }
    } catch {
      setTranslatedCaptions(prev => ({ ...prev, [statusId]: '__none__' }));
    }
  }, []);

  // Highlights modal state — opens when user taps "Salvar em destaques" on
  // their own status. Lets the user pick an existing highlight or create
  // a new one (name + first-status cover).
  const [highlightSheet, setHighlightSheet] = useState(null); // { statusId, coverUrl }
  const [highlights, setHighlights] = useState([]);
  const [newHighlightName, setNewHighlightName] = useState('');
  const [highlightSaving, setHighlightSaving] = useState(false);
  const openHighlightSheet = useCallback((statusItem) => {
    if (!statusItem?.id) return;
    setHighlightSheet({
      statusId: statusItem.id,
      coverUrl: statusItem.media_url || statusItem.thumbnail_url || '',
    });
    api.statusHighlightList?.()
      .then(r => { if (r?.success && Array.isArray(r.data?.highlights)) setHighlights(r.data.highlights); })
      .catch(() => {});
  }, []);
  const addToHighlight = useCallback(async (highlightId) => {
    if (!highlightSheet?.statusId || !highlightId || highlightSaving) return;
    setHighlightSaving(true);
    try { await api.statusHighlightAddStatus?.(highlightId, highlightSheet.statusId); }
    catch {} finally {
      setHighlightSaving(false);
      setHighlightSheet(null);
    }
  }, [highlightSheet, highlightSaving]);
  const createHighlight = useCallback(async () => {
    const name = newHighlightName.trim();
    if (!name || !highlightSheet?.statusId || highlightSaving) return;
    setHighlightSaving(true);
    try {
      const r = await api.statusHighlightCreate?.(name, [highlightSheet.statusId], highlightSheet.coverUrl || '');
      if (r?.success) {
        setNewHighlightName('');
        setHighlightSheet(null);
      }
    } catch {} finally { setHighlightSaving(false); }
  }, [newHighlightName, highlightSheet, highlightSaving]);
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

  // Handle emoji reaction on a status. Race-safe: snapshot the prior
  // reaction *inside* the setMyReactions updater so rapid taps don't read
  // a stale `myReactions[id]` from closure. On error, roll BOTH state
  // slices back to the snapshot — previous code left optimistic UI even
  // when the server rejected.
  const handleReact = useCallback(async (emoji) => {
    const item = viewerStatuses[viewerIndex];
    if (!item) return;
    const statusId = item.id;
    let prevMine; // captured in updater so it's the actual pre-tap value
    setMyReactions(prev => {
      prevMine = prev[statusId] ?? null;
      const next = prevMine === emoji ? null : emoji;
      return { ...prev, [statusId]: next };
    });
    setStatusReactions(prev => {
      const stripped = (prev[statusId] || []).filter(r => r.user_email !== currentEmail);
      if (prevMine !== emoji) stripped.push({ emoji, user_email: currentEmail });
      return { ...prev, [statusId]: stripped };
    });
    try {
      const r = await api.apiCall('status_react', { status_id: statusId, emoji }, 'POST');
      if (!r?.success) throw new Error(r?.message || 'react_failed');
    } catch (err) {
      // Roll back BOTH slices to the pre-tap snapshot.
      setMyReactions(prev => ({ ...prev, [statusId]: prevMine ?? null }));
      setStatusReactions(prev => {
        const stripped = (prev[statusId] || []).filter(r => r.user_email !== currentEmail);
        if (prevMine) stripped.push({ emoji: prevMine, user_email: currentEmail });
        return { ...prev, [statusId]: stripped };
      });
      if (__DEV__) console.warn('[Status] React failed:', err?.message);
    }
  }, [viewerStatuses, viewerIndex, currentEmail]);

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
      closeViewerRef.current?.();
    } catch (err) {
      console.warn('[Status] Forward failed:', err);
    }
  }, [viewerStatuses, viewerIndex, viewerOwnerName, t, router]);

  // Creator state
  const [cameraVisible, setCameraVisible] = useState(false);
  // Press lock: TouchableOpacity onPress + onLongPress can both fire on slow
  // devices when the user releases right at the long-press threshold. We saw
  // status creation open StatusCamera AND the system gallery picker at once
  // ("dois sistemas"). Lock blocks concurrent handlers for ~600ms after either.
  const statusPressLockRef = useRef(0);
  const [creatorVisible, setCreatorVisible] = useState(false);
  const [creatorMode, setCreatorMode] = useState('text');
  const [textContent, setTextContent] = useState('');
  const [textBgColor, setTextBgColor] = useState(TEXT_BG_COLORS[0]);
  const [textFontStyle, setTextFontStyle] = useState('normal'); // 'normal' | 'serif' | 'mono'
  // Entry animation for text-only statuses. 'none' means no animation at
  // all (default). Saved in meta.text_animation and replayed in the viewer
  // via <AnimatedStatusText />.
  const [textAnimation, setTextAnimation] = useState('none'); // 'none' | 'bounce' | 'fade' | 'typewriter'
  // Multi-photo "carousel" picker — holds an array of photoFile objects so
  // we can publish all of them as one story sequence via status_carousel_publish.
  const [carouselPhotos, setCarouselPhotos] = useState([]); // [{ uri, name, type }]
  const [statusPrivacy, setStatusPrivacy] = useState('all'); // 'all' | 'contacts' | 'close_friends' | 'except'
  // Author-side hide list — populated by the "Ocultar de…" sheet when the
  // user picks privacy=except. Travels to the backend as `except_emails` so
  // status_list filters out these viewers. Reset when the composer closes.
  const [exceptEmails, setExceptEmails] = useState([]); // [email lowercase]
  const [exceptPickerVisible, setExceptPickerVisible] = useState(false);
  // Notify-on-stories subscriptions — Set of target emails the current
  // user opted into push pings for. Loaded once on mount via
  // status_notify_list and mutated optimistically when the user taps the
  // "Notificar / Não notificar" pill in the preview action sheet.
  const [notifySubs, setNotifySubs] = useState(() => new Set());
  // Cross-post to Feed — when true the publish flow passes cross_post_feed=true
  // so the backend duplicates the media into the public Feed. Only meaningful
  // for image/video status; the toggle is hidden for text/poll modes.
  const [crossPostFeed, setCrossPostFeed] = useState(false);
  const [photoUri, setPhotoUri] = useState(null);
  const [photoFile, setPhotoFile] = useState(null);
  const [photoFilter, setPhotoFilter] = useState('normal');
  const [stickers, setStickers] = useState([]); // [{ id, emoji, x, y }]
  const [showStickerPicker, setShowStickerPicker] = useState(false);
  // Link sticker prompt state. Opens a small inline form (URL + optional CTA
  // label) inside the picker when the user taps the "Link" tile. Validates
  // the URL with isValidStickerUrl before allowing add.
  const [linkPromptVisible, setLinkPromptVisible] = useState(false);
  const [linkPromptUrl, setLinkPromptUrl] = useState('');
  const [linkPromptLabel, setLinkPromptLabel] = useState('');
  // GIF sticker picker — opened from the sticker tray's "GIF" tile. Reuses
  // the existing GifPickerPanel (Tenor search + cached previews). On select
  // we drop a new gif-type sticker on the canvas at a randomized origin so
  // the user can see it land + drag it where they want.
  const [gifPickerVisible, setGifPickerVisible] = useState(false);
  // Locally-archived status IDs. Backend doesn't yet expose status_archive,
  // so we hide them from the strip optimistically + memoize so the next
  // refetch (which DOES include them) still respects the user's choice
  // until they restart. TODO: wire to api.statusArchive once backend ships.
  const [archivedStatusIds, setArchivedStatusIds] = useState(() => new Set());
  const [textOverlays, setTextOverlays] = useState([]); // [{ id, text, x, y, color }]
  const [showAddTextInput, setShowAddTextInput] = useState(false);
  const [newOverlayText, setNewOverlayText] = useState('');
  const [drawMode, setDrawMode] = useState(false);
  const [drawColor, setDrawColor] = useState('#fff');
  const [drawPaths, setDrawPaths] = useState([]); // [{ points: [{x,y}], color }]
  const currentDrawPath = useRef(null);

  // Composer history — unified undo/redo across stickers + textOverlays +
  // drawPaths. Stack of snapshots `{ stickers, textOverlays, drawPaths }` so
  // the user can step back through every edit, not just draw strokes.
  // Push a snapshot BEFORE every mutation; pop on undo and re-apply.
  const historyRef = useRef({ past: [], future: [] });
  const HISTORY_CAP = 30; // hard ceiling so a 5-min editing session can't OOM
  const pushHistory = useCallback((snapshot) => {
    const past = historyRef.current.past;
    past.push(snapshot);
    if (past.length > HISTORY_CAP) past.shift();
    // Any new mutation invalidates the redo stack — Photoshop pattern.
    historyRef.current.future = [];
  }, []);
  const [historyVer, setHistoryVer] = useState(0); // bumps to re-render the toolbar's enabled state
  const snapshot = useCallback(() => ({
    stickers: stickers.map(s => ({ ...s })),
    textOverlays: textOverlays.map(t => ({ ...t })),
    drawPaths: drawPaths.map(p => ({ ...p, points: p.points.map(pt => ({ ...pt })) })),
  }), [stickers, textOverlays, drawPaths]);
  const recordEdit = useCallback(() => {
    pushHistory(snapshot());
    setHistoryVer(v => v + 1);
  }, [pushHistory, snapshot]);
  const undoEdit = useCallback(() => {
    const past = historyRef.current.past;
    if (past.length === 0) return;
    const prev = past.pop();
    historyRef.current.future.push(snapshot());
    setStickers(prev.stickers);
    setTextOverlays(prev.textOverlays);
    setDrawPaths(prev.drawPaths);
    setHistoryVer(v => v + 1);
    try { Haptics.selectionAsync?.(); } catch {}
  }, [snapshot]);
  const redoEdit = useCallback(() => {
    const future = historyRef.current.future;
    if (future.length === 0) return;
    const next = future.pop();
    historyRef.current.past.push(snapshot());
    setStickers(next.stickers);
    setTextOverlays(next.textOverlays);
    setDrawPaths(next.drawPaths);
    setHistoryVer(v => v + 1);
    try { Haptics.selectionAsync?.(); } catch {}
  }, [snapshot]);
  // Reset history when composer closes — fresh session, fresh stack.
  const resetHistory = useCallback(() => {
    historyRef.current = { past: [], future: [] };
    setHistoryVer(0);
  }, []);

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

  // Reply to a status — preferred path is the backend `status_reply_dm`
  // action which builds a proper "replied to your story" card (image/text
  // snapshot + reply text) on the server. We fall back to the legacy
  // chatSend flow only if the new action isn't available (e.g. cached PHP).
  // Optional `overrideText` lets the quick-emoji row send without the input.
  const handleStatusReply = useCallback(async (overrideText) => {
    const text = (typeof overrideText === 'string' ? overrideText : viewerReply).trim();
    if (!text || sendingReply || !viewerOwnerEmail) return;
    const currentItem = viewerStatuses[viewerIndex];
    if (!currentItem?.id) return;
    setSendingReply(true);
    try {
      let r;
      try {
        r = await api.statusReplyDM?.(currentItem.id, text);
      } catch (netErr) {
        // Offline / 5xx — queue and treat as optimistically sent so the
        // input clears and the legacy chatSend fallback below is skipped.
        try {
          const { queueOfflineAction } = require('../services/offlineCache');
          await queueOfflineAction({
            type: 'status_reply_dm',
            params: { status_id: currentItem.id, content: text },
          });
        } catch {}
        if (typeof overrideText !== 'string') setViewerReply('');
        setSendingReply(false);
        return;
      }
      if (r?.success) {
        if (typeof overrideText !== 'string') setViewerReply('');
      } else {
        // Legacy fallback — sends the reply via regular chatSend so older
        // clients still work. Kept intentionally simple; the server-side
        // card path is the one we show off.
        const createRes = await chatCreate([viewerOwnerEmail], '', 'direct');
        const convId = createRes?.data?.conversation_id || createRes?.data?.id;
        if (!convId) throw new Error('No conversation');
        const statusType = currentItem?.type || 'text';
        const statusLabel = `↩️ ${t?.('status.replyToStatus') || 'Respondeu ao seu status'}`;
        if (statusType === 'image' && currentItem?.content) {
          const imgUrl = (currentItem.content || '').split('\n')[0];
          const fullUrl = imgUrl.startsWith('/') ? BASE_URL + imgUrl : imgUrl;
          await chatSend(convId, `${statusLabel}: ${text}`, 'image', null, null, fullUrl);
        } else if (statusType === 'video' && currentItem?.content) {
          const vidUrl = (currentItem.content || '').split('\n')[0];
          const fullUrl = vidUrl.startsWith('/') ? BASE_URL + vidUrl : vidUrl;
          await chatSend(convId, `${statusLabel}: ${text}`, 'video', null, null, fullUrl);
        } else {
          const statusPreview = (currentItem?.content || '').substring(0, 80);
          await chatSend(convId, `${statusLabel}: "${statusPreview}"\n\n${text}`, 'text');
        }
        if (typeof overrideText !== 'string') setViewerReply('');
      }
    } catch (err) {
      console.warn('[Status] Reply failed:', err);
    } finally {
      setSendingReply(false);
    }
  }, [viewerReply, sendingReply, viewerOwnerEmail, viewerStatuses, viewerIndex, t]);

  // Swipe down to dismiss
  const panY = useRef(new Animated.Value(0)).current;
  // closeViewerRef moved to top of component to break TDZ forward-ref
  // from handleOpenForward (~line 954) that needs to call closeViewer.

  // PanResponder for swipe-down-to-close on the status viewer modal.
  // Uses CAPTURE phase so we beat the inner TouchableOpacity (which would
  // otherwise eat the gesture and prevent the close). Threshold dy>14
  // engages the drag, then close on dy>80 OR a fast flick (vy>0.55).
  // Was previously trying GestureDetector from RNGH but that broke the
  // VideoView render inside Modal — reverted to PanResponder only.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => false,
      onStartShouldSetPanResponderCapture: () => false,
      // Lower threshold to dy>6 (was 14) — Instagram/WhatsApp register the
      // swipe almost immediately. Was too tight: small intentional drags
      // weren't claiming the responder, so the inner TouchableOpacity ate
      // the gesture and the modal didn't follow the finger nor close.
      onMoveShouldSetPanResponder: (_, gs) => gs.dy > 6 && gs.dy > Math.abs(gs.dx) * 1.2,
      onMoveShouldSetPanResponderCapture: (_, gs) => gs.dy > 6 && gs.dy > Math.abs(gs.dx) * 1.2,
      onPanResponderTerminationRequest: () => false,
      onPanResponderMove: (_, gs) => { if (gs.dy > 0) panY.setValue(gs.dy); },
      onPanResponderRelease: (_, gs) => {
        // Looser dismiss thresholds (was 80px or vy>0.55) so a normal
        // downward flick closes — matching Stories' feel.
        if (gs.dy > 60 || gs.vy > 0.4) closeViewerRef.current?.();
        else Animated.spring(panY, { toValue: 0, useNativeDriver: false, tension: 40 }).start();
      },
      onPanResponderTerminate: () => {
        Animated.spring(panY, { toValue: 0, useNativeDriver: false, tension: 40 }).start();
      },
    })
  ).current;

  // Hook owns fetch + 30d disk cache + MMKV preload + WS deltas + 120s poll
  // + fingerprint diff + video warm-cache. The local myStatuses/contactStatuses
  // state below mirrors the hook output so the existing optimistic mutation
  // sites (mark-viewed, delete, etc.) keep their setState calls intact.
  //
  // Wave 4 finalize (2026-05-08): also pull `markViewed`/`removeStatus`/
  // `removeGroup` so that mark-viewed, delete, archive and mute propagate
  // into the hook's MMKV + 30d disk cache. Before this, those mutations
  // only touched the local mirror state, which meant other surfaces using
  // useStatuses (ChatListTab home strip, Profile stories row) would re-paint
  // stale "unviewed" rings until the next 120s poll caught up.
  const {
    mine: hookMine,
    others: hookOthers,
    loading: hookLoading,
    refetch: loadStatuses,
    markViewed: hookMarkViewed,
    removeStatus: hookRemoveStatus,
    removeGroup: hookRemoveGroup,
  } = useStatuses(currentEmail, { warmCacheVideos: true });

  // Mirror hook → local state. setState bails when the reference is unchanged
  // (the hook already fingerprint-diffs upstream) so this only fires on real
  // deltas — no flicker, no extra renders.
  // Locally-archived ids are filtered out client-side here until the backend
  // ships `status_archive`. This way "Arquivar" gives instant feedback even
  // though the row still exists server-side.
  useEffect(() => {
    if (archivedStatusIds.size > 0) {
      setMyStatuses(hookMine.filter(s => !archivedStatusIds.has(s.id)));
    } else {
      setMyStatuses(hookMine);
    }
    // Detect newly-arrived owner emails to fire the ring pulse animation —
    // any owner present in hookOthers that wasn't in the previous snapshot
    // gets a one-shot scale pop so the user sees "this just arrived".
    const prevSet = new Set((contactStatuses || []).map(g => String(g.ownerEmail || '').toLowerCase()));
    for (const g of hookOthers || []) {
      const k = String(g.ownerEmail || '').toLowerCase();
      if (!prevSet.has(k)) {
        try { triggerPulse(k); } catch {}
      }
    }
    setContactStatuses(hookOthers);
    if (hookLoading === false && loading) setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hookMine, hookOthers, hookLoading, loading, archivedStatusIds]);

  // Load the "Notify me about X's stories" subscription set once on mount.
  // The set drives the toggle pill rendered in the long-press preview
  // action sheet (alongside Silenciar / Reportar / Compartilhar). Cheap
  // single-row-per-pair table on the backend; cached client-side as a Set
  // for O(1) lookup. Failure is silent — the pill defaults to "off".
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const r = await api.statusNotifyList?.();
        if (!mounted) return;
        const arr = Array.isArray(r?.data?.targets) ? r.data.targets : [];
        setNotifySubs(new Set(arr.map(e => String(e || '').toLowerCase())));
      } catch {}
    })();
    return () => { mounted = false; };
  }, []);

  // Pull-to-refresh handler — re-runs the hook's refetch and clears the
  // spinner once the network round-trip resolves (or fails silently).
  const onPullRefresh = useCallback(async () => {
    setRefreshing(true);
    try { await loadStatuses?.(); } catch {}
    setRefreshing(false);
  }, [loadStatuses]);

  // Profile screen routes here with new=1 when user taps the "Novo" circle.
  // Kick the composer open as soon as the tab mounts so they don't also have
  // to hit "+" themselves.
  const _autoOpenedRef = useRef(false);
  useEffect(() => {
    if (autoNewStatus && !_autoOpenedRef.current) {
      _autoOpenedRef.current = true;
      // Slight delay so the tab finishes mounting before the modal appears.
      // openCreator is declared ~350 lines below this effect; keeping it in
      // the deps array would crash with TDZ ("Cannot access 'openCreator'
      // before initialization") because the deps array is evaluated synchronously
      // at render time. The closure inside the setTimeout resolves the binding
      // when it fires (well after render completes), so the call still works.
      setTimeout(() => { try { openCreator('text'); } catch {} }, 250);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoNewStatus]);

  // Filter by search
  const filteredStatuses = contactStatuses.filter((s) => {
    if (!searchQuery.trim()) return true;
    const q = searchQuery.toLowerCase();
    return s.ownerName.toLowerCase().includes(q) || s.ownerEmail.toLowerCase().includes(q);
  });

  // 3-way partition (Instagram-style): muted users go to a collapsed
  // "Silenciados" section, the rest split into "Recentes" (any unviewed)
  // and "Vistos" (all viewed). The hook flags muted groups via `s.muted`
  // when known; we also fall back to a backend hint at `s.is_muted`.
  const mutedStatuses = filteredStatuses.filter(
    (s) => !!(s.muted || s.is_muted)
  );
  const audibleStatuses = filteredStatuses.filter(
    (s) => !(s.muted || s.is_muted)
  );
  const recentStatuses = audibleStatuses.filter(
    (s) => !s.items.every((item) => item.viewed)
  );
  const viewedStatuses = audibleStatuses.filter(
    (s) => s.items.every((item) => item.viewed)
  );

  // All status groups for swiping between people
  const [allStatusGroups, setAllStatusGroups] = useState([]);
  const [currentGroupIndex, setCurrentGroupIndex] = useState(0);

  // ─── Viewer Logic ───
  const openViewer = useCallback((statusGroup) => {
    // [WAVE 54 2026-05-21] Manifest-only placeholder guard. If user taps a
    // bubble before status_list resolves, force a refetch and abort the
    // open — empty stories would just flash + close anyway.
    const isPlaceholder = (statusGroup?.items || []).every(it => it?._placeholder);
    if (isPlaceholder) {
      try { loadStatuses?.(); } catch {}
      return;
    }
    // Light haptic on tap — Instagram/WhatsApp parity. Without this the
    // tap into the story viewer feels unanchored vs other taps in the app.
    try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light); } catch {}
    // Aggressive prefetch the FIRST 3 videos of the tapped group right now —
    // by the time the modal animates open + the player mounts, the file is
    // already on disk and getLocalUriSyncJs returns a file:// URI for instant
    // playback. Removes "tela preta" on cold-tap of an uncached story.
    if (Platform.OS !== 'web' && statusGroup?.items?.length) {
      try {
        for (const it of statusGroup.items.slice(0, 3)) {
          if (it?.type !== 'video') continue;
          const raw = (it.media_url || it.content || '').split('\n')[0];
          const fullUrl = raw.startsWith('/') ? BASE_URL + raw : raw;
          if (fullUrl) cacheMedia(fullUrl, { force: true }).catch(() => {});
        }
      } catch {}
    }
    // Configure audio session so video status PLAYS through the speaker even
    // when the iOS silent switch is on (Instagram/Stories pattern). Without
    // this, half of opens land in muted city. expo-av's setAudioModeAsync
    // also benefits expo-video on the same session.
    if (Platform.OS !== 'web') {
      try {
        const { Audio } = require('expo-av');
        Audio?.setAudioModeAsync?.({
          playsInSilentModeIOS: true,
          allowsRecordingIOS: false,
          staysActiveInBackground: false,
          shouldDuckAndroid: true,
          playThroughEarpieceAndroid: false,
        });
      } catch {}
    }
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
    // useNativeDriver:false to match panY (also false). Mixing native+JS
    // drivers on Animated.Views inside a Modal sometimes leaves the
    // VideoView native peer black — RN won't reconcile transforms and
    // opacity that come from different threads on the same modal layer.
    Animated.timing(viewerOpacity, { toValue: 1, duration: 250, useNativeDriver: false }).start();
  }, [viewerOpacity, panY, myStatuses, contactStatuses, currentEmail, currentName]);

  const closeViewer = useCallback(() => {
    stopStatusAudio();
    Animated.timing(viewerOpacity, { toValue: 0, duration: 200, useNativeDriver: false }).start(() => {
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
      // Reset paused/replying state when changing person — without these
      // the viewer carried hold-to-pause across people and the auto-advance
      // never fired on the next contact.
      setIsPaused(false);
      stopStatusAudio();
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
      setIsPaused(false);
      stopStatusAudio();
      progressAnim.setValue(0);
    }
  }, [currentGroupIndex, allStatusGroups, progressAnim]);

  const advanceViewer = useCallback(() => {
    const currentItem = viewerStatuses[viewerIndex];
    if (currentItem && !currentItem.viewed) {
      const _viewId = currentItem.id;
      api.statusView(_viewId).catch(() => {
        // Offline / 5xx — queue the view receipt so it lands next reconnect.
        // Server insert is idempotent on (status_id, viewer_email).
        try {
          const { queueOfflineAction } = require('../services/offlineCache');
          queueOfflineAction({ type: 'status_view', params: { status_id: _viewId } });
        } catch {}
      });
      // Local viewer snapshot still needs the immediate flip — `viewerStatuses`
      // was captured at openViewer time and isn't bound to the hook output,
      // so this keeps the in-modal "Vistos" badge truthy for this same item.
      setViewerStatuses(prev => prev.map((s, idx) => idx === viewerIndex ? { ...s, viewed: true } : s));
      // Wave 4 finalize: route through the hook so MMKV + 30d disk cache +
      // home strip + profile rings all see the viewed flag immediately. The
      // mirror useEffect re-pushes hookOthers → setContactStatuses, so the
      // "Recentes / Visualizados" partition reshuffles within one render —
      // replaces the old manual setContactStatuses walk that left other
      // surfaces (ChatListTab home, Profile) stale until the next 120s poll.
      try { hookMarkViewed?.(currentItem.id); } catch {}
    }

    if (viewerIndex < viewerStatuses.length - 1) {
      setViewerIndex((prev) => prev + 1);
    } else {
      // Move to next person's statuses instead of closing
      goToNextPerson();
    }
  }, [viewerStatuses, viewerIndex, goToNextPerson, hookMarkViewed]);

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

  // Per-item duration override: when a video reports its real length the
  // progress bar uses that instead of STATUS_DURATION (5s). Falls back to
  // 5s for images and for videos that haven't reported metadata yet — the
  // effect re-runs on videoDurationMs change so when the video player calls
  // onDuration the timer adjusts.
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const [videoLoading, setVideoLoading] = useState(false);
  const [videoError, setVideoError] = useState(false);
  // Bump on every cache poll tick so the URL resolver inside StatusVideoPlayer
  // re-runs and picks up a freshly-cached file:// URI as soon as the
  // background download finishes. Without this, expo-video stays bound to the
  // initial remote URL and never switches to the local file once it's ready.
  const [cacheTick, setCacheTick] = useState(0);
  useEffect(() => {
    // Reset duration + loading flags on item change so a 30s video doesn't
    // carry over to a 3s next-item video and over-stay; spinner shows on
    // every fresh load.
    setVideoDurationMs(0);
    const item = viewerStatuses[viewerIndex];
    if (item?.type === 'video') {
      setVideoLoading(true);
      setVideoError(false);
    } else {
      setVideoLoading(false);
      setVideoError(false);
    }
  }, [viewerIndex, viewerOwnerEmail, viewerStatuses]);

  // While the current item is a video that's still loading, poll the local
  // cache 5x at 300ms — when the prefetch download lands, bump cacheTick so
  // the URL resolver re-runs and the player switches to file:// mid-load.
  useEffect(() => {
    if (Platform.OS === 'web' || !viewerVisible || !videoLoading) return;
    const item = viewerStatuses[viewerIndex];
    if (item?.type !== 'video') return;
    const raw = (item.media_url || item.content || '').split('\n')[0];
    const fullUrl = raw.startsWith('/') ? BASE_URL + raw : raw;
    if (!fullUrl) return;
    let i = 0;
    const id = setInterval(() => {
      i++;
      try {
        const { getLocalUriSyncJs } = require('../services/mediaCache');
        if (getLocalUriSyncJs(fullUrl)) {
          setCacheTick(t => t + 1);
          clearInterval(id);
          return;
        }
      } catch {}
      if (i >= 8) clearInterval(id); // ~2.4s — beyond that, the spinner stays.
    }, 300);
    return () => clearInterval(id);
  }, [viewerVisible, viewerIndex, viewerStatuses, videoLoading]);

  // Watchdog: if a video is still loading after 5s (R2 slow / network
  // hiccup / no buffer), auto-advance to the next item instead of leaving
  // the user staring at a black screen with a spinner. Stories pattern —
  // beats Instagram which just sits there.
  useEffect(() => {
    if (Platform.OS === 'web' || !viewerVisible || !videoLoading) return;
    const item = viewerStatuses[viewerIndex];
    if (item?.type !== 'video') return;
    const t = setTimeout(() => {
      try {
        // Only auto-advance if STILL loading after 5s (videoLoading true).
        // The state captured here is the closure value, but we re-read
        // mountedRef-like check via viewerVisible: if user already moved,
        // the effect cleanup ran and this timeout is gone.
        advanceViewer?.();
      } catch {}
    }, 5000);
    return () => clearTimeout(t);
  }, [viewerVisible, viewerIndex, viewerStatuses, videoLoading, advanceViewer]);

  // Pre-cache the NEXT 2 videos to disk so when the user advances the
  // VideoView plays from a local file:// URI instead of streaming fresh from
  // R2 (which is the "tela preta antes" the user sees). Telegram/Stories
  // pattern. Force=true bypasses the cellular gate in cacheMedia since the
  // user is actively in the viewer.
  useEffect(() => {
    if (Platform.OS === 'web' || !viewerVisible) return;
    const upcoming = [];
    // Same person, next 3 items (was 2 — extra slot helps long carousels)
    for (let i = 1; i <= 3; i++) {
      const it = viewerStatuses[viewerIndex + i];
      if (it && it.type === 'video' && (it.media_url || it.content)) upcoming.push(it);
    }
    // Next 2 people's first items so swipe-to-next-person is also instant
    for (let g = 1; g <= 2; g++) {
      const grp = allStatusGroups[currentGroupIndex + g];
      if (grp?.items?.[0] && grp.items[0].type === 'video') upcoming.push(grp.items[0]);
    }
    for (const it of upcoming) {
      const raw = (it.media_url || it.content || '').split('\n')[0];
      const fullUrl = raw.startsWith('/') ? BASE_URL + raw : raw;
      if (!fullUrl) continue;
      try { cacheMedia(fullUrl, { force: true }).catch(() => {}); } catch {}
    }
  }, [viewerVisible, viewerIndex, viewerStatuses, allStatusGroups, currentGroupIndex]);

  useEffect(() => {
    if (!viewerVisible || viewerStatuses.length === 0 || isPaused) return;

    const item = viewerStatuses[viewerIndex];
    const isVid = item?.type === 'video';
    const dur = isVid && videoDurationMs > 0 ? videoDurationMs : STATUS_DURATION;

    progressAnim.setValue(0);
    const anim = Animated.timing(progressAnim, {
      toValue: 1,
      duration: dur,
      useNativeDriver: true,
    });
    animRef.current = anim;
    anim.start();

    timerRef.current = setTimeout(advanceViewer, dur);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      anim.stop();
    };
  }, [viewerVisible, viewerIndex, viewerStatuses.length, isPaused, videoDurationMs]);

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
    if (Date.now() < statusPressLockRef.current) return;
    statusPressLockRef.current = Date.now() + 600;
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
            const result = await launch({ mediaTypes: ['images', 'videos'], quality: 0.8, videoMaxDuration: 60 });
            if (!result.canceled && result.assets?.[0]) {
              const asset = result.assets[0];
              const isVid = asset.type === 'video' || /\.(mp4|mov|m4v|webm)$/i.test(asset.uri || '');
              // CRITICAL: when the user picked a VIDEO, switch creatorMode
              // accordingly so publishStatus calls statusPublish with
              // type='video'. Previously stayed as 'photo' from the
              // openCreator entry, which registered videos as static
              // images and broke playback.
              if (isVid) setCreatorMode('video');
              setPhotoUri(asset.uri);
              setPhotoFile({
                uri: asset.uri,
                name: isVid ? 'status.mp4' : 'status.jpg',
                type: asset.mimeType || (isVid ? 'video/mp4' : 'image/jpeg'),
              });
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

  // Handler for when StatusCamera captures a photo/video.
  // Perf: photos are compressed to ~1200px / 0.82 JPEG before upload so a 4 MB
  // HEIC/PNG becomes ~150 KB — cuts upload time on 4G from ~8 s to <1 s. Video
  // is uploaded as-is (compression would re-encode, losing much more time than
  // it saves). `isBoomerang` flag rides along in extraMeta so the viewer knows
  // to loop the short clip back-and-forth.
  const handleCameraCapture = useCallback(async (capture) => {
    setCameraVisible(false);
    if (!capture?.uri) return;
    setPublishing(true);
    try {
      let uploadUri = capture.uri;
      let uploadType = capture.type === 'video' ? 'video/mp4' : 'image/jpeg';
      let uploadName = capture.type === 'video' ? 'status.mp4' : 'status.jpg';

      if (capture.type === 'photo' && Platform.OS !== 'web') {
        try {
          const ImageManipulator = require('expo-image-manipulator');
          const out = await ImageManipulator.manipulateAsync(
            capture.uri,
            [{ resize: { width: 1200 } }],
            { compress: 0.82, format: ImageManipulator.SaveFormat.JPEG }
          );
          if (out?.uri) uploadUri = out.uri;
        } catch (e) {
          // Fall through to original on manipulator failure — better slow upload
          // than no status at all.
          console.warn('[status] compress failed:', e?.message);
        }
      }

      const file = { uri: uploadUri, name: uploadName, type: uploadType };
      const uploadR = await api.statusUpload(file);
      if (uploadR?.success && uploadR.data?.url) {
        const statusType = capture.type === 'video' ? 'video' : 'image';
        const extraMeta = capture.isBoomerang ? { is_boomerang: true } : {};
        const r = await api.statusPublish(uploadR.data.url, statusType, '#000000', null, extraMeta);
        if (r?.success) {
          loadStatuses();
        } else {
          // Camera capture published successfully to R2 but server rejected
          // the status_create row — without this the user sees the camera
          // close and assumes the status went up.
          console.warn('[StatusCamera] publish rejected:', r?.message);
          try { Alert.alert?.(t?.('common.error') || 'Erro', r?.message || t?.('status.publishFailed') || 'Não foi possível publicar o status.'); } catch {}
        }
      } else {
        console.warn('[StatusCamera] upload failed:', uploadR?.message);
        try { Alert.alert?.(t?.('common.error') || 'Erro', uploadR?.message || t?.('status.uploadFailed') || 'Falha no upload da mídia.'); } catch {}
      }
    } catch (e) {
      console.warn('[StatusCamera publish]', e);
      try { Alert.alert?.(t?.('common.error') || 'Erro', (t?.('status.publishFailed') || 'Não foi possível publicar o status.') + (e?.message ? ` (${e.message})` : '')); } catch {}
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
      text_animation: textAnimation !== 'none' ? textAnimation : undefined,
      privacy: statusPrivacy !== 'all' ? statusPrivacy : undefined,
      // Author-side hide list — forwarded only when privacy === 'except'.
      // Backend persists it under meta.except_emails and filters per viewer.
      except_emails: (statusPrivacy === 'except' && exceptEmails.length > 0) ? exceptEmails : undefined,
      filter: photoFilter !== 'normal' ? photoFilter : undefined,
      stickers: stickers.length > 0 ? stickers.map(s => ({
        ...(s.emoji ? { emoji: s.emoji } : {}),
        ...(s.type ? { type: s.type, ...s } : {}),
        x: Math.round(s.x), y: Math.round(s.y),
      })) : undefined,
      text_overlays: textOverlays.length > 0 ? textOverlays.map(to => ({ text: to.text, x: Math.round(to.x), y: Math.round(to.y), color: to.color })) : undefined,
      draw_paths: drawPaths.length > 0 ? drawPaths.map(p => ({ color: p.color, points: p.points.map(pt => ({ x: Math.round(pt.x), y: Math.round(pt.y) })) })) : undefined,
      // Cross-post to Feed — only forwarded for image/video modes (backend
      // ignores it for text/poll). Toggle defaults to off; user opts in.
      cross_post_feed: (crossPostFeed && (creatorMode === 'photo' || creatorMode === 'video')) ? true : undefined,
    };

    setPublishing(true);
    try {
      if ((creatorMode === 'photo' || creatorMode === 'video') && photoFile) {
        const uploadR = await api.statusUpload(photoFile);
        if (uploadR?.success && uploadR.data?.url) {
          const caption = textContent.trim();
          const content = caption ? uploadR.data.url + '\n' + caption : uploadR.data.url;
          const statusType = creatorMode === 'video' ? 'video' : 'image';
          const r = await api.statusPublish(content, statusType, '#000000', musicData, extraMeta);
          if (r?.success) {
            setCreatorVisible(false); setMusicPickerVisible(false); setSelectedMusic(null); setCrossPostFeed(false); loadStatuses();
            // Success haptic — without this, users tap "publish" and aren't sure
            // the post landed since the modal close + list reload have a brief gap.
            if (Platform.OS !== 'web') {
              try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
            }
          } else {
            // Server rejected status_create — surface so user can retry instead
            // of staring at the open creator with no signal. Previously silent
            // (`catch {}` below also swallowed thrown errors).
            console.warn('[Status] publish rejected:', r?.message);
            try { Alert.alert?.(t?.('common.error') || 'Erro', r?.message || t?.('status.publishFailed') || 'Não foi possível publicar o status.'); } catch {}
          }
        } else {
          // Upload failed (Rust + PHP fallback both returned !success). Tell
          // the user — without this they sit on the creator with no feedback.
          console.warn('[Status] upload failed:', uploadR?.message);
          try { Alert.alert?.(t?.('common.error') || 'Erro', uploadR?.message || t?.('status.uploadFailed') || 'Falha no upload da mídia.'); } catch {}
        }
      } else {
        const r = await api.statusPublish(textContent.trim(), 'text', textBgColor, musicData, extraMeta);
        if (r?.success) {
          setCreatorVisible(false); setMusicPickerVisible(false); setTextContent(''); setSelectedMusic(null); loadStatuses();
          if (Platform.OS !== 'web') {
            try { Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success); } catch {}
          }
        } else {
          console.warn('[Status] text publish rejected:', r?.message);
          try { Alert.alert?.(t?.('common.error') || 'Erro', r?.message || t?.('status.publishFailed') || 'Não foi possível publicar o status.'); } catch {}
        }
      }
    } catch (e) {
      // Network/runtime exception. Was empty `catch {}` — user got zero
      // feedback when a transient 5xx or DNS hiccup hit status publish.
      console.warn('[Status] publish exception:', e?.message || e);
      try { Alert.alert?.(t?.('common.error') || 'Erro', (t?.('status.publishFailed') || 'Não foi possível publicar o status.') + (e?.message ? ` (${e.message})` : '')); } catch {}
    } finally {
      setPublishing(false);
    }
  }, [textContent, textBgColor, creatorMode, photoFile, publishing, loadStatuses, selectedMusic, textFontStyle, statusPrivacy, crossPostFeed, exceptEmails]);

  // Multi-photo carousel publisher — uploads each picked image (up to 10)
  // in parallel, then calls status_carousel_publish to register them as one
  // linked story. Returns silently on cancel; surfaces errors via console
  // so transient network hiccups don't interrupt the user flow.
  const publishCarousel = useCallback(async () => {
    if (publishing) return;
    if (Date.now() < statusPressLockRef.current) return;
    statusPressLockRef.current = Date.now() + 600;
    try {
      let assets = [];
      if (Platform.OS === 'web') {
        // Web: plain multi-select file input. One-shot, no permission prompt.
        const files = await new Promise((resolve) => {
          const input = document.createElement('input');
          input.type = 'file';
          input.accept = 'image/*,video/*';
          input.multiple = true;
          input.onchange = (e) => resolve(Array.from(e.target.files || []));
          input.click();
        });
        if (!files.length) return;
        assets = files.slice(0, 10).map(f => ({
          uri: URL.createObjectURL(f), _file: f,
          name: f.name || 'status',
          type: f.type || 'image/jpeg',
          isVideo: (f.type || '').startsWith('video/'),
        }));
      } else {
        const ImagePicker = await import('expo-image-picker');
        const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (!perm.granted) return;
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.All,
          allowsMultipleSelection: true,
          selectionLimit: 10,
          quality: 0.8,
        });
        if (result.canceled || !result.assets?.length) return;
        assets = result.assets.slice(0, 10).map(a => ({
          uri: a.uri,
          name: a.fileName || (a.type === 'video' ? 'status.mp4' : 'status.jpg'),
          type: a.mimeType || (a.type === 'video' ? 'video/mp4' : 'image/jpeg'),
          isVideo: a.type === 'video',
        }));
      }
      if (!assets.length) return;

      setPublishing(true);
      // Upload in parallel — each slide is independent so we don't need
      // to serialize. Promise.allSettled lets a single slow upload not
      // kill the whole carousel.
      const uploads = await Promise.allSettled(assets.map(async (a) => {
        const file = Platform.OS === 'web' ? a._file : { uri: a.uri, name: a.name, type: a.type };
        const r = await api.statusUpload(file);
        if (r?.success && r?.data?.url) {
          return { url: r.data.url, isVideo: a.isVideo };
        }
        return null;
      }));

      const items = uploads
        .map(u => (u.status === 'fulfilled' ? u.value : null))
        .filter(Boolean)
        .map(u => ({
          type: u.isVideo ? 'video' : 'image',
          media_url: u.url,
          background: '#000000',
        }));

      if (!items.length) {
        console.warn('[Status] carousel: no items uploaded');
        return;
      }

      // Single-item carousels still publish, but we could also fall back
      // to the classic status_publish path. Kept unified for simplicity.
      await api.statusCarouselPublish?.(items, { privacy: statusPrivacy !== 'all' ? statusPrivacy : 'all' });
      loadStatuses();
    } catch (e) {
      console.warn('[Status] carousel publish failed:', e?.message);
    } finally {
      setPublishing(false);
    }
  }, [publishing, statusPrivacy, loadStatuses]);

  const deleteMyStatus = useCallback(async (statusId) => {
    try {
      await api.statusDelete(statusId);
      // Wave 4 finalize: hookRemoveStatus drops the row from mine + groups
      // + others, invalidates the fingerprint, and (next refetch) re-persists
      // MMKV/disk. The mirror useEffect feeds setMyStatuses on the next tick,
      // so we don't need the local setMyStatuses call anymore.
      try { hookRemoveStatus?.(statusId); } catch {}
    } catch {}
  }, [hookRemoveStatus]);

  // Archive own status. Backend `status_archive` doesn't exist yet — when
  // present, we call it (best-effort, fire-and-forget) so the server keeps
  // the row hidden across devices. Until that ships, the status is removed
  // from `myStatuses` immediately + tracked in `archivedStatusIds` so the
  // user gets instant feedback. The future archive section will read from
  // both stores once the endpoint is wired.
  // TODO(api.statusArchive): wire to backend once endpoint exists. For now
  //   archived ids only persist for this session — next refetch will surface
  //   them again unless we also filter in the normalize step.
  const archiveMyStatus = useCallback(async (statusId) => {
    if (!statusId) return;
    // Keep the local archivedStatusIds Set so the mirror useEffect can
    // continue filtering hookMine on every refetch (the backend doesn't
    // know about archive yet — we re-apply on each tick).
    setArchivedStatusIds(prev => {
      const next = new Set(prev);
      next.add(statusId);
      return next;
    });
    // Wave 4 finalize: also tell the hook so the disk/MMKV cache drops
    // the row immediately. Without this, ChatListTab home strip would
    // still paint the archived status on its next mount until refetch.
    try { hookRemoveStatus?.(statusId); } catch {}
    try {
      if (typeof api.statusArchive === 'function') {
        await api.statusArchive(statusId);
      }
    } catch {}
  }, [hookRemoveStatus]);

  // Open the per-status analytics panel. Loads backend payload lazily;
  // shows a spinner until the response lands. Owner-only — caller must
  // gate on isOwnStatus. We don't block the open on the network so the
  // panel mounts instantly with skeleton numbers.
  const openAnalytics = useCallback(async (statusId) => {
    if (!statusId) return;
    setAnalyticsStatusId(statusId);
    setAnalyticsData(null);
    setAnalyticsError(null);
    setAnalyticsLoading(true);
    setAnalyticsModalOpen(true);
    try {
      const res = await api.statusAnalytics?.(statusId);
      if (res?.success && res.data) {
        setAnalyticsData(res.data);
      } else {
        setAnalyticsError(res?.message || 'Não foi possível carregar estatísticas');
      }
    } catch (e) {
      setAnalyticsError(e?.message || 'Erro de rede');
    } finally {
      setAnalyticsLoading(false);
    }
  }, []);

  // Open the archive sheet (list of archived own statuses). Lazy-loads
  // on first open so we don't pay the round-trip up front.
  const openArchiveSheet = useCallback(async () => {
    setArchiveSheetOpen(true);
    setArchiveLoading(true);
    try {
      const res = await api.statusArchiveList?.();
      const items = res?.data?.items || res?.items || [];
      setArchiveItems(Array.isArray(items) ? items : []);
    } catch {
      setArchiveItems([]);
    } finally {
      setArchiveLoading(false);
    }
  }, []);

  // Repost an own (live or archived) status as a new 24h story. Server
  // copies media + caption and assigns a fresh expires_at. We refetch the
  // home strip after success so the new row appears at the top.
  const repostMyStatus = useCallback(async (statusId, { privacy = 'all', caption = '' } = {}) => {
    if (!statusId) return null;
    try {
      const res = await api.statusRepost?.(statusId, { privacy, caption });
      if (res?.success) {
        // Trigger a refetch so the new row lands in the strip; the hook
        // owns disk persistence so we don't need to mutate state here.
        try { loadStatuses?.(); } catch {}
        return res.data;
      }
    } catch (e) {
      console.warn('[repostMyStatus] failed:', e?.message);
    }
    return null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadStatuses]);

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

  const isOwnStatus = String(viewerOwnerEmail || '').toLowerCase() === String(currentEmail || '').toLowerCase();
  const currentViewerItem = viewerStatuses[viewerIndex];

  const renderStatusRow = (statusGroup) => {
    const latestItem = statusGroup.items[statusGroup.items.length - 1];
    const time = timeAgo(latestItem?.timestamp, t);
    const allViewed = statusGroup.items.every((item) => item.viewed);
    const count = statusGroup.items.length;
    // Close-friends ring: any item with privacy === 'close_friends' flips
    // the whole row's ring green. Mirrors the StoryScroller behavior so
    // the parity holds between the horizontal top strip and the list rows.
    const rowCloseFriends = statusGroup.items.some(
      (item) => (item?.meta?.privacy || item?.privacy) === 'close_friends'
    );

    return (
      <TouchableOpacity
        key={statusGroup.ownerEmail}
        style={[styles.statusRow, { backgroundColor: isDark ? colors.card : '#fff' }]}
        // Pre-warm the first video + its poster the moment the finger
        // touches down (~150ms before onPress fires). Cuts perceived
        // open time by giving the network a head-start while the user's
        // tap is still being recognized. Same pattern as Telegram chat
        // list pre-fetch on touch-in.
        onPressIn={() => {
          if (Platform.OS === 'web') return;
          try {
            const items = statusGroup?.items || [];
            const first = items[0];
            if (!first || first.type !== 'video') return;
            const raw = (first.media_url || first.content || '').split('\n')[0];
            const fullUrl = raw.startsWith('/') ? BASE_URL + raw : raw;
            if (fullUrl) cacheMedia(fullUrl, { force: true }).catch(() => {});
            const t = first.thumbnail_url;
            if (t) {
              const posterUrl = t.startsWith('/') ? BASE_URL + t : t;
              try {
                const { Image: ExpoImg } = require('expo-image');
                ExpoImg?.prefetch?.([posterUrl]).catch(() => {});
              } catch {}
            }
          } catch {}
        }}
        onPress={() => openViewer(statusGroup)}
        // Long-press → quick peek modal (Instagram pattern). Preview the
        // latest item without marking as viewed; releasing dismisses it.
        // We just open the full viewer for now (release-to-close needs a
        // separate gesture handler refactor) but at least give haptic feedback
        // so users discover the gesture is responsive.
        onLongPress={() => {
          try { Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium); } catch {}
          setPreviewGroup(statusGroup);
        }}
        delayLongPress={350}
        activeOpacity={0.7}
      >
        <Animated.View style={[styles.avatarWrapper, {
          transform: [{ scale: getPulseFor(statusGroup.ownerEmail) }],
        }]}>
          <SegmentedRing
            items={statusGroup.items}
            size={52}
            viewed={allViewed}
            closeFriends={rowCloseFriends}
          />
          <AvatarCircle name={statusGroup.ownerName} email={statusGroup.ownerEmail} size={52} />
        </Animated.View>
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
    // Skeleton instead of spinner — perceived load time drops because the
    // user sees the row layout immediately and the rows just "fill in"
    // when data lands. Matches Instagram/Telegram pattern.
    const SkeletonRow = ({ rowKey }) => (
      <View key={rowKey} style={[styles.statusRow, { backgroundColor: isDark ? colors.card : '#fff' }]}>
        <View style={[styles.avatarWrapper, {
          width: 52, height: 52, borderRadius: 26,
          backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)',
        }]} />
        <View style={[styles.statusInfo, { gap: 6 }]}>
          <View style={{ height: 13, width: '55%', borderRadius: 6, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />
          <View style={{ height: 11, width: '35%', borderRadius: 6, backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.04)' }} />
        </View>
      </View>
    );
    return (
      <View style={[styles.container, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
        <View style={[styles.sectionHeader, { backgroundColor: isDark ? colors.background : '#f6f8fa' }]}>
          <View style={{ height: 14, width: 140, borderRadius: 6, backgroundColor: isDark ? 'rgba(255,255,255,0.08)' : 'rgba(0,0,0,0.06)' }} />
        </View>
        {[0,1,2,3,4,5].map(i => <SkeletonRow key={`sk-${i}`} rowKey={`sk-${i}`} />)}
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

      <ScrollView
        style={styles.scrollView}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onPullRefresh}
            tintColor={ACCENT}
            colors={[ACCENT, '#6D28D9']}
            progressBackgroundColor={isDark ? '#1a1a1a' : '#fff'}
          />
        }
      >
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

        {/* My Status Hero Tile — 96px circular avatar with dashed purple
            ring (empty) or solid gradient ring (active). "Quem viu" view
            count pill surfaces below when there's an active story.
            Replaces the old rectangular row card for an Instagram-grade
            hero feel. */}
        <View style={[styles.myStatusCard, {
          backgroundColor: isDark ? colors.card : '#fff',
          ...(Platform.OS === 'web' ? { boxShadow: '0 2px 12px rgba(0,0,0,0.08)' } : {}),
        }]}>
          <View style={styles.myStatusRow}>
            <TouchableOpacity
              onPress={() => hasMyStatus ? openViewer(myStatusGroup) : openCreator()}
              activeOpacity={0.7}
              style={{ alignItems: 'center', justifyContent: 'center', marginRight: 16 }}
            >
              <View style={styles.myAvatarWrapperHero}>
                {hasMyStatus ? (
                  // Solid gradient ring when there's an active story.
                  <Svg width={108} height={108} style={{ position: 'absolute', top: -6, left: -6 }}>
                    <Defs>
                      <LinearGradient id="heroRing" x1="0" y1="0" x2="1" y2="1">
                        <Stop offset="0" stopColor="#7C3AED" />
                        <Stop offset="0.5" stopColor="#9333EA" />
                        <Stop offset="1" stopColor="#6D28D9" />
                      </LinearGradient>
                    </Defs>
                    <SvgCircle cx="54" cy="54" r="51" stroke="url(#heroRing)" strokeWidth={3.5} fill="none" />
                  </Svg>
                ) : (
                  // Dashed purple "tap to add" ring when empty.
                  <Svg width={108} height={108} style={{ position: 'absolute', top: -6, left: -6 }}>
                    <SvgCircle cx="54" cy="54" r="51" stroke={ACCENT} strokeWidth={2.5} strokeDasharray="6 5" fill="none" opacity={0.65} />
                  </Svg>
                )}
                <AvatarCircle name={currentName} email={currentEmail} size={96} />
                {!hasMyStatus && (
                  <View style={[styles.plusBadgeHero, {
                    borderColor: isDark ? colors.card : '#fff',
                  }]}>
                    <IconPlus size={16} color="#fff" />
                  </View>
                )}
              </View>
            </TouchableOpacity>
            <View style={{ flex: 1 }}>
              <Text style={[styles.myStatusName, { color: colors.text }]}>
                {myStatusLabel}
              </Text>
              <Text style={[styles.myStatusSub, { color: colors.textSecondary }]} numberOfLines={1}>
                {hasMyStatus
                  ? `${myStatuses.length} ${myStatuses.length > 1 ? 'atualizações' : 'atualização'} • ${timeAgo(myStatuses[myStatuses.length - 1]?.timestamp, t)}`
                  : addStatusLabel
                }
              </Text>
              {/* "Quem viu" badge — only when own status is active and has
                  any views. Tapping opens the viewers sheet for the latest
                  item (same flow as the in-viewer eye icon). */}
              {hasMyStatus && myViewCount > 0 && (
                <TouchableOpacity
                  style={[styles.viewCountPill, {
                    backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.10)',
                    borderColor: isDark ? 'rgba(124,58,237,0.35)' : 'rgba(124,58,237,0.22)',
                  }]}
                  activeOpacity={0.7}
                  onPress={async () => {
                    const last = myStatuses[myStatuses.length - 1];
                    if (!last?.id) return;
                    try { Haptics.impactAsync?.(Haptics.ImpactFeedbackStyle.Light); } catch {}
                    try {
                      const r = await statusViewers(last.id);
                      const list = (r?.data?.viewers || r?.viewers || []);
                      setViewersList(list);
                      setViewersModal(true);
                    } catch {}
                  }}
                  accessibilityLabel={`${myViewCount} visualizações`}
                >
                  <IconEye size={12} color={ACCENT} />
                  <Text style={styles.viewCountPillText}>
                    {myViewCount} {myViewCount === 1 ? 'visualização' : 'visualizações'}
                  </Text>
                </TouchableOpacity>
              )}
            </View>
            <View style={styles.myStatusActions}>
              {hasMyStatus && (
                <TouchableOpacity
                  // "Arquivar status" — long-press on the trash also surfaces
                  // it via Alert/confirm (so users discover it without a new
                  // icon cluttering the row), but keep this dedicated button
                  // visible so the action is always one tap away. Uses
                  // archiveMyStatus which hides the latest item immediately
                  // and TODOs the backend wire-up.
                  style={[styles.actionCircle, { backgroundColor: isDark ? '#1a2330' : '#e3f2fd', marginRight: 10 }]}
                  onPress={() => {
                    const last = myStatuses[myStatuses.length - 1];
                    if (!last) return;
                    const doArchive = () => archiveMyStatus(last.id);
                    if (Platform.OS === 'web') {
                      if (typeof window !== 'undefined' && window.confirm(t?.('status.archiveConfirm') || 'Arquivar este status?')) doArchive();
                    } else {
                      Alert.alert(
                        t?.('status.archiveTitle') || 'Arquivar status',
                        t?.('status.archiveConfirm') || 'Arquivar este status? Você poderá vê-lo no arquivo depois.',
                        [
                          { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                          { text: t?.('status.archive') || 'Arquivar', onPress: doArchive },
                        ]
                      );
                    }
                  }}
                  accessibilityLabel={t?.('status.archive') || 'Arquivar status'}
                >
                  <IconArchive size={18} color="#3b82f6" />
                </TouchableOpacity>
              )}
              {/* "Ver arquivo" — opens the archive sheet so users can browse
                  past archived stories and repost any of them as a fresh
                  24h story. Lives next to the archive trash so the two
                  archive actions are co-located. */}
              <TouchableOpacity
                style={[styles.actionCircle, { backgroundColor: isDark ? '#1e2a3a' : '#e8f0fe', marginRight: 10 }]}
                onPress={openArchiveSheet}
                accessibilityLabel={t?.('status.openArchive') || 'Abrir arquivo'}
              >
                <IconBookmark size={18} color="#3b82f6" />
              </TouchableOpacity>
              {hasMyStatus && (
                <TouchableOpacity
                  style={[styles.actionCircle, { backgroundColor: isDark ? '#3a1c1e' : '#fce4ec' }]}
                  onPress={() => {
                    const last = myStatuses[myStatuses.length - 1];
                    if (!last) return;
                    const doDelete = () => deleteMyStatus(last.id);
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
                  accessibilityLabel={t?.('common.delete') || 'Excluir'}
                >
                  <IconTrash size={18} color="#D63031" />
                </TouchableOpacity>
              )}
              <TouchableOpacity
                style={[styles.actionCircle, {
                  backgroundColor: isDark ? '#1a332a' : '#e8f5e9',
                  marginLeft: hasMyStatus ? 10 : 0,
                }]}
                onPress={() => openCreator(Platform.OS !== 'web' ? 'camera' : 'photo')}
                // Long-press → multi-photo carousel publish.
                // Keeps the single-shot flow on tap so existing users aren't
                // disrupted, while still exposing the carousel without a
                // new icon cluttering the layout.
                onLongPress={publishCarousel}
                delayLongPress={350}
                accessibilityLabel={t?.('status.addMore') || 'Adicionar outro'}
                accessibilityHint={t?.('status.longPressCarousel') || 'Segure para publicar várias fotos'}
              >
                <IconPlus size={20} color={ACCENT} />
              </TouchableOpacity>
            </View>
          </View>
        </View>

        {/* "Meus" — surfaces the user's own status as a row only when they
            have one. Sits between the hero tile and the Recentes section,
            mirrors Instagram's layout where your own story shows up in the
            highlights row before others' stories. */}
        {hasMyStatus && (
          <View style={styles.section}>
            <View style={styles.sectionHeader}>
              <View style={styles.sectionAccent} />
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                {t?.('status.mine') || 'Meus'}
              </Text>
              <Text style={[styles.sectionCount, { color: colors.textSecondary }]}>{myStatuses.length}</Text>
            </View>
            {renderStatusRow(myStatusGroup)}
          </View>
        )}

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

        {/* Silenciados — collapsed by default. Tapping the section header
            expands the list. Mirrors Instagram's hidden-stories pattern so
            muted users don't pollute the main feed. */}
        {mutedStatuses.length > 0 && (
          <View style={styles.section}>
            <TouchableOpacity
              style={styles.sectionHeader}
              activeOpacity={0.7}
              onPress={() => {
                try { Haptics.selectionAsync?.(); } catch {}
                setShowMuted(v => !v);
              }}
            >
              <View style={[styles.sectionAccent, { backgroundColor: isDark ? '#555' : '#bbb' }]} />
              <Text style={[styles.sectionTitle, { color: colors.textSecondary }]}>
                {t?.('status.muted') || 'Silenciados'}
              </Text>
              <Text style={[styles.sectionCount, { color: colors.textSecondary }]}>{mutedStatuses.length}</Text>
              <Text style={{ color: colors.textSecondary, fontSize: 14, marginRight: 16 }}>
                {showMuted ? '−' : '+'}
              </Text>
            </TouchableOpacity>
            {showMuted && mutedStatuses.map((s) => renderStatusRow(s))}
          </View>
        )}

        {/* Empty state */}
        {recentStatuses.length === 0 && viewedStatuses.length === 0 && mutedStatuses.length === 0 && !hasMyStatus && (
          <View style={styles.emptyContainer}>
            <EmptyStatusIllustration isDark={isDark} />
            <Text style={[styles.emptyText, { color: colors.text }]}>
              {t?.('status.firstTitle') || 'Adicione seu primeiro status'}
            </Text>
            <Text style={[styles.emptySubtext, { color: colors.textSecondary }]}>{disappearsLabel}</Text>
            <TouchableOpacity
              style={styles.emptyButton}
              onPress={() => openCreator()}
              activeOpacity={0.85}
            >
              <IconPlus size={18} color="#fff" />
              <Text style={styles.emptyButtonText}>{t?.('status.addStatus') || 'Adicionar status'}</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={{ height: 120 }} />
      </ScrollView>

      {/* FABs — Telegram-grade glass orbs */}
      <BrandFab
        style={{ position: 'absolute', bottom: (insets?.bottom || 0) + 84, right: 24 }}
        size={48}
        variant="secondary"
        surfaceColor={isDark ? '#2a2e2b' : '#fff'}
        onPress={() => Platform.OS !== 'web' ? openCreator('camera') : openCreator('photo')}
        onLongPress={publishCarousel}
        delayLongPress={350}
        accessibilityHint={t?.('status.longPressCarousel') || 'Segure para publicar várias fotos'}
      >
        <IconCamera size={22} color={ACCENT} />
      </BrandFab>
      <BrandFab
        style={{ position: 'absolute', bottom: (insets?.bottom || 0) + 16, right: 20 }}
        size={58}
        color={ACCENT}
        onPress={() => openCreator('text')}
        accessibilityLabel="New text status"
      >
        <IconEdit size={24} color="#fff" />
      </BrandFab>

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

      {/* ─── Long-press Preview Modal ─── */}
      {/* Quick peek of the latest status item (Instagram pattern: hold to
          preview without marking as viewed). Tap anywhere → full viewer.
          Tap outside the card → dismiss. */}
      <Modal
        visible={!!previewGroup}
        transparent
        animationType="fade"
        statusBarTranslucent
        onRequestClose={() => setPreviewGroup(null)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.85)', alignItems: 'center', justifyContent: 'center' }}
          onPress={() => setPreviewGroup(null)}
        >
          {(() => {
            if (!previewGroup) return null;
            const items = previewGroup.items || [];
            if (!items.length) return null;
            return (
              <Pressable
                onPress={() => { const g = previewGroup; setPreviewGroup(null); setTimeout(() => openViewer(g), 80); }}
                style={{
                  width: SCREEN_WIDTH * 0.7, height: SCREEN_HEIGHT * 0.55,
                  borderRadius: 16, overflow: 'hidden',
                  backgroundColor: items[0]?.background || items[0]?.bg_color || '#1a1a1a',
                }}
              >
                {/* Animated mini-player — auto-advances at 1.5× through the
                    user's stories while the long-press is held. Releases
                    on Pressable parent dismiss; tap-to-open still works. */}
                <AnimatedPeekPreview
                  group={previewGroup}
                  ownerName={previewGroup.ownerName}
                  t={t}
                />
              </Pressable>
            );
          })()}
          {/* Long-press action sheet — Silenciar / Reportar / Compartilhar
              (Instagram parity). Only renders for OTHER users' status (don't
              show on your own card). Each button is a glass-tinted pill. */}
          {previewGroup && String(previewGroup.ownerEmail || '').toLowerCase() !== String(currentEmail || '').toLowerCase() && (
            <View style={{ flexDirection: 'row', marginTop: 18, gap: 10 }}>
              <Pressable
                onPress={async () => {
                  const targetEmail = previewGroup.ownerEmail;
                  const targetName = previewGroup.ownerName;
                  setPreviewGroup(null);
                  try { await api.statusMute(targetEmail); } catch {}
                  try { Haptics.notificationAsync?.(Haptics.NotificationFeedbackType.Success); } catch {}
                  // Wave 4 finalize: route through the hook so the muted
                  // owner drops out of MMKV/disk cache too — otherwise
                  // ChatListTab home strip would still paint the row on
                  // its next mount until the next 120s poll. The mirror
                  // useEffect re-pushes hookOthers → setContactStatuses,
                  // so the local list collapses on the next render.
                  try { hookRemoveGroup?.(targetEmail); } catch {}
                  try { Alert.alert?.(t?.('status.muteSuccess') || 'Silenciado', `${t?.('status.mutedBody') || 'Status de'} ${targetName} ${t?.('status.mutedSuffix') || 'foi silenciado.'}`); } catch {}
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: 16, paddingVertical: 11,
                  backgroundColor: pressed ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.15)',
                  borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 7,
                })}
              >
                <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M13.73 21a2 2 0 0 1-3.46 0" />
                  <Path d="M18.63 13A17.89 17.89 0 0 1 18 8" />
                  <Path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14" />
                  <Path d="M18 8a6 6 0 0 0-9.33-5" />
                  <Path d="m1 1 22 22" />
                </Svg>
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                  {t?.('status.muteAction') || 'Silenciar'}
                </Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  const targetEmail = previewGroup.ownerEmail;
                  setPreviewGroup(null);
                  try { Haptics.notificationAsync?.(Haptics.NotificationFeedbackType.Warning); } catch {}
                  try {
                    if (typeof api.statusReport === 'function') {
                      await api.statusReport(targetEmail);
                    } else {
                      await api.apiCall?.('status_report', { email: targetEmail }, 'POST');
                    }
                  } catch {}
                  try { Alert.alert?.(t?.('status.reportSent') || 'Denúncia enviada', t?.('status.reportBody') || 'Obrigado. Vamos revisar este conteúdo.'); } catch {}
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: 16, paddingVertical: 11,
                  backgroundColor: pressed ? 'rgba(255,80,80,0.42)' : 'rgba(255,80,80,0.25)',
                  borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 7,
                })}
              >
                <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <Path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
                  <Path d="M4 22V4" />
                </Svg>
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                  {t?.('status.reportAction') || 'Reportar'}
                </Text>
              </Pressable>
              <Pressable
                onPress={async () => {
                  const targetName = previewGroup.ownerName;
                  setPreviewGroup(null);
                  try { Haptics.impactAsync?.(Haptics.ImpactFeedbackStyle.Light); } catch {}
                  try {
                    const Share = require('react-native').Share;
                    await Share?.share?.({
                      message: `${t?.('status.shareMsg') || 'Olha o status de'} ${targetName} no Chatyy!`,
                    });
                  } catch {}
                }}
                style={({ pressed }) => ({
                  paddingHorizontal: 16, paddingVertical: 11,
                  backgroundColor: pressed ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.15)',
                  borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 7,
                })}
              >
                <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                  <SvgCircle cx="18" cy="5" r="3" />
                  <SvgCircle cx="6" cy="12" r="3" />
                  <SvgCircle cx="18" cy="19" r="3" />
                  <Path d="m8.59 13.51 6.83 3.98" />
                  <Path d="m15.41 6.51-6.82 3.98" />
                </Svg>
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                  {t?.('status.shareAction') || 'Compartilhar'}
                </Text>
              </Pressable>
              {/* Notify-for-stories pill — opt-in to FCM pings when this
                  contact posts a new story. Active state paints the chip
                  purple so the user reads at a glance whether they're
                  already subscribed. Optimistic mutate the Set, then fire
                  the toggle; revert + alert on failure. */}
              {(() => {
                const targetEm = String(previewGroup.ownerEmail || '').toLowerCase();
                const targetNm = previewGroup.ownerName;
                const active = notifySubs.has(targetEm);
                return (
                  <Pressable
                    onPress={async () => {
                      setPreviewGroup(null);
                      // Optimistic flip + fire-and-forget API call. If the
                      // backend rejects, we restore the prior state and
                      // surface an alert. The Set is cloned so React picks
                      // up the change in StrictMode.
                      const next = !active;
                      setNotifySubs(prev => {
                        const s = new Set(prev);
                        if (next) s.add(targetEm); else s.delete(targetEm);
                        return s;
                      });
                      try {
                        const r = await api.statusNotifyToggle?.(targetEm, next);
                        if (r && r.success === false) throw new Error(r?.message || 'toggle failed');
                        try { Haptics.notificationAsync?.(Haptics.NotificationFeedbackType.Success); } catch {}
                        try {
                          Alert.alert?.(
                            next ? (t?.('status.notifyOn') || 'Notificar sobre stories de') + ' ' + targetNm
                                 : (t?.('status.notifyOff') || 'Não notificar sobre stories de') + ' ' + targetNm,
                            next ? (t?.('status.notifyEnabled') || 'Você será avisado quando postar novos stories.')
                                 : (t?.('status.notifyDisabled') || 'Notificações desativadas.'),
                          );
                        } catch {}
                      } catch (e) {
                        // Revert on failure
                        setNotifySubs(prev => {
                          const s = new Set(prev);
                          if (next) s.delete(targetEm); else s.add(targetEm);
                          return s;
                        });
                        try { Alert.alert?.(t?.('common.error') || 'Erro', e?.message || ''); } catch {}
                      }
                    }}
                    style={({ pressed }) => ({
                      paddingHorizontal: 16, paddingVertical: 11,
                      backgroundColor: active
                        ? (pressed ? 'rgba(124,58,237,0.85)' : 'rgba(124,58,237,0.65)')
                        : (pressed ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.15)'),
                      borderRadius: 22, flexDirection: 'row', alignItems: 'center', gap: 7,
                    })}
                  >
                    <Svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                      <Path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
                      <Path d="M13.73 21a2 2 0 0 1-3.46 0" />
                    </Svg>
                    <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
                      {active
                        ? (t?.('status.notifyingShort') || 'Notificando')
                        : (t?.('status.notifyShort') || 'Notificar')}
                    </Text>
                  </Pressable>
                );
              })()}
            </View>
          )}
        </Pressable>
      </Modal>

      {/* ─── GIF sticker picker ─── */}
      {/* Pops the existing GifPickerPanel so the user can search Tenor +
          drop a GIF onto the canvas. Validates the URL against an allow-list
          (Tenor / Giphy / chatyy R2) before adding the sticker so a
          malicious payload (e.g. tracking pixel disguised as gif) can't
          land in someone else's published status. */}
      <Modal
        visible={gifPickerVisible}
        transparent
        animationType="slide"
        statusBarTranslucent
        onRequestClose={() => setGifPickerVisible(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}
          onPress={() => setGifPickerVisible(false)}
        >
          <Pressable onPress={(e) => e.stopPropagation && e.stopPropagation()}>
            <GifPickerPanel
              colors={colors}
              t={t}
              onClose={() => setGifPickerVisible(false)}
              onSelect={(gif) => {
                // Tenor returns { id, url, preview, width, height } via
                // chatSearchGifs. Prefer the full URL but fall back to
                // preview for older API shapes.
                const rawUrl = gif?.url || gif?.preview || '';
                if (!isAllowedGifUrl(rawUrl)) {
                  // Silent reject: GifPickerPanel only surfaces results from
                  // our backend (Tenor) so this should never legitimately
                  // fire. Keeping the guard so a future mistake (e.g.
                  // pasting a URL from elsewhere) can't bypass the allow-list.
                  setGifPickerVisible(false);
                  return;
                }
                const w = Math.max(1, Number(gif?.width) || 200);
                const h = Math.max(1, Number(gif?.height) || 200);
                recordEdit();
                setStickers(prev => [...prev, {
                  id: Date.now() + Math.random(),
                  type: 'gif',
                  url: rawUrl,
                  width: w,
                  height: h,
                  x: 60 + Math.random() * 80,
                  y: 200 + Math.random() * 60,
                }]);
                setGifPickerVisible(false);
              }}
            />
          </Pressable>
        </Pressable>
      </Modal>

      {/* ─── Full-Screen Status Viewer Modal ─── */}
      {/* Reverted to PanResponder only (was breaking VideoView render
          inside Modal when wrapped in GestureDetector). */}
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
              {/* Own status: trash to delete this story + plus to post another. */}
              {isOwnStatus && currentViewerItem?.id && (
                <>
                  {/* Save to highlights — Stories permanentes (B) */}
                  <TouchableOpacity
                    onPress={() => openHighlightSheet(currentViewerItem)}
                    style={[styles.viewerClose, { marginRight: 4 }]}
                    accessibilityLabel={t?.('status.saveToHighlight') || 'Salvar em destaques'}
                  >
                    <IconBookmark size={22} color="#fff" />
                  </TouchableOpacity>
                  {/* Per-status analytics (impressions, exit rate, etc).
                      Lazily fetched on tap. Backend returns the aggregate
                      shape; the modal renders skeleton numbers while we
                      wait so the panel doesn't feel laggy on slow links. */}
                  <TouchableOpacity
                    onPress={() => openAnalytics(currentViewerItem.id)}
                    style={[styles.viewerClose, { marginRight: 4 }]}
                    accessibilityLabel={t?.('status.analytics') || 'Estatísticas'}
                  >
                    <IconBarChart size={22} color="#fff" />
                  </TouchableOpacity>
                  {/* Repost own status — generates a fresh 24h row from
                      the same media + caption. Wrapped in a confirm so the
                      user doesn't double-post by accident. */}
                  <TouchableOpacity
                    onPress={() => {
                      const id = currentViewerItem.id;
                      const doRepost = async () => {
                        const out = await repostMyStatus(id);
                        if (out?.status_id) {
                          closeViewer();
                        }
                      };
                      if (Platform.OS === 'web') {
                        if (window.confirm(t?.('status.repostConfirm') || 'Repostar este status?')) doRepost();
                      } else {
                        Alert.alert(
                          t?.('status.repostTitle') || 'Repostar',
                          t?.('status.repostConfirm') || 'Publicar este status de novo por mais 24h?',
                          [
                            { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                            { text: t?.('status.repost') || 'Repostar', onPress: doRepost },
                          ]
                        );
                      }
                    }}
                    style={[styles.viewerClose, { marginRight: 4 }]}
                    accessibilityLabel={t?.('status.repost') || 'Repostar'}
                  >
                    <IconRotateCw size={22} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      const id = currentViewerItem.id;
                      if (Platform.OS === 'web') {
                        if (window.confirm(t?.('status.deleteConfirm') || 'Apagar este status?')) deleteMyStatus(id);
                      } else {
                        Alert.alert(
                          t?.('status.deleteTitle') || 'Apagar status',
                          t?.('status.deleteConfirm') || 'Apagar este status?',
                          [
                            { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                            { text: t?.('common.delete') || 'Excluir', style: 'destructive', onPress: () => deleteMyStatus(id) },
                          ]
                        );
                      }
                    }}
                    style={[styles.viewerClose, { marginRight: 4 }]}
                    accessibilityLabel={t?.('common.delete') || 'Excluir'}
                  >
                    <IconTrash size={22} color="#ef4444" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => {
                      closeViewer();
                      setTimeout(() => { try { openCreator?.('camera'); } catch {} }, 120);
                    }}
                    style={[styles.viewerClose, { marginRight: 4 }]}
                    accessibilityLabel={t?.('status.addMore') || 'Adicionar outro'}
                  >
                    <IconPlus size={24} color="#fff" />
                  </TouchableOpacity>
                </>
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
                // Text-only stories can now carry an entry animation
                // (bounce/fade/typewriter) via meta.text_animation. Key the
                // component on the item id so the animation restarts on tap-
                // forward/back instead of staying in its final state.
                <AnimatedStatusText
                  animKey={currentViewerItem?.id || 0}
                  text={currentViewerItem?.content || ''}
                  bgColor={currentViewerItem?.bgColor || currentViewerItem?.background || '#6D28D9'}
                  fontStyle={currentViewerItem?.font_style || currentViewerItem?.meta?.font_style || 'normal'}
                  animation={currentViewerItem?.text_animation || currentViewerItem?.meta?.text_animation || 'none'}
                />
              ) : currentViewerItem?.type === 'video' ? (
                // No alignItems/justifyContent here — they collapse a
                // `flex:1` child without intrinsic size (native VideoView)
                // to zero on the cross axis, which is exactly the "tela
                // preta" symptom. Let the child flex naturally and rely on
                // contentFit="contain" inside VideoView for letterboxing.
                <View style={{ flex: 1, width: '100%', backgroundColor: '#000' }}>
                  {Platform.OS === 'web' ? (
                    // Stories pattern: autoplay only works with muted=true on
                    // web (Chrome/Safari block autoplay with sound). Sound is
                    // enabled on tap via the manual unmute control overlay.
                    <video
                      src={(() => { const url = ((currentViewerItem?.media_url || currentViewerItem?.content || '')).split('\n')[0]; return url.startsWith('/') ? BASE_URL + url : url; })()}
                      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                      autoPlay
                      muted
                      playsInline
                      loop
                      controls={false}
                      onClick={(e) => { try { e.currentTarget.muted = !e.currentTarget.muted; } catch {} }}
                    />
                  ) : (
                    <>
                      <StatusVideoPlayer
                        posterUrl={(() => {
                          // Prefer the server-generated .thumb.jpg poster
                          // so the viewer paints the first frame instantly
                          // instead of the black "buffering" screen.
                          const t = currentViewerItem?.thumbnail_url;
                          if (!t) return null;
                          return t.startsWith('/') ? BASE_URL + t : t;
                        })()}
                        url={(() => {
                          // Prefer HLS playlist (chunk-streamed, <500ms
                          // first frame) over progressive mp4 when
                          // available. Falls back to mp4 + local-cache
                          // path for clips that haven't been transcoded yet.
                          const hls = currentViewerItem?.hls_url;
                          if (hls) {
                            return hls.startsWith('/') ? BASE_URL + hls : hls;
                          }
                          const raw = ((currentViewerItem?.media_url || currentViewerItem?.content || '')).split('\n')[0];
                          const fullUrl = raw.startsWith('/') ? BASE_URL + raw : raw;
                          if (Platform.OS !== 'web' && fullUrl) {
                            try {
                              const { getLocalUriSyncJs } = require('../services/mediaCache');
                              const local = getLocalUriSyncJs(fullUrl);
                              if (local) return local;
                            } catch {}
                          }
                          return fullUrl;
                        })()}
                        onDuration={(ms) => { if (ms > 0) setVideoDurationMs(ms); }}
                        onLoaded={() => setVideoLoading(false)}
                        onError={() => { setVideoError(true); setVideoLoading(false); }}
                      />
                      {/* Buffering spinner — shown while the player connects
                          to R2 + decodes the first frame. Without this the
                          user sees ~1s of black on slow 4G and assumes the
                          status is broken. */}
                      {videoLoading && !videoError ? (
                        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                          <ActivityIndicator size="large" color="#fff" />
                        </View>
                      ) : null}
                      {videoError ? (
                        <View pointerEvents="none" style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', padding: 24 }}>
                          <Text style={{ color: '#fff', fontSize: 15, textAlign: 'center', opacity: 0.85 }}>
                            {t?.('status.videoError') || 'Não foi possível carregar este vídeo.'}
                          </Text>
                        </View>
                      ) : null}
                    </>
                  )}
                  {(() => {
                    // New format: caption sits directly in `content`.
                    // Old format (pre-fix): caption was appended to media_url
                    // as "URL\ncaption". Try both so existing posts still
                    // show their caption.
                    const c = (currentViewerItem?.content || '').trim();
                    const m = currentViewerItem?.media_url || '';
                    const caption = c || m.split('\n').slice(1).join('\n').trim();
                    if (!caption) return null;
                    // Multi-language status: when caption_locale on the post
                    // doesn't match the viewer's locale we surface a "🌐
                    // Traduzir" button. After tap, the translated string
                    // replaces the caption inline; "Original" reverts.
                    const meta = currentViewerItem?.meta || {};
                    const captionLocale = meta?.caption_locale || 'pt-BR';
                    const userLocale = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language : 'pt-BR';
                    const cached = (meta?.caption_translations || {})[userLocale];
                    const tState = translatedCaptions[currentViewerItem?.id];
                    const showTranslate = captionLocale && captionLocale.split('-')[0] !== userLocale.split('-')[0];
                    const displayCaption = (tState && tState !== '__loading__' && tState !== '__none__') ? tState : (cached || caption);
                    const isTranslated = !!(tState && tState !== '__loading__' && tState !== '__none__') || !!cached;
                    return (
                      <View style={styles.viewerCaptionBar}>
                        <Text style={styles.viewerCaption} numberOfLines={3} ellipsizeMode="tail">{displayCaption}</Text>
                        {showTranslate ? (
                          <TouchableOpacity
                            onPress={() => {
                              if (isTranslated) {
                                setTranslatedCaptions(prev => ({ ...prev, [currentViewerItem?.id]: undefined }));
                              } else if (tState !== '__loading__') {
                                requestTranslate(currentViewerItem?.id);
                              }
                            }}
                            style={{ marginTop: 4, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4 }}
                          >
                            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '600', textDecorationLine: 'underline', opacity: 0.85 }}>
                              {tState === '__loading__' ? '…' : (isTranslated ? (t('status.original') || 'Ver original') : (t('status.translate') || 'Traduzir'))}
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    );
                  })()}
                </View>
              ) : currentViewerItem?.type === 'image' ? (
                <View style={{ flex: 1, width: '100%', alignItems: 'center', justifyContent: 'center' }}>
                  {/* ExpoImage with memory-disk cache so the same status
                      opens instantly the second time (and across views
                      from different contacts). Falls back to plain Image
                      if the module isn't bundled for some reason. */}
                  {(() => {
                    const url = (() => { const u = ((currentViewerItem?.media_url || currentViewerItem?.content || '')).split('\n')[0]; return u.startsWith('/') ? BASE_URL + u : u; })();
                    let ExpoImg = null;
                    try { ExpoImg = require('expo-image').Image; } catch {}
                    if (ExpoImg) {
                      return <ExpoImg source={{ uri: url }} style={styles.viewerImage} contentFit="contain" cachePolicy="memory-disk" transition={120} />;
                    }
                    return <CachedImage source={{ uri: url }} style={styles.viewerImage} resizeMode="contain" />;
                  })()}
                  {(() => {
                    // New format: caption sits directly in `content`.
                    // Old format (pre-fix): caption was appended to media_url
                    // as "URL\ncaption". Try both so existing posts still
                    // show their caption.
                    const c = (currentViewerItem?.content || '').trim();
                    const m = currentViewerItem?.media_url || '';
                    const caption = c || m.split('\n').slice(1).join('\n').trim();
                    if (!caption) return null;
                    // Multi-language status: when caption_locale on the post
                    // doesn't match the viewer's locale we surface a "🌐
                    // Traduzir" button. After tap, the translated string
                    // replaces the caption inline; "Original" reverts.
                    const meta = currentViewerItem?.meta || {};
                    const captionLocale = meta?.caption_locale || 'pt-BR';
                    const userLocale = (typeof navigator !== 'undefined' && navigator.language) ? navigator.language : 'pt-BR';
                    const cached = (meta?.caption_translations || {})[userLocale];
                    const tState = translatedCaptions[currentViewerItem?.id];
                    const showTranslate = captionLocale && captionLocale.split('-')[0] !== userLocale.split('-')[0];
                    const displayCaption = (tState && tState !== '__loading__' && tState !== '__none__') ? tState : (cached || caption);
                    const isTranslated = !!(tState && tState !== '__loading__' && tState !== '__none__') || !!cached;
                    return (
                      <View style={styles.viewerCaptionBar}>
                        <Text style={styles.viewerCaption} numberOfLines={3} ellipsizeMode="tail">{displayCaption}</Text>
                        {showTranslate ? (
                          <TouchableOpacity
                            onPress={() => {
                              if (isTranslated) {
                                setTranslatedCaptions(prev => ({ ...prev, [currentViewerItem?.id]: undefined }));
                              } else if (tState !== '__loading__') {
                                requestTranslate(currentViewerItem?.id);
                              }
                            }}
                            style={{ marginTop: 4, alignSelf: 'flex-start', flexDirection: 'row', alignItems: 'center', gap: 4 }}
                          >
                            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '600', textDecorationLine: 'underline', opacity: 0.85 }}>
                              {tState === '__loading__' ? '…' : (isTranslated ? (t('status.original') || 'Ver original') : (t('status.translate') || 'Traduzir'))}
                            </Text>
                          </TouchableOpacity>
                        ) : null}
                      </View>
                    );
                  })()}
                </View>
              ) : null}

              {/* Music overlay — shows song title + artist when status has music */}
              {currentViewerItem?.music_title ? (
                <View style={styles.musicOverlay} pointerEvents="none">
                  {currentViewerItem.music_cover_url ? (
                    <CachedImage source={{ uri: currentViewerItem.music_cover_url }} style={styles.musicOverlayCover} />
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

            {/* Instagram-style swipe-up emoji reaction picker. The picker
                is rendered at the bottom; its gesture strip lives above the
                reply bar so swiping up is intuitive. Tapping the inline
                emoji row is kept as a fallback (WhatsApp-style). */}
            {!isOwnStatus && (
              <>
                <ReactionSwipeUp
                  activeEmoji={myReactions[currentViewerItem?.id]}
                  emojis={QUICK_REACTIONS}
                  onOpen={() => {
                    setIsPaused(true);
                    if (timerRef.current) clearTimeout(timerRef.current);
                    if (animRef.current) animRef.current.stop();
                  }}
                  onClose={() => setIsPaused(false)}
                  onReact={(emoji) => handleReact(emoji)}
                  bottomOffset={78}
                />
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
              </>
            )}

            {/* Reply input (only for other people's statuses) */}
            {!isOwnStatus && (
              <>
                {/* Quick-reply emoji row — WhatsApp parity. Tap = sends that
                    emoji as the reply immediately, without typing. */}
                <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 18, paddingBottom: 6, gap: 6 }}>
                  {['❤️', '\u{1F602}', '\u{1F62E}', '\u{1F622}', '\u{1F44F}'].map((emoji) => (
                    <TouchableOpacity
                      key={'qr-' + emoji}
                      onPress={() => handleStatusReply(emoji)}
                      disabled={sendingReply}
                      activeOpacity={0.6}
                      style={{ flex: 1, alignItems: 'center', paddingVertical: 8, borderRadius: 20, backgroundColor: 'rgba(255,255,255,0.08)' }}
                      accessibilityRole="button"
                      accessibilityLabel={'Reply ' + emoji}
                    >
                      <Text style={{ fontSize: 22 }}>{emoji}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              <View style={styles.replyBar}>
                <View style={styles.replyInputWrap}>
                  <TextInput
                    style={styles.replyInput}
                    value={viewerReply}
                    onChangeText={setViewerReply}
                    placeholder={t?.('status.reply') || 'Responder...'}
                    placeholderTextColor="rgba(255,255,255,0.4)"
                    returnKeyType="send"
                    onSubmitEditing={() => handleStatusReply()}
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
                    onPress={() => handleStatusReply()}
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
              </>
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

      {/* ─── Highlight picker — Stories permanentes (B) ─── */}
      <Modal visible={!!highlightSheet} transparent animationType="slide" onRequestClose={() => setHighlightSheet(null)}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }} onPress={() => setHighlightSheet(null)}>
          <Pressable style={{
            backgroundColor: isDark ? '#111' : '#fff',
            borderTopLeftRadius: 22, borderTopRightRadius: 22,
            paddingTop: 18, paddingBottom: Platform.OS === 'ios' ? 36 : 22,
            paddingHorizontal: 20,
          }} onPress={(e) => e.stopPropagation?.()}>
            <Text style={{ fontSize: 17, fontWeight: '700', color: isDark ? '#fff' : '#111', marginBottom: 14 }}>
              {t?.('status.saveToHighlight') || 'Salvar em destaques'}
            </Text>
            {highlights.length > 0 && (
              <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ marginBottom: 12 }}>
                {highlights.map(h => (
                  <TouchableOpacity
                    key={h.id}
                    onPress={() => addToHighlight(h.id)}
                    style={{ alignItems: 'center', marginRight: 14, opacity: highlightSaving ? 0.5 : 1 }}
                  >
                    <View style={{
                      width: 60, height: 60, borderRadius: 30,
                      borderWidth: 2, borderColor: isDark ? '#444' : '#ddd',
                      alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                      backgroundColor: isDark ? '#1c1c1e' : '#f4f4f5',
                    }}>
                      {h.cover_url ? (
                        <Image source={{ uri: h.cover_url.startsWith('http') ? h.cover_url : ('https://chatyy.com.br' + (h.cover_url.startsWith('/') ? '' : '/') + h.cover_url) }} style={{ width: 60, height: 60 }} />
                      ) : (
                        <IconBookmark size={22} color={isDark ? '#888' : '#666'} />
                      )}
                    </View>
                    <Text style={{ fontSize: 11, fontWeight: '600', marginTop: 6, color: isDark ? '#ccc' : '#333', maxWidth: 70 }} numberOfLines={1}>
                      {h.name}
                    </Text>
                  </TouchableOpacity>
                ))}
              </ScrollView>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 4 }}>
              <TextInput
                value={newHighlightName}
                onChangeText={setNewHighlightName}
                placeholder={t?.('status.highlightName') || 'Nome do destaque'}
                placeholderTextColor={isDark ? '#888' : '#999'}
                style={{
                  flex: 1, paddingHorizontal: 14, paddingVertical: 10,
                  borderRadius: 12, fontSize: 14,
                  backgroundColor: isDark ? '#1c1c1e' : '#f4f4f5',
                  color: isDark ? '#fff' : '#111',
                }}
                editable={!highlightSaving}
                maxLength={60}
              />
              <TouchableOpacity
                onPress={createHighlight}
                disabled={!newHighlightName.trim() || highlightSaving}
                style={{
                  paddingHorizontal: 16, paddingVertical: 10, borderRadius: 12,
                  backgroundColor: '#7C3AED',
                  opacity: !newHighlightName.trim() || highlightSaving ? 0.5 : 1,
                }}
              >
                {highlightSaving
                  ? <ActivityIndicator size="small" color="#fff" />
                  : <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>{t?.('status.newHighlight') || 'Novo'}</Text>}
              </TouchableOpacity>
            </View>
          </Pressable>
        </Pressable>
      </Modal>

      {/* ─── Viewers List Modal — WhatsApp-style ─── */}
      <Modal visible={viewersModal} transparent animationType="slide" onRequestClose={() => { setViewersModal(false); setIsPaused(false); }}>
        <Pressable style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }} onPress={() => { setViewersModal(false); setIsPaused(false); }}>
          <Pressable style={{
            backgroundColor: isDark ? '#111' : '#fff',
            borderTopLeftRadius: 24, borderTopRightRadius: 24,
            maxHeight: '75%', paddingBottom: Platform.OS === 'ios' ? 34 : 18,
            ...(Platform.OS === 'web' ? { boxShadow: '0 -8px 32px rgba(0,0,0,0.35)' } : {}),
          }}>
            {/* Drag handle */}
            <View style={{ alignItems: 'center', paddingTop: 10, paddingBottom: 4 }}>
              <View style={{ width: 42, height: 5, borderRadius: 3, backgroundColor: isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.15)' }} />
            </View>
            {/* Header — gradient eye badge + big count */}
            <View style={{
              paddingHorizontal: 20, paddingTop: 12, paddingBottom: 16,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.07)',
            }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                {/* Gradient SVG badge — Instagram-style vibrant icon */}
                <View style={{
                  width: 44, height: 44, borderRadius: 14,
                  overflow: 'hidden', alignItems: 'center', justifyContent: 'center',
                  ...(Platform.OS === 'web' ? { boxShadow: '0 4px 14px rgba(124,58,237,0.35)' } : {
                    shadowColor: '#7C3AED', shadowOffset: { width: 0, height: 4 },
                    shadowOpacity: 0.3, shadowRadius: 8, elevation: 4,
                  }),
                }}>
                  <Svg width={44} height={44} viewBox="0 0 44 44" style={{ position: 'absolute' }}>
                    <Defs>
                      <LinearGradient id="viewerGrad" x1="0" y1="0" x2="1" y2="1">
                        <Stop offset="0" stopColor="#A855F7" />
                        <Stop offset="1" stopColor="#7C3AED" />
                      </LinearGradient>
                    </Defs>
                    <Rect x="0" y="0" width="44" height="44" rx="14" fill="url(#viewerGrad)" />
                    {/* Eye glyph — curved lid + pupil */}
                    <Path d="M12 22 C16 15 28 15 32 22 C28 29 16 29 12 22 Z" stroke="#fff" strokeWidth="2" fill="none" />
                    <SvgCircle cx="22" cy="22" r="3.5" fill="#fff" />
                  </Svg>
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={{ fontSize: 22, fontWeight: '800', color: isDark ? '#fff' : '#111', letterSpacing: -0.4 }}>
                    {viewersList.length} {viewersList.length === 1 ? (t?.('status.viewer') || 'visualização') : (t?.('status.views') || 'visualizações')}
                  </Text>
                  {viewersList.length > 0 && (
                    <Text style={{ fontSize: 12.5, color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.48)', marginTop: 2 }}>
                      {t?.('status.viewersSubtitle') || 'Quem viu seu status'}
                    </Text>
                  )}
                </View>
              </View>
            </View>

            {viewersLoading ? (
              <View style={{ paddingVertical: 60 }}>
                <ActivityIndicator size="large" color="#7C3AED" />
              </View>
            ) : viewersList.length === 0 ? (
              <View style={{ alignItems: 'center', paddingVertical: 60, paddingHorizontal: 28 }}>
                <View style={{
                  width: 72, height: 72, borderRadius: 36,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.04)' : 'rgba(0,0,0,0.04)',
                  alignItems: 'center', justifyContent: 'center', marginBottom: 16,
                }}>
                  <IconEye size={32} color={isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)'} />
                </View>
                <Text style={{ fontSize: 16, fontWeight: '600', color: isDark ? '#fff' : '#111', marginBottom: 4 }}>
                  {t?.('status.noViewersTitle') || 'Ninguém viu ainda'}
                </Text>
                <Text style={{ fontSize: 13, color: isDark ? 'rgba(255,255,255,0.5)' : 'rgba(0,0,0,0.45)', textAlign: 'center' }}>
                  {t?.('status.noViewersBody') || 'Seus contatos verão quando abrirem o app.'}
                </Text>
              </View>
            ) : (
              <ScrollView
                showsVerticalScrollIndicator={false}
                contentContainerStyle={{ paddingVertical: 6 }}
              >
                {(() => {
                  // Group viewers by day — HOJE / ONTEM / date. Assumes server
                  // returns viewed_at sorted desc; if not we sort defensively.
                  const sorted = [...viewersList].sort((a, b) => {
                    const ta = Date.parse(a.viewed_at || 0) || 0;
                    const tb = Date.parse(b.viewed_at || 0) || 0;
                    return tb - ta;
                  });
                  const now = new Date();
                  const today = now.toDateString();
                  const yday = new Date(now.getTime() - 86400000).toDateString();
                  const groups = {};
                  const order = [];
                  for (const v of sorted) {
                    const d = v.viewed_at ? new Date(v.viewed_at) : now;
                    let key;
                    if (d.toDateString() === today) key = t?.('date.today') || 'HOJE';
                    else if (d.toDateString() === yday) key = t?.('date.yesterday') || 'ONTEM';
                    else key = d.toLocaleDateString();
                    if (!groups[key]) { groups[key] = []; order.push(key); }
                    groups[key].push(v);
                  }
                  return order.map(dayLabel => (
                    <View key={dayLabel}>
                      <Text style={{
                        fontSize: 11, fontWeight: '700',
                        color: isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)',
                        letterSpacing: 0.8, textTransform: 'uppercase',
                        paddingHorizontal: 20, paddingTop: 14, paddingBottom: 6,
                      }}>
                        {dayLabel.toUpperCase()}
                      </Text>
                      {groups[dayLabel].map((v, i) => {
                        // If this viewer also reacted, we surface their emoji on the right.
                        const reactEmoji = v.reaction_emoji || null;
                        const name = emailToDisplayName(v.name || v.viewer_email);
                        return (
                          <TouchableOpacity
                            key={i}
                            activeOpacity={0.65}
                            onPress={() => {
                              // Tap viewer → open their profile
                              try {
                                setViewersModal(false);
                                router.push('/u/' + encodeURIComponent(v.viewer_email));
                              } catch {}
                            }}
                            style={{
                              flexDirection: 'row', alignItems: 'center',
                              paddingHorizontal: 20, paddingVertical: 11, gap: 14,
                            }}
                          >
                            <View style={{ position: 'relative', width: 48, height: 48, alignItems: 'center', justifyContent: 'center' }}>
                              {/* Gradient ring when the viewer reacted — Instagram story-ring vibe */}
                              {reactEmoji && (
                                <Svg width={48} height={48} viewBox="0 0 48 48" style={{ position: 'absolute' }}>
                                  <Defs>
                                    <LinearGradient id={`vring${i}`} x1="0" y1="0" x2="1" y2="1">
                                      <Stop offset="0" stopColor="#F472B6" />
                                      <Stop offset="0.5" stopColor="#A855F7" />
                                      <Stop offset="1" stopColor="#7C3AED" />
                                    </LinearGradient>
                                  </Defs>
                                  <SvgCircle cx="24" cy="24" r="22" stroke={`url(#vring${i})`} strokeWidth="2.2" fill="none" />
                                </Svg>
                              )}
                              <AvatarCircle name={name} email={v.viewer_email} size={40} />
                              {reactEmoji && (
                                <View style={{
                                  position: 'absolute', right: -1, bottom: -1,
                                  width: 22, height: 22, borderRadius: 11,
                                  backgroundColor: isDark ? '#111' : '#fff',
                                  alignItems: 'center', justifyContent: 'center',
                                  borderWidth: 2, borderColor: isDark ? '#111' : '#fff',
                                  ...(Platform.OS === 'web' ? { boxShadow: '0 1px 3px rgba(0,0,0,0.2)' } : {}),
                                }}>
                                  <Text style={{ fontSize: 12 }}>{reactEmoji}</Text>
                                </View>
                              )}
                            </View>
                            <View style={{ flex: 1 }}>
                              <Text style={{ fontSize: 15.5, fontWeight: '600', color: isDark ? '#fff' : '#111', letterSpacing: -0.1 }} numberOfLines={1}>
                                {name}
                              </Text>
                              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                                {/* Tiny SVG clock icon next to the timestamp */}
                                <Svg width={11} height={11} viewBox="0 0 24 24" fill="none">
                                  <SvgCircle cx="12" cy="12" r="9.5" stroke={isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)'} strokeWidth="1.8" />
                                  <Path d="M12 7v5l3 2" stroke={isDark ? 'rgba(255,255,255,0.4)' : 'rgba(0,0,0,0.4)'} strokeWidth="1.8" strokeLinecap="round" />
                                </Svg>
                                <Text style={{ fontSize: 12.5, color: isDark ? 'rgba(255,255,255,0.45)' : 'rgba(0,0,0,0.45)' }} numberOfLines={1}>
                                  {v.viewed_at ? timeAgo(v.viewed_at, t) : ''}
                                </Text>
                              </View>
                            </View>
                            {/* Right-side chevron — invites tap */}
                            <Svg width={16} height={16} viewBox="0 0 24 24" fill="none">
                              <Path d="M9 6l6 6-6 6" stroke={isDark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.28)'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                            </Svg>
                          </TouchableOpacity>
                        );
                      })}
                    </View>
                  ));
                })()}
              </ScrollView>
            )}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ─── Per-Status Analytics Modal (creator-only) ─── */}
      {/* Renders impressions, reactions, replies, exit/completion rate.
          Skeleton shimmers under each KPI tile while the request flies.
          Numbers are rounded to 1 decimal on the rates so the layout
          stays clean; reactions/replies/impressions are integer. */}
      <Modal
        visible={analyticsModalOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setAnalyticsModalOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
          onPress={() => setAnalyticsModalOpen(false)}
        >
          <Pressable style={{
            backgroundColor: isDark ? '#1a1a2e' : '#fff',
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            paddingHorizontal: 20, paddingTop: 12, paddingBottom: 36,
            minHeight: 360,
          }}>
            <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : '#d1d5db', marginBottom: 18 }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 18 }}>
              <IconBarChart size={20} color={isDark ? '#fff' : '#111'} />
              <Text style={{ fontSize: 18, fontWeight: '800', color: isDark ? '#fff' : '#111' }}>
                {t?.('status.analytics') || 'Estatísticas'}
              </Text>
            </View>
            {analyticsLoading ? (
              <View style={{ paddingVertical: 32, alignItems: 'center' }}>
                <ActivityIndicator size="large" color={ACCENT} />
                <Text style={{ marginTop: 12, color: isDark ? '#9ca3af' : '#6b7280', fontSize: 13 }}>
                  {t?.('status.analyticsLoading') || 'Carregando...'}
                </Text>
              </View>
            ) : analyticsError ? (
              <View style={{ paddingVertical: 24, alignItems: 'center', gap: 10 }}>
                <Text style={{ color: isDark ? '#f87171' : '#dc2626', fontSize: 14, textAlign: 'center' }}>
                  {analyticsError}
                </Text>
                <TouchableOpacity
                  onPress={() => analyticsStatusId && openAnalytics(analyticsStatusId)}
                  style={{ paddingHorizontal: 18, paddingVertical: 10, borderRadius: 18, backgroundColor: ACCENT }}
                >
                  <Text style={{ color: '#fff', fontWeight: '700' }}>
                    {t?.('common.retry') || 'Tentar novamente'}
                  </Text>
                </TouchableOpacity>
              </View>
            ) : analyticsData ? (
              <View>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 12, justifyContent: 'space-between' }}>
                  {/* Each KPI tile — two per row on phones, four on tablets.
                      Layout is flex-wrap so the panel adapts naturally to
                      width without media queries. */}
                  {[
                    { label: t?.('status.kpiImpressions') || 'Visualizações', value: analyticsData.impressions, kind: 'int' },
                    { label: t?.('status.kpiReactions') || 'Reações', value: analyticsData.reactions, kind: 'int' },
                    { label: t?.('status.kpiReplies') || 'Respostas', value: analyticsData.replies, kind: 'int' },
                    { label: t?.('status.kpiCompletion') || 'Concluíram', value: analyticsData.completion_rate, kind: 'pct' },
                    { label: t?.('status.kpiExitRate') || 'Saídas', value: analyticsData.exit_rate, kind: 'pct' },
                  ].map((k, i) => (
                    <View
                      key={i}
                      style={{
                        flexBasis: '48%',
                        padding: 14,
                        borderRadius: 14,
                        backgroundColor: isDark ? 'rgba(255,255,255,0.05)' : '#f3f4f6',
                      }}
                    >
                      <Text style={{ fontSize: 12, color: isDark ? '#9ca3af' : '#6b7280', marginBottom: 6, fontWeight: '600' }} numberOfLines={1}>
                        {k.label}
                      </Text>
                      <Text style={{ fontSize: 22, fontWeight: '900', color: isDark ? '#fff' : '#111' }}>
                        {k.kind === 'pct' ? `${k.value}%` : k.value}
                      </Text>
                    </View>
                  ))}
                </View>
                <Text style={{ marginTop: 16, fontSize: 11, color: isDark ? '#6b7280' : '#9ca3af', textAlign: 'center', lineHeight: 16 }}>
                  {t?.('status.analyticsNote') || 'Atualizado em tempo real. Estatísticas privadas — só você vê.'}
                </Text>
              </View>
            ) : null}
          </Pressable>
        </Pressable>
      </Modal>

      {/* ─── Archive Sheet (own old statuses, long-press to repost) ─── */}
      <Modal
        visible={archiveSheetOpen}
        transparent
        animationType="slide"
        onRequestClose={() => setArchiveSheetOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
          onPress={() => setArchiveSheetOpen(false)}
        >
          <Pressable style={{
            backgroundColor: isDark ? '#1a1a2e' : '#fff',
            borderTopLeftRadius: 20, borderTopRightRadius: 20,
            paddingHorizontal: 16, paddingTop: 12, paddingBottom: 28,
            maxHeight: '78%',
          }}>
            <View style={{ alignSelf: 'center', width: 36, height: 4, borderRadius: 2, backgroundColor: isDark ? 'rgba(255,255,255,0.2)' : '#d1d5db', marginBottom: 14 }} />
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 4, marginBottom: 12 }}>
              <IconArchive size={20} color={isDark ? '#fff' : '#111'} />
              <Text style={{ fontSize: 18, fontWeight: '800', color: isDark ? '#fff' : '#111' }}>
                {t?.('status.archiveTitle2') || 'Arquivo'}
              </Text>
            </View>
            <Text style={{ fontSize: 12, color: isDark ? '#9ca3af' : '#6b7280', marginBottom: 12, paddingHorizontal: 4 }}>
              {t?.('status.archiveHint') || 'Toque longo em um status para repostar.'}
            </Text>
            {archiveLoading ? (
              <ActivityIndicator size="large" color={ACCENT} style={{ marginVertical: 32 }} />
            ) : archiveItems.length === 0 ? (
              <Text style={{ textAlign: 'center', color: isDark ? '#6b7280' : '#9ca3af', marginVertical: 32, fontSize: 14 }}>
                {t?.('status.archiveEmpty') || 'Nenhum status arquivado'}
              </Text>
            ) : (
              <ScrollView>
                {/* Grid of archived rows — 3 cols on phone, more on
                    tablet. Each tile shows the media thumb (or bg color
                    for text statuses) + a tiny date. Long-press fires
                    repost confirm; short-press is a no-op (we don't
                    want to re-publish on accident from a tap). */}
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                  {archiveItems.map((item) => {
                    const isVideo = item.type === 'video';
                    const isText = item.type === 'text';
                    const mediaUrl = (item.media_url || '').split('\n')[0];
                    const fullUrl = mediaUrl.startsWith('/') ? `${BASE_URL}${mediaUrl}` : mediaUrl;
                    const dt = item.archived_at || item.created_at || '';
                    const dateLabel = (() => {
                      try {
                        const d = new Date(dt);
                        return d.toLocaleDateString();
                      } catch { return ''; }
                    })();
                    return (
                      <TouchableOpacity
                        key={item.id}
                        onLongPress={() => {
                          const doRepost = async () => {
                            const out = await repostMyStatus(item.id);
                            if (out?.status_id) {
                              setArchiveSheetOpen(false);
                            }
                          };
                          if (Platform.OS === 'web') {
                            if (typeof window !== 'undefined' && window.confirm(t?.('status.repostConfirm') || 'Repostar este status?')) doRepost();
                          } else {
                            Alert.alert(
                              t?.('status.repostTitle') || 'Repostar',
                              t?.('status.repostConfirm') || 'Publicar este status de novo por mais 24h?',
                              [
                                { text: t?.('common.cancel') || 'Cancelar', style: 'cancel' },
                                { text: t?.('status.repost') || 'Repostar', onPress: doRepost },
                              ]
                            );
                          }
                        }}
                        delayLongPress={300}
                        activeOpacity={0.7}
                        style={{
                          width: '31%',
                          aspectRatio: 0.6,
                          borderRadius: 12,
                          overflow: 'hidden',
                          backgroundColor: isText ? (item.background || '#6D28D9') : (isDark ? '#0f0f1e' : '#f3f4f6'),
                          position: 'relative',
                        }}
                      >
                        {isText ? (
                          <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8 }}>
                            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700', textAlign: 'center' }} numberOfLines={6}>
                              {item.content || ''}
                            </Text>
                          </View>
                        ) : fullUrl ? (
                          <Image
                            source={{ uri: fullUrl }}
                            style={{ flex: 1 }}
                            resizeMode="cover"
                          />
                        ) : null}
                        {/* Date stripe at bottom — gives the user the
                            same chronological context Instagram archive
                            grid has. */}
                        <View style={{
                          position: 'absolute', bottom: 0, left: 0, right: 0,
                          paddingHorizontal: 6, paddingVertical: 4,
                          backgroundColor: 'rgba(0,0,0,0.55)',
                        }}>
                          <Text style={{ color: '#fff', fontSize: 10, fontWeight: '600' }} numberOfLines={1}>
                            {dateLabel}
                          </Text>
                        </View>
                        {isVideo ? (
                          <View style={{
                            position: 'absolute', top: 6, right: 6,
                            width: 18, height: 18, borderRadius: 9,
                            backgroundColor: 'rgba(0,0,0,0.55)',
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            <IconPlay size={10} color="#fff" />
                          </View>
                        ) : null}
                      </TouchableOpacity>
                    );
                  })}
                </View>
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
        {/* Force translucent system bar inside the composer so the camera/photo
            renders behind clock+wifi+battery, while the header below pushes
            down by `insets.top` to clear them. Fixes Android-only overlap
            where the close (X) button sat under the system bar on Pixel/Galaxy
            devices. iOS already had the 54pt baseline so this is a no-op there
            (translucent on iOS just keeps the existing default). */}
        <StatusBar translucent backgroundColor="transparent" barStyle="light-content" />
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
          {/* ─── Music Picker (rendered INSIDE creator modal to avoid iOS stacking issues) ─── */}
          {musicPickerVisible ? (
            <View style={{ flex: 1, backgroundColor: isDark ? '#1a1a2e' : '#fff' }}>
              {/* Header with back button — same Android translucent fix as
                  the parent composer header. Uses runtime insets.top instead
                  of the stale ANDROID_TOP_INSET module-load constant. */}
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingTop: Platform.OS === 'android' ? insets.top + 8 : (insets.top || 54), paddingBottom: 12, borderBottomWidth: 1, borderBottomColor: isDark ? 'rgba(255,255,255,0.1)' : '#e5e7eb' }}>
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
                      <CachedImage source={{ uri: track.coverUrl }} style={{ width: 50, height: 50, borderRadius: 6 }} />
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
          <View style={[styles.creatorContainer, {
            // When a gradient preset is selected (textBgColor is a
            // `gradient:<id>` token), we paint via SVG below and let the
            // container stay transparent so the gradient bleeds to the
            // edges. Plain hex colors keep the legacy backgroundColor path.
            backgroundColor: creatorMode === 'photo'
              ? '#000'
              : (resolveGradient(textBgColor) ? '#000' : textBgColor),
          }]}>
            {/* Gradient background layer — only painted in text mode when
                the user picked a multi-stop preset. Renders behind everything
                else (pattern overlay + body + header) via absoluteFill.
                react-native-svg's <Svg> needs an explicit width/height pair
                or preserveAspectRatio="none" to stretch — we use the latter
                so the gradient fills any phone size without measuring. */}
            {creatorMode === 'text' && (() => {
              const g = resolveGradient(textBgColor);
              if (!g) return null;
              const stops = g.colors.length > 1 ? g.colors : [g.colors[0], g.colors[0]];
              return (
                <Svg
                  pointerEvents="none"
                  style={StyleSheet.absoluteFill}
                  preserveAspectRatio="none"
                  viewBox="0 0 1 1"
                >
                  <Defs>
                    <LinearGradient id={`textBgGrad_${g.id}`} x1="0" y1="0" x2="1" y2="1">
                      {stops.map((c, i) => (
                        <Stop key={i} offset={`${Math.round((i / (stops.length - 1)) * 100)}%`} stopColor={c} stopOpacity="1" />
                      ))}
                    </LinearGradient>
                  </Defs>
                  <Rect x="0" y="0" width="1" height="1" fill={`url(#textBgGrad_${g.id})`} />
                </Svg>
              );
            })()}
            {/* Subtle pattern overlay for text mode */}
            {creatorMode === 'text' && (
              <View style={styles.creatorPatternOverlay} pointerEvents="none" />
            )}

            {/* Composer header — override the stylesheet's static paddingTop
                with the runtime safe-area inset so the X / Save / Music row
                always clears clock+wifi+battery on Android (Pixel/Galaxy
                edge-to-edge windows where StatusBar.currentHeight reads 0
                until measurement settles). +8 nudges it off the edge for
                breathing room; iOS keeps its prior 54pt baseline. */}
            <View style={[
              styles.creatorHeader,
              { paddingTop: Platform.OS === 'android' ? insets.top + 8 : (insets.top || 54) },
            ]}>
              <TouchableOpacity onPress={() => { setCreatorVisible(false); setMusicPickerVisible(false); setPhotoFilter('normal'); setStickers([]); setShowStickerPicker(false); setTextOverlays([]); setShowAddTextInput(false); setDrawMode(false); setDrawPaths([]); resetHistory(); setExceptEmails([]); setExceptPickerVisible(false); }} style={styles.creatorCloseBtn}>
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

              {/* Text animation picker — cycles none → bounce → fade →
                  typewriter. The label is a short glyph so the header doesn't
                  grow on phones with tight horizontal space. */}
              {creatorMode === 'text' && (
                <TouchableOpacity
                  onPress={() => {
                    const anims = ['none', 'bounce', 'fade', 'typewriter'];
                    const idx = anims.indexOf(textAnimation);
                    setTextAnimation(anims[(idx + 1) % anims.length]);
                  }}
                  style={styles.fontToggleBtn}
                  activeOpacity={0.7}
                  accessibilityLabel={t?.('status.textAnimation') || 'Animação de texto'}
                >
                  <Text style={styles.fontToggleText}>
                    {textAnimation === 'none' ? '—'
                      : textAnimation === 'bounce' ? '✨'
                      : textAnimation === 'fade' ? '◐'
                      : '▌'}
                  </Text>
                </TouchableOpacity>
              )}

              {/* Privacy toggle — cycles through 4 audiences:
                  All → Contacts → Close Friends → Except.
                  Close Friends shows in green to mirror Instagram's
                  green-ring story tier. */}
              <TouchableOpacity
                onPress={() => {
                  const privacyOptions = ['all', 'contacts', 'close_friends', 'except'];
                  const idx = privacyOptions.indexOf(statusPrivacy);
                  const nextPrivacy = privacyOptions[(idx + 1) % privacyOptions.length];
                  setStatusPrivacy(nextPrivacy);
                  // When the user lands on "except" via the cycle, surface the
                  // picker right away so they don't have to discover a second
                  // tap. Skipped on the same-mode tap.
                  if (nextPrivacy === 'except') setExceptPickerVisible(true);
                }}
                onLongPress={() => {
                  // Long-press the chip while on "except" to re-open the
                  // picker without cycling the whole audience wheel.
                  if (statusPrivacy === 'except') setExceptPickerVisible(true);
                  // Long-press while on "close_friends" routes to the
                  // dedicated list management screen so the user can edit
                  // their persisted close-friends roster (chat_close_friends).
                  // We close the composer first so the navigation lands on
                  // a clean stack — the publish UI is in a Modal that would
                  // otherwise sit on top of the manager screen.
                  if (statusPrivacy === 'close_friends' && router) {
                    setCreatorVisible(false);
                    setTimeout(() => { try { router.push('/close-friends'); } catch {} }, 140);
                  }
                }}
                style={styles.privacyToggleBtn}
                activeOpacity={0.7}
              >
                {statusPrivacy === 'all' ? (
                  <IconEye size={18} color="#fff" />
                ) : statusPrivacy === 'contacts' ? (
                  <IconEye size={18} color={ACCENT} />
                ) : statusPrivacy === 'close_friends' ? (
                  <IconEye size={18} color="#22C55E" />
                ) : (
                  <IconEye size={18} color="#FF6B6B" />
                )}
                <Text style={styles.privacyToggleText}>
                  {statusPrivacy === 'all' ? (t?.('status.privacyAll') || 'All')
                    : statusPrivacy === 'contacts' ? (t?.('status.privacyContacts') || 'Contacts')
                    : statusPrivacy === 'close_friends' ? (t?.('status.closeFriends') || 'Close friends')
                    : (t?.('status.privacyExcept') || 'Except') + (exceptEmails.length > 0 ? ` (${exceptEmails.length})` : '')}
                </Text>
              </TouchableOpacity>

              <View style={{ flex: 1 }} />
              {creatorMode === 'text' && (
                <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.colorPicker}>
                  {/* Gradient presets — painted first so the user discovers
                      the multi-stop options without scrolling. Each dot is
                      a mini SVG with the same LinearGradient the full canvas
                      will render — preview-by-thumbnail beats a guessing UX.
                      Selection serializes as `gradient:<id>` so the backend
                      stores it in chat_user_status.bg_color verbatim. */}
                  {TEXT_BG_GRADIENTS.map((g) => {
                    const token = `gradient:${g.id}`;
                    const selected = textBgColor === token;
                    const stops = g.colors.length > 1 ? g.colors : [g.colors[0], g.colors[0]];
                    return (
                      <TouchableOpacity
                        key={g.id}
                        onPress={() => setTextBgColor(token)}
                        style={[
                          styles.colorDot,
                          { backgroundColor: 'transparent', overflow: 'hidden' },
                          selected && styles.colorDotSelected,
                        ]}
                        accessibilityLabel={`${t?.('status.textBg.gradients') || 'Gradientes'}: ${g.id}`}
                      >
                        <Svg
                          width="100%"
                          height="100%"
                          viewBox="0 0 1 1"
                          preserveAspectRatio="none"
                          style={StyleSheet.absoluteFill}
                        >
                          <Defs>
                            <LinearGradient id={`pickerGrad_${g.id}`} x1="0" y1="0" x2="1" y2="1">
                              {stops.map((c, i) => (
                                <Stop key={i} offset={`${Math.round((i / (stops.length - 1)) * 100)}%`} stopColor={c} stopOpacity="1" />
                              ))}
                            </LinearGradient>
                          </Defs>
                          <Rect x="0" y="0" width="1" height="1" fill={`url(#pickerGrad_${g.id})`} />
                        </Svg>
                        {selected && <View style={styles.colorDotInner} />}
                      </TouchableOpacity>
                    );
                  })}
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
                      <CachedImage source={{ uri: photoUri }} style={styles.creatorPhoto} resizeMode="contain" />
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
                            <CachedImage source={{ uri: photoUri }} style={{ width: 62, height: 62 }} resizeMode="cover" />
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

              {/* Sticker + Text + Draw toolbar (photo mode).
                  SVG icons instead of emoji glyphs — OS-independent rendering,
                  matches the app icon system, and stays crisp on every pixel
                  density. iMessage-style pill with subtle shadow. */}
              {creatorMode === 'photo' && photoUri && (
                <View style={{ position: 'absolute', top: 8, right: 12, zIndex: 20, gap: 10 }}>
                  <TouchableOpacity
                    onPress={() => setShowStickerPicker(p => !p)}
                    style={editorToolBtnStyle}
                    accessibilityLabel="Stickers"
                    accessibilityRole="button"
                  >
                    <IconSmile size={22} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => { setShowAddTextInput(true); setNewOverlayText(''); }}
                    style={editorToolBtnStyle}
                    accessibilityLabel="Texto"
                    accessibilityRole="button"
                  >
                    <IconType size={22} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={() => setDrawMode(d => !d)}
                    style={[editorToolBtnStyle, drawMode && { backgroundColor: '#7C3AED' }]}
                    accessibilityLabel="Desenhar"
                    accessibilityRole="button"
                  >
                    <IconBrush size={22} color="#fff" />
                  </TouchableOpacity>
                  {/* Undo / Redo — unified across stickers, text overlays,
                      drawn strokes. The `historyVer` state bumps on every
                      mutation so this re-renders and reads `historyRef.current`
                      fresh. Greyed out when the corresponding stack is empty
                      instead of disappearing — keeps toolbar layout stable. */}
                  <TouchableOpacity
                    onPress={undoEdit}
                    style={[editorToolBtnStyle, { opacity: historyRef.current.past.length === 0 ? 0.35 : 1 }]}
                    accessibilityLabel="Desfazer"
                    accessibilityRole="button"
                    disabled={historyRef.current.past.length === 0}
                  >
                    <IconUndo2 size={20} color="#fff" />
                  </TouchableOpacity>
                  <TouchableOpacity
                    onPress={redoEdit}
                    style={[editorToolBtnStyle, { opacity: historyRef.current.future.length === 0 ? 0.35 : 1 }]}
                    accessibilityLabel="Refazer"
                    accessibilityRole="button"
                    disabled={historyRef.current.future.length === 0}
                  >
                    <IconRotateCw size={20} color="#fff" />
                  </TouchableOpacity>
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
                    // Snapshot BEFORE the stroke starts so undo collapses the
                    // whole stroke, not point-by-point. recordEdit captures
                    // the pre-stroke state; the move handler appends.
                    recordEdit();
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
                          recordEdit();
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
                        { key: 'poll', Icon: IconBarChart, label: t?.('status.stickerPoll') || 'Enquete' },
                        { key: 'question', Icon: IconHelpCircle, label: t?.('status.stickerQuestion') || 'Pergunta' },
                        { key: 'slider', Icon: IconSliders, label: t?.('status.stickerSlider') || 'Slider' },
                        { key: 'countdown', Icon: IconClock, label: t?.('status.stickerCountdown') || 'Contagem' },
                        { key: 'mention', Icon: IconAtSign, label: t?.('status.stickerMention') || 'Menção' },
                        { key: 'quiz', Icon: IconAward, label: t?.('status.stickerQuiz') || 'Quiz' },
                        { key: 'location', Icon: IconMapPin, label: t?.('status.stickerLocation') || 'Local' },
                        { key: 'link', Icon: IconLink, label: t?.('status.stickerLink') || 'Link' },
                        // 'gif' opens an inline GifPickerPanel modal (reuses the
                        // chat composer's GIF picker). Uses IconSearch as a
                        // generic stand-in since there's no IconGif in Icons.js.
                        { key: 'gif', Icon: IconSearch, label: t?.('status.stickerGif') || 'GIF' },
                      ].map(s => (
                        <TouchableOpacity key={s.key} onPress={() => {
                          if (s.key === 'link') {
                            // Don't close the picker — swap to the link prompt
                            // panel below so the user can enter URL + optional
                            // CTA label without losing context.
                            setLinkPromptUrl('');
                            setLinkPromptLabel('');
                            setLinkPromptVisible(true);
                            return;
                          }
                          if (s.key === 'gif') {
                            // Pop the GIF search modal. We close the sticker
                            // picker so the GIF picker has full screen height
                            // (its FlatList is internally scrollable).
                            setShowStickerPicker(false);
                            setGifPickerVisible(true);
                            return;
                          }
                          setShowStickerPicker(false);
                          // Snapshot BEFORE the sticker drop so a single undo
                          // removes it cleanly. recordEdit captures current
                          // state; the mutation below replaces it.
                          recordEdit();
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
                          } else if (s.key === 'slider') {
                            // Slider sticker. `emoji` is the indicator that
                            // rides the track in the viewer; `preview` is
                            // just the composer thumbnail position (50 = mid).
                            setStickers(prev => [...prev, { id: Date.now(), type: 'slider', x: 40, y: 200, question: t?.('status.sliderDefaultQuestion') || 'Quão concorda?', emoji: '🔥', preview: 50 }]);
                          } else if (s.key === 'location') {
                            setStickers(prev => [...prev, { id: Date.now(), emoji: '📍', x: 100 + Math.random() * 80, y: 150 + Math.random() * 150 }]);
                          }
                        }} style={{ width: 72, height: 62, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)', borderRadius: 10, padding: 4 }}>
                          <s.Icon size={22} color="#fff" />
                          <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 9, marginTop: 4, fontWeight: '600' }}>{s.label}</Text>
                        </TouchableOpacity>
                      ))}
                    </View>

                    {/* Link sticker prompt — shown inside the picker after the
                        "Link" tile is tapped. URL is required + validated;
                        label is optional and defaults to "Saiba mais". */}
                    {linkPromptVisible && (
                      <View style={{
                        backgroundColor: 'rgba(255,255,255,0.08)',
                        borderRadius: 10, padding: 12, marginBottom: 14,
                      }}>
                        <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10, fontWeight: '700', marginBottom: 6, letterSpacing: 0.5 }}>
                          URL
                        </Text>
                        <TextInput
                          value={linkPromptUrl}
                          onChangeText={setLinkPromptUrl}
                          placeholder="chatyy.com.br ou https://..."
                          placeholderTextColor="rgba(255,255,255,0.35)"
                          autoCapitalize="none"
                          autoCorrect={false}
                          keyboardType="url"
                          style={{
                            color: '#fff', fontSize: 13,
                            backgroundColor: 'rgba(0,0,0,0.35)',
                            borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8,
                            ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
                          }}
                        />
                        <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 10, fontWeight: '700', marginTop: 10, marginBottom: 6, letterSpacing: 0.5 }}>
                          BOTÃO (OPCIONAL)
                        </Text>
                        <TextInput
                          value={linkPromptLabel}
                          onChangeText={setLinkPromptLabel}
                          placeholder="Saiba mais"
                          placeholderTextColor="rgba(255,255,255,0.35)"
                          maxLength={28}
                          style={{
                            color: '#fff', fontSize: 13,
                            backgroundColor: 'rgba(0,0,0,0.35)',
                            borderRadius: 8, paddingHorizontal: 10, paddingVertical: 8,
                            ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}),
                          }}
                        />
                        <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                          <TouchableOpacity
                            onPress={() => { setLinkPromptVisible(false); setLinkPromptUrl(''); setLinkPromptLabel(''); }}
                            style={{ flex: 1, paddingVertical: 9, borderRadius: 8, backgroundColor: 'rgba(255,255,255,0.12)', alignItems: 'center' }}
                          >
                            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>{t?.('common.cancel') || 'Cancelar'}</Text>
                          </TouchableOpacity>
                          <TouchableOpacity
                            disabled={!isValidStickerUrl(linkPromptUrl)}
                            onPress={() => {
                              if (!isValidStickerUrl(linkPromptUrl)) return;
                              const url = String(linkPromptUrl || '').trim();
                              const label = String(linkPromptLabel || '').trim();
                              recordEdit();
                              setStickers(prev => [...prev, {
                                id: Date.now(),
                                type: 'link',
                                x: 60, y: 220,
                                url,
                                label: label || 'Saiba mais',
                              }]);
                              setLinkPromptVisible(false);
                              setLinkPromptUrl('');
                              setLinkPromptLabel('');
                              setShowStickerPicker(false);
                            }}
                            style={{
                              flex: 1, paddingVertical: 9, borderRadius: 8,
                              backgroundColor: isValidStickerUrl(linkPromptUrl) ? '#7C3AED' : 'rgba(124,58,237,0.35)',
                              alignItems: 'center',
                            }}
                          >
                            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '700' }}>{t?.('common.add') || 'Adicionar'}</Text>
                          </TouchableOpacity>
                        </View>
                      </View>
                    )}

                    {/* Emoji stickers */}
                    <Text style={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, fontWeight: '700', marginBottom: 8, letterSpacing: 0.5 }}>EMOJIS</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                      {['😂','❤️','🔥','👏','🎉','😍','🥺','💀','🤩','😎','🥳','💯','🙌','✨','💕','🦋','🌈','⭐','🎵','📍','⏰','🗓️'].map(em => (
                        <TouchableOpacity key={em} onPress={() => {
                          recordEdit();
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
                  <CachedImage source={{ uri: selectedMusic.coverUrl }} style={styles.selectedMusicCover} />
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

            {/* Cross-post-to-Feed toggle — only meaningful for media stories.
                Keeps the publish flow single-tap (default off); user has to
                consciously opt in so a normally-private story doesn't leak
                into the public Feed accidentally. */}
            {(creatorMode === 'photo' || creatorMode === 'video') && (
              <TouchableOpacity
                onPress={() => setCrossPostFeed(v => !v)}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  paddingVertical: 10, paddingHorizontal: 14,
                  backgroundColor: 'rgba(255,255,255,0.06)',
                  borderRadius: 12, marginHorizontal: 12, marginTop: 6,
                }}
                activeOpacity={0.7}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: crossPostFeed }}
                accessibilityLabel={t?.('status.crossPostFeed') || 'Postar também no Feed'}
              >
                {crossPostFeed ? <IconCheckboxChecked size={20} color="#7C3AED" /> : <IconCheckbox size={20} color="rgba(255,255,255,0.5)" />}
                <IconFeedShare size={16} color="rgba(255,255,255,0.85)" />
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 }}>
                  {t?.('status.crossPostFeed') || 'Postar também no Feed'}
                </Text>
              </TouchableOpacity>
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

      {/* "Hide from…" multi-select sheet — appears when the user picks
          privacy=except. Lists the contact rows from the home strip plus
          any extra contacts we know about. Tap to toggle inclusion. The
          chosen emails travel to status_create as `except_emails` and are
          stored in meta so status_list filters them out per viewer. */}
      <Modal
        visible={exceptPickerVisible}
        transparent
        animationType="slide"
        onRequestClose={() => setExceptPickerVisible(false)}
      >
        <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}>
          <View style={{
            backgroundColor: isDark ? '#1A0F2E' : '#fff',
            borderTopLeftRadius: 22, borderTopRightRadius: 22,
            paddingHorizontal: 18, paddingTop: 14, paddingBottom: 28,
            maxHeight: '72%',
          }}>
            <View style={{
              alignSelf: 'center', width: 38, height: 4, borderRadius: 2,
              backgroundColor: isDark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.2)',
              marginBottom: 14,
            }} />
            <Text style={{ color: isDark ? '#fff' : '#111', fontSize: 17, fontWeight: '800', marginBottom: 4 }}>
              {t?.('status.hideFromListTitle') || 'Ocultar este status de:'}
            </Text>
            <Text style={{ color: isDark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.55)', fontSize: 12, marginBottom: 12 }}>
              {(contactStatuses?.length || 0) === 0
                ? (t?.('status.hideFromListEmpty') || 'Toque em contatos para ocultar deles.')
                : `${exceptEmails.length} ${(t?.('status.selectedCount') || 'selecionado(s)')}`}
            </Text>
            <FlatList
              data={contactStatuses || []}
              keyExtractor={(g) => String(g.ownerEmail || g.email || Math.random())}
              renderItem={({ item }) => {
                const em = String(item.ownerEmail || item.email || '').toLowerCase();
                const nm = item.ownerName || item.name || em.split('@')[0] || em;
                const sel = exceptEmails.includes(em);
                return (
                  <TouchableOpacity
                    onPress={() => {
                      setExceptEmails(prev => prev.includes(em)
                        ? prev.filter(e => e !== em)
                        : [...prev, em]);
                    }}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 12,
                      paddingVertical: 10,
                    }}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: sel }}
                  >
                    <View style={{
                      width: 22, height: 22, borderRadius: 11,
                      borderWidth: 2,
                      borderColor: sel ? '#FF6B6B' : (isDark ? 'rgba(255,255,255,0.35)' : 'rgba(0,0,0,0.3)'),
                      backgroundColor: sel ? '#FF6B6B' : 'transparent',
                      alignItems: 'center', justifyContent: 'center',
                    }}>
                      {sel ? <Text style={{ color: '#fff', fontWeight: '900', fontSize: 14 }}>{'✓'}</Text> : null}
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={{ color: isDark ? '#fff' : '#111', fontSize: 15, fontWeight: '600' }} numberOfLines={1}>
                        {nm}
                      </Text>
                      <Text style={{ color: isDark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)', fontSize: 12 }} numberOfLines={1}>
                        {em}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              }}
            />
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 12 }}>
              <TouchableOpacity
                onPress={() => { setExceptEmails([]); }}
                style={{
                  flex: 1, paddingVertical: 12, borderRadius: 22,
                  backgroundColor: isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)',
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: isDark ? '#fff' : '#111', fontWeight: '700' }}>
                  {t?.('common.clear') || 'Limpar'}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setExceptPickerVisible(false)}
                style={{
                  flex: 1, paddingVertical: 12, borderRadius: 22,
                  backgroundColor: '#7C3AED',
                  alignItems: 'center',
                }}
              >
                <Text style={{ color: '#fff', fontWeight: '800' }}>
                  {t?.('common.done') || 'Pronto'}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
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
    gap: 8,
  },
  storyItem: {
    alignItems: 'center',
    width: 80,
    marginRight: 8,
  },
  storyAvatarWrap: {
    position: 'relative',
    marginBottom: 6,
  },
  // Tiny ♪ pill in the top-right of the avatar wrap when the status carries
  // music. Same accent color as the active gradient ring so it reads as part
  // of the story visual language.
  storyMusicBadge: {
    position: 'absolute',
    top: -2,
    right: -2,
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#fff',
    zIndex: 2,
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
    paddingHorizontal: 22,
    paddingVertical: 22,
  },
  myAvatarWrapper: { position: 'relative' },
  // Hero tile wrapper — 96px circular avatar with breathing room for the
  // 108px outer ring (dashed empty / solid gradient active). Centered so
  // the dashed ring doesn't get clipped by the surrounding card.
  myAvatarWrapperHero: {
    position: 'relative',
    width: 96,
    height: 96,
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Bigger plus badge for the 96px hero avatar — centered on the bottom-
  // right edge, with shadow to lift it above the dashed ring.
  plusBadgeHero: {
    position: 'absolute',
    bottom: 0,
    right: 0,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: ACCENT,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 3,
    ...Platform.select({
      ios: { shadowColor: ACCENT, shadowOffset: { width: 0, height: 2 }, shadowOpacity: 0.4, shadowRadius: 5 },
      android: { elevation: 5 },
      web: { boxShadow: '0 2px 8px rgba(124,58,237,0.4)' },
    }),
  },
  // "Quem viu" pill — sits under the name/sub on the hero card. Soft
  // tinted background + thin border so it reads as informational rather
  // than as a button.
  viewCountPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 5,
    paddingHorizontal: 9,
    paddingVertical: 4,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    marginTop: 8,
  },
  viewCountPillText: {
    color: ACCENT,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
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
  // Why: tightened segment gap (4→3) so progress reads as a continuous strip,
  // matched Instagram. Bumped track height (3→3.5) and lifted the empty-state
  // tint slightly (0.18→0.22) so unwatched segments don't disappear on
  // bright media.
  progressBarRow: {
    flexDirection: 'row',
    paddingHorizontal: 10,
    paddingTop: Platform.OS === 'ios' ? 54 : ANDROID_TOP_INSET + 10,
    gap: 3,
  },
  progressBarTrack: {
    flex: 1,
    height: 3.5,
    backgroundColor: 'rgba(255,255,255,0.22)',
    borderRadius: 2,
    overflow: 'hidden',
  },
  // Story progress bar — gradient + glow on web. Solid white on
  // native (RN can't render inline gradient cheaply). Tech feel.
  progressBarFill: {
    height: '100%',
    backgroundColor: '#fff',
    borderRadius: 2,
    ...(Platform.OS === 'web' ? {
      backgroundImage: 'linear-gradient(90deg, rgba(255,255,255,0.85), #fff)',
      boxShadow: '0 0 8px rgba(255,255,255,0.55)',
    } : {}),
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
    // Cap height so a long caption never blocks the reply input or runs
    // off the bottom on small screens. Triple line max — anything longer
    // truncates with ellipsis, matching Instagram Stories.
    maxHeight: 110,
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
    paddingTop: Platform.OS === 'ios' ? 54 : ANDROID_TOP_INSET + 12,
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
