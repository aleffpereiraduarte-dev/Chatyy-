// ChatCamera — [2026-10-07 ios-native] WhatsApp-style in-app chat camera.
//
// Replaces the system camera (expo-image-picker launchCameraAsync) for the
// chat composer's camera button. Same react-native-vision-camera binary the
// Status camera already ships (so this file is JS-only / OTA-able), but with
// NO frame processor: the iOS crash that made Status fall back to expo-camera
// (2026-05-27/28, Hermes heap corruption) lived in the Skia + Apple-Vision
// face-detector WORKLET, not in the plain capture session used here.
//
// UX (WhatsApp parity):
//   • tap the shutter            → photo (flash off / on / auto; front camera
//                                  uses a white "screen flash")
//   • hold the shutter (>250 ms) → video while held, drag UP to zoom, release
//                                  to stop; 60 s cap with a red progress ring
//   • flip button / double-tap   → front ↔ back      • pinch → zoom
//   • tap preview                → focus
//   • recent-gallery strip       → tap = send that item; long-press = multi-
//                                  select then "→ (n)"; gallery icon opens the
//                                  full system picker (parent's handleGallery)
//
// Output: onCapture(files[]) with the SAME descriptor shape handleGallery
// builds ({ uri, name, type, size, duration?, width?, height? }). The parent
// opens MediaPreview (caption / edit / HD / view-once) whose onSend runs
// uploadAndSendFile → mediaSendQueue.enqueueMedia (durable SQLite 'upload'
// lane) — so camera captures get exactly the same durability as gallery ones.
//
// Kill switch (OTA / console): globalThis.__chatyy_inapp_camera = false →
// isChatCameraAvailable() returns false and the parent keeps the legacy
// system camera. Also false on web or when the native module isn't linked.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View, Text, StyleSheet, Modal, TouchableOpacity, PanResponder, Platform,
  FlatList, AppState, Linking, ActivityIndicator, Animated, Easing, StatusBar,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconX, IconZap, IconRefresh, IconImage, IconSend } from '../Icons';
import { tap as hapticTap, selection as hapticSelection, warning as hapticWarning } from '../../services/haptics';

// ─── Lazy native deps (never at module eval — a missing binding must not
// crash the chat screen import) ──────────────────────────────────────────────
let _VC; // undefined = not tried, null = unavailable
function loadVisionCamera() {
  if (_VC !== undefined) return _VC;
  _VC = null;
  if (Platform.OS === 'web') return _VC;
  try {
    const mod = require('react-native-vision-camera');
    if (mod && mod.Camera && typeof mod.useCameraDevice === 'function') _VC = mod;
  } catch { _VC = null; }
  return _VC;
}
let _ML;
function loadMediaLibrary() {
  if (_ML !== undefined) return _ML;
  _ML = null;
  try { _ML = require('expo-media-library'); } catch { _ML = null; }
  return _ML;
}
let _ExpoImage;
function loadThumbImage() {
  if (_ExpoImage !== undefined) return _ExpoImage;
  _ExpoImage = null;
  // expo-image understands iOS `ph://` asset URIs (RN core Image does not).
  try { _ExpoImage = require('expo-image').Image || null; } catch { _ExpoImage = null; }
  return _ExpoImage;
}

/** True when the in-app camera can be used on this binary/platform. */
export function isChatCameraAvailable() {
  try {
    if (typeof globalThis !== 'undefined' && globalThis.__chatyy_inapp_camera === false) return false;
  } catch {}
  return !!loadVisionCamera();
}

const MAX_VIDEO_SEC = 60;
const HOLD_TO_RECORD_MS = 250;
const SHUTTER = 78;
const RECENT_COUNT = 40;

function tt(t, key, fallback) {
  try {
    const v = typeof t === 'function' ? t(key) : null;
    return (v && v !== key) ? v : fallback;
  } catch { return fallback; }
}

function toFileUri(p) {
  if (!p) return null;
  return p.startsWith('file://') ? p : `file://${p}`;
}

function isInCall() {
  try {
    if (globalThis.__chatyyNativeCallActive) return true;
    const cs = require('../../services/callState');
    const s = cs.getCallState?.();
    return s === 'active' || s === 'answered' || s === 'ringing';
  } catch { return false; }
}

const MIME_BY_EXT = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v',
  '3gp': 'video/3gpp', webm: 'video/webm',
};

function fmtDur(sec) {
  const s = Math.max(0, Math.floor(sec || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ─────────────────────────────────────────────────────────────────────────────

export default function ChatCamera({ visible, onClose, onCapture, onOpenGallery, t }) {
  return (
    <Modal
      visible={!!visible}
      animationType="slide"
      presentationStyle="fullScreen"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      {visible ? (
        <ChatCameraBody onClose={onClose} onCapture={onCapture} onOpenGallery={onOpenGallery} t={t} />
      ) : null}
    </Modal>
  );
}

function ChatCameraBody({ onClose, onCapture, onOpenGallery, t }) {
  const VC = loadVisionCamera();
  const insets = useSafeAreaInsets();
  const [perm, setPerm] = useState('checking'); // checking | granted | denied
  const [micOk, setMicOk] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!VC) { if (alive) setPerm('denied'); return; }
      try {
        let st = VC.Camera.getCameraPermissionStatus();
        if (st !== 'granted') st = await VC.Camera.requestCameraPermission();
        if (!alive) return;
        if (st !== 'granted') { setPerm('denied'); return; }
        setPerm('granted');
        let mic = VC.Camera.getMicrophonePermissionStatus();
        if (mic === 'not-determined') mic = await VC.Camera.requestMicrophonePermission();
        if (alive) setMicOk(mic === 'granted');
      } catch {
        if (alive) setPerm('denied');
      }
    })();
    return () => { alive = false; };
  }, [VC]);

  if (perm === 'checking') {
    return <View style={[st.root, st.center]}><ActivityIndicator color="#fff" /></View>;
  }
  if (perm !== 'granted' || !VC) {
    return (
      <View style={[st.root, st.center, { paddingHorizontal: 32 }]}>
        <StatusBar barStyle="light-content" />
        <Text style={st.permTitle}>{tt(t, 'chatCamera.permTitle', 'Permita o acesso à câmera')}</Text>
        <Text style={st.permBody}>
          {tt(t, 'chatCamera.permBody', 'Para tirar fotos e gravar vídeos no Chatyy, ative a câmera nos Ajustes.')}
        </Text>
        <TouchableOpacity style={st.permBtn} onPress={() => { try { Linking.openSettings(); } catch {} }}>
          <Text style={st.permBtnTxt}>{tt(t, 'chatCamera.openSettings', 'Abrir Ajustes')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={[st.topBtn, { position: 'absolute', top: insets.top + 8, left: 12 }]} onPress={onClose}
          accessibilityRole="button" accessibilityLabel={tt(t, 'common.close', 'Fechar')}>
          <IconX size={24} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  }
  return <CameraScreen VC={VC} micOk={micOk} insets={insets} onClose={onClose} onCapture={onCapture} onOpenGallery={onOpenGallery} t={t} />;
}

function CameraScreen({ VC, micOk, insets, onClose, onCapture, onOpenGallery, t }) {
  const { Camera, useCameraDevice, useCameraFormat } = VC;
  const [position, setPosition] = useState('back');
  const device = useCameraDevice(position);
  // 1080p video / max photo. Video is re-encoded by the media queue anyway;
  // 1080p30 keeps preview + capture smooth on older iPhones.
  const format = useCameraFormat(device, [
    { videoResolution: { width: 1920, height: 1080 } },
    { photoAspectRatio: 4 / 3 },
    { fps: 30 },
  ]);
  const cameraRef = useRef(null);
  const [flash, setFlash] = useState('off'); // off | on | auto
  const [appActive, setAppActive] = useState(AppState.currentState === 'active');
  const [ready, setReady] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recSec, setRecSec] = useState(0);
  const [busy, setBusy] = useState(false);
  const [screenFlash, setScreenFlash] = useState(false);
  const neutralZoom = device?.neutralZoom ?? 1;
  const [zoom, setZoom] = useState(neutralZoom);
  const audioOn = micOk && !isInCall();

  useEffect(() => { setZoom(device?.neutralZoom ?? 1); }, [device?.id]);

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => setAppActive(s === 'active'));
    return () => { try { sub.remove(); } catch {} };
  }, []);

  // ─── Recording state ───
  const recRef = useRef({ active: false, startedAt: 0, timer: null, holdTimer: null, finishing: false, zoomBase: 1 });
  const ringAnim = useRef(new Animated.Value(0)).current;
  const pulse = useRef(new Animated.Value(1)).current;

  const stopTimers = useCallback(() => {
    const r = recRef.current;
    if (r.timer) { clearInterval(r.timer); r.timer = null; }
    if (r.holdTimer) { clearTimeout(r.holdTimer); r.holdTimer = null; }
  }, []);

  useEffect(() => () => {
    stopTimers();
    if (recRef.current.active) { try { cameraRef.current?.cancelRecording?.(); } catch {} }
  }, [stopTimers]);

  const deliver = useCallback((files) => {
    if (!files || files.length === 0) return;
    try { onCapture?.(files); } catch {}
  }, [onCapture]);

  const startRecording = useCallback(() => {
    const cam = cameraRef.current;
    if (!cam || recRef.current.active || busy) return;
    recRef.current.active = true;
    recRef.current.finishing = false;
    recRef.current.startedAt = Date.now();
    recRef.current.zoomBase = zoom;
    setRecording(true);
    setRecSec(0);
    hapticTap('medium');
    ringAnim.setValue(0);
    Animated.timing(ringAnim, { toValue: 1, duration: MAX_VIDEO_SEC * 1000, easing: Easing.linear, useNativeDriver: false }).start();
    Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.3, duration: 500, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 500, useNativeDriver: true }),
    ])).start();
    recRef.current.timer = setInterval(() => {
      const el = (Date.now() - recRef.current.startedAt) / 1000;
      setRecSec(el);
      if (el >= MAX_VIDEO_SEC) stopRecordingRef.current?.();
    }, 250);
    try {
      cam.startRecording({
        flash: (position === 'back' && device?.hasTorch && flash === 'on') ? 'on' : 'off',
        fileType: 'mp4',
        videoCodec: 'h264',
        onRecordingFinished: (video) => {
          stopTimers();
          recRef.current.active = false;
          setRecording(false);
          ringAnim.stopAnimation();
          pulse.stopAnimation(); pulse.setValue(1);
          const uri = toFileUri(video?.path);
          const dur = Number(video?.duration || 0);
          if (!uri) return;
          if (dur > 0 && dur < 0.6) {
            // Too short to be intentional — WhatsApp also drops these.
            hapticWarning();
            return;
          }
          deliver([{
            uri,
            name: `VID_${Date.now()}.mp4`,
            type: 'video/mp4',
            size: 0,
            duration: dur || null,
            width: video?.width, height: video?.height,
          }]);
        },
        onRecordingError: (e) => {
          stopTimers();
          recRef.current.active = false;
          setRecording(false);
          ringAnim.stopAnimation();
          pulse.stopAnimation(); pulse.setValue(1);
          if (__DEV__) console.warn('[ChatCamera] record error', e?.code || e?.message || e);
          hapticWarning();
        },
      });
    } catch (e) {
      stopTimers();
      recRef.current.active = false;
      setRecording(false);
      if (__DEV__) console.warn('[ChatCamera] startRecording threw', e?.message || e);
    }
  }, [busy, zoom, position, device?.hasTorch, flash, deliver, stopTimers, ringAnim, pulse]);

  const stopRecording = useCallback(() => {
    if (!recRef.current.active || recRef.current.finishing) return;
    recRef.current.finishing = true;
    hapticTap('light');
    // stopRecording resolves; the file arrives via onRecordingFinished.
    try { cameraRef.current?.stopRecording?.()?.catch?.(() => {}); } catch {}
  }, []);
  const stopRecordingRef = useRef(stopRecording);
  stopRecordingRef.current = stopRecording;

  const takePhoto = useCallback(async () => {
    const cam = cameraRef.current;
    if (!cam || busy || recRef.current.active) return;
    setBusy(true);
    hapticTap('rigid');
    const frontFlash = position === 'front' && flash !== 'off';
    try {
      if (frontFlash) {
        setScreenFlash(true);
        await new Promise(r => setTimeout(r, 180));
      }
      const photo = await cam.takePhoto({
        flash: (device?.hasFlash && position === 'back') ? flash : 'off',
        enableShutterSound: true,
      });
      const uri = toFileUri(photo?.path);
      if (uri) {
        deliver([{
          uri,
          name: `IMG_${Date.now()}.jpg`,
          type: 'image/jpeg',
          size: 0,
          width: photo?.width, height: photo?.height,
        }]);
      }
    } catch (e) {
      if (__DEV__) console.warn('[ChatCamera] takePhoto failed', e?.message || e);
      hapticWarning();
    } finally {
      setScreenFlash(false);
      setBusy(false);
    }
  }, [busy, position, flash, device?.hasFlash, deliver]);

  // ─── Shutter gesture: tap = photo, hold = video, drag up while held = zoom ───
  const zoomRange = useMemo(() => {
    const min = device?.minZoom ?? 1;
    const max = Math.min(device?.maxZoom ?? 1, (device?.neutralZoom ?? 1) * 10);
    return { min, max };
  }, [device?.minZoom, device?.maxZoom, device?.neutralZoom]);
  const handlersRef = useRef({});
  handlersRef.current = { startRecording, stopRecording, takePhoto, zoomRange, ready };
  const shutterPan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => {
      const r = recRef.current;
      if (r.holdTimer) clearTimeout(r.holdTimer);
      r.holdTimer = setTimeout(() => {
        r.holdTimer = null;
        if (handlersRef.current.ready) handlersRef.current.startRecording();
      }, HOLD_TO_RECORD_MS);
    },
    onPanResponderMove: (_e, g) => {
      if (!recRef.current.active) return;
      const { min, max } = handlersRef.current.zoomRange;
      const base = recRef.current.zoomBase;
      const up = Math.max(0, -g.dy);
      const next = Math.min(max, Math.max(min, base + (up / 320) * (max - base)));
      setZoom(next);
    },
    onPanResponderRelease: () => {
      const r = recRef.current;
      if (r.holdTimer) {
        clearTimeout(r.holdTimer); r.holdTimer = null;
        if (handlersRef.current.ready) handlersRef.current.takePhoto();
        return;
      }
      if (r.active) handlersRef.current.stopRecording();
    },
    onPanResponderTerminate: () => {
      const r = recRef.current;
      if (r.holdTimer) { clearTimeout(r.holdTimer); r.holdTimer = null; }
      if (r.active) handlersRef.current.stopRecording();
    },
  }), []);

  // ─── Preview taps: single = focus, double = flip ───
  const lastTapRef = useRef(0);
  const flip = useCallback(() => {
    if (recRef.current.active) return;
    hapticSelection();
    setPosition(p => (p === 'back' ? 'front' : 'back'));
  }, []);
  const onPreviewTap = useCallback((e) => {
    const now = Date.now();
    if (now - lastTapRef.current < 280) { lastTapRef.current = 0; flip(); return; }
    lastTapRef.current = now;
    try {
      if (device?.supportsFocus && cameraRef.current?.focus) {
        const { locationX, locationY } = e.nativeEvent || {};
        cameraRef.current.focus({ x: locationX, y: locationY })?.catch?.(() => {});
      }
    } catch {}
  }, [device?.supportsFocus, flip]);

  const cycleFlash = useCallback(() => {
    hapticSelection();
    setFlash(f => (f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off'));
  }, []);

  // ─── Recent gallery strip ───
  const [recent, setRecent] = useState([]);
  const [selected, setSelected] = useState([]); // asset ids, in tap order
  const [resolving, setResolving] = useState(false);
  useEffect(() => {
    let alive = true;
    (async () => {
      const ML = loadMediaLibrary();
      if (!ML?.getAssetsAsync) return;
      try {
        let p = await ML.getPermissionsAsync();
        if (!p?.granted && p?.canAskAgain !== false && p?.status !== 'denied') {
          p = await ML.requestPermissionsAsync();
        }
        if (!p?.granted && p?.accessPrivileges !== 'limited') return;
        const res = await ML.getAssetsAsync({
          first: RECENT_COUNT,
          mediaType: [ML.MediaType?.photo || 'photo', ML.MediaType?.video || 'video'],
          sortBy: [[ML.SortBy?.creationTime || 'creationTime', false]],
        });
        if (alive) setRecent(Array.isArray(res?.assets) ? res.assets : []);
      } catch {}
    })();
    return () => { alive = false; };
  }, []);

  const assetToFile = useCallback(async (asset) => {
    const ML = loadMediaLibrary();
    let uri = asset?.uri || '';
    try {
      if (ML?.getAssetInfoAsync && (Platform.OS === 'ios' || !uri.startsWith('file://'))) {
        const info = await ML.getAssetInfoAsync(asset, { shouldDownloadFromNetwork: true });
        if (info?.localUri) uri = info.localUri;
      }
    } catch {}
    if (!uri || uri.startsWith('ph://')) return null;
    const isVideo = asset.mediaType === 'video';
    const fname = asset.filename || '';
    const m = (fname || uri).match(/\.([a-z0-9]{2,5})(?:\?|#|$)/i);
    const ext = (m ? m[1] : (isVideo ? 'mp4' : 'jpg')).toLowerCase();
    return {
      uri,
      name: fname || `media_${Date.now()}.${ext}`,
      type: MIME_BY_EXT[ext] || (isVideo ? 'video/mp4' : 'image/jpeg'),
      size: 0,
      duration: isVideo ? (asset.duration || null) : undefined,
      width: asset.width, height: asset.height,
    };
  }, []);

  const sendAssets = useCallback(async (assets) => {
    if (resolving || !assets.length) return;
    setResolving(true);
    try {
      const files = [];
      for (const a of assets) {
        const f = await assetToFile(a);
        if (f) files.push(f);
      }
      if (files.length) deliver(files);
      else hapticWarning();
    } finally {
      setResolving(false);
    }
  }, [resolving, assetToFile, deliver]);

  const onRecentPress = useCallback((asset) => {
    if (selected.length > 0) {
      hapticSelection();
      setSelected(prev => (prev.includes(asset.id) ? prev.filter(x => x !== asset.id) : [...prev, asset.id].slice(0, 30)));
      return;
    }
    sendAssets([asset]);
  }, [selected.length, sendAssets]);
  const onRecentLongPress = useCallback((asset) => {
    hapticTap('medium');
    setSelected(prev => (prev.includes(asset.id) ? prev : [...prev, asset.id]));
  }, []);
  const sendSelected = useCallback(() => {
    const byId = new Map(recent.map(a => [a.id, a]));
    sendAssets(selected.map(id => byId.get(id)).filter(Boolean));
  }, [recent, selected, sendAssets]);

  const Thumb = loadThumbImage();
  const renderRecent = useCallback(({ item }) => {
    const idx = selected.indexOf(item.id);
    return (
      <TouchableOpacity
        activeOpacity={0.8}
        onPress={() => onRecentPress(item)}
        onLongPress={() => onRecentLongPress(item)}
        delayLongPress={300}
        style={st.thumbWrap}
        accessibilityRole="button"
        accessibilityLabel={item.mediaType === 'video' ? tt(t, 'chatCamera.video', 'Vídeo') : tt(t, 'chatCamera.photo', 'Foto')}
      >
        {Thumb ? (
          <Thumb source={{ uri: item.uri }} style={st.thumb} contentFit="cover" recyclingKey={item.id} cachePolicy="memory" />
        ) : <View style={[st.thumb, { backgroundColor: '#222' }]} />}
        {item.mediaType === 'video' ? (
          <Text style={st.thumbDur}>{fmtDur(item.duration)}</Text>
        ) : null}
        {idx >= 0 ? (
          <View style={st.thumbSel}><Text style={st.thumbSelTxt}>{idx + 1}</Text></View>
        ) : null}
      </TouchableOpacity>
    );
  }, [Thumb, selected, onRecentPress, onRecentLongPress, t]);

  if (!device) {
    return (
      <View style={[st.root, st.center]}>
        <ActivityIndicator color="#fff" />
        <TouchableOpacity style={[st.topBtn, { position: 'absolute', top: insets.top + 8, left: 12 }]} onPress={onClose}>
          <IconX size={24} color="#fff" />
        </TouchableOpacity>
      </View>
    );
  }

  const ringWidth = ringAnim.interpolate({ inputRange: [0, 1], outputRange: ['0%', '100%'] });
  const flashLabel = flash === 'auto' ? 'A' : null;
  const flashDisabled = position === 'front' ? false : !(device.hasFlash || device.hasTorch);

  return (
    <View style={st.root}>
      <StatusBar hidden />
      <TouchableOpacity activeOpacity={1} onPress={onPreviewTap} style={StyleSheet.absoluteFill}>
        <Camera
          ref={cameraRef}
          style={StyleSheet.absoluteFill}
          device={device}
          format={format}
          isActive={appActive}
          photo
          video
          audio={audioOn}
          zoom={zoom}
          enableZoomGesture={!recording}
          photoQualityBalance="balanced"
          videoBitRate="normal"
          onInitialized={() => setReady(true)}
          onError={(e) => { if (__DEV__) console.warn('[ChatCamera] camera error', e?.code || e?.message || e); }}
        />
      </TouchableOpacity>

      {screenFlash ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: '#fff' }]} /> : null}

      {/* Top bar */}
      <View style={[st.topBar, { top: insets.top + 6 }]} pointerEvents="box-none">
        <TouchableOpacity style={st.topBtn} onPress={onClose} disabled={recording}
          accessibilityRole="button" accessibilityLabel={tt(t, 'common.close', 'Fechar')}>
          <IconX size={26} color="#fff" />
        </TouchableOpacity>
        {recording ? (
          <View style={st.recPill}>
            <Animated.View style={[st.recDot, { opacity: pulse }]} />
            <Text style={st.recTxt}>{fmtDur(recSec)}</Text>
          </View>
        ) : null}
        <TouchableOpacity style={[st.topBtn, flashDisabled && { opacity: 0.35 }]} onPress={cycleFlash} disabled={flashDisabled || recording}
          accessibilityRole="button"
          accessibilityLabel={`Flash ${flash === 'off' ? tt(t, 'chatCamera.flashOff', 'desligado') : flash === 'on' ? tt(t, 'chatCamera.flashOn', 'ligado') : 'auto'}`}>
          <View>
            <IconZap size={24} color={flash === 'off' ? '#fff' : '#facc15'} />
            {flash === 'off' ? <View style={st.flashSlash} /> : null}
            {flashLabel ? <Text style={st.flashAuto}>{flashLabel}</Text> : null}
          </View>
        </TouchableOpacity>
      </View>

      {/* Bottom: recent strip + controls */}
      <View style={[st.bottom, { paddingBottom: insets.bottom + 14 }]} pointerEvents="box-none">
        {!recording && recent.length > 0 ? (
          <View style={st.stripWrap}>
            <FlatList
              data={recent}
              horizontal
              keyExtractor={(a) => a.id}
              renderItem={renderRecent}
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 8 }}
              initialNumToRender={10}
              windowSize={5}
              extraData={selected}
            />
            {selected.length > 0 ? (
              <TouchableOpacity style={st.sendSel} onPress={sendSelected} disabled={resolving}
                accessibilityRole="button" accessibilityLabel={tt(t, 'common.next', 'Próximo')}>
                {resolving ? <ActivityIndicator color="#000" size="small" /> : (
                  <>
                    <Text style={st.sendSelTxt}>{selected.length}</Text>
                    <IconSend size={18} color="#000" />
                  </>
                )}
              </TouchableOpacity>
            ) : null}
          </View>
        ) : null}

        <View style={st.controls}>
          <TouchableOpacity style={st.sideBtn} onPress={() => { if (!recording) onOpenGallery?.(); }} disabled={recording}
            accessibilityRole="button" accessibilityLabel={tt(t, 'chatConv.gallery', 'Galeria')}>
            {!recording ? <IconImage size={26} color="#fff" /> : null}
          </TouchableOpacity>

          <View {...shutterPan.panHandlers} style={st.shutterHit}
            accessible accessibilityRole="button"
            accessibilityLabel={tt(t, 'chatCamera.shutterA11y', 'Toque para foto, segure para vídeo')}
            accessibilityActions={[{ name: 'activate' }]}
            onAccessibilityAction={() => takePhoto()}
          >
            <View style={[st.shutterOuter, recording && st.shutterOuterRec]}>
              <View style={[st.shutterInner, recording && st.shutterInnerRec]} />
            </View>
            {busy ? <ActivityIndicator style={StyleSheet.absoluteFill} color="#fff" /> : null}
          </View>

          <TouchableOpacity style={st.sideBtn} onPress={flip} disabled={recording}
            accessibilityRole="button" accessibilityLabel={tt(t, 'chatCamera.flip', 'Virar câmera')}>
            {!recording ? <IconRefresh size={26} color="#fff" /> : null}
          </TouchableOpacity>
        </View>

        {recording ? (
          <View style={st.progressTrack}><Animated.View style={[st.progressFill, { width: ringWidth }]} /></View>
        ) : (
          <Text style={st.hint}>{tt(t, 'chatCamera.hint', 'Segure para gravar vídeo, toque para foto')}</Text>
        )}
      </View>

      {!ready ? <View pointerEvents="none" style={[StyleSheet.absoluteFill, st.center]}><ActivityIndicator color="#fff" /></View> : null}
    </View>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },
  center: { alignItems: 'center', justifyContent: 'center' },
  permTitle: { color: '#fff', fontSize: 19, fontWeight: '700', textAlign: 'center', marginBottom: 10 },
  permBody: { color: 'rgba(255,255,255,0.75)', fontSize: 15, textAlign: 'center', lineHeight: 21 },
  // [2026-10-10 conv-polish] P&B: botões/seleção brancos com tinta preta sobre a câmera (era verde WhatsApp).
  permBtn: { marginTop: 22, backgroundColor: '#fff', borderRadius: 22, paddingHorizontal: 22, paddingVertical: 11 },
  permBtnTxt: { color: '#000', fontWeight: '700', fontSize: 15 },
  topBar: { position: 'absolute', left: 12, right: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  topBtn: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  flashSlash: { position: 'absolute', left: -1, top: 11, width: 27, height: 2, backgroundColor: '#fff', transform: [{ rotate: '-45deg' }] },
  flashAuto: { position: 'absolute', right: -8, bottom: -4, color: '#facc15', fontSize: 11, fontWeight: '800' },
  recPill: { flexDirection: 'row', alignItems: 'center', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 14, paddingHorizontal: 10, paddingVertical: 4 },
  recDot: { width: 9, height: 9, borderRadius: 5, backgroundColor: '#ef4444', marginRight: 6 },
  recTxt: { color: '#fff', fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  bottom: { position: 'absolute', left: 0, right: 0, bottom: 0 },
  stripWrap: { flexDirection: 'row', alignItems: 'center', marginBottom: 14 },
  thumbWrap: { width: 64, height: 64, marginHorizontal: 2, borderRadius: 6, overflow: 'hidden' },
  thumb: { width: 64, height: 64 },
  thumbDur: { position: 'absolute', left: 4, bottom: 2, color: '#fff', fontSize: 10, fontWeight: '700', textShadowColor: 'rgba(0,0,0,0.8)', textShadowRadius: 3 },
  thumbSel: { position: 'absolute', top: 3, right: 3, minWidth: 20, height: 20, borderRadius: 10, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center', borderWidth: 1.5, borderColor: '#000' },
  thumbSelTxt: { color: '#000', fontSize: 11, fontWeight: '800' },
  sendSel: { flexDirection: 'row', alignItems: 'center', gap: 6, backgroundColor: '#fff', borderRadius: 22, height: 44, paddingHorizontal: 14, marginRight: 10, marginLeft: 4 },
  sendSelTxt: { color: '#000', fontWeight: '800', fontSize: 15 },
  controls: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 32 },
  sideBtn: { width: 48, height: 48, borderRadius: 24, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.25)' },
  shutterHit: { width: SHUTTER + 24, height: SHUTTER + 24, alignItems: 'center', justifyContent: 'center' },
  shutterOuter: { width: SHUTTER, height: SHUTTER, borderRadius: SHUTTER / 2, borderWidth: 5, borderColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  shutterOuterRec: { width: SHUTTER + 18, height: SHUTTER + 18, borderRadius: (SHUTTER + 18) / 2, borderColor: 'rgba(255,255,255,0.85)' },
  shutterInner: { width: SHUTTER - 18, height: SHUTTER - 18, borderRadius: (SHUTTER - 18) / 2, backgroundColor: 'transparent' },
  shutterInnerRec: { width: 34, height: 34, borderRadius: 17, backgroundColor: '#ef4444' },
  progressTrack: { height: 3, marginHorizontal: 40, marginTop: 16, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)', overflow: 'hidden' },
  progressFill: { height: 3, backgroundColor: '#ef4444' },
  hint: { color: 'rgba(255,255,255,0.85)', textAlign: 'center', fontSize: 13, marginTop: 12, textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4 },
});
