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
  PanResponder, AppState, Linking, Easing, Dimensions, StyleSheet,
} from 'react-native';
import * as api from '../../services/api';
import { BASE_URL } from '../../services/api';
import { IconX, IconPlus, IconTrash, IconSend, IconCheck, IconMessageSquare, IconEye, IconMusic, IconVolume2, IconVolumeX, IconPause, IconArrowRight, IconDownload } from '../Icons';
import AvatarCircle from '../AvatarCircle';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect as SvgRect } from 'react-native-svg';

// Text-status gradient presets — mirrored from ChatStatusTab.TEXT_BG_GRADIENTS
// so the viewer can paint the same SVG fill the composer previewed. Kept
// inline (instead of importing) to avoid a circular dep: ChatStatusTab
// already pulls StoryViewer indirectly through ChatListTab.
const _TEXT_BG_GRADIENTS_VIEWER = {
  purple_pink: ['#8B5CF6', '#EC4899'],
  blue_cyan:   ['#2563EB', '#06B6D4'],
  orange_red:  ['#F97316', '#EF4444'],
  green_teal:  ['#10B981', '#14B8A6'],
  sunset:      ['#FACC15', '#F97316', '#EF4444'],
  aurora:      ['#06B6D4', '#8B5CF6', '#EC4899'],
};
function _resolveTextGradient(bgColor) {
  if (!bgColor || typeof bgColor !== 'string' || !bgColor.startsWith('gradient:')) return null;
  const id = bgColor.slice('gradient:'.length);
  const colors = _TEXT_BG_GRADIENTS_VIEWER[id];
  return colors ? { id, colors } : null;
}

const WEB = Platform.OS === 'web';
const STORY_DURATION_MS = 5000;

let _ExpoImage = null;
try { _ExpoImage = require('expo-image').Image; } catch {}

let _Haptics = null;
try { _Haptics = require('expo-haptics'); } catch {}

let _cacheMedia = null;
try { _cacheMedia = require('../../services/mediaCache').cacheMedia; } catch {}

// WS singleton — used to surface real-time reaction toasts on the author's
// own story without polling. Safe to require here: every viewer surface
// already has the WS connected via AuthContext; we only piggy-back on it.
let _mailWs = null;
try { _mailWs = require('../../services/websocket').default; } catch {}

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
// Walk a status item and collect every interactive sticker that needs a
// tappable surface in the viewer (slider, poll, question, mention,
// countdown). Returns the raw sticker objects with x/y intact so the
// renderer below can place them in the same spot as the composer.
function _extractInteractiveStickers(item) {
  if (!item) return [];
  const lists = [];
  if (Array.isArray(item.stickers)) lists.push(item.stickers);
  if (Array.isArray(item.meta?.stickers)) lists.push(item.meta.stickers);
  const out = [];
  const seen = new Set();
  const interactiveTypes = new Set(['slider', 'question', 'mention', 'countdown', 'poll', 'quiz']);
  for (const list of lists) {
    for (const s of list) {
      if (!s || !s.type || !interactiveTypes.has(s.type)) continue;
      const key = `${s.type}:${s.id || ''}:${s.x || 0}:${s.y || 0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(s);
    }
  }
  return out;
}

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

// Slider sticker (viewer) — Instagram-style "emoji slider". Lets the
// viewer drag an emoji along a 0-100 track, then sends the value to the
// backend. After submission we show the running average as a marker on
// the track. Disabled on own stories (publisher already has it via the
// composer preview). One submission per (status, sticker) — backend
// upserts so re-dragging just overwrites.
function SliderStickerView({ sticker, statusId, ownStatus, alreadyVoted, onVoted, t }) {
  const [value, setValue] = useState(50);
  const [submitted, setSubmitted] = useState(!!alreadyVoted);
  const [avg, setAvg] = useState(typeof sticker?.avg_value === 'number' ? sticker.avg_value : null);
  const [trackWidth, setTrackWidth] = useState(220);
  const startValueRef = useRef(50);

  const emoji = sticker?.emoji || '🔥';
  const question = sticker?.question || (t ? t('status.sliderDefaultQuestion') : 'Qual o seu nível?');
  const stickerId = String(sticker?.id || '');

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !submitted && !ownStatus,
    onMoveShouldSetPanResponder: () => !submitted && !ownStatus,
    onPanResponderGrant: () => {
      startValueRef.current = value;
    },
    onPanResponderMove: (_, g) => {
      const tw = trackWidth || 220;
      const next = Math.max(0, Math.min(100, Math.round(startValueRef.current + (g.dx / tw) * 100)));
      setValue(next);
    },
    onPanResponderRelease: async () => {
      try {
        if (_Haptics) _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Medium);
      } catch {}
      setSubmitted(true);
      try {
        const r = await api.statusSliderVote(statusId, value, stickerId);
        if (r?.success && typeof r?.data?.avg_value === 'number') {
          setAvg(r.data.avg_value);
        }
        try { onVoted?.(value); } catch {}
      } catch {}
    },
  })).current;

  return (
    <View style={{
      backgroundColor: 'rgba(15,23,42,0.92)', borderRadius: 18,
      paddingTop: 14, paddingBottom: 22, paddingHorizontal: 16, width: 260,
    }}>
      <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700', textAlign: 'center', marginBottom: 14 }}>
        {question}
      </Text>
      <View
        onLayout={(e) => setTrackWidth(e.nativeEvent.layout.width)}
        style={{ height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.18)', position: 'relative' }}
      >
        <View style={{
          position: 'absolute', left: 0, top: 0, bottom: 0,
          width: `${value}%`,
          borderRadius: 4, backgroundColor: '#F59E0B',
        }} />
        <View
          {...pan.panHandlers}
          style={{
            position: 'absolute',
            top: -22,
            left: `${value}%`,
            transform: [{ translateX: -20 }],
            padding: 4,
          }}
        >
          <Text style={{ fontSize: 36 }}>{emoji}</Text>
        </View>
        {submitted && avg !== null ? (
          <View style={{
            position: 'absolute',
            top: 12,
            left: `${avg}%`,
            transform: [{ translateX: -10 }],
            alignItems: 'center',
          }}>
            <View style={{ width: 2, height: 12, backgroundColor: 'rgba(255,255,255,0.7)' }} />
            <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 10, fontWeight: '700', marginTop: 2 }}>{Math.round(avg)}</Text>
          </View>
        ) : null}
      </View>
      {!ownStatus && !submitted ? (
        <Text style={{ color: 'rgba(255,255,255,0.55)', fontSize: 11, textAlign: 'center', marginTop: 14 }}>
          {t ? t('status.sliderDragHint') : 'Arraste para responder'}
        </Text>
      ) : null}
      {submitted && !ownStatus ? (
        <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 11, textAlign: 'center', marginTop: 14 }}>
          {t ? t('status.sliderYourAnswer') : 'Sua resposta'}: {value}{avg !== null ? `  ·  ${t ? t('status.sliderAverage') : 'média'} ${Math.round(avg)}` : ''}
        </Text>
      ) : null}
    </View>
  );
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
  // Repost own status — fires with (story) so the caller can route to the
  // composer pre-loaded with the same media. Optional; if omitted, the
  // Repost button is not rendered.
  onRepost,
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
  // Mention sticker → fires when viewer taps an `@username` chip painted
  // on the story. Caller routes to /u/<email> (profile screen) or opens a
  // profile modal. Optional; if omitted the chip stays decorative.
  onMentionPress = null,
}) {
  const stories = Array.isArray(storiesProp) ? storiesProp : [];
  const insets = useSafeAreaInsets();
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
  // Realtime reaction toast — shown on the OWNER side when a viewer reacts.
  // Backed by the WS `status_react` event (chat.php fires it via /notify).
  // Auto-dismisses after 2.6s. Shape: { name, emoji } or null.
  const [reactToast, setReactToast] = useState(null);
  const reactToastAnim = useRef(new Animated.Value(0)).current;
  // Heart burst — long-press on ❤️ spawns 5 hearts that float up & fade.
  // Each entry: { id, emoji, dx (start horizontal offset), size, anim }.
  // Anim 0 → 1 over 1.2s: translateY -180, opacity 1 → 0, scale 0.6 → 1.
  // Native-driven so the burst stays smooth on cheap Android.
  const [hearts, setHearts] = useState([]);
  // Per-session video mute pref (defaults unmuted — video status is consciously
  // tapped, not autoplay scroll, so audio is expected). Persists across items
  // within a single viewer session; resets when modal closes.
  const [videoMuted, setVideoMuted] = useState(false);
  // Image fade-in — kills the white→content pop when expo-image loads. Reset
  // per item via the same idx effect that drives crossfade.
  const imageFade = useRef(new Animated.Value(0)).current;
  // Reply grace — after the user dismisses the reply keyboard we give them
  // a few extra seconds before the auto-advance timer can finish the story.
  // Without this, the user types "thanks", taps send/blur, and the timer
  // (which was paused while typing) snaps to "advance" in <2s leaving them
  // no time to read the reaction. Set on blur, cleared by a timer or by the
  // user manually advancing/closing.
  const replyGraceRef = useRef(false);
  const replyGraceTimerRef = useRef(null);
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
  // Save-to-gallery — transient "Salvo na galeria" toast confirms the save
  // worked. Auto-clears after 1.8s. `saving` blocks re-taps while the file
  // is being copied so we don't fire MediaLibrary twice on a slow flush.
  const [saving, setSaving] = useState(false);
  const [savedToast, setSavedToast] = useState(false);
  const savedToastAnim = useRef(new Animated.Value(0)).current;
  // Reply aggregate count — populated lazily for own statuses via
  // status_analytics. Surfaced as a pill above the "Seen by N" row so the
  // owner sees BOTH metrics at a glance (Instagram pattern). Map keyed by
  // status id so flipping between slides in the same group doesn't refetch.
  const [repliesCountById, setRepliesCountById] = useState({});
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

  // Tap-hold ripple — Instagram-style radial spread when the user presses to
  // pause. Lives at the touch point (set by onPressIn on the center zone),
  // animates 0 → 1 over 320ms (scale 0.5 → 2.6, opacity 0.3 → 0). Keeps the
  // hold gesture feeling tactile even with no haptic. Native-driven scale +
  // opacity so it's free on cheap Android. Reset by setting state to null
  // when paused goes false (or when the user releases).
  const [rippleAt, setRippleAt] = useState(null); // { x, y } in screen coords
  const rippleAnim = useRef(new Animated.Value(0)).current;
  // Last single-tap timestamp on the center zone — used to detect the
  // double-tap pair that fires the "❤️" reaction. Reset to 0 after each
  // successful pair so a slow third tap can't accidentally chain.
  const lastTapRef = useRef(0);
  useEffect(() => {
    if (rippleAt) {
      rippleAnim.setValue(0);
      Animated.timing(rippleAnim, {
        toValue: 1, duration: 360, easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }).start();
    } else {
      rippleAnim.setValue(0);
    }
  }, [rippleAt, rippleAnim]);

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

  // Reply input entrance — slide-up + fade when focused. Backdrop darkens
  // (proxy for backdrop-blur since expo-blur isn't bundled) so the input
  // sits over a high-contrast surface and reads cleanly over busy stories.
  // 0 = resting (input hugs bottom bar baseline), 1 = focused (lifted +
  // backdrop active). 220ms timing matches the keyboardOffset cadence so
  // the keyboard + composer animate in lockstep.
  const replyEnter = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(replyEnter, {
      toValue: replyFocused ? 1 : 0,
      duration: 220,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false, // backgroundColor lerp can't go native
    }).start();
  }, [replyFocused, replyEnter]);

  // Auto-pause when the app backgrounds — without this, the timer keeps
  // ticking, the user comes back, and the story they wanted to look at
  // already advanced (or finished). Resume when active so the user doesn't
  // have to manually tap to un-pause after every background→foreground cycle
  // (previous "resume handled by paused=false default" comment was wrong —
  // paused is sticky once true, it only flips back via gesture release/tap).
  // Skip resume if the reply input is focused (typing-pause owns that state).
  useEffect(() => {
    if (!visible) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        if (!replyFocused) setPaused(false);
        return;
      }
      setPaused(true);
    });
    return () => { try { sub.remove(); } catch {} };
  }, [visible, replyFocused]);

  // Realtime reaction toast (owner side). When a viewer reacts to one of
  // OUR stories the backend fires `status_react` on our personal channel;
  // we surface a small "X reacted with EMOJI" pill that fades out after
  // ~2.6s. Skipped when we're viewing someone else's story (isSelf=false).
  // The "removed" flag means the viewer un-reacted — we don't show a toast
  // for that. Multi-reaction in <2s coalesces by replacing the visible pill.
  useEffect(() => {
    if (!visible || !isSelf || !_mailWs?.on) return undefined;
    let dismissTimer = null;
    const sub = _mailWs.on('status_react', (data) => {
      try {
        const d = data || {};
        if (d.removed || !d.emoji) return;
        // Match against the currently visible story id so a reaction on
        // a different (older) story doesn't surface mid-view. Owner sees
        // it later in viewers sheet anyway.
        const curId = stories?.[idx]?.id;
        if (curId && d.status_id && Number(d.status_id) !== Number(curId)) return;
        const name = d.reactor_name || (d.reactor_email ? String(d.reactor_email).split('@')[0] : '');
        setReactToast({ name, emoji: String(d.emoji) });
        reactToastAnim.setValue(0);
        Animated.sequence([
          Animated.timing(reactToastAnim, { toValue: 1, duration: 220, useNativeDriver: true }),
          Animated.delay(2200),
          Animated.timing(reactToastAnim, { toValue: 0, duration: 240, useNativeDriver: true }),
        ]).start(() => setReactToast(null));
        if (dismissTimer) clearTimeout(dismissTimer);
        dismissTimer = setTimeout(() => setReactToast(null), 2800);
      } catch {}
    });
    return () => {
      try { sub?.(); } catch {}
      if (dismissTimer) clearTimeout(dismissTimer);
    };
  }, [visible, isSelf, idx, stories, reactToastAnim]);

  // Replies count fetcher — lazy-loads status_analytics for own statuses so
  // the "Seen by N" row can surface a "💬 X respostas" pill alongside it.
  // Keyed by status id so re-entering the same slide doesn't re-fetch.
  // statusAnalytics is owner-only on the backend so we gate on isSelf to
  // avoid 403 churn. Failure is silent — pill just stays hidden.
  useEffect(() => {
    if (!visible || !isSelf) return;
    const curStory = stories?.[idx];
    const sid = curStory?.id;
    if (!sid) return;
    if (Object.prototype.hasOwnProperty.call(repliesCountById, sid)) return;
    let cancelled = false;
    (async () => {
      try {
        const r = await api.statusAnalytics?.(sid);
        if (cancelled) return;
        const n = Number(r?.data?.replies);
        setRepliesCountById(prev => ({ ...prev, [sid]: Number.isFinite(n) ? n : 0 }));
      } catch {
        if (!cancelled) setRepliesCountById(prev => ({ ...prev, [sid]: 0 }));
      }
    })();
    return () => { cancelled = true; };
  }, [visible, isSelf, idx, stories, repliesCountById]);

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
  // Horizontal drag — Instagram-style parallax swipe between user groups.
  // Tracks `dx` while the gesture is active. On release: if past threshold
  // AND a target group exists, snap toward it then fire onNextGroup/onPrevGroup
  // (caller swaps stories prop). Otherwise spring back. Background shifts
  // ~25% of dx for a subtle parallax peek at the "next" canvas underneath.
  const dragX = useRef(new Animated.Value(0)).current;
  // Screen width — captured once so the parallax interpolation can map the
  // drag distance into a sensible fraction (~25%). Dimensions.get is cheap
  // but we still cache to avoid hitting it every frame.
  const winW = (() => { try { return Dimensions.get('window').width; } catch { return 360; } })();
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
  // Track which axis the current gesture claimed so move/release branches
  // don't fight each other (mixing dx + dy on the same frame looks janky).
  // Set in onMoveShouldSetPanResponder, cleared on release/terminate.
  const gestureAxisRef = useRef(null); // 'h' | 'v' | null
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (evt, gs) => {
        // Horizontal swipe between user groups — only claim when there's
        // actually a target on that side (onNextGroup/onPrevGroup wired
        // AND we're not already at the edge). Threshold 12px + dx > dy*1.5
        // so a slight diagonal still feels like horizontal intent.
        if (Math.abs(gs.dx) > 12 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.5) {
          const canNext = gs.dx < 0 && onNextGroup && groupIndex < groupCount - 1;
          const canPrev = gs.dx > 0 && onPrevGroup && groupIndex > 0;
          if (canNext || canPrev) { gestureAxisRef.current = 'h'; return true; }
          return false;
        }
        // Need a clean vertical gesture — beats taps + horizontal scrolls.
        if (Math.abs(gs.dy) <= 12 || Math.abs(gs.dy) <= Math.abs(gs.dx) * 1.5) return false;
        if (gs.dy > 0) { gestureAxisRef.current = 'v'; return true; } // swipe-down → close
        // Swipe-up only claims the responder when it started in the bottom
        // 30% of the screen — otherwise the user might be reaching for the
        // header or a sticker and we'd swallow their tap.
        try {
          const { height: H } = require('react-native').Dimensions.get('window');
          const startY = (evt?.nativeEvent?.pageY || 0) - gs.dy;
          swipeUpFromBottomRef.current = (startY / H) >= 0.7;
        } catch { swipeUpFromBottomRef.current = false; }
        // Only claim if user actually has a link target — pointless otherwise.
        if (swipeUpFromBottomRef.current && !!activeLinkRef.current && gs.dy < -12) {
          gestureAxisRef.current = 'v'; return true;
        }
        return false;
      },
      onPanResponderGrant: () => { setPaused(true); },
      onPanResponderMove: (_evt, gs) => {
        if (gestureAxisRef.current === 'h') {
          // Horizontal parallax — only honor in the direction with a target.
          const canNext = gs.dx < 0 && onNextGroup && groupIndex < groupCount - 1;
          const canPrev = gs.dx > 0 && onPrevGroup && groupIndex > 0;
          if (canNext || canPrev) dragX.setValue(gs.dx);
          return;
        }
        // We only animate the swipe-DOWN drag visually; swipe-up is a
        // discrete "pull up to reveal" gesture that fires on release.
        if (gs.dy >= 0) dragY.setValue(gs.dy);
      },
      onPanResponderRelease: (_evt, gs) => {
        if (gestureAxisRef.current === 'h') {
          // Horizontal commit — > 60px OR fling-fast → fire group nav.
          const threshold = 60;
          const fling = Math.abs(gs.vx) > 0.6;
          gestureAxisRef.current = null;
          if (gs.dx < -threshold || (gs.dx < 0 && fling)) {
            if (onNextGroup && groupIndex < groupCount - 1) {
              if (_Haptics && Platform.OS !== 'web') {
                try { _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Light); } catch {}
              }
              // Slide out to the left then snap back to 0 once the parent
              // swaps the stories prop — caller is sync so this is fine.
              Animated.timing(dragX, { toValue: -winW, duration: 180, useNativeDriver: true })
                .start(() => {
                  dragX.setValue(0);
                  try { onNextGroup(); } catch {}
                });
              setPaused(false);
              return;
            }
          } else if (gs.dx > threshold || (gs.dx > 0 && fling)) {
            if (onPrevGroup && groupIndex > 0) {
              if (_Haptics && Platform.OS !== 'web') {
                try { _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Light); } catch {}
              }
              Animated.timing(dragX, { toValue: winW, duration: 180, useNativeDriver: true })
                .start(() => {
                  dragX.setValue(0);
                  try { onPrevGroup(); } catch {}
                });
              setPaused(false);
              return;
            }
          }
          // Below threshold — spring back to center.
          Animated.spring(dragX, { toValue: 0, useNativeDriver: true, friction: 7, tension: 90 }).start();
          setPaused(false);
          return;
        }
        // Swipe-up commit — > 60px upward + bottom-30% origin → open link.
        if (gs.dy < -60 && swipeUpFromBottomRef.current) {
          const target = activeLinkRef.current;
          swipeUpFromBottomRef.current = false;
          gestureAxisRef.current = null;
          if (target) {
            if (_Haptics && Platform.OS !== 'web') {
              try { _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Medium); } catch {}
            }
            try { Linking.openURL(target).catch(() => {}); } catch {}
          }
          setPaused(false);
          return;
        }
        gestureAxisRef.current = null;
        if (gs.dy > 120 || gs.vy > 0.6) {
          // Mount-grace guard — if the opening tap from the home strip leaks
          // into the freshly-mounted PanResponder as a swipe-down (touch
          // started off-modal, finger lifted on-modal a few pixels lower),
          // we'd close the viewer the instant it opens. Snap back instead.
          if (isFreshMount()) {
            Animated.spring(dragY, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
            setPaused(false);
            return;
          }
          Animated.timing(dragY, { toValue: 600, duration: 180, useNativeDriver: true })
            .start(() => { dragY.setValue(0); onClose?.(); });
        } else {
          Animated.spring(dragY, { toValue: 0, useNativeDriver: true, friction: 7 }).start();
          setPaused(false);
        }
      },
      onPanResponderTerminate: () => {
        Animated.spring(dragY, { toValue: 0, useNativeDriver: true }).start();
        Animated.spring(dragX, { toValue: 0, useNativeDriver: true }).start();
        gestureAxisRef.current = null;
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

  // Mount debounce — the tap that OPENS the viewer can leak through to the
  // freshly-mounted tap-zones (Modal mounts synchronously on Android + the
  // status ring sits at y~120 which overlaps the viewer's tap-zone top:110).
  // Without a small grace window, the opening touch fires goPrev()/advance()
  // or, worse, gets reported as a swipe-down (origin tap below the ring then
  // finger lifts after modal mount → release event lands on PanResponder).
  // Block all close/nav handlers for 250ms after visible flips to true.
  const mountAtRef = useRef(0);
  const isFreshMount = useCallback(() => {
    return mountAtRef.current > 0 && (Date.now() - mountAtRef.current) < 250;
  }, []);

  useEffect(() => {
    if (visible) {
      mountAtRef.current = Date.now();
      setIdx(Math.min(Math.max(0, startIdx || 0), Math.max(0, (stories?.length || 1) - 1)));
      setPaused(false);
      setCaughtUp(false);
      caughtUpAnim.setValue(0);
      // Fresh viewer session — clear any leftover grace from a previous open.
      replyGraceRef.current = false;
      if (replyGraceTimerRef.current) { clearTimeout(replyGraceTimerRef.current); replyGraceTimerRef.current = null; }
    } else {
      mountAtRef.current = 0;
      // Modal closed — kill the grace timer so it can't fire against a stale
      // closure after the user already moved on.
      if (replyGraceTimerRef.current) { clearTimeout(replyGraceTimerRef.current); replyGraceTimerRef.current = null; }
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
    // [WAVE 93 2026-05-21] Safety net for `imageFade` — when expo-image
    // serves the source from its own memory cache (same uri viewed earlier
    // in this session, or pre-warmed via prefetch) the `onLoad` callback can
    // fire BEFORE the new <Image> child commits, so our `imageFade` reset
    // to 0 wins and the user sees a black canvas forever. After 900ms force
    // the fade to 1 — way past any realistic decode + paint window for a
    // disk-cached jpeg/webp. Doesn't fight the natural fade-in path: if
    // onLoad already triggered the animation, this is a no-op (value already
    // 1; Animated will short-circuit). Cancel on idx change to avoid leaks.
    const imageFadeFloor = setTimeout(() => {
      try { Animated.timing(imageFade, { toValue: 1, duration: 200, useNativeDriver: true }).start(); } catch {}
    }, 900);
    // [WAVE 93 2026-05-21] Skip placeholder items: their id looks like
    // `__manifest_<email>_<i>` and the backend rejects it (500 → goes into
    // offline queue → garbage retries forever). Wait for the real status_list
    // payload to land before firing the view receipt. The next idx-effect
    // render after hookGroups swaps will see a numeric id and fire correctly.
    if (cur.id && !cur._placeholder && !String(cur.id).startsWith('__manifest_') && !viewedIdsRef.current.has(cur.id)) {
      viewedIdsRef.current.add(cur.id);
      // Fire-and-forget → if offline / 5xx, the receipt is silently lost,
      // breaking the "Vistos" badge on the author's side. Queue the action
      // so replayOfflineQueue resends on next reconnect. Server is idempotent
      // on (status_id, viewer_email) so duplicates are a no-op.
      try {
        const _statusId = cur.id;
        Promise.resolve(api.statusView?.(_statusId)).catch(() => {
          try {
            const { queueOfflineAction } = require('../../services/offlineCache');
            queueOfflineAction({ type: 'status_view', params: { status_id: _statusId } });
          } catch {}
        });
      } catch {}
      try { onMarkViewed?.(cur.id); } catch {}
    }
    // Pre-cache the NEXT N stories while this one is playing — eliminates the
    // micro-buffering that used to flash between stories. Cheap: cacheMedia
    // dedupes by URL, so re-visits hit the disk cache. Web skipped (browser
    // already handles HTTP caching for <video>/<img>).
    // Aggressive radius: i+1 and i+2 (image + poster). The user reported
    // "as vezes os status demora carregar a foto em si"; pre-warming two
    // ahead means the full payload is already on disk before they tap.
    if (Platform.OS !== 'web' && _cacheMedia) {
      for (let _ofs = 1; _ofs <= 2; _ofs++) {
        const _peek = stories?.[idx + _ofs];
        if (!_peek) break;
        const _peekRaw = _peek.media_url
          || ((_peek.type === 'image' || _peek.type === 'video') && /^(\/|https?:\/\/)/.test(String(_peek.content || ''))
              ? _peek.content : '');
        const _peekUrl = _resolveUrl(_peekRaw);
        // force:true on i+1 so the immediate next paint hits the disk cache
        // even on cellular; i+2 stays opportunistic (cellular gate respected).
        if (_peekUrl) { _cacheMedia(_peekUrl, _ofs === 1 ? { force: true } : undefined).catch(() => {}); }
        const _peekThumb = _resolveUrl(_peek.thumbnail_url);
        if (_peekThumb) { _cacheMedia(_peekThumb, { force: true }).catch(() => {}); }
      }
    } else if (Platform.OS === 'web') {
      // Web: use Image.prefetch (RN web shim → preload link) for image-type
      // peeks so the browser HTTP cache is warm before the user advances.
      try {
        for (let _ofs = 1; _ofs <= 2; _ofs++) {
          const _peek = stories?.[idx + _ofs];
          if (!_peek || _peek.type !== 'image') continue;
          const _peekRaw = _peek.media_url
            || (/^(\/|https?:\/\/)/.test(String(_peek.content || '')) ? _peek.content : '');
          const _peekUrl = _resolveUrl(_peekRaw);
          if (_peekUrl) Image.prefetch?.(_peekUrl);
          const _peekThumb = _resolveUrl(_peek.thumbnail_url);
          if (_peekThumb) Image.prefetch?.(_peekThumb);
        }
      } catch {}
    }
    if (cur.type === 'video') return () => clearTimeout(imageFadeFloor);
    if (paused) return () => clearTimeout(imageFadeFloor);
    // [WAVE 79 2026-05-21] Placeholder items have no real media yet —
    // freeze the progress bar so the timer doesn't tick through ghost items
    // while status_list is still in flight. Parent (ChatListTab) refetches
    // and swaps to real items in-place; the next render of this effect will
    // see `cur._placeholder === undefined` and resume normal cadence.
    if (cur._placeholder) return () => clearTimeout(imageFadeFloor);
    // Reply grace — if the user just dismissed the reply keyboard we extend
    // the remaining-time so they can actually read whatever made them reply.
    // Grace flag is cleared 4s later by the blur handler so a second visit
    // (next story) is back to normal cadence. Re-using STORY_DURATION_MS as
    // the base keeps the cadence predictable; we just bump the floor.
    const duration = replyGraceRef.current ? Math.max(STORY_DURATION_MS, 5000) : STORY_DURATION_MS;
    // Instagram-style ease-out so the bar fills crisp at the start and
    // glides into the seam — feels less mechanical than the linear ramp.
    animRef.current = Animated.timing(progressRef.current, {
      toValue: 1,
      duration,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animRef.current.start(({ finished }) => {
      if (finished) advance();
    });
    return () => { animRef.current?.stop?.(); clearTimeout(imageFadeFloor); };
  }, [visible, idx, paused, stories, advance, onMarkViewed, itemOpacity, imageFade]);

  useEffect(() => {
    if (visible && (!stories || stories.length === 0)) {
      // Defer the auto-close so a brief empty render (e.g., parent recomputed
      // groupIdx mid-state-flush and `items` is momentarily []) doesn't close
      // the modal the instant it mounts. 350ms covers the mount-grace window
      // and the followup setStatuses(hookGroups) sync effect in ChatListTab.
      const t = setTimeout(() => {
        // Re-check via ref — if a fresh mount is still active or stories
        // populated in the meantime, the parent will skip the close.
        if (isFreshMount()) return;
        onClose?.();
      }, 350);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [visible, stories?.length, onClose, isFreshMount]);

  // Save the current story media to the device gallery. Mirrors the
  // ChatMediaViewer flow: prefer mediaCache (already on disk) → fall back
  // to a direct download via expo-file-system → handoff to MediaLibrary.
  // Author-only by default; non-owners only see the button if the publisher
  // hasn't opted out (cur.allow_save !== false). Web silently no-ops since
  // RN's web shim lacks createAssetAsync.
  const handleSaveToGallery = useCallback(async (story) => {
    if (!story || saving || Platform.OS === 'web') return;
    setSaving(true);
    try {
      const ML = (() => { try { return require('expo-media-library'); } catch { return null; } })();
      if (!ML) { setSaving(false); return; }
      const perm = await ML.requestPermissionsAsync(true);
      if (perm?.status !== 'granted' && perm?.accessPrivileges !== 'all') {
        try { Alert.alert(t?.('common.permissionRequired') || 'Permissão necessária', t?.('chatMedia.permPhotos') || 'Permita acesso a Fotos nas configurações.'); } catch {}
        setSaving(false);
        return;
      }
      const rawUrl = story.media_url || (story.content || '').split('\n')[0] || '';
      const remoteUrl = rawUrl
        ? (rawUrl.startsWith('http') ? rawUrl : `${BASE_URL}${rawUrl}`)
        : '';
      if (!remoteUrl) { setSaving(false); return; }
      // Reuse the per-app media cache if it's already there — saves a
      // duplicate network round-trip and is exactly the local path the
      // task describes ("cache mediaCache").
      let sourceUri = remoteUrl;
      try {
        if (_cacheMedia) {
          const cached = await _cacheMedia(remoteUrl, { force: true });
          if (cached && typeof cached === 'string') sourceUri = cached;
        }
      } catch {}
      let FS;
      try { FS = require('expo-file-system/legacy'); } catch { try { FS = require('expo-file-system'); } catch { FS = null; } }
      if (sourceUri.startsWith('http') && FS?.downloadAsync) {
        const ext = (sourceUri.split('/').pop() || 'file').split('?')[0].split('.').pop() || 'jpg';
        const tempPath = (FS.cacheDirectory || '') + 'chatyy_status_save_' + Date.now() + '.' + ext;
        const dl = await FS.downloadAsync(sourceUri, tempPath);
        if (dl?.uri) sourceUri = dl.uri;
      }
      let ok = false;
      try {
        const asset = await ML.createAssetAsync(sourceUri);
        if (asset) ok = true;
      } catch {
        try { await ML.saveToLibraryAsync(sourceUri); ok = true; } catch {}
      }
      if (ok) {
        setSavedToast(true);
        savedToastAnim.setValue(0);
        Animated.sequence([
          Animated.timing(savedToastAnim, { toValue: 1, duration: 200, useNativeDriver: true }),
          Animated.delay(1400),
          Animated.timing(savedToastAnim, { toValue: 0, duration: 220, useNativeDriver: true }),
        ]).start(() => setSavedToast(false));
        try { if (_Haptics) _Haptics.notificationAsync(_Haptics.NotificationFeedbackType.Success); } catch {}
      }
    } catch {}
    finally { setSaving(false); }
  }, [saving, t, savedToastAnim]);

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
  // Interactive stickers (slider/question/mention/countdown) — these get a
  // tappable overlay rendered at the publisher's chosen (x, y). Poll/quiz
  // already render via a dedicated viewer surface so we filter them out
  // here to avoid double-painting them on the media canvas.
  const interactiveStickers = _extractInteractiveStickers(cur).filter(s => s.type !== 'poll' && s.type !== 'quiz');

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
      // Gradient text status — bg_color is a `gradient:<id>` token instead
      // of a hex value. Paint the SVG behind the text in absoluteFill so
      // the gradient bleeds edge-to-edge while the centered Text stays put.
      const gradient = _resolveTextGradient(cur.bg_color);
      const stops = gradient
        ? (gradient.colors.length > 1 ? gradient.colors : [gradient.colors[0], gradient.colors[0]])
        : null;
      return (
        <View style={{ flex: 1, backgroundColor: gradient ? '#000' : (cur.bg_color || '#25D366'), alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          {gradient ? (
            <Svg
              pointerEvents="none"
              style={StyleSheet.absoluteFill}
              preserveAspectRatio="none"
              viewBox="0 0 1 1"
            >
              <Defs>
                <SvgLinearGradient id={`storyTextGrad_${gradient.id}`} x1="0" y1="0" x2="1" y2="1">
                  {stops.map((c, i) => (
                    <Stop key={i} offset={`${Math.round((i / (stops.length - 1)) * 100)}%`} stopColor={c} stopOpacity="1" />
                  ))}
                </SvgLinearGradient>
              </Defs>
              <SvgRect x="0" y="0" width="1" height="1" fill={`url(#storyTextGrad_${gradient.id})`} />
            </Svg>
          ) : null}
          <Text style={{ color: '#fff', fontSize: 26, fontWeight: '800', textAlign: 'center', lineHeight: 34 }}>
            {cur.content || ''}
          </Text>
        </View>
      );
    }
    if (!mediaUrl) {
      // [WAVE 79 2026-05-21] Manifest-only placeholder items have NO media_url
      // because status_manifest only ships per-owner aggregates (count + email
      // + latest_at). When the user taps before status_list resolves we'd land
      // on "Mídia indisponível" — wrong message. Show a spinner + "Carregando"
      // instead so the viewer feels alive while the real payload streams in.
      // Bug user 2026-05-21: "foto não aparece, se volta aparece".
      if (cur?._placeholder) {
        return (
          <View style={{ flex: 1, backgroundColor: '#0f172a', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
            <ActivityIndicator size="large" color="rgba(255,255,255,0.85)" />
            <Text style={{ marginTop: 16, color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '600', textAlign: 'center' }}>
              {t?.('status.loading') || 'Carregando…'}
            </Text>
          </View>
        );
      }
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
        const InnerVideo = ({ uri, loop, initialMuted }) => {
          // [WAVE 93 2026-05-21] Pass `loop` + `initialMuted` as props so the
          // useVideoPlayer init callback reads the CURRENT idx's values (vs
          // the captured first-render values when stale). Was: every advance
          // to a new video item kept the FIRST item's mute + loop semantics
          // because `isBoomerang` and `videoMuted` were closed over in the
          // outer render.
          const player = useVideoPlayer(uri, (p) => {
            try { p.loop = !!loop; p.muted = !!initialMuted; p.play(); } catch {}
          });
          // Sync mute toggle live — caller flips videoMuted, we push it down.
          useEffect(() => { try { player.muted = videoMuted; } catch {} }, [videoMuted]); // eslint-disable-line react-hooks/exhaustive-deps
          // Sync loop flag too — a status carousel can mix boomerang + normal
          // clips, so we have to update player.loop when isBoomerang changes
          // between idx steps without the player being recreated.
          useEffect(() => { try { player.loop = !!loop; } catch {} }, [loop]); // eslint-disable-line react-hooks/exhaustive-deps
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
        return <InnerVideo uri={mediaUrl} loop={isBoomerang} initialMuted={videoMuted} />;
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
    // Poster fallback for IMAGE status — backend (#557) ships thumbnail_url
    // for both photo + video status. Painting a blurred thumb behind the
    // full image kills the 1-2s black gap users reported while expo-image /
    // network finished the full payload. Falls back gracefully on older
    // statuses without thumbnail_url (the wrapper's #0f172a tint reads as
    // a soft slate, not pitch black).
    const imagePoster = cur.thumbnail_url
      ? (cur.thumbnail_url.startsWith('http') ? cur.thumbnail_url : `${BASE_URL}${cur.thumbnail_url}`)
      : '';
    const ImagePosterLayer = imagePoster ? (
      WEB ? (
        <img
          src={imagePoster}
          alt=""
          style={{
            position: 'absolute', top: 0, left: 0, width: '100%', height: '100%',
            objectFit: 'contain', filter: 'blur(20px)', transform: 'scale(1.08)',
          }}
        />
      ) : (
        <Image
          source={{ uri: imagePoster }}
          style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, width: '100%', height: '100%' }}
          resizeMode="contain"
          blurRadius={20}
        />
      )
    ) : null;
    if (_ExpoImage && !WEB) {
      // Image fade-in: opacity ramps 0 → 1 once expo-image fires onLoad.
      // Native driver makes it free; transition prop alone gives a slight
      // crossfade INSIDE expo-image but doesn't cover the empty-frame gap
      // before any data has arrived. Poster sits underneath via absolute
      // positioning so the blurred thumb peeks while the full payload lands.
      return (
        <View style={{ flex: 1, backgroundColor: '#0f172a' }}>
          {ImagePosterLayer}
          <Animated.View style={{ flex: 1, opacity: imageFade }}>
            <_ExpoImage
              source={{ uri: mediaUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="contain"
              cachePolicy="memory-disk"
              priority="high"
              transition={120}
              onLoad={() => {
                Animated.timing(imageFade, { toValue: 1, duration: 350, useNativeDriver: true }).start();
              }}
            />
          </Animated.View>
        </View>
      );
    }
    return WEB
      ? (
        <div style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: '#0f172a' }}>
          {ImagePosterLayer}
          <img src={mediaUrl} alt="" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain' }} />
        </div>
      )
      : (
        <View style={{ flex: 1, backgroundColor: '#0f172a' }}>
          {ImagePosterLayer}
          <Animated.View style={{ flex: 1, opacity: imageFade }}>
            <Image
              source={{ uri: mediaUrl }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="contain"
              onLoad={() => {
                Animated.timing(imageFade, { toValue: 1, duration: 350, useNativeDriver: true }).start();
              }}
            />
          </Animated.View>
        </View>
      );
  };

  // Modern gradient progress bar — animates left-to-right with a soft glow.
  // Replaces the flat white bar. Uses Svg gradient + Animated Rect width.
  // Hold-to-pause dims the whole row to 40% so the freeze is visible without
  // hiding the segments entirely (uiOpacity → 0 already hides chrome but the
  // user still wants positional context — "I'm on segment 3 of 5, paused").
  const renderProgressBars = () => (
    <Animated.View style={{
      // Android edge-to-edge: static top:20 sat under the system clock on
      // devices with >24dp status bars. Use insets.top + 8 with a small floor
      // so the progress segments always clear the status bar.
      position: 'absolute', top: Math.max(insets?.top || 0, Platform.OS === 'android' ? 12 : 44) + 6, left: 0, right: 0,
      flexDirection: 'row', gap: 6, paddingHorizontal: 10, zIndex: 5,
      opacity: pausedAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] }),
    }}>
      {stories.map((_, i) => (
        <View key={i} style={{
          // Pending segments: white @ 30% opacity (Instagram spec). Completed
          // segments paint a solid gradient on top via the `i < safeIdx` branch
          // below, so the user reads three distinct states cleanly: pending
          // (30%), active (animating fill), completed (100% solid gradient).
          flex: 1, height: 4, backgroundColor: 'rgba(255,255,255,0.3)',
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
          // Combined transforms — scale (entrance), translateY (swipe-down),
          // translateX (horizontal group swipe). Background parallax (~25%
          // shift in the opposite direction) is rendered as a sibling layer
          // below via the brand-tinted gradient so dragging right reveals a
          // soft purple "peek" hinting at the next user underneath.
          transform: [
            { scale: entranceScale },
            { translateY: dragY },
            { translateX: dragX },
          ],
          opacity: dragOpacity,
        }}
        {...panResponder.panHandlers}
      >
        {/* Parallax peek backdrop — a soft brand-tinted layer that shifts at
            ~25% of the drag in the OPPOSITE direction so the user feels like
            the next/prev story canvas is sliding underneath. Sits at z=0,
            below all chrome. Opacity ramps with |dx| so the peek only shows
            during actual gestures, not during entrance. pointerEvents none
            to keep tap zones intact. */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
            backgroundColor: '#1a0a2e',
            zIndex: 0,
            opacity: dragX.interpolate({
              inputRange: [-winW, -40, 0, 40, winW],
              outputRange: [0.6, 0.15, 0, 0.15, 0.6],
              extrapolate: 'clamp',
            }),
            transform: [{
              translateX: dragX.interpolate({
                inputRange: [-winW, 0, winW],
                outputRange: [winW * 0.25, 0, -winW * 0.25],
              }),
            }],
          }}
        />
        {renderProgressBars()}

        {/* Hold-to-pause icon — small ⏸ in the top-right that fades in only
            while paused. Position aligned with the progress bar row so the
            two cues read as one piece of UI. pointerEvents none so it never
            interferes with the tap-zones underneath. */}
        <Animated.View
          pointerEvents="none"
          style={{
            position: 'absolute',
            // Sit just under the progress bar row — both use the same safe-area
            // floor so the pause pill never clips the status bar on Android.
            top: Math.max(insets?.top || 0, Platform.OS === 'android' ? 12 : 44) + 2, right: 12,
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
            inspect (paused) — Instagram pattern, unobstructs the photo.
            Avatar + name + time live INSIDE a translucent pill so they read
            cleanly over any background (white avatar on a white sky used to
            disappear). The pill stretches just enough to wrap the metadata —
            action buttons (delete/add/close) sit outside on the right. */}
        <Animated.View style={{
          // Avatar + name pill — render 24dp below the progress segments so
          // the metadata never overlaps the status bar on Android.
          position: 'absolute', top: Math.max(insets?.top || 0, Platform.OS === 'android' ? 12 : 44) + 20, left: 0, right: 0,
          flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, zIndex: 5, gap: 8,
          opacity: uiOpacity,
        }}>
          <View style={{
            // Backdrop pill — dark translucent surface that reads as a soft
            // backdrop-blur over any photo. 22px radius matches the avatar
            // ring so the two read as one continuous shape; padding tuned so
            // the avatar's outer halo doesn't get clipped.
            flex: 1, minWidth: 0, flexShrink: 1,
            flexDirection: 'row', alignItems: 'center', gap: 10,
            backgroundColor: 'rgba(0,0,0,0.42)',
            borderRadius: 22, paddingLeft: 4, paddingRight: 12, paddingVertical: 4,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
          }}>
            {ownerEmail ? (
              // White ring + soft glow around the owner avatar — gives the
              // header a more "premium" feel and visually separates the avatar
              // from busy story backgrounds. Avatar bumped down to 32px to
              // match Instagram header spec; pill height tracks.
              <View style={{
                width: 36, height: 36, borderRadius: 18,
                borderWidth: 2, borderColor: '#fff',
                alignItems: 'center', justifyContent: 'center',
                shadowColor: '#fff', shadowOpacity: 0.5, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
                elevation: 6,
              }}>
                <AvatarCircle name={ownerName} email={ownerEmail} size={32} />
              </View>
            ) : null}
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 14 }} numberOfLines={1}>
                {ownerName}
              </Text>
              {cur?.created_at ? (
                <Text style={{ color: 'rgba(255,255,255,0.75)', fontSize: 11, marginTop: 1 }}>
                  {formatRelTime(cur.created_at, t)}
                </Text>
              ) : null}
            </View>
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
              {onRepost ? (
                // Repost own status — closes the viewer, then forwards the
                // current story to the caller so they can open the composer
                // with the same media. Mirrors Instagram's "Compartilhar de
                // novo" flow without the Highlights side effect.
                <TouchableOpacity
                  onPress={() => {
                    const item = cur;
                    onClose?.();
                    setTimeout(() => { try { onRepost?.(item); } catch {} }, 150);
                  }}
                  style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(124,58,237,0.55)', alignItems: 'center', justifyContent: 'center' }}
                  accessibilityLabel={t?.('status.repostAction') || 'Repostar'}
                >
                  <IconArrowRight size={18} color="#fff" />
                </TouchableOpacity>
              ) : null}
            </>
          )}
          {/* Save to gallery — visible on the author's own non-text stories
              (images/videos). Saving a text status is a no-op since the
              content lives only in cur.content. Hidden on web (no
              MediaLibrary parity in expo-media-library's web shim). */}
          {isSelf && cur?.id && Platform.OS !== 'web' && (cur.type === 'image' || cur.type === 'video') ? (
            <TouchableOpacity
              onPress={() => handleSaveToGallery(cur)}
              disabled={saving}
              style={{
                width: 34, height: 34, borderRadius: 17,
                backgroundColor: saving ? 'rgba(124,58,237,0.55)' : 'rgba(0,0,0,0.4)',
                alignItems: 'center', justifyContent: 'center',
                opacity: saving ? 0.7 : 1,
              }}
              accessibilityLabel={t?.('status.saveToGallery') || 'Salvar na galeria'}
            >
              {saving ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <IconDownload size={18} color="#fff" />
              )}
            </TouchableOpacity>
          ) : null}
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
            // Mute toggle — float below the header pill which itself sits
            // 20dp below the inset. Add ~46dp to clear it.
            position: 'absolute', top: Math.max(insets?.top || 0, Platform.OS === 'android' ? 12 : 44) + 66, right: 14,
            zIndex: 5, opacity: uiOpacity,
          }}>
            <TouchableOpacity
              onPress={() => { setVideoMuted(m => !m); _haptic('light'); }}
              hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
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
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600', flex: 1 }} numberOfLines={1} ellipsizeMode="tail">
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
            alignSelf: 'center', maxWidth: '92%',
            backgroundColor: 'rgba(0,0,0,0.45)',
            borderRadius: 14, paddingHorizontal: 14, paddingVertical: 10,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
            zIndex: 6,
            opacity: uiOpacity,
          }}>
            <Text
              adjustsFontSizeToFit
              numberOfLines={6}
              style={{
                color: '#fff', fontSize: 15, lineHeight: 20, textAlign: 'center',
                // Subtle shadow under caption text adds extra legibility on top
                // of the gradient — same trick Instagram uses for stickers.
                textShadowColor: 'rgba(0,0,0,0.5)',
                textShadowOffset: { width: 0, height: 1 },
                textShadowRadius: 3,
              }}
            >
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

        {/* Interactive stickers — slider (and future: mention/countdown live
            renders). Painted at the publisher's (x, y). zIndex 6 so they
            sit above the media + gif overlays but below the chrome. The
            tap surface itself manages submission state internally. */}
        {interactiveStickers.length > 0 ? (
          <View
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 6 }}
            pointerEvents="box-none"
          >
            {interactiveStickers.map((s, si) => {
              if (s.type === 'slider') {
                return (
                  <View
                    key={`slider-${s.id || si}`}
                    style={{ position: 'absolute', left: Number(s.x) || 0, top: Number(s.y) || 0 }}
                  >
                    <SliderStickerView
                      sticker={s}
                      statusId={cur?.id}
                      ownStatus={!!isSelf}
                      t={t}
                    />
                  </View>
                );
              }
              // Mention sticker — Instagram-style "@username" chip that
              // routes to the mentioned user's profile when tapped. Email
              // can live in `s.email` (preferred), otherwise fall back to
              // resolving via `s.username` (legacy). When neither parent
              // wired onMentionPress nor a target is present, the chip
              // stays decorative (no-op onPress).
              // TODO(backend): backend should send a push notification to
              // the mentioned user when a status containing their mention
              // is published. Currently the chat.php status_publish
              // pipeline doesn't fan out a "you were mentioned in a story"
              // FCM ping — track in chat_status_mentions table + push-notify
              // mention_type='status'.
              if (s.type === 'mention') {
                const username = String(s.username || '').replace(/^@/, '');
                const email = s.email || (username.includes('@') ? username : null);
                const targetEmail = email || (username ? `${username}` : null);
                const tappable = !!(onMentionPress && targetEmail);
                return (
                  <TouchableOpacity
                    key={`mention-${s.id || si}`}
                    activeOpacity={tappable ? 0.7 : 1}
                    disabled={!tappable}
                    onPress={() => {
                      if (!tappable) return;
                      try { if (_Haptics) _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Light); } catch {}
                      try { onMentionPress?.({ email: targetEmail, username, sticker: s, story: cur }); } catch {}
                    }}
                    style={{ position: 'absolute', left: Number(s.x) || 0, top: Number(s.y) || 0 }}
                    accessibilityRole="link"
                    accessibilityLabel={`@${username}`}
                  >
                    <View style={{
                      backgroundColor: 'rgba(59,130,246,0.92)',
                      borderRadius: 20, paddingVertical: 8, paddingHorizontal: 16,
                      borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
                      shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
                      elevation: 3,
                    }}>
                      <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
                        @{username}
                      </Text>
                    </View>
                  </TouchableOpacity>
                );
              }
              return null;
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
            wired by the caller. Disabled while the reply input is focused
            so reaching for the keyboard doesn't accidentally advance the
            story (user complained the viewer closed before they could
            finish typing). Dismisses the keyboard instead — same WhatsApp
            pattern (tap outside input → keyboard down, story stays). */}
        <Pressable
          style={{ position: 'absolute', left: 0, top: 110, bottom: Math.max(100, (insets?.bottom || 0) + 80), width: Math.max(winW * 0.3, 100) }}
          onPress={() => {
            // Swallow the opening tap that bled through from the home strip
            // ring — fires goPrev() at idx 0 (noop) but at higher groupIndex
            // jumps to the wrong user the instant the modal mounts.
            if (isFreshMount()) return;
            if (replyFocused) { try { Keyboard.dismiss(); } catch {} return; }
            _haptic('light'); goPrev();
          }}
          accessibilityLabel={t?.('status.previous') || 'Previous story'}
          accessibilityRole="button"
        />
        <Pressable
          style={{ position: 'absolute', right: 0, top: 110, bottom: Math.max(100, (insets?.bottom || 0) + 80), width: Math.max(winW * 0.3, 100) }}
          onPress={() => {
            // Same opening-tap swallow as the left zone — at last-item this
            // triggers `caughtUp` → 1.4s close, which reads as "fechou na
            // hora" since the user never had time to see the story.
            if (isFreshMount()) return;
            if (replyFocused) { try { Keyboard.dismiss(); } catch {} return; }
            _haptic('light'); advance();
          }}
          accessibilityLabel={t?.('status.next') || 'Next story'}
          accessibilityRole="button"
        />
        <Pressable
          style={{ position: 'absolute', left: Math.max(winW * 0.3, 100), right: Math.max(winW * 0.3, 100), top: 110, bottom: Math.max(100, (insets?.bottom || 0) + 80) }}
          onPressIn={(e) => {
            if (isFreshMount()) return;
            if (replyFocused) { try { Keyboard.dismiss(); } catch {} return; }
            setPaused(true);
            // Capture absolute screen position of the touch (pageX/pageY) so
            // the ripple paints exactly where the user pressed, not at the
            // pressable's origin. nativeEvent guards against synthetic web
            // events that lack pageX/pageY.
            try {
              const x = e?.nativeEvent?.pageX;
              const y = e?.nativeEvent?.pageY;
              if (Number.isFinite(x) && Number.isFinite(y)) {
                setRippleAt({ x, y });
                // Clear after ripple finishes (~360ms) so a second press
                // re-mounts the View and re-triggers the entry animation.
                setTimeout(() => setRippleAt(null), 400);
              }
            } catch {}
          }}
          onPress={(e) => {
            if (isFreshMount() || replyFocused) return;
            // Double-tap → fire a "❤️" reaction + a single flying heart
            // burst. Mirrors Instagram/TikTok double-tap-like UX without
            // disrupting the existing tap-hold-to-pause + tap-to-advance
            // behaviors (those are handled by onPressIn/onPressOut + the
            // left/right zones). 250ms window is the sweet spot between
            // "two intentional taps" and "two slow scrolls".
            const now = Date.now();
            const last = lastTapRef.current || 0;
            lastTapRef.current = now;
            if (now - last > 250) return;
            lastTapRef.current = 0; // consume — next pair starts fresh
            try {
              const x = e?.nativeEvent?.pageX;
              const y = e?.nativeEvent?.pageY;
              const burstId = `dt-${now}`;
              const burst = Array.from({ length: 4 }).map((_, i) => ({
                id: `${burstId}-${i}`,
                emoji: '❤️',
                dx: (Math.random() - 0.5) * 100,
                size: 30 + Math.random() * 22,
                delay: i * 50,
                anim: new Animated.Value(0),
                originX: Number.isFinite(x) ? x : null,
                originY: Number.isFinite(y) ? y : null,
              }));
              setHearts(prev => [...prev, ...burst]);
              burst.forEach(h => {
                Animated.timing(h.anim, {
                  toValue: 1, duration: 1200, delay: h.delay,
                  easing: Easing.out(Easing.quad),
                  useNativeDriver: true,
                }).start();
              });
              setTimeout(() => {
                setHearts(prev => prev.filter(p => !burst.find(b => b.id === p.id)));
              }, 1500);
              _haptic('medium');
              setReactPop('❤️');
              setTimeout(() => setReactPop(null), 900);
              try { onReact?.(cur, '❤️'); } catch {}
            } catch {}
          }}
          onPressOut={() => setPaused(false)}
        />

        {/* Tap-hold ripple — radial spread @ touch point. zIndex above media
            but below chrome; pointerEvents none so it never blocks anything.
            Scale 0.5 → 2.6, opacity 0.3 → 0 over 360ms. Color matches the
            brand gradient so the cue reads as "Chatyy" not generic OS ink. */}
        {rippleAt ? (
          <Animated.View
            pointerEvents="none"
            style={{
              position: 'absolute',
              left: rippleAt.x - 60, top: rippleAt.y - 60,
              width: 120, height: 120, borderRadius: 60,
              backgroundColor: 'rgba(255,255,255,0.3)',
              borderWidth: 2, borderColor: 'rgba(236,72,153,0.55)',
              zIndex: 15,
              opacity: rippleAnim.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
              transform: [{
                scale: rippleAnim.interpolate({ inputRange: [0, 1], outputRange: [0.5, 2.6] }),
              }],
            }}
          />
        ) : null}

        {/* Flying emoji animation */}
        {reactPop && (
          <View pointerEvents="none" style={{
            position: 'absolute', left: 0, right: 0, bottom: 100,
            alignItems: 'center', zIndex: 20,
          }}>
            <Text style={{ fontSize: 72 }}>{reactPop}</Text>
          </View>
        )}

        {/* Realtime reaction toast (owner side) — slides down from the top
            bar when a viewer reacts to one of OUR stories. Backed by the
            WS `status_react` event; no polling. Auto-dismisses after ~2.6s
            via the inline animation chain in the subscription effect. */}
        {reactToast && (
          <Animated.View
            pointerEvents="none"
            style={{
              // Float below the header pill (inset + ~46dp) so the toast
              // appears under it instead of overlapping the status bar.
              position: 'absolute', top: Math.max(insets?.top || 0, Platform.OS === 'android' ? 12 : 44) + 66,
              left: 0, right: 0, alignItems: 'center', zIndex: 30,
              opacity: reactToastAnim,
              transform: [{
                translateY: reactToastAnim.interpolate({
                  inputRange: [0, 1], outputRange: [-12, 0],
                }),
              }],
            }}
          >
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 8,
              backgroundColor: 'rgba(20,20,28,0.92)',
              borderRadius: 22, paddingHorizontal: 14, paddingVertical: 9,
              borderWidth: 1, borderColor: 'rgba(124,58,237,0.55)',
              shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 8,
              shadowOffset: { width: 0, height: 4 }, elevation: 6,
              maxWidth: '85%',
            }}>
              <Text style={{ fontSize: 20 }}>{reactToast.emoji}</Text>
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }} numberOfLines={1}>
                {reactToast.name
                  ? `${reactToast.name} ${t?.('status.reactedWith') || 'reagiu com'}`
                  : (t?.('status.someoneReacted') || 'Alguém reagiu')}
              </Text>
            </View>
          </Animated.View>
        )}

        {/* Save-to-gallery toast — confirms the file landed in the camera
            roll. Same chrome as the react toast so the visual language
            stays consistent. Anchored top so it doesn't fight the reply
            keyboard at the bottom. */}
        {savedToast && (
          <Animated.View
            pointerEvents="none"
            style={{
              // Match the react-toast offset (inset-aware) so the two toasts
              // share the same y-anchor when they stack.
              position: 'absolute', top: Math.max(insets?.top || 0, Platform.OS === 'android' ? 12 : 44) + 66,
              left: 0, right: 0, alignItems: 'center', zIndex: 31,
              opacity: savedToastAnim,
              transform: [{
                translateY: savedToastAnim.interpolate({
                  inputRange: [0, 1], outputRange: [-12, 0],
                }),
              }],
            }}
          >
            <View style={{
              flexDirection: 'row', alignItems: 'center', gap: 8,
              backgroundColor: 'rgba(34,197,94,0.95)',
              borderRadius: 22, paddingHorizontal: 14, paddingVertical: 9,
              shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 8,
              shadowOffset: { width: 0, height: 4 }, elevation: 6,
            }}>
              <IconCheck size={16} color="#fff" strokeWidth={3} />
              <Text style={{ color: '#fff', fontWeight: '700', fontSize: 13 }} numberOfLines={1}>
                {t?.('status.savedToGallery') || 'Salvo na galeria'}
              </Text>
            </View>
          </Animated.View>
        )}

        {/* Heart burst — 5 hearts spawned by long-press on ❤️ in the reaction
            row. Each one floats up ~180px while fading + scaling. Stacked at
            bottom: 130 (above the reaction row) so the flock appears to lift
            off the heart itself. zIndex 21 (one above reactPop) so the burst
            survives even mid-pop. */}
        {hearts.length > 0 && (
          <View pointerEvents="none" style={{
            position: 'absolute', left: 0, right: 0, bottom: 130,
            alignItems: 'center', zIndex: 21,
          }}>
            {hearts.map(h => (
              <Animated.Text
                key={h.id}
                style={{
                  position: 'absolute',
                  fontSize: h.size,
                  opacity: h.anim.interpolate({
                    inputRange: [0, 0.15, 0.8, 1],
                    outputRange: [0, 1, 1, 0],
                  }),
                  transform: [
                    { translateX: h.anim.interpolate({ inputRange: [0, 1], outputRange: [0, h.dx] }) },
                    { translateY: h.anim.interpolate({ inputRange: [0, 1], outputRange: [0, -200] }) },
                    { scale: h.anim.interpolate({ inputRange: [0, 0.3, 1], outputRange: [0.6, 1.15, 0.85] }) },
                    { rotate: h.anim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${h.dx > 0 ? 12 : -12}deg`] }) },
                  ],
                }}
              >
                {h.emoji}
              </Animated.Text>
            ))}
          </View>
        )}

        {/* Bottom bar — when reply is focused the surface darkens (proxy for
            backdrop-blur since expo-blur isn't bundled) and lifts ~6px so the
            composer reads as "elevated above the canvas" without an actual
            translation that would fight the keyboard offset. */}
        <Animated.View style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
          paddingHorizontal: 14, paddingBottom: (insets?.bottom || 0) + 14, paddingTop: 10,
          backgroundColor: replyEnter.interpolate({
            inputRange: [0, 1],
            outputRange: ['rgba(0,0,0,0.18)', 'rgba(0,0,0,0.55)'],
          }),
          zIndex: 10,
          transform: [{ translateY: keyboardOffset }],
          opacity: uiOpacity,
        }}>
          {isSelf ? (
            // Tappable "Seen by N" pill + reply aggregate pill — opens
            // inline viewers sheet when caller wired. Falls back to inline
            // label for surfaces that don't pass onSeenByPress.
            <View style={{ gap: 8 }}>
              {onSeenByPress ? (
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
                    {(cur?.views ?? 0)} {cur?.views === 1 ? (t?.('status.viewSingular') || 'visualização') : (t?.('status.viewPlural') || 'visualizações')}
                  </Text>
                </View>
              )}
              {/* Reply count pill — surfaced only when > 0 so empty stories
                  don't render a misleading "0 respostas" line. Backed by
                  statusAnalytics (owner-only). Tap is a no-op for now —
                  future wave wires it to a replies sheet listing the DM
                  cards that quoted this story. */}
              {(repliesCountById[cur.id] || 0) > 0 ? (
                <View
                  style={{
                    flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start',
                    gap: 8,
                    backgroundColor: 'rgba(124,58,237,0.78)',
                    borderRadius: 18, paddingHorizontal: 12, paddingVertical: 6,
                    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
                  }}
                >
                  <IconMessageSquare size={14} color="#fff" />
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
                    {(t?.('status.replies.count') || '{n} respostas').replace('{n}', repliesCountById[cur.id] || 0)}
                  </Text>
                </View>
              ) : null}
            </View>
          ) : (
            <View style={{ gap: 10 }}>
              {/* Quick reactions — scale-pop animation + medium haptic on tap.
                  Pulse ramps 1 → 1.6 → 1 via emojiPulse state; pairs with the
                  flying-emoji ReactPop overlay rendered above the bottom bar.
                  Haptic mirrors WhatsApp react UX: a short medium-strength
                  thump that confirms the touch landed even before the visual
                  catches up. */}
              <View style={{ flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 16 }}>
                {['❤️','🔥','😂','😮','😢','👏','👍'].map(emoji => {
                  const pulsing = emojiPulse === emoji;
                  const isHeart = emoji === '❤️';
                  return (
                    <TouchableOpacity
                      key={emoji}
                      // Long-press on the heart triggers a 5-heart burst with
                      // randomized horizontal drift + size + delay so the
                      // flock feels organic instead of cookie-cutter.
                      // Other emojis keep the single-pop behavior (long-press
                      // == tap on them) so the gesture stays predictable.
                      onLongPress={isHeart ? () => {
                        _haptic('medium');
                        try { onReact?.(cur, emoji); } catch {}
                        const now = Date.now();
                        const burst = Array.from({ length: 5 }).map((_, i) => ({
                          id: `${now}-${i}`,
                          emoji,
                          dx: (Math.random() - 0.5) * 120, // -60..+60 px drift
                          size: 28 + Math.random() * 24,   // 28..52 px
                          delay: i * 60,                   // staggered spawn
                          anim: new Animated.Value(0),
                        }));
                        setHearts(prev => [...prev, ...burst]);
                        burst.forEach(h => {
                          Animated.timing(h.anim, {
                            toValue: 1, duration: 1200, delay: h.delay,
                            easing: Easing.out(Easing.quad),
                            useNativeDriver: true,
                          }).start();
                        });
                        // Reap after the longest one finishes — keeps state lean.
                        setTimeout(() => {
                          setHearts(prev => prev.filter(p => !burst.find(b => b.id === p.id)));
                        }, 1500);
                      } : undefined}
                      delayLongPress={isHeart ? 280 : undefined}
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
                // Reply input wrapper — slide-up (4px) + brighten the field
                // when focused so the active state is obvious. Native driver
                // for transform; backgroundColor lerp via the parent's
                // replyEnter (already non-native).
                <Animated.View style={{
                  flexDirection: 'row', alignItems: 'center', gap: 8,
                  backgroundColor: replyEnter.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['rgba(255,255,255,0.15)', 'rgba(255,255,255,0.22)'],
                  }),
                  borderRadius: 24, paddingLeft: 14, paddingRight: 6,
                  borderWidth: 1,
                  borderColor: replyEnter.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['rgba(255,255,255,0.28)', 'rgba(255,255,255,0.55)'],
                  }),
                  transform: [{
                    translateY: replyEnter.interpolate({ inputRange: [0, 1], outputRange: [0, -4] }),
                  }],
                }}>
                  <IconMessageSquare size={16} color="rgba(255,255,255,0.7)" />
                  <TextInput
                    value={replyText}
                    onChangeText={setReplyText}
                    onFocus={() => {
                      setPaused(true);
                      setReplyFocused(true);
                      // Tapping the input itself counts as engagement — clear
                      // any leftover grace from a previous blur so the cadence
                      // restarts cleanly when they finish typing.
                      replyGraceRef.current = false;
                      if (replyGraceTimerRef.current) { clearTimeout(replyGraceTimerRef.current); replyGraceTimerRef.current = null; }
                    }}
                    onBlur={() => {
                      setReplyFocused(false);
                      // Hold the grace flag for 4s so the auto-advance timer
                      // resumes with a minimum 4.5s window even if the user
                      // had nearly consumed the original 5s before tapping
                      // reply. Without this, blur → setPaused(false) snaps
                      // to advance in <1s and the user loses their place.
                      replyGraceRef.current = true;
                      if (replyGraceTimerRef.current) clearTimeout(replyGraceTimerRef.current);
                      replyGraceTimerRef.current = setTimeout(() => {
                        replyGraceRef.current = false;
                        replyGraceTimerRef.current = null;
                      }, 4000);
                      setPaused(false);
                    }}
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
                </Animated.View>
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
                      <View style={{ flexDirection: 'row', alignItems: 'center', paddingVertical: 8, gap: 12 }}>
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
