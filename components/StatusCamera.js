/**
 * StatusCamera — Instagram-level camera for status creation
 * Real photo filters with live preview, video recording, gallery picker
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Dimensions,
  Platform, Image, Pressable, ScrollView, FlatList, Linking, Modal,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import CachedImage from './CachedImage';
import { IconRefresh } from './Icons';

// Haptics (graceful — `expo-haptics` may not be present in every build)
let _Haptics = null;
try { _Haptics = require('expo-haptics'); } catch {}
const haptic = (kind) => {
  if (!_Haptics) return;
  try {
    if (kind === 'medium') _Haptics.impactAsync?.(_Haptics.ImpactFeedbackStyle?.Medium);
    else if (kind === 'heavy') _Haptics.impactAsync?.(_Haptics.ImpactFeedbackStyle?.Heavy);
    else _Haptics.impactAsync?.(_Haptics.ImpactFeedbackStyle?.Light);
  } catch {}
};

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;
const THUMB_SIZE = 76;

// ─── Instagram-style filters ───
// Each filter has: overlay layers (tint color + opacity + blendMode) that stack
// on top of the image on native. On confirm, the filter key is passed to parent.
export const FILTERS = [
  { key: 'normal',    label: 'Normal',    layers: [] },
  { key: 'clarendon', label: 'Clarendon', layers: [
    { color: 'rgba(127,187,227,0.2)', blend: 'overlay' },
    { color: 'rgba(0,0,0,0.05)', blend: 'multiply' },
  ], adjust: { contrast: 1.2, saturate: 1.35 } },
  { key: 'gingham',   label: 'Gingham',   layers: [
    { color: 'rgba(230,230,250,0.2)', blend: 'soft-light' },
  ], adjust: { brightness: 1.05, hueRotate: -10 } },
  { key: 'moon',      label: 'Moon',      layers: [
    { color: 'rgba(160,160,186,0.35)', blend: 'overlay' },
  ], adjust: { grayscale: 1, contrast: 1.1, brightness: 1.1 } },
  { key: 'lark',      label: 'Lark',      layers: [
    { color: 'rgba(242,242,220,0.15)', blend: 'soft-light' },
  ], adjust: { contrast: 0.9, brightness: 1.15, saturate: 1.2 } },
  { key: 'reyes',     label: 'Reyes',     layers: [
    { color: 'rgba(239,205,173,0.25)', blend: 'overlay' },
  ], adjust: { sepia: 0.22, brightness: 1.1, contrast: 0.85, saturate: 0.75 } },
  { key: 'juno',      label: 'Juno',      layers: [
    { color: 'rgba(127,140,200,0.12)', blend: 'overlay' },
  ], adjust: { contrast: 1.15, brightness: 1.05, saturate: 1.7, sepia: 0.1 } },
  { key: 'slumber',   label: 'Slumber',   layers: [
    { color: 'rgba(125,105,24,0.2)', blend: 'overlay' },
  ], adjust: { saturate: 0.66, brightness: 1.05 } },
  { key: 'aden',      label: 'Aden',      layers: [
    { color: 'rgba(66,10,14,0.12)', blend: 'soft-light' },
    { color: 'rgba(230,193,165,0.1)', blend: 'overlay' },
  ], adjust: { hueRotate: -20, contrast: 0.9, saturate: 0.85, brightness: 1.2 } },
  { key: 'valencia',  label: 'Valencia',  layers: [
    { color: 'rgba(58,3,3,0.12)', blend: 'overlay' },
  ], adjust: { contrast: 1.08, brightness: 1.08, sepia: 0.08 } },
  { key: 'nashville', label: 'Nashville', layers: [
    { color: 'rgba(247,176,59,0.18)', blend: 'overlay' },
    { color: 'rgba(0,70,150,0.08)', blend: 'multiply' },
  ], adjust: { contrast: 1.2, brightness: 1.05, saturate: 1.2, sepia: 0.15 } },
  { key: 'perpetua',  label: 'Perpetua',  layers: [
    { color: 'rgba(0,91,154,0.12)', blend: 'soft-light' },
    { color: 'rgba(230,193,61,0.08)', blend: 'overlay' },
  ], adjust: { saturate: 1.25, brightness: 1.05 } },
  { key: 'toaster',   label: 'Toaster',   layers: [
    { color: 'rgba(128,78,15,0.2)', blend: 'overlay' },
  ], adjust: { contrast: 1.5, brightness: 0.9, saturate: 1.3 } },
  { key: 'walden',    label: 'Walden',    layers: [
    { color: 'rgba(0,68,204,0.12)', blend: 'soft-light' },
    { color: 'rgba(204,204,0,0.06)', blend: 'overlay' },
  ], adjust: { brightness: 1.1, saturate: 1.6, hueRotate: 10 } },
  { key: 'hudson',    label: 'Hudson',    layers: [
    { color: 'rgba(166,177,255,0.18)', blend: 'overlay' },
  ], adjust: { brightness: 1.2, contrast: 0.9, saturate: 1.1 } },
  { key: 'xpro2',     label: 'X-Pro II',  layers: [
    { color: 'rgba(230,97,0,0.15)', blend: 'overlay' },
    { color: 'rgba(0,0,80,0.12)', blend: 'multiply' },
  ], adjust: { contrast: 1.3, saturate: 1.4, sepia: 0.1 } },
  { key: 'rise',      label: 'Rise',      layers: [
    { color: 'rgba(236,205,169,0.15)', blend: 'overlay' },
    { color: 'rgba(50,30,7,0.08)', blend: 'multiply' },
  ], adjust: { brightness: 1.05, contrast: 0.9, saturate: 0.9, sepia: 0.05 } },
  { key: 'sierra',    label: 'Sierra',    layers: [
    { color: 'rgba(128,78,15,0.15)', blend: 'overlay' },
  ], adjust: { contrast: 0.85, saturate: 0.75, brightness: 1.15 } },
  { key: 'inkwell',   label: 'Inkwell',   layers: [
    { color: 'rgba(0,0,0,0.08)', blend: 'multiply' },
  ], adjust: { grayscale: 1, contrast: 1.25, brightness: 1.05 } },
  { key: 'lofi',      label: 'Lo-Fi',     layers: [
    { color: 'rgba(34,34,34,0.1)', blend: 'multiply' },
  ], adjust: { contrast: 1.5, saturate: 1.1, brightness: 1.0 } },
  { key: 'earlybird', label: 'Earlybird', layers: [
    { color: 'rgba(208,186,142,0.2)', blend: 'overlay' },
    { color: 'rgba(100,50,10,0.1)', blend: 'multiply' },
  ], adjust: { contrast: 0.9, sepia: 0.25, saturate: 1.3, brightness: 1.05 } },
];

// Capture modes — TikTok-style 3-tab swipeable bar
const MODES = ['photo', 'video', 'story'];
const MODE_LABELS = { photo: 'Foto', video: 'Vídeo', story: 'Story' };

// Speed cycle (TikTok pattern — affects video playback rate metadata)
const SPEED_CYCLE = [0.3, 0.5, 1, 2, 3];
const SPEED_LABELS = { 0.3: '0.3x', 0.5: '0.5x', 1: '1x', 2: '2x', 3: '3x' };

// Brand purple gradient — applied via tinted ring layers around record button
const BRAND_PURPLE = '#5B21B6';
const BRAND_PURPLE_LIGHT = '#7C3AED';
const BRAND_PINK = '#EC4899';

// Max video duration (TikTok-style 60s cap)
const MAX_RECORD_MS = 60000;

// ─── Filter overlay component (native) ───
export function FilterOverlay({ filter, style }) {
  if (!filter?.layers?.length) return null;
  return filter.layers.map((layer, i) => (
    <View
      key={i}
      pointerEvents="none"
      style={[StyleSheet.absoluteFill, style, { backgroundColor: layer.color }]}
    />
  ));
}

// ─── Filter thumbnail ───
function FilterThumb({ filter, uri, selected, onPress }) {
  return (
    <TouchableOpacity onPress={onPress} activeOpacity={0.7} style={s.thumbWrap}>
      <View style={[s.thumbFrame, selected && s.thumbFrameActive]}>
        <Image source={{ uri }} style={s.thumbImg} resizeMode="cover" />
        <FilterOverlay filter={filter} style={{ borderRadius: 8 }} />
      </View>
      <Text style={[s.thumbLabel, selected && s.thumbLabelActive]} numberOfLines={1}>
        {filter.label}
      </Text>
    </TouchableOpacity>
  );
}

export default function StatusCamera({ visible, onClose, onCapture, t }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState('front');
  const [flash, setFlash] = useState('off');
  const [captureMode, setCaptureMode] = useState('photo');
  const [recording, setRecording] = useState(false);
  const [recordTimer, setRecordTimer] = useState(0);
  const [preview, setPreview] = useState(null);
  const [filterIdx, setFilterIdx] = useState(0);
  const [timerDelay, setTimerDelay] = useState(0);
  const [counting, setCounting] = useState(false);
  const [countDown, setCountDown] = useState(0);

  // ── TikTok-grade additions ──
  const [speed, setSpeed] = useState(1);              // playback speed
  const [beauty, setBeauty] = useState(false);        // beauty filter toggle
  const [musicTrack, setMusicTrack] = useState(null); // {id, title} or null
  const [musicPickerOpen, setMusicPickerOpen] = useState(false);
  const [galleryThumb, setGalleryThumb] = useState(null); // last roll asset uri
  const [showSwipeHint, setShowSwipeHint] = useState(true);

  const cameraRef = useRef(null);
  const recordTimerRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;
  // record-button press scale (TikTok-style squish)
  const recScaleAnim = useRef(new Animated.Value(1)).current;
  // glow halo opacity when recording
  const glowAnim = useRef(new Animated.Value(0)).current;
  // swipe-hint fade
  const hintFadeAnim = useRef(new Animated.Value(0)).current;

  const activeFilter = FILTERS[filterIdx] || FILTERS[0];

  // ─── Record animation (pulse + purple glow halo) ───
  useEffect(() => {
    if (recording) {
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.15, duration: 600, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
      ])).start();
      Animated.timing(glowAnim, { toValue: 1, duration: 240, useNativeDriver: true }).start();
      recordTimerRef.current = setInterval(() => setRecordTimer(p => p + 1), 1000);
      const maxTimer = setTimeout(() => stopRecording(), MAX_RECORD_MS);
      return () => { clearTimeout(maxTimer); clearInterval(recordTimerRef.current); };
    } else {
      pulseAnim.setValue(1);
      Animated.timing(glowAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      clearInterval(recordTimerRef.current);
      setRecordTimer(0);
    }
  }, [recording]);

  useEffect(() => {
    if (recording) {
      progressAnim.setValue(0);
      Animated.timing(progressAnim, { toValue: 1, duration: MAX_RECORD_MS, useNativeDriver: false }).start();
    } else {
      progressAnim.setValue(0);
    }
  }, [recording]);

  // ─── Swipe hint fade-in/out (Feature 8) ───
  useEffect(() => {
    if (!visible || !showSwipeHint) return;
    Animated.sequence([
      Animated.timing(hintFadeAnim, { toValue: 1, duration: 400, useNativeDriver: true }),
      Animated.delay(2000),
      Animated.timing(hintFadeAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
    ]).start(() => setShowSwipeHint(false));
  }, [visible]);

  // ─── Pre-load last camera-roll thumb (Feature 7) ───
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    (async () => {
      try {
        const perm = await ImagePicker.getMediaLibraryPermissionsAsync?.();
        if (!perm?.granted) return;
        // expo-media-library would be cleaner, but to avoid a new dep we just
        // skip the thumb when not granted. The picker still works on tap.
        const MediaLibrary = (() => { try { return require('expo-media-library'); } catch { return null; } })();
        if (!MediaLibrary?.getAssetsAsync) return;
        const res = await MediaLibrary.getAssetsAsync({ first: 1, sortBy: ['creationTime'], mediaType: ['photo'] });
        if (!cancelled && res?.assets?.[0]?.uri) setGalleryThumb(res.assets[0].uri);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [visible]);

  const fmtTime = (s) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  // ─── Capture ───
  const takePhoto = useCallback(async () => {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({ quality: 0.92, exif: false });
      let finalUri = photo.uri;
      // Front-camera mirror fix: flip horizontally so the saved photo matches
      // what the user saw in the preview (iOS/Android save a non-mirrored image
      // but the preview is mirrored — selfie looks "backwards" after capture).
      if (facing === 'front' && Platform.OS !== 'web') {
        try {
          const ImageManipulator = require('expo-image-manipulator');
          const flipped = await ImageManipulator.manipulateAsync(
            photo.uri,
            [{ flip: ImageManipulator.FlipType.Horizontal }],
            { compress: 0.92, format: ImageManipulator.SaveFormat.JPEG }
          );
          finalUri = flipped.uri;
        } catch (e) { console.warn('[StatusCamera] flip failed:', e?.message); }
      }
      // Skip the in-camera preview/filter pass — the parent's StatusEditor
      // already provides a fullscreen preview with filters + caption + send.
      // Showing both screens was confusing (and broke for videos because the
      // local preview tried to render an mp4 inside <CachedImage>).
      // Carry the live-selected filter forward (Feature E) so the StatusEditor
      // re-applies it and stores it in status meta.
      onCapture?.({
        uri: finalUri,
        type: 'photo',
        width: photo.width,
        height: photo.height,
        filter: activeFilter.key !== 'normal' ? activeFilter.key : undefined,
        filterAdjust: activeFilter.adjust || undefined,
        beauty: beauty || undefined,
        music: musicTrack || undefined,
      });
    } catch (e) {
      console.warn('[StatusCamera] photo error:', e);
    }
  }, [facing, onCapture, activeFilter, beauty, musicTrack]);

  const startRecording = useCallback(async () => {
    if (!cameraRef.current || recording) return;
    setRecording(true);
    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: 30, quality: '720p' });
      if (video?.uri) onCapture?.({
        uri: video.uri,
        type: 'video',
        filter: activeFilter.key !== 'normal' ? activeFilter.key : undefined,
        filterAdjust: activeFilter.adjust || undefined,
        speed: speed !== 1 ? speed : undefined,
        beauty: beauty || undefined,
        music: musicTrack || undefined,
      });
    } catch (e) {
      console.warn('[StatusCamera] record error:', e);
    }
    setRecording(false);
  }, [recording, onCapture, speed, beauty, musicTrack, activeFilter]);

  const stopRecording = useCallback(() => {
    if (cameraRef.current && recording) cameraRef.current.stopRecording();
  }, [recording]);

  // Boomerang: record a short 1.5s clip. The viewer then loops it back-and-forth
  // by playing forward → reversing playbackRate → repeat. Marking the capture
  // with `isBoomerang` tells downstream uploaders to pass it as a video status
  // with a tag so the viewer knows to loop it that way.
  const recordBoomerang = useCallback(async () => {
    if (!cameraRef.current || recording) return;
    setRecording(true);
    try {
      const boomerangPromise = cameraRef.current.recordAsync({ maxDuration: 2, quality: '720p' });
      // Auto-stop after 1.5s — recordAsync resolves once stopRecording fires.
      setTimeout(() => { try { cameraRef.current?.stopRecording?.(); } catch {} }, 1500);
      const video = await boomerangPromise;
      if (video?.uri) onCapture?.({
        uri: video.uri,
        type: 'video',
        isBoomerang: true,
        filter: activeFilter.key !== 'normal' ? activeFilter.key : undefined,
        filterAdjust: activeFilter.adjust || undefined,
      });
    } catch (e) {
      console.warn('[StatusCamera] boomerang error:', e);
    }
    setRecording(false);
  }, [recording, onCapture]);

  const handleCapturePress = useCallback(async () => {
    haptic('light');
    if (captureMode === 'photo') {
      if (timerDelay > 0) {
        setCounting(true);
        for (let i = timerDelay; i > 0; i--) {
          setCountDown(i);
          await new Promise(r => setTimeout(r, 1000));
        }
        setCounting(false); setCountDown(0);
      }
      await takePhoto();
    } else if (captureMode === 'story') {
      // Story mode = quick photo capture (uses status flow, no boomerang loop)
      await takePhoto();
    } else if (captureMode === 'video') {
      if (recording) { haptic('heavy'); stopRecording(); }
      else { haptic('medium'); startRecording(); }
    }
  }, [captureMode, recording, timerDelay, takePhoto, startRecording, stopRecording]);

  const handleLongPress = useCallback(() => {
    haptic('medium');
    if (captureMode === 'photo') { setCaptureMode('video'); startRecording(); }
  }, [captureMode, startRecording]);

  const handlePressIn = useCallback(() => {
    Animated.spring(recScaleAnim, { toValue: 0.92, useNativeDriver: true, friction: 6, tension: 180 }).start();
  }, []);

  const handlePressOut = useCallback(() => {
    Animated.spring(recScaleAnim, { toValue: 1, useNativeDriver: true, friction: 5, tension: 180 }).start();
    if (recording) { haptic('heavy'); stopRecording(); setCaptureMode('photo'); }
  }, [recording, stopRecording]);

  // ─── Gallery ───
  // Explicitly request photo-library permission first so the user gets the OS
  // sheet instead of a silent failure when iOS has revoked access. Without
  // this, tapping 🖼 just no-op'd and felt broken.
  const openGallery = useCallback(async () => {
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        if (perm.canAskAgain === false) {
          try { Linking.openSettings?.(); } catch {}
        }
        return;
      }
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images', 'videos'],
        quality: 0.92,
        videoMaxDuration: 60,
        allowsEditing: false,
        allowsMultipleSelection: true,
        selectionLimit: 10,
      });
      if (!result.canceled && result.assets?.length) {
        const isVid = (a) => a.type === 'video' || /\.(mp4|mov|webm|3gp)$/i.test(a.uri || '');
        if (result.assets.length === 1) {
          const a = result.assets[0];
          setPreview({ uri: a.uri, type: isVid(a) ? 'video' : 'photo', width: a.width, height: a.height });
        } else {
          // Multi-select → emit a carousel directly (skip the single-item
          // preview/filter editor; the parent publishes them as one story).
          onCapture?.({
            multi: true,
            items: result.assets.map(a => ({
              uri: a.uri,
              type: isVid(a) ? 'video' : 'photo',
              width: a.width,
              height: a.height,
            })),
          });
        }
      }
    } catch (e) {
      console.warn('[StatusCamera] gallery error:', e?.message);
    }
  }, []);

  // ─── Confirm ───
  const handleConfirm = useCallback(() => {
    if (!preview) return;
    onCapture?.({
      uri: preview.uri,
      type: preview.type,
      isBoomerang: !!preview.isBoomerang,
      filter: activeFilter.key !== 'normal' ? activeFilter.key : undefined,
      filterAdjust: activeFilter.adjust || undefined,
    });
    setPreview(null);
    setFilterIdx(0);
  }, [preview, activeFilter, onCapture]);

  // ─── Guards ───
  if (!visible) return null;

  if (!permission?.granted) {
    // Apple App Review 5.1.1(iv) compliance: the pre-permission screen MUST
    // (a) lead to the native permission dialog (no "Cancel" exit before it)
    // and (b) use neutral wording — "Continue", not "Allow". Once the user
    // explicitly denies via the native dialog, `permission.canAskAgain` is
    // false; only THEN we offer a Settings deep-link.
    const denied = permission && permission.granted === false && permission.canAskAgain === false;
    return (
      <View style={s.container}>
        <View style={s.permBox}>
          <Text style={s.permText}>
            {t?.('status.cameraPermission') || 'Precisamos de acesso à câmera para criar status.'}
          </Text>
          {denied ? (
            <TouchableOpacity style={s.permBtn} onPress={() => Linking.openSettings?.()}>
              <Text style={s.permBtnTxt}>{t?.('common.openSettings') || 'Abrir Ajustes'}</Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity style={s.permBtn} onPress={requestPermission}>
              <Text style={s.permBtnTxt}>{t?.('common.continue') || 'Continuar'}</Text>
            </TouchableOpacity>
          )}
        </View>
      </View>
    );
  }

  // ═══════════════════════════════════════
  // PREVIEW MODE — with Instagram filters
  // ═══════════════════════════════════════
  if (preview) {
    return (
      <View style={s.container}>
        {/* Main preview image + filter overlay */}
        <View style={{ flex: 1 }}>
          {preview.type === 'photo' ? (
            <View style={{ flex: 1 }}>
              <CachedImage source={{ uri: preview.uri }} style={s.previewImg} resizeMode="contain" />
              <FilterOverlay filter={activeFilter} />
            </View>
          ) : (
            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
              <CachedImage source={{ uri: preview.uri }} style={s.previewImg} resizeMode="contain" />
              <View style={{ position: 'absolute', top: 20, alignSelf: 'center', backgroundColor: 'rgba(255,0,0,0.7)', paddingHorizontal: 12, paddingVertical: 4, borderRadius: 12 }}>
                <Text style={{ color: '#fff', fontSize: 12, fontWeight: '700' }}>VIDEO</Text>
              </View>
            </View>
          )}
        </View>

        {/* Filter strip — horizontal scroll with thumbnails (Instagram-style) */}
        {preview.type === 'photo' && (
          <View style={s.filterBar}>
            <FlatList
              data={FILTERS}
              horizontal
              showsHorizontalScrollIndicator={false}
              keyExtractor={(f) => f.key}
              contentContainerStyle={{ paddingHorizontal: 12, gap: 8 }}
              renderItem={({ item, index }) => (
                <FilterThumb
                  filter={item}
                  uri={preview.uri}
                  selected={filterIdx === index}
                  onPress={() => setFilterIdx(index)}
                />
              )}
            />
          </View>
        )}

        {/* Bottom action bar */}
        <View style={s.previewActions}>
          <TouchableOpacity onPress={() => { setPreview(null); setFilterIdx(0); }} style={s.actionBtn}>
            <Text style={s.actionBtnTxt}>{t?.('status.retake') || 'Refazer'}</Text>
          </TouchableOpacity>

          {/* Filter name badge */}
          {activeFilter.key !== 'normal' && (
            <View style={s.filterBadge}>
              <Text style={s.filterBadgeTxt}>{activeFilter.label}</Text>
            </View>
          )}

          <TouchableOpacity onPress={handleConfirm} style={[s.actionBtn, s.confirmBtn]}>
            <Text style={[s.actionBtnTxt, { color: '#fff' }]}>{t?.('status.usePhoto') || 'Usar'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ═══════════════════════════════
  // CAMERA VIEW
  // ═══════════════════════════════
  return (
    <View style={s.container}>
      <CameraView
        ref={cameraRef}
        style={s.camera}
        facing={facing}
        flash={flash}
        mode={captureMode === 'video' ? 'video' : 'picture'}
      />

      {/* Top-left close (TikTok pattern, Feature 5) */}
      <TouchableOpacity
        onPress={() => { haptic('light'); onClose?.(); }}
        style={s.closeBtn}
        accessibilityLabel="Close camera"
        accessibilityRole="button"
      >
        <Text style={s.closeBtnTxt}>✕</Text>
      </TouchableOpacity>

      {/* Top music tile (Feature 6) — pill above mode tabs */}
      <TouchableOpacity
        onPress={() => { haptic('light'); setMusicPickerOpen(true); }}
        style={s.musicPill}
        accessibilityLabel="Add music"
        accessibilityRole="button"
      >
        <Text style={s.musicNote}>♫</Text>
        <Text style={s.musicLabel} numberOfLines={1}>
          {musicTrack?.title || 'Adicionar som'}
        </Text>
      </TouchableOpacity>

      {/* Right-side action stack (Feature 3) — TikTok vertical column */}
      <View style={s.rightStack} pointerEvents="box-none">
        <TouchableOpacity
          onPress={() => { haptic('light'); setFacing(f => f === 'front' ? 'back' : 'front'); }}
          style={s.stackBtn}
          accessibilityLabel="Flip camera"
        >
          <IconRefresh size={22} color="#fff" />
          <Text style={s.stackLabel}>Virar</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { haptic('light'); setFlash(f => f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off'); }}
          style={s.stackBtn}
          accessibilityLabel="Toggle flash"
        >
          <Text style={s.stackIcon}>{flash === 'off' ? '⚡' : flash === 'on' ? '⚡' : '⚡'}</Text>
          <Text style={s.stackLabel}>
            {flash === 'off' ? 'Off' : flash === 'on' ? 'On' : 'Auto'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => {
            haptic('light');
            setSpeed(prev => {
              const i = SPEED_CYCLE.indexOf(prev);
              return SPEED_CYCLE[(i + 1) % SPEED_CYCLE.length];
            });
          }}
          style={s.stackBtn}
          accessibilityLabel="Speed"
        >
          <Text style={[s.stackIcon, { fontSize: 13, fontWeight: '900' }]}>{SPEED_LABELS[speed]}</Text>
          <Text style={s.stackLabel}>Speed</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { haptic('light'); setBeauty(b => !b); }}
          style={[s.stackBtn, beauty && s.stackBtnActive]}
          accessibilityLabel="Beauty"
        >
          <Text style={s.stackIcon}>✨</Text>
          <Text style={s.stackLabel}>Beauty</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => { haptic('light'); setTimerDelay(d => d === 0 ? 3 : d === 3 ? 10 : 0); }}
          style={[s.stackBtn, timerDelay > 0 && s.stackBtnActive]}
          accessibilityLabel="Timer"
        >
          <Text style={s.stackIcon}>⏱</Text>
          <Text style={s.stackLabel}>{timerDelay === 0 ? 'Timer' : `${timerDelay}s`}</Text>
        </TouchableOpacity>
      </View>

      {/* Beauty soft overlay */}
      {beauty && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,220,225,0.10)' }]} />
      )}

      {/* Countdown */}
      {counting && (
        <View style={s.countdown}>
          <Text style={s.countdownTxt}>{countDown}</Text>
        </View>
      )}

      {/* Record timer badge */}
      {recording && (
        <View style={s.recBadge}>
          <View style={s.recDot} />
          <Text style={s.recTxt}>{fmtTime(recordTimer)}</Text>
        </View>
      )}

      {/* Filter swipe hint (Feature 8) */}
      {showSwipeHint && (
        <Animated.View style={[s.swipeHint, { opacity: hintFadeAnim }]} pointerEvents="none">
          <Text style={s.swipeHintTxt}>Deslize pra trocar filtro</Text>
        </Animated.View>
      )}

      {/* Live filter overlay (Feature E) — applies the chosen filter on top of
          the camera preview before capture. Both layers + adjust hints are
          carried over to the saved status as `filter` meta so the viewer can
          re-apply on playback. */}
      <FilterOverlay filter={activeFilter} />

      {/* Live filter chip strip (Feature E) — horizontal scroll above the
          mode bar so users can pick a look while framing. Tap = apply. */}
      <View style={s.liveFilterStrip} pointerEvents="box-none">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 14, gap: 8 }}
        >
          {FILTERS.map((f, i) => {
            const sel = filterIdx === i;
            return (
              <TouchableOpacity
                key={f.key}
                onPress={() => setFilterIdx(i)}
                style={[s.liveFilterChip, sel && s.liveFilterChipActive]}
                accessibilityLabel={`Filter ${f.label}`}
              >
                <Text style={[s.liveFilterChipTxt, sel && s.liveFilterChipTxtActive]} numberOfLines={1}>
                  {f.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

      {/* Mode tabs — TikTok-style with active underline (Feature 4) */}
      <View style={s.modeBar}>
        {MODES.map((m) => {
          const active = captureMode === m;
          return (
            <TouchableOpacity
              key={m}
              onPress={() => { haptic('light'); setCaptureMode(m); }}
              style={s.modeItem}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[s.modeTxt, active && s.modeTxtActive]}>
                {MODE_LABELS[m]}
              </Text>
              {active && <View style={s.modeUnderline} />}
            </TouchableOpacity>
          );
        })}
      </View>

      {/* Bottom bar: gallery thumb / big record button / spacer */}
      <View style={s.botBar}>
        {/* Gallery picker thumb (Feature 7) */}
        <TouchableOpacity
          onPress={() => { haptic('light'); openGallery(); }}
          style={s.galleryThumb}
          accessibilityLabel={t?.('status.gallery') || 'Galeria'}
          accessibilityRole="button"
        >
          {galleryThumb ? (
            <Image source={{ uri: galleryThumb }} style={s.galleryThumbImg} />
          ) : (
            <View style={s.galleryThumbFallback}>
              <Text style={{ fontSize: 22 }}>🖼</Text>
            </View>
          )}
        </TouchableOpacity>

        {/* Big record button (Feature 1) — 86px white circle, 4px ring,
            purple glow when recording, with progress ring (Feature 2) */}
        <Pressable
          onPress={handleCapturePress}
          onLongPress={handleLongPress}
          onPressIn={handlePressIn}
          onPressOut={handlePressOut}
          delayLongPress={300}
          accessibilityLabel="Capture"
          accessibilityRole="button"
        >
          <View style={s.capWrap}>
            {/* Purple glow halo (only while recording) */}
            <Animated.View
              pointerEvents="none"
              style={[
                s.capGlow,
                {
                  opacity: glowAnim,
                  transform: [{ scale: glowAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1.15] }) }],
                },
              ]}
            />
            {/* Outer 86px white ring */}
            <Animated.View style={[s.capOuter, { transform: [{ scale: recScaleAnim }] }]}>
              {/* Inner solid disc — turns red square when recording */}
              <Animated.View style={[
                s.capInner,
                recording && s.capRec,
                { transform: [{ scale: pulseAnim }] },
              ]} />
              {/* Progress ring (60s anti-clockwise gradient) */}
              {recording && (
                <View style={s.progRing} pointerEvents="none">
                  <Animated.View style={[s.progArc, {
                    transform: [{ rotate: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '-360deg'] }) }],
                  }]} />
                </View>
              )}
            </Animated.View>
          </View>
        </Pressable>

        {/* Right-side spacer for symmetry (actions live on rightStack column) */}
        <View style={{ width: 50, height: 50 }} pointerEvents="none" />
      </View>

      {/* Music picker placeholder modal (Feature 6) */}
      <Modal
        transparent
        visible={musicPickerOpen}
        animationType="slide"
        onRequestClose={() => setMusicPickerOpen(false)}
      >
        <View style={s.musicSheetBackdrop}>
          <View style={s.musicSheet}>
            <View style={s.musicSheetHandle} />
            <Text style={s.musicSheetTitle}>Adicionar som</Text>
            <Text style={s.musicSheetEmpty}>Em breve — biblioteca de áudio do Chatyy</Text>
            <TouchableOpacity
              onPress={() => { haptic('light'); setMusicTrack(null); setMusicPickerOpen(false); }}
              style={s.musicSheetClose}
            >
              <Text style={s.musicSheetCloseTxt}>Fechar</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </View>
  );
}

// ═══════════════════════════════
// STYLES
// ═══════════════════════════════
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },

  // Top-left close (Feature 5)
  closeBtn: {
    position: 'absolute', top: Platform.OS === 'ios' ? 60 : 40, left: 16,
    width: 40, height: 40, borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center', zIndex: 30,
  },
  closeBtnTxt: { color: '#fff', fontSize: 20, fontWeight: '600', lineHeight: 22 },

  // Music tile (Feature 6)
  musicPill: {
    position: 'absolute', top: Platform.OS === 'ios' ? 64 : 44,
    alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)',
    borderRadius: 18, paddingHorizontal: 14, paddingVertical: 7,
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    maxWidth: 220, zIndex: 20,
  },
  musicNote: { color: '#fff', fontSize: 14, marginRight: 6, fontWeight: '700' },
  musicLabel: { color: '#fff', fontSize: 13, fontWeight: '600', letterSpacing: 0.2 },

  // Right-side action stack (Feature 3)
  rightStack: {
    position: 'absolute', right: 12, top: Platform.OS === 'ios' ? 130 : 110,
    alignItems: 'center', gap: 18, zIndex: 15,
  },
  stackBtn: {
    width: 50, alignItems: 'center', justifyContent: 'center',
    paddingVertical: 4,
  },
  stackBtnActive: {},
  stackIcon: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    color: '#fff', fontSize: 20, fontWeight: '700',
    textAlign: 'center', lineHeight: 44,
    overflow: 'hidden',
  },
  stackLabel: {
    color: '#fff', fontSize: 10, marginTop: 4, fontWeight: '700',
    letterSpacing: 0.3, textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },

  // Live filter chip strip (above mode bar, below preview)
  liveFilterStrip: {
    position: 'absolute', bottom: 195,
    left: 0, right: 0, height: 38,
  },
  liveFilterChip: {
    paddingHorizontal: 14, height: 32,
    borderRadius: 16, backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  liveFilterChipActive: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderColor: '#fff',
  },
  liveFilterChipTxt: {
    color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: '700', letterSpacing: 0.4,
  },
  liveFilterChipTxtActive: { color: '#000' },

  // Mode tabs (Feature 4) — TikTok bold tabs with white underline
  modeBar: {
    position: 'absolute', bottom: 150,
    left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', gap: 26,
  },
  modeItem: { paddingHorizontal: 6, paddingVertical: 6, alignItems: 'center' },
  modeTxt: {
    color: 'rgba(255,255,255,0.55)', fontSize: 14, fontWeight: '700',
    letterSpacing: 0.6, textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowOffset: { width: 0, height: 1 }, textShadowRadius: 2,
  },
  modeTxtActive: { color: '#fff', fontWeight: '900' },
  modeUnderline: {
    marginTop: 5, height: 3, width: 22, borderRadius: 2,
    backgroundColor: '#fff',
  },

  // Bottom bar
  botBar: {
    position: 'absolute', bottom: 36,
    left: 0, right: 0, paddingHorizontal: 24,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
  },

  // Gallery picker thumb (Feature 7)
  galleryThumb: {
    width: 50, height: 50, borderRadius: 12,
    overflow: 'hidden',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.85)',
    backgroundColor: 'rgba(255,255,255,0.10)',
    alignItems: 'center', justifyContent: 'center',
  },
  galleryThumbImg: { width: '100%', height: '100%' },
  galleryThumbFallback: {
    width: '100%', height: '100%', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(255,255,255,0.12)',
  },

  // Big record button (Feature 1) — 86px white, 4px ring
  capWrap: {
    width: 110, height: 110, alignItems: 'center', justifyContent: 'center',
  },
  capGlow: {
    position: 'absolute',
    width: 110, height: 110, borderRadius: 55,
    backgroundColor: BRAND_PURPLE_LIGHT,
    shadowColor: BRAND_PURPLE_LIGHT,
    shadowOpacity: 0.85, shadowRadius: 22, shadowOffset: { width: 0, height: 0 },
    elevation: 14,
  },
  capOuter: {
    width: 86, height: 86, borderRadius: 43,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  capInner: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#fff' },
  capRec: { backgroundColor: '#FF3B30', borderRadius: 8, width: 34, height: 34 },
  // Progress ring (Feature 2) — gradient-ish via layered borders, anti-clockwise
  progRing: {
    position: 'absolute', top: -4, left: -4,
    width: 94, height: 94, alignItems: 'center', justifyContent: 'center',
  },
  progArc: {
    width: 94, height: 94, borderRadius: 47, borderWidth: 4,
    borderColor: BRAND_PURPLE_LIGHT,
    borderTopColor: BRAND_PINK,
    borderRightColor: 'transparent',
  },

  // Swipe hint (Feature 8)
  swipeHint: {
    position: 'absolute', bottom: 220,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 14, paddingVertical: 7,
    borderRadius: 16,
  },
  swipeHintTxt: {
    color: 'rgba(255,255,255,0.92)', fontSize: 12, fontWeight: '600',
    letterSpacing: 0.3,
  },

  // Music picker bottom-sheet placeholder (Feature 6)
  musicSheetBackdrop: {
    flex: 1, backgroundColor: 'rgba(0,0,0,0.55)', justifyContent: 'flex-end',
  },
  musicSheet: {
    backgroundColor: '#1A0F2E',
    borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 24, paddingTop: 12, paddingBottom: 36,
    minHeight: 240,
  },
  musicSheetHandle: {
    alignSelf: 'center', width: 38, height: 4, borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.3)', marginBottom: 18,
  },
  musicSheetTitle: { color: '#fff', fontSize: 18, fontWeight: '800' },
  musicSheetEmpty: {
    color: 'rgba(255,255,255,0.6)', fontSize: 14, marginTop: 14, marginBottom: 22,
  },
  musicSheetClose: {
    backgroundColor: BRAND_PURPLE_LIGHT,
    paddingVertical: 14, borderRadius: 22, alignItems: 'center',
  },
  musicSheetCloseTxt: { color: '#fff', fontSize: 15, fontWeight: '800' },

  // Record badge
  recBadge: {
    position: 'absolute', top: Platform.OS === 'ios' ? 105 : 85,
    alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,0,0,0.85)', borderRadius: 14,
    paddingHorizontal: 12, paddingVertical: 5,
    zIndex: 25,
    shadowColor: '#FF3B30', shadowOpacity: 0.5, shadowRadius: 8, shadowOffset: { width: 0, height: 0 },
    elevation: 8,
  },
  recDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  recTxt: { color: '#fff', fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },

  // Countdown
  countdown: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 20,
  },
  countdownTxt: { color: '#fff', fontSize: 100, fontWeight: '900' },

  // Preview
  previewImg: { flex: 1, width: '100%' },

  // Filter bar (Instagram-style thumbnails)
  filterBar: {
    position: 'absolute',
    bottom: 90,
    left: 0, right: 0,
    height: THUMB_SIZE + 24,
  },

  // Filter thumbnail
  thumbWrap: { alignItems: 'center', width: THUMB_SIZE + 8 },
  thumbFrame: {
    width: THUMB_SIZE, height: THUMB_SIZE, borderRadius: 8,
    overflow: 'hidden', borderWidth: 2, borderColor: 'transparent',
  },
  thumbFrameActive: { borderColor: '#fff', borderWidth: 3 },
  thumbImg: { width: '100%', height: '100%' },
  thumbLabel: {
    color: 'rgba(255,255,255,0.6)', fontSize: 10, fontWeight: '600',
    marginTop: 4, textAlign: 'center',
  },
  thumbLabelActive: { color: '#fff', fontWeight: '800' },

  // Preview actions
  previewActions: {
    position: 'absolute', bottom: 20,
    left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-evenly', alignItems: 'center',
  },
  actionBtn: {
    paddingHorizontal: 28, paddingVertical: 14, borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  actionBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
  confirmBtn: { backgroundColor: '#25D366' },

  filterBadge: {
    backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 16,
    paddingHorizontal: 14, paddingVertical: 6,
  },
  filterBadgeTxt: { color: '#fff', fontSize: 13, fontWeight: '700' },

  // Permissions
  permBox: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24 },
  permText: { color: '#fff', fontSize: 16, textAlign: 'center', marginBottom: 12 },
  permBtn: {
    paddingHorizontal: 28, paddingVertical: 14, borderRadius: 24,
    backgroundColor: '#25D366', width: 200, alignItems: 'center',
  },
  permBtnTxt: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
