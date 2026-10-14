import { androidTopInset } from '../utils/systemInsets'; // [2026-10-07 android-native] edge-to-edge
import React, { useState, useEffect, useLayoutEffect, useCallback, useRef, memo, useMemo } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, FlatList, Dimensions,
  Animated, Platform, Share, TextInput, Modal, KeyboardAvoidingView,
  ActivityIndicator, Pressable, ScrollView, Image, Easing, PanResponder,
  AppState, ToastAndroid, Linking,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AvatarCircle from './AvatarCircle';
// [2026-10-08 apps-native] feedback tátil nativo nos botões do rail + haptic do tema
import PressableScale from './PressableScale';
import { haptic } from '../constants/theme';
import FeedComments from './FeedComments';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// [#1231 2026-05-20] useIsFocused para pausar reel quando user troca de aba
// (Conversas/Apps/etc.). Bug: vídeo continuava tocando áudio no background
// porque ReelsViewer fica montado dentro do /chat screen — só isActive (per
// FlatList row) era checado.
import { useIsFocused } from '@react-navigation/native';
import {
  IconHeart, IconHeartOutline, IconMessageCircle, IconShare,
  IconBookmark, IconBookmarkFilled, IconMusic, IconPlay, IconPause,
  IconX, IconSend, IconChevronDown, IconCamera, IconPlus, IconVolume2, IconVolumeX, IconEye,
  IconRepeat, IconLink, IconCopy, IconMoreHorizontal, IconDiamond, IconSliders, IconGiftBox,
} from './Icons';
// Reels P1 monetization shares the same diamond catalog + wallet ledger
// as Live gifts. The gift panel is components/gifts/GiftSheet (context 'post' →
// diamond_gift_send), the same panel used in lives and the 1:1 chat.
import * as api from '../services/api';
// [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag
import { DIAMONDS_ENABLED } from '../constants/featureFlags';
import { giftLabel, giftMeta } from './live/liveEngageConfig';
import GiftSheet from './gifts/GiftSheet';
import LiveGiftGlyph from './live/LiveGiftGlyph';
import { cachedVideoSource } from '../services/videoCacheSource'; // [2026-10-10 native-audit] native video disk cache
// [reels-v1 2026-10-13] sinais de comportamento (só dentro do Reels) + cold start de interesses
import { trackReelEvent, trackReelView, flushReelSignals } from '../services/reelsSignals';
import ReelsInterestPicker from './ReelsInterestPicker';
import Svg, { Defs, LinearGradient as SvgLinearGradient, Stop, Rect as SvgRect } from 'react-native-svg';
// expo-shorts powers the native player + pool. Imported lazily so a missing
// native binary (dev only) doesn't break the import chain — fallback paths
// degrade gracefully when these are null.
let _expoShorts = null;
try { _expoShorts = require('expo-shorts'); } catch {}
// [2026-10-13 reels-android] Android: expo-shorts DESLIGADO (Reels "não abria" — tela preta).
// Causa (nativo, ExoPoolManager.kt): prefetch/releasePool são AsyncFunction → rodam na
// HandlerThread "expo.modules.AsyncFunctionQueue" (tem Looper). O prefetch do próximo reel
// costuma chegar ANTES de a view nativa montar → ensureSlot cria os 3 ExoPlayer nessa thread
// (applicationLooper = fila de módulos) → na thread principal PlayerView.setPlayer() exige
// applicationLooper == main e lança → attachPlayerForUrl cai no placeholder preto ("Shorts
// player") e o pool fica envenenado; ao voltar pra aba (releasePool) o ciclo se repete. O
// onError da view não era ouvido no JS. Android usa expo-video (ExoPlayer correto, TextureView).
// Religar só p/ teste: globalThis.__chatyy_reels_shorts_android = true (antes de abrir o Reels).
const _shortsAllowedHere = () => {
  if (Platform.OS !== 'android') return true;
  try { return globalThis.__chatyy_reels_shorts_android === true; } catch { return false; }
};
if (!_shortsAllowedHere()) _expoShorts = null;
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
// [2026-10-11 social-qa] Largura do reel = largura MEDIDA do container (não a
// janela): no desktop web a sidebar (72px) empurrava o trilho de ações
// (curtir/comentar/compartilhar) pra fora da tela. Em tela larga (desktop) o
// reel vira coluna 9:16 centralizada, como Instagram/TikTok web.
function _reelItemWidth(containerWidth, height) {
  const w = containerWidth || SCREEN_WIDTH;
  if (Platform.OS === 'web' && height > 0 && w > height * 0.8) return Math.max(320, Math.round(height * 9 / 16));
  return w;
}

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
    if (!_shortsAllowedHere()) return null; // [2026-10-13 reels-android] ver topo do arquivo
    try {
      // [fix 2026-07-05] The native module/view registers as "ExpoShorts" (see
      // ShortsPlayer.tsx requireNativeViewManager/requireNativeModule('ExpoShorts')),
      // NOT the old "ExpoShortsPlayer" key, and SDK-55 Expo modules aren't in the
      // legacy NativeModules registry — so the old probe was ALWAYS false and the
      // native reels engine (AVPlayer/ExoPlayer pool + prefetch) was silently dead,
      // every build falling back to expo-video. Probe the real names.
      const { UIManager } = require('react-native');
      let hasViewManager = false;
      try {
        hasViewManager = typeof UIManager?.getViewManagerConfig === 'function'
          ? !!UIManager.getViewManagerConfig('ExpoShorts') : false;
      } catch {}
      let hasNativeModule = false;
      try { hasNativeModule = !!require('expo-modules-core').requireNativeModule('ExpoShorts'); } catch {}
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
function VideoFallbackPlayer({ videoUrl, isActive, paused, muted, playbackRate = 1, onTimeUpdate, onReady, onPlaybackReady, onError }) {
  const VideoView = _expoVideo?.VideoView;
  const useVideoPlayer = _expoVideo?.useVideoPlayer;
  const player = useVideoPlayer && useVideoPlayer(cachedVideoSource(videoUrl || ''), (p) => {
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

  // [2026-10-13 reels-android] Pronto/erro do player → NativeReelVideo (estado de erro +
  // "Tentar de novo" + evento [REELS]). Antes um erro de decodificação/rede = tela preta muda.
  const onPlaybackReadyRef = useRef(onPlaybackReady);
  const onErrorRef = useRef(onError);
  onPlaybackReadyRef.current = onPlaybackReady;
  onErrorRef.current = onError;
  useEffect(() => {
    if (!player || typeof player.addListener !== 'function') return undefined;
    let sub = null;
    try {
      if (player.status === 'readyToPlay') onPlaybackReadyRef.current?.();
      sub = player.addListener('statusChange', (ev) => {
        try {
          const st = ev?.status;
          if (st === 'readyToPlay') onPlaybackReadyRef.current?.();
          else if (st === 'error') onErrorRef.current?.(ev?.error?.message || 'status_error');
        } catch {}
      });
    } catch {}
    return () => { try { sub?.remove?.(); } catch {} };
  }, [player]);

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
      // [2026-10-13 reels-android] SurfaceView dentro de FlatList paginada (removeClippedSubviews)
      // pode ficar preta/fora de posição no Android; TextureView acompanha o scroll.
      {...(Platform.OS === 'android' ? { surfaceType: 'textureView' } : null)}
    />
  );
}

// [2026-10-13 reels-android] Diagnóstico leve: código de erro sem URL/e-mail (sem dado pessoal).
function _reelErrCode(msg) {
  try {
    return String(msg || 'unknown')
      .replace(/https?:\/\/\S+/gi, '<url>')
      .replace(/[\w.+-]+@[\w.-]+/g, '<email>')
      .slice(0, 80);
  } catch { return 'unknown'; }
}
function _reportReels(event, data) {
  try { require('../services/crashReporter').reportTaggedEvent('REELS', event, data); } catch {}
}
const REEL_READY_TIMEOUT_MS = 15000;

const NativeReelVideo = memo(function NativeReelVideo({ videoUrl, poster, isActive, paused, playbackRate = 1, isPreload = false, muted = true, onTimeUpdate, onReady, hardGateClosed = false, t }) {
  const shortsRef = useRef(null);
  // [2026-10-13 reels-android] Erro/timeout do player → aviso + "Tentar de novo" (remonta o
  // player via key) em vez de tela preta muda, e 1 evento [REELS] no log de crashes.
  const [failed, setFailed] = useState(null);
  const [attempt, setAttempt] = useState(0);
  const readyRef = useRef(false);
  const engine = ShortsPlayerLazy ? 'shorts' : (_expoVideo ? 'expo-video' : 'none');
  useEffect(() => { readyRef.current = false; setFailed(null); }, [videoUrl]);
  const handlePlayerReady = useCallback(() => { readyRef.current = true; }, []);
  const handlePlayerError = useCallback((msg) => {
    const code = _reelErrCode(msg);
    setFailed(code);
    _reportReels('player_error', { engine, state: isActive ? 'active' : 'preload', attempt, code });
  }, [engine, isActive, attempt]);
  const shouldPlayNow = !!isActive && !paused && !isPreload && !hardGateClosed;
  useEffect(() => {
    if (!shouldPlayNow || failed || readyRef.current || !videoUrl) return undefined;
    const id = setTimeout(() => {
      if (readyRef.current) return;
      setFailed('timeout');
      _reportReels('player_timeout', { engine, state: 'active', attempt, code: 'timeout' });
    }, REEL_READY_TIMEOUT_MS);
    return () => clearTimeout(id);
  }, [shouldPlayNow, failed, videoUrl, attempt, engine]);
  const retry = useCallback(() => { readyRef.current = false; setFailed(null); setAttempt((a) => a + 1); }, []);
  const errorOverlay = (failed && isActive) ? (
    <View style={[StyleSheet.absoluteFill, styles.reelErrorWrap]} pointerEvents="box-none">
      <Text style={styles.reelErrorText}>{t?.('reels.videoError') || 'Não foi possível reproduzir este vídeo'}</Text>
      <Pressable onPress={retry} hitSlop={10} accessibilityRole="button" style={({ pressed }) => [styles.reelErrorBtn, { opacity: pressed ? 0.7 : 1 }]}>
        <Text style={styles.reelErrorBtnText}>{t?.('reels.videoRetry') || 'Tentar de novo'}</Text>
      </Pressable>
    </View>
  ) : null;

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
    // [2026-10-13 reels-android] playhead andando = tocando (iOS não reemite ready p/ item pré-carregado)
    if (ms > 0) readyRef.current = true;
    if (onTimeUpdate) onTimeUpdate(ms, durMs);
  }, [onTimeUpdate]);

  // [WAVE 43B 2026-05-20] hardGateClosed = user trocou de aba/route. Mesmo
  // que `paused` já esteja true via effectivePaused, forçamos muted=true
  // adicionalmente como belt-and-suspenders pra silenciar IMEDIATAMENTE —
  // o pause vai pelo prop diff mas se a session de áudio não desativou
  // ainda, o AVPlayer pode emitir frames residuais. muted=true mata áudio
  // sem ambiguidade. Quando o gate reabre, voltamos pro estado original.
  const effectiveMuted = hardGateClosed ? true : !!muted;

  // Native-only — if for any reason the module didn't link (e.g. iOS 504/505
  // shipped before expo-shorts), fall back to expo-video's VideoView so the
  // Reels feed still plays. Only surface a black placeholder if expo-video
  // also isn't available (web or extremely old binaries).
  if (!ShortsPlayerLazy) {
    if (_expoVideo) {
      return (
        <>
          <VideoFallbackPlayer
            key={`a${attempt}`}
            videoUrl={videoUrl}
            isActive={isActive && !isPreload && !hardGateClosed}
            paused={paused || hardGateClosed}
            muted={effectiveMuted}
            playbackRate={playbackRate}
            onTimeUpdate={handleNativeTime}
            onReady={onReady}
            onPlaybackReady={handlePlayerReady}
            onError={handlePlayerError}
          />
          {errorOverlay}
        </>
      );
    }
    return <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />;
  }

  // hardGateClosed force-mutes AND forces playWhenInFocus=false regardless
  // of isActive/paused so a stale parent re-render can't re-arm playback.
  const shouldPlay = !!isActive && !paused && !isPreload && !hardGateClosed;
  return (
    <View style={StyleSheet.absoluteFill}>
      <ShortsPlayerLazy
        key={`a${attempt}`}
        ref={shortsRef}
        videoUrl={videoUrl}
        playWhenInFocus={shouldPlay}
        muted={effectiveMuted}
        playbackRate={Number(playbackRate) || 1}
        onTime={handleNativeTime}
        onPlaybackReady={handlePlayerReady}
        onError={handlePlayerError}
      />
      {errorOverlay}
    </View>
  );
});

const ACCENT = '#111111';
const DOUBLE_TAP_DELAY = 300;
const BASE_URL = 'https://chatyy.com.br';
const isWeb = Platform.OS === 'web';
// [2026-10-13 reels-visual] Linha do cabeçalho (abas/criar/interesses): logo abaixo da
// status bar — o vídeo agora começa atrás dela (chat.js tira o paddingTop na aba Reels).
const REEL_HEADER_H = 44;
function reelHeaderTop(insets) {
  if (isWeb) return 10;
  return Math.max(insets?.top || 0, Platform.OS === 'android' ? 24 : 44) + 2;
}
const useNative = Platform.OS !== 'web';

// [2026-10-13 visual] Native scrim. topGradient/bottomGradient only had a CSS
// `background` (web); on iOS/Android they were transparent, so the white
// caption/rail sat on bright video with text-shadow alone. SVG gradient keeps
// it dependency-free (react-native-svg is already in the app).
const ReelScrim = memo(function ReelScrim({ edge }) {
  if (isWeb) return null;
  const id = edge === 'top' ? 'reelScrimTop' : 'reelScrimBottom';
  const top = edge === 'top';
  return (
    <Svg width="100%" height="100%" style={StyleSheet.absoluteFill} preserveAspectRatio="none">
      <Defs>
        <SvgLinearGradient id={id} x1="0" y1={top ? '0' : '1'} x2="0" y2={top ? '1' : '0'}>
          <Stop offset="0" stopColor="#000" stopOpacity={top ? 0.55 : 0.7} />
          <Stop offset="1" stopColor="#000" stopOpacity={0} />
        </SvgLinearGradient>
      </Defs>
      <SvgRect x="0" y="0" width="100%" height="100%" fill={`url(#${id})`} />
    </Svg>
  );
});

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

// Reels P2 — Duet / Stitch / "Usar este som" call backend actions that don't
// exist yet (the post-create recorder has no duet/stitch mode and there's no
// reels-by-sound feed wired end-to-end). Hide those affordances behind this
// flag until the backend lands so users don't tap into a dead end. "Não
// tenho interesse" stays visible and persists the hide locally + toasts.
const REELS_BACKEND_ACTIONS_READY = false;

// A feed post counts as a "reel" when it's a video — either tagged
// media_type=video, or its first media URL has a video extension. Hoisted to
// module scope so loadReels() (page 1) and loadMore() (pages 2+) share the
// exact same filter, keeping pagination dedup consistent.
function isReelVideo(p) {
  if (!p) return false;
  if (p.media_type === 'video') return true;
  const urls = parseMediaUrls(p.media_urls);
  return urls.some(u => typeof u === 'string' && (u.endsWith('.mp4') || u.endsWith('.mov') || u.endsWith('.webm')));
}

// [reels-v1 2026-10-13] Motivo explicável do ranking (reel.rec vindo de reels_rec_feed).
function reelWhyText(reel, t) {
  const why = reel?.rec?.why;
  if (!why) return '';
  const cat = reel?.rec?.cat ? ((t && t(`reels.cat.${reel.rec.cat}`)) || reel.rec.cat) : '';
  const name = reel?.author_name || '';
  const map = {
    interest: [t?.('reels.why.interest') || 'Porque você costuma assistir {cat}', true],
    chosen: [t?.('reels.why.chosen') || 'Porque você escolheu {cat} nos seus interesses', true],
    following: [t?.('reels.why.following') || 'Porque você segue {name}', false],
    popular: [t?.('reels.why.popular') || 'Está em alta no Chatyy', false],
    explore: [t?.('reels.why.explore') || 'Para você descobrir algo novo', false],
    new: [t?.('reels.why.new') || 'Publicado recentemente', false],
    rewatch: [t?.('reels.why.rewatch') || 'Você já viu este reel', false],
  };
  const m = map[why];
  if (!m) return '';
  if (m[1] && !cat) return t?.('reels.why.popular') || 'Está em alta no Chatyy';
  return String(m[0]).replace('{cat}', cat).replace('{name}', name);
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
              /* [PERF] A viral reel can have thousands of likers. A ScrollView
                 + .map mounted every row (each an AvatarCircle) at once — a
                 stutter on open and heavy memory. Virtualize with FlatList. */
              <FlatList
                style={styles.sheetList}
                data={likers}
                showsVerticalScrollIndicator={false}
                keyExtractor={(liker, idx) => liker.email || String(idx)}
                initialNumToRender={14}
                windowSize={10}
                removeClippedSubviews={Platform.OS !== 'web'}
                renderItem={({ item: liker }) => (
                  <View style={styles.commentRow}>
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
                )}
                ListFooterComponent={<View style={{ height: 20 }} />}
              />
            )}
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ── Comments Bottom Sheet ──
// [2026-05-25] Replaced by the full-featured <FeedComments> component
// (pagination, threading, voice/sticker/video replies, WS live comments,
// onCommentCountChange) wired into ReelsViewer below. The old inline
// CommentsSheet never bumped reel.comment_count and lacked all of those, so
// it was removed. Shared sheet styles (sheetBackdrop/commentRow/…) stay —
// LikersSheet + the Share/Speed sheets still use them.

// ── Spinning Album Art ──
// [2026-10-11 reels-perf] react-native-web runs JS-driver Animated by
// RE-RENDERING the Animated component every frame (useAnimatedProps →
// scheduleUpdate), so each looping decoration below cost ~60 React commits/s
// on web. On web they now use CSS keyframes (compositor, zero JS); native
// keeps the Animated (native-driver) loops unchanged.
const WEB_SPIN_STYLE = isWeb ? {
  animationKeyframes: [{ from: { transform: 'rotate(0deg)' }, to: { transform: 'rotate(360deg)' } }],
  animationDuration: '3000ms', animationTimingFunction: 'linear', animationIterationCount: 'infinite',
} : null;

const SpinningDisc = memo(function SpinningDisc({ authorEmail, authorName }) {
  if (WEB_SPIN_STYLE) {
    return (
      <View style={[styles.albumArt, WEB_SPIN_STYLE]}>
        <View style={styles.albumArtInner}>
          <View style={styles.albumArtCenter}>
            <AvatarCircle email={authorEmail} name={authorName} size={18} />
          </View>
        </View>
      </View>
    );
  }
  return <SpinningDiscNative authorEmail={authorEmail} authorName={authorName} />;
});
const SpinningDiscNative = memo(function SpinningDiscNative({ authorEmail, authorName }) {
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
const LiveBadgeRing = memo(function LiveBadgeRing({ size = 44, children, t }) {
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
          {t?.('live.aoVivo') || 'AO VIVO'}
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
const WEB_EQ_CFGS = [
  { dur: [280, 400], min: 0.25, max: 1, rest: 0.4 },
  { dur: [330, 450], min: 0.40, max: 0.95, rest: 0.85 },
  { dur: [290, 410], min: 0.30, max: 0.90, rest: 0.55 },
];
const MusicEqualizer = memo(function MusicEqualizer({ active = true }) {
  if (isWeb) {
    // CSS keyframes on transform:scaleY (bar height 3..12 ≈ scale 0.25..1).
    return (
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 1.5, height: 12, marginRight: 2 }}>
        {WEB_EQ_CFGS.map((c, i) => {
          const total = c.dur[0] + c.dur[1];
          const upPct = Math.round((c.dur[0] / total) * 100);
          return (
            <View
              key={i}
              style={{
                width: 2.5, height: 12, borderRadius: 1.25, backgroundColor: '#fff', transformOrigin: 'bottom',
                ...(active ? {
                  animationKeyframes: [{ '0%': { transform: `scaleY(${c.min})` }, [`${upPct}%`]: { transform: `scaleY(${c.max})` }, '100%': { transform: `scaleY(${c.min})` } }],
                  animationDuration: `${total}ms`, animationTimingFunction: 'ease-in-out', animationIterationCount: 'infinite',
                } : { transform: `scaleY(${c.rest})` }),
              }}
            />
          );
        })}
      </View>
    );
  }
  return <MusicEqualizerNative active={active} />;
});
const MusicEqualizerNative = memo(function MusicEqualizerNative({ active = true }) {
  const bars = useRef([
    new Animated.Value(0.4),
    new Animated.Value(0.85),
    new Animated.Value(0.55),
  ]).current;
  useEffect(() => {
    // [PERF] The bars animate `height` (a layout prop), so this loop runs on
    // the JS thread with useNativeDriver:false. Only run it for the ACTIVE
    // reel — otherwise the 2 off-screen pre-mounted ReelItems (windowSize) each
    // spin their own JS loop forever, stealing frames from the swipe/scroll and
    // the playing video. When inactive, rest the bars at their static values.
    if (!active) {
      bars.forEach((v, i) => v.setValue([0.4, 0.85, 0.55][i]));
      return;
    }
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
  }, [active]);
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

// ── Desktop web frame ──
// [2026-10-13 reels-visual] Web largo: coluna 9:16 centralizada sobre o pôster desfocado
// (nível Instagram/TikTok web) e o trilho de ações AO LADO do vídeo (reelContainerDesktop).
function ReelDesktopFrame({ enabled, width, height, poster, children }) {
  if (!enabled) return children;
  return (
    <View style={{ width, height, backgroundColor: '#000', overflow: 'hidden', alignItems: 'center' }}>
      {poster ? (
        <Image
          source={{ uri: poster }}
          resizeMode="cover"
          style={[StyleSheet.absoluteFill, { opacity: 0.32, filter: 'blur(40px) saturate(1.2)', transform: [{ scale: 1.15 }] }]}
          accessibilityIgnoresInvertColors
        />
      ) : null}
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.35)' }]} />
      {children}
    </View>
  );
}

// ── Music Marquee (scrolling text) ──
// [2026-10-13 reels-visual] Antes rolava SEMPRE com o texto duplicado ("… - Áudio original
// azharkhandeena - Áudio ori"). Agora mede: cabe → uma linha parada; não cabe → rola
// (2 cópias só nesse caso, com pausa entre voltas).
const MARQUEE_GAP = 36;
const MusicMarquee = memo(function MusicMarquee({ text: musicText, active = true }) {
  const [boxW, setBoxW] = useState(0);
  const [textW, setTextW] = useState(0);
  const overflow = boxW > 0 && textW > boxW + 1;
  const scrollX = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    scrollX.setValue(0);
    if (isWeb || !overflow || !active) return undefined;
    const dist = textW + MARQUEE_GAP;
    const anim = Animated.loop(
      Animated.sequence([
        Animated.delay(1200),
        Animated.timing(scrollX, { toValue: -dist, duration: Math.max(4000, dist * 28), easing: Easing.linear, useNativeDriver: true }),
        Animated.timing(scrollX, { toValue: 0, duration: 0, useNativeDriver: true }),
      ])
    );
    anim.start();
    return () => anim.stop();
  }, [overflow, active, textW, musicText, scrollX]);

  const webAnim = (isWeb && overflow && active) ? {
    animationKeyframes: [{ from: { transform: 'translateX(0px)' }, to: { transform: `translateX(-${Math.round(textW + MARQUEE_GAP)}px)` } }],
    animationDuration: `${Math.max(4000, Math.round((textW + MARQUEE_GAP) * 28))}ms`,
    animationTimingFunction: 'linear', animationIterationCount: 'infinite', animationDelay: '1200ms',
  } : null;

  return (
    <View style={styles.marqueeContainer} onLayout={(e) => setBoxW(Math.round(e.nativeEvent.layout.width))}>
      {/* medidor invisível: largura natural do texto */}
      <View pointerEvents="none" style={styles.marqueeMeasure}>
        <Text style={styles.marqueeText} onLayout={(e) => setTextW(Math.ceil(e.nativeEvent.layout.width))}>{musicText}</Text>
      </View>
      {overflow ? (
        isWeb ? (
          <View style={[styles.marqueeTrack, { width: textW * 2 + MARQUEE_GAP + 8 }, webAnim]}>
            <Text style={[styles.marqueeText, { marginRight: MARQUEE_GAP }]} numberOfLines={1}>{musicText}</Text>
            <Text style={styles.marqueeText} numberOfLines={1}>{musicText}</Text>
          </View>
        ) : (
          <Animated.View style={[styles.marqueeTrack, { width: textW * 2 + MARQUEE_GAP + 8, transform: [{ translateX: scrollX }] }]}>
            <Text style={[styles.marqueeText, { marginRight: MARQUEE_GAP }]} numberOfLines={1}>{musicText}</Text>
            <Text style={styles.marqueeText} numberOfLines={1}>{musicText}</Text>
          </Animated.View>
        )
      ) : (
        <Text style={styles.marqueeText} numberOfLines={1}>{musicText}</Text>
      )}
    </View>
  );
});

// [2026-10-13 diamantes] TipSheetWrapper removido — presente em reel usa
// components/gifts/GiftSheet.js (context 'post', mesmo painel da live).

// ── Floating Diamond (tip animation) ──
// When the user sends a tip (or someone else does via WS), we mount this
// component with a unique key. It rises from the bottom-right of the reel,
// fading out after ~1.4s. Multiple simultaneous tips stack visually.
const FloatingDiamond = memo(function FloatingDiamond({ label, icon }) {
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
        backgroundColor: 'rgba(17, 17, 17,0.85)',
        opacity,
        transform: [{ translateY }],
      }}
    >
      {icon ? <LiveGiftGlyph icon={icon} size={28} /> : <IconDiamond size={16} />}
      <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700', maxWidth: 200 }} numberOfLines={1}>
        {label || ''}
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
function ShareSheet({ visible, reel, t, onClose, onRepost, onCopyLink, onExternal, onSendChat }) {
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
            {onSendChat ? <Row icon={IconSend} label={t?.('reels.sendInChat') || 'Enviar em uma conversa'} onPress={onSendChat} /> : null}
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
// Mute preference — lifted to ReelsViewer (not per-ReelItem) so it persists
// across swipes and sessions. Bug: mute reset on every swipe because each
// ReelItem owned its own muted state.
const REELS_MUTED_KEY = '@chatyy:reels_muted_v1';
// Locally-persisted "não tenho interesse" hides — kept client-side so the
// reel stays gone across sessions even if the backend hide signal isn't live.
const REELS_HIDDEN_KEY = '@chatyy:reels_hidden_ids_v1';

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
                      backgroundColor: active ? 'rgba(255,255,255,0.10)' : 'transparent',
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={`${s}x`}
                  >
                    <Text style={{ color: '#fff', fontSize: 16, fontWeight: active ? '800' : '500' }}>
                      {s}×{s === 1 ? `  (${t?.('common.default') || 'Padrão'})` : ''}
                    </Text>
                    {active ? (
                      <View style={{ width: 12, height: 12, borderRadius: 6, backgroundColor: '#ffffff' }} />
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

// ── Playback clock (per ReelItem) ──
// [2026-10-11 reels-perf] Tiny pub/sub that carries playback position
// WITHOUT React state. Before, a 100ms setInterval did setProgress/setCurrentMs
// on ReelItem → whole item (rail, caption, sheets) re-rendered 10×/s → 17 long
// tasks on desktop. Now only the leaf subscribers (Scrubber fill via
// Animated.Value.setValue, SubtitleOverlay only when the LINE changes) react.
function createPlaybackClock() {
  const subs = new Set();
  let pct = 0;
  let ms = 0;
  return {
    get pct() { return pct; },
    get ms() { return ms; },
    publish(nextPct, nextMs) {
      pct = Number.isFinite(nextPct) ? Math.max(0, Math.min(1, nextPct)) : 0;
      ms = Number.isFinite(nextMs) ? nextMs : 0;
      subs.forEach((fn) => { try { fn(pct, ms); } catch {} });
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
  };
}

// Subtitle line isolated from ReelItem: re-renders only when the visible
// caption text actually changes (a few times per segment, not 10×/s).
const SubtitleOverlay = memo(function SubtitleOverlay({ clock, segments, enabled }) {
  const [line, setLine] = useState(() => (enabled ? pickSubtitle(segments, clock?.ms) : ''));
  useEffect(() => {
    if (!enabled || !clock || !segments?.length) { setLine(''); return undefined; }
    setLine(pickSubtitle(segments, clock.ms));
    return clock.subscribe((_p, ms) => {
      const next = pickSubtitle(segments, ms);
      setLine((prev) => (prev === next ? prev : next));
    });
  }, [clock, segments, enabled]);
  if (!line) return null;
  return (
    <View pointerEvents="none" style={styles.subtitleOverlay}>
      <View style={styles.subtitleBg}>
        <Text style={styles.subtitleText}>{line}</Text>
      </View>
    </View>
  );
});

// ── Scrubber (draggable progress bar) ──
// TikTok/Instagram parity: horizontal bar at the very bottom — tap to jump,
// drag to scrub. While the user is touching it we suspend the auto-progress
// update so the thumb doesn't fight the finger. Calls onSeek(progressNormalized)
// once on release (web) or live (native) so the underlying <video> seeks.
// [2026-10-11 reels-perf] Fill is driven by the playback clock with ZERO
// React renders while playing. Web: imperative transform on the fill's DOM
// node (an Animated.Value on react-native-web re-renders the AnimatedComponent
// on every setValue = 60 commits/s). Native: Animated.Value.setValue (direct
// prop update, no React commit). translateX keeps it compositor-only.
// Only scrub start/end re-render.
const Scrubber = memo(function Scrubber({ clock, onSeek, onScrubStart, onScrubEnd }) {
  const [width, setWidth] = useState(0);
  const [scrubbing, setScrubbing] = useState(false);
  const pctAnim = useRef(new Animated.Value(clock?.pct || 0)).current;
  const pctRef = useRef(clock?.pct || 0);
  const fillRef = useRef(null);
  const thumbRef = useRef(null);
  const widthRef = useRef(0);
  const scrubbingRef = useRef(false);
  useEffect(() => { widthRef.current = width; }, [width]);
  const paint = useCallback((p) => {
    pctRef.current = p;
    if (isWeb) {
      const pc = Math.round(Math.max(0, Math.min(1, p)) * 10000) / 100;
      const f = fillRef.current;
      if (f && f.style) f.style.transform = `translateX(${pc - 100}%)`;
      const th = thumbRef.current;
      if (th && th.style) th.style.left = `${pc}%`;
    } else {
      pctAnim.setValue(p);
    }
  }, [pctAnim]);
  // Re-apply after any re-render (scrub toggle) so React never resets it.
  useLayoutEffect(() => { if (isWeb) paint(pctRef.current); });
  useEffect(() => {
    if (!clock) return undefined;
    paint(clock.pct || 0);
    return clock.subscribe((p) => { if (!scrubbingRef.current) paint(p); });
  }, [clock, paint]);

  const pctFromEvent = (e) => {
    const x = e.nativeEvent.locationX;
    const w = widthRef.current || 1;
    return Math.max(0, Math.min(1, x / w));
  };
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (e) => {
        scrubbingRef.current = true;
        setScrubbing(true);
        onScrubStart?.();
        const pct = pctFromEvent(e);
        paint(pct);
        onSeek?.(pct, false);
      },
      onPanResponderMove: (e) => {
        const pct = pctFromEvent(e);
        paint(pct);
        onSeek?.(pct, false);
      },
      onPanResponderRelease: (e) => {
        const pct = pctFromEvent(e);
        paint(pct);
        onSeek?.(pct, true);
        scrubbingRef.current = false;
        setScrubbing(false);
        onScrubEnd?.();
      },
      onPanResponderTerminate: () => {
        scrubbingRef.current = false;
        setScrubbing(false);
        onScrubEnd?.();
      },
    })
  ).current;

  const w = width || 1;
  const fillX = pctAnim.interpolate({ inputRange: [0, 1], outputRange: [-w, 0], extrapolate: 'clamp' });
  const thumbX = pctAnim.interpolate({ inputRange: [0, 1], outputRange: [0, w], extrapolate: 'clamp' });
  return (
    <View
      {...panResponder.panHandlers}
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      // Bigger hit target than the visible bar so it's easy to grab; the
      // visible track stays 3px to match the prior aesthetic.
      style={styles.scrubberHit}
      accessibilityRole="adjustable"
    >
      <View style={[styles.progressBar, { overflow: 'hidden' }, scrubbing ? { height: 5 } : null]}>
        {isWeb ? (
          <View ref={fillRef} style={[styles.progressFill, { width: '100%', willChange: 'transform' }]} />
        ) : (
          <Animated.View style={[styles.progressFill, { width: '100%', transform: [{ translateX: fillX }] }]} />
        )}
      </View>
      {scrubbing ? (isWeb ? (
        <View ref={thumbRef} pointerEvents="none" style={[styles.scrubberThumb, { bottom: -4, top: undefined }]} />
      ) : (
        <Animated.View pointerEvents="none" style={[styles.scrubberThumb, { left: 0, bottom: -4, top: undefined, transform: [{ translateX: thumbX }] }]} />
      )) : null}
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
const ReelItem = memo(function ReelItem({ onCreate, reel, isActive, colors, isDark, t, user, containerHeight, containerWidth, onOpenComments, onOpenLikers, onOpenProfile, onUseSound, onDuet, onStitch, onHidePost, onLikeChange, showLiveRing, overlayOpen, router, preload, screenFocused = true, muted = false, onToggleMute }) {
  // Safe-area insets so the bottom info block (username/caption/music row)
  // doesn't sit on top of the iOS home indicator or Android gesture pill.
  const insets = useSafeAreaInsets();
  // Reels P0 — more-sheet visibility (Not interested / Duet / Stitch / Use sound)
  const [moreSheetOpen, setMoreSheetOpen] = useState(false);
  const [whyOpen, setWhyOpen] = useState(false); // [reels-v1 2026-10-13]
  const [paused, setPaused] = useState(false);
  // Share drawer (Repost / Copy link / External). Declared early so the
  // effectivePaused expression on the next line can reference it.
  const [shareSheetOpen, setShareSheetOpen] = useState(false);
  // When the comments/likers/share sheet opens above this reel, pause so the
  // user isn't trying to read with audio blasting underneath. Without this,
  // the Modal stack doesn't pause the underlying video — the reel keeps
  // playing unmuted and you have to manually pause before reading replies.
  // [#1231 2026-05-20] Pausa também quando a tela perde foco (user trocou
  // de aba/route). Sem isso o vídeo continuava tocando áudio em background.
  const effectivePaused = paused || !!overlayOpen || shareSheetOpen || !screenFocused;
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
  // Mute is owned by ReelsViewer (props muted + onToggleMute) so the user's
  // choice persists across swipes + sessions instead of resetting per reel.
  const [liked, setLiked] = useState(!!reel.user_liked);
  const [likeCount, setLikeCount] = useState(Number(reel.like_count) || 0);
  const [bookmarked, setBookmarked] = useState(!!reel.user_bookmarked);
  const [captionExpanded, setCaptionExpanded] = useState(false);
  // [2026-10-11 reels-perf] playback position lives in a clock (no state) —
  // see createPlaybackClock. Scrubbing is a ref only (no re-render needed).
  const clockRef = useRef(null);
  if (!clockRef.current) clockRef.current = createPlaybackClock();
  const playbackClock = clockRef.current;
  const scrubbingRef = useRef(false);
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
  // Fire feedView at most once per reel id per mount. The effect below reran
  // every time `isActive` flipped, so swiping back to a reel re-counted a view
  // and inflated the number. Mirror transcribeFiredRef's fire-once pattern but
  // keep a Set so a pooled/recycled ReelItem covers each id it has seen.
  const viewedRef = useRef(new Set());

  const videoRef = useRef(null);
  const lastTapRef = useRef(0);
  const heartScale = useRef(new Animated.Value(0)).current;
  const heartOpacity = useRef(new Animated.Value(0)).current;
  const likeScale = useRef(new Animated.Value(1)).current;
  const bookmarkScale = useRef(new Animated.Value(1)).current;
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
    try { trackReelEvent(reel.id, 'follow'); } catch {} // [reels-v1]
    try { require('expo-haptics').selectionAsync(); } catch {}
    try {
      await api.followUser?.(reel.author_email);
    } catch {
      setFollowed(false);
    } finally {
      followInFlightRef.current = false;
    }
  }, [reel?.author_email]);

  const pushDiamondBurst = useCallback((label, icon) => {
    burstSeqRef.current += 1;
    const key = burstSeqRef.current;
    setDiamondBursts(prev => [...prev, { key, label, icon }].slice(-6));
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
      // [2026-10-13 diamantes] o meu presente já animou no onSent — ignora o eco.
      if (user?.email && String(data.sender_email || '').toLowerCase() === String(user.email).toLowerCase()) return;
      const who = data.sender_name || data.sender_email?.split('@')[0] || '?';
      const meta = giftMeta(data.gift_sku || data.gift_type || data.gift);
      const q = Number(data.quantity) || 1;
      pushDiamondBurst(`${who} · ${giftLabel(t, data.icon || meta.icon, data.label || meta.label)}${q > 1 ? ' x' + q : ''}`, data.icon || meta.icon);
    });
    return () => {
      try { unsub?.(); } catch {}
      try { mailWs.unsubscribe?.(channel); } catch {}
    };
  }, [reel?.id, pushDiamondBurst, user?.email, t]);

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
    const label = reel.sound_label || `${reel.author_name || reel.author_email?.split('@')[0]} — ${t?.('feed.originalAudio') || 'Áudio original'}`;
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

  // Memoize media URL parsing (ReelItem no longer ticks with playback, but
  // likes/sheets still re-render it).
  const mediaUrls = useMemo(() => parseMediaUrls(reel.media_urls), [reel.media_urls]);
  const videoUrl = useMemo(() => resolveMediaUrl(mediaUrls[0]), [mediaUrls]);
  const authorDisplay = reel.author_name || reel.author_email?.split('@')[0] || '?';
  const commentCount = Number(reel.comment_count ?? reel.comments_count ?? reel.comments) || 0;
  // [2026-10-13 reels-visual] "♫ Áudio original · autor" (uma linha; marquee só se não couber)
  const musicName = reel.audio_name || `${t('feed.originalAudio') || 'Áudio original'} · ${authorDisplay}`;

  // Sync with prop changes
  useEffect(() => {
    setLiked(!!reel.user_liked);
    setLikeCount(Number(reel.like_count) || 0);
    setBookmarked(!!reel.user_bookmarked);
    // View pill (P1): reconcile the count whenever feed_list hands us a fresh
    // view_count (backend now returns it). The pill only renders when > 0, so
    // without this it stayed stuck at 0 for the whole session.
    setViewCount(Number(reel.view_count) || 0);
  }, [reel.user_liked, reel.like_count, reel.user_bookmarked, reel.view_count]);

  // Track view when reel becomes active (P1) — gated behind a ~1.5s dwell so
  // we only count a view once the user actually watched, not on every swipe
  // that flicked past. Guarded via viewedRef so swiping back doesn't re-fire
  // feedView for an id already counted this mount. Optimistically bumps the
  // local pill so it reacts immediately.
  useEffect(() => {
    if (!isActive || !reel.id || viewedRef.current.has(reel.id)) return;
    const timer = setTimeout(() => {
      if (viewedRef.current.has(reel.id)) return;
      viewedRef.current.add(reel.id);
      setViewCount(prev => prev + 1);
      api.feedView?.(reel.id).catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
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

  // Progress tracking (web). [2026-10-11 reels-perf] requestAnimationFrame
  // reads <video>.currentTime and publishes to the playback clock — no React
  // state, so ReelItem no longer re-renders 10×/s (was a 100ms setInterval →
  // 17 long tasks on desktop). Throttled to only publish when time moved.
  // Suspended while scrubbing so the thumb tracks the finger.
  useEffect(() => {
    if (!isWeb) return undefined;
    if (!isActive) { playbackClock.publish(0, 0); return undefined; }
    if (typeof requestAnimationFrame !== 'function') return undefined;
    let raf = 0;
    let lastT = -1;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      if (scrubbingRef.current) return;
      const v = videoRef.current;
      if (!v || !v.duration || !Number.isFinite(v.duration)) return;
      const ct = v.currentTime;
      if (ct === lastT) return; // paused / buffering → no work
      lastT = ct;
      playbackClock.publish(ct / v.duration, ct * 1000);
    };
    raf = requestAnimationFrame(tick);
    return () => { if (raf) cancelAnimationFrame(raf); };
  }, [isActive, playbackClock]);

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

  // Visible caption line is computed inside <SubtitleOverlay> (subscribes to
  // the playback clock) so the line change doesn't re-render ReelItem.

  // Reset paused state when becoming active
  useEffect(() => {
    if (isActive) {
      setPaused(false);
      setCaptionExpanded(false);
    }
  }, [isActive]);

  const toggleMute = useCallback(() => {
    const newMuted = !muted;
    if (isWeb && videoRef.current) {
      videoRef.current.muted = newMuted;
    }
    onToggleMute?.();
    try { require('expo-haptics').selectionAsync(); } catch {}
  }, [muted, onToggleMute]);

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
    const nextLiked = !wasLiked;
    // [#like-count-sync] Compute the optimistic count explicitly so we can both
    // update local state AND lift it to the parent's reels map (so the like
    // survives FlatList recycling — see handleReelLikeChange). Reading off
    // `likeCount` here is safe: toggleLike is single-flighted by likeInFlightRef.
    const optimisticCount = wasLiked ? Math.max(0, likeCount - 1) : likeCount + 1;
    setLiked(nextLiked);
    setLikeCount(optimisticCount);
    try { onLikeChange?.(reel.id, nextLiked, optimisticCount); } catch {}
    try { trackReelEvent(reel.id, nextLiked ? 'like' : 'unlike'); } catch {} // [reels-v1]
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
        const finalLiked = r.data.liked !== undefined ? !!r.data.liked : nextLiked;
        if (r.data.liked !== undefined) setLiked(finalLiked);
        // Backend returns the reconciled total as `likes_count`; older
        // servers used `like_count`. Read both so the count actually syncs.
        const serverCount = r.data.likes_count ?? r.data.like_count;
        const finalCount = serverCount !== undefined ? Number(serverCount) : optimisticCount;
        if (serverCount !== undefined) setLikeCount(finalCount);
        // [#like-count-sync] Reconcile the parent map with the server truth.
        try { onLikeChange?.(reel.id, finalLiked, finalCount); } catch {}
      }
    } catch {
      // Network error — keep the optimistic state and queue the toggle.
      // TikTok / Instagram keep the heart filled while offline; rolling back
      // mid-tap is jarring and (worse) makes the user re-tap and double-fire
      // the toggle when net comes back.
      try {
        const { queueOfflineAction } = require('../services/offlineCache');
        await queueOfflineAction({ type: 'feed_like', params: { id: reel.id } });
      } catch {
        setLiked(wasLiked);
        setLikeCount(likeCount);
        // [#like-count-sync] Roll back the parent map too so it matches.
        try { onLikeChange?.(reel.id, wasLiked, likeCount); } catch {}
      }
    } finally {
      likeInFlightRef.current = false;
    }
  }, [liked, likeCount, reel.id, likeScale, onLikeChange]);

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
    try { trackReelEvent(reel.id, was ? 'unsave' : 'save'); } catch {} // [reels-v1]
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
      // Offline — preserve optimistic state, queue for replay. Bookmark UI
      // flicker is even more disruptive than like (slower animation), so we
      // skip the rollback unless the queue itself errors.
      try {
        const { queueOfflineAction } = require('../services/offlineCache');
        await queueOfflineAction({ type: 'feed_bookmark', params: { id: reel.id } });
      } catch {
        setBookmarked(was);
      }
    }
  }, [bookmarked, reel.id, bookmarkScale]);

  const handleShare = useCallback(() => {
    setShareSheetOpen(true);
  }, []);

  const handleShareExternal = useCallback(async () => {
    setShareSheetOpen(false);
    try { trackReelEvent(reel.id, 'share'); } catch {} // [reels-v1]
    const url = `${BASE_URL}/feed/${reel.id}`;
    if (isWeb && typeof navigator !== 'undefined' && navigator.share) {
      try { await navigator.share({ title: reel.caption || '', url }); } catch {}
    } else if (!isWeb) {
      try { await Share.share({ message: url }); } catch {}
    }
  }, [reel.id, reel.caption]);

  const handleShareCopyLink = useCallback(async () => {
    setShareSheetOpen(false);
    try { trackReelEvent(reel.id, 'share'); } catch {} // [reels-v1]
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
    try { trackReelEvent(reel.id, 'share'); } catch {} // [reels-v1]
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

  // [reels-v1 2026-10-13] Compartilhar NO CHAT: abre o seletor de conversas (/share-receive)
  // com o link do reel como texto — mesmo fluxo do "compartilhar da galeria".
  const handleShareToChat = useCallback(() => {
    setShareSheetOpen(false);
    try { trackReelEvent(reel.id, 'share'); } catch {}
    const url = `${BASE_URL}/feed/${reel.id}`;
    try { router?.push({ pathname: '/share-receive', params: { text: url } }); } catch {}
  }, [reel.id, router]);

  const height = containerHeight || SCREEN_HEIGHT;
  // [2026-10-13 reels-visual] web desktop → coluna 9:16 + trilho ao lado
  const desktopFrame = isWeb && _reelItemWidth(containerWidth, height) < (containerWidth || SCREEN_WIDTH) - 1;

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
    playbackClock.publish(ms / durMs, ms);
  }, [playbackClock]);

  // Scrubber seek handler. `final` is true on PanResponder release; false
  // during the live drag. We seek the underlying video either way so the
  // viewer sees the frame they're scrubbing to immediately.
  const handleScrub = useCallback((pct, final) => {
    // Keep subtitles in sync with the scrub position (bypasses the
    // scrubbing guard: the Scrubber already ignores clock while dragging).
    const durMs = isWeb ? ((videoRef.current?.duration || 0) * 1000) : (nativeDurMsRef.current || 0);
    playbackClock.publish(pct, durMs * pct);
    if (isWeb && videoRef.current && Number.isFinite(videoRef.current.duration)) {
      try { videoRef.current.currentTime = videoRef.current.duration * pct; } catch {}
    } else if (!isWeb && nativeSeekRef.current?.seek) {
      const dur = nativeDurMsRef.current || 0;
      if (dur > 0) nativeSeekRef.current.seek(dur * pct);
    }
  }, [playbackClock]);
  const onScrubStart = useCallback(() => { scrubbingRef.current = true; }, []);
  const onScrubEnd = useCallback(() => { scrubbingRef.current = false; }, []);

  return (
    <ReelDesktopFrame
      enabled={desktopFrame}
      width={containerWidth || SCREEN_WIDTH}
      height={height}
      poster={reel.thumbnail_url ? resolveMediaUrl(reel.thumbnail_url) : null}
    >
    <View style={[styles.reelContainer, { height, width: _reelItemWidth(containerWidth, height), alignSelf: 'center' }, desktopFrame ? styles.reelContainerDesktop : null]}>
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
            hardGateClosed={!screenFocused}
            t={t}
          />
        )}
      </TouchableOpacity>
      </PinchZoomBox>

      {/* 2× boost toast (long-press). Floats top-center, fades in/out. */}
      <BoostToast visible={rateBoost} />

      {/* Gradient overlays for readability */}
      <View pointerEvents="none" style={styles.topGradient}><ReelScrim edge="top" /></View>
      <View pointerEvents="none" style={styles.bottomGradient}><ReelScrim edge="bottom" /></View>

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
      {/* [2026-10-13 reels-visual] Linha secundária (AO VIVO / CC) abaixo do cabeçalho do
          viewer — antes mudo/criar ficavam na MESMA altura das abas e se sobrepunham. */}
      <View pointerEvents="box-none" style={[styles.topBar, { paddingTop: reelHeaderTop(insets) + REEL_HEADER_H + 4 }]}>
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
          {/* CC toggle — only renders when the post has segments. Tap
              hides/shows the bottom subtitle overlay. Persists to AsyncStorage. */}
          {subtitleSegments.length > 0 && (
            <TouchableOpacity
              onPress={toggleSubtitles}
              activeOpacity={0.7}
              hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
              style={{ backgroundColor: subtitlesEnabled ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.35)', borderRadius: 8, paddingHorizontal: 8, height: 28, alignItems: 'center', justifyContent: 'center' }}
              accessibilityLabel={subtitlesEnabled ? (t('feed.captionsOn') || t('media.subtitlesOn') || 'Captions on') : (t('feed.captionsOff') || t('media.subtitlesOff') || 'Captions off')}
              accessibilityRole="button"
            >
              <Text style={{ color: subtitlesEnabled ? '#000' : '#fff', fontSize: 12, fontWeight: '800', letterSpacing: 0.5 }}>CC</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>

      {/* ── RIGHT SIDE BUTTONS ── */}
      <View style={[styles.rightSidebar, { bottom: insets.bottom + 78 }, desktopFrame && { right: -68, bottom: 24 }]}>
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
            <LiveBadgeRing size={40} t={t}>
              <AvatarCircle email={reel.author_email} name={reel.author_name} size={36} />
            </LiveBadgeRing>
          ) : (
            <View style={styles.profileAvatarRing}>
              <AvatarCircle email={reel.author_email} name={reel.author_name} size={36} />
            </View>
          )}
          {/* Plus-badge only when not yet followed and is another user. */}
          {!followed && isOtherUser && !reel.is_catalog ? (
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
        {/* [2026-10-13 reels-visual] contagem centralizada SOB o ícone; "0" escondido (Instagram) */}
        <Animated.View style={[styles.sidebarItem, { transform: [{ scale: likeScale }] }]}>
          <TouchableOpacity
            style={styles.sidebarBtn}
            onPress={toggleLike}
            activeOpacity={0.7}
            accessibilityLabel={liked ? (t('feed.unlike') || 'Unlike') : (t('feed.like') || 'Like')}
            accessibilityRole="button"
          >
            <View style={styles.sidebarIcon}>
              {liked ? (
                <IconHeart size={30} color="#FF2D55" />
              ) : (
                <IconHeartOutline size={30} color="#fff" />
              )}
            </View>
          </TouchableOpacity>
          {likeCount > 0 ? (
            <TouchableOpacity onPress={() => onOpenLikers?.(reel)} activeOpacity={0.7} hitSlop={{ top: 4, bottom: 6, left: 10, right: 10 }}>
              <Text style={styles.sidebarCount}>{formatCount(likeCount)}</Text>
            </TouchableOpacity>
          ) : null}
        </Animated.View>

        {/* Tip / Diamond — Reels P1 monetization. Opens LivePaidGiftSheet,
            which reuses the same SKU set + wallet UI as Live gifts.
            [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag. */}
        {DIAMONDS_ENABLED && reel.author_email?.toLowerCase() !== user?.email?.toLowerCase() && (
          <PressableScale
            style={styles.sidebarBtn}
            onPress={handleOpenTip}
            activeOpacity={0.85}
            scaleTo={0.88}
            accessibilityLabel={t?.('gifts.sendGift') || 'Enviar presente'}
            accessibilityRole="button"
          >
            <IconGiftBox size={27} color="#fff" />
          </PressableScale>
        )}

        {/* Comment — [2026-10-08 apps-native] PressableScale (scale + haptic nativo) */}
        <PressableScale
          style={[styles.sidebarBtn, (reel.allow_comments === false && String(reel.author_email || '').toLowerCase() !== String(user?.email || '').toLowerCase()) && { opacity: 0.4 }]}
          // [2026-10-08 reels-publish] autor desligou os comentários → botão inativo.
          onPress={() => { if (reel.allow_comments === false && String(reel.author_email || '').toLowerCase() !== String(user?.email || '').toLowerCase()) return; onOpenComments?.(reel); }}
          activeOpacity={0.85}
          scaleTo={0.88}
          accessibilityLabel={t('feed.comment') || 'Comment'}
          accessibilityRole="button"
        >
          <View style={styles.sidebarIcon}><IconMessageCircle size={29} color="#fff" /></View>
          {commentCount > 0 ? <Text style={styles.sidebarCount}>{formatCount(commentCount)}</Text> : null}
        </PressableScale>

        {/* Share */}
        <PressableScale
          style={styles.sidebarBtn}
          onPress={handleShare}
          activeOpacity={0.85}
          scaleTo={0.88}
          accessibilityLabel={t('feed.share') || 'Compartilhar'}
          accessibilityRole="button"
        >
          <View style={styles.sidebarIcon}><IconSend size={28} color="#fff" /></View>
        </PressableScale>

        {/* [2026-10-13 reels-visual] Velocidade e visualizações saíram do trilho → menu "…". */}

        {/* Bookmark */}
        <Animated.View style={{ transform: [{ scale: bookmarkScale }] }}>
          <PressableScale
            style={styles.sidebarBtn}
            onPress={toggleBookmark}
            haptic="select"
            activeOpacity={0.85}
            scaleTo={0.88}
            accessibilityLabel={bookmarked ? (t('feed.removeBookmark') || 'Remove') : (t('feed.bookmark') || 'Save')}
            accessibilityRole="button"
          >
            <View style={styles.sidebarIcon}>
              {bookmarked ? (
                <IconBookmarkFilled size={28} color="#fff" />
              ) : (
                <IconBookmark size={28} color="#fff" />
              )}
            </View>
          </PressableScale>
        </Animated.View>

        {/* More (kebab) — Reels P0: opens the actions sheet
            (Duet / Stitch / Use sound / Not interested / Report). */}
        <PressableScale
          style={styles.sidebarBtn}
          onPress={() => setMoreSheetOpen(true)}
          activeOpacity={0.85}
          scaleTo={0.88}
          accessibilityLabel={t?.('common.more') || 'More'}
          accessibilityRole="button"
        >
          <View style={styles.sidebarIcon}><IconMoreHorizontal size={28} color="#fff" /></View>
        </PressableScale>

        {/* Spinning album art disc — tap to jump to the sound feed
            ("Usar este som"). Long-press-friendly hit area thanks to the
            outer TouchableOpacity. */}
        <PressableScale
          activeOpacity={0.85}
          scaleTo={0.9}
          onPress={() => onUseSound && onUseSound(reel)}
          accessibilityLabel={t?.('feed.useThisSound') || 'Usar este som'}
          accessibilityRole="button"
        >
          <SpinningDisc authorEmail={reel.author_email} authorName={reel.author_name} />
        </PressableScale>
      </View>

      {/* ── Subtitle overlay (TikTok auto-caption) ──
          Sits above the bottom info block so the visible caption doesn't
          fight for the same vertical space. We pin to bottom-center with
          a max-width of 78% so it never collides with the right rail. */}
      <SubtitleOverlay clock={playbackClock} segments={subtitleSegments} enabled={subtitlesEnabled} />

      {/* ── BOTTOM LEFT INFO ── */}
      <View style={[styles.bottomInfo, { paddingBottom: insets.bottom + 16 }, desktopFrame && { right: 56 }]}>
        {/* Username */}
        <Text style={styles.username}>{reel.is_catalog ? authorDisplay : `@${authorDisplay}`}</Text>
        {/* [reels-v1 2026-10-13] Crédito obrigatório da fonte licenciada ("Vídeo: Nome · Pexels") → página do vídeo */}
        {reel.credit ? (
          <Text
            style={styles.creditText}
            numberOfLines={1}
            accessibilityRole="link"
            onPress={() => { const u = reel.credit.page_url || reel.credit.author_url; if (u) { try { Linking.openURL(u); } catch {} } }}
          >
            {(t?.('reels.credit') || 'Vídeo: {name} · {source}').replace('{name}', reel.credit.name || reel.credit.source || '').replace('{source}', reel.credit.source || '')}
          </Text>
        ) : null}

        {/* Caption */}
        {reel.caption ? (
          <TouchableOpacity
            onPress={() => setCaptionExpanded(!captionExpanded)}
            activeOpacity={0.9}
          >
            <Text style={styles.caption} numberOfLines={captionExpanded ? undefined : 2}>
              {reel.caption}
            </Text>
            {!captionExpanded && (reel.caption.length > 80 || (String(reel.caption).match(/\n/g) || []).length >= 2) && (
              <Text style={styles.moreText}>{t('feed.more') || 'mais'}</Text>
            )}
          </TouchableOpacity>
        ) : null}

        {/* Music row — tocar leva a "Usar este som". [2026-10-13 reels-visual] uma linha só:
            sem equalizer duplicando o ♫ e sem o salvar-som solto (foi pro menu "…"). */}
        <TouchableOpacity
          style={styles.musicRow}
          activeOpacity={0.7}
          onPress={() => onUseSound && onUseSound(reel)}
          accessibilityLabel={t?.('feed.useThisSound') || 'Usar este som'}
          accessibilityRole="button"
        >
          <View style={styles.sidebarIcon}><IconMusic size={13} color="#fff" /></View>
          <MusicMarquee text={musicName} active={isActive} />
        </TouchableOpacity>
      </View>

      {/* Mudo discreto no canto inferior direito (alinhado à linha da música). Tocar no
          vídeo continua pausando/retomando com o ícone central. */}
      <TouchableOpacity
        onPress={toggleMute}
        activeOpacity={0.7}
        hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
        style={[styles.muteChip, { bottom: insets.bottom + 34 }]}
        accessibilityLabel={muted ? (t('feed.unmute') || 'Ativar som') : (t('feed.mute') || 'Silenciar')}
        accessibilityRole="button"
      >
        {muted ? <IconVolumeX size={16} color="#fff" /> : <IconVolume2 size={16} color="#fff" />}
      </TouchableOpacity>

      {/* Floating diamond bursts — mounted briefly on each tip event. */}
      {diamondBursts.map(b => (
        <FloatingDiamond key={b.key} label={b.label} icon={b.icon} />
      ))}

      {/* Tip sheet — reuses LivePaidGiftSheet UI. We intercept onClose so we
          can substitute our own feed_post_tip call (the sheet doesn't know
          how to call our reel-tip endpoint). Trick: hand it a tip handler
          via a wrapping side-effect — when the sheet closes we check
          its last-selected gift and fire the tip ourselves. */}
      {/* [2026-05-22 monetization-pause] hidden by MONETIZATION_ENABLED flag */}
      {DIAMONDS_ENABLED && tipSheetOpen && reel?.id ? (
        <GiftSheet
          visible
          onClose={() => setTipSheetOpen(false)}
          context="post"
          targetId={reel.id}
          recipientName={reel.author_name || (reel.author_email || '').split('@')[0]}
          onSent={(_d, gift, qty) => {
            const me = user?.name || user?.email?.split('@')[0] || '';
            pushDiamondBurst(`${me} · ${giftLabel(t, gift.icon, gift.label)}${qty > 1 ? ' x' + qty : ''}`, gift.icon);
          }}
        />
      ) : null}

      {/* ── DRAGGABLE SCRUBBER ── (tap to jump / drag to seek) */}
      <Scrubber
        clock={playbackClock}
        onSeek={handleScrub}
        onScrubStart={onScrubStart}
        onScrubEnd={onScrubEnd}
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
        onSendChat={router ? handleShareToChat : undefined}
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

            {/* Use this sound — hidden until the by-sound feed ships. */}
            {REELS_BACKEND_ACTIONS_READY && !!reel.sound_id && (
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

            {/* Duet — only when the creator allows it (and backend is ready). */}
            {REELS_BACKEND_ACTIONS_READY && reel.allow_duet !== false && reel.media_type === 'video' && (
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

            {/* Stitch — only when the creator allows it (and backend is ready). */}
            {REELS_BACKEND_ACTIONS_READY && reel.allow_stitch !== false && reel.media_type === 'video' && (
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

            {/* [reels-v1 2026-10-13] Por que estou vendo isto? (ranking explicável) */}
            {!!reel.rec?.why && (
              <TouchableOpacity
                style={{ paddingHorizontal: 20, paddingVertical: 14 }}
                onPress={() => setWhyOpen((v) => !v)}
                activeOpacity={0.7}
                accessibilityRole="button"
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14 }}>
                  <IconEye size={22} color="#fff" />
                  <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                    {t?.('reels.why.title') || 'Por que estou vendo isto?'}
                  </Text>
                </View>
                {whyOpen ? (
                  <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, lineHeight: 20, marginTop: 8, marginLeft: 36 }}>
                    {reelWhyText(reel, t)}
                  </Text>
                ) : null}
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

            {/* [2026-10-13 reels-visual] Salvar som — saiu da linha da música. */}
            <TouchableOpacity
              style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 }}
              onPress={() => { setMoreSheetOpen(false); handleToggleSoundSave(); }}
              activeOpacity={0.7}
              accessibilityRole="button"
            >
              {soundSaved ? <IconBookmarkFilled size={22} color="#fff" /> : <IconBookmark size={22} color="#fff" />}
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600' }}>
                {soundSaved ? (t?.('feed.unsaveSound') || 'Remover som dos salvos') : (t?.('feed.saveSound') || 'Salvar som')}
              </Text>
            </TouchableOpacity>

            {/* [2026-10-13 reels-visual] Visualizações — saiu do trilho (informativo). */}
            {viewCount > 0 && (
              <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingVertical: 14, gap: 14 }}>
                <IconEye size={22} color="#fff" />
                <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', flex: 1 }}>
                  {t?.('feed.views') || 'Visualizações'}
                </Text>
                <Text style={{ color: 'rgba(255,255,255,0.7)', fontSize: 14, fontWeight: '700' }}>{formatCount(viewCount)}</Text>
              </View>
            )}

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
              <Text style={{ color: '#fff', fontSize: 14, fontWeight: '700' }}>{playbackRate}×</Text>
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
    </ReelDesktopFrame>
  );
}, (prev, next) => {
  // [perf] Custom equality so a parent re-render (containerHeight settling,
  // the prefetch effect firing on currentIndex change, overlay toggles for a
  // *different* row) doesn't re-render every mounted reel. We only re-render
  // when something this row actually renders against changed. Function props
  // (onOpenComments, onLikeChange, …) are stable useCallbacks in the parent,
  // so we deliberately ignore their identity. NOTE: returning true === skip
  // re-render; this is a pure render optimization and changes no behavior.
  if (prev.isActive !== next.isActive) return false;
  if (prev.preload !== next.preload) return false;
  if (prev.muted !== next.muted) return false; // [2026-07-03] mute was never compared → global mute button didn't re-render the mounted reel until the user swiped
  if (prev.overlayOpen !== next.overlayOpen) return false;
  if (prev.screenFocused !== next.screenFocused) return false;
  if (prev.showLiveRing !== next.showLiveRing) return false;
  if (prev.containerHeight !== next.containerHeight) return false;
  if (prev.containerWidth !== next.containerWidth) return false;
  if (prev.isDark !== next.isDark) return false;
  if (!!prev.onCreate !== !!next.onCreate) return false; // [2026-10-08 apps-native] câmera aparece/some
  if (prev.colors !== next.colors) return false;
  if (prev.t !== next.t) return false;
  if (prev.user?.email !== next.user?.email) return false;
  const a = prev.reel, b = next.reel;
  if (!a || !b) return a === b;
  if (a.id !== b.id) return false;
  if ((a.like_count ?? 0) !== (b.like_count ?? 0)) return false;
  if ((Number(a.comment_count ?? a.comments_count ?? a.comments) || 0) !== (Number(b.comment_count ?? b.comments_count ?? b.comments) || 0)) return false;
  if ((a.view_count ?? 0) !== (b.view_count ?? 0)) return false;
  if ((a.user_liked || false) !== (b.user_liked || false)) return false;
  if ((a.user_bookmarked || false) !== (b.user_bookmarked || false)) return false;
  if ((a.user_following || false) !== (b.user_following || false)) return false;
  if ((a.sound_saved || false) !== (b.sound_saved || false)) return false;
  if ((a.caption || '') !== (b.caption || '')) return false;
  if ((a.media_urls || '') !== (b.media_urls || '')) return false;
  return true;
});

// ── Loading skeleton ──
function ReelsSkeleton({ insets }) {
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.55, duration: 750, easing: Easing.inOut(Easing.ease), useNativeDriver: true }),
    ]));
    a.start();
    return () => a.stop();
  }, [pulse]);
  const bone = (st) => <View style={[{ backgroundColor: 'rgba(255,255,255,0.10)' }, st]} />;
  return (
    <View style={[styles.loadingContainer, { backgroundColor: '#0a0a0a' }]}>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: pulse }]}>
        <View style={{ position: 'absolute', top: reelHeaderTop(insets) + 12, left: 0, right: 0, flexDirection: 'row', justifyContent: 'center', gap: 22 }}>
          {bone({ width: 72, height: 14, borderRadius: 7 })}
          {bone({ width: 72, height: 14, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.16)' })}
        </View>
        <View style={{ position: 'absolute', right: 14, bottom: (insets?.bottom || 0) + 86, alignItems: 'center', gap: 24 }}>
          {[42, 30, 30, 30, 30].map((d, i) => <View key={i}>{bone({ width: d, height: d, borderRadius: d / 2 })}</View>)}
        </View>
        <View style={{ position: 'absolute', left: 14, right: 84, bottom: (insets?.bottom || 0) + 40, gap: 10 }}>
          {bone({ width: '38%', height: 14, borderRadius: 7, backgroundColor: 'rgba(255,255,255,0.14)' })}
          {bone({ width: '88%', height: 12, borderRadius: 6 })}
          {bone({ width: '62%', height: 12, borderRadius: 6 })}
          {bone({ width: '46%', height: 10, borderRadius: 5, backgroundColor: 'rgba(255,255,255,0.07)' })}
        </View>
      </Animated.View>
    </View>
  );
}

// ── Empty state ──
// [2026-10-08 apps-native] variante de ERRO + botão "Tentar novamente" (antes
// o vazio era um beco sem saída: early-return sem FlatList = sem pull-to-refresh).
function EmptyReels({ colors, isDark, t, error = false, following = false, onRetry, height, onCreate, onSeeForYou }) {
  const title = error
    ? (t('feed.loadError') || 'Erro ao carregar')
    : following
      ? (t('feed.noFollowingReels') || 'No reels from people you follow')
      : (t('feed.noReels') || 'Sem reels ainda');
  const sub = error
    ? (t('common.networkError') || 'Falha de conexão')
    : following
      ? (t('feed.noFollowingReelsHint') || 'Follow people to see their reels here')
      : (t('feed.noReelsHint') || 'Videos aparecerao aqui');
  return (
    <View style={[styles.emptyContainer, height ? { height } : null]}>
      <View style={styles.emptyIcon}>
        {error
          ? <IconRepeat size={32} color="rgba(255,255,255,0.75)" />
          : <IconPlay size={32} color="rgba(255,255,255,0.75)" />}
      </View>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptySubtext}>{sub}</Text>
      {/* [2026-10-13 reels-visual] "Seguindo" vazio → atalho primário pro "Para você" */}
      {!error && following && !!onSeeForYou && (
        <PressableScale
          onPress={onSeeForYou}
          style={styles.emptyRetryBtn}
          accessibilityRole="button"
          accessibilityLabel={t('feed.forYou') || 'Para você'}
        >
          <Text style={styles.emptyRetryText}>{t('feed.forYou') || 'Para você'}</Text>
        </PressableScale>
      )}
      {!!onRetry && !(following && !error && onSeeForYou) && (
        <PressableScale
          onPress={onRetry}
          style={styles.emptyRetryBtn}
          accessibilityRole="button"
          accessibilityLabel={t('common.retry') || 'Tentar novamente'}
        >
          <Text style={styles.emptyRetryText}>{error ? (t('common.retry') || 'Tentar novamente') : (t('common.refresh') || 'Atualizar')}</Text>
        </PressableScale>
      )}
      {/* [2026-10-08 reels-publish] sem reels → atalho pro compositor */}
      {!error && !!onCreate && (
        <PressableScale
          onPress={onCreate}
          style={[styles.emptyRetryBtn, { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: '#fff', flexDirection: 'row', alignItems: 'center', gap: 8 }]}
          accessibilityRole="button"
          accessibilityLabel={(t('reels.create') && t('reels.create') !== 'reels.create') ? t('reels.create') : 'Criar reel'}
          testID="reels-empty-create"
        >
          <IconCamera size={18} color="#fff" />
          <Text style={[styles.emptyRetryText, { color: '#fff' }]}>{(t('reels.create') && t('reels.create') !== 'reels.create') ? t('reels.create') : 'Criar reel'}</Text>
        </PressableScale>
      )}
    </View>
  );
}

// ── Main ReelsViewer ──
export default function ReelsViewer({ colors, isDark, t, user, router, feedMode: feedModeProp, showLiveRing, onAvatarTap, onPullRefresh, soundId: soundIdProp, soundLabel: soundLabelProp, parentActive = true, onCreate, recommended = true }) {
  // [reels-v1 2026-10-13] "Para você" vem do ranking do servidor (reels_rec_feed) — com
  // fallback automático pro feedList antigo se o servidor ainda não tem o endpoint.
  const useRec = !!recommended && !soundIdProp;
  const recCursorRef = useRef(null);
  const recSupportedRef = useRef(true);
  const recModeRef = useRef(false);
  const [recActive, setRecActive] = useState(false);
  const [pickerMode, setPickerMode] = useState(null); // null | 'onboarding' | 'manage'
  // [#1231 2026-05-20] Screen focus gate — pausa qualquer reel quando a tela
  // sai de foco (user navegou pra /chat-conversation ou outra aba). Sem isso
  // o áudio continuava tocando em background; só `isActive` (per FlatList row)
  // era checado e ele sempre é true pro item visível.
  const isScreenFocused = useIsFocused();
  // [#1238 2026-05-20] AppState gate — useIsFocused mantém true quando app vai
  // pra background (lock screen, home button), porque a route ainda é a ativa.
  // Sem isso o reel continuava tocando áudio com o app minimizado. Combinamos
  // os dois flags num único `playGate` que vai pro ReelItem.
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      setAppActive(next === 'active');
    });
    return () => { try { sub.remove(); } catch {} };
  }, []);
  // [#1247 2026-05-20] parentActive — chat.js renderiza tabs com display:none,
  // então useIsFocused() fica TRUE quando user troca pra Chats/Calls (a route
  // /chat continua focada). Sem essa flag o ShortsPlayer nativo continuava
  // tocando áudio em background. ChatFeedTab passa true só quando activeTab
  // === 'feed' (e feedMode === 'reels' — só renderiza ReelsViewer nesse caso).
  const playGate = isScreenFocused && appActive && parentActive;

  // Mute lives here (not per-ReelItem) so it persists across swipes + sessions.
  // Bug: mute reset on every swipe because each ReelItem owned its own state.
  // Hydrated from AsyncStorage on mount; toggle persists the new value.
  const [muted, setMuted] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const v = await AsyncStorage.getItem(REELS_MUTED_KEY);
        if (v === '1') setMuted(true);
      } catch {}
    })();
  }, []);
  const handleToggleMute = useCallback(() => {
    setMuted(m => {
      const next = !m;
      AsyncStorage.setItem(REELS_MUTED_KEY, next ? '1' : '0').catch(() => {});
      return next;
    });
  }, []);

  // [#1247 2026-05-20] Quando playGate cai pra false (user troca de aba),
  // restaura AVAudioSession e drena o pool de imediato. Sem isso o native
  // ShortsPlayer fica em playWhenInFocus=false mas a sessão de áudio segue
  // .playback — o buffer drena lentamente. Drenar pool = hard-stop audible.
  //
  // [WAVE 43B 2026-05-20] Reorder: drena pool ANTES de restaurar a sessão.
  // Iteração anterior chamava restoreShortsAudioSession primeiro — isso
  // chama setActive(false) com player ainda vivo, e iOS continua emitindo
  // áudio até o player ser explicitamente nilificado. Drenar pool primeiro
  // garante que slot.player?.pause() + replaceCurrentItem(nil) acontecem
  // antes da sessão desativar, eliminando frames residuais.
  useEffect(() => {
    if (isWeb) return;
    if (!playGate) {
      // 1) pause + tear down all 3 AVPlayer slots first (kills audio at source)
      try { releaseShortsPoolFn?.(); } catch {}
      // 2) only then deactivate AVAudioSession (with notifyOthersOnDeactivation
      //    so Spotify/Apple Music can resume if they were ducked)
      try { restoreShortsAudioSessionFn?.(); } catch {}
    } else {
      // Re-arm playback session quando volta pra Reels.
      try { setShortsAudioSessionPlaybackFn?.(); } catch {}
    }
  }, [playGate]);

  // [WAVE 43B 2026-05-20] AppState belt-and-suspenders — quando o app vai
  // pra background (Home button, app switcher), playGate já cai via
  // appActive=false e o effect acima drena o pool. Mas se o user matar o
  // app via swipe sem passar por background events (raro mas observed na
  // emul Android), o AVPlayer pool sobrevive em outro processo até ARC
  // limpar. Esse listener extra força drain via componentWillUnmount no
  // change para 'background'/'inactive'.
  useEffect(() => {
    if (isWeb) return undefined;
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'background' || next === 'inactive') {
        try { releaseShortsPoolFn?.(); } catch {}
        try { restoreShortsAudioSessionFn?.(); } catch {}
      }
    });
    return () => { try { sub.remove(); } catch {} };
  }, []);
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
  const reelsRef = useRef(reels);
  reelsRef.current = reels;
  const [followingReels, setFollowingReels] = useState([]);
  // [2026-10-08 reels-publish] reel publicado em 2º plano (reelPublishQueue) →
  // entra no topo de "Seguindo" e "Pra você" sem esperar o próximo refresh.
  useEffect(() => {
    if (soundIdProp) return undefined;
    let unsub = null;
    try {
      unsub = require('../services/reelPublishQueue').onReelPublished((p) => {
        if (!p?.id) return;
        const add = (prev) => (prev.some(x => String(x.id) === String(p.id)) ? prev : [p, ...prev]);
        setFollowingReels(add);
        setReels(add);
        setLoading(false);
      });
    } catch {}
    return () => { try { unsub && unsub(); } catch {} };
  }, [soundIdProp]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  // [2026-10-08 apps-native] falha de rede antes caía no empty "Sem reels
  // ainda" (mentira) sem jeito de tentar de novo. Agora vira estado de erro.
  const [loadError, setLoadError] = useState(false);
  const [commentsReel, setCommentsReel] = useState(null);
  const [likersReel, setLikersReel] = useState(null);
  const [containerHeight, setContainerHeight] = useState(SCREEN_HEIGHT);
  const [containerWidth, setContainerWidth] = useState(SCREEN_WIDTH);

  // ── Infinite scroll (P0) ──
  // Page cursor + has-more + in-flight guard tracked per feed (For You vs
  // Following vs by-sound). loadReels() resets these to page 1; loadMore()
  // (wired to FlatList onEndReached) appends the next page and dedups by id,
  // mirroring ChatFeedTab.loadPosts' existingIds merge so a reel never shows
  // twice when the backend returns overlapping windows.
  const [page, setPage] = useState(1);
  const [followingPage, setFollowingPage] = useState(1);
  const [hasMore, setHasMore] = useState(true);
  const [followingHasMore, setFollowingHasMore] = useState(true);
  const loadingMoreRef = useRef(false);

  // ── "Não tenho interesse" local persistence + toast (P2) ──
  const hiddenIdsRef = useRef(new Set());
  const [hideToast, setHideToast] = useState('');
  const hideToastTimerRef = useRef(null);
  useEffect(() => {
    (async () => {
      try {
        const raw = await AsyncStorage.getItem(REELS_HIDDEN_KEY);
        if (raw) {
          const ids = JSON.parse(raw);
          if (Array.isArray(ids)) hiddenIdsRef.current = new Set(ids.map(String));
        }
      } catch {}
    })();
    return () => { if (hideToastTimerRef.current) clearTimeout(hideToastTimerRef.current); };
  }, []);

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
  //
  // [WAVE 43B 2026-05-20] Drena pool ANTES de restaurar a sessão de áudio.
  // setActive(false) com player vivo deixa frames residuais saírem; nilificar
  // o player primeiro garante silêncio antes da sessão desativar.
  useEffect(() => {
    if (isWeb) return undefined;
    try { setShortsAudioSessionPlaybackFn?.(); } catch {}
    return () => {
      try { releaseShortsPoolFn?.(); } catch {}
      try { restoreShortsAudioSessionFn?.(); } catch {}
    };
  }, []);

  // [reels-v1 2026-10-13] Uma página do ranking. null = indisponível (usa o feed antigo).
  const fetchRecPage = async (reset) => {
    if (!recSupportedRef.current) return null;
    try {
      const exclude = reset ? [] : (reelsRef.current || []).map((p) => p.id);
      const r = await api.reelsRecFeed({ cursor: reset ? null : recCursorRef.current, limit: 10, excludeIds: exclude });
      if (!r || r.success === false) {
        const msg = `${r?.message || ''} ${r?.data?.error || ''}`;
        if (/unknown|not_migrated/i.test(msg)) recSupportedRef.current = false;
        _reportReels('rec_feed_error', { state: reset ? 'first' : 'more', code: _reelErrCode(msg.trim() || 'no_response') });
        return null;
      }
      const d = r.data || {};
      recCursorRef.current = d.next_cursor || null;
      return { posts: Array.isArray(d.posts) ? d.posts : [], hasMore: !!d.has_more, onboarding: !!d.onboarding_needed };
    } catch (e) {
      _reportReels('rec_feed_error', { state: reset ? 'first' : 'more', code: _reelErrCode(e?.message) });
      return null;
    }
  };
  const interestsKey = `@chatyy:reels_interests_asked_v1:${String(user?.email || '').toLowerCase()}`;
  const maybeAskInterests = async () => {
    try {
      const asked = await AsyncStorage.getItem(interestsKey);
      if (!asked) setPickerMode('onboarding');
    } catch {}
  };
  const handlePickerDone = useCallback((selected) => {
    setPickerMode(null);
    try { AsyncStorage.setItem(interestsKey, '1'); } catch {}
    if (Array.isArray(selected) && selected.length) loadReels(true);
  }, [interestsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const loadReels = async (isRefresh = false) => {
    if (isRefresh) setRefreshing(true);
    else setLoading(true);
    // Fresh load → reset both feed cursors back to page 1.
    setPage(1);
    setFollowingPage(1);
    setHasMore(true);
    setFollowingHasMore(true);
    setLoadError(false);
    try {
      // Reels P0 — three load paths:
      //   1. soundIdProp set → "Use this sound" feed (chat_reels_by_sound)
      //   2. Following tab    → feedList({ type: 'following' }) for a strict
      //      chronological follows-only feed (no shared-conversation match)
      //   3. For You tab      → standard feedList() (contact-aware) for now;
      //      will swap to algorithm='fyp' once FYP ranker is GA.
      if (soundIdProp) {
        const r = await api.chatReelsBySound(soundIdProp, 1, 50);
        if (!r || !r.success) setLoadError(true); // [2026-10-08 apps-native]
        if (r && r.success && r.data) {
          const rawSound = Array.isArray(r.data.posts) ? r.data.posts : [];
          const videos = rawSound.filter(p => !hiddenIdsRef.current.has(String(p.id)));
          setReels(videos);
          setFollowingReels(videos);
          const more = rawSound.length >= 50;
          setHasMore(more);
          setFollowingHasMore(more);
        }
      } else {
        // Fire both feeds in parallel so switching tabs is instant.
        // [reels-v1 2026-10-13] "Para você" = ranking (reels_rec_feed); feedList só de fallback.
        let [allR, followR, recR] = await Promise.all([
          useRec ? Promise.resolve(null) : api.feedList({ page: 1, limit: 50 }),
          api.feedList({ page: 1, limit: 50, type: 'following' }),
          useRec ? fetchRecPage(true) : Promise.resolve(null),
        ]);
        if (useRec && !recR) allR = await api.feedList({ page: 1, limit: 50 });
        recModeRef.current = !!recR;
        setRecActive(!!recR);
        if (recR) {
          setReels(recR.posts.filter(p => !hiddenIdsRef.current.has(String(p.id))));
          setHasMore(recR.hasMore);
          if (recR.onboarding) maybeAskInterests();
        }
        // [2026-10-08 apps-native] as duas falharam → erro (não "vazio")
        if (!recR && (!allR || !allR.success) && (!followR || !followR.success)) {
          setLoadError(true);
          _reportReels('feed_error', { state: 'load', code: _reelErrCode(allR?.message || followR?.message || 'no_response') });
        }
        if (allR && allR.success && allR.data) {
          const rawPosts = allR.data.posts || allR.data;
          const allPosts = Array.isArray(rawPosts) ? rawPosts : [];
          const videos = allPosts.filter(p => isReelVideo(p) && !hiddenIdsRef.current.has(String(p.id)));
          setReels(videos);
          // Base has-more on the *raw* page size (pre video-filter) so a page
          // full of non-video posts doesn't prematurely stop pagination.
          setHasMore(allPosts.length >= 50);
        }
        if (followR && followR.success && followR.data) {
          const rawF = followR.data.posts || followR.data;
          const followingAll = Array.isArray(rawF) ? rawF : [];
          const followingVids = followingAll.filter(p => isReelVideo(p) && !hiddenIdsRef.current.has(String(p.id)));
          setFollowingReels(followingVids);
          setFollowingHasMore(followingAll.length >= 50);
        }
      }
    } catch (e) {
      console.warn('Reels load error:', e);
      setLoadError(true); // [2026-10-08 apps-native]
      _reportReels('feed_error', { state: 'exception', code: _reelErrCode(e?.message) });
    } finally {
      setLoading(false);
      setRefreshing(false);
      try { onPullRefresh && isRefresh && onPullRefresh(); } catch {}
    }
  };

  const handleRefresh = useCallback(() => loadReels(true), []);

  // ── Infinite scroll (P0) — fetch the next page for whichever tab is active
  // and append it, deduping by id (mirrors ChatFeedTab.loadPosts existingIds
  // merge). The loadingMoreRef single-flight guard stops FlatList from firing
  // a second onEndReached while a fetch is already in flight. By-sound feeds
  // (soundIdProp) page through chat_reels_by_sound; the two standard tabs use
  // feedList with type='following' for the Following tab.
  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current) return;
    const isFollowing = reelTab === 'following';
    // [#tab-switch-fix] Guard against the empty-list transition: when the user
    // flips tabs, activeReels momentarily becomes the other tab's array which
    // may be empty for a frame. FlatList fires onEndReached on an empty list
    // (offset 0 == "end"), which used to kick off a spurious page-2 fetch and
    // double pagination. Bail when the active tab has no reels yet — loadReels
    // owns the page-1 load.
    const activeLen = isFollowing ? followingReels.length : reels.length;
    if (activeLen === 0) return;
    const moreAvailable = isFollowing ? followingHasMore : hasMore;
    if (!moreAvailable) return;
    const nextPage = (isFollowing ? followingPage : page) + 1;
    loadingMoreRef.current = true;
    try {
      let rawPosts = [];
      let recHasMore = null;
      if (soundIdProp) {
        const r = await api.chatReelsBySound(soundIdProp, nextPage, 50);
        if (r && r.success && r.data) rawPosts = Array.isArray(r.data.posts) ? r.data.posts : [];
      } else if (!isFollowing && recModeRef.current) {
        // [reels-v1 2026-10-13] próxima página do ranking (cursor + exclude dos já carregados)
        const rp = await fetchRecPage(false);
        if (rp) { rawPosts = rp.posts; recHasMore = rp.hasMore; } else { recHasMore = false; }
      } else {
        const args = { page: nextPage, limit: 50 };
        if (isFollowing) args.type = 'following';
        const r = await api.feedList(args);
        if (r && r.success && r.data) {
          const raw = r.data.posts || r.data;
          rawPosts = Array.isArray(raw) ? raw : [];
        }
      }
      const newVideos = rawPosts.filter(p => isReelVideo(p) && !hiddenIdsRef.current.has(String(p.id)));
      const setList = isFollowing ? setFollowingReels : setReels;
      setList(prev => {
        const existingIds = new Set(prev.map(p => p.id));
        const unique = newVideos.filter(p => !existingIds.has(p.id));
        if (unique.length === 0) return prev;
        return [...prev, ...unique];
      });
      // Cursor + has-more bookkeeping. Base has-more on the *raw* page size so
      // a page full of non-video posts doesn't prematurely halt pagination.
      const more = recHasMore !== null ? recHasMore : rawPosts.length >= 50;
      if (isFollowing) {
        setFollowingPage(nextPage);
        setFollowingHasMore(more);
        if (soundIdProp) setPage(nextPage);
      } else {
        setPage(nextPage);
        setHasMore(more);
      }
    } catch (e) {
      console.warn('Reels loadMore error:', e);
    } finally {
      loadingMoreRef.current = false;
    }
  }, [reelTab, page, followingPage, hasMore, followingHasMore, soundIdProp, reels.length, followingReels.length]);

  const handleOpenComments = useCallback((reel) => {
    setCommentsReel(reel);
  }, []);

  const handleOpenLikers = useCallback((reel) => {
    setLikersReel(reel);
  }, []);

  // FeedComments fires this whenever a comment is added/removed so the
  // right-rail count (reads reel.comment_count at ~2030) refreshes live.
  // Update both feed arrays + the open commentsReel so the sheet header
  // and the rail stay in sync.
  const commentsReelRef = useRef(null);
  commentsReelRef.current = commentsReel;
  const handleCommentCountChange = useCallback((newCount) => {
    const cur = commentsReelRef.current; // [reels-v1] comentou = sinal forte
    if (cur && Number(newCount) > (Number(cur.comment_count ?? cur.comments_count) || 0)) { try { trackReelEvent(cur.id, 'comment'); } catch {} }
    setCommentsReel(prev => {
      if (!prev) return prev;
      const id = prev.id;
      const patch = (p) => (p.id === id ? { ...p, comment_count: newCount } : p);
      setReels(rs => rs.map(patch));
      setFollowingReels(rs => rs.map(patch));
      return { ...prev, comment_count: newCount };
    });
  }, []);

  // [#like-count-sync] When a ReelItem toggles its like, patch the parent feed
  // arrays so the optimistic like (user_liked + like_count) survives FlatList
  // recycling. Without this, the ReelItem's own sync effect (keyed on
  // reel.user_liked / reel.like_count) would reset the heart + count back to
  // the stale prop the next time the row re-mounts or the prop object changes —
  // i.e. swipe away and back and the like vanished. We patch BOTH arrays since
  // the same reel can appear in For You and Following.
  const handleReelLikeChange = useCallback((reelId, nextLiked, nextCount) => {
    const patch = (p) => (p.id === reelId
      ? { ...p, user_liked: nextLiked, like_count: nextCount }
      : p);
    setReels(rs => rs.map(patch));
    setFollowingReels(rs => rs.map(patch));
  }, []);

  const onLayout = useCallback((e) => {
    const h = e.nativeEvent.layout.height;
    const w = e.nativeEvent.layout.width;
    if (h > 0) setContainerHeight(h);
    if (w > 0) setContainerWidth(w);
  }, []);
  // [2026-10-11 social-qa] Web: o onLayout do reelsRoot não chegava (QA: item
  // ficava com a altura da JANELA 844 dentro de um container de 709 → legenda,
  // @autor e barra de progresso escondidos atrás da tab bar e o paging
  // desalinhado). ResizeObserver direto no nó DOM garante a altura real.
  const _rootRoRef = useRef(null);
  const setRootRef = useCallback((el) => {
    if (!isWeb) return;
    try { _rootRoRef.current?.disconnect?.(); } catch {}
    _rootRoRef.current = null;
    if (!el || typeof el.getBoundingClientRect !== 'function') return;
    const apply = () => {
      try {
        const r = el.getBoundingClientRect();
        if (r.height > 0) setContainerHeight(Math.round(r.height));
        if (r.width > 0) setContainerWidth(Math.round(r.width));
      } catch {}
    };
    apply();
    if (typeof ResizeObserver !== 'undefined') {
      try { const ro = new ResizeObserver(apply); ro.observe(el); _rootRoRef.current = ro; } catch {}
    }
  }, []);
  useEffect(() => () => { try { _rootRoRef.current?.disconnect?.(); } catch {} }, []);

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

  // Reset index when switching tabs.
  // [#tab-switch-fix] Also clear the loadingMoreRef single-flight guard so the
  // empty-list transition between tabs (activeReels momentarily swaps to the
  // other tab's array) can't leave a stale in-flight flag that double-fires
  // onEndReached. The currentIndex reset is *also* re-run via a useEffect keyed
  // on reelTab below (after activeReels has actually swapped) to avoid the
  // off-by-N where the FlatList paints the new tab's data against the old index.
  const handleTabChange = useCallback((tab) => {
    try { haptic.select(); } catch {} // [2026-10-08 apps-native]
    setReelTab(tab);
    setCurrentIndex(0);
    loadingMoreRef.current = false;
    if (listRef.current) {
      try { listRef.current.scrollToOffset({ offset: 0, animated: false }); } catch {}
    }
  }, []);

  // [#tab-switch-fix] currentIndex must snap back to 0 *after* activeReels has
  // swapped to the newly-selected tab's array. Doing it only inside
  // handleTabChange races the render: setReelTab queues a state change that
  // swaps activeReels on the next render, but the FlatList briefly evaluated
  // renderItem with the new data and the old currentIndex (off-by-N — wrong
  // video flashed as "active"). Keying this on reelTab guarantees the reset
  // lands in the same commit as the array swap. Also re-scrolls to top.
  useEffect(() => {
    setCurrentIndex(0);
    loadingMoreRef.current = false;
    if (listRef.current) {
      try { listRef.current.scrollToOffset({ offset: 0, animated: false }); } catch {}
    }
  }, [reelTab]);

  const handleOpenProfile = useCallback((email, item) => {
    if (item?.is_catalog) { const u = item.credit?.author_url || item.credit?.page_url; if (u) { try { Linking.openURL(u); } catch {} } return; } // [reels-v1]
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

  // ── Reels P0/P2: Not interested — soft-hide for the current viewer.
  // The backend feed_hide_post action may not be live yet, so we ALSO persist
  // the hidden id locally (AsyncStorage) and surface a toast so the action is
  // never a silent no-op. Locally-hidden ids are filtered out of future loads
  // via hiddenIdsRef (see loadReels-side filter), so the reel stays gone even
  // across refreshes regardless of whether the server recorded the signal.
  const handleHidePost = useCallback(async (reel, signal = 'not_interested') => {
    if (!reel?.id) return;
    try { trackReelEvent(reel.id, 'not_interested'); } catch {} // [reels-v1] sinal negativo forte no perfil
    // Best-effort server signal — ignore failures, the local hide is authoritative.
    try { await api.feedHidePost?.(reel.id, signal); } catch {}
    // Persist locally so the reel stays hidden across sessions.
    try {
      hiddenIdsRef.current.add(String(reel.id));
      await AsyncStorage.setItem(
        REELS_HIDDEN_KEY,
        JSON.stringify([...hiddenIdsRef.current]),
      );
    } catch {}
    // Optimistically drop the reel from the active list so it disappears now.
    setReels(prev => prev.filter(p => p.id !== reel.id));
    setFollowingReels(prev => prev.filter(p => p.id !== reel.id));
    // Visible confirmation (toast) — auto-dismisses after ~2s.
    const msg = signal === 'reported'
      ? (t?.('feed.reportThanks') || 'Obrigado, vamos revisar.')
      : (t?.('feed.notInterestedDone') || 'Você verá menos desse tipo.');
    if (Platform.OS === 'android' && ToastAndroid?.show) {
      try { ToastAndroid.show(msg, ToastAndroid.SHORT); return; } catch {}
    }
    setHideToast(msg);
    if (hideToastTimerRef.current) clearTimeout(hideToastTimerRef.current);
    hideToastTimerRef.current = setTimeout(() => setHideToast(''), 2200);
  }, [t]);

  const overlayOpen = !!commentsReel || !!likersReel || !!pickerMode;

  // [reels-v1 2026-10-13] Tempo assistido por impressão (relógio de parede enquanto o reel
  // está ativo, a aba visível, o app em 1º plano e sem sheet por cima). Ao trocar de reel ou
  // sair da aba → trackReelView(id, watch_ms, duração) → servidor deriva pulo (<2 s), % assistido
  // e replay. Envio em lote (services/reelsSignals).
  const watchRef = useRef({ id: null, accum: 0, since: 0, dur: 0 });
  useEffect(() => {
    const w = watchRef.current;
    const now = Date.now();
    const reel = Array.isArray(activeReels) ? activeReels[currentIndex] : null;
    const gateOpen = playGate && !overlayOpen;
    const id = reel && gateOpen ? reel.id : null;
    if (w.since) { w.accum += now - w.since; w.since = 0; }
    if (w.id !== id) {
      if (w.id != null) { try { trackReelView(w.id, w.accum, w.dur); } catch {} }
      w.id = id; w.accum = 0;
      w.dur = reel ? (Number(reel.video_duration_ms) || 0) : 0;
    }
    if (id != null) w.since = now;
  }, [currentIndex, activeReels, playGate, overlayOpen]);
  useEffect(() => () => {
    const w = watchRef.current;
    if (w.id != null) { if (w.since) w.accum += Date.now() - w.since; try { trackReelView(w.id, w.accum, w.dur); } catch {} }
    try { flushReelSignals(); } catch {}
  }, []);
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
        containerWidth={containerWidth}
        onOpenComments={handleOpenComments}
        onOpenLikers={handleOpenLikers}
        onOpenProfile={handleOpenProfile}
        onUseSound={handleUseSound}
        onDuet={handleDuet}
        onStitch={handleStitch}
        onHidePost={handleHidePost}
        onLikeChange={handleReelLikeChange}
        showLiveRing={!!showLiveRing}
        overlayOpen={overlayOpen}
        preload={isPreloadItem}
        screenFocused={playGate}
        muted={muted}
        onToggleMute={handleToggleMute}
        onCreate={onCreate}
      />
    );
  }, [currentIndex, colors, isDark, t, user, router, containerHeight, containerWidth, handleOpenComments, handleOpenLikers, handleOpenProfile, handleUseSound, handleDuet, handleStitch, handleHidePost, handleReelLikeChange, showLiveRing, overlayOpen, playGate, muted, handleToggleMute, onCreate]);

  const keyExtractor = useCallback((item) => String(item.id), []);

  // [2026-10-11 social-qa] Desktop web: ↑/↓ (e PageUp/PageDown) trocam de reel,
  // como Instagram/TikTok web. Antes só a roda do mouse — e no desktop ela não
  // avançava (QA: rolou 40px e voltou). Ignora quando digitando ou com sheet aberta.
  useEffect(() => {
    if (!isWeb || typeof window === 'undefined' || !parentActive) return undefined;
    const onKey = (e) => {
      const tg = e?.target; const tag = String(tg?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tg?.isContentEditable) return;
      if (overlayOpen) return;
      let d = 0;
      if (e.key === 'ArrowDown' || e.key === 'PageDown') d = 1;
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') d = -1;
      else return;
      const len = Array.isArray(activeReels) ? activeReels.length : 0;
      const n = Math.max(0, Math.min(len - 1, currentIndex + d));
      if (n === currentIndex || len === 0) return;
      try { e.preventDefault(); } catch {}
      try { listRef.current?.scrollToOffset?.({ offset: n * containerHeight, animated: true }); } catch {}
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [parentActive, currentIndex, activeReels, containerHeight, overlayOpen]);

  if (loading) {
    return (
      // [2026-10-13 reels-visual] skeleton em forma de reel (cabeçalho + trilho + legenda), pulsando — sem spinner cru
      <ReelsSkeleton insets={outerInsets} />
    );
  }

  // [2026-10-08 apps-native] só early-return quando AMBAS as abas estão vazias
  // (antes: "Pra você" vazio escondia "Seguindo" com conteúdo). Com retry.
  if (reels.length === 0 && followingReels.length === 0) {
    return (
      <View style={styles.loadingContainer}>
        <EmptyReels colors={colors} isDark={isDark} t={t} error={loadError} onRetry={() => loadReels(false)} onCreate={onCreate} />
        <ReelsInterestPicker visible={!!pickerMode} mode={pickerMode || 'onboarding'} t={t} onDone={handlePickerDone} onClose={() => setPickerMode(null)} />
      </View>
    );
  }

  return (
    <View ref={setRootRef} style={styles.reelsRoot} onLayout={onLayout}>
      {/* [2026-10-13 reels-visual] Cabeçalho único (TikTok/Instagram): abas centralizadas com
          indicador; à direita interesses + criar, espaçados. Mudo saiu do topo (canto inferior). */}
      <View style={[styles.reelHeader, { top: reelHeaderTop(outerInsets) }]} pointerEvents="box-none">
        <View style={styles.reelTabBar} pointerEvents="box-none">
          <Pressable
            onPress={() => { if (reelTab !== 'following') handleTabChange('following'); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="tab"
            accessibilityState={{ selected: reelTab === 'following' }}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={[
              styles.reelTabText,
              reelTab === 'following' && styles.reelTabTextActive,
            ]}>
              {t('feed.followingReels') || 'Following'}
            </Text>
            <View style={[styles.reelTabIndicator, reelTab !== 'following' && { backgroundColor: 'transparent' }]} />
          </Pressable>
          <Pressable
            onPress={() => { if (reelTab !== 'forYou') handleTabChange('forYou'); }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            accessibilityRole="tab"
            accessibilityState={{ selected: reelTab === 'forYou' }}
            style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
          >
            <Text style={[
              styles.reelTabText,
              reelTab === 'forYou' && styles.reelTabTextActive,
            ]}>
              {t('feed.forYou') || 'For You'}
            </Text>
            <View style={[styles.reelTabIndicator, reelTab !== 'forYou' && { backgroundColor: 'transparent' }]} />
          </Pressable>
        </View>
        <View style={styles.reelHeaderRight} pointerEvents="box-none">
          {recActive && reelTab === 'forYou' ? (
            <Pressable
              onPress={() => { try { haptic.select(); } catch {} setPickerMode('manage'); }}
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              accessibilityRole="button"
              accessibilityLabel={t('reels.interests.manageTitle') || 'Seus interesses'}
              style={({ pressed }) => [styles.reelHeaderIconBtn, { opacity: pressed ? 0.6 : 1 }]}
            >
              <IconSliders size={21} color="#fff" />
            </Pressable>
          ) : null}
          {!!onCreate && (
            <PressableScale
              onPress={onCreate}
              activeOpacity={0.85}
              scaleTo={0.9}
              hitSlop={{ top: 8, bottom: 8, left: 6, right: 6 }}
              accessibilityLabel={t?.('reels.create') || 'Criar reel'}
              accessibilityRole="button"
              style={styles.reelHeaderIconBtn}
            >
              <IconCamera size={23} color="#fff" />
              <View style={styles.reelCreatePlus}><IconPlus size={9} color="#000" /></View>
            </PressableScale>
          )}
        </View>
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
        onEndReached={loadMore}
        onEndReachedThreshold={0.5}
        getItemLayout={(data, index) => ({
          length: containerHeight,
          offset: containerHeight * index,
          index,
        })}
        initialNumToRender={2}
        maxToRenderPerBatch={2}
        windowSize={3}
        // [perf] Spread the off-screen mounting work across a couple of frames
        // instead of one big synchronous batch — keeps the swipe gesture from
        // dropping frames while the next reel mounts. windowSize=3 already caps
        // mounted rows to active±1 so only the active + 1 preload video exist.
        updateCellsBatchingPeriod={60}
        removeClippedSubviews={Platform.OS !== 'web'}
        onRefresh={handleRefresh}
        refreshing={refreshing}
        ListEmptyComponent={
          // Surface an empty state for *every* tab — silently rendering
          // null on Discover/For You looked like a hung load.
          // [2026-10-08 apps-native] EmptyReels unificado + retry/erro.
          <View style={[styles.loadingContainer, { height: containerHeight }]}>
            <EmptyReels t={t} error={loadError} following={reelTab === 'following'} onRetry={() => loadReels(false)} onCreate={onCreate} onSeeForYou={() => handleTabChange('forYou')} />
          </View>
        }
      />

      {/* Comments bottom sheet — full-featured FeedComments (pagination,
          threading, voice/sticker/video replies, WS live comments, count
          sync). Visibility still keyed off commentsReel so overlayOpen keeps
          auto-pausing the active reel while the sheet is open. */}
      <FeedComments
        visible={!!commentsReel}
        post={commentsReel}
        colors={colors}
        isDark={isDark}
        t={t}
        user={user}
        onClose={() => setCommentsReel(null)}
        onCommentCountChange={handleCommentCountChange}
      />

      {/* [reels-v1 2026-10-13] cold start (1º acesso) / "Seus interesses" */}
      <ReelsInterestPicker visible={!!pickerMode} mode={pickerMode || 'onboarding'} t={t} onDone={handlePickerDone} onClose={() => setPickerMode(null)} />

      {/* Likers bottom sheet */}
      <LikersSheet
        visible={!!likersReel}
        post={likersReel}
        colors={colors}
        isDark={isDark}
        t={t}
        onClose={() => setLikersReel(null)}
      />

      {/* "Não tenho interesse" / report confirmation toast (iOS + web; Android
          uses the native ToastAndroid in handleHidePost). */}
      {!!hideToast && (
        <View pointerEvents="none" style={styles.hideToast}>
          <Text style={styles.hideToastText} numberOfLines={2}>{hideToast}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  // [2026-10-13 reels-android] erro do player (sobre o vídeo, centro)
  reelErrorWrap: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, backgroundColor: 'rgba(0,0,0,0.35)' },
  reelErrorText: { color: '#fff', fontSize: 15, fontWeight: '600', textAlign: 'center', marginBottom: 14, ...TEXT_SHADOW },
  reelErrorBtn: { paddingHorizontal: 22, paddingVertical: 10, borderRadius: 22, backgroundColor: 'rgba(255,255,255,0.18)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.6)' },
  reelErrorBtnText: { color: '#fff', fontSize: 15, fontWeight: '700' },
  // ── Root ──
  reelsRoot: {
    flex: 1,
    backgroundColor: '#000',
  },
  // [reels-v1 2026-10-13] crédito da fonte + botão de interesses
  creditText: {
    color: 'rgba(255,255,255,0.72)',
    fontSize: 12,
    fontWeight: '500',
    marginTop: -4,
    marginBottom: 0,
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  interestsBtn: {
    position: 'absolute',
    right: 10,
    zIndex: 21,
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingContainer: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  hideToast: {
    position: 'absolute',
    bottom: 90,
    left: 24,
    right: 24,
    backgroundColor: 'rgba(0,0,0,0.85)',
    borderRadius: 14,
    paddingVertical: 12,
    paddingHorizontal: 18,
    alignItems: 'center',
    zIndex: 50,
  },
  hideToastText: {
    color: '#fff',
    fontSize: 14,
    fontWeight: '600',
    textAlign: 'center',
  },
  reelContainer: {
    backgroundColor: '#000',
    position: 'relative',
    overflow: 'hidden',
  },
  // web desktop: deixa o trilho (right negativo) aparecer ao lado da coluna 9:16
  reelContainerDesktop: {
    overflow: 'visible',
  },

  // ── Gradient overlays ──
  topGradient: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: 170,
    background: isWeb ? 'linear-gradient(to bottom, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.18) 55%, transparent 100%)' : undefined,
    backgroundColor: isWeb ? undefined : 'transparent',
    zIndex: 1,
  },
  bottomGradient: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    height: 340,
    background: isWeb ? 'linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.25) 50%, transparent 100%)' : undefined,
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
    paddingTop: Platform.OS === 'ios' ? 54 : androidTopInset(16),
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
    width: 52,
    alignItems: 'center',
    zIndex: 10,
    gap: 14,
  },
  // [2026-10-13 reels-visual] item do trilho (ícone + contagem) sempre centrado
  sidebarItem: {
    alignItems: 'center',
    width: 52,
  },
  // sombra sutil no ícone (legível em vídeo claro): iOS usa a alfa do conteúdo; web drop-shadow
  sidebarIcon: {
    alignItems: 'center',
    justifyContent: 'center',
    ...(isWeb
      ? { filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.55))' }
      : { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.45, shadowRadius: 3 }),
  },
  // mudo discreto no canto inferior direito (saiu do cabeçalho)
  muteChip: {
    position: 'absolute',
    right: 16,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.42)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,255,255,0.22)',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 11,
  },
  profileAvatarBtn: {
    alignItems: 'center',
    marginBottom: 6,
  },
  profileAvatarRing: {
    borderWidth: 2,
    borderColor: '#fff',
    borderRadius: 20,
    padding: 1,
    overflow: 'hidden',
    ...(isWeb ? {} : { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.4, shadowRadius: 4 }),
  },
  profileFollowBadge: {
    position: 'absolute',
    bottom: -6,
    // [2026-10-13 visual] P&B brand: white badge / black plus (was pink #FF2D55)
    backgroundColor: '#fff',
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: '#000',
  },
  profileFollowPlus: {
    color: '#000',
    fontSize: 13,
    fontWeight: '800',
    lineHeight: 15,
    marginTop: -1,
  },
  sidebarBtn: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 52,
    minHeight: 44,
    gap: 3,
  },
  // Bumped from 12/600 → 11/700 with stronger shadow so the count reads as
  // a label glued to the icon (TikTok pattern) instead of floating text.
  sidebarCount: {
    color: '#fff',
    fontSize: 12.5,
    fontWeight: '600',
    textAlign: 'center',
    letterSpacing: 0.1,
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
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.2,
    ...TEXT_SHADOW,
  },
  caption: {
    color: '#fff',
    fontSize: 14,
    lineHeight: 19.5,
    ...TEXT_SHADOW,
  },
  moreText: {
    color: 'rgba(255,255,255,0.78)',
    fontSize: 14,
    fontWeight: '600',
    marginTop: 3,
    ...TEXT_SHADOW,
  },

  // ── Music row ──
  musicRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginTop: 2,
    // não encosta no mudo (canto inferior direito)
    marginRight: 6,
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
  marqueeMeasure: {
    position: 'absolute',
    left: 0,
    top: 0,
    width: 4000,
    flexDirection: 'row',
    opacity: 0,
  },
  marqueeText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
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
    // [2026-10-10 feed-polish] was #111 on the video/black track → invisible.
    backgroundColor: '#ffffff',
    borderRadius: 1.5,
    ...(isWeb ? {
      boxShadow: '0 0 6px rgba(0,0,0,0.35)',
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
    gap: 14,
    paddingHorizontal: 40,
  },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.2)',
    backgroundColor: 'rgba(255,255,255,0.04)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: -0.2,
    color: '#fff',
    textAlign: 'center',
  },
  emptySubtext: {
    color: 'rgba(255,255,255,0.55)',
    fontSize: 13.5,
    lineHeight: 19,
    textAlign: 'center',
  },
  // [2026-10-08 apps-native] pill branco (P&B) do retry
  emptyRetryBtn: {
    marginTop: 10,
    paddingHorizontal: 22,
    paddingVertical: 11,
    borderRadius: 999,
    backgroundColor: '#fff',
  },
  emptyRetryText: {
    color: '#000',
    fontSize: 14,
    fontWeight: '700',
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
  // [2026-10-13 reels-visual] cabeçalho: abas centradas + ações à direita (sem sobreposição)
  reelHeader: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: REEL_HEADER_H,
    zIndex: 20,
    justifyContent: 'center',
  },
  reelTabBar: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 92,
    right: 92,
    flexDirection: 'row',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 22,
  },
  reelHeaderRight: {
    position: 'absolute',
    right: 8,
    top: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  reelHeaderIconBtn: {
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    ...(isWeb ? { filter: 'drop-shadow(0 1px 3px rgba(0,0,0,0.55))' } : { shadowColor: '#000', shadowOffset: { width: 0, height: 1 }, shadowOpacity: 0.45, shadowRadius: 3 }),
  },
  reelCreatePlus: {
    position: 'absolute',
    right: 5,
    bottom: 7,
    width: 13,
    height: 13,
    borderRadius: 6.5,
    backgroundColor: '#fff',
    alignItems: 'center',
    justifyContent: 'center',
  },
  reelTabText: {
    color: 'rgba(255,255,255,0.62)',
    fontSize: 16,
    fontWeight: '600',
    letterSpacing: -0.1,
    textAlign: 'center',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  reelTabTextActive: {
    color: '#fff',
    fontWeight: '800',
  },
  reelTabIndicator: {
    width: 20,
    height: 2.5,
    borderRadius: 2,
    backgroundColor: '#fff',
    alignSelf: 'center',
    marginTop: 6,
    ...(isWeb ? { boxShadow: '0 0 8px rgba(255,255,255,0.5)' } : {}),
  },

  // ── 2× Boost toast (long-press) ──
  // Floats below the top bar so it doesn't fight the tab row. Brand purple
  // pill with a single "2×" label — minimal, TikTok-style.
  boostToast: {
    position: 'absolute',
    top: Platform.OS === 'ios' ? 100 : androidTopInset(70),
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 25,
  },
  boostToastBg: {
    backgroundColor: 'rgba(17, 17, 17,0.92)',
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
