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

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, TextInput, Pressable, Image,
  Platform, Modal, Alert, Animated, Keyboard, FlatList, ActivityIndicator,
  PanResponder, AppState, Linking, Easing, Dimensions, StyleSheet,
} from 'react-native';
import * as api from '../../services/api';
import { BASE_URL } from '../../services/api';
import { IconX, IconPlus, IconTrash, IconSend, IconCheck, IconMessageSquare, IconEye, IconMusic, IconVolume2, IconVolumeX, IconPause, IconArrowRight, IconDownload, IconCamera, IconAlertTriangle } from '../Icons';
import AvatarCircle from '../AvatarCircle';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect as SvgRect, Path } from 'react-native-svg';
// Shared text-status gradient presets + resolver — single source of truth so
// StoryViewer, AnimatedStatusText and ChatStatusTab never drift apart.
import { resolveTextGradient as _resolveTextGradient } from './textGradients';

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

// Walk a status item and surface the freehand draw strokes the publisher
// painted in the composer. The composer (ChatStatusTab) serializes them under
// `meta.draw_paths` (also tolerant of a top-level `draw_paths` for legacy
// rows). Each path is `{ color, points: [{x,y}] }` in the SAME pixel space the
// composer captured, so the viewer paints them at the raw (x, y) — identical
// to how gif/interactive stickers are placed. Without this, every drawing was
// silently dropped on the viewer side.
function _extractDrawPaths(item) {
  if (!item) return [];
  const lists = [];
  if (Array.isArray(item.draw_paths)) lists.push(item.draw_paths);
  if (Array.isArray(item.meta?.draw_paths)) lists.push(item.meta.draw_paths);
  const out = [];
  for (const list of lists) {
    for (const p of list) {
      if (!p || !Array.isArray(p.points) || p.points.length < 2) continue;
      out.push({
        color: typeof p.color === 'string' ? p.color : '#fff',
        points: p.points
          .filter(pt => pt && typeof pt.x === 'number' && typeof pt.y === 'number')
          .map(pt => ({ x: pt.x, y: pt.y })),
      });
    }
    // First non-empty source wins — avoids double-painting when the backend
    // serializes both top-level and meta copies for compat.
    if (out.length > 0) break;
  }
  return out.filter(p => p.points.length >= 2);
}

// Walk a status item and surface the draggable text overlays the publisher
// added in the composer (`meta.text_overlays`, tolerant of a top-level copy).
// Each overlay is `{ text, x, y, color }` in the composer's pixel space, so
// the viewer paints them at the raw (x, y) just like stickers. Without this,
// text drawn over a photo never appeared in the viewer.
function _extractTextOverlays(item) {
  if (!item) return [];
  const lists = [];
  if (Array.isArray(item.text_overlays)) lists.push(item.text_overlays);
  if (Array.isArray(item.meta?.text_overlays)) lists.push(item.meta.text_overlays);
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const to of list) {
      if (!to || !to.text) continue;
      const x = Number(to.x) || 0;
      const y = Number(to.y) || 0;
      const key = `${to.text}:${x}:${y}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ text: String(to.text), x, y, color: typeof to.color === 'string' ? to.color : '#fff' });
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

  // The PanResponder is created ONCE (useRef), so its handlers keep
  // first-render bindings forever: `value` was frozen at 50 — every vote hit
  // the server as 50 no matter where the user dragged — and statusId/
  // stickerId/submitted/trackWidth were equally stale (the component is
  // mounted without a key, so navigating stories re-uses this instance and
  // a vote could even land on the WRONG status). Mirror the live values into
  // a ref the handlers read at call time.
  const liveRef = useRef({});
  liveRef.current = { value, submitted, trackWidth, ownStatus, statusId, stickerId };

  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => !liveRef.current.submitted && !liveRef.current.ownStatus,
    onMoveShouldSetPanResponder: () => !liveRef.current.submitted && !liveRef.current.ownStatus,
    onPanResponderGrant: () => {
      startValueRef.current = liveRef.current.value;
    },
    onPanResponderMove: (_, g) => {
      const tw = liveRef.current.trackWidth || 220;
      const next = Math.max(0, Math.min(100, Math.round(startValueRef.current + (g.dx / tw) * 100)));
      setValue(next);
    },
    onPanResponderRelease: async () => {
      try {
        if (_Haptics) _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Medium);
      } catch {}
      const sent = liveRef.current.value;
      setSubmitted(true);
      try {
        const r = await api.statusSliderVote(liveRef.current.statusId, sent, liveRef.current.stickerId);
        if (r?.success) {
          if (typeof r?.data?.avg_value === 'number') setAvg(r.data.avg_value);
          try { onVoted?.(sent); } catch {}
        } else {
          // Failed vote must not stay "confirmed" — re-enable the slider.
          setSubmitted(false);
        }
      } catch { setSubmitted(false); }
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

// Native expo-video player for status videos. HOISTED to module level (vs the
// old inline definition inside renderMedia) so React sees a STABLE component
// type across the frequent progress-driven re-renders — otherwise every tick
// minted a fresh function object → unmount/remount of VideoView+player → the
// buffering flash + player churn users reported. Memoized so it only re-renders
// when its props actually change.
//
// `mod` (the resolved expo-video module) is passed in by the caller so we don't
// pay a require() on every render and so the caller can fall through to expo-av
// when expo-video is unavailable. `liveMuted` is the live mute toggle (caller
// flips it; we push it to the player); `initialMuted`/`loop` seed the player.
const StatusVideoPlayer = React.memo(function StatusVideoPlayer({
  mod, uri, loop, initialMuted, liveMuted, poster, paused, onEnd, onError, onReady, onProgress,
}) {
  const { useVideoPlayer, VideoView } = mod;
  // [WAVE 93 2026-05-21] Seed loop + mute from the CURRENT item's props so each
  // advance to a new video gets the right semantics (not the first item's,
  // which the old inline closure captured).
  const player = useVideoPlayer(uri, (p) => {
    try { p.loop = !!loop; p.muted = !!initialMuted; p.play(); } catch {}
  });
  const endedRef = useRef(false);
  const readyRef = useRef(false);
  // Live mirror of `paused` so the 'ended'/max-duration listeners can consult
  // it WITHOUT re-subscribing on every pause toggle (re-subbing mid-playback
  // can drop the native 'ended' event). Kept in sync by the pause/play effect.
  const pausedRef = useRef(!!paused);
  // Pause/resume the player in lockstep with the viewer. Long-press, typing a
  // reply (paused = paused||replyFocused), and app-background all flow in via
  // the `paused` prop; without this the video kept playing under a "paused"
  // story and auto-advanced mid-reply. expo-video is property/imperative:
  // pause()/play() are safe to call repeatedly.
  useEffect(() => {
    pausedRef.current = !!paused;
    try { if (paused) player.pause?.(); else player.play?.(); } catch {}
  }, [player, paused]);
  // Sync mute toggle live — caller flips liveMuted, we push it down.
  useEffect(() => { try { player.muted = !!liveMuted; } catch {} }, [player, liveMuted]);
  // Sync loop flag too — a status carousel can mix boomerang + normal clips,
  // so update player.loop when it changes between idx steps without recreating.
  useEffect(() => { try { player.loop = !!loop; } catch {} }, [player, loop]);
  // Listen for status updates to detect load errors + ready state.
  useEffect(() => {
    const sub = player.addListener?.('statusChange', (s) => {
      const status = s?.status || s;
      if (s?.error || status === 'error') { onError?.(); }
      // expo-video reports 'readyToPlay' once the first frame is decoded —
      // that's when we hide the spinner.
      if (status === 'readyToPlay' || status === 'playing') { readyRef.current = true; onReady?.(); }
    });
    return () => { try { sub?.remove?.(); } catch {} };
  }, [player, onError, onReady]);

  // Progress feed — push the playback fraction (currentTime/duration) up so the
  // active segment's progress bar actually fills DURING a video (it used to sit
  // at 0% the whole clip because the JS timer is skipped for videos). Prefer the
  // native 'timeUpdate' event; fall back to a light 250ms poll of currentTime.
  useEffect(() => {
    if (loop || !onProgress) return undefined;
    let poll = null;
    const push = () => {
      try {
        const dur = Number(player.duration);
        const cur = Number(player.currentTime);
        if (Number.isFinite(dur) && dur > 0 && Number.isFinite(cur)) {
          onProgress(Math.max(0, Math.min(1, cur / dur)));
        }
      } catch {}
    };
    const sub = player.addListener?.('timeUpdate', push);
    if (!sub) poll = setInterval(push, 250);
    return () => {
      try { sub?.remove?.(); } catch {}
      if (poll) clearInterval(poll);
    };
  }, [player, loop, onProgress]);

  // Stuck-video watchdog — if the clip never reaches readyToPlay AND never
  // ends within ~9s (dead URL, codec stall, dropped events), surface the error
  // card via onError so the viewer doesn't freeze on a black canvas forever.
  // Cleared as soon as the first frame decodes. Skipped for looping/boomerang
  // clips (they intentionally never end). Doesn't fire while paused.
  useEffect(() => {
    if (loop) return undefined;
    const timer = setTimeout(() => {
      if (!readyRef.current && !endedRef.current && !pausedRef.current) {
        try { onError?.(); } catch {}
      }
    }, 9000);
    return () => clearTimeout(timer);
  }, [player, loop, onError]);
  // [PRIMARY AUTO-ADVANCE] expo-video fires 'ended' at end-of-playback for a
  // non-looping clip. The old inline path had NO end listener so native video
  // stories hung forever. Belt-and-suspenders: also arm a max-duration timeout
  // from player.duration once known, in case the 'ended' event is dropped.
  useEffect(() => {
    if (loop) return undefined; // boomerang/looping clips never auto-advance here
    endedRef.current = false;
    let retry = null;
    // Gate advance while paused/typing — if `ended` (or the max-duration
    // fallback) lands while the story is paused (long-press, reply focused,
    // backgrounded), DON'T advance. Re-check shortly so it fires the moment the
    // user resumes instead of swallowing the end entirely.
    const fire = () => {
      if (endedRef.current) return;
      if (pausedRef.current) {
        if (!retry) retry = setInterval(() => { if (!pausedRef.current) fire(); }, 300);
        return;
      }
      endedRef.current = true;
      if (retry) { clearInterval(retry); retry = null; }
      onEnd?.();
    };
    const sub = player.addListener?.('ended', fire);
    let maxTimer = null;
    const armMaxTimer = () => {
      try {
        const dur = player.duration;
        if (Number.isFinite(dur) && dur > 0 && !maxTimer) {
          maxTimer = setTimeout(fire, dur * 1000 + 600);
        }
      } catch {}
    };
    armMaxTimer();
    // duration is often unknown at mount; re-check once playback is ready.
    const subReady = player.addListener?.('statusChange', (s) => {
      const status = s?.status || s;
      if (status === 'readyToPlay' || status === 'playing') armMaxTimer();
    });
    return () => {
      try { sub?.remove?.(); } catch {}
      try { subReady?.remove?.(); } catch {}
      if (maxTimer) clearTimeout(maxTimer);
      if (retry) clearInterval(retry);
    };
  }, [player, loop, onEnd]);
  // Defensive teardown on unmount — reclaim AVPlayer/MediaCodec buffers.
  useEffect(() => () => {
    try { player.pause?.(); } catch {}
    try { player.replace?.(null); } catch {}
    try { player.release?.(); } catch {}
  }, [player]);
  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {poster}
      <VideoView player={player} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} contentFit="contain" nativeControls={false} />
    </View>
  );
});

// StoryMedia — the per-item media canvas (text / image / video), HOISTED to
// module level and wrapped in React.memo so transient parent state ticks
// (reactPop, hearts, emojiPulse, paused, toast) don't rebuild + re-reconcile
// the expensive media subtree on every render. It only re-renders when one of
// its actual inputs changes (the current item, the resolved URL, the per-item
// error/retry/mute flags, or the imageFade ref). Behavior + visuals are a
// verbatim move of the former inline `renderMedia()` — no logic change.
const StoryMedia = React.memo(function StoryMedia({
  cur, isText, isVideo, isImage, mediaUrl,
  t, paused, videoMuted, videoError, imageError, imageRetry, imageFade,
  advance, advanceNatural, onVideoError, onVideoReady, onVideoProgress, setVideoError, setImageError, setImageRetry,
  boomerangRef, boomerangStateRef,
}) {
    if (isText) {
      // Gradient text status — bg_color is a `gradient:<id>` token instead
      // of a hex value. Paint the SVG behind the text in absoluteFill so
      // the gradient bleeds edge-to-edge while the centered Text stays put.
      // Backend serializes chat_user_status.bg_color into the wire field
      // `background` (status_list / status_create / WS / manifest all use that
      // key — there is NO `bg_color` key on the wire). Reading only cur.bg_color
      // made every text+music status fall back to plain green / black-no-gradient
      // = the "status sem foto/sem visual" bug. Accept both keys (matches the
      // ChatStatusTab pattern: cur?.background || cur?.bg_color).
      const _bg = cur.bg_color || cur.background;
      const gradient = _resolveTextGradient(_bg);
      const stops = gradient
        ? (gradient.colors.length > 1 ? gradient.colors : [gradient.colors[0], gradient.colors[0]])
        : null;
      return (
        <View style={{ flex: 1, backgroundColor: gradient ? '#000' : (_bg || '#25D366'), alignItems: 'center', justifyContent: 'center', padding: 30 }}>
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
          <View style={{ flex: 1, backgroundColor: '#1a0a2e', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
            <ActivityIndicator size="large" color="rgba(255,255,255,0.85)" />
            <Text style={{ marginTop: 16, color: 'rgba(255,255,255,0.85)', fontSize: 14, fontWeight: '600', textAlign: 'center' }}>
              {t?.('status.loading') || 'Carregando…'}
            </Text>
          </View>
        );
      }
      return (
        <View style={{ flex: 1, backgroundColor: '#1a0a2e', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <View style={{ marginBottom: 12 }}><IconCamera size={40} color="rgba(255,255,255,0.55)" /></View>
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
            <View style={{ marginBottom: 14 }}><IconAlertTriangle size={38} color="rgba(255,255,255,0.55)" /></View>
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
              onEnded={isBoomerang ? undefined : advanceNatural}
              onError={() => setVideoError(true)}
              onLoadedMetadata={isBoomerang ? (() => setTimeout(advanceNatural, boomerangLoopDurationMs)) : undefined}
              style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain', backgroundColor: 'transparent' }}
            />
          </View>
        );
      }
      // Prefer expo-video (SDK 55+); fall back to expo-av for older bundles.
      // The player itself lives in the module-level <StatusVideoPlayer> so it
      // doesn't get remounted on every progress tick (the hook used to be
      // defined inside this render fn → new component type each render). For
      // a non-boomerang clip we pass `onEnd={advance}` so it auto-advances at
      // end-of-playback (the inline path had no end listener → native video
      // stories hung forever).
      try {
        const _expoVideoMod = require('expo-video');
        if (_expoVideoMod?.useVideoPlayer && _expoVideoMod?.VideoView) {
          return (
            <StatusVideoPlayer
              mod={_expoVideoMod}
              uri={mediaUrl}
              loop={isBoomerang}
              initialMuted={videoMuted}
              liveMuted={videoMuted}
              poster={PosterOverlay}
              paused={paused}
              onEnd={advanceNatural}
              onError={onVideoError}
              onReady={onVideoReady}
              onProgress={onVideoProgress}
            />
          );
        }
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
            onLoad={isBoomerang ? (() => setTimeout(advanceNatural, boomerangLoopDurationMs)) : undefined}
            onPlaybackStatusUpdate={(s) => {
              if (!isBoomerang) { if (s?.didJustFinish) advanceNatural(); return; }
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
    // statuses without thumbnail_url (the wrapper's #1a0a2e tint reads as
    // a soft brand-purple, not pitch black).
    //
    // [WAVE 99 2026-05-21] When backend didn't ship a thumbnail_url for an
    // image status (most image rows, since chat.php only generates thumbs
    // for video — line 8972), fall back to the media_url ITSELF blurred so
    // the blackness gap before/around expo-image's fade-in window is
    // covered by the same image content rather than a dark void. expo-image
    // dedupes by URL so this is essentially free (same bytes used by the
    // sharp foreground load).
    const imagePoster = cur.thumbnail_url
      ? (cur.thumbnail_url.startsWith('http') ? cur.thumbnail_url : `${BASE_URL}${cur.thumbnail_url}`)
      : mediaUrl;
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
    // [WAVE 99 2026-05-21] Error fallback chip — replaces the silent-black
    // canvas when expo-image / RN Image / <img> fails to decode. Surfaces
    // the real reason in dev logs + offers a Retry tap that bumps the
    // imageRetry counter — that remounts the underlying image with a fresh
    // cache key (cachePolicy="none" on retry) so a poisoned disk cache entry
    // can't soft-brick the viewer forever. Branded #1a0a2e backdrop so the
    // canvas reads as "Stories" not "app crashed". Falls through to next
    // story via the existing auto-advance timer so a single broken item
    // doesn't dead-end the carousel.
    if (imageError) {
      return (
        <View style={{ flex: 1, backgroundColor: '#1a0a2e', alignItems: 'center', justifyContent: 'center', padding: 30 }}>
          <View style={{ marginBottom: 14 }}><IconAlertTriangle size={38} color="rgba(255,255,255,0.55)" /></View>
          <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 16, fontWeight: '700', textAlign: 'center' }}>
            {t?.('status.imageUnavailable') || 'Imagem indisponível'}
          </Text>
          <Text style={{ marginTop: 6, color: 'rgba(255,255,255,0.55)', fontSize: 12, textAlign: 'center', paddingHorizontal: 12 }}>
            {t?.('status.imageUnavailableHint') || 'Toque pra tentar de novo ou avance pra próxima.'}
          </Text>
          <TouchableOpacity
            onPress={() => {
              setImageError(false);
              setImageRetry(r => r + 1);
              imageFade.setValue(0);
              Animated.timing(imageFade, { toValue: 1, duration: 200, useNativeDriver: true }).start();
            }}
            style={{
              marginTop: 18, paddingHorizontal: 22, paddingVertical: 10,
              borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.16)',
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.28)',
            }}
            accessibilityRole="button"
          >
            <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>
              {t?.('status.retry') || 'Tentar de novo'}
            </Text>
          </TouchableOpacity>
        </View>
      );
    }
    // On retry, bypass the (possibly poisoned) disk cache for one fetch so
    // we don't loop on the bad entry. After a successful onLoad it'll be
    // re-cached fresh.
    const _imgCachePolicy = imageRetry > 0 ? 'none' : 'memory-disk';
    // Brand-tinted backdrop replaces #0f172a slate. When expo-image fails
    // but the safety-net imageFade forces opacity 1 anyway, the user at
    // least sees a recognizable dark-purple "Stories canvas" — not a blank
    // black void the user calls "preto puro".
    const _wrapperBg = '#1a0a2e';
    // Force-remount the inner image whenever URL or retry counter changes
    // so React doesn't reuse a stale instance still tied to the old cache
    // hit. expo-image internally dedupes by source.uri so the key= is the
    // only escape hatch.
    const _imgKey = `${mediaUrl}::${imageRetry}`;
    if (_ExpoImage && !WEB) {
      // Image fade-in: opacity ramps 0 → 1 once expo-image fires onLoad.
      // Native driver makes it free; transition prop alone gives a slight
      // crossfade INSIDE expo-image but doesn't cover the empty-frame gap
      // before any data has arrived. Poster sits underneath via absolute
      // positioning so the blurred thumb peeks while the full payload lands.
      return (
        <View style={{ flex: 1, backgroundColor: _wrapperBg }}>
          {ImagePosterLayer}
          <Animated.View style={{ flex: 1, opacity: imageFade }}>
            <_ExpoImage
              key={_imgKey}
              source={{ uri: mediaUrl }}
              style={{ width: '100%', height: '100%' }}
              contentFit="contain"
              cachePolicy={_imgCachePolicy}
              priority="high"
              transition={120}
              onLoad={() => {
                Animated.timing(imageFade, { toValue: 1, duration: 350, useNativeDriver: true }).start();
              }}
              onError={(e) => {
                if (__DEV__) {
                  try { console.warn('[STATUS-IMG-ERR]', mediaUrl, e?.nativeEvent?.error || e?.error || e); } catch {}
                }
                setImageError(true);
                imageFade.setValue(1);
              }}
            />
          </Animated.View>
        </View>
      );
    }
    return WEB
      ? (
        <div style={{ position: 'relative', width: '100%', height: '100%', backgroundColor: _wrapperBg }}>
          {ImagePosterLayer}
          <img
            key={_imgKey}
            src={mediaUrl}
            alt=""
            style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', objectFit: 'contain' }}
            onError={() => {
              if (typeof console !== 'undefined') {
                try { console.warn('[STATUS-IMG-ERR-web]', mediaUrl); } catch {}
              }
              setImageError(true);
            }}
          />
        </div>
      )
      : (
        <View style={{ flex: 1, backgroundColor: _wrapperBg }}>
          {ImagePosterLayer}
          <Animated.View style={{ flex: 1, opacity: imageFade }}>
            <Image
              key={_imgKey}
              source={{ uri: mediaUrl }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="contain"
              onLoad={() => {
                Animated.timing(imageFade, { toValue: 1, duration: 350, useNativeDriver: true }).start();
              }}
              onError={(e) => {
                if (__DEV__) {
                  try { console.warn('[STATUS-IMG-ERR-rn]', mediaUrl, e?.nativeEvent?.error || e); } catch {}
                }
                setImageError(true);
                imageFade.setValue(1);
              }}
            />
          </Animated.View>
        </View>
      );
});

// Status music player — plays the chosen track preview WHILE a music status is
// on screen. Lives INSIDE the viewer so music plays from EVERY entry point
// (home status strip, profile, chat tab), not only ChatStatusTab — previously
// StoryViewer only showed the music *name* pill and never played audio, so the
// user saw "nome aparece mas a música não toca" from most surfaces.
//
// CRITICAL (2026-05-29): this project is Expo SDK 55, which DROPPED expo-av in
// favor of expo-audio. The previous version did `require('expo-av').Audio`,
// which THROWS (module not installed) → caught → `_StatusAudio` stayed null →
// the player early-returned and NOTHING ever played, from any surface. That was
// the real reason "a música não toca" survived every prior fix. Rewritten on
// expo-audio's imperative API (createAudioPlayer + setAudioModeAsync). Note the
// option names differ from expo-av: `playsInSilentMode` (not ...IOS) so iOS
// plays with the ringer switch off; player is property-driven (.loop/.volume/
// .play()/.remove()) and auto-loads its source. No-op if the module or url is
// missing. Loops the ~30s preview while the story is visible & not paused.
let _expoAudio = null;
try { _expoAudio = require('expo-audio'); } catch {}

// Full-screen visual for a voice-only status: gradient backdrop + mic disc +
// a static waveform + label. The audio itself is driven by StatusMusicPlayer;
// this only paints the canvas (StoryMedia handles image/video/text).
function VoiceStatusMedia({ caption, bgColor, t }) {
  const bg = (bgColor && /^#|rgb/.test(String(bgColor))) ? bgColor : '#7C3AED';
  const bars = [10, 18, 26, 16, 30, 22, 34, 20, 28, 14, 24, 32, 18, 26, 12, 22, 30, 16, 24, 20];
  return (
    <View style={{ flex: 1, backgroundColor: bg, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 }}>
      <View style={{ width: 108, height: 108, borderRadius: 54, backgroundColor: 'rgba(255,255,255,0.16)', alignItems: 'center', justifyContent: 'center', marginBottom: 26 }}>
        <View style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}>
          <IconMusic size={40} color="#fff" />
        </View>
      </View>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 40 }}>
        {bars.map((h, i) => (
          <View key={i} style={{ width: 4, height: h, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.85)' }} />
        ))}
      </View>
      <Text style={{ color: 'rgba(255,255,255,0.9)', fontSize: 14, fontWeight: '600', marginTop: 24, letterSpacing: 0.3 }}>
        {t?.('status.voiceStatus') || 'Mensagem de voz'}
      </Text>
      {!!caption && (
        <Text style={{ color: '#fff', fontSize: 16, fontWeight: '500', marginTop: 12, textAlign: 'center' }} numberOfLines={3}>{caption}</Text>
      )}
    </View>
  );
}

function StatusMusicPlayer({ url, active, startMs = 0 }) {
  const playerRef = useRef(null);
  useEffect(() => {
    // Tear down any previous track first (item changed / paused / closed).
    if (playerRef.current) { try { playerRef.current.remove(); } catch {} playerRef.current = null; }
    if (!url || !active || !_expoAudio || !_expoAudio.createAudioPlayer) return;
    let cancelled = false;
    (async () => {
      // iOS: must set the audio session BEFORE playing or the ringer switch
      // mutes us. playsInSilentMode is the expo-audio spelling.
      try { await _expoAudio.setAudioModeAsync({ playsInSilentMode: true, shouldPlayInBackground: false }); } catch {}
      if (cancelled) return;
      try {
        const player = _expoAudio.createAudioPlayer({ uri: url });
        player.loop = true;
        player.volume = 1.0;
        // Seek to the author-picked "trecho" start offset (music_start_ms) so
        // playback begins where they trimmed it — WhatsApp/IG store this offset.
        // expo-audio's seekTo takes SECONDS; guard since source may still be
        // loading (seek is best-effort, the player re-applies on play()).
        const startSec = Math.max(0, Number(startMs) || 0) / 1000;
        if (startSec > 0) { try { await player.seekTo(startSec); } catch {} }
        if (cancelled) { try { player.remove(); } catch {} return; }
        player.play(); // source auto-loads; play() is safe to call immediately
        playerRef.current = player;
      } catch {}
    })();
    return () => {
      cancelled = true;
      if (playerRef.current) { try { playerRef.current.remove(); } catch {} playerRef.current = null; }
    };
  }, [url, active, startMs]);
  return null;
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
  // [WAVE 99 2026-05-21] Image error tracking — symmetric counterpart to
  // videoError. Without it, when expo-image fails (404, decode error, signed
  // URL expired, CORS) onLoad never fires + imageFade stayed at 0 → the
  // viewer's media canvas was solid #0f172a / black to the user with NO
  // signal to retry. Bug user 2026-05-21 print: "Aleff Duarte 21h / 1
  // visualização / mídia área PRETO PURO". Real status row in DB, URL
  // returns 200, but expo-image's memory-disk cache likely held a
  // poisoned/half-written entry from an earlier tap. Now: onError flips
  // this flag → we paint a brand-tinted error card with a Retry tap that
  // bumps the retry counter, which forces a `key=` remount + bypasses the
  // cache for the next attempt.
  const [imageError, setImageError] = useState(false);
  const [imageRetry, setImageRetry] = useState(0);
  // Caught-up "all done" overlay shown for 1.4s before the modal closes when
  // the user finishes the last story — Instagram pattern, replaces the abrupt
  // dismiss that left users wondering "did I tap something wrong?".
  const [caughtUp, setCaughtUp] = useState(false);
  const caughtUpAnim = useRef(new Animated.Value(0)).current;
  // Pending 1.4s auto-close armed when the overlay shows. Without the ref the
  // timeout fired into rewinds and brand-new sessions (viewer reopened within
  // 1.4s closed itself on top of fresh stories).
  const caughtUpTimerRef = useRef(null);
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
    // BUG FIX (2026-05-25) — owner never saw the live reaction toast. The
    // backend emits the WS event as `status_reaction` (chat.php status_react
    // handler → event:'status_reaction'), but this listener only subscribed
    // to `status_react`. The websocket dispatcher emits `msg.type` verbatim
    // with no alias, so the names never matched and the handler never fired.
    // Subscribe to BOTH names so we catch the canonical `status_reaction` and
    // stay compatible with any path/remap that uses the short `status_react`.
    const onReaction = (data) => {
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
    };
    const sub = _mailWs.on('status_reaction', onReaction);
    const subLegacy = _mailWs.on('status_react', onReaction);
    return () => {
      try { sub?.(); } catch {}
      try { subLegacy?.(); } catch {}
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
  // Group-nav props are frozen inside the once-created PanResponder below
  // (same first-render-binding trap the slider's liveRef solves above): on a
  // cold mount they're still the null/0 defaults so the horizontal gesture is
  // never claimed; on a warm reuse a stale groupIndex navigates to the wrong
  // group. Mirror them into a ref the handlers read at gesture time.
  const groupNavRef = useRef({});
  groupNavRef.current = { groupIndex, groupCount, onNextGroup, onPrevGroup };
  const panResponder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (evt, gs) => {
        // Horizontal swipe between user groups — only claim when there's
        // actually a target on that side (onNextGroup/onPrevGroup wired
        // AND we're not already at the edge). Threshold 12px + dx > dy*1.5
        // so a slight diagonal still feels like horizontal intent.
        if (Math.abs(gs.dx) > 12 && Math.abs(gs.dx) > Math.abs(gs.dy) * 1.5) {
          const gn = groupNavRef.current;
          const canNext = gs.dx < 0 && gn.onNextGroup && gn.groupIndex < gn.groupCount - 1;
          const canPrev = gs.dx > 0 && gn.onPrevGroup && gn.groupIndex > 0;
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
          const gn = groupNavRef.current;
          const canNext = gs.dx < 0 && gn.onNextGroup && gn.groupIndex < gn.groupCount - 1;
          const canPrev = gs.dx > 0 && gn.onPrevGroup && gn.groupIndex > 0;
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
          const gn = groupNavRef.current;
          const threshold = 60;
          const fling = Math.abs(gs.vx) > 0.6;
          gestureAxisRef.current = null;
          if (gs.dx < -threshold || (gs.dx < 0 && fling)) {
            if (gn.onNextGroup && gn.groupIndex < gn.groupCount - 1) {
              if (_Haptics && Platform.OS !== 'web') {
                try { _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Light); } catch {}
              }
              // Slide out to the left then snap back to 0 once the parent
              // swaps the stories prop — caller is sync so this is fine.
              Animated.timing(dragX, { toValue: -winW, duration: 180, useNativeDriver: true })
                .start(() => {
                  dragX.setValue(0);
                  try { groupNavRef.current.onNextGroup(); } catch {}
                });
              setPaused(false);
              return;
            }
          } else if (gs.dx > threshold || (gs.dx > 0 && fling)) {
            if (gn.onPrevGroup && gn.groupIndex > 0) {
              if (_Haptics && Platform.OS !== 'web') {
                try { _Haptics.impactAsync(_Haptics.ImpactFeedbackStyle.Light); } catch {}
              }
              Animated.timing(dragX, { toValue: winW, duration: 180, useNativeDriver: true })
                .start(() => {
                  dragX.setValue(0);
                  try { groupNavRef.current.onPrevGroup(); } catch {}
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
  // Block all close/nav handlers for 600ms after visible flips to true.
  // [2026-05-25] Bumped 250ms → 600ms. The deferred empty-stories auto-close
  // below arms a 350ms timer; with the old 250ms window that timer could
  // outlive the guard and dismiss the viewer the instant it opened from the
  // chat-list strip (bug "nem abre e já fecha"). The chat-list path passes a
  // freshly-locked snapshot whose array reference flips across the same
  // state-flush that sets statusViewerEmail, so `stories` can be momentarily
  // read as [] by the auto-close effect's stale closure right after mount.
  // 600ms comfortably covers the 350ms close timer + the fade/spring anims.
  const mountAtRef = useRef(0);
  const isFreshMount = useCallback(() => {
    return mountAtRef.current > 0 && (Date.now() - mountAtRef.current) < 600;
  }, []);
  // Always-current view of the stories prop so deferred timers (auto-close)
  // re-check the LIVE value instead of a stale closure captured when the
  // effect armed. Prevents closing a viewer that received items in the gap.
  const storiesRef = useRef(stories);
  storiesRef.current = stories;

  useEffect(() => {
    if (visible) {
      mountAtRef.current = Date.now();
      setIdx(Math.min(Math.max(0, startIdx || 0), Math.max(0, (stories?.length || 1) - 1)));
      setPaused(false);
      // [deep-20260801] Force the playback effect's per-item reset on (re)open
      // — same idx/id as the previous session must still reset progress/fade.
      lastItemKeyRef.current = null;
      setCaughtUp(false);
      caughtUpAnim.setValue(0);
      // A close armed in a previous session must not fire into this one.
      if (caughtUpTimerRef.current) { clearTimeout(caughtUpTimerRef.current); caughtUpTimerRef.current = null; }
      // Fresh viewer session — clear any leftover grace from a previous open.
      replyGraceRef.current = false;
      if (replyGraceTimerRef.current) { clearTimeout(replyGraceTimerRef.current); replyGraceTimerRef.current = null; }
    } else {
      mountAtRef.current = 0;
      // Modal closed — kill the grace timer so it can't fire against a stale
      // closure after the user already moved on.
      if (replyGraceTimerRef.current) { clearTimeout(replyGraceTimerRef.current); replyGraceTimerRef.current = null; }
      if (caughtUpTimerRef.current) { clearTimeout(caughtUpTimerRef.current); caughtUpTimerRef.current = null; }
    }
    // Deps: groupIndex (not stories?.length) — the reset must fire on open,
    // explicit startIdx change and group swap, but NOT when the stories array
    // merely grows/shrinks mid-view (WS-arrived status, remote delete): that
    // used to snap the viewer back to startIdx while the user was mid-group.
    // Out-of-range idx after a shrink is handled by the render-side safeIdx
    // clamp. groupIndex also covers same-length group swaps, which the old
    // length dep silently missed.
  }, [visible, startIdx, groupIndex, caughtUpAnim]);

  // Unmount safety net for the caught-up auto-close — the visible-effect
  // branches only cover open/close transitions, not the component dying.
  useEffect(() => () => {
    if (caughtUpTimerRef.current) { clearTimeout(caughtUpTimerRef.current); caughtUpTimerRef.current = null; }
  }, []);

  // Completion receipt — fires once per status when playback reaches the end
  // NATURALLY (timer finished / video ended), never on tap-skip. Pairs with
  // the backend `completed` writer on status_view (deep-20260807): without
  // this sender every owner's completion_rate read 0% / exit_rate 100%.
  // Deduped per id so rewinds/replays don't refire; queued offline with the
  // same transient/hard-error split as the view receipt above.
  const completedIdsRef = useRef(new Set());
  const markCompleted = useCallback((item) => {
    const _id = item?.id;
    if (!_id || item._placeholder || String(_id).startsWith('__manifest_') || completedIdsRef.current.has(_id)) return;
    completedIdsRef.current.add(_id);
    const _queueCompleted = () => {
      try {
        const { queueOfflineAction } = require('../../services/offlineCache');
        queueOfflineAction({ type: 'status_view', params: { status_id: _id, completed: true } });
      } catch {}
    };
    try {
      Promise.resolve(api.statusView?.(_id, true)).then((r) => {
        if (r && r.success === false
            && !/not_found|already|duplicate|invalid|permission|forbidden|expired/i.test(String(r.message || r.error || ''))) {
          _queueCompleted();
        }
      }).catch(_queueCompleted);
    } catch {}
  }, []);

  const advance = useCallback((natural) => {
    setIdx(prev => {
      // `natural === true` only at real end-of-playback call sites (timer
      // finished, video onEnd/onEnded/didJustFinish, boomerang loop timeout)
      // — tap-to-skip and PanResponder paths call advance() bare.
      if (natural === true) markCompleted(storiesRef.current?.[prev] ?? stories?.[prev]);
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
        if (caughtUpTimerRef.current) clearTimeout(caughtUpTimerRef.current);
        caughtUpTimerRef.current = setTimeout(() => { caughtUpTimerRef.current = null; onClose?.(); }, 1400);
      }
      return prev;
    });
  }, [stories, onClose, caughtUp, caughtUpAnim, onNextGroup, groupIndex, groupCount, markCompleted]);

  // Stable natural-end wrapper handed to StoryMedia → video end handlers.
  // Passing an inline arrow instead would churn StatusVideoPlayer's memo +
  // its [player, loop, onEnd] listener effect on every parent render.
  const advanceNatural = useCallback(() => advance(true), [advance]);

  // Stable callbacks handed to the hoisted StatusVideoPlayer so React.memo can
  // skip re-renders on progress ticks. onError clears the spinner + flips the
  // fail card; onReady hides the spinner once the first frame decodes.
  const _onVideoError = useCallback(() => { setVideoError(true); setVideoLoading(false); }, []);
  const _onVideoReady = useCallback(() => { setVideoLoading(false); }, []);
  // Drive the active segment's progress bar from the video's playback position
  // — the JS timer is skipped for videos, so without this the bar sat at 0%
  // the whole clip. Stable identity so the memoized StatusVideoPlayer doesn't
  // re-render on each tick.
  const _onVideoProgress = useCallback((frac) => {
    try { progressRef.current.setValue(Math.max(0, Math.min(1, frac))); } catch {}
  }, []);

  // Backward navigation: at item 0, if there's a previous group, jump to it.
  // Otherwise stay put (current behavior). Boundary haptic mirrors `advance`.
  const goPrev = useCallback(() => {
    // Rewinding past the "caught up" overlay: abort the pending auto-close AND
    // hide the overlay — cancelling only the timer left a black curtain over
    // the story the user just rewound to.
    if (caughtUpTimerRef.current) { clearTimeout(caughtUpTimerRef.current); caughtUpTimerRef.current = null; }
    setCaughtUp(false);
    caughtUpAnim.setValue(0);
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

  // [deep-20260801] Per-item key so the playback effect can tell "new item on
  // screen" (full reset: progress 0, crossfade, view receipt, precache) apart
  // from a re-run caused by a pause toggle or a stories-array identity change
  // (WS-arrived status, remote delete). Without it every long-press release
  // re-ran the whole reset block: progress snapped to 0, the photo blinked
  // (opacity 0 → fade), and the story replayed from the start. Cleared on
  // open (effect above nulls it) so re-entering the viewer still resets.
  const lastItemKeyRef = useRef(null);

  useEffect(() => {
    if (!visible) return;
    // [deep-20260801] Self-heal idx after a shrink (remote delete of the last
    // item while it's on screen): the render side clamps via safeIdx, but
    // this effect read the RAW idx — `cur` came back undefined, no timer was
    // armed, and the story shown by the clamp froze forever. Snap the state
    // back into range and let the effect re-run against the real item.
    if (stories && stories.length > 0 && idx > stories.length - 1) {
      setIdx(stories.length - 1);
      return;
    }
    const cur = stories?.[idx];
    if (!cur) return;
    // [P1 2026-05-26] Placeholder items have no real media yet — the parent
    // (ChatListTab/useStatuses) refetches status_list and swaps the SAME index
    // to a real item in-place. EARLY-RETURN here so we never start the progress
    // timer against a ghost: leave the canvas visible (itemOpacity=1, no
    // fade-from-0 flash on placeholders) and freeze progress at 0. Because the
    // real item is a different object identity, `stories` changes reference and
    // this effect re-runs — at which point `cur._placeholder` is undefined and
    // we fall through to the normal media + timer setup below (timer starts).
    // Without this, the prior code reset itemOpacity to 0 then armed the
    // placeholder freeze only AFTER the media-setup block, but the crossfade
    // left the canvas at opacity 0 with no timer → frozen story.
    if (cur._placeholder) {
      progressRef.current.setValue(0);
      itemOpacity.setValue(1);
      return;
    }
    // [deep-20260801] Only run the per-item reset when the ITEM actually
    // changed. Re-runs from `paused`/`stories` dep churn skip it, so a
    // long-press release resumes instead of replaying from 0%.
    const itemKey = `${groupIndex}:${idx}:${cur.id ?? ''}`;
    const isNewItem = lastItemKeyRef.current !== itemKey;
    let imageFadeFloor = null;
    if (isNewItem) {
    lastItemKeyRef.current = itemKey;
    progressRef.current.setValue(0);
    // Reset per-item state: crossfade in, image fade reset, video flags cleared.
    itemOpacity.setValue(0);
    Animated.timing(itemOpacity, { toValue: 1, duration: 220, useNativeDriver: true }).start();
    imageFade.setValue(0);
    setVideoError(false);
    setVideoLoading(cur.type === 'video');
    // [WAVE 99 2026-05-21] Reset image error state per item so a stale error
    // from a prior story doesn't bleed into the next one. Retry counter stays
    // — it's tied to mediaUrl key remount + bumps only on explicit user retry.
    setImageError(false);
    // [WAVE 93 2026-05-21] Safety net for `imageFade` — when expo-image
    // serves the source from its own memory cache (same uri viewed earlier
    // in this session, or pre-warmed via prefetch) the `onLoad` callback can
    // fire BEFORE the new <Image> child commits, so our `imageFade` reset
    // to 0 wins and the user sees a black canvas forever. After 900ms force
    // the fade to 1 — way past any realistic decode + paint window for a
    // disk-cached jpeg/webp. Doesn't fight the natural fade-in path: if
    // onLoad already triggered the animation, this is a no-op (value already
    // 1; Animated will short-circuit). Cancel on idx change to avoid leaks.
    imageFadeFloor = setTimeout(() => {
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
        const _queueView = () => {
          try {
            const { queueOfflineAction } = require('../../services/offlineCache');
            queueOfflineAction({ type: 'status_view', params: { status_id: _statusId } });
          } catch {}
        };
        Promise.resolve(api.statusView?.(_statusId)).then((r) => {
          // apiCall resolves {success:false} on native network failure (it
          // never rejects there — .catch only fires on the web offline gate),
          // so queueing only inside .catch made the queue dead code on native.
          // Mirror the replay handler: queue transient failures, drop hard errors.
          if (r && r.success === false
              && !/not_found|already|duplicate|invalid|permission|forbidden|expired/i.test(String(r.message || r.error || ''))) {
            _queueView();
          }
        }).catch(_queueView);
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
    } // end isNewItem — resets + view receipt + precache run once per item
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
    // Voice/audio statuses hold longer so the recorded note isn't cut off by
    // the default 5s image cadence. (Ideal = advance on audio 'ended'; a fixed
    // 30s floor is the safe JS-only approximation until duration is plumbed.)
    const _isVoiceStatus = (cur.type === 'voice' || cur.type === 'audio')
      || (!!cur.media_url && cur.type !== 'image' && cur.type !== 'video' && /\.(m4a|mp3|aac|wav|ogg|opus|webm)(\?|$)/i.test(String(cur.media_url)));
    const duration = _isVoiceStatus ? 30000 : (replyGraceRef.current ? Math.max(STORY_DURATION_MS, 5000) : STORY_DURATION_MS);
    // [deep-20260801] Resume-aware: on a pause release (isNewItem=false) the
    // bar sits wherever the cleanup stopped it — arm the timer for the
    // REMAINING fraction only, so resume continues instead of stretching a
    // full `duration` over the leftover sliver. New items start from the
    // reset 0 above, so remaining === duration there. progress is JS-driven
    // (useNativeDriver:false), so _value is accurate.
    let _fromV = 0;
    try {
      const _pv = progressRef.current;
      _fromV = Number(_pv?._value ?? _pv?.__getValue?.() ?? 0);
      if (!Number.isFinite(_fromV)) _fromV = 0;
      _fromV = Math.max(0, Math.min(1, _fromV));
    } catch {}
    // Reply grace — the max(STORY_DURATION_MS, 5000) floor above is a no-op
    // (both sides are 5000ms): what actually shortens the window is the
    // bar's leftover fraction. Clamp it so the resume leg lasts ≥4.5s and
    // snap the bar back so the visual matches the timer.
    if (!_isVoiceStatus && replyGraceRef.current) {
      const _graceCap = Math.max(0, 1 - 4500 / duration);
      if (_fromV > _graceCap) {
        _fromV = _graceCap;
        try { progressRef.current?.setValue?.(_fromV); } catch {}
      }
    }
    // Instagram-style ease-out so the bar fills crisp at the start and
    // glides into the seam — feels less mechanical than the linear ramp.
    animRef.current = Animated.timing(progressRef.current, {
      toValue: 1,
      duration: Math.max(150, Math.round(duration * (1 - _fromV))),
      easing: Easing.out(Easing.cubic),
      useNativeDriver: false,
    });
    animRef.current.start(({ finished }) => {
      if (finished) advance(true);
    });
    return () => { animRef.current?.stop?.(); clearTimeout(imageFadeFloor); };
  }, [visible, idx, paused, stories, advance, onMarkViewed, itemOpacity, imageFade, groupIndex]);

  useEffect(() => {
    // [P0 2026-05-26] Guard the ARM step against a momentarily-empty
    // `storiesRef`. The effect closure captures `stories` at render time, but
    // by the time it runs the LIVE snapshot (storiesRef.current) may already
    // carry items (parent swapped the locked snapshot in a later micro-task).
    // If the live ref is already populated, we must NOT arm the close timer at
    // all — otherwise the timer fires against a stale-empty closure and the
    // viewer flashes shut the instant it opened ("abre e já fecha"). Keeping
    // the in-timeout re-check below is belt-and-suspenders for the inverse race
    // (ref populates AFTER we arm but BEFORE the 350ms elapses).
    const liveHasStories = Array.isArray(storiesRef.current) && storiesRef.current.length > 0;
    if (visible && !liveHasStories && (!stories || stories.length === 0)) {
      // Defer the auto-close so a brief empty render (e.g., parent recomputed
      // groupIdx mid-state-flush and `items` is momentarily []) doesn't close
      // the modal the instant it mounts. 350ms covers the mount-grace window
      // and the followup setStatuses(hookGroups) sync effect in ChatListTab.
      const t = setTimeout(() => {
        // Re-check via ref — if a fresh mount is still active or stories
        // populated in the meantime, DON'T close. `storiesRef.current` is the
        // live value (not the stale closure from when this effect armed), so a
        // viewer that received its locked snapshot a few ms after mount stays
        // open instead of flashing closed ("nem abre e já fecha").
        if (isFreshMount()) return;
        if (Array.isArray(storiesRef.current) && storiesRef.current.length > 0) return;
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
  // Freehand drawings + text overlays the publisher painted in the composer.
  // The composer flattens neither (it ships them as meta), so the viewer is the
  // only place they get rendered — at the raw composer (x, y), same convention
  // as gif/interactive stickers above.
  const drawPaths = (isImage || isVideo) ? _extractDrawPaths(cur) : [];
  const textOverlays = (isImage || isVideo) ? _extractTextOverlays(cur) : [];

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

  // Voice status — an audio-only story. Detected by an explicit type OR by a
  // media_url that points at an audio file on a non-image/non-video status
  // (the backend currently coerces unknown types to 'text' but still persists
  // media_url, so extension-sniffing keeps it working without a backend change).
  const isVoice = (cur.type === 'voice' || cur.type === 'audio')
    || (!!rawMedia && !isImage && !isVideo && /\.(m4a|mp3|aac|wav|ogg|opus|webm)(\?|$)/i.test(String(rawMedia)));

  const renderMedia = () => (
    isVoice ? (
      <VoiceStatusMedia caption={(cur.content || '').trim()} bgColor={cur.bg_color || cur.background} t={t} />
    ) : (
    <StoryMedia
      cur={cur}
      isText={isText}
      isVideo={isVideo}
      isImage={isImage}
      mediaUrl={mediaUrl}
      t={t}
      paused={paused || replyFocused}
      videoMuted={videoMuted}
      videoError={videoError}
      imageError={imageError}
      imageRetry={imageRetry}
      imageFade={imageFade}
      advance={advance}
      advanceNatural={advanceNatural}
      onVideoError={_onVideoError}
      onVideoReady={_onVideoReady}
      onVideoProgress={_onVideoProgress}
      setVideoError={setVideoError}
      setImageError={setImageError}
      setImageRetry={setImageRetry}
      boomerangRef={boomerangRef}
      boomerangStateRef={boomerangStateRef}
    />
    )
  );

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
      flexDirection: 'row', gap: 4, paddingHorizontal: 10, zIndex: 5,
      opacity: pausedAnim.interpolate({ inputRange: [0, 1], outputRange: [1, 0.4] }),
    }}>
      {stories.map((_, i) => (
        // [beauty2 2026-05-31] Slightly fuller track (3.5→3.5) with a tad more
        // contrast on the pending state + a hairline drop-shadow so the segments
        // stay legible over bright/white media instead of dissolving into it.
        <View key={i} style={{
          // Pending segments: white @ 30% opacity (Instagram spec). Completed
          // segments paint a solid gradient on top via the `i < safeIdx` branch
          // below, so the user reads three distinct states cleanly: pending
          // (30%), active (animating fill), completed (100% solid gradient).
          // Fully-rounded caps so segments read as discrete capsules instead
          // of a chopped bar.
          flex: 1, height: 3.5, backgroundColor: 'rgba(255,255,255,0.32)',
          borderRadius: 4, overflow: 'hidden',
          shadowColor: '#000', shadowOpacity: 0.18, shadowRadius: 2, shadowOffset: { width: 0, height: 1 },
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
      {/* Music playback for music statuses — plays while this item is shown and
          the viewer isn't paused; skipped for video (video carries its own
          audio). Renders nothing visually. */}
      <StatusMusicPlayer url={isVideo ? null : (isVoice ? mediaUrl : (cur?.music_preview_url || null))} active={!paused} startMs={isVoice ? 0 : (Number(cur?.music_start_ms) || 0)} />
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
            // [beauty2 2026-05-31] Deeper, softer backdrop pill + a faint drop
            // shadow so the metadata floats cleanly over any media (bright skies
            // included) instead of reading as a flat patch.
            backgroundColor: 'rgba(0,0,0,0.46)',
            borderRadius: 22, paddingLeft: 4, paddingRight: 13, paddingVertical: 4,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
            shadowColor: '#000', shadowOpacity: 0.25, shadowRadius: 6, shadowOffset: { width: 0, height: 2 },
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
              {/* [beauty2 2026-05-31] Tighter letter-spacing + subtle text shadow
                  on the name for extra legibility; time gets a softer tone and
                  a hair more breathing room below the name. */}
              <Text
                style={{
                  color: '#fff', fontWeight: '700', fontSize: 14, letterSpacing: 0.1,
                  textShadowColor: 'rgba(0,0,0,0.35)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
                }}
                numberOfLines={1}
              >
                {ownerName}
              </Text>
              {cur?.created_at ? (
                <Text style={{ color: 'rgba(255,255,255,0.72)', fontSize: 11, fontWeight: '500', marginTop: 2 }}>
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
            onPress={() => {
              // Mount-grace guard — the X button sits at the very top of the
              // screen (top: insets.top+20), exactly where the chat-list status
              // ring strip lives. The opening tap on a ring can leak its touch-up
              // into this freshly-mounted button and fire onClose the instant the
              // viewer mounts ("abre e fecha na hora"). Every other interactive
              // surface in this viewer (left/right/center tap zones, swipe-down)
              // already swallows the leaked opening tap via isFreshMount(); the
              // close button was missed in the 2026-05-25 hardening pass.
              if (isFreshMount()) return;
              onClose?.();
            }}
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
            style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 240, zIndex: 3 }}
          >
            {/* [beauty2 2026-05-31] Five-stop ramp (vs four) for an even smoother,
                deeper fade — keeps captions + bottom chrome legible over
                bright/busy media without a visible banding seam. */}
            <View style={{ flex: 1.4, backgroundColor: 'rgba(0,0,0,0.0)' }} />
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.08)' }} />
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.20)' }} />
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.36)' }} />
            <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.56)' }} />
          </View>
        ) : null}

        {/* Caption overlay — glass surface for image/video stories */}
        {caption ? (
          <Animated.View style={{
            position: 'absolute',
            bottom: isSelf ? 78 : 110,
            alignSelf: 'center', maxWidth: '92%',
            // [beauty2 2026-05-31] Softer rounded glass surface for the caption
            // with a hair more padding + a faint shadow lift so it reads as a
            // floating card over the media instead of a flat overlay box.
            backgroundColor: 'rgba(0,0,0,0.46)',
            borderRadius: 16, paddingHorizontal: 16, paddingVertical: 11,
            borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
            shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
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

        {/* Freehand drawings — SVG paths painted in the composer at the raw
            (x, y) capture space. zIndex 3 so strokes sit above the media but
            below gif/interactive stickers + chrome. pointerEvents none so they
            never swallow tap-to-advance. */}
        {drawPaths.length > 0 ? (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 3 }}
          >
            <Svg width="100%" height="100%" style={{ position: 'absolute', top: 0, left: 0 }}>
              {drawPaths.map((p, pi) => {
                const d = p.points.map((pt, j) => `${j === 0 ? 'M' : 'L'}${pt.x},${pt.y}`).join(' ');
                return (
                  <Path
                    key={pi}
                    d={d}
                    stroke={p.color}
                    strokeWidth={3}
                    fill="none"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                );
              })}
            </Svg>
          </View>
        ) : null}

        {/* Text overlays — draggable text the publisher placed in the composer,
            painted at the raw (x, y). zIndex 5 so text sits above drawings/gifs
            but below the chrome. Non-interactive (display only in the viewer). */}
        {textOverlays.length > 0 ? (
          <View
            pointerEvents="none"
            style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 5 }}
          >
            {textOverlays.map((to, ti) => (
              <View
                key={ti}
                style={{
                  position: 'absolute', left: to.x, top: to.y,
                  backgroundColor: 'rgba(0,0,0,0.5)',
                  paddingHorizontal: 16, paddingVertical: 8, borderRadius: 8,
                }}
              >
                <Text style={{ color: to.color || '#fff', fontSize: 24, fontWeight: '700', textAlign: 'center' }}>
                  {to.text}
                </Text>
              </View>
            ))}
          </View>
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
                // Only a real email is a valid profile target. A bare username
                // (legacy stickers without `s.email`) is NOT a routable target —
                // routing to it lands on a broken/empty profile. Accept `s.email`
                // or a username that already looks like an email; otherwise the
                // chip stays decorative (non-interactive).
                const targetEmail = s.email || (username.includes('@') ? username : null);
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
              <View style={{
                flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
                paddingHorizontal: 12, paddingVertical: 7, marginHorizontal: 6,
                // [beauty2 2026-05-31] Cohesive translucent reaction bar (IG
                // parity) — slightly darker glass + softer border + a subtle
                // drop shadow so the floating pill reads as one elevated
                // surface above any media.
                backgroundColor: 'rgba(0,0,0,0.34)',
                borderRadius: 28,
                borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)',
                shadowColor: '#000', shadowOpacity: 0.22, shadowRadius: 8, shadowOffset: { width: 0, height: 3 },
              }}>
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
                  {/* [beauty2 2026-05-31] */}
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
                        // Soft brand glow so the send affordance pops against
                        // the translucent reply field (WhatsApp/IG parity).
                        shadowColor: '#7C3AED', shadowOpacity: 0.55, shadowRadius: 8,
                        shadowOffset: { width: 0, height: 2 }, elevation: 5,
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
