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
  PanResponder, AppState, Linking,
} from 'react-native';
import * as api from '../../services/api';
import { BASE_URL } from '../../services/api';
import { IconX, IconPlus, IconTrash, IconSend, IconCheck, IconMessageSquare, IconEye, IconMusic, IconVolume2, IconVolumeX, IconPause, IconArrowRight } from '../Icons';
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

// Find the first link sticker attached to a status item, regardless of where
// the backend serialized it (top-level `stickers`, or nested in `meta`).
// Returns `{ url, label }` or null. URL is normalized to include a scheme so
// Linking.openURL works on bare-domain inputs ("chatyy.com.br" → "https://").
function _extractLinkSticker(item) {
  if (!item) return null;
  const lists = [];
  if (Array.isArray(item.stickers)) lists.push(item.stickers);
  if (Array.isArray(item.meta?.stickers)) lists.push(item.meta.stickers);
  for (const list of lists) {
    for (const s of list) {
      if (s && s.type === 'link' && s.url) {
        let url = String(s.url).trim();
        if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
        const label = (s.label && String(s.label).trim()) || 'Saiba mais';
        return { url, label };
      }
    }
  }
  return null;
}

// Walk `stickers` + `meta.stickers` and surface every gif sticker so the
// viewer can paint them on top of the media. Each gif is validated against
// the allow-list (Tenor / Giphy / chatyy R2) so a malicious publisher can't
// smuggle a tracking pixel through this surface.
let _isAllowedGifUrl = (() => true);
try { _isAllowedGifUrl = require('../../hooks/useStatuses').isAllowedGifUrl || _isAllowedGifUrl; } catch {}
function _extractGifStickers(item) {
  if (!item) return [];
  const lists = [];
  if (Array.isArray(item.stickers)) lists.push(item.stickers);
  if (Array.isArray(item.meta?.stickers)) lists.push(item.meta.stickers);
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const s of list) {
      if (!s || s.type !== 'gif' || !s.url) continue;
      if (!_isAllowedGifUrl(s.url)) continue;
      // Dedup across `stickers` + `meta.stickers` (some backends serialize
      // both for compat) — keyed by url + position.
      const key = `${s.url}:${s.x || 0}:${s.y || 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        url: String(s.url),
        x: Number(s.x) || 0,
        y: Number(s.y) || 0,
        width: Math.max(1, Number(s.width) || 200),
        height: Math.max(1, Number(s.height) || 200),
      });
    }
  }
  return out;
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
  // Wave 8 (2026-05-06): cross-group navigation. When the caller passes a
  // group index + count + boundary callbacks, the tap-zones at the edges
  // forward to the next/prev group instead of closing the modal — Instagram
  // pattern. All optional; backward-compatible with single-group callers.
  groupIndex = 0,
  groupCount = 1,
  onNextGroup = null,
  onPrevGroup = null,
}) {
  const stories = Array.isArray(storiesProp) ? storiesProp : [];
  const [idx, setIdx] = useState(startIdx || 0);
  const [paused, setPaused] = useState(false);
  const [replyText, setReplyText] = useState('');
  const [replying, setReplying] = useState(false);
  const [replySent, setReplySent] = useState(false);
  // Focused state for the reply input — when true the bottom bar must NOT fade,
  // even though the viewer is paused. Without this the user's input vanishes
  // mid-typing because `paused → uiOpacity 0` collapses the whole bottom bar
  // (including the TextInput they're tapping). Instagram keeps the input lit
  // up while the rest of the chrome dims; we mirror that.
  const [replyFocused, setReplyFocused] = useState(false);
  const [reactPop, setReactPop] = useState(null);
  const [emojiPulse, setEmojiPulse] = useState(null); // emoji currently scaling (UI feedback)
  // Per-session video mute pref (defaults unmuted — video status is consciously
  // tapped, not autoplay scroll, so audio is expected). Persists across items
  // within a single viewer session; resets when modal closes.
  const [videoMuted, setVideoMuted] = useState(false);
  // Image fade-in — kills the white→content pop when expo-image loads. Reset
  // per item via the same idx effect that drives crossfade.
  const imageFade = useRef(new Animated.Value(0)).current;
  // Video error overlay — when expo-video / expo-av fail to load (404, codec,
  // network), show a friendly card instead of leaving black screen forever.
  const [videoError, setVideoError] = useState(false);
  // Video loading state — small spinner while expo-video is initializing,
  // before the first decoded frame paints. Poster usually masks this but on
  // older statuses without thumbnail_url the user used to see a black hole.
  const [videoLoading, setVideoLoading] = useState(false);
  // Caught-up "all done" overlay shown for 1.4s before the modal closes when
  // the user finishes the last story — Instagram pattern, replaces the abrupt
  // dismiss that left users wondering "did I tap something wrong?".
  const [caughtUp, setCaughtUp] = useState(false);
  const caughtUpAnim = useRef(new Animated.Value(0)).current;
  // UI fade when paused (long-press to inspect a story). Mirrors Instagram —
  // header + bottom bar fade to 0 so the photo is unobstructed; tap-release
  // brings them back. Native-driven opacity, free even on cheap Android.
  // Special case: while the reply input has focus we keep chrome lit so the
  // user can see what they're typing — paused-but-typing is a different state
  // than paused-because-long-press.
  const uiOpacity = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.timing(uiOpacity, {
      toValue: (paused && !replyFocused) ? 0 : 1,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [paused, replyFocused, uiOpacity]);

  // Hold-to-pause visual cue. Goes 0 → 1 when the user holds the story.
  // Used to:
  //   - dim the progress bar (opacity 1 → 0.4) so it reads as "frozen"
  //   - fade in a small ⏸ icon at the top-right corner
  // 200ms ease, native-driven so it stays smooth even on cheap Android.
  // Distinct from `uiOpacity` (which fully hides chrome) — the user still
  // wants to SEE that the bar is there, just understand it's stopped.
  const pausedAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(pausedAnim, {
      toValue: paused ? 1 : 0,
      duration: 200,
      useNativeDriver: true,
    }).start();
  }, [paused, pausedAnim]);

  // Auto-pause when the app backgrounds — without this, the timer keeps
  // ticking, the user comes back, and the story they wanted to look at
  // already advanced (or finished). Restores prior paused state on resume.
  useEffect(() => {
    if (!visible) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') return; // resume handled by paused=false default
      setPaused(true);
    });
    return () => { try { sub.remove(); } catch {} };
  }, [visible]);

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
  // Swipe-up always reads the freshest link target — refreshed below in a
  // useEffect once we know `linkSticker` for the current item. Declared
  // BEFORE panResponder so its onPanResponderRelease closure can read the
  // ref without a TDZ at gesture-time.
  const activeLinkRef = useRef(null);
  // Track whether the current drag is in the swipe-up CTA zone (bottom 30%
  // of the screen). Captured on the move-start event by reading pageY against
  // window height. Reset every release so a new touch reads fresh.
  const swipeUpFromBottomRef = useRef(false);
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (evt, gs) => {
        // Need a clean vertical gesture — beats taps + horizontal scrolls.
        if (Math.abs(gs.dy) <= 12 || Math.abs(gs.dy) <= Math.abs(gs.dx) * 1.5) return false;
        if (gs.dy > 0) return true; // swipe-down → close
        // Swipe-up only claims the responder when it started in the bottom
        // 30% of the screen — otherwise the user might be reaching for the
        // header or a sticker and we'd swallow their tap.
        try {
          const { height: H } = require('react-native').Dimensions.get('window');
          const startY = (evt?.nativeEvent?.pageY || 0) - gs.dy;
          swipeUpFromBottomRef.current = (startY / H) >= 0.7;
        } catch { swipeUpFromBottomRef.current = false; }
        // Only claim if user actually has a link target — pointless otherwise.
        return swipeUpFromBottomRef.current && !!activeLinkRef.current && gs.dy < -12;
      },
      onPanResponderGrant: () => { setPaused(true); },
      onPanResponderMove: (_evt, gs) => {
        // We only animate the swipe-DOWN drag visually; swipe-up is a
        // discrete "pull up to reveal" gesture that fires on release.
        if (gs.dy >= 0) dragY.setValue(gs.dy);
      },
      onPanResponderRelease: (_evt, gs) => {
        // Swipe-up commit — > 60px upward + bottom-30% origin → open link.
        if (gs.dy < -60 && swipeUpFromBottomRef.current) {
          const target = activeLinkRef.current;
          swipeUpFromBottomRef.current = false;
          if (target) {
            if (_Haptics && Platform.OS !== 'web') {
              try { _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Medium); } catch {}
            }
            try { Linking.openURL(target).catch(() => {}); } catch {}
          }
          setPaused(false);
          return;
        }
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
        swipeUpFromBottomRef.current = false;
      },
    })
  ).current;

  // (activeLinkRef is declared earlier — its useEffect sync lives below
  // alongside the pulse animation effect.)

  // Pulsing "↑ Saiba mais" hint. Pulses every 4s (0.7→1.0 opacity + tiny
  // scale) so the gesture is discoverable without being annoying. Native-
  // driven so it stays free even on cheap Android.
  //
  // Note: this effect re-extracts the link sticker for the active idx
  // since `linkSticker` isn't computed until after the early-return guards
  // below. Cheap (per idx change), keeps the hook order stable.
  const ctaPulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const _curForEffect = stories?.[Math.min(Math.max(0, idx), Math.max(0, (stories?.length || 1) - 1))];
    const _linkForEffect = _extractLinkSticker(_curForEffect);
    activeLinkRef.current = _linkForEffect?.url || null;
    if (!visible || !_linkForEffect) {
      ctaPulse.setValue(0);
      return undefined;
    }
    let cancelled = false;
    // Wait 1.2s after the story opens before the first pulse so the user
    // gets a chance to read the content first.
    const initial = setTimeout(() => {
      if (cancelled) return;
      const loop = Animated.loop(
        Animated.sequence([
          Animated.timing(ctaPulse, { toValue: 1, duration: 700, useNativeDriver: true }),
          Animated.timing(ctaPulse, { toValue: 0, duration: 700, useNativeDriver: true }),
          // 4s gap (~ matches Instagram cadence) before the next pulse.
          Animated.delay(2600),
        ])
      );
      loop.start();
    }, 1200);
    return () => {
      cancelled = true;
      clearTimeout(initial);
      ctaPulse.stopAnimation?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, idx, stories]);

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
      setCaughtUp(false);
      caughtUpAnim.setValue(0);
    }
  }, [visible, startIdx, stories?.length, caughtUpAnim]);

  const advance = useCallback(() => {
    setIdx(prev => {
      if (prev < (stories?.length || 0) - 1) return prev + 1;
      // Last item of THIS group finished — if there's a next group, jump to
      // it. Caller handles the swap via stories prop change + startIdx=0.
      // Stronger haptic at the group boundary so the user feels the
      // transition (vs the light "tick" between items inside one group).
      if (onNextGroup && groupIndex < groupCount - 1) {
        if (_Haptics && Platform.OS !== 'web') {
          try { _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Medium); } catch {}
        }
        try { onNextGroup(); } catch {}
        return prev;
      }
      // Truly last item of last group — show "caught up" for 1.4s, then close.
      if (!caughtUp) {
        setCaughtUp(true);
        caughtUpAnim.setValue(0);
        Animated.timing(caughtUpAnim, { toValue: 1, duration: 220, useNativeDriver: true }).start();
        setTimeout(() => { onClose?.(); }, 1400);
      }
      return prev;
    });
  }, [stories, onClose, caughtUp, caughtUpAnim, onNextGroup, groupIndex, groupCount]);

  // Backward navigation: at item 0, if there's a previous group, jump to it.
  // Otherwise stay put (current behavior). Boundary haptic mirrors `advance`.
  const goPrev = useCallback(() => {
    setIdx(prev => {
      if (prev > 0) return prev - 1;
      if (onPrevGroup && groupIndex > 0) {
        if (_Haptics && Platform.OS !== 'web') {
          try { _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Medium); } catch {}
        }
        try { onPrevGroup(); } catch {}
      }
      return prev;
    });
  }, [onPrevGroup, groupIndex]);

  useEffect(() => {
    if (!visible) return;
    const cur = stories?.[idx];
    if (!cur) return;
    progressRef.current.setValue(0);
    // Reset per-item state: crossfade in, image fade reset, video flags cleared.
    itemOpacity.setValue(0);
    Animated.timing(itemOpacity, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    imageFade.setValue(0);
    setVideoError(false);
    setVideoLoading(cur.type === 'video');
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
  }, [visible, idx, paused, stories, advance, onMarkViewed, itemOpacity, imageFade]);

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
  // Link sticker — surfaced as a tappable bottom-center pill below. Walks both
  // `cur.stickers` and `cur.meta.stickers` since the backend serialization
  // varies by status version. Returns null if no link sticker is attached so
  // existing surfaces (poll/quiz/mention/music) keep their layout untouched.
  const linkSticker = _extractLinkSticker(cur);
  // GIF stickers — animated overlays positioned over the media. Same dual-
  // path extraction as link stickers; allow-list validated so a malicious
  // publisher can't smuggle a tracking pixel through.
  const gifStickers = _extractGifStickers(cur);

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
      // Friendly fail card — beats a black void if expo-video/expo-av reject
      // the URL (404, codec mismatch, signed URL expired).
      if (videoError) {
        return (
          <View style={{ flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
            <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 38, marginBottom: 14 }}>⚠</Text>
            <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16, fontWeight: '700', textAlign: 'center' }}>
              {t?.('status.videoUnavailable') || 'Vídeo indisponível'}
            </Text>
            <Text style={{ marginTop: 6, color: 'rgba(255,255,255,0.5)', fontSize: 12, textAlign: 'center' }}>
              {t?.('status.videoUnavailableHint') || 'Tente novamente em instantes ou avance.'}
            </Text>
          </View>
        );
      }
      if (WEB) {
        return (
          <View style={{ flex: 1, backgroundColor: '#000' }}>
            {PosterOverlay}
            <video
              src={mediaUrl}
              autoPlay
              playsInline
              muted={videoMuted}
              loop={isBoomerang}
              onEnded={isBoomerang ? undefined : advance}
              onError={() => setVideoError(true)}
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
          const player = useVideoPlayer(uri, (p) => {
            try { p.loop = isBoomerang; p.muted = videoMuted; p.play(); } catch {}
          });
          // Sync mute toggle live — caller flips videoMuted, we push it down.
          useEffect(() => { try { player.muted = videoMuted; } catch {} }, [videoMuted]); // eslint-disable-line react-hooks/exhaustive-deps
          // Listen for status updates to detect load errors + ready state.
          useEffect(() => {
            const sub = player.addListener?.('statusChange', (s) => {
              if (s?.error) { setVideoError(true); setVideoLoading(false); }
              // expo-video reports 'readyToPlay' once the first frame is
              // decoded — that's when we hide the spinner.
              if (s?.status === 'readyToPlay' || s?.status === 'playing') {
                setVideoLoading(false);
              }
            });
            return () => { try { sub?.remove?.(); } catch {} };
          }, []); // eslint-disable-line react-hooks/exhaustive-deps
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
      // Image fade-in: opacity ramps 0 → 1 once expo-image fires onLoad.
      // Native driver makes it free; transition prop alone gives a slight
      // crossfade INSIDE expo-image but doesn't cover the empty-frame gap
      // before any data has arrived.
      return (
        <Animated.View style={{ flex: 1, opacity: imageFade }}>
          <_ExpoImage
            source={{ uri: mediaUrl }}
            style={{ width: '100%', height: '100%' }}
            contentFit="contain"
            cachePolicy="memory-disk"
            transition={120}
            onLoad={() => {
              Animated.timing(imageFade, { toValue: 1, duration: 200, useNativeDriver: true }).start();
            }}
          />
        </Animated.View>
      );
    }
    return WEB
      ? <img src={mediaUrl} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain', backgroundColor: '#000' }} />
      : <Image
          source={{ uri: mediaUrl }}
          style={{ width: '100%', height: '100%' }}
          resizeMode="contain"
          onLoad={() => {
            Animated.timing(imageFade, { toValue: 1, duration: 200, useNativeDriver: true }).start();
          }}
        />;
  };

  // Modern gradient progress bar — animates left-to-right with a soft glow.
  // Replaces the flat white bar. Uses Svg gradient + Animated Rect width.
  // Hold-to-pause dims the whole row to 40% so the freeze is visible without
  // hiding the segments entirely (uiOpacity → 0 already hides chrome but the
  // user still wants positional context — "I'm on segment 3 of 5, paused").
  const renderProgressBars = () => (
    <Animated.View style={{
      position: 'absolute', top: Platform.OS === 'ios' ? 50 : 20, left: 0, right: 0,
      flexDirection: 'row', gap: 4, paddingHorizontal: 10, zIndex: 5,
      opacity: pausedAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] }),
    }}>
      {stories.map((_, i) => (
        <View key={i} style={{
          flex: 1, height: 3, backgroundColor: 'rgba(255,255,255,0.28)',
          borderRadius: 2, overflow: 'hidden',
        }}>
          {i < safeIdx && (
            // Completed segment — purple→pink gradient matches the active fill
            // so finished + in-progress segments read as one consistent brand
            // surface (vs the prior solid white that looked disconnected).
            <View style={{ width: '100%', height: '100%', flexDirection: 'row' }}>
              <View style={{ flex: 1, backgroundColor: '#7C3AED' }} />
              <View style={{ flex: 1, backgroundColor: '#A855F7' }} />
              <View style={{ flex: 1, backgroundColor: '#EC4899' }} />
            </View>
          )}
          {i === safeIdx && (
            <Animated.View
              accessibilityLabel={`${t?.('status.progress') || 'Story'} ${safeIdx + 1} ${t?.('common.of') || 'de'} ${stories.length}`}
              accessibilityRole="progressbar"
              style={{
                height: '100%',
                width: progressRef.current.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] }),
                backgroundColor: 'transparent',
                flexDirection: 'row',
                shadowColor: '#EC4899', shadowOpacity: 0.7, shadowRadius: 4, shadowOffset: { width: 0, height: 0 },
              }}
            >
              {/* Brand gradient (purple → pink) — three stacked color steps
                  approximate a linear-gradient cheaply. Pink trailing edge
                  carries a soft glow via shadowColor on the parent. */}
              <View style={{ flex: 1, backgroundColor: '#7C3AED' }} />
              <View style={{ flex: 1, backgroundColor: '#A855F7' }} />
              <View style={{ flex: 1, backgroundColor: '#EC4899' }} />
            </Animated.View>
          )}
        </View>
      ))}
    </Animated.View>
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

        {/* Hold-to-pause icon — small ⏸ in the top-right that fades in only
            while paused. Position aligned with the progress bar row so the
            two cues read as one piece of UI. pointerEvents none so it never
            interferes with the tap-zones underneath. */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: Platform.OS === 'ios' ? 46 : 16, right: 12,
            zIndex: 6,
            opacity: pausedAnim,
            transform: [{ scale: pausedAnim.interpolate({ inputRange: [0, 1], outputRange: [0.85, 1] }) }],
          }}
        >
          <View style={{
            width: 22, height: 22, borderRadius: 11,
            backgroundColor: 'rgba(0,0,0,0.55)',
            alignItems: 'center', justifyContent: 'center',
          }}>
            <IconPause size={12} color="#fff" />
          </View>
        </Animated.View>

        {/* Header — avatar + name + relative time, plus own-only delete/add-more.
            Wrapped in Animated.View so it fades out when user long-presses to
            inspect (paused) — Instagram pattern, unobstructs the photo. */}
        <Animated.View style={{
          position: 'absolute', top: Platform.OS === 'ios' ? 64 : 34, left: 0, right: 0,
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, zIndex: 5, gap: 10,
          opacity: uiOpacity,
        }}>
          {ownerEmail ? (
            // White ring + soft glow around the owner avatar — gives the
            // header a more "premium" feel and visually separates the avatar
            // from busy story backgrounds. shadowColor white + radius 8 reads
            // as a halo on iOS; elevation handles Android equivalent.
            <View style={{
              width: 40, height: 40, borderRadius: 20,
              borderWidth: 2, borderColor: '#fff',
              alignItems: 'center', justifyContent: 'center',
              shadowColor: '#fff', shadowOpacity: 0.5, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
              elevation: 6,
            }}>
              <AvatarCircle name={ownerName} email={ownerEmail} size={36} />
            </View>
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
          <TouchableOpacity
            onPress={onClose}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{
              width: 38, height: 38, borderRadius: 19,
              backgroundColor: 'rgba(0,0,0,0.55)',
              alignItems: 'center', justifyContent: 'center',
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
              shadowColor: '#000', shadowOpacity: 0.4, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
              elevation: 4,
            }}
            accessibilityLabel="Close"
          >
            <IconX size={20} color="#fff" />
          </TouchableOpacity>
        </Animated.View>

        {/* Media — wrapped in Animated.View for crossfade between items */}
        <Animated.View style={{ flex: 1, opacity: itemOpacity }}>
          {renderMedia()}
        </Animated.View>

        {/* Loading spinner overlay — shown while expo-video initializes and
            the poster (.thumb.jpg) hasn't masked the black gap. Centered, soft
            white, fades with paused UI. Auto-hides on readyToPlay. */}
        {isVideo && videoLoading && !videoError && (
          <Animated.View style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            alignItems: 'center', justifyContent: 'center',
            zIndex: 4, opacity: uiOpacity, pointerEvents: 'none',
          }}>
            <ActivityIndicator size="large" color="rgba(255,255,255,0.85)" />
          </Animated.View>
        )}

        {/* Mute toggle — only visible on video status. Bottom-left, inside
            same fade as the rest of the UI (paused → fade out). Tap toggles
            the player mute and persists for the rest of the session. */}
        {isVideo && !videoError && (
          <Animated.View style={{
            position: 'absolute', top: Platform.OS === 'ios' ? 110 : 80, right: 14,
            zIndex: 5, opacity: uiOpacity,
          }}>
            <TouchableOpacity
              onPress={() => { setVideoMuted(m => !m); _haptic('light'); }}
              style={{ width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(0,0,0,0.4)', alignItems: 'center', justifyContent: 'center' }}
              accessibilityLabel={videoMuted ? (t?.('status.unmute') || 'Unmute') : (t?.('status.mute') || 'Mute')}
              accessibilityRole="button"
            >
              {videoMuted
                ? <IconVolumeX size={18} color="#fff" />
                : <IconVolume2 size={18} color="#fff" />}
            </TouchableOpacity>
          </Animated.View>
        )}

        {/* Music indicator — bumped to bottom: 180 when caption present so the
            two pills don't overlap (caption box can be ~60-80px tall on
            multi-line text). Also fades with paused UI. */}
        {cur?.music_title ? (
          <Animated.View style={{
            position: 'absolute',
            bottom: caption ? 180 : (isSelf ? 80 : 110),
            left: 16, right: 16,
            flexDirection: 'row', alignItems: 'center', gap: 8,
            backgroundColor: 'rgba(0,0,0,0.45)',
            borderRadius: 20, paddingHorizontal: 12, paddingVertical: 7,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
            zIndex: 6,
            opacity: uiOpacity,
          }}>
            <IconMusic size={14} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 }} numberOfLines={1}>
              {cur.music_title}{cur.music_artist ? ` — ${cur.music_artist}` : ''}
            </Text>
          </Animated.View>
        ) : null}

        {/* Bottom dark fade — three stacked translucent bars approximate a
            linear-gradient (cheap, no extra dep) so the caption + bottom bar
            stay legible over bright/busy media. Sits behind chrome (zIndex 3)
            and pointerEvents:none so it doesn't intercept taps. Only shown
            when there's caption + media (text statuses already have a solid
            background). */}
        {caption && (isImage || isVideo) ? (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 220, zIndex: 3 }}
          >
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.0)' }} />
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.18)' }} />
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.42)' }} />
          </View>
        ) : null}

        {/* Caption overlay — glass surface for image/video stories */}
        {caption ? (
          <Animated.View style={{
            position: 'absolute',
            bottom: isSelf ? 78 : 110,
            left: 16, right: 16,
            backgroundColor: 'rgba(0,0,0,0.45)',
            borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
            zIndex: 6,
            opacity: uiOpacity,
          }}>
            <Text style={{
              color: '#fff', fontSize: 15, lineHeight: 20, textAlign: 'center',
              // Subtle shadow under caption text adds extra legibility on top
              // of the gradient — same trick Instagram uses for stickers.
              textShadowColor: 'rgba(0,0,0,0.5)',
              textShadowOffset: { width: 0, height: 1 },
              textShadowRadius: 3,
            }}>
              {caption}
            </Text>
          </Animated.View>
        ) : null}

        {/* GIF stickers — animated overlays positioned at the publisher's
            chosen (x, y). Rendered ABOVE the media but BELOW the chrome so
            the user can drag past them. Allow-list + dimension caps applied
            in _extractGifStickers above so a malicious publisher can't
            smuggle a tracking pixel through this surface. */}
        {gifStickers.length > 0 ? (
          <View
            pointerEvents="none"
            style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 4,
            }}
          >
            {gifStickers.map((g, gi) => {
              // Cap render size at 220px so a huge gif can't dominate the
              // viewer canvas. Maintains aspect ratio on the smaller side.
              const cap = 220;
              const ratio = g.width / g.height;
              const renderW = ratio >= 1 ? Math.min(cap, g.width) : Math.min(cap, g.width * (cap / g.height));
              const renderH = ratio >= 1 ? Math.min(cap, g.height * (cap / g.width)) : Math.min(cap, g.height);
              if (WEB) {
                return (
                  <img
                    key={gi}
                    src={g.url}
                    alt=""
                    style={{
                      position: 'absolute', left: g.x, top: g.y,
                      width: renderW, height: renderH,
                      borderRadius: 8, objectFit: 'cover',
                    }}
                  />
                );
              }
              if (_ExpoImage) {
                // expo-image natively decodes animated webp/gif. cachePolicy
                // memory-disk dedupes across re-renders so the gif keeps
                // looping without re-downloading.
                return (
                  <_ExpoImage
                    key={gi}
                    source={{ uri: g.url }}
                    style={{
                      position: 'absolute', left: g.x, top: g.y,
                      width: renderW, height: renderH, borderRadius: 8,
                    }}
                    contentFit="cover"
                    cachePolicy="memory-disk"
                  />
                );
              }
              return (
                <Image
                  key={gi}
                  source={{ uri: g.url }}
                  style={{
                    position: 'absolute', left: g.x, top: g.y,
                    width: renderW, height: renderH, borderRadius: 8,
                  }}
                  resizeMode="cover"
                />
              );
            })}
          </View>
        ) : null}

        {/* Link sticker — Instagram-style "Saiba mais" pill, bottom-center.
            Tap forwards to the URL via Linking.openURL (Android opens
            default browser, iOS uses Safari, web opens new tab). zIndex 7
            so it sits above the music/caption pills if the publisher
            stacked all three. Stack offset bumps it above music+caption
            so the three pills don't overlap. */}
        {linkSticker ? (
          <Animated.View style={{
            position: 'absolute',
            bottom: caption ? (cur?.music_title ? 240 : 170) : (cur?.music_title ? 170 : (isSelf ? 100 : 130)),
            left: 0, right: 0,
            alignItems: 'center',
            zIndex: 7,
            opacity: uiOpacity,
          }}>
            <TouchableOpacity
              onPress={() => {
                _haptic('light');
                try { Linking.openURL(linkSticker.url).catch(() => {}); } catch {}
              }}
              activeOpacity={0.85}
              accessibilityRole="link"
              accessibilityLabel={linkSticker.label}
              style={{
                flexDirection: 'row', alignItems: 'center', gap: 8,
                backgroundColor: 'rgba(255,255,255,0.95)',
                borderRadius: 22, paddingHorizontal: 16, paddingVertical: 9,
                shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 8, shadowOffset: { width: 0, height: 2 },
                elevation: 4,
              }}
            >
              <Text style={{ color: '#111', fontSize: 14, fontWeight: '700' }} numberOfLines={1}>
                {linkSticker.label}
              </Text>
              <View style={{
                width: 22, height: 22, borderRadius: 11,
                backgroundColor: '#7C3AED',
                alignItems: 'center', justifyContent: 'center',
              }}>
                <IconArrowRight size={13} color="#fff" />
              </View>
            </TouchableOpacity>
          </Animated.View>
        ) : null}

        {/* Swipe-up CTA hint — small "↑ Saiba mais" line at the bottom that
            pulses every 4s while a link sticker is present. Tells the user
            they can swipe up from the bottom 30% to open the link in
            addition to tapping the pill. zIndex 6 so it sits below the pill
            but above tap zones. pointerEvents none so the swipe-up gesture
            in the parent panResponder gets the touch. */}
        {linkSticker ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              bottom: Platform.OS === 'ios' ? 36 : 22,
              left: 0, right: 0,
              alignItems: 'center',
              zIndex: 6,
              opacity: Animated.multiply(
                uiOpacity,
                ctaPulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] })
              ),
              transform: [
                { translateY: ctaPulse.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }) },
              ],
            }}
          >
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 4,
              backgroundColor: 'rgba(0,0,0,0.35)',
              paddingHorizontal: 12, paddingVertical: 5,
              borderRadius: 14,
            }}>
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>
                {/* Reusing the link sticker's CTA label keeps the hint and
                    the pill consistent — if the publisher set "Comprar"
                    the swipe hint also says "Comprar". */}
                {`↑ ${linkSticker.label}`}
              </Text>
            </View>
          </Animated.View>
        ) : null}

        {/* Tap zones — left/right with subtle haptic on each transition.
            Boundary taps (first/last item) jump to prev/next group when
            wired by the caller. */}
        <Pressable
          style={{ position: 'absolute', left: 0, top: 110, bottom: 100, width: '30%' }}
          onPress={() => { _haptic('light'); goPrev(); }}
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
          opacity: uiOpacity,
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
              {/* Quick reactions — scale-pop animation + medium haptic on tap.
                  Pulse ramps 1 → 1.6 → 1 via emojiPulse state; pairs with the
                  flying-emoji ReactPop overlay rendered above the bottom bar.
                  Haptic mirrors WhatsApp react UX: a short medium-strength
                  thump that confirms the touch landed even before the visual
                  catches up. */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
                {['❤️','🔥','😂','😮','😢','👏','👍'].map(emoji => {
                  const pulsing = emojiPulse === emoji;
                  return (
                    <TouchableOpacity
                      key={emoji}
                      onPress={() => {
                        _haptic('medium');
                        setEmojiPulse(emoji);
                        setTimeout(() => setEmojiPulse(null), 260);
                        setReactPop(emoji);
                        setTimeout(() => setReactPop(null), 900);
                        try { onReact?.(cur, emoji); } catch {}
                      }}
                      hitSlop={8}
                      style={{
                        paddingHorizontal: 6,
                        transform: [{ scale: pulsing ? 1.6 : 1 }],
                        // Soft glow only while pulsing — adds visual oomph
                        // without bloating the resting state.
                        ...(pulsing ? {
                          shadowColor: '#EC4899', shadowOpacity: 0.6, shadowRadius: 10, shadowOffset: { width: 0, height: 0 },
                        } : null),
                      }}
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
                  backgroundColor: 'rgba(255,255,255,0.15)',
                  borderRadius: 24, paddingLeft: 14, paddingRight: 6,
                  borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)',
                }}>
                  <IconMessageSquare size={16} color="rgba(255,255,255,0.7)" />
                  <TextInput
                    value={replyText}
                    onChangeText={setReplyText}
                    onFocus={() => { setPaused(true); setReplyFocused(true); }}
                    onBlur={() => { setReplyFocused(false); setPaused(false); }}
                    placeholder={(t?.('status.replyPlaceholder') || 'Responder para') + ' ' + (ownerName || '...')}
                    placeholderTextColor="rgba(255,255,255,0.7)"
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

        {/* "All caught up" overlay — fades in when the last story finishes,
            replaces the abrupt dismiss with a 1.4s confirmation. */}
        {caughtUp && (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
              backgroundColor: 'rgba(0,0,0,0.78)',
              alignItems: 'center', justifyContent: 'center',
              zIndex: 30,
              opacity: caughtUpAnim,
            }}
          >
            <Animated.View style={{
              width: 88, height: 88, borderRadius: 44,
              backgroundColor: 'rgba(124,58,237,0.18)',
              borderWidth: 2, borderColor: '#7C3AED',
              alignItems: 'center', justifyContent: 'center', marginBottom: 18,
              transform: [{ scale: caughtUpAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) }],
            }}>
              <IconCheck size={42} color="#fff" strokeWidth={3} />
            </Animated.View>
            {/* t() returns the key literal when missing, so `|| fallback`
                wouldn't kick in — compare value !== key explicitly. */}
            <Text style={{ color: '#fff', fontSize: 19, fontWeight: '800', textAlign: 'center' }}>
              {(() => { const v = t?.('status.caughtUp'); return (v && v !== 'status.caughtUp') ? v : 'Tudo em dia'; })()}
            </Text>
            <Text style={{ color: 'rgba(255,255,255,0.65)', fontSize: 14, marginTop: 6, textAlign: 'center', paddingHorizontal: 30 }}>
              {(() => { const v = t?.('status.caughtUpHint'); return (v && v !== 'status.caughtUpHint') ? v : 'Você viu todos os status.'; })()}
            </Text>
          </Animated.View>
        )}

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
                    // Backend joins chat_status_reactions and returns the
                    // viewer's latest reaction_emoji. Render as a chip so the
                    // owner sees BOTH "who viewed" and "who reacted with what"
                    // in one place — same UX as Instagram's viewer list.
                    const emoji = viewer.reaction_emoji || '';
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
                        {emoji ? (
                          <View style={{
                            width: 34, height: 34, borderRadius: 17,
                            backgroundColor: isDark ? 'rgba(124,58,237,0.18)' : 'rgba(124,58,237,0.08)',
                            borderWidth: 1, borderColor: 'rgba(124,58,237,0.32)',
                            alignItems: 'center', justifyContent: 'center',
                          }}>
                            <Text style={{ fontSize: 18 }}>{emoji}</Text>
                          </View>
                        ) : null}
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
