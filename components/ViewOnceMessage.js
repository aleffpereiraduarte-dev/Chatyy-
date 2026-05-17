import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Modal, Pressable,
  Image, ActivityIndicator, Platform, StatusBar as RNStatusBar, BackHandler,
} from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { IconEye, IconLock, IconVideo, IconCheck, IconX, IconMic, IconPlay, IconPause } from './Icons';

let _expoVideoMod = null;
function loadExpoVideo() {
  if (_expoVideoMod !== null) return _expoVideoMod;
  try { _expoVideoMod = require('expo-video'); }
  catch { _expoVideoMod = false; }
  return _expoVideoMod;
}

let _expoAudioMod = null;
function loadExpoAudio() {
  if (_expoAudioMod !== null) return _expoAudioMod;
  try { _expoAudioMod = require('expo-audio'); }
  catch { _expoAudioMod = false; }
  return _expoAudioMod;
}

const VIEWED_KEY = 'chatyy.viewOnceViewed.v1';

async function _loadLocalViewed() {
  try {
    const raw = await AsyncStorage.getItem(VIEWED_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.map(String) : []);
  } catch { return new Set(); }
}
async function _markLocalViewed(id) {
  try {
    const raw = await AsyncStorage.getItem(VIEWED_KEY);
    const arr = raw ? (JSON.parse(raw) || []) : [];
    const set = new Set(arr.map(String));
    set.add(String(id));
    const next = Array.from(set).slice(-2000);
    await AsyncStorage.setItem(VIEWED_KEY, JSON.stringify(next));
  } catch {}
}

const _parseViewedBy = (raw) => {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
};

function FullscreenVideoPlayer({ uri, onLoaded, onEnded, onError }) {
  const mod = loadExpoVideo();
  if (!mod || !mod.useVideoPlayer || !mod.VideoView) {
    onError?.(new Error('expo-video unavailable'));
    return null;
  }
  const { useVideoPlayer, VideoView } = mod;
  const loadedRef = useRef(false);
  const endedRef = useRef(false);

  const player = useVideoPlayer(uri, (p) => {
    p.loop = false;
    try { const r = p.play?.(); if (r?.catch) r.catch(() => {}); } catch {}
  });

  useEffect(() => {
    if (!player) return;
    const subStatus = player.addListener?.('statusChange', (e) => {
      const status = e?.status || e;
      if ((status === 'readyToPlay' || status === 'playing') && !loadedRef.current) {
        loadedRef.current = true;
        onLoaded?.();
      }
      if (status === 'error') onError?.(e?.error || new Error('video error'));
    });
    const subEnded = player.addListener?.('ended', () => {
      if (!endedRef.current) { endedRef.current = true; onEnded?.(); }
    });
    return () => {
      try { subStatus?.remove?.(); subEnded?.remove?.(); } catch {}
      // Defensive teardown — expo-video's hook auto-disposes the player on
      // unmount, but on rapid open/close cycles (multiple view-once views in
      // a row) the AVPlayer/MediaCodec buffer can stay resident long enough
      // to push iPad/low-RAM Android into GC pressure. Pause + release the
      // source explicitly so resources are reclaimed before the next modal
      // mounts a fresh player.
      try { player.pause?.(); } catch {}
      try { player.replace?.(null); } catch {}
      try { player.release?.(); } catch {}
    };
  }, [player, onLoaded, onEnded, onError]);

  return (
    <VideoView
      player={player}
      style={{ flex: 1, width: '100%', backgroundColor: '#000' }}
      contentFit="contain"
      nativeControls={false}
      allowsFullscreen={false}
    />
  );
}

function ViewOnceFullscreen({ uri, isVideo, t, senderName, onClose, onLoaded, onError }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  // Android back closes modal — mirror iOS X close
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose?.();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const handleLoaded = useCallback(() => {
    if (loaded) return;
    setLoaded(true);
    onLoaded?.();
  }, [loaded, onLoaded]);

  const handleError = useCallback((e) => {
    setErrored(true);
    onError?.(e);
  }, [onError]);

  return (
    <Modal
      visible={true}
      transparent={false}
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
      hardwareAccelerated
    >
      <View style={fs.root}>
        {Platform.OS === 'android' ? (
          <RNStatusBar barStyle="light-content" backgroundColor="rgba(0,0,0,0.6)" translucent />
        ) : null}

        {/* Top header — sender + view-once badge */}
        <View style={[fs.header, { paddingTop: Platform.OS === 'android' ? 36 : 56 }]}>
          <Pressable
            onPress={onClose}
            hitSlop={16}
            style={({ pressed }) => [fs.closeBtn, pressed && { opacity: 0.6 }]}
            accessibilityRole="button"
            accessibilityLabel={t?.('common.close') || 'Fechar'}
          >
            <IconX size={26} color="#fff" />
          </Pressable>
          <View style={fs.headerCenter} pointerEvents="none">
            {senderName ? (
              <Text style={fs.senderName} numberOfLines={1}>{senderName}</Text>
            ) : null}
            <View style={fs.badgeRow}>
              <IconLock size={12} color="rgba(255,255,255,0.85)" />
              <Text style={fs.badgeText}>
                {(isVideo
                  ? (t?.('chatConv.viewOnceVideo') || 'Vídeo')
                  : (t?.('chatConv.viewOncePhoto') || 'Foto')) +
                  ' · ' +
                  (t?.('chatConv.viewOnce') || 'Visualização única')}
              </Text>
            </View>
          </View>
          <View style={fs.closeBtn} />
        </View>

        {/* Content area */}
        <View style={fs.contentWrap}>
          {!!uri && isVideo ? (
            <FullscreenVideoPlayer
              uri={uri}
              onLoaded={handleLoaded}
              onEnded={onClose}
              onError={handleError}
            />
          ) : !!uri ? (
            <Image
              source={{ uri }}
              style={fs.fullImage}
              resizeMode="contain"
              onLoad={handleLoaded}
              onError={handleError}
            />
          ) : (
            <View style={fs.errorBox}>
              <Text style={fs.errorText}>
                {t?.('chatConv.viewOnceMissing') || 'Mídia indisponível'}
              </Text>
            </View>
          )}

          {!loaded && !errored ? (
            <View style={fs.spinnerWrap} pointerEvents="none">
              <ActivityIndicator size="large" color="#fff" />
            </View>
          ) : null}

          {errored ? (
            <View style={fs.errorOverlay}>
              <Text style={fs.errorText}>
                {t?.('chatConv.viewOnceLoadFailed') || 'Não foi possível carregar a mídia'}
              </Text>
              <TouchableOpacity
                onPress={onClose}
                style={fs.errorBtn}
                accessibilityRole="button"
              >
                <Text style={fs.errorBtnText}>
                  {t?.('common.close') || 'Fechar'}
                </Text>
              </TouchableOpacity>
            </View>
          ) : null}
        </View>

        {/* Bottom hint — reinforce one-shot semantics */}
        {loaded && !errored ? (
          <View style={fs.bottomHint} pointerEvents="none">
            <IconLock size={14} color="rgba(255,255,255,0.85)" />
            <Text style={fs.bottomHintText}>
              {t?.('chatConv.viewOnceHint') || 'Foto/vídeo só pode ser visto uma vez'}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

/**
 * View Once Message — strict WhatsApp semantics:
 *  - Sender: NEVER opens. Always sees a locked pill ("Foto · Visualização única",
 *    or "Aberta" if a recipient already opened). No tap target.
 *  - Receiver unviewed: Tap pill → fullscreen modal opens. Photo stays open
 *    until user dismisses (X / Android back). Video plays once and auto-closes.
 *    Mark-as-viewed fires only on real onLoad success — if media fails the
 *    user can retry and the pill stays tap-to-view.
 *  - Receiver viewed: locked "Aberta" / "Expirou" pill, no re-open.
 */
export default function ViewOnceMessage({ msg, colors = {}, isOwn, onView, t, currentEmail }) {
  const safeColors = {
    surface: '#fff',
    border: '#e0e0e0',
    primary: '#7C3AED',
    textTertiary: '#999',
    textSecondary: '#666',
    text: '#000',
    ...colors,
  };

  const fileUrl = msg?.file_url || null;
  // Audio detection MUST come before video — a `.webm` voice note hits the
  // video extension regex otherwise and gets rendered with VideoView (black
  // screen, no audible playback). Voice notes use msg.type === 'audio' or
  // 'voice'; the extension check (.m4a/.opus/.ogg/.mp3/.aac/.wav) is the
  // belt-and-suspenders fallback for legacy rows that left type unset.
  const isAudio = (msg?.type === 'audio' || msg?.type === 'voice') ||
    /\.(m4a|opus|ogg|mp3|aac|wav)(\?|$)/i.test(String(fileUrl || ''));
  const isVideo = !isAudio && (
    (msg?.type === 'video') ||
    /\.(mp4|mov|webm|mkv|avi|m4v|3gp)(\?|$)/i.test(String(fileUrl || ''))
  );

  const vb = _parseViewedBy(msg?.viewed_by);
  const meLower = String(currentEmail || '').toLowerCase();
  const vbHasMe = !!meLower && vb.map(e => String(e || '').toLowerCase()).includes(meLower);
  const vbHasAny = vb.length > 0;

  const [localViewed, setLocalViewed] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const set = await _loadLocalViewed();
      if (alive && msg?.id != null && set.has(String(msg.id))) setLocalViewed(true);
    })();
    return () => { alive = false; };
  }, [msg?.id]);

  const isLocked = !!msg?.expired_at || vbHasMe || localViewed;
  const [modalOpen, setModalOpen] = useState(false);

  // ───────────── SENDER BRANCH ─────────────
  if (isOwn) {
    const accent = 'rgba(255,255,255,0.92)';
    const subtle = 'rgba(255,255,255,0.65)';
    const sub = vbHasAny
      ? (t?.('chatConv.viewOnceOpened') || 'Visualizada')
      : (t?.('chatConv.viewOnceSent') || 'Visualização única');
    const title = isAudio
      ? (t?.('chatConv.viewOnceVoiceLabel') || 'Áudio único')
      : isVideo
        ? (t?.('chatConv.viewOnceVideo') || 'Vídeo único')
        : (t?.('chatConv.viewOncePhoto') || 'Foto única');
    return (
      <View style={s.expiredRow}>
        <View style={[s.expiredIconCircle, { backgroundColor: 'rgba(255,255,255,0.15)' }]}>
          {isAudio
            ? <IconMic size={16} color={accent} />
            : isVideo
              ? <IconVideo size={16} color={accent} />
              : <IconEye size={16} color={accent} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.expiredTitle, { color: accent }]} numberOfLines={1}>{title}</Text>
          <Text style={[s.expiredSub, { color: subtle }]} numberOfLines={1}>{sub}</Text>
        </View>
        <IconLock size={13} color={subtle} />
      </View>
    );
  }

  // ───────────── RECEIVER EXPIRED ─────────────
  if (isLocked) {
    const accent = safeColors.primary;
    const subtle = safeColors.textSecondary;
    const title = isAudio
      ? (t?.('chatConv.viewOnceVoiceLabel') || 'Áudio único')
      : isVideo
        ? (t?.('chatConv.viewOnceVideo') || 'Vídeo único')
        : (t?.('chatConv.viewOncePhoto') || 'Foto única');
    const subLabel = isAudio
      ? (t?.('chatConv.viewOnceVoiceExpired') || 'Áudio expirado')
      : (t?.('chatConv.viewOnceOpened') || 'Aberta');
    return (
      <View style={s.expiredRow}>
        <View style={[s.expiredIconCircle, { backgroundColor: 'rgba(124,58,237,0.12)' }]}>
          {isAudio ? <IconMic size={16} color={accent} /> : <IconCheck size={16} color={accent} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.expiredTitle, { color: accent }]} numberOfLines={1}>{title}</Text>
          <Text style={[s.expiredSub, { color: subtle }]} numberOfLines={1}>{subLabel}</Text>
        </View>
        <IconLock size={13} color={subtle} />
      </View>
    );
  }

  // ───────────── RECEIVER UNVIEWED — AUDIO inline play ─────────────
  // Audio view-once doesn't open a fullscreen modal — the recipient taps the
  // pill, the audio plays inline once, and the bubble locks to "expired" as
  // soon as the player emits `ended`. If playback errors out the pill stays
  // tap-to-listen so the user can retry (same retry semantics as image/video).
  if (isAudio) {
    return (
      <ViewOnceAudioPlayer
        msg={msg}
        fileUrl={fileUrl}
        colors={safeColors}
        t={t}
        onConsumed={() => {
          if (msg?.id != null) { _markLocalViewed(msg.id).catch(() => {}); }
          setLocalViewed(true);
          onView?.(msg?.id);
        }}
      />
    );
  }

  // ───────────── RECEIVER UNVIEWED — tap to open fullscreen ─────────────
  const accent = safeColors.primary;
  const subtle = safeColors.textSecondary;

  return (
    <>
      <TouchableOpacity
        onPress={() => { if (!modalOpen) setModalOpen(true); }}
        activeOpacity={0.7}
        style={s.tapRow}
        accessibilityRole="button"
        accessibilityLabel={t?.('chatConv.tapToView') || 'Toque para ver'}
      >
        <View style={[s.tapIconCircle, { backgroundColor: 'rgba(124,58,237,0.14)' }]}>
          {isVideo ? <IconVideo size={18} color={accent} /> : <IconEye size={18} color={accent} />}
        </View>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text style={[s.tapTitle, { color: accent }]} numberOfLines={1}>
            {isVideo
              ? (t?.('chatConv.viewOnceVideo') || 'Vídeo único')
              : (t?.('chatConv.viewOncePhoto') || 'Foto única')}
          </Text>
          <Text style={[s.tapSub, { color: subtle }]} numberOfLines={1}>
            {t?.('chatConv.tapToView') || 'Toque para ver'}
          </Text>
        </View>
      </TouchableOpacity>

      {modalOpen ? (
        <ViewOnceFullscreen
          uri={fileUrl}
          isVideo={isVideo}
          t={t}
          senderName={msg?.sender_name || ''}
          onClose={() => setModalOpen(false)}
          onLoaded={() => {
            // Mark consumed only when the media actually rendered. If it errored
            // the pill stays tap-to-view so the user can try again.
            if (msg?.id != null) { _markLocalViewed(msg.id).catch(() => {}); }
            setLocalViewed(true);
            onView?.(msg?.id);
          }}
          onError={() => { /* keep pill open for retry */ }}
        />
      ) : null}
    </>
  );
}

/**
 * View-once audio player — receiver-side, single-shot inline playback.
 *
 *  - Initial state: purple pill with mic icon + "Tocar para ouvir" sub.
 *  - On tap: starts playback (HTMLAudio on web, expo-audio AudioPlayer on
 *    native). Pill flips to "Tocando... 0:03 / 0:14" with a play→pause swap.
 *  - On `ended`: fire onConsumed (which marks the row server-side as opened
 *    + locks locally). The parent ViewOnceMessage then re-renders us into
 *    the "expired" pill via `isLocked === true`.
 *  - On `error`: surface a "tap to retry" sub. Don't burn the view.
 *  - Pause: tapping while playing pauses but does NOT lock — only `ended`
 *    counts as consumption (WhatsApp parity; user must hear it through).
 */
function ViewOnceAudioPlayer({ msg, fileUrl, colors, t, onConsumed }) {
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(Number(msg?.duration) || 0);
  const [errored, setErrored] = useState(false);
  const soundRef = useRef(null);
  const intervalRef = useRef(null);
  const consumedRef = useRef(false);
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      // Pause + release on unmount so we don't leak an AVPlayer / HTMLAudio.
      try {
        if (Platform.OS === 'web') soundRef.current?.pause?.();
        else {
          soundRef.current?.pause?.();
          soundRef.current?._sub?.remove?.();
          soundRef.current?.remove?.();
        }
      } catch {}
      soundRef.current = null;
    };
  }, []);

  const fireConsumed = useCallback(() => {
    if (consumedRef.current) return;
    consumedRef.current = true;
    try { onConsumed?.(); } catch {}
  }, [onConsumed]);

  const handleTap = useCallback(async () => {
    if (errored) {
      // Retry path: reset and let the user tap again.
      setErrored(false);
      soundRef.current = null;
      return;
    }
    if (!fileUrl) { setErrored(true); return; }

    if (Platform.OS === 'web') {
      try {
        if (!soundRef.current) {
          const audio = new window.Audio(fileUrl);
          audio.preload = 'auto';
          audio.onloadedmetadata = () => {
            if (!isMountedRef.current) return;
            if (audio.duration && isFinite(audio.duration)) setDuration(audio.duration);
          };
          audio.onended = () => {
            if (!isMountedRef.current) return;
            setPlaying(false);
            setCurrentTime(0);
            if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
            // The actual consumption hook — fire AFTER state cleanup so the
            // re-render that flips us into the locked pill happens cleanly.
            fireConsumed();
          };
          audio.onerror = () => {
            if (!isMountedRef.current) return;
            setPlaying(false);
            setErrored(true);
            if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
          };
          soundRef.current = audio;
        }
        if (playing) {
          soundRef.current.pause();
          setPlaying(false);
          if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
          return;
        }
        await soundRef.current.play();
        if (!isMountedRef.current) return;
        setPlaying(true);
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = setInterval(() => {
          const a = soundRef.current;
          if (!a) return;
          if (a.duration > 0) {
            setCurrentTime(a.currentTime);
            if (a.duration && isFinite(a.duration) && !duration) setDuration(a.duration);
          }
        }, 100);
      } catch (e) {
        setErrored(true);
        setPlaying(false);
      }
      return;
    }

    // Native (iOS/Android) — expo-audio
    const mod = loadExpoAudio();
    if (!mod || !mod.createAudioPlayer) {
      setErrored(true);
      return;
    }
    try {
      if (!soundRef.current) {
        // Force playback through speaker (not earpiece) and pause Spotify/etc.
        // Same audio session config the regular AudioPlayer uses, so the
        // view-once playback behaves identically — silent-switch safe, no
        // mixing with music, releases focus back to other apps on ended.
        try {
          await mod.setAudioModeAsync?.({
            playsInSilentMode: true,
            allowsRecording: false,
            shouldPlayInBackground: true,
            interruptionMode: 'doNotMix',
            interruptionModeAndroid: 'doNotMix',
            shouldDuckAndroid: false,
          });
        } catch {}
        const player = mod.createAudioPlayer(typeof fileUrl === 'string' ? fileUrl : { uri: String(fileUrl) }, { updateInterval: 150, downloadFirst: false });
        const sub = player.addListener?.('playbackStatusUpdate', (status) => {
          if (!isMountedRef.current) return;
          if (status?.error) {
            setErrored(true); setPlaying(false);
            if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
            return;
          }
          if (status?.duration && isFinite(status.duration) && status.duration > 0) {
            setDuration(status.duration);
            if (status.playing) setCurrentTime(status.currentTime || 0);
          }
          // expo-audio reports `ended` by status.didJustFinish (preferred) or
          // currentTime >= duration after !playing. Either signal counts.
          const didFinish = status?.didJustFinish === true ||
            (!status?.playing && status?.duration > 0 && status?.currentTime >= status?.duration);
          if (didFinish) {
            setPlaying(false);
            setCurrentTime(0);
            // Hand the audio session back to the OS so Spotify/YT can resume.
            try {
              mod.setAudioModeAsync?.({
                interruptionMode: 'mixWithOthers',
                interruptionModeAndroid: 'mixWithOthers',
              }).catch(() => {});
            } catch {}
            fireConsumed();
          }
        });
        player._sub = sub;
        soundRef.current = player;
      }
      if (playing) {
        try { soundRef.current.pause(); } catch {}
        setPlaying(false);
        return;
      }
      try {
        soundRef.current.play();
        setPlaying(true);
      } catch {
        setErrored(true);
      }
    } catch (e) {
      setErrored(true);
      setPlaying(false);
    }
  }, [errored, fileUrl, fireConsumed, playing, duration]);

  const accent = colors.primary;
  const subtle = colors.textSecondary;
  const fmt = (s) => {
    const n = Math.max(0, Math.floor(s || 0));
    const m = Math.floor(n / 60);
    const r = n % 60;
    return `${m}:${r < 10 ? '0' : ''}${r}`;
  };

  const sub = errored
    ? (t?.('chatConv.viewOnceLoadFailed') || 'Não foi possível carregar. Toque pra tentar.')
    : playing
      ? `${fmt(currentTime)} / ${fmt(duration)}`
      : (t?.('chatConv.viewOnceVoiceTapToHear') || 'Tocar para ouvir');

  return (
    <TouchableOpacity
      onPress={handleTap}
      activeOpacity={0.7}
      style={s.tapRow}
      accessibilityRole="button"
      accessibilityLabel={t?.('chatConv.viewOnceVoiceTapToHear') || 'Tocar para ouvir'}
    >
      <View style={[s.tapIconCircle, { backgroundColor: 'rgba(124,58,237,0.14)' }]}>
        {playing
          ? <IconPause size={18} color={accent} />
          : errored
            ? <IconMic size={18} color={accent} />
            : <IconPlay size={18} color={accent} />}
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={[s.tapTitle, { color: accent }]} numberOfLines={1}>
          {t?.('chatConv.viewOnceVoiceLabel') || 'Áudio único'}
        </Text>
        <Text style={[s.tapSub, { color: subtle }]} numberOfLines={1}>
          {sub}
        </Text>
      </View>
      <IconLock size={13} color={subtle} />
    </TouchableOpacity>
  );
}

const s = StyleSheet.create({
  expiredRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6, paddingRight: 4, minWidth: 180 },
  expiredIconCircle: { width: 32, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  expiredTitle: { fontSize: 14, fontWeight: '600' },
  expiredSub: { fontSize: 12, marginTop: 1, fontStyle: 'italic' },
  tapRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 8, paddingRight: 4, minWidth: 200 },
  tapIconCircle: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  tapTitle: { fontSize: 14, fontWeight: '600' },
  tapSub: { fontSize: 12, marginTop: 1 },
});

const fs = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  header: {
    flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, paddingBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    zIndex: 20,
  },
  closeBtn: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  headerCenter: { flex: 1, alignItems: 'center', paddingHorizontal: 8 },
  senderName: { color: '#fff', fontSize: 15, fontWeight: '600', maxWidth: '100%' },
  badgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 2 },
  badgeText: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '500' },
  contentWrap: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#000' },
  fullImage: { width: '100%', height: '100%' },
  spinnerWrap: { position: 'absolute', alignItems: 'center', justifyContent: 'center' },
  errorBox: { padding: 24, alignItems: 'center', justifyContent: 'center' },
  errorOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.85)', padding: 24, gap: 16 },
  errorText: { color: '#fff', fontSize: 16, textAlign: 'center' },
  errorBtn: { paddingHorizontal: 18, paddingVertical: 10, borderRadius: 22, backgroundColor: '#7C3AED' },
  errorBtnText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  bottomHint: {
    position: 'absolute', bottom: 32, left: 16, right: 16,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8,
    paddingVertical: 10, paddingHorizontal: 14,
    backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 18,
  },
  bottomHintText: { color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: '500' },
});
