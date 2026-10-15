// [2026-10-13 video-studio] Câmera de criação (iOS/Android) — nível TikTok/Reels, 100% JS (OTA).
//
// Gravação em SEGMENTOS (cada um = um clip da EDL v1):
//   - tocar = grava até tocar de novo · segurar = grava enquanto segura (arrastar p/ cima = zoom)
//   - barra segmentada no topo, apagar último, limite 15 s / 60 s / 3 min
//   - velocidade por segmento 0.3x…3x: grava em 1x e marca clip.speed (o RENDER aplica)
//   - timer 3 s / 10 s, virar câmera (inclusive no meio: fecha o trecho e reabre na outra lente),
//     lanterna (traseira), grade, pinça p/ zoom, toque duplo p/ virar,
//     "Alinhar" = último frame do trecho anterior a 30 % de opacidade (expo-video generateThumbnailsAsync)
//   - música no fone durante a gravação (expo-audio), compensando a velocidade do trecho
//   - importar da galeria (vídeos + fotos; foto = clip de 3 s)
// Filtros: prévia APROXIMADA (overlay de cor, sem processar pixels). O filtro final sai do render.
//
// CAMINHO NATIVO p/ prévia de filtro fiel em tempo real (precisa build — NÃO feito aqui):
//   iOS: view nativa própria (ex.: no expo-native-toolkit) com AVCaptureVideoDataOutput →
//        CIFilter chain (CIPhotoEffectMono/Noir, CITemperatureAndTint, CIColorControls) → MTKView
//        (CIContext Metal), gravando os mesmos CVPixelBuffers via AVAssetWriter (o filtro "assa" no arquivo
//        OU só no preview, mantendo o render do servidor como fonte da verdade).
//   Android: CameraX Preview → SurfaceTexture → GLSurfaceView com fragment shader por filtro (LUT 3D
//        512×512 por id) + Recorder/MediaCodec numa EGLSurface compartilhada.
//   Mesmos ids de services/videoStudio/filters.js; o JS só troca a prop `filterId`.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Pressable, PanResponder, AppState, Alert, Linking, ActivityIndicator,
  Animated, Easing, ScrollView, StatusBar, BackHandler, Dimensions, Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { Image as ExpoImage } from 'expo-image';
import { useIsFocused } from '@react-navigation/native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import {
  IconX, IconCameraFlip, IconZap, IconClock, IconGrid, IconCopy, IconSparkles, IconImage,
  IconUndo2, IconCheck, IconMusic,
} from '../Icons';
import { tap as hapticTap, selection as hapticSelection, warning as hapticWarning } from '../../services/haptics';
import { SPEEDS } from '../../services/videoStudio/edl';
import { STUDIO_FILTERS, getStudioFilter } from '../../services/videoStudio/filters';
import { useSegmentSession, LIMITS_S, assetsToClips, probeVideo } from '../../services/videoStudio/useSegmentSession';

const { height: SCREEN_H } = Dimensions.get('window');
const MIN_CLIP_MS = 500;          // iOS/Android falham com trechos muito curtos
const TAP_THRESHOLD_MS = 280;     // < isso = toque (modo tap); ≥ = segurar
const TIMER_CYCLE = [0, 3, 10];

let KeepAwake = null;
try { KeepAwake = require('expo-keep-awake'); } catch { KeepAwake = null; }
const KA_TAG = 'video-studio-rec';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (s) => {
  const t = Math.max(0, Math.floor(s));
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};
const limitLabel = (s) => (s >= 60 ? `${s / 60} min` : `${s}s`);
const speedLabel = (v) => `${v}x`;

export default function CameraStudio({ t, draftId, initialMusic, onNext, onClose }) {
  const insets = useSafeAreaInsets();
  const isFocused = useIsFocused();
  const session = useSegmentSession({ draftId, initialMusic });
  const { segments, totalS, limitS, setLimitS, filter, setFilter, music, setMusic } = session;

  const [camPerm, requestCam] = useCameraPermissions();
  const [micPerm, requestMic] = useMicrophonePermissions();

  const [appState, setAppState] = useState(AppState.currentState || 'active');
  const [facing, setFacing] = useState('front');
  const [torch, setTorch] = useState(false);
  const [zoom, setZoom] = useState(0);
  const [grid, setGrid] = useState(false);
  const [align, setAlign] = useState(false);
  const [timerS, setTimerS] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [panel, setPanel] = useState(null); // 'speed' | 'filter' | null
  const [cameraReady, setCameraReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recMode, setRecMode] = useState('tap');
  const [elapsedMs, setElapsedMs] = useState(0);
  const [countdown, setCountdown] = useState(null);
  const [ghost, setGhost] = useState(null);
  const [busy, setBusy] = useState(null); // 'import' | 'next'
  const [toast, setToast] = useState(null);

  const cameraRef = useRef(null);
  const recordingRef = useRef(false);
  const recStartRef = useRef(0);
  const recModeRef = useRef('tap');
  const pendingFlipRef = useRef(false);
  const stopTimerRef = useRef(null);
  const countdownRef = useRef(null);
  const gestureRef = useRef({ t: 0, startedHere: false, baseZoom: 0 });
  const zoomRef = useRef(0);
  const musicPlayerRef = useRef(null);
  const toastTimer = useRef(null);
  const live = useRef({});

  const camGranted = !!camPerm?.granted;
  const micGranted = !!micPerm?.granted;
  // Mantém montada enquanto um trecho ainda está finalizando (desmontar no meio pode perder o arquivo).
  const cameraActive = camGranted && ((isFocused && appState !== 'background') || recording);
  const timelineNow = totalS + (recording ? elapsedMs / 1000 / speed : 0);
  const remainingS = Math.max(0, limitS - totalS);

  zoomRef.current = zoom;
  recModeRef.current = recMode;

  const showToast = useCallback((msg) => {
    setToast(msg);
    try { clearTimeout(toastTimer.current); } catch {}
    toastTimer.current = setTimeout(() => setToast(null), 2200);
  }, []);

  // ── Música no fone (hook: vem do editor/servidor via draftStore.setPendingMusic ou ?music_url=) ──
  useEffect(() => {
    if (!music?.url) return undefined;
    let player = null;
    try {
      const A = require('expo-audio');
      // allowsRecording: SEM ele o iOS mata mic+AEC (ver memória call_oneway_audio).
      A.setAudioModeAsync?.({ playsInSilentMode: true, allowsRecording: true }).catch?.(() => {});
      player = A.createAudioPlayer({ uri: music.url });
      musicPlayerRef.current = player;
    } catch { musicPlayerRef.current = null; }
    return () => {
      try { player?.pause?.(); } catch {}
      try { player?.remove?.(); } catch {}
      if (musicPlayerRef.current === player) musicPlayerRef.current = null;
    };
  }, [music?.url]);

  const startMusic = useCallback((timelinePos, spd) => {
    const p = musicPlayerRef.current;
    if (!p || !music) return;
    try {
      p.seekTo?.((Number(music.start) || 0) + timelinePos);
      // Trecho em 2x → no resultado o vídeo anda 2x; a música (tempo real) toca a 1/2 enquanto grava.
      try { p.setPlaybackRate?.(clamp(1 / spd, 0.5, 2)); } catch {}
      p.volume = 1;
      p.play?.();
    } catch {}
  }, [music]);
  const pauseMusic = useCallback(() => { try { musicPlayerRef.current?.pause?.(); } catch {} }, []);

  // ── Ciclo de vida: app em 2º plano / ligação → fecha o trecho e libera a câmera ──
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      setAppState(s);
      if (s !== 'active') {
        cancelCountdown();
        if (recordingRef.current) {
          pendingFlipRef.current = false;
          doStop(true);
          live.current.interrupted = true;
        }
      } else if (live.current.interrupted) {
        live.current.interrupted = false;
        showToast(t('videoStudio.cam.interrupted'));
      }
    });
    return () => { try { sub.remove(); } catch {} };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isFocused) { cancelCountdown(); if (recordingRef.current) doStop(true); pauseMusic(); }
    else session.reloadFromStore();
    setCameraReady(false);
  }, [isFocused]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => {
    try { cameraRef.current?.stopRecording?.(); } catch {}
    try { KeepAwake?.deactivateKeepAwake?.(KA_TAG); } catch {}
    try { clearTimeout(stopTimerRef.current); clearInterval(countdownRef.current); clearTimeout(toastTimer.current); } catch {}
  }, []);

  // Tick do progresso + parada automática no limite.
  useEffect(() => {
    if (!recording) return undefined;
    const iv = setInterval(() => {
      const ms = Date.now() - recStartRef.current;
      setElapsedMs(ms);
      if (live.current.totalS + ms / 1000 / live.current.speed >= live.current.limitS - 0.05) doStop(true);
    }, 50);
    return () => clearInterval(iv);
  }, [recording]); // eslint-disable-line react-hooks/exhaustive-deps

  live.current.totalS = totalS;
  live.current.speed = speed;
  live.current.limitS = limitS;

  // ── Gravação ──
  const startRecording = useCallback(async (mode) => {
    if (recordingRef.current || !cameraRef.current) return;
    if (!live.current.cameraReady) { showToast(t('videoStudio.cam.notReady')); return; }
    const remaining = live.current.limitS - live.current.totalS;
    if (remaining < 0.3) { hapticWarning(); showToast(t('videoStudio.cam.limitReached')); return; }
    const spd = live.current.speed;
    const fac = live.current.facing;
    recordingRef.current = true;
    recStartRef.current = Date.now();
    setRecMode(mode); recModeRef.current = mode;
    setElapsedMs(0);
    setRecording(true);
    setPanel(null);
    hapticTap('medium');
    try { KeepAwake?.activateKeepAwakeAsync?.(KA_TAG); } catch {}
    startMusic(live.current.totalS, spd);
    let res = null;
    try {
      res = await cameraRef.current.recordAsync({ maxDuration: Math.max(1, Math.ceil(remaining * spd) + 1) });
    } catch (e) { res = null; }
    const wallS = (Date.now() - recStartRef.current) / 1000;
    recordingRef.current = false;
    setRecording(false);
    setElapsedMs(0);
    pauseMusic();
    try { KeepAwake?.deactivateKeepAwake?.(KA_TAG); } catch {}
    if (res?.uri) {
      const srcDur = Math.max(0.1, Math.min(wallS, remaining * spd));
      try {
        const { index, clip } = await session.addSegment(
          { uri: res.uri, kind: 'video', in: 0, out: srcDur, speed: spd, mirror: false /* [2026-10-15 espelho] enviado NÃO espelhado (só a prévia espelha); usuário pode espelhar no editor */, camera: fac },
          { move: true },
        );
        // Duração REAL (start-up da gravação come ~100-300 ms do relógio de parede) + frame p/ Alinhar.
        probeVideo(clip.uri).then(({ duration, thumb }) => {
          if (duration > 0.05) session.patchSegment(index, { out: Math.min(duration, remaining * spd + 0.05) });
          if (thumb) setGhost({ thumb, index, camera: fac });
        }).catch(() => {});
      } catch {
        showToast(t('videoStudio.cam.recordFailed'));
      }
    } else if (wallS > 0.6) {
      showToast(t('videoStudio.cam.recordFailed'));
    }
    if (pendingFlipRef.current) {
      pendingFlipRef.current = false;
      const next = fac === 'front' ? 'back' : 'front';
      live.current.facing = next;
      live.current.cameraReady = false;
      setCameraReady(false);
      setFacing(next);
      live.current.resumeAfterFlip = mode;
    }
  }, [session, startMusic, pauseMusic, showToast, t]);

  const doStop = useCallback((force) => {
    if (!recordingRef.current) return;
    const age = Date.now() - recStartRef.current;
    const stop = () => { try { cameraRef.current?.stopRecording?.(); } catch {} };
    try { clearTimeout(stopTimerRef.current); } catch {}
    if (age < MIN_CLIP_MS && !force) stopTimerRef.current = setTimeout(stop, MIN_CLIP_MS - age);
    else if (age < MIN_CLIP_MS) stopTimerRef.current = setTimeout(stop, MIN_CLIP_MS - age);
    else stop();
  }, []);

  live.current.facing = live.current.facing || facing;
  live.current.cameraReady = cameraReady;

  const onCameraReady = useCallback(() => {
    setCameraReady(true);
    live.current.cameraReady = true;
    const resume = live.current.resumeAfterFlip;
    if (resume) {
      live.current.resumeAfterFlip = null;
      setTimeout(() => { startRecording(resume); }, 250);
    }
  }, [startRecording]);

  // Fallback: algumas versões não reemitem onCameraReady ao trocar de lente.
  useEffect(() => {
    if (!live.current.resumeAfterFlip) return undefined;
    const id = setTimeout(() => {
      if (live.current.resumeAfterFlip && cameraRef.current) {
        live.current.cameraReady = true;
        setCameraReady(true);
        const m = live.current.resumeAfterFlip;
        live.current.resumeAfterFlip = null;
        startRecording(m);
      }
    }, 1200);
    return () => clearTimeout(id);
  }, [facing, startRecording]);

  const flip = useCallback(() => {
    hapticSelection();
    if (recordingRef.current) { pendingFlipRef.current = true; doStop(true); return; }
    const next = live.current.facing === 'front' ? 'back' : 'front';
    live.current.facing = next;
    setFacing(next);
    setZoom(0);
  }, [doStop]);

  // ── Contagem do timer ──
  function cancelCountdown() {
    try { clearInterval(countdownRef.current); } catch {}
    countdownRef.current = null;
    setCountdown(null);
  }
  const beginCountdown = useCallback(() => {
    let n = timerS;
    setCountdown(n);
    hapticSelection();
    countdownRef.current = setInterval(() => {
      n -= 1;
      if (n <= 0) {
        cancelCountdown();
        startRecording('tap');
      } else {
        setCountdown(n);
        hapticSelection();
      }
    }, 1000);
  }, [timerS, startRecording]);

  // ── Botão de gravar: tocar / segurar / arrastar p/ cima = zoom ──
  const handlers = useRef({});
  handlers.current.pressIn = () => {
    const g = { t: Date.now(), startedHere: false, baseZoom: zoomRef.current };
    gestureRef.current = g;
    if (countdownRef.current) { cancelCountdown(); return; }
    if (recordingRef.current) { doStop(false); return; }
    if (timerS > 0) { beginCountdown(); return; }
    g.startedHere = true;
    startRecording('hold');
  };
  handlers.current.pressOut = () => {
    const g = gestureRef.current;
    if (!g.startedHere) return;
    g.startedHere = false;
    if (Date.now() - g.t < TAP_THRESHOLD_MS) {
      setRecMode('tap'); recModeRef.current = 'tap';
    } else {
      doStop(false);
    }
  };
  handlers.current.move = (dy) => {
    const g = gestureRef.current;
    if (!g.startedHere || dy > -8) return;
    setZoom(clamp(g.baseZoom + (-dy - 8) / (SCREEN_H * 0.45), 0, 1));
  };
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => handlers.current.pressIn(),
    onPanResponderMove: (_e, g) => handlers.current.move(g.dy),
    onPanResponderRelease: () => handlers.current.pressOut(),
    onPanResponderTerminate: () => handlers.current.pressOut(),
  }), []);

  // ── Pinça = zoom · toque duplo = virar ──
  const pinchBase = useRef(0);
  const gestures = useMemo(() => {
    const pinch = Gesture.Pinch()
      .runOnJS(true)
      .onStart(() => { pinchBase.current = zoomRef.current; })
      .onUpdate((e) => { setZoom(clamp(pinchBase.current + (e.scale - 1) * 0.35, 0, 1)); });
    const dbl = Gesture.Tap().numberOfTaps(2).runOnJS(true).onEnd((_e, ok) => { if (ok) flip(); });
    return Gesture.Simultaneous(pinch, dbl);
  }, [flip]);

  // ── Apagar último / galeria / próximo / fechar ──
  const deleteLast = useCallback(() => {
    if (recordingRef.current || !segments.length) return;
    Alert.alert(t('videoStudio.cam.deleteLastConfirm'), '', [
      { text: t('videoStudio.cam.cancel'), style: 'cancel' },
      {
        text: t('videoStudio.cam.delete'), style: 'destructive',
        onPress: async () => {
          hapticTap('light');
          await session.removeLast();
          setGhost(null);
        },
      },
    ]);
  }, [segments.length, session, t]);

  const goNext = useCallback(async () => {
    if (recordingRef.current || busy) return;
    if (!session.segments.length) return;
    setBusy('next');
    try {
      const r = await session.finish();
      if (r.id) onNext?.(r.id, r.edl);
    } finally { setBusy(null); }
  }, [busy, session, onNext]);

  const importGallery = useCallback(async () => {
    if (recordingRef.current || busy) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm?.granted && perm?.accessPrivileges !== 'limited') {
        Alert.alert(t('videoStudio.cam.galleryTitle'), t('videoStudio.cam.galleryDenied'), [
          { text: t('videoStudio.cam.cancel'), style: 'cancel' },
          { text: t('videoStudio.cam.permSettings'), onPress: () => { Linking.openSettings().catch(() => {}); } },
        ]);
        return;
      }
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos', 'images'],
        allowsMultipleSelection: true,
        selectionLimit: 20,
        orderedSelection: true,
        quality: 1,
      });
      if (res?.canceled || !res?.assets?.length) return;
      setBusy('import');
      const hadSegments = session.segments.length > 0;
      const clips = assetsToClips(res.assets);
      let added = 0;
      for (const c of clips) {
        if (c._needsProbe) {
          const { duration } = await probeVideo(c.uri, { wantThumb: false });
          if (duration > 0) c.out = duration;
        }
        delete c._needsProbe;
        try { await session.addSegment(c, { move: false }); added += 1; } catch {}
      }
      setBusy(null);
      if (!added) { showToast(t('videoStudio.cam.importFailed')); return; }
      // TikTok: importar sem nada gravado = vai direto pro editor.
      if (!hadSegments) setTimeout(() => { live.current.goNext?.(); }, 50);
    } catch {
      setBusy(null);
      showToast(t('videoStudio.cam.importFailed'));
    }
  }, [busy, session, showToast, t]);
  live.current.goNext = goNext;

  const close = useCallback(() => {
    if (recordingRef.current) { doStop(true); return true; }
    if (countdownRef.current) { cancelCountdown(); return true; }
    if (!session.segments.length) { session.discard().catch(() => {}); onClose?.(); return true; }
    Alert.alert(t('videoStudio.cam.discardTitle'), t('videoStudio.cam.discardMsg'), [
      { text: t('videoStudio.cam.cancel'), style: 'cancel' },
      { text: t('videoStudio.cam.saveDraft'), onPress: async () => { await session.keepDraft(); onClose?.(); } },
      { text: t('videoStudio.cam.discard'), style: 'destructive', onPress: async () => { await session.discard(); onClose?.(); } },
    ]);
    return true;
  }, [doStop, session, onClose, t]);

  useEffect(() => {
    if (!isFocused || Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', close);
    return () => { try { sub.remove(); } catch {} };
  }, [isFocused, close]);

  // ── Animação do botão ──
  const recAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(recAnim, { toValue: recording ? 1 : 0, duration: 180, easing: Easing.out(Easing.quad), useNativeDriver: true }).start();
  }, [recording, recAnim]);
  const ringScale = recAnim.interpolate({ inputRange: [0, 1], outputRange: [1, recMode === 'hold' ? 1.28 : 1.12] });
  const innerScale = recAnim.interpolate({ inputRange: [0, 1], outputRange: [1, recMode === 'hold' ? 0.55 : 0.42] });
  const innerRadius = recording && recMode === 'tap' ? 10 : 34;

  // ── Permissões ──
  if (!camPerm || !micPerm) {
    return <View style={styles.root}><ActivityIndicator color="#fff" style={{ marginTop: SCREEN_H * 0.4 }} /></View>;
  }
  const needPerm = !camGranted || (!micGranted && micPerm.canAskAgain);
  if (needPerm) {
    const canAsk = (camGranted || camPerm.canAskAgain) && (micGranted || micPerm.canAskAgain);
    return (
      <View style={[styles.root, styles.permWrap, { paddingTop: insets.top + 12, paddingBottom: insets.bottom + 24 }]}>
        <StatusBar barStyle="light-content" />
        <Pressable onPress={() => onClose?.()} hitSlop={12} style={[styles.permClose, { top: insets.top + 8 }]} accessibilityRole="button" accessibilityLabel={t('videoStudio.cam.close')}>
          <IconX size={26} color="#fff" />
        </Pressable>
        <View style={styles.permIcon}><IconCameraFlip size={34} color="#fff" /></View>
        <Text style={styles.permTitle}>{t('videoStudio.cam.permTitle')}</Text>
        <Text style={styles.permBody}>{t('videoStudio.cam.permBody')}</Text>
        <Pressable
          style={styles.permBtn}
          accessibilityRole="button"
          onPress={async () => {
            if (!canAsk) { Linking.openSettings().catch(() => {}); return; }
            try { if (!camGranted) await requestCam(); } catch {}
            try { if (!micGranted) await requestMic(); } catch {}
          }}
        >
          <Text style={styles.permBtnText}>{canAsk ? t('videoStudio.cam.permAllow') : t('videoStudio.cam.permSettings')}</Text>
        </Pressable>
        <Pressable style={styles.permBtnGhost} onPress={importGallery} accessibilityRole="button">
          <Text style={styles.permBtnGhostText}>{t('videoStudio.cam.gallery')}</Text>
        </Pressable>
      </View>
    );
  }

  const tint = getStudioFilter(filter?.id).tint;
  const idle = !recording && countdown == null;
  const barW = Dimensions.get('window').width - 24;

  return (
    <GestureHandlerRootView style={styles.root}>
      <StatusBar hidden />
      <GestureDetector gesture={gestures}>
        <View style={StyleSheet.absoluteFill} collapsable={false}>
          {cameraActive ? (
            <CameraView
              ref={cameraRef}
              style={StyleSheet.absoluteFill}
              facing={facing}
              mode="video"
              zoom={zoom}
              enableTorch={torch && facing === 'back'}
              mute={!micGranted}
              videoQuality="1080p"
              onCameraReady={onCameraReady}
              onMountError={() => showToast(t('videoStudio.cam.recordFailed'))}
            />
          ) : <View style={[StyleSheet.absoluteFill, { backgroundColor: '#000' }]} />}
          {!!tint && <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: tint }]} />}
          {align && ghost?.thumb ? (
            <View pointerEvents="none" style={[StyleSheet.absoluteFill, { opacity: 0.3, transform: [{ scaleX: facing === 'front' ? -1 : 1 }] }]}>
              <ExpoImage source={ghost.thumb} contentFit="cover" style={StyleSheet.absoluteFill} />
            </View>
          ) : null}
          {grid && (
            <View pointerEvents="none" style={StyleSheet.absoluteFill}>
              <View style={[styles.gridV, { left: '33.33%' }]} />
              <View style={[styles.gridV, { left: '66.66%' }]} />
              <View style={[styles.gridH, { top: '33.33%' }]} />
              <View style={[styles.gridH, { top: '66.66%' }]} />
            </View>
          )}
        </View>
      </GestureDetector>

      {/* Topo: barra segmentada + tempo */}
      <View pointerEvents="box-none" style={[styles.top, { paddingTop: insets.top + 8 }]}>
        <View style={[styles.bar, { width: barW }]}>
          {segments.map((c, i) => {
            const d = (c.out - c.in) / (c.speed || 1);
            return <View key={`s${i}`} style={[styles.barSeg, { width: Math.max(2, (d / limitS) * barW) }]} />;
          })}
          {recording && <View style={[styles.barSeg, styles.barLive, { width: Math.max(2, ((elapsedMs / 1000 / speed) / limitS) * barW) }]} />}
        </View>
        <View style={styles.topRow}>
          <Pressable onPress={close} hitSlop={12} style={styles.iconBtn} accessibilityRole="button" accessibilityLabel={t('videoStudio.cam.close')}>
            <IconX size={26} color="#fff" />
          </Pressable>
          {music ? (
            <Pressable
              style={styles.musicChip}
              disabled={recording}
              onPress={() => Alert.alert(music.title || t('videoStudio.cam.sound'), '', [
                { text: t('videoStudio.cam.cancel'), style: 'cancel' },
                { text: t('videoStudio.cam.removeSound'), style: 'destructive', onPress: () => setMusic(null) },
              ])}
            >
              <IconMusic size={14} color="#fff" />
              <Text style={styles.musicText} numberOfLines={1}>{music.title || t('videoStudio.cam.sound')}</Text>
            </Pressable>
          ) : <View style={{ flex: 1 }} />}
          <Text style={styles.timeText}>{(segments.length || recording) ? `${fmt(timelineNow)} / ${fmt(limitS)}` : ''}</Text>
        </View>
      </View>

      {/* Trilho direito */}
      {idle && (
        <View style={[styles.rail, { top: insets.top + 74 }]}>
          <RailBtn label={t('videoStudio.cam.flip')} onPress={flip}><IconCameraFlip size={26} color="#fff" /></RailBtn>
          <RailBtn label={t('videoStudio.cam.speed')} active={panel === 'speed' || speed !== 1} onPress={() => setPanel(panel === 'speed' ? null : 'speed')}>
            <Text style={styles.railTxt}>{speedLabel(speed)}</Text>
          </RailBtn>
          <RailBtn label={t('videoStudio.cam.filters')} active={panel === 'filter' || filter?.id !== 'none'} onPress={() => setPanel(panel === 'filter' ? null : 'filter')}>
            <IconSparkles size={24} color="#fff" />
          </RailBtn>
          <RailBtn label={timerS ? `${timerS}s` : t('videoStudio.cam.timer')} active={!!timerS} onPress={() => { hapticSelection(); setTimerS(TIMER_CYCLE[(TIMER_CYCLE.indexOf(timerS) + 1) % TIMER_CYCLE.length]); }}>
            <IconClock size={24} color="#fff" />
          </RailBtn>
          <RailBtn label={t('videoStudio.cam.flash')} active={torch && facing === 'back'} disabled={facing !== 'back'} onPress={() => setTorch((v) => !v)}>
            <IconZap size={24} color="#fff" />
          </RailBtn>
          <RailBtn label={t('videoStudio.cam.grid')} active={grid} onPress={() => setGrid((v) => !v)}>
            <IconGrid size={24} color="#fff" />
          </RailBtn>
          {segments.length > 0 && (
            <RailBtn label={t('videoStudio.cam.align')} active={align} onPress={() => setAlign((v) => !v)}>
              <IconCopy size={24} color="#fff" />
            </RailBtn>
          )}
        </View>
      )}

      {/* Contagem */}
      {countdown != null && (
        <View pointerEvents="none" style={styles.countWrap}><Text style={styles.countTxt}>{countdown}</Text></View>
      )}
      {!!toast && <View pointerEvents="none" style={[styles.toast, { top: insets.top + 70 }]}><Text style={styles.toastTxt}>{toast}</Text></View>}

      {/* Base */}
      <View pointerEvents="box-none" style={[styles.bottom, { paddingBottom: insets.bottom + 14 }]}>
        {idle && panel === 'speed' && (
          <View style={styles.pillRow}>
            {SPEEDS.map((v) => (
              <Pressable key={v} onPress={() => { hapticSelection(); setSpeed(v); }} style={[styles.pill, speed === v && styles.pillOn]} accessibilityRole="button">
                <Text style={[styles.pillTxt, speed === v && styles.pillTxtOn]}>{speedLabel(v)}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {idle && panel === 'filter' && (
          <View style={{ alignItems: 'center' }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
              {STUDIO_FILTERS.map((f) => (
                <Pressable key={f.id} onPress={() => { hapticSelection(); setFilter({ id: f.id, intensity: 1 }); }} style={[styles.pill, filter?.id === f.id && styles.pillOn]} accessibilityRole="button">
                  <Text style={[styles.pillTxt, filter?.id === f.id && styles.pillTxtOn]}>{t(f.labelKey)}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Text style={styles.hint}>{t('videoStudio.cam.filterHint')}</Text>
          </View>
        )}
        {idle && !segments.length && !panel && <Text style={styles.hint}>{t('videoStudio.cam.holdHint')}</Text>}

        <View style={styles.controls}>
          <View style={styles.side}>
            {idle && (
              <Pressable onPress={importGallery} style={styles.galleryBtn} accessibilityRole="button" accessibilityLabel={t('videoStudio.cam.gallery')}>
                {ghost?.thumb ? <ExpoImage source={ghost.thumb} style={StyleSheet.absoluteFill} contentFit="cover" /> : <IconImage size={22} color="#fff" />}
              </Pressable>
            )}
            {idle && <Text style={styles.sideLbl}>{t('videoStudio.cam.gallery')}</Text>}
          </View>

          <View style={styles.recWrap} {...pan.panHandlers} accessibilityRole="button" accessibilityLabel={recording ? t('videoStudio.cam.stop') : t('videoStudio.cam.record')}>
            <Animated.View style={[styles.recRing, { transform: [{ scale: ringScale }] }]} />
            <Animated.View style={[styles.recInner, { borderRadius: innerRadius, transform: [{ scale: innerScale }] }]} />
          </View>

          <View style={[styles.side, { flexDirection: 'row', justifyContent: 'center', gap: 14 }]}>
            {idle && segments.length > 0 && (
              <>
                <Pressable onPress={deleteLast} hitSlop={8} style={styles.smallCircle} accessibilityRole="button" accessibilityLabel={t('videoStudio.cam.deleteLast')}>
                  <IconUndo2 size={20} color="#fff" />
                </Pressable>
                <Pressable onPress={goNext} hitSlop={8} style={[styles.smallCircle, styles.nextBtn]} accessibilityRole="button" accessibilityLabel={t('videoStudio.cam.next')}>
                  {busy === 'next' ? <ActivityIndicator color="#000" size="small" /> : <IconCheck size={22} color="#000" />}
                </Pressable>
              </>
            )}
          </View>
        </View>

        {idle && !segments.length && (
          <View style={styles.limitRow}>
            {LIMITS_S.slice().reverse().map((s) => (
              <Pressable key={s} onPress={() => { hapticSelection(); setLimitS(s); }} hitSlop={8} accessibilityRole="button">
                <Text style={[styles.limitTxt, limitS === s && styles.limitOn]}>{limitLabel(s)}</Text>
              </Pressable>
            ))}
          </View>
        )}
        {idle && segments.length > 0 && remainingS < 0.3 && <Text style={styles.hint}>{t('videoStudio.cam.limitReached')}</Text>}
      </View>

      {busy === 'import' && (
        <View style={styles.busy}><ActivityIndicator color="#fff" /><Text style={styles.busyTxt}>{t('videoStudio.cam.importing')}</Text></View>
      )}
    </GestureHandlerRootView>
  );
}

function RailBtn({ label, active, disabled, onPress, children }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} hitSlop={6} style={[styles.railBtn, disabled && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ selected: !!active, disabled: !!disabled }}>
      <View style={[styles.railIcon, active && styles.railIconOn]}>{children}</View>
      <Text style={styles.railLbl} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

const SH = { textShadowColor: 'rgba(0,0,0,0.55)', textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 3 };
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  top: { position: 'absolute', left: 0, right: 0, top: 0, alignItems: 'center' },
  bar: { height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.28)', flexDirection: 'row', overflow: 'hidden' },
  barSeg: { height: 4, backgroundColor: '#fff', borderRightWidth: 2, borderRightColor: '#000' },
  barLive: { borderRightWidth: 0, opacity: 0.85 },
  topRow: { width: '100%', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, marginTop: 10, gap: 10 },
  iconBtn: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
  musicChip: { flex: 1, maxWidth: 220, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, backgroundColor: 'rgba(0,0,0,0.42)', borderRadius: 16, paddingHorizontal: 12, height: 32 },
  musicText: { color: '#fff', fontSize: 13, fontWeight: '600', flexShrink: 1 },
  timeText: { color: '#fff', fontSize: 13, fontWeight: '600', minWidth: 84, textAlign: 'right', fontVariant: ['tabular-nums'], ...SH },
  rail: { position: 'absolute', right: 8, alignItems: 'center', gap: 14 },
  railBtn: { alignItems: 'center', width: 58 },
  railIcon: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
  railIconOn: { backgroundColor: 'rgba(255,255,255,0.22)' },
  railTxt: { color: '#fff', fontSize: 15, fontWeight: '800', ...SH },
  railLbl: { color: '#fff', fontSize: 11, fontWeight: '600', marginTop: 2, ...SH },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.45)' },
  gridH: { position: 'absolute', left: 0, right: 0, height: StyleSheet.hairlineWidth, backgroundColor: 'rgba(255,255,255,0.45)' },
  countWrap: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center' },
  countTxt: { color: '#fff', fontSize: 120, fontWeight: '200', ...SH },
  toast: { position: 'absolute', alignSelf: 'center', backgroundColor: 'rgba(0,0,0,0.72)', paddingHorizontal: 14, paddingVertical: 8, borderRadius: 14 },
  toastTxt: { color: '#fff', fontSize: 13, fontWeight: '600' },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center' },
  pillRow: { flexDirection: 'row', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 10, padding: 3, marginBottom: 16 },
  filterRow: { paddingHorizontal: 16, gap: 8, marginBottom: 6 },
  pill: { paddingHorizontal: 13, height: 32, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  pillOn: { backgroundColor: '#fff' },
  pillTxt: { color: '#fff', fontSize: 13, fontWeight: '700' },
  pillTxtOn: { color: '#000' },
  hint: { color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '500', marginBottom: 12, textAlign: 'center', paddingHorizontal: 24, ...SH },
  controls: { width: '100%', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18 },
  side: { width: 110, alignItems: 'center' },
  sideLbl: { color: '#fff', fontSize: 11, fontWeight: '600', marginTop: 4, ...SH },
  galleryBtn: { width: 42, height: 42, borderRadius: 10, borderWidth: 2, borderColor: '#fff', overflow: 'hidden', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.3)' },
  recWrap: { width: 96, height: 96, alignItems: 'center', justifyContent: 'center' },
  recRing: { position: 'absolute', width: 86, height: 86, borderRadius: 43, borderWidth: 5, borderColor: 'rgba(255,255,255,0.92)' },
  recInner: { width: 68, height: 68, backgroundColor: '#fff' },
  smallCircle: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.35)' },
  nextBtn: { backgroundColor: '#fff', borderColor: '#fff' },
  limitRow: { flexDirection: 'row', gap: 22, marginTop: 14 },
  limitTxt: { color: 'rgba(255,255,255,0.6)', fontSize: 14, fontWeight: '700', ...SH },
  limitOn: { color: '#fff' },
  busy: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center', gap: 10 },
  busyTxt: { color: '#fff', fontSize: 14, fontWeight: '600' },
  permWrap: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32 },
  permClose: { position: 'absolute', left: 12, padding: 6 },
  permIcon: { width: 76, height: 76, borderRadius: 38, borderWidth: 1, borderColor: 'rgba(255,255,255,0.3)', alignItems: 'center', justifyContent: 'center', marginBottom: 22 },
  permTitle: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center' },
  permBody: { color: 'rgba(255,255,255,0.72)', fontSize: 15, lineHeight: 21, textAlign: 'center', marginTop: 10, marginBottom: 28 },
  permBtn: { backgroundColor: '#fff', borderRadius: 12, height: 50, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  permBtnText: { color: '#000', fontSize: 16, fontWeight: '700' },
  permBtnGhost: { marginTop: 12, height: 46, alignSelf: 'stretch', alignItems: 'center', justifyContent: 'center' },
  permBtnGhostText: { color: '#fff', fontSize: 15, fontWeight: '600' },
});
