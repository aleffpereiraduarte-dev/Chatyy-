/**
 * StatusCamera — Instagram-level camera for status creation
 * Real photo filters with live preview, video recording, gallery picker
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Dimensions,
  Platform, Image, Pressable, ScrollView, FlatList,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import CachedImage from './CachedImage';
import { IconRefresh } from './Icons';

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

// Capture modes
const MODES = ['photo', 'video', 'boomerang'];
const MODE_LABELS = { photo: 'FOTO', video: 'VIDEO', boomerang: 'BOOMERANG' };

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

  const cameraRef = useRef(null);
  const recordTimerRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  const activeFilter = FILTERS[filterIdx] || FILTERS[0];

  // ─── Record animation ───
  useEffect(() => {
    if (recording) {
      Animated.loop(Animated.sequence([
        Animated.timing(pulseAnim, { toValue: 1.2, duration: 500, useNativeDriver: true }),
        Animated.timing(pulseAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
      ])).start();
      recordTimerRef.current = setInterval(() => setRecordTimer(p => p + 1), 1000);
      const maxTimer = setTimeout(() => stopRecording(), 30000);
      return () => { clearTimeout(maxTimer); clearInterval(recordTimerRef.current); };
    } else {
      pulseAnim.setValue(1);
      clearInterval(recordTimerRef.current);
      setRecordTimer(0);
    }
  }, [recording]);

  useEffect(() => {
    if (recording) {
      progressAnim.setValue(0);
      Animated.timing(progressAnim, { toValue: 1, duration: 30000, useNativeDriver: false }).start();
    } else {
      progressAnim.setValue(0);
    }
  }, [recording]);

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
      setPreview({ uri: finalUri, type: 'photo', width: photo.width, height: photo.height });
    } catch (e) {
      console.warn('[StatusCamera] photo error:', e);
    }
  }, [facing]);

  const startRecording = useCallback(async () => {
    if (!cameraRef.current || recording) return;
    setRecording(true);
    try {
      const video = await cameraRef.current.recordAsync({ maxDuration: 30, quality: '720p' });
      if (video?.uri) setPreview({ uri: video.uri, type: 'video' });
    } catch (e) {
      console.warn('[StatusCamera] record error:', e);
    }
    setRecording(false);
  }, [recording]);

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
      if (video?.uri) setPreview({ uri: video.uri, type: 'video', isBoomerang: true });
    } catch (e) {
      console.warn('[StatusCamera] boomerang error:', e);
    }
    setRecording(false);
  }, [recording]);

  const handleCapturePress = useCallback(async () => {
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
    } else if (captureMode === 'boomerang') {
      // Boomerang is now a real 1.5s loop-video capture (not a still frame).
      await recordBoomerang();
    } else if (captureMode === 'video') {
      recording ? stopRecording() : startRecording();
    }
  }, [captureMode, recording, timerDelay, takePhoto, recordBoomerang, startRecording, stopRecording]);

  const handleLongPress = useCallback(() => {
    if (captureMode === 'photo') { setCaptureMode('video'); startRecording(); }
  }, [captureMode, startRecording]);

  const handlePressOut = useCallback(() => {
    if (recording) { stopRecording(); setCaptureMode('photo'); }
  }, [recording, stopRecording]);

  // ─── Gallery ───
  const openGallery = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'], quality: 0.92, videoMaxDuration: 30,
    });
    if (!result.canceled && result.assets?.[0]) {
      const a = result.assets[0];
      const isVid = a.type === 'video' || /\.(mp4|mov|webm|3gp)$/i.test(a.uri || '');
      setPreview({ uri: a.uri, type: isVid ? 'video' : 'photo', width: a.width, height: a.height });
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
    return (
      <View style={s.container}>
        <View style={s.permBox}>
          <Text style={s.permText}>
            {t?.('status.cameraPermission') || 'Precisamos de acesso à câmera para criar status'}
          </Text>
          <TouchableOpacity style={s.permBtn} onPress={requestPermission}>
            <Text style={s.permBtnTxt}>{t?.('common.allow') || 'Permitir'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[s.permBtn, { backgroundColor: '#555' }]} onPress={onClose}>
            <Text style={s.permBtnTxt}>{t?.('common.cancel') || 'Cancelar'}</Text>
          </TouchableOpacity>
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

      {/* Top bar */}
      <View style={s.topBar}>
        <TouchableOpacity onPress={onClose} style={s.topBtn}>
          <Text style={s.topBtnTxt}>✕</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setFlash(f => f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off')}
          style={s.topBtn}
        >
          <Text style={s.topBtnTxt}>
            {flash === 'off' ? '⚡' : flash === 'on' ? '⚡✓' : '⚡A'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setTimerDelay(d => d === 0 ? 3 : d === 3 ? 10 : 0)}
          style={s.topBtn}
        >
          <Text style={s.topBtnTxt}>
            {timerDelay === 0 ? '⏱' : `⏱${timerDelay}s`}
          </Text>
        </TouchableOpacity>
      </View>

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

      {/* Mode bar */}
      <View style={s.modeBar}>
        {MODES.map((m) => (
          <TouchableOpacity
            key={m}
            onPress={() => setCaptureMode(m)}
            style={[s.modeItem, captureMode === m && s.modeItemActive]}
          >
            <Text style={[s.modeTxt, captureMode === m && s.modeTxtActive]}>
              {MODE_LABELS[m]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Bottom bar: gallery / capture / flip */}
      <View style={s.botBar}>
        <TouchableOpacity onPress={openGallery} style={s.galleryBtn}>
          <Text style={{ fontSize: 20 }}>🖼</Text>
        </TouchableOpacity>

        <Pressable
          onPress={handleCapturePress}
          onLongPress={handleLongPress}
          onPressOut={handlePressOut}
          delayLongPress={300}
          style={s.capOuter}
        >
          <Animated.View style={[
            s.capInner,
            recording && s.capRec,
            { transform: [{ scale: pulseAnim }] },
          ]} />
          {recording && (
            <View style={s.progRing}>
              <Animated.View style={[s.progArc, {
                borderColor: '#FF3B30',
                borderTopColor: 'transparent',
                transform: [{ rotate: progressAnim.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] }) }],
              }]} />
            </View>
          )}
        </Pressable>

        <TouchableOpacity
          onPress={() => setFacing(f => f === 'front' ? 'back' : 'front')}
          style={s.flipBtn}
          accessibilityLabel="Flip camera"
          accessibilityRole="button"
        >
          <IconRefresh size={24} color="#fff" />
        </TouchableOpacity>
      </View>
    </View>
  );
}

// ═══════════════════════════════
// STYLES
// ═══════════════════════════════
const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  camera: { flex: 1 },

  // Top bar
  topBar: {
    position: 'absolute', top: Platform.OS === 'ios' ? 60 : 40,
    left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-between',
    paddingHorizontal: 20, zIndex: 10,
  },
  topBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center', justifyContent: 'center',
  },
  topBtnTxt: { color: '#fff', fontSize: 18, fontWeight: '700' },

  // Mode bar
  modeBar: {
    position: 'absolute', bottom: 140,
    left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', gap: 20,
  },
  modeItem: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16 },
  modeItemActive: { backgroundColor: 'rgba(255,255,255,0.2)' },
  modeTxt: { color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  modeTxtActive: { color: '#fff' },

  // Bottom bar
  botBar: {
    position: 'absolute', bottom: 50,
    left: 0, right: 0,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly',
  },
  galleryBtn: {
    width: 48, height: 48, borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.3)',
  },
  flipBtn: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },

  // Capture button
  capOuter: {
    width: 80, height: 80, borderRadius: 40,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  capInner: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#fff' },
  capRec: { backgroundColor: '#FF3B30', borderRadius: 8, width: 36, height: 36 },
  progRing: { position: 'absolute', width: 80, height: 80, alignItems: 'center', justifyContent: 'center' },
  progArc: { width: 80, height: 80, borderRadius: 40, borderWidth: 4 },

  // Record badge
  recBadge: {
    position: 'absolute', top: Platform.OS === 'ios' ? 110 : 90,
    alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,0,0,0.7)', borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 5,
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
