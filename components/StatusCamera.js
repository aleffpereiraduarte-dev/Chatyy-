/**
 * StatusCamera — Instagram-style camera for status creation
 * Supports: photo capture, video recording (hold), front/back camera,
 * flash toggle, gallery picker, boomerang mode, timer
 */
import React, { useState, useRef, useCallback, useEffect } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Animated, Dimensions,
  Platform, Image, ActivityIndicator, Pressable, Alert,
} from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import * as ImageManipulator from 'expo-image-manipulator';

const SCREEN_W = Dimensions.get('window').width;
const SCREEN_H = Dimensions.get('window').height;

// ─── Filter presets (Instagram-like) ───
const FILTERS = [
  { name: 'Normal', adjust: null },
  { name: 'Vivid', adjust: [{ resize: { width: 1080 } }], options: { compress: 0.95 } },
  { name: 'Warm', adjust: [{ resize: { width: 1080 } }], options: { compress: 0.9 } },
  { name: 'Cool', adjust: [{ resize: { width: 1080 } }], options: { compress: 0.85 } },
  { name: 'B&W', adjust: [{ resize: { width: 1080 } }], options: { compress: 0.9 } },
];

// ─── Capture modes ───
const MODES = ['photo', 'video', 'boomerang'];
const MODE_LABELS = { photo: 'FOTO', video: 'VIDEO', boomerang: 'BOOMERANG' };

export default function StatusCamera({ visible, onClose, onCapture, t }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState('front');
  const [flash, setFlash] = useState('off');
  const [captureMode, setCaptureMode] = useState('photo');
  const [recording, setRecording] = useState(false);
  const [recordTimer, setRecordTimer] = useState(0);
  const [preview, setPreview] = useState(null); // { uri, type: 'photo'|'video' }
  const [selectedFilter, setSelectedFilter] = useState(0);
  const [timerDelay, setTimerDelay] = useState(0); // 0, 3, 10
  const [counting, setCounting] = useState(false);
  const [countDown, setCountDown] = useState(0);

  const cameraRef = useRef(null);
  const recordTimerRef = useRef(null);
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const progressAnim = useRef(new Animated.Value(0)).current;

  // Pulse animation for record button
  useEffect(() => {
    if (recording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(pulseAnim, { toValue: 1.2, duration: 500, useNativeDriver: true }),
          Animated.timing(pulseAnim, { toValue: 1, duration: 500, useNativeDriver: true }),
        ])
      ).start();
      // Record timer counter
      recordTimerRef.current = setInterval(() => setRecordTimer(p => p + 1), 1000);
      // Max 30s video
      const maxTimer = setTimeout(() => stopRecording(), 30000);
      return () => { clearTimeout(maxTimer); clearInterval(recordTimerRef.current); };
    } else {
      pulseAnim.setValue(1);
      clearInterval(recordTimerRef.current);
      setRecordTimer(0);
    }
  }, [recording]);

  // Progress ring animation for video
  useEffect(() => {
    if (recording) {
      progressAnim.setValue(0);
      Animated.timing(progressAnim, {
        toValue: 1, duration: 30000, useNativeDriver: false,
      }).start();
    } else {
      progressAnim.setValue(0);
    }
  }, [recording]);

  const formatTimer = (s) => `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;

  // ─── Capture photo ───
  const takePhoto = useCallback(async () => {
    if (!cameraRef.current) return;
    try {
      const photo = await cameraRef.current.takePictureAsync({
        quality: 0.9,
        exif: false,
        skipProcessing: false,
      });
      setPreview({ uri: photo.uri, type: 'photo', width: photo.width, height: photo.height });
    } catch (e) {
      console.warn('[StatusCamera] photo error:', e);
    }
  }, []);

  // ─── Start video recording ───
  const startRecording = useCallback(async () => {
    if (!cameraRef.current || recording) return;
    setRecording(true);
    try {
      const video = await cameraRef.current.recordAsync({
        maxDuration: 30,
        quality: '720p',
      });
      if (video?.uri) {
        setPreview({ uri: video.uri, type: 'video' });
      }
    } catch (e) {
      console.warn('[StatusCamera] record error:', e);
    }
    setRecording(false);
  }, [recording]);

  // ─── Stop video recording ───
  const stopRecording = useCallback(() => {
    if (cameraRef.current && recording) {
      cameraRef.current.stopRecording();
    }
  }, [recording]);

  // ─── Handle capture button ───
  const handleCapturePress = useCallback(async () => {
    if (captureMode === 'photo' || captureMode === 'boomerang') {
      if (timerDelay > 0) {
        setCounting(true);
        setCountDown(timerDelay);
        for (let i = timerDelay; i > 0; i--) {
          setCountDown(i);
          await new Promise(r => setTimeout(r, 1000));
        }
        setCounting(false);
        setCountDown(0);
      }
      await takePhoto();
    } else if (captureMode === 'video') {
      if (recording) {
        stopRecording();
      } else {
        startRecording();
      }
    }
  }, [captureMode, recording, timerDelay, takePhoto, startRecording, stopRecording]);

  // ─── Long press for video (Instagram-style) ───
  const handleLongPress = useCallback(() => {
    if (captureMode === 'photo') {
      setCaptureMode('video');
      startRecording();
    }
  }, [captureMode, startRecording]);

  const handlePressOut = useCallback(() => {
    if (recording) {
      stopRecording();
      setCaptureMode('photo');
    }
  }, [recording, stopRecording]);

  // ─── Gallery picker ───
  const openGallery = useCallback(async () => {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      quality: 0.9,
      videoMaxDuration: 30,
    });
    if (!result.canceled && result.assets?.[0]) {
      const asset = result.assets[0];
      const isVideo = asset.type === 'video' || (asset.uri && /\.(mp4|mov|webm|3gp)$/i.test(asset.uri));
      setPreview({ uri: asset.uri, type: isVideo ? 'video' : 'photo', width: asset.width, height: asset.height });
    }
  }, []);

  // ─── Apply filter to image ───
  const applyFilter = useCallback(async (uri) => {
    const filter = FILTERS[selectedFilter];
    if (!filter.adjust || selectedFilter === 0) return uri;
    try {
      const result = await ImageManipulator.manipulateAsync(
        uri,
        filter.adjust,
        { compress: filter.options?.compress ?? 0.9, format: ImageManipulator.SaveFormat.JPEG }
      );
      return result.uri;
    } catch {
      return uri;
    }
  }, [selectedFilter]);

  // ─── Confirm and send ───
  const handleConfirm = useCallback(async () => {
    if (!preview) return;
    let finalUri = preview.uri;
    if (preview.type === 'photo') {
      finalUri = await applyFilter(preview.uri);
    }
    onCapture?.({ uri: finalUri, type: preview.type });
    setPreview(null);
  }, [preview, applyFilter, onCapture]);

  // ─── Permission handling ───
  if (!visible) return null;

  if (!permission?.granted) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionBox}>
          <Text style={styles.permissionText}>
            {t?.('status.cameraPermission') || 'Precisamos de acesso a camera para criar status'}
          </Text>
          <TouchableOpacity style={styles.permissionBtn} onPress={requestPermission}>
            <Text style={styles.permissionBtnText}>{t?.('common.allow') || 'Permitir'}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.permissionBtn, { backgroundColor: '#555' }]} onPress={onClose}>
            <Text style={styles.permissionBtnText}>{t?.('common.cancel') || 'Cancelar'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ─── Preview mode ───
  if (preview) {
    return (
      <View style={styles.container}>
        {preview.type === 'photo' ? (
          <Image source={{ uri: preview.uri }} style={styles.previewImage} resizeMode="contain" />
        ) : (
          <View style={styles.previewImage}>
            <Text style={styles.videoPreviewText}>Video Preview</Text>
            <Image source={{ uri: preview.uri }} style={styles.previewImage} resizeMode="contain" />
          </View>
        )}

        {/* Filter strip (photo only) */}
        {preview.type === 'photo' && (
          <View style={styles.filterStrip}>
            {FILTERS.map((f, i) => (
              <TouchableOpacity
                key={f.name}
                onPress={() => setSelectedFilter(i)}
                style={[styles.filterChip, selectedFilter === i && styles.filterChipActive]}
              >
                <Text style={[styles.filterLabel, selectedFilter === i && styles.filterLabelActive]}>
                  {f.name}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* Bottom controls */}
        <View style={styles.previewBottom}>
          <TouchableOpacity onPress={() => setPreview(null)} style={styles.retakeBtn}>
            <Text style={styles.retakeBtnText}>{t?.('status.retake') || 'Refazer'}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={handleConfirm} style={styles.confirmBtn}>
            <Text style={styles.confirmBtnText}>{t?.('status.usePhoto') || 'Usar'}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // ─── Camera view ───
  return (
    <View style={styles.container}>
      <CameraView
        ref={cameraRef}
        style={styles.camera}
        facing={facing}
        flash={flash}
        mode={captureMode === 'photo' || captureMode === 'boomerang' ? 'picture' : 'video'}
      />

      {/* Top controls */}
      <View style={styles.topBar}>
        <TouchableOpacity onPress={onClose} style={styles.topBtn}>
          <Text style={styles.topBtnText}>✕</Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setFlash(f => f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off')}
          style={styles.topBtn}
        >
          <Text style={styles.topBtnText}>
            {flash === 'off' ? '⚡️' : flash === 'on' ? '⚡️✓' : '⚡️A'}
          </Text>
        </TouchableOpacity>

        <TouchableOpacity
          onPress={() => setTimerDelay(d => d === 0 ? 3 : d === 3 ? 10 : 0)}
          style={styles.topBtn}
        >
          <Text style={styles.topBtnText}>
            {timerDelay === 0 ? '⏱' : `⏱${timerDelay}s`}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Countdown overlay */}
      {counting && (
        <View style={styles.countdownOverlay}>
          <Text style={styles.countdownText}>{countDown}</Text>
        </View>
      )}

      {/* Recording timer */}
      {recording && (
        <View style={styles.recordTimerBadge}>
          <View style={styles.recordDot} />
          <Text style={styles.recordTimerText}>{formatTimer(recordTimer)}</Text>
        </View>
      )}

      {/* Mode selector */}
      <View style={styles.modeBar}>
        {MODES.map((m) => (
          <TouchableOpacity
            key={m}
            onPress={() => setCaptureMode(m)}
            style={[styles.modeItem, captureMode === m && styles.modeItemActive]}
          >
            <Text style={[styles.modeText, captureMode === m && styles.modeTextActive]}>
              {MODE_LABELS[m]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>

      {/* Bottom controls */}
      <View style={styles.bottomBar}>
        {/* Gallery */}
        <TouchableOpacity onPress={openGallery} style={styles.galleryBtn}>
          <View style={styles.galleryIcon}>
            <Text style={{ fontSize: 20 }}>🖼</Text>
          </View>
        </TouchableOpacity>

        {/* Capture button */}
        <Pressable
          onPress={handleCapturePress}
          onLongPress={handleLongPress}
          onPressOut={handlePressOut}
          delayLongPress={300}
          style={styles.captureOuter}
        >
          <Animated.View style={[
            styles.captureInner,
            recording && styles.captureRecording,
            { transform: [{ scale: pulseAnim }] },
          ]} />
          {/* Progress ring for video */}
          {recording && (
            <View style={styles.progressRing}>
              <Animated.View style={[styles.progressArc, {
                borderColor: '#FF3B30',
                borderTopColor: 'transparent',
                transform: [{
                  rotate: progressAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: ['0deg', '360deg'],
                  }),
                }],
              }]} />
            </View>
          )}
        </Pressable>

        {/* Flip camera */}
        <TouchableOpacity
          onPress={() => setFacing(f => f === 'front' ? 'back' : 'front')}
          style={styles.flipBtn}
        >
          <Text style={{ fontSize: 22 }}>🔄</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1, backgroundColor: '#000',
  },
  camera: {
    flex: 1,
  },
  // ─── Top bar ───
  topBar: {
    position: 'absolute', top: Platform.OS === 'ios' ? 60 : 40,
    left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-between',
    paddingHorizontal: 20, zIndex: 10,
  },
  topBtn: {
    width: 44, height: 44, borderRadius: 22,
    backgroundColor: 'rgba(0,0,0,0.4)',
    alignItems: 'center', justifyContent: 'center',
  },
  topBtnText: { color: '#fff', fontSize: 18, fontWeight: '700' },

  // ─── Mode bar ───
  modeBar: {
    position: 'absolute', bottom: 140,
    left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', gap: 20,
  },
  modeItem: {
    paddingHorizontal: 14, paddingVertical: 6, borderRadius: 16,
  },
  modeItemActive: {
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  modeText: { color: 'rgba(255,255,255,0.5)', fontSize: 12, fontWeight: '700', letterSpacing: 1 },
  modeTextActive: { color: '#fff' },

  // ─── Bottom bar ───
  bottomBar: {
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
  galleryIcon: { alignItems: 'center', justifyContent: 'center' },
  flipBtn: {
    width: 48, height: 48, borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },

  // ─── Capture button ───
  captureOuter: {
    width: 80, height: 80, borderRadius: 40,
    borderWidth: 4, borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  captureInner: {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: '#fff',
  },
  captureRecording: {
    backgroundColor: '#FF3B30',
    borderRadius: 8, width: 36, height: 36,
  },
  progressRing: {
    position: 'absolute', width: 80, height: 80,
    alignItems: 'center', justifyContent: 'center',
  },
  progressArc: {
    width: 80, height: 80, borderRadius: 40,
    borderWidth: 4,
  },

  // ─── Recording timer ───
  recordTimerBadge: {
    position: 'absolute', top: Platform.OS === 'ios' ? 110 : 90,
    alignSelf: 'center',
    flexDirection: 'row', alignItems: 'center', gap: 6,
    backgroundColor: 'rgba(255,0,0,0.7)', borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 5,
  },
  recordDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' },
  recordTimerText: { color: '#fff', fontSize: 14, fontWeight: '700', fontVariant: ['tabular-nums'] },

  // ─── Countdown ───
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.5)', zIndex: 20,
  },
  countdownText: { color: '#fff', fontSize: 100, fontWeight: '900' },

  // ─── Preview ───
  previewImage: { flex: 1, width: '100%' },
  videoPreviewText: {
    color: '#fff', fontSize: 18, fontWeight: '700',
    position: 'absolute', top: '50%', alignSelf: 'center', zIndex: 5,
  },
  filterStrip: {
    position: 'absolute', bottom: 120,
    left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', gap: 10,
    paddingHorizontal: 16,
  },
  filterChip: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18,
    backgroundColor: 'rgba(255,255,255,0.15)',
  },
  filterChipActive: { backgroundColor: '#25D366' },
  filterLabel: { color: 'rgba(255,255,255,0.7)', fontSize: 12, fontWeight: '600' },
  filterLabelActive: { color: '#fff' },
  previewBottom: {
    position: 'absolute', bottom: 50,
    left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'space-evenly',
  },
  retakeBtn: {
    paddingHorizontal: 28, paddingVertical: 14, borderRadius: 24,
    backgroundColor: 'rgba(255,255,255,0.2)',
  },
  retakeBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  confirmBtn: {
    paddingHorizontal: 28, paddingVertical: 14, borderRadius: 24,
    backgroundColor: '#25D366',
  },
  confirmBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },

  // ─── Permissions ───
  permissionBox: {
    flex: 1, alignItems: 'center', justifyContent: 'center', gap: 16, padding: 24,
  },
  permissionText: { color: '#fff', fontSize: 16, textAlign: 'center', marginBottom: 12 },
  permissionBtn: {
    paddingHorizontal: 28, paddingVertical: 14, borderRadius: 24,
    backgroundColor: '#25D366', width: 200, alignItems: 'center',
  },
  permissionBtnText: { color: '#fff', fontSize: 16, fontWeight: '700' },
});
