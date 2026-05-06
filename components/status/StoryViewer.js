// StoryViewer — full-screen status playback modal.
//
// Single canonical viewer for every status surface: profile (story ring around
// avatar), chat list home (status circle row), and the dedicated Status tab
// (deferred — ChatStatusTab has 50+ specialized state hooks tied to
// reactions/forward/highlights/translate that we'll fold in next wave).
//
// Wave 4 (2026-05-06) — absorbed ChatListTab's inline Modal viewer:
//   - caption overlay with glass surface
//   - music indicator (title + artist)
//   - tappable "Seen by N" pill on own stories with inline viewers sheet
//   - gradient animated progress bars
//   - avatar + timestamp in header
//   - markViewed hook integration via onMarkViewed callback
//
// All extras gated by props so callers don't pay for what they don't use.

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, Pressable, Image,
  Platform, Modal, Alert, Animated, Keyboard, FlatList, ActivityIndicator,
  PanResponder,
} from 'react-native';
import * as api from '../../services/api';
import { BASE_URL } from '../../services/api';
import { IconX, IconPlus, IconTrash, IconSend, IconCheck, IconMessageSquare, IconEye, IconMusic } from '../Icons';
import AvatarCircle from '../AvatarCircle';

const WEB = Platform.OS === 'web';
const STORY_DURATION_MS = 5000;

let _ExpoImage = null;
try { _ExpoImage = require('expo-image').Image; } catch {}

let _Haptics = null;
try { _Haptics = require('expo-haptics'); } catch {}

let _cacheMedia = null;
try { _cacheMedia = require('../../services/mediaCache').cacheMedia; } catch {}

// Resolve any media-ish URL (relative path, R2, signed URL) to a fully-qualified
// URL the platform can fetch. Mirrors the inline logic in renderMedia so the
// pre-cache pass and poster lookup don't drift out of sync.
function _resolveUrl(raw) {
  if (!raw) return '';
  const s = String(raw).split('\n')[0];
  return s.startsWith('http') ? s : `${BASE_URL}${s}`;
}

// Format "h ago / d ago" — same logic ChatListTab used inline. PG returns
// "2026-04-22 01:30:00.123+00" which Safari can't parse, so we normalize.
function formatRelTime(createdAt, t) {
  try {
    let iso = String(createdAt || '').replace(' ', 'T');
    iso = iso.replace(/([+-]\d{2})$/, '$1:00');
    const d = new Date(iso);
    const ms = d.getTime();
    if (!Number.isFinite(ms)) return '';
    const h = Math.round((Date.now() - ms) / 3600000);
    if (h < 1) return t?.('time.now') || 'Agora';
    if (h < 24) return `${h}h`;
    return `${Math.floor(h / 24)}d`;
  } catch { return ''; }
}

function formatViewedAt(viewedAt) {
  try {
    let iso = String(viewedAt || '').replace(' ', 'T');
    iso = iso.replace(/([+-]\d{2})$/, '$1:00');
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

export default function StoryViewer({
  visible,
  stories: storiesProp,
  startIdx,
  ownerName,
  ownerEmail,
  onClose,
  isSelf = false,
  onDelete,
  onAddMore,
  onReply,
  onReact,
  // New (Wave 4) — optional viewers sheet integration. When provided, the
  // own-status "Seen by N" pill becomes tappable and pops the inline list.
  onSeenByPress,        // fn(item) → caller fetches list and sets viewersList
  viewersFor,           // item currently being inspected (or null)
  viewersList = [],     // [{ email, name, viewed_at }]
  viewersLoading = false,
  onCloseViewers,       // fn() → caller clears viewersFor
  onMarkViewed,         // fn(itemId) → caller updates hook cache for instant ring collapse
  // Theming for the bottom sheet (defaults handle 95% of cases)
  isDark = false,
  t,
}) {
  const stories = Array.isArray(storiesProp) ? storiesProp : [];
  const [idx, setIdx] = useState(startIdx || 0);
  const [paused, setPaused] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const [replySent, setReplySent] = useState(false);
  const [reactPop, setReactPop] = useState(null);
  const [emojiPulse, setEmojiPulse] = useState(null); // emoji currently scaling (UI feedback)

  const keyboardOffset = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!visible) return undefined;
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e) => {
      const h = e?.endCoordinates?.height || 0;
      Animated.timing(keyboardOffset, {
        toValue: -h, duration: e?.duration || 250, useNativeDriver: true,
      }).start();
    };
    const onHide = (e) => {
      Animated.timing(keyboardOffset, {
        toValue: 0, duration: e?.duration || 250, useNativeDriver: true,
      }).start();
    };
    const s = Keyboard.addListener(showEvt, onShow);
    const h = Keyboard.addListener(hideEvt, onHide);
    return () => { s.remove(); h.remove(); };
  }, [visible, keyboardOffset]);

  const progressRef = useRef(new Animated.Value(0));
  const animRef = useRef(null);
  const viewedIdsRef = useRef(new Set());
  const boomerangRef = useRef(null);
  const boomerangStateRef = useRef({ reversing: false });

  // Wave 4 modernization (2026-05-06): subtle entrance scale so the modal
  // pops in instead of just fading. iOS Stories has the same micro-spring.
  // Native driver makes it free even on low-end Android.
  const entranceScale = useRef(new Animated.Value(0.94)).current;
  useEffect(() => {
    if (!visible) { entranceScale.setValue(0.94); return; }
    Animated.spring(entranceScale, {
      toValue: 1,
      friction: 8,
      tension: 90,
      useNativeDriver: true,
    }).start();
  }, [visible, entranceScale]);

  // Crossfade between stories — opacity ramps 0 → 1 on idx change so the
  // transition isn't a hard cut. Reset to 0 in same effect that clears the
  // progress so paint doesn't flash the previous frame at full opacity.
  const itemOpacity = useRef(new Animated.Value(1)).current;

  // Swipe-down to close — Instagram pattern. PanResponder tracks the drag
  // distance, fades the modal as the user pulls, and either snaps back or
  // closes on release. Vertical-only: horizontal taps still hit the prev/next
  // pressables underneath.
  const dragY = useRef(new Animated.Value(0)).current;
  const dragOpacity = dragY.interpolate({
    inputRange: [0, 200, 400],
    outputRange: [1, 0.5, 0],
    extrapolate: 'clamp',
  });
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_evt, gs) => {
        // Only claim vertical drags > 12px, so taps + horizontal scrolls keep working.
        return Math.abs(gs.dy) > 12 && Math.abs(gs.dy) > Math.abs(gs.dx) * 1.5 && gs.dy > 0;
      },
      onPanResponderGrant: () => { setPaused(true); },
      onPanResponderMove: (_evt, gs) => {
        if (gs.dy >= 0) dragY.setValue(gs.dy);
      },
      onPanResponderRelease: (_evt, gs) => {
        if (gs.dy > 120 || gs.vy > 0.6) {
          Animated.timing(dragY, { toValue: 600, duration: 180, useNativeDriver: true })
            .start(() => { dragY.setValue(0); onClose?.(); });
        } else {
          Animated.spring(dragY, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
          setPaused(false);
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start();
        setPaused(false);
      },
    })
  ).current;

  const _haptic = useCallback((style = 'light') => {
    if (!_Haptics || Platform.OS === 'web') return;
    try {
      const map = {
        light: _Haptics.ImpactFeedbackStyle?.Light,
        medium: _Haptics.ImpactFeedbackStyle?.Medium,
      };
      _Haptics.impactAsync(map[style] || map.light);
    } catch {}
  }, []);

  useEffect(() => {
    if (visible) {
      setIdx(Math.min(Math.max(0, startIdx || 0), Math.max(0, (stories?.length || 1) - 1)));
      setPaused(false);
    }
  }, [visible, startIdx, stories?.length]);

  const advance = useCallback(() => {
    setIdx(prev => {
      if (prev < (stories?.length || 0) - 1) return prev + 1;
      onClose?.();
      return prev;
    });
  }, [stories, onClose]);

  useEffect(() => {
    if (!visible) return;
    const cur = stories?.[idx];
    if (!cur) return;
    progressRef.current.setValue(0);
    // Crossfade the new item in from 0 → 1 (200ms). Skips on the first paint
    // because itemOpacity already starts at 1 from the ref init.
    itemOpacity.setValue(0);
    Animated.timing(itemOpacity, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    if (cur.id && !viewedIdsRef.current.has(cur.id)) {
      viewedIdsRef.current.add(cur.id);
      try { api.statusView?.(cur.id); } catch {}
      try { onMarkViewed?.(cur.id); } catch {}
    }
    // Pre-cache the NEXT story while this one is playing — eliminates the
    // micro-buffering that used to flash between stories. Cheap: cacheMedia
    // dedupes by URL, so re-visits hit the disk cache. Web skipped (browser
    // already handles HTTP caching for <video>/<img>).
    if (Platform.OS !== 'web' && _cacheMedia) {
      const next = stories?.[idx + 1];
      const nextRaw = next?.media_url
        || ((next?.type === 'image' || next?.type === 'video') && /^(\/|https?:\/\/)/.test(String(next?.content || ''))
            ? next.content : '');
      const nextUrl = _resolveUrl(nextRaw);
      if (nextUrl) { _cacheMedia(nextUrl).catch(() => {}); }
      // Also pre-cache the next item's poster for instant first-frame render.
      const nextThumb = _resolveUrl(next?.thumbnail_url);
      if (nextThumb) { _cacheMedia(nextThumb).catch(() => {}); }
    }
    if (cur.type === 'video') return;
    if (paused) return;
    animRef.current = Animated.timing(progressRef.current, {
      toValue: 1,
      duration: STORY_DURATION_MS,
      useNativeDriver: false,
    });
    animRef.current.start(({ finished }) => {
      if (finished) advance();
    });
    return () => { animRef.current?.stop?.(); };
  }, [visible, idx, paused, stories, advance, onMarkViewed, itemOpacity]);

  useEffect(() => {
    if (visible && (!stories || stories.length === 0)) {
      const t = setTimeout(() => onClose?.(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [visible, stories?.length, onClose]);

  if (!visible) return null;
  if (!stories.length) return null;
  const safeIdx = Math.min(Math.max(0, idx), stories.length - 1);
  const cur = stories[safeIdx];
  if (!cur) return null;

  const isImage = cur.type === 'image';
  const isVideo = cur.type === 'video';
  const isText = cur.type === 'text';

  // Caption: text status uses `content` AS the caption-rendered-as-big-text
  // (handled in renderMedia below). Image/video status uses `content` as
  // CAPTION OVERLAY on top of the media. Legacy rows had URL in `content`
  // followed by \n + caption — split if we detect that shape.
  const raw = cur.content || '';
  const legacyMediaInContent = (isImage || isVideo) && /^(\/|https?:\/\/)/.test(raw);
  const caption = legacyMediaInContent
    ? (raw.includes('\n') ? raw.split('\n').slice(1).join('\n').trim() : '')
    : ((isImage || isVideo) ? raw.trim() : '');

  const rawMedia = cur.media_url
    || ((isImage || isVideo) && legacyMediaInContent
        ? raw.split('\n')[0]
        : '');
  const mediaUrl = rawMedia ? (rawMedia.startsWith('http') ? rawMedia : `${BASE_URL}${rawMedia}`) : '';

  const renderMedia = () => {
    if (isText) {
      return (
        <View style={{ flex: 1, backgroundColor: cur.bg_color || '#25D366', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800', textAlign: 'center', lineHeight: 34 }}>
            {cur.content || ''}
          </Text>
        </View>
      );
    }
    if (!mediaUrl) {
      return (
        <View style={{ flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 40, marginBottom: 12 }}>📷</Text>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16, fontWeight: '700', textAlign: 'center' }}>
            {t?.('status.unavailable') || 'Mídia indisponível'}
          </Text>
          <Text style={{ marginTop: 6, color: 'rgba(255,255,255,0.5)', fontSize: 12, textAlign: 'center' }}>
            {t?.('status.unavailableHint') || 'Esse status pode ter expirado ou foi removido.'}
          </Text>
        </View>
      );
    }
    if (isVideo) {
      const isBoomerang = !!cur.is_boomerang || !!cur?.meta?.is_boomerang;
      const boomerangLoopDurationMs = 7000;
      // Poster: backend stores .thumb.jpg next to status videos and surfaces
      // it via `thumbnail_url`. Painting it behind the <video> kills the black
      // flash before the first decoded frame lands. Falls back gracefully if
      // the field is absent (older statuses).
      const posterUrl = cur.thumbnail_url
        ? (cur.thumbnail_url.startsWith('http') ? cur.thumbnail_url : `${BASE_URL}${cur.thumbnail_url}`)
        : '';
      const PosterOverlay = posterUrl ? (
        <Image
          source={{ uri: posterUrl }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' }}
          resizeMode="contain"
        />
      ) : null;
      if (WEB) {
        return (
          <View style={{ flex: 1, backgroundColor: '#000' }}>
            {PosterOverlay}
            <video
              src={mediaUrl}
              autoPlay
              playsInline
              loop={isBoomerang}
              onEnded={isBoomerang ? undefined : advance}
              onLoadedMetadata={isBoomerang ? (() => setTimeout(advance, boomerangLoopDurationMs)) : undefined}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain', backgroundColor: 'transparent' }}
            />
          </View>
        );
      }
      // Prefer expo-video (SDK 55+); fall back to expo-av for older bundles.
      try {
        const { useVideoPlayer, VideoView } = require('expo-video');
        const InnerVideo = ({ uri }) => {
          const player = useVideoPlayer(uri, (p) => { try { p.loop = isBoomerang; p.muted = false; p.play(); } catch {} });
          useEffect(() => () => {
            try { player.pause?.(); } catch {}
            try { player.replace?.(null); } catch {}
            try { player.release?.(); } catch {}
          }, []); // eslint-disable-line react-hooks/exhaustive-deps
          return (
            <View style={{ flex: 1, backgroundColor: '#000' }}>
              {PosterOverlay}
              <VideoView player={player} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} contentFit="contain" nativeControls={false} />
            </View>
          );
        };
        return <InnerVideo uri={mediaUrl} />;
      } catch {}
      try {
        const V = require('expo-av').Video;
        return (
          <V
            ref={boomerangRef}
            source={{ uri: mediaUrl }}
            resizeMode="contain"
            shouldPlay={!paused}
            isLooping={isBoomerang}
            onLoad={isBoomerang ? (() => setTimeout(advance, boomerangLoopDurationMs)) : undefined}
            onPlaybackStatusUpdate={(s) => {
              if (!isBoomerang) { if (s?.didJustFinish) advance(); return; }
              try {
                if (s?.didJustFinish && boomerangRef?.current?.setPositionAsync) {
                  boomerangStateRef.current.reversing = !boomerangStateRef.current.reversing;
                  if (boomerangStateRef.current.reversing && s?.durationMillis) {
                    boomerangRef.current.setPositionAsync(Math.max(0, s.durationMillis - 50));
                  }
                }
              } catch {}
            }}
            style={{ width: '100%', height: '100%', backgroundColor: '#000' }}
          />
        );
      } catch {}
      return <Image source={{ uri: mediaUrl }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />;
    }
    if (_ExpoImage && !WEB) {
      return (
        <_ExpoImage
          source={{ uri: mediaUrl }}
          style={{ width: '100%', height: '100%' }}
          contentFit="contain"
          cachePolicy="memory-disk"
          transition={120}
        />
      );
    }
    return WEB
      ? <img src={mediaUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }} />
      : <Image source={{ uri: mediaUrl }} style={{ width: '100%', height: '100%' }} resizeMode="contain" />;
  };

  // Modern gradient progress bar — animates left-to-right with a soft glow.
  // Replaces the flat white bar. Uses Svg gradient + Animated Rect width.
  const renderProgressBars = () => (
    <View style={{
      position: 'absolute', top: Platform.OS === 'ios' ? 50 : 20, left: 0, right: 0,
      flexDirection: 'row', gap: 4, paddingHorizontal: 10, zIndex: 5,
    }}>
      {stories.map((_, i) => (
        <View key={i} style={{
          flex: 1, height: 3, backgroundColor: 'rgba(255,255,255,0.28)',
          borderRadius: 2, overflow: 'hidden',
        }}>
          {i < safeIdx && <View style={{ width: '100%', height: '100%', backgroundColor: '#fff' }} />}
          {i === safeIdx && (
            <Animated.View
              accessibilityLabel={`${t?.('status.progress') || 'Story'} ${safeIdx + 1} ${t?.('common.of') || 'de'} ${stories.length}`}
              accessibilityRole="progressbar"
              style={{
                height: '100%',
                width: progressRef.current.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                backgroundColor: 'transparent',
              }}
            >
              {/* Inner gradient overlay — simulates the iOS-style "gleam" via a
                  brighter trailing edge. Two stacked Views are cheaper than Svg
                  gradient for a tiny 3px bar. */}
              <View style={{
                flex: 1,
                backgroundColor: 'rgba(255,255,255,0.95)',
                shadowColor: '#fff', shadowOpacity: 0.6, shadowRadius: 4, shadowOffset: { width: 0, height: 0 },
              }} />
            </Animated.View>
          )}
        </View>
      ))}
    </View>
  );

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose} statusBarTranslucent>
      <Animated.View
        style={{
          flex: 1, backgroundColor: '#000',
          transform: [{ scale: entranceScale }, { translateY: dragY }],
          opacity: dragOpacity,
        }}
        {...panResponder.panHandlers}
      >
        {renderProgressBars()}

        {/* Header — avatar + name + relative time, plus own-only delete/add-more */}
        <View style={{
          position: 'absolute', top: Platform.OS === 'ios' ? 64 : 34, left: 0, right: 0,
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, zIndex: 5, gap: 10,
        }}>
          {ownerEmail ? (
            <AvatarCircle name={ownerName} email={ownerEmail} size={36} />
          ) : null}
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }} numberOfLines={1}>
              {ownerName}
            </Text>
            {cur?.created_at ? (
              <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, marginTop: 1 }}>
                {formatRelTime(cur.created_at, t)}
              </Text>
            ) : null}
          </View>
          {isSelf && cur?.id && (
            <>
              <TouchableOpacity
                onPress={() => {
                  const id = cur.id;
                  const doDelete = () => { onDelete?.(id); };
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
                style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' }}
                accessibilityLabel={t?.('common.delete') || 'Excluir'}
              >
                <IconTrash size={18} color="#ef4444" />
              </TouchableOpacity>
              {onAddMore ? (
                <TouchableOpacity
                  onPress={() => { onClose?.(); setTimeout(() => onAddMore?.(), 150); }}
                  style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' }}
                  accessibilityLabel={t?.('status.addMore') || 'Adicionar outro'}
                >
                  <IconPlus size={18} color="#fff" />
                </TouchableOpacity>
              ) : null}
            </>
          )}
          <TouchableOpacity onPress={onClose} style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' }} accessibilityLabel="Close">
            <IconX size={18} color="#fff" />
          </TouchableOpacity>
        </View>

        {/* Media — wrapped in Animated.View for crossfade between items */}
        <Animated.View style={{ flex: 1, opacity: itemOpacity }}>
          {renderMedia()}
        </Animated.View>

        {/* Music indicator — animated equalizer pill */}
        {cur?.music_title ? (
          <View style={{
            position: 'absolute',
            bottom: caption ? 130 : (isSelf ? 80 : 110),
            left: 16, right: 16,
            flexDirection: 'row', alignItems: 'center', gap: 8,
            backgroundColor: 'rgba(0,0,0,0.45)',
            borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
            zIndex: 6,
          }}>
            <IconMusic size={14} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 }} numberOfLines={1}>
              {cur.music_title}{cur.music_artist ? ` — ${cur.music_artist}` : ''}
            </Text>
          </View>
        ) : null}

        {/* Caption overlay — glass surface for image/video stories */}
        {caption ? (
          <View style={{
            position: 'absolute',
            bottom: isSelf ? 78 : 110,
            left: 16, right: 16,
            backgroundColor: 'rgba(0,0,0,0.45)',
            borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
            zIndex: 6,
          }}>
            <Text style={{ color: '#fff', fontSize: 15, lineHeight: 20, textAlign: 'center' }}>
              {caption}
            </Text>
          </View>
        ) : null}

        {/* Tap zones — left/right with subtle haptic on each transition */}
        <Pressable
          style={{ position: 'absolute', left: 0, top: 110, bottom: 100, width: '30%' }}
          onPress={() => { _haptic('light'); setIdx(i => Math.max(0, i - 1)); }}
          accessibilityLabel={t?.('status.previous') || 'Previous story'}
          accessibilityRole="button"
        />
        <Pressable
          style={{ position: 'absolute', right: 0, top: 110, bottom: 100, width: '30%' }}
          onPress={() => { _haptic('light'); advance(); }}
          accessibilityLabel={t?.('status.next') || 'Next story'}
          accessibilityRole="button"
        />
        <Pressable
          style={{ position: 'absolute', left: '30%', right: '30%', top: 110, bottom: 100 }}
          onPressIn={() => setPaused(true)}
          onPressOut={() => setPaused(false)}
        />

        {/* Flying emoji animation */}
        {reactPop && (
          <View pointerEvents="none" style={{
            position: 'absolute', left: 0, right: 0, bottom: 100,
            alignItems: 'center', zIndex: 20,
          }}>
            <Text style={{ fontSize: 72 }}>{reactPop}</Text>
          </View>
        )}

        {/* Bottom bar */}
        <Animated.View style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          paddingHorizontal: 14, paddingBottom: Platform.OS === 'ios' ? 28 : 14, paddingTop: 10,
          backgroundColor: 'rgba(0,0,0,0.18)',
          zIndex: 10,
          transform: [{ translateY: keyboardOffset }],
        }}>
          {isSelf ? (
            // Tappable "Seen by N" pill — opens inline viewers sheet when caller wired.
            // Falls back to inline label for surfaces that don't pass onSeenByPress.
            onSeenByPress ? (
              <TouchableOpacity
                onPress={() => onSeenByPress(cur)}
                activeOpacity={0.8}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  backgroundColor: 'rgba(0,0,0,0.55)',
                  borderRadius: 22, paddingHorizontal: 14, paddingVertical: 9,
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
                }}
                accessibilityLabel={t?.('status.seenBy') || 'Visualizações'}
                accessibilityRole="button"
              >
                <IconEye size={17} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 14, fontWeight: '600', flex: 1 }}>
                  {(cur.views || 0) === 0
                    ? (t?.('status.noViewsYet') || 'Ninguém viu ainda')
                    : `${cur.views || 0} ${(cur.views || 0) === 1 ? (t?.('status.viewSingular') || 'visualização') : (t?.('status.viewPlural') || 'visualizações')}`}
                </Text>
                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 16 }}>›</Text>
              </TouchableOpacity>
            ) : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <IconEye size={16} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', opacity: 0.9 }}>
                  {(cur?.views ?? 0)} {cur?.views === 1 ? (t?.('status.view') || 'visualização') : (t?.('status.views') || 'visualizações')}
                </Text>
              </View>
            )
          ) : (
            <View style={{ gap: 10 }}>
              {/* Quick reactions */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                {['❤️','🔥','😂','😮','😢','👏','👍'].map(emoji => {
                  const pulsing = emojiPulse === emoji;
                  return (
                    <TouchableOpacity
                      key={emoji}
                      onPress={() => {
                        setEmojiPulse(emoji);
                        setTimeout(() => setEmojiPulse(null), 220);
                        setReactPop(emoji);
                        setTimeout(() => setReactPop(null), 900);
                        try { onReact?.(cur, emoji); } catch {}
                      }}
                      hitSlop={8}
                      style={{ paddingHorizontal: 6, transform: [{ scale: pulsing ? 1.35 : 1 }] }}
                    >
                      <Text style={{ fontSize: 26 }}>{emoji}</Text>
                    </TouchableOpacity>
                  );
                })}
              </View>
              {/* Reply input */}
              {replySent ? (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  backgroundColor: 'rgba(34,197,94,0.22)',
                  borderRadius: 24, paddingHorizontal: 16, paddingVertical: 12,
                  borderWidth: 1, borderColor: 'rgba(34,197,94,0.5)',
                  justifyContent: 'center',
                }}>
                  <IconCheck size={16} color="#fff" strokeWidth={2.5} />
                  <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
                    {t?.('status.replySent') || 'Resposta enviada'}
                  </Text>
                </View>
              ) : (
                <View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  backgroundColor: 'rgba(255,255,255,0.12)',
                  borderRadius: 24, paddingLeft: 14, paddingRight: 6,
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.25)',
                }}>
                  <IconMessageSquare size={16} color="rgba(255,255,255,0.55)" />
                  <TextInput
                    value={replyText}
                    onChangeText={setReplyText}
                    onFocus={() => setPaused(true)}
                    onBlur={() => setPaused(false)}
                    placeholder={(t?.('status.replyPlaceholder') || 'Responder para') + ' ' + (ownerName || '...')}
                    placeholderTextColor="rgba(255,255,255,0.55)"
                    style={{ flex: 1, color: '#fff', fontSize: 14, paddingVertical: 10, ...(Platform.OS === 'web' ? { outlineStyle: 'none' } : {}) }}
                    editable={!replying}
                    returnKeyType="send"
                    onSubmitEditing={async () => {
                      if (!replyText.trim() || replying) return;
                      setReplying(true);
                      try {
                        try { require('react-native').Vibration.vibrate(8); } catch {}
                        await onReply?.(cur, replyText.trim());
                        setReplyText('');
                        setReplySent(true);
                        setTimeout(() => setReplySent(false), 1400);
                      } catch {}
                      setReplying(false);
                    }}
                  />
                  {replyText.trim() ? (
                    <TouchableOpacity
                      disabled={replying}
                      onPress={async () => {
                        if (!replyText.trim() || replying) return;
                        setReplying(true);
                        try {
                          try { require('react-native').Vibration.vibrate(8); } catch {}
                          await onReply?.(cur, replyText.trim());
                          setReplyText('');
                          setReplySent(true);
                          setTimeout(() => setReplySent(false), 1400);
                        } catch {}
                        setReplying(false);
                      }}
                      style={{
                        width: 34, height: 34, borderRadius: 17,
                        backgroundColor: '#7C3AED',
                        alignItems: 'center', justifyContent: 'center',
                        opacity: replying ? 0.6 : 1,
                      }}
                      accessibilityLabel={t?.('common.send') || 'Enviar'}
                    >
                      <IconSend size={15} color="#fff" />
                    </TouchableOpacity>
                  ) : null}
                </View>
              )}
            </View>
          )}
        </Animated.View>

        {/* Inline viewers sheet — shown over the modal when caller wires
            onSeenByPress + viewersFor. Pauses navigation while open. */}
        {viewersFor?.id === cur.id && (
          <View
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, justifyContent: 'flex-end', zIndex: 20 }}
            pointerEvents="box-none"
          >
            <TouchableOpacity
              activeOpacity={1}
              onPress={() => onCloseViewers?.()}
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
                <IconEye size={18} color={isDark ? '#fff' : '#111'} />
                <Text style={{ fontSize: 18, fontWeight: '800', color: isDark ? '#fff' : '#111', flex: 1 }}>
                  {t?.('status.seenBy') || 'Visualizações'} · {viewersList.length}
                </Text>
                <TouchableOpacity onPress={() => onCloseViewers?.()} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
                  <IconX size={20} color={isDark ? '#999' : '#666'} />
                </TouchableOpacity>
              </View>
              {viewersLoading ? (
                <View style={{ paddingVertical: 24, alignItems: 'center' }}>
                  <ActivityIndicator size="small" color="#7C3AED" />
                </View>
              ) : viewersList.length === 0 ? (
                <View style={{ paddingVertical: 32, alignItems: 'center' }}>
                  <IconEye size={36} color={isDark ? '#666' : '#999'} />
                  <Text style={{ color: isDark ? '#999' : '#666', marginTop: 10, fontSize: 14 }}>
                    {t?.('status.noViewsYet') || 'Ninguém viu ainda'}
                  </Text>
                </View>
              ) : (
                <FlatList
                  data={viewersList}
                  keyExtractor={(u, i) => u.email || String(i)}
                  renderItem={({ item: viewer }) => {
                    const email = viewer.email || '';
                    const name = viewer.name || email.split('@')[0] || '';
                    return (
                      <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 10, gap: 12 }}>
                        <AvatarCircle name={name} email={email} size={42} />
                        <View style={{ flex: 1 }}>
                          <Text style={{ color: isDark ? '#fff' : '#111', fontSize: 15, fontWeight: '600' }} numberOfLines={1}>{name}</Text>
                          {viewer.viewed_at ? (
                            <Text style={{ color: isDark ? '#999' : '#666', fontSize: 12, marginTop: 1 }}>
                              {formatViewedAt(viewer.viewed_at)}
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
      </Animated.View>
    </Modal>
  );
}
