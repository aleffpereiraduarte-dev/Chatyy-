/**
 * ReelsRecorder.js
 *
 * TikTok / Instagram-grade dedicated camera surface for Reels creation.
 *
 * This is the SKELETON cut — UI shell + state machine + multi-clip recording
 * stack are implemented; heavy work (ffmpeg concat, beat sync, AR filters,
 * post-record trim/text overlays) is wired as TODO hooks calling
 * components/PhotoEditor.js or services/* once those land.
 *
 * Layout overview:
 *
 *   ┌─────────────────────────────────────────┐
 *   │ ✕   ♫ Add music                  ↻ ⚡ 1× │  ← top bar (close / music / right rail)
 *   │ ▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱ 0:08/0:60│  ← multi-clip timeline + total time
 *   │                                          │
 *   │           [ camera preview ]             │
 *   │                                          │
 *   │           (filters, beauty,              │  ← right rail (vertical action column)
 *   │            speed, timer, effects)        │
 *   │                                          │
 *   │   0.3×  0.5×  [ 1× ]  2×  3×             │  ← speed picker (pre-record)
 *   │                                          │
 *   │   [Gallery]    ⚪ REC    [Preview]       │  ← bottom action row
 *   └─────────────────────────────────────────┘
 *
 * State machine (clipsCount, recording, countdown) drives which controls
 * are interactive. The record button uses press-and-hold for hands-free
 * recording — release pauses, tap-to-resume adds a new clip.
 */
import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  StyleSheet,
  Animated,
  Dimensions,
  Platform,
  Pressable,
  ScrollView,
  Image,
  Modal,
  ActivityIndicator,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, useMicrophonePermissions } from 'expo-camera';
import * as ImagePicker from 'expo-image-picker';
import { useTheme } from '../context/ThemeContext';
import { useLanguage } from '../context/LanguageContext';
import {
  IconX,
  IconMusic,
  IconRefresh,
  IconZap,
  IconSparkles,
  IconClock,
  IconTrash,
  IconImage,
  IconCheck,
} from './Icons';

// Haptics (graceful — `expo-haptics` may be absent in some builds).
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

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

// Reels caps — Instagram = 60s default, TikTok = up to 180s stretch.
// The user can opt into the longer cap via the duration toggle below the
// timeline. 60s is the default to keep things snappy on first launch.
export const MAX_DURATION_60_MS = 60_000;
export const MAX_DURATION_180_MS = 180_000;

// Hard cap per clip — TikTok lets a single clip eat the full timeline if you
// hold record long enough. We respect that.
const MAX_SINGLE_CLIP_MS = MAX_DURATION_180_MS;

// Speed presets — TikTok parity. Selecting a speed PRE-record changes the
// playback rate metadata baked into the captured clip (frame interpolation
// happens post-record via ffmpeg in a later cut).
const SPEED_OPTIONS = [
  { value: 0.3, label: '0.3×' },
  { value: 0.5, label: '0.5×' },
  { value: 1,   label: '1×' },
  { value: 2,   label: '2×' },
  { value: 3,   label: '3×' },
];

// Countdown presets — tap once for 3s, twice for 10s, third tap clears.
const COUNTDOWN_CYCLE = [0, 3, 10];

// Clip palette — each finished clip in the multi-clip timeline gets a hue
// based on its index so the user can visually distinguish segments. Mirrors
// TikTok's segmented progress bar.
const CLIP_COLORS = ['#7C3AED', '#EC4899', '#F59E0B', '#10B981', '#3B82F6', '#EF4444', '#A855F7', '#06B6D4'];

const BRAND = '#7C3AED';

// Instagram-style CSS filter strip — same vocabulary as CreatePostModal so
// users get one mental model across feed/reels. CSS string is used directly
// on web; native uses `getNativeFilterStyle` for an approximate look since
// react-native doesn't support the full CSS filter pipeline.
const FILTERS = [
  { name: 'Normal', css: '' },
  { name: 'Clarendon', css: 'contrast(1.2) saturate(1.35)' },
  { name: 'Gingham', css: 'brightness(1.05) hue-rotate(-10deg)' },
  { name: 'Moon', css: 'grayscale(1) contrast(1.1) brightness(1.1)' },
  { name: 'Lark', css: 'contrast(0.9) brightness(1.1) saturate(1.2)' },
  { name: 'Reyes', css: 'sepia(0.22) brightness(1.1) contrast(0.85) saturate(0.75)' },
  { name: 'Juno', css: 'contrast(1.1) brightness(1.05) saturate(1.3)' },
  { name: 'Slumber', css: 'saturate(0.66) brightness(1.05) sepia(0.1)' },
  { name: 'Aden', css: 'hue-rotate(20deg) contrast(0.9) saturate(0.85) brightness(1.2)' },
  { name: 'Perpetua', css: 'brightness(1.05) contrast(1.1) saturate(1.1)' },
];

// Effects — 6 baseline AR-light presets implemented as CSS filters. AR
// face-tracking lives in a separate cut (FaceFilters.js); these are global
// color/tone presets that ride on top of the live preview without needing a
// face mesh.
const EFFECTS = [
  { name: 'Normal', css: '' },
  { name: 'B&W', css: 'grayscale(1) contrast(1.05)' },
  { name: 'Vintage', css: 'sepia(0.55) contrast(0.95) brightness(1.05)' },
  { name: 'Vivid', css: 'saturate(1.6) contrast(1.15)' },
  { name: 'Cold', css: 'hue-rotate(-15deg) saturate(1.1) brightness(1.05)' },
  { name: 'Warm', css: 'hue-rotate(15deg) saturate(1.2) brightness(1.05) sepia(0.1)' },
];

// Native fallback styling — RN can't apply CSS filter strings, so we lean
// on opacity/tint as a visual hint that the filter is active.
function getNativeFilterStyle(name) {
  switch (name) {
    case 'Moon':
    case 'B&W': return { opacity: 0.85 };
    case 'Reyes':
    case 'Vintage': return { opacity: 0.88 };
    case 'Slumber':
    case 'Warm': return { opacity: 0.92 };
    case 'Cold': return { opacity: 0.92 };
    default: return {};
  }
}

/**
 * ReelsRecorder
 *
 * Props:
 *   onClose:     () => void                  // user dismisses recorder
 *   onComplete:  ({ clips, music, totalDurationMs }) => void
 *                                            // user taps Preview/Next with
 *                                            // at least one clip recorded
 *   initialMusic: { id, url, title } | null  // pre-seeded from /reels-sound
 *                                            // "Use this sound" flow
 *   maxDurationMs: number                    // override default 60s cap
 */
export default function ReelsRecorder({
  onClose,
  onComplete,
  onOpenDrafts,
  initialMusic = null,
  maxDurationMs = MAX_DURATION_60_MS,
}) {
  const insets = useSafeAreaInsets();
  const { colors } = useTheme();
  const { t } = useLanguage();

  // ─── Permissions ───
  const [camPerm, requestCamPerm] = useCameraPermissions();
  const [micPerm, requestMicPerm] = useMicrophonePermissions();

  // ─── Camera state ───
  const cameraRef = useRef(null);
  const [facing, setFacing] = useState('back'); // 'back' | 'front'
  const [flash, setFlash] = useState('off');    // 'off' | 'on' | 'auto'
  const [previewSize, setPreviewSize] = useState({ width: SCREEN_W, height: SCREEN_H });

  // ─── Recording state ───
  const [clips, setClips] = useState([]);         // [{ uri, durationMs, speed }]
  const [recording, setRecording] = useState(false);
  const [recordElapsedMs, setRecordElapsedMs] = useState(0);
  const recordStartedAtRef = useRef(0);
  const recordTickRef = useRef(null);
  const maxClipTimerRef = useRef(null);

  // ─── Pre-record controls ───
  const [speed, setSpeed] = useState(1);
  const [countdown, setCountdown] = useState(0); // 0 = off, 3, 10
  const [counting, setCounting] = useState(false);
  const [countDisplay, setCountDisplay] = useState(0);

  // ─── Music ───
  const [selectedSound, setSelectedSound] = useState(initialMusic);

  // ─── Right-rail toggles ───
  const [beauty, setBeauty] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [effectsOpen, setEffectsOpen] = useState(false);
  // Active selection per surface — null = Normal / off. Live filter rides on
  // top of the preview while the bottom sheet is open so the user sees the
  // change before committing. Effect is layered separately so a filter +
  // effect combo (e.g. Clarendon + B&W) can be stacked.
  const [activeFilter, setActiveFilter] = useState('Normal');
  const [activeEffect, setActiveEffect] = useState('Normal');

  // ─── Duration cap toggle (60s vs 180s) ───
  const [maxMs, setMaxMs] = useState(maxDurationMs);

  // ─── Animations ───
  const recScaleAnim = useRef(new Animated.Value(1)).current;
  const recRingAnim = useRef(new Animated.Value(0)).current;

  // ─── Derived values ───
  const totalDurationMs = useMemo(
    () => clips.reduce((acc, c) => acc + (c.durationMs || 0), 0),
    [clips]
  );
  const totalWithCurrentMs = totalDurationMs + recordElapsedMs;
  const remainingMs = Math.max(0, maxMs - totalWithCurrentMs);
  const progressPct = Math.min(1, totalWithCurrentMs / maxMs);

  // ─── Permission gate ───
  useEffect(() => {
    if (camPerm && !camPerm.granted && camPerm.canAskAgain) requestCamPerm?.();
    if (micPerm && !micPerm.granted && micPerm.canAskAgain) requestMicPerm?.();
  }, [camPerm?.granted, micPerm?.granted]);

  // ─── Recording elapsed ticker ───
  useEffect(() => {
    if (!recording) {
      if (recordTickRef.current) clearInterval(recordTickRef.current);
      recordTickRef.current = null;
      return;
    }
    recordStartedAtRef.current = Date.now();
    recordTickRef.current = setInterval(() => {
      const elapsed = Date.now() - recordStartedAtRef.current;
      setRecordElapsedMs(elapsed);
      // Auto-stop if we'd blow past the max duration.
      if (totalDurationMs + elapsed >= maxMs) {
        try { cameraRef.current?.stopRecording?.(); } catch {}
      }
    }, 100);
    return () => {
      if (recordTickRef.current) clearInterval(recordTickRef.current);
      recordTickRef.current = null;
    };
  }, [recording, totalDurationMs, maxMs]);

  // ─── Record ring pulse ───
  useEffect(() => {
    if (recording) {
      Animated.loop(
        Animated.sequence([
          Animated.timing(recRingAnim, { toValue: 1, duration: 600, useNativeDriver: true }),
          Animated.timing(recRingAnim, { toValue: 0, duration: 600, useNativeDriver: true }),
        ])
      ).start();
    } else {
      recRingAnim.stopAnimation();
      recRingAnim.setValue(0);
    }
  }, [recording]);

  // ─── Countdown runner ───
  const runCountdown = useCallback(async () => {
    if (countdown <= 0) return;
    setCounting(true);
    for (let i = countdown; i > 0; i--) {
      setCountDisplay(i);
      haptic('light');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 1000));
    }
    setCounting(false);
    setCountDisplay(0);
  }, [countdown]);

  // ─── Record control ───
  const startRecording = useCallback(async () => {
    if (recording) return;
    if (!cameraRef.current) return;
    if (totalDurationMs >= maxMs) return;
    haptic('medium');
    if (countdown > 0) await runCountdown();
    if (!cameraRef.current) return;

    setRecording(true);
    setRecordElapsedMs(0);
    Animated.spring(recScaleAnim, { toValue: 1.18, useNativeDriver: true }).start();

    // recordAsync resolves only when stopRecording fires (or maxDuration hits).
    try {
      const remainingSec = Math.max(1, Math.floor((maxMs - totalDurationMs) / 1000));
      const video = await cameraRef.current.recordAsync({
        maxDuration: Math.min(remainingSec, Math.ceil(MAX_SINGLE_CLIP_MS / 1000)),
        quality: '720p',
      });
      if (video?.uri) {
        const dur = Date.now() - recordStartedAtRef.current;
        setClips((prev) => [
          ...prev,
          {
            uri: video.uri,
            durationMs: Math.min(dur, maxMs - totalDurationMs),
            speed,
          },
        ]);
        haptic('light');
      }
    } catch (e) {
      console.warn('[ReelsRecorder] record error:', e?.message);
    } finally {
      setRecording(false);
      setRecordElapsedMs(0);
      Animated.spring(recScaleAnim, { toValue: 1, useNativeDriver: true }).start();
    }
  }, [recording, countdown, runCountdown, totalDurationMs, maxMs, speed]);

  const stopRecording = useCallback(() => {
    if (!recording || !cameraRef.current) return;
    try { cameraRef.current.stopRecording(); } catch {}
  }, [recording]);

  // ─── Multi-clip helpers ───
  const deleteClip = useCallback((idx) => {
    haptic('medium');
    setClips((prev) => prev.filter((_, i) => i !== idx));
  }, []);

  const deleteLastClip = useCallback(() => {
    if (clips.length === 0) return;
    haptic('medium');
    setClips((prev) => prev.slice(0, -1));
  }, [clips.length]);

  // ─── Gallery import ───
  const pickFromGallery = useCallback(async () => {
    if (recording) return;
    haptic('light');
    try {
      const res = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['videos'],
        videoMaxDuration: Math.ceil(maxMs / 1000),
        quality: 0.92,
        allowsMultipleSelection: false,
      });
      if (res?.canceled) return;
      const asset = res.assets?.[0];
      if (!asset?.uri) return;
      const dur = (asset.duration ?? 0) || 0;
      setClips((prev) => [
        ...prev,
        {
          uri: asset.uri,
          durationMs: Math.min(dur, maxMs - totalDurationMs),
          speed: 1,
          imported: true,
        },
      ]);
    } catch (e) {
      console.warn('[ReelsRecorder] gallery error:', e?.message);
    }
  }, [recording, maxMs, totalDurationMs]);

  // ─── Music picker (TODO: route to /reels-sound with returnTo) ───
  const openMusicPicker = useCallback(() => {
    if (recording) return;
    haptic('light');
    // TODO: navigate to sound picker. For skeleton, use a placeholder local
    // catalog. The proper flow is router.push('/reels-sound?picker=1') which
    // returns { sound_id, url, title } via params. Wired in a later cut.
    setSelectedSound((prev) =>
      prev
        ? null
        : { id: 'placeholder', url: '', title: t?.('reels.recorder.addMusic') || 'Adicionar música' }
    );
  }, [recording, t]);

  // ─── Preview / Next (composer) ───
  const goToPreview = useCallback(() => {
    if (clips.length === 0) return;
    haptic('medium');
    onComplete?.({
      clips,
      music: selectedSound,
      totalDurationMs,
    });
  }, [clips, selectedSound, totalDurationMs, onComplete]);

  // ─── Close confirm — clips would be lost ───
  const handleClose = useCallback(() => {
    haptic('light');
    if (clips.length > 0) {
      // TODO: ConfirmModal — discard or save draft. For skeleton we just close.
    }
    onClose?.();
  }, [clips.length, onClose]);

  // ─── Layout: permission denied gate ───
  if (!camPerm) {
    return (
      <View style={styles.root}>
        <ActivityIndicator color="#fff" />
      </View>
    );
  }
  if (!camPerm.granted) {
    return (
      <View style={[styles.root, styles.permGate]}>
        <Text style={styles.permTitle}>
          {t?.('reels.recorder.title') || 'Criar reel'}
        </Text>
        <Text style={styles.permBody}>
          {t?.('status.cameraPermBody') || 'Precisamos da câmera para gravar.'}
        </Text>
        <TouchableOpacity onPress={requestCamPerm} style={styles.permBtn}>
          <Text style={styles.permBtnTxt}>
            {t?.('common.allow') || 'Permitir'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={handleClose} style={[styles.permBtn, styles.permBtnGhost]}>
          <Text style={styles.permBtnTxt}>{t?.('common.cancel') || 'Cancelar'}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  // ─── Main render ───
  return (
    <View style={styles.root}>
      {/* Camera preview — full screen behind UI chrome */}
      <View
        style={StyleSheet.absoluteFill}
        onLayout={(e) => setPreviewSize({
          width: e.nativeEvent.layout.width,
          height: e.nativeEvent.layout.height,
        })}
      >
        <CameraView
          ref={cameraRef}
          style={[
            styles.camera,
            // On web, CameraView is rendered via a <video> element and CSS
            // filters apply natively. On native we fall back to opacity tints
            // via getNativeFilterStyle.
            Platform.OS === 'web'
              ? { filter: [
                    FILTERS.find(f => f.name === activeFilter)?.css,
                    EFFECTS.find(e => e.name === activeEffect)?.css,
                  ].filter(Boolean).join(' ') || undefined }
              : { ...getNativeFilterStyle(activeFilter), ...getNativeFilterStyle(activeEffect) },
          ]}
          facing={facing}
          flash={flash}
          mode="video"
        />
        {beauty && (
          <View
            pointerEvents="none"
            style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(255,220,225,0.10)' }]}
          />
        )}
      </View>

      {/* ─── TOP BAR: close + music pill + duration cap toggle ─── */}
      <View
        style={[styles.topBar, { paddingTop: (insets.top || 0) + 4 }]}
        pointerEvents="box-none"
      >
        <TouchableOpacity onPress={handleClose} style={styles.closeBtn} hitSlop={12}>
          <IconX size={26} color="#fff" />
        </TouchableOpacity>

        {/* Music pill (centered) */}
        <TouchableOpacity
          onPress={openMusicPicker}
          style={styles.musicPill}
          hitSlop={6}
          disabled={recording}
        >
          <IconMusic size={14} color="#fff" />
          <Text style={styles.musicPillTxt} numberOfLines={1}>
            {selectedSound?.title || t?.('reels.recorder.addMusic') || 'Adicionar música'}
          </Text>
        </TouchableOpacity>

        {/* Duration cap toggle (60 / 180) */}
        <TouchableOpacity
          onPress={() => {
            haptic('light');
            setMaxMs((m) => (m === MAX_DURATION_60_MS ? MAX_DURATION_180_MS : MAX_DURATION_60_MS));
          }}
          style={styles.durBtn}
          disabled={recording || clips.length > 0}
        >
          <Text style={styles.durBtnTxt}>
            {Math.round(maxMs / 1000)}s
          </Text>
        </TouchableOpacity>
      </View>

      {/* ─── MULTI-CLIP TIMELINE (under top bar) ─── */}
      <View
        style={[styles.timelineWrap, { top: (insets.top || 0) + 56 }]}
        pointerEvents="box-none"
      >
        <View style={styles.timelineTrack}>
          {/* Past clips */}
          {clips.map((c, i) => {
            const w = (c.durationMs / maxMs) * (SCREEN_W - 32);
            return (
              <Pressable
                key={`${c.uri}-${i}`}
                onLongPress={() => deleteClip(i)}
                style={[
                  styles.timelineSeg,
                  { width: w, backgroundColor: CLIP_COLORS[i % CLIP_COLORS.length] },
                ]}
              />
            );
          })}
          {/* Live segment while recording */}
          {recording && (
            <View
              style={[
                styles.timelineSeg,
                {
                  width: (recordElapsedMs / maxMs) * (SCREEN_W - 32),
                  backgroundColor: '#fff',
                  opacity: 0.95,
                },
              ]}
            />
          )}
        </View>
        <Text style={styles.timelineLabel}>
          {fmtMs(totalWithCurrentMs)} / {fmtMs(maxMs)}
        </Text>
      </View>

      {/* ─── RIGHT RAIL: action stack ─── */}
      <View
        style={[styles.rightRail, { top: (insets.top || 0) + 100 }]}
        pointerEvents="box-none"
      >
        <RailBtn
          icon={<IconRefresh size={22} color="#fff" />}
          label={t?.('status.flip') || 'Virar'}
          onPress={() => {
            if (recording) return;
            haptic('light');
            setFacing((f) => (f === 'back' ? 'front' : 'back'));
          }}
        />
        <RailBtn
          icon={<IconZap size={22} color={flash === 'off' ? '#fff' : '#FBBF24'} />}
          label={flash === 'off' ? 'Off' : flash === 'on' ? 'On' : 'Auto'}
          onPress={() => {
            haptic('light');
            setFlash((f) => (f === 'off' ? 'on' : f === 'on' ? 'auto' : 'off'));
          }}
        />
        <RailBtn
          icon={<IconSparkles size={22} color={beauty ? BRAND : '#fff'} />}
          label={t?.('status.beauty') || 'Beauty'}
          onPress={() => { haptic('light'); setBeauty((b) => !b); }}
          active={beauty}
        />
        <RailBtn
          icon={<IconClock size={22} color={countdown > 0 ? BRAND : '#fff'} />}
          label={countdown === 0 ? (t?.('status.timer') || 'Timer') : `${countdown}s`}
          onPress={() => {
            haptic('light');
            setCountdown((c) => {
              const i = COUNTDOWN_CYCLE.indexOf(c);
              return COUNTDOWN_CYCLE[(i + 1) % COUNTDOWN_CYCLE.length];
            });
          }}
          active={countdown > 0}
        />
        <RailBtn
          icon={<Text style={styles.railGlyph}>FX</Text>}
          label={t?.('status.effects') || 'Efeitos'}
          onPress={() => { haptic('light'); setEffectsOpen(true); /* TODO: AR sheet */ }}
        />
        <RailBtn
          icon={<Text style={styles.railGlyph}>◑</Text>}
          label={t?.('status.filters') || 'Filtros'}
          onPress={() => { haptic('light'); setFiltersOpen(true); /* TODO: filter strip */ }}
        />
        {clips.length > 0 && (
          <RailBtn
            icon={<IconTrash size={22} color="#fff" />}
            label={t?.('common.undo') || 'Desfazer'}
            onPress={deleteLastClip}
          />
        )}
      </View>

      {/* ─── COUNTDOWN OVERLAY ─── */}
      {counting && (
        <View style={styles.countdownOverlay} pointerEvents="none">
          <Text style={styles.countdownTxt}>{countDisplay}</Text>
        </View>
      )}

      {/* ─── SPEED PICKER (above bottom row) ─── */}
      <View
        style={[styles.speedRow, { bottom: (insets.bottom || 0) + 150 }]}
        pointerEvents={recording ? 'none' : 'auto'}
      >
        {SPEED_OPTIONS.map((opt) => {
          const sel = speed === opt.value;
          return (
            <TouchableOpacity
              key={opt.value}
              onPress={() => { haptic('light'); setSpeed(opt.value); }}
              style={[styles.speedChip, sel && styles.speedChipActive]}
              disabled={recording || clips.length > 0}
            >
              <Text style={[styles.speedChipTxt, sel && styles.speedChipTxtActive]}>
                {opt.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>

      {/* ─── HOLD-TO-RECORD HINT (idle, no clips) ─── */}
      {!recording && clips.length === 0 && !counting && (
        <View
          style={[styles.hintPill, { bottom: (insets.bottom || 0) + 200 }]}
          pointerEvents="none"
        >
          <Text style={styles.hintPillTxt}>
            {t?.('reels.recorder.holdToRecord') || 'Mantenha pressionado pra gravar'}
          </Text>
        </View>
      )}

      {/* ─── Drafts entry pill — sits above the speed row when there's no
              active recording. Tap to navigate to /reels-drafts. Persisted
              drafts are loaded from AsyncStorage there. ─── */}
      {!recording && onOpenDrafts && (
        <TouchableOpacity
          onPress={() => { haptic('light'); onOpenDrafts(); }}
          style={[styles.draftsPill, { bottom: (insets.bottom || 0) + 250 }]}
          activeOpacity={0.8}
        >
          <Text style={styles.draftsPillTxt}>
            {t?.('reels.drafts') || 'Rascunhos'}
          </Text>
        </TouchableOpacity>
      )}

      {/* ─── BOTTOM ROW: gallery | record | preview ─── */}
      <View
        style={[styles.bottomRow, { paddingBottom: (insets.bottom || 0) + 18 }]}
        pointerEvents="box-none"
      >
        {/* Gallery (left) */}
        <TouchableOpacity
          onPress={pickFromGallery}
          style={styles.sideBtn}
          disabled={recording}
          accessibilityLabel={t?.('status.gallery') || 'Galeria'}
        >
          <View style={styles.sideBtnInner}>
            <IconImage size={22} color="#fff" />
          </View>
          <Text style={styles.sideBtnLabel}>
            {t?.('status.gallery') || 'Galeria'}
          </Text>
        </TouchableOpacity>

        {/* Record (center) — press-and-hold OR tap to start, tap to stop */}
        <Pressable
          onPressIn={() => {
            if (recording) return;
            // Press-and-hold semantics: starts immediately, will stop on release.
            startRecording();
          }}
          onPressOut={() => {
            if (recording) stopRecording();
          }}
          onLongPress={() => { /* press-and-hold handled by onPressIn */ }}
          style={styles.recBtnWrap}
          disabled={remainingMs <= 0}
        >
          {/* Animated pulse ring */}
          <Animated.View
            style={[
              styles.recRing,
              {
                opacity: recRingAnim.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0.3, 0.85],
                }),
                transform: [{
                  scale: recRingAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 1.18],
                  }),
                }],
              },
            ]}
          />
          <Animated.View
            style={[
              styles.recBtn,
              { transform: [{ scale: recScaleAnim }] },
              recording && styles.recBtnActive,
            ]}
          >
            <View style={[styles.recDot, recording && styles.recDotActive]} />
          </Animated.View>
        </Pressable>

        {/* Preview / Next (right) */}
        <TouchableOpacity
          onPress={goToPreview}
          style={[styles.sideBtn, clips.length === 0 && styles.sideBtnDisabled]}
          disabled={clips.length === 0 || recording}
          accessibilityLabel={t?.('reels.recorder.preview.title') || 'Pré-visualizar'}
        >
          <View style={[styles.sideBtnInner, clips.length > 0 && styles.sideBtnInnerActive]}>
            <IconCheck size={22} color="#fff" />
          </View>
          <Text style={styles.sideBtnLabel}>
            {t?.('reels.recorder.preview.title') || 'Pré-visualizar'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* ─── Filter / effect strips ─── */}
      {/* Each strip is a horizontal scroller of preset chips rendered as a
          bottom sheet. Selecting a chip applies the preset live to the camera
          preview (see the CameraView style above). Close dismisses without
          revert — user can pick "Normal" to clear. */}
      {(filtersOpen || effectsOpen) && (
        <Modal
          transparent
          animationType="slide"
          onRequestClose={() => { setFiltersOpen(false); setEffectsOpen(false); }}
        >
          <Pressable
            style={styles.fxSheetWrap}
            onPress={() => { setFiltersOpen(false); setEffectsOpen(false); }}
          >
            <Pressable style={styles.fxSheet} onPress={(e) => e.stopPropagation?.()}>
              <View style={styles.fxSheetHeader}>
                <Text style={styles.fxSheetTitle}>
                  {filtersOpen
                    ? (t?.('status.filters') || 'Filtros')
                    : (t?.('status.effects') || 'Efeitos')}
                </Text>
                <TouchableOpacity
                  onPress={() => { setFiltersOpen(false); setEffectsOpen(false); }}
                  hitSlop={10}
                >
                  <IconX size={22} color="#fff" />
                </TouchableOpacity>
              </View>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.fxRow}
              >
                {(filtersOpen ? FILTERS : EFFECTS).map((preset) => {
                  const isActive = filtersOpen
                    ? activeFilter === preset.name
                    : activeEffect === preset.name;
                  return (
                    <TouchableOpacity
                      key={preset.name}
                      onPress={() => {
                        haptic('light');
                        if (filtersOpen) setActiveFilter(preset.name);
                        else setActiveEffect(preset.name);
                      }}
                      style={styles.fxChip}
                      activeOpacity={0.8}
                    >
                      <View style={[
                        styles.fxThumb,
                        isActive && { borderColor: BRAND, borderWidth: 2 },
                        // Web: paint a colored swatch with the actual CSS
                        // filter applied so the chip previews the look.
                        Platform.OS === 'web' && {
                          backgroundColor: '#7C3AED',
                          filter: preset.css || undefined,
                        },
                        Platform.OS !== 'web' && getNativeFilterStyle(preset.name),
                      ]}>
                        {preset.name === 'Normal' && (
                          <Text style={styles.fxThumbNone}>—</Text>
                        )}
                      </View>
                      <Text style={[styles.fxLabel, isActive && { color: BRAND, fontWeight: '800' }]} numberOfLines={1}>
                        {preset.name}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </ScrollView>
            </Pressable>
          </Pressable>
        </Modal>
      )}
    </View>
  );
}

// ─── Helpers ───
function fmtMs(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function RailBtn({ icon, label, onPress, active }) {
  return (
    <TouchableOpacity
      onPress={onPress}
      style={[styles.railBtn, active && styles.railBtnActive]}
      hitSlop={6}
    >
      <View style={styles.railBtnIcon}>{icon}</View>
      <Text style={styles.railBtnLabel} numberOfLines={1}>{label}</Text>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: '#000' },

  camera: { flex: 1 },

  // Permission gate
  permGate: {
    flex: 1,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  permTitle: { color: '#fff', fontSize: 22, fontWeight: '800', marginBottom: 10 },
  permBody: { color: '#fff', opacity: 0.78, fontSize: 14, textAlign: 'center', marginBottom: 28 },
  permBtn: {
    backgroundColor: BRAND,
    paddingHorizontal: 26,
    paddingVertical: 12,
    borderRadius: 24,
    marginTop: 10,
  },
  permBtnGhost: { backgroundColor: 'rgba(255,255,255,0.12)' },
  permBtnTxt: { color: '#fff', fontSize: 15, fontWeight: '700' },

  // Top bar
  topBar: {
    position: 'absolute',
    top: 0, left: 0, right: 0,
    paddingHorizontal: 14,
    paddingBottom: 10,
    flexDirection: 'row',
    alignItems: 'center',
    zIndex: 30,
  },
  closeBtn: {
    width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  musicPill: {
    flex: 1,
    marginHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    maxWidth: SCREEN_W - 140,
    alignSelf: 'center',
  },
  musicPillTxt: { color: '#fff', fontSize: 13, fontWeight: '600', maxWidth: 200 },
  durBtn: {
    width: 44, height: 40,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  durBtnTxt: { color: '#fff', fontSize: 12, fontWeight: '800' },

  // Multi-clip timeline
  timelineWrap: {
    position: 'absolute',
    left: 16, right: 16,
    zIndex: 25,
  },
  timelineTrack: {
    height: 4,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.18)',
    overflow: 'hidden',
    flexDirection: 'row',
  },
  timelineSeg: {
    height: '100%',
    marginRight: 1,
  },
  timelineLabel: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '700',
    marginTop: 6,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 4,
  },

  // Right rail
  rightRail: {
    position: 'absolute',
    right: 8,
    zIndex: 28,
    alignItems: 'center',
    gap: 14,
  },
  railBtn: {
    alignItems: 'center',
    paddingHorizontal: 6,
    paddingVertical: 4,
    minWidth: 56,
  },
  railBtnActive: {},
  railBtnIcon: {
    width: 40, height: 40,
    alignItems: 'center', justifyContent: 'center',
    borderRadius: 20,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  railBtnLabel: {
    color: '#fff', fontSize: 10.5, fontWeight: '700',
    marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowRadius: 3,
  },
  railGlyph: { color: '#fff', fontSize: 14, fontWeight: '900' },

  // Countdown overlay
  countdownOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.25)',
    zIndex: 50,
  },
  countdownTxt: {
    color: '#fff',
    fontSize: 140,
    fontWeight: '900',
    textShadowColor: 'rgba(0,0,0,0.45)',
    textShadowRadius: 10,
  },

  // Speed row
  speedRow: {
    position: 'absolute',
    left: 0, right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 8,
    zIndex: 25,
  },
  speedChip: {
    paddingHorizontal: 12, paddingVertical: 6,
    borderRadius: 14,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  speedChipActive: { backgroundColor: '#fff' },
  speedChipTxt: { color: '#fff', fontSize: 12, fontWeight: '800' },
  speedChipTxtActive: { color: '#000' },

  // Hold-to-record hint pill
  hintPill: {
    position: 'absolute',
    alignSelf: 'center',
    left: 0, right: 0,
    alignItems: 'center',
    zIndex: 20,
  },
  hintPillTxt: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '700',
    backgroundColor: 'rgba(0,0,0,0.45)',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 12,
    overflow: 'hidden',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 4,
  },

  // Bottom row
  bottomRow: {
    position: 'absolute',
    left: 0, right: 0, bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    zIndex: 25,
    paddingHorizontal: 20,
  },
  sideBtn: {
    alignItems: 'center',
    width: 80,
  },
  sideBtnDisabled: { opacity: 0.4 },
  sideBtnInner: {
    width: 44, height: 44,
    borderRadius: 12,
    backgroundColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
  },
  sideBtnInnerActive: { backgroundColor: BRAND },
  sideBtnLabel: {
    color: '#fff', fontSize: 11, fontWeight: '700', marginTop: 4,
    textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 3,
  },

  // Record button — 80px primary
  recBtnWrap: {
    width: 96, height: 96,
    alignItems: 'center', justifyContent: 'center',
  },
  recRing: {
    position: 'absolute',
    width: 96, height: 96,
    borderRadius: 48,
    backgroundColor: BRAND,
  },
  recBtn: {
    width: 80, height: 80,
    borderRadius: 40,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 5,
    borderColor: '#fff',
    alignItems: 'center', justifyContent: 'center',
  },
  recBtnActive: {
    borderColor: '#EF4444',
  },
  recDot: {
    width: 28, height: 28,
    borderRadius: 14,
    backgroundColor: '#EF4444',
  },
  recDotActive: {
    width: 22, height: 22,
    borderRadius: 4,
  },

  // Filter/effect bottom sheet
  fxSheetWrap: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.5)',
    justifyContent: 'flex-end',
  },
  fxSheet: {
    backgroundColor: '#111',
    borderTopLeftRadius: 18,
    borderTopRightRadius: 18,
    paddingTop: 14,
    paddingBottom: 30,
  },
  fxSheetHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingBottom: 12,
  },
  fxSheetTitle: { color: '#fff', fontSize: 16, fontWeight: '800' },
  fxRow: {
    paddingHorizontal: 14,
    gap: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  fxChip: {
    alignItems: 'center',
    width: 64,
  },
  fxThumb: {
    width: 56, height: 56,
    borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.18)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 6,
    overflow: 'hidden',
  },
  fxThumbNone: { color: '#fff', fontSize: 18, fontWeight: '700', opacity: 0.6 },
  fxLabel: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
    textAlign: 'center',
    maxWidth: 64,
  },

  // Drafts entry pill — centered above the speed row
  draftsPill: {
    position: 'absolute',
    alignSelf: 'center',
    paddingHorizontal: 16,
    paddingVertical: 7,
    borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    zIndex: 22,
  },
  draftsPillTxt: { color: '#fff', fontSize: 12, fontWeight: '700' },
});
