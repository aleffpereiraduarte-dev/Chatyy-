// VideoNoteRecorder — WhatsApp/Telegram-style round video note recorder.
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
// Behavior (2026-05-18 WhatsApp-grade upgrade):
//   - Tap-and-hold the trigger to start recording (haptic medium impact).
//   - Release before 1s → cancel (with toast "Hold longer").
//   - Slide ↑ to lock (hands-free); tap stop when locked. Haptic on lock.
//   - Slide ← past 90px → cancel with trash icon zoom + opacity feedback.
//   - Last 10s: timer turns red + haptic warning every 1s.
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
import { IconX, IconStop, IconTrash, IconLock } from '../Icons';

let _camera = null;
function loadCamera() {
  if (_camera !== null) return _camera;
  try { _camera = require('expo-camera'); }
  catch { _camera = false; }
  return _camera;
}

let _haptics = null;
function loadHaptics() {
  if (_haptics !== null) return _haptics;
  try { _haptics = require('expo-haptics'); }
  catch { _haptics = false; }
  return _haptics || null;
}

function hapticImpact(style) {
  // Best-effort haptics. Silent fail on web / unsupported devices.
  const h = loadHaptics();
  if (!h) return;
  try {
    if (style === 'medium') h.impactAsync(h.ImpactFeedbackStyle.Medium);
    else if (style === 'heavy') h.impactAsync(h.ImpactFeedbackStyle.Heavy);
    else if (style === 'warning') h.notificationAsync(h.NotificationFeedbackType.Warning);
    else if (style === 'success') h.notificationAsync(h.NotificationFeedbackType.Success);
    else h.impactAsync(h.ImpactFeedbackStyle.Light);
  } catch {}
}

const SIZE = 300;     // preview circle diameter (px)
const MAX_MS = 60000; // 60s WhatsApp/Telegram cap
const WARN_MS = 50000; // last 10s: red timer + haptic warning ticks
const MIN_HOLD_MS = 1000; // <1s release = cancel (matches voice notes)
const LOCK_THRESHOLD = 60; // slide-up px to lock hands-free
const CANCEL_THRESHOLD = 90; // slide-left px to cancel with trash zone

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
  // Visual flag for "user is dragging left past cancel threshold" — when set,
  // the trash zone grows and the trigger goes red. Drives both the live drag
  // feedback and the on-release cancel decision.
  const [cancelIntent, setCancelIntent] = useState(false);

  const cameraRef = useRef(null);
  const startedAtRef = useRef(0);
  const timerRef = useRef(null);
  const progressAnim = useRef(new Animated.Value(0)).current;
  // Idle pulse on the trigger button — gently expands+contracts the
  // brand-purple background ring while the user hasn't started recording,
  // mirroring WhatsApp's instant-video "hold here" hint without text.
  const idlePulse = useRef(new Animated.Value(0)).current;
  const slideY = useRef(new Animated.Value(0)).current;
  // Horizontal slide for swipe-left-to-cancel. Mirrors slideY but on X axis
  // so the trigger button visually tracks the finger while the user drags
  // toward the trash zone.
  const slideX = useRef(new Animated.Value(0)).current;
  const trashScale = useRef(new Animated.Value(0.8)).current;
  // Lock pill bounce: a subtle upward translate while !locked so users
  // discover the lock affordance without reading the hint text.
  const lockHintBounce = useRef(new Animated.Value(0)).current;
  const recordPromiseRef = useRef(null);
  const cancelledRef = useRef(false);
  // Latched flag for last-10s warning so we haptic-tick exactly once per
  // second in the final stretch, regardless of timer interval jitter.
  const lastWarnSecRef = useRef(-1);

  // Reset state every time we re-open the recorder.
  useEffect(() => {
    if (visible) {
      setRecording(false);
      setLocked(false);
      setElapsed(0);
      setError('');
      setCancelIntent(false);
      cancelledRef.current = false;
      lastWarnSecRef.current = -1;
      progressAnim.setValue(0);
      slideY.setValue(0);
      slideX.setValue(0);
      trashScale.setValue(0.8);
      // Start a gentle bounce on the lock-hint chevron so the affordance
      // is visible without reading the text label.
      Animated.loop(
        Animated.sequence([
          Animated.timing(lockHintBounce, { toValue: -6, duration: 700, useNativeDriver: true }),
          Animated.timing(lockHintBounce, { toValue: 0, duration: 700, useNativeDriver: true }),
        ])
      ).start();
      // Idle pulse on the trigger button — the brand-purple halo gently
      // breathes while the user hasn't started yet, so the affordance feels
      // alive (matches WhatsApp's instant-video idle hint).
      Animated.loop(
        Animated.sequence([
          Animated.timing(idlePulse, { toValue: 1, duration: 1200, useNativeDriver: true }),
          Animated.timing(idlePulse, { toValue: 0, duration: 1200, useNativeDriver: true }),
        ])
      ).start();
    }
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      lockHintBounce.stopAnimation();
      idlePulse.stopAnimation();
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
    lastWarnSecRef.current = -1;
    // Medium impact = "you are now recording" — matches WhatsApp's haptic
    // on the audio note hold trigger. Light feels too subtle for video where
    // the visual change is also subtle (circle borders red).
    hapticImpact('medium');
    Animated.timing(progressAnim, { toValue: 1, duration: MAX_MS, useNativeDriver: false }).start();
    timerRef.current = setInterval(() => {
      const e = Date.now() - startedAtRef.current;
      setElapsed(e);
      // Last-10s warning haptics: one warning tick per second once we cross
      // the WARN_MS threshold. Helps locked-mode users notice the cap is
      // approaching without staring at the timer.
      if (e >= WARN_MS && e < MAX_MS) {
        const sec = Math.floor(e / 1000);
        if (sec !== lastWarnSecRef.current) {
          lastWarnSecRef.current = sec;
          hapticImpact('warning');
        }
      }
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
    if (cancel) {
      cancelledRef.current = true;
      hapticImpact('heavy'); // distinct from success — "tossed in trash"
    } else {
      hapticImpact('success'); // double-tap success notification
    }
    try { cameraRef.current.stopRecording(); } catch {}
    if (cancel) {
      setRecording(false);
      setLocked(false);
      setCancelIntent(false);
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
      onClose?.();
    }
  };

  // PanResponder for the trigger: hold-to-record + slide-up-to-lock +
  // slide-left-to-cancel. We need TWO axes:
  //   • dy < 0 → progress toward lock (LOCK_THRESHOLD = 60px)
  //   • dx < 0 → progress toward cancel (CANCEL_THRESHOLD = 90px)
  // Whichever axis dominates wins. WhatsApp uses the same disambiguation.
  //
  // NOTE: PanResponder callbacks form a closure over `locked`/`cancelIntent`
  // at create-time. We re-read these via refs (lockedRef/cancelIntentRef)
  // below to avoid stale-closure bugs when re-recording within the same modal.
  const lockedRef = useRef(false);
  const cancelIntentRef = useRef(false);
  useEffect(() => { lockedRef.current = locked; }, [locked]);
  useEffect(() => { cancelIntentRef.current = cancelIntent; }, [cancelIntent]);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        startRecording();
      },
      onPanResponderMove: (_e, gesture) => {
        if (lockedRef.current) return; // gestures inert once locked
        // Disambiguate axis: dominant motion wins so a slight diagonal
        // doesn't toggle both states at once.
        const absX = Math.abs(gesture.dx);
        const absY = Math.abs(gesture.dy);

        // Vertical-up dominant → lock track
        if (gesture.dy < 0 && absY > absX) {
          slideY.setValue(Math.max(gesture.dy, -120));
          slideX.setValue(0);
          if (absY >= LOCK_THRESHOLD) {
            hapticImpact('medium'); // chunky "locked in" feel
            setLocked(true);
          }
          return;
        }
        // Horizontal-left dominant → cancel track
        if (gesture.dx < 0 && absX > absY) {
          slideX.setValue(Math.max(gesture.dx, -160));
          slideY.setValue(0);
          const past = absX >= CANCEL_THRESHOLD;
          if (past !== cancelIntentRef.current) {
            // State edge: entering/leaving the cancel zone.
            if (past) hapticImpact('light');
            setCancelIntent(past);
            Animated.spring(trashScale, {
              toValue: past ? 1.25 : 0.8,
              useNativeDriver: true,
              friction: 5,
            }).start();
          }
          return;
        }
        // Neutral / right-drift → reset both
        slideX.setValue(0);
        slideY.setValue(0);
      },
      onPanResponderRelease: () => {
        if (lockedRef.current) return; // stays recording until user taps stop
        // Tossed past the cancel threshold → discard regardless of hold time.
        if (cancelIntentRef.current) {
          stopRecording(true);
          Animated.parallel([
            Animated.spring(slideX, { toValue: 0, useNativeDriver: true }),
            Animated.spring(trashScale, { toValue: 0.8, useNativeDriver: true }),
          ]).start();
          return;
        }
        const heldMs = Date.now() - startedAtRef.current;
        if (heldMs < MIN_HOLD_MS) {
          stopRecording(true);
        } else {
          stopRecording(false);
        }
        Animated.parallel([
          Animated.spring(slideY, { toValue: 0, useNativeDriver: true }),
          Animated.spring(slideX, { toValue: 0, useNativeDriver: true }),
        ]).start();
      },
      onPanResponderTerminate: () => {
        // System interrupted gesture (e.g. modal popped) — treat as cancel.
        if (!lockedRef.current && recording) stopRecording(true);
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
  // Last 10s: timer flips red as a visual reminder that we're nearing the
  // 60s cap. Matches the haptic warning ticks above.
  const inWarn = elapsed >= WARN_MS && elapsed < MAX_MS;
  const remainingS = Math.max(0, Math.ceil((MAX_MS - elapsed) / 1000));

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

        {/* Hint — escalates through states:
              idle → "Hold to record"
              recording (drag) → "Slide ↑ lock • ← cancel • 0:05"
              cancel-intent → "Release to cancel" (red)
              warn (last 10s) → "Stop in 7s" (red)
              locked → "Tap to stop • 0:30" */}
        <Text style={[
          s.hint,
          cancelIntent && { color: '#FCA5A5' },
          inWarn && !cancelIntent && { color: '#FCA5A5' },
        ]}>
          {error === 'camera'
            ? (t?.('videoNote.permissionCamera') || 'Camera permission required')
            : error === 'mic'
              ? (t?.('videoNote.permissionMic') || 'Microphone permission required')
              : recording
                ? (cancelIntent
                    ? (t?.('videoNote.releaseToCancel') || 'Release to cancel')
                    : locked
                      ? (inWarn
                          ? `${t?.('videoNote.stopIn') || 'Stop in'} ${remainingS}s`
                          : `${t?.('videoNote.tapStop') || 'Tap to stop'} • ${mm}:${ss}`)
                      : (inWarn
                          ? `${t?.('videoNote.stopIn') || 'Stop in'} ${remainingS}s`
                          : `${t?.('videoNote.slideHints') || 'Slide ↑ lock • ← cancel'} • ${mm}:${ss}`))
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

        {/* Trash zone — visible left of the trigger while recording. Grows
            + opacity-spikes when the user drags into it past CANCEL_THRESHOLD.
            Mirrors the WhatsApp voice-note "swipe to cancel" affordance. */}
        {recording && !locked && (
          <Animated.View
            pointerEvents="none"
            style={[
              s.trashZone,
              {
                opacity: slideX.interpolate({
                  inputRange: [-CANCEL_THRESHOLD, -20, 0],
                  outputRange: [1, 0.6, 0.3],
                  extrapolate: 'clamp',
                }),
                transform: [{ scale: trashScale }],
                backgroundColor: cancelIntent ? '#EF4444' : 'rgba(255,255,255,0.18)',
              },
            ]}
          >
            <IconTrash size={26} color="#fff" />
          </Animated.View>
        )}

        {/* Lock pill — sits above the trigger; bounces gently to surface
            the slide-up-to-lock affordance. Hides once locked. */}
        {!locked && recording && (
          <Animated.View
            pointerEvents="none"
            style={[
              s.lockPillFloat,
              { transform: [{ translateY: lockHintBounce }] },
            ]}
          >
            <IconLock size={14} color="#fff" />
            <Text style={{ color: '#fff', fontSize: 11, fontWeight: '700' }}>↑</Text>
          </Animated.View>
        )}

        {/* Trigger button — hold to record, slide up to lock, slide left to
            cancel. When locked, this becomes a Stop button (single tap). */}
        <Animated.View
          style={[
            s.triggerWrap,
            { transform: [{ translateY: slideY }, { translateX: slideX }] },
          ]}
        >
          {/* Idle pulse halo (purple ring breathing) — only visible before
              recording starts; replaced by the red progress ring after. */}
          {!recording && !locked && (
            <Animated.View
              pointerEvents="none"
              style={[
                s.idleHalo,
                {
                  transform: [{
                    scale: idlePulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.18] }),
                  }],
                  opacity: idlePulse.interpolate({ inputRange: [0, 1], outputRange: [0.55, 0.12] }),
                },
              ]}
            />
          )}
          {locked ? (
            <TouchableOpacity
              onPress={() => stopRecording(false)}
              style={[s.triggerBtn, { backgroundColor: '#EF4444' }]}
              accessibilityLabel={t?.('videoNote.tapStop') || 'Tap to stop'}
              accessibilityRole="button"
            >
              <IconStop size={26} color="#fff" />
            </TouchableOpacity>
          ) : (
            <View
              {...panResponder.panHandlers}
              style={[
                s.triggerBtn,
                {
                  backgroundColor: cancelIntent
                    ? '#EF4444'
                    : recording
                      ? '#EF4444'
                      : '#7C3AED',
                },
              ]}
              accessibilityLabel={
                recording
                  ? (t?.('videoNote.recordingHint') || 'Recording. Slide up to lock, left to cancel.')
                  : (t?.('videoNote.holdToRecord') || 'Hold to record')
              }
              accessibilityRole="button"
            >
              <View style={[
                s.triggerInner,
                recording && { borderRadius: 8, width: 24, height: 24 },
              ]} />
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
  // Trash zone sits ~120px to the left of the trigger center. We position it
  // with `right` referenced from the screen so the trigger can drag toward
  // it without layout reflow. Bottom matches trigger center vertically.
  trashZone: {
    position: 'absolute',
    bottom: 70 + 18, // align with trigger center (trigger is 86 tall, bottom:70 → center @ 113)
    left: '50%',
    marginLeft: -160, // 160px left of screen center
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  // Lock pill floats above the trigger and gently bounces. Centered horizontally.
  lockPillFloat: {
    position: 'absolute',
    bottom: 70 + 86 + 12, // trigger.bottom + trigger.height + gap
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
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
  // Halo behind the trigger button — breathes while idle to invite the
  // press-and-hold gesture. Sits centered on the trigger and is masked by it.
  idleHalo: {
    position: 'absolute',
    width: 110,
    height: 110,
    borderRadius: 55,
    backgroundColor: '#7C3AED',
    top: -12,
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
