import React, { useState, useEffect, useCallback, useRef, memo, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Dimensions,
  Animated, Platform, Share, TextInput, Modal, KeyboardAvoidingView,
  ActivityIndicator, Pressable, ScrollView, Image, Easing, PanResponder,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AvatarCircle from './AvatarCircle';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  IconHeart, IconHeartOutline, IconMessageCircle, IconShare,
  IconBookmark, IconBookmarkFilled, IconMusic, IconPlay, IconPause,
  IconX, IconSend, IconChevronDown, IconCamera, IconVolume2, IconVolumeX, IconEye,
  IconRepeat, IconLink, IconCopy, IconMoreHorizontal,
} from './Icons';
// Reels P1 monetization shares the same diamond catalog + wallet ledger
// as Live gifts. We render a local TipSheetWrapper (defined below) that
// mirrors LivePaidGiftSheet's grid but calls feed_post_tip instead of
// the live-only live_gift_send endpoint.
import * as api from '../services/api';
// expo-shorts powers the native player + pool. Imported lazily so a missing
// native binary (dev only) doesn't break the import chain — fallback paths
// degrade gracefully when these are null.
let _expoShorts = null;
try { _expoShorts = require('expo-shorts'); } catch {}
const prefetchShortsVideoFn = _expoShorts?.prefetchShortsVideo || null;
const releaseShortsPoolFn = _expoShorts?.releaseShortsPool || null;
const setShortsAudioSessionPlaybackFn = _expoShorts?.setShortsAudioSessionPlayback || null;
const restoreShortsAudioSessionFn = _expoShorts?.restoreShortsAudioSession || null;

// expo-video fallback — used when ExpoShortsPlayer isn't linked in the
// current native binary (happens on builds that shipped before the
// expo-shorts module landed, e.g. iOS 504/505). Without this the
// NativeReelVideo just painted a black <View> and the Reels feed looked
// dead. expo-video is already a project dep (~55.0.13) so it's always
// importable on native; on web we still degrade to black.
let _expoVideo = null;
try { _expoVideo = require('expo-video'); } catch {}

// Pick the active subtitle segment for a video time (in ms). Segments
// arrive shaped like {start, end, text} with start/end in SECONDS. We
// linear-scan because subtitle counts cap at 500 — a binary search would
// save ~3 µs per frame and isn't worth the complexity.
function pickSubtitle(segments, currentMs) {
  if (!Array.isArray(segments) || segments.length === 0) return '';
  const t = (currentMs || 0) / 1000;
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const start = Number(s.start) || 0;
    const end = Number(s.end) || 0;
    if (t >= start && t <= end) return s.text || '';
  }
  return '';
}

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

// Native video player — uses the bespoke `expo-shorts` module which loans
// from a 3-slot AVPlayer (iOS) / ExoPlayer (Android) pool. Replaced the
// previous WebView+HTML5 path (2026-05-18): native saves ~60% TTFF, ~50%
// memory (3 decoders total vs N WebViews), and survives lock-screen audio
// the way TikTok does.
//
// API surface kept identical to the old NativeReelVideo so callers don't
// have to change:
//   - props:    videoUrl, poster, isActive, paused, playbackRate, isPreload
//   - callbacks: onTimeUpdate(ms, durMs), onReady({ seek })
//
// Pre-load mode: when isPreload is true we mount the native view with
// playWhenInFocus=false + muted so the pool warms the URL but no playback
// starts. AVPoolManager + ExoPoolManager pick up the same slot on focus,
// so swiping to it paints the first frame already decoded.
// [Android Reels fix 2026-05-19] On Android binaries that shipped before the
// expo-shorts native module landed, `require('expo-shorts').ShortsPlayer`
// returns the JS wrapper (truthy) but the native component "ExpoShortsPlayer"
// isn't registered with UIManager — RN then renders the component NAME as
// fallback text ("ShortsPlayer"), which is what the user reported seeing.
// Probe UIManager + NativeModules to confirm the native side is actually
// linked before trusting the wrapper. If not, fall through to expo-video.
const ShortsPlayerLazy = (() => {
  try {
    const mod = require('expo-shorts');
    const wrapper = mod?.ShortsPlayer;
    if (!wrapper) return null;
    if (Platform.OS === 'web') return null;
    try {
      const { UIManager, NativeModules } = require('react-native');
      const hasViewManager = typeof UIManager?.getViewManagerConfig === 'function'
        ? !!UIManager.getViewManagerConfig('ExpoShortsPlayer')
        : true;
      const hasNativeModule = !!(NativeModules?.ExpoShortsModule || NativeModules?.ExpoShorts);
      if (!hasViewManager && !hasNativeModule) return null;
    } catch { /* if probe fails, trust the wrapper */ }
    return wrapper;
  } catch { return null; }
})();

// Drop-in fallback that mirrors the relevant ShortsPlayer surface using
// expo-video's VideoView + useVideoPlayer. We can't conditionally call
// useVideoPlayer inside NativeReelVideo (hooks must be top-level), so this
// lives as a sibling component and we mount it only when ShortsPlayerLazy
// is missing. Supports the same isActive/paused/muted semantics so the
// rest of the feed (scroll-to-play, mute toggle) keeps working.
function VideoFallbackPlayer({ videoUrl, isActive, paused, muted, playbackRate = 1, onTimeUpdate, onReady }) {
  const VideoView = _expoVideo?.VideoView;
  const useVideoPlayer = _expoVideo?.useVideoPlayer;
  const player = useVideoPlayer && useVideoPlayer(videoUrl || '', (p) => {
    try {
      p.loop = true;
      p.muted = !!muted;
      p.playbackRate = Number(playbackRate) || 1;
      if (isActive && !paused) p.play();
    } catch {}
  });

  // Sync play/pause with the parent's isActive/paused flags so swiping
  // between reels stops the off-screen ones.
  useEffect(() => {
    if (!player) return;
    try {
      if (isActive && !paused) player.play();
      else player.pause();
    } catch {}
  }, [isActive, paused, player]);

  // Mute toggle from the global Reels mute button.
  useEffect(() => {
    if (!player) return;
    try { player.muted = !!muted; } catch {}
  }, [muted, player]);

  // Playback rate (rare, but supported by ShortsPlayer so we mirror it).
  useEffect(() => {
    if (!player) return;
    try { player.playbackRate = Number(playbackRate) || 1; } catch {}
  }, [playbackRate, player]);

  // Time updates + onReady seek API — keeps subtitle sync + scrub working.
  useEffect(() => {
    if (!player) return;
    if (onReady) {
      const seekFn = (ms) => {
        try { player.currentTime = (Number(ms) || 0) / 1000; } catch {}
      };
      onReady({ seek: seekFn });
    }
    if (!onTimeUpdate) return undefined;
    const id = setInterval(() => {
      try {
        const ct = (player.currentTime || 0) * 1000;
        const dur = (player.duration || 0) * 1000;
        onTimeUpdate(ct, dur);
      } catch {}
    }, 125);
    return () => clearInterval(id);
  }, [player, onReady, onTimeUpdate]);

  if (!VideoView || !player) {
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />;
  }
  return (
    <VideoView
      style={StyleSheet.absoluteFill}
      player={player}
      contentFit="cover"
      nativeControls={false}
      allowsFullscreen={false}
      allowsPictureInPicture={false}
    />
  );
}

const NativeReelVideo = memo(function NativeReelVideo({ videoUrl, poster, isActive, paused, playbackRate = 1, isPreload = false, muted = true, onTimeUpdate, onReady }) {
  const shortsRef = useRef(null);

  // Expose the imperative seek API to the parent through onReady — keeps the
  // callsite identical to the old WebView-backed component.
  useEffect(() => {
    if (!onReady) return;
    const seekFn = (ms) => {
      try { shortsRef.current?.seek?.(Math.max(0, Number(ms) || 0)); } catch {}
    };
    onReady({ seek: seekFn });
    // Re-publish if shortsRef remounts.
  }, [onReady]);

  // Time updates from native (~8fps). Replaces the WebView postMessage tick.
  const handleNativeTime = useCallback((ms, durMs) => {
    if (onTimeUpdate) onTimeUpdate(ms, durMs);
  }, [onTimeUpdate]);

  // Native-only — if for any reason the module didn't link (e.g. iOS 504/505
  // shipped before expo-shorts), fall back to expo-video's VideoView so the
  // Reels feed still plays. Only surface a black placeholder if expo-video
  // also isn't available (web or extremely old binaries).
  if (!ShortsPlayerLazy) {
    if (_expoVideo) {
      return (
        <VideoFallbackPlayer
          videoUrl={videoUrl}
          isActive={isActive && !isPreload}
          paused={paused}
          muted={muted}
          playbackRate={playbackRate}
          onTimeUpdate={onTimeUpdate}
          onReady={onReady}
        />
      );
    }
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />;
  }

  const shouldPlay = !!isActive && !paused && !isPreload;
  return (
    <View style={StyleSheet.absoluteFill}>
      <ShortsPlayerLazy
        ref={shortsRef}
        videoUrl={videoUrl}
        playWhenInFocus={shouldPlay}
        muted={!!muted}
        playbackRate={Number(playbackRate) || 1}
        onTime={handleNativeTime}
      />
    </View>
  );
});

const ACCENT = '#7C3AED';
const DOUBLE_TAP_DELAY = 300;
const BASE_URL = 'https://chatyy.com.br';
const isWeb = Platform.OS === 'web';
const useNative = Platform.OS !== 'web';

// Text shadow style for readability over video
const TEXT_SHADOW = {
  textShadowColor: 'rgba(0,0,0,0.75)',
  textShadowOffset: { width: 0, height: 1.5 },
  textShadowRadius: 5,
};

const ICON_SHADOW = {
  shadowColor: '#000',
  shadowOffset: { width: 0, height: 1 },
  shadowOpacity: 0.5,
  shadowRadius: 3,
  ...(isWeb ? {} : { elevation: 3 }),
};

function resolveMediaUrl(url) {
  if (!url) return '';
  if (url.startsWith('http')) return url;
  return BASE_URL + (url.startsWith('/') ? '' : '/') + url;
}

function parseMediaUrls(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return []; }
  }
  return [];
}

function formatCount(n) {
  if (!n || n <= 0) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(n);
}

function timeAgo(dateStr, t) {
  if (!dateStr) return '';
  const str = dateStr.endsWith('Z') || dateStr.includes('+') ? dateStr : dateStr + 'Z';
  const now = Date.now();
  const then = new Date(str).getTime();
  if (!Number.isFinite(then)) return '';
  const diffMs = now - then;
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return t?.('time.now') || 'now';
  if (mins < 60) return (t?.('time.min') || '{n}m').replace('{n}', mins);
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return (t?.('time.hours') || '{n}h').replace('{n}', hrs);
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d`;
  return (_d=>isNaN(_d.getTime())?'':_d.toLocaleDateString())(new Date(str));
}

// ── Likers Bottom Sheet ──
function LikersSheet({ visible, post, colors, isDark, t, onClose }) {
  const [likers, setLikers] = useState([]);
  const [loading, setLoading] = useState(false);
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible && post) {
      loadLikers();
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: SCREEN_HEIGHT,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, post]);

  const loadLikers = async () => {
    if (!post) return;
    setLoading(true);
    try {
      const r = await api.feedLikers(post.id);
      if (r.success && r.data) {
        setLikers(Array.isArray(r.data.likers) ? r.data.likers : (Array.isArray(r.data) ? r.data : []));
      }
    } catch {} finally { setLoading(false); }
  };

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Animated.View
          style={[styles.sheetContainer, {
            transform: [{ translateY: slideAnim }],
          }]}
        >
          <Pressable onPress={() => {}}>
            <View style={styles.sheetHandle}>
              <View style={styles.sheetHandleBar} />
            </View>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {t('feed.likes') || 'Likes'}
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <IconX size={22} color="#999" />
              </TouchableOpacity>
            </View>

            {loading ? (
              <View style={styles.sheetLoading}>
                <ActivityIndicator size="small" color="#fff" />
              </View>
            ) : likers.length === 0 ? (
              <View style={styles.sheetEmpty}>
                <Text style={styles.sheetEmptyText}>
                  {t('feed.noLikes') || 'Sem curtidas'}
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.sheetList} showsVerticalScrollIndicator={false}>
                {likers.map((liker, idx) => (
                  <View key={liker.email || idx} style={styles.commentRow}>
                    <AvatarCircle email={liker.email} name={liker.name} size={32} />
                    <View style={styles.commentContent}>
                      <Text style={styles.commentAuthor}>
                        {liker.name || liker.email?.split('@')[0] || '?'}
                      </Text>
                      <Text style={styles.commentTime}>
                        {timeAgo(liker.created_at, t)}
                      </Text>
                    </View>
                  </View>
                ))}
                <View style={{ height: 20 }} />
              </ScrollView>
            )}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ── Comments Bottom Sheet ──
function CommentsSheet({ visible, post, colors, isDark, t, user, onClose }) {
  const [comments, setComments] = useState([]);
  const [loading, setLoading] = useState(false);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;

  useEffect(() => {
    if (visible && post) {
      loadComments();
      Animated.spring(slideAnim, {
        toValue: 0,
        tension: 65,
        friction: 11,
        useNativeDriver: true,
      }).start();
    } else {
      Animated.timing(slideAnim, {
        toValue: SCREEN_HEIGHT,
        duration: 250,
        useNativeDriver: true,
      }).start();
    }
  }, [visible, post]);

  const loadComments = async () => {
    if (!post) return;
    setLoading(true);
    try {
      const r = await api.feedComments(post.id);
      if (r.success && r.data) {
        setComments(Array.isArray(r.data.comments) ? r.data.comments : (Array.isArray(r.data) ? r.data : []));
      }
    } catch {} finally { setLoading(false); }
  };

  const sendComment = async () => {
    if (!text.trim() || sending || !post) return;
    setSending(true);
    try {
      const r = await api.feedComment(post.id, text.trim());
      if (r.success) {
        setText('');
        loadComments();
      }
    } catch {} finally { setSending(false); }
  };

  if (!visible) return null;

  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Animated.View
          style={[styles.sheetContainer, {
            transform: [{ translateY: slideAnim }],
          }]}
        >
          <Pressable onPress={() => {}}>
            {/* Handle bar */}
            <View style={styles.sheetHandle}>
              <View style={styles.sheetHandleBar} />
            </View>
            <View style={styles.sheetHeader}>
              <Text style={styles.sheetTitle}>
                {t('feed.comments') || 'Comments'}
              </Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <IconX size={22} color="#999" />
              </TouchableOpacity>
            </View>

            {loading ? (
              <View style={styles.sheetLoading}>
                <ActivityIndicator size="small" color="#fff" />
              </View>
            ) : comments.length === 0 ? (
              <View style={styles.sheetEmpty}>
                <Text style={styles.sheetEmptyText}>
                  {t('feed.noComments') || 'Sem comentarios'}
                </Text>
              </View>
            ) : (
              <ScrollView style={styles.sheetList} showsVerticalScrollIndicator={false}>
                {comments.map((c, idx) => (
                  <View key={c.id || idx} style={styles.commentRow}>
                    <AvatarCircle email={c.author_email} name={c.author_name} size={32} />
                    <View style={styles.commentContent}>
                      <Text style={styles.commentAuthor}>
                        {c.author_name || c.author_email?.split('@')[0] || '?'}
                        <Text style={styles.commentText}>
                          {'  '}{c.content}
                        </Text>
                      </Text>
                      <Text style={styles.commentTime}>
                        {timeAgo(c.created_at, t)}
                      </Text>
                    </View>
                  </View>
                ))}
                <View style={{ height: 20 }} />
              </ScrollView>
            )}

            {/* Input */}
            <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
              <View style={styles.sheetInput}>
                <AvatarCircle email={user?.email} name={user?.name} size={30} />
                <TextInput
                  style={styles.sheetTextInput}
                  placeholder={t('feed.writeComment') || 'Adicionar comentario...'}
                  placeholderTextColor="#666"
                  value={text}
                  onChangeText={setText}
                  returnKeyType="send"
                  onSubmitEditing={sendComment}
                />
                <TouchableOpacity
                  onPress={sendComment}
                  disabled={!text.trim() || sending}
                  style={{ opacity: text.trim() ? 1 : 0.4 }}
                >
                  {sending ? (
                    <ActivityIndicator size="small" color="#fff" />
                  ) : (
                    <IconSend size={22} color="#fff" />
                  )}
                </TouchableOpacity>
              </View>
            </KeyboardAvoidingView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ── Spinning Album Art ──
const SpinningDisc = memo(function SpinningDisc({ authorEmail, authorName }) {
  const spinValue = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const spin = Animated.loop(
      Animated.timing(spinValue, {
        toValue: 1,
        duration: 3000,
        easing: Easing.linear,
        useNativeDriver: true,
      })
    );
    spin.start();
    return () => spin.stop();
  }, []);

  const rotate = spinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ['0deg', '360deg'],
  });

  return (
    <Animated.View style={[styles.albumArt, { transform: [{ rotate }] }]}>
      <View style={styles.albumArtInner}>
        <View style={styles.albumArtCenter}>
          <AvatarCircle email={authorEmail} name={authorName} size={18} />
        </View>
      </View>
    </Animated.View>
  );
});

// ── Live Badge Ring ──
// Renders a pulsing colored ring + "AO VIVO" badge under the avatar when the
// reel's author is currently broadcasting. Tapping the avatar routes to the
// live viewer (`/live-viewer?id=<liveId>`) — handled by the parent via
// onAvatarTap. Pure View + Animated stack so it works on web + native without
// needing react-native-svg. 2-color rotating gradient effect is simulated
// with a single colored ring + opacity loop, which is plenty for the size.
const LiveBadgeRing = memo(function LiveBadgeRing({ size = 44, children }) {
  const pulse = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 900, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      ])
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.07] });
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 1] });
  return (
    <View style={{ alignItems: 'center', justifyContent: 'center' }}>
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          width: size + 6,
          height: size + 6,
          borderRadius: (size + 6) / 2,
          borderWidth: 2.5,
          borderColor: '#FF3B30',
          opacity,
          transform: [{ scale }],
        }}
      />
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        {children}
      </View>
      {/* "AO VIVO" pill anchored just below the avatar. */}
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          bottom: -8,
          backgroundColor: '#FF3B30',
          paddingHorizontal: 6,
          paddingVertical: 1,
          borderRadius: 4,
          borderWidth: 1.5,
          borderColor: '#000',
        }}
      >
        <Text style={{ color: '#fff', fontSize: 8, fontWeight: '800', letterSpacing: 0.4 }}>
          AO VIVO
        </Text>
      </View>
    </View>
  );
});

// ── Music equalizer (3 bars bouncing) ──
// Renders next to the music icon to signal "audio is playing" without
// audio actually being present (the reel is muted in the UI; this is
// purely visual flair). 3 thin vertical bars, each on its own loop
// with offset phase + duration so they look like real EQ levels.
const MusicEqualizer = memo(function MusicEqualizer() {
  const bars = useRef([
    new Animated.Value(0.4),
    new Animated.Value(0.85),
    new Animated.Value(0.55),
  ]).current;
  useEffect(() => {
    const cfgs = [
      { dur: [280, 400], min: 0.25, max: 1 },
      { dur: [330, 450], min: 0.40, max: 0.95 },
      { dur: [290, 410], min: 0.30, max: 0.90 },
    ];
    const loops = bars.map((v, i) => {
      const c = cfgs[i];
      return Animated.loop(
        Animated.sequence([
          Animated.timing(v, { toValue: c.max, duration: c.dur[0], useNativeDriver: false }),
          Animated.timing(v, { toValue: c.min, duration: c.dur[1], useNativeDriver: false }),
        ])
      );
    });
    loops.forEach(l => l.start());
    return () => loops.forEach(l => l.stop());
  }, []);
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 12, marginRight: 2 }}>
      {bars.map((v, i) => (
        <Animated.View
          key={i}
          style={{
            width: 2.5,
            borderRadius: 1.25,
            backgroundColor: '#fff',
            height: v.interpolate({ inputRange: [0, 1], outputRange: [3, 12] }),
          }}
        />
      ))}
    </View>
  );
});

// ── Music Marquee (scrolling text) ──
const MusicMarquee = memo(function MusicMarquee({ text: musicText }) {
  const scrollX = useRef(new Animated.Value(0)).current;
  const textWidth = useRef(200);

  useEffect(() => {
    const anim = Animated.loop(
      Animated.sequence([
        Animated.timing(scrollX, {
          toValue: -textWidth.current,
          duration: 6000,
          easing: Easing.linear,
          useNativeDriver: true,
        }),
        Animated.timing(scrollX, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true,
        }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [musicText]);

  return (
    <View style={styles.marqueeContainer}>
      <Animated.View
        style={[styles.marqueeTrack, { transform: [{ translateX: scrollX }] }]}
        onLayout={(e) => { textWidth.current = e.nativeEvent.layout.width / 2; }}
      >
        <Text style={styles.marqueeText}>{musicText}    </Text>
        <Text style={styles.marqueeText}>{musicText}    </Text>
      </Animated.View>
    </View>
  );
});

// ── Tip Sheet Wrapper (reuses paid-gift UI for per-reel tipping) ──
// Mirrors LivePaidGiftSheet's grid but wires the Send button to
// api.feedPostTip(postId, sku) instead of liveGiftSend(sessionId, sku).
// We load the same catalog (liveGiftCatalog) so SKUs + diamond costs stay
// in lockstep with Live monetization. Diamond balance pulled from
// api.walletBalance().
const TipSheetWrapper = memo(function TipSheetWrapper({ visible, onClose, postId, onTipSent, t }) {
  const [gifts, setGifts] = useState([
    { sku: 'gift_rose',   label: 'Rose',   diamonds_cost: 100 },
    { sku: 'gift_star',   label: 'Star',   diamonds_cost: 300 },
    { sku: 'gift_crown',  label: 'Crown',  diamonds_cost: 1000 },
    { sku: 'gift_rocket', label: 'Rocket', diamonds_cost: 2000 },
    { sku: 'gift_galaxy', label: 'Galaxy', diamonds_cost: 5000 },
    { sku: 'gift_legend', label: 'Legend', diamonds_cost: 10000 },
  ]);
  const [balance, setBalance] = useState(0);
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const c = await api.liveGiftCatalog?.();
        if (c?.success && Array.isArray(c.data?.gifts) && c.data.gifts.length) setGifts(c.data.gifts);
      } catch {}
      try {
        const b = await api.walletBalance?.();
        if (b?.success && b.data) setBalance(Number(b.data.diamond_balance) || 0);
      } catch {}
    })();
  }, [visible]);

  const onSend = useCallback(async (gift) => {
    if (!postId || !gift?.sku || sending) return;
    if (balance < (gift.diamonds_cost || 0)) {
      // Insufficient — bubble up to user; LivePaidGiftSheet handles the
      // top-up flow if they tap "Comprar" on the next try.
      try { require('react-native').Alert.alert(t?.('common.error') || 'Erro', t?.('feed.tipInsufficient') || 'Diamantes insuficientes'); } catch {}
      return;
    }
    setSending(true);
    try {
      const res = await api.feedPostTip?.(postId, gift.sku);
      if (res?.success) {
        if (res.data?.diamond_balance != null) setBalance(Number(res.data.diamond_balance));
        onTipSent?.(gift.sku);
        onClose?.();
      } else if (res?.data?.code === 'insufficient_diamonds') {
        setBalance(Number(res.data.diamond_balance) || 0);
        try { require('react-native').Alert.alert(t?.('common.error') || 'Erro', t?.('feed.tipInsufficient') || 'Diamantes insuficientes'); } catch {}
      } else {
        // Surface the actual error so the user knows the tap didn't silently
        // succeed. Previously this branch was empty + a silent catch — server
        // 401 / 500 / "Post not found" all looked like "nothing happens" to
        // the user. Bug report 2026-05-19: "clico em mandar diamante e nada
        // acontece".
        const msg = res?.message || res?.error || (t?.('common.error') || 'Erro ao enviar diamante');
        try { require('react-native').Alert.alert(t?.('common.error') || 'Erro', String(msg)); } catch {}
      }
    } catch (e) {
      try { require('react-native').Alert.alert(t?.('common.error') || 'Erro', t?.('common.networkError') || 'Falha de conexão'); } catch {}
    } finally {
      setSending(false);
    }
  }, [balance, onClose, onTipSent, postId, sending, t]);

  if (!visible) return null;
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
        onPress={onClose}
      >
        <Pressable
          onPress={(e) => e.stopPropagation && e.stopPropagation()}
          style={{ backgroundColor: '#0F172A', borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingHorizontal: 16, paddingTop: 12, paddingBottom: 30, minHeight: 320 }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <Text style={{ color: '#fff', fontSize: 16, fontWeight: '700' }}>
              {t?.('feed.tipSheetTitle') || 'Mandar diamante'}
            </Text>
            <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <IconX size={18} color="#fff" />
            </TouchableOpacity>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 13 }}>
              {t?.('live.diamondBalance') || 'Saldo'}:
            </Text>
            <Text style={{ color: '#fff', fontSize: 15, fontWeight: '800' }}>{balance} ◆</Text>
          </View>
          <FlatList
            data={gifts}
            keyExtractor={(g) => g.sku}
            numColumns={3}
            columnWrapperStyle={{ gap: 10, justifyContent: 'space-between' }}
            scrollEnabled={false}
            renderItem={({ item }) => {
              const affordable = balance >= (item.diamonds_cost || 0);
              return (
                <TouchableOpacity
                  onPress={() => onSend(item)}
                  disabled={sending}
                  style={{ flex: 1, aspectRatio: 0.85, marginBottom: 10, borderRadius: 14, padding: 10, backgroundColor: 'rgba(168,85,247,0.10)', borderWidth: 1, borderColor: 'rgba(168,85,247,0.20)', alignItems: 'center', opacity: affordable ? 1 : 0.55 }}
                  activeOpacity={0.85}
                  accessibilityRole="button"
                  accessibilityLabel={`${item.label} ${item.diamonds_cost} diamonds`}
                >
                  <View style={{ width: 56, height: 56, borderRadius: 28, backgroundColor: '#A855F7', alignItems: 'center', justifyContent: 'center', marginBottom: 6 }}>
                    <Text style={{ color: '#fff', fontSize: 22, fontWeight: '800' }}>{(item.icon || item.label || '?').toString().charAt(0).toUpperCase()}</Text>
                  </View>
                  <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }} numberOfLines={1}>{item.label}</Text>
                  <Text style={{ color: '#FBBF24', fontSize: 13, fontWeight: '800', marginTop: 2 }}>{item.diamonds_cost} ◆</Text>
                </TouchableOpacity>
              );
            }}
          />
          {sending ? (
            <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
              <ActivityIndicator color="#fff" />
            </View>
          ) : null}
        </Pressable>
      </Pressable>
    </Modal>
  );
});

// ── Floating Diamond (tip animation) ──
// When the user sends a tip (or someone else does via WS), we mount this
// component with a unique key. It rises from the bottom-right of the reel,
// fading out after ~1.4s. Multiple simultaneous tips stack visually.
const FloatingDiamond = memo(function FloatingDiamond({ label }) {
  const translateY = useRef(new Animated.Value(0)).current;
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.parallel([
      Animated.timing(translateY, { toValue: -140, duration: 1400, useNativeDriver: true, easing: Easing.out(Easing.cubic) }),
      Animated.sequence([
        Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
        Animated.delay(700),
        Animated.timing(opacity, { toValue: 0, duration: 520, useNativeDriver: true }),
      ]),
    ]).start();
  }, [opacity, translateY]);

  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        right: 28,
        bottom: 220,
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 999,
        backgroundColor: 'rgba(124,58,237,0.85)',
        opacity,
        transform: [{ translateY }],
      }}
    >
      <Text style={{ color: '#fff', fontSize: 16 }}>💎</Text>
      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }} numberOfLines={1}>
        {label || 'Diamante'}
      </Text>
    </Animated.View>
  );
});

// ── Pause Icon Flash ──
const PauseFlash = memo(function PauseFlash({ visible }) {
  const opacity = useRef(new Animated.Value(0)).current;
  const scale = useRef(new Animated.Value(0.5)).current;

  useEffect(() => {
    if (visible) {
      opacity.setValue(1);
      scale.setValue(0.5);
      Animated.parallel([
        Animated.timing(opacity, {
          toValue: 0,
          duration: 600,
          delay: 200,
          useNativeDriver: true,
        }),
        Animated.spring(scale, {
          toValue: 1,
          tension: 300,
          friction: 15,
          useNativeDriver: true,
        }),
      ]).start();
    }
  }, [visible]);

  return (
    <Animated.View
      pointerEvents="none"
      style={[styles.pauseFlashOverlay, {
        opacity,
        transform: [{ scale }],
      }]}
    >
      <View style={styles.pauseFlashCircle}>
        <IconPlay size={36} color="#fff" />
      </View>
    </Animated.View>
  );
});

// ── Heart Particle Burst ──
// Eight tiny hearts radiate from the center on like — TikTok-grade fizz
// that sells the action. Each particle gets its own translation vector
// (computed from index → angle) plus its own scale/opacity timeline.
// Mounted only briefly via `key` change so the parent can retrigger
// without us tracking visibility ourselves.
const HeartParticleBurst = memo(function HeartParticleBurst() {
  const COUNT = 8;
  const particles = useRef(
    Array.from({ length: COUNT }, () => ({
      tx: new Animated.Value(0),
      ty: new Animated.Value(0),
      scale: new Animated.Value(0),
      opacity: new Animated.Value(1),
    }))
  ).current;

  useEffect(() => {
    const anims = particles.map((p, i) => {
      const angle = (i / COUNT) * Math.PI * 2;
      const radius = 70 + Math.random() * 30;
      const dx = Math.cos(angle) * radius;
      const dy = Math.sin(angle) * radius - 20; // slight upward bias
      p.tx.setValue(0);
      p.ty.setValue(0);
      p.scale.setValue(0);
      p.opacity.setValue(1);
      return Animated.parallel([
        Animated.timing(p.tx, { toValue: dx, duration: 700, useNativeDriver: true }),
        Animated.timing(p.ty, { toValue: dy, duration: 700, useNativeDriver: true }),
        Animated.sequence([
          Animated.spring(p.scale, { toValue: 1, tension: 200, friction: 8, useNativeDriver: true }),
          Animated.timing(p.scale, { toValue: 0.4, duration: 280, useNativeDriver: true }),
        ]),
        Animated.timing(p.opacity, { toValue: 0, duration: 700, delay: 100, useNativeDriver: true }),
      ]);
    });
    Animated.parallel(anims).start();
  }, []);

  return (
    <View pointerEvents="none" style={styles.particleBurstWrap}>
      {particles.map((p, i) => (
        <Animated.View
          key={i}
          style={{
            position: 'absolute',
            transform: [{ translateX: p.tx }, { translateY: p.ty }, { scale: p.scale }],
            opacity: p.opacity,
          }}
        >
          <IconHeart size={18} color="#FF2D55" />
        </Animated.View>
      ))}
    </View>
  );
});

// ── Share Bottom Sheet ──
// In-app drawer offering Repost / Copy link / External share. Replaces the
// previous one-shot navigator.share() call so users can pick a destination
// (cross-post into the feed, stash the URL, or hand off to the OS sheet).
function ShareSheet({ visible, reel, t, onClose, onRepost, onCopyLink, onExternal }) {
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, { toValue: 0, tension: 65, friction: 11, useNativeDriver: true }).start();
    } else {
      Animated.timing(slideAnim, { toValue: SCREEN_HEIGHT, duration: 220, useNativeDriver: true }).start();
    }
  }, [visible]);
  if (!visible) return null;
  const Row = ({ icon: Icon, label, onPress }) => (
    <TouchableOpacity activeOpacity={0.7} onPress={onPress} style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 22, paddingVertical: 16, gap: 14 }}>
      <Icon size={22} color="#fff" />
      <Text style={{ flex: 1, fontSize: 15.5, fontWeight: '600', color: '#fff', letterSpacing: -0.1 }}>{label}</Text>
    </TouchableOpacity>
  );
  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Animated.View style={[styles.sheetContainer, { transform: [{ translateY: slideAnim }], minHeight: 220, paddingBottom: 24 }]}>
          <Pressable onPress={() => {}}>
            <View style={styles.sheetHandle}><View style={styles.sheetHandleBar} /></View>
            <View style={[styles.sheetHeader, { borderBottomWidth: 0, paddingBottom: 4 }]}>
              <Text style={styles.sheetTitle}>{t?.('feed.share') || 'Compartilhar'}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <IconX size={22} color="#999" />
              </TouchableOpacity>
            </View>
            <Row icon={IconRepeat} label={t?.('feed.repost') || 'Repostar'} onPress={onRepost} />
            <Row icon={IconLink}   label={t?.('feed.copyLink') || t?.('common.copy') || 'Copiar link'} onPress={onCopyLink} />
            <Row icon={IconShare}  label={t?.('feed.shareOutside') || t?.('feed.shareExternal') || 'Compartilhar fora'} onPress={onExternal} />
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ── Speed Picker Sheet ──
// Replaces the inline cycle button when the user opens it via the more-menu.
// Tap a speed → applies + persists to AsyncStorage under REELS_SPEED_KEY so
// the next reel loads with the same default. TikTok parity: 5 speed options.
const REELS_SPEED_KEY = '@chatyy:reels_speed_default_v1';
const REELS_CC_KEY = '@chatyy:reels_cc_enabled_v1';

function SpeedPickerSheet({ visible, current, onSelect, onClose, t }) {
  const slideAnim = useRef(new Animated.Value(SCREEN_HEIGHT)).current;
  useEffect(() => {
    Animated.timing(slideAnim, {
      toValue: visible ? 0 : SCREEN_HEIGHT,
      duration: visible ? 220 : 180,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [visible]);
  if (!visible) return null;
  const SPEEDS = [0.5, 0.75, 1, 1.5, 2];
  return (
    <Modal transparent visible={visible} animationType="none" onRequestClose={onClose} statusBarTranslucent>
      <Pressable style={styles.sheetBackdrop} onPress={onClose}>
        <Animated.View style={[styles.sheetContainer, { transform: [{ translateY: slideAnim }], minHeight: 240, paddingBottom: 24 }]}>
          <Pressable onPress={() => {}}>
            <View style={styles.sheetHandle}><View style={styles.sheetHandleBar} /></View>
            <View style={[styles.sheetHeader, { borderBottomWidth: 0, paddingBottom: 4 }]}>
              <Text style={styles.sheetTitle}>{t?.('feed.speedPicker') || 'Velocidade'}</Text>
              <TouchableOpacity onPress={onClose} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <IconX size={22} color="#999" />
              </TouchableOpacity>
            </View>
            <View style={{ paddingHorizontal: 14, paddingTop: 12 }}>
              {SPEEDS.map(s => {
                const active = Math.abs(s - current) < 0.01;
                return (
                  <TouchableOpacity
                    key={s}
                    activeOpacity={0.7}
                    onPress={() => onSelect(s)}
                    style={{
                      flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                      paddingVertical: 12, paddingHorizontal: 10, borderRadius: 10,
                      backgroundColor: active ? 'rgba(124,58,237,0.20)' : 'transparent',
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`${s}x`}
                  >
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: active ? '800' : '500' }}>
                      {s}×{s === 1 ? `  (${t?.('common.default') || 'Padrão'})` : ''}
                    </Text>
                    {active ? (
                      <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#7C3AED' }} />
                    ) : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ── Scrubber (draggable progress bar) ──
// TikTok/Instagram parity: horizontal bar at the very bottom — tap to jump,
// drag to scrub. While the user is touching it we suspend the auto-progress
// update so the thumb doesn't fight the finger. Calls onSeek(progressNormalized)
// once on release (web) or live (native) so the underlying <video> seeks.
const Scrubber = memo(function Scrubber({ progress, onSeek, onScrubStart, onScrubEnd }) {
  const [width, setWidth] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const [livePct, setLivePct] = useState(progress);
  const widthRef = useRef(0);
  useEffect(() => { widthRef.current = width; }, [width]);
  useEffect(() => { if (!scrubbing) setLivePct(progress); }, [progress, scrubbing]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        setScrubbing(true);
        onScrubStart?.();
        const x = e.nativeEvent.locationX;
        const w = widthRef.current || 1;
        const pct = Math.max(0, Math.min(1, x / w));
        setLivePct(pct);
        onSeek?.(pct, false);
      },
      onPanResponderMove: (e) => {
        const x = e.nativeEvent.locationX;
        const w = widthRef.current || 1;
        const pct = Math.max(0, Math.min(1, x / w));
        setLivePct(pct);
        onSeek?.(pct, false);
      },
      onPanResponderRelease: (e) => {
        const x = e.nativeEvent.locationX;
        const w = widthRef.current || 1;
        const pct = Math.max(0, Math.min(1, x / w));
        setLivePct(pct);
        onSeek?.(pct, true);
        setScrubbing(false);
        onScrubEnd?.();
      },
      onPanResponderTerminate: () => {
        setScrubbing(false);
        onScrubEnd?.();
      },
    })
  ).current;

  const shown = scrubbing ? livePct : progress;
  return (
    <View
      {...panResponder.panHandlers}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      // Bigger hit target than the visible bar so it's easy to grab; the
      // visible track stays 3px to match the prior aesthetic.
      style={styles.scrubberHit}
      accessibilityRole="adjustable"
    >
      <View style={[styles.progressBar, scrubbing ? { height: 5 } : null]}>
        <View style={[styles.progressFill, { width: `${Math.min(shown * 100, 100)}%` }]} />
        {scrubbing ? (
          <View pointerEvents="none" style={[styles.scrubberThumb, { left: `${Math.min(shown * 100, 100)}%` }]} />
        ) : null}
      </View>
    </View>
  );
});

// ── Pinch-to-zoom wrapper ──
// Two-finger pinch scales the video 1..3× with a spring-back to 1 on release.
// Uses RNGH's PinchGestureHandler when available; on web (no RNGH) or older
// builds without it, returns the child unchanged (graceful no-op).
const PinchZoomBox = memo(function PinchZoomBox({ children }) {
  const scaleAnim = useRef(new Animated.Value(1)).current;
  let PinchHandler = null;
  let GH = null;
  if (Platform.OS !== 'web') {
    try { GH = require('react-native-gesture-handler'); PinchHandler = GH?.PinchGestureHandler; } catch {}
  }
  const onPinch = useCallback((ev) => {
    const s = Math.max(1, Math.min(3, ev.nativeEvent.scale || 1));
    scaleAnim.setValue(s);
  }, [scaleAnim]);
  const onStateChange = useCallback((ev) => {
    if (!GH) return;
    if (ev.nativeEvent.state === GH.State.END || ev.nativeEvent.state === GH.State.CANCELLED) {
      Animated.spring(scaleAnim, { toValue: 1, useNativeDriver: true, tension: 80, friction: 7 }).start();
    }
  }, [GH, scaleAnim]);
  const wrapped = (
    <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ scale: scaleAnim }] }]} pointerEvents="box-none">
      {children}
    </Animated.View>
  );
  if (PinchHandler) {
    return (
      <PinchHandler onGestureEvent={onPinch} onHandlerStateChange={onStateChange}>
        {wrapped}
      </PinchHandler>
    );
  }
  return wrapped;
});

// ── 2× Speed Toast (long-press boost) ──
const BoostToast = memo(function BoostToast({ visible }) {
  const opacity = useRef(new Animated.Value(0)).current;
  // Safe-area top so the toast floats below the system clock on Android
  // edge-to-edge instead of being clipped by the status bar (used to use
  // static top:70 which sat under the notch on devices reporting >40dp).
  const bInsets = useSafeAreaInsets();
  useEffect(() => {
    Animated.timing(opacity, {
      toValue: visible ? 1 : 0,
      duration: 160,
      useNativeDriver: true,
    }).start();
  }, [visible]);
  return (
    <Animated.View pointerEvents="none" style={[styles.boostToast, { top: Math.max(bInsets.top, Platform.OS === 'android' ? 12 : 44) + 64, opacity }]}>
      <View style={styles.boostToastBg}>
        <Text style={styles.boostToastText}>2×</Text>
      </View>
    </Animated.View>
  );
});

// ── Single Reel Item ──
const ReelItem = memo(function ReelItem({ reel, isActive, colors, isDark, t, user, containerHeight, onOpenComments, onOpenLikers, onOpenProfile, onUseSound, onDuet, onStitch, onHidePost, showLiveRing, overlayOpen, router, preload }) {
  // Safe-area insets so the bottom info block (username/caption/music row)
  // doesn't sit on top of the iOS home indicator or Android gesture pill.
  const insets = useSafeAreaInsets();
  // Reels P0 — more-sheet visibility (Not interested / Duet / Stitch / Use sound)
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);
  const [paused, setPaused] = useState(false);
  // Share drawer (Repost / Copy link / External). Declared early so the
  // effectivePaused expression on the next line can reference it.
  const [shareSheetOpen, setShareSheetOpen] = useState(false);
  // When the comments/likers/share sheet opens above this reel, pause so the
  // user isn't trying to read with audio blasting underneath. Without this,
  // the Modal stack doesn't pause the underlying video — the reel keeps
  // playing unmuted and you have to manually pause before reading replies.
  const effectivePaused = paused || !!overlayOpen || shareSheetOpen;
  // TikTok-style speed selector: persists to AsyncStorage so the user's
  // chosen default rides between reels. While long-pressing the video we
  // temporarily boost to 2× and snap back on release (rateBoost flag).
  const [playbackRate, setPlaybackRate] = useState(1);
  const [rateBoost, setRateBoost] = useState(false); // long-press 2× preview
  const [speedPickerOpen, setSpeedPickerOpen] = useState(false);
  // Hydrate the persisted default once on mount so subsequent reels open at
  // the user's preferred rate. Stored as a string number under REELS_SPEED_KEY.
  useEffect(() => {
    (async () => {
      try {
        const v = await AsyncStorage.getItem(REELS_SPEED_KEY);
        const n = Number(v);
        if (Number.isFinite(n) && n > 0 && n !== 1) setPlaybackRate(n);
      } catch {}
    })();
  }, []);
  const cyclePlaybackRate = useCallback(() => {
    setSpeedPickerOpen(true);
    try { require('expo-haptics').selectionAsync(); } catch {}
  }, []);
  const handleSelectSpeed = useCallback(async (s) => {
    setPlaybackRate(s);
    setSpeedPickerOpen(false);
    try { await AsyncStorage.setItem(REELS_SPEED_KEY, String(s)); } catch {}
    try { require('expo-haptics').selectionAsync(); } catch {}
  }, []);
  // Effective rate sent to the video — boost wins.
  const effectiveRate = rateBoost ? 2 : playbackRate;
  const [muted, setMuted] = useState(false);
  const [liked, setLiked] = useState(!!reel.user_liked);
  const [likeCount, setLikeCount] = useState(Number(reel.like_count) || 0);
  const [bookmarked, setBookmarked] = useState(!!reel.user_bookmarked);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [currentMs, setCurrentMs] = useState(0);
  const [isScrubbing, setIsScrubbing] = useState(false);
  const scrubbingRef = useRef(false);
  useEffect(() => { scrubbingRef.current = isScrubbing; }, [isScrubbing]);
  const [showPauseFlash, setShowPauseFlash] = useState(false);
  // Burst particle key — bump to remount HeartParticleBurst so the
  // animation reruns on every double-tap or like-button trigger.
  const [particleKey, setParticleKey] = useState(0);
  const [viewCount, setViewCount] = useState(Number(reel.view_count) || 0);
  // Subtitles (TikTok auto-captions). CC enabled persists across sessions to
  // AsyncStorage (REELS_CC_KEY) so the user keeps their preference. We still
  // default to ON when segments are present (matches TikTok behavior).
  const initialSegs = Array.isArray(reel?.subtitles) ? reel.subtitles : [];
  const [subtitleSegments, setSubtitleSegments] = useState(initialSegs);
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(initialSegs.length > 0);
  const ccHydratedRef = useRef(false);
  useEffect(() => {
    if (ccHydratedRef.current) return;
    ccHydratedRef.current = true;
    (async () => {
      try {
        const v = await AsyncStorage.getItem(REELS_CC_KEY);
        if (v === '0') setSubtitlesEnabled(false);
        else if (v === '1') setSubtitlesEnabled(true);
      } catch {}
    })();
  }, []);
  const toggleSubtitles = useCallback(() => {
    setSubtitlesEnabled(v => {
      const next = !v;
      AsyncStorage.setItem(REELS_CC_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  }, []);
  const transcribeFiredRef = useRef(false);

  const videoRef = useRef(null);
  const lastTapRef = useRef(0);
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;
  const likeScale = useRef(new Animated.Value(1)).current;
  const bookmarkScale = useRef(new Animated.Value(1)).current;
  const progressIntervalRef = useRef(null);
  const pauseFlashKey = useRef(0);

  // Reels P1 — tip sheet (reuses LivePaidGiftSheet) + floating diamond burst.
  // diamondBursts is a list of { key, label } we mount briefly to play the
  // rise-and-fade animation. WS `feed_post_tip` events from other viewers
  // append to the same list so everyone watching sees the diamond fly.
  const [tipSheetOpen, setTipSheetOpen] = useState(false);
  const [diamondBursts, setDiamondBursts] = useState([]);
  const burstSeqRef = useRef(0);
  // Sound favorite — tap 💾 on the music marquee. Local state mirrors the
  // backend so the icon flips immediately. Initialized off reel.sound_saved
  // if the server hydrated it on /feed_list, else off.
  const [soundSaved, setSoundSaved] = useState(!!reel.sound_saved);
  useEffect(() => { setSoundSaved(!!reel.sound_saved); }, [reel.sound_saved, reel.id]);

  // Follow state — mirrors reel.user_following (server-hydrated). Inline
  // "Follow" button next to the avatar only renders for other users we
  // don't already follow. Optimistic flip + rollback on failure.
  const [followed, setFollowed] = useState(!!(reel.user_following || reel.is_following));
  useEffect(() => {
    setFollowed(!!(reel.user_following || reel.is_following));
  }, [reel.user_following, reel.is_following, reel.id]);
  const isOtherUser = !!reel.author_email
    && String(reel.author_email).toLowerCase() !== String(user?.email || '').toLowerCase();
  const followInFlightRef = useRef(false);
  const handleFollow = useCallback(async () => {
    if (followInFlightRef.current) return;
    if (!reel?.author_email) return;
    followInFlightRef.current = true;
    setFollowed(true);
    try { require('expo-haptics').selectionAsync(); } catch {}
    try {
      await api.followUser?.(reel.author_email);
    } catch {
      setFollowed(false);
    } finally {
      followInFlightRef.current = false;
    }
  }, [reel?.author_email]);

  const pushDiamondBurst = useCallback((label) => {
    burstSeqRef.current += 1;
    const key = burstSeqRef.current;
    setDiamondBursts(prev => [...prev, { key, label }]);
    // GC the burst after the animation completes (1500ms ≈ animation length).
    setTimeout(() => {
      setDiamondBursts(prev => prev.filter(b => b.key !== key));
    }, 1700);
  }, []);

  // WS — listen for tips on this reel so non-tipping viewers see the burst.
  useEffect(() => {
    if (!reel?.id) return;
    let unsub = null;
    let mailWs = null;
    try { mailWs = require('../services/websocket').default; } catch {}
    if (!mailWs?.on || !mailWs?.subscribe) return;
    const channel = `feed_post_${reel.id}`;
    try { mailWs.subscribe(channel); } catch {}
    unsub = mailWs.on('feed_post_tip', (data) => {
      if (!data || Number(data.post_id) !== Number(reel.id)) return;
      const who = data.sender_name || data.sender_email?.split('@')[0] || '?';
      pushDiamondBurst(`${who} 💎`);
    });
    return () => {
      try { unsub?.(); } catch {}
      try { mailWs.unsubscribe?.(channel); } catch {}
    };
  }, [reel?.id, pushDiamondBurst]);

  // Tip click → open the existing paid-gift sheet. Override onClose so we
  // can intercept the send: LivePaidGiftSheet auto-fires liveGiftSend by
  // session_id; for a reel-tip we instead call feedPostTip.
  const handleOpenTip = useCallback(() => {
    if (!reel?.id) return;
    setTipSheetOpen(true);
  }, [reel?.id]);

  // Save / unsave the reel's sound to chat_user_saved_sounds. When
  // sound_id is empty (Original) we synthesize "<email>/<id>" to keep the
  // favorites table self-consistent.
  const handleToggleSoundSave = useCallback(async () => {
    if (!reel) return;
    const sid = reel.sound_id || `${reel.author_email}/${reel.id}`;
    const label = reel.sound_label || `${reel.author_name || reel.author_email?.split('@')[0]} — ${t?.('feed.originalAudio') || 'Audio original'}`;
    if (soundSaved) {
      setSoundSaved(false);
      try { await api.reelsSoundFavoriteUnsave?.(sid); } catch {}
    } else {
      setSoundSaved(true);
      try {
        await api.reelsSoundFavoriteSave?.(sid, label, {
          previewUrl: reel.sound_preview_url || '',
          imageUrl: reel.sound_image_url || '',
          durationSec: Number(reel.video_duration_ms) ? Math.round(Number(reel.video_duration_ms) / 1000) : 30,
        });
      } catch {}
      try { require('expo-haptics').selectionAsync(); } catch {}
    }
  }, [reel, soundSaved, t]);

  const mediaUrls = parseMediaUrls(reel.media_urls);
  const videoUrl = resolveMediaUrl(mediaUrls[0]);
  const authorDisplay = reel.author_name || reel.author_email?.split('@')[0] || '?';
  const commentCount = Number(reel.comment_count) || 0;
  const musicName = reel.audio_name || `${authorDisplay} - ${t('feed.originalAudio') || 'Audio original'}`;

  // Sync with prop changes
  useEffect(() => {
    setLiked(!!reel.user_liked);
    setLikeCount(Number(reel.like_count) || 0);
    setBookmarked(!!reel.user_bookmarked);
  }, [reel.user_liked, reel.like_count, reel.user_bookmarked]);

  // Track view when reel becomes active
  useEffect(() => {
    if (isActive && reel.id) {
      api.feedView?.(reel.id).catch(() => {});
    }
  }, [isActive, reel.id]);

  // Auto-play/pause based on active state (web)
  useEffect(() => {
    if (!isWeb) return;
    const v = videoRef.current;
    if (!v) return;
    if (isActive && !effectivePaused) {
      v.muted = true;
      v.currentTime = v.currentTime || 0;
      const playPromise = v.play();
      if (playPromise) {
        playPromise.then(() => {
          if (!muted) setTimeout(() => { v.muted = false; }, 300);
        }).catch(() => {
          v.muted = true;
          v.play().catch(() => {});
        });
      }
    } else {
      v.pause();
    }
  }, [isActive, effectivePaused, muted]);

  // Progress tracking (web). Also drives subtitle current-time so the
  // overlay re-paints in sync with playback. 100ms tick is generous —
  // captions feel stuttery below ~250ms but TikTok runs ~16ms; we
  // compromise at 100ms because RN setState batches anyway. Suspend the
  // tick while the user is dragging the scrubber so the thumb tracks the
  // finger instead of the underlying playhead. (scrubbingRef declared above
  // alongside isScrubbing state so handleNativeTime can read it.)
  useEffect(() => {
    if (!isWeb) return;
    if (isActive) {
      progressIntervalRef.current = setInterval(() => {
        if (scrubbingRef.current) return;
        if (videoRef.current && videoRef.current.duration) {
          setProgress(videoRef.current.currentTime / videoRef.current.duration);
          setCurrentMs(videoRef.current.currentTime * 1000);
        }
      }, 100);
    } else {
      setProgress(0);
      setCurrentMs(0);
    }
    return () => {
      if (progressIntervalRef.current) clearInterval(progressIntervalRef.current);
    };
  }, [isActive]);

  // Auto-transcribe own reel that doesn't yet have captions. Whisper
  // hits the existing `ai_transcribe_audio` endpoint; the result is
  // saved back via `feed_post_set_subtitles` so the next viewer sees
  // captions instantly. Fire-once: transcribeFiredRef prevents
  // duplicate jobs across re-renders or tab toggles.
  useEffect(() => {
    if (transcribeFiredRef.current) return;
    if (!isActive || !reel?.id) return;
    if (subtitleSegments.length > 0) return;
    const ownerLc = String(reel.author_email || '').toLowerCase();
    const meLc = String(user?.email || '').toLowerCase();
    if (!ownerLc || ownerLc !== meLc) return; // only owner triggers
    if (!videoUrl) return;
    transcribeFiredRef.current = true;
    (async () => {
      try {
        const r = await api.aiAssist?.('transcribe_video', { url: videoUrl });
        const segs = r?.data?.segments;
        if (Array.isArray(segs) && segs.length > 0) {
          setSubtitleSegments(segs);
          setSubtitlesEnabled(true);
          try { await api.feedPostSetSubtitles(reel.id, segs); } catch {}
        }
      } catch {}
    })();
  }, [isActive, reel?.id, reel?.author_email, user?.email, subtitleSegments.length, videoUrl]);

  // Compute the visible caption line for the current playback time.
  const subtitleLine = subtitlesEnabled ? pickSubtitle(subtitleSegments, currentMs) : '';

  // Reset paused state when becoming active
  useEffect(() => {
    if (isActive) {
      setPaused(false);
      setCaptionExpanded(false);
    }
  }, [isActive]);

  const toggleMute = useCallback(() => {
    setMuted(m => {
      const newMuted = !m;
      if (isWeb && videoRef.current) {
        videoRef.current.muted = newMuted;
      }
      return newMuted;
    });
    try { require('expo-haptics').selectionAsync(); } catch {}
  }, []);

  const togglePause = useCallback(() => {
    if (isWeb) {
      if (!videoRef.current) return;
      if (videoRef.current.paused) {
        videoRef.current.muted = muted;
        videoRef.current.play().catch(() => {});
        setPaused(false);
      } else {
        videoRef.current.pause();
        setPaused(true);
        pauseFlashKey.current += 1;
        setShowPauseFlash(prev => !prev);
      }
    } else {
      setPaused(p => {
        if (!p) {
          pauseFlashKey.current += 1;
          setShowPauseFlash(prev => !prev);
        }
        return !p;
      });
    }
  }, [muted]);

  const showHeartAnimation = useCallback(() => {
    heartScale.setValue(0);
    heartOpacity.setValue(1);
    Animated.sequence([
      Animated.spring(heartScale, {
        toValue: 1.3,
        tension: 200,
        friction: 5,
        useNativeDriver: true,
      }),
      Animated.parallel([
        Animated.spring(heartScale, {
          toValue: 1,
          tension: 200,
          friction: 10,
          useNativeDriver: true,
        }),
        Animated.timing(heartOpacity, {
          toValue: 0,
          duration: 400,
          delay: 400,
          useNativeDriver: true,
        }),
      ]),
    ]).start();
  }, [heartScale, heartOpacity]);

  const likeInFlightRef = useRef(false);
  const toggleLike = useCallback(async () => {
    // Race guard — without this, rapid double-tap fires N parallel requests
    // and the like state desyncs (icon flickers or count jumps wildly).
    if (likeInFlightRef.current) return;
    likeInFlightRef.current = true;
    const wasLiked = liked;
    setLiked(!wasLiked);
    setLikeCount(prev => wasLiked ? Math.max(0, prev - 1) : prev + 1);
    // Scale-pop 1 → 1.4 → 1 spring (matches TikTok button feedback). Burst
    // particles + light haptic only when *becoming* liked, not on un-like.
    likeScale.setValue(1);
    Animated.sequence([
      Animated.spring(likeScale, { toValue: 1.4, tension: 300, friction: 5, useNativeDriver: true }),
      Animated.spring(likeScale, { toValue: 1, tension: 220, friction: 9, useNativeDriver: true }),
    ]).start();
    if (!wasLiked) {
      setParticleKey(k => k + 1);
      try { require('expo-haptics').impactAsync('light'); } catch {}
    }
    try {
      const r = await api.feedLike(reel.id);
      if (r.success && r.data) {
        if (r.data.liked !== undefined) setLiked(!!r.data.liked);
        if (r.data.like_count !== undefined) setLikeCount(Number(r.data.like_count));
      }
    } catch {
      setLiked(wasLiked);
      setLikeCount(prev => wasLiked ? prev + 1 : Math.max(0, prev - 1));
    } finally {
      likeInFlightRef.current = false;
    }
  }, [liked, reel.id, likeScale]);

  const handleDoubleTap = useCallback(() => {
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_DELAY) {
      // Double tap = like (with medium haptic + particle burst). Always
      // burst even when already liked — the affordance feels good and
      // matches TikTok behavior of always firing the heart on double-tap.
      if (!liked) toggleLike();
      showHeartAnimation();
      setParticleKey(k => k + 1);
      try { require('expo-haptics').impactAsync('medium'); } catch {}
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
      // Single tap with delay to differentiate
      setTimeout(() => {
        if (lastTapRef.current !== 0) {
          togglePause();
        }
      }, DOUBLE_TAP_DELAY + 50);
    }
  }, [liked, toggleLike, showHeartAnimation, togglePause]);

  const toggleBookmark = useCallback(async () => {
    const was = bookmarked;
    setBookmarked(!was);
    bookmarkScale.setValue(0.5);
    Animated.spring(bookmarkScale, {
      toValue: 1,
      tension: 300,
      friction: 8,
      useNativeDriver: true,
    }).start();
    try {
      const r = await api.feedBookmark(reel.id);
      if (r.success && r.data) {
        if (r.data.bookmarked !== undefined) setBookmarked(!!r.data.bookmarked);
      }
    } catch {
      setBookmarked(was);
    }
  }, [bookmarked, reel.id, bookmarkScale]);

  const handleShare = useCallback(() => {
    setShareSheetOpen(true);
  }, []);

  const handleShareExternal = useCallback(async () => {
    setShareSheetOpen(false);
    const url = `${BASE_URL}/feed/${reel.id}`;
    if (isWeb && typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: reel.caption || '', url }); } catch {}
    } else if (!isWeb) {
      try { await Share.share({ message: url }); } catch {}
    }
  }, [reel.id, reel.caption]);

  const handleShareCopyLink = useCallback(async () => {
    setShareSheetOpen(false);
    const url = `${BASE_URL}/feed/${reel.id}`;
    try {
      if (isWeb && typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(url);
      } else if (!isWeb) {
        // expo-clipboard is the canonical RN clipboard API; fall back silently
        // if the module isn't bundled (some older binaries skipped it).
        try {
          const Clipboard = require('expo-clipboard');
          await Clipboard.setStringAsync(url);
        } catch {
          try { require('react-native').Clipboard.setString(url); } catch {}
        }
      }
      try { require('expo-haptics').notificationAsync('success'); } catch {}
    } catch {}
  }, [reel.id]);

  const handleShareRepost = useCallback(() => {
    setShareSheetOpen(false);
    // Mirror FeedPost.handleRepost — defer to the feed surface with a
    // ?repost_of=… query so the existing CreatePostModal flow can pick it up.
    try {
      if (router?.push) {
        router.push(`/feed?repost_of=${reel.id}`);
        return;
      }
    } catch {}
    // Web/standalone fallback: just copy the link so the user can paste it.
    handleShareCopyLink();
  }, [reel.id, router, handleShareCopyLink]);

  const height = containerHeight || SCREEN_HEIGHT;

  // Long-press anywhere on the video → boost playbackRate to 2× (TikTok parity).
  // Snap back on release. (isScrubbing declared earlier so the progress effect
  // can read it via scrubbingRef.)
  const handleLongPress = useCallback(() => {
    setRateBoost(true);
    try { require('expo-haptics').impactAsync('medium'); } catch {}
  }, []);
  const handlePressOut = useCallback(() => {
    if (rateBoost) {
      setRateBoost(false);
      // Re-apply user's chosen rate to web video on release. Native reacts
      // automatically via the playbackRate prop on NativeReelVideo.
      if (isWeb && videoRef.current) {
        try { videoRef.current.playbackRate = playbackRate; } catch {}
      }
    }
  }, [rateBoost, playbackRate]);

  // Web: keep <video>.playbackRate in sync with effectiveRate (handles both
  // boost on long-press and user-chosen default).
  useEffect(() => {
    if (!isWeb || !videoRef.current) return;
    try { videoRef.current.playbackRate = effectiveRate; } catch {}
  }, [effectiveRate]);

  // Native seek bridge — exposed by NativeReelVideo (expo-shorts) via onReady.
  const nativeSeekRef = useRef(null);
  const handleNativeReady = useCallback((api) => {
    nativeSeekRef.current = api;
  }, []);
  // Native duration captured from the WebView's time updates so the
  // scrubber can convert pct → ms on seek without a round-trip.
  const nativeDurMsRef = useRef(0);
  // Native time updates — drives the scrubber. Suppressed while the user is
  // actively dragging so the thumb tracks the finger instead of the playhead.
  const handleNativeTime = useCallback((ms, durMs) => {
    if (!durMs) return;
    nativeDurMsRef.current = durMs;
    if (scrubbingRef.current) return;
    setProgress(ms / durMs);
    setCurrentMs(ms);
  }, []);

  // Scrubber seek handler. `final` is true on PanResponder release; false
  // during the live drag. We seek the underlying video either way so the
  // viewer sees the frame they're scrubbing to immediately.
  const handleScrub = useCallback((pct, final) => {
    setProgress(pct);
    if (isWeb && videoRef.current && Number.isFinite(videoRef.current.duration)) {
      try { videoRef.current.currentTime = videoRef.current.duration * pct; } catch {}
    } else if (!isWeb && nativeSeekRef.current?.seek) {
      const dur = nativeDurMsRef.current || 0;
      if (dur > 0) nativeSeekRef.current.seek(dur * pct);
    }
  }, []);

  return (
    <View style={[styles.reelContainer, { height, width: SCREEN_WIDTH }]}>
      {/* Video - full screen edge to edge. Long-press anywhere → 2× boost.
          Wrapped in PinchZoomBox so two-finger pinch scales 1..3× then springs
          back on release (silent no-op when RNGH isn't on the path). */}
      <PinchZoomBox>
      <TouchableOpacity
        activeOpacity={1}
        onPress={handleDoubleTap}
        onLongPress={handleLongPress}
        onPressOut={handlePressOut}
        delayLongPress={350}
        style={StyleSheet.absoluteFill}
      >
        {isWeb ? (
          <video
            ref={(el) => {
              videoRef.current = el;
              if (el && isActive) {
                el.muted = true;
                el.play().then(() => {
                  if (!muted) setTimeout(() => { el.muted = false; }, 300);
                }).catch(() => {
                  el.muted = true;
                  el.play().catch(() => {});
                });
              } else if (el && !isActive) {
                el.pause();
              }
            }}
            src={videoUrl}
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              aspectRatio: '9 / 16',
              backgroundColor: '#000',
            }}
            loop
            playsInline
            muted
            preload="auto"
            poster={reel.thumbnail_url ? resolveMediaUrl(reel.thumbnail_url) : undefined}
          />
        ) : (
          <NativeReelVideo
            videoUrl={videoUrl}
            poster={reel.thumbnail_url ? resolveMediaUrl(reel.thumbnail_url) : null}
            isActive={isActive}
            paused={effectivePaused}
            playbackRate={effectiveRate}
            muted={muted}
            onTimeUpdate={handleNativeTime}
            onReady={handleNativeReady}
            isPreload={!!preload && !isActive}
          />
        )}
      </TouchableOpacity>
      </PinchZoomBox>

      {/* 2× boost toast (long-press). Floats top-center, fades in/out. */}
      <BoostToast visible={rateBoost} />

      {/* Gradient overlays for readability */}
      <View pointerEvents="none" style={styles.topGradient} />
      <View pointerEvents="none" style={styles.bottomGradient} />

      {/* Pause flash animation */}
      <PauseFlash key={pauseFlashKey.current} visible={paused} />

      {/* Heart animation (double-tap) - big white heart center screen */}
      <Animated.View
        pointerEvents="none"
        style={[styles.heartAnimOverlay, {
          opacity: heartOpacity,
          transform: [{ scale: heartScale }],
        }]}
      >
        <IconHeart size={110} color="#fff" />
      </Animated.View>

      {/* Particle burst — fires on like (double-tap or button). `key`
          remount is what restarts the per-particle Animated timeline. */}
      {particleKey > 0 && (
        <HeartParticleBurst key={particleKey} />
      )}

      {/* ── TOP BAR (right side only - tabs are rendered by parent) ── */}
      {/* Android safe-area: status bar can be 24-36dp; the static
          paddingTop:16 from styles.topBar was cropping into the system
          clock/battery. Override with the runtime inset (with a tiny
          floor for devices that report 0). */}
      <View style={[styles.topBar, { paddingTop: Math.max(insets.top, Platform.OS === 'android' ? 12 : 44) + 8 }]}>
        {/* Top-left LIVE banner — only renders when the reel author is
            broadcasting. Red bg + white dot + "AO VIVO" text. Tapping
            routes to the live viewer through onOpenProfile (parent wires
            this to /live-viewer?id=<liveId>). SVG dot, no emoji per UI rule. */}
        {(reel.is_live || reel.live_id) ? (
          <TouchableOpacity
            onPress={() => onOpenProfile?.(reel.author_email, reel)}
            activeOpacity={0.85}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              backgroundColor: '#FF3B30',
              paddingHorizontal: 10,
              paddingVertical: 5,
              borderRadius: 6,
            }}
            accessibilityLabel={t?.('feed.live') || 'AO VIVO'}
            accessibilityRole="button"
          >
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />
            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 }}>
              {(t?.('feed.live') || 'AO VIVO').toUpperCase()}
            </Text>
          </TouchableOpacity>
        ) : (
          <View />
        )}
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 16 }}>
          <TouchableOpacity
            onPress={toggleMute}
            activeOpacity={0.7}
            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
            style={{
              backgroundColor: muted ? 'rgba(124,58,237,0.85)' : 'rgba(0,0,0,0.45)',
              borderRadius: 20,
              width: 36,
              height: 36,
              alignItems: 'center',
              justifyContent: 'center',
              borderWidth: muted ? 0 : StyleSheet.hairlineWidth,
              borderColor: 'rgba(255,255,255,0.18)',
            }}
            accessibilityLabel={muted ? (t('feed.unmute') || 'Unmute') : (t('feed.mute') || 'Mute')}
            accessibilityRole="button"
          >
            {muted ? <IconVolumeX size={20} color="#fff" /> : <IconVolume2 size={20} color="#fff" />}
          </TouchableOpacity>
          {/* CC toggle — only renders when the post has segments. Tap
              hides/shows the bottom subtitle overlay. Persists to AsyncStorage. */}
          {subtitleSegments.length > 0 && (
            <TouchableOpacity
              onPress={toggleSubtitles}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{ backgroundColor: subtitlesEnabled ? 'rgba(124,58,237,0.85)' : 'rgba(0,0,0,0.35)', borderRadius: 8, paddingHorizontal: 8, height: 28, alignItems: 'center', justifyContent: 'center' }}
              accessibilityLabel={subtitlesEnabled ? (t('feed.captionsOn') || t('media.subtitlesOn') || 'Captions on') : (t('feed.captionsOff') || t('media.subtitlesOff') || 'Captions off')}
              accessibilityRole="button"
            >
              <Text style={{ color: '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 }}>CC</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity activeOpacity={0.7} hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}>
            <IconCamera size={26} color="#fff" />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── RIGHT SIDE BUTTONS ── */}
      <View style={styles.rightSidebar}>
        {/* Profile avatar with white border + follow badge. Tapping opens
            the author's unified profile at /u/{email}. Previously had no
            onPress so the tap was a silent no-op. */}
        <TouchableOpacity
          style={styles.profileAvatarBtn}
          activeOpacity={0.8}
          onPress={() => onOpenProfile?.(reel.author_email, reel)}
          accessibilityLabel={authorDisplay}
          accessibilityRole="button"
        >
          {/* Reels P0 — Live badge ring around the avatar when the author is
              broadcasting. Tap routes via onAvatarTap (wired in parent). */}
          {showLiveRing && (reel.is_live || reel.live_id) ? (
            <LiveBadgeRing size={40}>
              <AvatarCircle email={reel.author_email} name={reel.author_name} size={36} />
            </LiveBadgeRing>
          ) : (
            <View style={styles.profileAvatarRing}>
              <AvatarCircle email={reel.author_email} name={reel.author_name} size={36} />
            </View>
          )}
          {/* Plus-badge only when not yet followed and is another user. */}
          {!followed && isOtherUser ? (
            <TouchableOpacity
              onPress={handleFollow}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              style={styles.profileFollowBadge}
              accessibilityLabel={t?.('feed.follow') || 'Follow'}
              accessibilityRole="button"
            >
              <Text style={styles.profileFollowPlus}>+</Text>
            </TouchableOpacity>
          ) : null}
        </TouchableOpacity>

        {/* Like */}
        <Animated.View style={{ transform: [{ scale: likeScale }] }}>
          <TouchableOpacity
            style={styles.sidebarBtn}
            onPress={toggleLike}
            activeOpacity={0.7}
            accessibilityLabel={liked ? (t('feed.unlike') || 'Unlike') : (t('feed.like') || 'Like')}
            accessibilityRole="button"
          >
            {liked ? (
              <IconHeart size={28} color="#FF2D55" />
            ) : (
              <IconHeartOutline size={28} color="#fff" />
            )}
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onOpenLikers?.(reel)} activeOpacity={0.7}>
            <Text style={styles.sidebarCount}>{formatCount(likeCount)}</Text>
          </TouchableOpacity>
        </Animated.View>

        {/* Tip / Diamond — Reels P1 monetization. Opens LivePaidGiftSheet,
            which reuses the same SKU set + wallet UI as Live gifts. On send
            we fire feed_post_tip (not the live gift endpoint) so the reel
            gets credit and the floating diamond animation. Hidden when
            viewing your own reel — you can't tip yourself. */}
        {reel.author_email?.toLowerCase() !== user?.email?.toLowerCase() && (
          <TouchableOpacity
            style={styles.sidebarBtn}
            onPress={handleOpenTip}
            activeOpacity={0.7}
            accessibilityLabel={t?.('feed.tipCreator') || 'Mandar diamante'}
            accessibilityRole="button"
          >
            <Text style={{ fontSize: 26 }}>💎</Text>
          </TouchableOpacity>
        )}

        {/* Comment */}
        <TouchableOpacity
          style={styles.sidebarBtn}
          onPress={() => onOpenComments?.(reel)}
          activeOpacity={0.7}
          accessibilityLabel={t('feed.comment') || 'Comment'}
          accessibilityRole="button"
        >
          <IconMessageCircle size={28} color="#fff" />
          <Text style={styles.sidebarCount}>{formatCount(commentCount)}</Text>
        </TouchableOpacity>

        {/* Share */}
        <TouchableOpacity
          style={styles.sidebarBtn}
          onPress={handleShare}
          activeOpacity={0.7}
          accessibilityLabel={t('feed.share') || 'Compartilhar'}
          accessibilityRole="button"
        >
          <IconShare size={28} color="#fff" />
        </TouchableOpacity>

        {/* Playback speed — TikTok parity. Tap cycles 1x → 1.5x → 2x → 0.5x.
            Hidden when at 1x to keep the rail clean; reveals as a small pill
            once user opted into a non-default speed. */}
        <TouchableOpacity
          style={[styles.sidebarBtn, { paddingVertical: 6 }]}
          onPress={cyclePlaybackRate}
          activeOpacity={0.7}
          accessibilityLabel={`${t?.('feed.speed') || 'Velocidade'} ${playbackRate}x`}
          accessibilityRole="button"
        >
          <View style={{
            paddingHorizontal: 10, paddingVertical: 4, borderRadius: 12,
            backgroundColor: playbackRate === 1 ? 'rgba(255,255,255,0.15)' : '#7C3AED',
            minWidth: 36, alignItems: 'center',
          }}>
            <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>
              {playbackRate === 0.5 ? '0.5×' : playbackRate === 1 ? '1×' : playbackRate === 1.5 ? '1.5×' : '2×'}
            </Text>
          </View>
        </TouchableOpacity>

        {/* Views */}
        {viewCount > 0 && (
          <View style={styles.sidebarBtn}>
            <IconEye size={28} color="#fff" />
            <Text style={styles.sidebarCount}>{formatCount(viewCount)}</Text>
          </View>
        )}

        {/* Bookmark */}
        <Animated.View style={{ transform: [{ scale: bookmarkScale }] }}>
          <TouchableOpacity
            style={styles.sidebarBtn}
            onPress={toggleBookmark}
            activeOpacity={0.7}
            accessibilityLabel={bookmarked ? (t('feed.removeBookmark') || 'Remove') : (t('feed.bookmark') || 'Save')}
            accessibilityRole="button"
          >
            {bookmarked ? (
              <IconBookmarkFilled size={28} color="#fff" />
            ) : (
              <IconBookmark size={28} color="#fff" />
            )}
          </TouchableOpacity>
        </Animated.View>

        {/* More (kebab) — Reels P0: opens the actions sheet
            (Duet / Stitch / Use sound / Not interested / Report). */}
        <TouchableOpacity
          style={styles.sidebarBtn}
          onPress={() => setMoreSheetOpen(true)}
          activeOpacity={0.7}
          accessibilityLabel={t?.('common.more') || 'More'}
          accessibilityRole="button"
        >
          <IconMoreHorizontal size={28} color="#fff" />
        </TouchableOpacity>

        {/* Spinning album art disc — tap to jump to the sound feed
            ("Usar este som"). Long-press-friendly hit area thanks to the
            outer TouchableOpacity. */}
        <TouchableOpacity
          activeOpacity={0.85}
          onPress={() => onUseSound && onUseSound(reel)}
          accessibilityLabel={t?.('feed.useThisSound') || 'Usar este som'}
          accessibilityRole="button"
        >
          <SpinningDisc authorEmail={reel.author_email} authorName={reel.author_name} />
        </TouchableOpacity>
      </View>

      {/* ── Subtitle overlay (TikTok auto-caption) ──
          Sits above the bottom info block so the visible caption doesn't
          fight for the same vertical space. We pin to bottom-center with
          a max-width of 78% so it never collides with the right rail. */}
      {!!subtitleLine && (
        <View pointerEvents="none" style={styles.subtitleOverlay}>
          <View style={styles.subtitleBg}>
            <Text style={styles.subtitleText}>{subtitleLine}</Text>
          </View>
        </View>
      )}

      {/* ── BOTTOM LEFT INFO ── */}
      <View style={[styles.bottomInfo, { paddingBottom: insets.bottom + 16 }]}>
        {/* Username */}
        <Text style={styles.username}>@{authorDisplay}</Text>

        {/* Caption */}
        {reel.caption ? (
          <TouchableOpacity
            onPress={() => setCaptionExpanded(!captionExpanded)}
            activeOpacity={0.9}
          >
            <Text style={styles.caption} numberOfLines={captionExpanded ? undefined : 2}>
              {reel.caption}
            </Text>
            {!captionExpanded && reel.caption.length > 80 && (
              <Text style={styles.moreText}>{t('feed.more') || 'mais'}</Text>
            )}
          </TouchableOpacity>
        ) : null}

        {/* Music row with marquee + tiny equalizer. Tapping the row jumps
            to "Use this sound". The 💾 button on the right saves the sound
            to the user's favorites (chat_user_saved_sounds) so it shows up
            in CreatePostModal's "Meus salvos" tab. */}
        <View style={[styles.musicRow, { flexDirection: 'row', alignItems: 'center' }]}>
          <TouchableOpacity
            style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 }}
            activeOpacity={0.7}
            onPress={() => onUseSound && onUseSound(reel)}
            accessibilityLabel={t?.('feed.useThisSound') || 'Usar este som'}
            accessibilityRole="button"
          >
            <IconMusic size={12} color="#fff" />
            <MusicEqualizer />
            <MusicMarquee text={musicName} />
          </TouchableOpacity>
          {/* Reels P1 — save sound favorite. 💾 toggles persistence. */}
          <TouchableOpacity
            onPress={handleToggleSoundSave}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            style={{ paddingLeft: 8, paddingRight: 2 }}
            accessibilityRole="button"
            accessibilityLabel={soundSaved ? (t?.('feed.unsaveSound') || 'Remover som dos salvos') : (t?.('feed.saveSound') || 'Salvar som')}
          >
            <Text style={{ fontSize: 16, opacity: soundSaved ? 1 : 0.7 }}>{soundSaved ? '💾' : '💾'}</Text>
          </TouchableOpacity>
        </View>
      </View>

      {/* Floating diamond bursts — mounted briefly on each tip event. */}
      {diamondBursts.map(b => (
        <FloatingDiamond key={b.key} label={b.label} />
      ))}

      {/* Tip sheet — reuses LivePaidGiftSheet UI. We intercept onClose so we
          can substitute our own feed_post_tip call (the sheet doesn't know
          how to call our reel-tip endpoint). Trick: hand it a tip handler
          via a wrapping side-effect — when the sheet closes we check
          its last-selected gift and fire the tip ourselves. */}
      <TipSheetWrapper
        visible={tipSheetOpen}
        onClose={() => setTipSheetOpen(false)}
        postId={reel?.id}
        onTipSent={(giftSku) => {
          pushDiamondBurst((user?.name || user?.email?.split('@')[0] || 'Você') + ' 💎');
          try { require('expo-haptics').notificationAsync(require('expo-haptics').NotificationFeedbackType.Success); } catch {}
        }}
        t={t}
      />

      {/* ── DRAGGABLE SCRUBBER ── (tap to jump / drag to seek) */}
      <Scrubber
        progress={progress}
        onSeek={handleScrub}
        onScrubStart={() => setIsScrubbing(true)}
        onScrubEnd={() => setIsScrubbing(false)}
      />

      {/* Share drawer (Repost / Copy link / External) */}
      <ShareSheet
        visible={shareSheetOpen}
        reel={reel}
        t={t}
        onClose={() => setShareSheetOpen(false)}
        onRepost={handleShareRepost}
        onCopyLink={handleShareCopyLink}
        onExternal={handleShareExternal}
      />

      {/* Reels P0 — More actions sheet (Duet / Stitch / Use sound /
          Not interested / Report). Sliding bottom sheet, same UX shape
          as ShareSheet so it feels native + consistent. */}
      <Modal
        visible={moreSheetOpen}
        transparent
        animationType="fade"
        onRequestClose={() => setMoreSheetOpen(false)}
      >
        <Pressable
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end' }}
          onPress={() => setMoreSheetOpen(false)}
        >
          <Pressable
            style={{
              backgroundColor: '#1a1a1a',
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              paddingTop: 10,
              paddingBottom: 28,
            }}
            onPress={(e) => e.stopPropagation && e.stopPropagation()}
          >
            <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', alignSelf: 'center', marginBottom: 12 }} />

            {/* Use this sound */}
            {!!reel.sound_id && (
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 }}
                onPress={() => { setMoreSheetOpen(false); onUseSound && onUseSound(reel); }}
                activeOpacity={0.7}
              >
                <IconMusic size={22} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                  {t?.('feed.useThisSound') || 'Usar este som'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Duet — only when the creator allows it. */}
            {reel.allow_duet !== false && reel.media_type === 'video' && (
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 }}
                onPress={() => { setMoreSheetOpen(false); onDuet && onDuet(reel); }}
                activeOpacity={0.7}
              >
                <IconRepeat size={22} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                  {t?.('feed.duet') || 'Duet (split-screen)'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Stitch — only when the creator allows it. */}
            {reel.allow_stitch !== false && reel.media_type === 'video' && (
              <TouchableOpacity
                style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 }}
                onPress={() => { setMoreSheetOpen(false); onStitch && onStitch(reel); }}
                activeOpacity={0.7}
              >
                <IconPlay size={22} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                  {t?.('feed.stitch') || 'Stitch (clip + reagir)'}
                </Text>
              </TouchableOpacity>
            )}

            {/* Not interested — soft-hide. */}
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 }}
              onPress={() => { setMoreSheetOpen(false); onHidePost && onHidePost(reel, 'not_interested'); }}
              activeOpacity={0.7}
            >
              <IconX size={22} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                {t?.('feed.notInterested') || 'Não tenho interesse'}
              </Text>
            </TouchableOpacity>

            {/* Speed picker entry — opens dedicated 5-option sheet. */}
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 }}
              onPress={() => { setMoreSheetOpen(false); setSpeedPickerOpen(true); }}
              activeOpacity={0.7}
            >
              <IconPlay size={22} color="#fff" />
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', flex: 1 }}>
                {t?.('feed.speed') || 'Velocidade'}
              </Text>
              <Text style={{ color: '#a78bfa', fontSize: 14, fontWeight: '700' }}>{playbackRate}×</Text>
            </TouchableOpacity>

            {/* Report — escalated negative signal. */}
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 }}
              onPress={() => { setMoreSheetOpen(false); onHidePost && onHidePost(reel, 'reported'); }}
              activeOpacity={0.7}
            >
              <IconX size={22} color="#FF3B30" />
              <Text style={{ color: '#FF3B30', fontSize: 16, fontWeight: '600' }}>
                {t?.('feed.report') || 'Denunciar'}
              </Text>
            </TouchableOpacity>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Speed picker (TikTok parity: 0.5 / 0.75 / 1 / 1.5 / 2). Persists to AsyncStorage. */}
      <SpeedPickerSheet
        visible={speedPickerOpen}
        current={playbackRate}
        onSelect={handleSelectSpeed}
        onClose={() => setSpeedPickerOpen(false)}
        t={t}
      />
    </View>
  );
});

// ── Empty state ──
function EmptyReels({ colors, isDark, t }) {
  return (
    <View style={styles.emptyContainer}>
      <View style={styles.emptyIcon}>
        <IconPlay size={48} color="#555" />
      </View>
      <Text style={styles.emptyTitle}>
        {t('feed.noReels') || 'Sem reels ainda'}
      </Text>
      <Text style={styles.emptySubtext}>
        {t('feed.noReelsHint') || 'Videos aparecerao aqui'}
      </Text>
    </View>
  );
}

// ── Main ReelsViewer ──
export default function ReelsViewer({ colors, isDark, t, user, router, feedMode: feedModeProp, showLiveRing, onAvatarTap, onPullRefresh, soundId: soundIdProp, soundLabel: soundLabelProp }) {
  // Safe-area insets — the Following/For You tabs are absolutely positioned
  // with a static `top: 16` on Android, which on edge-to-edge windows was
  // tucking under the status-bar clock. Use runtime insets so the tab row
  // always clears the system UI.
  const outerInsets = useSafeAreaInsets();
  // Parent can drive the tab via prop (ChatReelsTab does). Default to whatever
  // the parent says or "forYou" so the in-viewer tab bar still works standalone.
  const initialTab = feedModeProp === 'following' ? 'following' : 'forYou';
  const [reelTab, setReelTab] = useState(initialTab);
  // Keep local tab state in sync if the parent flips it.
  useEffect(() => {
    if (feedModeProp === 'following' && reelTab !== 'following') setReelTab('following');
    if (feedModeProp === 'foryou' && reelTab !== 'forYou') setReelTab('forYou');
  }, [feedModeProp]); // eslint-disable-line react-hooks/exhaustive-deps
  const [reels, setReels] = useState([]);
  const [followingReels, setFollowingReels] = useState([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [commentsReel, setCommentsReel] = useState(null);
  const [likersReel, setLikersReel] = useState(null);
  const [containerHeight, setContainerHeight] = useState(SCREEN_HEIGHT);

  const viewConfigRef = useRef({ viewAreaCoveragePercentThreshold: 50 });
  const onViewableRef = useRef(({ viewableItems }) => {
    if (viewableItems && viewableItems[0]) {
      setCurrentIndex(viewableItems[0].index);
    }
  });
  const listRef = useRef(null);

  useEffect(() => {
    loadReels();
    // soundIdProp drives a "by-sound" load path — when set, both lists fold
    // into the same sound-feed so swiping shows every reel using that audio.
  }, [soundIdProp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Native player housekeeping — flip AVAudioSession to .playback on mount
  // (TikTok parity: audio survives lock screen) and restore + drain the pool
  // on unmount. Both functions are no-ops on web / when expo-shorts isn't
  // available (dev binaries that didn't link the native module).
  useEffect(() => {
    if (isWeb) return undefined;
    try { setShortsAudioSessionPlaybackFn?.(); } catch {}
    return () => {
      try { restoreShortsAudioSessionFn?.(); } catch {}
      try { releaseShortsPoolFn?.(); } catch {}
    };
  }, []);

  const loadReels = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    try {
      // Reels P0 — three load paths:
      //   1. soundIdProp set → "Use this sound" feed (chat_reels_by_sound)
      //   2. Following tab    → feedList({ type: 'following' }) for a strict
      //      chronological follows-only feed (no shared-conversation match)
      //   3. For You tab      → standard feedList() (contact-aware) for now;
      //      will swap to algorithm='fyp' once FYP ranker is GA.
      if (soundIdProp) {
        const r = await api.chatReelsBySound(soundIdProp, 1, 50);
        if (r && r.success && r.data) {
          const videos = Array.isArray(r.data.posts) ? r.data.posts : [];
          setReels(videos);
          setFollowingReels(videos);
        }
      } else {
        // Fire both feeds in parallel so switching tabs is instant.
        const [allR, followR] = await Promise.all([
          api.feedList({ page: 1, limit: 50 }),
          api.feedList({ page: 1, limit: 50, type: 'following' }),
        ]);
        if (allR && allR.success && allR.data) {
          const rawPosts = allR.data.posts || allR.data;
          const allPosts = Array.isArray(rawPosts) ? rawPosts : [];
          const videos = allPosts.filter(p => {
            if (p.media_type === 'video') return true;
            const urls = parseMediaUrls(p.media_urls);
            return urls.some(u => typeof u === 'string' && (u.endsWith('.mp4') || u.endsWith('.mov') || u.endsWith('.webm')));
          });
          setReels(videos);
        }
        if (followR && followR.success && followR.data) {
          const rawF = followR.data.posts || followR.data;
          const followingAll = Array.isArray(rawF) ? rawF : [];
          const followingVids = followingAll.filter(p => {
            if (p.media_type === 'video') return true;
            const urls = parseMediaUrls(p.media_urls);
            return urls.some(u => typeof u === 'string' && (u.endsWith('.mp4') || u.endsWith('.mov') || u.endsWith('.webm')));
          });
          setFollowingReels(followingVids);
        }
      }
    } catch (e) {
      console.warn('Reels load error:', e);
    } finally {
      setLoading(false);
      setRefreshing(false);
      try { onPullRefresh && isRefresh && onPullRefresh(); } catch {}
    }
  };

  const handleRefresh = useCallback(() => loadReels(true), []);

  const handleOpenComments = useCallback((reel) => {
    setCommentsReel(reel);
  }, []);

  const handleOpenLikers = useCallback((reel) => {
    setLikersReel(reel);
  }, []);

  const onLayout = useCallback((e) => {
    const h = e.nativeEvent.layout.height;
    if (h > 0) setContainerHeight(h);
  }, []);

  const activeReels = reelTab === 'following' ? followingReels : reels;

  // Native pool prefetch — warm slots for the next two reels when the
  // viewable item changes. Cheap (singleton pool tops out at 3 instances),
  // and it's what makes TikTok-style swipes feel instant. The pool's LRU
  // strategy means the just-watched reel naturally evicts itself when we
  // hit reel N+3. No-op on web (HLS+<video> already preloads metadata).
  useEffect(() => {
    if (isWeb || !prefetchShortsVideoFn) return;
    if (!Array.isArray(activeReels) || activeReels.length === 0) return;
    for (const offset of [1, 2]) {
      const nextIdx = currentIndex + offset;
      const next = activeReels[nextIdx];
      if (!next) continue;
      const urls = parseMediaUrls(next.media_urls);
      const u = resolveMediaUrl(urls[0]);
      if (!u) continue;
      try { prefetchShortsVideoFn(String(next.id), u); } catch {}
    }
  }, [currentIndex, activeReels]);

  // Reset index when switching tabs
  const handleTabChange = useCallback((tab) => {
    setReelTab(tab);
    setCurrentIndex(0);
    if (listRef.current) {
      try { listRef.current.scrollToOffset({ offset: 0, animated: false }); } catch {}
    }
  }, []);

  const handleOpenProfile = useCallback((email, item) => {
    // If the parent wired onAvatarTap (ChatReelsTab does for live routing),
    // give it the first shot so tapping a live creator opens the live viewer
    // instead of their profile.
    if (item && typeof onAvatarTap === 'function') {
      const handled = onAvatarTap(item);
      if (handled) return;
    }
    if (!email || !router) return;
    router.push(`/u/${encodeURIComponent(email)}`);
  }, [router, onAvatarTap]);

  // ── Reels P0: "Use this sound" — route to a sound-feed instance of the
  // viewer. The /reels-sound route renders <ReelsViewer soundId={id} /> so
  // every clip using that audio shows up in the same vertical pager.
  const handleUseSound = useCallback((reel) => {
    if (!reel?.sound_id) return;
    try {
      router?.push(`/reels-sound?sound_id=${encodeURIComponent(reel.sound_id)}&label=${encodeURIComponent(reel.sound_label || '')}`);
    } catch {}
  }, [router]);

  // ── Reels P0: Duet / Stitch — bounce into the create-post screen with the
  // parent post id pre-loaded so the recorder boots into split/stitch mode.
  const handleDuet = useCallback((reel) => {
    if (!reel?.id) return;
    try { router?.push(`/post-create?duet_of=${reel.id}`); } catch {}
  }, [router]);
  const handleStitch = useCallback((reel) => {
    if (!reel?.id) return;
    try { router?.push(`/post-create?stitch_of=${reel.id}`); } catch {}
  }, [router]);

  // ── Reels P0: Not interested — soft-hide for the current viewer.
  const handleHidePost = useCallback(async (reel, signal = 'not_interested') => {
    if (!reel?.id) return;
    try { await api.feedHidePost(reel.id, signal); } catch {}
    // Optimistically drop the reel from the active list so it disappears now.
    setReels(prev => prev.filter(p => p.id !== reel.id));
    setFollowingReels(prev => prev.filter(p => p.id !== reel.id));
  }, []);

  const overlayOpen = !!commentsReel || !!likersReel;
  // Pre-load window: mark the reel that's one and two ahead as `preload`.
  // On native, the parent's prefetch effect already warmed the pool — this
  // flag just keeps the native view paused (playWhenInFocus=false) while
  // the AVPlayer / ExoPlayer holds the URL ready. On web, <video preload="auto">
  // does the same trick.
  const renderItem = useCallback(({ item, index }) => {
    const isActiveItem = index === currentIndex;
    const isPreloadItem = !isActiveItem && (index === currentIndex + 1 || index === currentIndex + 2);
    return (
      <ReelItem
        reel={item}
        isActive={isActiveItem}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        router={router}
        containerHeight={containerHeight}
        onOpenComments={handleOpenComments}
        onOpenLikers={handleOpenLikers}
        onOpenProfile={handleOpenProfile}
        onUseSound={handleUseSound}
        onDuet={handleDuet}
        onStitch={handleStitch}
        onHidePost={handleHidePost}
        showLiveRing={!!showLiveRing}
        overlayOpen={overlayOpen}
        preload={isPreloadItem}
      />
    );
  }, [currentIndex, colors, isDark, t, user, router, containerHeight, handleOpenComments, handleOpenLikers, handleOpenProfile, handleUseSound, handleDuet, handleStitch, handleHidePost, showLiveRing, overlayOpen]);

  const keyExtractor = useCallback((item) => String(item.id), []);

  if (loading) {
    return (
      <View style={styles.loadingContainer}>
        <ActivityIndicator size="large" color="#fff" />
      </View>
    );
  }

  if (reels.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <EmptyReels colors={colors} isDark={isDark} t={t} />
      </View>
    );
  }

  return (
    <View style={styles.reelsRoot} onLayout={onLayout}>
      {/* Following / For You tabs overlaying the top */}
      <View style={[styles.reelTabBar, { top: Math.max(outerInsets.top, Platform.OS === 'android' ? 12 : 44) + 8 }]} pointerEvents="box-none">
        <TouchableOpacity
          onPress={() => handleTabChange('following')}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[
            styles.reelTabText,
            reelTab === 'following' && styles.reelTabTextActive,
          ]}>
            {t('feed.followingReels') || 'Following'}
          </Text>
          {reelTab === 'following' && <View style={styles.reelTabIndicator} />}
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => handleTabChange('forYou')}
          activeOpacity={0.7}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text style={[
            styles.reelTabText,
            reelTab === 'forYou' && styles.reelTabTextActive,
          ]}>
            {t('feed.forYou') || 'For You'}
          </Text>
          {reelTab === 'forYou' && <View style={styles.reelTabIndicator} />}
        </TouchableOpacity>
      </View>

      <FlatList
        ref={listRef}
        data={activeReels}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        pagingEnabled
        showsVerticalScrollIndicator={false}
        snapToInterval={containerHeight}
        snapToAlignment="start"
        decelerationRate="fast"
        onViewableItemsChanged={onViewableRef.current}
        viewabilityConfig={viewConfigRef.current}
        getItemLayout={(data, index) => ({
          length: containerHeight,
          offset: containerHeight * index,
          index,
        })}
        initialNumToRender={2}
        maxToRenderPerBatch={3}
        windowSize={3}
        removeClippedSubviews={Platform.OS !== 'web'}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        ListEmptyComponent={
          // Surface an empty state for *every* tab — silently rendering
          // null on Discover/For You looked like a hung load. Copy varies
          // by tab; icon adapts to dark mode contrast (was hardcoded #555).
          <View style={[styles.loadingContainer, { height: containerHeight }]}>
            <View style={styles.emptyIcon}>
              <IconPlay size={48} color="rgba(255,255,255,0.55)" />
            </View>
            <Text style={styles.emptyTitle}>
              {reelTab === 'following'
                ? (t('feed.noFollowingReels') || 'No reels from people you follow')
                : (t('feed.noReels') || 'Sem reels por aqui')}
            </Text>
            <Text style={styles.emptySubtext}>
              {reelTab === 'following'
                ? (t('feed.noFollowingReelsHint') || 'Follow people to see their reels here')
                : (t('feed.noReelsHint') || 'Volte mais tarde — novos reels chegam o tempo todo.')}
            </Text>
          </View>
        }
      />

      {/* Comments bottom sheet */}
      <CommentsSheet
        visible={!!commentsReel}
        post={commentsReel}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCommentsReel(null)}
      />

      {/* Likers bottom sheet */}
      <LikersSheet
        visible={!!likersReel}
        post={likersReel}
        colors={colors}
        isDark={isDark}
        t={t}
        onClose={() => setLikersReel(null)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  // ── Root ──
  reelsRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reelContainer: {
    backgroundColor: '#000',
    position: 'relative',
    overflow: 'hidden',
  },

  // ── Gradient overlays ──
  topGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 120,
    background: isWeb ? 'linear-gradient(to bottom, rgba(0,0,0,0.4) 0%, transparent 100%)' : undefined,
    backgroundColor: isWeb ? undefined : 'transparent',
    zIndex: 1,
  },
  bottomGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 300,
    background: isWeb ? 'linear-gradient(to top, rgba(0,0,0,0.6) 0%, transparent 100%)' : undefined,
    backgroundColor: isWeb ? undefined : 'transparent',
    zIndex: 1,
  },

  // ── Top bar ──
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'ios' ? 54 : 16,
    paddingBottom: 12,
    zIndex: 10,
  },
  topTitle: {
    color: '#fff',
    fontSize: 22,
    fontWeight: '700',
    letterSpacing: 0.3,
    ...TEXT_SHADOW,
  },

  // ── Pause flash ──
  pauseFlashOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 5,
  },
  pauseFlashCircle: {
    width: 64,
    height: 64,
    borderRadius: 32,
    backgroundColor: 'rgba(0,0,0,0.35)',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // ── Heart animation ──
  heartAnimOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 20,
  },

  // ── Right sidebar ──
  rightSidebar: {
    position: 'absolute',
    right: 8,
    bottom: 90,
    alignItems: 'center',
    zIndex: 10,
    gap: 16,
  },
  profileAvatarBtn: {
    alignItems: 'center',
    marginBottom: 4,
  },
  profileAvatarRing: {
    borderWidth: 2,
    borderColor: '#fff',
    borderRadius: 20,
    padding: 1,
    overflow: 'hidden',
  },
  profileFollowBadge: {
    position: 'absolute',
    bottom: -6,
    backgroundColor: '#FF2D55',
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#000',
  },
  profileFollowPlus: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 15,
    marginTop: -1,
  },
  sidebarBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 48,
    minHeight: 48,
    gap: 4,
  },
  // Bumped from 12/600 → 11/700 with stronger shadow so the count reads as
  // a label glued to the icon (TikTok pattern) instead of floating text.
  sidebarCount: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.2,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },

  // ── Spinning album art ──
  albumArt: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 8,
    borderColor: '#333',
    backgroundColor: '#1a1a1a',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 4,
    overflow: 'hidden',
  },
  albumArtInner: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: '#222',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  albumArtCenter: {
    width: 18,
    height: 18,
    borderRadius: 9,
    overflow: 'hidden',
  },

  // ── Bottom info ──
  // Reserve 76px on the right so the caption/marquee never overlaps the
  // 48-wide sidebar rail (right:8 + 48 + 20 breathing room).
  bottomInfo: {
    position: 'absolute',
    bottom: 24,
    left: 14,
    right: 76,
    zIndex: 10,
    gap: 8,
  },
  username: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '700',
    ...TEXT_SHADOW,
  },
  caption: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 19,
    ...TEXT_SHADOW,
  },
  moreText: {
    color: '#a78bfa',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 2,
  },

  // ── Music row ──
  musicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 4,
  },
  marqueeContainer: {
    flex: 1,
    overflow: 'hidden',
    height: 18,
  },
  marqueeTrack: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  marqueeText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '400',
    ...TEXT_SHADOW,
  },

  // ── Subtitle overlay (TikTok-style auto-caption) ──
  subtitleOverlay: {
    position: 'absolute',
    bottom: 180,
    left: 0,
    right: 0,
    alignItems: 'center',
    paddingHorizontal: 24,
    zIndex: 12,
  },
  subtitleBg: {
    maxWidth: '78%',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  subtitleText: {
    color: '#fff',
    fontSize: 16,
    lineHeight: 21,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 0.1,
    textShadowColor: 'rgba(0,0,0,0.85)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },

  // ── Progress bar / Scrubber ──
  // 3px visible track with a 22px tall hit area so the user can grab + drag.
  // While scrubbing the visible bar bumps to 5px to confirm the interaction.
  scrubberHit: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 22,
    justifyContent: 'flex-end',
    zIndex: 15,
  },
  progressBar: {
    height: 3,
    backgroundColor: 'rgba(255,255,255,0.25)',
  },
  scrubberThumb: {
    position: 'absolute',
    top: -5,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: '#fff',
    marginLeft: -6.5,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 1 },
    shadowOpacity: 0.5,
    shadowRadius: 3,
    ...(isWeb ? {} : { elevation: 4 }),
  },
  // Brand purple → pink gradient with a soft halo on web. Native uses a
  // solid brand purple (RN Animated doesn't render CSS gradients cheaply
  // and react-native-svg <LinearGradient> on a 3px bar isn't worth it).
  progressFill: {
    height: '100%',
    backgroundColor: '#7C3AED',
    borderRadius: 1.5,
    ...(isWeb ? {
      backgroundImage: 'linear-gradient(90deg, #7C3AED 0%, #EC4899 100%)',
      boxShadow: '0 0 8px rgba(236,72,153,0.55), 0 0 14px rgba(124,58,237,0.4)',
    } : {}),
  },

  // ── Particle burst (anchored to the like button on the right rail
  // so the hearts irradiate FROM the icon the user just tapped). ──
  particleBurstWrap: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'flex-end',
    justifyContent: 'flex-end',
    paddingBottom: 100,
    paddingRight: 32,
    zIndex: 19,
  },

  // ── Empty state ──
  emptyContainer: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  emptyIcon: {
    width: 80,
    height: 80,
    borderRadius: 40,
    borderWidth: 2,
    borderColor: '#333',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '700',
    color: '#fff',
  },
  emptySubtext: {
    color: '#666',
    fontSize: 14,
  },

  // ── Comments sheet (dark themed) ──
  sheetBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'flex-end',
  },
  sheetContainer: {
    backgroundColor: '#1c1c1e',
    borderTopLeftRadius: 14,
    borderTopRightRadius: 14,
    maxHeight: SCREEN_HEIGHT * 0.6,
    minHeight: 300,
  },
  sheetHandle: {
    alignItems: 'center',
    paddingVertical: 16,
  },
  // Why: handle bar grew (36×4 → 44×5) so the drag affordance reads more
  // substantial — TikTok/Instagram both use ~44px. Header title bumped from
  // 15 → 16.5 with negative letter-spacing for the polished sheet look.
  sheetHandleBar: {
    width: 44,
    height: 5,
    borderRadius: 3,
    backgroundColor: 'rgba(255,255,255,0.35)',
  },
  sheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(255,255,255,0.1)',
  },
  sheetTitle: {
    fontSize: 16.5,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.3,
  },
  sheetLoading: {
    padding: 40,
    alignItems: 'center',
  },
  sheetEmpty: {
    padding: 40,
    alignItems: 'center',
  },
  sheetEmptyText: {
    fontSize: 14,
    color: '#888',
  },
  sheetList: {
    maxHeight: SCREEN_HEIGHT * 0.35,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  commentRow: {
    flexDirection: 'row',
    gap: 10,
    marginBottom: 16,
  },
  commentContent: {
    flex: 1,
  },
  commentAuthor: {
    fontSize: 13.5,
    fontWeight: '700',
    color: '#fff',
    letterSpacing: -0.15,
    lineHeight: 19,
  },
  commentText: {
    fontWeight: '400',
    color: 'rgba(255,255,255,0.88)',
    letterSpacing: -0.05,
  },
  commentTime: {
    fontSize: 11.5,
    marginTop: 4,
    color: 'rgba(255,255,255,0.55)',
    fontWeight: '500',
    letterSpacing: 0.1,
  },
  sheetInput: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: 'rgba(255,255,255,0.1)',
    backgroundColor: '#1c1c1e',
  },
  // Why: input pill enlarged (radius 20→22, padX 14→16) so it reads more like
  // a chat input than a search box. Web transition smooths the focus tint.
  sheetTextInput: {
    flex: 1,
    fontSize: 14,
    paddingHorizontal: 16,
    paddingVertical: 9,
    borderRadius: 22,
    color: '#fff',
    backgroundColor: 'rgba(255,255,255,0.10)',
    ...(Platform.OS === 'web' ? { outlineStyle: 'none', transition: 'background-color 180ms ease' } : {}),
  },

  // ── Reel tab bar (Following / For You) ──
  reelTabBar: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 54 : 16,
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 28,
    zIndex: 20,
    paddingVertical: 8,
  },
  reelTabText: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  reelTabTextActive: {
    color: '#fff',
    fontWeight: '700',
  },
  reelTabIndicator: {
    width: 24,
    height: 3,
    borderRadius: 1.5,
    backgroundColor: '#fff',
    alignSelf: 'center',
    marginTop: 4,
  },

  // ── 2× Boost toast (long-press) ──
  // Floats below the top bar so it doesn't fight the tab row. Brand purple
  // pill with a single "2×" label — minimal, TikTok-style.
  boostToast: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 100 : 70,
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 25,
  },
  boostToastBg: {
    backgroundColor: 'rgba(124,58,237,0.92)',
    paddingHorizontal: 14,
    paddingVertical: 6,
    borderRadius: 20,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.4,
    shadowRadius: 6,
    ...(Platform.OS === 'web' ? {} : { elevation: 5 }),
  },
  boostToastText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '800',
    letterSpacing: 1,
  },
});
