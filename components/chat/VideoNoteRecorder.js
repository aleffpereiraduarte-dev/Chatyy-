// VideoNoteRecorder — Telegram/iMessage-style round video note recorder.
//
// Why this lives outside the main composer:
//   - Hooks (useState/useEffect) for camera setup must run from a stable
//     parent regardless of recording state. Inline-mounting inside the
//     composer led to hook-count mismatches when the recorder unmounted
//     mid-record (Rules-of-Hooks crash).
//   - 300x300 round mask + 60s max + slide-up-lock UI are non-trivial; a
//     dedicated component keeps chat-conversation.js below its 25k LoC ceiling.
//
// Public API:
//   <VideoNoteRecorder
//     visible={bool}
//     onClose={() => void}                  // soltar antes de 1s OU X manual
//     onComplete={(file) => void}           // file = { uri, name, type, size, duration }
//     colors={themeColors}
//     t={i18nFn}
//   />
//
// Behavior:
//   - Tap-and-hold the trigger to start recording.
//   - Release before 1s → cancel.
//   - Slide up to lock (hands-free); tap stop when locked.
//   - Max 60s; auto-stops with radial progress indicator.
//   - On success → onComplete(file). Parent uploads via chatUploadFile w/ type='video_note'.

import React, { useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  PanResponder,
  Platform,
  ActivityIndicator,
  Modal,
  Pressable,
} from 'react-native';
import { IconX, IconStop } from '../Icons';

let _camera = null;
function loadCamera() {
  if (_camera !== null) return _camera;
  try { _camera = require('expo-camera'); }
  catch { _camera = false; }
  return _camera;
}

const SIZE = 300;     // preview circle diameter (px)
const MAX_MS = 60000; // 60s WhatsApp/Telegram cap
const MIN_HOLD_MS = 1000; // <1s release = cancel (matches voice notes)
const LOCK_THRESHOLD = 60; // slide-up px to lock hands-free

export default function VideoNoteRecorder({ visible, onClose, onComplete, colors, t }) {
  const mod = loadCamera();
  const CameraView = mod && (mod.CameraView || mod.Camera);
  const useCameraPermissions = mod?.useCameraPermissions;
  const useMicrophonePermissions = mod?.useMicrophonePermissions;

  const [permission, requestPermission] = useCameraPermissions ? useCameraPermissions() : [{ granted: true }, () => Promise.resolve({ granted: true })];
  const [micPerm, requestMicPerm] = useMicrophonePermissions ? useMicrophonePermissions() : [{ granted: true }, () => Promise.resolve({ granted: true })];
  const [recording, setRecording] = useState(false);
  const [locked, setLocked] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [facing, setFacing] = useState('front');
  const [error, setError] = useState('');

  const cameraRef = useRef(null);
  const startedAtRef = useRef(0);
  const timerRef = useRef(null);
  const progressAnim = useRef(new Animated.Value(0)).current;
  const slideY = useRef(new Animated.Value(0)).current;
  const recordPromiseRef = useRef(null);
  const cancelledRef = useRef(false);

  // Reset state every time we re-open the recorder.
  useEffect(() => {
    if (visible) {
      setRecording(false);
      setLocked(false);
      setElapsed(0);
      setError('');
      cancelledRef.current = false;
      progressAnim.setValue(0);
      slideY.setValue(0);
    }
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [visible]);

  // Request perms on first open. We do this lazily so the chat opens
  // instantly even on iOS where the permission prompt is slow.
  useEffect(() => {
    if (!visible || !mod) return;
    (async () => {
      if (permission && !permission.granted) {
        const r = await requestPermission();
        if (!r.granted) { setError('camera'); return; }
      }
      if (micPerm && !micPerm.granted) {
        const r = await requestMicPerm();
        if (!r.granted) { setError('mic'); return; }
      }
    })();
  }, [visible]);

  const startRecording = async () => {
    if (!cameraRef.current || recording) return;
    cancelledRef.current = false;
    startedAtRef.current = Date.now();
    setRecording(true);
    setElapsed(0);
    Animated.timing(progressAnim, { toValue: 1, duration: MAX_MS, useNativeDriver: false }).start();
    timerRef.current = setInterval(() => {
      const e = Date.now() - startedAtRef.current;
      setElapsed(e);
      if (e >= MAX_MS) stopRecording(false);
    }, 100);
    try {
      const p = cameraRef.current.recordAsync({
        maxDuration: MAX_MS / 1000,
        // 720p is plenty for a 300x300 bubble; keeps file ~5-10MB max for 60s.
        ...(Platform.OS === 'ios' ? { quality: '720p' } : {}),
      });
      recordPromiseRef.current = p;
      const result = await p;
      if (cancelledRef.current) return;
      if (result?.uri) {
        const dur = Date.now() - startedAtRef.current;
        const file = {
          uri: result.uri,
          name: `video_note_${Date.now()}.mp4`,
          type: 'video/mp4',
          size: 0, // backend trusts filesize($destPath); 0 is fine.
          duration: dur,
        };
        onComplete?.(file);
        onClose?.();
      }
    } catch (e) {
      console.warn('[VideoNoteRecorder] record error', e);
      setError('record');
    } finally {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      progressAnim.stopAnimation();
      progressAnim.setValue(0);
      setRecording(false);
      setLocked(false);
      recordPromiseRef.current = null;
    }
  };

  const stopRecording = async (cancel = false) => {
    if (!recording || !cameraRef.current) return;
    if (cancel) cancelledRef.current = true;
    try { cameraRef.current.stopRecording(); } catch {}
    if (cancel) {
      setRecording(false);
      setLocked(false);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      onClose?.();
    }
  };

  // PanResponder for the trigger: hold-to-record + slide-up-to-lock.
  // Replaces the simple onPressIn/onPressOut combo because we need the
  // dy gesture for the lock behavior. Threshold 60px matches WhatsApp.
  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startRecording();
      },
      onPanResponderMove: (_e, gesture) => {
        if (gesture.dy < 0 && !locked) {
          slideY.setValue(Math.max(gesture.dy, -120));
          if (Math.abs(gesture.dy) >= LOCK_THRESHOLD) {
            setLocked(true);
          }
        }
      },
      onPanResponderRelease: () => {
        if (locked) return; // stays recording until user taps stop
        const heldMs = Date.now() - startedAtRef.current;
        if (heldMs < MIN_HOLD_MS) {
          stopRecording(true);
        } else {
          stopRecording(false);
        }
        Animated.spring(slideY, { toValue: 0, useNativeDriver: true }).start();
      },
    })
  ).current;

  if (!visible) return null;

  if (!mod || !CameraView) {
    return (
      <Modal visible transparent animationType="fade" onRequestClose={onClose}>
        <View style={s.backdrop}>
          <View style={[s.errCard, { backgroundColor: colors?.surface || '#fff' }]}>
            <Text style={{ color: colors?.text || '#000', fontWeight: '700', fontSize: 16, marginBottom: 8 }}>
              {t?.('videoNote.unavailable') || 'Video notes unavailable'}
            </Text>
            <Text style={{ color: colors?.textSecondary || '#666', fontSize: 13, marginBottom: 16 }}>
              {t?.('videoNote.installCamera') || 'Native camera module not available on this build.'}
            </Text>
            <TouchableOpacity onPress={onClose} style={[s.btn, { backgroundColor: '#7C3AED' }]}>
              <Text style={{ color: '#fff', fontWeight: '700' }}>{t?.('common.close') || 'Close'}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    );
  }

  const secs = Math.floor(elapsed / 1000);
  const mm = String(Math.floor(secs / 60)).padStart(2, '0');
  const ss = String(secs % 60).padStart(2, '0');

  return (
    <Modal visible transparent animationType="fade" onRequestClose={() => onClose?.()}>
      <Pressable
        onPress={() => { if (!recording) onClose?.(); }}
        style={s.backdrop}
      >
        {/* Top-right close. Always available so users can bail. */}
        <TouchableOpacity onPress={() => { cancelledRef.current = true; stopRecording(true); onClose?.(); }} style={s.closeBtn} hitSlop={12}>
          <IconX size={24} color="#fff" />
        </TouchableOpacity>

        {/* Camera preview clipped to a perfect circle */}
        <View style={s.previewWrap}>
          <View style={s.previewCircle}>
            <CameraView
              ref={cameraRef}
              style={{ width: SIZE, height: SIZE }}
              facing={facing}
              mode="video"
              videoQuality="720p"
            />
          </View>
          {/* Radial progress ring around the preview */}
          {recording && (
            <Animated.View
              pointerEvents="none"
              style={[
                s.progressRing,
                {
                  borderColor: '#EF4444',
                  opacity: progressAnim.interpolate({ inputRange: [0, 0.05, 1], outputRange: [0, 1, 1] }),
                },
              ]}
            />
          )}
        </View>

        {/* Hint */}
        <Text style={s.hint}>
          {error === 'camera'
            ? (t?.('videoNote.permissionCamera') || 'Camera permission required')
            : error === 'mic'
              ? (t?.('videoNote.permissionMic') || 'Microphone permission required')
              : recording
                ? (locked
                    ? `${t?.('videoNote.tapStop') || 'Tap to stop'} • ${mm}:${ss}`
                    : `${t?.('videoNote.slideToLock') || 'Slide up to lock'} • ${mm}:${ss}`)
                : (t?.('videoNote.holdToRecord') || 'Hold to record')}
        </Text>

        {/* Flip camera (hidden mid-recording to avoid mid-stream switches) */}
        {!recording && (
          <TouchableOpacity
            onPress={() => setFacing(f => (f === 'front' ? 'back' : 'front'))}
            style={s.flipBtn}
          >
            <Text style={{ color: '#fff', fontSize: 13, fontWeight: '600' }}>
              {facing === 'front' ? (t?.('videoNote.useBack') || 'Use back') : (t?.('videoNote.useFront') || 'Use front')}
            </Text>
          </TouchableOpacity>
        )}

        {/* Trigger button — hold to record, slide up to lock. When locked,
            this becomes a Stop button (single tap). */}
        <Animated.View style={[s.triggerWrap, { transform: [{ translateY: slideY }] }]}>
          {locked ? (
            <TouchableOpacity
              onPress={() => stopRecording(false)}
              style={[s.triggerBtn, { backgroundColor: '#EF4444' }]}
              accessibilityLabel={t?.('videoNote.tapStop') || 'Tap to stop'}
            >
              <IconStop size={26} color="#fff" />
            </TouchableOpacity>
          ) : (
            <View
              {...panResponder.panHandlers}
              style={[s.triggerBtn, { backgroundColor: recording ? '#EF4444' : '#7C3AED' }]}
            >
              <View style={[
                s.triggerInner,
                recording && { borderRadius: 8, width: 24, height: 24 },
              ]} />
            </View>
          )}
          {!locked && recording && (
            <View style={s.lockPill}>
              <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>↑</Text>
              <Text style={{ color: '#fff', fontSize: 10 }}>
                {t?.('videoNote.lock') || 'Lock'}
              </Text>
            </View>
          )}
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const s = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  closeBtn: {
    position: 'absolute',
    top: 50,
    right: 22,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  previewWrap: {
    width: SIZE + 16,
    height: SIZE + 16,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 36,
  },
  previewCircle: {
    width: SIZE,
    height: SIZE,
    borderRadius: SIZE / 2,
    overflow: 'hidden',
    backgroundColor: '#000',
  },
  progressRing: {
    position: 'absolute',
    width: SIZE + 12,
    height: SIZE + 12,
    borderRadius: (SIZE + 12) / 2,
    borderWidth: 4,
  },
  hint: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
    marginBottom: 28,
    textAlign: 'center',
    paddingHorizontal: 24,
  },
  flipBtn: {
    position: 'absolute',
    bottom: 200,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 16,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  triggerWrap: {
    position: 'absolute',
    bottom: 70,
    alignItems: 'center',
    gap: 10,
  },
  triggerBtn: {
    width: 86,
    height: 86,
    borderRadius: 43,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  triggerInner: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: '#fff',
  },
  lockPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
  },
  errCard: {
    paddingHorizontal: 24,
    paddingVertical: 22,
    borderRadius: 16,
    width: '85%',
    maxWidth: 360,
  },
  btn: {
    paddingHorizontal: 18,
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: 'center',
  },
});
