// ShortVideoBubble.js — special chat bubble for `type=short_video` rows.
//
// Differs from the regular chat video bubble in three ways:
//   1. AUTOPLAY MUTED LOOP, no native controls. The bubble plays itself
//      so the user sees the clip the moment it scrolls into view (TikTok
//      preview pattern). Tap = expand fullscreen with sound.
//   2. 9:16 ASPECT pinned. Bubble is the same shape no matter what the
//      sender's camera output was (recorder enforces, but we belt+braces
//      it here too in case of legacy rows).
//   3. ROUND PLAY INDICATOR + reels-style badge overlay so the bubble
//      visually reads as "this is a Reel, not a normal chat video".
//
// On long-press, callers can plug a ShareToReelsCTA — see the
// onLongPressShare prop. We don't render the menu ourselves so the
// existing chat-conversation message context menu stays the single source
// of truth.
//
// FEATURE-FLAG GATED. When isShortVideoInChatEnabled() returns false this
// component degrades to a thin "open as video" tile so legacy rows still
// render. Bubble is forward-compatible — even when the flag is off, an
// already-sent short_video bubble (e.g. from a beta tester) won't break.

import React, { useCallback, useMemo, useRef, useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Platform,
  ActivityIndicator,
} from 'react-native';
import { useTheme } from '../context/ThemeContext';
import { BorderRadius, Spacing, FontSize } from '../constants/theme';
import { IconPlay, IconFilm, IconMusic } from './Icons';
import {
  isShortVideoInChatEnabled,
  SHORT_VIDEO_TUNING,
  SHORT_VIDEO_META_KEYS,
} from '../services/shortVideoConfig';

// Lazy-load the native shorts player so the bubble works in dev even when
// the binary hasn't been linked. Falls back to expo-video, then to a
// static thumbnail tile, in that order.
let _ShortsPlayer = null;
function loadShortsPlayer() {
  if (_ShortsPlayer !== null) return _ShortsPlayer;
  try {
    const mod = require('../modules/expo-shorts/src');
    _ShortsPlayer = mod?.ShortsPlayer || mod?.default || false;
  } catch {
    _ShortsPlayer = false;
  }
  return _ShortsPlayer;
}

let _expoVideo = null;
function loadExpoVideo() {
  if (_expoVideo !== null) return _expoVideo;
  try { _expoVideo = require('expo-video'); }
  catch { _expoVideo = false; }
  return _expoVideo;
}

// Bubble size — width is capped so it doesn't blow out the conversation
// padding; height follows 9:16. ~180×320 lines up with what WhatsApp
// shows on iPhone 13/14 widths.
const BUBBLE_WIDTH = 180;
const BUBBLE_HEIGHT = Math.round(BUBBLE_WIDTH / SHORT_VIDEO_TUNING.ASPECT_RATIO);

function formatDuration(ms) {
  if (!ms || ms < 0) return '0:00';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

/**
 * @typedef {Object} ShortVideoBubbleProps
 * @property {string} uri                       CDN URL of the clip
 * @property {Object=} meta                     chat_messages.meta JSON
 * @property {number=} durationMs               fallback if meta missing
 * @property {boolean=} isFocused               parent scroller decided
 *                                              this bubble is on screen
 *                                              and should autoplay. When
 *                                              undefined we autoplay
 *                                              always (safe default for
 *                                              non-virtualized lists).
 * @property {() => void=} onTapExpand          tap → open fullscreen
 *                                              viewer with audio. Caller
 *                                              owns the viewer route.
 * @property {(msgId: string) => void=} onLongPressShare
 *                                              long-press → "Postar nos
 *                                              Reels também". Plugs into
 *                                              shareShortVideoToReels.
 * @property {string=} messageId                forwarded to long-press
 */
export default function ShortVideoBubble({
  uri,
  meta = null,
  durationMs = 0,
  isFocused,
  onTapExpand,
  onLongPressShare,
  messageId,
}) {
  const { colors } = useTheme();
  const [playerReady, setPlayerReady] = useState(false);
  const [errored, setErrored] = useState(false);

  const safeMeta = meta && typeof meta === 'object' ? meta : {};
  const effectiveDur = Number(
    safeMeta[SHORT_VIDEO_META_KEYS.DURATION_MS] || durationMs || 0,
  );
  const hasMusic = !!safeMeta[SHORT_VIDEO_META_KEYS.MUSIC_TITLE];
  const reelsCrossPosted = !!safeMeta[SHORT_VIDEO_META_KEYS.REELS_POST_ID];

  // Autoplay rule: if parent passed isFocused, honour it (FlatList
  // viewability callback). If parent didn't pass anything, default to
  // playing — chat bubbles aren't virtualized aggressively enough for
  // that to be a problem (~50 bubbles in DOM max).
  const shouldPlay = isFocused === undefined ? true : !!isFocused;

  const handleTap = useCallback(() => {
    if (typeof onTapExpand === 'function') onTapExpand();
  }, [onTapExpand]);

  const handleLongPress = useCallback(() => {
    if (typeof onLongPressShare === 'function') onLongPressShare(messageId);
  }, [onLongPressShare, messageId]);

  // ── Renderer selection ──────────────────────────────────────────────
  // 1. Native ShortsPlayer (best — same engine as Reels, prefetched pool)
  // 2. expo-video (fallback — works everywhere)
  // 3. Static tile (last-resort — feature flag off or no players)
  const flagOn = isShortVideoInChatEnabled();

  const renderPlayer = useMemo(() => {
    if (!uri || errored) return null;
    if (!flagOn) return null;  // degrade to static tile

    const Native = loadShortsPlayer();
    if (Native) {
      // ShortsPlayer is muted by default and accepts playWhenInFocus —
      // exactly the autoplay-muted-loop pattern we need.
      return (
        <Native
          videoUrl={uri}
          playWhenInFocus={shouldPlay}
          muted={true}
          onPlaybackReady={() => setPlayerReady(true)}
          onError={() => setErrored(true)}
          style={shortStyles.fill}
        />
      );
    }

    // expo-video fallback. autoplay muted + loop matches VideoNotePlayer.
    const ev = loadExpoVideo();
    if (ev && ev.useVideoPlayer && ev.VideoView) {
      return <ExpoVideoFallback uri={uri} shouldPlay={shouldPlay} onReady={() => setPlayerReady(true)} />;
    }
    return null;
  }, [uri, flagOn, shouldPlay, errored]);

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={handleTap}
      onLongPress={onLongPressShare ? handleLongPress : undefined}
      delayLongPress={350}
      style={[shortStyles.bubble, { backgroundColor: '#0b0b0b' }]}
    >
      {/* Player layer */}
      <View style={shortStyles.fill}>
        {renderPlayer || (
          <View style={[shortStyles.fill, shortStyles.fallbackTile]}>
            <IconFilm size={28} color="#fff" />
            <Text style={shortStyles.fallbackText}>
              {flagOn ? 'Short video' : 'Vídeo curto'}
            </Text>
          </View>
        )}
        {!playerReady && renderPlayer && (
          <View style={[shortStyles.fill, shortStyles.loadingScrim]}>
            <ActivityIndicator size="small" color="#fff" />
          </View>
        )}
      </View>

      {/* Top-right: Reels-style badge so the bubble visually differs from
          a normal chat video. */}
      <View style={shortStyles.badge}>
        <IconFilm size={11} color="#fff" />
        <Text style={shortStyles.badgeText}>Short</Text>
      </View>

      {/* Bottom-left: duration pill. */}
      {effectiveDur > 0 && (
        <View style={shortStyles.durationPill}>
          <Text style={shortStyles.durationText}>{formatDuration(effectiveDur)}</Text>
        </View>
      )}

      {/* Bottom-right: music indicator if track attached. */}
      {hasMusic && (
        <View style={shortStyles.musicPill}>
          <IconMusic size={10} color="#fff" />
        </View>
      )}

      {/* Center play hint — fades the moment the player is ready, but
          stays as an affordance for users that the bubble is tappable
          for fullscreen with sound. */}
      {!playerReady && (
        <View pointerEvents="none" style={shortStyles.centerPlayWrap}>
          <View style={shortStyles.centerPlayCircle}>
            <IconPlay size={20} color="#fff" />
          </View>
        </View>
      )}

      {/* "Posted to Reels" indicator (subtle bottom bar). */}
      {reelsCrossPosted && (
        <View pointerEvents="none" style={[shortStyles.reelsBar, { backgroundColor: colors.primary }]}>
          <Text style={shortStyles.reelsBarText}>Reels</Text>
        </View>
      )}
    </TouchableOpacity>
  );
}

// ── expo-video sub-renderer (hooks-safe — extracted so the bubble's
//    main body doesn't conditionally call hooks). ────────────────────
function ExpoVideoFallback({ uri, shouldPlay, onReady }) {
  const ev = loadExpoVideo();
  // We already checked ev truthy in the parent, but guard again so this
  // file is safe to import in tests where expo-video may be mocked out.
  if (!ev?.useVideoPlayer || !ev?.VideoView) return null;
  const { useVideoPlayer, VideoView } = ev;

  const player = useVideoPlayer(uri, (p) => {
    try {
      p.muted = true;
      p.loop = true;
      if (shouldPlay) {
        const r = p.play?.();
        if (r?.catch) r.catch(() => {});
      }
    } catch {}
  });

  // React to focus changes — pause when scrolled off-screen.
  useEffect(() => {
    if (!player) return;
    try {
      if (shouldPlay) {
        const r = player.play?.();
        if (r?.catch) r.catch(() => {});
      } else {
        player.pause?.();
      }
    } catch {}
  }, [shouldPlay, player]);

  // expo-video doesn't have a clean onReady event — fake one on first
  // tick so the loading scrim disappears even if it's not actually
  // decoded yet. UX win > correctness.
  useEffect(() => {
    const id = setTimeout(() => onReady?.(), 150);
    return () => clearTimeout(id);
  }, [onReady]);

  return (
    <VideoView
      player={player}
      style={{ width: '100%', height: '100%' }}
      contentFit="cover"
      nativeControls={false}
      allowsFullscreen={false}
    />
  );
}

const shortStyles = StyleSheet.create({
  bubble: {
    width: BUBBLE_WIDTH,
    height: BUBBLE_HEIGHT,
    borderRadius: BorderRadius.xl,
    overflow: 'hidden',
    position: 'relative',
  },
  fill: { ...StyleSheet.absoluteFillObject },
  fallbackTile: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#111',
  },
  fallbackText: {
    color: '#fff',
    fontSize: FontSize.xs,
    marginTop: 6,
    fontWeight: '600',
  },
  loadingScrim: {
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  badge: {
    position: 'absolute',
    top: 8,
    right: 8,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  badgeText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.3,
  },
  durationPill: {
    position: 'absolute',
    bottom: 8,
    left: 8,
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: BorderRadius.full,
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  durationText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: '600',
  },
  musicPill: {
    position: 'absolute',
    bottom: 8,
    right: 8,
    width: 22,
    height: 22,
    borderRadius: BorderRadius.full,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  centerPlayWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centerPlayCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reelsBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingVertical: 2,
    alignItems: 'center',
  },
  reelsBarText: {
    color: '#fff',
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
});

// ── Composer menu entry helper ──────────────────────────────────────
//
// chat-conversation.js (untouched here per the agent split) builds its
// attachment grid from an `items` array around line 3518. To add a
// "Vídeo curto" entry there, import buildShortVideoMenuItem(t, colors)
// and spread it into the items array. Returns null when the flag is off
// so the grid silently drops the slot for users not in the rollout.
//
// Example wiring (do NOT apply here — chat-conversation.js is owned by
// another agent):
//
//   import { buildShortVideoMenuItem } from '../components/ShortVideoBubble';
//   import { recordShortVideoInChat } from '../services/shortVideoRecord';
//
//   const items = [
//     ...,
//     buildShortVideoMenuItem(t, colors, () => recordShortVideoInChat({
//       conversationId,
//     })),
//   ].filter(Boolean);
//
// IconFilm + a violet circle matches the Reels tab's visual identity so
// users associate the entry with the existing Reels feature.
export function buildShortVideoMenuItem(t, _colors, onPick) {
  if (!isShortVideoInChatEnabled()) return null;
  return {
    key: 'short_video',
    label: (t && t('chat.attach.shortVideo')) || 'Vídeo curto',
    icon: IconFilm,
    // Match ReelsRecorder's neon-violet accent so the pill reads as Reels.
    color: '#7C3AED',
    onPress: onPick,
  };
}
