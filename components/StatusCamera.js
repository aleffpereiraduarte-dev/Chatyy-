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
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import CachedImage from './CachedImage';
import { IconRefresh } from './Icons';
// AR face-filter pipeline (MediaPipe FaceLandmarker — Apache 2.0).
// Filter overlay is graceful: when the native binding isn't loaded
// (web, debug sim without the pod installed), each preset falls back
// to a centered static overlay. The carousel + preset switching still
// works for UI testing without the binding.
import FaceFilterOverlay from './status/FaceFilterOverlay';
import { FACE_FILTER_PRESETS } from './status/FaceFilters';

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

// Slow-mo speed presets for IMPORTED video (the live-capture speed
// cycle is SPEED_CYCLE; this list is a subset that excludes 0.3x
// because Instagram doesn't expose that for imports — users find it
// unwatchable in practice).
const IMPORT_SPEED_LIST = [0.5, 1, 2, 3];

// Voiceover max duration matches Instagram (30s). The OS will stop
// recording automatically when the cap is hit so we don't need a
// separate timer.
const VOICEOVER_MAX_MS = 30000;

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

export default function StatusCamera({ visible, onClose, onCapture, t, initialSeed = null }) {
  const [permission, requestPermission] = useCameraPermissions();
  const [facing, setFacing] = useState('front');
  const [flash, setFlash] = useState('off');
  const [captureMode, setCaptureMode] = useState('photo');
  const [recording, setRecording] = useState(false);
  const [recordTimer, setRecordTimer] = useState(0);
  // initialSeed (Repost flow) hydrates the preview slot with the previous
  // story's media so the user lands directly in the filter/confirm editor
  // instead of having to re-shoot. The capture screen is bypassed via the
  // existing `preview` → "PREVIEW MODE" render branch.
  const [preview, setPreview] = useState(initialSeed && initialSeed.uri ? {
    uri: initialSeed.uri,
    type: initialSeed.type === 'video' ? 'video' : 'photo',
    width: initialSeed.width,
    height: initialSeed.height,
    fromRepost: true,
  } : null);
  // Reset the preview when a fresh seed arrives (e.g. user closes + repos
  // a different story without unmounting the modal).
  useEffect(() => {
    if (initialSeed && initialSeed.uri) {
      setPreview({
        uri: initialSeed.uri,
        type: initialSeed.type === 'video' ? 'video' : 'photo',
        width: initialSeed.width,
        height: initialSeed.height,
        fromRepost: true,
      });
    }
  }, [initialSeed?.uri]);
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
  // Multi-clip recording — TikTok-style. Each tap adds a finished segment
  // (max 20s each) to the stack; once the user has 2+ they can either keep
  // recording or hit "Pronto" to publish all clips as one CAROUSEL story.
  // Native AVMutableComposition stitch is not in this build (no ffmpeg-wasm
  // dep, native module would need a fresh build); we publish via the
  // existing status_carousel_publish so viewers see a segmented progress
  // ring with all clips back-to-back — the perceptual equivalent.
  const [segments, setSegments] = useState([]); // [{ uri, type:'video', durationMs }]
  const MAX_SEGMENTS = 3;
  const MAX_SEGMENT_MS = 20000;

  // AR face filter (MediaPipe FaceLandmarker — Apache 2.0). null = off.
  // Active when captureMode is 'photo' or 'video' on the front camera.
  // Six bundled presets in components/status/FaceFilters.js; the carousel
  // below the preview lets the user swipe between them.
  const [arFilterIdx, setArFilterIdx] = useState(0);
  const [previewLayoutSize, setPreviewLayoutSize] = useState({ width: 0, height: 0 });
  // ffmpeg stitching progress (multi-clip concat). 0..1 — drives the
  // progress pill above the segment bar so the user sees the merge
  // happening. Falls to carousel-publish if ffmpeg fails (logged).
  const [stitchProgress, setStitchProgress] = useState(0);
  const [stitching, setStitching] = useState(false);
  // Slow-mo speed picker for imported gallery videos. Default 1x; user
  // can override via the pill above the preview retake/use bar. Applied
  // via ffmpeg `-filter_complex setpts=PTS/N` (audio re-pitched with
  // atempo so it stays in sync — atempo chained for > 2x because each
  // chain link is capped at 2x).
  const [importSpeed, setImportSpeed] = useState(1);
  // Voiceover state — when active, we record a 30s mic-only audio track
  // and ffmpeg-mux it onto the existing video before publish. The video
  // keeps its original audio (mixed) unless `voiceMute` is set.
  const [voiceoverRecording, setVoiceoverRecording] = useState(false);
  const [voiceoverUri, setVoiceoverUri] = useState(null);
  const voiceoverRecRef = useRef(null);

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

  // ─── ffmpeg-kit helpers ───
  // Lazy-loaded so web builds (and debug simulators without the pod) don't
  // explode on import. The native module ships under `ffmpeg-kit-react-native`
  // and is LGPL 3.0 (link-time license — no source disclosure required if we
  // use the prebuilt frameworks, which we do).
  const _getFFmpegKit = useCallback(() => {
    // [2026-05-18] ffmpeg-kit dependency removed — arthenica/ffmpeg-kit was
    // retired in 2025 and all binaries (iOS xcframework + Android Maven AAR)
    // were pulled from CocoaPods / Maven Central / GitHub Releases. The only
    // maintained fork (yspreen/spreen) is GPL-only, which is incompatible
    // with App Store distribution.
    //
    // Returning null degrades stitchSegmentsToFile() gracefully — the caller
    // (StatusComposer) already falls back to status_carousel_publish, which
    // uploads each clip individually and lets the server stitch (or the
    // viewer plays them as a carousel).
    //
    // Long-term fix: write a tiny native module using AVMutableComposition
    // (iOS, AVFoundation) + MediaMuxer (Android, NDK) — the same APIs
    // WhatsApp / Instagram / TikTok use. Tracked separately. No third-party
    // FFmpeg binary required.
    return null;
  }, []);

  // Build the concat filter string for N input clips. The video and audio
  // streams are interleaved (`[0:v][0:a][1:v][1:a]...concat=n=N:v=1:a=1[v][a]`)
  // so the output keeps a single AV stream. We also force a -shortest tail
  // trim so a stray clip with extra audio frames doesn't introduce a hiccup.
  const buildConcatFilter = useCallback((count) => {
    let inputs = '';
    for (let i = 0; i < count; i++) inputs += `[${i}:v:0][${i}:a:0]`;
    return `${inputs}concat=n=${count}:v=1:a=1[v][a]`;
  }, []);

  // Stitch the current `segments` stack into a single mp4 via ffmpeg-kit.
  // Resolves to the output file URI on success, or null on failure (caller
  // falls back to status_carousel_publish so the user is never blocked).
  const stitchSegmentsToFile = useCallback(async () => {
    const FFK = _getFFmpegKit();
    if (!FFK || segments.length < 2) return null;
    const FFmpegKit = FFK.FFmpegKit || FFK.default?.FFmpegKit;
    const ReturnCode = FFK.ReturnCode || FFK.default?.ReturnCode;
    if (!FFmpegKit || !ReturnCode) return null;
    setStitching(true);
    setStitchProgress(0);
    // Output lives in expo-file-system's cache so it gets garbage-collected
    // when the OS reclaims space — we don't need it after publish.
    let outUri = null;
    try {
      const FS = require('expo-file-system');
      const cacheDir = FS.cacheDirectory || FS.documentDirectory || '';
      outUri = `${cacheDir}status_stitch_${Date.now()}.mp4`;
      const inputs = segments.map(s => `-i "${s.uri.replace(/^file:\/\//, '')}"`).join(' ');
      const filter = buildConcatFilter(segments.length);
      // -movflags +faststart so the result streams cleanly when uploaded
      // to R2 (web client can begin playback before download completes).
      const cmd = `${inputs} -filter_complex "${filter}" -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 128k -movflags +faststart "${outUri.replace(/^file:\/\//, '')}"`;
      const session = await FFmpegKit.executeAsync(cmd, async (s) => {
        try {
          const code = await s.getReturnCode();
          if (ReturnCode.isSuccess(code)) setStitchProgress(1);
        } catch {}
      }, undefined, (stat) => {
        // statistics callback — surfaces time progress so we can drive the
        // progress pill. We approximate progress as elapsed/totalDurationMs
        // (sum of segment durations).
        try {
          const totalMs = segments.reduce((a, s) => a + (s.durationMs || 0), 0) || 1;
          const elapsedMs = stat?.getTime?.() || 0;
          setStitchProgress(Math.min(1, elapsedMs / totalMs));
        } catch {}
      });
      // Poll for return code — executeAsync may resolve before the success
      // callback if the session is short. The 30s timeout matches the
      // longest plausible 3-clip stitch at 1080p on a 2-year-old phone.
      const start = Date.now();
      while (Date.now() - start < 30000) {
        await new Promise(r => setTimeout(r, 200));
        try {
          const code = await session.getReturnCode();
          if (code != null && ReturnCode.isSuccess(code)) {
            setStitchProgress(1);
            setStitching(false);
            return outUri;
          }
          if (code != null && !ReturnCode.isSuccess(code)) {
            console.warn('[StatusCamera] ffmpeg stitch failed code:', code);
            break;
          }
        } catch {}
      }
    } catch (e) {
      console.warn('[StatusCamera] stitch error:', e?.message);
    }
    setStitching(false);
    return null;
  }, [segments, _getFFmpegKit, buildConcatFilter]);

  // Apply a speed change to a single imported video via ffmpeg. setpts
  // scales the video presentation timestamps (PTS/N where N>1 = faster).
  // Audio gets the same factor via atempo (chained when > 2x because the
  // filter is capped per-link at 2.0). Returns the output URI or null on
  // failure (caller falls back to original clip).
  const applySpeedToVideo = useCallback(async (uri, factor) => {
    const FFK = _getFFmpegKit();
    if (!FFK || !factor || factor === 1) return uri;
    const FFmpegKit = FFK.FFmpegKit || FFK.default?.FFmpegKit;
    const ReturnCode = FFK.ReturnCode || FFK.default?.ReturnCode;
    if (!FFmpegKit || !ReturnCode) return uri;
    try {
      const FS = require('expo-file-system');
      const cacheDir = FS.cacheDirectory || FS.documentDirectory || '';
      const out = `${cacheDir}status_speed_${factor}x_${Date.now()}.mp4`;
      // Compose atempo chain: each link capped 0.5..2.0. For 0.5x we use one
      // 0.5 link; for 3x we chain 2.0 * 1.5; for 0.25x we'd chain 0.5*0.5.
      const atempoChain = (f) => {
        if (f >= 0.5 && f <= 2.0) return `atempo=${f}`;
        if (f > 2.0) {
          // 3x = 2.0 * 1.5 ; 4x = 2.0 * 2.0
          return `atempo=2.0,atempo=${(f / 2.0).toFixed(3)}`;
        }
        // < 0.5 (rare here; UI only exposes 0.5x lower bound)
        return `atempo=0.5,atempo=${(f / 0.5).toFixed(3)}`;
      };
      const setpts = `setpts=PTS/${factor}`;
      const cmd = `-i "${uri.replace(/^file:\/\//, '')}" -filter_complex "[0:v]${setpts}[v];[0:a]${atempoChain(factor)}[a]" -map "[v]" -map "[a]" -c:v libx264 -preset veryfast -crf 23 -c:a aac -movflags +faststart "${out.replace(/^file:\/\//, '')}"`;
      const session = await FFmpegKit.executeAsync(cmd);
      // 30s timeout matches the upper bound for a 60s 1080p clip on phone-grade HW.
      const start = Date.now();
      while (Date.now() - start < 30000) {
        await new Promise(r => setTimeout(r, 200));
        try {
          const code = await session.getReturnCode();
          if (code != null && ReturnCode.isSuccess(code)) return out;
          if (code != null && !ReturnCode.isSuccess(code)) break;
        } catch {}
      }
    } catch (e) {
      console.warn('[StatusCamera] speed apply error:', e?.message);
    }
    return uri;
  }, [_getFFmpegKit]);

  // Mux a separately-recorded voiceover audio track onto a video. The
  // input video's original audio is mixed at 0.3 gain so the voiceover
  // dominates (Instagram parity). Returns the muxed URI or null on
  // failure.
  const muxVoiceoverOntoVideo = useCallback(async (videoUri, audioUri, { keepOriginal = true } = {}) => {
    const FFK = _getFFmpegKit();
    if (!FFK) return videoUri;
    const FFmpegKit = FFK.FFmpegKit || FFK.default?.FFmpegKit;
    const ReturnCode = FFK.ReturnCode || FFK.default?.ReturnCode;
    if (!FFmpegKit || !ReturnCode) return videoUri;
    try {
      const FS = require('expo-file-system');
      const cacheDir = FS.cacheDirectory || FS.documentDirectory || '';
      const out = `${cacheDir}status_voiceover_${Date.now()}.mp4`;
      const filter = keepOriginal
        ? `[0:a]volume=0.3[a0];[1:a]volume=1.6[a1];[a0][a1]amix=inputs=2:dropout_transition=0[a]`
        : `[1:a]volume=1.6[a]`;
      const cmd = `-i "${videoUri.replace(/^file:\/\//, '')}" -i "${audioUri.replace(/^file:\/\//, '')}" -filter_complex "${filter}" -map 0:v -map "[a]" -c:v copy -c:a aac -shortest -movflags +faststart "${out.replace(/^file:\/\//, '')}"`;
      const session = await FFmpegKit.executeAsync(cmd);
      const start = Date.now();
      while (Date.now() - start < 30000) {
        await new Promise(r => setTimeout(r, 200));
        try {
          const code = await session.getReturnCode();
          if (code != null && ReturnCode.isSuccess(code)) return out;
          if (code != null && !ReturnCode.isSuccess(code)) break;
        } catch {}
      }
    } catch (e) {
      console.warn('[StatusCamera] voiceover mux error:', e?.message);
    }
    return videoUri;
  }, [_getFFmpegKit]);

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
      // Spec bump: 30s → 60s cap (TikTok / IG Story plus parity). The
      // MAX_RECORD_MS constant + progress ring already animate over 60s;
      // only the camera SDK call still passed 30, which silently capped
      // recordings at 30s no matter what the UI suggested. Aligned now.
      const video = await cameraRef.current.recordAsync({ maxDuration: 60, quality: '720p' });
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
      // Segment mode: once the user has captured at least one clip, every
      // subsequent tap records another segment instead of a fresh single
      // clip. This is the multi-clip path — clips publish as a carousel
      // via publishSegments() when the user hits "Pronto".
      if (segments.length > 0 && segments.length < MAX_SEGMENTS) {
        if (recording) { haptic('heavy'); stopRecording(); }
        else { haptic('medium'); recordSegment(); }
        return;
      }
      if (recording) { haptic('heavy'); stopRecording(); }
      else { haptic('medium'); startRecording(); }
    }
  }, [captureMode, recording, timerDelay, takePhoto, startRecording, stopRecording, recordSegment, segments.length]);

  // Tracks whether the current recording started via long-press (hold-to-
  // record). When true, releasing the button stops recording. When false
  // (tapped in video mode to toggle), releasing must NOT stop — otherwise
  // the user can't lift their finger between start-tap and stop-tap.
  const holdRecordingRef = useRef(false);
  // Segment-mode start timestamp. We use it to compute durationMs for the
  // finished clip so the carousel can show per-clip elapsed in the viewer.
  const segmentStartRef = useRef(0);

  // Record one segment (max 20s) and push it onto the segments stack
  // instead of emitting onCapture immediately. Returns once recordAsync
  // resolves — caller should keep recording state coherent.
  const recordSegment = useCallback(async () => {
    if (!cameraRef.current || recording) return;
    if (segments.length >= MAX_SEGMENTS) {
      try { Linking.openURL('chatyy://noop'); } catch {} // no-op anchor
      return;
    }
    setRecording(true);
    segmentStartRef.current = Date.now();
    try {
      const cap = Math.ceil(MAX_SEGMENT_MS / 1000);
      const video = await cameraRef.current.recordAsync({ maxDuration: cap, quality: '720p' });
      if (video?.uri) {
        const dur = Math.max(0, Date.now() - segmentStartRef.current);
        setSegments(prev => [...prev, { uri: video.uri, type: 'video', durationMs: dur }]);
      }
    } catch (e) {
      console.warn('[StatusCamera] segment record error:', e);
    }
    setRecording(false);
  }, [recording, segments.length]);

  // Publish the accumulated segment stack. Preferred path: ffmpeg-kit
  // stitches all N clips into a single seamless mp4 (native concat
  // filter), then emits a SINGLE video status. Fallback path (ffmpeg
  // unavailable or stitch failed): emit as CAROUSEL so the viewer
  // still gets the segmented progress ring and the user doesn't lose
  // the recording.
  const publishSegments = useCallback(async () => {
    if (segments.length === 0) return;
    // Single segment? Just emit it as one video — no concat needed.
    if (segments.length === 1) {
      onCapture?.({
        uri: segments[0].uri,
        type: 'video',
        filter: activeFilter.key !== 'normal' ? activeFilter.key : undefined,
        filterAdjust: activeFilter.adjust || undefined,
        speed: speed !== 1 ? speed : undefined,
        beauty: beauty || undefined,
        music: musicTrack || undefined,
      });
      setSegments([]);
      return;
    }
    // Try native stitch first. Falls through to carousel on failure.
    const stitched = await stitchSegmentsToFile();
    if (stitched) {
      onCapture?.({
        uri: stitched,
        type: 'video',
        // Mark the source so backend telemetry can track stitch success
        // rate. No effect on viewer rendering.
        stitched: true,
        filter: activeFilter.key !== 'normal' ? activeFilter.key : undefined,
        filterAdjust: activeFilter.adjust || undefined,
        speed: speed !== 1 ? speed : undefined,
        beauty: beauty || undefined,
        music: musicTrack || undefined,
      });
      setSegments([]);
      return;
    }
    // Fallback: publish as carousel so the user's clips don't get lost.
    onCapture?.({
      multi: true,
      items: segments.map(s => ({
        uri: s.uri,
        type: 'video',
        durationMs: s.durationMs,
      })),
      filter: activeFilter.key !== 'normal' ? activeFilter.key : undefined,
      filterAdjust: activeFilter.adjust || undefined,
      speed: speed !== 1 ? speed : undefined,
      beauty: beauty || undefined,
      music: musicTrack || undefined,
    });
    setSegments([]);
  }, [segments, onCapture, activeFilter, speed, beauty, musicTrack, stitchSegmentsToFile]);

  const handleLongPress = useCallback(() => {
    haptic('medium');
    // Hands-free record: hold to start (any mode), release to stop. In
    // photo mode we transparently switch to video so the recording fires
    // immediately without forcing the user to tap the mode bar first.
    if (!recording) {
      if (captureMode === 'photo' || captureMode === 'story') setCaptureMode('video');
      holdRecordingRef.current = true;
      startRecording();
    }
  }, [captureMode, recording, startRecording]);

  const handlePressIn = useCallback(() => {
    Animated.spring(recScaleAnim, { toValue: 0.92, useNativeDriver: true, friction: 6, tension: 180 }).start();
  }, []);

  const handlePressOut = useCallback(() => {
    Animated.spring(recScaleAnim, { toValue: 1, useNativeDriver: true, friction: 5, tension: 180 }).start();
    // Only auto-stop when the recording originated from a long-press hold.
    // Tap-to-toggle recordings (handleCapturePress in video mode) must
    // survive press-out so the user can release between start and stop.
    if (recording && holdRecordingRef.current) {
      holdRecordingRef.current = false;
      haptic('heavy');
      stopRecording();
    }
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

  // ─── Voiceover (long-press record button in preview) ───
  // Records mic-only audio for up to 30s using `expo-audio`. The result
  // gets muxed onto the preview video by handleConfirm via ffmpeg
  // before publish. The original video audio is mixed in at 30% gain
  // so the voiceover dominates without erasing the scene's audio.
  const startVoiceover = useCallback(async () => {
    if (voiceoverRecording || preview?.type !== 'video') return;
    try {
      const Audio = require('expo-audio');
      // Request mic permission. iOS shows the OS prompt the first time;
      // on subsequent runs the permission is cached.
      const perm = await Audio.requestRecordingPermissionsAsync?.();
      if (perm && perm.granted === false) {
        try { Linking.openSettings?.(); } catch {}
        return;
      }
      await Audio.setAudioModeAsync?.({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
      // High-quality recording preset — matches Instagram's voiceover
      // bitrate so the muxed audio doesn't sound noticeably worse than
      // the captured camera audio.
      // expo-audio (newer SDKs) exposes a class-based AudioRecorder; older
      // SDKs expose Audio.Recording. We probe for the class first, then
      // fall back below. The `new` invocation can't sit inside an optional
      // chain (JS spec) so we guard with a plain check.
      const Rec = Audio.AudioRecorder;
      const recording = Rec
        ? new Rec(Audio.RECORDING_PRESETS?.HIGH_QUALITY || undefined)
        : null;
      if (recording?.prepareToRecordAsync) {
        await recording.prepareToRecordAsync();
        await recording.startAsync?.();
        voiceoverRecRef.current = recording;
      } else {
        // Older expo-audio API surface (function-based) — fall back.
        const rec = await Audio.Audio?.Recording?.createAsync?.(Audio.RecordingOptionsPresets?.HIGH_QUALITY);
        voiceoverRecRef.current = rec?.recording || null;
      }
      setVoiceoverRecording(true);
      haptic('medium');
      // Auto-stop after VOICEOVER_MAX_MS so the user can release the
      // button after the cap is hit without re-triggering recording.
      setTimeout(() => {
        if (voiceoverRecRef.current) stopVoiceover();
      }, VOICEOVER_MAX_MS);
    } catch (e) {
      console.warn('[StatusCamera] voiceover start error:', e?.message);
      setVoiceoverRecording(false);
    }
  }, [voiceoverRecording, preview]);

  const stopVoiceover = useCallback(async () => {
    if (!voiceoverRecRef.current) return;
    try {
      const rec = voiceoverRecRef.current;
      if (rec.stopAndUnloadAsync) await rec.stopAndUnloadAsync();
      else if (rec.stopAsync) await rec.stopAsync();
      const uri = (rec.getURI && rec.getURI()) || rec.uri || null;
      voiceoverRecRef.current = null;
      setVoiceoverRecording(false);
      if (uri) {
        setVoiceoverUri(uri);
        haptic('light');
      }
    } catch (e) {
      console.warn('[StatusCamera] voiceover stop error:', e?.message);
      setVoiceoverRecording(false);
      voiceoverRecRef.current = null;
    }
  }, []);

  // ─── Confirm ───
  // For imported videos: if the user picked a non-1x speed via the slow-mo
  // pill OR recorded a voiceover, run ffmpeg post-processing here before
  // emitting the capture. Both operations are best-effort; on failure we
  // forward the original uri so the user never loses media.
  const handleConfirm = useCallback(async () => {
    if (!preview) return;
    let finalUri = preview.uri;
    let appliedSpeed = undefined;
    if (preview.type === 'video' && importSpeed !== 1) {
      try {
        const sped = await applySpeedToVideo(preview.uri, importSpeed);
        if (sped) { finalUri = sped; appliedSpeed = importSpeed; }
      } catch (e) { console.warn('[StatusCamera] speed apply failed:', e?.message); }
    }
    if (preview.type === 'video' && voiceoverUri) {
      try {
        const muxed = await muxVoiceoverOntoVideo(finalUri, voiceoverUri, { keepOriginal: true });
        if (muxed) finalUri = muxed;
      } catch (e) { console.warn('[StatusCamera] voiceover mux failed:', e?.message); }
    }
    onCapture?.({
      uri: finalUri,
      type: preview.type,
      isBoomerang: !!preview.isBoomerang,
      filter: activeFilter.key !== 'normal' ? activeFilter.key : undefined,
      filterAdjust: activeFilter.adjust || undefined,
      // Persist `speed` meta only when actually applied so existing
      // downstream code (caption translation, telemetry) doesn't see a
      // stray 1x value.
      speed: appliedSpeed,
      // AR face filter — passes the preset key downstream so the viewer
      // can re-render the overlay during playback (web/native respect
      // this in `currentViewerItem.meta.face_filter`).
      face_filter: FACE_FILTER_PRESETS[arFilterIdx]?.key !== 'none'
        ? FACE_FILTER_PRESETS[arFilterIdx]?.key
        : undefined,
    });
    setPreview(null);
    setFilterIdx(0);
    setImportSpeed(1);
    setVoiceoverUri(null);
  }, [preview, activeFilter, onCapture, importSpeed, voiceoverUri, applySpeedToVideo, muxVoiceoverOntoVideo, arFilterIdx]);

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

        {/* Slow-mo speed pill — only shown for imported video. Cycles
            through IMPORT_SPEED_LIST so users can tap to flip between
            0.5x / 1x / 2x / 3x. ffmpeg-kit applies the speed via setpts
            during handleConfirm. */}
        {preview.type === 'video' && (
          <View style={s.previewSpeedRow}>
            {IMPORT_SPEED_LIST.map((sp) => (
              <TouchableOpacity
                key={sp}
                onPress={() => { haptic('light'); setImportSpeed(sp); }}
                style={[s.previewSpeedPill, importSpeed === sp && s.previewSpeedPillActive]}
                accessibilityLabel={`Speed ${sp}x`}
              >
                <Text style={[s.previewSpeedTxt, importSpeed === sp && s.previewSpeedTxtActive]}>
                  {sp}x
                </Text>
              </TouchableOpacity>
            ))}
            {/* Voiceover capture button — hold to record up to 30s of
                mic-only audio that ffmpeg muxes onto the video. Visual
                state goes red while the recorder is active. */}
            <Pressable
              onPressIn={() => { startVoiceover(); }}
              onPressOut={() => { stopVoiceover(); }}
              style={[s.voiceoverBtn, voiceoverRecording && s.voiceoverBtnActive]}
              accessibilityLabel={t?.('status.voiceover') || 'Voz over'}
            >
              {/* Voiceover label — text-only per project "no emoji in UI"
                  rule. State machine: idle → REC → DONE. Holding the button
                  starts recording; releasing stops it and toggles to DONE. */}
              <Text style={[s.voiceoverTxt, voiceoverRecording && { color: '#fff' }]}>
                {voiceoverUri ? 'VOZ OK' : (voiceoverRecording ? 'GRAVANDO' : (t?.('status.voiceover') || 'Voz over'))}
              </Text>
            </Pressable>
          </View>
        )}

        {/* Stitch progress pill — shown while ffmpeg is concat-ing
            multi-clip segments. Goes from 0 to 100% along the bottom
            edge. Falls back silently to carousel publish if it fails. */}
        {stitching && (
          <View style={s.stitchProgressWrap}>
            <Text style={s.stitchProgressTxt}>
              {`${Math.round(stitchProgress * 100)}%`}
            </Text>
          </View>
        )}

        {/* Bottom action bar */}
        <View style={s.previewActions}>
          <TouchableOpacity onPress={() => { setPreview(null); setFilterIdx(0); setImportSpeed(1); setVoiceoverUri(null); }} style={s.actionBtn}>
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
      <View
        style={s.camera}
        onLayout={(e) => {
          const { width, height } = e.nativeEvent.layout;
          if (width !== previewLayoutSize.width || height !== previewLayoutSize.height) {
            setPreviewLayoutSize({ width, height });
          }
        }}
      >
        <CameraView
          ref={cameraRef}
          style={s.camera}
          facing={facing}
          flash={flash}
          mode={captureMode === 'video' ? 'video' : 'picture'}
        />
        {/* AR face filter overlay (MediaPipe FaceLandmarker). Sits on
            top of the camera preview, below the UI chrome so the user's
            touches don't get intercepted. Renders nothing when the
            preset is 'none'. */}
        <FaceFilterOverlay
          filterKey={FACE_FILTER_PRESETS[arFilterIdx]?.key}
          previewSize={previewLayoutSize}
          facing={facing}
        />
      </View>

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
        {/* Multi-clip toggle — sets captureMode to video and records the
            first segment. Subsequent taps on the record button add more
            segments (up to 3). The user finishes by hitting "Pronto" in
            the segment bar that appears under the mode tabs. */}
        <TouchableOpacity
          onPress={() => {
            if (recording) return;
            haptic('medium');
            if (captureMode !== 'video') setCaptureMode('video');
            // Start the first segment via recordSegment so the stack
            // accumulates instead of firing onCapture with one clip.
            recordSegment();
          }}
          style={[s.stackBtn, segments.length > 0 && s.stackBtnActive]}
          accessibilityLabel="Multi-clip"
        >
          <Text style={s.stackIcon}>{segments.length > 0 ? `${segments.length}+` : '⊞'}</Text>
          <Text style={s.stackLabel}>
            {t?.('status.segments') || 'Clips'}
          </Text>
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

      {/* Record timer badge — shows red dot + elapsed time + "Gravando"
          label so the user knows hands-free recording is live. The label
          aliases to the localized string via t() when available. */}
      {recording && (
        <View style={s.recBadge}>
          <View style={s.recDot} />
          <Text style={s.recTxt}>{fmtTime(recordTimer)}</Text>
          <Text style={[s.recTxt, { fontSize: 11, opacity: 0.9, marginLeft: 4 }]}>
            {t?.('status.recording') || 'Gravando'}
          </Text>
        </View>
      )}

      {/* Hands-free hint — small pill above the capture button when idle
          and on the video tab. Auto-fades once they've recorded at least
          one clip (showSwipeHint reuses that visibility timing). */}
      {!recording && captureMode === 'video' && showSwipeHint && (
        <Animated.View style={[s.swipeHint, { opacity: hintFadeAnim, bottom: 180 }]} pointerEvents="none">
          <Text style={s.swipeHintTxt}>
            {t?.('status.recordHoldHint') || 'Segure para gravar'}
          </Text>
        </Animated.View>
      )}

      {/* Segment counter + Pronto pill — shown when the user has at least
          one captured segment. Each segment is a separate clip (max 20s);
          we publish the stack as a carousel via onCapture({multi:true}).
          Tap "+" on the record button keeps adding clips up to 3 total. */}
      {captureMode === 'video' && segments.length > 0 && (
        <View style={s.segmentBar} pointerEvents="box-none">
          <View style={s.segmentPill}>
            {Array.from({ length: MAX_SEGMENTS }).map((_, i) => (
              <View
                key={i}
                style={[
                  s.segmentDot,
                  i < segments.length && s.segmentDotFilled,
                ]}
              />
            ))}
            <Text style={s.segmentPillTxt}>
              {`${segments.length}/${MAX_SEGMENTS}`}
            </Text>
          </View>
          <TouchableOpacity
            onPress={() => { haptic('medium'); publishSegments(); }}
            style={s.segmentDoneBtn}
            disabled={recording}
            accessibilityLabel={t?.('common.done') || 'Pronto'}
          >
            <Text style={s.segmentDoneTxt}>
              {t?.('common.done') || 'Pronto'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity
            onPress={() => { haptic('light'); setSegments(prev => prev.slice(0, -1)); }}
            style={s.segmentUndoBtn}
            disabled={recording}
            accessibilityLabel={t?.('common.undo') || 'Desfazer'}
          >
            <Text style={s.segmentDoneTxt}>{'⤺'}</Text>
          </TouchableOpacity>
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

      {/* AR face filter carousel — sits just above the color filter strip.
          Six bundled presets (none/dog/cat/sunglasses/heart eyes/party hat/
          vampire). Swipe horizontally to switch; tap to apply. Each preset
          PNG ships in assets/ar-filters/. */}
      <View style={s.arFilterStrip} pointerEvents="box-none">
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ paddingHorizontal: 14, gap: 10 }}
        >
          {FACE_FILTER_PRESETS.map((p, i) => {
            const sel = arFilterIdx === i;
            return (
              <TouchableOpacity
                key={p.key}
                onPress={() => { haptic('light'); setArFilterIdx(i); }}
                style={[s.arFilterTile, sel && s.arFilterTileActive]}
                accessibilityLabel={`AR ${p.label}`}
              >
                {/* The 'none' preset has no asset — render a circle slash
                    glyph (∅) so it still reads as "no filter" without
                    needing a dedicated icon component. All other presets
                    render the bundled PNG overlay scaled to fit the tile. */}
                {p.asset ? (
                  <Image source={p.asset} style={s.arFilterIcon} resizeMode="contain" />
                ) : (
                  <View style={{
                    width: 30, height: 30, borderRadius: 15,
                    borderWidth: 2, borderColor: 'rgba(255,255,255,0.6)',
                    transform: [{ rotate: '-45deg' }],
                  }}>
                    <View style={{
                      position: 'absolute', top: 13, left: -1, right: -1,
                      height: 2, backgroundColor: 'rgba(255,255,255,0.6)',
                    }} />
                  </View>
                )}
                <Text style={[s.arFilterLabel, sel && s.arFilterLabelActive]} numberOfLines={1}>
                  {p.label}
                </Text>
              </TouchableOpacity>
            );
          })}
        </ScrollView>
      </View>

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

  // AR face filter carousel (above color filter strip in camera view)
  arFilterStrip: {
    position: 'absolute', bottom: 235,
    left: 0, right: 0, height: 60,
  },
  arFilterTile: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderWidth: 2, borderColor: 'rgba(255,255,255,0.18)',
    alignItems: 'center', justifyContent: 'center',
    overflow: 'hidden', paddingHorizontal: 4,
  },
  arFilterTileActive: {
    borderColor: '#fff', borderWidth: 3,
    backgroundColor: 'rgba(255,255,255,0.18)',
  },
  arFilterIcon: { width: 30, height: 30 },
  arFilterLabel: {
    color: 'rgba(255,255,255,0.75)', fontSize: 9, fontWeight: '700',
  },
  arFilterLabelActive: { color: '#fff', fontWeight: '900' },

  // Slow-mo speed row (preview mode, imported video only)
  previewSpeedRow: {
    position: 'absolute', bottom: 100,
    left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 8,
  },
  previewSpeedPill: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  previewSpeedPillActive: {
    backgroundColor: '#fff', borderColor: '#fff',
  },
  previewSpeedTxt: { color: 'rgba(255,255,255,0.8)', fontSize: 13, fontWeight: '800' },
  previewSpeedTxtActive: { color: '#000' },

  // Voiceover capture button (preview mode, video only)
  voiceoverBtn: {
    paddingHorizontal: 14, paddingVertical: 8, borderRadius: 18,
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderWidth: 1, borderColor: 'rgba(255,255,255,0.18)',
  },
  voiceoverBtnActive: { backgroundColor: '#dc2626', borderColor: '#dc2626' },
  voiceoverTxt: { color: '#fff', fontSize: 13, fontWeight: '700' },

  // ffmpeg stitch progress pill (multi-clip merge feedback)
  stitchProgressWrap: {
    position: 'absolute', bottom: 78,
    alignSelf: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
    paddingHorizontal: 18, paddingVertical: 6,
    borderRadius: 14,
  },
  stitchProgressTxt: { color: '#fff', fontSize: 13, fontWeight: '800' },

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

  // Segment bar (multi-clip recording UI) — appears once the user has
  // at least one captured segment. Pill shows N/MAX_SEGMENTS dots; the
  // "Pronto" button publishes the stack via status_carousel_publish.
  segmentBar: {
    position: 'absolute', bottom: 220,
    left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center',
    gap: 10,
  },
  segmentPill: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
    borderRadius: 16, paddingHorizontal: 12, paddingVertical: 6,
    gap: 6,
  },
  segmentDot: {
    width: 8, height: 8, borderRadius: 4,
    backgroundColor: 'rgba(255,255,255,0.3)',
  },
  segmentDotFilled: { backgroundColor: BRAND_PURPLE_LIGHT },
  segmentPillTxt: { color: '#fff', fontSize: 11, fontWeight: '800', marginLeft: 4 },
  segmentDoneBtn: {
    paddingHorizontal: 16, paddingVertical: 8, borderRadius: 16,
    backgroundColor: '#25D366',
  },
  segmentDoneTxt: { color: '#fff', fontSize: 13, fontWeight: '800' },
  segmentUndoBtn: {
    paddingHorizontal: 12, paddingVertical: 8, borderRadius: 16,
    backgroundColor: 'rgba(0,0,0,0.55)',
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
